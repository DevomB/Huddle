// T1.2. Documents to and from refs/huddle/* on the shared remote.
//
// The hard rules in plan.md §3 apply to every call made here. core/git.ts
// already covers prompting, timeouts, gc and optional locks when `network: true`
// is passed. This module is responsible for the rest:
//   - no local refs, no FETCH_HEAD, no index, no working tree: build the commit
//     with hash-object -w / mktree / commit-tree, list with ls-remote, fetch by
//     name with --no-write-fetch-head (and --no-tags, and an empty --refmap so
//     git does not opportunistically update tracking refs);
//   - push with --no-verify, so a user's pre-push hook never runs for huddle;
//   - push through a refspec-less stand-in for the remote when the remote's
//     fetch refspecs cover refs/huddle/* (a mirror-style
//     "+refs/*:refs/remotes/origin/*"): after a push git updates the tracking
//     ref such a refspec maps to, and there is no flag to stop it (see push);
//   - fetched text goes through parseDoc(text, ref) from docs.ts and nowhere else.
//
// How a failed push is classified (see settlePush):
//   - timeout, or git never got as far as a per-ref status   -> "offline",
//     unless stderr shows an authentication or permission failure -> "denied"
//   - the lease failed, or the remote says the ref moved      -> "lost-race"
//   - the remote rejected the ref in words we do not know     -> ask the remote
//     what the ref holds now: moved means "lost-race", unmoved means "denied".
// The last step exists because server wording differs between hosts, while the
// state of the ref does not lie.

import { randomBytes } from "node:crypto";
import { LIMITS, parseDoc, serializeDoc } from "./docs.ts";
import { git } from "./git.ts";
import type { GitResult } from "./git.ts";
import { log } from "./log.ts";
import { locateRepo } from "./paths.ts";
import { REF_PATTERN, parseRef } from "./types.ts";
import type { Doc, Expect, FailReason, FetchedDoc, FetchResult, PublishResult, Ref, Sha, Transport } from "./types.ts";

export interface TransportOptions {
  /** Any directory inside the clone. */
  cwd: string;
  /** Name of the git remote (config.remote). */
  remote: string;
  /** Per network call. Defaults to the 10 s in core/git.ts. */
  timeoutMs?: number;
}

/** The one file in every document commit's tree. */
export const DOC_FILE = "doc.json";

/** SHA-1 today; SHA-256 repositories use 64 characters. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Same rule as config validation in paths.ts: a remote name, never a URL or an option. */
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Document commits carry a fixed identity and date. Two reasons: commit-tree
 * must work in a clone with no user.name, and the user's email must not be
 * published to the remote. A side effect worth having: a document's commit
 * sha depends only on its text, so publishing the same document twice is a
 * no-op push.
 */
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "huddle",
  GIT_AUTHOR_EMAIL: "huddle@huddle.invalid",
  GIT_AUTHOR_DATE: "1577836800 +0000",
  GIT_COMMITTER_NAME: "huddle",
  GIT_COMMITTER_EMAIL: "huddle@huddle.invalid",
  GIT_COMMITTER_DATE: "1577836800 +0000",
};

/** In a partial clone, asking for a missing object would start a network fetch from a "local" call. */
const LOCAL_ENV = { GIT_NO_LAZY_FETCH: "1" };

const PUSH_ARGS = [
  "-c",
  "push.useForceIfIncludes=false",
  "push",
  "--porcelain",
  "--no-verify", // the user's pre-push hook is not ours to run
  "--no-signed", // push.gpgSign would prompt for a passphrase
  "--no-follow-tags",
  "--recurse-submodules=no",
];

const FETCH_ARGS = [
  "-c",
  "fetch.writeCommitGraph=false",
  "fetch",
  "--no-write-fetch-head", // a background fetch must not rewrite FETCH_HEAD under a `git pull`
  "--no-tags", // tag following would create local refs
  "--no-prune",
  "--no-recurse-submodules",
  "--refmap=", // ignore remote.<name>.fetch: no opportunistic tracking-ref updates
  "--quiet",
  "--stdin",
];

