// T3.5. The opencode adapter.
//
// opencode has no hooks file. What it has is plugins: JavaScript that it loads
// into its own process and calls at certain points. So `huddle init` writes
// one small plugin, .opencode/plugins/huddle.js, and that plugin does what a
// hook command does for the other agents: it runs
//
//   node .huddle/huddle.mjs hook opencode
//
// with one JSON object on stdin and reads one JSON object from stdout. This
// file holds both ends: the plugin's text (pluginSource) and the adapter that
// answers it (parse, format).
//
// Sources, read on 2026-11-12. Nothing here was run against a real opencode.
//   https://opencode.ai/docs/plugins/ and /docs/build/plugins/server/ (opencode 2)
//   github.com/anomalyco/opencode at v2.2.7 (fedc6f2) and v1.19.5 (810c0eb):
//     v2  packages/core/src/plugin/{module,source-directory,hooks}.ts,
//         packages/plugin/src/promise/{adapter,session,tool,shell}.ts,
//         packages/core/src/{tool.ts,session/prompt.ts,session/runner/llm.ts}
//     v1  packages/opencode/src/plugin/{index,shared}.ts, packages/plugin/src/index.ts,
//         packages/opencode/src/session/{prompt,tools,status}.ts
//
// Two majors, one file. `opencode.ai/install` and npm's opencode-ai@latest
// still give opencode 1 (1.19.5); opencode 2 has its own installer and its own
// plugin API. The docs' recipe for a plugin that serves both is one default
// export { id, setup, server }: opencode 2 calls setup(ctx), opencode 1 calls
// server(input) and takes the hooks it returns. opencode 1 reads that form
// from 1.18.29 on; an older one logs "Plugin export is not a function" and
// leaves the plugin out.
//
// Trust. Neither major asks before it loads a project's plugins. Both load
// every .js and .ts file in .opencode/plugins/ of the session's directory and
// of the directories above it, so whoever opens the repository in opencode
// runs huddle.js at once. This is the one adapter where huddle commits code
// that an agent loads, and its notes say so.
//
// What the plugin sends (hook_event_name), and what becomes of it here:
//
//   start    session-start   the first prompt of a session this plugin instance
//                            has not seen, and the first one after a compaction.
//                            opencode has no hook for a session's start.
//   prompt   prompt          v2 session.hook("prompt"), v1 "chat.message"
//   tool     post-edit       after edit, write, patch (v2) or apply_patch (v1),
//                            with the files the call named; see "Edits".
//                            Without files after any other tool that does more
//                            than read: a sign of life.
//            pre-edit        a subagent's edit, with its files; see "Subagents"
//   idle     turn-end        v2 session.hook("experimental.idle"), v1 the
//                            session.status event with status idle
//   end      session-end     opencode disposes the plugin: v1 when it quits,
//                            v2 when its server stops or reloads the plugin
//
// How the model gets what huddle says. With a prompt: opencode 2 is handed a
// synthetic message (ctx.session.synthetic with resume: false, so that it is
// read with the prompt and does not start a turn of its own), opencode 1 gets
// one more text part, marked synthetic, on the user's own message. After an
// edit: the text is appended to the tool's result.
//
// Edits. A plugin that runs before a tool call can replace the call's input or
// reject the call and nothing else, in both majors. huddle never blocks, so no
// hook before a tool call is registered at all, and on opencode THE AGENT
// HEARS OF AN OVERLAP RIGHT AFTER ITS EDIT, WITH THE EDIT'S RESULT, NOT BEFORE
// IT. That is the engine's post-edit with the files of the edit: it gives the
// warning the session has not had yet for those files, once, and it asks for
// the sync that publishes the edit.
//
// Waiting. opencode waits for its hooks inline. The plugin therefore waits
// only where an answer can come back (start, prompt, the edit tools) and lets
// every other process go without reading it. What the engine says on such an
// event has no reader, and format() reports it as unshown.
//
// Subagents. A subagent runs in a child session with an id of its own and a
// parentID. The engine expects subagents under their parent's id, so the
// plugin walks up to the top session (one API call per session, remembered)
// and sends that id with subagent: true. A child's prompt and idle are not
// sent. The engine warns a subagent on a pre-edit and on nothing else (each
// time, and without remembering it: a subagent's context is its own), so a
// subagent's edit is handed over as a pre-edit, after the fact.
//
// A hook that throws is not harmless in opencode: v2 turns a throw after a
// tool call into a defect and v1 does the same for every hook. Every hook body
// in the plugin is wrapped, and every failure of the command (no node, no
// bundle, a crash, a timeout, output that is not JSON) ends in "do nothing".
//
// Not done: HUDDLE_SESSION on opencode 2. Its shell hook runs before opencode
// puts the session id into the environment and is not told the session.
// opencode 1 has "shell.env" with the session id, and gets it.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "../core/io.ts";
import { asRecord, asText, bundlePath, exists, onPath, placeOf, reason, writeWhole } from "./json-hooks.ts";
import type { Check, Installed, Json } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, HookEvent, HookEventType, HookInput, HookOutcome, HookOutput, InstallOptions } from "./types.ts";

