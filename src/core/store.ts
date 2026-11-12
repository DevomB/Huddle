// T1.1. Local state in <git-common-dir>/huddle/: local.json, cache.json, seen/.
// Every write is atomic (temp file + rename) and every read-modify-write runs
// under a lock with stale-lock recovery, because hooks from several agent
// sessions hit these files at the same time.

import { todo } from "./io.ts";
import type { RepoPaths } from "./paths.ts";
import type { Cache, LocalSession, LocalState, Seen } from "./types.ts";

export interface LockOptions {
  /** How long to wait for the lock before giving up. 0 = try once. */
  waitMs?: number;
  /** A lock older than this is treated as left behind by a dead process and taken over. */
  staleMs?: number;
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Runs `fn` while holding <stateDir>/<name>.lock ("sync" is paths.syncLock).
 * Returns { acquired: false } without running `fn` when the lock could not be
 * taken in time. The lock is released when `fn` settles, also when it throws.
 */
export async function withLock<T>(
  paths: RepoPaths,
  name: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<LockResult<T>> {
  void paths;
  void name;
  void fn;
  void opts;
  return todo("store.withLock");
}

/** local.json, or an empty state when it does not exist yet or is unreadable. */
export async function readLocal(paths: RepoPaths): Promise<LocalState> {
  void paths;
  return todo("store.readLocal");
}

/** Atomic read-modify-write of local.json under its lock. `mutate` edits the state in place. Returns the new state. */
export async function updateLocal(paths: RepoPaths, mutate: (state: LocalState) => void): Promise<LocalState> {
  void paths;
  void mutate;
  return todo("store.updateLocal");
}

export type SessionPatch = { id: string; worktree: string } & Partial<LocalSession>;

/**
 * Creates the session or merges `patch` into it. On create, startedAt is set
 * and missing fields get defaults (agent "manual", empty intent with
 * intentSource "none", no files, no claims). seenAt is set to now unless the
 * patch carries one.
 */
export async function touchSession(paths: RepoPaths, patch: SessionPatch): Promise<LocalSession> {
  void paths;
  void patch;
  return todo("store.touchSession");
}

/** Removes the session and its seen state. False when there was no such session. */
export async function removeSession(paths: RepoPaths, id: string): Promise<boolean> {
  void paths;
  void id;
  return todo("store.removeSession");
}

/** cache.json, or an empty cache ({ fetchedAt: null, refs: {} }) when missing or unreadable. */
export async function readCache(paths: RepoPaths): Promise<Cache> {
  void paths;
  return todo("store.readCache");
}

/** Atomic. The caller (sync) holds sync.lock. */
export async function writeCache(paths: RepoPaths, cache: Cache): Promise<void> {
  void paths;
  void cache;
  return todo("store.writeCache");
}

/** What was last injected into that session, or null. The file name comes from seenFile() in paths.ts. */
export async function readSeen(paths: RepoPaths, sessionId: string): Promise<Seen | null> {
  void paths;
  void sessionId;
  return todo("store.readSeen");
}

export async function writeSeen(paths: RepoPaths, sessionId: string, seen: Seen): Promise<void> {
  void paths;
  void sessionId;
  void seen;
  return todo("store.writeSeen");
}

export async function removeSeen(paths: RepoPaths, sessionId: string): Promise<void> {
  void paths;
  void sessionId;
  return todo("store.removeSeen");
}
