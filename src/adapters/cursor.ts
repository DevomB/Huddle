// T3.4. Cursor hooks, installed into <repo>/.cursor/hooks.json.
//
// Written against https://cursor.com/docs/hooks and
// https://cursor.com/docs/reference/third-party-hooks as they read on
// 2026-11-12. Nothing here has been run against Cursor itself: the fixtures
// in test/fixtures/hooks/cursor are built from the schemas on those pages,
// not recorded. Read the docs again before changing how a payload is read or
// an answer is encoded, and where this file says "not documented", check it
// against a live Cursor when there is one.
//
//   Cursor event         huddle event                       registered with
//   sessionStart         session-start                      timeout 10
//   beforeSubmitPrompt   prompt                             timeout 5
//   postToolUse          post-edit that also briefs, when   timeout 5, matcher Write|Delete|Shell
//                        the tool edited a file; else
//                        prompt without a text
//   postToolUseFailure   prompt without a text              timeout 5, matcher Write|Delete|Shell
//   afterFileEdit        post-edit                          timeout 5
//   stop                 turn-end                           timeout 5
//   sessionEnd           session-end                        timeout 5
//
// Where Cursor differs from Claude Code, and it matters here:
//
// - A hook can put text in front of the agent in three places only:
//   sessionStart, postToolUse and postToolUseFailure, all through
//   `additional_context`. beforeSubmitPrompt can let the prompt pass or block
//   it and has no field that reaches the agent. So the prompt records the
//   intent and nothing is shown, and everything the team has to say comes
//   after a tool call instead:
//   - the postToolUse of an edit is handed to the engine as a post-edit with
//     `brief` set (adapters/types.ts): the overlap warning for the file and
//     whatever is new in the team, in one answer;
//   - any other postToolUse, and every postToolUseFailure, is handed over as
//     a prompt without a text: a sign of life plus the news.
// - Nothing can be said before an edit without stopping it. preToolUse's
//   `agent_message` is "fed back to the agent when the action is denied", and
//   preToolUse is one of the hooks where an answer Cursor cannot read blocks
//   the action. huddle never blocks, so it registers no hook before a tool
//   call at all, and the overlap warning comes right after the edit.
// - afterFileEdit can say nothing to anyone and is registered all the same,
//   as a second post-edit for the same edit. It is the one event the page
//   ties to file edits whatever the tool behind them is called, and it names
//   the file in a documented field. If Cursor's edit tool has a type the
//   matcher below does not catch, this is what still gets the edit published.
//   The engine takes two post-edits for one edit as one: what the first said
//   is on record, and an answer that could not be shown uses up nothing.
// - The matcher Write|Delete|Shell is not anchored, on purpose. The reason is
//   at AFTER_TOOLS; do not "fix" it before it has been seen to work.
// - Which file a tool edited is not documented for postToolUse: the page
//   shows `tool_input` for Shell only. It is read as `file_path`, the name
//   every documented Cursor payload uses for a file (afterFileEdit,
//   beforeReadFile), then as `path`. If Cursor calls it something else, an
//   edit still counts as a sign of life and brings the news, no overlap
//   warning is ever given, and the hook says so on stderr with the names of
//   the fields it did find (never their values), so that it leaves a trace.
// - sessionStart "runs as fire-and-forget; the agent loop does not wait for or
//   enforce a blocking response", and huddle's session-start waits up to 4 s
//   for a sync before it answers. So the briefing given there may never reach
//   the agent. It is printed, and it is not recorded as shown (`unshown`): the
//   first edit or shell command brings the briefing again. Twice at worst,
//   where the other choice was never at worst. sessionEnd is fire-and-forget too ("the
//   response is logged but not used"). For the other hooks the page does not
//   say whether Cursor waits; huddle keeps them short either way, which is
//   why postToolUse is registered for the tools that change things and not
//   for Read or Grep.
// - Every hook of every source runs, and of several `additional_context`
//   answers to one event "the last response wins". A hook of the user's that
//   answers postToolUse too can replace huddle's text, which huddle has then
//   recorded as shown. install() and check() say so in a note.
// - A handler is a command line, run from the project root, by PowerShell on
//   Windows. `node <bundle> hook cursor <event>` reads the same in every
//   shell, which a check for node or for the bundle would not. Where either
//   is missing the command fails, and for the hooks registered here Cursor
//   then carries on ("Hook failed, action proceeds").
// - The event comes from the command line, not from the payload: Cursor ran
//   the command it found under that event.
// - The session id is `conversation_id`, which the page lists among the fields
//   of every hook; for sessionStart it says `session_id` is the "same as
//   conversation_id".
// - `env` returned from sessionStart is "available to all subsequent hook
//   executions". Nothing says it reaches the agent's shell, so HUDDLE_SESSION
//   is not passed on. `huddle intent` typed by the agent finds the session
//   anyway: it is the one last active in the worktree.
// - Cloud agents run a project's hooks, but not sessionStart and sessionEnd.
//   A session there appears with its first prompt and ages out.
// - Which conversation_id a subagent's tool calls carry is not documented.
//   Whatever id an event carries is its session.
// - Cursor also runs Claude Code's hooks from .claude/settings.json unless
//   that is switched off. claude-code.ts stands down for a payload that is
//   Cursor's, so that one Cursor session is not recorded by two adapters.
//   That leaves a repository with huddle's Claude Code hooks and without
//   these: a Cursor session there would be invisible. So detect() says yes
//   wherever the Claude Code hooks are, and a default `huddle init` installs
//   both.

