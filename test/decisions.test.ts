// T4.1: huddle decide and huddle decisions, on the harness with real clones.
// The first test is the exit test from plan.md §5.

import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openContext } from "../src/core/context.ts";
import type { Ctx } from "../src/core/context.ts";
import { addDecision, allDecisions, fitLog } from "../src/core/decisions.ts";
import { LIMITS } from "../src/core/docs.ts";
import type { Io } from "../src/core/io.ts";
import { renderBriefing } from "../src/core/render.ts";
import { currentView } from "../src/core/session.ts";
import { readCache, touchSession } from "../src/core/store.ts";
import { decisionsRef } from "../src/core/types.ts";
import type { Decision, DecisionDoc, Identity, Seen, Transport } from "../src/core/types.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const posixOnly = process.platform === "win32" ? "uses a sh script as a server-side hook" : false;

async function ok(clone: Clone, args: string[], now: string, cwd?: string) {
  const r = await clone.huddle(args, cwd === undefined ? { now } : { now, cwd });
  assert.equal(r.code, 0, `huddle ${args.join(" ")} in ${clone.name} exited ${r.code}: ${r.stderr}${r.stdout}`);
  return r;
}

/** `huddle decide`, returning the new decision's id. */
async function decide(clone: Clone, text: string, now: string, extra: string[] = []): Promise<string> {
  const r = await ok(clone, ["decide", text, ...extra], now);
  const id = /^decision ([a-z2-7]{8}) recorded/.exec(r.stdout)?.[1];
  assert.ok(id, `no decision id in: ${r.stdout}`);
  return id;
}

/** The decision logs on the remote, read from the bare repository itself. */
async function remoteLogs(h: Harness): Promise<DecisionDoc[]> {
  const refs = (await h.remoteGit("for-each-ref", "--format=%(refname)", "refs/huddle/decisions")).split("\n").filter(Boolean);
  return Promise.all(refs.map(async (ref) => JSON.parse(await h.remoteGit("cat-file", "-p", `${ref}:doc.json`)) as DecisionDoc));
}

const texts = (decisions: Decision[]) => decisions.map((decision) => decision.text);

function inProcess(clone: Clone, now: string): Promise<Ctx> {
  const io: Io = { cwd: clone.dir, env: { ...process.env, HUDDLE_NOW: now }, self: BUNDLE, out: () => {}, err: () => {}, readStdin: async () => "" };
  return openContext(io);
}

/** The briefing a hook would inject into a session of `clone`: the whole team, or what changed since `since`. */
async function briefing(clone: Clone, now: string, since?: Seen) {
  const ctx = await inProcess(clone, now);
  return renderBriefing(await currentView(ctx, "the-session"), since === undefined ? {} : { since });
}

test("exit test: alice decides, bob's next briefing shows it, and superseding hides the old one", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");

  const first = await decide(alice, "API errors use problem+json", at(0));

  // Bob's session starts: one sync, then the full briefing.
  await ok(bob, ["sync"], at(10));
  const full = await briefing(bob, at(11));
  assert.match(full.text, /^Decisions \(1\): API errors use problem\+json\.$/m);
  assert.match(full.text, /huddle decide "<choice others must follow: stack, API shape, naming, file layout>"/, "the footer says when to record one");
  // Shown once: with nothing new, the next prompt gets no briefing at all.
  assert.equal((await briefing(bob, at(12), full.seen)).text, "");

  const listed = await ok(bob, ["decisions", "--cached"], at(13));
  assert.match(listed.stdout, new RegExp(`^- \\[${first}\\] API errors use problem\\+json\\. \\(alice / manual, 13s ago\\)$`, "m"));

  // Alice changes her mind. Bob's next prompt is told, and the old decision is gone everywhere.
  const second = await decide(alice, "API errors use RFC 9457 problem details, never bare strings", at(20), ["--supersedes", first]);
  await ok(bob, ["sync"], at(30));
  const delta = await briefing(bob, at(31), full.seen);
  assert.match(delta.text, /^Decisions \(1 new\): API errors use RFC 9457 problem details, never bare strings\.$/m);
  assert.doesNotMatch(delta.text, /problem\+json/);

  const after = await ok(bob, ["decisions", "--cached"], at(32));
  assert.match(after.stdout, new RegExp(`\\[${second}\\] API errors use RFC 9457`));
  assert.doesNotMatch(after.stdout, /problem\+json/);
  assert.doesNotMatch((await briefing(bob, at(33))).text, /problem\+json/, "a full briefing leaves the superseded one out too");

  // Nothing is erased on the remote: the log keeps both, and says which replaced which.
  const [log] = await remoteLogs(h);
  assert.deepEqual(
    log!.decisions.map(({ id, supersedes }) => ({ id, supersedes })),
    [
      { id: second, supersedes: first },
      { id: first, supersedes: undefined },
    ],
  );
  assert.deepEqual({ actor: log!.actor, user: log!.user, kind: log!.kind, v: log!.v }, { actor: log!.actor, user: "alice", kind: "decisions", v: 0 });
});

