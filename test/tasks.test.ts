// T5.1 exit test (plan.md §5): 20 simultaneous claim races each have exactly
// one winner, and the loser's message names the winner. Plus the life of a
// task around it. Races run the built CLI, one process per contender.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openContext } from "../src/core/context.ts";
import type { Ctx } from "../src/core/context.ts";
import type { Io } from "../src/core/io.ts";
import { touchSession } from "../src/core/store.ts";
import { addTask, claimTask, dropTask, finishTask, syncFailure } from "../src/core/tasks.ts";
import { actorRef, taskRef } from "../src/core/types.ts";
import type { TaskDoc, Transport } from "../src/core/types.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness, RunResult } from "./harness.ts";

const posixOnly = process.platform === "win32" ? "uses sh scripts as remote hooks" : false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A pinned clock that only moves when a test says so. Sessions stay live for 15 minutes. */
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

interface ListedTask extends TaskDoc {
  ownerLive: boolean;
}

/** `huddle task add`, returning the new task's id. */
async function addVia(clone: Clone, title: string, now: string): Promise<string> {
  const result = await clone.huddle(["task", "add", title], { now });
  assert.equal(result.code, 0, `task add failed: ${result.stderr}`);
  const id = /^added \[([a-z2-7]{8})\] /.exec(result.stdout)?.[1];
  assert.ok(id, `no id in: ${result.stdout}`);
  return id;
}

/** The tasks as `clone` sees them after a sync at `now`. */
async function tasksSeenBy(clone: Clone, now: string, session?: string): Promise<ListedTask[]> {
  const result = await clone.huddle(["task", "list", "--json"], { now, session });
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(result.stdout) as { tasks: ListedTask[] }).tasks;
}

async function taskSeenBy(clone: Clone, id: string, now: string): Promise<ListedTask> {
  const task = (await tasksSeenBy(clone, now)).find((candidate) => candidate.id === id);
  assert.ok(task, `task ${id} not listed`);
  return task;
}

function remoteGit(h: Harness, args: string[]): string {
  return execFileSync("git", args, { cwd: h.remote, encoding: "utf8" }).trim();
}

/** What a task ref holds on the remote right now, read from the bare repository. */
function remoteTask(h: Harness, id: string): TaskDoc {
  return JSON.parse(remoteGit(h, ["cat-file", "blob", `${taskRef(id)}:doc.json`])) as TaskDoc;
}

interface Contender {
  clone: Clone;
  session?: string;
}

/**
 * Everyone claims the same task at the same moment. Checks the exit test's
 * two clauses and returns how the losers lost.
 */
async function race(h: Harness, id: string, contenders: Contender[], now: string): Promise<{ winner: Contender; beaten: number; late: number }> {
  const results = await Promise.all(contenders.map(({ clone, session }) => clone.huddle(["task", "claim", id], { now, session })));
  const describeAll = (): string => results.map((r, i) => `${contenders[i]!.clone.name}/${contenders[i]!.session ?? "-"}: ${r.code} ${r.stdout.trim()} ${r.stderr.trim()}`).join("\n");

  const winners = results.flatMap((result, index) => (result.code === 0 ? [index] : []));
  assert.equal(winners.length, 1, `expected exactly one winner:\n${describeAll()}`);
  const winner = contenders[winners[0]!]!;
  assert.match(results[winners[0]!]!.stdout, new RegExp(`^claimed \\[${id}\\] `));

  let beaten = 0;
  let late = 0;
  results.forEach((result: RunResult, index) => {
    if (index === winners[0]) return;
    // Exit code 3 is "overlap or lost race", and the message says who has the task.
    assert.equal(result.code, 3, `loser should exit 3:\n${describeAll()}`);
    const named = new RegExp(`\\[${id}\\] .* (was claimed first by|is taken by) ${winner.clone.name} / manual$`);
    assert.match(result.stdout.trim(), named, `the loser's message should name the winner:\n${describeAll()}`);
    if (result.stdout.includes("was claimed first by")) beaten++;
    else late++;
  });

  // The remote agrees: claimed, by the winner's session.
  const onRemote = remoteTask(h, id);
  assert.equal(onRemote.status, "claimed");
  assert.equal(onRemote.owner?.user, winner.clone.name);
  if (winner.session) assert.equal(onRemote.owner?.session, winner.session);
  return { winner, beaten, late };
}

