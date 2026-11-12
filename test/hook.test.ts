// T2.1: `huddle hook <agent>`, from an agent's payload on stdin to what the
// hook process prints and how it exits (runHook in src/hooks/engine.ts, and
// src/commands/hook.ts). First in this process, replaying the payloads that
// were recorded from Claude Code and Codex. Then through the built bundle, the
// way an agent runs it: the budgets on the clock, a git that hangs, syncs in
// processes of their own, a crash. What the engine does with each event is in
// engine.test.ts.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ADAPTERS, getAdapter } from "../src/adapters/index.ts";
import type { Adapter, HookEvent, HookEventType } from "../src/adapters/types.ts";
import { run as hookCommand, limitLifetime } from "../src/commands/hook.ts";
import { seenFile } from "../src/core/paths.ts";
import { OVERLAP_HINT } from "../src/core/render.ts";
import { DEADLINE_MS, appendLines, lifetimeMs, runHook } from "../src/hooks/engine.ts";
import { toIntent } from "../src/hooks/intent.ts";
import {
  ALONE,
  AUTH_PROMPT,
  DELTA_HEAD,
  FULL_FOOT,
  FULL_HEAD,
  NOTHING_ASKED,
  ON_THE_CLOCK,
  PATIENCE,
  SAY_SO,
  ago,
  aliceBuildsAuth,
  aliceLine,
  at,
  authWarning,
  eventOf,
  fire,
  forced,
  ioFor,
  logOf,
  overlapHead,
  publish,
  published,
  record,
  seenKeys,
  sessionOf,
  sessionsOf,
  sleep,
  syncIdle,
  team,
  text,
  throttled,
  timed,
  until,
} from "./engine.kit.ts";
import type { Team } from "./engine.kit.ts";
import { BUNDLE, BUNDLE_NODE } from "./harness.ts";
import type { CleanupHost, Clone, RunResult } from "./harness.ts";

type Json = Record<string, unknown>;
type Agent = "claude-code" | "codex";

const ALL_TYPES: HookEventType[] = ["session-start", "prompt", "pre-edit", "post-edit", "turn-end", "session-end"];

// ---------------------------------------------------------------------------
// The recorded payloads
// ---------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL("./fixtures/hooks/", import.meta.url));
/** The project directory in the recordings; see the README next to them. */
const RECORDED_IN = "/home/dev/acme";

function fixture(agent: Agent, name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, agent, `${name}.json`), "utf8")) as Json;
}

/**
 * A recorded payload as stdin, as it would have been recorded in `where` (a
 * clone, or any directory): the recording's project directory becomes that
 * one. `over` replaces fields of the payload.
 */
function recorded(agent: Agent, name: string, where: Clone | string, over: Json = {}): string {
  const dir = typeof where === "string" ? where : where.dir;
  const moved = (value: unknown): unknown => {
    if (typeof value === "string") return value.split(RECORDED_IN).join(dir);
    if (Array.isArray(value)) return value.map(moved);
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, moved(inner)]));
    return value;
  };
  return JSON.stringify({ ...(moved(fixture(agent, name)) as Json), ...over });
}

/** The session most of the Claude Code recordings are of, another one of its sessions, and the session of the Codex recordings. */
const CLAUDE_SESSION = String(fixture("claude-code", "session-start.startup").session_id);
const OTHER_CLAUDE_SESSION = String(fixture("claude-code", "session-start.resume").session_id);
const CODEX_SESSION = String(fixture("codex", "session-start.startup").session_id);

const SIX_OF_CLAUDE: Array<[HookEventType, string]> = [
  ["session-start", "session-start.startup"],
  ["prompt", "user-prompt-submit.typed"],
  ["pre-edit", "pre-tool-use.write"],
  ["post-edit", "post-tool-use.write"],
  ["turn-end", "stop"],
  ["session-end", "session-end"],
];

// ---------------------------------------------------------------------------
// Running a hook
// ---------------------------------------------------------------------------

interface Ran {
  code: number;
  /** One entry per line printed. */
  stdout: string[];
  stderr: string[];
}

const SILENT: Ran = { code: 0, stdout: [], stderr: [] };
const QUIET: RunResult = { code: 0, stdout: "", stderr: "" };

/** The one JSON object both agents read context from. Spelled out here: it is what they parse. */
const contextJson = (event: string, context: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
/** In this process: exit code 0 and that object on stdout, nothing else. */
const says = (event: string, context: string): Ran => ({ code: 0, stdout: [contextJson(event, context)], stderr: [] });
/** Through the bundle: the same, as the text that arrives on the pipe. */
const prints = (event: string, context: string): RunResult => ({ code: 0, stdout: `${contextJson(event, context)}\n`, stderr: "" });

/** `huddle hook <agent>` in this process, in the clone, with `stdin` and the clock at T0 + `seconds`. */
async function hook(clone: Clone, agent: string, stdin: string, seconds: number, env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  const io = ioFor(clone, { now: at(seconds), stdin, env });
  const code = await runHook([agent], io);
  return { code, stdout: io.stdout, stderr: io.stderr };
}

interface Exited {
  /** Null when the process had to be killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Starts a node process in `cwd` and says what to do with its stdin: `stdin`
 * is written to it, and the pipe is closed only when `end` is set. An agent
 * may keep the pipe open for as long as its hook runs.
 */
function start(node: string, args: string[], cwd: string, stdin: { text?: string; end: boolean }, env: NodeJS.ProcessEnv = {}): Promise<Exited> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(node, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - started });
    });
    child.stdin.on("error", () => {});
    if (stdin.text !== undefined) child.stdin.write(stdin.text);
    if (stdin.end) child.stdin.end();
  });
}

/** A registered adapter whose parse and format a test may replace; both are put back when the test ends. */
function borrow(t: CleanupHost, name: string): Adapter {
  const adapter = getAdapter(name);
  assert.ok(adapter, `there is no adapter named ${name}`);
  const original = { parse: adapter.parse, format: adapter.format };
  t.after(() => void Object.assign(adapter, original));
  return adapter;
}

// ---------------------------------------------------------------------------
// A teammate to run into
// ---------------------------------------------------------------------------

const NOTES_PROMPT = "Draft the release notes";

/**
 * Alice's agent started at T0 and was asked at T0+5 to draft the release
 * notes. At T0+10 it wrote `files` (not committed), and all of it was
 * published at T0+12. Bob's clone has not synced since it was made.
 */
async function aliceDraftsNotes(t: CleanupHost, files: string[] = ["notes.txt"]): Promise<Team> {
  const made = await team(t);
  const { alice } = made;
  await fire(alice, "session-start", 0);
  await fire(alice, "prompt", 5, { prompt: NOTES_PROMPT });
  for (const file of files) await alice.write(file, "draft\n");
  await fire(alice, "post-edit", 10, { paths: files.map((file) => join(alice.dir, file)) });
  await publish(alice, 12);
  return made;
}

/** The line a briefing has for alice then, read at T0 + `now`. */
const notesLine = (now: number, files = "notes.txt"): string => `- alice / claude-code on main (${ago(10, now)}): "${NOTES_PROMPT}". Files: ${files}`;
/** The warning for one of her files, read at T0 + `now`. */
const notesWarning = (path: string, now: number): string =>
  text(overlapHead(path), `- alice / claude-code on main (${ago(10, now)}) has it in flight: "${NOTES_PROMPT}".`, SAY_SO);

