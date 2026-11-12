// T1.4. huddle sync

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { currentBranch } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { log } from "../core/log.ts";
import { locateRepo } from "../core/paths.ts";
import { currentView, resolveSession } from "../core/session.ts";
import { touchSession } from "../core/store.ts";
import { sync } from "../core/sync.ts";

export const summary = "Publish this clone's sessions and refresh the team state";

const USAGE = "huddle sync [--background] [--force]";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    { background: { type: "boolean", default: false }, force: { type: "boolean", default: false } },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);

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
 * it always exits 0: nobody is watching, and a failure is in the log.
 */
async function background(io: Io, force: boolean): Promise<number> {
  const paths = await locateRepo(io.cwd).catch(() => null);
  try {
    const ctx = await openContext(io);
    const result = await sync(ctx, { force });
    if (result.error) log(ctx.paths, "sync", `background sync: ${result.error}`);
  } catch (error) {
    log(paths, "sync", "background sync failed", error);
  }
  return EXIT.OK;
}