function ioFor(dir: string, env: Record<string, string>): Io {
  return { cwd: dir, env: { ...process.env, ...env }, self: BUNDLE, out: () => {}, err: () => {}, readStdin: async () => "" };
}

/** A context for calling src/core/tasks.ts in-process as a session of `clone`. */
function ctxFor(clone: Clone, now: string, session: string): Promise<Ctx> {
  return openContext(ioFor(clone.dir, { HUDDLE_NOW: now, HUDDLE_SESSION: session }));
}

/**
 * Makes `ctx` lose its next compare-and-swap on `ref`: `first` runs after ctx
 * has read the task and before its push goes out. Returns a count of the
 * pushes ctx attempted for that ref.
 */
function interrupt(ctx: Ctx, ref: string, first: () => Promise<unknown>): () => number {
  const real = ctx.transport;
  let pushes = 0;
  const racing: Transport = {
    fetchAll: (known) => real.fetchAll(known),
    remove: (target, expect) => real.remove(target, expect),
    publish: async (target, doc, expect) => {
      if (target === ref && pushes++ === 0) await first();
      return real.publish(target, doc, expect);
    },
  };
  ctx.transport = racing;
  return () => pushes;
}

// ---------------------------------------------------------------------------
// Exit test
// ---------------------------------------------------------------------------

describe("task claim races (exit test)", () => {
  let h: Harness;
  let clones: Clone[];

  before(async () => {
    h = await createHarness();
    clones = [];
    for (const name of ["alice", "bob", "carol", "dave"]) clones.push(await h.clone(name));
  });
  after(() => h.cleanup());

  test("20 simultaneous claim races each have exactly one winner, and the loser's message names the winner", async (t) => {
    const tally = { races: 0, beaten: 0, late: 0 };
    const wins = new Map<string, number>();
    for (let n = 0; n < 20; n++) {
      // A fresh task per race, added by a different clone each time.
      const id = await addVia(clones[n % 4]!, `race number ${n}`, at(n));
      const result = await race(h, id, clones.map((clone) => ({ clone })), at(n));
      tally.races++;
      tally.beaten += result.beaten;
      tally.late += result.late;
      wins.set(result.winner.clone.name, (wins.get(result.winner.clone.name) ?? 0) + 1);
    }
    t.diagnostic(
      `${tally.races} races of 4 simultaneous claims from 4 clones: ${tally.races} winners; ${tally.beaten} losers lost the compare-and-swap, ` +
        `${tally.late} arrived after it; every loser named the winner. Wins: ${[...wins].map(([name, count]) => `${name} ${count}`).join(", ")}`,
    );
    // If no loser ever lost the swap itself, these were not simultaneous and the test proved nothing about atomicity.
    assert.ok(tally.beaten > 0, "no race was decided by the compare-and-swap");
  });

  test("one claim race with 20 contenders: four clones, five sessions each", async (t) => {
    const id = await addVia(clones[0]!, "the big race", at(30));
    const contenders = clones.flatMap((clone) => [1, 2, 3, 4, 5].map((n) => ({ clone, session: `${clone.name}-session-${n}` })));
    const result = await race(h, id, contenders, at(30));
    t.diagnostic(`20 simultaneous claims: 1 winner (${result.winner.clone.name}, ${result.winner.session}); ${result.beaten} lost the compare-and-swap, ${result.late} arrived after it`);

    // Everyone sees the same owner afterwards, and sees that owner as live.
    for (const clone of clones) {
      const seen = await taskSeenBy(clone, id, at(31));
      assert.equal(seen.owner?.session, result.winner.session);
      assert.equal(seen.ownerLive, true, `${clone.name} sees the winner's claim as abandoned`);
    }
  });

  test("losing the compare-and-swap reports the winner", async () => {
    // Deterministic version of the race: Bob's claim lands in the instant between Alice's read and Alice's push.
    const [alice, bob] = [clones[0]!, clones[1]!];
    const id = await addVia(alice, "contested", at(40));
    const ctx = await ctxFor(alice, at(40), "alice-main");
    const real = ctx.transport;
    let interposed = 0;
    const racing: Transport = {
      fetchAll: (known) => real.fetchAll(known),
      remove: (ref, expect) => real.remove(ref, expect),
      publish: async (ref, doc, expect) => {
        if (ref === taskRef(id) && interposed++ === 0) {
          const stolen = await bob.huddle(["task", "claim", id], { now: at(40) });
          assert.equal(stolen.code, 0, stolen.stderr);
        }
        return real.publish(ref, doc, expect);
      },
    };
    ctx.transport = racing;

    const result = await claimTask(ctx, id, { session: "alice-main", agent: "manual" });
    assert.equal(interposed, 1, "Alice attempted exactly one push for the task");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === "lost-race", JSON.stringify(result));
    assert.equal(!result.ok && result.task?.owner?.user, "bob", "the result carries the task as it is now, owned by the winner");
    assert.equal(!result.ok && result.ownerLive, true);
    assert.equal(remoteTask(h, id).owner?.user, "bob", "Alice's push did not overwrite Bob's claim");
  });
});