// ---------------------------------------------------------------------------
// The recorded sessions, replayed in this process
// ---------------------------------------------------------------------------

test("Claude Code, from its recorded payloads: a briefing at the start, one warning before the edit, never a word on Stop or SessionEnd", async (t) => {
  const { h, bob } = await aliceDraftsNotes(t);
  const asked = record(t);
  // Claude Code names a file like this one to its SessionStart hooks, and to no other.
  const envFile = join(h.root, "session-env", CLAUDE_SESSION, "sessionstart-hook-0.sh");
  const claude = (name: string, seconds: number, env: NodeJS.ProcessEnv = {}, over: Json = {}): Promise<Ran> =>
    hook(bob, "claude-code", recorded("claude-code", name, bob, over), seconds, env);

  // SessionStart: the briefing goes to the model, and HUDDLE_SESSION to the agent's shell.
  assert.deepEqual(await claude("session-start.startup", 20, { CLAUDE_ENV_FILE: envFile }), says("SessionStart", text(FULL_HEAD, notesLine(20), FULL_FOOT)));
  assert.equal(await readFile(envFile, "utf8"), `export HUDDLE_SESSION=${CLAUDE_SESSION}\n`);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.agent, session.worktree]),
    [[CLAUDE_SESSION, "claude-code", bob.dir]],
  );

  // UserPromptSubmit: nothing has changed since the briefing, so nothing is printed. The start of the prompt is the intent.
  assert.deepEqual(await claude("user-prompt-submit.typed", 22), SILENT);
  const typed = String(fixture("claude-code", "user-prompt-submit.typed").prompt);
  const intent = (await sessionOf(bob, CLAUDE_SESSION))?.intent ?? "";
  assert.equal(intent, toIntent(typed));
  assert.ok(intent.startsWith("Do these steps in order. 1) Use the Write tool to create notes.txt"), intent);
  assert.ok(Array.from(intent).length <= 200 && typed.length > 200);

  // PreToolUse of Write: notes.txt is in alice's flight.
  assert.deepEqual(await claude("pre-tool-use.write", 25), says("PreToolUse", notesWarning("notes.txt", 25)));
  // PostToolUse has nothing to say, and the Edit of the same file was warned about already.
  assert.deepEqual(await claude("post-tool-use.write", 26), SILENT);
  assert.deepEqual(await claude("pre-tool-use.edit", 27), SILENT);

  // Before a tool that names no file to edit, and on an event huddle does not register for, there is no event at all.
  for (const name of ["pre-tool-use.read", "pre-tool-use.bash", "subagent-stop"]) assert.deepEqual(await claude(name, 28), SILENT, name);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.seenAt]),
    [[CLAUDE_SESSION, at(27)]],
  );

  // Stop: output there would keep the agent going. SessionEnd: the session is gone.
  assert.deepEqual(await claude("stop", 30), SILENT);
  assert.deepEqual(await claude("session-end", 40), SILENT);
  assert.deepEqual(await sessionsOf(bob), []);

  // What was asked of the network on the way: one sync waited for at the start; then the new intent and
  // the ends of the turn and of the session at once, and the edit left to the throttle.
  assert.equal(asked.waited.length, 1);
  assert.deepEqual(asked.background, [forced(bob), throttled(bob), forced(bob), forced(bob)]);

  // The session starts again (a resume, /clear, a compaction). Claude Code names the same file, and the line is in it once.
  const again = await claude("session-start.startup", 50, { CLAUDE_ENV_FILE: envFile }, { source: "clear" });
  assert.deepEqual(again, says("SessionStart", text(FULL_HEAD, notesLine(50), FULL_FOOT)));
  assert.equal(await readFile(envFile, "utf8"), `export HUDDLE_SESSION=${CLAUDE_SESSION}\n`);
});

test("Codex, from its recorded payloads: the paths in a patch count from where the command runs", async (t) => {
  const { bob } = await aliceDraftsNotes(t, ["notes.txt", "packages/api/src/app.ts"]);
  await mkdir(join(bob.dir, "packages/api"), { recursive: true });
  const asked = record(t);
  const codex = (name: string, seconds: number, over: Json = {}): Promise<Ran> => hook(bob, "codex", recorded("codex", name, bob, over), seconds);

  assert.deepEqual(await codex("session-start.startup", 20), says("SessionStart", text(FULL_HEAD, notesLine(20, "notes.txt, packages/api/src/app.ts"), FULL_FOOT)));
  assert.deepEqual(await codex("user-prompt-submit", 22), SILENT);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.agent, session.intent, session.intentSource]),
    [[CODEX_SESSION, "codex", "Add rate limiting to the login endpoint", "prompt"]],
  );

  // apply_patch at the top of the repository: "notes.txt".
  assert.deepEqual(await codex("pre-tool-use.apply-patch.add", 25), says("PreToolUse", notesWarning("notes.txt", 25)));
  // The same tool in packages/api, where the patch says "src/app.ts".
  assert.deepEqual(await codex("pre-tool-use.apply-patch.subdirectory", 26), says("PreToolUse", notesWarning("packages/api/src/app.ts", 26)));
  assert.equal((await sessionOf(bob, CODEX_SESSION))?.worktree, bob.dir, "a subdirectory is not another worktree");

  // A patch of four files nobody else has touched, a shell command, and the edit once it is made.
  assert.deepEqual(await codex("pre-tool-use.apply-patch.mixed", 27), SILENT);
  assert.deepEqual(await codex("pre-tool-use.bash", 28), SILENT);
  assert.deepEqual(await codex("post-tool-use.apply-patch", 29), SILENT);
  assert.deepEqual(await codex("stop", 30), SILENT);
  // The recorded SessionEnd is of another session. This one ends the same way.
  assert.deepEqual(await codex("session-end", 40, { session_id: CODEX_SESSION, cwd: bob.dir }), SILENT);
  assert.deepEqual(await sessionsOf(bob), []);

  assert.equal(asked.waited.length, 1);
  assert.deepEqual(asked.background, [forced(bob), throttled(bob), forced(bob), forced(bob)]);
});

// ---------------------------------------------------------------------------
// What is not an event, and a command that is written wrong
// ---------------------------------------------------------------------------

test("input that is no event is answered with silence and exit code 0, and nothing is touched", async (t) => {
  const { bob } = await team(t);
  const asked = record(t);
  const inputs = [
    "",
    "  \n",
    "not json",
    "{",
    "[]",
    "null",
    "42",
    '"SessionStart"',
    "{}",
    "x".repeat(200_000),
    // No session, or none worth the name.
    JSON.stringify({ hook_event_name: "SessionStart", cwd: bob.dir }),
    JSON.stringify({ hook_event_name: "SessionStart", session_id: "   ", cwd: bob.dir }),
    JSON.stringify({ hook_event_name: "SessionStart", session_id: 7, cwd: bob.dir }),
    // An event of the agent's that huddle does not register for.
    JSON.stringify({ hook_event_name: "Notification", session_id: "s-bob", cwd: bob.dir }),
    JSON.stringify({ session_id: "s-bob", cwd: bob.dir }),
    // A tool call that edits nothing.
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-bob", cwd: bob.dir, tool_name: "Read", tool_input: { file_path: "a.ts" } }),
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-bob", cwd: bob.dir, tool_name: "Bash", tool_input: { command: "ls" } }),
  ];
  for (const agent of ["claude-code", "codex"]) {
    for (const stdin of inputs) assert.deepEqual(await hook(bob, agent, stdin, 0), SILENT, `${agent}: ${stdin.slice(0, 60)}`);
  }
  assert.equal(existsSync(join(bob.dir, ".git", "huddle")), false);
  assert.deepEqual(asked, NOTHING_ASKED);
});

