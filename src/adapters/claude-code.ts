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
//   PostToolUse         post-edit       timeout 5, async, every tool but Read, Grep and Glob
//   Stop                turn-end        timeout 5
//   SessionEnd          session-end     timeout 5
//
// PostToolUse is the session's heartbeat, not only a record of edits: a
// session that only runs shell commands still shows as live, and a shell
// command can edit files too. It leaves out the three tools that cannot
// change a file and that agents call in bursts, each of which would start a
// node process for nothing. It is async so that no tool call waits for it,
// and Claude Code does not enforce `timeout` on an async hook: for that one
// registration the only deadline is the engine's own.
//
// Two things about where Claude Code looks, both from its settings page:
// - It reads .claude/settings.json from the directory a session starts in,
//   not from the repository root. A session started in a subdirectory, or
//   moved with /cd, runs none of these hooks. install() and check() say so.
// - It reads .claude/settings.local.json from the repository root, and in a
//   linked worktree from the main checkout's root.

import { exec, execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { locateRepo } from "../core/paths.ts";
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

/**
 * Every tool except Read, Grep and Glob. A matcher with any character besides
 * letters, digits, "_", "-", spaces, "," and "|" is a JavaScript regular expression, tested
 * unanchored against the tool name, so this is a negative lookahead from the
 * start of the name. Checked on Claude Code 2.1.322: with it the hook ran for
 * Bash, Write and Edit and not for Read, Grep or Glob.
 */
const NOT_READ_ONLY = "^(?!(?:Read|Grep|Glob)$)";

const REGISTRATIONS: readonly Registration[] = [
  { event: "SessionStart", type: "session-start", timeout: 10 },
  { event: "UserPromptSubmit", type: "prompt", timeout: 5 },
  { event: "PreToolUse", type: "pre-edit", timeout: 5, matcher: EDIT_TOOLS.join("|") },
  { event: "PostToolUse", type: "post-edit", timeout: 5, async: true, matcher: NOT_READ_ONLY },
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

/**
 * A paste long enough to collapse in the prompt box ("[Pasted text #1 +12
 * lines]": over 800 characters or over three lines) arrives expanded, and in
 * sessions where Claude Code marks pasted text it sits between two lines of
 * their own:
 *
 *   <pasted_content id="k3j9">
 *   ...what was pasted...
 *   </pasted_content id="k3j9">
 *
 * The id is random and the same on both lines, so that pasted text cannot
 * close its own block.
 */
const PASTE_OPEN = /^<pasted_content(?: id="([^"]*)")?>$/;
const PASTE_CLOSE = /^<\/pasted_content(?: id="([^"]*)")?>$/;

/**
 * The part of a prompt that the user typed. The prompt becomes the intent
 * that is published to the team, and a paste is where secrets, logs and other
 * people's data come from, so a marked paste is dropped whole: its two marker
 * lines and everything between them. A block that is never closed by its own
 * id takes the rest of the prompt with it; losing typed text costs an intent,
 * keeping pasted text can publish a password.
 *
 * What this cannot do: a short paste, and any paste in a session that does
 * not mark them, carries no marker and reads exactly like typing.
 */
