// T3.3. Gemini CLI hooks, installed into <repo>/.gemini/settings.json.
//
// Written against https://geminicli.com/docs/hooks/ and its reference page as
// they read on 2026-11-12, and against Gemini CLI's own source at the release
// current then (tag v0.68.0): packages/core/src/hooks (types, hookRunner,
// hookPlanner, hookAggregator, trustedHooks), packages/core/src/scheduler
// (scheduler, hook-utils) and packages/core/src/utils/shell-utils.ts. No
// payload was recorded from a running Gemini CLI; the fixtures in
// test/fixtures/hooks/gemini-cli are built from those two sources. Read the
// docs again before changing how a payload is read or an answer is encoded.
//
//   Gemini CLI event   huddle event                     registered with
//   SessionStart       session-start                    timeout 10 s
//   BeforeAgent        prompt                           timeout 5 s
//   BeforeTool         pre-edit, shown to the user      timeout 5 s, matcher: write_file and replace
//   AfterTool          pre-edit after write_file or     timeout 5 s, matcher: every tool but the
//                      replace, post-edit otherwise       six that only read
//   AfterAgent         turn-end                         timeout 5 s
//   SessionEnd         session-end                      timeout 5 s
//
// The two tool rows are not what one would guess, and this is why.
//
// - A BeforeTool hook can refuse a tool call, rewrite its input or make the
//   user confirm it. It cannot say anything to the model and let the call go
//   ahead: the scheduler reads a decision, a system message and tool_input
//   from its answer, and nothing else. An AfterTool hook can: the
//   additionalContext it returns is appended to the tool's result. huddle
//   never blocks an edit. So the overlap warning, which is the engine's
//   answer to pre-edit, is asked for twice. Before the edit it goes to the
//   user as systemMessage, ahead of Gemini CLI's own question whether to
//   allow the edit, and the engine is told that the agent was not shown it
//   (HookOutput.unshown), so it does not count as said. After the edit the
//   same warning comes up again and the agent reads it with the result of
//   that edit; now it counts, and neither is told a second time. For the
//   agent that is later than on Claude Code or Codex, and it is the earliest
//   Gemini CLI allows.
// - AfterTool on every other tool is the engine's sign of life, a post-edit
//   that names no file: a session that only runs shell commands still shows
//   as live, and a shell command can edit files. Gemini CLI waits for every
//   hook, there is no async form, so the tools that only read and are called
//   in bursts are left out.
// - The engine starts a background sync on post-edit and not on pre-edit, so
//   an edit by itself asks for none: it is published by the sync that the
//   next tool call of another kind asks for, or the end of the turn.
//
// What else differs from Claude Code, and matters here:
// - A handler is a command line for a shell: `bash -c` on macOS and Linux,
//   PowerShell on Windows (pwsh when it is installed, else Windows PowerShell
//   5.1). One string serves both, so it uses only what both read the same way.
// - A hook that exits with a code other than 0 or 1 and prints anything that
//   is not JSON is read as a refusal. On BeforeAgent that discards the user's
//   prompt; on BeforeTool it blocks the edit. A shell that cannot find node
//   exits 127 and says so. Hence the `; exit 0` at the end of the command:
//   the hook exits 0 whatever became of node, and what node or the shell said
//   on stderr is shown to the user as a message instead of deciding anything.
// - `timeout` is in milliseconds.
// - Gemini CLI reads .gemini/settings.json from the directory it is started
//   in and from nowhere above it, and runs hooks with that directory as their
//   working directory. So the command names the bundle relative to it, and a
//   session started in a subdirectory runs none of these hooks.
// - String values in settings.json have $NAME and ${NAME} replaced when the
//   file is loaded, and $GEMINI_PROJECT_DIR and its like are replaced again,
//   shell-quoted, when a hook runs. The command has no "$" in it.
// - A project's hooks run only in a trusted folder. The first time, and again
//   whenever a hook's name or command changes, Gemini CLI warns that the
//   project brings hooks and names them. All six carry the same name and the
//   same command, so that is one entry, and `/hooks disable huddle` turns
//   them all off.
// - "<" and ">" in additionalContext reach the model as "&lt;" and "&gt;".
// - A payload does not say whether a subagent made the tool call, so every
//   event counts as the session's own.
// - There is no way for a hook to set a variable in the agent's shell, so
//   HUDDLE_SESSION is not passed on.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "../core/io.ts";
import { asRecord, asText, checkHooks, contextOutput, exists, installHooks, onPath, readJsonObject } from "./json-hooks.ts";
import type { HookFile, Json, Registration } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, CheckResult, HookEvent, HookInput, HookOutcome, HookOutput, InstallOptions, InstallResult } from "./types.ts";