test("a hook command that names no agent, or one that does not exist, says so on stderr and still exits 0", async (t) => {
  const { bob } = await team(t);
  const names = ADAPTERS.map((adapter) => adapter.name);
  for (const name of ["claude-code", "codex", "git"]) assert.ok(names.includes(name), `${name} is not registered`);
  const known = names.join(", ");
  const answer = async (args: string[]): Promise<{ code: number; stdout: string[]; stderr: string[]; read: number }> => {
    const io = ioFor(bob, { stdin: "{}" });
    const code = await runHook(args, io);
    return { code, stdout: io.stdout, stderr: io.stderr, read: io.stdinCalls.length };
  };
  /** On stderr, exit code 0, and stdin was left alone. */
  const complaint = (line: string) => ({ code: 0, stdout: [], stderr: [line], read: 0 });

  assert.deepEqual(await answer([]), complaint(`Usage: huddle hook <agent>   (agents: ${known})`));
  assert.deepEqual(await answer(["no-such-agent"]), complaint(`huddle: no hook adapter named "no-such-agent". Known: ${known}.`));
  // Names every object answers to are not adapters.
  for (const name of ["", "constructor", "__proto__", "toString"]) {
    assert.deepEqual(await answer([name, "claude-code"]), complaint(`huddle: no hook adapter named "${name}". Known: ${known}.`));
  }
  // The name comes out of a config file that somebody edited by hand: it is quoted and cut, and stays one line.
  const odd = `agent\n"with" quotes ${"x".repeat(200)}`;
  assert.deepEqual(await answer([odd]), complaint(`huddle: no hook adapter named ${JSON.stringify(odd.slice(0, 60))}. Known: ${known}.`));

  // The same from the real command. Any other exit code would block the tool call on some agents.
  assert.deepEqual(await bob.huddle(["hook"]), { code: 0, stdout: "", stderr: `Usage: huddle hook <agent>   (agents: ${known})\n` });
  assert.deepEqual(await bob.huddle(["hook", "no-such-agent"], { stdin: "{}" }), {
    code: 0,
    stdout: "",
    stderr: `huddle: no hook adapter named "no-such-agent". Known: ${known}.\n`,
  });
  assert.equal(existsSync(join(bob.dir, ".git", "huddle")), false);
});

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

test("the payload is waited for 300 ms and no longer", async (t) => {
  const { bob } = await team(t);
  const io = ioFor(bob, { stdin: () => new Promise<string>(() => {}), env: ON_THE_CLOCK });
  const { ms, value } = await timed(() => runHook(["claude-code"], io));
  assert.equal(value, 0);
  assert.deepEqual([io.stdout, io.stderr], [[], []]);
  // It asks for one JSON value and gives the read 300 ms; a timer of its own holds if the read does not keep to that.
  assert.deepEqual(io.stdinCalls, [{ timeoutMs: 300, json: true }]);
  assert.ok(ms >= 340 && ms < 700, `came back after ${Math.round(ms)} ms`);

  // A machine that was given patience waits that many times longer for it, as for everything else.
  const patient = ioFor(bob, { stdin: () => new Promise<string>(() => {}), env: { HUDDLE_HOOK_PATIENCE: "2" } });
  const slow = await timed(() => runHook(["claude-code"], patient));
  assert.deepEqual([slow.value, patient.stdout, patient.stderr], [0, [], []]);
  assert.deepEqual(patient.stdinCalls, [{ timeoutMs: 600, json: true }]);
  assert.ok(slow.ms >= 640 && slow.ms < 1000, `came back after ${Math.round(slow.ms)} ms`);
});

test("a payload that arrives late has used up its event's time: the hook does not run over because its input was slow", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 15);
  const edit = (session: string): string =>
    recorded("claude-code", "pre-tool-use.write", bob, { session_id: session, tool_input: { file_path: join(bob.dir, "src/auth.ts"), content: "one" } });

  // On time, this edit is warned about.
  assert.deepEqual(await hook(bob, "claude-code", edit("s-on-time"), 20), says("PreToolUse", authWarning(20)));

  // A quarter of a second late, the 150 ms of a pre-edit are gone before the engine has begun.
  const io = ioFor(bob, { now: at(21), stdin: () => sleep(250).then(() => edit("s-late")), env: ON_THE_CLOCK });
  const { ms, value } = await timed(() => runHook(["claude-code"], io));
  assert.equal(value, 0);
  assert.deepEqual([io.stdout, io.stderr], [[], []], "with 150 ms of its own it would have had the warning to print");
  assert.ok(ms >= 245 && ms < 600, `came back after ${Math.round(ms)} ms`);
  // What was abandoned runs on for a moment. Let it finish before the clone is removed under it.
  await sleep(300);
});

test("through the bundle: a pipe that stays open holds nothing up, with a payload or without one", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 15);
  const edit = recorded("claude-code", "pre-tool-use.write", bob, { session_id: "s-bob", agent_id: "a1", tool_input: { file_path: join(bob.dir, "src/auth.ts"), content: "one" } });
  const run = (stdin: { text?: string; end: boolean }): Promise<Exited> => start(BUNDLE_NODE, [BUNDLE, "hook", "claude-code"], bob.dir, stdin, { HUDDLE_NOW: at(20), ...ON_THE_CLOCK });

  // Nothing ever arrives and nobody closes the pipe: the hook gives up by itself, quietly.
  const empty = await run({ end: false });
  assert.deepEqual([empty.code, empty.stdout, empty.stderr], [0, "", ""]);
  assert.ok(empty.ms >= 300, `gave up after ${Math.round(empty.ms)} ms`);

  // The payload arrives and the pipe stays open, as some agents leave it. One complete JSON value is all the hook
  // waits for. The warning is the proof: the 300 ms that the end of input is waited for are twice what a pre-edit has,
  // so a hook that waited for it would have nothing to say. (On a machine that is busy enough a pre-edit runs out of
  // time anyway, hence more than one try.)
  const warning = `${contextJson("PreToolUse", authWarning(20))}\n`;
  let answered = await run({ text: edit, end: false });
  for (let attempt = 1; attempt < 5 && answered.stdout !== warning; attempt++) {
    assert.deepEqual([answered.code, answered.stdout, answered.stderr], [0, "", ""], "a pre-edit that runs out of time says nothing");
    answered = await run({ text: edit, end: false });
  }
  assert.deepEqual([answered.code, answered.stdout, answered.stderr], [0, warning, ""]);
});

// ---------------------------------------------------------------------------
// What the adapter hands back
// ---------------------------------------------------------------------------

