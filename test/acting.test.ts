// Which session a process is (src/core/acting.ts). The rule under test: a
// process acts as a session only when something proves it is that session,
// and being the one that was active last proves nothing.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCode } from "../src/adapters/claude-code.ts";
import { codex } from "../src/adapters/codex.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import { IdentityRequired, MANUAL, describeActing, requireActing, resolveActing, sessionIdOf, witnessesOf, worktreeSessionId } from "../src/core/acting.ts";
import type { Acting, ActingContext } from "../src/core/acting.ts";
import { takeSession } from "../src/core/args.ts";
import { EXIT, UsageError } from "../src/core/io.ts";
import { readLocal } from "../src/core/store.ts";
import { DEFAULT_CONFIG } from "../src/core/types.ts";
import { ambient, at, fire, ioFor, sessionsOf, team } from "./engine.kit.ts";
import type { Clone } from "./harness.ts";

const CLAUDE = "6835a033-358b-4497-a94e-356ac1bac1e3";
const CODEX = "0199a213-81c0-7800-8aa1-bbab2a035a53";

interface Asking {
  /** Seconds after T0. */
  now: number;
  env?: NodeJS.ProcessEnv;
  /** The `--session` option. */
  session?: string;
  argv?: string[];
  /** The path of the running script, when the case is about how the command line is shown again. */
  self?: string;
}

/** What a command run in the clone's worktree, at that moment and in that environment, hands the resolver. */
async function asking(clone: Clone, opts: Asking): Promise<ActingContext> {
  const io = ioFor(clone, { now: at(opts.now), env: opts.env ?? {} });
  if (opts.session !== undefined) io.session = opts.session;
  if (opts.argv !== undefined) io.argv = opts.argv;
  if (opts.self !== undefined) io.self = opts.self;
  return { io, paths: await clone.paths(), config: DEFAULT_CONFIG, now: new Date(at(opts.now)) };
}

const who = (acting: Acting): Array<string | null> => [acting.id, acting.kind, acting.source, acting.agent];

/** A Claude Code session and a Codex session in bob's worktree, each started by its own hooks. `last` was active last. */
async function twoAgents(bob: Clone, last: "claude" | "codex"): Promise<void> {
  const start = (agent: string, sessionId: string, seconds: number) => fire(bob, "session-start", seconds, { agent, sessionId });
  await start("claude-code", CLAUDE, last === "claude" ? 20 : 10);
  await start("codex", CODEX, last === "codex" ? 20 : 10);
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

test("each agent's own variable names its session, the way its hook payloads do", () => {
  assert.equal(claudeCode.sessionVariable, "CLAUDE_CODE_SESSION_ID");
  assert.equal(codex.sessionVariable, "CODEX_SESSION_ID");
  assert.deepEqual(
    ADAPTERS.filter((adapter) => adapter.sessionVariable !== undefined).map((adapter) => adapter.name),
    ["claude-code", "codex"],
    "git hooks have no session of their own",
  );

  assert.deepEqual(witnessesOf({}), []);
  assert.deepEqual(witnessesOf({ CLAUDE_CODE_SESSION_ID: CLAUDE }), [{ source: "CLAUDE_CODE_SESSION_ID", id: CLAUDE, agent: "claude-code" }]);
  assert.deepEqual(witnessesOf({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: "a-subagent-thread" }), [{ source: "CODEX_SESSION_ID", id: CODEX, agent: "codex" }]);
  assert.deepEqual(witnessesOf({ HUDDLE_SESSION: "by-hand", CODEX_SESSION_ID: CODEX }), [
    { source: "HUDDLE_SESSION", id: "by-hand", agent: "" },
    { source: "CODEX_SESSION_ID", id: CODEX, agent: "codex" },
  ]);
  // Empty and blank values are no statement at all.
  assert.deepEqual(witnessesOf({ HUDDLE_SESSION: " ", CLAUDE_CODE_SESSION_ID: "", CODEX_SESSION_ID: " \n" }), []);
  // The id is made into the one the hook engine makes of the payload's: the same function.
  const long = "y".repeat(300);
  assert.deepEqual(witnessesOf({ CLAUDE_CODE_SESSION_ID: `  ${long}\n` }), [{ source: "CLAUDE_CODE_SESSION_ID", id: sessionIdOf(long), agent: "claude-code" }]);
});

test("a command run by an agent is that agent's session, whichever session was active last", async (t) => {
  for (const last of ["claude", "codex"] as const) {
    const { bob } = await team(t);
    await twoAgents(bob, last);

    const asClaude = await resolveActing(await asking(bob, { now: 30, env: { CLAUDE_CODE_SESSION_ID: CLAUDE } }));
    assert.deepEqual(who(asClaude), [CLAUDE, "agent", "CLAUDE_CODE_SESSION_ID", "claude-code"], last);
    assert.equal(asClaude.session?.id, CLAUDE);
    assert.deepEqual(asClaude.candidates, []);

    const asCodex = await resolveActing(await asking(bob, { now: 30, env: { CODEX_SESSION_ID: CODEX } }));
    assert.deepEqual(who(asCodex), [CODEX, "agent", "CODEX_SESSION_ID", "codex"], last);

    const byHand = await resolveActing(await asking(bob, { now: 30, env: { HUDDLE_SESSION: CODEX } }));
    assert.deepEqual(who(byHand), [CODEX, "explicit", "HUDDLE_SESSION", "codex"], last);

    const byOption = await resolveActing(await asking(bob, { now: 30, session: CLAUDE }));
    assert.deepEqual(who(byOption), [CLAUDE, "explicit", "--session", "claude-code"], last);
  }
});

test("an agent whose hooks never ran is still its own session: its variable names it, and it is recorded as that agent's", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 10, { agent: "claude-code", sessionId: CLAUDE });
  // Codex in a project it does not trust runs no hook, so nothing here knows its session. Its shell commands carry the id all the same.
  const acting = await resolveActing(await asking(bob, { now: 20, env: { CODEX_SESSION_ID: CODEX } }));
  assert.deepEqual(who(acting), [CODEX, "agent", "CODEX_SESSION_ID", "codex"]);
  assert.equal(acting.session, null, "nothing has created it yet");
  assert.deepEqual(await sessionsOf(bob).then((sessions) => sessions.map((session) => session.id)), [CLAUDE], "and asking creates nothing");
});