import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, asText, checkHooks, clip, exists, fileNamesHook, installHooks, isVersion, plainCommand, twiceNote } from "./json-hooks.ts";
import type { HookFile, Json, Registration } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, CheckResult, HookEvent, HookInput, HookOutcome, HookOutput, InstallOptions, InstallResult } from "./types.ts";

const NAME = "cursor";
const HOOKS = ".cursor/hooks.json";
/** The version of the hooks file this adapter writes entries for. */
const VERSION = 1;

/**
 * The tools whose postToolUse huddle wants: the two that change a file by
 * name, and the shell, which is how a session that edits nothing still shows
 * as alive. A matcher is a regular expression tested against the tool type;
 * this one is in the form of the page's own example ("Shell|Read|Write").
 *
 * Not anchored, on purpose. Anchored it would leave out an MCP tool whose
 * name contains one of the words, which costs a short process that answers
 * nothing. But the tool types are known from the page alone: if one is spelled
 * a little differently in a real Cursor, an anchored matcher never fires and
 * huddle is deaf there, with nothing to show for it. Anchor it once it has
 * been seen to work.
 */
const AFTER_TOOLS = "Write|Delete|Shell";

const REGISTRATIONS: readonly Registration[] = [
  { event: "sessionStart", type: "session-start", timeout: 10 },
  { event: "beforeSubmitPrompt", type: "prompt", timeout: 5 },
  // A post-edit when the tool edited a file huddle can name; parse() makes anything else a prompt without a text.
  { event: "postToolUse", type: "post-edit", timeout: 5, matcher: AFTER_TOOLS },
  // "Called when a tool fails, times out, or is denied." No edit happened, so it is never an edit here.
  { event: "postToolUseFailure", type: "prompt", timeout: 5, matcher: AFTER_TOOLS },
  // No matcher: this event is "matched against the value Write" and nothing else.
  { event: "afterFileEdit", type: "post-edit", timeout: 5 },
  { event: "stop", type: "turn-end", timeout: 5 },
  { event: "sessionEnd", type: "session-end", timeout: 5 },
];

const REGISTERED = new Map<string, Registration>(REGISTRATIONS.map((registration) => [registration.event, registration]));

/** The events whose answer has a field that reaches the agent. */
const SPEAKS: ReadonlySet<string> = new Set(["sessionStart", "postToolUse", "postToolUseFailure"]);

/** What parse() hands to format() through HookEvent.native. */
interface Native {
  event: string;
  /** A file tool whose input named no file where editedPaths() looks: the tool, and the names of the fields it did have. */
  unnamed?: { tool: string; fields: string[] };
}

