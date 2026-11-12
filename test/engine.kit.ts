// Shared by the tests of the hook engine: a team of clones that are set up for
// huddle, events as an adapter would hand them over, and a record of what the
// engine asked of the network. Not a test file itself.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookEvent, HookEventType, HookOutcome } from "../src/adapters/types.ts";
import { openContext } from "../src/core/context.ts";
import type { Ctx } from "../src/core/context.ts";
import type { Io, StdinOptions } from "../src/core/io.ts";
import { COMMANDS, NOTICE, OVERLAP_HINT, formatAge } from "../src/core/render.ts";
import { readLocal, readSeen, withLock, writeCache } from "../src/core/store.ts";
import { sync } from "../src/core/sync.ts";
import type { BackgroundOptions, SyncResult } from "../src/core/sync.ts";
import { actorRef } from "../src/core/types.ts";
import type { ActorDoc, Cache, LocalSession, Session } from "../src/core/types.ts";
import { effects, handleEvent } from "../src/hooks/engine.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { CleanupHost, Clone, Harness } from "./harness.ts";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export const T0 = Date.parse("2026-01-01T00:00:00Z");
/** The pinned clock at T0 + `seconds`. */
export const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
export const MIN = 60;
/** How the age of something last seen at T0 + `then` reads at T0 + `now`. */
export const ago = (then: number, now: number): string => formatAge((now - then) * 1000);
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(what: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** How long `work` took, in milliseconds, with what it returned. */
export async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await work();
  return { ms: performance.now() - started, value };
}

/**
 * How many times its deadline a hook gets under test, unless the test says
 * otherwise. A hook has 150 ms for an edit. On a machine that is running a
 * dozen test files at once it runs out of them now and then, as it should,
 * and a test that only wanted the hook's answer then fails for a reason that
 * is not its own.
 *
 * Set on this process, so that it reaches the hooks handled in it (ioFor) and
 * the ones it starts through the bundle (the harness passes the environment
 * on). Whatever the developer's shell had there is replaced.
 */
export const PATIENCE = 20;
process.env.HUDDLE_HOOK_PATIENCE = String(PATIENCE);

/**
 * For the tests that are about time, as the environment of an event or of a
 * hook process: every deadline as it is for a user.
 */
export const ON_THE_CLOCK: Readonly<Record<string, string>> = Object.freeze({ HUDDLE_HOOK_PATIENCE: "1" });

// ---------------------------------------------------------------------------
// Clones
// ---------------------------------------------------------------------------

export interface Team {
  h: Harness;
  alice: Clone;
  bob: Clone;
}

/**
 * A remote and two clones of it that are set up for huddle as far as a hook
 * can tell: .huddle/ is committed on main, with `config` as the team's config.
 */
export async function team(t: CleanupHost, config: Record<string, unknown> = {}): Promise<Team> {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await alice.write(".huddle/config.json", `${JSON.stringify(config)}\n`);
  await alice.commit("Set up huddle");
  await alice.push();
  const bob = await h.clone("bob");
  return { h, alice, bob };
}

/** The actor documents on the remote. */
export async function actorDocs(h: Harness): Promise<ActorDoc[]> {
  const refs = (await h.remoteGit("for-each-ref", "--format=%(refname)", "refs/huddle/actors")).split("\n").filter(Boolean);
  return Promise.all(refs.map(async (ref) => JSON.parse(await h.remoteGit("cat-file", "-p", `${ref}:doc.json`)) as ActorDoc));
}

/** What `user` has published, or undefined when there is nothing of theirs on the remote. */
export async function published(h: Harness, user: string): Promise<ActorDoc | undefined> {
  return (await actorDocs(h)).find((doc) => doc.user === user);
}

export async function sessionsOf(clone: Clone): Promise<LocalSession[]> {
  return (await readLocal(await clone.paths())).sessions;
}

/** The clone's record of a session; by default the one its agent's events name. */
export async function sessionOf(clone: Clone, id = `s-${clone.name}`): Promise<LocalSession | undefined> {
  return (await sessionsOf(clone)).find((session) => session.id === id);
}

/** What the session was shown, as the keys of its seen file; [] when there is none. */
export async function seenKeys(clone: Clone, id = `s-${clone.name}`): Promise<string[]> {
  return Object.keys((await readSeen(await clone.paths(), id))?.items ?? {}).sort();
}

export async function logOf(clone: Clone): Promise<string> {
  return readFile((await clone.paths()).logFile, "utf8").catch(() => "");
}

/** True once no sync holds the lock, so the harness can remove the clone safely. */
export async function syncIdle(clone: Clone): Promise<boolean> {
  return !existsSync((await clone.paths()).syncLock);
}

/**
 * Takes one of the clone's store locks in this process and holds it until the
 * returned function is called. `staleMs` has to be what the real users of that
 * lock pass, or they take it over.
 */