const NAME = "opencode";

/** Where the plugin goes: the directory both majors load project plugins from. */
export const PLUGIN = ".opencode/plugins/huddle.js";

/** The tools that write the files they name: edit, write and patch in opencode 2; edit, write and apply_patch in opencode 1. */
const EDIT_TOOLS: readonly string[] = ["edit", "write", "patch", "apply_patch"];

/** The tools of the two tags that only read, ask or take notes. Nothing is run after them. */
const READ_ONLY_TOOLS: readonly string[] = ["read", "glob", "grep", "lsp", "question", "skill", "todowrite", "webfetch", "websearch", "invalid"];

const TYPES: Readonly<Record<string, HookEventType>> = Object.freeze({
  start: "session-start",
  prompt: "prompt",
  tool: "post-edit",
  idle: "turn-end",
  end: "session-end",
});

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/** The first line of the plugin. A huddle.js that does not start with it is someone else's. */
const MARKER = "// Generated by huddle init. Do not edit: huddle init writes this file again, and what you changed is lost.";

/** A bundle path that can stand in a JavaScript string and in a URL as it is. */
const PLAIN_PATH = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;

const list = (names: readonly string[]): string => names.map((name) => JSON.stringify(name)).join(", ");

/**
 * The text of .opencode/plugins/huddle.js for a bundle at this repo-relative
 * path. Plain JavaScript, an ES module, node built-ins only.
 */
