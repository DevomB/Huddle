// T1.4.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Check paths for overlap with teammates; exits 3 on overlap";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("check", io);
}
