// T1.4: sync and the first commands, on the harness with real clones.
// The first test is the exit test from plan.md §5.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openContext } from "../src/core/context.ts";
import type { Io } from "../src/core/io.ts";
import { withLock } from "../src/core/store.ts";
import { contentHash, deferredSyncDue, foreignSessions, shouldPublish, spawnBackgroundSync, syncWithin } from "../src/core/sync.ts";
import { DEFAULT_CONFIG } from "../src/core/types.ts";
import type { ActorDoc, Cache, LocalState, Session } from "../src/core/types.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const MIN = 60;

/** The huddle refs on the remote, as "ref sha" lines. */
const remoteRefs = (h: Harness) => h.remoteGit("for-each-ref", "--format=%(refname) %(objectname)", "refs/huddle");

async function actorDocs(h: Harness): Promise<ActorDoc[]> {
  const refs = (await h.remoteGit("for-each-ref", "--format=%(refname)", "refs/huddle/actors")).split("\n").filter(Boolean);
  return Promise.all(refs.map(async (ref) => JSON.parse(await h.remoteGit("cat-file", "-p", `${ref}:doc.json`)) as ActorDoc));
}

async function ok(clone: Clone, args: string[], now: string, env: Record<string, string> = {}) {
  const r = await clone.huddle(args, { now, env });
  assert.equal(r.code, 0, `huddle ${args.join(" ")} in ${clone.name} exited ${r.code}: ${r.stderr}${r.stdout}`);
  return r;
}

test("exit test: alice announces and edits, bob sees her, check names her, and she ages out", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");

  await alice.git("checkout", "--quiet", "-b", "feat/auth");
  await ok(alice, ["intent", "build auth"], at(0));
  await alice.write("src/auth.ts", "export const auth = true;\n");
  const aliceBefore = await alice.snapshot();
  await ok(alice, ["sync"], at(10));
  assert.deepEqual(await alice.snapshot(), aliceBefore, "sync changed alice's refs, FETCH_HEAD, index or working tree");

  const bobBefore = await bob.snapshot();
  await ok(bob, ["sync"], at(20));

  const status = await ok(bob, ["status"], at(25));
  assert.match(status.stdout, /alice/, "status names alice");
  assert.match(status.stdout, /feat\/auth/, "status shows her branch");
  assert.match(status.stdout, /build auth/, "status shows her intent");
  assert.match(status.stdout, /src\/auth\.ts/, "status shows her file");

  const check = await bob.huddle(["check", "src/auth.ts"], { now: at(30) });
  assert.equal(check.code, 3, `check should exit 3 on overlap: ${check.stdout}${check.stderr}`);
  assert.match(check.stdout, /alice/, "check names alice");
  assert.match(check.stdout, /src\/auth\.ts/);

  const clear = await bob.huddle(["check", "src/unrelated.ts"], { now: at(30) });
  assert.equal(clear.code, 0, clear.stderr);
  assert.doesNotMatch(clear.stdout, /alice/);

  assert.deepEqual(await bob.snapshot(), bobBefore, "sync, status and check changed bob's refs, FETCH_HEAD, index or working tree");

  // Alice was last active at T0+10s. One second short of the TTL she is still listed...
  const almost = await ok(bob, ["status"], at(10 + 15 * MIN - 1));
  assert.match(almost.stdout, /alice/);
  // ...and at the TTL she is gone, from status and from check.
  const after = await ok(bob, ["status"], at(10 + 15 * MIN));
  assert.doesNotMatch(after.stdout, /alice/, "alice is past the TTL and must not be listed");
  assert.doesNotMatch(after.stdout, /src\/auth\.ts/);
  const checkAfter = await bob.huddle(["check", "src/auth.ts"], { now: at(10 + 15 * MIN) });
  assert.equal(checkAfter.code, 0, "no overlap with a session that is no longer live");
});

test("what is published: paths, branch and intent, never file contents or the worktree path", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "refactor the parser"], at(0));
  await alice.write("src/parser.ts", "const SECRET_TOKEN = 'hunter2';\n");
  await ok(alice, ["sync"], at(5));

  const docs = await actorDocs(h);
  assert.equal(docs.length, 1);
  const doc = docs[0]!;
  assert.equal(doc.v, 0);
  assert.equal(doc.kind, "actor");
  assert.equal(doc.user, "alice");
  assert.match(doc.actor, /^[a-z2-7]{8}$/);
  assert.equal(doc.sessions.length, 1);
  const session = doc.sessions[0]!;
  assert.equal(session.agent, "manual");
  assert.equal(session.branch, "main");
  assert.equal(session.intent, "refactor the parser");
  assert.equal(session.intentSource, "manual");
  assert.deepEqual(session.files, ["src/parser.ts"]);
  assert.deepEqual(Object.keys(session).sort(), ["agent", "branch", "claims", "files", "id", "intent", "intentSource", "seenAt", "startedAt"]);

  const raw = JSON.stringify(doc);
  assert.doesNotMatch(raw, /hunter2|SECRET_TOKEN/, "file contents were published");
  assert.ok(!raw.includes(alice.dir), "the local worktree path was published");
  // The ref is named after the actor and holds exactly one file.
  const refs = (await remoteRefs(h)).split("\n");
  assert.equal(refs.length, 1);
  assert.ok(refs[0]!.startsWith(`refs/huddle/actors/${doc.actor} `));
  assert.equal(await h.remoteGit("ls-tree", "--name-only", `refs/huddle/actors/${doc.actor}`), "doc.json");
  assert.equal(await h.remoteGit("rev-list", "--count", `refs/huddle/actors/${doc.actor}`), "1", "the commit has no parent");
});

test("a sync with nothing new does not push; a change does; the heartbeat does after activity", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "first"], at(0));
  await ok(alice, ["sync"], at(1));
  const first = await remoteRefs(h);

  // Background syncs do not count as activity, so nothing about the doc changes.
  await ok(alice, ["sync", "--background", "--force"], at(30));
  assert.equal(await remoteRefs(h), first, "an unchanged doc was pushed again");

  // Past the heartbeat interval but with no activity since the last publish: still nothing to say.
  await ok(alice, ["sync", "--background", "--force"], at(4 * MIN));
  assert.equal(await remoteRefs(h), first, "a heartbeat was sent for a session that did nothing");

  // A new file in flight is a content change.
  await alice.write("new.ts", "x\n");
  await ok(alice, ["sync", "--background", "--force"], at(4 * MIN + 5));
  const second = await remoteRefs(h);
  assert.notEqual(second, first, "a changed doc was not pushed");

  // That push was made by a background sync, which is not activity: it carried the session as last seen at 0:01.
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.seenAt, at(1));

  // Activity (a manual sync touches the session). The heartbeat interval has not passed, but what
  // teammates hold for the session is five minutes old by now, so its sign of life goes out.
  await ok(alice, ["sync"], at(5 * MIN));
  const third = await remoteRefs(h);
  assert.notEqual(third, second, "teammates were left with a seenAt five minutes behind");
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.seenAt, at(5 * MIN));

  // More activity a minute later: seenAt alone, a minute ahead of what teammates hold, is not worth a push.
  await ok(alice, ["sync"], at(6 * MIN));
  assert.equal(await remoteRefs(h), third, "seenAt alone caused a push inside the heartbeat interval");

  // The same activity once the heartbeat interval has passed: publish, so teammates see she is still there.
  await ok(alice, ["sync"], at(8 * MIN));
  const fourth = await remoteRefs(h);
  assert.notEqual(fourth, third, "no heartbeat after the interval despite activity");
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.seenAt, at(8 * MIN));
});

