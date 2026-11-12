// T1.1. Local state in <git-common-dir>/huddle/: local.json, cache.json, seen/.
// Every write is atomic (temp file + rename) and every read-modify-write runs
// under a lock with stale-lock recovery, because hooks from several agent
// sessions hit these files at the same time.
//
// Readers never take a lock: a write replaces the file with an atomic rename,
// so a reader sees the previous file or the new one, never a partial one.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { nowIso } from "./clock.ts";
import { LIMITS, cleanText, parseDoc } from "./docs.ts";
import { ensureStateDir, seenFile } from "./paths.ts";
import type { RepoPaths } from "./paths.ts";
import { parseRef } from "./types.ts";
import type { Cache, LocalSession, LocalState, Seen } from "./types.ts";

const LOCAL_LOCK = "local";
const TMP_MARK = ".tmp-";
const TEMP_MAX_AGE_MS = 60_000;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const EPOCH = "1970-01-01T00:00:00.000Z";
const LOCK_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const OWNER_FILE_RE = /^owner-[0-9a-f]{16}\.json$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A store lock could not be taken in time. A caller on a time budget (a hook)
 * passes a small waitMs and treats this as "skip this write".
 */
export class StoreBusyError extends Error {
  lock: string;
  waitMs: number;
  constructor(lock: string, waitMs: number) {
    super(`could not take the ${lock} lock within ${waitMs} ms`);
    this.name = "StoreBusyError";
    this.lock = lock;
    this.waitMs = waitMs;
  }
}

function errno(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Atomic writes and tolerant reads
// ---------------------------------------------------------------------------

/** rename() over an existing file. On Windows a scanner or a reader can make it fail for a moment. */
async function replaceFile(tmp: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      const code = errno(error);
      const transient = WINDOWS && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!transient || attempt >= 10) throw error;
      await sleep(5 * (attempt + 1));
    }
  }
}

/**
 * Writes a file so that a reader sees either the previous content or the new
 * content, never a partial write. The parent directory must exist.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}${TMP_MARK}${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, text);
    await replaceFile(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

type Loaded = { kind: "missing" } | { kind: "corrupt" } | { kind: "ok"; value: unknown };

/** Reads a JSON file. Throws only for errors other than "not there" and "not JSON". */
async function loadJson(file: string): Promise<Loaded> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "corrupt" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Leftovers from crashed processes
// ---------------------------------------------------------------------------

const swept = new Set<string>();

/**
 * Removes temp files and temp lock directories that a crashed process left
 * behind. Runs once per process and state directory, and only touches entries
 * that have not been modified for a minute.
 */
async function sweepTemps(paths: RepoPaths): Promise<void> {
  if (swept.has(paths.stateDir)) return;
  swept.add(paths.stateDir);
  for (const dir of [paths.stateDir, paths.seenDir]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.includes(TMP_MARK)) continue;
      const path = join(dir, entry);
      try {
        if (Date.now() - (await stat(path)).mtimeMs > TEMP_MAX_AGE_MS) await rm(path, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The cross-process lock
//
// A held lock is the directory <stateDir>/<name>.lock containing exactly one
// owner file, whose name carries a random token. It is taken by preparing a
// temp directory with the owner file inside and renaming it into place. rename
// fails while the lock directory is non-empty, so the lock appears atomically
// and is never visible "empty but held".
//
// An empty lock directory therefore means "no holder": a release or a recovery
// that was interrupted half way.
//
// Recovering a stale lock removes the specific owner file that was judged
// stale and then removes the directory only if that left it empty. A newer
// holder has a different token, so a late recoverer's unlink misses and its
// rmdir fails on the non-empty directory. That makes recovery a
// compare-and-delete, which a plain lock file cannot offer: with a lock file,
// two processes that both see a stale lock can each remove the other's fresh one.
//
// While `fn` runs, a heartbeat keeps the owner file's mtime fresh. So staleMs
// only fires for a holder that is hung or gone, never for one that is merely
// slow, and a dead holder on this host is detected at once through its pid.
//
// Known limit: a holder that is frozen for longer than staleMs and then
// continues (laptop suspend, SIGSTOP, a wall clock stepped forward) can find
// that a waiter took its lock over in the meantime, so two processes may be
// inside `fn` at once. Everything guarded by these locks is written with an
// atomic rename and is rebuilt by the next hook or sync, so the cost is one
// lost update or one doubled sync, never a damaged file.
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** How long to wait for the lock before giving up. 0 = try once. Default 5000. */
  waitMs?: number;
  /**
   * A lock whose owner file has not been touched for this long is treated as
   * left behind and taken over. Use the same value at every call site of one
   * lock name. Default 30000.
   */
  staleMs?: number;
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

interface LockOwner {
  pid: number;
  host: string;
  at: string;
}

const HELD_CODES = new Set(
  WINDOWS ? ["ENOTEMPTY", "EEXIST", "ENOTDIR", "EPERM", "EACCES", "EBUSY"] : ["ENOTEMPTY", "EEXIST", "ENOTDIR"],
);
const NOT_EMPTY_CODES = new Set(
  WINDOWS ? ["ENOTEMPTY", "EEXIST", "EPERM", "EACCES", "EBUSY"] : ["ENOTEMPTY", "EEXIST"],
);

function ownerFileName(token: string): string {
  return `owner-${token}.json`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errno(error) === "EPERM";
  }
}

/** True when the owner file is gone, older than staleMs, or names a dead process on this host. */
async function ownerIsStale(ownerPath: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(ownerPath)).mtimeMs;
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(owner)) return false;
  const { pid, host } = owner;
  // A pid only means something on the host that issued it.
  return host === hostname() && typeof pid === "number" && Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
}

