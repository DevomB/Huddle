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
import { OVERLAP_HINT, shownText } from "../src/core/render.ts";
import type { ActorDoc } from "../src/core/types.ts";
import { DEADLINE_MS, handleEvent, sessionIdOf } from "../src/hooks/engine.ts";
import { REDACTED } from "../src/hooks/intent.ts";
import {
  ALONE,
  AUTH_PROMPT,
  DELTA_HEAD,
  FULL_FOOT,
  FULL_HEAD,
  MIN,
  NEVER_FETCHED,
  NOTHING_ASKED,
  ON_THE_CLOCK,
  PATIENCE,
  SAY_SO,
  ago,
  aliceBuildsAuth,
  aliceLine,
  ambient,
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
  unnamedNote,
} from "./engine.kit.ts";
import { createHarness } from "./harness.ts";
import type { Clone } from "./harness.ts";

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
  const outcome = await fire(alice, "session-start", 0, { source: "startup" }, ON_THE_CLOCK);

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
  const { ms, value } = await timed(() => fire(alice, "session-start", 0, {}, ON_THE_CLOCK));

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

/**
 * Teammates a, b, c and so on, each with an intent of the full length and all
 * on `files`. `tag` makes them other people than a crowd with another tag.
 * `shorter` takes that many characters off the intents, from the last
 * teammate's first, 190 at the most from each.
 */
const crowd = (count: number, files: string[], tag = "", shorter = 0): ActorDoc[] =>
  Array.from({ length: count }, (_, index) => {
    const letter = String.fromCharCode(97 + index);
    const cut = Math.max(0, Math.min(190, shorter - (count - 1 - index) * 190));
    const intent = `${letter} `.repeat(100).trim().slice(0, 199 - cut).trimEnd();
    return teammate(`team${letter}${tag}`, `teammate-${letter}`, [remoteSession(`s-${letter}`, 10, { intent, intentSource: "prompt", files })]);
  });

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

test("a warning names first whoever is new to the session, whatever the order of the team view", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 0);
  const on = (actor: string, user: string, seen: number): ActorDoc => teammate(actor, user, [remoteSession(`s-${user}`, seen, { files: ["a.ts"] })]);
  const line = (user: string, seen: number, now: number): string => `- ${user} / codex on main (${ago(seen, now)}) has it in flight: no stated intent.`;

  await cacheTeam(bob, 30, [on("aliceaaa", "alice", 30)]);
  assert.equal((await fire(bob, "pre-edit", 31, { paths: ["a.ts"] })).context, text(overlapHead("a.ts"), line("alice", 30, 31), SAY_SO));

  // Dave and erin turn up on the file. Both were last seen before alice, so the team view has them after her.
  await cacheTeam(bob, 32, [on("aliceaaa", "alice", 30), on("daveaaaa", "dave", 20), on("erinaaaa", "erin", 25)]);
  assert.equal((await fire(bob, "pre-edit", 33, { paths: ["a.ts"] })).context, text(overlapHead("a.ts"), line("erin", 25, 33), line("dave", 20, 33), line("alice", 30, 33), SAY_SO));
  assert.deepEqual(await fire(bob, "pre-edit", 34, { paths: ["a.ts"] }), {});

  // A subagent has been told about nobody: for it, the order is the team view's.
  assert.equal(
    (await fire(bob, "pre-edit", 35, { paths: ["a.ts"], subagent: true })).context,
    text(overlapHead("a.ts"), line("alice", 30, 35), line("erin", 25, 35), line("dave", 20, 35), SAY_SO),
  );
});