test("a session that wakes up just after another session of its clone published is not shown as gone", async (t) => {
  // A publish carries every session's seenAt as it was at that moment. Session
  // "quiet" claims a directory and then says nothing for 13 minutes; session
  // "busy" of the same clone publishes. Teammates now hold a 13-minute-old
  // seenAt for "quiet". When it wakes up a minute later the heartbeat is not
  // due, and waiting for it would let "quiet" pass the 15-minute TTL in
  // teammates' eyes while it is at work.
  const h = await createHarness(t);
  const twin = await h.clone("twin");
  const bob = await h.clone("bob");
  const quiet = { HUDDLE_SESSION: "quiet" };
  const busy = { HUDDLE_SESSION: "busy" };
  const published = async (id: string) => (await actorDocs(h)).flatMap((doc) => doc.sessions).find((session) => session.id === id)?.seenAt;

  await ok(twin, ["claim", "src/desk/**"], at(0), quiet);
  await ok(twin, ["sync"], at(0), quiet);
  await ok(twin, ["intent", "something else"], at(13 * MIN), busy);
  await ok(twin, ["sync"], at(13 * MIN), busy);
  assert.equal(await published("quiet"), at(0), "setup: the publish caused by the other session carries the old seenAt");
  assert.equal(await published("busy"), at(13 * MIN));

  // "quiet" is active again: a manual sync touches the session. Nothing but seenAt changed.
  await ok(twin, ["sync"], at(14 * MIN), quiet);
  assert.equal(await published("quiet"), at(14 * MIN), "its sign of life was not published");

  // 15.5 minutes after the claim, 1.5 after the session was last active: bob still sees it.
  await ok(bob, ["sync"], at(15 * MIN + 30));
  const check = await bob.huddle(["check", "src/desk/lamp.ts"], { now: at(15 * MIN + 30) });
  assert.equal(check.code, 3, `bob should be warned about the live claim: ${check.stdout}${check.stderr}`);
  assert.match(check.stdout, /twin/);

  // And no push for a session whose published seenAt is recent enough: one minute on, nothing is sent.
  const before = await remoteRefs(h);
  await ok(twin, ["sync"], at(15 * MIN), quiet);
  assert.equal(await remoteRefs(h), before, "seenAt alone caused a push inside the heartbeat interval");
});

test("the same with the cache lost: what teammates hold is read from the fetch of that round", async (t) => {
  const h = await createHarness(t);
  const twin = await h.clone("twin");
  const quiet = { HUDDLE_SESSION: "quiet" };
  const busy = { HUDDLE_SESSION: "busy" };
  const published = async (id: string) => (await actorDocs(h)).flatMap((doc) => doc.sessions).find((session) => session.id === id)?.seenAt;

  await ok(twin, ["claim", "src/desk/**"], at(0), quiet);
  await ok(twin, ["sync"], at(0), quiet);
  await ok(twin, ["intent", "something else"], at(13 * MIN), busy);
  await ok(twin, ["sync"], at(13 * MIN), busy);
  assert.equal(await published("quiet"), at(0));

  // Without cache.json this clone no longer knows what it published for each session.
  await rm((await twin.paths()).cacheFile);
  await ok(twin, ["sync"], at(14 * MIN), quiet);
  assert.equal(await published("quiet"), at(14 * MIN), "its sign of life waited for another round");

  // The same loss when nothing is owed: the fetch brings the copy back and nothing is pushed.
  const before = await remoteRefs(h);
  await rm((await twin.paths()).cacheFile);
  await ok(twin, ["sync"], at(15 * MIN), quiet);
  assert.equal(await remoteRefs(h), before, "a lost cache alone caused a push");
});

test("background syncs are throttled to one per syncIntervalSeconds; --force and manual syncs are not", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "one"], at(0));
  await ok(alice, ["sync"], at(0));
  const first = await remoteRefs(h);

  await ok(alice, ["intent", "two"], at(5));
  await ok(alice, ["sync", "--background"], at(5));
  assert.equal(await remoteRefs(h), first, "a background sync ran 5 s after the last one");

  await ok(alice, ["sync", "--background"], at(15));
  const second = await remoteRefs(h);
  assert.notEqual(second, first, "a background sync 15 s after the last one should run");
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "two");

  await ok(alice, ["intent", "three"], at(16));
  await ok(alice, ["sync", "--background", "--force"], at(16));
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "three", "--force ignores the throttle");
});

test("when the remote is unreachable, sync says so and exits 1; status still shows the cached team", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  await ok(alice, ["intent", "build auth"], at(0));
  await ok(alice, ["sync"], at(1));
  await ok(bob, ["sync"], at(2));

  await bob.git("remote", "set-url", "origin", join(h.root, "gone.git"));
  const before = await bob.snapshot();
  const cacheFile = (await bob.paths()).cacheFile;
  assert.equal((JSON.parse(await readFile(cacheFile, "utf8")) as Cache).fetchedAt, at(2));
  const sync = await bob.huddle(["sync"], { now: at(60) });
  assert.equal(sync.code, 1);
  assert.equal(sync.stdout, "", "a sync that failed does not say it synced");
  assert.match(sync.stderr, /could not reach remote "origin"/);
  assert.equal((JSON.parse(await readFile(cacheFile, "utf8")) as Cache).fetchedAt, at(2), "a failed fetch does not make the cache look fresh");

  const status = await bob.huddle(["status"], { now: at(120) });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /alice/, "the cached team is still shown");
  assert.match(status.stdout, /build auth/);
  assert.match(status.stderr, /could not reach remote "origin"/);

  const background = await bob.huddle(["sync", "--background", "--force"], { now: at(180) });
  assert.deepEqual({ code: background.code, stdout: background.stdout, stderr: background.stderr }, { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await bob.snapshot(), before);
  const log = await readFile((await bob.paths()).logFile, "utf8");
  assert.match(log, /offline/, "the failure is in the debug log");
});