test("decide prints the id, records who decided and when, and touches nothing but its ref", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await alice.write("wip.txt", "w\n");
  const before = await alice.snapshot();

  const r = await ok(alice, ["decide", "Dates", "are", "UTC  ISO-8601\tstrings"], at(5));
  assert.match(r.stdout, /^decision [a-z2-7]{8} recorded: Dates are UTC ISO-8601 strings\n$/, "words are joined and whitespace is collapsed");
  assert.equal(r.stderr, "");
  assert.deepEqual(await alice.snapshot(), before, "no local ref, index, config or working tree change");

  const [log] = await remoteLogs(h);
  assert.equal(log!.decisions.length, 1);
  assert.deepEqual({ ...log!.decisions[0], id: "x" }, { id: "x", at: at(5), agent: "manual", text: "Dates are UTC ISO-8601 strings" });
  assert.equal((await h.remoteGit("for-each-ref", "--format=%(refname)", "refs/huddle")).split("\n").length, 1, "one ref: the decision log, no actor doc");
});

test("a decision made from an agent's session is recorded with that agent's name", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  // What an agent's hooks leave behind: a session with the agent's own id and name.
  await touchSession(await alice.paths(), { id: "codex-session-1", worktree: alice.dir, agent: "codex", seenAt: at(0) });
  const r = await alice.huddle(["decide", "Money is integer cents"], { now: at(1), session: "codex-session-1" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await remoteLogs(h))[0]!.decisions[0]!.agent, "codex");
  // And without HUDDLE_SESSION, a command run in that worktree joins its live session.
  await ok(alice, ["decide", "Ids are ULIDs"], at(2));
  assert.equal((await remoteLogs(h))[0]!.decisions[0]!.agent, "codex");
  assert.match((await ok(alice, ["decisions", "--cached"], at(3))).stdout, /\(alice \/ codex, 1s ago\)/);
});

test("everyone's decisions are one list, newest first, and anyone can supersede anyone's", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  const a1 = await decide(alice, "Use pnpm", at(0));
  const b1 = await decide(bob, "Tests live next to the code", at(10));
  await decide(alice, "Branch names are feat/<topic>", at(20));

  const listed = await ok(bob, ["decisions"], at(100));
  const lines = listed.stdout.trim().split("\n");
  assert.match(lines[0]!, /^Decisions \(3\), newest first\. Informational only/);
  assert.deepEqual(
    lines.slice(1).map((line) => line.replace(/^- \[[a-z2-7]+\] /, "")),
    ["Branch names are feat/<topic>. (alice / manual, 1m ago)", "Tests live next to the code. (bob / manual, 1m ago)", "Use pnpm. (alice / manual, 1m ago)"],
  );

  // Bob replaces alice's decision: it lands in bob's log and hides hers for everyone.
  await decide(bob, "Use npm, not pnpm: CI has no pnpm", at(110), ["--supersedes", a1]);
  const json = JSON.parse((await ok(alice, ["decisions", "--json"], at(200))).stdout) as { fetchedAt: string; decisions: (Decision & { user: string })[] };
  assert.equal(json.fetchedAt, at(200));
  assert.deepEqual(
    json.decisions.map((decision) => [decision.user, decision.text]),
    [
      ["bob", "Use npm, not pnpm: CI has no pnpm"],
      ["alice", "Branch names are feat/<topic>"],
      ["bob", "Tests live next to the code"],
    ],
  );
  assert.ok(json.decisions.some((decision) => decision.id === b1));
  assert.equal((await remoteLogs(h)).length, 2, "each clone writes only its own log");
});

