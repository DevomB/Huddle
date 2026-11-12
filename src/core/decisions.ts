// T4.1. Shared decisions: the write path. The read side (union of all actors'
// decisions minus superseded ones, newest first) is buildView in view.ts.

import type { Ctx } from "./context.ts";
import { todo } from "./io.ts";
import type { Decision, FailReason } from "./types.ts";

export type DecideResult = { ok: true; decision: Decision } | { ok: false; reason: FailReason | "unknown-supersedes" };

/**
 * Appends a decision to this clone's DecisionDoc and force-publishes it to
 * refs/huddle/decisions/<actor>. Must not lose this clone's earlier decisions
 * when the cache is empty or stale.
 */
export async function addDecision(
  ctx: Ctx,
  text: string,
  opts: { supersedes?: string; agent?: string } = {},
): Promise<DecideResult> {
  void ctx;
  void text;
  void opts;
  return todo("decisions.addDecision");
}
