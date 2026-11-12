// T2.1. huddle hook <agent>: what an agent's hook configuration runs.

import type { Io } from "../core/io.ts";
import { noteCrash, runHook } from "../hooks/engine.ts";

export const summary = "Entry point for agent hooks: huddle hook <agent>";

/**
 * In a hook process the first lines of the bundle (scripts/banner.mjs) turn
 * anything uncaught into a silent exit 0. That guard cannot say where the
 * debug log is; the engine can, so it gets to leave a line there first.
 *
 * This is the one command that touches `process`. Only a real hook process
 * does: run() called from a test, or from any other command, registers
 * nothing.
 */
function recordCrashes(): void {
  if (process.argv[2] !== "hook") return;
  process.prependListener("uncaughtException", noteCrash);
  process.prependListener("unhandledRejection", noteCrash);
}

/** Always exits 0 unless the agent's own protocol asks for another code: a hook never breaks the agent. */
export async function run(args: string[], io: Io): Promise<number> {
  recordCrashes();
  return runHook(args, io);
}
