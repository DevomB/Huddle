// T3.1. Codex hooks, installed into <repo>/.codex/hooks.json.
//
// Written against https://developers.openai.com/codex/hooks as it read on
// 2026-11-12 (the address now redirects to https://learn.chatgpt.com/docs/hooks,
// same text), and against Codex's own source at the release current then
// (tag rust-v0.167.0): the generated wire schemas in codex-rs/hooks/schema,
// the command runner in codex-rs/hooks/src/engine, and the hook tests in
// codex-rs/core/tests/suite/hooks.rs. Read the docs again before changing how
// a payload is read or an answer is encoded.
//
//   Codex event        huddle event    registered with
//   SessionStart       session-start   timeout 10
//   UserPromptSubmit   prompt          timeout 5
//   PreToolUse         pre-edit        timeout 5, matcher ^apply_patch$
//   PostToolUse        post-edit       timeout 5, async, every tool
//   Stop               turn-end        timeout 5
//   SessionEnd         session-end     timeout 3
//
// PostToolUse has no matcher on purpose: it is the session's heartbeat, and it
// is async so that no tool call waits for it.
//
// Where Codex differs from Claude Code, and it matters here:
// - Every file edit is one tool, apply_patch, and the files are named inside
//   the patch text, relative to the payload's cwd as a rule.
// - A handler is a command line for a shell: the user's login shell on macOS
//   and Linux, cmd.exe on Windows. There is no exec form. Since it is a shell
//   command anyway, it starts with checks that node and the bundle exist.
// - SessionEnd hooks get three seconds at most.
// - There is no way for a hook to set a variable in the agent's shell, so
//   HUDDLE_SESSION is not passed on.
// - Project hooks run only in a trusted project, and only once each hook has
//   been reviewed in /hooks. A changed hook definition has to be reviewed again.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, asText, checkHooks, clip, contextOutput, exists, installHooks, onPath, plainCommand, twiceNote } from "./json-hooks.ts";
import type { Check, HookFile, Installed, Json, Registration } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, HookEvent, HookEventType, HookInput, HookOutcome, HookOutput, InstallOptions } from "./types.ts";

const NAME = "codex";
const HOOKS = ".codex/hooks.json";
const PROJECT_CONFIG = ".codex/config.toml";

const REGISTRATIONS: readonly Registration[] = [
  { event: "SessionStart", type: "session-start", timeout: 10 },
  { event: "UserPromptSubmit", type: "prompt", timeout: 5 },
  // The matcher is a regular expression on the tool name. Codex also lets
  // "Edit" and "Write" stand for apply_patch; the name itself is enough.
  { event: "PreToolUse", type: "pre-edit", timeout: 5, matcher: "^apply_patch$" },
  { event: "PostToolUse", type: "post-edit", timeout: 5, async: true },
  { event: "Stop", type: "turn-end", timeout: 5 },
  // Codex gives SessionEnd hooks one second, and three at most whatever the
  // file says. That is less than the engine's budget for session-end.
  { event: "SessionEnd", type: "session-end", timeout: 3 },
];

const TYPE_OF_EVENT = new Map<string, HookEventType>(REGISTRATIONS.map((registration) => [registration.event, registration.type]));
const EVENT_OF_TYPE = new Map<HookEventType, string>(REGISTRATIONS.map((registration) => [registration.type, registration.event]));

// ---------------------------------------------------------------------------
// parse: a Codex payload on stdin -> a normalized event
// ---------------------------------------------------------------------------

/** More files than this in one patch is not a patch anyone reviews; the rest are found by git afterwards. */
const MAX_PATCH_FILES = 200;

/**
 * The lines of an apply_patch patch that name a file:
 *
 *   *** Add File: <path>      *** Update File: <path>
 *   *** Delete File: <path>   *** Move to: <path>
 *
 * Only at the start of a line. Codex's parser also accepts padding in front
 * of a marker, but a line of file content always starts with "+", "-" or a
 * space, so a padded "marker" can equally be content that quotes one.
 */
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/** The files a patch touches, as written in it: relative to the payload's cwd, or absolute. */
function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("*** ")) continue;
    const path = PATCH_FILE.exec(line.trimEnd())?.[1]?.trim();
    if (path === undefined || path === "" || paths.includes(path)) continue;
    paths.push(path);
    if (paths.length === MAX_PATCH_FILES) break;
  }
  return paths;
}

/** For apply_patch, tool_input.command is the patch itself. Other tools name no files huddle can read. */
function editedPaths(payload: Json): string[] {
  if (payload.tool_name !== "apply_patch") return [];
  return patchPaths(asText(asRecord(payload.tool_input)?.command));
}

