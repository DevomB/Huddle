// Where huddle keeps things, and the config that is read from there.
//
// Local state lives in <git-common-dir>/huddle/, shared by every worktree of a
// clone and never committed. Team config is committed at .huddle/config.json.

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "./git.ts";
import { CliError } from "./io.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import type { Config } from "./types.ts";

export interface RepoPaths {
  /** Top level of the current worktree (absolute). */
  worktree: string;
  /** This worktree's git dir (absolute). */
  gitDir: string;
  /** The clone's common git dir (absolute); the same for all its worktrees. */
  commonDir: string;
  /** <commonDir>/huddle */
  stateDir: string;
  /** This clone's actor id. */
  actorFile: string;
  /** This clone's sessions; the source for its ActorDoc. */
  localFile: string;
  /** Last fetched team state. */
  cacheFile: string;
  /** One sync at a time. */
  syncLock: string;
  /** seen/<session>: what was last injected into that session. Use seenFile(). */
  seenDir: string;
  /** Debug log. Use log(). */
  logFile: string;
  /** Local config override. */
  localConfigFile: string;
  /** <worktree>/.huddle */
  teamDir: string;
  /** <worktree>/.huddle/config.json, committed. */
  teamConfigFile: string;
  /** <worktree>/.huddle/huddle.mjs, the vendored bundle. */
  bundleFile: string;
}

/** Resolves the repo that contains `cwd`. Null when `cwd` is not inside a git worktree (or git is missing). */
export async function locateRepo(cwd: string): Promise<RepoPaths | null> {
  const result = await git(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd });
  if (!result.ok) return null;
  const [top, gitDir, commonDir] = result.stdout.split(/\r?\n/);
  if (!top || !gitDir || !commonDir) return null;
  // --show-toplevel is absolute; the other two may be relative to cwd.
  return pathsFor(resolve(cwd, top), resolve(cwd, gitDir), resolve(cwd, commonDir));
}

/** locateRepo for commands: throws a CliError when there is no repo. */
export async function requireRepo(cwd: string): Promise<RepoPaths> {
  const paths = await locateRepo(cwd);
  if (!paths) throw new CliError("not inside a git repository");
  return paths;
}

export function pathsFor(worktree: string, gitDir: string, commonDir: string): RepoPaths {
  const stateDir = join(commonDir, "huddle");
  const teamDir = join(worktree, ".huddle");
  return {
    worktree,
    gitDir,
    commonDir,
    stateDir,
    actorFile: join(stateDir, "actor"),
    localFile: join(stateDir, "local.json"),
    cacheFile: join(stateDir, "cache.json"),
    syncLock: join(stateDir, "sync.lock"),
    seenDir: join(stateDir, "seen"),
    logFile: join(stateDir, "log"),
    localConfigFile: join(stateDir, "config.json"),
    teamDir,
    teamConfigFile: join(teamDir, "config.json"),
    bundleFile: join(teamDir, "huddle.mjs"),
  };
}

/** Creates <commonDir>/huddle and seen/ if needed. */
export async function ensureStateDir(paths: RepoPaths): Promise<void> {
  await mkdir(paths.seenDir, { recursive: true });
}

const PLAIN_SEEN_NAME = /^[a-z0-9_-]+$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * The seen-state file for a session. Session ids come from agents, so they are
 * reduced to a safe file name; a hash suffix keeps two ids that reduce to the
 * same name apart.
 *
 * Only an id that is already lower-case and safe is used as it is. Anything
 * with an upper-case letter gets the suffix too, because "Abc" and "abc" are
 * one file on a case-insensitive filesystem (macOS, Windows). A name Windows
 * reserves for a device ("con", "aux", "com1", ...) is prefixed as well.
 */
export function seenFile(paths: RepoPaths, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const device = WINDOWS_DEVICE_NAME.test(safe.toLowerCase());
  if (safe === sessionId && PLAIN_SEEN_NAME.test(safe) && !device) return join(paths.seenDir, safe);
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  // Windows treats "con.anything" as the device as well, so the name itself must change.
  return join(paths.seenDir, `${device ? "_" : ""}${safe || "session"}.${hash}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** A configured remote name. Never a URL, a path, or anything git could read as an option. */
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** "auto" or a branch-like name. No leading dash, no revision syntax. */
const BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const NUMBER_LIMITS = {
  syncIntervalSeconds: [1, 3600],
  heartbeatMinutes: [1, 1440],
  ttlMinutes: [1, 10080],
} as const;

/**
 * Merges config sources over the defaults, later sources winning. Team config
 * is written by teammates, so every value is validated and an invalid value
 * falls back to the previous one rather than failing.
 */
export function mergeConfig(...sources: unknown[]): Config {
  const config: Config = { ...DEFAULT_CONFIG };
  for (const source of sources) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
    const raw = source as Record<string, unknown>;
    if (typeof raw.remote === "string" && REMOTE_NAME_RE.test(raw.remote)) config.remote = raw.remote;
    if (typeof raw.base === "string" && BASE_RE.test(raw.base) && !raw.base.includes("..")) config.base = raw.base;
    for (const key of Object.keys(NUMBER_LIMITS) as (keyof typeof NUMBER_LIMITS)[]) {
      const value = raw[key];
      const [min, max] = NUMBER_LIMITS[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) config[key] = value;
    }
    if (raw.mode === "warn") config.mode = raw.mode;
    if (typeof raw.captureIntent === "boolean") config.captureIntent = raw.captureIntent;
  }
  return config;
}

/** Defaults, then .huddle/config.json, then the local override. Missing or unreadable files are skipped. */
export async function loadConfig(paths: RepoPaths): Promise<Config> {
  return mergeConfig(await readJsonLoose(paths.teamConfigFile), await readJsonLoose(paths.localConfigFile));
}

async function readJsonLoose(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}
