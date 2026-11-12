import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, normalizeDoc } from "../src/core/docs.ts";
import type { Cache, DecisionDoc, TaskDoc } from "../src/core/types.ts";
import { matchWork } from "../src/core/glob.ts";
import { buildView, countTasks, overlaps, taskState } from "../src/core/view.ts";
import { ME, NOW, cacheOf, loadTeam, makeSession } from "./fixtures/cache/team.ts";

const MINUTE = 60_000;

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

test("fixture: every doc in team.json is exactly what parseDoc would let through", () => {
  const cache = loadTeam();
  let docs = 0;
  for (const [ref, entry] of Object.entries(cache.refs)) {
    if (entry.doc === null) continue;
    docs++;
    assert.deepEqual(normalizeDoc(entry.doc), entry.doc, ref);
  }
  assert.equal(docs, 13);
});

test("view: live sessions other than the viewer's own, most recently seen first", () => {
  const view = buildView(loadTeam(), ME, NOW);
  assert.deepEqual(ids(view.sessions), ["sess-me-2", "sess-alice", "sess-bob"]);
  assert.deepEqual(
    view.sessions.map((session) => [session.actor, session.user, session.host, session.sameClone]),
    [
      ["selfself", "me", "my-laptop", true],
      ["alice222", "alice", "alice-mbp", false],
      ["bobb2222", "bob", "bob-thinkpad", false],
    ],
  );
  const alice = view.sessions[1];
  assert.equal(alice?.branch, "feat/auth");
  assert.equal(alice?.intent, "JWT middleware");
  assert.deepEqual(alice?.files, ["src/auth/jwt.ts", "src/auth/middleware/verify-token.ts", "src/auth/middleware/refresh-token.ts", "test/auth/jwt.test.ts"]);
  assert.equal(view.now, "2026-11-12T12:00:00.000Z");
  assert.equal(view.fetchedAt, "2026-11-12T11:59:48.000Z");
  assert.deepEqual(view.self, ME);
});

test("view: TTL edge: a session seen exactly ttlMinutes ago is not live, one millisecond later it is", () => {
  const cache = loadTeam();
  const daveSeen = Date.parse("2026-11-12T11:45:00.000Z");

  const atEdge = buildView(cache, ME, new Date(daveSeen + 15 * MINUTE));
  assert.equal(atEdge.now, NOW.toISOString(), "the fixture's NOW is dave's TTL edge");
  assert.equal(ids(atEdge.sessions).includes("sess-dave"), false);

  const justInside = buildView(cache, ME, new Date(daveSeen + 15 * MINUTE - 1));
  assert.equal(ids(justInside.sessions).includes("sess-dave"), true);

  const justOutside = buildView(cache, ME, new Date(daveSeen + 15 * MINUTE + 1));
  assert.equal(ids(justOutside.sessions).includes("sess-dave"), false);
});

test("view: ttlMinutes is configurable and defaults to 15", () => {
  const cache = loadTeam();
  assert.deepEqual(ids(buildView(cache, ME, NOW, { ttlMinutes: 16 }).sessions), ["sess-me-2", "sess-alice", "sess-bob", "sess-dave"]);
  // bob was seen exactly 2 minutes ago: at ttl 2 that is the edge, so he is out.
  assert.deepEqual(ids(buildView(cache, ME, NOW, { ttlMinutes: 2 }).sessions), ["sess-me-2", "sess-alice"]);
  assert.deepEqual(ids(buildView(cache, ME, NOW, { ttlMinutes: 0 }).sessions), ids(buildView(cache, ME, NOW).sessions), "a nonsensical ttl falls back to the default");
  assert.deepEqual(ids(buildView(cache, ME, new Date(NOW.getTime() + 20 * MINUTE)).sessions), [], "everyone ages out");
});

test("view: a seenAt in the future (clock skew) counts as live", () => {
  const cache = cacheOf([{ actor: "skew2222", user: "skewed", sessions: [makeSession({ id: "s1", seenAt: "2026-11-12T12:04:00.000Z" })] }]);
  assert.deepEqual(ids(buildView(cache, ME, NOW).sessions), ["s1"]);
});