/** True when the lock is free afterwards: it was released, empty, or stale and we removed it. */
async function recoverIfStale(lockDir: string, staleMs: number): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(lockDir);
  } catch (error) {
    const code = errno(error);
    if (code === "ENOENT") return true;
    if (code !== "ENOTDIR") throw error;
    // Something that is not a directory sits at the lock path. Remove it once it is old.
    try {
      if (Date.now() - (await stat(lockDir)).mtimeMs <= staleMs) return false;
      await rm(lockDir, { force: true });
    } catch {
      // Raced with another process; the next attempt sorts it out.
    }
    return true;
  }
  for (const entry of entries) {
    // Only owner files can hold the lock. Anything else in here is debris.
    if (OWNER_FILE_RE.test(entry) && !(await ownerIsStale(join(lockDir, entry), staleMs))) return false;
  }
  for (const entry of entries) {
    await rm(join(lockDir, entry), { recursive: true, force: true }).catch(() => {});
  }
  try {
    // Succeeds only while the directory is still empty, so a new holder is never removed.
    await rmdir(lockDir);
    return true;
  } catch (error) {
    const code = errno(error);
    if (code === "ENOENT") return true;
    if (NOT_EMPTY_CODES.has(code)) return false;
    throw error;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2 + attempt * 2, 20) + Math.random() * 5;
}