test("an adapter that throws, or answers with nonsense, costs the output and never the exit code", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 15);
  const codex = borrow(t, "codex");
  const format = codex.format;
  const run = (seconds: number): Promise<Ran> => hook(bob, "codex", "{}", seconds);

  codex.parse = () => {
    throw new Error("parse broke");
  };
  assert.deepEqual(await run(20), SILENT);
  for (const nonsense of [undefined, "an event", 42, true, []]) {
    codex.parse = () => nonsense as never;
    assert.deepEqual(await run(20), SILENT, JSON.stringify(nonsense));
  }
  assert.deepEqual(await sessionsOf(bob), [], "none of that was an event");

  // From here on there is an event, and a warning to format every time: a subagent is always warned.
  codex.parse = (): HookEvent => eventOf(bob, "pre-edit", { agent: "codex", paths: ["src/auth.ts"], subagent: true });
  codex.format = () => {
    throw new Error("format broke");
  };
  assert.deepEqual(await run(21), SILENT);
  assert.match(await logOf(bob), /\[hook\] the hook failed \| Error: format broke/);

  for (const nonsense of [undefined, null, "context", 42]) {
    codex.format = () => nonsense as never;
    assert.deepEqual(await run(22), SILENT, JSON.stringify(nonsense));
  }
  // What is printed has to be text, and the lines for a file a list.
  codex.format = () => ({ stdout: 42, stderr: { text: "x" }, exitCode: 0, appendLines: "export A=1" }) as never;
  assert.deepEqual(await run(23), SILENT);

  // The exit code is the adapter's to ask for, where its agent's protocol needs one: a whole number from 0 to 255. Anything else is 0.
  const codes: Array<[unknown, number]> = [
    [0, 0],
    [2, 2],
    [255, 255],
    [256, 0],
    [-1, 0],
    [1.5, 0],
    [Number.NaN, 0],
    ["2", 0],
    [null, 0],
    [undefined, 0],
  ];
  for (const [asked, given] of codes) {
    codex.format = (event, outcome) => ({ ...format(event, outcome), exitCode: asked as never });
    assert.deepEqual(await run(24), { ...says("PreToolUse", authWarning(24)), code: given }, `asked for ${String(asked)}`);
  }

  // Both streams pass through as they are.
  codex.format = () => ({ stdout: "for the agent", stderr: "for whoever reads the terminal", exitCode: 0 });
  assert.deepEqual(await run(25), { code: 0, stdout: ["for the agent"], stderr: ["for whoever reads the terminal"] });
});

test("what was shown goes on record only after it is printed: output that did not get out is given again", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const edit = recorded("claude-code", "pre-tool-use.write", bob, { session_id: "s-bob", tool_input: { file_path: join(bob.dir, "src/auth.ts"), content: "one" } });
  const record_ = seenFile(await bob.paths(), "s-bob");

  // The agent is gone and its pipe with it: printing fails.
  const broken = ioFor(bob, { now: at(25), stdin: edit });
  broken.out = () => {
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  };
  assert.equal(await runHook(["claude-code"], broken), 0);
  assert.deepEqual(broken.stderr, []);
  assert.ok(!(await seenKeys(bob)).includes("w:src/auth.ts"), "a warning nobody saw is not on record");
  assert.match(await logOf(bob), /\[hook\] the hook failed \| Error: write EPIPE/);

  // So the next edit of the file is warned about. At the moment the warning is printed it is not on record yet.
  const io = ioFor(bob, { now: at(26), stdin: edit });
  const print = io.out;
  let onRecordWhenPrinted: boolean | null = null;
  io.out = (line) => {
    onRecordWhenPrinted = readFileSync(record_, "utf8").includes("w:src/auth.ts");
    print(line);
  };
  assert.equal(await runHook(["claude-code"], io), 0);
  assert.deepEqual(io.stdout, [contextJson("PreToolUse", authWarning(26))]);
  assert.equal(onRecordWhenPrinted, false);
  assert.ok((await seenKeys(bob)).includes("w:src/auth.ts"));

  // Once it is on record, the same edit is quiet.
  assert.deepEqual(await hook(bob, "claude-code", edit, 27), SILENT);
});

test("a hook whose time runs out once its answer is out does not stay to put it on record, and the log says so", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 15);
  const patience = 4;
  const asleep = new Int32Array(new SharedArrayBuffer(4));
  const warning = contextJson("PreToolUse", authWarning(20));

  // The machine stalls the moment the warning is out, for longer than the edit has. On a machine that is busy enough
  // the edit runs out of time before it has a warning at all, hence the second and third try.
  let session = "";
  let stdout: string[] = [];
  for (let attempt = 0; attempt < 3 && stdout.length === 0; attempt++) {
    session = `s-stalled-${attempt}`;
    const edit = recorded("claude-code", "pre-tool-use.write", bob, { session_id: session, tool_input: { file_path: join(bob.dir, "src/auth.ts"), content: "one" } });
    const io = ioFor(bob, { now: at(20), stdin: edit, env: { HUDDLE_HOOK_PATIENCE: String(patience) } });
    const print = io.out;
    io.out = (line) => {
      print(line);
      // Runs as soon as the hook waits for anything, which is the write of its record: nothing in this process
      // moves again before the deadline is behind it.
      queueMicrotask(() => void Atomics.wait(asleep, 0, 0, patience * DEADLINE_MS["pre-edit"] + 20));
    };
    assert.equal(await runHook(["claude-code"], io), 0);
    assert.deepEqual(io.stderr, []);
    stdout = io.stdout;
  }
  assert.deepEqual(stdout, [warning]);
  assert.match(await logOf(bob), /\[hook\] pre-edit: its deadline passed before what was shown was on record/);
  // A hook process is over at this point, and the next edit of the file is warned about once more. Here the process
  // lives on and the write lands after all: it was only not waited for.
  await until("the abandoned write to land", async () => (await seenKeys(bob, session)).includes("w:src/auth.ts"));
});