/** How many `git cat-file blob` processes read fetched documents at once. */
const READ_CONCURRENCY = 8;

type Fail = { ok: false; reason: FailReason };

function fail(reason: FailReason): Fail {
  return { ok: false, reason };
}

interface Session {
  cwd: string;
  remote: string;
  timeoutMs: number | undefined;
  note(message: string, error?: unknown): Promise<void>;
  /** remote.<name>.fetch, read once. */
  fetchRefspecs(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Reading git's output. Pure, exported for tests.
// ---------------------------------------------------------------------------

export interface PushStatus {
  /** " " fast-forward, "+" forced, "-" deleted, "*" new, "=" up to date, "!" rejected. */
  flag: string;
  /** For example "[rejected] (stale info)" or "[remote rejected] (pre-receive hook declined)". */
  summary: string;
}

/** The status line for `ref` in `git push --porcelain` output: "<flag>\t<from>:<to>\t<summary>". */
export function parsePushStatus(stdout: string, ref: Ref): PushStatus | null {
  for (const line of stdout.split("\n")) {
    const parts = line.replace(/\r$/, "").split("\t");
    const flag = parts[0];
    const fromTo = parts[1];
    if (parts.length < 3 || flag === undefined || fromTo === undefined || flag.length !== 1) continue;
    // Ref names cannot contain ":", so the destination is whatever follows the last one.
    if (fromTo.slice(fromTo.lastIndexOf(":") + 1) !== ref) continue;
    return { flag, summary: parts.slice(2).join("\t") };
  }
  return null;
}

/** `git ls-remote` output as ref -> sha. Lines that are not a well-formed huddle ref are dropped: the remote is untrusted. */
export function parseLsRemote(stdout: string): Map<Ref, Sha> {
  const refs = new Map<Ref, Sha>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sha = line.slice(0, tab);
    const ref = line.slice(tab + 1).replace(/\r$/, "");
    if (SHA_RE.test(sha) && parseRef(ref)) refs.set(ref, sha);
  }
  return refs;
}

/**
 * Whether a rejected push's summary says the ref was not where we expected it.
 * "stale info" is git's own lease check, made before anything is sent. The
 * rest is what the remote answers when the ref moved after that check passed:
 *   git's receive-pack:  (reference already exists), (incorrect old value provided)
 *   GitHub, 2026-11-12:  (cannot lock ref '<ref>': reference already exists),
 *                        (cannot lock ref '<ref>': is at <sha> but expected <sha>)
 * A summary this does not recognize is not a verdict either way: settlePush
 * then asks the remote what the ref holds.
 */
export function saysRefMoved(summary: string): boolean {
  return /stale info|reference already exists|incorrect old value provided|is at [0-9a-f]+ but expected [0-9a-f]+/i.test(summary);
}

/**
 * Authentication or permission failures. Deliberately not matching "access
 * rights": git prints "Please make sure you have the correct access rights"
 * after every failed ssh connection, including an unresolvable host.
 */
const AUTH_RE = new RegExp(
  [
    "permission denied",
    "permission to \\S+ denied",
    "authentication failed",
    "could not read (username|password)",
    "terminal prompts disabled",
    "invalid (username|credentials)",
    "returned error: 40[13]",
    "http 40[13]",
    "access denied",
    "not authorized",
    "unauthorized",
    "marked as read only",
    "repository not found",
    "host key verification failed",
  ].join("|"),
  "i",
);

/** For a call that failed before any ref was accepted or rejected. */
export function classifyFailure(result: Pick<GitResult, "timedOut" | "stderr">): "offline" | "denied" {
  if (result.timedOut) return "offline";
  return AUTH_RE.test(result.stderr) ? "denied" : "offline";
}

/**
 * Whether one of a remote's fetch refspecs maps `ref` to a local tracking ref.
 * Negative refspecs are ignored, which errs on the side of saying yes.
 */
export function tracksRef(fetchRefspecs: string[], ref: Ref): boolean {
  return fetchRefspecs.some((refspec) => {
    const spec = refspec.trim().replace(/^\+/, "");
    const colon = spec.indexOf(":");
    if (spec.startsWith("^") || colon < 0 || colon === spec.length - 1) return false; // excludes, or has no destination
    const src = spec.slice(0, colon);
    const star = src.indexOf("*");
    if (star < 0) return src === ref;
    return ref.length >= src.length - 1 && ref.startsWith(src.slice(0, star)) && ref.endsWith(src.slice(star + 1));
  });
}

/** What a push needs from a remote's section. Its fetch refspecs, `push` and `mirror` are left behind on purpose. */
const PUSH_SETTINGS = new Set(["url", "pushurl", "receivepack", "proxy", "proxyauthmethod", "vcs"]);

/**
 * `-c` arguments that define a remote called `name` for the length of one git
 * command: the same URLs and connection settings as the real remote, and no
 * refspecs. `entries` are the real remote's settings as [variable, value]
 * pairs. Values are passed on as configured, so git applies insteadOf and
 * pushInsteadOf to them exactly as it does for the real remote. Null when
 * there is no URL to push to.
 */
export function standInRemote(entries: [string, string][], name: string): string[] | null {
  const kept = entries.filter(([key]) => PUSH_SETTINGS.has(key));
  if (!kept.some(([key, value]) => (key === "url" || key === "pushurl") && value !== "")) return null;
  return kept.flatMap(([key, value]) => ["-c", `remote.${name}.${key}=${value}`]);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * publish: "own" force-updates, "absent" creates only if the ref is missing,
 * a Sha replaces only if the ref is still at that Sha. Lost compare-and-swap
 * is "lost-race"; unreachable remote or timeout is "offline"; the remote
 * refusing the push for any other reason is "denied".
 *
 * fetchAll: lists refs/huddle/*, fetches the docs whose sha differs from
 * `known`, and reports the refs in `known` that are gone. A ref whose content
 * does not parse is reported with doc: null.
 *
 * remove: deletes the ref only if it is still at `expect`.
 *
 * None of the three ever throws. A call that cannot even be attempted comes
 * back as a failure too: an invalid ref, expectation or document is "denied"
 * (nothing was sent), and a local git failure is "offline". The reason and
 * git's stderr are written to the debug log.
 */
export function createTransport(opts: TransportOptions): Transport {
  let logTarget: Promise<{ logFile: string } | null> | undefined;
  let refspecs: Promise<string[]> | undefined;
  const session: Session = {
    cwd: opts.cwd,
    remote: opts.remote,
    timeoutMs: opts.timeoutMs,
    fetchRefspecs: () =>
      (refspecs ??= git(["config", "--get-all", `remote.${opts.remote}.fetch`], { cwd: opts.cwd }).then((found) =>
        // Exit 1 is "not set". Anything else unexpected is treated the same: push by name.
        found.ok ? found.stdout.split("\n").filter((line) => line.trim() !== "") : [],
      )),
    // The log lives in the state dir, which is only looked up when there is something to say.
    note: async (message, error) => {
      try {
        logTarget ??= locateRepo(opts.cwd);
        log(await logTarget, "transport", message, error);
      } catch {
        // Logging never breaks a call.
      }
    },
  };

  const guarded = async <T>(what: string, run: () => Promise<T | Fail>): Promise<T | Fail> => {
    try {
      if (!REMOTE_RE.test(session.remote)) {
        await session.note(`${what}: "${session.remote}" is not a remote name`);
        return fail("offline");
      }
      return await run();
    } catch (error) {
      await session.note(`${what} failed`, error);
      return fail("offline");
    }
  };

  return {
    publish: (ref: Ref, doc: Doc, expect: Expect): Promise<PublishResult> =>
      guarded("publish", () => publish(session, ref, doc, expect)),
    fetchAll: (known: Map<Ref, Sha>): Promise<FetchResult> => guarded("fetchAll", () => fetchAll(session, known)),
    remove: (ref: Ref, expect: Sha): Promise<PublishResult> => guarded("remove", () => remove(session, ref, expect)),
  };
}

// ---------------------------------------------------------------------------
// publish and remove
// ---------------------------------------------------------------------------

async function publish(s: Session, ref: Ref, doc: Doc, expect: Expect): Promise<PublishResult> {
  if (!parseRef(ref) || (expect !== "own" && expect !== "absent" && !SHA_RE.test(expect))) {
    await s.note(`publish ${ref}: invalid ref or expectation`);
    return fail("denied");
  }
  let text: string;
  try {
    text = serializeDoc(doc);
  } catch (error) {
    await s.note(`publish ${ref}: not a valid document`, error);
    return fail("denied");
  }

  const commit = await writeDocCommit(s, text);
  // "own": plain force. Otherwise the lease is the compare-and-swap: an empty
  // expected value means "the ref must not exist".
  const lease = expect === "own" ? [] : [`--force-with-lease=${ref}:${expect === "absent" ? "" : expect}`];
  const pushed = await push(s, ref, lease, `${expect === "own" ? "+" : ""}${commit}:${ref}`);
  return settlePush(s, "publish", pushed, ref, expect, commit);
}

async function remove(s: Session, ref: Ref, expect: Sha): Promise<PublishResult> {
  if (!parseRef(ref) || !SHA_RE.test(expect)) {
    await s.note(`remove ${ref}: invalid ref or expectation`);
    return fail("denied");
  }
  const pushed = await push(s, ref, [`--force-with-lease=${ref}:${expect}`], `:${ref}`);
  return settlePush(s, "remove", pushed, ref, expect, null);
}

/**
 * One push of one refspec, normally to the remote by name.
 *
 * After a successful push git updates (or deletes) whatever local tracking ref
 * the remote's fetch refspecs map the pushed ref to, and push has no
 * equivalent of fetch's --refmap to turn that off. The default refspec covers
 * only refs/heads/*, so it never matches a huddle ref; a clone configured to
 * mirror every ref does. Pushing to the URL instead does not help: git finds
 * the configured remote with that URL and uses its refspecs anyway. So in
 * such a clone the push goes to a stand-in remote that exists only on this
 * command's line, with the real remote's URLs and connection settings and no
 * refspecs. Nothing is written to the user's config.
 */
async function push(s: Session, ref: Ref, lease: string[], refspec: string): Promise<GitResult> {
  let target = s.remote;
  let standIn: string[] = [];
  if (tracksRef(await s.fetchRefspecs(), ref)) {
    const section = `remote.${s.remote}.`;
    const listed = await git(["config", "--null", "--get-regexp", `^remote\\.${s.remote.replace(/\./g, "\\.")}\\.`], { cwd: s.cwd });
    // --null prints "<key>\n<value>\0". The variable name comes back lowercased; the remote's name keeps its case.
    const entries = listed.stdout.split("\0").flatMap((entry): [string, string][] => {
      const newline = entry.indexOf("\n");
      if (newline < 0 || !entry.startsWith(section)) return [];
      return [[entry.slice(section.length, newline).toLowerCase(), entry.slice(newline + 1)]];
    });
    target = `huddle-push-${randomBytes(6).toString("hex")}`; // cannot collide with a remote the user has
    const config = standInRemote(entries, target);
    if (!config) throw new Error(`remote "${s.remote}" has no URL to push ${ref} to`);
    standIn = config;
  }
  const args = [...standIn, ...PUSH_ARGS, ...lease, target, refspec];
  return git(args, { cwd: s.cwd, network: true, timeoutMs: s.timeoutMs });
}

/** Builds the parentless commit whose tree holds only doc.json. Writes objects, never refs. */
async function writeDocCommit(s: Session, text: string): Promise<Sha> {
  const blob = await plumb(s, ["hash-object", "-w", "--stdin"], text);
  const tree = await plumb(s, ["mktree"], `100644 blob ${blob}\t${DOC_FILE}\n`);
  return plumb(s, ["commit-tree", "--no-gpg-sign", "-m", "huddle", tree], undefined, COMMIT_ENV);
}

/** A local plumbing call that prints one object id. */
async function plumb(s: Session, args: string[], input?: string, env?: Record<string, string>): Promise<Sha> {
  const result = await git(args, { cwd: s.cwd, input, env: { ...LOCAL_ENV, ...env } });
  const sha = result.stdout.trim();
  if (!result.ok || !SHA_RE.test(sha)) {
    throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return sha;
}

/**
 * Turns a finished push into a result. `commit` is what we tried to put at the
 * ref, or null for a delete.
 */
async function settlePush(
  s: Session,
  what: string,
  pushed: GitResult,
  ref: Ref,
  expect: Expect,
  commit: Sha | null,
): Promise<PublishResult> {
  // For a delete, `expect` is always a sha: report what was removed.
  const done: PublishResult = { ok: true, sha: commit ?? expect };
  if (pushed.ok) return done;

  const status = pushed.timedOut ? null : parsePushStatus(pushed.stdout, ref);
  if (!status || status.flag !== "!") {
    const reason = classifyFailure(pushed);
    await s.note(`${what} ${ref}: ${reason}: ${brief(pushed)}`);
    return fail(reason);
  }
  if (saysRefMoved(status.summary)) return fail("lost-race");

  // Rejected in words we do not recognize. Look at the ref instead of guessing.
  const current = await remoteSha(s, ref);
  if (!current.ok) {
    await s.note(`${what} ${ref}: rejected (${status.summary}) and the remote could not be asked why: ${current.reason}`);
    return current;
  }
  if (commit !== null && current.sha === commit) return done; // the remote already holds exactly this document
  const moved =
    expect === "own" ? false : expect === "absent" ? current.sha !== null : current.sha !== expect;
  if (moved) return fail("lost-race");
  await s.note(`${what} ${ref}: denied: ${status.summary}: ${brief(pushed)}`);
  return fail("denied");
}

function brief(result: GitResult): string {
  const text = result.stderr.trim().replace(/\s+/g, " ");
  return text.length > 400 ? `${text.slice(0, 400)}…` : text || `exit ${result.code}`;
}

// ---------------------------------------------------------------------------
// fetchAll
// ---------------------------------------------------------------------------

async function fetchAll(s: Session, known: Map<Ref, Sha>): Promise<FetchResult> {
  let listing = await listRemote(s);
  if (!listing.ok) return listing;

  const changed = new Map<Ref, FetchedDoc>();
  // The remote can move between the listing and the fetch. One more round
  // catches that; anything still unread after it is left out, so the caller's
  // `known` stays stale for that ref and the next sync picks it up.
  for (let round = 0; round < 2; round++) {
    const refs = listing.refs;
    const want = [...refs].filter(([ref, sha]) => (changed.get(ref)?.sha ?? known.get(ref)) !== sha);
    if (want.length === 0) break;

    // Our own documents, and anything fetched before, are already in the object store.
    let read = await readDocs(s, want);
    let missing = want.filter(([ref]) => !read.has(ref));
    if (missing.length > 0) {
      const fetched = await git([...FETCH_ARGS, s.remote], {
        cwd: s.cwd,
        network: true,
        timeoutMs: s.timeoutMs,
        input: missing.map(([ref]) => `${ref}\n`).join(""),
      });
      if (fetched.ok) {
        read = new Map([...read, ...(await readDocs(s, missing))]);
        missing = want.filter(([ref]) => !read.has(ref));
      } else if (fetched.timedOut || !/couldn't find remote ref/i.test(fetched.stderr)) {
        const reason = classifyFailure(fetched);
        await s.note(`fetchAll: ${reason}: ${brief(fetched)}`);
        return fail(reason);
      }
      // Otherwise a listed ref was deleted before we fetched it, and git fetched nothing.
    }
    for (const [ref, entry] of read) changed.set(ref, entry);
    if (missing.length === 0 || round === 1) break;

    listing = await listRemote(s);
    if (!listing.ok) return listing;
  }

  const refs = listing.refs;
  // Report only what agrees with the last listing we saw.
  for (const [ref, entry] of changed) {
    if (refs.get(ref) !== entry.sha) changed.delete(ref);
  }
  const removed = [...known.keys()].filter((ref) => !refs.has(ref));
  return { ok: true, changed, removed };
}

async function listRemote(s: Session): Promise<{ ok: true; refs: Map<Ref, Sha> } | Fail> {
  const listed = await git(["ls-remote", "--quiet", "--refs", s.remote, REF_PATTERN], {
    cwd: s.cwd,
    network: true,
    timeoutMs: s.timeoutMs,
  });
  if (!listed.ok) {
    const reason = classifyFailure(listed);
    await s.note(`ls-remote: ${reason}: ${brief(listed)}`);
    return fail(reason);
  }
  return { ok: true, refs: parseLsRemote(listed.stdout) };
}

/** What one ref points at on the remote right now; null when it does not exist. */
async function remoteSha(s: Session, ref: Ref): Promise<{ ok: true; sha: Sha | null } | Fail> {
  const listed = await git(["ls-remote", "--quiet", "--refs", s.remote, ref], {
    cwd: s.cwd,
    network: true,
    timeoutMs: s.timeoutMs,
  });
  if (!listed.ok) return fail(classifyFailure(listed));
  // ls-remote patterns match the tail of a ref name, so pick the exact one.
  return { ok: true, sha: parseLsRemote(listed.stdout).get(ref) ?? null };
}

interface ObjectInfo {
  oid: string;
  type: string;
  size: number;
}

/** One line of `git cat-file --batch-check` output; null for "<name> missing" and anything unexpected. */
function parseObjectInfo(line: string | undefined): ObjectInfo | null {
  const match = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line ?? "");
  if (!match) return null;
  return { oid: match[1]!, type: match[2]!, size: Number(match[3]) };
}

/**
 * Reads the documents for the listed commits that are present in the local
 * object store. A ref missing from the result has not been fetched yet. A ref
 * present with doc: null is there but is not a valid document: not a commit,
 * no doc.json, too large, or rejected by parseDoc.
 */
async function readDocs(s: Session, entries: [Ref, Sha][]): Promise<Map<Ref, FetchedDoc>> {
  const out = new Map<Ref, FetchedDoc>();
  if (entries.length === 0) return out;

  // Sizes and types first, in one process and without printing any content,
  // so an oversized or hostile blob is never read at all.
  const checked = await git(["cat-file", "--batch-check"], {
    cwd: s.cwd,
    env: LOCAL_ENV,
    input: entries.map(([, sha]) => `${sha}\n${sha}:${DOC_FILE}\n`).join(""),
  });
  if (!checked.ok) throw new Error(`git cat-file --batch-check failed (${checked.code}): ${checked.stderr.trim()}`);
  const lines = checked.stdout.split("\n");

  const toRead: { ref: Ref; sha: Sha; oid: string }[] = [];
  entries.forEach(([ref, sha], index) => {
    const commit = parseObjectInfo(lines[index * 2]);
    if (!commit) return; // not in the object store: needs a fetch
    const blob = parseObjectInfo(lines[index * 2 + 1]);
    if (commit.type !== "commit" || !blob || blob.type !== "blob" || blob.size > LIMITS.docBytes) {
      out.set(ref, { sha, doc: null });
    } else {
      toRead.push({ ref, sha, oid: blob.oid });
    }
  });

  // One process per document. A single `cat-file --batch` would be fewer
  // processes, but its output frames each blob by byte count and git.ts hands
  // us decoded text, so a blob with invalid UTF-8 could shift the framing and
  // pass its own bytes off as the next teammate's document.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let item = toRead[next++]; item !== undefined; item = toRead[next++]) {
      const blob = await git(["cat-file", "blob", item.oid], { cwd: s.cwd, env: LOCAL_ENV });
      // A failed read is left out rather than recorded as invalid: it is our problem, not the document's.
      if (blob.ok) out.set(item.ref, { sha: item.sha, doc: parseDoc(blob.stdout, item.ref) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, toRead.length) }, worker));
  return out;
}
