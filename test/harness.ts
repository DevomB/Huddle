// The test harness: one bare remote, any number of clones of it, and a way to
// run the built CLI in a clone as that clone's actor.
//
//   const h = await createHarness(t);            // cleaned up when the test ends
//   const alice = await h.clone("alice");
//   const bob = await h.clone("bob");
//   await alice.write("src/auth.ts", "...");
//   await alice.huddle(["intent", "build auth"]);
//   const r = await bob.huddle(["status"], { now: "2026-01-01T00:20:00Z" });
//
// Importing this file isolates git for the whole test process: no system or
// user config, a throwaway HOME, and no inherited GIT_DIR. That covers tests
// that call src/ modules in-process as well as the spawned CLI. `npm test`
// builds the bundle first; huddle() runs dist/huddle.mjs, the file that ships.
//
// The harness runs unchanged on Linux and on native Windows (Git for Windows,
// no WSL). Every directory it makes has a space and a letter outside ASCII in
// its name, so each test that uses it also covers such paths on both. A test
// whose mechanism exists only on POSIX says so with posixOnly(), and whatever
// it protects needs a portable test next to it.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOut } from "../src/core/git.ts";
import type { GitOptions, GitResult } from "../src/core/git.ts";
import { locateRepo } from "../src/core/paths.ts";
import type { RepoPaths } from "../src/core/paths.ts";

/** The built CLI. */
export const BUNDLE = fileURLToPath(new URL("../dist/huddle.mjs", import.meta.url));

/**
 * The node binary that runs the bundle. HUDDLE_TEST_NODE points it at another
 * version (CI uses Node 20, the oldest supported), while the tests themselves
 * need a Node that can load TypeScript.
 */
export const BUNDLE_NODE = process.env.HUDDLE_TEST_NODE || process.execPath;

// `npm test` rebuilds the bundle; `node --test test/one.test.ts` does not. Running the tests
// against a bundle older than the source gives false passes and false failures, so refuse.
{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const newest = (path: string): number => {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return 0;
    if (!info.isDirectory()) return info.mtimeMs;
    return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
  };
  const built = statSync(BUNDLE, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const source = Math.max(newest(join(root, "src")), newest(join(root, "scripts")), newest(join(root, "package.json")));
  if (built < source) {
    throw new Error(
      built === 0
        ? "dist/huddle.mjs does not exist. Run `npm run build` first (`npm test` does it for you)."
        : "dist/huddle.mjs is older than the source it is built from. Run `npm run build` first (`npm test` does it for you).",
    );
  }
}

// ---------------------------------------------------------------------------
// Process-wide isolation, set up once on import.
// ---------------------------------------------------------------------------

/** True on native Windows. Not under WSL, which is Linux to node. */
export const WINDOWS = process.platform === "win32";

/**
 * Options for a test whose mechanism exists only on POSIX: a mode bit, a
 * signal, a script that stands in for a program. It runs everywhere else and
 * is skipped on Windows with the reason shown in the report.
 *
 *   test("a hooks file its owner made read-only is left alone", posixOnly("chmod"), async (t) => { ... });
 */
export function posixOnly(mechanism: string): { skip: string | false } {
  return { skip: WINDOWS ? `POSIX-only: ${mechanism}` : false };
}

/**
 * The other way round, for a test of something only Windows has: cmd.exe, a
 * drive letter. It is skipped everywhere else, with the reason in the report.
 */
export function windowsOnly(mechanism: string): { skip: string | false } {
  return { skip: WINDOWS ? false : `Windows-only: ${mechanism}` };
}

/**
 * What every temp directory of the harness starts with: a space and a letter
 * outside ASCII (precomposed, so that it is the same bytes on every file
 * system these tests run on).
 */
export const TEMP_PREFIX = "huddle t\u00e9st ";

/**
 * A new temp directory, as the operating system itself names it. The native
 * realpath matters on Windows: the temp directory is often handed out in its
 * short form (C:\Users\RUNNER~1\...), and git and node's own realpath
 * disagree about that form.
 */
export function tempDirSync(label: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${label}-`)));
}

export async function tempDir(label: string): Promise<string> {
  return realpathSync.native(await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}${label}-`)));
}

/** Removes a test's directory. Windows keeps a directory busy for a moment after the last process in it has gone. */
export function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: WINDOWS ? 20 : 3, retryDelay: 100 });
}

