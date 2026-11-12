// Shared by the adapters whose agent keeps its hooks in a JSON file of the shape
//
//   { "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ <handler>, ... ] } ] } }
//
// which is Claude Code's .claude/settings.json and Codex's .codex/hooks.json,
// or of the flat shape Cursor's .cursor/hooks.json has (HookFile.flat):
//
//   { "version": 1, "hooks": { "<event>": [ <handler>, ... ] } }
//
// What differs per agent is the list of events, the handler huddle writes and
// how to recognize that handler again. The adapter supplies those in a
// HookFile; merging, writing and checking the file are the same for all.

import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { CliError } from "../core/io.ts";
import type { CheckResult, HookEventType, InstallResult } from "./types.ts";

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
  /**
   * Seconds. A safety net above the engine's own budget (plan.md §3), with
   * room for node to start. Not a net everywhere: Claude Code does not enforce
   * it on an async hook.
   */
  timeout: number;
  /** Absent: every occurrence of the event. */
  matcher?: string;
  async?: boolean;
}

export interface HookFile {
  /** Repo-relative path of the file, forward slashes. Also its name in messages. */
  path: string;
  registrations: readonly Registration[];
  /**
   * Each item of an event's list is a handler itself and carries its own
   * matcher; there are no groups. handlerFor() then returns the whole item,
   * matcher included.
   */
  flat?: boolean;
  /** A top-level "version" the agent requires. Written when the file has none; a file with another version is refused. */
  version?: number;
  /** The agent's name as it stands in huddle's command, `hook <agent>`. */
  agent: string;
  /**
   * Keys a handler may spell out with the value the agent assumes anyway
   * (Cursor: "type": "command"). A handler that differs from huddle's only in
   * those is huddle's handler as it should be, and is not rewritten.
   */
  defaults?: Json;
  /** The handler huddle registers for an event, for a bundle at this repo-relative path. */
  handlerFor(registration: Registration, bundle: string): Json;
  /**
   * Is this handler huddle's? Only when the whole of what it runs is huddle's
   * hook command and nothing else (see plainCommand), wherever it sits and
   * whichever bundle it points at, so that one moved or edited by hand is
   * updated instead of doubled. A command of the user's that also runs
   * huddle's, or merely names it, is the user's: install replaces what is
   * huddle's, and must never replace anything else.
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

/**
 * A whole command line that is huddle's hook and nothing else, as a hand
 * might write it: `node <path>/huddle.mjs hook <agent>`, with at most one
 * more word (the event), the path in quotes or not. The file has to be named
 * exactly huddle.mjs. Anything before or after it (`fmt.sh && node ...`,
 * `node ...; notify.sh`, `echo "node ..."`) makes the line somebody else's.
 */
export function plainCommand(agent: string): RegExp {
  const bare = "(?:[^\\s\"'`;&|<>()$]*[\\\\/])?huddle\\.mjs";
  const path = `(?:"(?:[^"]*[\\\\/])?huddle\\.mjs"|'(?:[^']*[\\\\/])?huddle\\.mjs'|${bare})`;
  return new RegExp(`^\\s*(?:[^\\s"'\`;&|<>()$]*[\\\\/])?node(?:\\.exe)?\\s+${path}\\s+hook\\s+${agent}(?:\\s+[A-Za-z][\\w-]*)?\\s*$`);
}

/**
 * Text that names huddle's hook for `agent` anywhere in it: inside a longer
 * command of the user's, or in the raw text of a file that cannot be parsed
 * (where a command's quotes are escaped, and the exec form's words stand in
 * a list).
 */
export function mentionsHook(agent: string): RegExp {
  return new RegExp(`(?:^|[\\s"'\\\\/])huddle\\.mjs["'\\\\,\\s]+hook["'\\\\,\\s]+${agent}(?![\\w-])`);
}

/** What a handler runs, as one line: its command, and the words of the exec form after it. */
function commandText(handler: Json): string {
  const words = [handler.command, ...(Array.isArray(handler.args) ? (handler.args as unknown[]) : [])];
  return words.filter((word): word is string => typeof word === "string").join(" ");
}

/**
 * A handler of the user's that also runs huddle's hook, or names it. Only one
 * that runs a command: in every agent here that is `type` "command", or no
 * type at all. A prompt or http handler runs nothing, whatever its text says.
 */
function alsoNamesHook(file: HookFile, value: unknown): boolean {
  const handler = asRecord(value);
  if (handler === null || (handler.type !== undefined && handler.type !== "command")) return false;
  return !file.isOurs(handler) && mentionsHook(file.agent).test(commandText(handler));
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

/** The same handler, give or take a key that is spelled out with its default value. */
function sameHandler(file: HookFile, actual: unknown, wanted: Json): boolean {
  const handler = asRecord(actual);
  if (handler === null || file.defaults === undefined) return sameJson(actual, wanted);
  const plain: Json = { ...handler };
  for (const [key, value] of Object.entries(file.defaults)) {
    if (!Object.hasOwn(wanted, key) && sameJson(plain[key], value)) delete plain[key];
  }
  return sameJson(plain, wanted);
}

/** The handlers of one item of an event's list: the item itself in a flat file, the group's handlers otherwise. Null for a shape this code does not know. */
function handlersIn(file: HookFile, item: unknown): unknown[] | null {
  if (file.flat === true) return [item];
  const group = asRecord(item);
  return group !== null && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : null;
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
        if (!sameHandler(file, handlers[h], wanted)) {
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

/**
 * The same for a flat list, whose items are the handlers: exactly one huddle
 * handler, the wanted one, where the first of them stood.
 */
function placeFlat(file: HookFile, items: unknown[], wanted: Json): boolean {
  let placed = false;
  let changed = false;
  for (let i = 0; i < items.length; i++) {
    if (!file.isOurs(items[i])) continue;
    if (placed) {
      items.splice(i--, 1);
      changed = true;
      continue;
    }
    if (!sameHandler(file, items[i], wanted)) {
      items[i] = wanted;
      changed = true;
    }
    placed = true;
  }
  if (!placed) {
    items.push(wanted);
    changed = true;
  }
  return changed;
}

/**
 * Takes huddle's handlers out of the list of an event huddle does not
 * register: left by a hand edit, or by a version that still used the event.
 * There they are a process per event that answers nothing. Returns whether
 * anything was removed.
 */
function dropOurs(file: HookFile, items: unknown[]): boolean {
  let removed = false;
  for (let i = 0; i < items.length; i++) {
    if (file.flat === true) {
      if (!file.isOurs(items[i])) continue;
      items.splice(i--, 1);
      removed = true;
      continue;
    }
    const handlers = handlersIn(file, items[i]);
    if (handlers === null) continue;
    const kept = handlers.filter((handler) => !file.isOurs(handler));
    if (kept.length === handlers.length) continue;
    removed = true;
    if (kept.length === 0) items.splice(i--, 1);
    else handlers.splice(0, handlers.length, ...kept);
  }
  return removed;
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

/** What a top-level "version" has to be. */
export function isVersion(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Adds huddle's handlers to the parsed file, in place. Returns whether anything changed. */
function mergeHooks(file: HookFile, settings: Json, bundle: string): boolean {
  let changed = false;
  if (file.version !== undefined) {
    if (settings.version === undefined) {
      settings.version = file.version;
      changed = true;
    } else if (!isVersion(settings.version)) {
      refuse(file, 'has a "version" that is not a positive whole number');
    } else if (settings.version !== file.version) {
      // Another version may mean another shape. Entries of this one are not written into it.
      throw new CliError(`${file.path} has "version": ${String(settings.version)}. This huddle writes hooks for version ${file.version} of that file only, so it left the file alone.`);
    }
  }
  if (settings.hooks === undefined) {
    settings.hooks = {};
    changed = true;
  }
  const hooks = asRecord(settings.hooks) ?? refuse(file, 'has a "hooks" entry that is not an object');
  for (const registration of file.registrations) {
    const wanted = file.handlerFor(registration, bundle);
    const groups = hooks[registration.event];
    if (groups === undefined) {
      hooks[registration.event] = [file.flat === true ? wanted : groupFor(registration, wanted)];
      changed = true;
    } else if (Array.isArray(groups)) {
      if (file.flat === true ? placeFlat(file, groups, wanted) : placeHandler(file, groups, registration, wanted)) changed = true;
    } else {
      refuse(file, `has a "hooks.${registration.event}" entry that is not a list`);
    }
  }
  const registered = new Set(file.registrations.map((registration) => registration.event));
  for (const [event, items] of Object.entries(hooks)) {
    if (registered.has(event) || !Array.isArray(items) || !dropOurs(file, items)) continue;
    if (items.length === 0) delete hooks[event];
    changed = true;
  }
  return changed;
}

/** The events under which a handler of the user's also runs huddle's hook, or names it. */
function eventsNamingHook(file: HookFile, hooks: Json | null): string[] {
  const events: string[] = [];
  for (const [event, items] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(items)) continue;
    if (items.some((item) => (handlersIn(file, item) ?? []).some((handler) => alsoNamesHook(file, handler)))) events.push(event);
  }
  return events;
}

/**
 * For install and check to pass on: huddle left the user's command alone and
 * has its own handler next to it, so if that command really runs huddle's
 * hook, the hook runs twice on the event. Null when there is nothing to say.
 */
export function twiceNote(file: HookFile, events: string[]): string | null {
  if (events.length === 0) return null;
  return `In ${file.path}, a hook command of your own under ${events.join(", ")} also names huddle's hook. huddle left it as it is and has its own handler next to it. If yours runs huddle's hook, the hook now runs twice on that event: take it out of yours.`;
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

/** Why a file could not be read or written, in words where the error code has an everyday meaning. */
function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EISDIR") return "it is a directory";
  if (code === "ENOTDIR") return "a file stands where one of its directories should be";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EROFS") return "the file system is read-only";
  if (code === "ELOOP") return "its symbolic links lead in a circle";
  return code ?? (error instanceof Error ? error.message : String(error));
}

/** Thrown by realPlace() for a symbolic link whose target is not there. */
class Dangling extends Error {}

/**
 * Where a path really is, with every symbolic link on the way followed, also
 * when the file or some of its directories do not exist yet. Creates nothing.
 */
async function realPlace(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Not there: a link that leads nowhere, or simply missing.
  const link = await lstat(path).then(
    (found) => found.isSymbolicLink(),
    () => false,
  );
  if (link) throw new Dangling();
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await realPlace(parent), basename(path));
}

/**
 * The file install writes: the hooks file itself, or what it links to inside
 * the checkout. Throws CliError, in a sentence that is true for init and for
 * doctor alike, when the file or one of its directories is a symbolic link
 * that leads nowhere or out of the checkout. Out of the checkout is refused
 * because git stores the link and not the file, so teammates would get
 * nothing; and because the file out there may be one the user shares between
 * projects, where huddle's hooks would then run without a bundle to run.
 */
async function placeOf(file: HookFile, repoRoot: string): Promise<string> {
  let target: string;
  try {
    target = await realPlace(join(repoRoot, file.path));
  } catch (error) {
    if (!(error instanceof Dangling)) throw error;
    throw new CliError(`${file.path} is, or lies behind, a symbolic link to a place that does not exist. huddle does not write through it. Remove the link or create its target, then run huddle init.`);
  }
  const inside = relative(await realpath(repoRoot), target);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new CliError(
      `${file.path} is, through a symbolic link, a file outside this checkout (${target}). huddle does not write there: its hooks would not reach your teammates, and would run wherever else that file is used. Put a real file in its place, then run huddle init.`,
    );
  }
  return target;
}

/**
 * All or nothing: a reader, the agent included, never sees half a file.
 * `target` is from placeOf(), so a link is written through and not replaced;
 * the file keeps its mode. `shown` is the file's name in messages.
 */
async function writeWhole(target: string, text: string, shown: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const mode = await stat(target).then(
    (found) => found.mode & 0o777,
    () => null,
  );
  if (mode !== null) {
    // The rename below needs the directory only, and would replace a file its owner has made read-only.
    const writable = await access(target, constants.W_OK).then(
      () => true,
      (error: unknown) => !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""),
    );
    if (!writable) throw new CliError(`${shown} is read-only, so huddle left it alone. Make it writable, then run huddle init again.`);
  }
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
 * nothing changes. Throws CliError, with the file untouched, when the file
 * cannot be read or written or is not a JSON object this can merge into.
 * `changed`: whether the file changed. `twice`: the events under which a
 * command of the user's also names huddle's hook (see twiceNote).
 */
export async function installHooks(file: HookFile, repoRoot: string, bundle: string): Promise<{ changed: boolean; twice: string[] }> {
  const vendored = bundlePath(bundle);
  let target: string;
  let before: string | null;
  try {
    target = await placeOf(file, repoRoot);
    before = await readText(target);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${file.path} could not be read (${reason(error)}), so huddle left it alone.`);
  }
  const settings = before === null ? {} : parseFile(file, before);
  const changed = mergeHooks(file, settings, vendored);
  const twice = eventsNamingHook(file, asRecord(settings.hooks));
  if (!changed) return { changed, twice };
  try {
    await writeWhole(target, serialize(settings, before), file.path);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${file.path} could not be written (${reason(error)}).`);
  }
  return { changed, twice };
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

/** A file's text as a JSON object, or "invalid". An empty file is an empty object. */
function parseObject(text: string): Json | "invalid" {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body.trim() === "") return {};
  try {
    return asRecord(JSON.parse(body)) ?? "invalid";
  } catch {
    return "invalid";
  }
}

/** A JSON object from a file: the object, null when the file is missing, or "invalid". */
export async function readJsonObject(path: string): Promise<Json | null | "invalid"> {
  let text: string | null;
  try {
    text = await readText(path);
  } catch {
    return "invalid";
  }
  return text === null ? null : parseObject(text);
}

/** Does the file at `path` name huddle's hook for `agent` anywhere in its text? False when it cannot be read. */
export async function fileNamesHook(path: string, agent: string): Promise<boolean> {
  const text = await readText(path).catch(() => null);
  return text !== null && mentionsHook(agent).test(text);
}

type Standing = "ok" | "differs" | "missing";

/**
 * `broken`: the hooks are there and cannot work as they are, which doctor
 * warns about; an adapter that was never installed is only mentioned.
 * `files`: every file of the adapter that the team commits, changed by this
 * run or not, which init uses to say what is still to be committed and doctor
 * to say what is not committed yet. They are optional fields of the contract
 * that T2.3 adds to types.ts; until that is merged they are spelled out here.
 */
export type Check = CheckResult & { broken?: boolean; files?: string[] };
export type Installed = InstallResult & { files?: string[] };

/** How one event's registration stands, plus the bundle its handler runs. */
function standingOf(file: HookFile, hooks: Json | null, registration: Registration): { standing: Standing; bundle: string | null } {
  const groups = hooks === null ? undefined : hooks[registration.event];
  let found = 0;
  let exact = false;
  let bundle: string | null = null;
  for (const item of Array.isArray(groups) ? groups : []) {
    const group = asRecord(item);
    const candidates = file.flat === true ? [item] : group !== null && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : [];
    for (const candidate of candidates) {
      const handler = asRecord(candidate);
      if (handler === null || !file.isOurs(handler)) continue;
      found++;
      const runs = file.bundleOf(handler);
      if (bundle === null) bundle = runs;
      // A flat handler holds its matcher, so comparing the handler compares that too.
      const matcherFits = file.flat === true || sameMatcher(group?.matcher, registration.matcher);
      // "Exact" is what install would write for the bundle this handler already points at.
      if (runs !== null && matcherFits && sameHandler(file, handler, file.handlerFor(registration, runs))) exact = true;
    }
  }
  return { standing: found === 0 ? "missing" : found === 1 && exact ? "ok" : "differs", bundle };
}

/** A bundle path that stays inside the checkout: relative, and never up and out of it. */
function insideCheckout(bundle: string): boolean {
  return bundle !== "" && !bundle.startsWith("/") && !/^[A-Za-z]:/.test(bundle) && !bundle.split(/[\\/]/).includes("..");
}

/** The events huddle does not register under which one of its handlers stands all the same. */
function staleEvents(file: HookFile, hooks: Json | null): string[] {
  const registered = new Set(file.registrations.map((registration) => registration.event));
  const events: string[] = [];
  for (const [event, items] of Object.entries(hooks ?? {})) {
    if (registered.has(event) || !Array.isArray(items)) continue;
    if (items.some((item) => (handlersIn(file, item) ?? []).some((handler) => file.isOurs(handler)))) events.push(event);
  }
  return events;
}

export interface Checked {
  result: Check;
  /** The parsed file when it could be read, for checks that are the adapter's own. */
  settings: Json | null;
  /** The events under which a command of the user's also names huddle's hook (see twiceNote). */
  twice: string[];
}

/**
 * Is the file in the state install leaves it in, with the bundle it points at
 * present? `notes` is empty: the adapter knows which manual steps its agent
 * needs.
 *
 * `broken` is for hooks of huddle's that are there and cannot work. A file
 * that cannot be parsed is broken only when huddle's hook is named in it:
 * whether the agent itself can read such a file (comments, a trailing comma)
 * is the agent's business, and with no hook of huddle's in it, not huddle's.
 */
export async function checkHooks(file: HookFile, repoRoot: string): Promise<Checked> {
  const no = (detail: string, settings: Json | null, broken: boolean, twice: string[] = []): Checked => ({
    result: broken ? { installed: false, broken: true, detail, notes: [] } : { installed: false, detail, notes: [] },
    settings,
    twice,
  });
  let text: string | null;
  try {
    // Where init would write. A link that leads nowhere or out of the checkout is init's reason to refuse, and doctor's to say so.
    text = await readText(await placeOf(file, repoRoot));
  } catch (error) {
    if (error instanceof CliError) return no(error.message, null, false);
    return no(`${file.path} cannot be read (${reason(error)}).`, null, false);
  }
  if (text === null) return no(`${file.path} not found. Run huddle init.`, null, false);
  const settings = parseObject(text);
  if (settings === "invalid") {
    return mentionsHook(file.agent).test(text)
      ? no(`${file.path} cannot be read as a JSON object, and huddle's hooks are in it. Fix the file, then run huddle init.`, null, true)
      : no(`${file.path} cannot be read as a JSON object, so huddle cannot add its hooks to it. There are none in it now.`, null, false);
  }

  const hooks = asRecord(settings.hooks);
  const twice = eventsNamingHook(file, hooks);
  const standings = file.registrations.map((registration) => ({ event: registration.event, ...standingOf(file, hooks, registration) }));
  const missing = standings.filter((item) => item.standing === "missing").map((item) => item.event);
  const differing = standings.filter((item) => item.standing === "differs").map((item) => item.event);
  const stale = staleEvents(file, hooks);
  if (missing.length === file.registrations.length && stale.length === 0) return no(`no huddle hooks in ${file.path}. Run huddle init.`, settings, false, twice);
  if (missing.length > 0 || differing.length > 0 || stale.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing for ${missing.join(", ")}`);
    if (differing.length > 0) parts.push(`not what this version installs for ${differing.join(", ")}`);
    if (stale.length > 0) parts.push(`still there under ${stale.join(", ")}, which this version does not use`);
    return no(`huddle hooks in ${file.path} are ${parts.join(" and ")}. Run huddle init.`, settings, true, twice);
  }
  // Every handler is "ok", so every one names its bundle.
  for (const bundle of new Set(standings.map((item) => item.bundle ?? ""))) {
    if (!insideCheckout(bundle)) return no(`hooks in ${file.path} run ${bundle}, which is outside this checkout. Run huddle init.`, settings, true, twice);
    if (!(await exists(join(repoRoot, bundle)))) return no(`hooks in ${file.path} run ${bundle}, which is not in this checkout. Run huddle init.`, settings, true, twice);
  }
  return { result: { installed: true, detail: `${file.registrations.length} hooks in ${file.path}`, notes: [], files: [file.path] }, settings, twice };
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
