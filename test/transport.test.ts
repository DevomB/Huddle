// T1.2 exit test (plan.md §5) and the cases around it.
//
// Every transport call in this file goes through `watched`, which snapshots the
// clone before and after and fails if a local ref, HEAD, FETCH_HEAD, the index
// or the working tree changed. That is the "after every call" clause of the
// exit test, applied to every call rather than to a sample.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { LIMITS, serializeDoc } from "../src/core/docs.ts";
import { NETWORK_TIMEOUT_MS } from "../src/core/git.ts";
import {
  DOC_FILE,
  classifyFailure,
  createTransport,
  parseLsRemote,
  parsePushStatus,
  saysRefMoved,
  standInRemote,
  tracksRef,
} from "../src/core/transport.ts";
import { actorRef, decisionsRef, taskRef } from "../src/core/types.ts";
import type { ActorDoc, DecisionDoc, Doc, Ref, Sha, TaskDoc, Transport } from "../src/core/types.ts";
import { createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const posixOnly = process.platform === "win32" ? "uses sh scripts as fake ssh, hooks and upload-pack" : false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AT = "2026-11-12T12:00:00.000Z";

function actorDoc(actor: string, n = 0): ActorDoc {
  return {
    v: 0,
    kind: "actor",
    actor,
    user: `user-${actor}`,
    host: "laptop",
    updatedAt: AT,
    sessions: [
      {
        id: `session-${n}`,
        agent: "manual",
        branch: "main",
        intent: `intent number ${n}`,
        intentSource: "manual",
        files: [`src/file-${n}.ts`],
        claims: ["docs/**"],
        startedAt: AT,
        seenAt: AT,
      },
    ],
  };
}

function decisionsDoc(actor: string): DecisionDoc {
  return {
    v: 0,
    kind: "decisions",
    actor,
    user: `user-${actor}`,
    decisions: [{ id: "dddddddd", at: AT, agent: "manual", text: "API errors use problem+json." }],
  };
}

/** A task claimed by contender `n`. Distinct `n` gives a distinct document, hence a distinct commit. */
function taskDoc(id: string, n: number): TaskDoc {
  const owner = { actor: "aaaaaaaa", user: `contender-${n}`, session: `session-${n}`, agent: "manual" };
  return { v: 0, kind: "task", id, title: "Write the transport", status: "claimed", owner, createdBy: owner, createdAt: AT, updatedAt: AT };
}

/** Plain git for test setup and inspection. Throws on failure, unless `lenient`, where a failure is "". */
function sh(cwd: string, args: string[], input?: string, lenient = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    }).replace(/\n$/, "");
  } catch (error) {
    if (lenient) return "";
    throw error;
  }
}

function digestTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      if (rel === "" && name === ".git") continue;
      const full = join(at, name);
      const path = rel === "" ? name : `${rel}/${name}`;
      if (statSync(full).isDirectory()) walk(full, path);
      else hash.update(`${path}\0`).update(readFileSync(full)).update("\0");
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

/** Everything the hard rules say a transport call must leave alone, for the worktree at `dir`. */
function localState(dir: string): Record<string, string | null> {
  const gitDir = sh(dir, ["rev-parse", "--absolute-git-dir"]);
  const file = (name: string): string | null =>
    existsSync(join(gitDir, name)) ? createHash("sha256").update(readFileSync(join(gitDir, name))).digest("hex") : null;
  return {
    refs: sh(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    head: `${readFileSync(join(gitDir, "HEAD"), "utf8").trim()} ${sh(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], undefined, true)}`,
    fetchHead: file("FETCH_HEAD"),
    index: file("index"),
    status: sh(dir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    files: digestTree(dir),
  };
}

/** Runs one transport call and fails if it changed anything local in `dir`. */
async function watched<T>(dir: string, call: () => Promise<T>): Promise<T> {
  const beforeCall = localState(dir);
  const result = await call();
  assert.deepEqual(localState(dir), beforeCall, "a transport call changed local refs, HEAD, FETCH_HEAD, the index or the working tree");
  return result;
}

/** A transport for a clone whose every call is watched. */
function transportFor(dir: string, opts: { remote?: string; timeoutMs?: number } = {}): Transport {
  const inner = createTransport({ cwd: dir, remote: opts.remote ?? "origin", timeoutMs: opts.timeoutMs });
  return {
    publish: (ref, doc, expect) => watched(dir, () => inner.publish(ref, doc, expect)),
    fetchAll: (known) => watched(dir, () => inner.fetchAll(known)),
    remove: (ref, expect) => watched(dir, () => inner.remove(ref, expect)),
  };
}

/** What a ref points at on the remote, read straight from the bare repository. */
function remoteRef(h: Harness, ref: Ref): Sha | null {
  try {
    return sh(h.remote, ["rev-parse", "--verify", "--quiet", ref]);
  } catch {
    return null;
  }
}

function remoteRefs(h: Harness): string {
  return sh(h.remote, ["for-each-ref", "--format=%(refname) %(objectname)"]);
}

/** Puts raw bytes on the remote as <ref> -> commit -> tree { <name>: blob }, bypassing the transport. */
function plantDoc(h: Harness, from: Clone, ref: Ref, content: string | Buffer, name = DOC_FILE): Sha {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: from.dir, input: content, encoding: "utf8", maxBuffer: 1024 }).trim();
  const tree = sh(from.dir, ["mktree"], `100644 blob ${blob}\t${name}\n`);
  const commit = sh(from.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "-m", "planted", tree]);
  sh(from.dir, ["push", "--quiet", "--no-verify", "origin", `+${commit}:${ref}`]);
  return commit;
}

function okSha(result: Awaited<ReturnType<Transport["publish"]>>): Sha {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return (result as { ok: true; sha: Sha }).sha;
}