test("earlier decisions survive an empty cache and a stale one", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const paths = await alice.paths();
  await decide(alice, "one", at(0));

  // The cache is gone: the log on the remote is still what the next decision is added to.
  await rm(paths.cacheFile);
  await decide(alice, "two", at(10));
  assert.deepEqual(texts((await remoteLogs(h))[0]!.decisions), ["two", "one"]);

  // The cache is behind: something this clone has not seen moved its log on the remote.
  // (A copy of the clone has the same actor id, which makes it a second writer of the same log.)
  await cp(alice.dir, join(h.root, "copy"), { recursive: true });
  await ok(alice, ["decide", "three, from elsewhere"], at(20), "../copy");
  await decide(alice, "four", at(30));
  assert.deepEqual(texts((await remoteLogs(h))[0]!.decisions), ["four", "three, from elsewhere", "two", "one"]);
  assert.match((await ok(alice, ["decisions", "--cached"], at(31))).stdout, /Decisions \(4\)/);
});

test("decisions made at the same moment in one clone are all recorded", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const wanted = ["a", "b", "c", "d", "e", "f"].map((name) => `rule ${name}`);
  const results = await Promise.all(wanted.map((text) => alice.huddle(["decide", text], { now: at(0) })));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const [log] = await remoteLogs(h);
  assert.deepEqual(texts(log!.decisions).sort(), wanted);
  assert.equal(new Set(log!.decisions.map((decision) => decision.id)).size, wanted.length);
});

/** A context whose transport does what `wrap` says around the real one. */
async function withTransport(clone: Clone, now: string, wrap: (real: Transport) => Partial<Transport>): Promise<Ctx> {
  const ctx = await inProcess(clone, now);
  const real = ctx.transport;
  return { ...ctx, transport: { publish: real.publish.bind(real), fetchAll: real.fetchAll.bind(real), remove: real.remove.bind(real), ...wrap(real) } };
}

test("when the log moves between reading and writing it, the decision is added to the new state", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await decide(alice, "one", at(0));
  await cp(alice.dir, join(h.root, "copy"), { recursive: true });

  // Just before alice's first push, the copy (same actor id) writes the log.
  let interfered = 0;
  const ctx = await withTransport(alice, at(10), (real) => ({
    publish: async (ref, doc, expect) => {
      if (interfered++ === 0) await ok(alice, ["decide", "slipped in"], at(9), "../copy");
      return real.publish(ref, doc, expect);
    },
  }));
  const result = await addDecision(ctx, "two", { agent: "claude-code" });
  assert.equal(result.ok, true);
  assert.equal(interfered, 2, "the first push lost the race and the second one went through");
  const [log] = await remoteLogs(h);
  assert.deepEqual(texts(log!.decisions), ["two", "slipped in", "one"]);
  assert.equal(log!.decisions[0]!.agent, "claude-code");
});

test("a log that keeps moving is reported as a lost race after three tries, with nothing written", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await decide(alice, "one", at(0));
  let pushes = 0;
  const ctx = await withTransport(alice, at(10), () => ({
    publish: async () => {
      pushes++;
      return { ok: false, reason: "lost-race" };
    },
  }));
  assert.deepEqual(await addDecision(ctx, "two"), { ok: false, reason: "lost-race" });
  assert.equal(pushes, 3);
  assert.deepEqual(texts((await remoteLogs(h))[0]!.decisions), ["one"]);
});

test("offline, the decision is not recorded and the command says so with exit 1", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await decide(alice, "one", at(0));
  await alice.git("remote", "set-url", "origin", join(h.root, "gone.git"));
  const before = await alice.snapshot();
  const r = await alice.huddle(["decide", "two"], { now: at(10) });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /could not reach remote "origin".*The decision was NOT recorded/);
  assert.deepEqual(await alice.snapshot(), before);
  // What was known before is still listed.
  const listed = await alice.huddle(["decisions"], { now: at(100) });
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /Decisions \(1\)/);
  assert.match(listed.stderr, /showing the last known decisions/);
  assert.deepEqual(texts((await remoteLogs(h))[0]!.decisions), ["one"]);
});

