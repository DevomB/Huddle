// T1.4.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Publish this clone's sessions and refresh the team state";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("sync", io);
}
