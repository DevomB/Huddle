// T4.1. huddle decisions

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderDecisions } from "../core/render.ts";
import { envelope, readTeam, refreshOutcome, resolveSession } from "../core/session.ts";
import { sync } from "../core/sync.ts";
import type { RefreshOutcome } from "../core/view.ts";

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
  let refresh: RefreshOutcome = "none";
  if (!values.cached) refresh = refreshOutcome(await sync(ctx));

  const me = await resolveSession(ctx);
  const team = await readTeam(ctx, me.id, refresh);
  const view = team.view;
  if (values.json) io.out(JSON.stringify({ fetchedAt: view.fetchedAt, decisions: view.decisions, ...envelope(team) }, null, 2));
  else io.out(renderDecisions(view));
  if (team.line !== "") io.err(`huddle: ${team.line}`);
  return EXIT.OK;
}