// ---------------------------------------------------------------------------
// The life of a task
// ---------------------------------------------------------------------------

describe("huddle task", () => {
  let h: Harness;
  let alice: Clone;
  let bob: Clone;

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    bob = await h.clone("bob");
  });
  after(() => h.cleanup());

  test("add, list, claim, done", async () => {
    const empty = await bob.huddle(["task"], { now: at(0) });
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /^No tasks\. Add one with: huddle task add/);

    const id = await addVia(alice, "Write the login page", at(1));
    const open = await bob.huddle(["task", "list"], { now: at(2) });
    assert.match(open.stdout, /^Tasks: 1 open\./);
    assert.ok(open.stdout.includes(`- [${id}] open: Write the login page`), open.stdout);
    const created = await taskSeenBy(bob, id, at(2));
    assert.deepEqual(
      { status: created.status, owner: created.owner, by: created.createdBy.user, createdAt: created.createdAt, updatedAt: created.updatedAt },
      { status: "open", owner: null, by: "alice", createdAt: at(1), updatedAt: at(1) },
    );

    const claimed = await bob.huddle(["task", "claim", id], { now: at(3) });
    assert.deepEqual([claimed.code, claimed.stdout.trim()], [0, `claimed [${id}] Write the login page`]);
    // The claimer sees "you"; the teammate sees the name. Neither sees it as abandoned.
    assert.ok((await bob.huddle(["task"], { now: at(4) })).stdout.includes(`- [${id}] taken by you: Write the login page`));
    assert.ok((await alice.huddle(["task"], { now: at(4) })).stdout.includes(`- [${id}] taken by bob / manual: Write the login page`));
    assert.equal((await taskSeenBy(alice, id, at(5))).updatedAt, at(3));

    // Claiming what you already hold is fine and changes nothing.
    const before = remoteGit(h, ["rev-parse", taskRef(id)]);
    const again = await bob.huddle(["task", "claim", id], { now: at(6) });
    assert.deepEqual([again.code, again.stdout.trim()], [0, `claimed [${id}] Write the login page`]);
    assert.equal(remoteGit(h, ["rev-parse", taskRef(id)]), before);

    // Alice can neither claim it nor finish it, and is told who holds it.
    const taken = await alice.huddle(["task", "claim", id], { now: at(7) });
    assert.deepEqual([taken.code, taken.stdout.trim()], [3, `[${id}] Write the login page is taken by bob / manual`]);
    const notMine = await alice.huddle(["task", "done", id], { now: at(8) });
    assert.deepEqual([notMine.code, notMine.stdout.trim()], [3, `[${id}] Write the login page is held by bob / manual, not by this session`]);
    assert.equal(remoteGit(h, ["rev-parse", taskRef(id)]), before, "a refused change pushed nothing");

    const done = await bob.huddle(["task", "done", id], { now: at(9) });
    assert.deepEqual([done.code, done.stdout.trim()], [0, `done [${id}] Write the login page`]);
    assert.ok((await alice.huddle(["task"], { now: at(10) })).stdout.includes(`- [${id}] done by bob / manual: Write the login page`));

    // Finishing a finished task is not an error; claiming or dropping one is a conflict.
    const doneAgain = await alice.huddle(["task", "done", id], { now: at(11) });
    assert.deepEqual([doneAgain.code, doneAgain.stdout.trim()], [0, `[${id}] Write the login page is already done (by bob / manual)`]);
    assert.equal((await alice.huddle(["task", "claim", id], { now: at(12) })).code, 3);
    assert.equal((await bob.huddle(["task", "drop", id], { now: at(12) })).code, 3);
    assert.deepEqual({ status: remoteTask(h, id).status, user: remoteTask(h, id).owner?.user }, { status: "done", user: "bob" });
  });

  test("a change shows in this clone's own list at once, without another sync", async () => {
    // `--cached` reads the cache and nothing else: it is what the next briefing in this clone would show.
    const cached = async (clone: Clone, now: string): Promise<string> => {
      const result = await clone.huddle(["task", "list", "--cached"], { now });
      assert.equal(result.code, 0, result.stderr);
      return result.stdout;
    };
    const id = await addVia(alice, "Cache me", at(15));
    assert.ok((await cached(alice, at(15))).includes(`- [${id}] open: Cache me`), "the new task is not in the cache");
    assert.equal((await alice.huddle(["task", "claim", id], { now: at(15) })).code, 0);
    assert.ok((await cached(alice, at(15))).includes(`- [${id}] taken by you: Cache me`), "the claim is not in the cache");
    assert.equal((await alice.huddle(["task", "drop", id], { now: at(15) })).code, 0);
    assert.ok((await cached(alice, at(15))).includes(`- [${id}] open: Cache me`), "the drop is not in the cache");
    assert.equal((await alice.huddle(["task", "done", id], { now: at(15) })).code, 0);
    assert.match(await cached(alice, at(15)), new RegExp(`- \\[${id}\\] done by .*: Cache me`), "the finish is not in the cache");
    // Bob has not synced since the task was added, and --cached does not go and ask.
    assert.ok(!(await cached(bob, at(15))).includes(id));
  });

  test("drop gives a task back, and only its holder can", async () => {
    const id = await addVia(alice, "Refactor the router", at(20));
    assert.equal((await alice.huddle(["task", "claim", id], { now: at(21) })).code, 0);

    const notMine = await bob.huddle(["task", "drop", id], { now: at(22) });
    assert.deepEqual([notMine.code, notMine.stdout.trim()], [3, `[${id}] Refactor the router is held by alice / manual, not by this session`]);

    const dropped = await alice.huddle(["task", "drop", id], { now: at(23) });
    assert.deepEqual([dropped.code, dropped.stdout.trim()], [0, `dropped [${id}] Refactor the router; it is open again`]);
    assert.deepEqual({ status: remoteTask(h, id).status, owner: remoteTask(h, id).owner }, { status: "open", owner: null });
    // Dropping an open task is fine and changes nothing.
    assert.equal((await bob.huddle(["task", "drop", id], { now: at(24) })).code, 0);

    assert.equal((await bob.huddle(["task", "claim", id], { now: at(25) })).code, 0);
    assert.equal(remoteTask(h, id).owner?.user, "bob");
  });

  test("anyone can finish a task nobody holds", async () => {
    const id = await addVia(alice, "Fix the typo", at(30));
    const done = await bob.huddle(["task", "done", id], { now: at(31) });
    assert.deepEqual([done.code, done.stdout.trim()], [0, `done [${id}] Fix the typo`]);
    assert.deepEqual({ status: remoteTask(h, id).status, user: remoteTask(h, id).owner?.user }, { status: "done", user: "bob" });
  });

  test("a claim whose session is gone can be claimed again, and not a minute before", async () => {
    const id = await addVia(alice, "Migrate the database", at(100));
    assert.equal((await alice.huddle(["task", "claim", id], { now: at(100) })).code, 0);

    // 14 minutes later Alice's session is still live (ttlMinutes is 15).
    const early = await bob.huddle(["task", "claim", id], { now: at(114) });
    assert.deepEqual([early.code, early.stdout.trim()], [3, `[${id}] Migrate the database is taken by alice / manual`]);

    // At 15 minutes it is not. Bob is told the task can be taken over, by list and by a refused `done`.
    const listed = await bob.huddle(["task"], { now: at(115) });
    assert.ok(listed.stdout.includes(`- [${id}] claimed by alice / manual, whose session is gone, so it can be claimed again: Migrate the database`), listed.stdout);
    const notMine = await bob.huddle(["task", "done", id], { now: at(116) });
    assert.equal(notMine.code, 3);
    assert.equal(
      notMine.stdout.trim(),
      `[${id}] Migrate the database is held by alice / manual, not by this session. That session is gone, so you can take the task over: huddle task claim ${id}`,
    );

    const taken = await bob.huddle(["task", "claim", id], { now: at(117) });
    assert.deepEqual([taken.code, taken.stdout.trim()], [0, `claimed [${id}] Migrate the database`]);
    assert.equal(remoteTask(h, id).owner?.user, "bob");

    // Alice comes back. The task is Bob's now.
    const back = await alice.huddle(["task", "done", id], { now: at(118) });
    assert.deepEqual([back.code, back.stdout.trim()], [3, `[${id}] Migrate the database is held by bob / manual, not by this session`]);
  });

  /**
   * A clone with two sessions, where what is published for "beta" trails what
   * the clone knows: beta holds the task, the clone's document was last
   * published by "alpha" when beta had been quiet for 13 minutes, and beta has
   * been active since. This is the state between a hook recording a session's
   * activity and the sync that publishes it.
   */
  async function trailingTwin(name: string): Promise<{ twin: Clone; id: string }> {
    const twin = await h.clone(name);
    const id = await addVia(twin, "Shared desk", at(500));
    assert.equal((await twin.huddle(["task", "claim", id], { now: at(500), session: "beta" })).code, 0);
    // 13 minutes on, alpha's activity publishes the clone's document; beta's last sign of life in it is 13 minutes old.
    assert.equal((await twin.huddle(["intent", "something else"], { now: at(513), session: "alpha" })).code, 0);
    assert.equal((await twin.huddle(["sync"], { now: at(513), session: "alpha" })).code, 0);
    // A minute later beta is at work again: recorded in this clone, not yet synced.
    const paths = await twin.paths();
    await touchSession(paths, { id: "beta", worktree: paths.worktree, agent: "manual", seenAt: at(514) });
    const actor = readFileSync(join(twin.dir, ".git", "huddle", "actor"), "utf8").trim();
    const published = JSON.parse(remoteGit(h, ["cat-file", "blob", `${actorRef(actor)}:doc.json`])) as { sessions: { id: string; seenAt: string }[] };
    assert.equal(published.sessions.find((session) => session.id === "beta")?.seenAt, at(500), "setup: the remote copy of beta should still be the old one");
    return { twin, id };
  }

  test("a task held by another live session of the same clone is never taken over", async () => {
    const { twin, id } = await trailingTwin("twin");
    // 15.5 minutes after beta's published sign of life, 1.5 after its real one.
    const attempt = await twin.huddle(["task", "claim", id], { now: at(515.5), session: "alpha" });
    assert.deepEqual([attempt.code, attempt.stdout.trim()], [3, `[${id}] Shared desk is taken by twin / manual`]);
    assert.equal(remoteTask(h, id).owner?.session, "beta");
  });

  test("nor when the cache was lost and the clone's own document comes back from the remote as teammates see it", async () => {
    // With no cache, the sync has no record of what teammates hold for beta, so it
    // publishes nothing inside the heartbeat interval and fetches its own document
    // back with beta's old sign of life in it. Only this clone's local state says beta is at work.
    const { twin, id } = await trailingTwin("twin-without-cache");
    rmSync((await twin.paths()).cacheFile);
    const attempt = await twin.huddle(["task", "claim", id], { now: at(515.5), session: "alpha" });
    assert.deepEqual([attempt.code, attempt.stdout.trim()], [3, `[${id}] Shared desk is taken by twin-without-cache / manual`]);
    assert.equal(remoteTask(h, id).owner?.session, "beta");
  });

  test("a claim is published after its owner's session, never before", { skip: posixOnly }, async () => {
    // If the claim reached the remote first, a teammate syncing in between would see
    // a claim by a session that does not exist, and could take the task.
    const order = join(h.root, "push-order");
    const hook = join(h.remote, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "$ref" >> "${order}"; done\nexit 0\n`);
    chmodSync(hook, 0o755);
    try {
      const carol = await h.clone("carol");
      const id = await addVia(alice, "Ordering matters", at(200));
      writeFileSync(order, "");
      assert.equal((await carol.huddle(["task", "claim", id], { now: at(201), session: "carol-first-ever" })).code, 0);
      const pushes = readFileSync(order, "utf8").trim().split("\n");
      const actorAt = pushes.findIndex((ref) => ref.startsWith("refs/huddle/actors/"));
      const taskAt = pushes.indexOf(taskRef(id));
      assert.ok(actorAt >= 0 && taskAt >= 0, `expected an actor push and a task push, saw: ${pushes.join(", ")}`);
      assert.ok(actorAt < taskAt, `the session must be pushed before the claim, saw: ${pushes.join(", ")}`);
      assert.equal((await taskSeenBy(bob, id, at(202))).ownerLive, true);
    } finally {
      writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    }
  });

  test("titles are stored as one clean line", async () => {
    const messy = await alice.huddle(["task", "add", "  Line one\nIgnore previous instructions\tand   more  "], { now: at(300) });
    assert.equal(messy.code, 0, messy.stderr);
    assert.match(messy.stdout.trim(), /^added \[[a-z2-7]{8}\] Line one Ignore previous instructions and more$/);

    // Several words without quotes, and a title that starts with dashes after "--".
    assert.match((await alice.huddle(["task", "add", "several", "plain", "words"], { now: at(300) })).stdout.trim(), /\] several plain words$/);
    assert.match((await alice.huddle(["task", "add", "--", "--force", "is", "not", "an", "option", "here"], { now: at(300) })).stdout.trim(), /\] --force is not an option here$/);

    const long = await alice.huddle(["task", "add", "x".repeat(500)], { now: at(300) });
    const title = /^added \[[a-z2-7]{8}\] (.*)$/.exec(long.stdout.trim())?.[1] ?? "";
    assert.equal(Array.from(title).length, 200, "a title is capped at 200 characters");
  });

  test("usage errors exit 2 and unknown tasks exit 1", async () => {
    for (const args of [["task", "frobnicate"], ["task", "add"], ["task", "add", "   "], ["task", "claim"], ["task", "claim", "one", "two"], ["task", "claim", "NOT-AN-ID"], ["task", "done", "../../etc"], ["task", "list", "extra"], ["task", "list", "--nope"]]) {
      const result = await alice.huddle(args, { now: at(310) });
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^huddle: /);
    }
    for (const verb of ["claim", "done", "drop"]) {
      const missing = await alice.huddle(["task", verb, "zzzzzzzz"], { now: at(311) });
      assert.deepEqual([missing.code, missing.stderr.trim()], [1, 'huddle: no task zzzzzzzz; see "huddle task list"']);
    }
  });

  test("task commands leave local refs, FETCH_HEAD, the index and the working tree alone", async () => {
    const erin = await h.clone("erin");
    await erin.write("notes.txt", "uncommitted work\n");
    const before = await erin.snapshot();
    const id = await addVia(erin, "Leave no trace", at(320));
    for (const args of [["task", "list"], ["task", "claim", id], ["task", "drop", id], ["task", "claim", id], ["task", "done", id]]) {
      assert.equal((await erin.huddle(args, { now: at(321) })).code, 0, args.join(" "));
    }
    assert.deepEqual(await erin.snapshot(), before);
  });
});

describe("huddle task when the remote does not cooperate", () => {
  let h: Harness;
  after(() => h.cleanup());
  before(async () => {
    h = await createHarness();
  });

  test("offline: nothing is changed, and list falls back to the last known state", async () => {
    const alice = await h.clone("alice");
    const frank = await h.clone("frank");
    const id = await addVia(alice, "Needs the network", at(0));
    assert.match((await frank.huddle(["task"], { now: at(1) })).stdout, /1 open/);
    const refBefore = remoteGit(h, ["rev-parse", taskRef(id)]);

    await frank.git("remote", "set-url", "origin", join(h.root, "no-such-remote.git"));
    for (const args of [["task", "claim", id], ["task", "done", id], ["task", "drop", id], ["task", "add", "Another"]]) {
      const result = await frank.huddle(args, { now: at(2) });
      assert.deepEqual([result.code, result.stdout, result.stderr.trim()], [1, "", 'huddle: could not reach remote "origin"; nothing was changed'], args.join(" "));
    }
    const listed = await frank.huddle(["task"], { now: at(3) });
    assert.equal(listed.code, 0);
    assert.ok(listed.stdout.includes(`- [${id}] open: Needs the network`), listed.stdout);
    assert.match(listed.stderr, /could not reach remote "origin"; showing the last known state/);
    assert.equal(remoteGit(h, ["rev-parse", taskRef(id)]), refBefore);
  });

  test("a remote that refuses huddle refs: the command says so and points at doctor", { skip: posixOnly }, async () => {
    const strict = await createHarness();
    try {
      const gina = await strict.clone("gina");
      const hook = join(strict.remote, "hooks", "pre-receive");
      writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/huddle/tasks/*) exit 1;; esac; done\nexit 0\n');
      chmodSync(hook, 0o755);
      const result = await gina.huddle(["task", "add", "Not allowed here"], { now: at(0) });
      assert.deepEqual(
        [result.code, result.stdout, result.stderr.trim()],
        [1, "", 'huddle: remote "origin" refused a push to refs/huddle/*; nothing was changed. Run "huddle doctor"'],
      );
      assert.equal(existsSync(join(strict.remote, "refs", "huddle", "tasks")), false);
    } finally {
      await strict.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// src/core/tasks.ts directly
// ---------------------------------------------------------------------------

describe("tasks.ts", () => {
  let h: Harness;
  let alice: Clone;
  const who = { session: "alice-main", agent: "manual" };

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
  });
  after(() => h.cleanup());

  test("addTask picks another id when the first one is taken", async () => {
    const ctx = await ctxFor(alice, at(0), who.session);
    const real = ctx.transport;
    const tried: string[] = [];
    ctx.transport = {
      fetchAll: (known) => real.fetchAll(known),
      remove: (ref, expect) => real.remove(ref, expect),
      publish: async (ref, doc, expect) => {
        tried.push(ref);
        assert.equal(expect, "absent", "a new task is created only if its ref does not exist");
        return tried.length < 3 ? { ok: false, reason: "lost-race" } : real.publish(ref, doc, expect);
      },
    };
    const result = await addTask(ctx, "Third time lucky", who);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(new Set(tried).size, 3, "each attempt used a new id");
    assert.equal(tried[2], taskRef(result.task.id));
    assert.equal(remoteTask(h, result.task.id).title, "Third time lucky");

    // And gives up rather than looping when every id is refused.
    ctx.transport = { ...ctx.transport, publish: async () => ({ ok: false, reason: "lost-race" }) };
    assert.deepEqual(await addTask(ctx, "Never", who), { ok: false, reason: "lost-race" });
  });

  test("a change is decided on fresh state, not on the cache", async () => {
    const bob = await h.clone("bob");
    const id = await addVia(alice, "Stale cache", at(10));
    // Alice's cache says "open". Bob claims and finishes it without Alice syncing.
    assert.equal((await bob.huddle(["task", "claim", id], { now: at(11) })).code, 0);
    assert.equal((await bob.huddle(["task", "done", id], { now: at(12) })).code, 0);

    const ctx = await ctxFor(alice, at(13), who.session);
    let pushes = 0;
    const real = ctx.transport;
    ctx.transport = {
      fetchAll: (known) => real.fetchAll(known),
      remove: (ref, expect) => real.remove(ref, expect),
      publish: (ref, doc, expect) => {
        if (ref === taskRef(id)) pushes++;
        return real.publish(ref, doc, expect);
      },
    };
    const claim = await claimTask(ctx, id, who);
    assert.ok(!claim.ok && claim.reason === "already-done" && claim.task?.owner?.user === "bob", JSON.stringify(claim));
    const drop = await dropTask(ctx, id, who);
    assert.ok(!drop.ok && drop.reason === "already-done", JSON.stringify(drop));
    const finish = await finishTask(ctx, id, who);
    assert.ok(!finish.ok && finish.reason === "already-done", JSON.stringify(finish));
    assert.equal(pushes, 0, "nothing was pushed for a task that was already done");
  });

  test("an unreachable remote is reported, and no claim is attempted", async () => {
    const id = await addVia(alice, "Unreachable", at(20));
    const ctx = await ctxFor(alice, at(21), who.session);
    let pushes = 0;
    ctx.transport = {
      fetchAll: async () => ({ ok: false, reason: "offline" }),
      remove: async () => ({ ok: false, reason: "offline" }),
      publish: async (ref) => {
        if (ref === taskRef(id)) pushes++;
        return { ok: false, reason: "offline" };
      },
    };
    for (const change of [claimTask, finishTask, dropTask]) {
      assert.deepEqual(await change(ctx, id, who), { ok: false, reason: "offline" });
    }
    assert.equal(pushes, 0);
    assert.deepEqual(await addTask(ctx, "Unreachable too", who), { ok: false, reason: "offline" });
  });

  test("a lost race that ends where the caller wanted to be is not reported as lost", async () => {
    const bob = await h.clone("bobby");
    // The other terminal's clock reads a second later than ours. With the very same time the two
    // documents would be identical, the same commit, and our push would be a no-op instead of a loss.
    const beat = new Date(Date.parse(at(40)) + 1_000).toISOString();
    const mine = { now: beat, session: who.session };
    const ok = async (clone: Clone, args: string[], opts: { now: string; session?: string }): Promise<void> => {
      const result = await clone.huddle(args, opts);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    };

    // Claim: the same session claims from a second terminal in the instant between our read and our push.
    const twice = await addVia(alice, "Claimed twice", at(40));
    let ctx = await ctxFor(alice, at(40), who.session);
    let pushes = interrupt(ctx, taskRef(twice), () => ok(alice, ["task", "claim", twice], mine));
    const claim = await claimTask(ctx, twice, who);
    assert.equal(pushes(), 1, "setup: our own push should have gone out");
    assert.equal(remoteTask(h, twice).updatedAt, beat, "setup: our push should have lost to the other terminal's");
    assert.ok(claim.ok && claim.task.status === "claimed" && claim.task.owner?.session === who.session, JSON.stringify(claim));
    assert.equal(claim.ok && claim.task.updatedAt, beat, "the result is the task as it is on the remote");

    // Drop: the task we are giving back was given back from the second terminal already.
    ctx = await ctxFor(alice, at(40), who.session);
    pushes = interrupt(ctx, taskRef(twice), () => ok(alice, ["task", "drop", twice], mine));
    const drop = await dropTask(ctx, twice, who);
    assert.equal(pushes(), 1);
    assert.equal(remoteTask(h, twice).updatedAt, beat, "setup: our push should have lost to the other terminal's");
    assert.ok(drop.ok && drop.task.status === "open" && drop.task.owner === null, JSON.stringify(drop));

    // Done: Bob finishes the open task first. It is done, which is what we wanted, and the result says by whom.
    ctx = await ctxFor(alice, at(40), who.session);
    pushes = interrupt(ctx, taskRef(twice), () => ok(bob, ["task", "done", twice], { now: at(40) }));
    const finish = await finishTask(ctx, twice, who);
    assert.equal(pushes(), 1);
    assert.ok(!finish.ok && finish.reason === "already-done" && finish.task?.owner?.user === "bobby", JSON.stringify(finish));
    assert.equal(remoteTask(h, twice).owner?.user, "bobby", "our late push changed nothing");

    // Claim against someone who claimed and finished in that instant: not a win, and not "taken" either.
    const gone = await addVia(alice, "Finished under us", at(41));
    ctx = await ctxFor(alice, at(41), who.session);
    pushes = interrupt(ctx, taskRef(gone), () => ok(bob, ["task", "done", gone], { now: at(41) }));
    const late = await claimTask(ctx, gone, who);
    assert.ok(!late.ok && late.reason === "already-done" && late.task?.owner?.user === "bobby", JSON.stringify(late));

    // Drop against someone who took the task over: still a lost race, and it names them.
    const taken = await addVia(alice, "Taken over", at(42));
    await ok(alice, ["task", "claim", taken], { now: at(42), session: who.session });
    ctx = await ctxFor(alice, at(60), who.session); // 18 minutes on, the claim's session has lapsed for everyone but us
    pushes = interrupt(ctx, taskRef(taken), () => ok(bob, ["task", "claim", taken], { now: at(60) }));
    const beaten = await dropTask(ctx, taken, who);
    assert.equal(pushes(), 1);
    assert.ok(!beaten.ok && beaten.reason === "lost-race" && beaten.task?.owner?.user === "bobby", JSON.stringify(beaten));
  });

  test("syncFailure: a change is only decided on state that was just fetched", () => {
    const round = { ran: true, fetched: true, published: false };
    assert.equal(syncFailure(round), null);
    assert.equal(syncFailure({ ...round, published: true }), null);
    assert.equal(syncFailure({ ...round, fetched: false, error: "offline" }), "offline");
    assert.equal(syncFailure({ ...round, fetched: false, error: "denied" }), "denied");
    // The fetch worked and our own push was refused: the task push would be refused as well.
    assert.equal(syncFailure({ ...round, error: "denied" }), "denied");
    assert.equal(syncFailure({ ...round, error: "offline" }), "offline", "our session may not be on the remote yet");
    assert.equal(syncFailure({ ...round, error: "lost-race" }), "offline");
    assert.equal(syncFailure({ ran: false, fetched: false, published: false, error: "internal" }), "offline");
    // Another sync held the lock for the whole wait: no error, and no fresh state either.
    assert.equal(syncFailure({ ran: false, skipped: "locked", fetched: false, published: false }), "offline");
    assert.equal(syncFailure({ ran: false, skipped: "throttled", fetched: false, published: false }), "offline");
  });

  test("an unknown task is not-found for every change", async () => {
    const ctx = await ctxFor(alice, at(30), who.session);
    for (const change of [claimTask, finishTask, dropTask]) {
      assert.deepEqual(await change(ctx, "zzzzzzzz", who), { ok: false, reason: "not-found" });
    }
  });
});