test("an adapter with no way to show a context says so, and the news is kept for an event that can carry it", async (t) => {
  const { alice, bob } = await aliceBuildsAuth(t);
  const codex = borrow(t, "codex");
  const format = codex.format;
  // An agent like Cursor before a prompt: its hook there can let the prompt pass or block it, and has no way to tell the model anything.
  const mute: Adapter["format"] = (_event, outcome) => ({ stdout: "", stderr: "", exitCode: 0, unshown: typeof outcome.context === "string" && outcome.context !== "" });
  const run = (name: string, seconds: number, over: Json = {}): Promise<Ran> => hook(bob, "codex", recorded("codex", name, bob, over), seconds);
  const edit = { tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.ts\n@@\n-a\n+b\n*** End Patch" } };

  // Neither the first briefing, nor the one that makes up for it at the prompt, nor a warning can be shown.
  codex.format = mute;
  assert.deepEqual(await run("session-start.startup", 20), SILENT);
  assert.deepEqual(await run("user-prompt-submit", 22), SILENT);
  assert.deepEqual(await run("pre-tool-use.apply-patch.add", 24, edit), SILENT);
  assert.deepEqual(await seenKeys(bob, CODEX_SESSION), [], "nothing is on record as shown");
  // Everything else about the events happened: the session is there, with the prompt as its intent.
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.intent, session.seenAt]),
    [[CODEX_SESSION, "Add rate limiting to the login endpoint", at(24)]],
  );

  // The first event that can carry a context gets all of it, once: the full briefing, and the warning.
  codex.format = format;
  assert.deepEqual(await run("user-prompt-submit", 26), says("UserPromptSubmit", text(FULL_HEAD, aliceLine(26), FULL_FOOT)));
  assert.deepEqual(await run("pre-tool-use.apply-patch.add", 27, edit), says("PreToolUse", authWarning(27)));
  assert.deepEqual(await run("user-prompt-submit", 28), SILENT);
  assert.deepEqual(await run("pre-tool-use.apply-patch.add", 29, edit), SILENT);

  // News that comes later is kept the same way.
  await fire(alice, "prompt", 30, { prompt: "Switch the JWT middleware to sessions" });
  await publish(alice, 31);
  await publish(bob, 32);
  codex.format = mute;
  assert.deepEqual(await run("user-prompt-submit", 35), SILENT);
  codex.format = format;
  const news = text(DELTA_HEAD, `- alice / claude-code on main (${ago(30, 36)}): "Switch the JWT middleware to sessions". Files: src/auth.ts`, OVERLAP_HINT);
  assert.deepEqual(await run("user-prompt-submit", 36), says("UserPromptSubmit", news));
  assert.deepEqual(await run("user-prompt-submit", 37), SILENT);

  // An agent that can be spoken to only after a tool call (Gemini CLI): nothing can be said before the edit. The
  // warning is kept, and the event after the edit carries it, once.
  codex.format = mute;
  assert.deepEqual(await run("session-start.startup", 40), SILENT);
  assert.deepEqual(await run("pre-tool-use.apply-patch.add", 41, edit), SILENT);
  codex.format = format;
  const late = text(overlapHead("src/auth.ts"), `- alice / claude-code on main (${ago(30, 42)}) has it in flight: "Switch the JWT middleware to sessions".`, SAY_SO);
  assert.deepEqual(await run("post-tool-use.apply-patch", 42, edit), says("PostToolUse", late));
  assert.deepEqual(await run("post-tool-use.apply-patch", 43, edit), SILENT);
  assert.deepEqual(await run("pre-tool-use.apply-patch.add", 44, edit), SILENT);

  // An agent that cannot be spoken to at a prompt either (Cursor): its adapter says of the event after a tool call
  // that the session may be briefed there, and what the prompt could not say arrives with it.
  const parse = codex.parse;
  codex.parse = (input) => {
    const event = parse(input);
    return event !== null && event.type === "post-edit" ? { ...event, brief: true } : event;
  };
  // The briefing that the session start at 40 could not show is still owed. The warning was given at 42.
  const owed = text(FULL_HEAD, `- alice / claude-code on main (${ago(30, 45)}): "Switch the JWT middleware to sessions". Files: src/auth.ts`, FULL_FOOT);
  assert.deepEqual(await run("post-tool-use.apply-patch", 45, edit), says("PostToolUse", owed));
  assert.deepEqual(await run("post-tool-use.apply-patch", 46, edit), SILENT);
  // And so is news that comes while the agent works.
  await fire(alice, "session-end", 50);
  await publish(alice, 51);
  await publish(bob, 52);
  codex.format = mute;
  assert.deepEqual(await run("user-prompt-submit", 55), SILENT);
  // Saying that it may brief is not the same as being able to: an answer that was not shown uses up nothing here either.
  assert.deepEqual(await run("post-tool-use.apply-patch", 56, edit), SILENT);
  codex.format = format;
  assert.deepEqual(await run("post-tool-use.apply-patch", 57, edit), says("PostToolUse", text(DELTA_HEAD, "Left: alice / claude-code (main).")));
  assert.deepEqual(await run("post-tool-use.apply-patch", 58, edit), SILENT);
});

test("appendLines adds a line to a file once, makes the directory, and refuses a line that is more than one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "huddle-hook-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const line = "export HUDDLE_SESSION=abc";

  const file = join(dir, "not", "there", "yet", "env.sh");
  await appendLines([{ path: file, line }]);
  assert.equal(await readFile(file, "utf8"), `${line}\n`);
  await appendLines([
    { path: file, line },
    { path: file, line },
  ]);
  assert.equal(await readFile(file, "utf8"), `${line}\n`, "a line the file has is not added again");
  await appendLines([
    { path: file, line: "export A=1" },
    { path: file, line: "export B=2" },
    { path: file, line: "export A=1" },
  ]);
  assert.equal(await readFile(file, "utf8"), `${line}\nexport A=1\nexport B=2\n`);

  // A file somebody else wrote: without a newline at its end, with Windows line ends, with the line as part of another.
  const theirs = join(dir, "theirs.sh");
  await writeFile(theirs, "export X=1");
  await appendLines([{ path: theirs, line }]);
  assert.equal(await readFile(theirs, "utf8"), `export X=1\n${line}\n`);
  await writeFile(theirs, `export X=1\r\n${line}\r\n`);
  await appendLines([{ path: theirs, line }]);
  assert.equal(await readFile(theirs, "utf8"), `export X=1\r\n${line}\r\n`);
  await writeFile(theirs, `# ${line}\n`);
  await appendLines([{ path: theirs, line }]);
  assert.equal(await readFile(theirs, "utf8"), `# ${line}\n${line}\n`);

  // The agent runs the file as shell code: a "line" with a line break in it would be a second command.
  const never = join(dir, "never.sh");
  await appendLines([
    { path: never, line: "export A=1\nrm -rf ~" },
    { path: never, line: "export A=1\rrm -rf ~" },
    { path: never, line: "" },
    { path: "", line },
  ]);
  assert.equal(existsSync(never), false);

  // Entries that are none are skipped, a file that cannot be written is given up on, and what comes after still counts.
  const odd = [null, 42, "export A=1", { path: never }, { line }, { path: 7, line }, { path: dir, line }, { path: join(file, "below-a-file.sh"), line }, { path: never, line: "export OK=1" }];
  await appendLines(odd as never);
  assert.equal(await readFile(never, "utf8"), "export OK=1\n");

  // And what is not a list is nothing.
  for (const entries of [undefined, null, "export A=1", 7, {}, { length: 1 }]) await appendLines(entries as never);
});

// ---------------------------------------------------------------------------
// The hook command
// ---------------------------------------------------------------------------

test("the hook command is runHook, and watches for crashes only in a hook process", async (t) => {
  const { bob } = await team(t);
  assert.notEqual(process.argv[2], "hook");
  const listeners = (): number[] => [process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection")];
  const before = listeners();

  const io = ioFor(bob, { now: at(0), stdin: recorded("claude-code", "post-tool-use.write", bob) });
  // Every timer that is asked for while the command runs, by how long it is to run.
  const timers: unknown[] = [];
  const setTimeout_ = globalThis.setTimeout;
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
    timers.push(args[1]);
    return setTimeout_(...args);
  }, setTimeout_);
  try {
    assert.equal(await hookCommand(["claude-code"], io), 0);
  } finally {
    globalThis.setTimeout = setTimeout_;
  }
  assert.deepEqual([io.stdout, io.stderr], [[], []]);
  assert.equal((await sessionOf(bob, CLAUDE_SESSION))?.seenAt, at(0));
  assert.deepEqual(listeners(), before, "a test, or another command, gets no listeners on its process");
  assert.ok(timers.length > 0, "the event's own deadline is a timer");
  assert.ok(!timers.includes(lifetimeMs(io)), "and no limit on its lifetime: that one ends the process");
});