test("a warning never grows past 4000 characters: what does not fit is counted, and of one path that is too long alone the sessions are", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 0);

  // Twelve teammates with intents of the full length, all on the same files: either file alone fits, the two together do not.
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

  // Twenty on one file: its warning cannot name them all. It names as many as fit and counts the others.
  await cacheTeam(bob, 10, crowd(20, ["vast.ts"]));
  /** A warning about vast.ts as the letters of the teammates it names, and its other lines. */
  const about = (warning: string): { named: string; frame: string[]; lineLength: number } => {
    const all = warning.split("\n");
    const named = all.slice(1, -2).map((line) => /^- teammate-([a-t]) \/ codex on main \(\d\ds ago\) has it in flight: "(?:\1 ){99}\1"\.$/.exec(line)?.[1] ?? "?");
    return { named: named.join(""), frame: [all[0] ?? "", ...all.slice(-2)], lineLength: all[1]?.length ?? 0 };
  };
  const cut = (await fire(bob, "pre-edit", 22, { paths: ["vast.ts"] })).context ?? "";
  assert.deepEqual(about(cut), { named: "abcdefghijklmn", frame: [overlapHead("vast.ts"), SAY_SO, unnamedNote(6, "vast.ts")], lineLength: 259 });
  assert.ok(cut.length <= 4000 && cut.length + 260 > 4000, `${cut.length} characters: no room was left for one more of them`);

  // Only the ones it named count as told. The next edit of the file is warned about with the others, and the
  // fourteen from before are the ones that are counted now.
  const rest = (await fire(bob, "pre-edit", 23, { paths: ["vast.ts"] })).context ?? "";
  assert.deepEqual(about(rest), { named: "opqrst", frame: [overlapHead("vast.ts"), SAY_SO, unnamedNote(14, "vast.ts")], lineLength: 259 });
  assert.deepEqual(await fire(bob, "pre-edit", 24, { paths: ["vast.ts"] }), {}, "now the session has been told about all twenty");

  // One more arrives. The warning is about that one, and does not go through the twenty again.
  await cacheTeam(bob, 10, [...crowd(20, ["vast.ts"]), teammate("teamlate", "zoe", [remoteSession("s-zoe", 5, { files: ["vast.ts"] })])]);
  assert.equal(
    (await fire(bob, "pre-edit", 25, { paths: ["vast.ts"] })).context,
    text(overlapHead("vast.ts"), "- zoe / codex on main (20s ago) has it in flight: no stated intent.", SAY_SO, unnamedNote(20, "vast.ts")),
  );
  assert.deepEqual(await fire(bob, "pre-edit", 26, { paths: ["vast.ts"] }), {});

  // A subagent has no memory: it gets the first fourteen each time.
  for (const now of [27, 28]) assert.equal(about((await fire(bob, "pre-edit", now, { paths: ["vast.ts"], subagent: true })).context ?? "").named, "abcdefghijklmn");

  // Twenty other people on two files, both in one edit. The line that counts the second file needs its room too,
  // so the first file's block names one fewer; and the second file waits until the first has been told in full.
  await cacheTeam(bob, 10, crowd(20, ["east.ts", "west.ts"], "y"));
  const both = { paths: ["east.ts", "west.ts"] };
  const turns: string[] = [];
  for (let now = 30; now < 36; now++) {
    const warning = (await fire(bob, "pre-edit", now, both)).context ?? "";
    assert.ok(warning.length <= 4000, `${warning.length} characters`);
    const all = warning.split("\n");
    const counted = all.at(-1) === moreNote(1) ? 1 : 0;
    const named = all.filter((line) => line.startsWith("- teammate-")).map((line) => line.charAt(11));
    turns.push(`${/^\[huddle\] (\S+) overlaps/.exec(all[0] ?? "")?.[1] ?? "nothing"}: ${named.join("")}${counted === 1 ? ", and one more path" : ""}`);
    if (warning !== "") assert.equal(all.at(-1 - counted), unnamedNote(20 - named.length, turns.at(-1)?.split(":")[0] ?? ""));
  }
  assert.deepEqual(turns, ["east.ts: abcdefghijklm, and one more path", "east.ts: nopqrst, and one more path", "west.ts: abcdefghijklmn", "west.ts: opqrst", "nothing: ", "nothing: "]);

  // Fifteen on one file is one too many, and the line that says so counts in the singular.
  await cacheTeam(bob, 10, crowd(15, ["tall.ts"], "x"));
  assert.deepEqual(about((await fire(bob, "pre-edit", 40, { paths: ["tall.ts"] })).context ?? ""), {
    named: "abcdefghijklmn",
    frame: [overlapHead("tall.ts"), SAY_SO, unnamedNote(1, "tall.ts")],
    lineLength: 259,
  });
  const fifteenth = `- teammate-o / codex on main (${ago(10, 41)}) has it in flight: "${"o ".repeat(100).trim()}".`;
  assert.equal((await fire(bob, "pre-edit", 41, { paths: ["tall.ts"] })).context, text(overlapHead("tall.ts"), fifteenth, SAY_SO, unnamedNote(14, "tall.ts")));

  // Eight on one file and six on another: each block fits, and the two together are a few characters too long. A
  // block that does not fit whole is left for the next edit, however little is missing.
  await cacheTeam(bob, 10, [...crowd(8, ["north.ts"], "n"), ...crowd(6, ["south.ts"], "s")]);
  const poles = { paths: ["north.ts", "south.ts"] };
  const north = (await fire(bob, "pre-edit", 50, poles)).context ?? "";
  assert.equal(north.split("\n").length, 11);
  assert.ok(north.startsWith(`${overlapHead("north.ts")}\n`) && north.endsWith(`\n${SAY_SO}\n${moreNote(1)}`), north.slice(-300));
  const south = (await fire(bob, "pre-edit", 51, poles)).context ?? "";
  assert.equal(south.split("\n").length, 8);
  assert.ok(south.startsWith(`${overlapHead("south.ts")}\n`) && south.endsWith(`\n${SAY_SO}`), south.slice(-300));
  const together = north.length - moreNote(1).length + south.length;
  assert.ok(together > 4000 && together < 4100, `the two blocks and the line break between them are ${together} characters`);

  // The line that counts the rest shows the path the way the first line of the warning does, "<" and ">" included.
  await cacheTeam(bob, 10, crowd(15, ["<tag>.ts"], "y"));
  const shown = shownText("<tag>.ts", 200);
  assert.notEqual(shown, "<tag>.ts");
  const tagged = ((await fire(bob, "pre-edit", 60, { paths: ["<tag>.ts"] })).context ?? "").split("\n");
  assert.deepEqual([tagged.length, tagged[0], tagged.at(-1)], [17, overlapHead(shown), unnamedNote(1, shown)]);
});