/** Returns the owner token, or null when the lock stayed held for waitMs. */
async function acquire(paths: RepoPaths, lockDir: string, waitMs: number, staleMs: number): Promise<string | null> {
  await ensureStateDir(paths);
  await sweepTemps(paths);
  const token = randomBytes(8).toString("hex");
  const tmpDir = `${lockDir}${TMP_MARK}${token}`;
  const tmpOwner = join(tmpDir, ownerFileName(token));
  const prepare = async () => {
    const owner: LockOwner = { pid: process.pid, host: hostname(), at: new Date().toISOString() };
    await mkdir(tmpDir, { recursive: true });
    await writeFile(tmpOwner, JSON.stringify(owner));
  };
  let acquired = false;
  try {
    await prepare();
    const deadline = performance.now() + waitMs;
    let stampedAt = Date.now();
    let immediateRetries = 0;
    for (let attempt = 0; ; attempt++) {
      // The owner file's mtime is the lock's age. Keep it (and the temp directory) fresh while
      // waiting, so that a lock taken after a long wait does not look old the moment it appears.
      // This uses the wall clock on purpose: like mtimes, it keeps moving while the machine sleeps.
      if (Math.abs(Date.now() - stampedAt) > 1_000) {
        const t = new Date();
        await utimes(tmpOwner, t, t).catch(() => {});
        await utimes(tmpDir, t, t).catch(() => {});
        stampedAt = t.getTime();
      }
      let failure = "";
      try {
        await rename(tmpDir, lockDir);
      } catch (error) {
        failure = errno(error) || "UNKNOWN";
        if (failure !== "ENOENT" && !HELD_CODES.has(failure)) throw error;
      }
      if (failure === "") {
        // A sweep (sweepTemps in another process) can empty a temp directory that looked abandoned
        // just before it is renamed. An empty lock directory is a free lock, not a held one, so
        // check that the owner file came along.
        if (await exists(join(lockDir, ownerFileName(token)))) {
          acquired = true;
          return token;
        }
      }
      if (failure === "" || failure === "ENOENT") {
        // Our temp directory is gone or was emptied (another process swept it). Build it again.
        await prepare();
        stampedAt = Date.now();
      }
      // Retry at once after freeing a dead lock, but only a few times, so a path that can never
      // be taken does not turn this into a busy loop.
      if ((await recoverIfStale(lockDir, staleMs)) && immediateRetries < 3) {
        immediateRetries++;
        continue;
      }
      if (performance.now() >= deadline) return null;
      await sleep(backoffMs(attempt));
    }
  } finally {
    if (!acquired) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function release(lockDir: string, token: string): Promise<void> {
  // If our lock was taken over, the unlink misses and rmdir fails on the new holder's
  // non-empty directory. Both are fine.
  await rm(join(lockDir, ownerFileName(token)), { force: true }).catch(() => {});
  await rmdir(lockDir).catch(() => {});
}

/**
 * Runs `fn` while holding <stateDir>/<name>.lock ("sync" is paths.syncLock).
 * Returns { acquired: false } without running `fn` when the lock could not be
 * taken in time. The lock is released when `fn` settles, also when it throws.
 * A lock left behind by a dead process is taken over.
 */
export async function withLock<T>(
  paths: RepoPaths,
  name: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<LockResult<T>> {
  if (typeof name !== "string" || !LOCK_NAME_RE.test(name)) {
    throw new TypeError(`invalid lock name ${JSON.stringify(name)}`);
  }
  const waitMs = Math.max(0, opts.waitMs ?? DEFAULT_WAIT_MS);
  const staleMs = Math.max(1, opts.staleMs ?? DEFAULT_STALE_MS);
  const lockDir = join(paths.stateDir, `${name}.lock`);
  const token = await acquire(paths, lockDir, waitMs, staleMs);
  if (token === null) return { acquired: false };
  const ownerPath = join(lockDir, ownerFileName(token));
  const heartbeat = setInterval(
    () => {
      const t = new Date();
      utimes(ownerPath, t, t).catch(() => {});
    },
    Math.max(25, Math.floor(staleMs / 3)),
  );
  heartbeat.unref();
  try {
    return { acquired: true, value: await fn() };
  } finally {
    clearInterval(heartbeat);
    await release(lockDir, token);
  }
}

// ---------------------------------------------------------------------------
// local.json
// ---------------------------------------------------------------------------

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isoOrEpoch(value: unknown): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : EPOCH;
}

function emptyLocal(): LocalState {
  return { v: 0, sessions: [], published: null };
}

/**
 * A session id must be one clean line within the published limit. Otherwise
 * publishing would alter it (see normalizeDoc) and the session would no longer
 * recognize itself in the team view.
 */
function validSessionId(id: unknown): id is string {
  return typeof id === "string" && id !== "" && cleanText(id, LIMITS.sessionId) === id;
}

function normalizeSession(raw: unknown): LocalSession | null {
  if (!isRecord(raw) || !validSessionId(raw.id)) return null;
  const source = raw.intentSource;
  return {
    ...raw, // fields this version does not know about survive a rewrite
    id: raw.id,
    agent: text(raw.agent, "manual"),
    branch: text(raw.branch, ""),
    intent: text(raw.intent, ""),
    intentSource: source === "prompt" || source === "manual" ? source : "none",
    files: texts(raw.files),
    claims: texts(raw.claims),
    startedAt: isoOrEpoch(raw.startedAt),
    seenAt: isoOrEpoch(raw.seenAt),
    worktree: text(raw.worktree, ""),
  };
}

/** Coerces whatever is on disk, or whatever a caller produced, into a valid LocalState. */
function normalizeLocal(raw: unknown): LocalState {
  if (!isRecord(raw) || raw.v !== 0) return emptyLocal();
  const byId = new Map<string, LocalSession>();
  if (Array.isArray(raw.sessions)) {
    for (const item of raw.sessions) {
      const session = normalizeSession(item);
      if (session) byId.set(session.id, session);
    }
  }
  const p = raw.published;
  const published =
    isRecord(p) && typeof p.at === "string" && typeof p.hash === "string" && typeof p.sha === "string"
      ? { at: p.at, hash: p.hash, sha: p.sha }
      : null;
  return { ...raw, v: 0, sessions: [...byId.values()], published };
}

export interface StoreOptions {
  /** How long to wait for the local lock before throwing StoreBusyError. Default 5000. */
  waitMs?: number;
}

/** local.json, or an empty state when it does not exist yet or is unreadable. */
export async function readLocal(paths: RepoPaths): Promise<LocalState> {
  try {
    const loaded = await loadJson(paths.localFile);
    return loaded.kind === "ok" ? normalizeLocal(loaded.value) : emptyLocal();
  } catch {
    return emptyLocal();
  }
}

/**
 * Atomic read-modify-write of local.json under its lock. `mutate` edits the
 * state in place (or returns a replacement). Returns the new state. When
 * `mutate` throws, nothing is written. Throws StoreBusyError when the lock
 * cannot be taken within opts.waitMs.
 */
export async function updateLocal(
  paths: RepoPaths,
  mutate: (state: LocalState) => LocalState | void,
  opts: StoreOptions = {},
): Promise<LocalState> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const result = await withLock(
    paths,
    LOCAL_LOCK,
    async () => {
      const loaded = await loadJson(paths.localFile);
      const state = loaded.kind === "ok" ? normalizeLocal(loaded.value) : emptyLocal();
      const before = toJson(state);
      const replacement = mutate(state);
      const next = normalizeLocal(replacement === undefined ? state : replacement);
      const after = toJson(next);
      if (loaded.kind === "corrupt") {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        await rename(paths.localFile, `${paths.localFile}.corrupt`).catch(() => {});
      } else if (loaded.kind === "ok" && after === before) {
        return next;
      }
      await writeFileAtomic(paths.localFile, after);
      return next;
    },
    { waitMs },
  );
  if (!result.acquired) throw new StoreBusyError(LOCAL_LOCK, waitMs);
  return result.value;
}

export type SessionPatch = { id: string; worktree: string } & Partial<LocalSession>;

/**
 * Creates the session or merges `patch` into it. On create, startedAt is set
 * and missing fields get defaults (agent "manual", empty intent with
 * intentSource "none", no files, no claims). seenAt is set to now unless the
 * patch carries one. Fields that are undefined in the patch keep their value.
 *
 * The id must be a single clean line of at most 128 characters (run agent
 * supplied ids through cleanText first); anything else is a TypeError.
 */
export async function touchSession(paths: RepoPaths, patch: SessionPatch, opts: StoreOptions = {}): Promise<LocalSession> {
  if (!validSessionId(patch.id)) {
    throw new TypeError("a session id must be a single line of 1 to 128 characters");
  }
  const stamp = nowIso();
  const next = await updateLocal(
    paths,
    (state) => {
      let session = state.sessions.find((s) => s.id === patch.id);
      if (!session) {
        session = {
          id: patch.id,
          agent: "manual",
          branch: "",
          intent: "",
          intentSource: "none",
          files: [],
          claims: [],
          startedAt: stamp,
          seenAt: stamp,
          worktree: patch.worktree,
        };
        state.sessions.push(session);
      }
      const target = session as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) target[key] = Array.isArray(value) ? [...value] : value;
      }
      if (patch.seenAt === undefined) session.seenAt = stamp;
    },
    opts,
  );
  const touched = next.sessions.find((s) => s.id === patch.id);
  if (!touched) throw new Error(`session ${patch.id} was not stored`);
  return touched;
}

