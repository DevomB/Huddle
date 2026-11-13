// T1.4. Argument parsing for commands: node's parseArgs, with its errors
// turned into usage errors (exit code 2). And the one option that is not a
// command's own: `--session`, which cli.ts takes off the line first.

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

/**
 * Takes the global option `--session <id>` (or `--session=<id>`) off a command
 * line, wherever it stands. It says which session this one command is
 * (core/acting.ts), and no command parses it. Two parts of a line are never
 * looked at: what follows a "--", which is the command's own text, and what
 * follows `hook`, which is an agent's. Given twice, or with no id, it is a
 * usage error: a command must not guess who it acts as.
 */
export function takeSession(argv: readonly string[]): { argv: string[]; session?: string } {
  const rest: string[] = [];
  let session: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--" || rest[0] === "hook") {
      rest.push(...argv.slice(index));
      break;
    }
    let value: string | undefined;
    if (arg === "--session") value = argv[++index] ?? "";
    else if (arg.startsWith("--session=")) value = arg.slice("--session=".length);
    else {
      rest.push(arg);
      continue;
    }
    value = value.trim();
    if (value === "" || value.startsWith("-")) throw new UsageError('--session needs a session id, or "manual" for this worktree\'s own session');
    if (session !== undefined) throw new UsageError("--session was given twice");
    session = value;
  }
  return session === undefined ? { argv: rest } : { argv: rest, session };
}