test("view: without a session id the viewer sees every session of its own clone", () => {
  const view = buildView(loadTeam(), { actor: "selfself" }, NOW);
  assert.deepEqual(ids(view.sessions), ["sess-me-2", "sess-me", "sess-alice", "sess-bob"]);
  assert.deepEqual(
    view.sessions.map((session) => session.sameClone),
    [true, true, false, false],
  );
  assert.deepEqual(view.self, { actor: "selfself" });
});

test("view: the same cache seen from another clone", () => {
  const view = buildView(loadTeam(), { actor: "alice222", session: "sess-alice" }, NOW);
  assert.deepEqual(ids(view.sessions), ["sess-me-2", "sess-me", "sess-bob"]);
  assert.equal(view.sessions.some((session) => session.sameClone), false);
});

test("view: refs with no valid doc, a doc for another actor, or an unknown name are ignored", () => {
  const view = buildView(loadTeam(), ME, NOW);
  assert.equal(view.sessions.some((session) => session.user === "mallory"), false, "mallory published under refs/huddle/actors/wrongref");
  assert.deepEqual(overlaps(view, "anything/else.ts"), [], "so her ** claim covers nothing");

  const cache = loadTeam();
  const alice = cache.refs["refs/huddle/actors/alice222"];
  assert.ok(alice);
  // A task doc parked under an actor ref, and an actor doc parked under a task ref.
  cache.refs["refs/huddle/actors/tdocs222"] = cache.refs["refs/huddle/tasks/tdocs222"]!;
  cache.refs["refs/huddle/tasks/alice222"] = alice;
  cache.refs["refs/heads/main"] = alice;
  cache.refs["refs/huddle/actors/alice222/extra"] = alice;
  assert.deepEqual(buildView(cache, ME, NOW), view);
});

test("view: a doc that lists one session id twice contributes it once, as most recently seen", () => {
  const cache = cacheOf([
    {
      actor: "dupe2222",
      user: "dupe",
      sessions: [
        makeSession({ id: "s1", intent: "newer", seenAt: "2026-11-12T11:59:30.000Z" }),
        makeSession({ id: "s1", intent: "older", seenAt: "2026-11-12T11:50:00.000Z" }),
      ],
    },
  ]);
  const view = buildView(cache, ME, NOW);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0]?.intent, "newer");
});

test("view: sessions seen at the same instant come out in a stable order", () => {
  const seenAt = "2026-11-12T11:59:00.000Z";
  const one = cacheOf([
    { actor: "zzzz2222", user: "zed", sessions: [makeSession({ id: "b", seenAt }), makeSession({ id: "a", seenAt })] },
    { actor: "aaaa2222", user: "amy", sessions: [makeSession({ id: "c", seenAt })] },
  ]);
  assert.deepEqual(ids(buildView(one, ME, NOW).sessions), ["c", "a", "b"]);
});

test("view: decisions are the union of all actors', minus superseded ones, newest first", () => {
  const view = buildView(loadTeam(), ME, NOW);
  assert.deepEqual(ids(view.decisions), ["dusepnpm", "dapierrs"]);
  assert.deepEqual(
    view.decisions.map((decision) => [decision.user, decision.actor, decision.agent, decision.text]),
    [
      ["bob", "bobb2222", "codex", "Use pnpm, not npm"],
      ["alice", "alice222", "claude-code", "API errors use problem+json"],
    ],
  );
  assert.equal(view.decisions[0]?.supersedes, "dusenpm2");
});

function decisionsCache(docs: DecisionDoc[]): Cache {
  const cache: Cache = { fetchedAt: null, refs: {} };
  for (const doc of docs) cache.refs[`refs/huddle/decisions/${doc.actor}`] = { sha: "0".repeat(40), doc };
  return cache;
}

