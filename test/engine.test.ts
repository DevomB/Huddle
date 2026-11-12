// T2.1: the hook engine, one event at a time (src/hooks/engine.ts), in-process
// on real clones. The plan's exit test: "unit tests per event, including the
// time budgets and 'internal error still exits 0'". The same engine through
// the built bundle is in hook.test.ts; events that name no session are in
// engine-ambient.test.ts.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { HookEvent, HookEventType } from "../src/adapters/types.ts";
import type { Io } from "../src/core/io.ts";
import { OVERLAP_HINT } from "../src/core/render.ts";
import type { ActorDoc } from "../src/core/types.ts";
import { DEADLINE_MS, handleEvent, sessionIdOf } from "../src/hooks/engine.ts";
import { REDACTED } from "../src/hooks/intent.ts";
import {
  ALONE,
  AUTH_PROMPT,
  CUT_NOTE,
  DELTA_HEAD,
  FULL_FOOT,
  FULL_HEAD,
  MIN,
  NEVER_FETCHED,
  NOTHING_ASKED,
  SAY_SO,
  ago,
  aliceBuildsAuth,
  aliceLine,
  at,
  authWarning,
  cacheTeam,
  eventOf,
  fire,
  forced,
  hold,
  ioFor,
  logOf,
  moreNote,
  never,
  overlapHead,
  publish,
  published,
  record,
  remoteSession,
  seenKeys,
  sessionOf,
  sessionsOf,
  sleep,
  staleNote,
  team,
  teammate,
  text,
  throttled,
  timed,
} from "./engine.kit.ts";
import { createHarness } from "./harness.ts";

/** Values shaped like a credential are put together at run time: see test/source.test.ts. */
const tok = (...parts: string[]) => parts.join("");

test("the deadlines are the time budgets of the plan, except session-end", () => {
  assert.deepEqual({ ...DEADLINE_MS }, { "session-start": 4000, prompt: 300, "pre-edit": 150, "post-edit": 150, "turn-end": 150, "session-end": 1000 });
  assert.ok(Object.isFrozen(DEADLINE_MS));
});

// ---------------------------------------------------------------------------
// session-start
// ---------------------------------------------------------------------------

test("session-start records the session, waits for one sync and gives the full briefing", async (t) => {
  const { h, alice } = await team(t);
  const asked = record(t);
  const outcome = await fire(alice, "session-start", 0, { source: "startup" });

  // HUDDLE_SESSION is for the agent's shell: `huddle intent` typed there lands in this session.
  assert.deepEqual(outcome, { env: { HUDDLE_SESSION: "s-alice" }, context: ALONE });
  assert.deepEqual(await sessionsOf(alice), [
    { id: "s-alice", agent: "claude-code", branch: "main", intent: "", intentSource: "none", files: [], claims: [], startedAt: at(0), seenAt: at(0), worktree: alice.dir },
  ]);

  // One sync, waited for, with what is left of the 4 s after a reserve for the briefing.
  assert.equal(asked.waited.length, 1);
  assert.ok(asked.waited[0]! > 3000 && asked.waited[0]! <= 3700, `the sync was given ${asked.waited[0]} ms`);
  assert.deepEqual(asked.background, [], "the sync that was waited for publishes the session; no second one is needed");
  const doc = await published(h, "alice");
  assert.deepEqual(doc?.sessions.map((session) => [session.id, session.agent, session.branch]), [["s-alice", "claude-code", "main"]]);
  assert.deepEqual(await seenKeys(alice), ["briefed", "tasks"]);
});

test("session-start names each teammate with branch, intent and files in flight", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  const outcome = await fire(bob, "session-start", 20);
  assert.deepEqual(outcome, { env: { HUDDLE_SESSION: "s-bob" }, context: text(FULL_HEAD, aliceLine(20), FULL_FOOT) });
});

test("every session-start briefs in full again and forgets the warnings, but the session stays the same one", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };
  await fire(bob, "session-start", 20);
  await fire(bob, "prompt", 22, { prompt: "Add the login page" });
  assert.equal((await fire(bob, "pre-edit", 25, edit)).context, authWarning(25));
  assert.deepEqual(await fire(bob, "pre-edit", 26, edit), {});

  // The context was compacted: what the session was shown is no longer in it.
  const again = await fire(bob, "session-start", 30, { source: "compact" });
  assert.deepEqual(again, { env: { HUDDLE_SESSION: "s-bob" }, context: text(FULL_HEAD, aliceLine(30), FULL_FOOT) });
  assert.equal((await fire(bob, "pre-edit", 35, edit)).context, authWarning(35));

  const session = await sessionOf(bob);
  assert.equal(session?.startedAt, at(20));
  assert.equal(session?.intent, "Add the login page");
  assert.equal(session?.intentSource, "prompt");
  assert.equal((await sessionsOf(bob)).length, 1);
});