/**
 * Removes every session `shouldRemove` returns true for, together with its
 * seen state, in one update. Returns the removed sessions. Sync uses this to
 * drop sessions that passed the TTL.
 */
export async function removeSessions(
  paths: RepoPaths,
  shouldRemove: (session: LocalSession) => boolean,
  opts: StoreOptions = {},
): Promise<LocalSession[]> {
  let removed: LocalSession[] = [];
  await updateLocal(
    paths,
    (state) => {
      removed = state.sessions.filter((s) => shouldRemove(s));
      if (removed.length > 0) state.sessions = state.sessions.filter((s) => !removed.includes(s));
    },
    opts,
  );
  for (const session of removed) await removeSeen(paths, session.id);
  return removed;
}

/** Removes the session and its seen state. False when there was no such session. */
export async function removeSession(paths: RepoPaths, id: string, opts: StoreOptions = {}): Promise<boolean> {
  const removed = await removeSessions(paths, (session) => session.id === id, opts);
  // Clear the seen state even when the session was already gone, so nothing is orphaned.
  if (removed.length === 0) await removeSeen(paths, id);
  return removed.length > 0;
}

// ---------------------------------------------------------------------------
// cache.json
// ---------------------------------------------------------------------------

/**
 * Coerces a value into a Cache. Every document goes through the same gate as
 * a fetched one (parseDoc), so readers may trust the shapes even if the file
 * was edited or damaged. An entry whose document does not pass keeps its sha
 * with doc: null, exactly like a ref that was fetched but is not a valid v0
 * document.
 */