/** Makes the remote refuse every push to refs/huddle/*, the way a server-side hook or a ref rule does. */
async function refuseHuddleRefs(h: Harness): Promise<void> {
  const hook = join(h.remote, "hooks", "update");
  await mkdir(dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\ncase "$1" in refs/huddle/*) echo "huddle refs are not accepted here" >&2; exit 1 ;; esac\nexit 0\n', { mode: 0o755 });
}

test("when the remote refuses huddle refs, sync says so and exits 1, still reads the team, and tries again next time", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  await ok(alice, ["intent", "build auth"], at(0));
  await ok(alice, ["sync"], at(1));
  await refuseHuddleRefs(h);

  await ok(bob, ["intent", "billing"], at(2));
  const sync = await bob.huddle(["sync"], { now: at(3) });
  assert.equal(sync.code, 1, sync.stdout + sync.stderr);
  assert.equal(sync.stdout, "", "a sync that could not publish does not say it synced");
  assert.match(sync.stderr, /remote "origin" refused a push to refs\/huddle/);
  assert.equal((await actorDocs(h)).length, 1, "only alice's doc is on the remote");

  const paths = await bob.paths();
  const local = JSON.parse(await readFile(paths.localFile, "utf8")) as LocalState;
  assert.equal(local.published, null, "nothing is recorded as published");
  // The fetch half of the round worked: the team is readable, and the cache says when it was read.
  assert.equal((JSON.parse(await readFile(paths.cacheFile, "utf8")) as Cache).fetchedAt, at(3));
  assert.match((await ok(bob, ["status", "--cached"], at(4))).stdout, /build auth/);

  const background = await bob.huddle(["sync", "--background", "--force"], { now: at(5) });
  assert.deepEqual({ code: background.code, stdout: background.stdout, stderr: background.stderr }, { code: 0, stdout: "", stderr: "" });
  assert.match(await readFile(paths.logFile, "utf8"), /publish failed: denied/, "the failure is in the debug log");

  // Once the remote accepts the refs again, the next sync publishes without anything having changed locally.
  await rm(join(h.remote, "hooks", "update"));
  assert.match((await ok(bob, ["sync"], at(6))).stdout, /published this clone's sessions/);
  assert.equal((await actorDocs(h)).length, 2);
});

test("a sync that is not forced skips at once when another sync holds the lock", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "waiting"], at(0));
  const paths = await alice.paths();

  let elapsed = -1;
  let ran: Awaited<ReturnType<Clone["huddle"]>> | undefined;
  const held = await withLock(paths, "sync", async () => {
    const started = Date.now();
    ran = await alice.huddle(["sync", "--background"], { now: at(1), timeoutMs: 12_000 });
    elapsed = Date.now() - started;
  });
  assert.ok(held.acquired, "the test could not take the sync lock");
  assert.equal(ran?.code, 0, `the skipped sync was killed or failed: ${ran?.stderr}`);
  assert.ok(elapsed < 8_000, `a throttled-path sync waited ${elapsed} ms for the lock; only a forced one may wait`);
  assert.equal(await remoteRefs(h), "", "the skipped sync published nothing");

  // The lock is free again: the same command now runs the round.
  await ok(alice, ["sync", "--background"], at(2));
  assert.equal((await actorDocs(h)).length, 1);
});

test("claims made and released at the same moment in one session are all kept", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const globs = ["src/a/**", "src/b/**", "src/c/**", "src/d/**", "docs/*.md", "test/**"];
  const listed = async () => (await ok(alice, ["claim"], at(50))).stdout.trim().split("\n").sort();

  for (let round = 0; round < 3; round++) {
    // Six processes at once, as an agent does with parallel tool calls.
    const claimed = await Promise.all(globs.map((glob) => alice.huddle(["claim", glob], { now: at(round * 10) })));
    for (const r of claimed) assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await listed(), [...globs].sort(), `round ${round}: a claim was lost`);

    const kept = globs.slice(0, 2);
    const released = await Promise.all(globs.slice(2).map((glob) => alice.huddle(["release", glob], { now: at(round * 10 + 1) })));
    for (const r of released) assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await listed(), [...kept].sort(), `round ${round}: a release was lost`);

    await ok(alice, ["release"], at(round * 10 + 2));
  }
  const local = JSON.parse(await readFile((await alice.paths()).localFile, "utf8")) as LocalState;
  assert.equal(local.sessions.length, 1, "all of it happened in one session");
});

test("a claim over the limit is refused whole and leaves the stored claims alone", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["claim", "keep/**"], at(0));
  const many = Array.from({ length: 200 }, (_, i) => `gen/${i}/**`);
  const refused = await alice.huddle(["claim", ...many], { now: at(1) });
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /at most \d+ claims/);
  assert.equal((await ok(alice, ["claim"], at(2))).stdout, "keep/**\n");
});

test("a copied clone publishing under the same actor id is noticed and logged", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "the original"], at(0));
  await ok(alice, ["sync"], at(1));
  const paths = await alice.paths();
  const logText = () => readFile(paths.logFile, "utf8").catch(() => "");
  assert.doesNotMatch(await logText(), /another clone/);

  // cp -r of the working directory takes .git/huddle/actor along.
  await cp(alice.dir, join(h.root, "copy"), { recursive: true });
  const inCopy = { cwd: "../copy" };
  const copied = await alice.huddle(["intent", "the copy"], { now: at(2), ...inCopy });
  assert.equal(copied.code, 0, copied.stderr);
  const copySync = await alice.huddle(["sync"], { now: at(3), ...inCopy });
  assert.equal(copySync.code, 0, copySync.stderr);
  assert.equal((await actorDocs(h)).length, 1, "the test needs both clones on one ref");

  await ok(alice, ["sync"], at(4));
  const log = await logText();
  assert.match(log, /another clone is publishing as this one: refs\/huddle\/actors\/[a-z2-7]+ holds session manual-[0-9a-f]{8}/);
  assert.ok(log.includes(paths.actorFile), "the log line names the file to delete");
});

test("this clone's own doc is not mistaken for another clone's when a push was never recorded", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "about to be interrupted"], at(0), { HUDDLE_SESSION: "s1" });
  await ok(alice, ["sync"], at(1), { HUDDLE_SESSION: "s1" });
  const paths = await alice.paths();
  const logText = () => readFile(paths.logFile, "utf8").catch(() => "");
  // A sync killed between the push and recording it, and then the session ended:
  // the remote holds a doc with a session this clone no longer has.
  const interrupted = async () => {
    await writeFile(paths.localFile, JSON.stringify({ v: 0, sessions: [], published: null }));
    await rm(paths.cacheFile, { force: true });
  };

  await interrupted();
  await ok(alice, ["sync", "--background", "--force"], at(2));
  assert.doesNotMatch(await logText(), /another clone/);

  // The same state without the record of the attempt is what a second writer looks like.
  await interrupted();
  await rm(join(paths.stateDir, "publish-attempt"));
  await ok(alice, ["sync", "--background", "--force"], at(3));
  assert.match(await logText(), /another clone is publishing as this one: \S+ holds session s1,/);
});

test("claims: a claimed glob is an overlap for teammates until it is released", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");

  const claimed = await ok(alice, ["claim", "src/payments/**", "docs/api.md"], at(0));
  assert.match(claimed.stdout, /src\/payments\/\*\*/);
  assert.equal((await ok(alice, ["claim"], at(1))).stdout, "src/payments/**\ndocs/api.md\n");
  await ok(alice, ["sync"], at(2));
  await ok(bob, ["sync"], at(3));

  const hit = await bob.huddle(["check", "src/payments/stripe/client.ts"], { now: at(4) });
  assert.equal(hit.code, 3, hit.stdout + hit.stderr);
  assert.match(hit.stdout, /alice/);
  assert.match(hit.stdout, /src\/payments\/\*\*/, "the warning says which claim matched");
  assert.equal((await bob.huddle(["check", "src/billing/invoice.ts"], { now: at(4) })).code, 0);
  assert.equal((await bob.huddle(["check", "docs/api.md", "src/billing/invoice.ts"], { now: at(4) })).code, 3, "any overlapping path is enough");

  // Releasing one claim keeps the other.
  const partial = await ok(alice, ["release", "src/payments/**"], at(5));
  assert.match(partial.stdout, /still claimed: docs\/api\.md/);
  await ok(alice, ["sync"], at(6));
  await ok(bob, ["sync"], at(7));
  assert.equal((await bob.huddle(["check", "src/payments/stripe/client.ts"], { now: at(8) })).code, 0);
  assert.equal((await bob.huddle(["check", "docs/api.md"], { now: at(8) })).code, 3);

  assert.match((await ok(alice, ["release"], at(9))).stdout, /released all claims/);
  await ok(alice, ["sync"], at(10));
  await ok(bob, ["sync"], at(11));
  assert.equal((await bob.huddle(["check", "docs/api.md"], { now: at(12) })).code, 0);
  assert.equal((await ok(alice, ["claim"], at(13))).stdout, "(no claims)\n");
});

