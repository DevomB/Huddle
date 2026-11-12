// T2.1. The hook engine: normalized events in, outcomes out (plan.md §3 Hooks).
// Agent-agnostic. Reads only local state and the cache; the network is only
// touched by the sync that session-start waits for and by detached background
// syncs (sync.spawnBackgroundSync).
//
//   Event           What happens                                              Deadline
//   session-start   one sync, waited for; then the full briefing              4 s
//   prompt          record the intent, brief on what changed, background sync 300 ms
//   pre-edit        warn when a target path overlaps a teammate's work        150 ms
//   post-edit       background sync                                           150 ms
//   turn-end        background sync, not throttled                            150 ms
//   session-end     remove the session, background sync, not throttled        1 s
//
// Every event creates or touches the session it names.
//
// Where hooks act. Only in a repository that is set up for huddle: one with a
// .huddle directory at the top of the worktree, which is what `huddle init`
// commits. The payload's cwd follows the agent, and an agent wanders: into a
// submodule, a sibling clone, a scratch directory. Without this rule it would
// get a session there, and a background sync would push the user's name, file
// names and the start of the next prompt to a remote that never asked for it.
// See locate().
//
// Deadlines. Each event has one, counted from the moment the hook command
// starts to run (node's own start-up comes on top). When it passes, the hook
// prints nothing and exits 0; whatever was still running is abandoned. Every
// write it could interrupt is an atomic rename or is covered by stale-lock
// recovery (core/store.ts). Agents put no time limit on some hooks at all
// (Claude Code on an async PostToolUse), so this is the only one there is.
//
// Syncs. A background sync is throttled to one per syncIntervalSeconds, and a
// throttled one is skipped, not delayed. So the events after which teammates
// have something new to learn ask for a sync that is not throttled: a session
// that appeared, moved to another worktree, changed its intent or left, and
// the end of a turn, after which nothing else might run for minutes.
//
// Subagents share their parent's session id. Their events keep the session
// alive and are warned before an edit, and that is all: they never move the
// session to another worktree, record an intent, use up the parent's briefing
// or end the session.
//
// An event can also name no session at all (event.ambient: a git hook, which
// only knows the worktree it ran in). It is given the session a CLI command
// typed in the same place would act as, so that a commit and `huddle intent`
// are one presence and not two, and from there on it is handled like a
// subagent's event. One thing differs. Its pre-edit is a commit, and between
// two commits nothing keeps the team state fresh, so it may first wait up to
// a second for a sync and has 1.5 s in all: see refreshFirst().
//
// What a session was shown is kept in seen/<session> (core/store.ts), in one
// map: the items renderBriefing returns, "briefed" once a briefing was built
// from them, and "w:<path>" for each overlap warning, so that the same warning
// is not repeated before every edit of the same file.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ADAPTERS, getAdapter } from "../adapters/index.ts";
import type { HookEvent, HookEventType, HookOutcome, HookOutput } from "../adapters/types.ts";
import { now as clockNow } from "../core/clock.ts";
import type { Ctx } from "../core/context.ts";
import { LIMITS, cleanText } from "../core/docs.ts";
import { toRepoPath } from "../core/files.ts";
import { getIdentity, getIdentityFast } from "../core/identity.ts";
import { EXIT } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { log } from "../core/log.ts";
import { ensureStateDir, loadConfig, locateRepo } from "../core/paths.ts";
import type { RepoPaths } from "../core/paths.ts";
import { DEFAULT_BRIEFING_CHARS, formatAge, renderBriefing, renderOverlaps } from "../core/render.ts";
import { currentView, resolveSession } from "../core/session.ts";
import { readCache, readSeen, removeSeen, removeSession, updateLocal, writeFileAtomic, writeSeen } from "../core/store.ts";
import { spawnBackgroundSync, syncWithin } from "../core/sync.ts";
import { createTransport } from "../core/transport.ts";
import type { Config, Identity, LocalSession, LocalState, Seen } from "../core/types.ts";
import { overlaps } from "../core/view.ts";
import type { TeamView } from "../core/view.ts";
import { isBareWord, toIntent } from "./intent.ts";

/**
 * How long each event may take, in milliseconds, from the moment the hook
 * command starts to run. These are the budgets of plan.md §3, except
 * session-end: it does not wait for the network, and agents cut it short
 * anyway (Codex after 3 s whatever the hook file says, Claude Code after 1.5 s
 * for all SessionEnd hooks together unless a hook asks for more).
 */