test("session-start says so when the team state could not be refreshed, or was never fetched", async (t) => {
  const { h, bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  await bob.git("remote", "set-url", "origin", join(h.root, "gone.git"));

  // Nine minutes on, the remote does not answer. Alice is within the TTL, so she is still shown, with a warning.
  const late = 20 + 9 * MIN;
  const stale = await fire(bob, "session-start", late, { source: "resume" });
  assert.equal(stale.context, text(FULL_HEAD, aliceLine(late), FULL_FOOT, staleNote("9m ago")));
  assert.deepEqual(stale.env, { HUDDLE_SESSION: "s-bob" });

  const carol = await h.clone("carol");
  await carol.git("remote", "set-url", "origin", join(h.root, "gone.git"));
  assert.equal((await fire(carol, "session-start", 30)).context, text(ALONE, NEVER_FETCHED));
  assert.match(await logOf(carol), /\[sync\] fetch failed/);
});

test("session-start does not wait for a sync that never comes back: the briefing is built from what there is", async (t) => {
  const { alice } = await team(t);
  const asked = record(t, never);
  const { ms, value } = await timed(() => fire(alice, "session-start", 0));

  assert.deepEqual(value, { env: { HUDDLE_SESSION: "s-alice" }, context: text(ALONE, NEVER_FETCHED) });
  assert.ok(ms >= 3500 && ms < DEADLINE_MS["session-start"], `took ${Math.round(ms)} ms`);
  assert.equal(asked.waited.length, 1);
  assert.equal((await sessionOf(alice))?.seenAt, at(0), "the session is recorded before the wait");
});

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

test("prompt records the intent: one scrubbed line of at most 200 characters, published at once", async (t) => {
  const { h, alice } = await team(t);
  await fire(alice, "session-start", 0);
  const asked = record(t);

  assert.deepEqual(await fire(alice, "prompt", 5, { prompt: "  Build the JWT\n middleware   in src/auth.ts " }), {}, "nobody else is here: nothing to say");
  let session = await sessionOf(alice);
  assert.equal(session?.intent, AUTH_PROMPT);
  assert.equal(session?.intentSource, "prompt");
  assert.equal(session?.seenAt, at(5));
  assert.deepEqual(asked.background, [forced(alice)], "a new intent is what teammates need to see: the sync is not left to the throttle");
  assert.deepEqual(asked.waited, [], "a prompt never waits for the network");

  // The same prompt again changes nothing, so its sync is left to the throttle, with the event's own clock.
  await fire(alice, "prompt", 6, { prompt: AUTH_PROMPT });
  assert.deepEqual(asked.background, [forced(alice), throttled(alice)]);
  assert.equal(asked.options[1]?.now?.toISOString(), at(6));
  assert.equal(asked.options[1]?.config?.syncIntervalSeconds, 15);

  await fire(alice, "prompt", 7, { prompt: `refactor ${"the parser ".repeat(40)}` });
  session = await sessionOf(alice);
  assert.equal(Array.from(session?.intent ?? "").length, 200);
  assert.ok(session?.intent.startsWith("refactor the parser the parser"));

  // What looks like a credential never reaches the intent, and so never the remote.
  const assigned = tok("API_", "KEY=");
  await fire(alice, "prompt", 8, { prompt: `deploy with ${assigned}abc123 and ${tok("gh", "p_", "x".repeat(36))} now` });
  assert.equal((await sessionOf(alice))?.intent, `deploy with ${assigned}${REDACTED} and ${REDACTED} now`);
  await publish(alice, 9);
  const raw = JSON.stringify(await published(h, "alice"));
  assert.ok(raw.includes(REDACTED) && !raw.includes("abc123") && !raw.includes("xxxx"), raw);
});

test("prompt with captureIntent off records no intent, and still briefs", async (t) => {
  const { h, alice, bob } = await aliceBuildsAuth(t, { captureIntent: false });
  assert.equal((await sessionOf(alice))?.intent, "");
  assert.equal((await sessionOf(alice))?.intentSource, "none");
  assert.equal((await published(h, "alice"))?.sessions[0]?.intent, "");

  await publish(bob, 15);
  const asked = record(t);
  const first = await fire(bob, "prompt", 20, { prompt: "Add the login page" });
  assert.equal(first.context, text(FULL_HEAD, "- alice / claude-code on main (10s ago): no stated intent. Files: src/auth.ts", FULL_FOOT));
  assert.equal((await sessionOf(bob))?.intent, "");
  assert.deepEqual(asked.background, [forced(bob)], "forced because the session is new, not because of an intent");
});

test("captureIntent switched off while a session runs takes back the intent a prompt gave it, at the session's next event", async (t) => {
  const { h, alice } = await team(t);
  /** The team's setting as this checkout has it: what a pull of the change leaves behind. */
  const capture = (on: boolean): Promise<void> => alice.write(".huddle/config.json", `${JSON.stringify({ captureIntent: on })}\n`);
  const intent = async (): Promise<Array<string | undefined>> => {
    const session = await sessionOf(alice);
    return [session?.intent, session?.intentSource];
  };
  const shared = async (): Promise<string | undefined> => (await published(h, "alice"))?.sessions[0]?.intent;
  await fire(alice, "session-start", 0);
  const asked = record(t);

  // Whichever event of the session comes first, and whoever it is from.
  const next: Array<[HookEventType, Partial<HookEvent>]> = [
    ["prompt", { prompt: "now the tests for it" }],
    ["pre-edit", { paths: ["src/auth.ts"] }],
    ["post-edit", {}],
    ["turn-end", {}],
    ["post-edit", { subagent: true }],
    ["session-start", {}],
  ];
  for (const [index, [type, over]] of next.entries()) {
    const now = 10 + index * 10;
    const label = `${type}${over.subagent === true ? " of a subagent" : ""}`;
    await capture(true);
    await fire(alice, "prompt", now, { prompt: AUTH_PROMPT });
    await publish(alice, now + 1);
    assert.equal(await shared(), AUTH_PROMPT, label);

    await capture(false);
    const [background, waited] = [asked.background.length, asked.waited.length];
    await fire(alice, type, now + 2, over);
    assert.deepEqual(await intent(), ["", "none"], label);
    // Teammates are not left with it until the throttle allows a sync.
    if (type === "session-start") assert.equal(asked.waited.length, waited + 1, label);
    else assert.deepEqual(asked.background.slice(background), [forced(alice)], label);
    await publish(alice, now + 3);
    assert.equal(await shared(), "", label);
  }

  // An intent that was stated with `huddle intent` was put there to be shared. It stays.
  await capture(true);
  const stated = await alice.huddle(["intent", "Own the auth module until Friday"], { session: "s-alice", now: at(100) });
  assert.equal(stated.code, 0, stated.stderr);
  await capture(false);
  const background = asked.background.length;
  await fire(alice, "post-edit", 101);
  await fire(alice, "prompt", 102, { prompt: "looks good, now write the tests for it" });
  assert.deepEqual(await intent(), ["Own the auth module until Friday", "manual"]);
  assert.deepEqual(asked.background.slice(background), [throttled(alice), throttled(alice)]);
});

test("which prompts replace the intent: not one word, not an empty one, and never one that was stated with huddle intent", async (t) => {
  const { alice } = await team(t);
  await fire(alice, "session-start", 0);
  const intentAfter = async (seconds: number, prompt: unknown): Promise<string | undefined> => {
    await fire(alice, "prompt", seconds, { prompt: prompt as string });
    return (await sessionOf(alice))?.intent;
  };

  // With nothing to lose, one word is better than nothing.
  assert.equal(await intentAfter(1, "refactor"), "refactor");
  assert.equal(await intentAfter(2, "Build the login page"), "Build the login page");

  // One word says nothing about the work. Neither does a prompt nobody typed (the adapter passes none).
  for (const [index, prompt] of ["yes", "continue", "ok.", "/compact", "LGTM!", "", "   \n ", undefined, 42].entries()) {
    assert.equal(await intentAfter(3 + index, prompt), "Build the login page", `after ${JSON.stringify(prompt)}`);
  }
  assert.equal((await sessionOf(alice))?.seenAt, at(11), "the session is still seen");

  // Two words do, and so does a sentence in a script that puts no spaces between words.
  assert.equal(await intentAfter(20, "fix it"), "fix it");
  const japanese = String.fromCodePoint(0x30ed, 0x30b0, 0x30a4, 0x30f3, 0x753b, 0x9762, 0x3092, 0x4f5c, 0x308b);
  assert.equal(await intentAfter(21, japanese), japanese);

  // An intent somebody stated on purpose stays, whatever is typed afterwards.
  const stated = await alice.huddle(["intent", "Own the auth module until Friday"], { session: "s-alice", now: at(30) });
  assert.equal(stated.code, 0, stated.stderr);
  const asked = record(t);
  assert.equal(await intentAfter(31, "looks good, now write the tests for it"), "Own the auth module until Friday");
  assert.equal((await sessionOf(alice))?.intentSource, "manual");
  assert.deepEqual(asked.background, [throttled(alice)], "nothing changed, so nothing is rushed out");

  // Until it is cleared: then the prompts speak again.
  assert.equal((await alice.huddle(["intent", "--clear"], { session: "s-alice", now: at(40) })).code, 0);
  assert.equal(await intentAfter(41, "now build the billing page"), "now build the billing page");
  assert.equal((await sessionOf(alice))?.intentSource, "prompt");
  assert.deepEqual(asked.background, [throttled(alice), forced(alice)]);
});

test("prompt briefs on what changed since the last briefing, and says nothing when nothing did", async (t) => {
  const { alice, bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);

  // Nothing new since the briefing a moment ago.
  assert.deepEqual(await fire(bob, "prompt", 25, { prompt: "Add the login page" }), {});

  // Alice changes course. Bob's next prompt after his clone has synced tells him, and only that.
  await fire(alice, "prompt", 30, { prompt: "Switch the JWT middleware to sessions" });
  await publish(alice, 31);
  await publish(bob, 32);
  const changed = await fire(bob, "prompt", 35, { prompt: "continue" });
  assert.deepEqual(changed, { context: text(DELTA_HEAD, `- alice / claude-code on main (5s ago): "Switch the JWT middleware to sessions". Files: src/auth.ts`, OVERLAP_HINT) });
  assert.equal((await sessionOf(bob))?.intent, "Add the login page");
  assert.deepEqual(await fire(bob, "prompt", 36, { prompt: "continue" }), {}, "told once");

  // Alice's session ends.
  await fire(alice, "session-end", 40);
  await publish(alice, 41);
  await publish(bob, 42);
  assert.deepEqual(await fire(bob, "prompt", 45, { prompt: "continue" }), { context: text(DELTA_HEAD, "Left: alice / claude-code (main).") });
  assert.deepEqual(await fire(bob, "prompt", 46, { prompt: "continue" }), {});
});

test("a session that was never briefed gets the full briefing at its first prompt, and keeps the warnings it had", async (t) => {
  const { h, bob } = await aliceBuildsAuth(t);
  // Hooks were installed while this session was running: there was no session-start for it.
  await publish(bob, 15);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };
  assert.equal((await fire(bob, "pre-edit", 18, edit)).context, authWarning(18));
  assert.deepEqual(await seenKeys(bob), ["w:src/auth.ts"]);

  const first = await fire(bob, "prompt", 20, { prompt: "Add the login page" });
  assert.deepEqual(first, { context: text(FULL_HEAD, aliceLine(20), FULL_FOOT) });
  const keys = await seenKeys(bob);
  assert.deepEqual(
    keys.filter((key) => !key.startsWith("s:")),
    ["briefed", "tasks", "w:src/auth.ts"],
  );
  assert.equal(keys.filter((key) => key.startsWith("s:")).length, 1);
  assert.deepEqual(await fire(bob, "pre-edit", 21, edit), {}, "the warning is still remembered");
  assert.deepEqual(await fire(bob, "prompt", 22, { prompt: "and the logout page" }), {});

  // The same in a clone that has never reached the remote: the full briefing says that it may be missing people, once.
  const carol = await h.clone("carol");
  assert.deepEqual(await fire(carol, "prompt", 30, { prompt: "Write the changelog" }), { context: text(ALONE, NEVER_FETCHED) });
  assert.deepEqual(await fire(carol, "prompt", 31, { prompt: "and the release notes" }), {});
});