test("a remote that refuses huddle refs: the decision is not recorded, exit 1", { skip: posixOnly }, async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const hook = join(h.remote, "hooks", "update");
  await mkdir(dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\ncase "$1" in refs/huddle/*) echo "not accepted here" >&2; exit 1 ;; esac\nexit 0\n');
  await chmod(hook, 0o755);
  const r = await alice.huddle(["decide", "one"], { now: at(0) });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused a push to refs\/huddle\/\*\. The decision was NOT recorded; run "huddle doctor"/);
  assert.deepEqual(await remoteLogs(h), []);
  assert.match((await ok(alice, ["decisions", "--cached"], at(1))).stdout, /^No decisions recorded\./);
});

test("usage errors exit 2 and record nothing", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const run = async (args: string[]) => alice.huddle(args, { now: at(0) });

  const empty = await run(["decide", "  "]);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /the decision is empty/);
  assert.equal((await run(["decide"])).code, 2);

  const long = await run(["decide", "x".repeat(LIMITS.decisionText + 1)]);
  assert.equal(long.code, 2);
  assert.match(long.stderr, new RegExp(`at most ${LIMITS.decisionText} characters; this one is ${LIMITS.decisionText + 1}`));
  assert.equal((await run(["decide", "x".repeat(LIMITS.decisionText)])).code, 0, "exactly the limit is fine");

  const notAnId = await run(["decide", "y", "--supersedes", "../../etc"]);
  assert.equal(notAnId.code, 2);
  assert.match(notAnId.stderr, /is not a decision id/);

  const unknown = await run(["decide", "y", "--supersedes", "abcd2345"]);
  assert.equal(unknown.code, 2, unknown.stderr);
  assert.match(unknown.stderr, /there is no decision abcd2345; run "huddle decisions" to see the ids\. Nothing was recorded\./);

  assert.equal((await run(["decide", "y", "--bogus"])).code, 2);
  assert.equal((await run(["decisions", "extra"])).code, 2);
  assert.equal((await remoteLogs(h))[0]!.decisions.length, 1, "only the one valid decision above");
});

test("something unreadable at this clone's decisions ref is left alone", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const ctx = await inProcess(alice, at(0));
  const ref = decisionsRef(ctx.identity.actor);
  // An ordinary commit there: no doc.json, so not a document this version understands.
  await alice.git("push", "--quiet", "origin", `HEAD:${ref}`);
  const before = await h.remoteGit("rev-parse", ref);

  const r = await alice.huddle(["decide", "one"], { now: at(1) });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot read, and it was left alone\. The decision was NOT recorded/);
  assert.equal(await h.remoteGit("rev-parse", ref), before);
});

const identity: Identity = { actor: "abcd2345", user: "alice", host: "laptop" };
const made = (id: string, seconds: number, supersedes?: string, text = `decision ${id}`): Decision => ({
  id,
  at: at(seconds),
  agent: "manual",
  text,
  ...(supersedes === undefined ? {} : { supersedes }),
});
const ids = (decisions: Decision[] | null) => decisions?.map((decision) => decision.id) ?? null;

test("fitLog keeps a log that fits exactly as it is", () => {
  const mine = [made("cccc", 3, "aaaa"), made("bbbb", 2), made("aaaa", 1)];
  assert.deepEqual(fitLog(identity, mine, []), mine);
  assert.deepEqual(fitLog(identity, [], []), []);
});

/** `count` decisions in force, newest first, ids fa.. onwards (base32 letters only). */
function filler(count: number, startSeconds: number): Decision[] {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length: count }, (_, i) => made(`f${letters[Math.floor(i / 26) % 26]}${letters[i % 26]}${letters[Math.floor(i / 676) % 26]}`, startSeconds + count - i));
}

test("fitLog drops only what nobody can see, oldest first, and never brings a hidden decision back", () => {
  const full = filler(LIMITS.decisions - 3, 1000);

  // old1 <- old2 <- newest: a chain. old1 goes first; only then is old2 free to go.
  const chain = [made("newest", 5000, "oldb"), ...full, made("oldb", 20, "olda"), made("olda", 10), made("extra", 5)];
  assert.equal(chain.length, LIMITS.decisions + 1);
  const cut = fitLog(identity, chain, []);
  assert.equal(cut?.length, LIMITS.decisions);
  assert.equal(cut?.some((decision) => decision.id === "olda"), false, "the oldest hidden decision is the one dropped");
  assert.ok(cut?.some((decision) => decision.id === "oldb"), "its replacement stays: one drop was enough");
  assert.ok(cut?.some((decision) => decision.id === "extra"), "a decision in force is never dropped, however old");

  // Two over: olda, then oldb (nothing left for it to keep hidden).
  const two = fitLog(identity, [made("more", 6000), ...chain], []);
  assert.equal(two?.length, LIMITS.decisions);
  assert.equal(two?.some((decision) => decision.id === "olda" || decision.id === "oldb"), false);

  // oldb is hidden (newest supersedes it) but is the only thing hiding a teammate's decision: it stays, and the log does not fit.
  const theirs = [made("teammate", 1)];
  const guard = [made("newest", 5000, "oldb"), ...filler(LIMITS.decisions - 1, 1000), made("oldb", 20, "teammate")];
  assert.equal(fitLog(identity, guard, theirs), null);
  // Once the teammate's decision is hidden by something else as well, oldb can go.
  assert.equal(ids(fitLog(identity, guard, [...theirs, made("other", 2, "teammate")]))?.includes("oldb"), false);
  // And when the teammate's decision no longer exists, there is nothing to keep hidden.
  assert.equal(ids(fitLog(identity, guard, []))?.includes("oldb"), false);

  // Two hidden decisions with nothing depending on them: the older one goes.
  const pair = [made("newb", 9001, "hidb"), made("newa", 9000, "hida"), ...filler(LIMITS.decisions - 3, 1000), made("hidb", 8), made("hida", 7)];
  const older = ids(fitLog(identity, pair, []));
  assert.deepEqual([older?.includes("hida"), older?.includes("hidb")], [false, true]);
  // Position in the log is what counts as age: the log is kept newest first.
  const swapped = ids(fitLog(identity, [...pair.slice(0, -2), made("hida", 7), made("hidb", 8)], []));
  assert.deepEqual([swapped?.includes("hida"), swapped?.includes("hidb")], [true, false]);

  // Everything in force: nothing can be dropped.
  assert.equal(fitLog(identity, filler(LIMITS.decisions + 1, 0), []), null);
});