test("one session always fits in a warning: the longest names there can be, in characters that count double", async (t) => {
  const { bob } = await team(t);
  await fire(bob, "session-start", 0);
  // Outside the basic plane a character is two in a JavaScript string, and every limit on a name counts characters.
  const wide = (count: number): string => String.fromCodePoint(0x1f600).repeat(count);
  const dir = Array.from({ length: 4 }, () => wide(49)).join("/");
  const worst = (letter: string): ActorDoc =>
    teammate(`worst${letter.repeat(3)}`, `${letter}${wide(79)}`, [
      remoteSession(`s-${letter}`, 10, { agent: wide(80), branch: wide(200), intent: wide(200), intentSource: "prompt", files: [`${dir}/${wide(49)}`] }),
    ]);
  await cacheTeam(bob, 10, ["a", "b", "c", "d"].map(worst));
  const edit = { paths: [join(bob.dir, dir)] };

  // Four of them do not fit, and neither do three with the line that counts the fourth. Two do.
  const first = ((await fire(bob, "pre-edit", 20, edit)).context ?? "").split("\n");
  assert.deepEqual([first.length, first[0], ...first.slice(-2)], [5, overlapHead(dir), SAY_SO, unnamedNote(2, dir)]);
  assert.deepEqual(
    first.slice(1, 3).map((line) => line.slice(0, 3)),
    ["- a", "- b"],
  );
  // Each line is as long as a line gets: every name in it was cut to its limit.
  for (const line of first.slice(1, 3)) assert.ok(line.length > 1100 && line.length < 1200, `${line.length} characters`);
  assert.ok(first.join("\n").length > 3000 && first.join("\n").length <= 4000, `${first.join("\n").length} characters`);

  const second = ((await fire(bob, "pre-edit", 21, edit)).context ?? "").split("\n");
  assert.deepEqual([second.length, second[0], ...second.slice(-2)], [5, overlapHead(dir), SAY_SO, unnamedNote(2, dir)]);
  assert.deepEqual(
    second.slice(1, 3).map((line) => line.slice(0, 3)),
    ["- c", "- d"],
  );
  assert.deepEqual(await fire(bob, "pre-edit", 22, edit), {});
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
  const mine = { paths: [join(bob.dir, "src/login.ts")] };

  // The session is new: published at once.
  assert.deepEqual(await fire(bob, "post-edit", 20, mine), {});
  assert.deepEqual(asked.background, [forced(bob)]);

  assert.deepEqual(await fire(bob, "post-edit", 21, mine), {});
  assert.deepEqual(await fire(bob, "post-edit", 22, {}), {}, "a shell command names no files");
  assert.deepEqual(asked.background, [forced(bob), throttled(bob), throttled(bob)]);
  // The throttle is asked with the event's clock and the team's config, so that no process is started for nothing.
  assert.equal(asked.options[1]?.now?.toISOString(), at(21));
  assert.equal(asked.options[1]?.config?.syncIntervalSeconds, 15);
  assert.deepEqual(asked.waited, []);
  assert.equal((await sessionOf(bob))?.seenAt, at(22));
  assert.deepEqual(await seenKeys(bob), [], "nothing was shown, so nothing is remembered");
});