// ---------------------------------------------------------------------------
// parse: a Cursor payload on stdin -> a normalized event
// ---------------------------------------------------------------------------

/** Tools that change the one file named in their input. Cursor's Write stands for Claude Code's Write and Edit. */
const FILE_TOOLS: readonly string[] = ["Write", "Delete"];

/** `tool_input` is an object on postToolUse. On the MCP hooks it is a JSON string, so that is read too. */
function toolInput(value: unknown): Json | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Is this the payload of a tool that changes one file by name? */
function isFileTool(payload: Json): boolean {
  return FILE_TOOLS.includes(asText(payload.tool_name));
}

/** The file a tool changed, or [] when the tool is not one that names a file or the name is not where this looks. */
function editedPaths(payload: Json): string[] {
  if (!isFileTool(payload)) return [];
  const input = toolInput(payload.tool_input);
  if (input === null) return [];
  const path = asText(input.file_path) || asText(input.path);
  return path === "" ? [] : [path];
}

/** Field names are Cursor's own words; anything else in their place is not repeated. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** The names of the fields a tool's input has, for the trace of an edit huddle could not name. Never a value. */
function fieldNames(payload: Json): string[] {
  return Object.keys(toolInput(payload.tool_input) ?? {})
    .filter((name) => FIELD_NAME.test(name))
    .slice(0, 12);
}