test("a subagent's prompt keeps the session alive and nothing else: no intent, and the news stays for the session itself", async (t) => {
  const { alice, bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  await fire(bob, "prompt", 22, { prompt: "Add the login page" });
  await fire(alice, "prompt", 30, { prompt: "Switch the JWT middleware to sessions" });
  await publish(alice, 31);
  await publish(bob, 32);

  assert.deepEqual(await fire(bob, "prompt", 35, { subagent: true, prompt: "Search the codebase for every use of jwt.verify" }), {});
  const session = await sessionOf(bob);
  assert.equal(session?.intent, "Add the login page");
  assert.equal(session?.seenAt, at(35));

  const own = await fire(bob, "prompt", 36, { prompt: "continue" });
  assert.equal(own.context, text(DELTA_HEAD, `- alice / claude-code on main (6s ago): "Switch the JWT middleware to sessions". Files: src/auth.ts`, OVERLAP_HINT));
});

// ---------------------------------------------------------------------------
// pre-edit
// ---------------------------------------------------------------------------

const warnedPaths = async (...args: Parameters<typeof seenKeys>): Promise<string[]> => (await seenKeys(...args)).filter((key) => key.startsWith("w:"));

test("pre-edit warns once when the file is in a teammate's flight, from the cache and without touching the network", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const asked = record(t);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };

  assert.deepEqual(await fire(bob, "pre-edit", 25, edit), { context: authWarning(25) });
  assert.deepEqual(await fire(bob, "pre-edit", 26, edit), {}, "ten edits of one contested file are one warning");
  assert.deepEqual(await fire(bob, "pre-edit", 27, { paths: [join(bob.dir, "src/other.ts")] }), {});
  assert.deepEqual(asked, NOTHING_ASKED);
  assert.equal((await sessionOf(bob))?.seenAt, at(27), "it is still a sign of life");
  assert.deepEqual(await warnedPaths(bob), ["w:src/auth.ts"]);
});

test("pre-edit warns again when another teammate arrives on the file, and when one who left comes back", async (t) => {
  const { h, alice, bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };
  assert.equal((await fire(bob, "pre-edit", 25, edit)).context, authWarning(25));

  // Carol starts on the same file. Bob knew about alice; carol is news.
  const carol = await h.clone("carol");
  await fire(carol, "session-start", 30);
  await carol.write("src/auth.ts", "export const auth = false;\n");
  await fire(carol, "post-edit", 31, { paths: [join(carol.dir, "src/auth.ts")] });
  await publish(carol, 32);
  await publish(bob, 33);
  const both = (now: number, carolSeen: number): string =>
    text(
      overlapHead("src/auth.ts"),
      `- carol / claude-code on main (${ago(carolSeen, now)}) has it in flight: no stated intent.`,
      `- alice / claude-code on main (${ago(10, now)}) has it in flight: "${AUTH_PROMPT}".`,
      SAY_SO,
    );
  assert.equal((await fire(bob, "pre-edit", 35, edit)).context, both(35, 31));
  assert.deepEqual(await fire(bob, "pre-edit", 36, edit), {});

  // Carol's session ends. Nobody is new, so there is nothing to say.
  await fire(carol, "session-end", 40);
  await publish(carol, 41);
  await publish(bob, 42);
  assert.deepEqual(await fire(bob, "pre-edit", 45, edit), {});

  // She resumes that same session, with the file still changed: that is news again.
  await fire(carol, "session-start", 50, { source: "resume" });
  await publish(bob, 52);
  assert.equal((await fire(bob, "pre-edit", 55, edit)).context, both(55, 50));

  // When nobody overlaps the file any more, it is forgotten altogether.
  await fire(alice, "session-end", 60);
  await fire(carol, "session-end", 60);
  await publish(alice, 61);
  await publish(carol, 61);
  await publish(bob, 62);
  assert.deepEqual(await fire(bob, "pre-edit", 65, edit), {});
  assert.deepEqual(await warnedPaths(bob), []);
});

test("pre-edit warns about a path that a teammate has claimed", async (t) => {
  const { alice, bob } = await aliceBuildsAuth(t);
  const claimed = await alice.huddle(["claim", "src/billing/**"], { session: "s-alice", now: at(14) });
  assert.equal(claimed.code, 0, claimed.stderr);
  await publish(alice, 15);
  await fire(bob, "session-start", 20);

  const outcome = await fire(bob, "pre-edit", 25, { paths: [join(bob.dir, "src/billing/invoice.ts")] });
  assert.equal(outcome.context, text(overlapHead("src/billing/invoice.ts"), `- alice / claude-code on main (11s ago) claimed src/billing/**: "${AUTH_PROMPT}".`, SAY_SO));
  assert.deepEqual(await fire(bob, "pre-edit", 26, { paths: [join(bob.dir, "src/shipping/label.ts")] }), {});
});

