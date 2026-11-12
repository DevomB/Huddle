// T1.4. What a worktree is working on: its branch and its files in flight.
// Reads only. git.ts runs with optional locks off, so `git status` here does
// not refresh (rewrite) the index.

import { realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { cutFiles } from "./docs.ts";
import { git } from "./git.ts";
import type { RepoPaths } from "./paths.ts";
import type { Config, SessionPartial } from "./types.ts";

export const DETACHED = "(detached)";

/** The branch checked out in `worktree`; "(detached)" for a detached HEAD. */
export async function currentBranch(worktree: string): Promise<string> {
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: worktree });
  const branch = result.stdout.trim();
  return result.ok && branch ? branch : DETACHED;
}

/**
 * The base branch as a ref name, or null when none of the candidates exists.
 *
 * An explicit config.base wins (as <remote>/<base>, else a local branch of that
 * name). With "auto", or when the explicit one does not exist, it is
 * <remote>/HEAD if set, else <remote>/main, else <remote>/master.
 */
export async function resolveBase(worktree: string, config: Config): Promise<string | null> {
  const remote = `refs/remotes/${config.remote}`;
  const candidates: string[] = [];
  if (config.base !== "auto") candidates.push(`${remote}/${config.base}`, `refs/heads/${config.base}`);
  candidates.push(`${remote}/HEAD`, `${remote}/main`, `${remote}/master`);

  // One call for all candidates. for-each-ref takes patterns, and a full ref name matches itself.
  const result = await git(["for-each-ref", "--format=%(refname)", ...candidates], { cwd: worktree });
  if (!result.ok) return null;
  const existing = new Set(result.stdout.split("\n").filter(Boolean));
  return candidates.find((candidate) => existing.has(candidate)) ?? null;
}

/** What a worktree has in flight. */
export interface WorkInFlight {
  /** Every file in flight: dirty files first, then files changed in commits, each group sorted. Not capped. */
  all: string[];
  /** What a session records and publishes exactly: at most LIMITS.files of `all`, each one exact on the wire. */
  files: string[];
  /** Null when `files` is all of it; otherwise the count and the generated globs that cover the rest. */
  partial: SessionPartial | null;
}

/**
 * Repo-relative paths: dirty files (staged, unstaged, deleted, untracked and
 * not ignored) first, then files changed in commits since the merge-base with
 * the base branch (without a base: in commits not pushed to the remote, see
 * unpushedFiles). Each group is sorted, so the list is stable between calls.
 * On any git failure the affected group is simply missing.
 *
 * Nothing is dropped: past LIMITS.files, or for a path the wire cannot carry
 * exactly, `partial` holds coverage globs for the rest (see cutFiles).
 */
export async function workInFlight(worktree: string, config: Config): Promise<WorkInFlight> {
  const [dirty, committed] = await Promise.all([dirtyFiles(worktree), committedFiles(worktree, config)]);
  const all = new Set<string>();
  for (const group of [dirty, committed]) for (const file of [...group].sort()) all.add(file);
  const list = [...all];
  return { all: list, ...cutFiles(list) };
}

/** The exact part of workInFlight: at most LIMITS.files paths. What is cut is in workInFlight's `partial`. */
export async function filesInFlight(worktree: string, config: Config): Promise<string[]> {
  return (await workInFlight(worktree, config)).files;
}

async function dirtyFiles(worktree: string): Promise<string[]> {
  // -z: NUL-separated and never quoted. --no-renames: a rename shows as a
  // delete plus an add, so both names are reported and every entry is one path.
  const result = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: worktree });
  if (!result.ok) return [];
  const files: string[] = [];
  const entries = result.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // Should --no-renames ever be ignored: a rename or copy entry is followed by its source path.
    if (status.includes("R") || status.includes("C")) {
      const source = entries[++i];
      if (source) files.push(source);
    }
  }
  return files.filter((file) => file !== "" && !file.endsWith("/"));
}

async function committedFiles(worktree: string, config: Config): Promise<string[]> {
  const base = await resolveBase(worktree, config);
  if (base) {
    const mergeBase = await git(["merge-base", "HEAD", base], { cwd: worktree });
    const from = mergeBase.stdout.trim();
    if (mergeBase.ok && from) {
      const result = await git(["diff", "--name-only", "-z", "--no-renames", from, "HEAD"], { cwd: worktree });
      return result.ok ? result.stdout.split("\0").filter(Boolean) : [];
    }
  }
  return unpushedFiles(worktree, config);
}

/** Commits looked at when there is no base to compare with. */
const UNPUSHED_COMMITS = 500;

