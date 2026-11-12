// T1.2 exit test (plan.md §5) and the cases around it.
//
// Every transport call in this file goes through `watched`, which snapshots the
// clone before and after and fails if a local ref, HEAD, FETCH_HEAD, the index,
// the working tree or the clone's own object store changed. That is the "after
// every call" clause of the exit test, applied to every call rather than to a
// sample.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { LIMITS, serializeDoc } from "../src/core/docs.ts";
import { NETWORK_TIMEOUT_MS } from "../src/core/git.ts";
import {
  DOC_FILE,
  OBJECT_MAX_AGE_MS,
  alternatesEntry,
  classifyFailure,
  createTransport,
  isMirror,
  parseLsRemote,
  parsePushStatus,
  parseRemoteSettings,
  pruneObjects,
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
    // The clone's own object store: loose objects, packs and their sizes. huddle's objects go elsewhere.
    objects: sh(dir, ["count-objects", "-v"]),
  };
}

/** Runs one transport call and fails if it changed anything local in `dir`. */
async function watched<T>(dir: string, call: () => Promise<T>): Promise<T> {
  const beforeCall = localState(dir);
  const result = await call();
  assert.deepEqual(localState(dir), beforeCall, "a transport call changed local refs, HEAD, FETCH_HEAD, the index, the working tree or the clone's object store");
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

/** huddle's own object directory for the clone that `dir` is a worktree of. */
function huddleObjects(dir: string): string {
  return join(resolve(dir, sh(dir, ["rev-parse", "--git-common-dir"])), "huddle", "objects");
}

/** Every file under `dir`, as sorted relative paths. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string, rel: string): void => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(at, entry.name), path);
      else found.push(path);
    }
  };
  walk(dir, "");
  return found.sort();
}

/** Whether the user's own git, run the way a user runs it, can see an object. Never fetches it on demand. */
function userSees(dir: string, sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", sha], { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
    return true;
  } catch {
    return false;
  }
}

/** Plain git that reads huddle's object directory, with the clone's own behind it. For inspection only. */
function huddleGit(dir: string, args: string[]): string {
  const own = join(resolve(dir, sh(dir, ["rev-parse", "--git-common-dir"])), "objects");
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OBJECT_DIRECTORY: huddleObjects(dir), GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesEntry(own) },
  }).replace(/\n$/, "");
}

/** The loose-object file of `oid`, relative to an object directory. */
function loose(oid: string): string {
  return `${oid.slice(0, 2)}/${oid.slice(2)}`;
}

/** Makes every file under `dir` look as if it was last written `ms` ago. */
function age(dir: string, ms: number, only?: string[]): void {
  const then = new Date(Date.now() - ms);
  for (const file of only ?? filesUnder(dir)) utimesSync(join(dir, file), then, then);
}