export const DEADLINE_MS: Readonly<Record<HookEventType, number>> = Object.freeze({
  "session-start": 4000,
  prompt: 300,
  "pre-edit": 150,
  "post-edit": 150,
  "turn-end": 150,
  "session-end": 1000,
});

/**
 * The deadline of a pre-edit that names no session (event.ambient): a commit.
 * It is longer because such an event may wait for a sync (refreshFirst), and
 * nobody notices on a commit what would be felt before each of an agent's edits.
 */
const PATIENT_PRE_EDIT_MS = 1500;
/** The longest that wait may be. A timer in this file: git's own network timeouts are far longer. */
const MAX_REFRESH_WAIT_MS = 1000;
/** What is kept back from the deadline for the check that follows the wait. */
const CHECK_RESERVE_MS = 150;

/** The payload is on stdin before node has even started; a hook whose payload has not arrived by now is not going to get one. */
const STDIN_WAIT_MS = 300;
/** What session-start keeps back from its deadline for everything that comes after the sync. */
const BRIEFING_RESERVE_MS = 300;
/** A store lock is not waited for longer than this, nor into the last moments before the deadline. */
const MAX_STORE_WAIT_MS = 1000;
const STORE_MARGIN_MS = 30;
/**
 * A full briefing says so when the team state is older than this. It is also
 * when a commit waits for a sync first, and how long it is before the next
 * commit in the same clone may wait again.
 */
const STALE_AFTER_MS = 2 * 60_000;
const MAX_EVENT_PATHS = 200;
/** An edit of many files at once names at most this many overlapping paths in full. */
const MAX_WARNING_PATHS = 5;
const MAX_WARNING_CHARS = DEFAULT_BRIEFING_CHARS;
/** How many paths a session's warnings are remembered for. */
const MAX_WARNED_PATHS = 100;

// Keys in Seen.items that are the engine's own. renderBriefing uses "s:", "d:" and "tasks".
const BRIEFED = "briefed";
const WARNED = "w:";

const CUT_NOTE = "[huddle] Cut short to fit: run `huddle check` for the rest.";

/**
 * The two ways the engine reaches the network. A seam for tests, which replace
 * them to see what was asked for; nothing else should.
 */
export const effects = { spawnBackgroundSync, syncWithin };

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

interface Deadline {
  /** Milliseconds left; negative once it has passed. */
  left(): number;
}

function deadlineIn(startedMs: number, budgetMs: number): Deadline {
  const end = startedMs + budgetMs;
  return { left: () => end - performance.now() };
}

/** How long this event may take. Takes whatever it is given: an event that is not one gets the shortest deadline there is. */
function deadlineFor(event: HookEvent | null | undefined): number {
  const type: unknown = event?.type;
  if (typeof type !== "string" || !Object.hasOwn(DEADLINE_MS, type)) return DEADLINE_MS["pre-edit"];
  if (type === "pre-edit" && event?.ambient === true) return PATIENT_PRE_EDIT_MS;
  return DEADLINE_MS[type as HookEventType];
}

type Settled<T> = { done: true; value: T } | { done: false };

/**
 * `work`, or { done: false } once the deadline has passed. The work is not
 * stopped, only no longer waited for; what it returns or throws afterwards is
 * dropped.
 */
function before<T>(deadline: Deadline, work: Promise<T>): Promise<Settled<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ done: false }), Math.max(0, deadline.left()));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ done: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Which repository, which session
// ---------------------------------------------------------------------------

/**
 * A session id the store accepts, the same one for the same input every time.
 * Ids come from agents: anything that is not one clean line is made one, and
 * an id over the limit keeps its start and gets a hash of the whole in place
 * of the rest, so that two long ids stay two sessions. "" when there is
 * nothing to use.
 */
export function sessionIdOf(raw: unknown): string {
  const flat = cleanText(raw, Number.MAX_SAFE_INTEGER);
  const chars = Array.from(flat);
  if (chars.length <= LIMITS.sessionId) return flat;
  const hash = createHash("sha256").update(flat).digest("hex").slice(0, 16);
  return `${chars.slice(0, LIMITS.sessionId - 17).join("").trimEnd()}-${hash}`;
}

