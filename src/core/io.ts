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
  /**
   * The global option `--session <id>`, when it was given: the session this
   * one command says it is (core/acting.ts). cli.ts takes it off the command
   * line, so no command sees or parses it.
   */
  session?: string;
  /** This run's arguments, the command name first, without the global options. For a message that shows the command line again. */
  argv?: string[];
  /** Write one line to stdout. A trailing newline is added. */
  out(text: string): void;
  /** Write one line to stderr. A trailing newline is added. */
  err(text: string): void;
  /**
   * Stdin as text. Empty when stdin is a terminal. Never hangs: without end of
   * input it returns what has arrived after `timeoutMs` (default 2000).
   */
  readStdin(opts?: StdinOptions): Promise<string>;
}

export interface StdinOptions {
  /** How long to wait for end of input. A hook passes its own budget. */
  timeoutMs?: number;
  /**
   * Return as soon as what has arrived is one complete JSON value. Agents send
   * a hook its payload as one JSON object, and some keep the pipe open
   * afterwards; without this such a hook would wait for the whole timeout.
   */
  json?: boolean;
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

/**
 * Thrown by args.parse when the arguments ask for help (--help or -h). The
 * dispatcher prints the command's summary and this usage line, and exits 0.
 */
export class HelpRequested extends Error {
  readonly usage: string;
  constructor(usage: string) {
    super("help requested");
    this.name = "HelpRequested";
    this.usage = usage;
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
    readStdin: (opts = {}) => readAll(process.stdin, opts.timeoutMs ?? STDIN_TIMEOUT_MS, opts.json === true),
  };
}

/** Exported for tests. `stream` is anything shaped like process.stdin. */
export function readAll(stream: NodeJS.ReadableStream & { isTTY?: boolean }, timeoutMs: number, json = false): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const text = () => Buffer.concat(chunks).toString("utf8");
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.pause();
      resolve(text());
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(bytes);
      if (!json) return;
      // Only worth a parse when the chunk ends the way a JSON object or array does.
      const last = bytes.toString("latin1").trimEnd().slice(-1);
      if (last !== "}" && last !== "]") return;
      try {
        JSON.parse(text());
        finish();
      } catch {
        // Not complete yet.
      }
    });
    stream.on("end", finish);
    stream.on("error", finish);
    stream.resume();
  });
}
