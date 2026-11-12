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
//   postToolUse          pre-edit when the tool edited a    timeout 5, matcher Write|Delete|Shell
//                        file, else prompt without a text
//   afterFileEdit        post-edit                          timeout 5
//   stop                 turn-end                           timeout 5
//   sessionEnd           session-end                        timeout 5
//
// Where Cursor differs from Claude Code, and it matters here:
//
// - A hook can put text in front of the agent in two places only:
//   sessionStart and postToolUse, both through `additional_context`.
//   beforeSubmitPrompt can let the prompt pass or block it and has no field
//   that reaches the agent. So the prompt records the intent and nothing is
//   shown, and what changed in the team comes with the next tool call
//   instead: a postToolUse that is no file edit is handed to the engine as a
//   prompt without a text, which is a sign of life plus the briefing on
//   whatever is new.
// - Nothing can be said before an edit without stopping it. preToolUse's
//   `agent_message` is "fed back to the agent when the action is denied", and
//   preToolUse is one of the hooks where an answer Cursor cannot read blocks
//   the action. huddle never blocks, so it registers no hook before a tool
//   call at all, and the overlap warning comes right after the edit: the
//   postToolUse of an edit is handed to the engine as the pre-edit it could
//   not be. The engine starts no sync on a pre-edit, so afterFileEdit, which
//   can say nothing to anyone, is registered as well and is the post-edit
//   that gets the edit published.
// - Which file a tool edited is not documented for postToolUse: the page
//   shows `tool_input` for Shell only. It is read as `file_path`, the name
//   every documented Cursor payload uses for a file (afterFileEdit,
//   beforeReadFile), then as `path`. If Cursor calls it something else, an
//   edit still counts as a sign of life and brings the news, and no overlap
//   warning is ever given.
// - No hook can be asynchronous: Cursor waits for each one. So postToolUse is
//   registered for the tools that change things and not for Read or Grep,
//   and an edit costs two short processes.
// - A handler is a command line, run from the project root, by PowerShell on
//   Windows. `node <bundle> hook cursor <event>` reads the same in every
//   shell, which a check for node or for the bundle would not. Where either
//   is missing the command fails, and for the hooks registered here Cursor
//   then carries on ("Hook failed, action proceeds").
// - The event comes from the command line, not from the payload: Cursor ran
//   the command it found under that event.
// - The session id is `conversation_id`, which every hook carries;
//   `session_id` on sessionStart and sessionEnd is "same as conversation_id".
// - `env` returned from sessionStart reaches later hooks, not the agent's
//   shell, so HUDDLE_SESSION is not passed on. `huddle intent` typed by the
//   agent finds the session anyway: it is the one last active in the worktree.
// - Cloud agents run a project's hooks, but not sessionStart and sessionEnd.
//   A session there appears with its first prompt and ages out.
// - Which conversation_id a subagent's tool calls carry is not documented.
//   Whatever id an event carries is its session.
// - Cursor also runs Claude Code's hooks from .claude/settings.json unless
//   that is switched off. claude-code.ts stands down for a payload that is
//   Cursor's, so that one Cursor session is not handled by two adapters.

import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, asText, checkHooks, clip, exists, installHooks, isVersion } from "./json-hooks.ts";
import type { Check, HookFile, Installed, Json, Registration } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, HookEvent, HookInput, HookOutcome, HookOutput, InstallOptions } from "./types.ts";

const NAME = "cursor";
const HOOKS = ".cursor/hooks.json";

/**
 * The tools whose postToolUse huddle wants: the two that change a file by
 * name, and the shell, which is how a session that edits nothing still shows
 * as alive. A matcher is a regular expression tested against the tool type;
 * this one is in the form of the page's own example ("Shell|Read|Write").
 */
const AFTER_TOOLS = "Write|Delete|Shell";

const REGISTRATIONS: readonly Registration[] = [
  { event: "sessionStart", type: "session-start", timeout: 10 },
  { event: "beforeSubmitPrompt", type: "prompt", timeout: 5 },
  { event: "postToolUse", type: "pre-edit", timeout: 5, matcher: AFTER_TOOLS },
  // No matcher: this event is "matched against the value Write" and nothing else.
  { event: "afterFileEdit", type: "post-edit", timeout: 5 },
  { event: "stop", type: "turn-end", timeout: 5 },
  { event: "sessionEnd", type: "session-end", timeout: 5 },
];

const REGISTERED = new Map<string, Registration>(REGISTRATIONS.map((registration) => [registration.event, registration]));