test("view: superseding chains, self-reference and dangling references", () => {
  const cache = decisionsCache([
    {
      v: 0,
      kind: "decisions",
      actor: "alice222",
      user: "alice",
      decisions: [
        { id: "aaaa", at: "2026-11-12T08:00:00.000Z", agent: "x", text: "first" },
        { id: "cccc", at: "2026-11-12T10:00:00.000Z", agent: "x", text: "third", supersedes: "bbbb" },
        { id: "self", at: "2026-11-12T07:00:00.000Z", agent: "x", text: "names itself", supersedes: "self" },
      ],
    },
    {
      v: 0,
      kind: "decisions",
      actor: "bobb2222",
      user: "bob",
      decisions: [
        { id: "bbbb", at: "2026-11-12T09:00:00.000Z", agent: "y", text: "second", supersedes: "aaaa" },
        { id: "dddd", at: "2026-11-12T06:00:00.000Z", agent: "y", text: "names nothing", supersedes: "gone" },
      ],
    },
  ]);
  // aaaa <- bbbb <- cccc leaves only cccc; the other two stand.
  assert.deepEqual(ids(buildView(cache, ME, NOW).decisions), ["cccc", "self", "dddd"]);
});

test("view: a superseding decision wins even when its author's clock is behind", () => {
  const cache = decisionsCache([
    { v: 0, kind: "decisions", actor: "alice222", user: "alice", decisions: [{ id: "olda", at: "2026-11-12T10:00:00.000Z", agent: "x", text: "old" }] },
    {
      v: 0,
      kind: "decisions",
      actor: "bobb2222",
      user: "bob",
      decisions: [{ id: "newb", at: "2026-11-12T09:55:00.000Z", agent: "y", text: "new", supersedes: "olda" }],
    },
  ]);
  assert.deepEqual(ids(buildView(cache, ME, NOW).decisions), ["newb"]);
});

test("view: decisions do not expire with their author's session", () => {
  const view = buildView(loadTeam(), ME, new Date(NOW.getTime() + 30 * 24 * 60 * MINUTE));
  assert.deepEqual(ids(view.sessions), []);
  assert.deepEqual(ids(view.decisions), ["dusepnpm", "dapierrs"]);
});

test("view: tasks oldest first, with ownerLive only for a claim whose owner session is live", () => {
  const view = buildView(loadTeam(), ME, NOW);
  assert.deepEqual(
    view.tasks.map((task) => [task.id, task.status, task.ownerLive, taskState(task)]),
    [
      ["tcisetup", "done", false, "done"],
      ["tdocs222", "open", false, "open"],
      ["tlogin22", "claimed", true, "taken"],
      ["ttokens2", "claimed", true, "taken"],
      ["tbilling", "claimed", true, "taken"],
      ["treadme2", "claimed", false, "stale"],
    ],
  );
  assert.deepEqual(countTasks(view), { open: 1, taken: 3, stale: 1, done: 1 });
  assert.equal(view.tasks[2]?.title, "Fix the login redirect");
  assert.equal(view.tasks[2]?.owner?.user, "bob");
});

test("view: a claim goes stale when its owner passes the TTL", () => {
  const later = buildView(loadTeam(), ME, new Date(NOW.getTime() + 13 * MINUTE + 1));
  // bob (seen 11:58:00) is now 15m00.001s old; alice (11:59:20) is still live.
  const state = Object.fromEntries(later.tasks.map((task) => [task.id, taskState(task)]));
  assert.equal(state.tlogin22, "stale");
  assert.equal(state.ttokens2, "taken");
});

function taskCache(task: TaskDoc): Cache {
  return { fetchedAt: null, refs: { [`refs/huddle/tasks/${task.id}`]: { sha: "0".repeat(40), doc: task } } };
}

test("view: the viewer's own claim is live even before its own actor doc reaches the cache", () => {
  const mine: TaskDoc = {
    v: 0,
    kind: "task",
    id: "tmine222",
    title: "Mine",
    status: "claimed",
    owner: { actor: "selfself", user: "me", session: "sess-me", agent: "claude-code" },
    createdBy: { actor: "selfself", user: "me", session: "sess-me", agent: "claude-code" },
    createdAt: "2026-11-12T11:00:00.000Z",
    updatedAt: "2026-11-12T11:00:00.000Z",
  };
  assert.equal(buildView(taskCache(mine), ME, NOW).tasks[0]?.ownerLive, true);
  assert.equal(buildView(taskCache(mine), { actor: "selfself", session: "another" }, NOW).tasks[0]?.ownerLive, false);
  assert.equal(buildView(taskCache(mine), { actor: "selfself" }, NOW).tasks[0]?.ownerLive, false);
});