const NAME = "gemini-cli";
const SETTINGS = ".gemini/settings.json";

/** The tools that write the one file named in their input, as tool_input.file_path. */
const EDIT_TOOLS: readonly string[] = ["write_file", "replace"];

/**
 * The tools that cannot change a file and that agents call in bursts.
 * search_file_content is the name grep_search had in older releases.
 */
const READ_ONLY_TOOLS: readonly string[] = ["read_file", "read_many_files", "list_directory", "glob", "grep_search", "search_file_content"];

// A tool matcher is a JavaScript regular expression, tested unanchored
// against the tool's name: "replace" alone would also match an MCP tool
// called mcp_db_replace_row. Both matchers are anchored at both ends.
const EDITS = `^(?:${EDIT_TOOLS.join("|")})$`;
const NOT_READ_ONLY = `^(?!(?:${READ_ONLY_TOOLS.join("|")})$)`;

/**
 * `timeout` is in seconds here, as in every Registration, and is written to
 * the file in milliseconds. `type` is what the event is passed on as; for
 * AfterTool that depends on the tool (see parsePayload).
 */
const REGISTRATIONS: readonly Registration[] = [
  { event: "SessionStart", type: "session-start", timeout: 10 },
  { event: "BeforeAgent", type: "prompt", timeout: 5 },
  { event: "BeforeTool", type: "pre-edit", timeout: 5, matcher: EDITS },
  { event: "AfterTool", type: "pre-edit", timeout: 5, matcher: NOT_READ_ONLY },
  { event: "AfterAgent", type: "turn-end", timeout: 5 },
  // Gemini CLI does not wait for SessionEnd hooks, so the timeout only bounds a hook that hangs.
  { event: "SessionEnd", type: "session-end", timeout: 5 },
];

const EVENTS: ReadonlySet<string> = new Set(REGISTRATIONS.map((registration) => registration.event));

// ---------------------------------------------------------------------------
// parse: a Gemini CLI payload on stdin -> a normalized event
// ---------------------------------------------------------------------------

/** The file an edit tool was called on, as the model wrote it: absolute as a rule, else relative to the payload's cwd. */
function editedPath(payload: Json): string {
  if (!EDIT_TOOLS.includes(asText(payload.tool_name))) return "";
  return asText(asRecord(payload.tool_input)?.file_path).trim();
}

