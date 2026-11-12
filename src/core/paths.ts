// Where huddle keeps things, and the config that is read from there.
//
// Local state lives in <git-common-dir>/huddle/, shared by every worktree of a
// clone and never committed. Team config is committed at .huddle/config.json.

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "./git.ts";
import { CliError } from "./io.ts";
import { log } from "./log.ts";
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

/** `huddle init` was run in this checkout (or someone made the directory by hand to opt it in). */
export async function isSetUp(paths: RepoPaths): Promise<boolean> {
  try {
    return (await stat(paths.teamDir)).isDirectory();
  } catch {
    return false;
  }
}

/** The same directory, also when one of the two was reached through a symlink. False when either is gone. */
export async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/**
 * The checkouts of this clone as git lists them, the main one first. Git is
 * asked in the common git directory, so this also answers when the worktree a
 * process was started in has been removed since. A checkout whose directory is
 * gone, or is not a checkout of this clone any more, is left out. Empty when
 * git cannot say.
 */
export async function listCheckouts(paths: RepoPaths): Promise<RepoPaths[]> {
  const result = await git(["worktree", "list", "--porcelain"], { cwd: paths.commonDir });
  if (!result.ok) return [];
  const found: RepoPaths[] = [];
  for (const block of result.stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const dir = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    // A bare repository's own entry is not a checkout. A quoted path has a newline or the like in it, and is passed over.
    if (!dir || dir.startsWith('"') || lines.includes("bare")) continue;
    const checkout = await locateRepo(dir);
    if (checkout !== null && (await sameDirectory(checkout.commonDir, paths.commonDir))) found.push(checkout);
  }
  return found;
}

/**
 * The checkout whose settings a command run in `paths` goes by.
 *
 * That is `paths` when it is set up. A worktree on a branch from before
 * `huddle init` has no .huddle, and the defaults are not the team's: with them,
 * a team that syncs with another remote than origin would have its sessions
 * pushed to origin. Such a worktree goes by a set-up checkout of the same
 * clone, the main one first. (A hook goes by the checkout its agent was started
 * in: hooks/engine.ts.) When no checkout of the clone is set up, it is `paths`
 * again: in a repository nobody ran init in, huddle works on the defaults.
 */
export async function settingsHome(paths: RepoPaths): Promise<RepoPaths> {
  if (await isSetUp(paths)) return paths;
  for (const checkout of await listCheckouts(paths)) {
    if (await isSetUp(checkout)) return checkout;
  }
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
 *
 * `captureIntent` is the exception: it decides whether prompt text is
 * published, so a value that is present but is not `true` turns capture off.
 *
 * The three intervals are also checked against each other afterwards (see
 * reconcile).
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
    if (Object.hasOwn(raw, "captureIntent")) config.captureIntent = raw.captureIntent === true;
  }
  return reconcile(config);
}

/**
 * Each interval can be valid alone and still break the others. A session is
 * kept alive by heartbeats, so the TTL has to span at least two of them, or an
 * idle session expires and reappears in every teammate's briefing. And a sync
 * interval longer than the heartbeat would mean the heartbeat never fires on
 * time. The TTL is raised and the sync interval lowered, because those are the
 * directions that cost nothing: neither makes huddle talk to the remote more.
 */
function reconcile(config: Config): Config {
  config.ttlMinutes = Math.max(config.ttlMinutes, 2 * config.heartbeatMinutes);
  config.syncIntervalSeconds = Math.min(config.syncIntervalSeconds, config.heartbeatMinutes * 60);
  return config;
}

export interface ConfigReport {
  config: Config;
  /** Config files that exist but could not be used, one line each. Empty when all is well. */
  problems: string[];
}

/**
 * Defaults, then .huddle/config.json, then the local override. A missing file
 * is skipped.
 *
 * A file that exists but does not hold a JSON object is skipped too, with a
 * line in `problems`. For the team file that also turns prompt capture off:
 * the usual cause is a merge conflict in .huddle/config.json, and a team that
 * had switched capture off must not start publishing prompts because of one.
 * The local override can still turn it back on.
 */
export async function loadConfigReport(paths: RepoPaths): Promise<ConfigReport> {
  const problems: string[] = [];
  const read = async (file: string, label: string): Promise<unknown> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      problems.push(`${label} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
      return null;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
      problems.push(`${label} is not a JSON object`);
    } catch {
      problems.push(`${label} is not valid JSON${/^(<<<<<<<|=======|>>>>>>>)/m.test(text) ? " (it has merge conflict markers)" : ""}`);
    }
    return null;
  };
  const team = await read(paths.teamConfigFile, ".huddle/config.json");
  if (team === null) problems.push("the team's settings are ignored and prompt capture is off until .huddle/config.json is fixed");
  const local = await read(paths.localConfigFile, "the local override (huddle/config.json in the git directory)");
  const config = mergeConfig(team === null ? { captureIntent: false } : team, local);
  return { config, problems };
}

/** The config alone. Problems go to the debug log; `huddle doctor` shows them. */
export async function loadConfig(paths: RepoPaths): Promise<Config> {
  const { config, problems } = await loadConfigReport(paths);
  for (const problem of problems) log(paths, "config", problem);
  return config;
}