export function pluginSource(bundle: string): string {
  if (!PLAIN_PATH.test(bundle) || bundle.split("/").includes("..")) {
    throw new TypeError(`opencode: the bundle path ${JSON.stringify(bundle)} cannot be written into the plugin (letters, digits, ".", "_", "-" and "/" only)`);
  }
  return String.raw`${MARKER}
// To turn huddle off for opencode, delete this file.
//
// opencode loads this file by itself, in every session in this repository. What it does there:
// when a prompt is sent, after a tool call, when a turn ends and when opencode closes, it runs
//
//     node ${bundle} hook opencode
//
// in the session's directory, with one JSON object on stdin, and gives the model what that
// prints: what teammates' agents are working on, and a warning when an edit overlaps their
// work. It runs nothing else, reads nothing else and sends nothing anywhere itself. When node
// or ${bundle} is missing, or the command fails or takes too long, it does nothing.
//
// One default export for both plugin APIs: opencode 2 calls setup(), opencode 1 (1.18.29 or
// later) calls server().
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUNDLE_PATH = ${JSON.stringify(bundle)};
// This file is <repository>/.opencode/plugins/huddle.js.
const BUNDLE = fileURLToPath(new URL("../../" + BUNDLE_PATH, import.meta.url));

// The tools that write files. Their hook is waited for: a warning goes into their result.
const EDITS = [${list(EDIT_TOOLS)}];
// The tools that only read. Nothing is run after them.
const READS = [${list(READ_ONLY_TOOLS)}];
// How long an answer is waited for, in milliseconds. huddle has shorter limits of its own;
// these are for a process that hangs.
const START_MS = 8000;
const ANSWER_MS = 3000;
// What the user sees in the transcript where the model was told something (opencode 2).
const NOTE = "huddle: what teammates' agents are working on";

// Runs the command with the payload on stdin. With a time to wait, resolves to what it
// printed, as an object; without one, lets the process go. Never rejects and never throws.
function send(payload, wait) {
  return new Promise((resolve) => {
    try {
      if (!existsSync(BUNDLE)) return resolve({});
      const child = spawn("node", [BUNDLE, "hook", "opencode"], {
        cwd: payload.cwd,
        stdio: ["pipe", wait ? "pipe" : "ignore", "ignore"],
        detached: !wait,
        windowsHide: true,
      });
      let printed = "";
      const timer = wait
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {}
            resolve({});
          }, wait)
        : undefined;
      child.on("error", () => {
        clearTimeout(timer);
        resolve({});
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(payload));
      if (!wait) {
        child.unref();
        return resolve({});
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        printed += chunk;
      });
      child.on("close", () => {
        clearTimeout(timer);
        let answer;
        try {
          answer = JSON.parse(printed);
        } catch {}
        resolve(typeof answer === "object" && answer !== null ? answer : {});
      });
    } catch {
      resolve({});
    }
  });
}

const contextOf = (answer) => (typeof answer.context === "string" ? answer.context.trim() : "");

// A hook that throws is not harmless in opencode. None of these does.
const quiet = (hook) => async (...args) => {
  try {
    await hook(...args);
  } catch {}
};

// What one opencode instance has seen in one directory. parentOf asks opencode for a
// session's parent.
function huddle(cwd, parentOf) {
  // session id -> who that is: the session at the top, and whether this one is a subagent's
  const known = new Map();
  // the top sessions that were started here -> the environment huddle wants their shells to have
  const started = new Map();

  function who(sessionID) {
    if (typeof sessionID !== "string" || sessionID === "") return Promise.resolve(null);
    if (!known.has(sessionID)) {
      const found = (async () => {
        let id = sessionID;
        for (let up = 0; up < 10; up++) {
          const parent = await parentOf(id);
          if (typeof parent !== "string" || parent === "") break;
          id = parent;
        }
        return { id, sub: id !== sessionID };
      })().catch(() => {
        // Not known this time; asked again at the session's next event.
        known.delete(sessionID);
        return null;
      });
      known.set(sessionID, found);
    }
    return known.get(sessionID);
  }

  const payload = (event, session, more) => ({
    hook_event_name: event,
    session_id: session.id,
    cwd,
    ...(session.sub ? { subagent: true } : {}),
    ...more,
  });

  return {
    // A prompt was sent. Resolves to what the model should read with it, or "".
    async prompt(sessionID, prompt) {
      const session = await who(sessionID);
      if (session === null || session.sub) return "";
      const said = [];
      if (!started.has(session.id)) {
        started.set(session.id, {});
        const answer = await send(payload("start", session), START_MS);
        if (typeof answer.env === "object" && answer.env !== null) started.set(session.id, answer.env);
        said.push(contextOf(answer));
      }
      said.push(contextOf(await send(payload("prompt", session, { prompt }), ANSWER_MS)));
      return said.filter((text) => text !== "").join("\n\n");
    },

    // A tool call ended. Resolves to what the model should read with its result, or "".
    async tool(sessionID, tool, input) {
      if (READS.includes(tool)) return "";
      const session = await who(sessionID);
      if (session === null) return "";
      if (!EDITS.includes(tool)) {
        void send(payload("tool", session, { tool }), 0);
        return "";
      }
      // Only what names the files: not what was written into them.
      const { path, filePath, patchText } = typeof input === "object" && input !== null ? input : {};
      return contextOf(await send(payload("tool", session, { tool, input: { path, filePath, patchText } }), ANSWER_MS));
    },

    // The session has nothing more to do for now.
    async idle(sessionID) {
      const session = await who(sessionID);
      if (session !== null && !session.sub) void send(payload("idle", session), 0);
    },

    // The session's context was compacted: what it was told is gone, so its next prompt starts over.
    async compacted(sessionID) {
      const session = await who(sessionID);
      if (session !== null && !session.sub) started.delete(session.id);
    },

    // The environment for a shell of this session.
    async env(sessionID) {
      const session = await who(sessionID);
      return (session !== null && started.get(session.id)) || {};
    },

    // opencode is closing, or unloading this plugin.
    close() {
      for (const id of started.keys()) void send(payload("end", { id, sub: false }), 0);
      started.clear();
    },
  };
}

// ---------------------------------------------------------------- opencode 2

async function setup(ctx) {
  const state = huddle(ctx.location.directory, async (id) => (await ctx.session.get({ sessionID: id })).parentID);
  // One registration that fails does not take the others with it.
  const register = async (add) => {
    try {
      await add();
    } catch {}
  };

  await register(() =>
    ctx.session.hook(
      "prompt",
      quiet(async (event) => {
        const context = await state.prompt(event.sessionID, event.prompt?.text);
        if (context === "") return;
        // resume: false, or the message would start a turn of its own before the prompt is in.
        await ctx.session.synthetic({ sessionID: event.sessionID, text: context, description: NOTE, delivery: event.delivery, resume: false });
      }),
    ),
  );

  await register(() =>
    ctx.tool.hook(
      "execute.after",
      quiet(async (event) => {
        if (event.status !== "completed") return;
        const context = await state.tool(event.sessionID, event.tool, event.input);
        if (context === "") return;
        const result = event.result ?? {};
        const output = typeof result.output === "string" ? result.output : (JSON.stringify(result.output) ?? String(result.output));
        // What the model reads is content; when a tool gives none, opencode shows its output.
        const content =
          typeof result.content === "string"
            ? [{ type: "text", text: result.content }]
            : Array.isArray(result.content) && result.content.length > 0
              ? result.content
              : [{ type: "text", text: output }];
        event.result = { ...result, content: [...content, { type: "text", text: context }] };
      }),
    ),
  );

  await register(() => ctx.session.hook("experimental.idle", quiet((event) => state.idle(event.sessionID))));
  await register(() => ctx.session.hook("compaction", quiet((event) => state.compacted(event.sessionID))));

  return () => {
    try {
      state.close();
    } catch {}
  };
}

// ---------------------------------------------------------------- opencode 1

// An id for a message part in opencode 1's form: "prt_", twelve hex digits of time and count,
// fourteen characters of chance. It sorts after the parts the message already has.
function partId() {
  const stamp = (BigInt(Date.now()) * 4096n + 4095n) & 0xffffffffffffn;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let tail = "";
  for (let at = 0; at < 14; at++) tail += chars[Math.floor(Math.random() * chars.length)];
  return "prt_" + stamp.toString(16).padStart(12, "0") + tail;
}

async function server(input) {
  // A session the client cannot find comes back without data, and this throws: not known.
  const state = huddle(input.directory, async (id) => (await input.client.session.get({ path: { id } })).data.parentID);

  return {
    "chat.message": quiet(async (message, output) => {
      if (!Array.isArray(output?.parts)) return;
      const typed = output.parts.filter((part) => part?.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored);
      const context = await state.prompt(message?.sessionID, typed.map((part) => part.text).join("\n"));
      if (context === "" || typeof output.message?.id !== "string") return;
      // One more part of the user's own message, which the model reads and the user is not shown as theirs.
      output.parts.push({ id: partId(), sessionID: message.sessionID, messageID: output.message.id, type: "text", text: context, synthetic: true });
    }),

    "tool.execute.after": quiet(async (call, output) => {
      const context = await state.tool(call?.sessionID, call?.tool, call?.args);
      if (context !== "" && typeof output?.output === "string") output.output += "\n\n" + context;
    }),

    "shell.env": quiet(async (shell, output) => {
      if (typeof output?.env !== "object" || output.env === null) return;
      for (const [name, value] of Object.entries(await state.env(shell?.sessionID))) {
        if (typeof value === "string") output.env[name] = value;
      }
    }),

    event: quiet(async ({ event }) => {
      const sessionID = event?.properties?.sessionID;
      if (event?.type === "session.status" && event.properties?.status?.type === "idle") await state.idle(sessionID);
      if (event?.type === "session.compacted") await state.compacted(sessionID);
    }),

    dispose: quiet(async () => state.close()),
  };
}

export default { id: "huddle", setup, server };
`;
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):(.*)$/;

