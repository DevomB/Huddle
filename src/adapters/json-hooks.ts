// Shared by the adapters whose agent keeps its hooks in a JSON file of the shape
//
//   { "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ <handler>, ... ] } ] } }
//
// which is Claude Code's .claude/settings.json and Codex's .codex/hooks.json.
// What differs per agent is the list of events, the handler huddle writes and
// how to recognize that handler again. The adapter supplies those in a
// HookFile; merging, writing and checking the file are the same for all.

import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { CliError } from "../core/io.ts";
import type { CheckResult, HookEventType } from "./types.ts";

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One of the agent's events that huddle registers a handler for. */
export interface Registration {
  /** The agent's name for the event. */
  event: string;
  type: HookEventType;
  /** Seconds. A safety net above the engine's own budget (plan.md §3), with room for node to start. */
  timeout: number;
  /** Absent: every occurrence of the event. */
  matcher?: string;
  async?: boolean;
}

export interface HookFile {
  /** Repo-relative path of the file, forward slashes. Also its name in messages. */
  path: string;
  registrations: readonly Registration[];
  /** The handler huddle registers for an event, for a bundle at this repo-relative path. */
  handlerFor(registration: Registration, bundle: string): Json;
  /**
   * Is this handler huddle's? Decided by what the handler runs, not by where
   * it sits, so one written by an older huddle, moved by hand or pointing at a
   * bundle in another place is updated instead of doubled.
   */
  isOurs(handler: unknown): boolean;
  /** The repo-relative bundle one of huddle's handlers runs, or null when it is not in the form huddle writes. */
  bundleOf(handler: Json): string | null;
}

