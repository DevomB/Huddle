// T3.3. Gemini CLI hooks, installed into <repo>/.gemini/settings.json.
//
// Written against https://geminicli.com/docs/hooks/ and its reference page as
// they read on 2026-11-12, and against Gemini CLI's own source at the release
// current then (tag v0.68.0): packages/core/src/hooks (types, hookRunner,
// hookPlanner, hookAggregator, trustedHooks), packages/core/src/scheduler
// (scheduler, hook-utils, tool-executor), packages/core/src/core/
// coreToolHookTriggers.ts, packages/core/src/utils/shell-utils.ts,
// packages/core/src/tools/definitions/base-declarations.ts (the tool names)
// and packages/cli/src (config/settings.ts, ui/commands/clearCommand.ts). No
// payload was recorded from a running Gemini CLI; the fixtures in
// test/fixtures/hooks/gemini-cli are built from those two sources. Read the
// docs again before changing how a payload is read or an answer is encoded.
//
//   Gemini CLI event   huddle event                     registered with
//   SessionStart       session-start                    timeout 10 s
//   BeforeAgent        prompt                           timeout 5 s
//   BeforeTool         pre-edit, shown to the user      timeout 5 s, matcher: write_file and replace
//   AfterTool          post-edit: with the file after   timeout 5 s, matcher: every tool but the
//                      write_file or replace, without     ones in READ_ONLY_TOOLS
//                      one after any other tool
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
//   never blocks an edit. So the overlap warning is asked for twice. Before
//   the edit, as the engine's pre-edit: it goes to the user as systemMessage,
//   ahead of Gemini CLI's own question whether to allow the edit, and the
//   engine is told that the agent was not shown it (HookOutput.unshown), so
//   it does not count as said. After the edit, as a post-edit that names the
//   file: the engine gives the warning the session has not had yet, the
//   agent reads it with the result of that edit, now it counts, and neither
//   is told a second time. For the agent that is later than on Claude Code
//   or Codex, and it is the earliest Gemini CLI allows.
// - Not after an edit that failed, though. For a tool that returned an error
//   the model is given the error's message and nothing else (tool-executor.ts
//   builds the response from error.message alone), so what a hook adds to
//   that result is lost. A replace whose old_string is not found is an
//   everyday thing. The warning is then not printed and reported as unshown,
//   and it comes with the result of the attempt that works.
// - AfterTool on every other tool is the engine's sign of life, a post-edit
//   that names no file: a session that only runs shell commands still shows
//   as live, and a shell command can edit files. Gemini CLI waits for every
//   hook, there is no async form, so the built-in tools that cannot change a
//   file in the worktree are left out (READ_ONLY_TOOLS). Every other built-in
//   tool and every tool of an MCP server costs one node process.
// - The post-edit after an edit is also what asks for the sync that publishes
//   it. BeforeTool asks for none.
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
// - `timeout` is in milliseconds. It does not bound these hooks under bash:
//   with `; exit 0` after it, bash starts node and waits for it instead of
//   becoming it, Gemini CLI's timeout signals the shell, and node lives on
//   with the pipes open, so the hook is over when node is. A hook that timed
//   out is not a refusal either way. What bounds a hook is huddle's own
//   deadline for the event (hooks/engine.ts).
// - SessionStart after /clear is the one start whose additionalContext goes
//   nowhere: clearCommand.ts takes the system message from the hook's answer
//   and nothing else. The session has a new id and an empty context then. So
//   that briefing is not printed and reported as unshown, and the first
//   prompt brings it.
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
//   event counts as the session's own: a warning that a subagent got with the
//   result of its edit counts as said to the session.
// - There is no way for a hook to set a variable in the agent's shell, so
//   HUDDLE_SESSION is not passed on.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { CliError } from "../core/io.ts";
import { asRecord, asText, checkHooks, contextOutput, exists, installHooks, onPath, plainCommand, twiceNote } from "./json-hooks.ts";
import type { Check, HookFile, Installed, Json, Registration } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, HookEvent, HookInput, HookOutcome, HookOutput, InstallOptions } from "./types.ts";