test("overlaps: a path that is one of another session's files in flight", () => {
  const view = buildView(loadTeam(), ME, NOW);
  const found = overlaps(view, "src/auth/jwt.ts");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.session.user, "alice");
  assert.equal(found[0]?.via, "file");
  assert.equal(found[0]?.match, "src/auth/jwt.ts");
});

test("overlaps: a path matched by another session's claim glob", () => {
  const view = buildView(loadTeam(), ME, NOW);
  const found = overlaps(view, "src/pages/signup.tsx");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.session.user, "bob");
  assert.equal(found[0]?.session.id, "sess-bob");
  assert.equal(found[0]?.via, "claim");
  assert.equal(found[0]?.match, "src/pages/**");
  assert.deepEqual(overlaps(view, "src/pages/admin/users/list.tsx").map((overlap) => overlap.match), ["src/pages/**"]);
  assert.deepEqual(overlaps(view, "src/pagesx/signup.tsx"), []);
});

test("overlaps: a file hit wins over a claim hit, one entry per session", () => {
  const view = buildView(loadTeam(), ME, NOW);
  const found = overlaps(view, "src/pages/login.tsx");
  assert.deepEqual(
    found.map((overlap) => [overlap.session.user, overlap.via, overlap.match]),
    [["bob", "file", "src/pages/login.tsx"]],
  );
});

test("overlaps: only live sessions other than the viewer's own count", () => {
  const view = buildView(loadTeam(), ME, NOW);
  assert.deepEqual(overlaps(view, "README.md"), [], "dave has README.md in flight but is past the TTL");
  assert.deepEqual(overlaps(view, "docs/guide.md"), [], "and his docs/** claim went with him");
  assert.deepEqual(overlaps(view, "src/ratelimit.ts"), [], "the viewer's own file");
  assert.deepEqual(overlaps(view, "src/unrelated.ts"), []);

  const sibling = overlaps(view, "src/billing/invoice.ts");
  assert.equal(sibling.length, 1, "another session in the same clone does count");
  assert.equal(sibling[0]?.session.sameClone, true);

  const earlier = buildView(loadTeam(), ME, new Date(NOW.getTime() - 1));
  assert.deepEqual(overlaps(earlier, "README.md").map((overlap) => overlap.session.user), ["dave"]);
  assert.deepEqual(overlaps(earlier, "docs/guide.md").map((overlap) => [overlap.via, overlap.match]), [["claim", "docs/**"]]);
});

test("overlaps: every overlapping session is reported, in view order", () => {
  const cache = cacheOf([
    { actor: "aaaa2222", user: "amy", sessions: [makeSession({ id: "a", files: ["src/shared.ts"], seenAt: "2026-11-12T11:58:00.000Z" })] },
    { actor: "bbbb2222", user: "ben", sessions: [makeSession({ id: "b", claims: ["src"], seenAt: "2026-11-12T11:59:00.000Z" })] },
    { actor: "cccc2222", user: "cat", sessions: [makeSession({ id: "c", files: ["lib/other.ts"], claims: ["lib/**"] })] },
  ]);
  const found = overlaps(buildView(cache, ME, NOW), "src/shared.ts");
  assert.deepEqual(
    found.map((overlap) => [overlap.session.user, overlap.via, overlap.match]),
    [
      ["ben", "claim", "src"],
      ["amy", "file", "src/shared.ts"],
    ],
  );
});

test("overlaps: the path is normalized, and may name a directory", () => {
  const view = buildView(loadTeam(), ME, NOW);
  assert.deepEqual(overlaps(view, "./src//auth/jwt.ts").map((overlap) => overlap.session.user), ["alice"]);
  assert.deepEqual(overlaps(view, "/src/auth/jwt.ts/").map((overlap) => overlap.session.user), ["alice"]);

  const dir = overlaps(view, "src/auth");
  assert.deepEqual(
    dir.map((overlap) => [overlap.session.user, overlap.via, overlap.match]),
    [["alice", "file", "src/auth/jwt.ts"]],
    "a directory overlaps whoever has a file in flight under it",
  );
  assert.deepEqual(overlaps(view, "src/au"), [], "a name prefix is not a directory");
  assert.deepEqual(overlaps(view, ""), []);
  assert.deepEqual(overlaps(view, "."), []);
});