/** A path as one word for the sh that git runs core.sshCommand, receivepack and uploadpack with. Harness paths hold a space. */
function shq(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
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

  test("20 `absent` races each have exactly one winner", async (t) => {
    const clones = [alice, bob, carol, dave];
    const transports = clones.map((clone) => transportFor(clone.dir));
    const reader = transportFor(alice.dir);
    const tally = { races: 0, won: 0, lost: 0 };
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
      tally.races++;
      tally.won += winners.length;
      tally.lost += results.length - winners.length;
    }
    t.diagnostic(`${tally.races} races of 4 simultaneous creates: ${tally.won} winners, ${tally.lost} lost-race`);
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

  test("20 `Sha` races each have exactly one winner", async (t) => {
    const clones = [alice, bob, carol, dave];
    const transports = clones.map((clone) => transportFor(clone.dir));
    const reader = transportFor(bob.dir);
    const tally = { races: 0, won: 0, lost: 0 };
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
      tally.races++;
      tally.won += winners.length;
      tally.lost += results.length - winners.length;
    }
    t.diagnostic(`${tally.races} races of 4 simultaneous replaces: ${tally.won} winners, ${tally.lost} lost-race`);
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

  test("a remote that never answers: offline at the timeout, and the stand-in for ssh does not survive (Node, every platform)", async () => {
    const olga = await h.clone("olga");
    const pidFile = join(h.root, "node-ssh.pid");
    const fakeSsh = join(h.root, "node-ssh-hang.mjs");
    writeFileSync(
      fakeSsh,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");\nsetTimeout(() => {}, 60000);\n`,
    );
    // Git for Windows runs core.sshCommand with its own sh, which takes forward slashes; each path is one quoted word.
    const word = (path: string) => `'${path.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
    sh(olga.dir, ["remote", "add", "hang", "ssh://git@huddle.invalid/team/repo.git"]);
    sh(olga.dir, ["config", "core.sshCommand", `${word(process.execPath)} ${word(fakeSsh)}`]);
    const timeoutMs = 2500;
    const hang = transportFor(olga.dir, { remote: "hang", timeoutMs });
    for (const [name, call] of [
      ["publish own", () => hang.publish(actorRef("oooooooo"), actorDoc("oooooooo"), "own")],
      ["fetchAll", () => hang.fetchAll(new Map())],
    ] as const) {
      const started = Date.now();
      assert.deepEqual(await call(), { ok: false, reason: "offline" }, name);
      const took = Date.now() - started;
      assert.ok(took >= timeoutMs - 100 && took < timeoutMs + 8000, `${name} took ${took} ms`);
    }
    const pids = readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
    assert.equal(pids.length, 2, "ssh was started once per call");
    const deadline = Date.now() + 5000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(pids.filter(alive), [], "a stand-in for ssh outlived its call");
  });

  test("an unreachable remote returns offline within the timeout", { skip: posixOnly }, async (t) => {
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
    sh(ivan.dir, ["config", "core.sshCommand", shq(fakeSsh)]);
    const timeoutMs = 1200;
    const hang = transportFor(ivan.dir, { remote: "hang", timeoutMs });
    const calls: [string, () => Promise<unknown>][] = [
      ["publish own", () => hang.publish(actorRef("eeeeeeee"), actorDoc("eeeeeeee", 2), "own")],
      ["publish absent", () => hang.publish(taskRef("offline"), taskDoc("offline", 2), "absent")],
      ["publish sha", () => hang.publish(actorRef("eeeeeeee"), actorDoc("eeeeeeee", 3), sha)],
      ["fetchAll", () => hang.fetchAll(new Map())],
      ["remove", () => hang.remove(actorRef("eeeeeeee"), sha)],
    ];
    const timings: string[] = [];
    for (const [name, call] of calls) {
      const started = Date.now();
      assert.deepEqual(await call(), { ok: false, reason: "offline" }, name);
      const took = Date.now() - started;
      // The lower bound proves the remote really hung. The upper bound is loose on purpose: this machine may be busy.
      assert.ok(took >= timeoutMs - 50, `${name} returned after ${took} ms, before the ${timeoutMs} ms timeout: the fake ssh did not hang`);
      assert.ok(took < timeoutMs + 5000, `${name} took ${took} ms with a ${timeoutMs} ms timeout`);
      timings.push(`${name} ${took} ms`);
    }
    t.diagnostic(`hanging remote, ${timeoutMs} ms timeout, all offline: ${timings.join(", ")}`);
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
      assert.ok(took >= 650 && took < 5700, `default-timeout call took ${took} ms with HUDDLE_TIMEOUT_MS=700`);
      t.diagnostic(`hanging remote, HUDDLE_TIMEOUT_MS=700 and no timeoutMs: fetchAll offline after ${took} ms`);
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
    sh(nora.dir, ["config", "remote.origin.receivepack", shq(wrapper)]);
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
      sh(h.remote, ["update-ref", name, good]);
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
    // Refused before anything is sent, and the result says so (sent: false): a caller may report "nothing changed".
    const denied = { ok: false, reason: "denied", sent: false };
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
    assert.deepEqual(await optionRemote.publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa"), "own"), { ...offline, sent: false });
    const notARepo = join(h.root, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    const nowhere = createTransport({ cwd: notARepo, remote: "origin" });
    // The document commit cannot even be built there: nothing was sent.
    assert.deepEqual(await nowhere.publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa"), "own"), { ...offline, sent: false });
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
    sh(hank.dir, ["config", "core.sshCommand", shq(fakeSsh)]);
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

// ---------------------------------------------------------------------------
// Where the objects go
// ---------------------------------------------------------------------------

/** refs/huddle/* as the remote holds them now: what a clone that is fully up to date would pass as `known`. */
function remoteHuddleRefs(h: Harness): Map<Ref, Sha> {
  return parseLsRemote(sh(h.remote, ["for-each-ref", "--format=%(objectname)%09%(refname)", "refs/huddle"]));
}

describe("transport keeps its objects out of the clone's own object store", () => {
  let h: Harness;
  let alice: Clone;
  let bob: Clone;

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    bob = await h.clone("bob");
  });
  after(() => h.cleanup());

  test("publish, fetchAll and remove write only to huddle's object directory", async () => {
    const own = { alice: sh(alice.dir, ["count-objects", "-v"]), bob: sh(bob.dir, ["count-objects", "-v"]) };
    assert.deepEqual(filesUnder(huddleObjects(alice.dir)), [], "setup: nothing written yet");

    const a = transportFor(alice.dir);
    const b = transportFor(bob.dir);
    const actor = okSha(await a.publish(actorRef("aaaaaaaa"), actorDoc("aaaaaaaa"), "own"));
    // One document is three objects: the blob, the tree and the commit.
    assert.equal(filesUnder(huddleObjects(alice.dir)).length, 3);
    const first = okSha(await a.publish(taskRef("objectsa"), taskDoc("objectsa", 1), "absent"));
    const second = okSha(await a.publish(taskRef("objectsa"), taskDoc("objectsa", 2), first));
    assert.equal(filesUnder(huddleObjects(alice.dir)).length, 9);

    const got = await fetched(b);
    assert.deepEqual(got.changed.get(actorRef("aaaaaaaa")), { sha: actor, doc: actorDoc("aaaaaaaa") });
    assert.deepEqual(got.changed.get(taskRef("objectsa")), { sha: second, doc: taskDoc("objectsa", 2) });
    assert.deepEqual(await b.remove(taskRef("objectsa"), second), { ok: true, sha: second });

    for (const [name, clone] of [["alice", alice], ["bob", bob]] as const) {
      assert.equal(sh(clone.dir, ["count-objects", "-v"]), own[name], `${name}'s object store changed`);
      // The user's git does not know these commits exist, so it never counts them, packs them or warns about them.
      assert.equal(userSees(clone.dir, actor), false, `${name}'s git can see a huddle commit`);
      assert.equal(userSees(clone.dir, second), false, `${name}'s git can see a huddle commit`);
      assert.equal(huddleGit(clone.dir, ["cat-file", "-t", actor]), "commit", `${name}: the commit is in huddle's directory`);
      assert.equal(sh(clone.dir, ["fsck", "--unreachable", "--no-progress"]), "", `${name}: the user's fsck finds something unreachable`);
    }
  });

  test("a linked worktree uses the clone's one huddle object directory", async () => {
    const linked = join(h.root, "alice-linked");
    sh(alice.dir, ["worktree", "add", "--quiet", "-b", "side", linked]);
    assert.equal(huddleObjects(linked), huddleObjects(alice.dir));
    const before = filesUnder(huddleObjects(alice.dir)).length;

    const sha = okSha(await transportFor(linked).publish(actorRef("linklink"), actorDoc("linklink"), "own"));
    assert.equal(filesUnder(huddleObjects(alice.dir)).length, before + 3);
    assert.equal(existsSync(join(sh(linked, ["rev-parse", "--absolute-git-dir"]), "huddle")), false, "nothing is kept per worktree");
    assert.equal(userSees(linked, sha), false);
    assert.deepEqual((await fetched(transportFor(linked))).changed.get(actorRef("linklink")), { sha, doc: actorDoc("linklink") });
    assert.deepEqual((await fetched(transportFor(bob.dir))).changed.get(actorRef("linklink")), { sha, doc: actorDoc("linklink") });
  });

  test("objects older than an hour are deleted by the next fetchAll, and younger ones are kept", async () => {
    const carol = await h.clone("carol");
    const c = transportFor(carol.dir);
    const dir = huddleObjects(carol.dir);
    const added = async (publish: () => Promise<Sha>): Promise<{ sha: Sha; files: string[] }> => {
      const had = filesUnder(dir);
      const sha = await publish();
      const files = filesUnder(dir).filter((file) => !had.includes(file));
      assert.equal(files.length, 3);
      return { sha, files };
    };

    // The limit has to dwarf the time any call can take (a push may last the whole network
    // timeout), and still be short enough that the directory stays small.
    assert.ok(OBJECT_MAX_AGE_MS >= 60 * NETWORK_TIMEOUT_MS, "objects are deleted too soon after they were written");
    assert.ok(OBJECT_MAX_AGE_MS <= 24 * 60 * 60_000, "objects are kept for more than a day");

    const old = await added(async () => okSha(await c.publish(actorRef("oldoldold"), actorDoc("oldoldold"), "own")));
    age(dir, OBJECT_MAX_AGE_MS + 60_000, old.files);
    const almost = await added(async () => okSha(await c.publish(actorRef("almostold"), actorDoc("almostold"), "own")));
    age(dir, OBJECT_MAX_AGE_MS - 60_000, almost.files);
    const fresh = await added(async () => okSha(await c.publish(actorRef("freshfresh"), actorDoc("freshfresh"), "own")));

    // Carol is up to date, so this fetchAll has nothing to read. All it does is clean up.
    const upToDate = await fetched(c, remoteHuddleRefs(h));
    assert.equal(upToDate.changed.size, 0);
    assert.deepEqual(filesUnder(dir), [...almost.files, ...fresh.files].sort(), "exactly the objects past the age limit were deleted");
    // Only files go. A git process that is about to write into a directory must still find it there.
    for (const file of old.files) assert.ok(existsSync(join(dir, file.split("/")[0]!)), "a directory was removed");

    // Nothing is lost by it: asked for everything, fetchAll gets the deleted document from the remote again.
    const everything = await fetched(c);
    assert.deepEqual(everything.changed.get(actorRef("oldoldold")), { sha: old.sha, doc: actorDoc("oldoldold") });
    assert.deepEqual(everything.changed.get(actorRef("almostold")), { sha: almost.sha, doc: actorDoc("almostold") });
    assert.deepEqual(everything.changed.get(actorRef("freshfresh")), { sha: fresh.sha, doc: actorDoc("freshfresh") });

    // A compare-and-swap against a commit whose objects are gone still works: the remote holds the comparison.
    const task = okSha(await c.publish(taskRef("prunedtask"), taskDoc("prunedtask", 1), "absent"));
    age(dir, OBJECT_MAX_AGE_MS + 60_000);
    await fetched(c, remoteHuddleRefs(h));
    assert.deepEqual(filesUnder(dir), [], "setup: everything should be cleaned up by now");
    const next = okSha(await c.publish(taskRef("prunedtask"), taskDoc("prunedtask", 2), task));
    assert.deepEqual(await c.publish(taskRef("prunedtask"), taskDoc("prunedtask", 3), task), { ok: false, reason: "lost-race" });
    assert.deepEqual(await c.remove(taskRef("prunedtask"), next), { ok: true, sha: next });
  });

  test("publishing a document again makes its objects recent again", async () => {
    // This is what protects a publish from a cleanup running in another process at the same
    // moment: git refreshes the modification time of an object it is asked to write and already has.
    const dana = await h.clone("dana");
    const d = transportFor(dana.dir);
    const dir = huddleObjects(dana.dir);
    const sha = okSha(await d.publish(actorRef("samesame"), actorDoc("samesame"), "own"));
    age(dir, OBJECT_MAX_AGE_MS + 60_000);
    assert.equal(okSha(await d.publish(actorRef("samesame"), actorDoc("samesame"), "own")), sha);
    const files = filesUnder(dir);
    assert.equal(files.length, 3);
    for (const file of files) assert.ok(Date.now() - statSync(join(dir, file)).mtimeMs < 60_000, `${file} still looks old`);
  });

  test("a document whose objects were only half cleaned up is fetched again, not reported as invalid", async () => {
    const erin = await h.clone("erin");
    const e = transportFor(erin.dir);
    const dir = huddleObjects(erin.dir);
    const sha = okSha(await transportFor(alice.dir).publish(actorRef("halfhalf"), actorDoc("halfhalf"), "own"));
    const whole = { sha, doc: actorDoc("halfhalf") };
    assert.deepEqual((await fetched(e)).changed.get(actorRef("halfhalf")), whole);
    const commit = loose(sha);
    const tree = loose(huddleGit(erin.dir, ["rev-parse", `${sha}^{tree}`]));
    const blob = loose(huddleGit(erin.dir, ["rev-parse", `${sha}:${DOC_FILE}`]));
    for (const file of [commit, tree, blob]) assert.ok(existsSync(join(dir, file)), "setup: the fetched objects should be loose files");

    // The cleanup deletes one file at a time, so for a moment a commit can be here without its content.
    for (const gone of [[blob], [tree], [tree, blob], [commit], [commit, tree]]) {
      for (const file of gone) rmSync(join(dir, file));
      assert.deepEqual((await fetched(e)).changed.get(actorRef("halfhalf")), whole, `after losing ${gone.join(" and ")}`);
      for (const file of [commit, tree, blob]) assert.ok(existsSync(join(dir, file)), "the fetch should have brought every object back");
    }
  });
});