export async function hold(clone: Clone, name: string, staleMs = 30_000): Promise<() => Promise<void>> {
  const paths = await clone.paths();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let taken: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    taken = resolve;
  });
  const done = withLock(
    paths,
    name,
    async () => {
      taken();
      await gate;
    },
    { staleMs },
  );
  await held;
  return async () => {
    release();
    await done;
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface TestIo extends Io {
  stdout: string[];
  stderr: string[];
  /** The options of each readStdin call. */
  stdinCalls: Array<StdinOptions | undefined>;
}

export interface IoOptions {
  /** Pins the clock (HUDDLE_NOW). */
  now?: string;
  env?: NodeJS.ProcessEnv;
  /** What readStdin gives: a text, or a function for the cases where it never arrives. */
  stdin?: string | (() => Promise<string>);
}

/** An Io whose working directory is the clone's top level (or the directory given), and that keeps what is printed. */
export function ioFor(where: Clone | string, opts: IoOptions = {}): TestIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdinCalls: Array<StdinOptions | undefined> = [];
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (opts.now !== undefined) env.HUDDLE_NOW = opts.now;
  const stdin = opts.stdin ?? "";
  return {
    cwd: typeof where === "string" ? where : where.dir,
    env,
    self: BUNDLE,
    out: (text) => void stdout.push(text),
    err: (text) => void stderr.push(text),
    readStdin: (options) => {
      stdinCalls.push(options);
      return typeof stdin === "string" ? Promise.resolve(stdin) : stdin();
    },
    stdout,
    stderr,
    stdinCalls,
  };
}

/** An event of the clone's agent session, as the Claude Code adapter would hand it over. */
export function eventOf(clone: Clone, type: HookEventType, over: Partial<HookEvent> = {}): HookEvent {
  return { type, agent: "claude-code", sessionId: `s-${clone.name}`, cwd: clone.dir, ...over };
}

/** Handles one event of the clone's agent session at T0 + `seconds`. The hook is started at the clone's top level. */
export function fire(clone: Clone, type: HookEventType, seconds: number, over: Partial<HookEvent> = {}, env: NodeJS.ProcessEnv = {}): Promise<HookOutcome> {
  return handleEvent(eventOf(clone, type, over), ioFor(clone, { now: at(seconds), env }));
}

/** Handles one event that names no session, as the git adapter hands it over: a git hook that ran in the clone. */
export function ambient(clone: Clone, type: HookEventType, seconds: number, over: Partial<HookEvent> = {}, env: NodeJS.ProcessEnv = {}): Promise<HookOutcome> {
  const event: HookEvent = { type, agent: "git", sessionId: "", cwd: clone.dir, ambient: true, ...over };
  return handleEvent(event, ioFor(clone, { now: at(seconds), env }));
}

/**
 * One forced sync in the clone at T0 + `seconds`. Stands in for the detached
 * sync an event asked for, which does not run under the harness.
 */