test("pre-edit takes paths as agents give them: absolute, relative to where the agent is, or a directory", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 15);
  await mkdir(join(bob.dir, "src"), { recursive: true });
  // A session of its own for each case, so that none of them is silent because an earlier one was warned.
  let cases = 0;
  const warned = async (over: Partial<HookEvent>): Promise<string | undefined> => (await fire(bob, "pre-edit", 25, { sessionId: `s-bob-${cases++}`, ...over })).context;

  assert.equal(await warned({ paths: [join(bob.dir, "src/auth.ts")] }), authWarning(25), "absolute");
  assert.equal(await warned({ paths: ["src/auth.ts"] }), authWarning(25), "relative, the agent at the top of the worktree");
  assert.equal(await warned({ cwd: join(bob.dir, "src"), paths: ["auth.ts"] }), authWarning(25), "relative, the agent in a subdirectory");
  assert.equal(await warned({ cwd: join(bob.dir, "src"), paths: ["../src/./auth.ts"] }), authWarning(25), "not normalized");
  assert.equal(await warned({ paths: [join(bob.dir, "src/auth.ts"), "src/auth.ts", "./src/auth.ts"] }), authWarning(25), "one file named three ways is one warning");
  assert.equal(await warned({ paths: [42 as never, null as never, "", join(bob.dir, "src/auth.ts")] }), authWarning(25), "entries that are not paths are skipped");

  // A directory: whatever is in flight under it counts.
  assert.equal(await warned({ paths: [join(bob.dir, "src")] }), text(overlapHead("src"), `- alice / claude-code on main (15s ago) has src/auth.ts in flight: "${AUTH_PROMPT}".`, SAY_SO));

  // Not huddle's business: nothing named, outside the worktree, the worktree itself, or not a list of paths at all.
  const outside = [[], [join(bob.dir, "..", "elsewhere", "src", "auth.ts")], ["../src/auth.ts"], [bob.dir], [42, null, {}], "src/auth.ts", { 0: "src/auth.ts" }, undefined];
  for (const paths of outside) assert.equal(await warned({ paths: paths as string[] }), undefined, JSON.stringify(paths));
});

test("a subagent is warned before every edit, and nothing is remembered for it", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };
  const before = await seenKeys(bob);

  assert.equal((await fire(bob, "pre-edit", 25, { ...edit, subagent: true })).context, authWarning(25));
  assert.equal((await fire(bob, "pre-edit", 26, { ...edit, subagent: true })).context, authWarning(26), "its context is new each time");
  assert.deepEqual(await seenKeys(bob), before);

  // The session itself has not been told by any of that.
  assert.equal((await fire(bob, "pre-edit", 27, edit)).context, authWarning(27));
  assert.deepEqual(await fire(bob, "pre-edit", 28, edit), {});
  // And what the session was told does not silence the next subagent.
  assert.equal((await fire(bob, "pre-edit", 29, { ...edit, subagent: true })).context, authWarning(29));
});

test("sessions of one clone: another worktree's files are an overlap, a shared worktree's are not, claims always are", async (t) => {
  const { alice } = await aliceBuildsAuth(t);
  const claimed = await alice.huddle(["claim", "src/billing/**"], { session: "s-alice", now: at(14) });
  assert.equal(claimed.code, 0, claimed.stderr);

  // A second agent of alice's, in a worktree of its own. No sync has run since: the clone's own sessions come from local state.
  const worktree = await alice.addWorktree("wt");
  const elsewhere = await fire(worktree, "pre-edit", 25, { sessionId: "s-alice-wt", paths: [join(worktree.dir, "src/auth.ts")] });
  assert.equal(elsewhere.context, text(overlapHead("src/auth.ts"), `- alice / claude-code (same clone) on main (11s ago) has it in flight: "${AUTH_PROMPT}".`, SAY_SO));

  // A third, in the same worktree as the first. The changed files there are as much its own, so they are no overlap.
  assert.deepEqual(await fire(alice, "pre-edit", 26, { sessionId: "s-alice-2", paths: [join(alice.dir, "src/auth.ts")] }), {});
  // What the first one claimed is still the first one's.
  const inClaim = await fire(alice, "pre-edit", 27, { sessionId: "s-alice-2", paths: [join(alice.dir, "src/billing/invoice.ts")] });
  assert.equal(inClaim.context, text(overlapHead("src/billing/invoice.ts"), `- alice / claude-code (same clone) on main (13s ago) claimed src/billing/**: "${AUTH_PROMPT}".`, SAY_SO));
});

test("an edit of many files spells out five overlapping paths and counts the rest, which are warned about next time", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 0);
  const files = Array.from({ length: 8 }, (_, index) => `src/part${index + 1}.ts`);
  await cacheTeam(bob, 10, [teammate("carolaaa", "carol", [remoteSession("s-carol", 10, { intent: "Split the parser", intentSource: "prompt", files })])]);
  const edit = { paths: files.map((file) => join(bob.dir, file)) };
  const block = (file: string, now: number): string => text(overlapHead(file), `- carol / codex on main (${ago(10, now)}) has it in flight: "Split the parser".`, SAY_SO);

  const first = await fire(bob, "pre-edit", 20, edit);
  assert.equal(first.context, text(...files.slice(0, 5).map((file) => block(file, 20)), moreNote(3)));
  // Only what was spelled out counts as told.
  assert.deepEqual(
    await warnedPaths(bob),
    files.slice(0, 5).map((file) => `w:${file}`),
  );

  const second = await fire(bob, "pre-edit", 21, edit);
  assert.equal(second.context, text(...files.slice(5).map((file) => block(file, 21))));
  assert.deepEqual(await fire(bob, "pre-edit", 22, edit), {});
});