const WORKER = fileURLToPath(new URL("./hook.worker.ts", import.meta.url));

test("no hook process outlives its limit, and the limit holds up no process that is done", async (t) => {
  const { bob } = await team(t);
  // The limit is the longest deadline there is and a little more, with the patience the machine was given.
  assert.equal(lifetimeMs(ioFor(bob, { env: ON_THE_CLOCK })), 4500);
  assert.equal(lifetimeMs(ioFor(bob)), PATIENCE * 4000 + 500);
  assert.equal(lifetimeMs(null), 4500);

  // The timer ends the process with exit code 0, and nothing waits for it.
  const codes: number[] = [];
  const timer = limitLifetime(30, (code) => void codes.push(code));
  assert.equal(timer.hasRef(), false);
  await sleep(120);
  assert.deepEqual(codes, [0]);

  // A real hook process in which something lives on after its event is done: nothing else would end it for 30 s.
  const lingering = await start(process.execPath, [WORKER, "hook", bob.dir, "linger"], bob.dir, { end: true }, ON_THE_CLOCK);
  assert.deepEqual([lingering.code, lingering.stdout, lingering.stderr], [0, "", ""]);
  assert.ok(lingering.ms >= 4400 && lingering.ms < 9000, `it was ended after ${Math.round(lingering.ms)} ms`);
});

test("a crash that nothing catches leaves a line in the clone's debug log, and the hook still exits 0 in silence", async (t) => {
  const { bob } = await team(t);
  const crash = (how: string, env: NodeJS.ProcessEnv = {}): Promise<Exited> => start(process.execPath, [WORKER, "hook", bob.dir, how], bob.dir, { end: true }, env);

  for (const [how, what] of [
    ["throw", "boom in a timer"],
    ["reject", "boom in a promise"],
  ] as const) {
    const ran = await crash(how);
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, "", ""], how);
    // One line, with the stack: its line breaks are written out as \n.
    assert.match(await logOf(bob), new RegExp(`^\\S+ \\d+ \\[hook\\] crashed \\| Error: ${what}\\\\n\\s+at [^\\n]*$`, "m"));
  }

  // HUDDLE_DEBUG is for whoever wants to see it happen.
  const loud = await crash("throw", { HUDDLE_DEBUG: "1" });
  assert.deepEqual([loud.code, loud.stdout], [0, ""]);
  assert.match(loud.stderr, /^huddle hook: Error: boom in a timer\n\s+at /);
});

// ---------------------------------------------------------------------------
// Through the built bundle
// ---------------------------------------------------------------------------

test("through the bundle: two Claude Code sessions on two clones, from the first briefing to the goodbye", async (t) => {
  const { h, alice, bob } = await team(t);
  const ALICE = OTHER_CLAUDE_SESSION;
  const BOB = CLAUDE_SESSION;
  const claude = (clone: Clone, session: string, name: string, seconds: number, over: Json = {}, env: Record<string, string> = {}): Promise<RunResult> =>
    clone.huddle(["hook", "claude-code"], { stdin: recorded("claude-code", name, clone, { session_id: session, ...over }), now: at(seconds), env });
  /** What a hook leaves to a detached process, which the harness does not let it start. */
  const background = async (clone: Clone, seconds: number): Promise<void> => {
    assert.deepEqual(await clone.huddle(["sync", "--background", "--force"], { now: at(seconds) }), QUIET);
  };
  const writes = (clone: Clone, path: string): Json => ({ tool_input: { file_path: join(clone.dir, path), content: "one" } });

  // Alice starts. Nobody else is here.
  const aliceEnv = join(h.root, "alice-env.sh");
  assert.deepEqual(await claude(alice, ALICE, "session-start.startup", 0, {}, { CLAUDE_ENV_FILE: aliceEnv }), prints("SessionStart", ALONE));
  assert.equal(await readFile(aliceEnv, "utf8"), `export HUDDLE_SESSION=${ALICE}\n`);
  assert.deepEqual(await claude(alice, ALICE, "user-prompt-submit.typed", 5, { prompt: AUTH_PROMPT }), QUIET);
  await alice.write("src/auth.ts", "export const auth = true;\n");
  assert.deepEqual(await claude(alice, ALICE, "post-tool-use.write", 10, writes(alice, "src/auth.ts")), QUIET);
  await background(alice, 12);

  // Bob starts and is told about her. Then he goes for the same file.
  const bobEnv = join(h.root, "bob-env.sh");
  assert.deepEqual(await claude(bob, BOB, "session-start.startup", 20, {}, { CLAUDE_ENV_FILE: bobEnv }), prints("SessionStart", text(FULL_HEAD, aliceLine(20), FULL_FOOT)));
  assert.deepEqual(await claude(bob, BOB, "user-prompt-submit.typed", 22, { prompt: "Add the login page" }), QUIET);
  assert.deepEqual(await claude(bob, BOB, "pre-tool-use.write", 25, writes(bob, "src/auth.ts")), prints("PreToolUse", authWarning(25)));
  assert.deepEqual(await claude(bob, BOB, "pre-tool-use.edit", 26, writes(bob, "src/auth.ts")), QUIET);

  // His agent says so, as the warning asks, from its shell: the variable from the SessionStart hook makes it the same session.
  const exported = /^export HUDDLE_SESSION=(\S+)$/m.exec(await readFile(bobEnv, "utf8"))?.[1];
  assert.equal(exported, BOB);
  const stated = await bob.huddle(["intent", "Pair with alice on the auth module"], { session: exported, now: at(27) });
  assert.deepEqual([stated.code, stated.stderr], [0, ""]);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.agent, session.intent, session.intentSource]),
    [[BOB, "claude-code", "Pair with alice on the auth module", "manual"]],
  );
  assert.deepEqual(await claude(bob, BOB, "stop", 30), QUIET);
  await background(bob, 31);

  // Alice hears of it with her next prompt, once.
  await background(alice, 32);
  const news = text(DELTA_HEAD, `- bob / claude-code on main (${ago(30, 35)}): "Pair with alice on the auth module".`, OVERLAP_HINT);
  assert.deepEqual(await claude(alice, ALICE, "user-prompt-submit.typed", 35, { prompt: "continue" }), prints("UserPromptSubmit", news));
  assert.deepEqual(await claude(alice, ALICE, "user-prompt-submit.typed", 36, { prompt: "continue" }), QUIET);
  assert.equal((await sessionOf(alice, ALICE))?.intent, AUTH_PROMPT, '"continue" is no intent');

  // Bob's session ends, and she hears of that as well.
  assert.deepEqual(await claude(bob, BOB, "session-end", 40), QUIET);
  await background(bob, 41);
  await background(alice, 42);
  assert.deepEqual(await claude(alice, ALICE, "user-prompt-submit.typed", 45, { prompt: "continue" }), prints("UserPromptSubmit", text(DELTA_HEAD, "Left: bob / claude-code (main).")));

  // Then hers.
  assert.deepEqual(await claude(alice, ALICE, "stop", 46), QUIET);
  assert.deepEqual(await claude(alice, ALICE, "session-end", 47), QUIET);
  await background(alice, 48);
  assert.deepEqual([await sessionsOf(alice), await sessionsOf(bob)], [[], []]);
  for (const user of ["alice", "bob"]) assert.deepEqual((await published(h, user))?.sessions ?? [], [], `${user} is still shown on the remote`);
});

