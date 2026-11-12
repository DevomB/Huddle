// T5.1.

import { notImplemented } from "../core/io.ts";
import type { Io } from "../core/io.ts";

export const summary = "Shared tasks: add | list | claim | done | drop";

export async function run(args: string[], io: Io): Promise<number> {
  void args;
  return notImplemented("task", io);
}