test("fitLog also keeps the document under the size limit", () => {
  // Four bytes per character: 200 decisions of 500 such characters are far over 256 KB.
  const wide = String.fromCodePoint(0x1f600).repeat(LIMITS.decisionText);
  const heavy = Array.from({ length: 150 }, (_, i) => made(`h${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)]}a`, 1000 - i, undefined, wide));
  assert.equal(fitLog(identity, heavy, []), null, "150 decisions fit the count but not the bytes, and all are in force");
  // Supersede enough of them from one new decision each, and the old ones can go.
  const replacements = heavy.slice(100).map((decision, i) => made(`r${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)]}a`, 2000 + i, decision.id, "short"));
  const cut = fitLog(identity, [...replacements, ...heavy], []);
  assert.ok(cut, "hidden heavy decisions are dropped until the document fits");
  assert.ok(cut.length < replacements.length + heavy.length);
  for (const replacement of replacements) assert.ok(cut.some((decision) => decision.id === replacement.id), "replacements stay");
  for (const decision of heavy.slice(0, 100)) assert.ok(cut.some((kept) => kept.id === decision.id), "decisions in force stay");
});

test("a full log refuses a new decision, and superseding one of its own makes room", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const ctx = await inProcess(alice, at(0));
  const ref = decisionsRef(ctx.identity.actor);
  const full = filler(LIMITS.decisions, 0);
  const seeded = await ctx.transport.publish(ref, { v: 0, kind: "decisions", actor: ctx.identity.actor, user: "alice", decisions: full }, "absent");
  assert.equal(seeded.ok, true);

  const refused = await alice.huddle(["decide", "one too many"], { now: at(5000) });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`decision log is full \\(${LIMITS.decisions} decisions.*NOT recorded.*--supersedes <id>`));
  assert.equal((await remoteLogs(h))[0]!.decisions.length, LIMITS.decisions);

  const oldest = full[full.length - 1]!.id;
  const r = await ok(alice, ["decide", "replaces the oldest", "--supersedes", oldest], at(5001));
  assert.match(r.stdout, new RegExp(`recorded, replacing ${oldest}: replaces the oldest\\n\\(1 superseded decision was removed from this clone's log to make room\\)`));
  const [log] = await remoteLogs(h);
  assert.equal(log!.decisions.length, LIMITS.decisions);
  assert.equal(log!.decisions[0]!.text, "replaces the oldest");
  assert.equal(log!.decisions.some((decision) => decision.id === oldest), false);
  // The new decision still names what it replaced, so a teammate's stale cache hides the old one too.
  assert.equal(log!.decisions[0]!.supersedes, oldest);
});

test("the cache after a decision is what the remote holds, so the decider sees it without a sync", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const id = await decide(alice, "one", at(0));
  const cache = await readCache(await alice.paths());
  assert.deepEqual(
    allDecisions(cache).map((decision) => decision.id),
    [id],
  );
  assert.equal(cache.fetchedAt, at(0));
  const ref = Object.keys(cache.refs)[0]!;
  assert.equal(cache.refs[ref]!.sha, await h.remoteGit("rev-parse", ref));
  assert.equal(JSON.parse(await readFile((await alice.paths()).cacheFile, "utf8")).refs[ref].doc.decisions[0].text, "one");
});