function typedPrompt(value: unknown): string {
  if (typeof value !== "string" || MACHINE_PROMPT.test(value)) return "";
  if (!value.includes("pasted_content")) return value.trim();
  const typed: string[] = [];
  let inPaste = false;
  let id: string | undefined;
  for (const line of value.split("\n")) {
    const text = line.trim();
    if (inPaste) {
      const close = PASTE_CLOSE.exec(text);
      if (close !== null && close[1] === id) inPaste = false;
      continue;
    }
    const open = PASTE_OPEN.exec(text);
    if (open !== null) {
      inPaste = true;
      id = open[1];
    } else if (!PASTE_CLOSE.test(text)) {
      typed.push(line); // a closing line with nothing open is Claude Code's too, and goes
    }
  }
  return typed.join("\n").trim();
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
    // The file has to be named exactly huddle.mjs: "not-huddle.mjs hook claude-code" is somebody else's.
    return typeof handler.command === "string" && /(?:^|[\s"'\\/])huddle\.mjs["']?\s+hook\s+claude-code(?![\w-])/.test(handler.command);
  },
  bundleOf(handler) {
    const script = Array.isArray(handler.args) ? asText(handler.args[0]) : "";
    return script.startsWith(PROJECT_DIR) ? script.slice(PROJECT_DIR.length) : null;
  },
};

/** What a teammate has to know for the hooks to run at all. init and doctor print these. */
const ROOT_NOTE =
  "Start claude at the root of the checkout. Claude Code reads .claude/settings.json from the directory a session starts in, so a session started in a subdirectory, or moved with /cd, runs none of huddle's hooks and stays invisible to the team.";
const NODE_NOTE =
  "Every teammate needs Node 20 or later on the PATH that Claude Code itself sees. If it cannot start node, Claude Code shows a hook error on every event. An app or IDE extension started outside a shell may not see a node installed by nvm, fnm or volta.";
const TRUST_NOTE =
  "In an interactive session Claude Code runs a project's hooks only once its workspace trust dialog has been accepted for the folder. Each teammate is asked the first time they start claude in the repo.";
const NOTES: readonly string[] = [ROOT_NOTE, NODE_NOTE, TRUST_NOTE];

async function install(opts: InstallOptions): Promise<InstallResult> {
  const changed = await installHooks(SETTINGS_FILE, opts.repoRoot, opts.bundle);
  return { changed: changed ? [SETTINGS] : [], notes: [...NOTES] };
}

// ---------------------------------------------------------------------------
// check and detect
// ---------------------------------------------------------------------------

/** Where to look beyond the repo. Arguments so that tests need not touch the real home directory. */
export interface Surroundings {
  env: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
  /** What `claude --version` prints, or null when it cannot be run. Left out: the version is not checked. */
  claudeVersion?: () => Promise<string | null>;
}

function here(): Surroundings {
  return { env: process.env, home: homedir(), platform: process.platform, claudeVersion: installedVersion };
}

/** Asks the claude on the PATH. On Windows it is a .cmd shim, which only a shell can start. */
function installedVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (error: Error | null, stdout: string): void => resolve(error === null ? stdout.trim() : null);
    const options = { timeout: 3000, windowsHide: true, encoding: "utf8" } as const;
    if (process.platform === "win32") exec("claude --version", options, done);
    else execFile("claude", ["--version"], options, done);
  });
}

/** Hooks with `args` (exec form) arrived in this release. An older one does not know the field and cannot run huddle's handlers. */
const FIRST_WITH_ARGS = [2, 1, 139] as const;

/** A note when the installed Claude Code is too old for the handlers, null when it is new enough or unknown. */
function tooOldNote(printed: string | null): string | null {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(printed ?? "");
  if (found === null) return null;
  for (let part = 0; part < FIRST_WITH_ARGS.length; part++) {
    const have = Number(found[part + 1]);
    const need = FIRST_WITH_ARGS[part] ?? 0;
    if (have > need) return null;
    if (have < need) {
      return `Claude Code ${found[0]} on this machine is older than ${FIRST_WITH_ARGS.join(".")}, the first release that can run the hooks huddle installs. Update Claude Code.`;
    }
  }
  return null;
}

/**
 * In a linked worktree, the root of the main checkout; otherwise null. Claude
 * Code keeps .claude/settings.local.json there, except on Windows, where the
 * file stays in the directory the session starts in.
 */
async function mainCheckout(repoRoot: string, around: Surroundings): Promise<string | null> {
  if (around.platform === "win32") return null;
  const paths = await locateRepo(repoRoot);
  if (paths === null || basename(paths.commonDir) !== ".git") return null; // not a repo, or one with no main checkout
  const [main, self] = await Promise.all([realpath(dirname(paths.commonDir)), realpath(repoRoot)]).catch(() => [null, null]);
  return main === null || main === self ? null : main;
}

function userConfigDir(around: Surroundings): string {
  return asText(around.env.CLAUDE_CONFIG_DIR) || join(around.home, ".claude");
}

/**
 * `disableAllHooks` after precedence: local over project over user. Two
 * higher layers are out of reach here: managed settings, and a --settings
 * flag on the command line.
 */
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
  const notes = [...NOTES];
  const userSettings = join(userConfigDir(around), "settings.json");
  // In a worktree the local file that counts is the main checkout's. A file
  // left in the worktree by a release before 2.1.211 is still read, below it.
  const main = await mainCheckout(repoRoot, around);
  const mainLocal = main === null ? null : join(main, LOCAL_SETTINGS);
  const disabledBy = hooksDisabledBy([
    ...(mainLocal === null ? [] : [{ name: mainLocal, settings: await readJsonObject(mainLocal) }]),
    { name: LOCAL_SETTINGS, settings: await readJsonObject(join(repoRoot, LOCAL_SETTINGS)) },
    { name: SETTINGS, settings },
    { name: userSettings, settings: await readJsonObject(userSettings) },
  ]);
  // What stops the hooks outright goes first.
  const tooOld = tooOldNote(around.claudeVersion === undefined ? null : await around.claudeVersion());
  if (tooOld !== null) notes.unshift(tooOld);
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
