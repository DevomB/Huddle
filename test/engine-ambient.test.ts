// T2.1: events that name no session (HookEvent.ambient), which is what a git
// hook sends, and the wait for a sync that comes before a commit is checked.
//
// The limits on that wait were agreed with the lead, and each is a test here:
// - the limit is a timer in the engine, not git's network timeout;
// - reaching it abandons the wait and never the sync;
// - a clone waits at most once per two minutes, also when the remote does not
//   answer, so whoever is offline pays for it once;
// - the hook's exit code and output are the same whether the sync made it or
//   not, apart from the warning itself.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { getAdapter } from "../src/adapters/index.ts";
import type { HookEvent, HookEventType } from "../src/adapters/types.ts";
import { openContext } from "../src/core/context.ts";
import { manualSessionId } from "../src/core/identity.ts";
import { sync } from "../src/core/sync.ts";
import { handleEvent, runHook } from "../src/hooks/engine.ts";
import {
  MIN,
  aliceBuildsAuth,
  ambient,
  at,
  authWarning,
  eventOf,
  fire,
  forced,
  hold,
  ioFor,
  logOf,
  never,
  publish,
  published,
  record,
  seenKeys,
  sessionOf,
  sessionsOf,
  syncIdle,
  team,
  throttled,
  timed,
  until,
} from "./engine.kit.ts";
import type { Clone } from "./harness.ts";

const NOTHING_ASKED = { background: [], options: [], waited: [] };

/** The session a command typed in the clone's worktree acts as when nothing else says which. */
const ownSession = async (clone: Clone): Promise<string> => manualSessionId(await clone.paths(), {});

// ---------------------------------------------------------------------------
// Which session
// ---------------------------------------------------------------------------

test("an event that names no session becomes the worktree's own session, with the git hook as its agent", async (t) => {
  const { bob } = await team(t);
  await publish(bob, 0);
  const asked = record(t);
  const id = await ownSession(bob);

  assert.deepEqual(await ambient(bob, "post-edit", 30, { native: { hook: "post-commit" } }), {});
  assert.deepEqual(await sessionsOf(bob), [
    { id, agent: "git", branch: "", intent: "", intentSource: "none", files: [], claims: [], startedAt: at(30), seenAt: at(30), worktree: bob.dir },
  ]);
  assert.deepEqual(asked.background, [forced(bob)], "a session that is new is published at once");

  // `huddle intent` typed in the same worktree is the same presence, not a second one.
  const stated = await bob.huddle(["intent", "Review the release notes"], { now: at(40) });
  assert.equal(stated.code, 0, stated.stderr);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.agent, session.intent, session.intentSource]),
    [[id, "git", "Review the release notes", "manual"]],
  );

  // And the next commit there keeps it alive without touching what was said.
  assert.deepEqual(await ambient(bob, "post-edit", 50), {});
  const session = await sessionOf(bob, id);
  assert.deepEqual([session?.seenAt, session?.intent, session?.startedAt], [at(50), "Review the release notes", at(30)]);
  assert.deepEqual(asked.background, [forced(bob), throttled(bob)]);
  assert.deepEqual(asked.waited, []);
});

test("where an agent's session is live, a git hook in that worktree counts as that session and changes nothing about it", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  await fire(bob, "prompt", 22, { prompt: "Add the login page" });
  const before = await sessionOf(bob);
  assert.ok(before);
  const asked = record(t);

  // Whatever the event is called, and whatever session the adapter put in: it is a sign of life for the session that is here.
  const types: HookEventType[] = ["post-edit", "prompt", "turn-end", "session-start", "session-end"];
  for (const [index, type] of types.entries()) {
    const outcome = await ambient(bob, type, 30 + index, { sessionId: "from-the-adapter", prompt: "Rewrite all of it", source: "startup", reason: "other" });
    assert.deepEqual(outcome, {}, type);
  }
  assert.deepEqual(await sessionsOf(bob), [{ ...before, seenAt: at(34) }]);
  assert.ok((await seenKeys(bob)).includes("briefed"), "what the agent's session was shown is not forgotten");
  assert.deepEqual(
    asked.background,
    types.map(() => throttled(bob)),
  );
  assert.deepEqual(asked.waited, []);
});

