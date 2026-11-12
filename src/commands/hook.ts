// T2.1. huddle hook <agent>: what an agent's hook configuration runs.

import { EXIT } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { lifetimeMs, noteCrash, runHook } from "../hooks/engine.ts";

export const summary = "Entry point for agent hooks: huddle hook <agent>";

/** Is this process a hook that an agent started? Not when run() is called from a test, or from any other command. */
function isHookProcess(): boolean {
  return process.argv[2] === "hook";
}

/**
 * In a hook process the first lines of the bundle (scripts/banner.mjs) turn
 * anything uncaught into a silent exit 0. That guard cannot say where the
 * debug log is; the engine can, so it gets to leave a line there first.
 */
function recordCrashes(): void {
  process.prependListener("uncaughtException", noteCrash);
  process.prependListener("unhandledRejection", noteCrash);
}

/**
 * No hook process lives longer than lifetimeMs(). Every event has a deadline
 * of its own, and the process exits when it has passed (hooks/engine.ts).
 * This timer is for whatever gets around that, now or after the next change
 * to this code: it ends the process with exit code 0 and nothing more said.
 * Where an agent's own time limit only ends the shell that started node (a
 * hook command with `; exit 0` behind it), this is the limit that holds.
 *
 * Two things it is not. It does not keep a process alive that is done: the
 * timer is unref'd. And it cannot fire while the process is stuck inside one
 * synchronous call, because nothing can.
 *
 * Returns the timer, for tests.
 */
export function limitLifetime(ms: number, exit: (code: number) => void = (code) => process.exit(code)): NodeJS.Timeout {
  const timer = setTimeout(() => exit(EXIT.OK), ms);
  timer.unref();
  return timer;
}

/**
 * Always exits 0 unless the agent's own protocol asks for another code: a hook
 * never breaks the agent. This is the one command that touches `process`, and
 * only in a real hook process.
 */
export async function run(args: string[], io: Io): Promise<number> {
  if (isHookProcess()) {
    recordCrashes();
    limitLifetime(lifetimeMs(io));
  }
  return runHook(args, io);
}
