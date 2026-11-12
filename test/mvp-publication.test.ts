// MVP sprint, worker 1: publication that teammates can read (audit A01), files
// past the cap that stay visible (A03), and claims that are shared exactly or
// refused (A07). The CLI tests use the real harness: a bare remote and clones,
// with git processes and the built bundle, on Linux and on native Windows.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COVER_ALL,
  DocTooLargeError,
  LIMITS,
  cleanPath,
  cutFiles,
  normalizeDoc,
  parseDoc,
  serializeDoc,
  wireSession,
} from "../src/core/docs.ts";
import { claimMatches } from "../src/core/glob.ts";
import { readCache, readLocal } from "../src/core/store.ts";
import { createTransport } from "../src/core/transport.ts";
import { actorRef, decisionsRef } from "../src/core/types.ts";
import type { ActorDoc, Decision, DecisionDoc, Session } from "../src/core/types.ts";
import { createHarness } from "./harness.ts";
import type { Clone } from "./harness.ts";

const T = "2026-11-12T20:00:00.000Z";
const ACTOR = "abcd2345";
const GRIN = String.fromCodePoint(0x1f600); // 4 UTF-8 bytes
const E_ACUTE = "\u00e9"; // 2 UTF-8 bytes

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "manual",
    branch: "main",
    intent: "",
    intentSource: "none",
    files: [],
    claims: [],
    startedAt: T,
    seenAt: T,
    ...over,
  };
}

