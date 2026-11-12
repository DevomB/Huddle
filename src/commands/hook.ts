// T2.1.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Entry point for agent hooks: huddle hook <agent>";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("hook", io);
}