test("with nothing in the environment, a live session in the worktree means nothing is proven", async (t) => {
  for (const last of ["claude", "codex"] as const) {
    const { bob } = await team(t);
    await twoAgents(bob, last);
    const acting = await resolveActing(await asking(bob, { now: 30 }));
    assert.deepEqual(who(acting), [null, "unbound", "", MANUAL], last);
    assert.equal(acting.session, null);
    assert.deepEqual(
      acting.candidates.map((session) => session.id),
      last === "claude" ? [CLAUDE, CODEX] : [CODEX, CLAUDE],
      "the sessions it could be, most recently active first",
    );
  }

  // One live session is no proof either: a person typing next to their agent is exactly this case.
  const { bob } = await team(t);
  await fire(bob, "session-start", 10, { agent: "claude-code", sessionId: CLAUDE });
  const acting = await resolveActing(await asking(bob, { now: 30 }));
  assert.equal(acting.id, null);
  assert.deepEqual(
    acting.candidates.map((session) => session.id),
    [CLAUDE],
  );
});

test("an environment that contradicts itself proves nothing; one that agrees with itself does", async (t) => {
  const { bob } = await team(t);
  await twoAgents(bob, "codex");

  // An agent started from inside another one inherits the outer one's variable next to its own.
  const nested = await resolveActing(await asking(bob, { now: 30, env: { CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_SESSION_ID: CODEX } }));
  assert.deepEqual(who(nested), [null, "unbound", "", MANUAL]);
  assert.deepEqual(
    nested.witnesses.map((witness) => [witness.source, witness.id]),
    [
      ["CLAUDE_CODE_SESSION_ID", CLAUDE],
      ["CODEX_SESSION_ID", CODEX],
    ],
  );

  // A HUDDLE_SESSION inherited from the shell the agent was started in does not win over the agent's own variable, and is not silently dropped either.
  const inherited = await resolveActing(await asking(bob, { now: 30, env: { HUDDLE_SESSION: CLAUDE, CODEX_SESSION_ID: CODEX } }));
  assert.equal(inherited.id, null);

  // The option on the command line settles it, for either.
  for (const id of [CLAUDE, CODEX]) {
    const settled = await resolveActing(await asking(bob, { now: 30, session: id, env: { CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_SESSION_ID: CODEX } }));
    assert.deepEqual([settled.id, settled.kind, settled.source], [id, "explicit", "--session"]);
  }

  // Two variables that name one session are no contradiction.
  const agreed = await resolveActing(await asking(bob, { now: 30, env: { HUDDLE_SESSION: CLAUDE, CLAUDE_CODE_SESSION_ID: CLAUDE } }));
  assert.deepEqual(who(agreed), [CLAUDE, "explicit", "HUDDLE_SESSION", "claude-code"]);
});