test("post-edit gives the warning that no pre-edit gave: once, with the edit's sync, and never to a subagent", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const asked = record(t);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };

  // An agent that cannot be spoken to before a tool call (Gemini CLI, Cursor), or a pre-edit that ran out of time:
  // nothing warned the session before this edit. So it is warned now, in the event that also starts the edit's sync.
  assert.deepEqual(await fire(bob, "post-edit", 25, edit), { context: authWarning(25) });
  assert.deepEqual(asked.background, [throttled(bob)]);
  assert.deepEqual(await warnedPaths(bob), ["w:src/auth.ts"]);
  // Told is told, whichever event did it.
  assert.deepEqual(await fire(bob, "post-edit", 26, edit), {});
  assert.deepEqual(await fire(bob, "pre-edit", 27, edit), {});

  // The other order is Claude Code's and Codex's: after a pre-edit that warned, the post-edit has nothing to add.
  await fire(bob, "session-start", 30);
  assert.deepEqual(await fire(bob, "pre-edit", 31, edit), { context: authWarning(31) });
  assert.deepEqual(await fire(bob, "post-edit", 32, edit), {});

  // A subagent was warned before its edit, as it is before every edit. Its post-edit stays a sign of life, and
  // uses up nothing that the session itself has yet to be told.
  await fire(bob, "session-start", 40);
  assert.deepEqual(await fire(bob, "post-edit", 41, { ...edit, subagent: true }), {});
  assert.deepEqual(await warnedPaths(bob), []);
  assert.deepEqual(await fire(bob, "post-edit", 42, edit), { context: authWarning(42) });

  // A file that nobody else is working on, and paths as agents give them.
  assert.deepEqual(await fire(bob, "post-edit", 43, { paths: [join(bob.dir, "README.md")] }), {});
  await fire(bob, "session-start", 50);
  assert.deepEqual(await fire(bob, "post-edit", 51, { cwd: join(bob.dir, "src"), paths: ["auth.ts", "../src/auth.ts"] }), { context: authWarning(51) });
  assert.equal(asked.waited.length, 3, "only the three session-starts waited for the network");
});

