// T4.1. huddle decide

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { addDecision } from "../core/decisions.ts";
import type { Attributed, DecideResult } from "../core/decisions.ts";
import { cleanText, LIMITS } from "../core/docs.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { shownText } from "../core/render.ts";
import { resolveSession } from "../core/session.ts";
import { scrubSecrets } from "../hooks/intent.ts";
import { ID_RE } from "../core/types.ts";

export const summary = "Record a decision others must follow: huddle decide \"<text>\"";

const USAGE = 'huddle decide [--supersedes <id>] [--] "<choice others must follow>"   (put -- before a text that starts with a dash)';

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { supersedes: { type: "string", multiple: true } }, USAGE);
  const typed = cleanText(positionals.join(" "), Number.MAX_SAFE_INTEGER);
  if (typed === "") throw new UsageError(`the decision is empty\nUsage: ${USAGE}`);
  // A rule that others must follow is not cut short behind the author's back.
  const length = Array.from(typed).length;
  if (length > LIMITS.decisionText) {
    throw new UsageError(`a decision is at most ${LIMITS.decisionText} characters; this one is ${length}. Say it shorter, or split it into two.`);
  }
  // A decision is read by everyone who can read the repository, and it is never removed. What
  // looks like a credential is not published (hooks/intent.ts; best effort). An intent is
  // published with that part taken out, because the next prompt replaces it. A decision is the
  // rule itself: with a part taken out it is a rule nobody can follow, for good. So it is refused.
  const scrubbed = scrubSecrets(typed);
  if (scrubbed !== typed) {
    throw new UsageError(
      "part of this looks like a credential, so the decision was NOT recorded: a decision is read by everyone who can read the repository and is never removed. " +
        `What huddle would have published:\n  ${scrubbed}\n` +
        "Say it without that part. A full commit id, a digest and a UUID look like a credential to huddle too: a short commit id is taken, and so is the name of the file or the setting that holds the value.",
    );
  }
  const text = typed;
  const named = values.supersedes ?? [];
  if (named.length > 1) throw new UsageError(`a decision replaces one other decision; --supersedes was given ${named.length} times\nUsage: ${USAGE}`);
  const supersedes = named[0]?.trim();
  if (supersedes !== undefined && !ID_RE.test(supersedes)) {
    throw new UsageError(`"${cleanText(supersedes, 40)}" is not a decision id; run "huddle decisions" to see them\nUsage: ${USAGE}`);
  }

  const ctx = await openContext(io);
  const me = await resolveSession(ctx);
  const result = await addDecision(ctx, text, supersedes === undefined ? { agent: me.agent } : { agent: me.agent, supersedes });
  return report(result, { remote: ctx.config.remote, supersedes }, io);
}

/**
 * "[id] text (user / agent)", the way `huddle decisions` lists one. It is a
 * teammate's text and an agent may be the one reading it, so it is shown as
 * the renderer shows it (render.ts, shownText): one line, without "<" or ">".
 */
function shown({ decision, user }: Attributed): string {
  const text = shownText(decision.text, LIMITS.decisionText);
  return `[${shownText(decision.id, 40)}] ${text} (${shownText(user, LIMITS.name) || "unknown"} / ${shownText(decision.agent, LIMITS.name) || "unknown"})`;
}

/**
 * Says what happened and gives the exit code: 0 recorded, 1 not recorded for
 * a reason that running the command again as it is will not change by itself,
 * 2 a mistake in the command, 3 someone else got there first.
 */
export function report(result: DecideResult, asked: { remote: string; supersedes?: string | undefined }, io: Pick<Io, "out" | "err">): number {
  const { remote, supersedes } = asked;
  if (result.ok) {
    io.out(`decision ${result.decision.id} recorded${supersedes === undefined ? "" : `, replacing ${supersedes}`}: ${result.decision.text}`);
    if (result.dropped > 0) {
      const n = result.dropped;
      io.out(`(${n} superseded decision${n === 1 ? " was" : "s were"} removed from this clone's log to make room)`);
    }
    return EXIT.OK;
  }

  switch (result.reason) {
    case "unknown-supersedes":
      throw new UsageError(`there is no decision ${supersedes}; run "huddle decisions" to see the ids. Nothing was recorded.`);
    case "already-superseded": {
      const inForce = result.inForce ?? [];
      const first = inForce[0];
      const more = inForce.length > 1 ? ` (and ${inForce.length - 1} more; see "huddle decisions")` : "";
      io.err(
        first === undefined
          ? `huddle: decision ${supersedes} was already replaced. The decision was NOT recorded; run "huddle decisions" to see what is in force.`
          : `huddle: decision ${supersedes} was already replaced by ${shown(first)}${more}. The decision was NOT recorded. To replace the rule in force, run the command again with --supersedes ${first.decision.id}.`,
      );
      return EXIT.CONFLICT;
    }
    case "offline":
      // Once the push has gone out, a missing answer does not say whether the remote took it.
      io.err(
        result.sent
          ? `huddle: remote "${remote}" stopped answering while the decision was being sent, so it may or may not have been recorded. Check with "huddle decisions" before running the command again.`
          : `huddle: could not reach remote "${remote}" (offline or timed out). The decision was NOT recorded; run the command again when the remote is reachable.`,
      );
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
