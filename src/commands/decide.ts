// T4.1. huddle decide

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { addDecision } from "../core/decisions.ts";
import { cleanText, LIMITS } from "../core/docs.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { resolveSession } from "../core/session.ts";
import { ID_RE } from "../core/types.ts";

export const summary = "Record a decision others must follow: huddle decide \"<text>\"";

const USAGE = 'huddle decide "<choice others must follow>" [--supersedes <id>]';

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { supersedes: { type: "string" } }, USAGE);
  const typed = positionals.join(" ");
  const text = cleanText(typed, LIMITS.decisionText);
  if (text === "") throw new UsageError(`the decision is empty\nUsage: ${USAGE}`);
  // A rule that others must follow is not cut short behind the author's back.
  const length = Array.from(cleanText(typed, Number.MAX_SAFE_INTEGER)).length;
  if (length > LIMITS.decisionText) {
    throw new UsageError(`a decision is at most ${LIMITS.decisionText} characters; this one is ${length}. Say it shorter, or split it into two.`);
  }
  const supersedes = values.supersedes?.trim();
  if (supersedes !== undefined && !ID_RE.test(supersedes)) {
    throw new UsageError(`"${cleanText(supersedes, 40)}" is not a decision id; run "huddle decisions" to see them\nUsage: ${USAGE}`);
  }

  const ctx = await openContext(io);
  const me = await resolveSession(ctx);
  const result = await addDecision(ctx, text, supersedes === undefined ? { agent: me.agent } : { agent: me.agent, supersedes });

  if (result.ok) {
    io.out(`decision ${result.decision.id} recorded${supersedes === undefined ? "" : `, replacing ${supersedes}`}: ${result.decision.text}`);
    if (result.dropped > 0) {
      const n = result.dropped;
      io.out(`(${n} superseded decision${n === 1 ? " was" : "s were"} removed from this clone's log to make room)`);
    }
    return EXIT.OK;
  }

  const remote = ctx.config.remote;
  switch (result.reason) {
    case "unknown-supersedes":
      throw new UsageError(`there is no decision ${supersedes}; run "huddle decisions" to see the ids. Nothing was recorded.`);
    case "offline":
      io.err(`huddle: could not reach remote "${remote}" (offline or timed out). The decision was NOT recorded; run the command again when the remote is reachable.`);
      return EXIT.ERROR;
    case "denied":
      io.err(`huddle: remote "${remote}" refused a push to refs/huddle/*. The decision was NOT recorded; run "huddle doctor".`);
      return EXIT.ERROR;
    case "lost-race":
      io.err("huddle: this clone's decision log kept changing on the remote while it was being written. The decision was NOT recorded; run the command again.");
      return EXIT.CONFLICT;
    case "busy":
      io.err("huddle: a sync is still running. The decision was NOT recorded; run the command again.");
      return EXIT.ERROR;
    case "full":
      io.err(
        `huddle: this clone's decision log is full (${LIMITS.decisions} decisions, or ${LIMITS.docBytes / 1024} KB). The decision was NOT recorded. ` +
          "Replace one of your own decisions with --supersedes <id>; that makes room.",
      );
      return EXIT.ERROR;
    case "unreadable":
      io.err("huddle: the remote holds a decision log for this clone that this version of huddle cannot read, and it was left alone. The decision was NOT recorded; update huddle.");
      return EXIT.ERROR;
  }
}