async function fetched(t: Transport, known = new Map<Ref, Sha>()) {
  const result = await t.fetchAll(known);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<typeof result, { ok: true }>;
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exit test
// ---------------------------------------------------------------------------

describe("transport exit test", () => {
  let h: Harness;
  let alice: Clone;
  let bob: Clone;
  let carol: Clone;
  let dave: Clone;

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    bob = await h.clone("bob");
    carol = await h.clone("carol");
    dave = await h.clone("dave");
  });
  after(() => h.cleanup());

  test("a doc round-trips between two clones", async () => {
    const a = transportFor(alice.dir);
    const b = transportFor(bob.dir);
    const docs: [Ref, Doc][] = [
      [actorRef("aaaaaaaa"), actorDoc("aaaaaaaa")],
      [decisionsRef("aaaaaaaa"), decisionsDoc("aaaaaaaa")],
      [taskRef("tttttttt"), taskDoc("tttttttt", 1)],
    ];
    const shas = new Map<Ref, Sha>();
    for (const [ref, doc] of docs) {
      const sha = okSha(await a.publish(ref, doc, ref === taskRef("tttttttt") ? "absent" : "own"));
      assert.equal(remoteRef(h, ref), sha, "publish reports the commit the remote ref now points at");
      shas.set(ref, sha);
    }

    // Bob has never seen any of it.
    const first = await fetched(b);
    assert.deepEqual([...first.changed.keys()].sort(), docs.map(([ref]) => ref).sort());
    for (const [ref, doc] of docs) {
      assert.deepEqual(first.changed.get(ref), { sha: shas.get(ref), doc });
    }
    assert.deepEqual(first.removed, []);

    // Nothing moved: nothing reported.
    const known = new Map([...first.changed].map(([ref, entry]) => [ref, entry.sha] as const));
    const second = await fetched(b, known);
    assert.equal(second.changed.size, 0);
    assert.deepEqual(second.removed, []);

    // Alice updates one document; Bob sees exactly that one.
    const updated = actorDoc("aaaaaaaa", 7);
    const newSha = okSha(await a.publish(actorRef("aaaaaaaa"), updated, "own"));
    assert.notEqual(newSha, shas.get(actorRef("aaaaaaaa")));
    const third = await fetched(b, known);
    assert.deepEqual([...third.changed], [[actorRef("aaaaaaaa"), { sha: newSha, doc: updated }]]);
    known.set(actorRef("aaaaaaaa"), newSha);

    // The same document again is the same commit, and a no-op push.
    assert.equal(okSha(await a.publish(actorRef("aaaaaaaa"), updated, "own")), newSha);

    // Alice removes it; Bob is told it is gone. A stale expectation removes nothing.
    assert.deepEqual(await a.remove(actorRef("aaaaaaaa"), shas.get(actorRef("aaaaaaaa"))!), { ok: false, reason: "lost-race" });
    assert.equal(remoteRef(h, actorRef("aaaaaaaa")), newSha);
    assert.deepEqual(await a.remove(actorRef("aaaaaaaa"), newSha), { ok: true, sha: newSha });
    assert.equal(remoteRef(h, actorRef("aaaaaaaa")), null);
    const fourth = await fetched(b, known);
    assert.equal(fourth.changed.size, 0);
    assert.deepEqual(fourth.removed, [actorRef("aaaaaaaa")]);
    assert.deepEqual(await a.remove(actorRef("aaaaaaaa"), newSha), { ok: false, reason: "lost-race" }, "removing a ref that is already gone");
  });

  test("20 `absent` races each have exactly one winner", async () => {
    const clones = [alice, bob, carol, dave];
    const transports = clones.map((clone) => transportFor(clone.dir));
    const reader = transportFor(alice.dir);
    for (let race = 0; race < 20; race++) {
      const id = `absent${String.fromCharCode(97 + race)}`; // absenta .. absentt
      const ref = taskRef(id);
      const results = await Promise.all(transports.map((t, n) => t.publish(ref, taskDoc(id, n), "absent")));
      const winners = results.flatMap((result, n) => (result.ok ? [n] : []));
      assert.equal(winners.length, 1, `race ${race}: ${JSON.stringify(results)}`);
      for (const result of results) {
        if (!result.ok) assert.equal(result.reason, "lost-race", `race ${race}: ${JSON.stringify(results)}`);
      }
      // The remote holds the winner's document, not a loser's.
      const winner = winners[0]!;
      assert.equal(remoteRef(h, ref), okSha(results[winner]!));
      assert.deepEqual((await fetched(reader)).changed.get(ref)?.doc, taskDoc(id, winner));
    }
  });

  test("one `absent` race with 20 contenders has exactly one winner", async () => {
    const clones = [alice, bob, carol, dave];
    const ref = taskRef("absentbig");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) => transportFor(clones[n % 4]!.dir).publish(ref, taskDoc("absentbig", n), "absent")),
    );
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => !result.ok && result.reason === "lost-race").length, 19, JSON.stringify(results));
    const winner = results.findIndex((result) => result.ok);
    assert.deepEqual((await fetched(transportFor(bob.dir))).changed.get(ref)?.doc, taskDoc("absentbig", winner));
  });

  test("20 `Sha` races each have exactly one winner", async () => {
    const clones = [alice, bob, carol, dave];
    const transports = clones.map((clone) => transportFor(clone.dir));
    const reader = transportFor(bob.dir);
    const ref = taskRef("sharace");
    // Each race replaces the previous race's winner, so every round is a real compare-and-swap on a moving ref.
    let current = okSha(await transports[0]!.publish(ref, taskDoc("sharace", 999), "absent"));
    for (let race = 0; race < 20; race++) {
      const results = await Promise.all(transports.map((t, n) => t.publish(ref, taskDoc("sharace", race * 10 + n), current)));
      const winners = results.flatMap((result, n) => (result.ok ? [n] : []));
      assert.equal(winners.length, 1, `race ${race}: ${JSON.stringify(results)}`);
      for (const result of results) {
        if (!result.ok) assert.equal(result.reason, "lost-race", `race ${race}: ${JSON.stringify(results)}`);
      }
      const winner = winners[0]!;
      current = okSha(results[winner]!);
      assert.equal(remoteRef(h, ref), current);
      assert.deepEqual((await fetched(reader)).changed.get(ref)?.doc, taskDoc("sharace", race * 10 + winner));
    }
  });

  test("one `Sha` race with 20 contenders has exactly one winner", async () => {
    const clones = [alice, bob, carol, dave];
    const ref = taskRef("shabig");
    const start = okSha(await transportFor(alice.dir).publish(ref, taskDoc("shabig", 999), "absent"));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) => transportFor(clones[n % 4]!.dir).publish(ref, taskDoc("shabig", n), start)),
    );
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => !result.ok && result.reason === "lost-race").length, 19, JSON.stringify(results));
    const winner = results.findIndex((result) => result.ok);
    assert.equal(remoteRef(h, ref), okSha(results[winner]!));
    assert.deepEqual((await fetched(transportFor(carol.dir))).changed.get(ref)?.doc, taskDoc("shabig", winner));
  });

  test("an expectation that does not hold loses without touching the ref", async () => {
    const a = transportFor(alice.dir);
    const ref = taskRef("expect");
    const first = okSha(await a.publish(ref, taskDoc("expect", 1), "absent"));
    assert.deepEqual(await a.publish(ref, taskDoc("expect", 2), "absent"), { ok: false, reason: "lost-race" });
    const second = okSha(await a.publish(ref, taskDoc("expect", 3), first));
    assert.deepEqual(await a.publish(ref, taskDoc("expect", 4), first), { ok: false, reason: "lost-race" }, "stale sha");
    assert.deepEqual(await a.publish(taskRef("expectnone"), taskDoc("expectnone", 5), first), { ok: false, reason: "lost-race" }, "sha expected, ref absent");
    assert.equal(remoteRef(h, ref), second);
    assert.equal(remoteRef(h, taskRef("expectnone")), null);
  });

  test("an unreachable remote returns offline within the timeout", { skip: posixOnly }, async () => {
    assert.equal(NETWORK_TIMEOUT_MS, 10_000, "plan.md §3: every network call has a 10 s timeout");
    const eve = await h.clone("eve");
    const sha = okSha(await transportFor(eve.dir).publish(actorRef("eeeeeeee"), actorDoc("eeeeeeee"), "own"));

    // 1. Fails fast: the remote is not there at all.
    sh(eve.dir, ["remote", "add", "gone", join(h.root, "no-such-remote.git")]);
    const gone = transportFor(eve.dir, { remote: "gone" });
    assert.deepEqual(await gone.publish(actorRef("eeeeeeee"), actorDoc("eeeeeeee", 1), "own"), { ok: false, reason: "offline" });
    assert.deepEqual(await gone.publish(taskRef("offline"), taskDoc("offline", 1), "absent"), { ok: false, reason: "offline" });
    assert.deepEqual(await gone.fetchAll(new Map()), { ok: false, reason: "offline" });
    assert.deepEqual(await gone.remove(actorRef("eeeeeeee"), sha), { ok: false, reason: "offline" });

    // 2. Hangs: ssh never answers. The call must come back at the timeout and take the ssh process with it.
    // A fresh clone, configured before its first network call: git.ts reads core.sshCommand once per process and directory.
    const ivan = await h.clone("ivan");
    const pidFile = join(h.root, "fake-ssh.pid");
    const fakeSsh = script(join(h.root, "fake-ssh-hang.sh"), `echo $$ >> "${pidFile}"\nexec sleep 60`);
    sh(ivan.dir, ["remote", "add", "hang", "ssh://git@huddle.invalid/team/repo.git"]);
    sh(ivan.dir, ["config", "core.sshCommand", fakeSsh]);
    const timeoutMs = 1200;
    const hang = transportFor(ivan.dir, { remote: "hang", timeoutMs });
    const calls: [string, () => Promise<unknown>][] = [
      ["publish own", () => hang.publish(actorRef("eeeeeeee"), actorDoc("eeeeeeee", 2), "own")],
      ["publish absent", () => hang.publish(taskRef("offline"), taskDoc("offline", 2), "absent")],
      ["publish sha", () => hang.publish(actorRef("eeeeeeee"), actorDoc("eeeeeeee", 3), sha)],
      ["fetchAll", () => hang.fetchAll(new Map())],
      ["remove", () => hang.remove(actorRef("eeeeeeee"), sha)],
    ];
    for (const [name, call] of calls) {
      const started = Date.now();
      assert.deepEqual(await call(), { ok: false, reason: "offline" }, name);
      const took = Date.now() - started;
      assert.ok(took >= timeoutMs - 50, `${name} returned after ${took} ms, before the ${timeoutMs} ms timeout: the fake ssh did not hang`);
      assert.ok(took < timeoutMs + 2500, `${name} took ${took} ms with a ${timeoutMs} ms timeout`);
    }
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, calls.length, "each call reached the fake ssh exactly once");
    // Killed processes are gone once reaped, which a loaded machine does not do instantly. The fake ssh would live 60 s.
    for (let waited = 0; pids.some(alive) && waited < 10_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(pids.filter(alive), [], "a timed-out call left its ssh process running");

    // 3. With no timeoutMs the default applies, and HUDDLE_TIMEOUT_MS is how tests shorten it.
    const saved = process.env.HUDDLE_TIMEOUT_MS;
    process.env.HUDDLE_TIMEOUT_MS = "700";
    try {
      const started = Date.now();
      assert.deepEqual(await transportFor(ivan.dir, { remote: "hang" }).fetchAll(new Map()), { ok: false, reason: "offline" });
      const took = Date.now() - started;
      assert.ok(took >= 650 && took < 3200, `default-timeout call took ${took} ms with HUDDLE_TIMEOUT_MS=700`);
    } finally {
      if (saved === undefined) delete process.env.HUDDLE_TIMEOUT_MS;
      else process.env.HUDDLE_TIMEOUT_MS = saved;
    }

    // Nothing above reached the real remote.
    assert.equal(remoteRef(h, actorRef("eeeeeeee")), sha);
    assert.equal(remoteRef(h, taskRef("offline")), null);
  });

  test("no call changes local refs, FETCH_HEAD, the index or the working tree, even in a lived-in clone", async () => {
    const frank = await h.clone("frank");
    // A clone as a user leaves it: FETCH_HEAD from a real fetch, staged and unstaged edits, an untracked file, a linked worktree.
    sh(frank.dir, ["fetch", "--quiet", "origin"]);
    assert.ok(existsSync(join(sh(frank.dir, ["rev-parse", "--absolute-git-dir"]), "FETCH_HEAD")), "setup: FETCH_HEAD should exist");
    writeFileSync(join(frank.dir, "staged.txt"), "staged\n");
    sh(frank.dir, ["add", "staged.txt"]);
    writeFileSync(join(frank.dir, "staged.txt"), "staged, then edited\n");
    writeFileSync(join(frank.dir, "untracked.txt"), "untracked\n");
    const linked = join(h.root, "frank-linked");
    sh(frank.dir, ["worktree", "add", "--quiet", "-b", "side", linked]);
    writeFileSync(join(linked, "side.txt"), "dirty in the linked worktree\n");

    // The check itself must be able to fail, or it proves nothing.
    const probe = localState(frank.dir);
    sh(alice.dir, ["commit", "--quiet", "--allow-empty", "-m", "moves main"]);
    sh(alice.dir, ["push", "--quiet", "origin", "HEAD:main"]);
    sh(frank.dir, ["fetch", "--quiet", "origin"]);
    assert.notDeepEqual(localState(frank.dir), probe, "setup: a real fetch should change the snapshot");

    // Newer git re-creates refs/remotes/origin/HEAD on fetch when it is missing. Ours must not.
    sh(frank.dir, ["remote", "set-head", "origin", "--delete"]);

    // Hostile fetch configuration: a mirror-style refspec, pruning and tag following would all write local refs.
    sh(alice.dir, ["tag", "v1"]);
    sh(alice.dir, ["push", "--quiet", "origin", "v1"]);
    sh(frank.dir, ["config", "remote.origin.fetch", "+refs/*:refs/remotes/origin/*"]);
    sh(frank.dir, ["config", "fetch.prune", "true"]);
    sh(frank.dir, ["config", "fetch.pruneTags", "true"]);
    sh(frank.dir, ["config", "remote.origin.tagOpt", "--tags"]);

    okSha(await transportFor(alice.dir).publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa", 20), "own"));
    for (const dir of [frank.dir, linked]) {
      const t = createTransport({ cwd: dir, remote: "origin" });
      // Both worktrees are checked around every call: refs are shared, FETCH_HEAD and the index are per worktree.
      const both = async <T>(call: () => Promise<T>): Promise<T> => watched(frank.dir, () => watched(linked, call));
      const id = dir === linked ? "livedlinked" : "livedmain";
      const got = await both(() => t.fetchAll(new Map()));
      assert.ok(got.ok && got.changed.has(actorRef("aaaaaaaa")), JSON.stringify(got));
      const own = okSha(await both(() => t.publish(actorRef("ffffffff"), actorDoc("ffffffff", 1), "own")));
      const created = okSha(await both(() => t.publish(taskRef(id), taskDoc(id, 1), "absent")));
      assert.deepEqual(await both(() => t.publish(taskRef(id), taskDoc(id, 2), "absent")), { ok: false, reason: "lost-race" });
      const replaced = okSha(await both(() => t.publish(taskRef(id), taskDoc(id, 3), created)));
      assert.deepEqual(await both(() => t.remove(taskRef(id), created)), { ok: false, reason: "lost-race" });
      assert.deepEqual(await both(() => t.remove(taskRef(id), replaced)), { ok: true, sha: replaced });
      assert.deepEqual(await both(() => t.remove(actorRef("ffffffff"), own)), { ok: true, sha: own });
    }
    assert.doesNotMatch(sh(frank.dir, ["for-each-ref", "--format=%(refname)"]), /huddle|refs\/tags\/v1|origin\/HEAD/, "no huddle ref, tag or origin/HEAD was created locally");
  });

  test("a clone that already tracks refs/huddle/* keeps its tracking refs exactly as they were", async () => {
    // With a mirror-style refspec the user's own `git fetch` creates refs/remotes/origin/huddle/...
    // A push by name would then update or delete those refs behind the user's back.
    const mia = await h.clone("mia");
    okSha(await transportFor(alice.dir).publish(actorRef("mirrored"), actorDoc("mirrored", 1), "own"));
    sh(mia.dir, ["config", "remote.origin.fetch", "+refs/*:refs/remotes/origin/*"]);
    sh(mia.dir, ["fetch", "--quiet", "origin"]);
    const tracking = "refs/remotes/origin/huddle/actors/mirrored";
    const before = sh(mia.dir, ["rev-parse", tracking]);
    const m = transportFor(mia.dir);
    const updated = okSha(await m.publish(actorRef("mirrored"), actorDoc("mirrored", 2), "own"));
    assert.equal(remoteRef(h, actorRef("mirrored")), updated);
    assert.deepEqual(await m.remove(actorRef("mirrored"), updated), { ok: true, sha: updated });
    assert.equal(remoteRef(h, actorRef("mirrored")), null);
    assert.equal(sh(mia.dir, ["rev-parse", tracking]), before, "the tracking ref still points where the user's fetch left it");
  });

  test("a push around the tracking refs still uses the remote's own settings", { skip: posixOnly }, async () => {
    const nora = await h.clone("nora");
    const counter = join(h.root, "receive-pack-count");
    const wrapper = script(join(h.root, "receive-pack.sh"), `echo run >> "${counter}"\nexec git receive-pack "$@"`);
    sh(nora.dir, ["config", "remote.origin.receivepack", wrapper]);
    const runs = (): number => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0);

    // By name: the default refspec does not cover refs/huddle/*.
    const n = transportFor(nora.dir);
    const first = okSha(await n.publish(taskRef("byname"), taskDoc("byname", 1), "absent"));
    assert.equal(runs(), 1, "setup: the remote's receivepack setting should be in use");

    // Through the stand-in remote. A new transport, because the refspecs are read once per transport.
    sh(nora.dir, ["config", "--add", "remote.origin.fetch", "+refs/huddle/*:refs/remotes/origin/huddle/*"]);
    const byUrl = transportFor(nora.dir);
    const second = okSha(await byUrl.publish(taskRef("byname"), taskDoc("byname", 2), first));
    assert.equal(runs(), 2, "the stand-in push went through the configured receive-pack too");
    assert.deepEqual(await byUrl.publish(taskRef("byname"), taskDoc("byname", 3), first), { ok: false, reason: "lost-race" });
    assert.deepEqual(await byUrl.remove(taskRef("byname"), second), { ok: true, sha: second });
    assert.equal(sh(nora.dir, ["for-each-ref", "refs/remotes/origin/huddle"]), "");
    assert.doesNotMatch(sh(nora.dir, ["config", "--list"]), /huddle-push/, "the stand-in remote is never written to the config");

    // A remote whose refspecs call for the stand-in, but which has no URL: refused locally, nothing sent.
    sh(nora.dir, ["remote", "add", "nourl", h.remote]);
    sh(nora.dir, ["config", "remote.nourl.fetch", "+refs/*:refs/remotes/nourl/*"]);
    sh(nora.dir, ["config", "--unset", "remote.nourl.url"]);
    assert.deepEqual(await transportFor(nora.dir, { remote: "nourl" }).publish(taskRef("nourl"), taskDoc("nourl", 1), "absent"), { ok: false, reason: "offline" });
    assert.equal(remoteRef(h, taskRef("nourl")), null);
  });
});