/** The events whose answer has a field that reaches the agent. */
const SPEAKS: ReadonlySet<string> = new Set(["sessionStart", "postToolUse"]);

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

/** The file a tool changed, or [] when the tool is not one that names a file or the name is not where this looks. */
function editedPaths(payload: Json): string[] {
  if (!FILE_TOOLS.includes(asText(payload.tool_name))) return [];
  const input = toolInput(payload.tool_input);
  if (input === null) return [];
  const path = asText(input.file_path) || asText(input.path);
  return path === "" ? [] : [path];
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
    native: { event: registration.event },
  };

  if (event.type === "session-end") {
    const reason = asText(payload.reason);
    if (reason !== "") event.reason = reason;
  } else if (event.type === "prompt") {
    const prompt = asText(payload.prompt).trim();
    if (prompt !== "") event.prompt = prompt;
  } else if (event.type === "pre-edit") {
    const paths = editedPaths(payload);
    // Not an edit huddle can name: the session is alive, and may hear the news.
    if (paths.length === 0) event.type = "prompt";
    else event.paths = paths;
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
 * `unshown`: format() was given a context and this event has no way to put it
 * in front of the agent. The engine is meant to leave what the session was
 * shown as it is, so that the same news comes up at the next event that can
 * carry it. The field is not in HookOutput yet; until the engine reads it, a
 * briefing built at a prompt is used up unseen.
 */
type Output = HookOutput & { unshown?: boolean };

function format(event: HookEvent, outcome: HookOutcome): Output {
  if (typeof outcome.context !== "string" || outcome.context.trim() === "") return SILENT;
  // Nothing is printed where no field reaches the agent. On stop the only
  // field there is, followup_message, would start another turn; on
  // beforeSubmitPrompt the only ones decide whether the prompt goes through.
  if (!SPEAKS.has(asText(asRecord(event.native)?.event))) return { ...SILENT, unshown: true };
  // outcome.env is not used: see the top of the file. And no `permission` or
  // `continue` is ever printed, so huddle neither allows nor blocks anything.
  return { stdout: JSON.stringify({ additional_context: clip(outcome.context, MAX_CONTEXT_CHARS) }), stderr: "", exitCode: 0 };
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
 * Any command that runs a file named exactly huddle.mjs as `hook cursor`,
 * however the path is written: an older install, or one edited by hand.
 */
const OURS = /(?:^|[\s"'\\/])huddle\.mjs["']?\s+hook\s+cursor(?![\w-])/;

const HOOKS_FILE: HookFile = {
  path: HOOKS,
  registrations: REGISTRATIONS,
  flat: true,
  /** "Config schema version. Must be a positive integer (use 1)." */
  version: 1,
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
  "Cursor lets a hook speak to its agent only when a session starts and after a tool call. So what changed in the team reaches the agent with its next tool call rather than with the prompt, and a warning about a file a teammate is working on comes right after the first edit of it, not before.";
const NOTES: readonly string[] = [TRUST_NOTE, NODE_NOTE, LATER_NOTE];

async function install(opts: InstallOptions): Promise<Installed> {
  const changed = await installHooks(HOOKS_FILE, opts.repoRoot, opts.bundle);
  return { changed: changed ? [HOOKS] : [], notes: [...NOTES], files: [HOOKS] };
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

async function check(repoRoot: string): Promise<Check> {
  const { result, settings } = await checkHooks(HOOKS_FILE, repoRoot);
  if (!result.installed) return result;
  // The hooks are all there, and Cursor still wants a version on the file.
  if (settings !== null && !isVersion(settings.version)) {
    const detail =
      settings.version === undefined
        ? `${HOOKS} has no "version", which Cursor requires. Run huddle init.`
        : `${HOOKS} has a "version" that is not a positive whole number, which Cursor requires. Fix the file, then run huddle init.`;
    return { installed: false, broken: true, detail, notes: [] };
  }
  return { ...result, notes: [...NOTES] };
}

/**
 * detect(), with the surroundings passed in. True on any sign that Cursor is
 * used on this repo or by this user. It leans towards yes: the hook config is
 * committed for the whole team, and one unused file costs less than a
 * teammate whose agent stays invisible.
 *
 * The PATH is not searched. Cursor's command-line agent is a program called
 * `agent`, and a program of that name says nothing about Cursor.
 */
export async function detectCursor(repoRoot: string, around: Surroundings): Promise<boolean> {
  if (await exists(join(repoRoot, ".cursor"))) return true;
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