// ---------------------------------------------------------------------------
// The worktree's own session
// ---------------------------------------------------------------------------

test("alone in a worktree, a command is the worktree's own session", async (t) => {
  const { bob } = await team(t);
  const own = worktreeSessionId(await bob.paths());
  assert.match(own, /^manual-[0-9a-f]{8}$/);

  const first = await resolveActing(await asking(bob, { now: 10 }));
  assert.deepEqual(who(first), [own, "worktree", "", MANUAL]);
  assert.equal(first.session, null);
  assert.deepEqual(await sessionsOf(bob), [], "asking creates nothing");

  // Once it exists it is still the only one here, so it stays that. A git hook made it, which is what its agent says.
  await ambient(bob, "post-edit", 20);
  const second = await resolveActing(await asking(bob, { now: 30 }));
  assert.deepEqual(who(second), [own, "worktree", "", "git"]);
  assert.equal(second.session?.id, own);

  // Another worktree of the same clone has its own, and a session over there does not make this one doubtful.
  const side = await bob.addWorktree("side");
  await fire(side, "session-start", 40, { agent: "claude-code", sessionId: CLAUDE });
  assert.equal((await resolveActing(await asking(side, { now: 41 }))).id, null, "in the worktree the agent is in, nothing is proven");
  assert.deepEqual(who(await resolveActing(await asking(bob, { now: 41 }))), [own, "worktree", "", "git"]);
  assert.notEqual(worktreeSessionId(await side.paths()), own);
});

test("a session that has been quiet for the TTL is not in the way any more", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 0, { agent: "claude-code", sessionId: CLAUDE });
  const ttl = DEFAULT_CONFIG.ttlMinutes * 60;
  assert.equal((await resolveActing(await asking(bob, { now: ttl - 1 }))).id, null);
  assert.equal((await resolveActing(await asking(bob, { now: ttl }))).kind, "worktree");
});

// ---------------------------------------------------------------------------
// --session
// ---------------------------------------------------------------------------

test("--session names a session of this worktree, the worktree's own with the word manual, or what the environment names", async (t) => {
  const { bob } = await team(t);
  await twoAgents(bob, "claude");
  const own = worktreeSessionId(await bob.paths());

  const manual = await resolveActing(await asking(bob, { now: 30, session: "manual" }));
  assert.deepEqual(who(manual), [own, "explicit", "--session", MANUAL]);
  // Whatever HUDDLE_SESSION says, the word means the worktree's own session, and the option wins.
  const still = await resolveActing(await asking(bob, { now: 30, session: "manual", env: { HUDDLE_SESSION: CLAUDE } }));
  assert.equal(still.id, own);

  // A session that is not on record but that the environment names: an agent whose hooks did not run can say it is itself.
  const unseen = "0199a213-0000-7000-8000-000000000001";
  const itself = await resolveActing(await asking(bob, { now: 30, session: unseen, env: { HUDDLE_SESSION: CLAUDE, CODEX_SESSION_ID: unseen } }));
  assert.deepEqual(who(itself), [unseen, "explicit", "--session", "codex"]);
});

test("--session with an id that is nobody's is refused: a typing mistake never acts as, or makes, another session", async (t) => {
  const { bob } = await team(t);
  await twoAgents(bob, "claude");
  const before = await readLocal(await bob.paths());

  for (const wrong of [CLAUDE.slice(0, 8), `${CLAUDE}x`, "claude", "s-nobody"]) {
    await assert.rejects(
      async () => resolveActing(await asking(bob, { now: 30, session: wrong })),
      (error: unknown) => {
        assert.ok(error instanceof UsageError, wrong);
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.match(error.message, /is not a session of this worktree, so nothing was done/);
        assert.ok(error.message.includes(CLAUDE) && error.message.includes(CODEX), "the sessions that are here are listed");
        assert.match(error.message, /--session manual/);
        return true;
      },
    );
  }
  assert.deepEqual(await readLocal(await bob.paths()), before);

  // A session of another worktree of this clone is named as that, with where it is.
  const side = await bob.addWorktree("side");
  await assert.rejects(
    async () => resolveActing(await asking(side, { now: 31, session: CLAUDE })),
    (error: unknown) => error instanceof UsageError && error.message.includes("is a session of another worktree") && error.message.includes(bob.dir),
  );
});

