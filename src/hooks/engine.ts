// T2.1. The hook engine: normalized events in, outcomes out (plan.md §3 Hooks).
// Agent-agnostic. Reads only local state and the cache; the network is only
// touched by the blocking sync in session-start / session-end and by detached
// background syncs (sync.spawnBackgroundSync).

import type { HookEvent, HookOutcome } from "../adapters/types.ts";
import { todo } from "../core/io.ts";
import type { Io } from "../core/io.ts";

/**
 * Event           Action                                                        Budget
 * session-start   one blocking sync, then the full briefing                     4 s
 * prompt          record intent, brief on what changed, background sync         300 ms
 * pre-edit        check the target paths against the cache; warn                150 ms
 * post-edit       background sync                                               150 ms
 * turn-end        background sync                                               150 ms
 * session-end     remove the session, sync                                      4 s
 *
 * Every event creates or touches the session it names. Never throws: an
 * internal error is logged and yields an empty outcome.
 */
export async function handleEvent(event: HookEvent, io: Io): Promise<HookOutcome> {
  void event;
  void io;
  return todo("engine.handleEvent");
}

/**
 * `huddle hook <agent> [args...]`: read stdin, let the adapter parse it, run
 * handleEvent, print what the adapter formats. Returns the exit code, which
 * is 0 on every internal error: a hook never breaks the agent.
 */
export async function runHook(args: string[], io: Io): Promise<number> {
  void args;
  void io;
  return todo("engine.runHook");
}