describe("transport in clones and against remotes with unusual settings", () => {
  let h: Harness;
  let alice: Clone;

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    sh(h.remote, ["config", "uploadpack.allowFilter", "true"]);
    // History to be shallow or partial about.
    writeFileSync(join(alice.dir, "history.txt"), "one\n");
    sh(alice.dir, ["add", "history.txt"]);
    sh(alice.dir, ["commit", "--quiet", "-m", "one"]);
    writeFileSync(join(alice.dir, "history.txt"), "two\n");
    sh(alice.dir, ["commit", "--quiet", "-am", "two"]);
    sh(alice.dir, ["push", "--quiet", "origin", "HEAD:main"]);
  });
  after(() => h.cleanup());

  /** A clone of the harness remote made with extra `git clone` arguments, over file:// so that they take effect. */
  const cloneWith = (name: string, args: string[]): string => {
    const dir = join(h.root, name);
    sh(h.root, ["clone", "--quiet", ...args, pathToFileURL(h.remote).href, dir]);
    return dir;
  };

  /** Documents go both ways between the clone at `dir` and Alice, and every kind of write works from `dir`. */
  const roundTrip = async (dir: string, id: string): Promise<Sha> => {
    const t = transportFor(dir);
    const a = transportFor(alice.dir);
    const theirs = okSha(await a.publish(actorRef(`${id}a`), actorDoc(`${id}a`), "own"));
    assert.deepEqual((await fetched(t)).changed.get(actorRef(`${id}a`)), { sha: theirs, doc: actorDoc(`${id}a`) });
    const own = okSha(await t.publish(actorRef(`${id}b`), actorDoc(`${id}b`), "own"));
    const created = okSha(await t.publish(taskRef(id), taskDoc(id, 1), "absent"));
    assert.deepEqual(await t.publish(taskRef(id), taskDoc(id, 2), "absent"), { ok: false, reason: "lost-race" });
    const replaced = okSha(await t.publish(taskRef(id), taskDoc(id, 3), created));
    const seen = await fetched(a);
    assert.deepEqual(seen.changed.get(actorRef(`${id}b`)), { sha: own, doc: actorDoc(`${id}b`) });
    assert.deepEqual(seen.changed.get(taskRef(id)), { sha: replaced, doc: taskDoc(id, 3) });
    assert.deepEqual(await t.remove(taskRef(id), replaced), { ok: true, sha: replaced });
    assert.equal(userSees(dir, theirs), false);
    return theirs;
  };

  test("a blobless partial clone gets whole documents", async () => {
    const dir = cloneWith("blobless", ["--filter=blob:none"]);
    const partial = (): string => sh(dir, ["config", "--get-regexp", "^remote\\.origin\\.(promisor|partialclonefilter)$"]);
    assert.equal(partial(), "remote.origin.promisor true\nremote.origin.partialclonefilter blob:none", "setup: this should be a partial clone");
    // git fetch applies the clone's filter unless told otherwise. With blob:none the
    // commit and the tree would arrive without doc.json, and the document would read as invalid.
    await roundTrip(dir, "blobless");
    assert.equal(partial(), "remote.origin.promisor true\nremote.origin.partialclonefilter blob:none");
  });

  test("a shallow clone stays exactly as shallow as it was", async () => {
    const dir = cloneWith("shallow", ["--depth", "1"]);
    const shallow = join(dir, ".git", "shallow");
    const before = readFileSync(shallow, "utf8");
    assert.equal(sh(dir, ["rev-list", "--count", "HEAD"]), "1", "setup: this should be a shallow clone");
    await roundTrip(dir, "shallow");
    assert.equal(readFileSync(shallow, "utf8"), before);
    assert.equal(sh(dir, ["rev-list", "--count", "HEAD"]), "1");
  });

  test("a clone that borrows its objects from another repository", async () => {
    const dir = join(h.root, "borrower");
    sh(h.root, ["clone", "--quiet", "--shared", alice.dir, dir]);
    sh(dir, ["remote", "set-url", "origin", h.remote]);
    assert.ok(existsSync(join(dir, ".git", "objects", "info", "alternates")), "setup: this clone should have an alternate of its own");
    assert.equal(sh(dir, ["count-objects"]), "0 objects, 0 kilobytes", "setup: every object of this clone should be borrowed");
    await roundTrip(dir, "borrowed");
  });

  test("a clone whose path contains the character git separates alternates with", { skip: process.platform === "win32" ? "a Windows path cannot contain a colon" : false }, async () => {
    const dir = cloneWith('we:ird "dir', []);
    const own = join(dir, ".git", "objects");
    const empty = join(h.root, "empty-objects");
    mkdirSync(empty, { recursive: true });
    const headVisible = (alternates: string): boolean => {
      try {
        execFileSync("git", ["cat-file", "-e", "HEAD"], { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_OBJECT_DIRECTORY: empty, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates } });
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(headVisible(own), false, "setup: git should split the unquoted path in two");
    assert.equal(headVisible(alternatesEntry(own)), true);
    await roundTrip(dir, "colonpath");
  });

  test("a remote configured as a push mirror gets the huddle ref and nothing else", async () => {
    const mira = await h.clone("mira");
    sh(mira.dir, ["commit", "--quiet", "--allow-empty", "-m", "not pushed yet"]);
    sh(mira.dir, ["branch", "secret"]);
    sh(mira.dir, ["config", "remote.origin.mirror", "true"]);
    assert.throws(() => sh(mira.dir, ["push", "--quiet", "origin", "HEAD:refs/heads/elsewhere"]), /--mirror can't be combined with refspecs/, "setup: git should refuse a refspec for a mirror remote");
    const branches = (): string => sh(h.remote, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]);
    const before = branches();
    await roundTrip(mira.dir, "mirrored");
    assert.equal(branches(), before, "a mirror push would have sent every local branch");
  });

  test("a huddle push does not open a second connection to negotiate", async () => {
    // With push.negotiate git first runs a fetch against the remote to look for history in
    // common. A document commit has none, and the extra connection is one more that can time out.
    const nell = await h.clone("nell");
    sh(nell.dir, ["config", "push.negotiate", "true"]);
    sh(nell.dir, ["commit", "--quiet", "--allow-empty", "-m", "for the setup check"]);
    const trace = join(h.root, "negotiate-trace");
    /** What git ran, by its own account, while `run` was going: GIT_TRACE reaches every git this process starts. */
    const traced = async (run: () => unknown): Promise<string> => {
      writeFileSync(trace, "");
      const had = process.env.GIT_TRACE;
      process.env.GIT_TRACE = trace;
      try {
        await run();
      } finally {
        if (had === undefined) delete process.env.GIT_TRACE;
        else process.env.GIT_TRACE = had;
      }
      return readFileSync(trace, "utf8");
    };
    assert.match(await traced(() => sh(nell.dir, ["push", "--quiet", "origin", "HEAD:refs/heads/nell"])), /fetch --negotiate-only/, "setup: the user's own push should negotiate");
    const ours = await traced(() => roundTrip(nell.dir, "negotiate"));
    assert.match(ours, /push --porcelain/, "setup: the trace should show huddle's pushes");
    assert.doesNotMatch(ours, /negotiate-only/);
  });

  test("the user's push options do not break a huddle push", async () => {
    const olga = await h.clone("olga");
    sh(olga.dir, ["config", "push.pushOption", "merge_request.create"]);
    sh(olga.dir, ["config", "--add", "push.pushOption", "ci.skip"]);
    sh(olga.dir, ["commit", "--quiet", "--allow-empty", "-m", "for the setup check"]);
    // A remote that does not take push options refuses the whole push when one is sent.
    sh(h.remote, ["config", "receive.advertisePushOptions", "false"]);
    try {
      assert.throws(() => sh(olga.dir, ["push", "--quiet", "origin", "HEAD:refs/heads/olga"]), /does not support push options/, "setup: the user's own push should be refused");
      await roundTrip(olga.dir, "pushopts");
    } finally {
      sh(h.remote, ["config", "--unset", "receive.advertisePushOptions"]);
    }
  });

  test("the user's push options are not delivered with a huddle push", { skip: posixOnly }, async () => {
    const pia = await h.clone("pia");
    sh(pia.dir, ["config", "push.pushOption", "merge_request.create"]);
    sh(pia.dir, ["config", "--add", "push.pushOption", "ci.skip"]);
    sh(pia.dir, ["commit", "--quiet", "--allow-empty", "-m", "for the setup check"]);
    const seen = join(h.root, "push-options-seen");
    const hook = script(join(h.remote, "hooks", "pre-receive"), `echo "\${GIT_PUSH_OPTION_COUNT:-0}" >> "${seen}"\nexit 0`);
    const counts = (): string[] => readFileSync(seen, "utf8").trim().split("\n");
    sh(h.remote, ["config", "receive.advertisePushOptions", "true"]);
    try {
      sh(pia.dir, ["push", "--quiet", "origin", "HEAD:refs/heads/pia"]);
      assert.deepEqual(counts(), ["2"], "setup: the user's own push should deliver both options");
      const p = transportFor(pia.dir);
      const created = okSha(await p.publish(taskRef("noptions"), taskDoc("noptions", 1), "absent"));
      const replaced = okSha(await p.publish(taskRef("noptions"), taskDoc("noptions", 2), created));
      assert.deepEqual(await p.remove(taskRef("noptions"), replaced), { ok: true, sha: replaced });
      assert.deepEqual(counts(), ["2", "0", "0", "0"], "three huddle pushes, no option on any of them");
    } finally {
      rmSync(hook);
      sh(h.remote, ["config", "--unset", "receive.advertisePushOptions"]);
    }
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
    sh(reader.dir, ["config", "remote.origin.uploadpack", shq(wrapper)]);
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

  test("parseRemoteSettings and isMirror: a remote's section as git prints it with --null", () => {
    const printed = [
      "remote.origin.url\ngit@github.com:team/repo.git",
      "remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*",
      "remote.origin.fetch\n+refs/huddle/*:refs/remotes/origin/huddle/*",
      "remote.origin.pushurl\nline one\nline two", // a value may contain a newline; only the first one separates
      "remote.origin.mirror", // written without a value, which git reads as true
      "remote.originals.url\nnot ours",
      "remote.Origin.url\nnot ours either: remote names are case sensitive",
      "",
    ].join("\0");
    const parsed = parseRemoteSettings(printed, "origin");
    assert.deepEqual(parsed, [
      ["url", "git@github.com:team/repo.git"],
      ["fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["fetch", "+refs/huddle/*:refs/remotes/origin/huddle/*"],
      ["pushurl", "line one\nline two"],
      ["mirror", "true"],
    ]);
    assert.equal(isMirror(parsed), true);
    assert.deepEqual(parseRemoteSettings("", "origin"), []);

    for (const value of ["true", "TRUE", "yes", "on", "1", " true "]) assert.equal(isMirror([["mirror", value]]), true, value);
    for (const value of ["false", "False", "no", "off", "0", ""]) assert.equal(isMirror([["mirror", value]]), false, JSON.stringify(value));
    assert.equal(isMirror([["url", "true"]]), false);
    assert.equal(isMirror([]), false);
  });

  test("alternatesEntry quotes a path only when git would misread it", () => {
    assert.equal(alternatesEntry("/home/me/repo/.git/objects", ":"), "/home/me/repo/.git/objects");
    assert.equal(alternatesEntry("/home/me/my repo/.git/objects", ":"), "/home/me/my repo/.git/objects", "a space needs nothing");
    assert.equal(alternatesEntry("/home/me/a:b/.git/objects", ":"), '"/home/me/a:b/.git/objects"');
    assert.equal(alternatesEntry('/home/me/a:"b"\\c/.git/objects', ":"), '"/home/me/a:\\"b\\"\\\\c/.git/objects"');
    // On Windows the separator is ";" and every path has a colon and backslashes: leave those alone.
    assert.equal(alternatesEntry("C:\\Users\\me\\repo\\.git\\objects", ";"), "C:\\Users\\me\\repo\\.git\\objects");
    assert.equal(alternatesEntry("C:\\Users\\me\\a;b\\.git\\objects", ";"), '"C:\\\\Users\\\\me\\\\a;b\\\\.git\\\\objects"');
    // An entry that starts with "#" is a comment to git, and one that starts with a quote is read as quoted.
    assert.equal(alternatesEntry("#odd/.git/objects", ":"), '"#odd/.git/objects"');
    assert.equal(alternatesEntry('"odd/.git/objects', ":"), '"\\"odd/.git/objects"');
  });

  test("pruneObjects deletes old files and nothing else", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "huddle-prune-"));
    const outside = mkdtempSync(join(tmpdir(), "huddle-prune-outside-"));
    const hour = 60 * 60_000;
    const put = (base: string, rel: string, ageMs: number): void => {
      const path = join(base, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "x");
      const then = new Date(Date.now() - ageMs);
      utimesSync(path, then, then);
    };
    try {
      put(root, "ab/old-object", 2 * hour);
      put(root, "ab/new-object", 60_000);
      put(root, "pack/pack-old.pack", 2 * hour);
      put(root, "pack/pack-old.idx", 2 * hour);
      put(root, "pack/pack-new.pack", 0);
      put(root, "tmp_objdir-bulk-fsync-abc/cd/old-object", 2 * hour); // what an interrupted batched fsync leaves behind
      put(root, "old-at-the-top", 2 * hour);
      put(root, "a/b/c/d/old-but-too-deep", 2 * hour); // deeper than git ever writes: not ours to judge
      put(root, "ef/exactly-at-the-limit", hour - 5_000);
      put(outside, "old-file", 2 * hour);
      put(outside, "dir/old-file", 2 * hour);
      if (process.platform !== "win32") {
        // Links are neither followed nor removed, so nothing outside the directory can be reached through one.
        symlinkSync(join(outside, "old-file"), join(root, "ab", "link-to-file"));
        symlinkSync(join(outside, "dir"), join(root, "link-to-dir"));
      }
      const links = process.platform === "win32" ? [] : ["ab/link-to-file", "link-to-dir"];

      assert.equal(await pruneObjects(root, hour), 5);
      assert.deepEqual(filesUnder(root), ["a/b/c/d/old-but-too-deep", "ab/new-object", "ef/exactly-at-the-limit", "pack/pack-new.pack", ...links].sort());
      assert.ok(existsSync(join(root, "tmp_objdir-bulk-fsync-abc", "cd")), "directories are left in place");
      assert.deepEqual(filesUnder(outside), ["dir/old-file", "old-file"], "nothing outside the directory was touched");

      // Nothing left to do, and a directory that does not exist is not an error.
      assert.equal(await pruneObjects(root, hour), 0);
      assert.equal(await pruneObjects(join(root, "no-such-directory"), hour), 0);
      // `now` is the reference point: an hour and a bit later, the rest has aged out too.
      assert.equal(await pruneObjects(root, hour, Date.now() + hour + 60_000), 3);
      assert.deepEqual(filesUnder(root), ["a/b/c/d/old-but-too-deep", ...links].sort());

      // What it costs when there is nothing to delete, on a directory as full as an hour of a busy team makes it.
      for (let n = 0; n < 256; n++) {
        const fanOut = n.toString(16).padStart(2, "0");
        for (let k = 0; k < 4; k++) put(root, `${fanOut}/object-${k}`, 0);
      }
      const started = performance.now();
      assert.equal(await pruneObjects(root, hour), 0);
      t.diagnostic(`pruneObjects over 256 directories and 1024 fresh files: ${Math.round(performance.now() - started)} ms`);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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
