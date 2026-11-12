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

import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, asText, checkHooks, clip, contextOutput, exists, installHooks, onPath, readJsonObject } from "./json-hooks.ts";
import type { HookFile, Json, Registration } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, CheckResult, HookEvent, HookEventType, HookInput, HookOutcome, HookOutput, InstallOptions, InstallResult } from "./types.ts";

const NAME = "claude-code";
const SETTINGS = ".claude/settings.json";
const LOCAL_SETTINGS = ".claude/settings.local.json";

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

  const context = typeof outcome.context === "string" && outcome.context.trim() !== "" ? clip(outcome.context, MAX_CONTEXT_CHARS) : "";
  const appendLines = envLines(event, outcome);
  if (context === "" && appendLines.length === 0) return SILENT;

  const output: HookOutput = { stdout: "", stderr: "", exitCode: 0 };
  if (context !== "") {
    // One JSON object and nothing else on stdout. additionalContext is the
    // only channel that reaches the model on all of these events (plain
    // stdout on PreToolUse goes to the debug log), and it is advisory: there
    // is no permissionDecision, so huddle never allows or blocks a tool call.
    output.stdout = contextOutput(nativeEvent, context);
  }
  if (appendLines.length > 0) output.appendLines = appendLines;
  return output;
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

/** Claude Code replaces this with the project root, inside each element of `args`. */
const PROJECT_DIR = "${CLAUDE_PROJECT_DIR}/";

const SETTINGS_FILE: HookFile = {
  path: SETTINGS,
  registrations: REGISTRATIONS,
  /** Exec form: with `args` there is no shell, so nothing needs quoting, on any platform. */
  handlerFor(registration, bundle) {
    const handler: Json = { type: "command", command: "node", args: [PROJECT_DIR + bundle, "hook", NAME], timeout: registration.timeout };
    if (registration.async === true) handler.async = true;
    return handler;
  },
  isOurs(value) {
    const handler = asRecord(value);
    if (handler === null || handler.type !== "command") return false;
    if (Array.isArray(handler.args)) {
      const [script, verb, agent] = handler.args as unknown[];
      return typeof script === "string" && /(?:^|[\\/])huddle\.mjs$/.test(script) && verb === "hook" && agent === NAME;
    }
    // Shell form, as an older version or a hand edit might have left it.
    return typeof handler.command === "string" && /huddle\.mjs["']?\s+hook\s+claude-code(?![\w-])/.test(handler.command);
  },
  bundleOf(handler) {
    const script = Array.isArray(handler.args) ? asText(handler.args[0]) : "";
    return script.startsWith(PROJECT_DIR) ? script.slice(PROJECT_DIR.length) : null;
  },
};

const TRUST_NOTE =
  "Claude Code runs a project's hooks only once its workspace trust dialog has been accepted for the folder. Each teammate is asked the first time they start claude in the repo.";

async function install(opts: InstallOptions): Promise<InstallResult> {
  const changed = await installHooks(SETTINGS_FILE, opts.repoRoot, opts.bundle);
  return { changed: changed ? [SETTINGS] : [], notes: [TRUST_NOTE] };
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
  const { result, settings } = await checkHooks(SETTINGS_FILE, repoRoot);
  if (!result.installed) return result;
  const notes = [TRUST_NOTE];
  const userSettings = join(userConfigDir(around), "settings.json");
  const disabledBy = hooksDisabledBy([
    { name: LOCAL_SETTINGS, settings: await readJsonObject(join(repoRoot, LOCAL_SETTINGS)) },
    { name: SETTINGS, settings },
    { name: userSettings, settings: await readJsonObject(userSettings) },
  ]);
  if (disabledBy !== null) {
    notes.unshift(`Hooks are turned off for Claude Code here: "disableAllHooks" is true in ${disabledBy}. huddle's hooks will not run until that is removed.`);
  }
  return { ...result, notes };
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
  return onPath(names, around.env);
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