/** InstallOptions.bundle in one spelling: forward slashes, no leading "./" or "/". */
export function bundlePath(bundle: string): string {
  const relative = bundle.replace(/\\/g, "/").replace(/^(?:\.?\/)+/, "");
  if (relative === "") throw new TypeError("the bundle path is empty");
  return relative;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function groupFor(registration: Registration, handler: Json): Json {
  return registration.matcher === undefined ? { hooks: [handler] } : { matcher: registration.matcher, hooks: [handler] };
}

/** Order of keys does not matter; order of array items does. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  const left = asRecord(a);
  const right = asRecord(b);
  if (left === null || right === null) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** An absent matcher, "" and "*" all mean every occurrence. */
function sameMatcher(actual: unknown, wanted: string | undefined): boolean {
  if (wanted === undefined) return actual === undefined || actual === "" || actual === "*";
  return actual === wanted;
}

/**
 * Makes `groups` (the matcher groups of one event) hold exactly one huddle
 * handler, the wanted one, under the wanted matcher. Everything that is not
 * huddle's is left exactly as it is. Returns whether anything changed.
 */
function placeHandler(file: HookFile, groups: unknown[], registration: Registration, wanted: Json): boolean {
  let placed = false;
  let changed = false;
  for (let g = 0; g < groups.length; g++) {
    const group = asRecord(groups[g]);
    const handlers = group !== null && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : null;
    if (group === null || handlers === null) continue; // not a shape this code knows: not ours to touch
    let removed = false;
    for (let h = 0; h < handlers.length; h++) {
      if (!file.isOurs(handlers[h])) continue;
      const matcherFits = sameMatcher(group.matcher, registration.matcher);
      if (!placed && (matcherFits || handlers.length === 1)) {
        if (!matcherFits) {
          // The group is huddle's alone, so its matcher is huddle's to correct.
          if (registration.matcher === undefined) delete group.matcher;
          else group.matcher = registration.matcher;
          changed = true;
        }
        if (!sameJson(handlers[h], wanted)) {
          handlers[h] = wanted;
          changed = true;
        }
        placed = true;
      } else {
        // A second copy, or a copy sharing a group whose matcher is someone else's.
        handlers.splice(h--, 1);
        removed = true;
        changed = true;
      }
    }
    if (removed && handlers.length === 0) groups.splice(g--, 1);
  }
  if (!placed) {
    groups.push(groupFor(registration, wanted));
    changed = true;
  }
  return changed;
}

function refuse(file: HookFile, problem: string): never {
  throw new CliError(`${file.path} ${problem}. huddle will not overwrite it: fix the file, then run huddle init again.`);
}

const BOM = String.fromCodePoint(0xfeff);

function parseFile(file: HookFile, text: string): Json {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    refuse(file, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return asRecord(parsed) ?? refuse(file, "does not hold a JSON object");
}

/** Adds huddle's handlers to the parsed file, in place. Returns whether anything changed. */
function mergeHooks(file: HookFile, settings: Json, bundle: string): boolean {
  let changed = false;
  if (settings.hooks === undefined) {
    settings.hooks = {};
    changed = true;
  }
  const hooks = asRecord(settings.hooks) ?? refuse(file, 'has a "hooks" entry that is not an object');
  for (const registration of file.registrations) {
    const wanted = file.handlerFor(registration, bundle);
    const groups = hooks[registration.event];
    if (groups === undefined) {
      hooks[registration.event] = [groupFor(registration, wanted)];
      changed = true;
    } else if (Array.isArray(groups)) {
      if (placeHandler(file, groups, registration, wanted)) changed = true;
    } else {
      refuse(file, `has a "hooks.${registration.event}" entry that is not a list`);
    }
  }
  return changed;
}

/** Writes the settings the way the file was already written: its indentation, line endings, final newline and BOM. */
function serialize(settings: Json, before: string | null): string {
  const old = before ?? "";
  const indent = /^([ \t]{1,10})"/m.exec(old)?.[1] ?? "  ";
  let text = JSON.stringify(settings, null, indent);
  if (old.trim() === "" || old.endsWith("\n")) text += "\n";
  if (old.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
  return old.startsWith(BOM) ? BOM + text : text;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** All or nothing: a reader, the agent included, never sees half a file. */
async function writeWhole(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write through a symlink rather than replace it, and keep the file's mode.
  const target = await realpath(path).catch(() => path);
  const mode = await stat(target).then(
    (found) => found.mode & 0o777,
    () => null,
  );
  const temporary = `${target}.huddle-${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, "utf8");
    if (mode !== null) await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Merges huddle's handlers into the file, creating it if need be. Leaves
 * everything that is not huddle's in place, and does not write at all when
 * nothing changes. Throws CliError, with the file untouched, when the file is
 * not a JSON object this can merge into. Returns whether the file changed.
 */
export async function installHooks(file: HookFile, repoRoot: string, bundle: string): Promise<boolean> {
  const relative = bundlePath(bundle);
  const path = join(repoRoot, file.path);
  const before = await readText(path);
  const settings = before === null ? {} : parseFile(file, before);
  if (!mergeHooks(file, settings, relative)) return false;
  await writeWhole(path, serialize(settings, before));
  return true;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** A JSON object from a file: the object, null when the file is missing, or "invalid". */
export async function readJsonObject(path: string): Promise<Json | null | "invalid"> {
  let text: string | null;
  try {
    text = await readText(path);
  } catch {
    return "invalid";
  }
  if (text === null) return null;
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body.trim() === "") return {};
  try {
    return asRecord(JSON.parse(body)) ?? "invalid";
  } catch {
    return "invalid";
  }
}

type Standing = "ok" | "differs" | "missing";

/** How one event's registration stands, plus the bundle its handler runs. */
function standingOf(file: HookFile, hooks: Json | null, registration: Registration): { standing: Standing; bundle: string | null } {
  const groups = hooks === null ? undefined : hooks[registration.event];
  let found = 0;
  let exact = false;
  let bundle: string | null = null;
  for (const item of Array.isArray(groups) ? groups : []) {
    const group = asRecord(item);
    for (const candidate of group !== null && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : []) {
      const handler = asRecord(candidate);
      if (handler === null || !file.isOurs(handler)) continue;
      found++;
      const runs = file.bundleOf(handler);
      if (bundle === null) bundle = runs;
      // "Exact" is what install would write for the bundle this handler already points at.
      if (runs !== null && sameMatcher(group?.matcher, registration.matcher) && sameJson(handler, file.handlerFor(registration, runs))) exact = true;
    }
  }
  return { standing: found === 0 ? "missing" : found === 1 && exact ? "ok" : "differs", bundle };
}

/**
 * Is the file in the state install leaves it in, with the bundle it points at
 * present? `settings` is the parsed file when it could be read, for checks
 * that are the adapter's own. `notes` is empty: the adapter knows which manual
 * steps its agent needs.
 */
export async function checkHooks(file: HookFile, repoRoot: string): Promise<{ result: CheckResult; settings: Json | null }> {
  const no = (detail: string, settings: Json | null = null) => ({ result: { installed: false, detail, notes: [] }, settings });
  const settings = await readJsonObject(join(repoRoot, file.path));
  if (settings === null) return no(`${file.path} not found. Run huddle init.`);
  if (settings === "invalid") return no(`${file.path} cannot be read as a JSON object. Fix the file, then run huddle init.`);

  const hooks = asRecord(settings.hooks);
  const standings = file.registrations.map((registration) => ({ event: registration.event, ...standingOf(file, hooks, registration) }));
  const missing = standings.filter((item) => item.standing === "missing").map((item) => item.event);
  const differing = standings.filter((item) => item.standing === "differs").map((item) => item.event);
  if (missing.length === file.registrations.length) return no(`no huddle hooks in ${file.path}. Run huddle init.`, settings);
  if (missing.length > 0 || differing.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing for ${missing.join(", ")}`);
    if (differing.length > 0) parts.push(`not what this version installs for ${differing.join(", ")}`);
    return no(`huddle hooks in ${file.path} are ${parts.join(" and ")}. Run huddle init.`, settings);
  }
  // Every handler is "ok", so every one names its bundle.
  for (const bundle of new Set(standings.map((item) => item.bundle ?? ""))) {
    if (!(await exists(join(repoRoot, bundle)))) return no(`hooks in ${file.path} run ${bundle}, which is not in this checkout. Run huddle init.`, settings);
  }
  return { result: { installed: true, detail: `${file.registrations.length} hooks in ${file.path}`, notes: [] }, settings };
}

/** Is a program with one of these file names in a directory on PATH? Looks, does not run anything. */
export async function onPath(names: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = asText(env.PATH) || asText(env.Path);
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      if (await exists(join(dir, name))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const CUT_NOTICE = '\n[huddle] Cut short to fit. Run "huddle status" for the rest.';

/** At most `max` characters, cut at the end of a line where there is one, with a pointer to the rest. */
export function clip(context: string, max: number): string {
  if (context.length <= max) return context;
  const room = max - CUT_NOTICE.length;
  const lineEnd = context.lastIndexOf("\n", room);
  let end = lineEnd > 0 ? lineEnd : room;
  const last = context.charCodeAt(end - 1);
  if (lineEnd <= 0 && last >= 0xd800 && last <= 0xdbff) end--; // do not split a surrogate pair
  return context.slice(0, end) + CUT_NOTICE;
}

/**
 * The one JSON object both agents read context from: advisory text for the
 * model under the event's own name, and no decision of any kind.
 */
export function contextOutput(nativeEvent: string, context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: nativeEvent, additionalContext: context } });
}