test("through the bundle: where huddle cannot work, every event still exits 0 with nothing on stdout or stderr", async (t) => {
  const { h, bob } = await team(t);
  const all = (run: (name: string) => Promise<RunResult>): Promise<RunResult[]> => Promise.all(SIX_OF_CLAUDE.map(([, name]) => run(name)));
  const quiet = SIX_OF_CLAUDE.map(() => QUIET);

  // Not a repository at all.
  const scratch = join(h.root, "scratch");
  await mkdir(scratch);
  assert.deepEqual(await all((name) => bob.huddle(["hook", "claude-code"], { cwd: "../scratch", stdin: recorded("claude-code", name, scratch), now: at(0) })), quiet);
  assert.deepEqual(await readdir(scratch), []);

  // A clone whose state directory cannot be one.
  const carol = await h.clone("carol");
  await writeFile(join(carol.dir, ".git", "huddle"), "in the way\n");
  assert.deepEqual(await all((name) => carol.huddle(["hook", "claude-code"], { stdin: recorded("claude-code", name, carol), now: at(0) })), quiet);
  assert.equal(await readFile(join(carol.dir, ".git", "huddle"), "utf8"), "in the way\n");

  // Half a payload.
  assert.deepEqual(await all((name) => bob.huddle(["hook", "claude-code"], { stdin: recorded("claude-code", name, bob).slice(0, 80), now: at(0) })), quiet);
  assert.equal(existsSync(join(bob.dir, ".git", "huddle")), false);
});

test("through the bundle: each event gets its work done in less than its budget on top of what node needs to start", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  const claude = (name: string, seconds: number, over: Json = {}): Promise<RunResult> =>
    bob.huddle(["hook", "claude-code"], { stdin: recorded("claude-code", name, bob, { session_id: "s-bob", ...over }), now: at(seconds), env: ON_THE_CLOCK });
  const auth = { tool_input: { file_path: join(bob.dir, "src/auth.ts"), content: "one" } };
  assert.deepEqual(await claude("session-start.startup", 20), prints("SessionStart", text(FULL_HEAD, aliceLine(20), FULL_FOOT)));
  /** How often a hook in this clone has run out of time so far. */
  const gaveUp = async (): Promise<number> => (await logOf(bob)).split("gave up at its deadline").length - 1;

  interface Measured {
    work: () => Promise<RunResult>;
    /** What the hook prints when its work is done. */
    stdout: string;
    before?: () => Promise<unknown>;
  }
  const runs: Record<HookEventType, Measured> = {
    "session-start": { work: () => claude("session-start.startup", 30), stdout: prints("SessionStart", text(FULL_HEAD, aliceLine(30), FULL_FOOT)).stdout },
    prompt: { work: () => claude("user-prompt-submit.typed", 31), stdout: "" },
    // A subagent's edit is warned about every time, so it is the one that does all of the work every time.
    "pre-edit": { work: () => claude("pre-tool-use.subagent-write", 32, auth), stdout: prints("PreToolUse", authWarning(32)).stdout },
    // The session has been warned about the file by then: the check is made, and has nothing to add.
    "post-edit": { work: () => claude("post-tool-use.write", 33, auth), stdout: "", before: () => fire(bob, "pre-edit", 32, { paths: [auth.tool_input.file_path] }) },
    "turn-end": { work: () => claude("stop", 34), stdout: "" },
    // Each run has a session to remove.
    "session-end": { work: () => claude("session-end", 36), stdout: "", before: () => fire(bob, "post-edit", 35) },
  };

  for (const type of ALL_TYPES) {
    const { work, stdout, before } = runs[type];
    const budget = DEADLINE_MS[type];
    const tries: string[] = [];
    let inBudget = false;
    // The clock of a machine that is doing other things is rough, and a hook that runs out of time gives up, as it
    // should. So an event has a few tries, and in one of them it has to get its work done inside its budget.
    for (let attempt = 0; attempt < 6 && !inBudget; attempt++) {
      await before?.();
      const givenUp = await gaveUp();
      // What it takes to start node and load the bundle. No deadline in the engine can count that, and it moves with
      // whatever else the machine is doing, so it is measured again right before each run.
      const startUp = (await timed(() => bob.huddle(["--version"]))).ms;
      const { ms, value } = await timed(work);
      assert.deepEqual([value.code, value.stderr], [0, ""], type);
      if (value.stdout !== "") assert.equal(value.stdout, stdout, type);
      const done = value.stdout === stdout && (await gaveUp()) === givenUp;
      tries.push(`${Math.round(ms - startUp)} ms${done ? "" : " (gave up)"}`);
      inBudget = done && ms - startUp < budget;
    }
    assert.ok(inBudget, `${type} has ${budget} ms on top of node's start-up; it took ${tries.join(", ")}`);
  }
});

/**
 * Stands in for a git that waits: on a dead network file system, on a lock, on a credential helper. Like git, it has
 * a child in its process group (git's would be ssh), and like git it does something when it is asked to stop with
 * SIGTERM (git removes its lock files). It notes each of those steps.
 */
const HANGING_GIT = [
  "#!/bin/sh",
  'echo "start $$" >> "$HUDDLE_TEST_PIDS"',
  `trap 'echo "stopped $$" >> "$HUDDLE_TEST_PIDS"; exit 143' TERM`,
  "sleep 20 &",
  'echo "child $! $$" >> "$HUDDLE_TEST_PIDS"',
  "wait",
  "",
].join("\n");

/** Has the process ended? A zombie has: what is left of it is an exit status that nobody has read yet. */
async function ended(pid: string): Promise<boolean> {
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
}

/** HANGING_GIT in `root`: what a hook's environment needs to run it as git, and what the stand-ins noted. */
async function hangingGit(root: string) {
  const bin = join(root, "bin");
  const notes = join(root, "git.pids");
  await mkdir(bin);
  await writeFile(join(bin, "git"), HANGING_GIT);
  await chmod(join(bin, "git"), 0o755);
  const lines = async (): Promise<string[]> => (await readFile(notes, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return {
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HUDDLE_TEST_PIDS: notes, ...ON_THE_CLOCK },
    lines,
    /** How many times git was started. */
    starts: async (): Promise<number> => (await lines()).filter((line) => line.startsWith("start ")).length,
    /** Each stand-in that got as far as starting its child, which it does once it would note a SIGTERM: [stand-in, child]. */
    pairs: async (): Promise<Array<[string, string]>> =>
      (await lines()).filter((line) => line.startsWith("child ")).map((line): [string, string] => [line.split(" ")[2] ?? "", line.split(" ")[1] ?? ""]),
    /** For a test that fails before the hooks have ended them. */
    killAll: async (): Promise<void> => {
      for (const pid of (await lines()).flatMap((line) => line.split(" ").slice(1))) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Gone already.
        }
      }
    },
  };
}

