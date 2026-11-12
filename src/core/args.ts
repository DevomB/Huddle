// T1.4. Argument parsing for commands: node's parseArgs, with its errors
// turned into usage errors (exit code 2).

import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { HelpRequested, UsageError } from "./io.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

/**
 * Parses a command's arguments. `--help` or `-h` anywhere before a "--" asks
 * for the command's help instead (HelpRequested); anything parseArgs rejects
 * is a UsageError carrying `usage`.
 */
export function parse<T extends Options>(args: string[], options: T, usage: string) {
  const end = args.indexOf("--");
  const flags = end === -1 ? args : args.slice(0, end);
  if (flags.includes("--help") || flags.includes("-h")) throw new HelpRequested(usage);
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\nUsage: ${usage}`);
  }
}
