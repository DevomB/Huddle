// What a command sees of the outside world, and how it reports back.
// Commands never touch process.* directly, so tests can run them in-process.

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  /** Overlap found, or a compare-and-swap was lost. */
  CONFLICT: 3,
} as const;

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Absolute path of the running huddle script, for vendoring and for spawning a background sync. */
  self: string;
  /** Write one line to stdout. A trailing newline is added. */
  out(text: string): void;
  /** Write one line to stderr. A trailing newline is added. */
  err(text: string): void;
  /** All of stdin as text. Empty when stdin is a terminal. Never hangs: gives up after a short timeout. */
  readStdin(): Promise<string>;
}

export interface Command {
  /** One line for `huddle --help`. */
  summary: string;
  /** Returns the process exit code. May throw CliError / UsageError. */
  run(args: string[], io: Io): Promise<number>;
}

/** An error whose message is meant for the user. cli.ts prints `huddle: <message>` and exits with `exitCode`. */
export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT.ERROR) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
    this.name = "UsageError";
  }
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = "NotImplementedError";
  }
}

/** Body of a stub command. The task that owns the command replaces the call. */
export function notImplemented(command: string, io: Io): number {
  io.err(`not implemented: ${command}`);
  return EXIT.ERROR;
}

/** Body of a stub module function. The task that owns the module replaces the call. */
export function todo(what: string): never {
  throw new NotImplementedError(what);
}

const STDIN_TIMEOUT_MS = 2000;

/** The real thing. `self` is the path of the running script (the bundle). */
export function processIo(self: string): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    self,
    out: (text) => void process.stdout.write(text.endsWith("\n") ? text : text + "\n"),
    err: (text) => void process.stderr.write(text.endsWith("\n") ? text : text + "\n"),
    readStdin: () => readAll(process.stdin, STDIN_TIMEOUT_MS),
  };
}

function readAll(stream: NodeJS.ReadStream, timeoutMs: number): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on("data", (chunk: Buffer | string) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    stream.on("end", finish);
    stream.on("error", finish);
    stream.resume();
  });
}
