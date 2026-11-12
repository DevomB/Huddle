// T2.3.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Set this repo up for huddle: vendor the bundle, write config, install agent hooks";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("init", io);
}
