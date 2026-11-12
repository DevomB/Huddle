// T1.4. One sync round (plan.md §3 Sync), and starting one in the background.

import type { Ctx } from "./context.ts";
import { todo } from "./io.ts";
import type { RepoPaths } from "./paths.ts";
import type { FailReason } from "./types.ts";

export interface SyncOptions {
  /** Ignore syncIntervalSeconds. */
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
  /** Why the fetch or the publish failed, if either did. */
  error?: FailReason;
}

/**
 * 1. Take sync.lock; skip if the last sync was under syncIntervalSeconds ago, unless forced.
 * 2. Recompute branch and files for each local session; drop sessions past the TTL.
 * 3. Refresh cache.json from the remote.
 * 4. Publish the ActorDoc if it changed or the last publish is older than heartbeatMinutes.
 * Never throws; network failures are logged and reported in the result.
 */
export async function sync(ctx: Ctx, opts: SyncOptions = {}): Promise<SyncResult> {
  void ctx;
  void opts;
  return todo("sync.sync");
}

/**
 * Starts `huddle sync` as a detached process and returns immediately. `self`
 * is the path of the running huddle script (io.self). Never throws. Used by
 * the hook engine and the git-hooks adapter; the throttle lives in sync().
 */
export function spawnBackgroundSync(paths: RepoPaths, self: string): void {
  void paths;
  void self;
  return todo("sync.spawnBackgroundSync");
}