test("overlaps: a teammate's file entry need not be in git's form to be recognized", () => {
  const cache = cacheOf([
    { actor: "aaaa2222", user: "amy", sessions: [makeSession({ id: "a", files: ["./src//shared.ts", ".env", "/abs/like.ts", "dir/"] })] },
  ]);
  const view = buildView(cache, ME, NOW);
  assert.deepEqual(overlaps(view, "src/shared.ts").map((overlap) => overlap.match), ["./src//shared.ts"]);
  assert.deepEqual(overlaps(view, ".env").map((overlap) => overlap.match), [".env"]);
  assert.deepEqual(overlaps(view, "abs/like.ts").map((overlap) => overlap.match), ["/abs/like.ts"]);
  assert.deepEqual(overlaps(view, "dir").map((overlap) => overlap.match), ["dir/"]);
  assert.deepEqual(overlaps(view, "src/other.ts"), []);
});

test("overlaps: one actor at every cap, checked against a deep path, costs one short walk per claim", () => {
  // The worst a single teammate's doc can be after the doc gate: 50 sessions,
  // each with 50 claims of nearly 400 characters, every claim a chain of
  // globstars and wildcards that the path's segments keep half-matching.
  const unit = "**/*a*a*/";
  const chain = unit.repeat(Math.floor(380 / unit.length));
  const sessions = Array.from({ length: LIMITS.sessions }, (_, s) =>
    makeSession({ id: `s${s}`, claims: Array.from({ length: LIMITS.claims }, (_, c) => `${chain}zz${s}x${c}`) }),
  );
  assert.ok(sessions[0]!.claims[0]!.length > 380 && sessions[0]!.claims[0]!.length <= LIMITS.path);
  const view = buildView(cacheOf([{ actor: "maxx2222", user: "max", sessions }]), ME, NOW);
  const deep = `${Array.from({ length: 60 }, (_, i) => `xa${i}ya${i}z`).join("/")}/file.ts`;

  // This runs on the pre-edit path, which has 150 ms. The cost is counted
  // rather than timed, because a stopwatch bound fails on a busy machine.
  const before = { ...matchWork };
  assert.deepEqual(overlaps(view, deep), []);
  const walks = matchWork.walks - before.walks;
  const steps = matchWork.steps - before.steps;
  // Matching once per path prefix instead would be 61 walks per claim and
  // about 25,000 steps per claim; one walk reads the path about once (830).
  assert.equal(walks, LIMITS.sessions * LIMITS.claims, "one walk per claim, however deep the path");
  assert.ok(steps <= walks * 3 * deep.length, `${walks} claims against a ${deep.length}-character path took ${steps} steps`);

  // The same claims do match where they should.
  const hit = `${Array.from({ length: 42 }, (_, i) => `xa${i}ya${i}z`).join("/")}/zz7x3/src/file.ts`;
  assert.deepEqual(
    overlaps(view, hit).map((overlap) => [overlap.session.id, overlap.via, overlap.match]),
    [["s7", "claim", `${chain}zz7x3`]],
  );
});

test("view: building a view neither changes the cache nor depends on anything but its arguments", () => {
  const cache = loadTeam();
  const first = buildView(cache, ME, NOW);
  assert.deepEqual(cache, loadTeam());
  assert.deepEqual(buildView(cache, ME, NOW), first);

  // Nothing in the view is shared with the cache: editing one leaves the other alone.
  for (const session of first.sessions) {
    session.files.push("edited-by-a-caller.ts");
    session.claims.push("edited/**");
  }
  for (const task of first.tasks) {
    task.createdBy.user = "edited";
    if (task.owner !== null) task.owner.user = "edited";
  }
  for (const decision of first.decisions) decision.text = "edited";
  assert.deepEqual(cache, loadTeam());
});

test("view: an empty cache gives an empty view; an invalid clock is an error", () => {
  const view = buildView({ fetchedAt: null, refs: {} }, ME, NOW);
  assert.deepEqual(view, { now: "2026-11-12T12:00:00.000Z", fetchedAt: null, self: ME, sessions: [], decisions: [], tasks: [] });
  assert.deepEqual(countTasks(view), { open: 0, taken: 0, stale: 0, done: 0 });
  assert.throws(() => buildView({ fetchedAt: null, refs: {} }, ME, new Date("not a date")), TypeError);
});
