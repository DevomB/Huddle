// T1.4. Argument parsing for commands: node's parseArgs, with its errors
// turned into usage errors (exit code 2).

import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { UsageError } from "./io.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

export function parse<T extends Options>(args: string[], options: T, usage: string) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\nUsage: ${usage}`);
  }
}