test("HUDDLE_SESSION says which session a git hook belongs to, also from another worktree, without moving it", async (t) => {
  const { bob } = await team(t);
  await publish(bob, 0);
  // The session-start hook sets it in the agent's shell, so a commit the agent makes carries it.
  await ambient(bob, "post-edit", 10, {}, { HUDDLE_SESSION: "s-terminal" });
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.agent, session.worktree]),
    [["s-terminal", "git", bob.dir]],
  );

  const worktree = await bob.addWorktree("wt");
  await ambient(worktree, "post-edit", 20, {}, { HUDDLE_SESSION: "s-terminal" });
  const sessions = await sessionsOf(bob);
  assert.deepEqual(
    sessions.map((session) => [session.id, session.seenAt, session.worktree]),
    [["s-terminal", at(20), bob.dir]],
  );

  // Without the variable that worktree has a session of its own.
  await ambient(worktree, "post-edit", 30);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.worktree]),
    [
      ["s-terminal", bob.dir],
      [await ownSession(worktree), worktree.dir],
    ],
  );
});

test("a session that has been quiet for longer than the TTL is no longer the worktree's session", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 0);
  await ambient(bob, "post-edit", 14 * MIN + 59);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => session.id),
    ["s-bob"],
    "one second short of the TTL the agent's session is still the one",
  );

  // Its last sign of life was that commit. Fifteen minutes later it has aged out, and a commit is somebody new.
  const later = 14 * MIN + 59 + 15 * MIN;
  await ambient(bob, "post-edit", later);
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => [session.id, session.agent, session.seenAt]),
    [
      ["s-bob", "claude-code", at(14 * MIN + 59)],
      [await ownSession(bob), "git", at(later)],
    ],
  );
});

test("a git hook outside a set-up repository is dropped: it says nothing about a session somewhere else", async (t) => {
  const { h, bob } = await team(t);
  await fire(bob, "session-start", 0);
  const scratch = join(h.root, "scratch");
  const other = join(h.root, "other");
  await mkdir(scratch);
  await bob.git("init", "--quiet", other);
  const asked = record(t);

  // An agent's own event from out there would keep its session alive back home. This one names no session to keep alive.
  assert.deepEqual(await ambient(bob, "post-edit", 10, { cwd: scratch }), {});
  assert.deepEqual(await ambient(bob, "pre-edit", 11, { cwd: other, paths: ["a.ts"] }), {});
  assert.equal((await sessionOf(bob))?.seenAt, at(0));
  assert.equal((await sessionsOf(bob)).length, 1);

  // And a hook that runs in a repository nobody set up does nothing there.
  const commit: HookEvent = { type: "pre-edit", agent: "git", sessionId: "", cwd: other, ambient: true, paths: ["a.ts"] };
  assert.deepEqual(await handleEvent(commit, ioFor(other, { now: at(12) })), {});
  assert.equal(existsSync(join(other, ".git", "huddle")), false);
  assert.deepEqual(asked, NOTHING_ASKED);
});

// ---------------------------------------------------------------------------
// A commit
// ---------------------------------------------------------------------------

test("a commit is checked like an edit and warned every time, and does not wait while the team state is fresh", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 20);
  const asked = record(t);
  // As git gives them: relative to the top of the worktree.
  const commit = { paths: ["src/auth.ts", "README.md"], native: { hook: "pre-commit" } };

  assert.deepEqual(await ambient(bob, "pre-edit", 25, commit), { context: authWarning(25) });
  assert.deepEqual(await ambient(bob, "pre-edit", 26, commit), { context: authWarning(26) }, "whoever commits has no context that holds the first warning");
  assert.deepEqual(await seenKeys(bob, await ownSession(bob)), [], "so nothing is remembered either");
  assert.deepEqual(asked.background, [forced(bob)], "the first one was the first sign of that session");

  // One second short of two minutes after the last fetch is still fresh.
  assert.deepEqual(await ambient(bob, "pre-edit", 139, commit), { context: authWarning(139) });
  assert.deepEqual(asked.waited, []);
  assert.equal(existsSync(join((await bob.paths()).stateDir, "wait-stamp")), false);
});

test("a commit waits for one sync when the team state is stale, and is checked against what came back", async (t) => {
  const { h, bob } = await aliceBuildsAuth(t);
  // Bob's clone has not synced since it was made. Without the wait the check would find nobody.
  const asked = record(t);
  const commit = { paths: ["src/auth.ts"] };

  assert.deepEqual(await ambient(bob, "pre-edit", 25, commit), { context: authWarning(25) });
  assert.equal(asked.waited.length, 1);
  assert.ok(asked.waited[0]! > 0 && asked.waited[0]! <= 1000, `the sync was given ${asked.waited[0]} ms`);
  assert.deepEqual(asked.background, [], "the sync that was waited for publishes the new session as well");
  assert.deepEqual(
    (await published(h, "bob"))?.sessions.map((session) => session.agent),
    ["git"],
  );
  // Recorded with the event's clock, before the wait.
  assert.equal(await readFile(join((await bob.paths()).stateDir, "wait-stamp"), "utf8"), at(25));

  // Two minutes after that fetch the state counts as stale again, and the last wait is two minutes back as well.
  assert.deepEqual(await ambient(bob, "pre-edit", 144, commit), { context: authWarning(144) });
  assert.equal(asked.waited.length, 1);
  assert.deepEqual(await ambient(bob, "pre-edit", 145, commit), { context: authWarning(145) });
  assert.equal(asked.waited.length, 2);
});

