// T1.4. huddle intent

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { cleanText, LIMITS } from "../core/docs.ts";
import { currentBranch } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { resolveSession } from "../core/session.ts";
import { touchSession } from "../core/store.ts";
import { spawnBackgroundSync } from "../core/sync.ts";

export const summary = "Say what this session is doing: huddle intent \"<text>\"";

const USAGE = 'huddle intent "<what you are doing>" | huddle intent --clear | huddle intent';

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { clear: { type: "boolean", default: false } }, USAGE);
  const ctx = await openContext(io);
  const me = await resolveSession(ctx);

  if (positionals.length === 0 && !values.clear) {
    io.out(me.session?.intent ? me.session.intent : "(no intent set)");
    return EXIT.OK;
  }
  if (values.clear && positionals.length > 0) throw new UsageError(`--clear takes no text\nUsage: ${USAGE}`);

  const intent = values.clear ? "" : cleanText(positionals.join(" "), LIMITS.intent);
  if (!values.clear && intent === "") throw new UsageError(`the intent is empty\nUsage: ${USAGE}`);

  await touchSession(ctx.paths, {
    id: me.id,
    worktree: ctx.paths.worktree,
    agent: me.agent,
    branch: await currentBranch(ctx.paths.worktree),
    intent,
    intentSource: intent === "" ? "none" : "manual",
    seenAt: ctx.now.toISOString(),
  });
  io.out(intent === "" ? "intent cleared" : `intent: ${intent}`);
  spawnBackgroundSync(ctx.paths, io.self, { force: true });
  return EXIT.OK;
}
