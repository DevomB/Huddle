// The only place huddle starts a git process. The safety rules from plan.md §3
// live here so no caller can forget one:
//
//   - Never prompt: GIT_TERMINAL_PROMPT=0, no askpass, ssh in batch mode. A hook
//     must not hang on a credential prompt.
//   - Every call has a timeout, and a timed-out call takes its whole process
//     group with it (git's ssh child would otherwise outlive git).
//   - No surprise writes: gc and maintenance are off, and optional locks are off
//     so that `git status` does not rewrite the index behind the user's back.
//   - Inherited GIT_DIR / GIT_INDEX_FILE / ... are dropped. huddle runs inside
//     git hooks, where git sets them, and they would redirect our calls.
//   - Output is not localized (LC_ALL=C), because callers classify failures from
//     stderr text.
//
// What this module cannot enforce is which git commands are run. Callers must
// still never write local refs, FETCH_HEAD, the index or the working tree:
// fetch with --no-write-fetch-head, build docs with hash-object / mktree /
// commit-tree, and push with --no-verify so user pre-push hooks do not fire.
// The user's own git config can undo each of those from the side, and has to
// be countered per command (transport.ts does): remote.<name>.tagOpt=--tags
// makes a fetch write tags (--no-tags), a mirror-style fetch refspec makes
// fetch and push write tracking refs (--refmap=, a stand-in remote),
// push.gpgSign fails or prompts (--no-signed), push.pushOption rides along
// (-c push.pushOption=), a partial clone's filter drops the blob (--no-filter),
// and commit-tree needs an identity the machine may not have (a fixed one).

import { spawn } from "node:child_process";

export const NETWORK_TIMEOUT_MS = 10_000;
export const LOCAL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface GitOptions {
  /** Directory to run in. Always required: huddle never relies on process.cwd(). */
  cwd: string;
  /** Text fed to stdin. Without it stdin is closed. */
  input?: string;
  /** Extra environment, applied last. Pass GIT_INDEX_FILE etc. here if a call really needs an inherited one. */
  env?: Record<string, string | undefined>;
  /** The call talks to a remote: apply the no-prompt rules and the network timeout. */
  network?: boolean;
  /** Overrides the default (10 s for network calls, 15 s otherwise). HUDDLE_TIMEOUT_MS overrides the network default. */
  timeoutMs?: number;
}

export interface GitResult {
  /** Exit code 0 and not timed out. */
  ok: boolean;
  /** Exit code, or -1 when git could not be started, was killed, or timed out. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class GitError extends Error {
  result: GitResult;
  args: string[];
  constructor(args: string[], result: GitResult) {
    const why = result.timedOut ? "timed out" : `exited ${result.code}`;
    super(`git ${args.join(" ")} ${why}: ${result.stderr.trim() || "(no stderr)"}`);
    this.name = "GitError";
    this.args = args;
    this.result = result;
  }
}

/** Options that go before the subcommand on every call. */
const BASE_ARGS = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

/**
 * Added for network calls. The HTTP counterpart of ssh's ServerAlive options:
 * git itself gives up on a transfer that stays under 1000 bytes per second for
 * 10 seconds, also when nobody is left to enforce our own timeout.
 */
const NETWORK_ARGS = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=10"];

/** Set by git when it runs a hook or an alias; they would point our calls at the wrong repo or index. */
const INHERITED_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_NAMESPACE",
];

/** The program an ssh command line starts with. A quoted path may contain spaces ("C:\Program Files\PuTTY\plink.exe"). */
function sshProgram(command: string): string {
  const quote = command[0];
  if (quote === '"' || quote === "'") {
    const end = command.indexOf(quote, 1);
    return end > 0 ? command.slice(1, end) : command.slice(1);
  }
  return command.split(/\s+/)[0] ?? "";
}

/**
 * Makes an ssh command non-interactive and bounded. Options are appended, and
 * ssh uses the first value it sees for each option, so anything the user set in
 * their own core.sshCommand wins.
 *
 * ConnectTimeout bounds the connection attempt; the ServerAlive pair makes ssh
 * give up on a connection that went silent after about 10 seconds by itself.
 * That matters when the huddle process that owns the timeout is gone: an agent
 * kills a hook at its own deadline, and the ssh it started would otherwise
 * wait on a dead connection for as long as TCP lets it.
 */
