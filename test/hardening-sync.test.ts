// Hardening, worker 1 (CONTRACT §5.3): forced syncs queued in one clone share
// a round. C1: K queued run one round between them. C2: a round that began
// before the caller's write is never reused. C3: a failed round is never
// reused as a success; "offline" is reused as that failure, so a queue against
// an unreachable remote is answered within one network timeout.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openContext } from "../src/core/context.ts";
import type { Ctx } from "../src/core/context.ts";
import type { Io } from "../src/core/io.ts";
import { touchSession, withLock } from "../src/core/store.ts";
import { sync } from "../src/core/sync.ts";
import type { SyncResult } from "../src/core/sync.ts";
import { actorRef } from "../src/core/types.ts";
import type { ActorDoc, FetchResult, PublishResult, Transport } from "../src/core/types.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness, RunResult } from "./harness.ts";

/** What says which session a process is (CONTRACT 3.1). None of it may leak in from the shell that runs the tests. */
const SESSION_VARS = ["HUDDLE_SESSION", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"];

function ioFor(dir: string, env: Record<string, string>): Io {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SESSION_VARS) delete base[name];
  return { cwd: dir, env: { ...base, ...env }, self: BUNDLE, out: () => {}, err: () => {}, readStdin: async () => "" };
}

/** A context for calling sync in-process as session `session` of `clone`. */
function ctxFor(clone: Clone, session: string): Promise<Ctx> {
  return openContext(ioFor(clone.dir, { HUDDLE_SESSION: session }));
}

/** Records `session` in local.json, as a command does before it syncs. */
async function touch(ctx: Ctx, session: string, intent = ""): Promise<void> {
  await touchSession(ctx.paths, { id: session, worktree: ctx.paths.worktree, agent: "manual", intent, seenAt: new Date().toISOString() });
}

/** Takes the clone's sync.lock in this process, as a running round would, until the returned function is called. */
async function holdSync(clone: Clone): Promise<() => Promise<void>> {
  const paths = await clone.paths();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let taken: () => void = () => {};
  const held = new Promise<void>((resolve) => (taken = resolve));
  // The staleness sync itself passes, so that no waiter takes the lock over.
  const done = withLock(paths, "sync", async () => {
    taken();
    await gate;
  }, { staleMs: 60_000 });
  await held;
  return async () => {
    release();
    await done;
  };
}

/** How many processes are waiting for the clone's sync.lock: each keeps a temporary directory next to it while it waits. */
function waiting(stateDir: string): number {
  return readdirSync(stateDir).filter((name) => name.startsWith("sync.lock.tmp-")).length;
}

