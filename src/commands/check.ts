// T1.4. huddle check

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { filesInFlight, toRepoPath } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderOverlaps } from "../core/render.ts";
import { currentView, resolveSession } from "../core/session.ts";
import { overlaps } from "../core/view.ts";

export const summary = "Check paths for overlap with teammates; exits 3 on overlap";

const USAGE = "huddle check [--json] [<path>...]   (no path: this worktree's files in flight)";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: "boolean", default: false } }, USAGE);
  const ctx = await openContext(io);
  const me = await resolveSession(ctx);

  let targets: string[];
  if (positionals.length === 0) {
    targets = await filesInFlight(ctx.paths.worktree, ctx.config);
  } else {
    targets = positionals.map((raw) => {
      const path = toRepoPath(ctx.paths, io.cwd, raw);
      if (path === null) throw new UsageError(`"${raw}" is outside this repository\nUsage: ${USAGE}`);
      return path;
    });
  }

  // From the cache: no network, so this is safe to call before every edit.
  const view = await currentView(ctx, me.id);
  const found = targets.map((path) => ({ path, overlaps: overlaps(view, path) })).filter((entry) => entry.overlaps.length > 0);

  if (values.json) {
    io.out(
      JSON.stringify(
        {
          checked: targets.length,
          fetchedAt: view.fetchedAt,
          overlaps: found.map((entry) => ({
            path: entry.path,
            sessions: entry.overlaps.map((overlap) => ({
              user: overlap.session.user,
              agent: overlap.session.agent,
              branch: overlap.session.branch,
              intent: overlap.session.intent,
              seenAt: overlap.session.seenAt,
              via: overlap.via,
              match: overlap.match,
            })),
          })),
        },
        null,
        2,
      ),
    );
  } else if (found.length === 0) {
    io.out(`no overlap: checked ${targets.length} path${targets.length === 1 ? "" : "s"} against ${view.sessions.length} other session${view.sessions.length === 1 ? "" : "s"}`);
  } else {
    for (const entry of found) io.out(renderOverlaps(entry.path, entry.overlaps, ctx.now));
  }
  return found.length > 0 ? EXIT.CONFLICT : EXIT.OK;
}