test("a warning never grows past 4000 characters: what does not fit is counted, and one path that is too long alone is cut", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 0);
  // Teammates with intents of the full length, all on the same files.
  const crowd = (count: number, files: string[]) =>
    Array.from({ length: count }, (_, index) => {
      const letter = String.fromCharCode(97 + index);
      const intent = `${letter} `.repeat(100).trim();
      return teammate(`team${letter}`, `teammate-${letter}`, [remoteSession(`s-${letter}`, 10, { intent, intentSource: "prompt", files })]);
    });

  // Twelve of them: either file alone fits, the two together do not.
  await cacheTeam(bob, 10, crowd(12, ["big.ts", "huge.ts"]));
  const first = (await fire(bob, "pre-edit", 20, { paths: ["big.ts", "huge.ts"] })).context ?? "";
  assert.ok(first.length > 3000 && first.length <= 4000, `${first.length} characters`);
  assert.ok(first.startsWith(`${overlapHead("big.ts")}\n- teammate-a / codex on main (10s ago) has it in flight: "a a a`));
  assert.ok(first.endsWith(`${SAY_SO}\n${moreNote(1)}`), first.slice(-200));
  assert.ok(!first.includes(overlapHead("huge.ts")));
  assert.deepEqual(await warnedPaths(bob), ["w:big.ts"]);

  const second = (await fire(bob, "pre-edit", 21, { paths: ["big.ts", "huge.ts"] })).context ?? "";
  assert.ok(second.startsWith(overlapHead("huge.ts")) && second.endsWith(SAY_SO), second.slice(-200));
  assert.ok(second.length <= 4000);

  // Twenty on one file: its warning alone is too long. It is cut at the end of a line, says so, and counts as told.
  await cacheTeam(bob, 10, crowd(20, ["vast.ts"]));
  const cut = (await fire(bob, "pre-edit", 22, { paths: ["vast.ts"] })).context ?? "";
  assert.ok(cut.length > 3000 && cut.length <= 4000, `${cut.length} characters`);
  const cutLines = cut.split("\n");
  assert.equal(cutLines[0], overlapHead("vast.ts"));
  assert.equal(cutLines.at(-1), CUT_NOTE);
  for (const line of cutLines.slice(1, -1)) assert.match(line, /^- teammate-[a-t] \/ codex on main \(12s ago\) has it in flight: "(?:[a-t] ){99}[a-t]"\.$/);
  assert.deepEqual(await fire(bob, "pre-edit", 23, { paths: ["vast.ts"] }), {});
});

test("a pre-edit that is the first sign of a session records it and has it published at once", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 15);
  const asked = record(t);

  assert.equal((await fire(bob, "pre-edit", 20, { paths: [join(bob.dir, "src/auth.ts")] })).context, authWarning(20));
  assert.deepEqual(asked.background, [forced(bob)]);
  assert.deepEqual(asked.waited, [], "the check never waits for it");
  const session = await sessionOf(bob);
  assert.deepEqual([session?.agent, session?.startedAt, session?.seenAt, session?.worktree], ["claude-code", at(20), at(20), bob.dir]);

  // With no path to check it is a sign of life and no more.
  assert.deepEqual(await fire(bob, "pre-edit", 21, { paths: [] }), {});
  assert.equal((await sessionOf(bob))?.seenAt, at(21));
  assert.deepEqual(asked.background, [forced(bob)]);
});

// ---------------------------------------------------------------------------
// post-edit, turn-end, session-end
// ---------------------------------------------------------------------------

test("post-edit keeps the session alive and leaves the sync to the throttle, unless the session is new", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await publish(bob, 15);
  const asked = record(t);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };

  // The session is new: published at once. And no warning after the fact, even for a contested file.
  assert.deepEqual(await fire(bob, "post-edit", 20, edit), {});
  assert.deepEqual(asked.background, [forced(bob)]);

  assert.deepEqual(await fire(bob, "post-edit", 21, edit), {});
  assert.deepEqual(await fire(bob, "post-edit", 22, {}), {}, "a shell command names no files");
  assert.deepEqual(asked.background, [forced(bob), throttled(bob), throttled(bob)]);
  // The throttle is asked with the event's clock and the team's config, so that no process is started for nothing.
  assert.equal(asked.options[1]?.now?.toISOString(), at(21));
  assert.equal(asked.options[1]?.config?.syncIntervalSeconds, 15);
  assert.deepEqual(asked.waited, []);
  assert.equal((await sessionOf(bob))?.seenAt, at(22));
  assert.deepEqual(await seenKeys(bob), [], "nothing was shown, so nothing is remembered");
});

test("turn-end has the turn's work published at once, whatever the throttle says, and does not wait for it", async (t) => {
  const { alice } = await team(t);
  await fire(alice, "session-start", 0);
  const asked = record(t);

  assert.deepEqual(await fire(alice, "turn-end", 5), {});
  assert.deepEqual(await fire(alice, "turn-end", 6), {});
  assert.deepEqual(asked.background, [forced(alice), forced(alice)]);
  assert.deepEqual(asked.waited, []);
  assert.equal((await sessionOf(alice))?.seenAt, at(6));
});

test("session-end removes the session and what it was shown, and has that published", async (t) => {
  const { h, alice } = await aliceBuildsAuth(t);
  await fire(alice, "session-start", 13, { sessionId: "s-alice-2" });
  assert.notDeepEqual(await seenKeys(alice), []);
  const asked = record(t);

  assert.deepEqual(await fire(alice, "session-end", 20, { reason: "other" }), {});
  assert.deepEqual(
    (await sessionsOf(alice)).map((session) => session.id),
    ["s-alice-2"],
    "the clone's other session is not touched",
  );
  assert.deepEqual(await seenKeys(alice), []);
  assert.notDeepEqual(await seenKeys(alice, "s-alice-2"), []);
  assert.deepEqual(asked.background, [forced(alice)]);
  assert.deepEqual(asked.waited, [], "it does not wait for the network");

  // Ending it twice, or ending a session nobody recorded, changes nothing and starts nothing.
  assert.deepEqual(await fire(alice, "session-end", 21), {});
  assert.deepEqual(await fire(alice, "session-end", 22, { sessionId: "never-seen" }), {});
  assert.deepEqual(asked.background, [forced(alice)]);
  assert.equal((await sessionsOf(alice)).length, 1);

  await publish(alice, 23);
  assert.deepEqual(
    (await published(h, "alice"))?.sessions.map((session) => session.id),
    ["s-alice-2"],
  );
});

test("a subagent's other events are signs of life: they do not start, end, relabel or brief the session", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const asked = record(t);
  const types: HookEventType[] = ["session-start", "post-edit", "turn-end", "session-end"];
  for (const [index, type] of types.entries()) {
    assert.deepEqual(await fire(bob, type, 30 + index, { subagent: true, agent: "codex" }), {}, type);
  }

  const session = await sessionOf(bob);
  assert.equal(session?.seenAt, at(33), "the session is still there after a subagent's session-end");
  assert.equal(session?.agent, "claude-code");
  assert.ok((await seenKeys(bob)).includes("briefed"), "a subagent's session-start forgot what the session was shown");
  assert.deepEqual(
    asked.background,
    types.map(() => throttled(bob)),
  );
  assert.deepEqual(asked.waited, []);

  // A subagent can be the first sign of a session all the same.
  await fire(bob, "post-edit", 40, { subagent: true, sessionId: "s-unknown" });
  assert.equal((await sessionOf(bob, "s-unknown"))?.agent, "claude-code");
  assert.deepEqual(asked.background.at(-1), forced(bob));
});

// ---------------------------------------------------------------------------
// Where hooks act
// ---------------------------------------------------------------------------

const ALL_TYPES = Object.keys(DEADLINE_MS) as HookEventType[];

test("in a repository that is not set up for huddle no event does anything at all", async (t) => {
  const h = await createHarness(t);
  const plain = await h.clone("plain");
  const paths = await plain.paths();
  const asked = record(t);
  const before = await plain.snapshot();

  for (const type of ALL_TYPES) {
    assert.deepEqual(await fire(plain, type, 5, { prompt: "Build it", paths: [join(plain.dir, "README.md")] }), {}, type);
  }
  assert.equal(existsSync(paths.stateDir), false, "a state directory was created");
  assert.deepEqual(await plain.snapshot(), before);
  assert.deepEqual(asked, NOTHING_ASKED);

  // .huddle has to be a directory at the top of the worktree. A file of that name is not it, and neither is one further down.
  await plain.write(".huddle", "not a directory\n");
  assert.deepEqual(await fire(plain, "session-start", 6), {});
  await rm(join(plain.dir, ".huddle"));
  await plain.write("packages/api/.huddle/config.json", "{}\n");
  assert.deepEqual(await fire(plain, "session-start", 7, { cwd: join(plain.dir, "packages/api") }), {});
  assert.equal(existsSync(paths.stateDir), false);
});