export function hardenSshCommand(base: string): string {
  const command = base.trim() || "ssh";
  if (/(^|[\\/])(tortoise)?plink(\.exe)?$/i.test(sshProgram(command))) {
    // PuTTY's plink takes none of OpenSSH's -o options.
    return /(^|\s)-batch(\s|$)/.test(command) ? command : `${command} -batch`;
  }
  return `${command} -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2`;
}

/**
 * The environment for one git call. Exported for tests; `sshCommand` is the
 * value of core.sshCommand when the caller has looked it up.
 */
export function gitEnv(
  parent: NodeJS.ProcessEnv,
  opts: { network?: boolean; env?: Record<string, string | undefined>; sshCommand?: string | null } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const name of INHERITED_LOCATION_VARS) delete env[name];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  if (opts.network) {
    // An empty GIT_ASKPASS short-circuits core.askPass and SSH_ASKPASS in git's
    // prompt code, so no GUI password dialog can pop up either.
    env.GIT_ASKPASS = "";
    env.GCM_INTERACTIVE = "never";
    const base = parent.GIT_SSH_COMMAND || opts.sshCommand || (parent.GIT_SSH ? null : "ssh");
    // GIT_SSH names a bare program we cannot pass options to; leave it alone.
    if (base) env.GIT_SSH_COMMAND = hardenSshCommand(base);
  }
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

const sshCommandCache = new Map<string, Promise<string | null>>();

function configuredSshCommand(cwd: string): Promise<string | null> {
  let cached = sshCommandCache.get(cwd);
  if (!cached) {
    cached = run(["config", "--get", "core.sshCommand"], { cwd }, gitEnv(process.env)).then((r) =>
      r.ok && r.stdout.trim() ? r.stdout.trim() : null,
    );
    sshCommandCache.set(cwd, cached);
  }
  return cached;
}

function networkTimeout(): number {
  const override = Number(process.env.HUDDLE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : NETWORK_TIMEOUT_MS;
}

/** Runs git. Never throws and never rejects: every failure comes back as a result with ok === false. */
export async function git(args: string[], opts: GitOptions): Promise<GitResult> {
  let sshCommand: string | null = null;
  if (opts.network && !process.env.GIT_SSH_COMMAND) sshCommand = await configuredSshCommand(opts.cwd);
  return run(args, opts, gitEnv(process.env, { network: opts.network, env: opts.env, sshCommand }));
}

/** Runs git and returns stdout without its trailing newline. Throws GitError on any failure. */
export async function gitOut(args: string[], opts: GitOptions): Promise<string> {
  const result = await git(args, opts);
  if (!result.ok) throw new GitError(args, result);
  return result.stdout.replace(/\r?\n$/, "");
}

function run(args: string[], opts: GitOptions, env: NodeJS.ProcessEnv): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? (opts.network ? networkTimeout() : LOCAL_TIMEOUT_MS);
  // Its own process group on POSIX, so a timeout can kill git and its ssh child together.
  const ownGroup = process.platform !== "win32";

  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (code: number, timedOut: boolean, note?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(err).toString("utf8");
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: note ? (stderr ? `${stderr}\n${note}` : note) : stderr,
        timedOut,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...BASE_ARGS, ...(opts.network ? NETWORK_ARGS : []), ...args], {
        cwd: opts.cwd,
        env,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: ownGroup,
        windowsHide: true,
      });
    } catch (error) {
      settle(-1, false, `could not start git: ${message(error)}`);
      return;
    }

    const kill = () => {
      try {
        if (ownGroup && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        // Windows has no process groups to signal: this ends git but not the ssh or
        // credential helper it started. Those end by themselves through the ssh and
        // http limits set above.
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      // A grandchild may still hold the pipes open; do not wait for 'close'.
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    timer = setTimeout(() => {
      kill();
      settle(-1, true, `timed out after ${timeoutMs} ms`);
    }, timeoutMs);

    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        kill();
        settle(-1, false, "git output too large");
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    child.on("error", (error) => settle(-1, false, `could not start git: ${message(error)}`));
    child.on("close", (code) => settle(code ?? -1, false));

    if (opts.input !== undefined && child.stdin) {
      // git may exit before it reads stdin; without a listener the EPIPE would crash the process.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
