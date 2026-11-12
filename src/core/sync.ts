// T1.4. One sync round (plan.md §3 Sync), and starting one in the background.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ageMs } from "./clock.ts";
import type { Ctx } from "./context.ts";
import { normalizeDoc } from "./docs.ts";
import { currentBranch, filesInFlight } from "./files.ts";
import { log } from "./log.ts";
import { ensureStateDir } from "./paths.ts";
import type { RepoPaths } from "./paths.ts";
import { toActorDoc } from "./session.ts";
import { readCache, readLocal, removeSeen, updateLocal, withLock, writeCache } from "./store.ts";
import type { LockResult } from "./store.ts";
import { actorRef } from "./types.ts";
import type { ActorDoc, CacheEntry, Config, Doc, FailReason, LocalState, PublishResult } from "./types.ts";

export interface SyncOptions {
  /** Ignore syncIntervalSeconds, and wait for a sync that is already running instead of skipping. */
  force?: boolean;
}

export interface SyncResult {
  /** False when the round was skipped. */
  ran: boolean;
  skipped?: "throttled" | "locked";
  /** The cache was refreshed from the remote. */
  fetched: boolean;
  /** This clone's ActorDoc was pushed. */
  published: boolean;
  /** Why the fetch or the publish failed, if either did; "internal" for a bug on our side. */
  error?: FailReason | "internal";
}

/** A forced sync waits this long for a round that is already running. */
export const FORCED_LOCK_WAIT_MS = 20_000;
/** A sync.lock whose holder stopped heartbeating for this long is taken over. */
const SYNC_LOCK_STALE_MS = 60_000;

/**
 * Runs `fn` holding sync.lock, waiting up to `waitMs` for it. Everything that
 * writes cache.json takes this lock, so a round and a `huddle decide` never
 * overwrite each other's view of the remote.
 */
export function withSyncLock<T>(paths: RepoPaths, waitMs: number, fn: () => Promise<T>): Promise<LockResult<T>> {
  return withLock(paths, "sync", fn, { waitMs, staleMs: SYNC_LOCK_STALE_MS });
}

/** When the last round started (ISO text). Local bookkeeping for the throttle; see stampFile. */
function stampFile(paths: RepoPaths): string {
  return join(paths.stateDir, "sync-stamp");
}

/** How much longer the throttle holds, in milliseconds; 0 when a background sync may run now. */
function throttleLeftMs(stamp: string | null, config: Config, now: Date): number {
  if (!stamp) return 0;
  const age = ageMs(stamp.trim(), now);
  const interval = config.syncIntervalSeconds * 1000;
  // A stamp from the future (clock change, pinned test clock) must not block syncing forever.
  return age >= 0 && age < interval ? interval - age : 0;
}

function throttledAt(stamp: string | null, config: Config, now: Date): boolean {
  return throttleLeftMs(stamp, config, now) > 0;
}

function readStamp(paths: RepoPaths): string | null {
  try {
    return readFileSync(stampFile(paths), "utf8");
  } catch {
    return null;
  }
}

/**
 * The content hash of the last ActorDoc this clone tried to push. A push can
 * reach the remote without being recorded in local.json (the process is killed
 * in between, or the connection drops after the server took the ref); this is
 * how the next round still recognizes that doc as its own.
 */
function attemptFile(paths: RepoPaths): string {
  return join(paths.stateDir, "publish-attempt");
}

