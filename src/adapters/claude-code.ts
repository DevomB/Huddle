// T2.2. Claude Code hooks, installed into .claude/settings.json.
//
// Written against https://code.claude.com/docs/en/hooks as it read on
// 2026-11-12 and against payloads recorded from Claude Code 2.1.322, which are
// the fixtures in test/fixtures/hooks/claude-code. Before changing how a
// payload is read or an answer is encoded, read the docs again: the format
// moves, and some of what follows is not what one would guess.
//
//   Claude Code event   huddle event    registered with
//   SessionStart        session-start   timeout 10
//   UserPromptSubmit    prompt          timeout 5
//   PreToolUse          pre-edit        timeout 5, matcher: the file-editing tools
//   PostToolUse         post-edit       timeout 5, async, every tool
//   Stop                turn-end        timeout 5
//   SessionEnd          session-end     timeout 5
//
// PostToolUse has no matcher on purpose. It is the session's heartbeat: a
// session that only runs shell commands still shows as live, and a shell
// command can edit files too. It is async so that no tool call waits for it.

import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CliError } from "../core/io.ts";
import { SILENT } from "./types.ts";
import type { Adapter, CheckResult, HookEvent, HookEventType, HookInput, HookOutcome, HookOutput, InstallOptions, InstallResult } from "./types.ts";

const NAME = "claude-code";
const SETTINGS = ".claude/settings.json";
const LOCAL_SETTINGS = ".claude/settings.local.json";

interface Registration {
  /** Claude Code's name for the event. */
  event: string;
  type: HookEventType;
  /** Seconds. A safety net above the engine's own budget (plan.md §3), with room for node to start. */
  timeout: number;
  /** Tool-name matcher. Absent: every occurrence of the event. */
  matcher?: string;
  async?: boolean;
}

/**
 * Tools that edit the one file named in their input. MultiEdit is gone from
 * current releases and stays listed for teammates on older ones. Letters and
 * `|` only, so Claude Code reads the matcher as a list of exact names and not
 * as a regular expression.
 */
const EDIT_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const REGISTRATIONS: readonly Registration[] = [
  { event: "SessionStart", type: "session-start", timeout: 10 },
  { event: "UserPromptSubmit", type: "prompt", timeout: 5 },
  { event: "PreToolUse", type: "pre-edit", timeout: 5, matcher: EDIT_TOOLS.join("|") },
  { event: "PostToolUse", type: "post-edit", timeout: 5, async: true },
  { event: "Stop", type: "turn-end", timeout: 5 },
  // SessionEnd hooks share 1.5 s unless a hook asks for longer, and
  // session-end has to finish a sync: the timeout is what buys the time.
  { event: "SessionEnd", type: "session-end", timeout: 5 },
];

const TYPE_OF_EVENT = new Map<string, HookEventType>(REGISTRATIONS.map((registration) => [registration.event, registration.type]));
const EVENT_OF_TYPE = new Map<HookEventType, string>(REGISTRATIONS.map((registration) => [registration.type, registration.event]));

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// parse: a Claude Code payload on stdin -> a normalized event
// ---------------------------------------------------------------------------

/** What format() needs back from parse(). */
interface Native {
  event: string;
  /** CLAUDE_ENV_FILE, which Claude Code gives a SessionStart hook: lines appended to it run before every later shell command. */
  envFile?: string;
}

/**
 * A prompt nobody typed. UserPromptSubmit also fires when a background task
 * finishes, when a subagent reports back and when another session sends a
 * message, and each of those arrives wrapped in a tag of Claude Code's own:
 * <task-notification>, <agent-message from="...">, <cross-session-message
 * from="...">. They share one shape, a lower-case tag name with a hyphen in
 * it, and that is the test, so that a wrapper added later is caught as well.
 * The price: a typed prompt that opens with a custom-element tag records no
 * intent.
 */
const MACHINE_PROMPT = /^\s*<[a-z]+(?:-[a-z0-9]+)+[\s>]/;

/** Claude Code puts pasted text between two lines of this shape. The text in between is the user's. */
const PASTE_MARKER = /^<\/?pasted_content id="[^"]*">$/;

