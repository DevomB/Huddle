// The entry point and command dispatch. This file runs on import: it is the
// program, not a library. Nobody but the lead edits it; a new command is a file
// in commands/ plus one line in COMMANDS.
//
//   init, doctor                                   T2.3
//   sync, status, intent, claim, release, check    T1.4
//   hook                                           T2.1
//   decide, decisions                              T4.1
//   task                                           T5.1

import { fileURLToPath } from "node:url";
import * as check from "./commands/check.ts";
import * as claim from "./commands/claim.ts";
import * as decide from "./commands/decide.ts";
import * as decisions from "./commands/decisions.ts";
import * as doctor from "./commands/doctor.ts";
import * as hook from "./commands/hook.ts";
import * as init from "./commands/init.ts";
import * as intent from "./commands/intent.ts";
import * as release from "./commands/release.ts";
import * as status from "./commands/status.ts";
import * as sync from "./commands/sync.ts";
import * as task from "./commands/task.ts";
import { takeSession } from "./core/args.ts";
import { CliError, EXIT, HelpRequested, processIo } from "./core/io.ts";
import type { Command, Io } from "./core/io.ts";

// Replaced with the package version by scripts/build.mjs.
declare const __HUDDLE_VERSION__: string | undefined;
const VERSION = typeof __HUDDLE_VERSION__ === "string" ? __HUDDLE_VERSION__ : "0.0.0-dev";

// In help order.
const COMMANDS: Record<string, Command> = {
  init,
  doctor,
  status,
  sync,
  intent,
  check,
  claim,
  release,
  decide,
  decisions,
  task,
  hook,
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    `huddle ${VERSION} - coding agents coordinating through the git remote they share`,
    "",
    "Usage: huddle <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`),
    "",
    "Options:",
    "  -h, --help          Show this help; after a command, that command's usage",
    "  -V, --version       Show the version",
    '      --session <id>  Say which session this command is, when huddle cannot tell: an id it lists, or "manual"',
    "",
    "Exit codes: 0 ok, 1 error, 2 usage, 3 overlap or lost race",
  ].join("\n");
}

async function main(line: string[], terminal: Io): Promise<number> {
  let argv: string[];
  let io = terminal;
  try {
    const taken = takeSession(line);
    argv = taken.argv;
    io = { ...terminal, argv, ...(taken.session === undefined ? {} : { session: taken.session }) };
  } catch (error) {
    terminal.err(`huddle: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CliError ? error.exitCode : EXIT.USAGE;
  }
  const [name, ...args] = argv;
  if (name === undefined) {
    io.err(usage());
    return EXIT.USAGE;
  }
  if (name === "--help" || name === "-h" || name === "help") {
    io.out(usage());
    return EXIT.OK;
  }
  if (name === "--version" || name === "-V" || name === "version") {
    io.out(VERSION);
    return EXIT.OK;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    io.err(`huddle: unknown command "${name}". Run "huddle --help" for the list.`);
    return EXIT.USAGE;
  }
  try {
    return await command.run(args, io);
  } catch (error) {
    // A hook exits 0 on every internal error and stays quiet: it never breaks the agent.
    if (name === "hook") return EXIT.OK;
    if (error instanceof HelpRequested) {
      io.out(`${command.summary}\n\nUsage: ${error.usage}`);
      return EXIT.OK;
    }
    if (error instanceof CliError) {
      io.err(`huddle: ${error.message}`);
      return error.exitCode;
    }
    io.err(`huddle: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.ERROR;
  }
}

/** Exit once stdout and stderr have drained: hook output is read from a pipe and must not be cut short. */
function exit(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

// A reader that goes away (huddle status | head) is not an error worth a stack trace.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

main(process.argv.slice(2), processIo(fileURLToPath(import.meta.url))).then(exit, (error) => {
  process.stderr.write(`huddle: ${error instanceof Error ? error.message : String(error)}\n`);
  exit(process.argv[2] === "hook" ? EXIT.OK : EXIT.ERROR);
});