test("claim and release reject what they cannot do, with exit code 2", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const outside = await alice.huddle(["claim", "../elsewhere/**"], { now: at(0) });
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /outside this repository/);
  await ok(alice, ["claim", "src/**"], at(1));
  const unknown = await alice.huddle(["release", "docs/**"], { now: at(2) });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /not claimed by this session: docs\/\*\*/);
  assert.equal((await ok(alice, ["claim"], at(3))).stdout, "src/**\n", "a failed release changes nothing");
  // Typed in a subdirectory, a glob is relative to it.
  await alice.write("src/auth/x.ts", "x\n");
  const sub = await alice.huddle(["claim", "*.ts"], { now: at(4), cwd: "src/auth" });
  assert.equal(sub.code, 0, sub.stderr);
  assert.match(sub.stdout, /src\/auth\/\*\.ts/);
});

test("check with no path checks this worktree's own files in flight", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  await alice.write("src/auth.ts", "alice's version\n");
  await ok(alice, ["sync"], at(0));
  await ok(bob, ["sync"], at(1));

  const clean = await bob.huddle(["check"], { now: at(2) });
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /no overlap: checked 0 paths/);

  await bob.write("src/auth.ts", "bob's version\n");
  await bob.write("src/other.ts", "x\n");
  const collide = await bob.huddle(["check"], { now: at(3) });
  assert.equal(collide.code, 3, collide.stdout + collide.stderr);
  assert.match(collide.stdout, /src\/auth\.ts/);
  assert.match(collide.stdout, /alice/);
  assert.doesNotMatch(collide.stdout, /src\/other\.ts/);

  const json = await bob.huddle(["check", "--json"], { now: at(3) });
  assert.equal(json.code, 3);
  const parsed = JSON.parse(json.stdout) as { checked: number; overlaps: { path: string; sessions: { user: string; via: string }[] }[] };
  assert.equal(parsed.checked, 2);
  assert.deepEqual(parsed.overlaps.map((o) => o.path), ["src/auth.ts"]);
  assert.equal(parsed.overlaps[0]!.sessions[0]!.user, "alice");
  assert.equal(parsed.overlaps[0]!.sessions[0]!.via, "file");

  const outside = await bob.huddle(["check", "/etc/passwd"], { now: at(4) });
  assert.equal(outside.code, 2);
});

test("intent: set, show, replace, clear; long text is cut to 200 characters on one line", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  assert.equal((await ok(alice, ["intent"], at(0))).stdout, "(no intent set)\n");
  assert.equal((await ok(alice, ["intent", "build", "the", "login", "page"], at(1))).stdout, "intent: build the login page\n");
  assert.equal((await ok(alice, ["intent"], at(2))).stdout, "build the login page\n");
  await ok(alice, ["intent", "line one\nline two"], at(3));
  assert.equal((await ok(alice, ["intent"], at(4))).stdout, "line one line two\n");
  await ok(alice, ["intent", "x".repeat(500)], at(5));
  const shown = (await ok(alice, ["intent"], at(6))).stdout.trimEnd();
  assert.equal(Array.from(shown).length, 200);
  assert.equal((await ok(alice, ["intent", "--clear"], at(7))).stdout, "intent cleared\n");
  assert.equal((await ok(alice, ["intent"], at(8))).stdout, "(no intent set)\n");

  const empty = await alice.huddle(["intent", "   "], { now: at(9) });
  assert.equal(empty.code, 2);
  const both = await alice.huddle(["intent", "--clear", "text"], { now: at(9) });
  assert.equal(both.code, 2);
  const flag = await alice.huddle(["intent", "--nope"], { now: at(9) });
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /Usage: huddle intent/);
});

test("two worktrees of one clone are two sessions of one actor, and see each other without a sync", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const second = await alice.addWorktree("feature");

  await ok(alice, ["intent", "main checkout work"], at(0));
  await ok(second, ["intent", "feature work"], at(1));
  await second.write("src/feature.ts", "f\n");

  // No sync yet: the other session comes from this clone's own local state.
  const local = await ok(alice, ["status", "--cached"], at(2));
  assert.match(local.stdout, /feature work/);
  assert.match(local.stdout, /same clone/);
  assert.doesNotMatch(local.stdout.split("\n").slice(1).join("\n"), /main checkout work/, "a session does not list itself as a teammate");

  await ok(second, ["sync"], at(3));
  const docs = await actorDocs(h);
  assert.equal(docs.length, 1, "one clone is one actor");
  assert.deepEqual(docs[0]!.sessions.map((s) => s.intent).sort(), ["feature work", "main checkout work"]);
  assert.deepEqual(docs[0]!.sessions.map((s) => s.branch).sort(), ["feature", "main"]);
  assert.notEqual(docs[0]!.sessions[0]!.id, docs[0]!.sessions[1]!.id);

  const check = await alice.huddle(["check", "src/feature.ts"], { now: at(4) });
  assert.equal(check.code, 3, "a file in flight in another worktree of the same clone is still an overlap");
});