function typedPrompt(value: unknown): string {
  if (typeof value !== "string" || MACHINE_PROMPT.test(value)) return "";
  if (!value.includes("pasted_content")) return value.trim();
  return value
    .split("\n")
    .filter((line) => !PASTE_MARKER.test(line.trim()))
    .join("\n")
    .trim();
}

/** The file an editing tool is about to change, or has changed. Always absolute; backslashes on Windows. */
function editedPaths(payload: Json): string[] {
  if (!EDIT_TOOLS.includes(asText(payload.tool_name))) return [];
  const input = asRecord(payload.tool_input);
  if (input === null) return [];
  const path = asText(input.file_path) || asText(input.notebook_path);
  return path === "" ? [] : [path];
}

/** Claude Code lists at most this many. */
const MAX_CHANGED_FILES = 200;

/**
 * Files a shell command changed, which Claude Code reports after the fact in
 * tool_response.bashEditDiff.changedFiles when it recorded them. The field is
 * in beta and best effort, so every part of it is optional here.
 */
function shellChangedPaths(payload: Json): string[] {
  const changed = asRecord(asRecord(payload.tool_response)?.bashEditDiff)?.changedFiles;
  if (!Array.isArray(changed)) return [];
  return changed.filter((path): path is string => typeof path === "string" && path !== "").slice(0, MAX_CHANGED_FILES);
}

function parsePayload(input: HookInput): HookEvent | null {
  const payload = asRecord(JSON.parse(input.stdin));
  if (payload === null) return null;
  const nativeEvent = asText(payload.hook_event_name);
  const type = TYPE_OF_EVENT.get(nativeEvent);
  const sessionId = asText(payload.session_id).trim();
  if (type === undefined || sessionId === "") return null;

  const native: Native = { event: nativeEvent };
  const envFile = asText(input.env.CLAUDE_ENV_FILE);
  if (envFile !== "") native.envFile = envFile;

  const event: HookEvent = {
    type,
    agent: NAME,
    sessionId,
    // The payload's cwd follows the agent into a worktree or a subdirectory.
    // CLAUDE_PROJECT_DIR and the hook's own cwd do not.
    cwd: asText(payload.cwd) || input.cwd,
    native,
  };
  // Tool events inside a subagent carry the parent's session_id plus an
  // agent_id. agent_type alone does not mean a subagent: `claude --agent`
  // sets it for the whole session.
  if (asText(payload.agent_id) !== "") event.subagent = true;

  if (type === "session-start") {
    const source = asText(payload.source);
    if (source !== "") event.source = source;
  } else if (type === "session-end") {
    const reason = asText(payload.reason);
    if (reason !== "") event.reason = reason;
  } else if (type === "prompt") {
    const prompt = typedPrompt(payload.prompt);
    if (prompt !== "") event.prompt = prompt;
  } else if (type === "pre-edit") {
    const paths = editedPaths(payload);
    if (paths.length === 0) return null; // the matcher was widened by hand, or the tool names no file
    event.paths = paths;
  } else if (type === "post-edit") {
    const paths = [...editedPaths(payload), ...shellChangedPaths(payload)];
    if (paths.length > 0) event.paths = paths;
  }
  return event;
}

function parse(input: HookInput): HookEvent | null {
  try {
    return parsePayload(input);
  } catch {
    return null; // not JSON, or not a payload: nothing huddle can use
  }
}

// ---------------------------------------------------------------------------
// format: the engine's outcome -> what the hook process prints
// ---------------------------------------------------------------------------

/**
 * Claude Code replaces any hook context over 10,000 characters with a file
 * path and a 2,000-character preview. Briefings are far smaller; this is the
 * net under them.
 */
const MAX_CONTEXT_CHARS = 9000;
const CUT_NOTICE = '\n[huddle] Cut short to fit. Run "huddle status" for the rest.';

function clip(context: string): string {
  if (context.length <= MAX_CONTEXT_CHARS) return context;
  const room = MAX_CONTEXT_CHARS - CUT_NOTICE.length;
  const lineEnd = context.lastIndexOf("\n", room);
  let end = lineEnd > 0 ? lineEnd : room;
  const last = context.charCodeAt(end - 1);
  if (lineEnd <= 0 && last >= 0xd800 && last <= 0xdbff) end--; // do not split a surrogate pair
  return context.slice(0, end) + CUT_NOTICE;
}

