// T1.4. huddle status

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderStatus } from "../core/render.ts";
import { envelope, readTeam, refreshOutcome, resolveSession } from "../core/session.ts";
import { sync } from "../core/sync.ts";
import type { RefreshOutcome } from "../core/view.ts";

export const summary = "Show who is working on what";

const USAGE = "huddle status [--json] [--cached]";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    { json: { type: "boolean", default: false }, cached: { type: "boolean", default: false } },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);
  const ctx = await openContext(io);

  // Refresh first unless told not to. Throttled like any sync, so a status
  // right after another sync costs nothing; a failure just means cached data,
  // and the warnings say so the same way in text and in JSON (CONTRACT 4.2).
  let refresh: RefreshOutcome = "none";
  if (!values.cached) refresh = refreshOutcome(await sync(ctx));

  const me = await resolveSession(ctx);
  const team = await readTeam(ctx, me.id, refresh);
  const view = team.view;

  if (values.json) {
    io.out(JSON.stringify({ you: { actor: ctx.identity.actor, user: ctx.identity.user, session: me.session }, ...view, ...envelope(team) }, null, 2));
    if (team.line !== "") io.err(`huddle: ${team.line}`);
    return EXIT.OK;
  }

  if (me.session) {
    const files = me.session.files.length;
    const intent = me.session.intent ? `: "${me.session.intent}"` : "";
    io.out(`You: ${ctx.identity.user} / ${me.session.agent} on ${me.session.branch || "(unknown branch)"}${intent}. ${files} file${files === 1 ? "" : "s"} in flight.`);
  } else {
    io.out(`You: ${ctx.identity.user}. Not announced yet: run huddle intent "<what you are doing>" or huddle sync.`);
  }
  io.out(renderStatus(view));
  if (team.line !== "") io.err(`huddle: ${team.line}`);
  return EXIT.OK;
}