function parsePayload(input: HookInput): HookEvent | null {
  const payload = asRecord(JSON.parse(input.stdin));
  if (payload === null) return null;
  // The command line says which event this is; the payload's own word for it
  // is the fallback for a handler somebody wrote by hand without one.
  const registration = REGISTERED.get(asText(input.args[0])) ?? REGISTERED.get(asText(payload.hook_event_name));
  const sessionId = (asText(payload.conversation_id) || asText(payload.session_id)).trim();
  if (registration === undefined || sessionId === "") return null;

  const event: HookEvent = {
    type: registration.type,
    agent: NAME,
    sessionId,
    // The tool hooks say where the tool ran. The others say nothing, and a
    // project's hooks start in the project root.
    cwd: asText(payload.cwd) || input.cwd,
  };
  const native: Native = { event: registration.event };
  event.native = native;

  if (event.type === "session-end") {
    const reason = asText(payload.reason);
    if (reason !== "") event.reason = reason;
  } else if (event.type === "prompt") {
    // Only the user's prompt has a text. After a failed tool call there is none to take an intent from.
    const prompt = registration.event === "beforeSubmitPrompt" ? asText(payload.prompt).trim() : "";
    if (prompt !== "") event.prompt = prompt;
  } else if (registration.event === "postToolUse") {
    const paths = editedPaths(payload);
    if (paths.length > 0) {
      // An edit, and the one place after it where the agent can be told anything: the warning and the news together.
      event.paths = paths;
      event.brief = true;
    } else {
      // Not an edit huddle can name: the session is alive, and hears the news.
      event.type = "prompt";
      if (isFileTool(payload)) native.unnamed = { tool: asText(payload.tool_name), fields: fieldNames(payload) };
    }
  } else if (event.type === "post-edit") {
    // afterFileEdit: "file_path": "<absolute path>".
    const path = asText(payload.file_path);
    if (path !== "") event.paths = [path];
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
 * Cursor's pages name no limit for `additional_context`. This is the one used
 * for Codex, the lowest of the limits that are documented; briefings are far
 * smaller.
 */
const MAX_CONTEXT_CHARS = 6000;

/**
 * One line for stderr when an edit could not be named. Without it nothing
 * would ever show that the overlap warnings are missing. Where the line ends
 * up is not verified: the page names a Hooks output channel "to debug
 * configured and executed hooks and see errors", and does not say that a
 * hook's stderr is shown there.
 */
function unnamedTrace(native: Json | null): string {
  const unnamed = asRecord(native?.unnamed);
  if (unnamed === null) return "";
  const fields = Array.isArray(unnamed.fields) ? (unnamed.fields as unknown[]).filter((name): name is string => typeof name === "string") : [];
  const found = fields.length === 0 ? "no fields huddle can read" : `the fields ${fields.join(", ")}`;
  return `huddle: Cursor's ${asText(unnamed.tool)} call did not name its file where huddle looks (file_path, path); its input has ${found}. huddle cannot warn about overlaps on files edited this way. Please report this line.\n`;
}

function format(event: HookEvent, outcome: HookOutcome): HookOutput {
  const native = asRecord(event.native);
  const stderr = unnamedTrace(native);
  const silent: HookOutput = stderr === "" ? SILENT : { ...SILENT, stderr };
  if (typeof outcome.context !== "string" || outcome.context.trim() === "") return silent;
  // Nothing is printed where no field reaches the agent. On stop the only
  // field there is, followup_message, would start another turn; on
  // beforeSubmitPrompt the only ones decide whether the prompt goes through.
  // `unshown` tells the engine so: it leaves what the session was shown as it
  // is, and the same news comes up at the next event that can carry it.
  const nativeEvent = asText(native?.event);
  if (!SPEAKS.has(nativeEvent)) return { ...silent, unshown: true };
  // outcome.env is not used: see the top of the file. And no `permission` or
  // `continue` is ever printed, so huddle neither allows nor blocks anything.
  const output: HookOutput = { stdout: JSON.stringify({ additional_context: clip(outcome.context, MAX_CONTEXT_CHARS) }), stderr, exitCode: 0 };
  // Cursor does not wait for sessionStart's answer (top of the file), so what is said there does not count as said.
  return nativeEvent === "sessionStart" ? { ...output, unshown: true } : output;
}

// ---------------------------------------------------------------------------
// The hooks file
// ---------------------------------------------------------------------------

/**
 * The bundle path goes into a command line for a shell that huddle does not
 * choose, so it is written only when every character is inert in all of them.
 */
const SHELL_INERT = /^[A-Za-z0-9._/-]+$/;

/** The command exactly as handlerFor() writes it, with the bundle path and the event captured. */
const COMMAND = /^node ([A-Za-z0-9._/-]+) hook cursor ([A-Za-z]+)$/;

/**
 * The whole command and nothing else: `node <path>/huddle.mjs hook cursor
 * <event>`, however the path is written. A line of the user's that runs this
 * among other things (`fmt.sh && node ...`, `node ...; notify.sh`), or only
 * mentions it, is theirs.
 */
const OURS = plainCommand(NAME);

const HOOKS_FILE: HookFile = {
  path: HOOKS,
  registrations: REGISTRATIONS,
  flat: true,
  /** "Config schema version. Must be a positive integer (use 1)." */
  version: VERSION,
  agent: NAME,
  /** A handler's `type` is "command" unless it says otherwise, so one that spells it out is the same handler. */
  defaults: { type: "command" },
  /**
   * Project hooks "run from the project root", so the bundle's repo-relative
   * path is enough. Neither `failClosed` nor `loop_limit` is set: a huddle
   * hook that fails must never hold anything up.
   */
  handlerFor(registration, bundle) {
    if (!SHELL_INERT.test(bundle)) {
      throw new TypeError(`cursor: the bundle path ${JSON.stringify(bundle)} cannot be written into a shell command (letters, digits, ".", "_", "-" and "/" only)`);
    }
    const handler: Json = { command: `node ${bundle} hook ${NAME} ${registration.event}`, timeout: registration.timeout };
    if (registration.matcher !== undefined) handler.matcher = registration.matcher;
    return handler;
  },
  isOurs(value) {
    const handler = asRecord(value);
    // `type` is "command" unless it says "prompt", which asks a model and runs nothing.
    return handler !== null && (handler.type === undefined || handler.type === "command") && typeof handler.command === "string" && OURS.test(handler.command);
  },
  bundleOf(handler) {
    return COMMAND.exec(asText(handler.command))?.[1] ?? null;
  },
};

/** What a teammate has to know. init and doctor print these. */
const TRUST_NOTE = "Cursor runs a project's hooks only in a workspace that is trusted.";
const NODE_NOTE =
  "Every teammate needs Node 20 or later on the PATH that Cursor itself sees. An app started outside a shell may not see a node installed by nvm, fnm or volta. Whether the hooks run, and why not, is in Cursor's Hooks output channel.";
const LATER_NOTE =
  "Cursor lets a hook speak to its agent only after a tool call, and when a session starts, where it does not wait for the answer. huddle is called after edits, deletions and shell commands, also when one of them failed. So what changed in the team reaches the agent after its next edit or shell command, not with the prompt. A warning about a file a teammate is working on comes right after the first edit of it, not before.";
const LAST_WINS_NOTE =
  "If another hook answers the same Cursor event with an additional_context of its own, Cursor keeps only one of the answers, and it may not be huddle's.";
const NOTES: readonly string[] = [TRUST_NOTE, NODE_NOTE, LATER_NOTE, LAST_WINS_NOTE];

async function install(opts: InstallOptions): Promise<InstallResult> {
  const { changed, twice } = await installHooks(HOOKS_FILE, opts.repoRoot, opts.bundle);
  const also = twiceNote(HOOKS_FILE, twice);
  return { changed: changed ? [HOOKS] : [], notes: also === null ? [...NOTES] : [...NOTES, also], files: [HOOKS] };
}

// ---------------------------------------------------------------------------
// check and detect
// ---------------------------------------------------------------------------

/** Where to look beyond the repo. Arguments so that tests need not touch the real home directory. */
export interface Surroundings {
  env: NodeJS.ProcessEnv;
  home: string;
}

function here(): Surroundings {
  return { env: process.env, home: homedir() };
}

async function check(repoRoot: string): Promise<CheckResult> {
  const { result, settings, twice } = await checkHooks(HOOKS_FILE, repoRoot);
  if (!result.installed) return result;
  // The hooks are all there, and Cursor still wants a version on the file: the one these entries are written for.
  if (settings !== null && settings.version !== VERSION) {
    const detail =
      settings.version === undefined
        ? `${HOOKS} has no "version", which Cursor requires. Run huddle init.`
        : !isVersion(settings.version)
          ? `${HOOKS} has a "version" that is not a positive whole number, which Cursor requires. Fix the file, then run huddle init.`
          : `${HOOKS} has "version": ${String(settings.version)}, and huddle's hooks in it are written for version ${VERSION}. Whether they work there is not known.`;
    return { installed: false, broken: true, detail, notes: [] };
  }
  const also = twiceNote(HOOKS_FILE, twice);
  return { ...result, notes: also === null ? [...NOTES] : [...NOTES, also] };
}

/** Where the Claude Code adapter keeps its hooks, and its name in huddle's command (claude-code.ts). */
const CLAUDE_SETTINGS = ".claude/settings.json";
const CLAUDE_NAME = "claude-code";

/**
 * detect(), with the surroundings passed in. True on any sign that Cursor is
 * used on this repo or by this user, and wherever huddle's Claude Code hooks
 * are installed, whoever uses Cursor or does not. It leans towards yes: the hook config is
 * committed for the whole team, and one unused file costs less than a
 * teammate whose agent stays invisible.
 *
 * The PATH is not searched. Cursor's command-line agent is a program called
 * `agent`, and a program of that name says nothing about Cursor.
 */
export async function detectCursor(repoRoot: string, around: Surroundings): Promise<boolean> {
  if (await exists(join(repoRoot, ".cursor"))) return true;
  // Cursor runs huddle's Claude Code hooks, and they stand down for it (claude-code.ts). Where they are, these have to be too.
  if (await fileNamesHook(join(repoRoot, CLAUDE_SETTINGS), CLAUDE_NAME)) return true;
  if (asText(around.env.CURSOR_AGENT) !== "") return true; // set in the shells Cursor's agent runs commands in
  return exists(join(around.home, ".cursor")); // the user's own hooks.json and the CLI's config live here
}

export const cursor: Adapter = {
  name: NAME,
  title: "Cursor",
  detect: (repoRoot) => detectCursor(repoRoot, here()),
  install,
  check,
  parse,
  format,
};