// The env file is run by a shell. Nothing is quoted or escaped: a name or a
// value is written only if every character in it is inert in a shell
// (no space, quote, $, `, \, ;, &, |, <, >, (, ), *, ?, [, ~, #, ! or newline),
// and is dropped otherwise.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_VALUE = /^[A-Za-z0-9_@%+=:,./-]{1,256}$/;

function envLines(event: HookEvent, outcome: HookOutcome): Array<{ path: string; line: string }> {
  const file = asText(asRecord(event.native)?.envFile);
  if (file === "" || outcome.env === undefined) return [];
  const lines: Array<{ path: string; line: string }> = [];
  for (const [name, value] of Object.entries(outcome.env)) {
    if (typeof value !== "string" || !ENV_NAME.test(name) || !ENV_VALUE.test(value)) continue;
    lines.push({ path: file, line: `export ${name}=${value}` });
  }
  return lines;
}

function format(event: HookEvent, outcome: HookOutcome): HookOutput {
  // Never print on Stop: output there tells Claude Code to keep the agent
  // going. SessionEnd output is thrown away.
  if (event.type === "turn-end" || event.type === "session-end") return SILENT;
  const nativeEvent = EVENT_OF_TYPE.get(event.type);
  if (nativeEvent === undefined) return SILENT;

  const context = typeof outcome.context === "string" && outcome.context.trim() !== "" ? clip(outcome.context) : "";
  const appendLines = envLines(event, outcome);
  if (context === "" && appendLines.length === 0) return SILENT;

  const output: HookOutput = { stdout: "", stderr: "", exitCode: 0 };
  if (context !== "") {
    // One JSON object and nothing else on stdout. additionalContext is the
    // only channel that reaches the model on all of these events (plain
    // stdout on PreToolUse goes to the debug log), and it is advisory: there
    // is no permissionDecision, so huddle never allows or blocks a tool call.
    output.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: nativeEvent, additionalContext: context } });
  }
  if (appendLines.length > 0) output.appendLines = appendLines;
  return output;
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

const BOM = String.fromCodePoint(0xfeff);

/** The handler huddle registers for one event. Exec form: no shell, so no quoting, on any platform. */
function handlerFor(registration: Registration, script: string): Json {
  const handler: Json = { type: "command", command: "node", args: [script, "hook", NAME], timeout: registration.timeout };
  if (registration.async === true) handler.async = true;
  return handler;
}

function groupFor(registration: Registration, handler: Json): Json {
  return registration.matcher === undefined ? { hooks: [handler] } : { matcher: registration.matcher, hooks: [handler] };
}

/** `${CLAUDE_PROJECT_DIR}` is replaced by Claude Code with the project root, inside each element of `args`. */
function scriptFor(bundle: string): string {
  const relative = bundle
    .replace(/\\/g, "/")
    .replace(/^(?:\.?\/)+/, "");
  if (relative === "") throw new TypeError("claude-code: the bundle path is empty");
  return `\${CLAUDE_PROJECT_DIR}/${relative}`;
}

/**
 * Is this hook handler huddle's? Recognized by what it runs, not by where it
 * sits, so a handler written by an older huddle, moved by hand or pointing at
 * a bundle in another place is updated instead of doubled.
 */