async function until(what: string, condition: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Rounds, counted as git's own trace of the ls-remote calls made with GIT_TRACE=<file> (every platform). */
function lsRemotes(trace: string): number {
  let text = "";
  try {
    text = readFileSync(trace, "utf8");
  } catch {
    return 0;
  }
  return text.split("\n").filter((line) => /trace: built-in: git ls-remote /.test(line)).length;
}

async function actorId(clone: Clone): Promise<string> {
  return readFileSync((await clone.paths()).actorFile, "utf8").trim();
}

async function remoteActorDoc(h: Harness, clone: Clone): Promise<ActorDoc> {
  return JSON.parse(await h.remoteGit("cat-file", "blob", `${actorRef(await actorId(clone))}:doc.json`)) as ActorDoc;
}

function describeRuns(results: RunResult[]): string {
  return results.map((r, i) => `${i}: exit ${r.code} ${r.stdout.trim()} ${r.stderr.trim()}`).join("\n");
}

/**
 * Wraps ctx's transport so that its next fetchAll and its next publish of this
 * clone's own document wait at a gate. `inside` resolves once the round is
 * at the gate (it has numbered itself and read local state by then).
 */
function blockRound(ctx: Ctx, answer: { fetch?: FetchResult; own?: PublishResult } = {}) {
  const real = ctx.transport;
  let reached: () => void = () => {};
  const inside = new Promise<void>((resolve) => (reached = resolve));
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let fetches = 0;
  const blocking: Transport = {
    fetchAll: async (known) => {
      if (fetches++ === 0) {
        reached();
        await gate;
        if (answer.fetch) return answer.fetch;
      }
      return real.fetchAll(known);
    },
    publish: async (ref, doc, expect) => {
      if (expect === "own" && answer.own) {
        await gate;
        return answer.own;
      }
      return real.publish(ref, doc, expect);
    },
    remove: (ref, expect) => real.remove(ref, expect),
  };
  ctx.transport = blocking;
  return { inside, open };
}

/** Counts the rounds of every context it wraps: one listing of the remote (fetchAll) per round. */
function countRounds(ctxs: Ctx[]): () => number {
  let rounds = 0;
  for (const ctx of ctxs) {
    const real = ctx.transport;
    ctx.transport = {
      fetchAll: (known) => {
        rounds++;
        return real.fetchAll(known);
      },
      publish: (ref, doc, expect) => real.publish(ref, doc, expect),
      remove: (ref, expect) => real.remove(ref, expect),
    };
  }
  return () => rounds;
}

describe("C1: forced syncs queued in one clone", () => {
  test("five queued at the same moment behind an open round are served by at most two rounds", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const opener = await ctxFor(alice, "alice-0");
    await touch(opener, "alice-0");
    assert.equal((await sync(opener, { force: true })).fetched, true);

    const callers = await Promise.all([1, 2, 3, 4, 5].map((n) => ctxFor(alice, `alice-${n}`)));
    const rounds = countRounds([opener, ...callers]);
    // The first round is held open until all five are queued behind it. It read local state before their writes.
    const block = blockRound(opener);
    const first = sync(opener, { force: true });
    await block.inside;
    const queued: Promise<SyncResult>[] = [];
    for (const [i, ctx] of callers.entries()) {
      await touch(ctx, `alice-${i + 1}`, `work ${i + 1}`);
      queued.push(sync(ctx, { force: true }));
    }
    await until("all five wait for sync.lock", () => waiting(opener.paths.stateDir) >= 5);
    block.open();
    const results = await Promise.all([first, ...queued]);

    assert.ok(rounds() <= 2, `${rounds()} rounds for one open round and five queued behind it`);
    for (const result of results) assert.equal(result.fetched, true, JSON.stringify(results));
    assert.equal(results.slice(1).filter((result) => result.shared === true).length, 4, "four of the five were served by the round of the fifth");
    const published = new Map((await remoteActorDoc(h, alice)).sessions.map((session) => [session.id, session.intent]));
    for (const n of [1, 2, 3, 4, 5]) assert.equal(published.get(`alice-${n}`), `work ${n}`, `alice-${n}'s write is on the remote`);
  });

  test("five queued in one clone run one round between them, and every session is published", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const first = await alice.huddle(["sync", "--force"], { session: "alice-0" });
    assert.equal(first.code, 0, first.stderr);
    const stateDir = (await alice.paths()).stateDir;
    const trace = join(h.root, "trace-alice.txt");

    const release = await holdSync(alice);
    const runs = [1, 2, 3, 4, 5].map((n) => alice.huddle(["sync", "--force"], { session: `alice-${n}`, env: { GIT_TRACE: trace } }));
    try {
      await until("all five wait for sync.lock", () => waiting(stateDir) >= 5);
    } finally {
      await release();
    }
    const results = await Promise.all(runs);
    for (const result of results) assert.equal(result.code, 0, describeRuns(results));
    assert.equal(lsRemotes(trace), 1, "rounds (ls-remote calls) for five queued forced syncs");
    const published = (await remoteActorDoc(h, alice)).sessions.map((session) => session.id).sort();
    for (const n of [1, 2, 3, 4, 5]) assert.ok(published.includes(`alice-${n}`), `alice-${n} is on the remote: ${published.join(", ")}`);
  });

  test("twenty queued over four clones run at most two rounds per clone", async (t) => {
    const h = await createHarness(t);
    const clones = await Promise.all(["alice", "bob", "carol", "dave"].map((name) => h.clone(name)));
    for (const clone of clones) {
      const first = await clone.huddle(["sync", "--force"], { session: `${clone.name}-0` });
      assert.equal(first.code, 0, first.stderr);
    }
    const traces = clones.map((clone) => join(h.root, `trace-${clone.name}.txt`));
    const releases = await Promise.all(clones.map(holdSync));
    const runs = clones.flatMap((clone, c) =>
      [1, 2, 3, 4, 5].map((n) => clone.huddle(["sync", "--force"], { session: `${clone.name}-${n}`, env: { GIT_TRACE: traces[c]! } })),
    );
    try {
      for (const clone of clones) {
        const stateDir = (await clone.paths()).stateDir;
        await until(`${clone.name}'s five wait for sync.lock`, () => waiting(stateDir) >= 5);
      }
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
    const results = await Promise.all(runs);
    for (const result of results) assert.equal(result.code, 0, describeRuns(results));
    for (const [c, clone] of clones.entries()) {
      const rounds = lsRemotes(traces[c]!);
      assert.ok(rounds >= 1 && rounds <= 2, `${clone.name} ran ${rounds} rounds for five queued forced syncs`);
      const published = (await remoteActorDoc(h, clone)).sessions.map((session) => session.id);
      for (const n of [1, 2, 3, 4, 5]) assert.ok(published.includes(`${clone.name}-${n}`), `${clone.name}-${n} is on the remote`);
    }
  });
});