/** The files a patch names: the paths of its "*** Add File:", "*** Update File:", "*** Delete File:" and "*** Move to:" lines. */
export function patchedPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n|\r/)) {
    const path = PATCH_HEADER.exec(line)?.[1]?.trim() ?? "";
    if (path !== "") paths.push(path);
  }
  return paths;
}

/**
 * The files an edit tool was called on, as the model wrote them: absolute, or
 * relative to the session's directory, which is the payload's cwd. `path` is
 * opencode 2's name for it and `filePath` opencode 1's; a patch names its
 * files in its text.
 */
function editedPaths(input: Json | null): string[] {
  if (input === null) return [];
  const named = [asText(input.path), asText(input.filePath), ...patchedPaths(asText(input.patchText))];
  return [...new Set(named.map((path) => path.trim()).filter((path) => path !== ""))];
}

function parsePayload(input: HookInput): HookEvent | null {
  const payload = asRecord(JSON.parse(input.stdin));
  if (payload === null) return null;
  const nativeEvent = asText(payload.hook_event_name);
  const sessionId = asText(payload.session_id).trim();
  const type = Object.hasOwn(TYPES, nativeEvent) ? TYPES[nativeEvent] : undefined;
  if (type === undefined || sessionId === "") return null;

  const tool = nativeEvent === "tool" ? asText(payload.tool) : "";
  const editing = EDIT_TOOLS.includes(tool);
  const event: HookEvent = {
    type,
    agent: NAME,
    sessionId,
    cwd: asText(payload.cwd) || input.cwd,
    // answered: the plugin waits for what is printed on this event and hands it to the model.
    native: { event: nativeEvent, answered: nativeEvent === "start" || nativeEvent === "prompt" || editing },
  };
  if (payload.subagent === true) event.subagent = true;

  if (nativeEvent === "prompt") {
    const prompt = asText(payload.prompt).trim();
    if (prompt !== "") event.prompt = prompt;
  }
  if (editing) {
    const paths = editedPaths(asRecord(payload.input));
    // An edit tool that named no file is a sign of life like any other tool.
    if (paths.length > 0) {
      event.paths = paths;
      // The session's own edit stays a post-edit: with its files, that is the warning and the edit's sync.
      // A subagent is warned on a pre-edit only.
      if (event.subagent === true) event.type = "pre-edit";
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
// format
// ---------------------------------------------------------------------------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The variables of an outcome that can be handed to a shell as they are. */
function envOf(env: unknown): Record<string, string> | null {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(asRecord(env) ?? {})) {
    if (ENV_NAME.test(name) && typeof value === "string" && !/[\0\r\n]/.test(value)) kept[name] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * What the plugin reads: one JSON object, { context?, env? }. Printed only on
 * the events whose answer the plugin waits for; a context on any other event
 * has no reader, and is reported as unshown so that the engine brings it up
 * again.
 */
function format(event: HookEvent, outcome: HookOutcome): HookOutput {
  if (event.type === "turn-end" || event.type === "session-end") return SILENT;
  const context = typeof outcome.context === "string" && outcome.context.trim() !== "" ? outcome.context : "";
  if (asRecord(event.native)?.answered !== true) return context === "" ? SILENT : { ...SILENT, unshown: true };
  const env = envOf(outcome.env);
  if (context === "" && env === null) return SILENT;
  const answer: Json = {};
  if (context !== "") answer.context = context;
  if (env !== null) answer.env = env;
  return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// install, check, detect
// ---------------------------------------------------------------------------

const TRUST_NOTE = `opencode does not ask before it loads a project's plugins: everyone who opens this repository in opencode runs ${PLUGIN} at once. That file is committed with the repository; all it does is run the huddle bundle that is committed next to it. Review it like any other code.`;

const NODE_NOTE =
  "The plugin starts node: node 20 or later has to be on the PATH that opencode sees. Without it the plugin does nothing and says nothing. It needs opencode 1.18.29 or later, or opencode 2.";

const WHEN_NOTE =
  "On opencode the agent gets the briefing with the first prompt of a session and news from teammates with each later prompt. It hears of an overlap with a teammate right after its edit, with the edit's result, not before it: a plugin that runs before an edit can change the call or refuse it, but cannot tell the model anything and let the edit go ahead.";

export const NOTES: readonly string[] = Object.freeze([TRUST_NOTE, NODE_NOTE, WHEN_NOTE]);

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A checkout may hold the file with CRLF line ends (git's autocrlf); that is the same file. */
const unix = (text: string): string => text.replace(/\r\n/g, "\n");

const isOurs = (text: string): boolean => text.startsWith(MARKER);

// With the m flag "$" stands before a carriage return as well, so a copy with CRLF line ends is read the same way.
const BUNDLE_LINE = /^const BUNDLE_PATH = ("[^"\\\r\n]*");$/m;

/** The repo-relative bundle a plugin written by huddle runs, or null when it does not say. */
function bundleOf(text: string): string | null {
  const literal = BUNDLE_LINE.exec(text)?.[1];
  if (literal === undefined) return null;
  const bundle: unknown = JSON.parse(literal);
  return typeof bundle === "string" && PLAIN_PATH.test(bundle) && !bundle.split("/").includes("..") ? bundle : null;
}

/**
 * The plugin is written where the hook files of the other agents are (the
 * shared code in json-hooks.ts): into the checkout and nowhere else. A link
 * at the file's place that stays inside the checkout is written through; one
 * that leads out of it, or nowhere, is refused, and so is a directory on the
 * way that does. This file is code that opencode runs: out there git would
 * store the link and not the file, and whatever else uses that directory
 * would load it.
 *
 * `files` names the plugin on every run, changed or not: it is the file the
 * team commits, and init keeps saying so until it is.
 */
async function install(opts: InstallOptions): Promise<Installed> {
  const wanted = pluginSource(bundlePath(opts.bundle));
  let target: string;
  let before: string | null;
  try {
    target = await placeOf({ path: PLUGIN }, opts.repoRoot);
    before = await readText(target);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${PLUGIN} could not be read (${reason(error)}), so huddle left it alone.`);
  }
  if (before !== null && unix(before) === wanted) return { changed: [], notes: [...NOTES], files: [PLUGIN] };
  if (before !== null && !isOurs(before)) {
    throw new CliError(`${PLUGIN} is there and was not written by huddle. huddle will not overwrite it: move it away, then run huddle init again.`);
  }
  try {
    await writeWhole(target, wanted, PLUGIN);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${PLUGIN} could not be written (${reason(error)}).`);
  }
  return { changed: [PLUGIN], notes: [...NOTES], files: [PLUGIN] };
}

/**
 * `broken`: a plugin of huddle's is there and cannot be relied on as it is
 * (not what this version writes, or its bundle is gone), which doctor warns
 * about. A plugin that is missing, or somebody else's file in its place, is
 * huddle not installed, which doctor only mentions.
 */
async function check(repoRoot: string): Promise<Check> {
  const no = (detail: string, broken = false): Check => (broken ? { installed: false, broken: true, detail, notes: [] } : { installed: false, detail, notes: [] });
  let text: string | null;
  try {
    // Where init would write. A link that leads nowhere or out of the checkout is init's reason to refuse, and doctor's to say so.
    text = await readText(await placeOf({ path: PLUGIN }, repoRoot));
  } catch (error) {
    if (error instanceof CliError) return no(error.message);
    return no(`${PLUGIN} cannot be read (${reason(error)}).`);
  }
  if (text === null) return no(`${PLUGIN} not found. Run huddle init.`);
  if (!isOurs(text)) return no(`${PLUGIN} is there and was not written by huddle. Move it away, then run huddle init.`);
  const bundle = bundleOf(text);
  if (bundle === null || unix(text) !== pluginSource(bundle)) return no(`${PLUGIN} is not what this version installs. Run huddle init.`, true);
  if (!(await exists(join(repoRoot, bundle)))) return no(`${PLUGIN} runs ${bundle}, which is not in this checkout. Run huddle init.`, true);
  return { installed: true, detail: `plugin in ${PLUGIN}`, notes: [...NOTES], files: [PLUGIN] };
}

export interface Surroundings {
  env: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
}

function here(): Surroundings {
  return { env: process.env, home: homedir(), platform: process.platform };
}

/** The user's own opencode directory: OPENCODE_CONFIG_DIR, or opencode under XDG_CONFIG_HOME or ~/.config. */
function userConfigDir(around: Surroundings): string {
  return asText(around.env.OPENCODE_CONFIG_DIR) || join(asText(around.env.XDG_CONFIG_HOME) || join(around.home, ".config"), "opencode");
}

/**
 * detect(), with the surroundings passed in. True on any sign that opencode is
 * used on this repo or by this user. It leans towards yes, as the other
 * adapters do: the plugin is committed for the whole team, and one unused file
 * costs less than a teammate whose agent stays invisible.
 */
export async function detectOpencode(repoRoot: string, around: Surroundings): Promise<boolean> {
  for (const sign of [".opencode", "opencode.json", "opencode.jsonc"]) {
    if (await exists(join(repoRoot, sign))) return true;
  }
  if (await exists(userConfigDir(around))) return true;
  const names = around.platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"];
  return onPath(names, around.env);
}

export const opencode: Adapter = {
  name: NAME,
  title: "opencode",
  detect: (repoRoot) => detectOpencode(repoRoot, here()),
  install,
  check,
  parse,
  format,
};