function parsePayload(input: HookInput): HookEvent | null {
  const payload = asRecord(JSON.parse(input.stdin));
  if (payload === null) return null;
  const nativeEvent = asText(payload.hook_event_name);
  const sessionId = asText(payload.session_id).trim();
  if (!EVENTS.has(nativeEvent) || sessionId === "") return null;

  const event: HookEvent = {
    type: "post-edit",
    agent: NAME,
    sessionId,
    // The directory Gemini CLI was started in. The hook process starts there too.
    cwd: asText(payload.cwd) || input.cwd,
    native: { event: nativeEvent },
  };

  switch (nativeEvent) {
    case "SessionStart": {
      event.type = "session-start";
      const source = asText(payload.source);
      if (source !== "") event.source = source;
      break;
    }
    case "SessionEnd": {
      event.type = "session-end";
      const reason = asText(payload.reason);
      if (reason !== "") event.reason = reason;
      break;
    }
    case "BeforeAgent": {
      event.type = "prompt";
      const prompt = asText(payload.prompt).trim();
      if (prompt !== "") event.prompt = prompt;
      break;
    }
    case "AfterAgent":
      event.type = "turn-end";
      break;
    case "BeforeTool": {
      // Before any other tool, and before an edit that names no file, there
      // is nothing to check; the sign of life is AfterTool's.
      const path = editedPath(payload);
      if (path === "") return null;
      event.type = "pre-edit";
      event.paths = [path];
      break;
    }
    case "AfterTool": {
      // Whether the edit worked is not looked at. An edit that failed on a
      // contested file is tried again, and the warning is due either way.
      const path = editedPath(payload);
      if (path !== "") {
        event.type = "pre-edit";
        event.paths = [path];
      }
      break;
    }
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

function format(event: HookEvent, outcome: HookOutcome): HookOutput {
  // On AfterAgent a decision makes Gemini CLI run the turn again, and text
  // that is not JSON is shown to the user. SessionEnd is not waited for.
  // Printing nothing and exiting 0 is success on both.
  if (event.type === "turn-end" || event.type === "session-end") return SILENT;
  // outcome.env is not used: Gemini CLI has no channel from a hook to the agent's shell.
  const context = typeof outcome.context === "string" ? outcome.context : "";
  if (context.trim() === "") return SILENT;

  // A briefing is for the model alone: the user would be shown it at every prompt.
  if (event.type === "session-start") return { stdout: contextOutput("SessionStart", context), stderr: "", exitCode: 0 };
  if (event.type === "prompt") return { stdout: contextOutput("BeforeAgent", context), stderr: "", exitCode: 0 };

  // On a tool event the context is an overlap warning. There is never a
  // decision in the answer: nothing is blocked, allowed, confirmed or rewritten.
  if (asText(asRecord(event.native)?.event) === "BeforeTool") {
    // Only the user can be told here. The agent has not been, and the engine
    // has to know: the warning is due again after the edit.
    return { stdout: JSON.stringify({ systemMessage: context }), stderr: "", exitCode: 0, unshown: true };
  }
  return { stdout: contextOutput("AfterTool", context), stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

/** The name all of huddle's handlers carry: in /hooks, in hooksConfig.disabled and in Gemini CLI's record of trusted hooks. */
const HOOK_NAME = "huddle";

const DESCRIPTION = "Shows this agent what teammates' agents are working on, and shows them what this one is. Installed by `huddle init`.";

/**
 * The bundle path goes into a command line for bash and for PowerShell, so it
 * is written only when every character is inert in both. It may not start
 * with "-" either: node would read it as an option.
 */
const SHELL_INERT = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * Gemini CLI runs the command with bash -c, or with PowerShell -Command on
 * Windows, in the directory it was started in, which is the one that holds
 * .gemini/settings.json. The bundle is named relative to that.
 *
 * `; exit 0` is not decoration (see the top of this file): without it, a
 * machine with no node on the PATH would have every prompt discarded. It is
 * `;` and not `||` because Windows PowerShell 5.1 does not parse `||`.
 */
function commandFor(bundle: string): string {
  return `node ${bundle} hook ${NAME}; exit 0`;
}

/** The command exactly as commandFor() writes it, with the bundle path captured. */
const COMMAND = /^node ([A-Za-z0-9._/][A-Za-z0-9._/-]*) hook gemini-cli; exit 0$/;

/**
 * Any command that runs a file named exactly huddle.mjs as `hook gemini-cli`,
 * however the path is written: an older install, or one edited by hand.
 */
const OURS = /(?:^|[\s"'\\/])huddle\.mjs["']?\s+hook\s+gemini-cli(?![\w-])/;

const SETTINGS_FILE: HookFile = {
  path: SETTINGS,
  registrations: REGISTRATIONS,
  handlerFor(registration, bundle) {
    if (!SHELL_INERT.test(bundle)) {
      throw new TypeError(`gemini-cli: the bundle path ${JSON.stringify(bundle)} cannot be written into a shell command (letters, digits, ".", "_", "-" and "/" only, and no "-" in front)`);
    }
    return { name: HOOK_NAME, type: "command", command: commandFor(bundle), timeout: registration.timeout * 1000, description: DESCRIPTION };
  },
  isOurs(value) {
    const handler = asRecord(value);
    return handler !== null && typeof handler.command === "string" && OURS.test(handler.command);
  },
  bundleOf(handler) {
    return COMMAND.exec(asText(handler.command))?.[1] ?? null;
  },
};

const START_NOTE =
  "Gemini CLI reads .gemini/settings.json from the directory it is started in, and runs a project's hooks only in a folder it trusts: each teammate starts gemini at the top of the repository and trusts the folder when asked. The first time, Gemini CLI warns that the project brings a hook named huddle; that is this one.";

const LATE_NOTE =
  "On Gemini CLI the user is shown an overlap with a teammate before the edit and the agent hears of it right after the edit, not before it: a hook that runs before an edit can block it, but cannot tell the model anything and let the edit go ahead.";

/**
 * `text` without its comments, as Gemini CLI reads a settings file: `//` to
 * the end of the line and `/* ... *\/`, wherever they are not inside a string.
 */
export function withoutComments(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    if (text[at] === '"') {
      // A string is copied whole, with whatever it holds.
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(at, end + 1);
      at = end + 1;
    } else if (text.startsWith("//", at)) {
      while (at < text.length && text[at] !== "\n" && text[at] !== "\r") at++;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      at = end === -1 ? text.length : end + 2;
    } else {
      out += text[at];
      at++;
    }
  }
  return out;
}

function isJsonObject(text: string): boolean {
  try {
    return asRecord(JSON.parse(text.replace(/^\uFEFF/, ""))) !== null;
  } catch {
    return false;
  }
}

/**
 * Is the settings file one that Gemini CLI reads and huddle does not, with
 * comments as the only reason? Gemini CLI takes comments out before it
 * parses; huddle would lose them when it writes the file back.
 */
async function commentsAreInTheWay(repoRoot: string): Promise<boolean> {
  const text = await readFile(join(repoRoot, SETTINGS), "utf8").catch(() => null);
  return text !== null && !isJsonObject(text) && isJsonObject(withoutComments(text));
}

const COMMENTS_INSTALL = `${SETTINGS} has comments in it. Gemini CLI reads such a file, but huddle cannot keep the comments when it writes its hooks into it and will not overwrite it: take the comments out, then run huddle init again.`;
const COMMENTS_CHECK = `${SETTINGS} has comments in it, and huddle cannot read it with them. Take the comments out, then run huddle init.`;

async function install(opts: InstallOptions): Promise<InstallResult> {
  let changed: boolean;
  try {
    changed = await installHooks(SETTINGS_FILE, opts.repoRoot, opts.bundle);
  } catch (error) {
    // "Not valid JSON" is true and no help to someone whose file Gemini CLI reads without complaint.
    if (error instanceof CliError && (await commentsAreInTheWay(opts.repoRoot))) throw new CliError(COMMENTS_INSTALL);
    throw error;
  }
  return { changed: changed ? [SETTINGS] : [], notes: [START_NOTE, LATE_NOTE] };
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

/** The user's own settings directory: ~/.gemini, or .gemini under GEMINI_CLI_HOME when that is set. */
function geminiHome(around: Surroundings): string {
  return join(asText(around.env.GEMINI_CLI_HOME) || around.home, ".gemini");
}

/**
 * What one settings file says about hooks: the whole system on or off
 * (undefined when it says nothing), and whether it disables huddle's. An
 * entry of hooksConfig.disabled is a hook's name, and only a hook that has no
 * name goes by its command there; huddle's all have one.
 */
function switchesIn(settings: Json | null | "invalid"): { enabled: boolean | undefined; disabled: boolean } {
  const config = settings === null || settings === "invalid" ? null : asRecord(settings.hooksConfig);
  return {
    enabled: typeof config?.enabled === "boolean" ? config.enabled : undefined,
    disabled: Array.isArray(config?.disabled) && config.disabled.includes(HOOK_NAME),
  };
}

/** check(), with the surroundings passed in. */
export async function checkGeminiCli(repoRoot: string, around: Surroundings): Promise<CheckResult> {
  const { result, settings } = await checkHooks(SETTINGS_FILE, repoRoot);
  if (!result.installed) return (await commentsAreInTheWay(repoRoot)) ? { ...result, detail: COMMENTS_CHECK } : result;
  const notes = [START_NOTE, LATE_NOTE];
  const userFile = join(geminiHome(around), "settings.json");
  const inProject = switchesIn(settings);
  const inUser = switchesIn(await readJsonObject(userFile));
  // Gemini CLI adds the lists of disabled hooks of all settings files together.
  const disabledIn = inProject.disabled ? SETTINGS : inUser.disabled ? userFile : null;
  if (disabledIn !== null) {
    notes.unshift(`huddle's hooks are disabled by name for Gemini CLI here: hooksConfig.disabled in ${disabledIn} lists them. They will not run until that entry is removed, or until /hooks enable ${HOOK_NAME} is run in Gemini CLI.`);
  }
  // The project's settings outrank the user's: the first of the two that says anything decides.
  const offIn = inProject.enabled === false ? SETTINGS : inProject.enabled === undefined && inUser.enabled === false ? userFile : null;
  if (offIn !== null) {
    notes.unshift(`Hooks are turned off for Gemini CLI here: hooksConfig.enabled is false in ${offIn}. huddle's hooks will not run until that is removed.`);
  }
  return { ...result, notes };
}

/**
 * detect(), with the surroundings passed in. True on any sign that Gemini CLI
 * is used on this repo or by this user. It leans towards yes: the hook config
 * is committed for the whole team, and one unused file costs less than a
 * teammate whose agent stays invisible.
 */
export async function detectGeminiCli(repoRoot: string, around: Surroundings): Promise<boolean> {
  if (await exists(join(repoRoot, ".gemini"))) return true;
  if (await exists(geminiHome(around))) return true;
  const names = around.platform === "win32" ? ["gemini.cmd", "gemini.exe", "gemini.ps1", "gemini"] : ["gemini"];
  return onPath(names, around.env);
}

export const geminiCli: Adapter = {
  name: NAME,
  title: "Gemini CLI",
  detect: (repoRoot) => detectGeminiCli(repoRoot, here()),
  install,
  check: (repoRoot) => checkGeminiCli(repoRoot, here()),
  parse,
  format,
};