function parsePayload(input: HookInput): HookEvent | null {
  const payload = asRecord(JSON.parse(input.stdin));
  if (payload === null) return null;
  const nativeEvent = asText(payload.hook_event_name);
  const type = TYPE_OF_EVENT.get(nativeEvent);
  const sessionId = asText(payload.session_id).trim();
  if (type === undefined || sessionId === "") return null;

  const event: HookEvent = {
    type,
    agent: NAME,
    sessionId,
    // On tool events this is where the command runs, which can be a
    // subdirectory. The hook process itself always starts in the session's cwd.
    cwd: asText(payload.cwd) || input.cwd,
    native: { event: nativeEvent },
  };
  // A subagent's hooks carry the parent's session_id, plus agent_id.
  if (asText(payload.agent_id) !== "") event.subagent = true;

  if (type === "session-start") {
    const source = asText(payload.source);
    if (source !== "") event.source = source;
  } else if (type === "session-end") {
    const reason = asText(payload.reason);
    if (reason !== "") event.reason = reason;
  } else if (type === "prompt") {
    // A prompt inside a subagent is the parent agent delegating, not the user
    // saying what they want, so it is no intent.
    const prompt = event.subagent === true ? "" : asText(payload.prompt).trim();
    if (prompt !== "") event.prompt = prompt;
  } else if (type === "pre-edit") {
    const paths = editedPaths(payload);
    if (paths.length === 0) return null; // the matcher was widened by hand, or the patch names no file
    event.paths = paths;
  } else if (type === "post-edit") {
    const paths = editedPaths(payload);
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
 * Codex moves hook output over about 2,500 tokens (it counts four bytes to a
 * token) into a file and shows the model a preview. Briefings are smaller;
 * this is the net under them, with room for text that is not ASCII.
 */
const MAX_CONTEXT_CHARS = 6000;

function format(event: HookEvent, outcome: HookOutcome): HookOutput {
  // Stop takes JSON only, and a decision there starts another turn. SessionEnd
  // output is ignored. Printing nothing and exiting 0 is success on both.
  if (event.type === "turn-end" || event.type === "session-end") return SILENT;
  const nativeEvent = EVENT_OF_TYPE.get(event.type);
  if (nativeEvent === undefined) return SILENT;
  // outcome.env is not used: Codex has no channel from a hook to the agent's shell.
  if (typeof outcome.context !== "string" || outcome.context.trim() === "") return SILENT;
  // Codex's output schemas allow no unknown key. hookEventName and
  // additionalContext are in all four, and neither decides anything: plain
  // stdout would be ignored on the tool events.
  return { stdout: contextOutput(nativeEvent, clip(outcome.context, MAX_CONTEXT_CHARS)), stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// The hooks file
// ---------------------------------------------------------------------------

/**
 * The bundle path goes into a command line for a shell that huddle does not
 * choose, so it is written only when every character is inert in all of them.
 */
const SHELL_INERT = /^[A-Za-z0-9._/-]+$/;

/**
 * Codex runs `command` as `$SHELL -lc "<command>"` from the session's cwd,
 * which may be a subdirectory, so the repo root is asked of git; this is the
 * form Codex's documentation recommends.
 *
 * The file is committed for the whole team, and Codex reports a hook that
 * exits non-zero as failed, on every event. So the command first checks that
 * it can do its job and does nothing otherwise: no node on the PATH; or no
 * bundle where git says the root is, which also covers a missing git, a
 * directory that is not a repository, a sparse checkout without the bundle
 * and a nested clone. Asking git twice costs a few milliseconds and keeps to
 * what reads the same in sh, bash, zsh and fish: "command -v", "test -f",
 * "||", "exit", ";" and "$( )" inside double quotes. A variable would not.
 */
function posixCommand(bundle: string): string {
  const path = (quiet: string): string => `"$(git rev-parse --show-toplevel${quiet})/${bundle}"`;
  return `command -v node >/dev/null 2>&1 || exit 0; test -f ${path(" 2>/dev/null")} || exit 0; node ${path("")} hook ${NAME}`;
}

/**
 * On Windows Codex runs `commandWindows` with cmd.exe /C, which has no "$( )".
 * The same two checks: outside a batch file "exit /b 0" ends cmd.exe itself,
 * with success, and "if exist" skips a bundle that is not there. The "@"
 * keeps cmd from echoing the command into the hook's output.
 */
function windowsCommand(bundle: string): string {
  return `where node >nul 2>nul || exit /b 0 & for /f "delims=" %i in ('git rev-parse --show-toplevel 2^>nul') do @if exist "%i/${bundle}" node "%i/${bundle}" hook ${NAME}`;
}

/** The POSIX command exactly as posixCommand() writes it, with the bundle path captured where it is tested for. */
const POSIX_COMMAND =
  /^command -v node >\/dev\/null 2>&1 \|\| exit 0; test -f "\$\(git rev-parse --show-toplevel 2>\/dev\/null\)\/([A-Za-z0-9._/-]+)" \|\| exit 0; node "\$\(git rev-parse --show-toplevel\)\/\1" hook codex$/;

/** The command of the version before, which checked for node and not for the bundle. Again the whole line. */
const EARLIER_COMMAND = /^command -v node >\/dev\/null 2>&1 \|\| exit 0; node "\$\(git rev-parse --show-toplevel\)\/[A-Za-z0-9._/-]+" hook codex$/;

/** The plain line a hand might write instead: `node <path>/huddle.mjs hook codex` and nothing else. */
const PLAIN_COMMAND = plainCommand(NAME);

const HOOKS_FILE: HookFile = {
  path: HOOKS,
  registrations: REGISTRATIONS,
  handlerFor(registration, bundle) {
    if (!SHELL_INERT.test(bundle)) {
      throw new TypeError(`codex: the bundle path ${JSON.stringify(bundle)} cannot be written into a shell command (letters, digits, ".", "_", "-" and "/" only)`);
    }
    const handler: Json = { type: "command", command: posixCommand(bundle), commandWindows: windowsCommand(bundle), timeout: registration.timeout };
    if (registration.async === true) handler.async = true;
    return handler;
  },
  agent: NAME,
  isOurs(value) {
    const handler = asRecord(value);
    if (handler === null || handler.type !== "command" || typeof handler.command !== "string") return false;
    // The whole command, in a form huddle has written (for any bundle) or the plain one. A longer line that contains it is the user's.
    return POSIX_COMMAND.test(handler.command) || EARLIER_COMMAND.test(handler.command) || PLAIN_COMMAND.test(handler.command);
  },
  bundleOf(handler) {
    return POSIX_COMMAND.exec(asText(handler.command))?.[1] ?? null;
  },
};

const TRUST_NOTE =
  "Codex runs a project's hooks only after two steps, which each teammate does once: trust the project when Codex asks, then review the hooks by running /hooks in Codex and trusting huddle's. Codex asks for that review again whenever a hook's definition changes.";

async function install(opts: InstallOptions): Promise<Installed> {
  const { changed, twice } = await installHooks(HOOKS_FILE, opts.repoRoot, opts.bundle);
  const also = twiceNote(HOOKS_FILE, twice);
  return { changed: changed ? [HOOKS] : [], notes: also === null ? [TRUST_NOTE] : [TRUST_NOTE, also], files: [HOOKS] };
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

function codexHome(around: Surroundings): string {
  return asText(around.env.CODEX_HOME) || join(around.home, ".codex");
}

/**
 * What a config.toml says about the hooks feature: true, false, or undefined
 * when it says nothing. `[features] hooks = false` turns hooks off;
 * `codex_hooks` is the older name for the same key. This reads those two
 * keys and nothing else of TOML.
 */
export function hooksFeature(toml: string): boolean | undefined {
  let table = "";
  let value: boolean | undefined;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      table = line.replace(/^\[+\s*/, "").replace(/\s*\]+$/, "");
      continue;
    }
    const found =
      table === "features"
        ? /^(?:hooks|codex_hooks)\s*=\s*(true|false)$/.exec(line)
        : table === ""
          ? (/^features\.(?:hooks|codex_hooks)\s*=\s*(true|false)$/.exec(line) ?? /^features\s*=\s*\{.*\b(?:hooks|codex_hooks)\s*=\s*(true|false)\b.*\}$/.exec(line))
          : null;
    if (found !== null) value = found[1] === "true";
  }
  return value;
}

async function hooksFeatureIn(path: string): Promise<boolean | undefined> {
  try {
    return hooksFeature(await readFile(path, "utf8"));
  } catch {
    return undefined; // no such file, or not readable: it says nothing
  }
}

/** check(), with the surroundings passed in. */
export async function checkCodex(repoRoot: string, around: Surroundings): Promise<Check> {
  const { result, twice } = await checkHooks(HOOKS_FILE, repoRoot);
  if (!result.installed) return result;
  const notes = [TRUST_NOTE];
  const also = twiceNote(HOOKS_FILE, twice);
  if (also !== null) notes.push(also);
  // The project's config outranks the user's: the first layer that says anything decides.
  const userConfig = join(codexHome(around), "config.toml");
  const inProject = await hooksFeatureIn(join(repoRoot, PROJECT_CONFIG));
  const offIn = inProject === false ? PROJECT_CONFIG : inProject === undefined && (await hooksFeatureIn(userConfig)) === false ? userConfig : null;
  if (offIn !== null) {
    notes.unshift(`Hooks are turned off for Codex here: [features] hooks is false in ${offIn}. huddle's hooks will not run until that is removed.`);
  }
  return { ...result, notes };
}

/**
 * detect(), with the surroundings passed in. True on any sign that Codex is
 * used on this repo or by this user. It leans towards yes: the hook config is
 * committed for the whole team, and one unused file costs less than a
 * teammate whose agent stays invisible.
 */
export async function detectCodex(repoRoot: string, around: Surroundings): Promise<boolean> {
  if (await exists(join(repoRoot, ".codex"))) return true;
  if (await exists(codexHome(around))) return true;
  const names = around.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  return onPath(names, around.env);
}

export const codex: Adapter = {
  name: NAME,
  title: "Codex",
  detect: (repoRoot) => detectCodex(repoRoot, here()),
  install,
  check: (repoRoot) => checkCodex(repoRoot, here()),
  parse,
  format,
};