/**
 * Every stand-in that got as far as starting its child was asked to stop with SIGTERM, and it and its child have
 * ended: the hook signalled the process group. Returns how many there were.
 */
async function noGitLeft(git: Awaited<ReturnType<typeof hangingGit>>): Promise<number> {
  const pairs = await git.pairs();
  for (const [standIn, child] of pairs) {
    await until(`stand-in ${standIn} and its child ${child} to end`, async () => (await ended(standIn)) && (await ended(child)), 10_000);
    assert.ok((await git.lines()).includes(`stopped ${standIn}`), `stand-in ${standIn} ended without a SIGTERM`);
  }
  return pairs.length;
}

test(
  "through the bundle: when git itself hangs, every event gives up at its deadline, exits 0, says nothing and leaves no git behind",
  { skip: process.platform === "win32" ? "needs a shell script to stand in for git" : false },
  async (t) => {
    const { h, bob } = await team(t);
    const git = await hangingGit(h.root);

    try {
      const runs = await Promise.all(
        SIX_OF_CLAUDE.map(([, name]) => timed(() => bob.huddle(["hook", "claude-code"], { stdin: recorded("claude-code", name, bob), env: git.env, now: at(0) }))),
      );
      for (const [index, [type]] of SIX_OF_CLAUDE.entries()) {
        const run = runs[index]!;
        const deadline = DEADLINE_MS[type];
        assert.deepEqual(run.value, QUIET, type);
        // Not before the deadline, since nothing could be done; and not long after it, since the hook does not wait for what it gave up on.
        assert.ok(run.ms >= deadline && run.ms < deadline + 2500, `${type} came back after ${Math.round(run.ms)} ms; its deadline is ${deadline} ms`);
      }
      // It was the stand-in that ran, for each event, and nothing got as far as writing anything.
      assert.ok((await git.starts()) >= SIX_OF_CLAUDE.length, `the stand-in for git ran ${await git.starts()} times`);
      assert.equal(existsSync(join(bob.dir, ".git", "huddle")), false);
      // Its time limit was a timer in the hook, and the hook is gone: on its way out it ended every git it had started.
      assert.ok((await noGitLeft(git)) >= 1, "no stand-in got as far as starting its child");
    } finally {
      await git.killAll();
    }
  },
);

test(
  "through the bundle: a hook that a signal stops ends the gits it started, and exits 0",
  { skip: process.platform === "win32" ? "needs a shell script to stand in for git, and signals" : false },
  async (t) => {
    const { bob, h } = await team(t);
    const git = await hangingGit(h.root);

    try {
      // What an agent sends a hook that runs over its own time limit, and what a terminal sends on Ctrl-C or when it closes.
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        const before = (await git.pairs()).length;
        const hook = spawn(BUNDLE_NODE, [BUNDLE, "hook", "claude-code"], {
          cwd: bob.dir,
          env: { ...process.env, ...git.env, HUDDLE_NOW: at(0) },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const output: string[] = [];
        hook.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        hook.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => hook.once("close", (code, by) => resolve([code, by])));
        hook.stdin.end(recorded("claude-code", "session-start.startup", bob));

        // The start has 4 s for its work, and the git it waits for never answers: it is waiting when the signal comes.
        await until(`the git of the hook that gets ${signal} to start`, async () => (await git.pairs()).length > before);
        hook.kill(signal);
        assert.deepEqual([await exited, output.join("")], [[0, null], ""], signal);
      }
      assert.ok((await noGitLeft(git)) >= 3);
    } finally {
      await git.killAll();
    }
  },
);

test("through the bundle, with syncs in processes of their own: the start waits for its sync, everything after leaves its sync behind", async (t) => {
  const { h, alice } = await team(t);
  // The harness turns detached syncs off. Here they are the point; each one is waited out before the next step.
  const live = { HUDDLE_NO_BACKGROUND: "" };
  const claude = (name: string, seconds: number, over: Json = {}): Promise<RunResult> =>
    alice.huddle(["hook", "claude-code"], { stdin: recorded("claude-code", name, alice, over), now: at(seconds), env: live });
  /** When the clone's last sync began, by the clock that sync was given. */
  const lastSync = async (): Promise<string> => readFile(join((await alice.paths()).stateDir, "sync-stamp"), "utf8").catch(() => "");
  const mine = async () => (await published(h, "alice"))?.sessions ?? [];
  const writes = (path: string): Json => ({ tool_input: { file_path: join(alice.dir, path), content: "one" } });

  try {
    // SessionStart waits for its sync: when the hook is back, the session is on the remote. (Or it took the 3.7 s the wait may last.)
    const start_ = await timed(() => claude("session-start.startup", 0));
    assert.deepEqual(start_.value, prints("SessionStart", ALONE));
    const there = (await mine()).map((session) => session.id);
    assert.ok(there.includes(CLAUDE_SESSION) || start_.ms >= 3500, `the hook was back after ${Math.round(start_.ms)} ms, before its sync had published`);
    await until("the session to be published", async () => (await mine()).length === 1);
    await until("that sync to finish", () => syncIdle(alice));
    assert.equal(await lastSync(), at(0));

    // A prompt with a new intent: published at once, by a process the hook does not wait for.
    assert.deepEqual(await claude("user-prompt-submit.typed", 5, { prompt: AUTH_PROMPT }), QUIET);
    await until("the intent to be published", async () => (await mine())[0]?.intent === AUTH_PROMPT);
    await until("that sync to finish", () => syncIdle(alice));
    assert.equal(await lastSync(), at(5));

    // An edit five seconds later is inside the sync interval of 15 s: no sync, so the file is not out yet.
    await alice.write("src/auth.ts", "export const auth = true;\n");
    assert.deepEqual(await claude("post-tool-use.write", 10, writes("src/auth.ts")), QUIET);
    await sleep(500);
    assert.equal(await lastSync(), at(5));
    assert.deepEqual((await mine())[0]?.files, []);

    // The next edit after the interval takes both files out.
    await alice.write("src/session.ts", "export const session = true;\n");
    assert.deepEqual(await claude("post-tool-use.write", 21, writes("src/session.ts")), QUIET);
    await until("the files to be published", async () => (await mine())[0]?.files.length === 2);
    await until("that sync to finish", () => syncIdle(alice));
    assert.equal(await lastSync(), at(21));
    assert.deepEqual((await mine())[0]?.files, ["src/auth.ts", "src/session.ts"]);

    // The end of the turn does not wait for the interval.
    await alice.write("src/token.ts", "export const token = true;\n");
    assert.deepEqual(await claude("stop", 22), QUIET);
    await until("the turn's last file to be published", async () => (await mine())[0]?.files.length === 3);
    await until("that sync to finish", () => syncIdle(alice));
    assert.equal(await lastSync(), at(22));

    // Neither does the end of the session.
    assert.deepEqual(await claude("session-end", 23), QUIET);
    await until("the session to be gone from the remote", async () => (await mine()).length === 0);
    assert.equal(await lastSync(), at(23));
  } finally {
    // Whatever is still running has to be done before the clone is removed under it.
    await sleep(200);
    await until("every sync to finish", () => syncIdle(alice));
  }
});