function normalizeCache(raw: unknown): Cache {
  const cache: Cache = { fetchedAt: null, refs: {} };
  if (!isRecord(raw)) return cache;
  if (typeof raw.fetchedAt === "string" && !Number.isNaN(Date.parse(raw.fetchedAt))) cache.fetchedAt = raw.fetchedAt;
  if (!isRecord(raw.refs)) return cache;
  for (const [ref, entry] of Object.entries(raw.refs)) {
    if (!parseRef(ref) || !isRecord(entry) || typeof entry.sha !== "string" || !SHA_RE.test(entry.sha)) continue;
    const doc = isRecord(entry.doc) ? parseDoc(JSON.stringify(entry.doc), ref) : null;
    cache.refs[ref] = { sha: entry.sha, doc };
  }
  return cache;
}

/** cache.json, or an empty cache ({ fetchedAt: null, refs: {} }) when missing or unreadable. */
export async function readCache(paths: RepoPaths): Promise<Cache> {
  try {
    const loaded = await loadJson(paths.cacheFile);
    return normalizeCache(loaded.kind === "ok" ? loaded.value : undefined);
  } catch {
    return normalizeCache(undefined);
  }
}

/** Atomic. The caller (sync) holds sync.lock. */
export async function writeCache(paths: RepoPaths, cache: Cache): Promise<void> {
  await ensureStateDir(paths);
  await writeFileAtomic(paths.cacheFile, toJson(normalizeCache(cache)));
}

// ---------------------------------------------------------------------------
// seen/<session>
// ---------------------------------------------------------------------------

/** What was last injected into that session, or null. The file name comes from seenFile() in paths.ts. */
export async function readSeen(paths: RepoPaths, sessionId: string): Promise<Seen | null> {
  let loaded: Loaded;
  try {
    loaded = await loadJson(seenFile(paths, sessionId));
  } catch {
    return null;
  }
  if (loaded.kind !== "ok" || !isRecord(loaded.value)) return null;
  const { at, items } = loaded.value;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || !isRecord(items)) return null;
  const seen: Seen = { at, items: {} };
  for (const [key, fingerprint] of Object.entries(items)) {
    if (typeof fingerprint === "string") seen.items[key] = fingerprint;
  }
  return seen;
}

/** Atomic. Each session only writes its own file, so no lock is needed. */
export async function writeSeen(paths: RepoPaths, sessionId: string, seen: Seen): Promise<void> {
  await ensureStateDir(paths);
  await writeFileAtomic(seenFile(paths, sessionId), toJson({ at: seen.at, items: seen.items }));
}

/** Removes the seen state of a session. Does nothing when there is none. */
export async function removeSeen(paths: RepoPaths, sessionId: string): Promise<void> {
  await rm(seenFile(paths, sessionId), { force: true });
}