const isolation = tempDirSync("env");
mkdirSync(join(isolation, "home"), { recursive: true });
writeFileSync(
  join(isolation, "gitconfig"),
  [
    "[user]",
    "\tname = Test User",
    "\temail = test@example.invalid",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[tag]",
    "\tgpgsign = false",
    "[core]",
    "\tautocrlf = false",
    // Only read by Git for Windows: fixtures with paths at the protocol's limit are longer than MAX_PATH.
    "\tlongpaths = true",
    "[advice]",
    "\tdetachedHead = false",
    "",
  ].join("\n"),
);
process.on("exit", () => {
  try {
    rmSync(isolation, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

/** The environment every harness git call and CLI run gets, on top of the parent's. */
export const TEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: join(isolation, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: join(isolation, "home"),
  // What node's os.homedir() and Git for Windows go by on Windows; unused elsewhere.
  USERPROFILE: join(isolation, "home"),
  XDG_CONFIG_HOME: join(isolation, "home", ".config"),
  // No detached background syncs: they would outlive the test and write into a
  // directory that is being removed. A test of the background path sets this to "".
  HUDDLE_NO_BACKGROUND: "1",
});

/**
 * Variables from the shell that runs the tests that would leak into them, or
 * out of them: an agent running the suite may carry CLAUDE_ENV_FILE (Claude
 * Code hands it to its SessionStart hooks), and a session-start replayed by a
 * test would then append to that real file.
 */
const SCRUBBED = [
  "CLAUDE_ENV_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "HUDDLE_NOW",
  "HUDDLE_SESSION",
  "HUDDLE_TIMEOUT_MS",
];

Object.assign(process.env, TEST_ENV);
for (const name of SCRUBBED) delete process.env[name];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HuddleOptions {
  /** Pins the CLI's clock (HUDDLE_NOW). */
  now?: string | Date;
  /** Sets HUDDLE_SESSION, the session id for manual use. */
  session?: string;
  /** Text piped to stdin, for hook payloads. */
  stdin?: string;
  /** Extra environment. */
  env?: Record<string, string>;
  /** Directory to run in, relative to the clone. Defaults to the clone's top level. */
  cwd?: string;
  /** Kill the CLI after this long. Default 30 s. */
  timeoutMs?: number;
}

/**
 * Everything the transport rules say a huddle call must leave alone: local
 * refs, HEAD, FETCH_HEAD, the index and the working tree. Take one before and
 * one after and compare with assert.deepStrictEqual.
 */
export interface Snapshot {
  /** Every local ref and what it points at. */
  refs: string;
  head: string;
  /** sha256 of FETCH_HEAD, or null when there is none. */
  fetchHead: string | null;
  /** sha256 of the index file, or null when there is none. */
  index: string | null;
  /** git status --porcelain, including untracked files. */
  status: string;
  /** sha256 of the repository's config file: catches `push -u`, `remote set-url`, `git config`. */
  config: string | null;
}

export interface Clone {
  name: string;
  /** Top level of the working tree (absolute, symlinks resolved). */
  dir: string;
  /** Runs git here; returns trimmed stdout; throws GitError on failure. */
  git(...args: string[]): Promise<string>;
  /** Runs git here; never throws. */
  gitResult(args: string[], opts?: Omit<GitOptions, "cwd">): Promise<GitResult>;
  /** Runs the built CLI here. Never throws; a timeout comes back as code -1. */
  huddle(args: string[], opts?: HuddleOptions): Promise<RunResult>;
  /** Writes a file, creating directories. `rel` is relative to the clone. */
  write(rel: string, content: string): Promise<void>;
  read(rel: string): Promise<string>;
  /** git add -A && git commit. Returns the new commit's sha. */
  commit(message: string): Promise<string>;
  /** Pushes the current branch to origin and sets upstream. */
  push(): Promise<void>;
  paths(): Promise<RepoPaths>;
  snapshot(): Promise<Snapshot>;
  /** Adds a linked worktree on a new branch. It shares this clone's git common dir, so it is the same actor. */
  addWorktree(name: string, branch?: string): Promise<Clone>;
}

export interface Harness {
  /** Temp directory holding the remote and the clones. */
  root: string;
  /** The bare remote (absolute path). It has one commit on main and HEAD pointing at main. */
  remote: string;
  /** A fresh clone of the remote at <root>/<name>, with user.name set to `name`. */
  clone(name: string): Promise<Clone>;
  /** Runs git in the bare remote; returns trimmed stdout; throws on failure. */
  remoteGit(...args: string[]): Promise<string>;
  /** Removes everything. Called automatically when a test context was given. */
  cleanup(): Promise<void>;
}

/** Enough of node:test's TestContext to register cleanup. */
export interface CleanupHost {
  after(fn: () => void | Promise<void>): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createHarness(t?: CleanupHost): Promise<Harness> {
  const root = await tempDir("repo");
  const remote = join(root, "remote.git");
  const cleanup = () => removeDir(root);
  t?.after(cleanup);

  await gitOut(["init", "--quiet", "--bare", "--initial-branch=main", remote], { cwd: root });

  // Seed main with one commit so clones have a branch and origin/HEAD resolves.
  const seed = join(root, ".seed");
  await gitOut(["clone", "--quiet", remote, seed], { cwd: root });
  await writeFile(join(seed, "README.md"), "# test repo\n");
  await gitOut(["add", "-A"], { cwd: seed });
  await gitOut(["commit", "--quiet", "-m", "Initial commit"], { cwd: seed });
  await gitOut(["push", "--quiet", "origin", "HEAD:refs/heads/main"], { cwd: seed });
  await removeDir(seed);

  return {
    root,
    remote,
    cleanup,
    remoteGit: (...args) => gitOut(args, { cwd: remote }),
    async clone(name) {
      const dir = join(root, name);
      await gitOut(["clone", "--quiet", remote, dir], { cwd: root });
      await gitOut(["config", "user.name", name], { cwd: dir });
      await gitOut(["config", "user.email", `${name}@example.invalid`], { cwd: dir });
      return makeClone(name, dir);
    },
  };
}

function makeClone(name: string, dir: string): Clone {
  const clone: Clone = {
    name,
    dir,
    git: (...args) => gitOut(args, { cwd: dir }),
    gitResult: (args, opts = {}) => git(args, { ...opts, cwd: dir }),
    huddle: (args, opts = {}) => runHuddle(dir, args, opts),
    async write(rel, content) {
      const file = join(dir, rel);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    read: (rel) => readFile(join(dir, rel), "utf8"),
    async commit(message) {
      await gitOut(["add", "-A"], { cwd: dir });
      await gitOut(["commit", "--quiet", "-m", message], { cwd: dir });
      return gitOut(["rev-parse", "HEAD"], { cwd: dir });
    },
    async push() {
      await gitOut(["push", "--quiet", "--set-upstream", "origin", "HEAD"], { cwd: dir });
    },
    async paths() {
      const paths = await locateRepo(dir);
      if (!paths) throw new Error(`${dir} is not a git worktree`);
      return paths;
    },
    snapshot: () => takeSnapshot(dir),
    async addWorktree(worktreeName, branch = worktreeName) {
      const worktreeDir = join(dirname(dir), `${name}-${worktreeName}`);
      await gitOut(["worktree", "add", "--quiet", "-b", branch, worktreeDir], { cwd: dir });
      return makeClone(name, worktreeDir);
    },
  };
  return clone;
}

async function takeSnapshot(dir: string): Promise<Snapshot> {
  const paths = await locateRepo(dir);
  if (!paths) throw new Error(`${dir} is not a git worktree`);
  // git.ts runs with GIT_OPTIONAL_LOCKS=0, so taking a snapshot does not itself refresh the index.
  const [refs, head, status] = await Promise.all([
    gitOut(["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: dir }),
    gitOut(["rev-parse", "--symbolic-full-name", "HEAD"], { cwd: dir }).then(async (name) => {
      const sha = await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir });
      return `${name} ${sha.stdout.trim()}`;
    }),
    gitOut(["status", "--porcelain", "--untracked-files=all"], { cwd: dir }),
  ]);
  return {
    refs,
    head,
    fetchHead: await hashFile(join(paths.gitDir, "FETCH_HEAD")),
    index: await hashFile(join(paths.gitDir, "index")),
    status,
    config: await hashFile(join(paths.commonDir, "config")),
  };
}

async function hashFile(file: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

function runHuddle(dir: string, args: string[], opts: HuddleOptions): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...TEST_ENV };
  for (const name of SCRUBBED) delete env[name];
  if (opts.now !== undefined) env.HUDDLE_NOW = typeof opts.now === "string" ? opts.now : opts.now.toISOString();
  if (opts.session !== undefined) env.HUDDLE_SESSION = opts.session;
  Object.assign(env, opts.env ?? {});

  return new Promise((resolve) => {
    const child = spawn(BUNDLE_NODE, [BUNDLE, ...args], {
      cwd: opts.cwd ? join(dir, opts.cwd) : dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      err.push(Buffer.from(`\n[harness] killed after ${opts.timeoutMs ?? 30_000} ms\n`));
      settle(-1);
    }, opts.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      err.push(Buffer.from(String(error)));
      settle(-1);
    });
    child.on("close", (code) => settle(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
  });
}
