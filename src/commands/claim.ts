// T1.4.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Claim files by glob for this session";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("claim", io);
}
