// T1.4. What a worktree is working on: its branch and its files in flight.

import { todo } from "./io.ts";
import type { RepoPaths } from "./paths.ts";
import type { Config } from "./types.ts";

/** The branch checked out in `worktree`; "(detached)" for a detached HEAD. */
export async function currentBranch(worktree: string): Promise<string> {
  void worktree;
  return todo("files.currentBranch");
}

/**
 * The base branch as a rev: <remote>/HEAD if set, else <remote>/main, else
 * <remote>/master, else config.base. Null when none of them exists.
 */
export async function resolveBase(worktree: string, config: Config): Promise<string | null> {
  void worktree;
  void config;
  return todo("files.resolveBase");
}

/**
 * Repo-relative paths, at most 200: dirty files (staged, unstaged, untracked
 * and not ignored) plus files changed since the merge-base with the base
 * branch. Reads only; never touches the index.
 */
export async function filesInFlight(worktree: string, config: Config): Promise<string[]> {
  void worktree;
  void config;
  return todo("files.filesInFlight");
}

/**
 * A path as an agent gives it (absolute, or relative to `cwd`; backslashes on
 * Windows) as a repo-relative path with forward slashes. Null when it is
 * outside the worktree.
 */
export function toRepoPath(paths: RepoPaths, cwd: string, path: string): string | null {
  void paths;
  void cwd;
  void path;
  return todo("files.toRepoPath");
}