interface Where {
  paths: RepoPaths;
  /**
   * The agent is working outside this repository right now. Its session is
   * kept alive where it was, and nothing is learned from where it went.
   */
  away: boolean;
}

/** `huddle init` was run here (or someone made the directory by hand to opt this clone in). */
async function isSetUp(paths: RepoPaths): Promise<boolean> {
  try {
    return (await stat(paths.teamDir)).isDirectory();
  } catch {
    return false;
  }
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/**
 * The repository an event is about, or null when there is none huddle may
 * touch. It is the one the agent is working in (event.cwd) when that is set
 * up for huddle. Otherwise it is the one the hook was started in (io.cwd; for
 * Claude Code the project directory), provided that one is set up:
 *   - the agent is in another worktree of that same clone, on a branch from
 *     before `huddle init`: use the worktree it is in;
 *   - the agent is somewhere else entirely: the session stays where it was.
 */
async function locate(event: HookEvent, io: Io): Promise<Where | null> {
  const cwd = typeof event.cwd === "string" && event.cwd !== "" ? event.cwd : io.cwd;
  const there = await locateRepo(cwd);
  if (there !== null && (await isSetUp(there))) return { paths: there, away: false };
  if (resolve(cwd) === resolve(io.cwd)) return null;
  const home = await locateRepo(io.cwd);
  if (home === null || !(await isSetUp(home))) return null;
  if (there !== null && (await sameDirectory(there.commonDir, home.commonDir))) return { paths: there, away: false };
  return { paths: home, away: true };
}

// ---------------------------------------------------------------------------
// One event
// ---------------------------------------------------------------------------

/** Everything a handler needs about the event it is handling. */
interface Run {
  event: HookEvent;
  io: Io;
  /** The session id, cleaned. */
  id: string;
  paths: RepoPaths;
  away: boolean;
  /**
   * The event does not speak for the session: it is a subagent's, or it names
   * no session (event.ambient). It keeps the session alive and is warned
   * before an edit, and that is all.
   */
  passive: boolean;
  /** Fixed for the event; honors HUDDLE_NOW in io.env. */
  now: Date;
  deadline: Deadline;
}

interface Prepared {
  outcome: HookOutcome;
  /**
   * Records what `outcome` shows as shown. Runs after the output has been
   * printed: a hook that dies in between repeats itself next time, which is
   * better than a teammate's news being marked as delivered and never printed.
   */
  commit?: () => Promise<void>;
}

/** What handleEvent and runHook can say about an event that went wrong. */
interface Trace {
  paths: RepoPaths | null;
}

let lastTrace: Trace | null = null;

/**
 * For the hook command: an error nothing caught is about to end the process
 * (quietly, with exit code 0; see scripts/banner.mjs). Leave a line in the
 * debug log first, if the event got far enough to know where that is.
 */
export function noteCrash(error: unknown): void {
  log(lastTrace?.paths ?? null, "hook", "crashed", error);
}

function contextFor(run: Run, config: Config, identity: Identity): Ctx {
  return {
    io: run.io,
    paths: run.paths,
    config,
    identity,
    transport: createTransport({ cwd: run.paths.worktree, remote: config.remote }),
    now: run.now,
  };
}

function storeWait(deadline: Deadline): number {
  return Math.max(0, Math.min(MAX_STORE_WAIT_MS, Math.floor(deadline.left()) - STORE_MARGIN_MS));
}

interface Touched {
  state: LocalState;
  session: LocalSession;
  created: boolean;
  /** The session is in another worktree than it was. */
  moved: boolean;
  intentChanged: boolean;
}

/**
 * Creates the session or marks it as just seen, in one locked update.
 * `intent`, when not empty, becomes the session's intent. Null when the
 * session could not be recorded (the store is busy or broken): that is
 * logged, and the caller carries on without it.
 */
async function touch(run: Run, intent = ""): Promise<Touched | null> {
  const { event, id, paths, now } = run;
  const at = now.toISOString();
  const agent = cleanText(event.agent, LIMITS.name) || "unknown";
  const { passive } = run;
  let created = false;
  let moved = false;
  let intentChanged = false;
  try {
    const state = await updateLocal(
      paths,
      (local) => {
        let session = local.sessions.find((candidate) => candidate.id === id);
        if (session === undefined) {
          session = { id, agent, branch: "", intent: "", intentSource: "none", files: [], claims: [], startedAt: at, seenAt: at, worktree: paths.worktree };
          local.sessions.push(session);
          created = true;
        } else {
          session.seenAt = at;
          if (!passive) session.agent = agent;
          if (!passive && !run.away && session.worktree !== paths.worktree) {
            // Branch and files describe the worktree it left. The sync that follows fills them in again.
            session.worktree = paths.worktree;
            session.branch = "";
            session.files = [];
            moved = true;
          }
        }
        // A one-word prompt ("yes", "continue") says nothing about the work: it does not replace an intent that does.
        if (intent !== "" && intent !== session.intent && !(session.intent !== "" && isBareWord(intent))) {
          session.intent = intent;
          session.intentSource = "prompt";
          intentChanged = true;
        }
      },
      { waitMs: storeWait(run.deadline) },
    );
    const session = state.sessions.find((candidate) => candidate.id === id);
    return session === undefined ? null : { state, session, created, moved, intentChanged };
  } catch (error) {
    log(paths, "hook", `${event.type}: could not record the session`, error);
    return null;
  }
}

/**
 * Waits for one sync, for `budgetMs` at the most. Reaching that abandons the
 * wait and never the sync. syncWithin keeps to the budget itself when it can
 * run the sync in a process of its own; the timer here holds when it cannot.
 */
async function syncFor(ctx: Ctx, budgetMs: number): Promise<void> {
  await before(deadlineIn(performance.now(), budgetMs), effects.syncWithin(ctx, budgetMs));
}

/** A background sync after an event: not throttled when teammates have something new to learn. */
function syncAfter(run: Run, config: Config, touched: Touched | null, news = false): void {
  const force = news || (touched !== null && (touched.created || touched.moved));
  effects.spawnBackgroundSync(run.paths, run.io.self, force ? { force: true } : { config, now: run.now });
}

/** The worktree whose files are the viewer's own (see session.currentView). */
function viewerOf(run: Run, touched: Touched | null): string {
  return run.away && touched !== null ? touched.session.worktree : run.paths.worktree;
}

// ---------------------------------------------------------------- briefings

/** For a full briefing: says so when the team state behind it could not be refreshed. "" when it is fresh. */
function staleNote(view: TeamView): string {
  if (view.fetchedAt === null) {
    return "[huddle] The team state has not been fetched from the remote yet, so teammates may be missing here. If this stays, run `huddle doctor`.";
  }
  const age = Date.parse(view.now) - Date.parse(view.fetchedAt);
  if (!(age >= STALE_AFTER_MS)) return "";
  return `[huddle] The team state was last fetched ${formatAge(age)} and could not be refreshed since, so this may be out of date. If this stays, run \`huddle doctor\`.`;
}

function lines(...parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}

/** What a briefing built from `seen` leaves in seen/<session>: its items, the marker, and the warnings remembered so far. */
function withMemory(seen: Seen, since: Seen | null): Seen {
  const items: Record<string, string> = { ...seen.items, [BRIEFED]: "1" };
  if (since !== null) {
    let kept = 0;
    for (const [key, value] of Object.entries(since.items)) {
      if (key.startsWith(WARNED) && kept++ < MAX_WARNED_PATHS) items[key] = value;
    }
  }
  return { at: seen.at, items };
}

function sameItems(before_: Seen | null, after: Seen): boolean {
  if (before_ === null) return false;
  const keys = Object.keys(after.items);
  return keys.length === Object.keys(before_.items).length && keys.every((key) => before_.items[key] === after.items[key]);
}

async function sessionStart(run: Run): Promise<Prepared> {
  const { id, paths, io, deadline } = run;
  // Set whatever happens below: `huddle intent` typed by the agent should land in this session.
  const outcome: HookOutcome = { env: { HUDDLE_SESSION: id } };
  // What the session was shown before means nothing to a context that is new,
  // cleared or compacted. Forgotten first, so that a briefing that fails below
  // is made up for by a full one at the next prompt.
  await removeSeen(paths, id).catch((error: unknown) => log(paths, "hook", "session-start: could not forget what was shown", error));
  try {
    const [config, identity, touched] = await Promise.all([loadConfig(paths), getIdentity(paths), touch(run)]);
    const ctx = contextFor(run, config, identity);
    const budget = deadline.left() - BRIEFING_RESERVE_MS;
    if (budget > 0) await syncFor(ctx, budget);
    else effects.spawnBackgroundSync(paths, io.self, { force: true });
    const view = await currentView(ctx, id, undefined, viewerOf(run, touched));
    const briefing = renderBriefing(view);
    outcome.context = lines(briefing.text, staleNote(view));
    return { outcome, commit: () => writeSeen(paths, id, withMemory(briefing.seen, null)) };
  } catch (error) {
    log(paths, "hook", "session-start: no briefing", error);
    return { outcome };
  }
}

async function prompt(run: Run): Promise<Prepared> {
  const { event, id, paths } = run;
  const config = await loadConfig(paths);
  const intent = config.captureIntent ? toIntent(event.prompt) : "";
  const [touched, identity, since] = await Promise.all([
    touch(run, intent),
    getIdentityFast(paths).catch((error: unknown) => {
      log(paths, "hook", "prompt: no briefing", error);
      return null;
    }),
    readSeen(paths, id),
  ]);
  syncAfter(run, config, touched, touched !== null && touched.intentChanged);
  if (identity === null) return { outcome: {} };

  const view = await currentView(contextFor(run, config, identity), id, touched?.state, viewerOf(run, touched));
  // Without a briefing to compare with (hooks installed mid-session, or a session-start that failed) this is the full one.
  const baseline = since !== null && Object.hasOwn(since.items, BRIEFED) ? since : null;
  const briefing = renderBriefing(view, { since: baseline });
  const text = baseline === null ? lines(briefing.text, staleNote(view)) : briefing.text;
  const next = withMemory(briefing.seen, since);
  const prepared: Prepared = { outcome: text === "" ? {} : { context: text } };
  if (!sameItems(since, next)) prepared.commit = () => writeSeen(paths, id, next);
  return prepared;
}

// ------------------------------------------------------------------- edits

/** The event's paths as repo-relative paths, without repeats. Paths outside the worktree are not huddle's business. */
function targetPaths(run: Run): string[] {
  const { event, io, paths } = run;
  if (!Array.isArray(event.paths)) return [];
  const base = typeof event.cwd === "string" && event.cwd !== "" ? event.cwd : io.cwd;
  const targets = new Set<string>();
  for (const raw of event.paths.slice(0, MAX_EVENT_PATHS)) {
    if (typeof raw !== "string" || raw === "") continue;
    const path = toRepoPath(paths, base, raw);
    if (path !== null) targets.add(path);
  }
  return [...targets];
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - CUT_NOTE.length - 1;
  const lineEnd = text.lastIndexOf("\n", room);
  let end = lineEnd > 0 ? lineEnd : room;
  const last = text.charCodeAt(end - 1);
  if (lineEnd <= 0 && last >= 0xd800 && last <= 0xdbff) end--; // do not split a surrogate pair
  return `${text.slice(0, end)}\n${CUT_NOTE}`;
}

function warningText(blocks: string[]): string {
  if (blocks.length === 0) return "";
  const shown = blocks.slice(0, MAX_WARNING_PATHS);
  const more = blocks.length - shown.length;
  if (more > 0) shown.push(`[huddle] ${more} more of the paths in this edit overlap teammates' work as well: run \`huddle check\`.`);
  return clip(shown.join("\n"), MAX_WARNING_CHARS);
}

/** Drops the oldest remembered warnings once there are more than MAX_WARNED_PATHS. Edits `items`. */
function capWarned(items: Record<string, string>): Record<string, string> {
  const warned = Object.keys(items).filter((key) => key.startsWith(WARNED));
  for (const key of warned.slice(0, Math.max(0, warned.length - MAX_WARNED_PATHS))) delete items[key];
  return items;
}

/**
 * The warning for the paths about to be edited, from the cache: no network.
 *
 * A path is warned about when a session overlaps it that this session has not
 * been told about for that path yet. So ten edits of one contested file give
 * one warning, a second teammate arriving on the file gives another, and a
 * session-start (a new or compacted context) starts over. A subagent is
 * always warned and nothing is remembered for it: its context is not the
 * session's, and it does not last. The same goes for an event that names no
 * session: whoever runs `git commit` has no context here at all.
 */
async function overlapWarning(run: Run, targets: string[]): Promise<Prepared> {
  const { id, paths, now } = run;
  const remember = !run.passive;
  const [identity, config, since] = await Promise.all([getIdentityFast(paths), loadConfig(paths), remember ? readSeen(paths, id) : null]);
  const view = await currentView(contextFor(run, config, identity), id, undefined, paths.worktree);

  const items: Record<string, string> = { ...(since?.items ?? {}) };
  const blocks: string[] = [];
  let changed = false;
  for (const path of targets) {
    const key = WARNED + path;
    const found = view.sessions.length === 0 ? [] : overlaps(view, path);
    if (found.length === 0) {
      if (Object.hasOwn(items, key)) {
        delete items[key];
        changed = true;
      }
      continue;
    }
    const who = found.map((overlap) => shortHash(`${overlap.session.actor}/${overlap.session.id}`)).sort();
    const told = new Set((Object.hasOwn(items, key) ? (items[key] ?? "") : "").split(","));
    if (!remember || who.some((one) => !told.has(one))) blocks.push(renderOverlaps(path, found, now));
    const value = who.join(",");
    if (remember && items[key] !== value) {
      items[key] = value;
      changed = true;
    }
  }

  const text = warningText(blocks);
  const prepared: Prepared = { outcome: text === "" ? {} : { context: text } };
  if (remember && changed) {
    prepared.commit = () => writeSeen(paths, id, { at: since?.at ?? now.toISOString(), items: capWarned(items) });
  }
  return prepared;
}

/** When a hook in this clone last waited for a sync before a commit (ISO text). */
function waitStamp(paths: RepoPaths): string {
  return join(paths.stateDir, "wait-stamp");
}

/**
 * Comes before the check of a pre-edit that names no session, which is a
 * commit. An agent's own hooks sync every few seconds. Between two commits
 * nothing does, and a teammate only counts for ttlMinutes after they were last
 * seen, so a team state fetched half an hour ago shows nobody and the check
 * could never find anything. When the state is older than STALE_AFTER_MS, one
 * sync is therefore waited for first.
 *
 * The wait is bounded twice. A timer here ends it after MAX_REFRESH_WAIT_MS at
 * the latest; that abandons the wait and not the sync, and the check goes
 * ahead with the state there is. And the whole clone waits at most once per
 * STALE_AFTER_MS, which is recorded before the wait begins, so that whoever is
 * offline pays for it once and not at every commit.
 *
 * True when a sync was started and waited for. Says nothing either way: what
 * the hook prints is the warning or nothing, whether the sync made it or not.
 */
async function refreshFirst(run: Run): Promise<boolean> {
  const { paths, now, deadline } = run;
  try {
    const { fetchedAt } = await readCache(paths);
    // A state dated in the future (a clock that was set back) counts as fresh: the next sync dates it again.
    const stateAge = fetchedAt === null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(fetchedAt);
    if (!(stateAge >= STALE_AFTER_MS)) return false;
    // A stamp from the future must not put the wait off for ever, so only an age that is not negative counts.
    const stamp = waitStamp(paths);
    const waitedAgo = now.getTime() - Date.parse((await readFile(stamp, "utf8").catch(() => "")).trim());
    if (waitedAgo >= 0 && waitedAgo < STALE_AFTER_MS) return false;
    const budget = Math.min(MAX_REFRESH_WAIT_MS, Math.floor(deadline.left()) - CHECK_RESERVE_MS);
    if (budget <= 0) return false;
    // Recorded first: if it cannot be, there is no limit on how often this would wait, so it does not wait at all.
    await ensureStateDir(paths);
    await writeFileAtomic(stamp, now.toISOString());
    const [config, identity] = await Promise.all([loadConfig(paths), getIdentityFast(paths)]);
    await syncFor(contextFor(run, config, identity), budget);
    return true;
  } catch (error) {
    log(paths, "hook", "pre-edit: could not refresh the team state first", error);
    return false;
  }
}

async function preEdit(run: Run): Promise<Prepared> {
  const { event, paths, io } = run;
  const targets = targetPaths(run);
  // A commit may wait for the team state; an agent's edit never does.
  const patient = event.ambient === true && targets.length > 0;
  const recorded = touch(run).then(async (touched) => {
    // A sync that was waited for publishes a session that is new as well.
    if (patient && (await refreshFirst(run))) return;
    if (touched !== null && (touched.created || touched.moved)) effects.spawnBackgroundSync(paths, io.self, { force: true });
  });
  // Otherwise the session is recorded alongside the check, not before it: the check does not need it, and the budget is short.
  if (patient) await recorded;
  let prepared: Prepared = { outcome: {} };
  if (targets.length > 0) {
    try {
      prepared = await overlapWarning(run, targets);
    } catch (error) {
      log(paths, "hook", "pre-edit: could not check for overlap", error);
    }
  }
  await recorded;
  return prepared;
}

/** post-edit, and every event of a subagent except pre-edit: the session is alive, and a sync may be due. */
async function heartbeat(run: Run): Promise<Prepared> {
  const [touched, config] = await Promise.all([touch(run), loadConfig(run.paths)]);
  syncAfter(run, config, touched);
  return { outcome: {} };
}

async function turnEnd(run: Run): Promise<Prepared> {
  await touch(run);
  // Not throttled: after the end of a turn nothing else may run for minutes,
  // and the turn's last edits must not wait that long to be published.
  // Detached and never waited for: such a sync waits up to 20 s for a round
  // that is already running.
  effects.spawnBackgroundSync(run.paths, run.io.self, { force: true });
  return { outcome: {} };
}

/** Removes the session from `paths`; when there was one, a sync that is not throttled publishes that it left. */
async function endSession(run: Run, paths: RepoPaths): Promise<void> {
  try {
    if (await removeSession(paths, run.id, { waitMs: storeWait(run.deadline) })) {
      effects.spawnBackgroundSync(paths, run.io.self, { force: true });
    }
  } catch (error) {
    log(paths, "hook", "session-end: could not remove the session; it will age out instead", error);
  }
}

async function sessionEnd(run: Run): Promise<Prepared> {
  const { event, io, paths } = run;
  await endSession(run, paths);
  // A session that started in one set-up clone and ended in another has a record in both.
  if (!run.away && typeof event.cwd === "string" && event.cwd !== "" && resolve(event.cwd) !== resolve(io.cwd)) {
    const home = await locateRepo(io.cwd);
    if (home !== null && (await isSetUp(home)) && !(await sameDirectory(home.commonDir, paths.commonDir))) await endSession(run, home);
  }
  return { outcome: {} };
}

/**
 * The session of an event that names none: the one a CLI command typed in the
 * same worktree would act as (HUDDLE_SESSION, else the session last active in
 * this worktree, else the worktree's manual session).
 */
async function ambientSession(run: Run): Promise<string> {
  const [config, identity] = await Promise.all([loadConfig(run.paths), getIdentityFast(run.paths)]);
  return (await resolveSession(contextFor(run, config, identity))).id;
}

async function prepare(event: HookEvent, io: Io, deadline: Deadline, trace: Trace): Promise<Prepared> {
  if (typeof event.type !== "string" || !Object.hasOwn(DEADLINE_MS, event.type)) return { outcome: {} };
  const ambient = event.ambient === true;
  const named = ambient ? "" : sessionIdOf(event.sessionId);
  if (!ambient && named === "") return { outcome: {} };
  const where = await locate(event, io);
  // An event that names no session says nothing about the sessions of a repository it did not happen in.
  if (where === null || (ambient && where.away)) return { outcome: {} };
  trace.paths = where.paths;
  const run: Run = {
    event,
    io,
    id: named,
    paths: where.paths,
    away: where.away,
    passive: ambient || event.subagent === true,
    now: clockNow(io.env),
    deadline,
  };
  if (ambient) run.id = await ambientSession(run);
  if (run.id === "") return { outcome: {} };

  if (run.passive && event.type !== "pre-edit") return heartbeat(run);
  switch (event.type) {
    case "session-start":
      return sessionStart(run);
    case "prompt":
      return prompt(run);
    case "pre-edit":
      return preEdit(run);
    case "post-edit":
      return heartbeat(run);
    case "turn-end":
      return turnEnd(run);
    case "session-end":
      return sessionEnd(run);
    default:
      return { outcome: {} };
  }
}

async function commit(prepared: Prepared, deadline: Deadline, trace: Trace, type: unknown): Promise<void> {
  if (prepared.commit === undefined) return;
  try {
    await before(deadline, prepared.commit());
  } catch (error) {
    log(trace.paths, "hook", `${String(type)}: could not record what was shown`, error);
  }
}

/**
 * Handles one normalized event and returns what should be put in front of the
 * agent. Never throws and never takes longer than the event's deadline: an
 * internal error or a deadline that passes is logged and yields an empty
 * outcome.
 */
export async function handleEvent(event: HookEvent, io: Io): Promise<HookOutcome> {
  const trace: Trace = { paths: null };
  lastTrace = trace;
  try {
    const budget = deadlineFor(event);
    const deadline = deadlineIn(performance.now(), budget);
    const prepared = await before(deadline, prepare(event, io, deadline, trace));
    if (!prepared.done) {
      log(trace.paths, "hook", `${event.type}: gave up at its deadline of ${budget} ms`);
      return {};
    }
    await commit(prepared.value, deadline, trace, event.type);
    return prepared.value.outcome;
  } catch (error) {
    log(trace.paths, "hook", "an event failed", error);
    return {};
  }
}

// ---------------------------------------------------------------------------
// The hook command
// ---------------------------------------------------------------------------

/**
 * Appends each line to its file unless the file already has that line. Such a
 * file is run as shell code by the agent, so a "line" with a line break in it
 * is refused here whatever the adapter checked. Errors are swallowed.
 * Exported for tests.
 */
export async function appendLines(entries: HookOutput["appendLines"]): Promise<void> {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    try {
      if (typeof entry?.path !== "string" || typeof entry.line !== "string") continue;
      if (entry.path === "" || entry.line === "" || /[\r\n]/.test(entry.line)) continue;
      let existing = "";
      try {
        existing = await readFile(entry.path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing.split(/\r?\n/).includes(entry.line)) continue;
      await mkdir(dirname(entry.path), { recursive: true });
      await appendFile(entry.path, `${existing !== "" && !existing.endsWith("\n") ? "\n" : ""}${entry.line}\n`);
    } catch {
      // The agent goes without the variable; nothing here depends on it.
    }
  }
}

function exitCodeOf(code: unknown): number {
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : EXIT.OK;
}

/**
 * `huddle hook <agent> [args...]`: read stdin, let the adapter parse it, run
 * the event, print what the adapter formats. Returns the exit code, which is
 * 0 on every internal error and when the event's deadline passes: a hook
 * never breaks the agent. (The adapter may ask for another exit code where
 * its agent's protocol needs one; none does today.)
 */
export async function runHook(args: string[], io: Io): Promise<number> {
  const started = performance.now();
  const trace: Trace = { paths: null };
  lastTrace = trace;
  try {
    const [name, ...rest] = args;
    const adapter = typeof name === "string" ? getAdapter(name) : undefined;
    if (adapter === undefined) {
      const known = ADAPTERS.map((candidate) => candidate.name).join(", ");
      // Not an internal error but a hook command that was written wrong. Still exit 0: on some agents any other code blocks the tool call.
      io.err(name === undefined ? `Usage: huddle hook <agent>   (agents: ${known})` : `huddle: no hook adapter named ${JSON.stringify(String(name).slice(0, 60))}. Known: ${known}.`);
      return EXIT.OK;
    }

    const stdin = await before(deadlineIn(started, STDIN_WAIT_MS + 50), io.readStdin({ timeoutMs: STDIN_WAIT_MS, json: true }));
    if (!stdin.done) return EXIT.OK;
    const event = adapter.parse({ args: rest, stdin: stdin.value, env: io.env, cwd: io.cwd });
    if (event === null || typeof event !== "object") return EXIT.OK; // not an event huddle cares about

    const budget = deadlineFor(event);
    const deadline = deadlineIn(started, budget);
    const prepared = await before(deadline, prepare(event, io, deadline, trace));
    if (!prepared.done) {
      log(trace.paths, "hook", `${event.type}: gave up at its deadline of ${budget} ms`);
      return EXIT.OK;
    }

    const output = adapter.format(event, prepared.value.outcome);
    await before(deadline, appendLines(output.appendLines));
    if (typeof output.stdout === "string" && output.stdout !== "") io.out(output.stdout);
    if (typeof output.stderr === "string" && output.stderr !== "") io.err(output.stderr);
    await commit(prepared.value, deadline, trace, event.type);
    return exitCodeOf(output.exitCode);
  } catch (error) {
    log(trace.paths, "hook", "the hook failed", error);
    return EXIT.OK;
  }
}