test("two sessions in one worktree share its files: they see each other, but their common dirty files are not an overlap", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  await ok(alice, ["intent", "first agent"], at(0), { HUDDLE_SESSION: "one" });
  await ok(alice, ["intent", "second agent"], at(1), { HUDDLE_SESSION: "two" });
  await alice.write("src/shared.ts", "x\n");
  await ok(alice, ["sync"], at(2), { HUDDLE_SESSION: "one" });

  // Both sessions report the worktree's dirty file, because either may have written it.
  const docs = await actorDocs(h);
  assert.deepEqual(docs[0]!.sessions.map((s) => s.files), [["src/shared.ts"], ["src/shared.ts"]]);

  // From inside that worktree the file is this session's own work as much as the other's: no warning.
  const own = await alice.huddle(["check", "src/shared.ts"], { now: at(3), env: { HUDDLE_SESSION: "one" } });
  assert.equal(own.code, 0, `a session was warned about its own worktree's files: ${own.stdout}`);
  const status = await ok(alice, ["status", "--cached"], at(3), { HUDDLE_SESSION: "one" });
  assert.match(status.stdout, /second agent/, "the other session is still listed");

  // A claim is a statement by one session, not a property of the worktree, so it still counts.
  await ok(alice, ["claim", "docs/**"], at(4), { HUDDLE_SESSION: "two" });
  const claimed = await alice.huddle(["check", "docs/guide.md"], { now: at(5), env: { HUDDLE_SESSION: "one" } });
  assert.equal(claimed.code, 3);

  // For a teammate in another clone the file is in flight twice over.
  await ok(bob, ["sync"], at(6));
  const theirs = await bob.huddle(["check", "src/shared.ts"], { now: at(7) });
  assert.equal(theirs.code, 3);
});

test("HUDDLE_SESSION selects the session; without it a command joins the live session of its worktree", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  // An agent's hook created this session (simulated by naming it).
  await ok(alice, ["intent", "from the agent"], at(0), { HUDDLE_SESSION: "agent-session-1" });
  // The same agent later runs a bare command from its shell: it must land in that session.
  await ok(alice, ["claim", "src/**"], at(5));
  await ok(alice, ["sync"], at(6));
  let docs = await actorDocs(h);
  assert.equal(docs[0]!.sessions.length, 1, "a second session was created for the same agent");
  assert.equal(docs[0]!.sessions[0]!.id, "agent-session-1");
  assert.equal(docs[0]!.sessions[0]!.intent, "from the agent");
  assert.deepEqual(docs[0]!.sessions[0]!.claims, ["src/**"]);

  // An explicit, different HUDDLE_SESSION is a different session.
  await ok(alice, ["intent", "second agent"], at(7), { HUDDLE_SESSION: "agent-session-2" });
  await ok(alice, ["sync"], at(8), { HUDDLE_SESSION: "agent-session-2" });
  docs = await actorDocs(h);
  assert.deepEqual(docs[0]!.sessions.map((s) => s.id).sort(), ["agent-session-1", "agent-session-2"]);
});

test("a session past the TTL is dropped from local state and from the published doc", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "old work"], at(0), { HUDDLE_SESSION: "old" });
  await ok(alice, ["sync"], at(1), { HUDDLE_SESSION: "old" });
  await ok(alice, ["intent", "new work"], at(20 * MIN), { HUDDLE_SESSION: "new" });
  await ok(alice, ["sync"], at(20 * MIN + 1), { HUDDLE_SESSION: "new" });

  const docs = await actorDocs(h);
  assert.deepEqual(docs[0]!.sessions.map((s) => s.id), ["new"]);
  const local = JSON.parse(await readFile((await alice.paths()).localFile, "utf8")) as LocalState;
  assert.deepEqual(local.sessions.map((s) => s.id), ["new"]);
});

test("the remote losing this clone's ref is repaired by the next sync", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "still here"], at(0));
  await ok(alice, ["sync"], at(1));
  const ref = (await remoteRefs(h)).split(" ")[0]!;
  await h.remoteGit("update-ref", "-d", ref);
  assert.equal(await remoteRefs(h), "");

  // Nothing changed locally and the heartbeat is not due, but the doc is gone from the remote.
  await ok(alice, ["sync", "--background", "--force"], at(30));
  assert.match(await remoteRefs(h), new RegExp(`^${ref} [0-9a-f]{40}$`));
});

test("status --json is machine-readable and carries the whole view", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  await ok(alice, ["intent", "build auth"], at(0));
  await ok(alice, ["sync"], at(1));
  const r = await ok(bob, ["status", "--json"], at(2));
  const view = JSON.parse(r.stdout) as { you: { user: string }; sessions: { user: string; intent: string }[]; fetchedAt: string };
  assert.equal(view.you.user, "bob");
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0]!.user, "alice");
  assert.equal(view.sessions[0]!.intent, "build auth");
  assert.equal(view.fetchedAt, at(2), "status refreshed the cache itself");
});

test("status does not announce the caller: looking is not presence", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const r = await ok(alice, ["status"], at(0));
  assert.match(r.stdout, /Not announced yet/);
  assert.equal(await remoteRefs(h), "", "a status call published a session");
});

test("outside a git repository every command fails cleanly with exit 1", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  for (const command of ["sync", "status", "intent", "claim", "release", "check"]) {
    const r = await alice.huddle([command], { cwd: "..", now: at(0) });
    assert.equal(r.code, 1, `${command}: ${r.stderr}`);
    assert.equal(r.stderr, "huddle: not inside a git repository\n");
    assert.equal(r.stdout, "");
  }
  const background = await alice.huddle(["sync", "--background"], { cwd: "..", now: at(0) });
  assert.deepEqual({ code: background.code, stdout: background.stdout, stderr: background.stderr }, { code: 0, stdout: "", stderr: "" });
});