export async function publish(clone: Clone, seconds: number): Promise<SyncResult> {
  const result = await sync(await openContext(ioFor(clone, { now: at(seconds) })), { force: true });
  assert.equal(result.ran, true, `the sync in ${clone.name} did not run: ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------------------
// What the engine asked of the network
// ---------------------------------------------------------------------------

export interface Asked {
  /** Background syncs, in order: forced, or left to the throttle. */
  background: Array<{ worktree: string; force: boolean }>;
  /** The options of each of those, as given. */
  options: BackgroundOptions[];
  /** Syncs that were waited for, by the budget each was given. */
  waited: number[];
  /** The checkout each of those was to run in: where its process is started, and whose settings it reads. */
  waitedIn: string[];
}

/**
 * Records what the engine asks for from here to the end of the test. The real
 * thing still happens: under the harness a background sync is not started, and
 * a sync that is waited for runs in this process. `waitFor` replaces the
 * latter, for a sync that fails or never comes back.
 */
export function record(t: CleanupHost, waitFor?: (ctx: Ctx, budgetMs: number) => Promise<boolean>): Asked {
  const original = { ...effects };
  const asked: Asked = { background: [], options: [], waited: [], waitedIn: [] };
  effects.spawnBackgroundSync = (paths, self, opts = {}) => {
    asked.background.push({ worktree: paths.worktree, force: opts.force === true });
    asked.options.push(opts);
    original.spawnBackgroundSync(paths, self, opts);
  };
  effects.syncWithin = (ctx, budgetMs) => {
    asked.waited.push(budgetMs);
    asked.waitedIn.push(ctx.paths.worktree);
    return (waitFor ?? original.syncWithin)(ctx, budgetMs);
  };
  t.after(() => void Object.assign(effects, original));
  return asked;
}

/** What a record holds when the engine asked for nothing. */
export const NOTHING_ASKED: Readonly<Asked> = Object.freeze({ background: [], options: [], waited: [], waitedIn: [] });

/** A sync that never comes back. */
export const never = (): Promise<boolean> => new Promise(() => {});

export const forced = (clone: Clone): { worktree: string; force: boolean } => ({ worktree: clone.dir, force: true });
export const throttled = (clone: Clone): { worktree: string; force: boolean } => ({ worktree: clone.dir, force: false });

// ---------------------------------------------------------------------------
// Teammates that exist only in a clone's cache
// ---------------------------------------------------------------------------

/** A teammate's session as it arrives from the remote, last seen at T0 + `seconds`. */
export function remoteSession(id: string, seconds: number, over: Partial<Session> = {}): Session {
  return { id, agent: "codex", branch: "main", intent: "", intentSource: "none", files: [], claims: [], startedAt: at(0), seenAt: at(seconds), ...over };
}

/** A teammate's document. `actor` has to be an id: 4 to 32 of a-z and 2-7. */
export function teammate(actor: string, user: string, sessions: Session[]): ActorDoc {
  return { v: 0, kind: "actor", actor, user, host: "laptop", updatedAt: at(0), sessions };
}

/**
 * Makes the clone's cache hold exactly these teammates, as if a sync at
 * T0 + `fetched` had found them (null: never fetched). A real sync afterwards
 * would remove them again, since the remote does not have them.
 */
export async function cacheTeam(clone: Clone, fetched: number | null, docs: ActorDoc[]): Promise<void> {
  const refs: Cache["refs"] = {};
  docs.forEach((doc, index) => {
    refs[actorRef(doc.actor)] = { sha: (index + 1).toString(16).padStart(40, "0"), doc };
  });
  await writeCache(await clone.paths(), { fetchedAt: fetched === null ? null : at(fetched), refs });
}

// ---------------------------------------------------------------------------
// What the engine says
// ---------------------------------------------------------------------------

export const ALONE = `[huddle] No teammates' agents are active on this repo right now.\n${COMMANDS}`;
export const NEVER_FETCHED =
  "[huddle] The team state has not been fetched from the remote yet, so teammates may be missing here. If this stays, run `huddle doctor`.";
export const staleNote = (age: string): string =>
  `[huddle] The team state was last fetched ${age} and could not be refreshed since, so this may be out of date. If this stays, run \`huddle doctor\`.`;
export const FULL_HEAD = `[huddle] Teammates' agents on this repo. ${NOTICE}`;
export const DELTA_HEAD = `[huddle] Update on teammates' agents. ${NOTICE}`;
export const FULL_FOOT = `${OVERLAP_HINT} ${COMMANDS}`;
export const overlapHead = (path: string): string => `[huddle] ${path} overlaps teammates' work in flight. ${NOTICE}`;
export const SAY_SO = "Say so before editing, and coordinate or pick a different file if you can.";
export const moreNote = (count: number): string => `[huddle] ${count} more of the paths in this edit overlap teammates' work as well: run \`huddle check\`.`;
export const CUT_NOTE = "[huddle] Cut short to fit: run `huddle check` for the rest.";

/** Joins the lines of an expected text. */
export const text = (...lines: string[]): string => lines.join("\n");

// ---------------------------------------------------------------------------
// The scenario most tests start from
// ---------------------------------------------------------------------------

export const AUTH_PROMPT = "Build the JWT middleware in src/auth.ts";

/**
 * Alice's agent started at T0, was asked at T0+5 to build the JWT middleware,
 * wrote src/auth.ts at T0+10 and all of it was published at T0+12. Bob's clone
 * has not synced since it was made and has no session.
 */
export async function aliceBuildsAuth(t: CleanupHost, config: Record<string, unknown> = {}): Promise<Team> {
  const made = await team(t, config);
  const { alice } = made;
  await fire(alice, "session-start", 0);
  await fire(alice, "prompt", 5, { prompt: AUTH_PROMPT });
  await alice.write("src/auth.ts", "export const auth = true;\n");
  await fire(alice, "post-edit", 10, { paths: [join(alice.dir, "src/auth.ts")] });
  await publish(alice, 12);
  return made;
}

/** The line a briefing has for alice in that scenario, read at T0 + `now`. */
export const aliceLine = (now: number, seen = 10): string => `- alice / claude-code on main (${ago(seen, now)}): "${AUTH_PROMPT}". Files: src/auth.ts`;

/** The warning bob gets for src/auth.ts in that scenario, read at T0 + `now`. */
export const authWarning = (now: number, seen = 10): string =>
  text(overlapHead("src/auth.ts"), `- alice / claude-code on main (${ago(seen, now)}) has it in flight: "${AUTH_PROMPT}".`, SAY_SO);