const NAME = "gemini-cli";
const SETTINGS = ".gemini/settings.json";

/** The tools that write the one file named in their input, as tool_input.file_path. */
const EDIT_TOOLS: readonly string[] = ["write_file", "replace"];

/**
 * The built-in tools that cannot change a file in the worktree: they read
 * files, the web, the docs, an MCP server's resources or the task tracker, or
 * talk to the user. No hook runs after them. The names are those of v0.68.0
 * (base-declarations.ts, tool-names.ts); search_file_content is the name
 * grep_search had in older releases. The other built-in tools are not all
 * writers of files (write_todos, activate_skill, the plan mode pair,
 * complete_task, the tracker's writing tools, invoke_agent); what they touch
 * was not read up on, so they keep their sign of life.
 */
const READ_ONLY_TOOLS: readonly string[] = [
  "read_file",
  "read_many_files",
  "list_directory",
  "glob",
  "grep_search",
  "search_file_content",
  "google_web_search",
  "web_fetch",
  "get_internal_docs",
  "read_mcp_resource",
  "list_mcp_resources",
  "tracker_get_task",
  "tracker_list_tasks",
  "tracker_visualize",
  "ask_user",
  "update_topic",
];

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
  { event: "AfterTool", type: "post-edit", timeout: 5, matcher: NOT_READ_ONLY },
  { event: "AfterAgent", type: "turn-end", timeout: 5 },
  // Gemini CLI's docs say a SessionEnd hook is not waited for. Its source awaits it, on /clear and in the
  // cleanup at exit, so a slow one delays both; the engine gives session-end one second.
  { event: "SessionEnd", type: "session-end", timeout: 5 },
];

const EVENTS: ReadonlySet<string> = new Set(REGISTRATIONS.map((registration) => registration.event));

// ---------------------------------------------------------------------------
// parse: a Gemini CLI payload on stdin -> a normalized event
// ---------------------------------------------------------------------------

/**
 * The file an edit tool was called on, as the model wrote it. Each of the two
 * tools takes one file_path. Gemini CLI resolves a relative one against its
 * workspace directory, which is the payload's cwd, and so does the engine.
 * Two cases where the file that was edited can be another one, neither
 * handled here: a session started with --include-directories has more than
 * one workspace directory, and replace corrects a path that does not exist to
 * a file of that name it finds elsewhere in the workspace.
 */
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
      // A post-edit. After an edit it names the file: the engine then gives the warning that
      // BeforeTool could not give the model, and asks for the sync that publishes the edit.
      const path = editedPath(payload);
      if (path !== "") event.paths = [path];
      // tool_response.error is there exactly when the tool failed. The model
      // then reads the error and nothing a hook adds: see format().
      const error = asRecord(payload.tool_response)?.error;
      if (error !== undefined && error !== null) event.native = { event: nativeEvent, failed: true };
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
  // that is not JSON is shown to the user. On SessionEnd there is nobody to
  // tell. Printing nothing and exiting 0 is success on both.
  if (event.type === "turn-end" || event.type === "session-end") return SILENT;
  // outcome.env is not used: Gemini CLI has no channel from a hook to the agent's shell.
  const context = typeof outcome.context === "string" ? outcome.context : "";
  if (context.trim() === "") return SILENT;

  // A briefing is for the model alone: the user would be shown it at every prompt.
  if (event.type === "session-start") {
    // After /clear Gemini CLI drops it. Not printed and not counted as said: the first prompt brings it.
    if (event.source === "clear") return { ...SILENT, unshown: true };
    return { stdout: contextOutput("SessionStart", context), stderr: "", exitCode: 0 };
  }
  if (event.type === "prompt") return { stdout: contextOutput("BeforeAgent", context), stderr: "", exitCode: 0 };

  // On a tool event the context is an overlap warning. There is never a
  // decision in the answer: nothing is blocked, allowed, confirmed or rewritten.
  const native = asRecord(event.native);
  if (asText(native?.event) === "BeforeTool") {
    // Only the user can be told here. The agent has not been, and the engine
    // has to know: the warning is due again after the edit.
    return { stdout: JSON.stringify({ systemMessage: context }), stderr: "", exitCode: 0, unshown: true };
  }
  // After a tool that failed, the model is not given what a hook adds to the
  // result. Nothing is printed, and the warning stays due for the next try.
  if (native?.failed === true) return { ...SILENT, unshown: true };
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