test("outside a repository, or with a working directory that is gone, no event does anything", async (t) => {
  const h = await createHarness(t);
  const scratch = join(h.root, "scratch");
  const missing = join(h.root, "missing");
  await mkdir(scratch);
  const start = (cwd: unknown): HookEvent => ({ type: "session-start", agent: "claude-code", sessionId: "s-x", cwd: cwd as string });

  assert.deepEqual(await handleEvent(start(scratch), ioFor(scratch)), {});
  assert.deepEqual(await handleEvent(start(missing), ioFor(missing)), {});
  assert.deepEqual(await handleEvent(start(missing), ioFor(scratch)), {});
  // No cwd in the payload: the directory the hook was started in is used.
  assert.deepEqual(await handleEvent(start(""), ioFor(scratch)), {});
  assert.deepEqual(await handleEvent(start(undefined), ioFor(scratch)), {});
});

test("an agent that wanders out of the repository keeps its session alive there, and nothing is written where it went or learned from it", async (t) => {
  const { h, bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  await fire(bob, "prompt", 25, { prompt: "Add the login page" });
  const scratch = join(h.root, "scratch");
  const other = join(h.root, "other");
  await mkdir(scratch);
  await bob.git("init", "--quiet", other);
  const asked = record(t);

  // The hook is still started in the project directory. The payload's cwd is where the agent is now.
  for (const [index, cwd] of [scratch, other].entries()) {
    assert.deepEqual(await fire(bob, "post-edit", 30 + index, { cwd, paths: [join(cwd, "notes.txt")] }), {});
    const session = await sessionOf(bob);
    assert.deepEqual([session?.seenAt, session?.worktree, session?.branch], [at(30 + index), bob.dir, "main"]);
  }
  assert.equal(existsSync(join(other, ".git", "huddle")), false, "state was written into a repository that never asked for it");

  // What is typed while it is away is about the place it went to, and is not this team's to read. The intent stays
  // what it was when the agent left, and nothing is rushed out.
  for (const [index, cwd] of [scratch, other].entries()) {
    assert.deepEqual(await fire(bob, "prompt", 35 + index, { cwd, prompt: "Fix the invoice PDF for the other client" }), {});
    const session = await sessionOf(bob);
    assert.deepEqual([session?.intent, session?.intentSource, session?.seenAt], ["Add the login page", "prompt", at(35 + index)]);
  }

  // A relative path is relative to where the agent is, which is not here. A file back home, named in full, is checked.
  assert.deepEqual(await fire(bob, "pre-edit", 40, { cwd: scratch, paths: ["src/auth.ts"] }), {});
  assert.equal((await fire(bob, "pre-edit", 41, { cwd: scratch, paths: [join(bob.dir, "src/auth.ts")] })).context, authWarning(41));

  assert.deepEqual(asked.background, [throttled(bob), throttled(bob), throttled(bob), throttled(bob)]);

  // It ends where it lives.
  assert.deepEqual(await fire(bob, "session-end", 50, { cwd: scratch }), {});
  assert.deepEqual(await sessionsOf(bob), []);
  assert.deepEqual(asked.background.at(-1), forced(bob));
});

test("a worktree of the same clone on a branch from before huddle init still counts: the session moves there", async (t) => {
  const { alice } = await aliceBuildsAuth(t);
  const old = join(alice.dir, "..", "alice-old");
  const firstCommit = await alice.git("rev-list", "--max-parents=0", "HEAD");
  await alice.git("worktree", "add", "--quiet", "-b", "old", old, firstCommit);
  const oldDir = await realpath(old);
  assert.equal(existsSync(join(oldDir, ".huddle")), false);
  const asked = record(t);

  // The agent entered that worktree. Its hooks are still started in the project directory, which is set up.
  assert.deepEqual(await fire(alice, "post-edit", 20, { cwd: oldDir }), {});
  let session = await sessionOf(alice);
  // Branch and files described the worktree it left; the sync that is forced here fills them in again. It is started
  // in the checkout that is set up: see the next test.
  assert.deepEqual([session?.worktree, session?.branch, session?.files, session?.seenAt], [oldDir, "", [], at(20)]);
  assert.equal(session?.intent, AUTH_PROMPT);
  assert.deepEqual(asked.background, [forced(alice)]);

  // A subagent that is still in the first worktree does not move the session back.
  await fire(alice, "post-edit", 21, { subagent: true });
  assert.equal((await sessionOf(alice))?.worktree, oldDir);
  await publish(alice, 22);
  session = await sessionOf(alice);
  assert.deepEqual([session?.branch, session?.files], ["old", []]);

  // A hook that is started in that worktree itself has no set-up repository to go by.
  assert.deepEqual(await handleEvent(eventOf(alice, "post-edit", { cwd: oldDir, sessionId: "s-other" }), ioFor(oldDir, { now: at(30) })), {});
  assert.equal(await sessionOf(alice, "s-other"), undefined);
});

test("in a worktree without .huddle a session goes by the checkout its hook was started in: that one's settings, and syncs that start there", async (t) => {
  // This team does not share prompts, and syncs with a remote of its own. Both are settings in .huddle/config.json on main.
  const { h, alice } = await team(t, { remote: "team", captureIntent: false });
  const teamRemote = join(h.root, "team.git");
  await alice.git("init", "--quiet", "--bare", teamRemote);
  await alice.git("remote", "add", "team", teamRemote);
  /** What huddle has put on the team's remote. */
  const onTeam = async (): Promise<ActorDoc[]> => {
    const refs = (await alice.git("--git-dir", teamRemote, "for-each-ref", "--format=%(refname)", "refs/huddle")).split("\n").filter(Boolean);
    return Promise.all(refs.map(async (ref) => JSON.parse(await alice.git("--git-dir", teamRemote, "cat-file", "-p", `${ref}:doc.json`)) as ActorDoc));
  };
  /** And on origin, where this team wants nothing of it. */
  const onOrigin = (): Promise<string> => h.remoteGit("for-each-ref", "--format=%(refname)", "refs/huddle");

  await fire(alice, "session-start", 0);
  const old = join(alice.dir, "..", "alice-old");
  await alice.git("worktree", "add", "--quiet", "-b", "old", old, await alice.git("rev-list", "--max-parents=0", "HEAD"));
  const oldDir = await realpath(old);
  assert.equal(existsSync(join(oldDir, ".huddle")), false);
  const asked = record(t);

  // The agent goes into that worktree and is given work there. Its hooks are still started in the project directory.
  await fire(alice, "pre-edit", 19, { cwd: oldDir, paths: ["customers.sql"] });
  await fire(alice, "prompt", 20, { cwd: oldDir, prompt: "Migrate the customer table" });
  await writeFile(join(oldDir, "customers.sql"), "-- a draft\n");
  await fire(alice, "post-edit", 21, { cwd: oldDir, paths: [join(oldDir, "customers.sql")] });
  await fire(alice, "turn-end", 22, { cwd: oldDir });
  const session = await sessionOf(alice);
  assert.deepEqual([session?.worktree, session?.intent, session?.intentSource], [oldDir, "", "none"], "this team does not share prompts");
  // Each sync is asked for in the checkout that has the settings. One that starts in the worktree runs on the defaults.
  assert.deepEqual(asked.background, [forced(alice), throttled(alice), throttled(alice), forced(alice)]);
  assert.deepEqual([asked.options[1]?.config?.remote, asked.options[1]?.config?.captureIntent], ["team", false]);

  // What the detached process does then, in the directory it was started in.
  const startedIn = relative(alice.dir, asked.background.at(-1)?.worktree ?? "");
  assert.deepEqual(await alice.huddle(["sync", "--background", "--force"], { cwd: startedIn, now: at(23) }), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(
    (await onTeam()).map((doc) => doc.sessions.map((one) => [one.branch, one.intent, one.files])),
    [[["old", "", ["customers.sql"]]]],
  );
  assert.equal(await onOrigin(), "", "huddle pushed to a remote this team does not sync with");

  // A new context in that worktree. The sync that a session-start waits for goes by the same settings.
  await writeFile(join(oldDir, "orders.sql"), "-- a draft\n");
  await fire(alice, "session-start", 30, { cwd: oldDir });
  assert.deepEqual(asked.waitedIn, [alice.dir], "that sync is a process of its own outside the tests, and reads the settings where it starts");
  assert.deepEqual((await onTeam())[0]?.sessions[0]?.files, ["customers.sql", "orders.sql"]);
  assert.equal(await onOrigin(), "");

  // And so does the sync that says the session has ended.
  await fire(alice, "session-end", 40, { cwd: oldDir });
  assert.deepEqual([await sessionsOf(alice), asked.background.at(-1)], [[], forced(alice)]);
});

test("a session that goes into another set-up clone is recorded there as well, and ends in both", async (t) => {
  const { alice, bob } = await team(t);
  await fire(bob, "session-start", 0);

  // Bob's agent changes into alice's clone on the same machine. Its hooks still run from bob's project directory.
  await fire(bob, "post-edit", 10, { cwd: alice.dir });
  assert.equal((await sessionOf(alice, "s-bob"))?.worktree, alice.dir);
  assert.equal((await sessionOf(bob))?.seenAt, at(0));

  const asked = record(t);
  assert.deepEqual(await fire(bob, "session-end", 20, { cwd: alice.dir }), {});
  assert.equal(await sessionOf(alice, "s-bob"), undefined);
  assert.equal(await sessionOf(bob), undefined);
  assert.deepEqual(asked.background, [forced(alice), forced(bob)]);
});

// ---------------------------------------------------------------------------
// Session ids
// ---------------------------------------------------------------------------

test("sessionIdOf makes any id one the store accepts, and keeps different ids different", () => {
  assert.equal(sessionIdOf("6835a033-358b-4497-a94e-356ac1bac1e3"), "6835a033-358b-4497-a94e-356ac1bac1e3");
  assert.equal(sessionIdOf("  spaced\n out\tid "), "spaced out id");
  assert.equal(sessionIdOf(`a${String.fromCodePoint(0x202e)}b`), "a b");
  for (const nothing of [undefined, null, 42, {}, [], "", " \n "]) assert.equal(sessionIdOf(nothing), "");

  assert.equal(sessionIdOf("x".repeat(128)), "x".repeat(128));
  const long = sessionIdOf("x".repeat(129));
  assert.match(long, /^x{111}-[0-9a-f]{16}$/);
  assert.equal(sessionIdOf("x".repeat(129)), long, "the same id every time");
  assert.notEqual(sessionIdOf(`${"x".repeat(129)}a`), sessionIdOf(`${"x".repeat(129)}b`), "two long ids that differ at the end stay two sessions");
  assert.equal(sessionIdOf(long), long);
});

test("an event without a usable session id is ignored; one with an overlong id is the same session every time", async (t) => {
  const { alice } = await team(t);
  for (const sessionId of ["", "  ", undefined, null, 42, {}]) {
    assert.deepEqual(await fire(alice, "session-start", 0, { sessionId: sessionId as string }), {}, JSON.stringify(sessionId));
  }
  assert.deepEqual(await sessionsOf(alice), []);

  const long = "y".repeat(300);
  const started = await fire(alice, "session-start", 1, { sessionId: long });
  assert.deepEqual(started.env, { HUDDLE_SESSION: sessionIdOf(long) });
  await fire(alice, "prompt", 2, { sessionId: long, prompt: "Build it" });
  assert.deepEqual(
    (await sessionsOf(alice)).map((session) => [session.id, session.intent]),
    [[sessionIdOf(long), "Build it"]],
  );
});

// ---------------------------------------------------------------------------
// Internal errors
// ---------------------------------------------------------------------------

test("handleEvent never throws, whatever it is handed", async (t) => {
  const { alice } = await team(t);
  const good = ioFor(alice, { now: at(0) });
  const notEvents: unknown[] = [
    null,
    undefined,
    42,
    "prompt",
    [],
    {},
    { type: "nope", sessionId: "s", cwd: alice.dir },
    { type: "constructor", sessionId: "s", cwd: alice.dir },
    { type: "prompt" },
    { type: 7, sessionId: "s", cwd: alice.dir },
    { type: "prompt", sessionId: {}, cwd: alice.dir },
    { type: "pre-edit", sessionId: "s", cwd: 42, paths: "x" },
  ];
  for (const notEvent of notEvents) assert.deepEqual(await handleEvent(notEvent as HookEvent, good), {}, JSON.stringify(notEvent));

  // An event with a field that is not what it should be is still that session's event; the field is what is ignored.
  const odd = { type: "prompt", sessionId: "s", cwd: alice.dir, prompt: { toString: null }, paths: 7, subagent: "yes", ambient: "no", agent: null };
  assert.deepEqual(await handleEvent(odd as unknown as HookEvent, good), { context: text(ALONE, NEVER_FETCHED) });
  const session = await sessionOf(alice, "s");
  assert.deepEqual([session?.intent, session?.agent], ["", "unknown"]);

  const notIo: unknown[] = [null, undefined, {}, { cwd: alice.dir }, { cwd: 42, env: null }, { cwd: alice.dir, env: {}, self: 42 }];
  for (const io of notIo) assert.deepEqual(await handleEvent(eventOf(alice, "turn-end"), io as Io), {}, JSON.stringify(io));
});

test("damaged state files do not stop a hook: local.json, the cache, a seen file, the team's config", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const paths = await bob.paths();

  // local.json: the session is recorded afresh, and the damaged file is kept for whoever wants to look.
  await writeFile(paths.localFile, "{ not json");
  assert.deepEqual(await fire(bob, "prompt", 25, { prompt: "Add the login page" }), {});
  assert.equal((await sessionOf(bob))?.intent, "Add the login page");
  assert.equal(await readFile(`${paths.localFile}.corrupt`, "utf8"), "{ not json");

  // The cache: nobody is known any more, and as far as this clone can tell alice has left.
  await writeFile(paths.cacheFile, "garbage");
  assert.deepEqual(await fire(bob, "prompt", 26, { prompt: "continue" }), { context: text(DELTA_HEAD, "Left: alice / claude-code (main).") });
  assert.deepEqual(await fire(bob, "pre-edit", 27, { paths: [join(bob.dir, "src/auth.ts")] }), {});

  // The record of what was shown: the next prompt is the full briefing again.
  const [seenName] = (await readdir(paths.seenDir)).filter((name) => name.startsWith("s-bob"));
  await writeFile(join(paths.seenDir, seenName ?? "s-bob"), "][");
  assert.deepEqual(await fire(bob, "prompt", 28, { prompt: "continue" }), { context: text(ALONE, NEVER_FETCHED) });

  // The team's config (a merge conflict in it): nobody can tell any more whether this team shares prompts. So none
  // is recorded and the one that was is taken back, rather than the hook failing.
  await writeFile(paths.teamConfigFile, "<<<<<<< HEAD\n{}\n=======\n");
  assert.deepEqual(await fire(bob, "prompt", 29, { prompt: "Rewrite everything in Rust" }), {});
  assert.deepEqual([(await sessionOf(bob))?.intent, (await sessionOf(bob))?.intentSource], ["", "none"]);
  assert.match(await logOf(bob), /\[config\] .*merge conflict markers/);
});

test("a state directory that cannot be used costs the briefing, never the hook", async (t) => {
  const { alice } = await team(t);
  await writeFile((await alice.paths()).stateDir, "in the way\n");

  // The variable for the agent's shell needs no state, so it is still set.
  assert.deepEqual(await fire(alice, "session-start", 0), { env: { HUDDLE_SESSION: "s-alice" } });
  for (const type of ALL_TYPES.filter((type) => type !== "session-start")) {
    assert.deepEqual(await fire(alice, type, 1, { prompt: "Build it", paths: [join(alice.dir, "a.ts")] }), {}, type);
  }
});

// ---------------------------------------------------------------------------
// Time budgets
// ---------------------------------------------------------------------------

test("when the store is busy a hook gives up on recording the session, not on warning, and stays inside its budget", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };
  const release = await hold(bob, "local");
  try {
    // The warning has to make it out although the session cannot be recorded. On a machine that is busy enough
    // the deadline wins now and then, hence the second and third try.
    let outcome: Awaited<ReturnType<typeof fire>> = {};
    let ms = 0;
    let now = 25;
    for (let attempt = 0; attempt < 3 && outcome.context === undefined; attempt++) {
      now = 25 + attempt;
      ({ ms, value: outcome } = await timed(() => fire(bob, "pre-edit", now, { ...edit, sessionId: `s-late-${attempt}` })));
    }
    assert.equal(outcome.context, authWarning(now));
    assert.ok(ms < DEADLINE_MS["pre-edit"] + 25, `pre-edit took ${Math.round(ms)} ms`);
    assert.deepEqual(
      (await sessionsOf(bob)).map((session) => session.id),
      ["s-bob"],
    );
    assert.match(await logOf(bob), /\[hook\] pre-edit: could not record the session/);

    // The other events have nothing but the session to record. They come back in time, empty-handed.
    for (const type of ["prompt", "post-edit", "turn-end", "session-end"] as const) {
      const run = await timed(() => fire(bob, type, 30, { prompt: "Add the login page" }));
      assert.deepEqual(run.value, {}, type);
      assert.ok(run.ms < DEADLINE_MS[type] + 25, `${type} took ${Math.round(run.ms)} ms`);
    }
    const log = await logOf(bob);
    assert.match(log, /\[hook\] prompt: could not record the session/);
    assert.match(log, /\[hook\] session-end: (?:could not remove the session|gave up at its deadline)/);
    assert.equal((await sessionOf(bob))?.intent, "", "nothing was recorded while the store was busy");
  } finally {
    await release();
  }
  // Nothing is left broken: the next event records the session as usual.
  await fire(bob, "prompt", 40, { prompt: "Add the login page" });
  assert.equal((await sessionOf(bob))?.intent, "Add the login page");
});