function isHuddleHandler(value: unknown): boolean {
  const handler = asRecord(value);
  if (handler === null || handler.type !== "command") return false;
  if (Array.isArray(handler.args)) {
    const [script, verb, agent] = handler.args as unknown[];
    return typeof script === "string" && /(?:^|[\\/])huddle\.mjs$/.test(script) && verb === "hook" && agent === NAME;
  }
  return typeof handler.command === "string" && /huddle\.mjs["']?\s+hook\s+claude-code(?![\w-])/.test(handler.command);
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
function placeHandler(groups: unknown[], registration: Registration, wanted: Json): boolean {
  let placed = false;
  let changed = false;
  for (let g = 0; g < groups.length; g++) {
    const group = asRecord(groups[g]);
    const handlers = group !== null && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : null;
    if (group === null || handlers === null) continue; // not a shape this code knows: not ours to touch
    let removed = false;
    for (let h = 0; h < handlers.length; h++) {
      if (!isHuddleHandler(handlers[h])) continue;
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

function refuse(problem: string): never {
  throw new CliError(`${SETTINGS} ${problem}. huddle will not overwrite it: fix the file, then run huddle init again.`);
}

function parseSettings(text: string): Json {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    refuse(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return asRecord(parsed) ?? refuse("does not hold a JSON object");
}

/** Adds huddle's handlers to parsed settings, in place. Returns whether anything changed. */
function mergeHooks(settings: Json, script: string): boolean {
  let changed = false;
  if (settings.hooks === undefined) {
    settings.hooks = {};
    changed = true;
  }
  const hooks = asRecord(settings.hooks) ?? refuse('has a "hooks" entry that is not an object');
  for (const registration of REGISTRATIONS) {
    const wanted = handlerFor(registration, script);
    const groups = hooks[registration.event];
    if (groups === undefined) {
      hooks[registration.event] = [groupFor(registration, wanted)];
      changed = true;
    } else if (Array.isArray(groups)) {
      if (placeHandler(groups, registration, wanted)) changed = true;
    } else {
      refuse(`has a "hooks.${registration.event}" entry that is not a list`);
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

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** All or nothing: a reader, Claude Code included, never sees half a settings file. */
async function writeWhole(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  // Write through a symlink rather than replace it, and keep the file's mode.
  const target = await realpath(file).catch(() => file);
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

const TRUST_NOTE =
  "Claude Code runs a project's hooks only once its workspace trust dialog has been accepted for the folder. Each teammate is asked the first time they start claude in the repo.";

async function install(opts: InstallOptions): Promise<InstallResult> {
  const script = scriptFor(opts.bundle);
  const file = join(opts.repoRoot, SETTINGS);
  const before = await readText(file);
  const settings = before === null ? {} : parseSettings(before);
  const changed = mergeHooks(settings, script);
  if (!changed) return { changed: [], notes: [TRUST_NOTE] };
  await writeWhole(file, serialize(settings, before));
  return { changed: [SETTINGS], notes: [TRUST_NOTE] };
}

// ---------------------------------------------------------------------------
// check and detect
// ---------------------------------------------------------------------------

/** Where to look beyond the repo. Arguments so that tests need not touch the real home directory. */
export interface Surroundings {
  env: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
}

function here(): Surroundings {
  return { env: process.env, home: homedir(), platform: process.platform };
}

function userConfigDir(around: Surroundings): string {
  return asText(around.env.CLAUDE_CONFIG_DIR) || join(around.home, ".claude");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The parsed file, null when it is missing, or "invalid". */
async function readSettings(file: string): Promise<Json | null | "invalid"> {
  let text: string | null;
  try {
    text = await readText(file);
  } catch {
    return "invalid";
  }
  if (text === null) return null;
  try {
    return parseSettings(text);
  } catch {
    return "invalid";
  }
}

type Standing = "ok" | "differs" | "missing";

/** How one event's registration stands, plus the script its handler runs. */
function standingOf(hooks: Json | null, registration: Registration): { standing: Standing; script: string } {
  const groups = hooks === null ? undefined : hooks[registration.event];
  let found = 0;
  let exact = false;
  let script = "";
  for (const item of Array.isArray(groups) ? groups : []) {
    const group = asRecord(item);
    for (const handler of group !== null && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : []) {
      if (!isHuddleHandler(handler)) continue;
      found++;
      const args = asRecord(handler)?.args;
      const first = Array.isArray(args) ? asText(args[0]) : "";
      if (script === "") script = first;
      // "Exact" is what install() would write for the bundle this handler already points at.
      if (first.startsWith("${CLAUDE_PROJECT_DIR}/") && sameMatcher(group?.matcher, registration.matcher) && sameJson(handler, handlerFor(registration, first))) {
        exact = true;
      }
    }
  }
  return { standing: found === 0 ? "missing" : found === 1 && exact ? "ok" : "differs", script };
}

/** `disableAllHooks` after precedence: local over project over user. Managed settings are out of reach here. */
function hooksDisabledBy(layers: Array<{ name: string; settings: Json | null | "invalid" }>): string | null {
  for (const layer of layers) {
    if (layer.settings === null || layer.settings === "invalid") continue;
    if (typeof layer.settings.disableAllHooks === "boolean") return layer.settings.disableAllHooks ? layer.name : null;
  }
  return null;
}

/** check(), with the surroundings passed in. */
export async function checkClaudeCode(repoRoot: string, around: Surroundings): Promise<CheckResult> {
  const project = await readSettings(join(repoRoot, SETTINGS));
  if (project === null) return { installed: false, detail: `${SETTINGS} not found. Run huddle init.`, notes: [] };
  if (project === "invalid") {
    return { installed: false, detail: `${SETTINGS} cannot be read as a JSON object. Fix the file, then run huddle init.`, notes: [] };
  }

  const hooks = asRecord(project.hooks);
  const standings = REGISTRATIONS.map((registration) => ({ event: registration.event, ...standingOf(hooks, registration) }));
  const missing = standings.filter((item) => item.standing === "missing").map((item) => item.event);
  const differing = standings.filter((item) => item.standing === "differs").map((item) => item.event);
  if (missing.length === REGISTRATIONS.length) {
    return { installed: false, detail: `no huddle hooks in ${SETTINGS}. Run huddle init.`, notes: [] };
  }
  if (missing.length > 0 || differing.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing for ${missing.join(", ")}`);
    if (differing.length > 0) parts.push(`not what this version installs for ${differing.join(", ")}`);
    return { installed: false, detail: `huddle hooks in ${SETTINGS} are ${parts.join(" and ")}. Run huddle init.`, notes: [] };
  }

  // Every handler is "ok", so every script starts with the placeholder.
  for (const bundle of new Set(standings.map((item) => item.script.slice("${CLAUDE_PROJECT_DIR}/".length)))) {
    if (!(await exists(join(repoRoot, bundle)))) {
      return { installed: false, detail: `hooks in ${SETTINGS} run ${bundle}, which is not in this checkout. Run huddle init.`, notes: [] };
    }
  }

  const notes = [TRUST_NOTE];
  const disabledBy = hooksDisabledBy([
    { name: LOCAL_SETTINGS, settings: await readSettings(join(repoRoot, LOCAL_SETTINGS)) },
    { name: SETTINGS, settings: project },
    { name: join(userConfigDir(around), "settings.json"), settings: await readSettings(join(userConfigDir(around), "settings.json")) },
  ]);
  if (disabledBy !== null) {
    notes.unshift(`Hooks are turned off for Claude Code here: "disableAllHooks" is true in ${disabledBy}. huddle's hooks will not run until that is removed.`);
  }
  return { installed: true, detail: `${REGISTRATIONS.length} hooks in ${SETTINGS}`, notes };
}

async function onPath(names: string[], around: Surroundings): Promise<boolean> {
  const path = asText(around.env.PATH) || asText(around.env.Path);
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      if (await exists(join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * detect(), with the surroundings passed in. True on any sign that Claude
 * Code is used on this repo or by this user. It leans towards yes: the hook
 * config is committed for the whole team, and one unused settings file costs
 * less than a teammate whose agent stays invisible.
 */
export async function detectClaudeCode(repoRoot: string, around: Surroundings): Promise<boolean> {
  if ((await exists(join(repoRoot, ".claude"))) || (await exists(join(repoRoot, "CLAUDE.md")))) return true;
  if (asText(around.env.CLAUDECODE) !== "") return true; // set in every shell Claude Code starts
  if (await exists(userConfigDir(around))) return true;
  const names = around.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  return onPath(names, around);
}

export const claudeCode: Adapter = {
  name: NAME,
  title: "Claude Code",
  detect: (repoRoot) => detectClaudeCode(repoRoot, here()),
  install,
  check: (repoRoot) => checkClaudeCode(repoRoot, here()),
  parse,
  format,
};