test("the option is taken off the command line wherever it stands, and never out of a command's own text or a hook's arguments", () => {
  assert.deepEqual(takeSession(["status"]), { argv: ["status"] });
  assert.deepEqual(takeSession(["--session", "abc", "claim", "src/**"]), { argv: ["claim", "src/**"], session: "abc" });
  assert.deepEqual(takeSession(["claim", "src/**", "--session", "abc"]), { argv: ["claim", "src/**"], session: "abc" });
  assert.deepEqual(takeSession(["task", "--session=manual", "claim", "abcd2345"]), { argv: ["task", "claim", "abcd2345"], session: "manual" });
  assert.deepEqual(takeSession(["--session", " abc "]), { argv: [], session: "abc" });
  // After "--" everything is the command's own text.
  assert.deepEqual(takeSession(["decide", "--", "--session", "x"]), { argv: ["decide", "--", "--session", "x"] });
  assert.deepEqual(takeSession(["--session", "abc", "intent", "--", "--session=y"]), { argv: ["intent", "--", "--session=y"], session: "abc" });
  // A hook's arguments are its agent's, and a hook's session is the one in its payload.
  assert.deepEqual(takeSession(["hook", "git", "pre-commit", "--session", "x"]), { argv: ["hook", "git", "pre-commit", "--session", "x"] });
  // An argument that only contains the word is not the option.
  assert.deepEqual(takeSession(["intent", "document the --session option"]), { argv: ["intent", "document the --session option"] });

  for (const bad of [["--session"], ["claim", "--session"], ["--session", ""], ["--session", "  "], ["--session="], ["--session", "--json"], ["--session", "a", "--session", "b"], ["--session=a", "status", "--session=a"]]) {
    assert.throws(
      () => takeSession(bad),
      (error: unknown) => error instanceof UsageError && error.exitCode === EXIT.USAGE,
      JSON.stringify(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

test("requireActing gives the session when it is proven, and otherwise refuses with a command line for each session it could be", async (t) => {
  const { bob } = await team(t);
  await twoAgents(bob, "codex");
  const own = worktreeSessionId(await bob.paths());
  const before = await readLocal(await bob.paths());

  const proven = await requireActing(await asking(bob, { now: 30, env: { CODEX_SESSION_ID: CODEX } }));
  assert.equal(proven.id, CODEX);

  // The bundle the team vendored, run from a subdirectory, with an argument a shell would act on.
  const ctx = await asking(bob, { now: 30, argv: ["claim", "src/api/**", "it's mine"], self: join(bob.dir, ".huddle", "huddle.mjs") });
  ctx.io.cwd = join(bob.dir, "src");
  let refused: unknown;
  try {
    await requireActing(ctx);
  } catch (error) {
    refused = error;
  }
  assert.ok(refused instanceof IdentityRequired);
  assert.ok(refused instanceof UsageError);
  assert.equal(refused.exitCode, EXIT.USAGE);
  assert.equal(refused.acting.id, null);
  const lines = refused.message.split("\n");
  assert.equal(
    lines[0],
    "this command acts as a session, and which one is not proven: 2 sessions are active in this worktree, and nothing says whether this command comes from one of them. Nothing was changed.",
  );
  assert.equal(lines[1], "Run it again and say which session it is:");
  const windows = process.platform === "win32";
  const rest = windows ? 'claim "src/api/**" "it\'s mine"' : "claim 'src/api/**' 'it'\\''s mine'";
  assert.deepEqual(lines.slice(2), [
    `  node ../.huddle/huddle.mjs --session ${CODEX} ${rest}   (codex, active 10s ago)`,
    `  node ../.huddle/huddle.mjs --session ${CLAUDE} ${rest}   (claude-code, active 20s ago)`,
    `  node ../.huddle/huddle.mjs --session manual ${rest}   (yourself, typing in this worktree)`,
  ]);
  assert.equal(refused.message.includes(own), false, "the worktree's own session is offered by its word, not its id");
  assert.deepEqual(await readLocal(await bob.paths()), before, "nothing was changed");

  // Started from somewhere else (the launcher on PATH): the command is `git huddle`.
  const installed = await asking(bob, { now: 30, argv: ["release"], self: join(bob.dir, "..", "elsewhere", "huddle.mjs") });
  await assert.rejects(
    () => requireActing(installed),
    (error: unknown) => error instanceof IdentityRequired && error.message.includes(`  git huddle --session ${CODEX} release   (codex, active 10s ago)`),
  );

  // Arguments that one line cannot carry are not pretended to be one.
  const multiline = await asking(bob, { now: 30, argv: ["intent", "first line\nsecond line"], self: join(bob.dir, ".huddle", "huddle.mjs") });
  await assert.rejects(
    () => requireActing(multiline),
    (error: unknown) => error instanceof IdentityRequired && error.message.includes(`  node .huddle/huddle.mjs --session manual <the same command>   (yourself, typing in this worktree)`),
  );
});

test("a refusal for an environment that contradicts itself says what each variable names, and offers each", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 10, { agent: "claude-code", sessionId: CLAUDE });
  // Codex, started from the Claude Code session's shell, in a project where its own hooks do not run.
  const ctx = await asking(bob, { now: 30, argv: ["intent", "review"], env: { CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_SESSION_ID: CODEX }, self: join(bob.dir, ".huddle", "huddle.mjs") });
  await assert.rejects(
    () => requireActing(ctx),
    (error: unknown) => {
      assert.ok(error instanceof IdentityRequired);
      assert.deepEqual(error.message.split("\n"), [
        `this command acts as a session, and which one is not proven: CLAUDE_CODE_SESSION_ID names ${CLAUDE}, CODEX_SESSION_ID names ${CODEX}. A process started inside an agent session inherits that session's variables. Nothing was changed.`,
        "Run it again and say which session it is:",
        `  node .huddle/huddle.mjs --session ${CLAUDE} intent review   (what CLAUDE_CODE_SESSION_ID names, active 20s ago)`,
        `  node .huddle/huddle.mjs --session ${CODEX} intent review   (what CODEX_SESSION_ID names)`,
        "  node .huddle/huddle.mjs --session manual intent review   (yourself, typing in this worktree)",
      ]);
      return true;
    },
  );
  // And each of the lines it offers is accepted.
  for (const id of [CLAUDE, CODEX, "manual"]) {
    const again = await asking(bob, { now: 31, session: id, env: { CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_SESSION_ID: CODEX } });
    assert.equal((await requireActing(again)).kind, "explicit", id);
  }
});

test("describeActing is one line that says who and why", async (t) => {
  const { bob } = await team(t);
  const own = worktreeSessionId(await bob.paths());
  assert.equal(describeActing(await resolveActing(await asking(bob, { now: 5 }))), `acting as this worktree's own session ${own} (no other session is active here)`);

  await twoAgents(bob, "claude");
  const line = async (opts: Omit<Asking, "now">): Promise<string> => describeActing(await resolveActing(await asking(bob, { now: 30, ...opts })));
  assert.equal(await line({ env: { CLAUDE_CODE_SESSION_ID: CLAUDE } }), `acting as claude-code session ${CLAUDE} (from CLAUDE_CODE_SESSION_ID)`);
  assert.equal(await line({ env: { HUDDLE_SESSION: "by-hand" } }), "acting as session by-hand (from HUDDLE_SESSION)");
  assert.equal(await line({ session: CODEX }), `acting as codex session ${CODEX} (--session)`);
  assert.equal(await line({ session: "manual" }), `acting as session ${own} (--session)`);
  assert.equal(await line({}), "not proven: 2 sessions are active in this worktree, and nothing says whether this command comes from one of them");
  assert.equal(
    await line({ env: { HUDDLE_SESSION: CLAUDE, CODEX_SESSION_ID: CODEX } }),
    `not proven: HUDDLE_SESSION names ${CLAUDE}, CODEX_SESSION_ID names ${CODEX}. A process started inside an agent session inherits that session's variables`,
  );
  for (const text of [await line({}), await line({ session: CODEX })]) assert.equal(text.includes("\n"), false);
});