describe("C2: a round that began before the caller's write", () => {
  test("is not reused: the caller runs its own round, and the remote holds the caller's write", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const a = await ctxFor(alice, "alice-a");
    await touch(a, "alice-a");
    assert.equal((await sync(a, { force: true })).fetched, true);

    const block = blockRound(a);
    const early = sync(a, { force: true });
    await block.inside; // numbered, and local state read before the write below

    const b = await ctxFor(alice, "alice-b");
    await touch(b, "alice-b", "the caller's write");
    const late = sync(b, { force: true });
    await until("the caller waits for sync.lock", () => waiting(b.paths.stateDir) >= 1);
    block.open();
    const [first, second]: [SyncResult, SyncResult] = await Promise.all([early, late]);

    assert.equal(first.shared, undefined);
    assert.equal(first.fetched, true);
    assert.equal(second.shared, undefined, "the caller was answered by a round that read local state before its write");
    assert.equal(second.fetched, true);
    assert.equal(second.published, true);
    const onRemote = (await remoteActorDoc(h, alice)).sessions.find((session) => session.id === "alice-b");
    assert.equal(onRemote?.intent, "the caller's write");
  });

  test("a round that began after the caller's write is reused, and its result says so", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const a = await ctxFor(alice, "alice-a");
    await touch(a, "alice-a");
    assert.equal((await sync(a, { force: true })).fetched, true);

    // The caller writes and asks while the lock is held, before the round that will serve it has begun.
    const release = await holdSync(alice);
    const b = await ctxFor(alice, "alice-b");
    await touch(b, "alice-b", "written first");
    const late = sync(b, { force: true });
    await until("the caller waits for sync.lock", () => waiting(b.paths.stateDir) >= 1);
    const other = sync(a, { force: true });
    await until("both wait for sync.lock", () => waiting(b.paths.stateDir) >= 2);
    await release();
    const results = await Promise.all([late, other]);
    // One of them ran the round, the other was served by it, whichever took the lock first.
    assert.deepEqual(results.map((r) => r.shared === true).sort(), [false, true], JSON.stringify(results));
    for (const result of results) assert.equal(result.fetched, true);
    const onRemote = (await remoteActorDoc(h, alice)).sessions.find((session) => session.id === "alice-b");
    assert.equal(onRemote?.intent, "written first");
  });
});

