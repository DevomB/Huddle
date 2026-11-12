// T1.4.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Show who is working on what";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("status", io);
}