test("an event that cannot finish gives up at its deadline with nothing to say, and logs that it did", async (t) => {
  const { h, alice, bob } = await team(t);
  const carol = await h.clone("carol");
  const dave = await h.clone("dave");
  // None of these clones has an actor id yet. Minting one needs the identity lock, which is held here for all of them.
  const stuck = [
    { clone: alice, type: "session-start" as const, deadline: 4000, over: {} },
    { clone: bob, type: "prompt" as const, deadline: 300, over: { prompt: "Build it" } },
    { clone: carol, type: "pre-edit" as const, deadline: 150, over: { paths: ["a.ts"] } },
    // A pre-edit that names no session is a commit, which has longer.
    { clone: dave, type: "pre-edit" as const, deadline: 1500, over: { paths: ["a.ts"], ambient: true, agent: "git", sessionId: "" } },
  ];
  record(t, never);
  const releases = await Promise.all(stuck.map(({ clone }) => hold(clone, "identity")));
  try {
    const runs = await Promise.all(stuck.map(({ clone, type, over }) => timed(() => fire(clone, type, 0, over))));
    for (const [index, { clone, type, deadline }] of stuck.entries()) {
      const run = runs[index]!;
      assert.deepEqual(run.value, {}, type);
      assert.ok(run.ms >= deadline - 5 && run.ms < deadline + 150, `${type} came back after ${Math.round(run.ms)} ms; its deadline is ${deadline} ms`);
      assert.match(await logOf(clone), new RegExp(`\\[hook\\] ${type}: gave up at its deadline of ${deadline} ms`));
    }
  } finally {
    await Promise.all(releases.map((release) => release()));
    // What was abandoned runs on once the lock is free. Let it finish before the clones are removed under it.
    await sleep(400);
  }
});