function readAttempt(paths: RepoPaths): string | null {
  try {
    return readFileSync(attemptFile(paths), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * 1. Take sync.lock; skip if the last sync was under syncIntervalSeconds ago, unless forced.
 * 2. Recompute branch and files for each local session; drop sessions past the TTL.
 * 3. Refresh cache.json from the remote.
 * 4. Publish the ActorDoc if it changed or the last publish is older than heartbeatMinutes.
 * Steps 3 and 4 run concurrently. Never throws; failures are logged and reported in the result.
 */
export async function sync(ctx: Ctx, opts: SyncOptions = {}): Promise<SyncResult> {
  const skipped = (why: "throttled" | "locked"): SyncResult => ({ ran: false, skipped: why, fetched: false, published: false });
  try {
    await ensureStateDir(ctx.paths);
    if (!opts.force && throttledAt(readStamp(ctx.paths), ctx.config, ctx.now)) return skipped("throttled");
    const locked = await withSyncLock(ctx.paths, opts.force ? FORCED_LOCK_WAIT_MS : 0, async () => {
      // Another process may have synced while we waited for the lock.
      if (!opts.force && throttledAt(readStamp(ctx.paths), ctx.config, ctx.now)) return skipped("throttled");
      await writeFile(stampFile(ctx.paths), ctx.now.toISOString());
      // After the stamp and before the round reads local state: see pendingFile.
      clearPending(ctx.paths);
      return round(ctx);
    });
    return locked.acquired ? locked.value : skipped("locked");
  } catch (error) {
    log(ctx.paths, "sync", "sync failed", error);
    return { ran: false, fetched: false, published: false, error: "internal" };
  }
}

async function round(ctx: Ctx): Promise<SyncResult> {
  const { paths, config, identity, transport, now } = ctx;
  const state = await refreshSessions(ctx);
  const cache = await readCache(paths);
  const ownRef = actorRef(identity.actor);

  const doc = toActorDoc(identity, state.sessions, now, config.ttlMinutes);
  const hash = contentHash(doc);
  const known = new Map(Object.entries(cache.refs).map(([ref, entry]) => [ref, entry.sha]));

  const lastAttempt = readAttempt(paths);
  const publish = async (): Promise<PublishResult> => {
    await writeFile(attemptFile(paths), hash);
    return transport.publish(ownRef, doc, "own");
  };

  // What teammates hold for each of our sessions, as far as the cache knows.
  const shown = shownSeenAt(cache.refs[ownRef], state.published);
  const publishDue = shouldPublish(state.published, doc, hash, now, config, shown);
  const [fetched, firstPublish] = await Promise.all([transport.fetchAll(known), publishDue ? publish() : Promise.resolve(null)]);

  let cacheChanged = false;
  if (fetched.ok) {
    const theirs = fetched.changed.get(ownRef);
    const ours = [state.published?.sha, firstPublish?.ok ? firstPublish.sha : undefined];
    if (theirs && !ours.includes(theirs.sha)) {
      const strangers = foreignSessions(theirs.doc, state, [state.published?.hash, lastAttempt, hash], now, config);
      if (strangers.length > 0) {
        log(
          paths,
          "sync",
          `another clone is publishing as this one: ${ownRef} holds session ${strangers.slice(0, 3).join(", ")}, which is not a session of this clone. ` +
            `This happens when a repository is copied together with its .git directory. Delete ${paths.actorFile} in the copy.`,
        );
      }
    }
    for (const [ref, entry] of fetched.changed) cache.refs[ref] = { sha: entry.sha, doc: entry.doc };
    for (const ref of fetched.removed) delete cache.refs[ref];
    cache.fetchedAt = now.toISOString();
    cacheChanged = true;
  } else {
    log(paths, "sync", `fetch failed: ${fetched.reason}`);
  }

  let published: PublishResult | null = firstPublish;
  if (!published && fetched.ok && state.published && doc.sessions.length > 0) {
    if (cache.refs[ownRef]?.sha !== state.published.sha) {
      // Our doc should be on the remote at the sha we last published. It is not
      // there (deleted, or overwritten by someone else): put it back.
      published = await publish();
    } else if (shown === null && shouldPublish(state.published, doc, hash, now, config, shownSeenAt(cache.refs[ownRef], state.published))) {
      // The cache had no copy of our own doc (it was lost), so the rule could
      // not see what teammates hold. The fetch has just brought that copy.
      published = await publish();
    }
  }

  if (published?.ok) {
    const sha = published.sha;
    await updateLocal(paths, (current) => {
      current.published = { at: now.toISOString(), hash, sha };
    });
    // Applied after the fetch: the listing may predate our own push.
    cache.refs[ownRef] = { sha, doc: normalizeDoc(doc) };
    cacheChanged = true;
  } else if (published) {
    log(paths, "sync", `publish failed: ${published.reason}`);
  }

  if (cacheChanged) await writeCache(paths, cache);

  const result: SyncResult = { ran: true, fetched: fetched.ok, published: published?.ok === true };
  const failure = !fetched.ok ? fetched.reason : published && !published.ok ? published.reason : undefined;
  if (failure) result.error = failure;
  return result;
}

/**
 * Evidence that another clone writes this clone's ref: the live sessions in
 * `remote`, the doc found there, that this clone does not have. Empty when the
 * doc is one this clone pushed (`ownHashes`: recorded, attempted, or being
 * pushed right now) or when every live session in it is known here.
 *
 * Both conditions are needed. A doc of ours can hold a session we no longer
 * have (it ended since); and a doc that is not ours with only sessions we know
 * is no proof of a second writer.
 */
export function foreignSessions(
  remote: Doc | null,
  state: LocalState,
  ownHashes: readonly (string | null | undefined)[],
  now: Date,
  config: Config,
): string[] {
  if (!remote || remote.kind !== "actor") return [];
  if (ownHashes.includes(contentHash(remote))) return [];
  const ttlMs = config.ttlMinutes * 60_000;
  const known = new Set(state.sessions.map((session) => session.id));
  return remote.sessions.filter((session) => !known.has(session.id) && ageMs(session.seenAt, now) < ttlMs).map((session) => session.id);
}

/** Step 2: drops sessions past the TTL and recomputes branch and files for the rest. Returns the new local state. */
async function refreshSessions(ctx: Ctx): Promise<LocalState> {
  const { paths, config, now } = ctx;
  const ttlMs = config.ttlMinutes * 60_000;
  const live = (seenAt: string) => ageMs(seenAt, now) < ttlMs;

  const before = await readLocal(paths);
  // Sessions that share a worktree share its branch and files: inspect each worktree once.
  const worktrees = [...new Set(before.sessions.filter((session) => live(session.seenAt)).map((session) => session.worktree))];
  const inspected = new Map<string, { branch: string; files: string[] }>();
  await Promise.all(
    worktrees.map(async (worktree) => {
      const found = await inspectWorktree(worktree, config);
      if (found) inspected.set(worktree, found);
    }),
  );

  const dropped: string[] = [];
  // Applied to whatever the state is now: a hook may have touched it while we ran git.
  const after = await updateLocal(paths, (current) => {
    current.sessions = current.sessions.filter((session) => {
      if (live(session.seenAt)) return true;
      dropped.push(session.id);
      return false;
    });
    for (const session of current.sessions) {
      const found = inspected.get(session.worktree);
      if (found) {
        session.branch = found.branch;
        session.files = found.files;
      }
    }
  });
  await Promise.all(dropped.map((id) => removeSeen(paths, id).catch(() => {})));
  return after;
}

/** Null when the worktree is gone; its sessions then keep what they last reported until the TTL drops them. */
async function inspectWorktree(worktree: string, config: Config): Promise<{ branch: string; files: string[] } | null> {
  try {
    if (!(await stat(worktree)).isDirectory()) return null;
  } catch {
    return null;
  }
  const [branch, files] = await Promise.all([currentBranch(worktree), filesInFlight(worktree, config)]);
  return { branch, files };
}

/**
 * For each of our sessions, the seenAt teammates hold: the one in `entry`,
 * a copy of our own ref, when that copy is the document we published last.
 * Null when it is not, or when there is no copy.
 */
function shownSeenAt(entry: CacheEntry | undefined, published: LocalState["published"]): Map<string, string> | null {
  if (!published || !entry || entry.sha !== published.sha || entry.doc?.kind !== "actor") return null;
  return new Map(entry.doc.sessions.map((session) => [session.id, session.seenAt] as const));
}

/**
 * A hash of what teammates would see change: everything except the timestamps
 * that move on every activity (updatedAt, seenAt), with lists in a fixed order.
 */
export function contentHash(doc: ActorDoc): string {
  const stable = [
    doc.actor,
    doc.user,
    doc.host,
    doc.sessions
      .map((session) => [
        session.id,
        session.agent,
        session.branch,
        session.intent,
        session.intentSource,
        [...session.files].sort(),
        [...session.claims].sort(),
        session.startedAt,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ];
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Step 4's rule. Publish when the content changed; or as a heartbeat, when the
 * last publish is older than heartbeatMinutes and some session has been active
 * since. A clone with no sessions that never published has nothing to say.
 *
 * One more case, inside the heartbeat interval. Teammates judge each session by
 * the seenAt they hold for it (`shown`: session id to the seenAt in the last
 * publish). A publish carries every session's seenAt as it was then, so a
 * session that had been quiet for a while when another session of this clone
 * caused the last publish is shown with its old seenAt. If it then wakes up,
 * waiting out the interval would leave it looking expired to teammates while
 * it is at work: its files and claims would vanish from their view and its
 * tasks could be taken. So a session seen a heartbeat or more after what
 * teammates hold for it is published at once.
 */
export function shouldPublish(
  published: LocalState["published"],
  doc: ActorDoc,
  hash: string,
  now: Date,
  config: Config,
  shown: ReadonlyMap<string, string> | null = null,
): boolean {
  if (!published) return doc.sessions.length > 0;
  if (published.hash !== hash) return true;
  const sinceLast = ageMs(published.at, now);
  if (Number.isNaN(sinceLast) || sinceLast < 0) return true;
  const heartbeat = config.heartbeatMinutes * 60_000;
  if (sinceLast >= heartbeat) return doc.sessions.some((session) => Date.parse(session.seenAt) > Date.parse(published.at));
  if (!shown) return false;
  return doc.sessions.some((session) => {
    const theirs = shown.get(session.id);
    return theirs !== undefined && Date.parse(session.seenAt) - Date.parse(theirs) >= heartbeat;
  });
}

export interface BackgroundOptions {
  /** With `now`, do not even start a process when the last sync is under syncIntervalSeconds old. */
  config?: Config;
  now?: Date;
  /** Pass --force to the background sync. */
  force?: boolean;
}

function backgroundDisabled(): boolean {
  return process.env.HUDDLE_NO_BACKGROUND === "1";
}

function startDetached(paths: RepoPaths, self: string, args: string[]) {
  const child = spawn(process.execPath, [self, "sync", "--background", ...args], {
    cwd: paths.worktree,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  return child;
}

/**
 * Starts `huddle sync --background` as a detached process and returns
 * immediately. `self` is the path of the running huddle script (io.self).
 * Never throws. Does nothing when HUDDLE_NO_BACKGROUND=1 (tests). The throttle
 * is enforced inside the sync; `opts.config` only saves starting a process
 * that would be throttled anyway. A throttled sync is not lost: one deferred
 * sync runs when the interval ends (deferSync).
 */
export function spawnBackgroundSync(paths: RepoPaths, self: string, opts: BackgroundOptions = {}): void {
  try {
    if (backgroundDisabled() || !self) return;
    const now = opts.now ?? new Date();
    if (!opts.force && opts.config && throttledAt(readStamp(paths), opts.config, now)) {
      deferSync(paths, self, opts.config, now);
      return;
    }
    startDetached(paths, self, opts.force === true ? ["--force"] : []).unref();
  } catch (error) {
    log(paths, "sync", "could not start a background sync", error);
  }
}

/**
 * The deferred sync that is waiting for the throttle to end, if there is one:
 * `{ token, dueAt }`, dueAt in real milliseconds. A background sync that is
 * skipped leaves one behind, so that what it would have published is still
 * published when the interval is over, even when no other event follows (a
 * plain `git commit` has no end of turn after it).
 * - At most one waits per clone: whoever creates this file starts it.
 * - Every round removes the file once its stamp is written and before it
 *   reads local state. So an event that found the file is covered by that
 *   round, and an event after it is throttled by that stamp and leaves a new
 *   file.
 * - The waiting process syncs only if the file still holds its token: if not,
 *   a round has run since, and that round covered what it was waiting for.
 * So background syncs that are not forced stay one interval apart.
 */
function pendingFile(paths: RepoPaths): string {
  return join(paths.stateDir, "sync-pending");
}

interface Pending {
  token: string;
  dueAt: number;
}

/** A deferred sync that has not run this long after it was due is taken for dead, and may be replaced. */
const PENDING_GRACE_MS = FORCED_LOCK_WAIT_MS + 10_000;
/** No deferred sync waits longer than the longest syncIntervalSeconds. */
const PENDING_MAX_WAIT_MS = 3_600_000;

function readPending(paths: RepoPaths): Pending | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingFile(paths), "utf8")) as Partial<Pending> | null;
    if (parsed && typeof parsed.token === "string" && typeof parsed.dueAt === "number") return { token: parsed.token, dueAt: parsed.dueAt };
  } catch {
    // Not there, or being written at this moment.
  }
  return null;
}

/** Removes the file: whatever it holds, or only when it holds `token`. Never throws. */
function clearPending(paths: RepoPaths, token?: string): void {
  try {
    if (token !== undefined && readPending(paths)?.token !== token) return;
    rmSync(pendingFile(paths), { force: true });
  } catch {
    // A file left behind is replaced once it is past its grace time.
  }
}

/** Creates the file. False when a deferred sync is already waiting. */
function claimPending(paths: RepoPaths, pending: Pending): boolean {
  const file = pendingFile(paths);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(pending), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = readPending(paths);
    let since = current?.dueAt;
    if (since === undefined) {
      try {
        since = statSync(file).mtimeMs; // unreadable: judged by its age
      } catch {
        since = 0; // gone in the meantime
      }
    }
    if (Date.now() <= since + PENDING_GRACE_MS) return false;
    rmSync(file, { force: true });
  }
  return false;
}

/**
 * Makes sure a sync runs when the throttle interval is over: starts one
 * detached process that waits until then, unless one is already waiting.
 * For a background sync that was skipped (throttled, or another sync held the
 * lock). Never throws. Does nothing when HUDDLE_NO_BACKGROUND=1 (tests).
 */
export function deferSync(paths: RepoPaths, self: string, config: Config, now: Date = new Date()): void {
  if (backgroundDisabled() || !self) return;
  const token = randomBytes(8).toString("hex");
  let claimed = false;
  try {
    const wait = Math.min(throttleLeftMs(readStamp(paths), config, now), PENDING_MAX_WAIT_MS);
    claimed = claimPending(paths, { token, dueAt: Date.now() + wait });
    if (!claimed) return;
    const child = startDetached(paths, self, ["--deferred", token]);
    child.on("error", () => clearPending(paths, token));
    child.unref();
  } catch (error) {
    // A claim with no process behind it would hold every later one off until its grace time is over.
    if (claimed) clearPending(paths, token);
    log(paths, "sync", "could not defer a background sync", error);
  }
}

/**
 * For the process deferSync started: waits until the deferred sync is due.
 * False when it is not wanted any more, because a sync ran in the meantime.
 */
export async function deferredSyncDue(paths: RepoPaths, token: string): Promise<boolean> {
  const mine = readPending(paths);
  if (mine?.token !== token) return false;
  const wait = Math.min(mine.dueAt - Date.now(), PENDING_MAX_WAIT_MS);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return readPending(paths)?.token === token;
}

/** For the same process, when it is done: removes the file if it still holds `token`. */
export function releaseDeferredSync(paths: RepoPaths, token: string): void {
  clearPending(paths, token);
}

/**
 * A forced sync with a deadline, for hooks with a time budget (session-start,
 * session-end). The sync runs in a detached process, so reaching the deadline
 * abandons the wait but not the sync: a push in flight still completes. True
 * when the sync finished in time. With HUDDLE_NO_BACKGROUND=1 the sync runs
 * in-process and the budget is not enforced.
 */
export async function syncWithin(ctx: Ctx, budgetMs: number): Promise<boolean> {
  if (backgroundDisabled() || !ctx.io.self) {
    await sync(ctx, { force: true });
    return true;
  }
  try {
    const child = startDetached(ctx.paths, ctx.io.self, ["--force"]);
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.unref();
        resolve(false);
      }, budgetMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", done);
      child.once("error", done);
    });
  } catch (error) {
    log(ctx.paths, "sync", "could not start a sync", error);
    return false;
  }
}
