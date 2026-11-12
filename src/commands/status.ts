// T1.4. huddle status

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderStatus } from "../core/render.ts";
import { currentView, resolveSession } from "../core/session.ts";
import { sync } from "../core/sync.ts";

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
  // right after another sync costs nothing; a failure just means cached data.
  let warning = "";
  if (!values.cached) {
    const result = await sync(ctx);
    if (result.error === "offline") warning = `could not reach remote "${ctx.config.remote}"; showing the last known state`;
    else if (result.error === "denied") warning = `remote "${ctx.config.remote}" refused a push to refs/huddle/*; run "huddle doctor"`;
  }

  const me = await resolveSession(ctx);
  const view = await currentView(ctx, me.id);

  if (values.json) {
    io.out(JSON.stringify({ you: { actor: ctx.identity.actor, user: ctx.identity.user, session: me.session }, ...view }, null, 2));
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
  if (warning) io.err(`huddle: ${warning}`);
  return EXIT.OK;
}
