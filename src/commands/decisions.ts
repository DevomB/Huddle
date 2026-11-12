// T4.1.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "List the team's current decisions";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("decisions", io);
}
