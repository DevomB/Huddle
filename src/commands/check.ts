// T1.4. huddle check
//
// MVP (CONTRACT 4.2): the answer is one of three, and only one of them is a
// clearance. "overlap" (exit 3) whatever the freshness; "clear" (exit 0) only
// on a fresh and complete team picture; anything else is "unknown" (exit 1):
// not knowing about a teammate is never reported as there being none.

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { toRepoPath, workInFlight } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderOverlaps } from "../core/render.ts";
import { envelope, readTeam, refreshOutcome, resolveSession } from "../core/session.ts";
import { sync } from "../core/sync.ts";
import { overlaps } from "../core/view.ts";
import type { RefreshOutcome } from "../core/view.ts";

export const summary = "Check paths for overlap with teammates; exits 3 on overlap, 1 when it cannot know";

const USAGE = "huddle check [--json] [--refresh] [<path>...]   (no path: this worktree's files in flight; --refresh: sync first)";

export type Verdict = "overlap" | "clear" | "unknown";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    { json: { type: "boolean", default: false }, refresh: { type: "boolean", default: false } },
    USAGE,
  );
  const ctx = await openContext(io);

  let targets: string[];
  // False when git could not list this worktree's own files in flight: some paths were then not checked.
  let listed = true;
  if (positionals.length === 0) {
    // Every file in flight: the published list stops at LIMITS.files, and a file past it can overlap too.
    const work = await workInFlight(ctx.paths.worktree, ctx.config);
    targets = work.all;
    listed = work.complete;
  } else {
    targets = positionals.map((raw) => {
      const path = toRepoPath(ctx.paths, io.cwd, raw);
      if (path === null) throw new UsageError(`"${raw}" is outside this repository\nUsage: ${USAGE}`);
      return path;
    });
  }

  // From the cache unless asked: no network, so this is safe to call before every edit.
  // --refresh runs one sync first, throttled like any other.
  let refresh: RefreshOutcome = "none";
  if (values.refresh) refresh = refreshOutcome(await sync(ctx));
  const me = await resolveSession(ctx);
  const team = await readTeam(ctx, me.id, refresh);
  const view = team.view;
  const found = targets.map((path) => ({ path, overlaps: overlaps(view, path) })).filter((entry) => entry.overlaps.length > 0);
  const warnings = listed ? team.warnings : ["this worktree's own files in flight could not be listed (git failed), so some of them may not have been checked", ...team.warnings];
  const trusted = listed && team.freshness.freshness === "fresh" && team.completeness.complete;
  const verdict: Verdict = found.length > 0 ? "overlap" : trusted ? "clear" : "unknown";

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
              ...(overlap.via === "coverage" && overlap.session.partial ? { total: overlap.session.partial.total } : {}),
            })),
          })),
          verdict,
          ...envelope(team),
          warnings,
        },
        null,
        2,
      ),
    );
  } else if (verdict === "overlap") {
    for (const entry of found) io.out(renderOverlaps(entry.path, entry.overlaps, ctx.now));
  } else {
    const what = `${targets.length} path${targets.length === 1 ? "" : "s"} against ${view.sessions.length} other session${view.sessions.length === 1 ? "" : "s"}`;
    if (verdict === "clear") io.out(`no overlap: checked ${what}`);
    else if (!listed) {
      const refresh = team.warnings.length > 0 ? ', and "huddle check --refresh" (or "huddle sync")' : "";
      io.out(`unknown: checked ${what}, but ${warnings.join("; ")}. Run "git status" to see why${refresh}, then check again`);
    }
    else io.out(`unknown: checked ${what}, but the team picture cannot be trusted: ${warnings.join("; ")}. Run "huddle check --refresh" (or "huddle sync") and check again`);
  }
  for (const warning of warnings) io.err(`huddle: ${warning}`);
  return verdict === "overlap" ? EXIT.CONFLICT : verdict === "clear" ? EXIT.OK : EXIT.ERROR;
}