test("an agent's own edit never waits, however stale the team state is", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  const asked = record(t);

  // The price is visible here: the cache was never filled, so there is no warning. An agent's hooks sync all the time; that is what fills it.
  assert.deepEqual(await fire(bob, "pre-edit", 25, { paths: ["src/auth.ts"] }), {});
  assert.deepEqual(await fire(bob, "pre-edit", 26, { paths: ["src/auth.ts"], subagent: true }), {});
  assert.deepEqual(asked.waited, []);
  assert.deepEqual(asked.background, [forced(bob)]);
});

test("a commit with nothing to check does not wait", async (t) => {
  const { bob } = await team(t);
  const asked = record(t);
  for (const paths of [[], undefined, ["../outside.ts"], [""]]) {
    assert.deepEqual(await ambient(bob, "pre-edit", 0, { paths }), {}, JSON.stringify(paths));
  }
  assert.deepEqual(asked.waited, []);
  // It is a sign of life all the same.
  assert.deepEqual(
    (await sessionsOf(bob)).map((session) => session.id),
    [await ownSession(bob)],
  );
  assert.deepEqual(asked.background, [forced(bob)]);
});

// ---------------------------------------------------------------------------
// The limits on the wait
// ---------------------------------------------------------------------------

test("the wait ends after a second whatever the sync does, and the commit is checked against the state there is", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 20);
  const asked = record(t, never);
  // Two and a half minutes after the last fetch. Alice is still within the TTL.
  const late = 20 + 150;

  const { ms, value } = await timed(() => ambient(bob, "pre-edit", late, { paths: ["src/auth.ts"] }));
  assert.deepEqual(value, { context: authWarning(late) });
  assert.ok(ms >= 950 && ms < 1400, `the commit was held for ${Math.round(ms)} ms`);
  assert.equal(asked.waited.length, 1);
  assert.deepEqual(asked.background, [], "the sync that was started is not doubled");
});

test("a clone waits at most once in two minutes, in all its worktrees, also when the remote does not answer", async (t) => {
  const { h, bob } = await team(t);
  await bob.git("remote", "set-url", "origin", join(h.root, "gone.git"));
  const worktree = await bob.addWorktree("wt");
  const asked = record(t);
  const commit = { paths: ["a.ts"] };

  assert.deepEqual(await ambient(bob, "pre-edit", 0, commit), {});
  assert.equal(asked.waited.length, 1, "the first commit waits");

  // The sync came back empty-handed, so the state is as stale as before. Still nobody waits again for two minutes.
  assert.deepEqual(await ambient(bob, "pre-edit", 30, commit), {});
  assert.deepEqual(await ambient(worktree, "pre-edit", 60, commit), {});
  assert.deepEqual(await ambient(bob, "pre-edit", 119, commit), {});
  assert.equal(asked.waited.length, 1, "being offline is paid for once, not at every commit");

  assert.deepEqual(await ambient(worktree, "pre-edit", 120, commit), {});
  assert.equal(asked.waited.length, 2, "two minutes on, one more try");
  assert.match(await logOf(bob), /\[sync\] fetch failed/);
});

test("a stamp from the future or one that says nothing does not put the wait off; one that cannot be written means no wait", async (t) => {
  const { h, bob } = await team(t);
  // The remote is gone, so the state stays stale and only the stamp decides.
  await bob.git("remote", "set-url", "origin", join(h.root, "gone.git"));
  const paths = await bob.paths();
  const stamp = join(paths.stateDir, "wait-stamp");
  await mkdir(paths.stateDir, { recursive: true });
  const asked = record(t);
  const commit = { paths: ["a.ts"] };

  // A clock that was set back leaves a stamp from the future.
  await writeFile(stamp, at(3600));
  await ambient(bob, "pre-edit", 0, commit);
  assert.equal(asked.waited.length, 1);
  assert.equal(await readFile(stamp, "utf8"), at(0));

  await writeFile(stamp, "not a date\n");
  await ambient(bob, "pre-edit", 10, commit);
  assert.equal(asked.waited.length, 2);

  // If the stamp cannot be written there would be no limit on how often a commit waits. So it does not wait at all.
  await rm(stamp);
  await mkdir(stamp);
  assert.deepEqual(await ambient(bob, "pre-edit", 500, commit), {});
  assert.equal(asked.waited.length, 2);
  assert.match(await logOf(bob), /\[hook\] pre-edit: could not refresh the team state first/);
});