describe("C3: a round that failed", () => {
  // The caller asks while the round runs, so it may only be served by a round that ends after its request.
  async function queuedBehind(answer: { fetch?: FetchResult; own?: PublishResult }, t: { after(fn: () => unknown): void }) {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const a = await ctxFor(alice, "alice-a");
    await touch(a, "alice-a");
    assert.equal((await sync(a, { force: true })).fetched, true);
    await touch(a, "alice-a", "something new to publish");
    const block = blockRound(a, answer);
    const failing = sync(a, { force: true });
    await block.inside;
    const b = await ctxFor(alice, "alice-b");
    await touch(b, "alice-b");
    const late = sync(b, { force: true });
    await until("the caller waits for sync.lock", () => waiting(b.paths.stateDir) >= 1);
    block.open();
    const [first, second] = await Promise.all([failing, late]);
    return { first, second };
  }

  test("offline is reused as offline, never as a success", async (t) => {
    const { first, second } = await queuedBehind({ fetch: { ok: false, reason: "offline" } }, t);
    assert.equal(first.error, "offline");
    assert.deepEqual(second, { ran: true, shared: true, fetched: false, published: false, error: "offline" });
  });

  test("denied is reused as denied", async (t) => {
    const { second } = await queuedBehind({ own: { ok: false, reason: "denied" } }, t);
    assert.deepEqual(second, { ran: true, shared: true, fetched: false, published: false, error: "denied" });
  });

  test("a push of this clone's document whose answer was lost is reused only as offline, never as a success", async (t) => {
    // The fetch worked; the push went out and no answer came back.
    const { first, second } = await queuedBehind({ own: { ok: false, reason: "offline" } }, t);
    assert.equal(first.fetched, true);
    assert.equal(first.error, "offline");
    assert.equal(second.shared, true);
    assert.equal(second.fetched, false);
    assert.equal(second.error, "offline");
  });

  test("a lost push of this clone's document is not reused: the caller runs its own round", async (t) => {
    const { first, second } = await queuedBehind({ own: { ok: false, reason: "lost-race" } }, t);
    assert.equal(first.error, "lost-race");
    assert.equal(second.shared, undefined);
    assert.equal(second.fetched, true);
    assert.equal(second.error, undefined);
  });

  test("a caller that arrives after a failed round has finished runs its own round, and succeeds once the remote is back", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const a = await ctxFor(alice, "alice-a");
    await touch(a, "alice-a");
    assert.equal((await sync(a, { force: true })).fetched, true);
    const real = a.transport;
    a.transport = { ...real, fetchAll: async () => ({ ok: false, reason: "offline" }) };
    const failed = await sync(a, { force: true });
    assert.equal(failed.error, "offline");

    // The remote is back. A caller that reads the record now finds that round finished: an old verdict must not stick.
    const b = await ctxFor(alice, "alice-b");
    await touch(b, "alice-b", "after the outage");
    const later = await sync(b, { force: true });
    assert.equal(later.shared, undefined);
    assert.equal(later.fetched, true);
    assert.equal(later.error, undefined);
    const onRemote = (await remoteActorDoc(h, alice)).sessions.find((session) => session.id === "alice-b");
    assert.equal(onRemote?.intent, "after the outage");
  });

  test("a record that cannot be read shares nothing", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const first = await alice.huddle(["sync", "--force"], { session: "alice-0" });
    assert.equal(first.code, 0, first.stderr);
    const paths = await alice.paths();
    writeFileSync(join(paths.stateDir, "sync-round"), "{ not json");
    const trace = join(h.root, "trace.txt");
    const release = await holdSync(alice);
    const runs = [1, 2].map((n) => alice.huddle(["sync", "--force"], { session: `alice-${n}`, env: { GIT_TRACE: trace } }));
    try {
      await until("both wait for sync.lock", () => waiting(paths.stateDir) >= 2);
    } finally {
      await release();
    }
    const results = await Promise.all(runs);
    for (const result of results) assert.equal(result.code, 0, describeRuns(results));
    assert.equal(lsRemotes(trace), 2, "each ran its own round");
  });

  test("forced syncs queued against a remote that never answers all report offline within one network timeout, none busy", async (t) => {
    const h = await createHarness(t);
    const alice = await h.clone("alice");
    const first = await alice.huddle(["sync", "--force"], { session: "alice-0" });
    assert.equal(first.code, 0, first.stderr);
    // The remote now never answers: ssh that hangs (a Node script, so this runs on every platform).
    const fakeSsh = join(h.root, "ssh-hang.mjs");
    writeFileSync(fakeSsh, "setTimeout(() => {}, 120000);\n");
    const word = (path: string) => `'${path.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
    await alice.git("remote", "set-url", "origin", "ssh://git@huddle.invalid/team/repo.git");
    await alice.git("config", "core.sshCommand", `${word(process.execPath)} ${word(fakeSsh)}`);
    const timeoutMs = 3000;
    const env = { HUDDLE_TIMEOUT_MS: String(timeoutMs) };

    // One alone, for the time a single command takes against this remote here.
    const t0 = performance.now();
    const alone = await alice.huddle(["sync", "--force"], { session: "alice-alone", env });
    const single = performance.now() - t0;
    assert.equal(alone.code, 1);
    assert.match(alone.stderr, /could not reach remote/);

    // Five at once, not held: some ask before the round begins, some while it runs.
    const runs = await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const started = performance.now();
        const result = await alice.huddle(["sync", "--force"], { session: `alice-${n}`, env });
        return { result, ms: performance.now() - started };
      }),
    );
    const report = runs.map(({ result, ms }, i) => `${i}: ${Math.round(ms)} ms, exit ${result.code} ${result.stderr.trim()}`).join("\n");
    for (const { result, ms } of runs) {
      assert.equal(result.code, 1, report);
      assert.match(result.stderr, /could not reach remote/, report);
      assert.doesNotMatch(result.stderr, /another sync is still running/, report);
      assert.ok(ms < single + 1000, `each within one network timeout plus one second (one alone took ${Math.round(single)} ms):\n${report}`);
    }
  });
});
