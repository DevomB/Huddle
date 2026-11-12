// T2.3. huddle doctor: can huddle work here, and if not, why not.

import { readFile } from "node:fs/promises";
import { checkAgentsMd } from "../adapters/agents-md.ts";
import { ADAPTERS } from "../adapters/index.ts";
import { parse } from "../core/args.ts";
import { ageMs } from "../core/clock.ts";
import { openContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { resolveBase } from "../core/files.ts";
import { git } from "../core/git.ts";
import { EXIT, NotImplementedError, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { loadConfigReport } from "../core/paths.ts";
import { toActorDoc } from "../core/session.ts";
import { readCache, readLocal } from "../core/store.ts";
import { actorRef, REF_PATTERN } from "../core/types.ts";
import { BUNDLE, bundleVersion } from "./init.ts";

export const summary = "Check that huddle can work here: remote, push access, hooks, last sync";

const USAGE = "huddle doctor [--json] [--offline]";

/** Oldest git with `fetch --no-write-fetch-head`, which the transport depends on. */
const MIN_GIT = [2, 29] as const;
const MIN_NODE = 20;

type Level = "ok" | "warn" | "fail" | "info";

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What to do about it. */
  notes: string[];
}

const check = (name: string, level: Level, detail: string, notes: string[] = []): Check => ({ name, level, detail, notes });

/**
 * Text with the credentials taken out of any URL in it (`https://user:token@host/…`).
 * Doctor output gets pasted into issues and chat, and both a remote URL and
 * git's own error messages can carry a token.
 */
export function redactUrl(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]+@/gi, "$1***@");
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * What git said went wrong, on one line. After a failed ssh connection git
 * ends with a two-line hint about access rights that says nothing about the
 * cause; the cause is in the lines before it (ssh's own message, "fatal: ...").
 */
function gitReason(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^Please make sure you have the correct access rights$|^and the repository exists\.$/.test(line));
  const text = redactUrl(lines.join(" / "));
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function toolchain(ctx: Ctx): Promise<Check> {
  const version = await git(["--version"], { cwd: ctx.paths.worktree });
  const found = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.stdout);
  const node = process.versions.node;
  const running = bundleVersion((await readText(ctx.io.self)) ?? "") ?? "(development build)";
  const label = `git ${found?.[0] ?? "unknown"}, node ${node}, huddle ${running}`;
  if (!found) return check("toolchain", "fail", label, ["git did not report a version; is git installed and on PATH?"]);
  const [major, minor] = [Number(found[1]), Number(found[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    return check("toolchain", "fail", label, [`huddle needs git ${MIN_GIT.join(".")} or newer (for fetch --no-write-fetch-head)`]);
  }
  if (Number(node.split(".")[0]) < MIN_NODE) return check("toolchain", "fail", label, [`huddle needs node ${MIN_NODE} or newer`]);
  return check("toolchain", "ok", label);
}

async function bundle(ctx: Ctx): Promise<Check> {
  const vendored = await readText(ctx.paths.bundleFile);
  if (vendored === null) {
    return check("bundle", "warn", `${BUNDLE} is missing`, ['run "huddle init" and commit the result, so teammates and agent hooks can run huddle from the repo']);
  }
  const version = bundleVersion(vendored);
  if (version === null) return check("bundle", "fail", `${BUNDLE} is not a huddle bundle`, ['run "huddle init" to replace it']);
  const tracked = await git(["ls-files", "--error-unmatch", "--", BUNDLE], { cwd: ctx.paths.worktree });
  if (!tracked.ok) {
    return check("bundle", "warn", `${BUNDLE} (huddle ${version}) is not committed`, [`git add .huddle && git commit: teammates get huddle by pulling it`]);
  }
  const running = bundleVersion((await readText(ctx.io.self)) ?? "");
  if (running !== null && running !== version) {
    return check("bundle", "warn", `${BUNDLE} is huddle ${version}; you are running ${running}`, ['run "huddle init" from the newer one to update the repo, or run the vendored copy']);
  }
  return check("bundle", "ok", `${BUNDLE} is huddle ${version} and committed`);
}

async function config(ctx: Ctx): Promise<Check> {
  const c = ctx.config;
  const detail = `remote ${c.remote}, base ${c.base}, sync every ${c.syncIntervalSeconds}s, heartbeat ${c.heartbeatMinutes}m, sessions expire after ${c.ttlMinutes}m, mode ${c.mode}`;
  const capture = c.captureIntent
    ? "prompt capture is on: the first 200 characters of each prompt are shared with everyone who can read this repo (captureIntent: false turns it off)"
    : "prompt capture is off: agents announce what they are doing with huddle intent";
  // A settings file that cannot be used is skipped, not fatal; what was skipped is said here.
  const { problems } = await loadConfigReport(ctx.paths);
  return check("config", problems.length > 0 ? "warn" : "info", detail, [...problems, capture]);
}

/**
 * The clock huddle goes by. HUDDLE_NOW pins it for tests; left set in a real
 * shell it stamps every session with one fixed moment, and they stop looking
 * alive to teammates once that moment is older than the TTL.
 */
function clock(ctx: Ctx): Check[] {
  if (!ctx.io.env.HUDDLE_NOW) return [];
  return [
    check("clock", "warn", `HUDDLE_NOW is set: huddle believes it is ${ctx.now.toISOString()}`, [
      "HUDDLE_NOW is for tests; unset it, or this clone's sessions carry the wrong time",
    ]),
  ];
}

/** The branch that committed work is measured against (files changed since the merge-base with it). */
async function base(ctx: Ctx): Promise<Check> {
  const { remote, base: wanted } = ctx.config;
  const found = await resolveBase(ctx.paths.worktree, ctx.config);
  if (found === null) {
    return check("base branch", "warn", `no base branch found: no ${remote}/HEAD, ${remote}/main or ${remote}/master${wanted === "auto" ? "" : `, and no branch "${wanted}"`}`, [
      "committed files are then shared only until their branch is pushed; uncommitted files are shared as usual",
      'set "base" in .huddle/config.json to the branch that work is merged into',
    ]);
  }
  const short = found.replace(/^refs\/(?:remotes|heads)\//, "");
  const target = found.endsWith("/HEAD") ? await git(["symbolic-ref", "--quiet", "--short", found], { cwd: ctx.paths.worktree }) : null;
  const name = target?.ok && target.stdout.trim() ? `${short} (${target.stdout.trim()})` : short;
  const explicit = [`refs/remotes/${remote}/${wanted}`, `refs/heads/${wanted}`];
  if (wanted !== "auto" && !explicit.includes(found)) {
    return check("base branch", "warn", `"base" is "${wanted}", but there is no such branch here or on ${remote}; using ${name}`, [
      `fix "base" in .huddle/config.json, or run "git fetch ${remote}" if the branch is new`,
    ]);
  }
  return check("base branch", "ok", name);
}

/** Reachability and push access. Skipped with --offline. */
async function remote(ctx: Ctx): Promise<Check[]> {
  const { paths, config: c } = ctx;
  const url = await git(["remote", "get-url", c.remote], { cwd: paths.worktree });
  if (!url.ok) {
    return [
      check("remote", "fail", `there is no git remote named "${c.remote}"`, [
        "huddle shares state through a git remote that everyone on the team pushes to. Add one (git remote add origin <url>) or set `remote` in .huddle/config.json.",
      ]),
    ];
  }
  const shown = redactUrl(url.stdout.trim());

  const started = Date.now();
  const listed = await git(["ls-remote", c.remote, REF_PATTERN], { cwd: paths.worktree, network: true });
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  if (!listed.ok) {
    const why = listed.timedOut ? `no answer within ${took}` : gitReason(listed.stderr) || `git ls-remote exited ${listed.code}`;
    return [
      check("remote", "fail", `cannot reach remote "${c.remote}" (${shown}): ${why}`, [
        "huddle never prompts for credentials. Make sure `git ls-remote " + c.remote + "` works without asking for a password (ssh agent, or a credential helper for HTTPS).",
      ]),
    ];
  }
  const refs = listed.stdout.split("\n").filter(Boolean).length;
  const checks = [check("remote", "ok", `remote "${c.remote}" (${shown}) answered in ${took}; ${refs} huddle ref${refs === 1 ? "" : "s"} on it`)];

  // huddle lists and fetches from the remote's URL and pushes to its push URL.
  const pushUrl = await git(["remote", "get-url", "--push", c.remote], { cwd: paths.worktree });
  if (pushUrl.ok && pushUrl.stdout.trim() !== url.stdout.trim()) {
    checks.push(
      check("remote", "info", `pushes go to a different URL: ${redactUrl(pushUrl.stdout.trim())}`, [
        "that is fine when both URLs are the same repository (ssh for push, https for fetch). If they are different repositories, teammates will never see what this clone publishes.",
      ]),
    );
  }

  checks.push(await pushAccess(ctx));
  return checks;
}

/**
 * Push access is tested by really pushing this clone's own document, which is
 * the only way to know: rulesets and push rules are enforced on the server.
 * Two pushes, because creating a ref and replacing one are separate
 * permissions and huddle needs both: every update of a document is a forced,
 * non-fast-forward push.
 */
async function pushAccess(ctx: Ctx): Promise<Check> {
  const { paths, config: c, transport } = ctx;
  const local = await readLocal(paths);
  const doc = toActorDoc(ctx.identity, local.sessions, ctx.now, c.ttlMinutes);
  const ref = actorRef(ctx.identity.actor);
  const byHand = `Check by hand with: git push ${c.remote} HEAD:refs/huddle/probe && git push ${c.remote} :refs/huddle/probe`;

  const first = await transport.publish(ref, { ...doc, updatedAt: new Date(ctx.now.getTime() - 1).toISOString() }, "own");
  if (!first.ok && first.reason === "offline") {
    return check("push", "fail", "the remote stopped answering during the push test", ["try again; if it keeps happening the remote is slow or flaky", `details are in ${paths.logFile}`]);
  }
  if (!first.ok) {
    return check("push", "fail", `the remote refused a push to refs/huddle/* (${first.reason})`, [
      "huddle stores its state in refs under refs/huddle/ on this remote, so everyone on the team needs to be able to push there.",
      "Usual causes: read-only access to the repo; a fork instead of the shared repo; a ruleset or push rule that restricts which ref names may be created (GitHub organization rulesets, GitLab push rules, Bitbucket branch restrictions).",
      byHand,
      `git's own message is in ${paths.logFile}`,
    ]);
  }

  const second = await transport.publish(ref, doc, "own");
  // A clone with nothing to announce that never published leaves no trace behind.
  const leaveNoTrace = doc.sessions.length === 0 && local.published === null;
  if (leaveNoTrace) await transport.remove(ref, second.ok ? second.sha : first.sha);
  if (second.ok) return check("push", "ok", "can create and replace refs under refs/huddle/ on this remote");
  if (second.reason === "offline") {
    return check("push", "fail", "the remote stopped answering during the push test", ["try again; if it keeps happening the remote is slow or flaky", `details are in ${paths.logFile}`]);
  }
  return check("push", "fail", `the remote accepts new refs under refs/huddle/ but refuses to replace them (${second.reason})`, [
    "huddle replaces a document by force-pushing its ref, so the remote must allow non-fast-forward updates under refs/huddle/.",
    "Usual causes: a server-side hook that rejects forced updates for every ref instead of only for branches; a per-ref permission that allows creating but not force-pushing (Gerrit's Force Push). git's own receive.denyNonFastForwards is not the cause: it only covers refs/heads/.",
    `git's own message is in ${paths.logFile}`,
  ]);
}

async function hooks(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];
  for (const adapter of ADAPTERS) {
    try {
      const result = await adapter.check(ctx.paths.worktree);
      checks.push(check(`hooks: ${adapter.title}`, result.installed ? "ok" : "info", result.detail, result.notes));
    } catch (error) {
      if (error instanceof NotImplementedError) {
        checks.push(check(`hooks: ${adapter.title}`, "info", "not available in this version of huddle"));
      } else {
        checks.push(check(`hooks: ${adapter.title}`, "warn", `could not check: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }
  const agentsMd = await checkAgentsMd(ctx.paths.worktree, { bundle: BUNDLE });
  checks.push(check("AGENTS.md", agentsMd.installed ? "ok" : "info", agentsMd.detail, agentsMd.notes));
  return checks;
}

/** How long a sighting of a second writer in the log stays worth a warning. */
const SHARED_ACTOR_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * sync logs it when this clone's entry on the remote was written by a clone
 * that is not this one (see foreignSessions in core/sync.ts). Two clones with
 * one actor id overwrite each other and never see each other, so the latest
 * such line, while it is recent, is shown as a problem to fix.
 */
function sharedActor(log: string, ctx: Ctx): Check | null {
  const lines = log.split("\n").filter((line) => line.includes("another clone is publishing as this one"));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const age = ageMs(last.slice(0, last.indexOf(" ")), ctx.now);
  if (Number.isNaN(age) || age > SHARED_ACTOR_MAX_AGE_MS) return null;
  return check("actor id", "warn", `another clone is publishing under this clone's actor id ${ctx.identity.actor} (seen ${formatAge(Math.max(0, age))})`, [
    "this happens when a repository is copied together with its .git directory",
    `delete ${ctx.paths.actorFile} in the copy, then run "huddle sync" in both`,
  ]);
}

async function state(ctx: Ctx): Promise<Check[]> {
  const [local, cache] = await Promise.all([readLocal(ctx.paths), readCache(ctx.paths)]);
  const ttlMs = ctx.config.ttlMinutes * 60_000;
  const live = local.sessions.filter((session) => ageMs(session.seenAt, ctx.now) < ttlMs).length;
  const who = `this clone is actor ${ctx.identity.actor} (${ctx.identity.user} on ${ctx.identity.host}) with ${live} live session${live === 1 ? "" : "s"}`;
  const checks = [check("identity", "info", who)];

  if (cache.fetchedAt === null) {
    checks.push(check("last sync", live > 0 ? "warn" : "info", "never synced", live > 0 ? ['run "huddle sync"; if it fails, the reason is above or in the log'] : []));
  } else {
    const age = ageMs(cache.fetchedAt, ctx.now);
    const stale = live > 0 && age > Math.max(10 * 60_000, ctx.config.syncIntervalSeconds * 20_000);
    checks.push(
      check("last sync", stale ? "warn" : "ok", `last synced ${formatAge(age)}`, stale ? ["sessions are live but nothing has synced for a while: check the log below"] : []),
    );
  }

  const log = await readText(ctx.paths.logFile);
  const shared = sharedActor(log ?? "", ctx);
  if (shared) checks.push(shared);
  const failures = (log ?? "").split("\n").filter((line) => /fail|error|denied|offline/i.test(line));
  const recent = failures[failures.length - 1];
  checks.push(check("log", "info", ctx.paths.logFile, recent ? [`last problem logged: ${redactUrl(recent).slice(0, 300)}`] : []));
  return checks;
}

const LABEL: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", info: "info" };

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    { json: { type: "boolean", default: false }, offline: { type: "boolean", default: false } },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);

  const ctx = await openContext(io);
  const checks: Check[] = [await toolchain(ctx), await bundle(ctx), await config(ctx), ...clock(ctx), await base(ctx)];
  if (values.offline) checks.push(check("remote", "info", "not checked (--offline)"));
  else checks.push(...(await remote(ctx)));
  checks.push(...(await hooks(ctx)), ...(await state(ctx)));

  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;

  if (values.json) {
    io.out(JSON.stringify({ ok: failed === 0, failed, warnings: warned, checks }, null, 2));
  } else {
    io.out(`huddle doctor: ${ctx.paths.worktree}`);
    for (const c of checks) {
      io.out(`  ${LABEL[c.level]}  ${c.name}: ${c.detail}`);
      for (const note of c.notes) io.out(`          ${note}`);
    }
    io.out("");
    if (failed > 0) io.out(`${failed} problem${failed === 1 ? "" : "s"} must be fixed before huddle can work here.`);
    else if (warned > 0) io.out(`huddle can work here; ${warned} thing${warned === 1 ? "" : "s"} to look at.`);
    else io.out("huddle can work here.");
  }
  return failed > 0 ? EXIT.ERROR : EXIT.OK;
}