/**
 * For a worktree with no base to compare with: the trunk is not called main
 * or master and <remote>/HEAD is not set, `base` names a branch that does not
 * exist, or a shallow clone has no merge-base. Rather than report nothing, it
 * reports the files of the commits that are on no branch of the remote yet,
 * which is the work a teammate has no other way to see. Once the branch is
 * pushed these files leave the list; `huddle doctor` says so and how to set
 * `base`.
 */
async function unpushedFiles(worktree: string, config: Config): Promise<string[]> {
  // With nothing fetched from the remote, every commit in the history would count as unpushed.
  const tracking = await git(["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/${config.remote}/`], { cwd: worktree });
  if (!tracking.ok || tracking.stdout.trim() === "") return [];
  const result = await git(
    ["log", "--format=", "--name-only", "-z", "--no-renames", `--max-count=${UNPUSHED_COMMITS}`, "HEAD", "--not", `--remotes=${config.remote}`],
    { cwd: worktree },
  );
  if (!result.ok) return [];
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * A path as an agent or a user gives it (absolute, or relative to `cwd`) as a
 * repo-relative path with forward slashes. Null when it is the worktree root
 * itself or outside the worktree.
 */
export function toRepoPath(paths: RepoPaths, cwd: string, path: string): string | null {
  if (path === "" || path.length > MAX_PATH_CHARS) return null;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const inside = (candidate: string): string | null => {
    const rel = relative(paths.worktree, candidate);
    return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel.split(sep).join("/") : null;
  };
  if (process.platform === "win32") {
    // Windows file systems ignore case and git does not: an agent may name
    // src\Auth.ts as c:\repo\SRC\auth.ts, and the path must come out as git
    // reports it, or no teammate's src/Auth.ts would match. The native realpath
    // gives the case on disk (and long names for 8.3 short ones). A tail that
    // does not exist yet keeps the case it was given.
    return inside(resolveExisting(absolute, realpathSync.native)) ?? inside(absolute);
  }
  // The worktree path from git has symlinks resolved; the path we were given
  // may not (macOS /tmp, a symlinked checkout). Try it as given, and only then
  // resolved: resolving asks the file system, and this runs before every edit.
  return inside(absolute) ?? inside(resolveExisting(absolute));
}

/** No operating system takes a longer path (Windows: 32,767 characters; Linux 4,096 bytes). Anything longer is not a file. */
const MAX_PATH_CHARS = 32_767;

/**
 * Resolves symlinks in the longest existing prefix of `path` (absolute and
 * normalized); the rest, a file not created yet, is kept as is.
 *
 * A prefix that resolves has only resolving ones before it, so the longest is
 * found by halving: about 15 looks at the file system for the longest path
 * there is, and never one per missing directory. All of it is synchronous, and
 * a hook calls this with whatever an agent handed it and a deadline of 150 ms.
 */
export function resolveExisting(path: string, real: (prefix: string) => string = realpathSync): string {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  // ends[k] is where the prefix of k components ends in `path`.
  const ends = [root.length];
  for (const part of parts) ends.push((ends.at(-1) ?? 0) + (ends.length > 1 ? sep.length : 0) + part.length);
  const attempt = (count: number): string | null => {
    try {
      return real(count === 0 ? root : path.slice(0, ends[count]));
    } catch {
      return null;
    }
  };

  let resolved = attempt(parts.length);
  if (resolved !== null) return resolved;
  resolved = attempt(0);
  if (resolved === null) return path;
  // Prefix `low` resolves (to `resolved`) and prefix `high` does not.
  let low = 0;
  let high = parts.length;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    const found = attempt(middle);
    if (found === null) high = middle;
    else {
      low = middle;
      resolved = found;
    }
  }
  return resolve(resolved, parts.slice(low).join(sep));
}

/**
 * A claim glob as the user typed it, as a repo-relative pattern with forward
 * slashes. Relative patterns are taken from `cwd`, like paths; a leading "/"
 * means the repo root. Null when the pattern would reach outside the worktree.
 */
export function toRepoPattern(paths: RepoPaths, cwd: string, pattern: string): string | null {
  const typed = pattern.replace(/\\/g, "/").trim();
  if (typed === "") return null;
  let prefix = "";
  let rest = typed;
  if (typed.startsWith("/")) {
    rest = typed.replace(/^\/+/, "");
  } else {
    const here = relative(paths.worktree, resolve(cwd));
    if (isAbsolute(here) || here === ".." || here.startsWith(`..${sep}`)) return null;
    prefix = here.split(sep).join("/");
  }
  const segments: string[] = [];
  for (const segment of [...prefix.split("/"), ...rest.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? null : segments.join("/");
}