function actorDoc(sessions: Session[], over: Partial<ActorDoc> = {}): ActorDoc {
  return { v: 0, kind: "actor", actor: ACTOR, user: "writer", host: "host", updatedAt: T, sessions, ...over };
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Every path in `cut` is in `files` or covered by a claim: what was left out is still visible. */
function assertCovered(published: Session, paths: string[]) {
  const exact = new Set(published.files);
  for (const path of paths) {
    if (exact.has(path)) continue;
    assert.ok(
      published.claims.some((claim) => claimMatches(claim, path)),
      `${path} is neither listed nor covered by ${JSON.stringify(published.claims)}`,
    );
  }
}

/** The audit's reproduction: deep, legal-length paths, 200 per session. */
function deepFiles(count: number, tag = "", unit = "a"): string[] {
  return Array.from({ length: count }, (_, n) => `src/${tag}${String(n).padStart(3, "0")}/` + unit.repeat(180) + "/" + "b".repeat(199) + ".ts");
}

describe("A01: a published actor document is always readable", () => {
  test("the audit's 323,645-byte document now fits, keeps every session, and covers every file", () => {
    const files = deepFiles(200);
    assert.ok(files.every((path) => path.length <= LIMITS.path));
    const doc = actorDoc(Array.from({ length: 4 }, (_, n) => session({ id: `session-${n}`, files })));
    assert.ok(bytes(JSON.stringify(doc, null, 2)) > LIMITS.docBytes, "setup: the raw document is over the limit");

    const text = serializeDoc(doc);
    assert.ok(bytes(text) <= LIMITS.docBytes, `${bytes(text)} bytes`);
    const read = parseDoc(text, actorRef(ACTOR)) as ActorDoc;
    assert.ok(read, "the reader takes what the writer published");
    assert.deepEqual(read.sessions.map((s) => s.id), ["session-0", "session-1", "session-2", "session-3"]);
    // The largest sessions are cut first, only as far as needed: some keep all 200 exact paths.
    assert.ok(read.sessions.some((s) => s.files.length < files.length), "something had to be cut");
    for (const s of read.sessions) {
      if (s.files.length === files.length) assert.equal(s.partial, undefined);
      else {
        assert.equal(s.partial?.total, 200);
        for (const glob of s.partial!.cover) assert.ok(s.claims.includes(glob), "every cover glob is also a claim");
      }
      assertCovered(s, files);
    }
  });

  test("multibyte paths: the byte budget counts UTF-8 bytes, not characters", () => {
    for (const unit of [E_ACUTE, GRIN, "\u4e2d"]) {
      const files = deepFiles(200, "", unit).map((path) => path.slice(0, 380));
      const doc = actorDoc(Array.from({ length: 6 }, (_, n) => session({ id: `s${n}`, intent: unit.repeat(250), files })));
      const text = serializeDoc(doc);
      assert.ok(bytes(text) <= LIMITS.docBytes, `${unit}: ${bytes(text)} bytes`);
      const read = parseDoc(text, actorRef(ACTOR)) as ActorDoc;
      assert.equal(read.sessions.length, 6);
      for (const s of read.sessions) assertCovered(s, files);
    }
  });

  test("worst case: 50 sessions with every text field at its limit in 4-byte characters still fit, each one covering the repo", () => {
    const long = (n: number) => GRIN.repeat(n);
    const claims = Array.from({ length: LIMITS.claims }, (_, c) => `${GRIN.repeat(390)}/${c}/**`);
    const sessions = Array.from({ length: LIMITS.sessions }, (_, n) =>
      session({
        id: `${n}-${long(LIMITS.sessionId - 3)}`,
        agent: long(LIMITS.name),
        branch: long(LIMITS.branch),
        intent: long(LIMITS.intent),
        intentSource: "manual",
        files: deepFiles(200, `${n}-`, GRIN).map((path) => path.slice(0, LIMITS.path)),
        claims,
      }),
    );
    const doc = actorDoc(sessions, { user: long(LIMITS.name), host: long(LIMITS.name) });
    const text = serializeDoc(doc);
    assert.ok(bytes(text) <= LIMITS.docBytes, `${bytes(text)} bytes`);
    const read = parseDoc(text, actorRef(ACTOR)) as ActorDoc;
    assert.equal(read.sessions.length, LIMITS.sessions, "every session stays visible");
    for (const s of read.sessions) assert.ok(s.claims.includes(COVER_ALL) || s.claims.length > 0);

    // The floor itself: 50 sessions with files: [] and claims: ["**"].
    const floor = actorDoc(
      sessions.map((s) => ({ ...s, files: [], claims: [COVER_ALL], partial: { total: Number.MAX_SAFE_INTEGER, cover: [COVER_ALL] } })),
      { user: long(LIMITS.name), host: long(LIMITS.name) },
    );
    const floorBytes = bytes(JSON.stringify(normalizeDoc(floor), null, 2) + "\n");
    assert.ok(floorBytes <= LIMITS.docBytes, `the floor is ${floorBytes} bytes`);
  });

  test("normalizing is idempotent, so a reader keeps exactly what was published", () => {
    const shapes = [
      actorDoc(Array.from({ length: 4 }, (_, n) => session({ id: `s${n}`, files: deepFiles(200) }))),
      actorDoc([session({ files: Array.from({ length: 1000 }, (_, n) => `pkg/m${n % 37}/f${n}.ts`) })]),
      actorDoc([session({ files: Array.from({ length: 300 }, (_, n) => `f${n}.txt`), claims: ["docs/**", "a b/c"] })]),
      actorDoc([session({ files: [`src/a${"\u200b"}b.ts`, " lead.ts", "ok.ts"], claims: Array.from({ length: 50 }, (_, c) => `c${c}/**`) })]),
    ];
    for (const doc of shapes) {
      const once = normalizeDoc(doc);
      assert.deepEqual(normalizeDoc(once), once);
      assert.deepEqual(parseDoc(serializeDoc(doc), actorRef(ACTOR)), once);
    }
  });

  test("a decision log over the budget is refused before publishing, with DocTooLargeError", async (t) => {
    const base32 = "abcdefghijklmnopqrstuvwxyz234567";
    const decisions: Decision[] = Array.from({ length: LIMITS.decisions }, (_, n) => ({
      id: Array.from({ length: 8 }, (_, k) => base32[(n >> (5 * k)) & 31]).join(""),
      at: T,
      agent: GRIN.repeat(LIMITS.name),
      text: GRIN.repeat(LIMITS.decisionText),
    }));
    const doc: DecisionDoc = { v: 0, kind: "decisions", actor: ACTOR, user: "writer", decisions };
    assert.throws(() => serializeDoc(doc), (error: unknown) => error instanceof DocTooLargeError && error.bytes > LIMITS.docBytes);

    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const before = await h.remoteGit("for-each-ref", "--format=%(refname)");
    const result = await createTransport({ cwd: alice.dir, remote: "origin" }).publish(decisionsRef(ACTOR), doc, "own");
    assert.deepEqual(result, { ok: false, reason: "denied", sent: false });
    assert.equal(await h.remoteGit("for-each-ref", "--format=%(refname)"), before, "nothing reached the remote");
  });

  test("remote round trip: a large actor published by one clone is read whole by another", async (t) => {
    const h = await createHarness(t);
    const writer = await h.clone("writer");
    const reader = await h.clone("reader");
    const files = deepFiles(200);
    const doc = actorDoc(Array.from({ length: 4 }, (_, n) => session({ id: `session-${n}`, files })));
    const published = await createTransport({ cwd: writer.dir, remote: "origin" }).publish(actorRef(ACTOR), doc, "own");
    assert.equal(published.ok, true);
    const fetched = await createTransport({ cwd: reader.dir, remote: "origin" }).fetchAll(new Map());
    assert.ok(fetched.ok);
    const got = fetched.changed.get(actorRef(ACTOR))?.doc as ActorDoc | null;
    assert.ok(got, "the reader got a document, not doc: null");
    assert.equal(got.sessions.length, 4);
    for (const s of got.sessions) assertCovered(s, files);
  });
});

describe("A03: files past the cap stay visible as coverage", () => {
  test("cutFiles keeps 200 exact paths and covers the rest with the narrowest globs that fit", () => {
    const all = [
      ...Array.from({ length: 200 }, (_, n) => `a/${String(n).padStart(3, "0")}.ts`),
      "b/c/one.ts",
      "b/c/two.ts",
      `\u00fcber/\u00e7a/x.ts`,
      "top.md",
    ];
    const { files, partial } = cutFiles(all);
    assert.equal(files.length, LIMITS.files);
    assert.deepEqual(partial, { total: 204, cover: ["b/c/**", "top.md", `\u00fcber/\u00e7a/**`].sort() });
    assert.deepEqual(cutFiles(all.slice(0, 200)), { files: all.slice(0, 200), partial: null });
  });

  test("coverage widens rather than outgrowing the claim cap, and never loses a path", () => {
    const all = Array.from({ length: 5000 }, (_, n) => `pkg/${n % 97}/deep/${n % 13}/f${n}.ts`);
    const { files, partial } = cutFiles(all);
    assert.ok(partial && partial.cover.length <= LIMITS.claims && partial.cover.length > 0);
    assert.equal(partial.total, 5000);
    const published = wireSession(session({ files, partial }));
    assertCovered(published, all);
  });

  test("user claims are not mixed with coverage locally; on the wire coverage takes the free slots or widens to **", () => {
    const all = Array.from({ length: 260 }, (_, n) => `gen/${n % 3}/f${n}.ts`);
    const { files, partial } = cutFiles(all);
    const local = session({ files, claims: ["docs/**"], ...(partial ? { partial } : {}) });
    const published = wireSession(local);
    assert.deepEqual(local.claims, ["docs/**"], "local claims are untouched");
    assert.deepEqual(published.claims, ["docs/**", ...partial!.cover]);
    assertCovered(published, all);

    // 49 user claims: one slot is left, so the cover widens into it.
    const near = Array.from({ length: LIMITS.claims - 1 }, (_, c) => `c${c}/**`);
    const one = wireSession(session({ files, claims: near, partial: partial! }));
    assert.equal(one.claims.length, LIMITS.claims);
    assert.deepEqual(one.partial?.cover, ["gen/**"]);
    assertCovered(one, all);

    // 50 user claims: no slot left. Everything is covered by one glob, and normalization keeps it.
    const full = Array.from({ length: LIMITS.claims }, (_, c) => `c${c}/**`);
    const none = wireSession(session({ files, claims: full, partial: partial! }));
    assert.deepEqual(none.claims, [COVER_ALL]);
    assert.deepEqual(none.partial, { total: 260, cover: [COVER_ALL] });
    const read = parseDoc(serializeDoc(actorDoc([none])), actorRef(ACTOR)) as ActorDoc;
    assert.deepEqual(read.sessions[0]!.claims, [COVER_ALL]);
  });

  test("a directory name the wire would change widens to its parent, and a path cleaning would rewrite is covered, not renamed", () => {
    const zw = "\u200b";
    const narrow = cutFiles([`ok/a${zw}b/x.ts`, "fine.ts"]);
    assert.deepEqual(narrow, { files: ["fine.ts"], partial: { total: 2, cover: ["ok/**"] } });
    // A top-level name the wire would trim has no directory to widen to: the whole repo is covered.
    const wide = cutFiles([`ok/a${zw}b/x.ts`, " spaced.ts", "fine.ts"]);
    assert.deepEqual(wide, { files: ["fine.ts"], partial: { total: 3, cover: [COVER_ALL] } });
    for (const glob of [...narrow.partial!.cover, ...wide.partial!.cover]) assert.equal(cleanPath(glob), glob);
  });

  async function manyFiles(clone: Clone, paths: string[]) {
    for (const path of paths) await clone.write(path, "x\n");
  }

  test("201 changed files: Bob is warned for file 201, and for 1,000 files in non-ASCII directories", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const bob = await h.clone("bob");
    const first = Array.from({ length: 201 }, (_, n) => `src/file-${String(n).padStart(3, "0")}.ts`);
    const more = Array.from({ length: 800 }, (_, n) => `lib/\u00fcnic\u00f8de-${n % 7}/\u4e2d${n}.ts`);
    await manyFiles(alice, [...first, ...more]);
    assert.equal((await alice.huddle(["intent", "Edit many files"], { now: T, session: "many-files" })).code, 0);
    assert.equal((await alice.huddle(["sync", "--force"], { now: T })).code, 0);

    const local = await readLocal(await alice.paths());
    const mine = local.sessions.find((s) => s.id === "many-files")!;
    assert.equal(mine.files.length, LIMITS.files);
    assert.equal(mine.partial?.total, 1001);
    assert.deepEqual(mine.claims, [], "generated coverage is not stored as the user's claims");

    assert.equal((await bob.huddle(["sync", "--force"], { now: T })).code, 0);
    const cache = await readCache(await bob.paths());
    const theirs = Object.values(cache.refs).flatMap((e) => (e.doc?.kind === "actor" ? e.doc.sessions : [])).find((s) => s.id === "many-files")!;
    assert.ok(theirs, "Bob holds Alice's session");
    assert.equal(theirs.partial?.total, 1001);
    assertCovered(theirs, [...first, ...more]);

    for (const path of [first[200]!, more[799]!, "lib/\u00fcnic\u00f8de-3/new.ts"]) {
      const r = await bob.huddle(["check", path, "--json"], { now: T });
      assert.equal(r.code, 3, `${path}: ${r.stdout}${r.stderr}`);
      const data = JSON.parse(r.stdout) as { overlaps: Array<{ sessions: Array<{ via: string; match: string }> }> };
      assert.equal(data.overlaps.length, 1);
      const match = data.overlaps[0]!.sessions[0]!.match;
      assert.ok(theirs.files.includes(match) || theirs.claims.includes(match), match);
    }
  });
});