test("reaching the limit abandons the wait and never the sync: a real one that is held up still publishes afterwards", async (t) => {
  const { h, alice, bob } = await team(t);
  // The real clock throughout: the sync that is waited for runs in a process of its own.
  await handleEvent(eventOf(alice, "session-start"), ioFor(alice));
  await alice.write("src/auth.ts", "export const auth = true;\n");
  await sync(await openContext(ioFor(alice)), { force: true });
  const commit: HookEvent = { type: "pre-edit", agent: "git", sessionId: "", cwd: bob.dir, ambient: true, paths: ["src/auth.ts"] };

  // Another sync of bob's clone is under way and does not finish: the one the commit starts has to queue behind it.
  let release: (() => Promise<void>) | null = await hold(bob, "sync", 60_000);
  const saved = process.env.HUDDLE_NO_BACKGROUND;
  delete process.env.HUDDLE_NO_BACKGROUND;
  try {
    const { ms, value } = await timed(() => handleEvent(commit, ioFor(bob)));
    assert.deepEqual(value, {}, "checked against the state there is, which is none");
    assert.ok(ms >= 950 && ms < 1450, `the commit was held for ${Math.round(ms)} ms`);
    assert.equal(await published(h, "bob"), undefined, "the sync is still waiting for its turn");

    await release();
    release = null;
    await until("the sync that was not waited for to publish", async () => (await published(h, "bob")) !== undefined);
    await until("that sync to finish", () => syncIdle(bob));
    assert.deepEqual(
      (await published(h, "bob"))?.sessions.map((session) => session.agent),
      ["git"],
    );

    // It fetched as well, so the next commit is warned, and has no reason to wait.
    const next = await timed(() => handleEvent(commit, ioFor(bob)));
    assert.match(next.value.context ?? "", /^\[huddle\] src\/auth\.ts overlaps teammates' work in flight\.[^\n]*\n- alice \/ claude-code on main \([^)]*\) has it in flight: no stated intent\.\n/);
    assert.ok(next.ms < 900, `the next commit took ${Math.round(next.ms)} ms`);
  } finally {
    if (saved === undefined) delete process.env.HUDDLE_NO_BACKGROUND;
    else process.env.HUDDLE_NO_BACKGROUND = saved;
    await release?.();
    await until("every sync to finish", () => syncIdle(bob));
  }
});

test("through the hook command: the same exit code and output whether the sync failed, hung or was not tried", async (t) => {
  const { h, bob } = await aliceBuildsAuth(t);
  await publish(bob, 20);
  await bob.git("remote", "set-url", "origin", join(h.root, "gone.git"));
  const stamp = join((await bob.paths()).stateDir, "wait-stamp");

  // The adapter that sends such events is T3.2's. Until it is here, one is made of Codex's: same payload, no session.
  const codex = getAdapter("codex");
  assert.ok(codex);
  const parse = codex.parse;
  codex.parse = (input) => {
    const event = parse(input);
    return event === null ? null : { ...event, agent: "git", sessionId: "", ambient: true };
  };
  t.after(() => {
    codex.parse = parse;
  });
  const payload = JSON.stringify({
    session_id: "not-used",
    cwd: bob.dir,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.ts\n@@\n-a\n+b\n*** End Patch" },
  });
  // Two and a half minutes after bob's last fetch: stale, and alice still within the TTL.
  const late = 20 + 150;
  const run = async (): Promise<{ code: number; stdout: string[]; stderr: string[] }> => {
    const io = ioFor(bob, { now: at(late), stdin: payload });
    const code = await runHook(["codex"], io);
    return { code, stdout: io.stdout, stderr: io.stderr };
  };
  const warned = {
    code: 0,
    stdout: [JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: authWarning(late) } })],
    stderr: [],
  };

  // The sync runs and fails: the remote is gone.
  assert.deepEqual(await run(), warned);
  assert.equal(await readFile(stamp, "utf8"), at(late), "it did wait");

  // The sync never comes back.
  const asked = record(t, never);
  await rm(stamp);
  assert.deepEqual(await run(), warned);
  assert.equal(asked.waited.length, 1);

  // No sync is tried: the clone has just waited.
  assert.deepEqual(await run(), warned);
  assert.equal(asked.waited.length, 1);
});