test("--help or -h after a command prints its summary and usage, exits 0, and does nothing else", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const before = await alice.snapshot();
  for (const command of ["sync", "status", "intent", "claim", "release", "check"]) {
    for (const flag of ["--help", "-h"]) {
      // Outside a repository too: help must not depend on where it is asked for.
      for (const cwd of [".", ".."]) {
        const r = await alice.huddle([command, flag], { cwd, now: at(0) });
        assert.equal(r.code, 0, `${command} ${flag}: ${r.stderr}`);
        assert.equal(r.stderr, "");
        const lines = r.stdout.split("\n");
        assert.ok(lines[0]!.length > 10 && !lines[0]!.startsWith("Usage"), `${command}: the first line is the command's summary`);
        assert.equal(lines[1], "");
        assert.ok(lines[2]!.startsWith(`Usage: huddle ${command}`), `${command}: ${lines[2]}`);
      }
    }
  }
  // After other arguments as well, and nothing was claimed or announced along the way.
  assert.equal((await alice.huddle(["claim", "src/**", "--help"], { now: at(1) })).code, 0);
  assert.equal((await ok(alice, ["claim"], at(2))).stdout, "(no claims)\n");
  assert.deepEqual(await alice.snapshot(), before);
  assert.equal(existsSync((await alice.paths()).localFile), false, "no session was created by asking for help");

  // "--" ends the options: what follows is text, even if it looks like a flag.
  assert.equal((await ok(alice, ["intent", "--", "--help"], at(3))).stdout, "intent: --help\n");
});

// ---------------------------------------------------------------------------
// The publish rule, as a pure function.
// ---------------------------------------------------------------------------

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  agent: "manual",
  branch: "main",
  intent: "work",
  intentSource: "manual",
  files: ["b.ts", "a.ts"],
  claims: [],
  startedAt: at(0),
  seenAt: at(0),
  ...over,
});

const doc = (sessions: Session[], updatedAt = at(0)): ActorDoc => ({ v: 0, kind: "actor", actor: "abcd2345", user: "alice", host: "laptop", updatedAt, sessions });

test("contentHash ignores timestamps and list order, and nothing else", () => {
  const base = contentHash(doc([session()]));
  assert.equal(contentHash(doc([session({ seenAt: at(500) })], at(500))), base, "seenAt and updatedAt");
  assert.equal(contentHash(doc([session({ files: ["a.ts", "b.ts"] })])), base, "file order");
  assert.equal(
    contentHash(doc([session({ id: "s2" }), session()])),
    contentHash(doc([session(), session({ id: "s2" })])),
    "session order",
  );
  assert.notEqual(contentHash(doc([session({ intent: "other" })])), base);
  assert.notEqual(contentHash(doc([session({ branch: "feat" })])), base);
  assert.notEqual(contentHash(doc([session({ files: ["a.ts"] })])), base);
  assert.notEqual(contentHash(doc([session({ claims: ["src/**"] })])), base);
  assert.notEqual(contentHash(doc([])), base);
});

test("shouldPublish: changes always, heartbeats only after activity, silence when there is nothing to say", () => {
  const config = { ...DEFAULT_CONFIG };
  const d = doc([session({ seenAt: at(0) })]);
  const hash = contentHash(d);
  const published = { at: at(0), hash, sha: "0".repeat(40) };

  assert.equal(shouldPublish(null, d, hash, new Date(at(0)), config), true, "first publish");
  assert.equal(shouldPublish(null, doc([]), contentHash(doc([])), new Date(at(0)), config), false, "nothing to announce");
  assert.equal(shouldPublish({ ...published, hash: "different" }, d, hash, new Date(at(1)), config), true, "content changed");
  assert.equal(shouldPublish(published, d, hash, new Date(at(60)), config), false, "unchanged, inside the heartbeat");
  assert.equal(shouldPublish(published, d, hash, new Date(at(3 * MIN)), config), false, "heartbeat due but idle since the last publish");

  const active = doc([session({ seenAt: at(100) })]);
  assert.equal(shouldPublish(published, active, hash, new Date(at(3 * MIN - 1)), config), false, "active, one second before the heartbeat");
  assert.equal(shouldPublish(published, active, hash, new Date(at(3 * MIN)), config), true, "active and the heartbeat is due");
  assert.equal(shouldPublish({ ...published, at: at(999) }, d, hash, new Date(at(0)), config), true, "a publish time in the future is not trusted");
  assert.equal(shouldPublish({ ...published, at: "garbage" }, d, hash, new Date(at(0)), config), true);
});

test("shouldPublish: inside the heartbeat interval, a session seen a heartbeat after what teammates hold for it is published", () => {
  const config = { ...DEFAULT_CONFIG };
  // The last publish was at 13 minutes, caused by s2. It carried s1 as last seen at 0.
  const shown = new Map([
    ["s1", at(0)],
    ["s2", at(13 * MIN)],
  ]);
  const sessions = (s1: string, s2 = at(13 * MIN)) => doc([session({ id: "s1", seenAt: s1 }), session({ id: "s2", seenAt: s2 })]);
  const hash = contentHash(sessions(at(0)));
  const published = { at: at(13 * MIN), hash, sha: "0".repeat(40) };
  const now = new Date(at(14 * MIN));

  assert.equal(shouldPublish(published, sessions(at(0)), hash, now, config, shown), false, "nobody has been active since");
  assert.equal(shouldPublish(published, sessions(at(14 * MIN)), hash, now, config, shown), true, "s1 woke up; teammates hold a 14-minute-old seenAt for it");
  assert.equal(shouldPublish(published, sessions(at(3 * MIN)), hash, now, config, shown), true, "exactly one heartbeat ahead");
  assert.equal(shouldPublish(published, sessions(at(3 * MIN - 1)), hash, now, config, shown), false, "one second short of a heartbeat ahead");
  assert.equal(shouldPublish(published, sessions(at(0), at(14 * MIN)), hash, now, config, shown), false, "s2 is one minute ahead of what teammates hold");
  // Without knowing what teammates hold, the interval is the only rule.
  assert.equal(shouldPublish(published, sessions(at(14 * MIN)), hash, now, config), false);
  assert.equal(shouldPublish(published, sessions(at(14 * MIN)), hash, now, config, null), false);
  // A session teammates have no seenAt for, or a broken one, decides nothing by itself.
  assert.equal(shouldPublish(published, sessions(at(14 * MIN)), hash, now, config, new Map([["s2", at(13 * MIN)]])), false);
  assert.equal(shouldPublish(published, sessions(at(14 * MIN)), hash, now, config, new Map([["s1", "garbage"]])), false);
});

// ---------------------------------------------------------------------------
// Concurrency and the background path. These use the real clock.
// ---------------------------------------------------------------------------