describe("A07: a claim is shared exactly or refused", () => {
  test("a claim over 400 characters is a usage error and leaves earlier claims alone; one at 400 reaches the peer exactly", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const bob = await h.clone("bob");
    const opts = { now: T, session: "claimer" };
    assert.equal((await alice.huddle(["claim", "docs/**"], opts)).code, 0);

    const tooLong = "src/" + "segment/".repeat(55) + "*";
    assert.ok(Array.from(tooLong).length > LIMITS.path);
    const refused = await alice.huddle(["claim", tooLong], opts);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /at most 400 characters/);
    assert.doesNotMatch(refused.stdout, /claimed/);
    const after = (await readLocal(await alice.paths())).sessions.find((s) => s.id === "claimer")!;
    assert.deepEqual(after.claims, ["docs/**"], "the earlier claim is untouched and nothing new was stored");

    // Exactly 400 characters, most of them 4-byte, in decomposed (NFD) form: shared as is.
    const nfd = "e\u0301";
    const boundary = `d${nfd}/` + GRIN.repeat(LIMITS.path - 2 - Array.from(`d${nfd}/`).length) + "/*";
    assert.equal(Array.from(boundary).length, LIMITS.path);
    const ok = await alice.huddle(["claim", boundary], opts);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal((await alice.huddle(["sync", "--force"], { now: T })).code, 0);
    assert.equal((await bob.huddle(["sync", "--force"], { now: T })).code, 0);
    const cache = await readCache(await bob.paths());
    const claims = Object.values(cache.refs).flatMap((e) => (e.doc?.kind === "actor" ? e.doc.sessions : [])).find((s) => s.id === "claimer")?.claims;
    assert.deepEqual(claims, ["docs/**", boundary]);
  });

  test("a claim with characters the wire would remove is refused", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const r = await alice.huddle(["claim", `src/a${"\u200b"}b/**`], { now: T, session: "claimer" });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /not shared with teammates/);
    assert.equal((await readLocal(await alice.paths())).sessions.find((s) => s.id === "claimer")?.claims.length ?? 0, 0);
  });
});