// ---------------------------------------------------------------------------
// Beyond the exit test
// ---------------------------------------------------------------------------

describe("transport against awkward remotes and clones", () => {
  let h: Harness;
  let alice: Clone;
  let bob: Clone;

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    bob = await h.clone("bob");
  });
  after(() => h.cleanup());

  test("invalid documents come back as doc: null and do not disturb valid ones", async () => {
    const good = okSha(await transportFor(alice.dir).publish(actorRef("goodgood"), actorDoc("goodgood"), "own"));
    const valid = serializeDoc(actorDoc("otherone"));
    const planted: [Ref, Sha][] = [
      [actorRef("notjson2"), plantDoc(h, alice, actorRef("notjson2"), "this is not json")],
      [actorRef("version2"), plantDoc(h, alice, actorRef("version2"), JSON.stringify({ ...actorDoc("version2"), v: 1 }))],
      [actorRef("wrongref"), plantDoc(h, alice, actorRef("wrongref"), valid)], // a valid doc for a different actor
      [taskRef("wrongkind"), plantDoc(h, alice, taskRef("wrongkind"), serializeDoc(actorDoc("wrongkind")))],
      [actorRef("nodocjson"), plantDoc(h, alice, actorRef("nodocjson"), serializeDoc(actorDoc("nodocjson")), "other.json")],
      [actorRef("toolarge"), plantDoc(h, alice, actorRef("toolarge"), JSON.stringify({ ...actorDoc("toolarge"), pad: "x".repeat(LIMITS.docBytes) }))],
      [actorRef("badutf22"), plantDoc(h, alice, actorRef("badutf22"), Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x0a, 0x7d]))],
      // Larger than git.ts lets any one call print. If the size were not checked before reading, the read
      // would be cut off, the ref would never be recorded, and every sync would fetch it again.
      [actorRef("hugehuge"), plantDoc(h, alice, actorRef("hugehuge"), Buffer.alloc(33 * 1024 * 1024, "x"))],
    ];
    // A ref that points straight at a blob, not at a commit.
    const blob = sh(alice.dir, ["hash-object", "-w", "--stdin"], valid);
    sh(alice.dir, ["push", "--quiet", "--no-verify", "origin", `+${blob}:${actorRef("justablob")}`]);
    planted.push([actorRef("justablob"), blob]);
    // Refs huddle does not define are not reported at all: not as changed, and never as removed.
    for (const name of ["refs/huddle/actors/UPPERCASE", "refs/huddle/actors/aaaa/bbbb", "refs/huddle/unknown/abcdabcd", "refs/huddle/actors/a.b"]) {
      sh(alice.dir, ["push", "--quiet", "--no-verify", "origin", `+${good}:${name}`]);
    }

    const result = await fetched(transportFor(bob.dir));
    const expected = new Map<Ref, unknown>(planted.map(([ref, sha]) => [ref, { sha, doc: null }]));
    expected.set(actorRef("goodgood"), { sha: good, doc: actorDoc("goodgood") });
    assert.deepEqual(new Map([...result.changed].sort()), new Map([...expected].sort()));
    assert.deepEqual(result.removed, []);

    // Reported once: with the shas cached, the bad refs are not fetched or reported again.
    const known = new Map([...result.changed].map(([ref, entry]) => [ref, entry.sha] as const));
    const again = await fetched(transportFor(bob.dir), known);
    assert.equal(again.changed.size, 0);
    assert.deepEqual(again.removed, []);
  });

  test("invalid input is refused before anything is sent", async () => {
    const a = transportFor(alice.dir);
    const refsBefore = remoteRefs(h);
    const main = remoteRef(h, "refs/heads/main")!;
    const denied = { ok: false, reason: "denied" };
    // Never outside refs/huddle/, whatever the caller passes.
    assert.deepEqual(await a.publish("refs/heads/main", actorDoc("aaaaaaaa"), "own"), denied);
    assert.deepEqual(await a.remove("refs/heads/main", main), denied);
    assert.deepEqual(await a.publish("refs/huddle/actors/--force", actorDoc("aaaaaaaa"), "own"), denied);
    assert.deepEqual(await a.publish(`${actorRef("aaaaaaaa")}\nrefs/heads/main`, actorDoc("aaaaaaaa"), "own"), denied);
    // Not a document.
    assert.deepEqual(await a.publish(actorRef("aaaaaaaa"), { v: 0, kind: "actor" } as unknown as Doc, "own"), denied);
    // Not an expectation.
    assert.deepEqual(await a.publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa"), "whatever"), denied);
    assert.deepEqual(await a.publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa"), "--force"), denied);
    assert.deepEqual(await a.remove(actorRef("aaaaaaaa"), "HEAD"), denied);
    assert.equal(remoteRefs(h), refsBefore, "the remote is untouched");

    // A remote "name" that git would read as an option, and a directory that is not a repository.
    const offline = { ok: false, reason: "offline" };
    const optionRemote = transportFor(alice.dir, { remote: "--upload-pack=touch /tmp/huddle-pwned" });
    assert.deepEqual(await optionRemote.fetchAll(new Map()), offline);
    assert.deepEqual(await optionRemote.publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa"), "own"), offline);
    const notARepo = join(h.root, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    const nowhere = createTransport({ cwd: notARepo, remote: "origin" });
    assert.deepEqual(await nowhere.publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa"), "own"), offline);
    assert.deepEqual(await nowhere.fetchAll(new Map()), offline);
    assert.deepEqual(await nowhere.remove(actorRef("aaaaaaaa"), main), offline);
    assert.equal(remoteRefs(h), refsBefore, "the remote is untouched");
  });

  test("the user's hooks, signing and identity settings do not get in the way", { skip: posixOnly }, async () => {
    const gina = await h.clone("gina");
    const marker = join(h.root, "pre-push-ran");
    const hooks = join(h.root, "gina-hooks");
    mkdirSync(hooks, { recursive: true });
    script(join(hooks, "pre-push"), `echo ran > "${marker}"\nexit 1`);
    sh(gina.dir, ["config", "core.hooksPath", hooks]);
    sh(gina.dir, ["config", "commit.gpgSign", "true"]);
    sh(gina.dir, ["config", "push.gpgSign", "true"]);
    sh(gina.dir, ["config", "gpg.program", join(h.root, "no-such-gpg")]);
    sh(gina.dir, ["config", "push.followTags", "true"]);
    sh(gina.dir, ["config", "push.useForceIfIncludes", "true"]);
    // No usable identity: an empty name and email override the harness's, and plain `git commit` refuses to run.
    sh(gina.dir, ["config", "user.useConfigOnly", "true"]);
    sh(gina.dir, ["config", "user.name", ""]);
    sh(gina.dir, ["config", "user.email", ""]);
    assert.throws(() => sh(gina.dir, ["-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "x"]), /empty ident|tell me who you are|no email/i, "setup: this clone should have no identity");

    const g = transportFor(gina.dir);
    const own = okSha(await g.publish(actorRef("gggggggg"), actorDoc("gggggggg"), "own"));
    const created = okSha(await g.publish(taskRef("ginatask"), taskDoc("ginatask", 1), "absent"));
    const replaced = okSha(await g.publish(taskRef("ginatask"), taskDoc("ginatask", 2), created));
    assert.deepEqual(await g.remove(taskRef("ginatask"), replaced), { ok: true, sha: replaced });
    assert.equal(existsSync(marker), false, "the user's pre-push hook ran for a huddle push");

    // The user's name and email are not in the commit that was published.
    const commit = sh(h.remote, ["cat-file", "commit", own]);
    assert.match(commit, /^author huddle <huddle@huddle\.invalid> /m);
    assert.doesNotMatch(commit, /^parent /m, "document commits are parentless");
    assert.equal(sh(h.remote, ["ls-tree", "--name-only", own]), DOC_FILE, "the tree holds exactly one file");
  });

  test("a remote that refuses huddle refs is reported as denied", { skip: posixOnly }, async () => {
    const strict = await createHarness();
    try {
      const zoe = await strict.clone("zoe");
      const z = transportFor(zoe.dir);
      const existing = okSha(await z.publish(taskRef("existing"), taskDoc("existing", 1), "absent"));
      script(
        join(strict.remote, "hooks", "pre-receive"),
        'while read old new ref; do case "$ref" in refs/huddle/*) echo "huddle refs are not allowed here" >&2; exit 1;; esac; done\nexit 0',
      );
      const denied = { ok: false, reason: "denied" };
      assert.deepEqual(await z.publish(actorRef("zzzzzzzz"), actorDoc("zzzzzzzz"), "own"), denied);
      assert.deepEqual(await z.publish(taskRef("newtask"), taskDoc("newtask", 1), "absent"), denied);
      assert.deepEqual(await z.publish(taskRef("existing"), taskDoc("existing", 2), existing), denied);
      assert.deepEqual(await z.remove(taskRef("existing"), existing), denied);
      assert.equal(remoteRef(strict, taskRef("existing")), existing);
      // Reading is still allowed, and still works.
      assert.deepEqual((await fetched(z)).changed.get(taskRef("existing")), { sha: existing, doc: taskDoc("existing", 1) });
    } finally {
      strict.cleanup();
    }
  });

  test("a rejection in unfamiliar words is a lost race when the ref moved", { skip: posixOnly }, async () => {
    // Other hosts word their rejections differently from git's own receive-pack.
    // This remote's update hook moves the ref and then declines the push, which
    // is what losing a race looks like when the wording gives nothing away.
    const odd = await createHarness();
    try {
      const yan = await odd.clone("yan");
      const y = transportFor(yan.dir);
      const rival = okSha(await y.publish(taskRef("parked"), taskDoc("parked", 42), "absent"));
      const start = okSha(await y.publish(taskRef("moving"), taskDoc("moving", 1), "absent"));
      script(
        join(odd.remote, "hooks", "update"),
        `case "$1" in refs/huddle/tasks/moving|refs/huddle/tasks/fresh)\n  unset GIT_QUARANTINE_PATH\n  git update-ref "$1" ${rival}\n  echo "ref is busy, try again later" >&2\n  exit 1;;\nesac\nexit 0`,
      );
      assert.deepEqual(await y.publish(taskRef("moving"), taskDoc("moving", 2), start), { ok: false, reason: "lost-race" });
      assert.equal(remoteRef(odd, taskRef("moving")), rival, "setup: the hook should have moved the ref");
      assert.deepEqual(await y.publish(taskRef("fresh"), taskDoc("fresh", 1), "absent"), { ok: false, reason: "lost-race" });
      assert.deepEqual(await y.remove(taskRef("moving"), rival), { ok: false, reason: "denied" }, "declined, and the ref is still where we expected it");
    } finally {
      odd.cleanup();
    }
  });

  test("an authentication failure is denied, not offline", { skip: posixOnly }, async () => {
    const hank = await h.clone("hank");
    const fakeSsh = script(join(h.root, "fake-ssh-denied.sh"), 'echo "git@huddle.invalid: Permission denied (publickey)." >&2\nexit 255');
    sh(hank.dir, ["remote", "add", "locked", "ssh://git@huddle.invalid/team/repo.git"]);
    sh(hank.dir, ["config", "core.sshCommand", fakeSsh]);
    const locked = transportFor(hank.dir, { remote: "locked" });
    const denied = { ok: false, reason: "denied" };
    assert.deepEqual(await locked.fetchAll(new Map()), denied);
    assert.deepEqual(await locked.publish(actorRef("hhhhhhhh"), actorDoc("hhhhhhhh"), "own"), denied);
    assert.deepEqual(await locked.publish(taskRef("locked"), taskDoc("locked", 1), "absent"), denied);
    assert.deepEqual(await locked.remove(actorRef("hhhhhhhh"), remoteRef(h, "refs/heads/main")!), denied);
  });

  test("works in a SHA-256 repository", async () => {
    const root = join(h.root, "sha256");
    mkdirSync(root, { recursive: true });
    const remote = join(root, "remote.git");
    sh(root, ["init", "--quiet", "--bare", "--object-format=sha256", "--initial-branch=main", remote]);
    const clones = ["one", "two"].map((name) => {
      const dir = join(root, name);
      sh(root, ["init", "--quiet", "--object-format=sha256", "--initial-branch=main", dir]);
      sh(dir, ["remote", "add", "origin", remote]);
      return dir;
    });
    const one = transportFor(clones[0]!);
    const two = transportFor(clones[1]!);
    const sha = okSha(await one.publish(taskRef("longsha"), taskDoc("longsha", 1), "absent"));
    assert.equal(sha.length, 64);
    assert.deepEqual((await fetched(two)).changed.get(taskRef("longsha")), { sha, doc: taskDoc("longsha", 1) });
    assert.deepEqual(await two.publish(taskRef("longsha"), taskDoc("longsha", 2), "absent"), { ok: false, reason: "lost-race" });
    const next = okSha(await two.publish(taskRef("longsha"), taskDoc("longsha", 2), sha));
    assert.deepEqual(await one.remove(taskRef("longsha"), sha), { ok: false, reason: "lost-race" });
    assert.deepEqual(await one.remove(taskRef("longsha"), next), { ok: true, sha: next });
  });
});

describe("fetchAll when the remote moves under it", { skip: posixOnly }, () => {
  let h: Harness;
  let alice: Clone;
  let reader: Clone;
  let counter: string;
  let steps: string;

  /** How many times the reader's git has started upload-pack on the remote: once per ls-remote, once per fetch. */
  const uploads = (): number => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0);

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    reader = await h.clone("reader");
    counter = join(h.root, "upload-pack-count");
    steps = join(h.root, "upload-pack-steps");
    mkdirSync(steps, { recursive: true });
    // A stand-in for upload-pack that counts its runs and, before run N, executes steps/N if it exists.
    // That is the only way to change the remote at an exact point between the listing and the fetch.
    const wrapper = script(
      join(h.root, "upload-pack.sh"),
      `n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))\necho $n > "${counter}"\n[ -x "${steps}/$n" ] && "${steps}/$n"\nexec git upload-pack "$@"`,
    );
    sh(reader.dir, ["config", "remote.origin.uploadpack", wrapper]);
  });
  after(() => h.cleanup());

  const reset = (): void => {
    writeFileSync(counter, "0\n");
    for (const name of readdirSync(steps)) writeFileSync(join(steps, name), "#!/bin/sh\nexit 0\n");
  };
  const onRemote = (args: string): string => `git --git-dir="${h.remote}" ${args}`;

  test("a ref replaced or deleted between the listing and the fetch", async () => {
    const a = transportFor(alice.dir);
    const stay = okSha(await a.publish(actorRef("staystay"), actorDoc("staystay"), "own"));
    okSha(await a.publish(actorRef("movemove"), actorDoc("movemove", 1), "own"));
    okSha(await a.publish(taskRef("vanish"), taskDoc("vanish", 1), "absent"));
    // The replacement for movemove is on the remote already, parked under another ref.
    const moved = okSha(await a.publish(actorRef("parkpark"), actorDoc("parkpark"), "own"));
    const replacement = plantDoc(h, alice, "refs/parking/movemove", serializeDoc(actorDoc("movemove", 2)));

    // Run 1 is the listing. Just before run 2, the fetch, one ref is replaced and one is deleted.
    reset();
    script(join(steps, "2"), `${onRemote(`update-ref ${actorRef("movemove")} ${replacement}`)}\n${onRemote(`update-ref -d ${taskRef("vanish")}`)}`);
    const known = new Map<Ref, Sha>([[taskRef("vanish"), "0".repeat(39) + "1"]]);
    const result = await fetched(transportFor(reader.dir), known);
    assert.deepEqual(
      new Map([...result.changed].sort()),
      new Map(
        [
          [actorRef("movemove"), { sha: replacement, doc: actorDoc("movemove", 2) }],
          [actorRef("parkpark"), { sha: moved, doc: actorDoc("parkpark") }],
          [actorRef("staystay"), { sha: stay, doc: actorDoc("staystay") }],
        ].sort() as [Ref, unknown][],
      ),
      "the replaced ref is reported at its new sha, with its new document",
    );
    assert.deepEqual(result.removed, [taskRef("vanish")]);
    assert.ok(uploads() >= 3, `expected a second listing after the remote moved, saw ${uploads()} upload-pack runs`);
  });

  test("a ref that keeps moving is left for the next sync instead of looping", async () => {
    const a = transportFor(alice.dir);
    const calm = okSha(await a.publish(actorRef("calmcalm"), actorDoc("calmcalm"), "own"));
    okSha(await a.publish(actorRef("busybusy"), actorDoc("busybusy", 0), "own"));
    const versions = [1, 2, 3, 4, 5, 6].map((n) => plantDoc(h, alice, `refs/parking/busy${n}`, serializeDoc(actorDoc("busybusy", n))));

    reset();
    // Before every single upload-pack run, the ref moves again: no listing is ever still true by the time of the fetch.
    versions.forEach((sha, index) => script(join(steps, String(index + 1)), onRemote(`update-ref ${actorRef("busybusy")} ${sha}`)));
    const result = await fetched(transportFor(reader.dir));
    assert.equal(uploads(), 4, "two rounds of listing and fetching, then stop");
    assert.deepEqual(result.changed.get(actorRef("calmcalm")), { sha: calm, doc: actorDoc("calmcalm") });
    const busy = result.changed.get(actorRef("busybusy"));
    // Either it is left out, or what is reported is what the remote really held at the last listing.
    if (busy !== undefined) assert.equal(busy.sha, versions[2]);
  });

  test("documents already in the object store are read without a fetch", async () => {
    const r = transportFor(reader.dir);
    const known = new Map([...(await fetched(r)).changed].map(([ref, entry]) => [ref, entry.sha] as const));

    // The reader publishes, so the new commit is in its own object store. Seeing
    // it listed must not cost a fetch: one upload-pack run is the listing, a second would be the fetch.
    const own = okSha(await r.publish(actorRef("readread"), actorDoc("readread"), "own"));
    reset();
    const result = await fetched(r, known);
    assert.deepEqual([...result.changed], [[actorRef("readread"), { sha: own, doc: actorDoc("readread") }]]);
    assert.equal(uploads(), 1, "our own document was read locally: one listing and no fetch");

    // Nothing changed at all: also one listing and no fetch.
    known.set(actorRef("readread"), own);
    reset();
    const again = await fetched(r, known);
    assert.equal(again.changed.size, 0);
    assert.equal(uploads(), 1);

    // Someone else's new document does need the fetch.
    const theirs = okSha(await transportFor(alice.dir).publish(actorRef("newsnews"), actorDoc("newsnews"), "own"));
    reset();
    assert.deepEqual([...(await fetched(r, known)).changed], [[actorRef("newsnews"), { sha: theirs, doc: actorDoc("newsnews") }]]);
    assert.equal(uploads(), 2, "one listing and one fetch");
  });
});

// ---------------------------------------------------------------------------
// Reading git's output
// ---------------------------------------------------------------------------

describe("transport output parsing", () => {
  const ref = "refs/huddle/tasks/abcdabcd";
  const sha = "b267ad7db8e347f98cf52955b93c89c4b626e383";

  test("parsePushStatus", () => {
    // Recorded from git 2.56 against a local bare remote.
    const line = (flag: string, from: string, summary: string): string => `To /tmp/remote.git\n${flag}\t${from}:${ref}\t${summary}\nDone\n`;
    assert.deepEqual(parsePushStatus(line("*", sha, "[new reference]"), ref), { flag: "*", summary: "[new reference]" });
    assert.deepEqual(parsePushStatus(line("+", sha, "11a31c3...68a6fde (forced update)"), ref), { flag: "+", summary: "11a31c3...68a6fde (forced update)" });
    assert.deepEqual(parsePushStatus(line("=", sha, "[up to date]"), ref), { flag: "=", summary: "[up to date]" });
    assert.deepEqual(parsePushStatus(line("!", sha, "[rejected] (stale info)"), ref), { flag: "!", summary: "[rejected] (stale info)" });
    assert.deepEqual(parsePushStatus(line("!", sha, "[remote rejected] (reference already exists)"), ref), { flag: "!", summary: "[remote rejected] (reference already exists)" });
    assert.deepEqual(parsePushStatus(line("-", "", "[deleted]"), ref), { flag: "-", summary: "[deleted]" });
    assert.deepEqual(parsePushStatus(line("!", "(delete)", "[rejected] (stale info)"), ref), { flag: "!", summary: "[rejected] (stale info)" });
    assert.deepEqual(parsePushStatus(line("*", sha, "[new reference]").replace(/\n/g, "\r\n"), ref), { flag: "*", summary: "[new reference]" });
    // Another ref's line, and output with no status line at all.
    assert.equal(parsePushStatus(line("*", sha, "[new reference]"), "refs/huddle/tasks/other222"), null);
    assert.equal(parsePushStatus("", ref), null);
    assert.equal(parsePushStatus("To /tmp/remote.git\nDone\n", ref), null);
  });

  test("saysRefMoved: rejection summaries that mean a lost race", () => {
    const sha = "b267ad7db8e347f98cf52955b93c89c4b626e383";
    const other = "e37457d9d599fad1d8dfc4c6e81accb00a9e4136";
    const moved = [
      // git 2.56, lease check on the client.
      "[rejected] (stale info)",
      // git 2.56 receive-pack on a local bare remote.
      "[remote rejected] (reference already exists)",
      "[remote rejected] (incorrect old value provided)",
      // GitHub over ssh, recorded 2026-11-12 from six simultaneous pushes to one ref.
      "[remote rejected] (cannot lock ref 'refs/huddle/tasks/liveraw': reference already exists)",
      `[remote rejected] (cannot lock ref 'refs/huddle/tasks/liveraw': is at ${sha} but expected ${other})`,
    ];
    for (const summary of moved) assert.equal(saysRefMoved(summary), true, summary);
    const notAVerdict = [
      "[remote rejected] (pre-receive hook declined)",
      "[remote rejected] (hook declined)",
      "[remote rejected] (push declined due to repository rule violations)",
      "[remote rejected] (failed to update ref)",
      "[remote rejected] (protected branch hook declined)",
      "[remote rejected] (deny updating a hidden ref)",
      "[rejected] (non-fast-forward)",
      "",
    ];
    for (const summary of notAVerdict) assert.equal(saysRefMoved(summary), false, summary);
  });

  test("parseLsRemote keeps well-formed huddle refs only", () => {
    const sha256 = "a".repeat(64);
    const out = [
      `${sha}\trefs/huddle/actors/abcdabcd`,
      `${sha256}\trefs/huddle/tasks/tttttttt`,
      `${sha}\trefs/huddle/decisions/abcdabcd\r`,
      `${sha}\trefs/heads/main`,
      `${sha}\trefs/huddle/actors/NOPE`,
      `${sha}\trefs/huddle/actors/abcd/efgh`,
      `${sha}\trefs/huddle/unknown/abcdabcd`,
      `not-a-sha\trefs/huddle/actors/bbbbbbbb`,
      `${sha.slice(1)}\trefs/huddle/actors/cccccccc`,
      "garbage without a tab",
      "",
    ].join("\n");
    assert.deepEqual(
      [...parseLsRemote(out)],
      [
        ["refs/huddle/actors/abcdabcd", sha],
        ["refs/huddle/tasks/tttttttt", sha256],
        ["refs/huddle/decisions/abcdabcd", sha],
      ],
    );
    assert.equal(parseLsRemote("").size, 0);
  });

  test("tracksRef: which fetch refspecs would make a push write a tracking ref", () => {
    const ref = "refs/huddle/actors/abcdabcd";
    assert.equal(tracksRef([], ref), false);
    assert.equal(tracksRef(["+refs/heads/*:refs/remotes/origin/*"], ref), false, "the default refspec");
    assert.equal(tracksRef(["+refs/heads/*:refs/remotes/origin/*", "+refs/pull/*/head:refs/remotes/origin/pr/*"], ref), false);
    assert.equal(tracksRef(["+refs/*:refs/remotes/origin/*"], ref), true, "mirror everything");
    assert.equal(tracksRef(["refs/*:refs/*"], ref), true);
    assert.equal(tracksRef(["+refs/huddle/*:refs/remotes/origin/huddle/*"], ref), true);
    assert.equal(tracksRef(["+refs/huddle/actors/*:refs/x/*"], ref), true);
    assert.equal(tracksRef(["+refs/huddle/tasks/*:refs/x/*"], ref), false);
    assert.equal(tracksRef(["+refs/*/abcdabcd:refs/x/*"], ref), true, "a star in the middle");
    assert.equal(tracksRef(["+refs/*/other:refs/x/*"], ref), false);
    assert.equal(tracksRef([`${ref}:refs/x/y`], ref), true, "an exact refspec");
    assert.equal(tracksRef([`+${ref}x:refs/x/y`], ref), false);
    assert.equal(tracksRef(["refs/huddle/*"], ref), false, "no destination, no tracking ref");
    assert.equal(tracksRef(["refs/huddle/*:"], ref), false);
    assert.equal(tracksRef(["^refs/huddle/*"], ref), false, "a negative refspec maps nothing");
    assert.equal(tracksRef(["  +refs/*:refs/remotes/origin/*  "], ref), true);
    assert.equal(tracksRef(["+refs/huddle/actors/abcdabcd*abcd:refs/x/*"], ref), false, "prefix and suffix may not overlap");
  });

  test("standInRemote: a refspec-less copy of a remote, for one command", () => {
    assert.equal(standInRemote([], "tmp"), null);
    assert.equal(standInRemote([["fetch", "+refs/*:refs/remotes/origin/*"]], "tmp"), null, "no URL");
    assert.equal(standInRemote([["url", ""]], "tmp"), null);
    assert.deepEqual(standInRemote([["url", "git@github.com:team/repo.git"]], "tmp"), ["-c", "remote.tmp.url=git@github.com:team/repo.git"]);
    assert.deepEqual(
      standInRemote(
        [
          ["url", "https://example.com/fetch.git"],
          ["fetch", "+refs/*:refs/remotes/origin/*"],
          ["pushurl", "https://example.com/push.git"],
          ["push", "refs/heads/*:refs/heads/*"],
          ["mirror", "true"],
          ["prune", "true"],
          ["tagopt", "--tags"],
          ["proxy", "http://proxy:3128"],
          ["proxyauthmethod", "basic"],
          ["receivepack", "/opt/git/bin/git-receive-pack"],
          ["uploadpack", "/opt/git/bin/git-upload-pack"],
          ["vcs", "custom"],
        ],
        "huddle-push-1",
      ),
      [
        "-c", "remote.huddle-push-1.url=https://example.com/fetch.git",
        "-c", "remote.huddle-push-1.pushurl=https://example.com/push.git",
        "-c", "remote.huddle-push-1.proxy=http://proxy:3128",
        "-c", "remote.huddle-push-1.proxyauthmethod=basic",
        "-c", "remote.huddle-push-1.receivepack=/opt/git/bin/git-receive-pack",
        "-c", "remote.huddle-push-1.vcs=custom",
      ],
      "connection settings are kept; refspecs, mirror and fetch-only settings are not",
    );
  });

  test("classifyFailure tells a refused connection from refused credentials", () => {
    const tail = "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    const offline = [
      `ssh: Could not resolve hostname github.com: Name or service not known\r\n${tail}`,
      `ssh: connect to host github.com port 22: Connection refused\r\n${tail}`,
      `ssh: connect to host github.com port 22: Connection timed out\r\n${tail}`,
      "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com\n",
      "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server\n",
      `fatal: '/tmp/no-such.git' does not appear to be a git repository\n${tail}`,
      "",
    ];
    for (const stderr of offline) assert.equal(classifyFailure({ timedOut: false, stderr }), "offline", stderr);
    const denied = [
      `git@github.com: Permission denied (publickey).\r\n${tail}`,
      `ERROR: Permission to team/repo.git denied to someone.\n${tail}`,
      `ERROR: Repository not found.\n${tail}`,
      "remote: Permission to team/repo.git denied to someone.\nfatal: unable to access 'https://github.com/team/repo.git/': The requested URL returned error: 403\n",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/team/repo.git/'\n",
      `Host key verification failed.\r\n${tail}`,
    ];
    for (const stderr of denied) assert.equal(classifyFailure({ timedOut: false, stderr }), "denied", stderr);
    // A timeout is offline whatever was printed before it.
    assert.equal(classifyFailure({ timedOut: true, stderr: denied[0]! }), "offline");
  });
});