test("foreignSessions: only a doc this clone did not push, holding a live session it does not have, is evidence", () => {
  const config = { ...DEFAULT_CONFIG };
  const now = new Date(at(60));
  const state: LocalState = { v: 0, sessions: [{ ...session({ id: "mine" }), worktree: "/w" }], published: null };
  const remote = doc([session({ id: "mine", seenAt: at(50) }), session({ id: "theirs", seenAt: at(50) }), session({ id: "other", seenAt: at(55) })]);

  assert.deepEqual(foreignSessions(remote, state, [], now, config), ["theirs", "other"]);
  assert.deepEqual(foreignSessions(remote, state, [null, undefined, "something else"], now, config), ["theirs", "other"]);
  assert.deepEqual(foreignSessions(remote, state, ["x", contentHash(remote)], now, config), [], "a doc this clone pushed");
  assert.deepEqual(foreignSessions(doc([session({ id: "mine" })]), state, [], now, config), [], "every session in it is known here");
  const longAgo = new Date(T0 + (config.ttlMinutes + 5) * MIN * 1000);
  assert.deepEqual(foreignSessions(remote, state, [], longAgo, config), [], "sessions past the TTL prove nothing");
  assert.deepEqual(foreignSessions(null, state, [], now, config), [], "an unreadable doc");
  assert.deepEqual(foreignSessions({ v: 0, kind: "decisions", actor: "abcd2345", user: "a", host: "h", updatedAt: at(0), decisions: [] } as never, state, [], now, config), []);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** True once no sync holds the lock, so the harness can remove the clone safely. */
async function syncIdle(clone: Clone): Promise<boolean> {
  const { syncLock } = await clone.paths();
  return !existsSync(syncLock);
}

test("several syncs at once in one clone all succeed and leave one consistent doc", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "racing"], new Date().toISOString());
  await alice.write("a.ts", "a\n");

  const results = await Promise.all(Array.from({ length: 6 }, () => alice.huddle(["sync"])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);

  const docs = await actorDocs(h);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.sessions.length, 1);
  assert.deepEqual(docs[0]!.sessions[0]!.files, ["a.ts"]);
  const local = JSON.parse(await readFile((await alice.paths()).localFile, "utf8")) as LocalState;
  assert.equal(local.sessions.length, 1);
  assert.equal(local.published?.sha, (await remoteRefs(h)).split(" ")[1], "local state records the commit that is actually on the remote");
  assert.ok(await syncIdle(alice), "a sync lock was left behind");
});

test("intent starts a detached background sync that publishes without being waited for", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");

  const r = await alice.huddle(["intent", "announce in the background"], { env: { HUDDLE_NO_BACKGROUND: "" } });
  assert.equal(r.code, 0, r.stderr);
  await until("the background sync to publish", async () => (await remoteRefs(h)) !== "");
  await until("the background sync to finish", () => syncIdle(alice));
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "announce in the background");
});

function inProcessIo(clone: Clone): Io {
  return { cwd: clone.dir, env: process.env, self: BUNDLE, out: () => {}, err: () => {}, readStdin: async () => "" };
}

test("syncWithin runs the sync in a detached process and reports whether it met the budget", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "budgeted"], new Date().toISOString());
  const saved = process.env.HUDDLE_NO_BACKGROUND;
  delete process.env.HUDDLE_NO_BACKGROUND;
  try {
    // A generous budget: the sync finishes inside it, and its effect is visible on return.
    const ctx = await openContext(inProcessIo(alice));
    assert.equal(await syncWithin(ctx, 10_000), true);
    assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "budgeted");

    // A budget no sync can meet: the caller gets control back at once, and the sync still completes.
    await alice.huddle(["intent", "abandoned wait"], { env: { HUDDLE_NO_BACKGROUND: "1" } });
    const started = Date.now();
    assert.equal(await syncWithin(await openContext(inProcessIo(alice)), 1), false);
    assert.ok(Date.now() - started < 1000, `syncWithin held on for ${Date.now() - started} ms past a 1 ms budget`);
    await until("the abandoned sync to publish anyway", async () => (await actorDocs(h))[0]?.sessions[0]?.intent === "abandoned wait");
  } finally {
    process.env.HUDDLE_NO_BACKGROUND = saved;
    // The detached sync must be done before the harness removes the clone under it.
    await until("the detached sync to finish", () => syncIdle(alice));
  }
});

test("spawnBackgroundSync never throws and does nothing when it would be throttled or is disabled", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const paths = await alice.paths();
  await ok(alice, ["intent", "x"], at(0));
  await ok(alice, ["sync"], at(0));
  const before = await remoteRefs(h);

  spawnBackgroundSync(paths, BUNDLE); // HUDDLE_NO_BACKGROUND=1 in the harness
  spawnBackgroundSync(paths, ""); // no script to run
  spawnBackgroundSync(paths, join(h.root, "missing.mjs"), { config: { ...DEFAULT_CONFIG }, now: new Date(at(1)) }); // throttled: never starts
  await sleep(300);
  assert.equal(await remoteRefs(h), before);
  assert.ok(await syncIdle(alice));
});

// ---------------------------------------------------------------------------
// A background sync that is skipped is made up for (the deferred sync)
// ---------------------------------------------------------------------------

/** Lets a `huddle` call start detached processes, which the harness otherwise turns off. */
const LIVE = { HUDDLE_NO_BACKGROUND: "" };

interface Waiting {
  token: string;
  dueAt: number;
}

async function pendingFile(clone: Clone): Promise<string> {
  return join((await clone.paths()).stateDir, "sync-pending");
}

async function waiting(clone: Clone): Promise<Waiting | null> {
  try {
    return JSON.parse(await readFile(await pendingFile(clone), "utf8")) as Waiting;
  } catch {
    return null;
  }
}

/** The deferred sync has run and its process is done, so the harness can remove the clone. */
const settled = async (clone: Clone) => (await syncIdle(clone)) && (await waiting(clone)) === null;

test("a background sync skipped by the throttle is made up for when the interval ends, by one process however many were skipped", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "one"], at(0));
  await ok(alice, ["sync"], at(0));
  const first = await remoteRefs(h);

  // 12 s later something changes and its background sync falls inside the 15 s interval.
  // That is a plain `git commit` with huddle's hooks: no end of turn follows it.
  await ok(alice, ["intent", "two"], at(12));
  await ok(alice, ["sync", "--background"], at(12), LIVE);
  assert.equal(await remoteRefs(h), first, "a sync 12 s after the last one pushed");
  const one = await waiting(alice);
  assert.ok(one, "the skipped sync left nothing behind to make up for it");
  const left = one.dueAt - Date.now();
  assert.ok(left > 0 && left <= 3000, `the deferred sync is due in ${left} ms; the interval ends in 3000`);

  // A burst (a rebase runs the hook once per commit): the one that is waiting covers them all.
  await ok(alice, ["sync", "--background"], at(12), LIVE);
  await ok(alice, ["sync", "--background"], at(12), LIVE);
  assert.equal((await waiting(alice))?.token, one.token, "a second deferred sync was started while one was waiting");

  await until("the deferred sync to publish", async () => (await remoteRefs(h)) !== first);
  await until("the deferred sync to finish", () => settled(alice));
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "two");
  assert.ok(one.dueAt <= Date.now(), "the deferred sync ran before the interval was over");
});

