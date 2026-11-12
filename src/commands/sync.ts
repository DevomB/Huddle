// T1.4. huddle sync

import { tmpdir } from "node:os";
import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { currentBranch } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { log } from "../core/log.ts";
import { listCheckouts, locateRepo, sameDirectory } from "../core/paths.ts";
import type { RepoPaths } from "../core/paths.ts";
import { currentView, resolveSession } from "../core/session.ts";
import { touchSession } from "../core/store.ts";
import { deferredSyncDue, deferSync, releaseDeferredSync, sync } from "../core/sync.ts";

export const summary = "Publish this clone's sessions and refresh the team state";

const USAGE = "huddle sync [--background] [--force]";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    // --deferred <token> is internal: it is how a deferred background sync is started (core/sync.ts deferSync).
    { background: { type: "boolean", default: false }, force: { type: "boolean", default: false }, deferred: { type: "string" } },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);

  if (values.deferred !== undefined) return deferred(io, values.deferred);
  if (values.background) return background(io, values.force === true);

  const ctx = await openContext(io);
  // Running sync by hand is activity: it makes this session visible to the team.
  const me = await resolveSession(ctx);
  await touchSession(ctx.paths, {
    id: me.id,
    worktree: ctx.paths.worktree,
    agent: me.agent,
    branch: await currentBranch(ctx.paths.worktree),
    seenAt: ctx.now.toISOString(),
  });

  const result = await sync(ctx, { force: true });
  if (!result.ran) {
    io.err(result.skipped === "locked" ? "huddle: another sync is still running; try again" : "huddle: sync failed, see the log (huddle doctor)");
    return EXIT.ERROR;
  }
  if (result.error) {
    io.err(`huddle: ${explain(result.error, ctx.config.remote)}`);
    return EXIT.ERROR;
  }

  const view = await currentView(ctx, me.id);
  const others = view.sessions.length;
  const who = others === 0 ? "no one else is active" : `${others} other session${others === 1 ? "" : "s"} active`;
  io.out(`synced with ${ctx.config.remote}: ${who}${result.published ? "; published this clone's sessions" : ""}`);
  return EXIT.OK;
}

function explain(reason: string, remote: string): string {
  if (reason === "offline") return `could not reach remote "${remote}" (offline or timed out); showing cached state only`;
  if (reason === "denied") return `remote "${remote}" refused a push to refs/huddle/*; run "huddle doctor"`;
  if (reason === "lost-race") return "the sync lost a race with another writer; run it again";
  return "sync failed, see the log (huddle doctor)";
}

/**
 * What hooks start as a detached process. Quiet, throttled unless forced, and
 * it always exits 0: nobody is watching, and a failure is in the log. A sync
 * that was skipped is made up for when the interval ends.
 */
async function background(io: Io, force: boolean): Promise<number> {
  const paths = await locateRepo(io.cwd).catch(() => null);
  try {
    const ctx = await openContext(io);
    const result = await sync(ctx, { force });
    if (result.error) log(ctx.paths, "sync", `background sync: ${result.error}`);
    if (!force && result.skipped) deferSync(ctx.paths, io.self, ctx.config, ctx.now);
  } catch (error) {
    log(paths, "sync", "background sync failed", error);
  }
  return EXIT.OK;
}

/**
 * What deferSync starts as a detached process: waits for the end of the
 * throttle interval, then syncs, unless a sync ran while it waited.
 */
async function deferred(io: Io, token: string): Promise<number> {
  const paths = await locateRepo(io.cwd).catch(() => null);
  if (!paths) return EXIT.OK;
  try {
    // While it waits, this process must not sit in the worktree: on Windows a
    // directory that is some process's working directory cannot be renamed or removed.
    try {
      process.chdir(tmpdir());
    } catch {
      // Then it waits where it is.
    }
    if (!(await deferredSyncDue(paths, token))) return EXIT.OK;
    const from = await checkoutToSyncFrom(paths, io.cwd);
    if (from === null) {
      log(paths, "sync", "deferred sync: no checkout of this clone is left to sync from");
      return EXIT.OK;
    }
    try {
      process.chdir(from);
    } catch {
      // Nothing below depends on it: every git call is given its directory.
    }
    // Opened after the wait: the round works with the clock and the settings as they are now.
    const ctx = await openContext({ ...io, cwd: from });
    const result = await sync(ctx, { force: true });
    if (result.error) log(ctx.paths, "sync", `deferred sync: ${result.error}`);
    else if (!result.ran) log(ctx.paths, "sync", "deferred sync: another sync held the lock for too long");
  } catch (error) {
    log(paths, "sync", "deferred sync failed", error);
  } finally {
    releaseDeferredSync(paths, token);
  }
  return EXIT.OK;
}

/**
 * Where a deferred sync runs once its wait is over. The sync is the clone's,
 * not the checkout's that happened to start it: events in every worktree of
 * the clone found it waiting and left their own sync to it. So when the
 * worktree it was started in has been removed in the meantime, it runs in
 * another checkout of the clone. Null only when none is left.
 */
async function checkoutToSyncFrom(paths: RepoPaths, startedIn: string): Promise<string | null> {
  const still = await locateRepo(startedIn).catch(() => null);
  if (still !== null && (await sameDirectory(still.commonDir, paths.commonDir))) return startedIn;
  return (await listCheckouts(paths))[0]?.worktree ?? null;
}