test("on a quiet machine each event takes less than half of its budget", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };
  /** The fastest of up to ten runs. The first one under half the budget settles it: on a machine that is doing other things, most runs say nothing. */
  const fastest = async (type: HookEventType, over: Partial<HookEvent>, before?: () => Promise<unknown>): Promise<number> => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 10 && best >= DEADLINE_MS[type] / 2; run++) {
      await before?.();
      best = Math.min(best, (await timed(() => fire(bob, type, 30 + run, over))).ms);
    }
    return best;
  };

  const measured: Record<HookEventType, number> = {
    "session-start": await fastest("session-start", {}),
    prompt: await fastest("prompt", { prompt: "Add the login page" }),
    // A subagent's, so that the warning is put together every time.
    "pre-edit": await fastest("pre-edit", { ...edit, subagent: true }),
    "post-edit": await fastest("post-edit", edit),
    "turn-end": await fastest("turn-end", {}),
    // Each run has a session to remove.
    "session-end": await fastest("session-end", {}, () => fire(bob, "post-edit", 29)),
  };
  for (const type of ALL_TYPES) {
    assert.ok(measured[type] < DEADLINE_MS[type] / 2, `${type} took ${Math.round(measured[type])} ms of its ${DEADLINE_MS[type]} ms`);
  }
});