test("a deferred sync stands down when a sync ran while it waited", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "one"], at(0));
  await ok(alice, ["sync"], at(0));
  await ok(alice, ["intent", "two"], at(13));
  await ok(alice, ["sync", "--background"], at(13), LIVE);
  const one = await waiting(alice);
  assert.ok(one);

  // The end of a turn: a forced sync publishes "two" and takes the deferred sync's job.
  await ok(alice, ["sync", "--background", "--force"], at(13));
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "two");
  assert.equal(await waiting(alice), null, "the round left the deferred sync waiting");
  const second = await remoteRefs(h);

  // Were the waiting process to sync after all, it would publish this.
  await ok(alice, ["intent", "three"], at(13));
  await sleep(Math.max(0, one.dueAt - Date.now()) + 1500);
  assert.equal(await remoteRefs(h), second, "the deferred sync ran although a sync had run while it waited");
  assert.ok(await syncIdle(alice));
});

test("deferredSyncDue: true at the due time while the file holds the token, false as soon as it does not", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["sync"], at(0)); // creates the state directory
  const paths = await alice.paths();
  const file = await pendingFile(alice);
  const write = (token: string, inMs: number) => writeFile(file, JSON.stringify({ token, dueAt: Date.now() + inMs }));

  await rm(file, { force: true });
  assert.equal(await deferredSyncDue(paths, "mine"), false, "no file");
  await write("theirs", 0);
  assert.equal(await deferredSyncDue(paths, "mine"), false, "another process's file");
  await writeFile(file, "{");
  assert.equal(await deferredSyncDue(paths, "mine"), false, "a file that cannot be read");

  await write("mine", 400);
  let started = Date.now();
  assert.equal(await deferredSyncDue(paths, "mine"), true);
  assert.ok(Date.now() - started >= 350, `came back after ${Date.now() - started} ms, before the due time`);

  // A round ran while it waited: the file is gone, or a later skipped sync has put its own there.
  for (const during of [() => rm(file), () => write("theirs", 5000)]) {
    await write("mine", 400);
    started = Date.now();
    const due = deferredSyncDue(paths, "mine");
    await sleep(100);
    await during();
    assert.equal(await due, false);
    assert.ok(Date.now() - started >= 350, "it waits out its time before it looks again");
  }

  // The process that stands down leaves the other one's file where it is, and syncs nothing.
  const theirs = await readFile(file, "utf8");
  const before = await remoteRefs(h);
  await ok(alice, ["intent", "not this process's to publish"], at(1));
  await ok(alice, ["sync", "--background", "--deferred", "mine"], at(1), LIVE);
  assert.equal(await readFile(file, "utf8"), theirs, "a deferred sync that stood down took the waiting one's file with it");
  assert.equal(await remoteRefs(h), before);
  await rm(file);
});

test("a background sync skipped because the lock was held runs once the lock is free", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "behind the lock"], at(0));
  const paths = await alice.paths();

  const held = await withLock(paths, "sync", async () => {
    // What `huddle decide` or `huddle task` does: holds the lock without running a round.
    const r = await alice.huddle(["sync", "--background"], { now: at(1), env: LIVE, timeoutMs: 12_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await remoteRefs(h), "", "the skipped sync published");
    assert.ok(await waiting(alice), "the skipped sync left nothing behind to make up for it");
  });
  assert.ok(held.acquired, "the test could not take the sync lock");

  await until("the deferred sync to publish", async () => (await remoteRefs(h)) !== "");
  await until("the deferred sync to finish", () => settled(alice));
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "behind the lock");
});

test("spawnBackgroundSync with the settings at hand defers a throttled sync instead of dropping it", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const paths = await alice.paths();
  const now = new Date();
  await ok(alice, ["intent", "x"], now.toISOString());
  await ok(alice, ["sync"], now.toISOString());
  const before = await remoteRefs(h);
  await ok(alice, ["intent", "y"], now.toISOString());

  const saved = process.env.HUDDLE_NO_BACKGROUND;
  delete process.env.HUDDLE_NO_BACKGROUND;
  try {
    // The hook engine's call after an edit, 1 s after the last sync, with a 3 s interval.
    spawnBackgroundSync(paths, BUNDLE, { config: { ...DEFAULT_CONFIG, syncIntervalSeconds: 3 }, now: new Date(now.getTime() + 1000) });
    const one = await waiting(alice);
    assert.ok(one, "the throttled sync was dropped");
    const left = one.dueAt - Date.now();
    assert.ok(left > 0 && left <= 2000, `due in ${left} ms; 2000 ms of the interval are left`);
    assert.equal(await remoteRefs(h), before);
    await until("the deferred sync to publish", async () => (await remoteRefs(h)) !== before);
    assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "y");
  } finally {
    process.env.HUDDLE_NO_BACKGROUND = saved;
    await until("the deferred sync to finish", () => settled(alice));
  }
});

test("a deferred sync that died is replaced; one that may still be alive is not", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await ok(alice, ["intent", "one"], at(0));
  await ok(alice, ["sync"], at(0));
  const first = await remoteRefs(h);
  const file = await pendingFile(alice);
  await ok(alice, ["intent", "two"], at(13));

  // Due a moment ago: its process may be waiting for the lock right now. Left alone.
  await writeFile(file, JSON.stringify({ token: "alive", dueAt: Date.now() - 2000 }));
  await ok(alice, ["sync", "--background"], at(13), LIVE);
  assert.equal((await waiting(alice))?.token, "alive");
  // A file that is being written at this moment cannot be read yet. Left alone too.
  await writeFile(file, "");
  await ok(alice, ["sync", "--background"], at(13), LIVE);
  assert.equal(await readFile(file, "utf8"), "");

  // Due a minute ago and still there: its process is gone. The next skipped sync takes over.
  await writeFile(file, JSON.stringify({ token: "dead", dueAt: Date.now() - 60_000 }));
  await ok(alice, ["sync", "--background"], at(13), LIVE);
  const taken = await waiting(alice);
  assert.ok(taken && taken.token !== "dead", "the dead deferred sync was not replaced");
  await until("the deferred sync to publish", async () => (await remoteRefs(h)) !== first);
  await until("the deferred sync to finish", () => settled(alice));
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "two");

  // The same for a file that cannot be read and has been lying there for a minute.
  await ok(alice, ["intent", "three"], at(27));
  await writeFile(file, "{");
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  const second = await remoteRefs(h);
  await ok(alice, ["sync", "--background"], at(27), LIVE);
  assert.ok((await waiting(alice))?.token, "the unreadable leftover was not replaced");
  await until("the deferred sync to publish", async () => (await remoteRefs(h)) !== second);
  await until("the deferred sync to finish", () => settled(alice));
  assert.equal((await actorDocs(h))[0]!.sessions[0]!.intent, "three");
});
