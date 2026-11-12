// T4.1. huddle decisions

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderDecisions } from "../core/render.ts";
import { currentView, resolveSession } from "../core/session.ts";
import { sync } from "../core/sync.ts";

export const summary = "List the team's current decisions";

const USAGE = "huddle decisions [--json] [--cached]";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    { json: { type: "boolean", default: false }, cached: { type: "boolean", default: false } },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);
  const ctx = await openContext(io);

  // Refresh first unless told not to, as `huddle status` does: throttled, and a failure just means cached data.
  let warning = "";
  if (!values.cached) {
    const result = await sync(ctx);
    if (result.error === "offline") warning = `could not reach remote "${ctx.config.remote}"; showing the last known decisions`;
  }

  const me = await resolveSession(ctx);
  const view = await currentView(ctx, me.id);
  if (values.json) io.out(JSON.stringify({ fetchedAt: view.fetchedAt, decisions: view.decisions }, null, 2));
  else io.out(renderDecisions(view));
  if (warning) io.err(`huddle: ${warning}`);
  return EXIT.OK;
}