/** The plain line a hand might write: `node <path>/huddle.mjs hook gemini-cli` and nothing else. */
const PLAIN_COMMAND = plainCommand(NAME);

/** The same with the exit at its end, which a hand may have spaced differently. */
const EXIT_AT_THE_END = /\s*;\s*exit\s+0\s*$/;

/**
 * Is the whole command huddle's hook and nothing else? In the form this
 * version writes, for any bundle, or the plain line with or without the exit
 * at its end (an install edited by hand). A longer line that contains it
 * (`... && ./notify.sh`, `time node ... | tee log`, an echo that mentions it)
 * is the user's and is left alone.
 */
function isWholeCommand(command: string): boolean {
  return COMMAND.test(command) || PLAIN_COMMAND.test(command.replace(EXIT_AT_THE_END, ""));
}

const SETTINGS_FILE: HookFile = {
  path: SETTINGS,
  agent: NAME,
  registrations: REGISTRATIONS,
  handlerFor(registration, bundle) {
    if (!SHELL_INERT.test(bundle)) {
      throw new TypeError(`gemini-cli: the bundle path ${JSON.stringify(bundle)} cannot be written into a shell command (letters, digits, ".", "_", "-" and "/" only, and no "-" in front)`);
    }
    return { name: HOOK_NAME, type: "command", command: commandFor(bundle), timeout: registration.timeout * 1000, description: DESCRIPTION };
  },
  isOurs(value) {
    const handler = asRecord(value);
    return handler !== null && typeof handler.command === "string" && isWholeCommand(handler.command);
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

/**
 * A byte order mark in front of a settings file. huddle reads past it and
 * keeps it when it writes the file. Gemini CLI cannot use such a file:
 * v0.68.0 reads it as text, takes the comments out (strip-json-comments
 * 3.1.1, which leaves the mark where it is) and hands the rest to JSON.parse,
 * which rejects the mark; config/settings.ts reports that as an error in the
 * configuration. So the user is told, wherever the file is installed into or
 * checked.
 */
const MARK = String.fromCodePoint(0xfeff);
const MARK_NOTE = `${SETTINGS} starts with a byte order mark. Gemini CLI cannot parse a settings file that has one and reports an error in its configuration: save the file without the mark.`;
const COMMENTS_AND_MARK_INSTALL = `${SETTINGS} has comments in it. huddle cannot keep the comments when it writes its hooks into it and will not overwrite it: take the comments out, then run huddle init again. The file also starts with a byte order mark, which Gemini CLI cannot parse: save it without the mark.`;

async function startsWithMark(repoRoot: string): Promise<boolean> {
  const text = await readFile(join(repoRoot, SETTINGS), "utf8").catch(() => "");
  return text.startsWith(MARK);
}

async function install(opts: InstallOptions): Promise<Installed> {
  let changed: boolean;
  let twice: string[];
  try {
    ({ changed, twice } = await installHooks(SETTINGS_FILE, opts.repoRoot, opts.bundle));
  } catch (error) {
    // "Not valid JSON" is true and no help to someone whose file Gemini CLI reads without complaint. Only that
    // refusal is reworded: one about where the file is (a link out of the checkout, say) stands as it is.
    if (error instanceof CliError && error.message.includes("is not valid JSON") && (await commentsAreInTheWay(opts.repoRoot))) {
      throw new CliError((await startsWithMark(opts.repoRoot)) ? COMMENTS_AND_MARK_INSTALL : COMMENTS_INSTALL);
    }
    throw error;
  }
  const notes = [START_NOTE, LATE_NOTE];
  const also = twiceNote(SETTINGS_FILE, twice);
  if (also !== null) notes.push(also);
  if (await startsWithMark(opts.repoRoot)) notes.unshift(MARK_NOTE);
  return { changed: changed ? [SETTINGS] : [], notes, files: [SETTINGS] };
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
 * The settings of the machine, which an administrator writes: the ones that
 * outrank every other file, and the defaults next to them, which every other
 * file outranks (getSystemSettingsPath and getSystemDefaultsPath in Gemini
 * CLI's config/settings.ts).
 */
export function systemSettingsFiles(around: Surroundings): { settings: string; defaults: string } {
  const byPlatform =
    around.platform === "darwin" ? "/Library/Application Support/GeminiCli/settings.json" : around.platform === "win32" ? "C:\\ProgramData\\gemini-cli\\settings.json" : "/etc/gemini-cli/settings.json";
  const settings = asText(around.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) || byPlatform;
  const path = around.platform === "win32" ? win32 : posix;
  return { settings, defaults: asText(around.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH) || path.join(path.dirname(settings), "system-defaults.json") };
}

/**
 * A settings file other than the project's, read the way Gemini CLI reads
 * every settings file: comments are taken out, then it is parsed. null when
 * it is not there or is not a JSON object; it says nothing then.
 */
async function readSettings(path: string): Promise<Json | null> {
  try {
    return asRecord(JSON.parse(withoutComments(await readFile(path, "utf8"))));
  } catch {
    return null;
  }
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
export async function checkGeminiCli(repoRoot: string, around: Surroundings): Promise<Check> {
  const { result, settings, twice } = await checkHooks(SETTINGS_FILE, repoRoot);
  if (!result.installed) {
    // With comments as the only obstacle the hooks in the file may well be running: Gemini CLI reads it. Not known to be broken.
    const unparsed = result.detail.includes("cannot be read as a JSON object");
    return unparsed && (await commentsAreInTheWay(repoRoot)) ? { installed: false, detail: COMMENTS_CHECK, notes: [] } : result;
  }
  const notes = [START_NOTE, LATE_NOTE];
  const also = twiceNote(SETTINGS_FILE, twice);
  if (also !== null) notes.push(also);
  const userFile = join(geminiHome(around), "settings.json");
  const system = systemSettingsFiles(around);
  const project = { file: SETTINGS, says: switchesIn(settings) };
  const user = { file: userFile, says: switchesIn(await readSettings(userFile)) };
  const machine = { file: system.settings, says: switchesIn(await readSettings(system.settings)) };
  const defaults = { file: system.defaults, says: switchesIn(await readSettings(system.defaults)) };
  // Gemini CLI adds the lists of disabled hooks of all settings files together. The file named is the one closest to hand.
  const disabledIn = [project, user, machine, defaults].find((scope) => scope.says.disabled)?.file;
  if (disabledIn !== undefined) {
    // The project's file is committed: an entry in it is every teammate's.
    const shared = disabledIn === SETTINGS ? ", and that file is the whole team's" : "";
    notes.unshift(`huddle's hooks are disabled by name for Gemini CLI here: hooksConfig.disabled in ${disabledIn} lists them${shared}. They will not run until that entry is removed, or until /hooks enable ${HOOK_NAME} is run in Gemini CLI.`);
  }
  // For a single value the files outrank one another: the machine's settings, the project's, the user's, the
  // machine's defaults. The first of them that says anything decides.
  const decides = [machine, project, user, defaults].find((scope) => scope.says.enabled !== undefined);
  if (decides?.says.enabled === false) {
    notes.unshift(`Hooks are turned off for Gemini CLI here: hooksConfig.enabled is false in ${decides.file}. huddle's hooks will not run until that is removed.`);
  }
  // First of all: with the mark in front, Gemini CLI does not get as far as any of the above.
  if (await startsWithMark(repoRoot)) notes.unshift(MARK_NOTE);
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
