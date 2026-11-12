// T4.1.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Record a decision others must follow: huddle decide \"<text>\"";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("decide", io);
}