test("a post-edit that may brief brings what a prompt would bring as well: after the warning, in one text, with one memory for both", async (t) => {
  const { h, alice, bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  await fire(bob, "prompt", 22, { prompt: "Add the login page" });
  const asked = record(t);
  // What an adapter hands over for an agent whose prompt hook cannot speak to the model (Cursor): its event after a
  // tool call says that the session may be briefed there.
  const auth = { brief: true, paths: [join(bob.dir, "src/auth.ts")] };
  const readme = { brief: true, paths: [join(bob.dir, "README.md")] };
  const SESSIONS = "Switch the JWT middleware to sessions";

  // Nothing is new since the briefing a moment ago.
  assert.deepEqual(await fire(bob, "post-edit", 25, readme), {});
  assert.deepEqual(await fire(bob, "post-edit", 26, { brief: true }), {}, "a shell command names no files");

  // Alice changes course, and bob's clone hears of it.
  await fire(alice, "prompt", 30, { prompt: SESSIONS });
  await publish(alice, 31);
  await publish(bob, 32);
  // An event that does not say so brings no update. On Claude Code and Codex that is for the prompt to bring.
  assert.deepEqual(await fire(bob, "post-edit", 35, { paths: readme.paths }), {});
  // One that does brings both: first what is in the way of this edit, then what changed in the team.
  const warning = text(overlapHead("src/auth.ts"), `- alice / claude-code on main (${ago(30, 36)}) has it in flight: "${SESSIONS}".`, SAY_SO);
  const update = text(DELTA_HEAD, `- alice / claude-code on main (${ago(30, 36)}): "${SESSIONS}". Files: src/auth.ts`, OVERLAP_HINT);
  assert.deepEqual(await fire(bob, "post-edit", 36, auth), { context: text(warning, update) });
  assert.deepEqual(
    (await seenKeys(bob)).filter((key) => !key.startsWith("s:")),
    ["briefed", "tasks", "w:src/auth.ts"],
  );
  // One memory: told is told, whichever event asks next.
  assert.deepEqual(await fire(bob, "post-edit", 37, auth), {});
  assert.deepEqual(await fire(bob, "prompt", 38, { prompt: "continue" }), {});
  assert.deepEqual(await fire(bob, "pre-edit", 39, { paths: auth.paths }), {});
  // And it is still a post-edit: each one kept the session alive and left its sync to the throttle.
  assert.equal((await sessionOf(bob))?.seenAt, at(39));
  const quiet = throttled(bob);
  assert.deepEqual(asked.background, [quiet, quiet, forced(alice), quiet, quiet, quiet, quiet], "bob's five post-edits and his prompt; only alice's change of course was rushed out");
  assert.deepEqual(asked.waited, []);

  // A subagent's event is a sign of life whatever it says it may do, and uses up nothing.
  await fire(alice, "session-end", 40);
  await publish(alice, 41);
  await publish(bob, 42);
  assert.deepEqual(await fire(bob, "post-edit", 45, { ...auth, subagent: true }), {});
  assert.deepEqual(await fire(bob, "post-edit", 46, auth), { context: text(DELTA_HEAD, "Left: alice / claude-code (main).") });
  assert.deepEqual(await warnedPaths(bob), [], "nobody is on the file any more, so nothing is remembered about it");

  // A session with no briefing to compare with (an agent that reports no session start, hooks installed while it
  // was running) gets the full one, here in a clone that has never reached the remote. Being new, it is published
  // at once.
  const carol = await h.clone("carol");
  assert.deepEqual(await fire(carol, "post-edit", 50, { brief: true }), { context: text(ALONE, NEVER_FETCHED) });
  assert.deepEqual(asked.background.at(-1), forced(carol));
  assert.deepEqual(await fire(carol, "post-edit", 51, { brief: true }), {});
});

test("a warning and an update in one text never pass 4000 characters: the update is cut down to the room the warning leaves, and waits when that is too little", async (t) => {
  const { h, bob } = await team(t);
  const carol = await h.clone("carol");
  await fire(bob, "session-start", 0);
  const big = { brief: true, paths: ["big.ts"] };
  /** The two parts of a text that has a warning and then an update whose first line is `head`. */
  const parts = (both: string, head: string): [string, string] => {
    const cut = both.indexOf(`\n${head}\n`);
    assert.ok(cut > 0, `no update after the warning: ${both.slice(-300)}`);
    return [both.slice(0, cut), both.slice(cut + 1)];
  };

  // Twelve teammates on one file, new to the session each time: the warning that names them all takes most of the
  // room. Shortening the last intents step by step lets what is left for the update grow from under 700 characters
  // to over 1000, so that whatever a briefing drops to fit is dropped somewhere along the way.
  for (const [round, tag] of ["a", "b", "c", "d", "e", "f", "g", "h"].entries()) {
    await cacheTeam(bob, 10, crowd(12, ["big.ts"], tag, round * 50));
    const both = (await fire(bob, "post-edit", 20 + round, big)).context ?? "";
    assert.ok(both.length <= 4000, `${both.length} characters in round ${round}`);
    const [warning] = parts(both, DELTA_HEAD);
    assert.ok(warning.startsWith(overlapHead("big.ts")) && warning.endsWith(SAY_SO), "the warning comes first");
    assert.equal(warning.split("\n").length, 14, "and is whole: all twelve are named");
    assert.deepEqual(await fire(bob, "post-edit", 20 + round, big), {}, "both parts count as told");

    // The same for a session with no briefing to compare with, in a clone whose team state is two minutes old: the
    // full briefing and its note about that have to fit in as well.
    const fresh = { ...big, sessionId: `s-fresh-${round}` };
    await cacheTeam(carol, 10, crowd(12, ["big.ts"], tag, round * 50));
    const first = (await fire(carol, "post-edit", 140 + round, fresh)).context ?? "";
    assert.ok(first.length <= 4000, `${first.length} characters in round ${round}, for a session that was never briefed`);
    const [, full] = parts(first, FULL_HEAD);
    assert.ok(full.endsWith(staleNote("2m ago")), full.slice(-200));
    await fire(carol, "session-end", 140 + round, fresh);
  }

  // Twenty on one file: the warning names as many of them as fit, and that leaves no room worth using. The update
  // is not given, so it is not used up either: it comes with the next event that may brief.
  await cacheTeam(bob, 10, crowd(20, ["vast.ts"], "z"));
  const vast = { brief: true, paths: ["vast.ts"] };
  const alone = (await fire(bob, "post-edit", 40, vast)).context ?? "";
  assert.ok(alone.length > 3500 && alone.length <= 4000, `${alone.length} characters`);
  assert.equal(alone.split("\n")[0], overlapHead("vast.ts"));
  assert.deepEqual(alone.split("\n").slice(-2), [SAY_SO, unnamedNote(6, "vast.ts")]);
  assert.ok(!alone.includes(DELTA_HEAD), "there was no room for an update");
  // That event has the six who were only counted, which is a short warning, and the update after it.
  const late = (await fire(bob, "post-edit", 41, vast)).context ?? "";
  assert.ok(late.length <= 4000, `${late.length} characters`);
  const [others, update] = parts(late, DELTA_HEAD);
  assert.deepEqual([others.split("\n").length, others.split("\n")[0], ...others.split("\n").slice(-2)], [9, overlapHead("vast.ts"), SAY_SO, unnamedNote(14, "vast.ts")]);
  assert.ok(update.length >= 500, `an update of ${update.length} characters`);
  assert.deepEqual(await fire(bob, "post-edit", 42, vast), {});
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

test("an agent that is away sees the team from where its session is: another worktree's files are still someone else's", async (t) => {
  const { h, alice } = await aliceBuildsAuth(t);
  // A second agent of alice's. Its hooks are started in the project directory, and it works in a worktree of its own.
  const worktree = await alice.addWorktree("wt");
  const scratch = join(h.root, "scratch");
  await mkdir(scratch);
  await fire(alice, "session-start", 20, { sessionId: "s-second", cwd: worktree.dir });
  assert.equal((await sessionOf(alice, "s-second"))?.worktree, worktree.dir);
  const first = (now: number, files: string): string => `- alice / claude-code (same clone) on main (${ago(10, now)}): "${AUTH_PROMPT}". Files: ${files}`;

  // The first agent goes on to another file. The second has wandered off to a scratch directory by then, and its
  // events are handled in the checkout its hooks were started in. That is the first agent's worktree, and not its
  // own: if it were taken for its own, the first agent's files would count as the second's and not be named.
  const away = { sessionId: "s-second", cwd: scratch };
  await alice.write("src/login.ts", "export const login = true;\n");
  await publish(alice, 25);
  assert.deepEqual(await fire(alice, "post-edit", 30, { ...away, brief: true }), { context: text(DELTA_HEAD, first(30, "src/auth.ts, src/login.ts"), OVERLAP_HINT) });
  await alice.write("src/logout.ts", "export const logout = true;\n");
  await publish(alice, 35);
  assert.deepEqual(await fire(alice, "prompt", 40, { ...away, prompt: "Tidy up the scratch notes" }), {
    context: text(DELTA_HEAD, first(40, "src/auth.ts, src/login.ts, src/logout.ts"), OVERLAP_HINT),
  });
  // And a file of the first agent's that it names in full from over there is in the first agent's flight.
  const warned = await fire(alice, "pre-edit", 41, { ...away, paths: [join(alice.dir, "src/login.ts")] });
  assert.equal(warned.context, text(overlapHead("src/login.ts"), `- alice / claude-code (same clone) on main (${ago(10, 41)}) has it in flight: "${AUTH_PROMPT}".`, SAY_SO));
  assert.equal((await sessionOf(alice, "s-second"))?.worktree, worktree.dir, "being away moved nothing");
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

test("an edit whose check for overlap fails loses the warning and nothing else: the session is kept alive, and its sync is started", async (t) => {
  const { bob } = await aliceBuildsAuth(t);
  await fire(bob, "session-start", 20);
  const asked = record(t);
  const edit = { paths: [join(bob.dir, "src/auth.ts")] };
  const paths = await bob.paths();

  // Something sits where the clone's id is kept, so nobody can say which of the sessions in the cache are this
  // clone's own and which are teammates': there is no check. Keeping the session alive needs no id.
  await rm(paths.actorFile);
  await mkdir(join(paths.actorFile, "in the way"), { recursive: true });

  assert.deepEqual(await fire(bob, "post-edit", 25, edit), {});
  assert.equal((await sessionOf(bob))?.seenAt, at(25));
  assert.deepEqual(asked.background, [throttled(bob)]);
  assert.deepEqual(await fire(bob, "pre-edit", 26, edit), {});
  assert.equal((await sessionOf(bob))?.seenAt, at(26));
  assert.deepEqual(asked.background, [throttled(bob)], "a pre-edit of a session that is known starts no sync, checked or not");
  const log = await logOf(bob);
  assert.match(log, /\[hook\] post-edit: could not check for overlap/);
  assert.match(log, /\[hook\] pre-edit: could not check for overlap/);
  assert.doesNotMatch(log, /an event failed/);
  assert.deepEqual(await warnedPaths(bob), [], "what was never said is not remembered as said");
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
      ({ ms, value: outcome } = await timed(() => fire(bob, "pre-edit", now, { ...edit, sessionId: `s-late-${attempt}` }, ON_THE_CLOCK)));
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
      const run = await timed(() => fire(bob, type, 30, { prompt: "Add the login page" }, ON_THE_CLOCK));
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
  const erin = await h.clone("erin");
  const frank = await h.clone("frank");
  // None of these clones has an actor id yet. Minting one needs the identity lock, which is held here for all of them.
  const stuck = [
    { clone: alice, type: "session-start" as const, deadline: 4000, over: {} },
    { clone: bob, type: "prompt" as const, deadline: 300, over: { prompt: "Build it" } },
    { clone: carol, type: "pre-edit" as const, deadline: 150, over: { paths: ["a.ts"] } },
    // A pre-edit that names no session is a commit, which has longer.
    { clone: dave, type: "pre-edit" as const, deadline: 1500, over: { paths: ["a.ts"], ambient: true, agent: "git", sessionId: "" } },
    { clone: erin, type: "post-edit" as const, deadline: 150, over: { paths: ["a.ts"] } },
    // A post-edit that also briefs does a prompt's work, and has a prompt's time for it.
    { clone: frank, type: "post-edit" as const, deadline: 300, over: { brief: true } },
  ];
  record(t, never);
  const releases = await Promise.all(stuck.map(({ clone }) => hold(clone, "identity")));
  try {
    const runs = await Promise.all(stuck.map(({ clone, type, over }) => timed(() => fire(clone, type, 0, over, ON_THE_CLOCK))));
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

test("HUDDLE_HOOK_PATIENCE makes every deadline that many times longer, and counts as 1 when it is not a number from 1 to 100", async (t) => {
  const { alice } = await team(t);
  record(t, never);
  // No actor id yet, and the lock that minting one needs is held: every edit here is stuck until its deadline.
  const cases: Array<[patience: string, deadline: number]> = [
    ["1", 150],
    ["2", 300],
    ["1.5", 225],
    ["", 150],
    ["0", 150],
    ["0.5", 150],
    ["-2", 150],
    ["101", 150],
    ["ten", 150],
    ["2x", 150],
  ];
  const release = await hold(alice, "identity");
  try {
    const runs = await Promise.all(
      cases.map(([patience], index) => timed(() => fire(alice, "pre-edit", 0, { sessionId: `s-${index}`, paths: ["a.ts"] }, { HUDDLE_HOOK_PATIENCE: patience }))),
    );
    for (const [index, [patience, deadline]] of cases.entries()) {
      const run = runs[index]!;
      assert.deepEqual(run.value, {}, patience);
      // Never before its deadline. How long after is up to the machine, with ten of them at once.
      assert.ok(run.ms >= deadline - 5, `with ${JSON.stringify(patience)} it came back after ${Math.round(run.ms)} ms; its deadline is then ${deadline} ms`);
    }
    // What the log says is the deadline each event really had: none of them had more than it should.
    const log = await logOf(alice);
    for (const [deadline, times] of [[150, 8], [225, 1], [300, 1]] as const) {
      assert.equal(log.split(`[hook] pre-edit: gave up at its deadline of ${deadline} ms`).length - 1, times, `${deadline} ms`);
    }
  } finally {
    await release();
    await sleep(400);
  }
});

test("patience is for this machine and not for the remote: a sync is waited for no longer than without it", async (t) => {
  const { alice, bob } = await aliceBuildsAuth(t);
  const asked = record(t);
  assert.ok(PATIENCE > 1, "these tests run with patience, as every test here does that is not about time");

  // A session start has twenty times its 4 s here. The sync it waits for still gets the 3.7 s it always gets at
  // the most, and what patience adds is kept for the work that comes after.
  await fire(alice, "session-start", 20);
  assert.deepEqual(asked.waited, [3700]);
  // The same for the second that a commit may wait. (Alice was last seen at 10 as far as the remote knows: a session
  // that was only seen again is not published again so soon.)
  assert.deepEqual(await ambient(bob, "pre-edit", 25, { paths: ["src/auth.ts"] }), { context: authWarning(25) });
  assert.deepEqual(asked.waited, [3700, 1000]);
});

test("what is kept back for the work after a sync grows with patience: after a slow start, the sync gets the rest of the deadline less that", async (t) => {
  const { alice, bob } = await team(t);
  /** By checkout: the budget its sync was given, and when. */
  const waits = new Map<string, { budget: number; at: number }>();
  record(t, (ctx, budgetMs) => {
    waits.set(ctx.paths.worktree, { budget: budgetMs, at: performance.now() });
    return Promise.resolve(false);
  });
  // Neither clone has an actor id yet. Minting one needs the identity lock, so both events are stuck while it is held.
  const releases = await Promise.all([hold(alice, "identity"), hold(bob, "identity")]);
  // With one and a half times its 4 s, a session start has 6 s and keeps 450 ms of them for the briefing.
  const startBegan = performance.now();
  const start = fire(alice, "session-start", 0, {}, { HUDDLE_HOOK_PATIENCE: "1.5" });
  // With twice its 1.5 s, a commit has 3 s and keeps 300 ms of them for the check.
  const commitBegan = performance.now();
  const commit = ambient(bob, "pre-edit", 0, { paths: ["a.ts"] }, { HUDDLE_HOOK_PATIENCE: "2" });
  // Two seconds in, each of them has less left than the longest wait and what it keeps back.
  await sleep(2000);
  await Promise.all(releases.map((release) => release()));
  assert.deepEqual(await start, { env: { HUDDLE_SESSION: "s-alice" }, context: text(ALONE, NEVER_FETCHED) });
  assert.deepEqual(await commit, {});

  /** When the wait the event was given runs out, counted from when the event began. */
  const waitEnds = (clone: Clone, began: number): number => {
    const wait = waits.get(clone.dir);
    assert.ok(wait, `the event in ${clone.name}'s clone waited for no sync`);
    return wait.at - began + wait.budget;
  };
  // 6000 - 450 and 3000 - 300. With the 300 ms and 150 ms of a machine without patience, both would end 150 ms later.
  const startEnds = waitEnds(alice, startBegan);
  assert.ok(Math.abs(startEnds - 5550) < 50, `the session start's wait would have ended ${Math.round(startEnds)} ms in`);
  const commitEnds = waitEnds(bob, commitBegan);
  assert.ok(Math.abs(commitEnds - 2700) < 50, `the commit's wait would have ended ${Math.round(commitEnds)} ms in`);
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
