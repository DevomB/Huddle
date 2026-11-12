// MVP sprint, worker 2 (audit A02, A09; CONTRACT 4.1 reader rule and 4.2):
// not knowing about a teammate is never reported as there being none.
//
// Real bare remote, real clones, the built CLI. Paths come from the harness,
// which puts a space and a non-ASCII letter in every directory name.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openContext } from "../src/core/context.ts";
import { actorRef } from "../src/core/types.ts";
import type { ActorDoc } from "../src/core/types.ts";
import { freshnessWarnings } from "../src/core/render.ts";
import { classifyFreshness, staleAfterSeconds } from "../src/core/view.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness, RunResult } from "./harness.ts";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
/** Seconds after T0. */
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

interface CheckJson {
  checked: number;
  fetchedAt: string | null;
  verdict: "overlap" | "clear" | "unknown";
  schemaVersion: number;
  freshness: string;
  complete: boolean;
  ageSeconds: number | null;
  warnings: string[];
  overlaps: { path: string; sessions: { user: string; via: string; match: string; total?: number }[] }[];
}

function json<T>(result: RunResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`stdout is not JSON (exit ${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
}

async function check(clone: Clone, args: string[], now: string, session?: string): Promise<{ result: RunResult; data: CheckJson }> {
  const result = await clone.huddle(["check", "--json", ...args], { now, session });
  return { result, data: json<CheckJson>(result) };
}

describe("check: overlap, clear or unknown", () => {
  let h: Harness;
  let alice: Clone;

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    await alice.write("src/Auth.ts", "alice\n");
    assert.equal((await alice.huddle(["intent", "Auth rework"], { now: at(0), session: "alice-1" })).code, 0);
    assert.equal((await alice.huddle(["sync", "--force"], { now: at(0), session: "alice-1" })).code, 0);
  });
  after(() => h.cleanup());

  test("a fresh clone that never synced checks a contested path: unknown, exit 1, never a clean verdict", async () => {
    const carol = await h.clone("carol");
    const { result, data } = await check(carol, ["src/Auth.ts"], at(5));
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.deepEqual([data.verdict, data.freshness, data.fetchedAt, data.ageSeconds, data.schemaVersion], ["unknown", "never", null, null, 1]);
    assert.ok(data.warnings.some((warning) => /never synced/.test(warning)), data.warnings.join("\n"));
    assert.match(result.stderr, /huddle: no team state yet/);

    const text = await carol.huddle(["check", "src/Auth.ts"], { now: at(5) });
    assert.equal(text.code, 1);
    assert.match(text.stdout, /^unknown: /);
    assert.doesNotMatch(text.stdout, /no overlap/);

    // The same clone after asking for a refresh sees the overlap.
    const refreshed = await carol.huddle(["check", "--refresh", "--json", "src/Auth.ts"], { now: at(6) });
    assert.equal(refreshed.code, 3, refreshed.stdout + refreshed.stderr);
    assert.deepEqual([json<CheckJson>(refreshed).verdict, json<CheckJson>(refreshed).freshness], ["overlap", "fresh"]);
  });

  test("a fresh empty team is clear, and differs from never-fetched", async () => {
    const lone = await createHarness();
    try {
      const solo = await lone.clone("solo");
      const never = await check(solo, ["src/x.ts"], at(0));
      assert.deepEqual([never.result.code, never.data.verdict, never.data.freshness], [1, "unknown", "never"]);
      assert.equal((await solo.huddle(["sync", "--force"], { now: at(1) })).code, 0);
      const fresh = await check(solo, ["src/x.ts"], at(2));
      assert.deepEqual([fresh.result.code, fresh.data.verdict, fresh.data.freshness, fresh.data.complete, fresh.data.warnings], [0, "clear", "fresh", true, []]);
      assert.equal(fresh.result.stderr, "");
      const text = await solo.huddle(["check", "src/x.ts"], { now: at(2) });
      assert.deepEqual([text.code, text.stdout.trim()], [0, "no overlap: checked 1 path against 0 other sessions"]);
    } finally {
      await lone.cleanup();
    }
  });

  test("a cache older than the stale limit is unknown, and --refresh brings it back", async () => {
    const bob = await h.clone("bob");
    assert.equal((await bob.huddle(["sync", "--force"], { now: at(10) })).code, 0);
    const limit = staleAfterSeconds(15);
    const fresh = await check(bob, ["src/other.ts"], at(10 + limit - 1));
    assert.deepEqual([fresh.data.verdict, fresh.data.freshness], ["clear", "fresh"]);
    const stale = await check(bob, ["src/other.ts"], at(10 + limit));
    assert.deepEqual([stale.result.code, stale.data.verdict, stale.data.freshness, stale.data.ageSeconds], [1, "unknown", "stale", limit]);
    // An overlap is an overlap whatever the freshness.
    const contested = await check(bob, ["src/Auth.ts"], at(10 + limit));
    assert.deepEqual([contested.result.code, contested.data.verdict], [3, "overlap"]);
    const refreshed = await check(bob, ["--refresh", "src/other.ts"], at(10 + limit));
    assert.deepEqual([refreshed.result.code, refreshed.data.verdict, refreshed.data.freshness], [0, "clear", "fresh"]);
  });

  test("an unreadable cache.json is 'unreadable', not empty", async () => {
    const dave = await h.clone("dave");
    assert.equal((await dave.huddle(["sync", "--force"], { now: at(20) })).code, 0);
    writeFileSync((await dave.paths()).cacheFile, "{ not json");
    const { result, data } = await check(dave, ["src/other.ts"], at(21));
    assert.deepEqual([result.code, data.verdict, data.freshness], [1, "unknown", "unreadable"]);
    assert.ok(data.warnings.some((warning) => /could not be read/.test(warning)));
  });

  test("a teammate document this version cannot read makes the picture incomplete", async () => {
    const erin = await h.clone("erin");
    const ctx = await openContext({ cwd: erin.dir, env: { ...(process.env as Record<string, string>), HUDDLE_NOW: at(30) }, self: BUNDLE, out() {}, err() {}, readStdin: async () => "" });
    const { execFileSync } = await import("node:child_process");
    const run = (args: string[], input?: string): string => execFileSync("git", args, { cwd: h.remote, input, encoding: "utf8" }).trim();
    const blob = run(["hash-object", "-w", "--stdin"], JSON.stringify({ v: 7, kind: "actor" }));
    const tree = run(["mktree"], `100644 blob ${blob}\tdoc.json\n`);
    const commit = run(["-c", "user.name=x", "-c", "user.email=x@example.invalid", "commit-tree", "-m", "x", tree]);
    run(["update-ref", "refs/huddle/actors/zzzzzzzz", commit]);
    try {
      const { result, data } = await check(erin, ["--refresh", "src/other.ts"], at(30));
      assert.deepEqual([result.code, data.verdict, data.freshness, data.complete], [1, "unknown", "fresh", false]);
      assert.ok(data.warnings.some((warning) => /could not be read by this version/.test(warning)), data.warnings.join("\n"));
      assert.ok(ctx.identity.actor !== "zzzzzzzz");
    } finally {
      run(["update-ref", "-d", "refs/huddle/actors/zzzzzzzz"]);
    }
  });

  test("end to end: a match on a generated coverage glob is an overlap 'via coverage', and the text says it is conservative", async () => {
    const frank = await h.clone("frank");
    const gina = await h.clone("gina");
    const ctx = await openContext({ cwd: frank.dir, env: { ...(process.env as Record<string, string>), HUDDLE_NOW: at(40) }, self: BUNDLE, out() {}, err() {}, readStdin: async () => "" });
    const doc: ActorDoc = {
      v: 0,
      kind: "actor",
      actor: ctx.identity.actor,
      user: "frank",
      host: "h",
      updatedAt: at(40),
      sessions: [
        {
          id: "frank-1",
          agent: "manual",
          branch: "main",
          intent: "Big change",
          intentSource: "manual",
          files: ["lib/one.ts"],
          claims: ["lib/**"],
          partial: { total: 250, cover: ["lib/**"] },
          startedAt: at(40),
          seenAt: at(40),
        },
      ],
    };
    assert.equal((await ctx.transport.publish(actorRef(ctx.identity.actor), doc, "own")).ok, true);
    const { result, data } = await check(gina, ["--refresh", "lib/deep/two.ts"], at(41));
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.deepEqual(data.overlaps[0]?.sessions.map((s) => [s.user, s.via, s.match, s.total]), [["frank", "coverage", "lib/**", 250]]);
    const text = await gina.huddle(["check", "lib/deep/two.ts"], { now: at(41) });
    assert.match(text.stdout, /has 250 files in flight, more than it lists, and lib\/\*\* covers the rest \(conservative/);
  });

  test("with no path, every file in flight is checked, not only the ones that fit a published document", async () => {
    const ivan = await h.clone("ivan");
    const jane = await h.clone("jane");
    const ctx = await openContext({ cwd: ivan.dir, env: { ...(process.env as Record<string, string>), HUDDLE_NOW: at(60) }, self: BUNDLE, out() {}, err() {}, readStdin: async () => "" });
    const session = { id: "ivan-1", agent: "manual", branch: "main", intent: "Tail", intentSource: "manual" as const, files: ["zz/last.ts"], claims: [], startedAt: at(60), seenAt: at(60) };
    const doc: ActorDoc = { v: 0, kind: "actor", actor: ctx.identity.actor, user: "ivan", host: "h", updatedAt: at(60), sessions: [session] };
    assert.equal((await ctx.transport.publish(actorRef(ctx.identity.actor), doc, "own")).ok, true);
    // More files in flight than LIMITS.files (200); the one that overlaps sorts last, past the cut.
    mkdirSync(join(jane.dir, "a"), { recursive: true });
    mkdirSync(join(jane.dir, "zz"), { recursive: true });
    for (let i = 0; i < 200; i++) writeFileSync(join(jane.dir, "a", `${String(i).padStart(4, "0")}.ts`), "x\n");
    writeFileSync(join(jane.dir, "zz", "last.ts"), "x\n");
    const { result, data } = await check(jane, ["--refresh"], at(61));
    assert.equal(data.checked, 201);
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.equal(data.overlaps[0]?.path, "zz/last.ts");
  });

  test("with no path, a worktree whose own files in flight cannot be listed is unknown, not clear", async () => {
    const kate = await h.clone("kate");
    assert.equal((await kate.huddle(["sync", "--force"], { now: at(70) })).code, 0);
    const baseline = await check(kate, [], at(71));
    assert.deepEqual([baseline.result.code, baseline.data.verdict], [0, "clear"], baseline.result.stdout + baseline.result.stderr);
    // A corrupt index makes "git status" fail; the committed listing still works.
    writeFileSync(join(kate.dir, ".git", "index"), "not an index");
    const { result, data } = await check(kate, [], at(72));
    assert.deepEqual([result.code, data.verdict], [1, "unknown"], result.stdout + result.stderr);
    assert.ok(data.warnings.some((warning) => /own files in flight could not be listed/.test(warning)), data.warnings.join("\n"));
    assert.match(result.stderr, /own files in flight could not be listed/);
    const text = await kate.huddle(["check"], { now: at(72) });
    assert.equal(text.code, 1, text.stdout + text.stderr);
    assert.match(text.stdout, /^unknown: .*own files in flight could not be listed/);
  });

  test("a path given in the platform's own absolute form maps to the repository path, case kept", async () => {
    const hank = await h.clone("hank");
    const native = join(hank.dir, "src", "Auth.ts"); // backslashes and a drive letter on Windows
    const { result, data } = await check(hank, ["--refresh", native], at(50));
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.equal(data.overlaps[0]?.path, "src/Auth.ts");
  });
});

describe("reads carry the same degradation in text and JSON (A09)", () => {
  let h: Harness;
  let bob: Clone;

  before(async () => {
    h = await createHarness();
    bob = await h.clone("bob");
    assert.equal((await bob.huddle(["sync", "--force"], { now: at(0) })).code, 0);
    await bob.git("remote", "set-url", "origin", join(h.root, "missing.git"));
  });
  after(() => h.cleanup());

  // Each command at its own time, past the 15 s throttle of the one before, so that every call tries its refresh.
  for (const [index, command] of [["status"], ["task", "list"], ["decisions"]].entries()) {
    const t = 120 + 120 * index;
    test(`${command.join(" ")}: an offline refresh is a warning in JSON, on stderr, and in text; exit 0`, async () => {
      const asJson = await bob.huddle([...command, "--json"], { now: at(t) });
      assert.equal(asJson.code, 0, asJson.stderr);
      const data = json<{ schemaVersion: number; freshness: string; complete: boolean; ageSeconds: number; warnings: string[]; fetchedAt: string }>(asJson);
      assert.deepEqual([data.schemaVersion, data.freshness, data.ageSeconds, data.fetchedAt], [1, "stale", t, at(0)]);
      const warning = data.warnings.find((line) => line.startsWith('could not reach remote "origin"'));
      assert.ok(warning, data.warnings.join("\n"));
      assert.ok(asJson.stderr.split(/\r?\n/).includes(`huddle: ${warning}`), asJson.stderr);

      const asText = await bob.huddle(command, { now: at(t + 20) }); // past the throttle, same minute of age
      assert.equal(asText.code, 0);
      assert.ok(asText.stderr.split(/\r?\n/).includes(`huddle: ${warning}`), "the same sentence in text mode");
    });
  }
});

describe("overlaps: the reader rule for coverage (pure)", () => {
  test("a claim that is also in partial.cover is 'coverage'; another claim is 'claim'; a file is 'file'", async () => {
    const { buildView, overlaps, teamCompleteness } = await import("../src/core/view.ts");
    const { renderOverlaps } = await import("../src/core/render.ts");
    const session = (id: string, extra: Record<string, unknown>) => ({
      id, agent: "manual", branch: "main", intent: "Work", intentSource: "manual", files: ["lib/one.ts"], claims: ["lib/**", "docs/*.md"], startedAt: at(0), seenAt: at(0), ...extra,
    });
    const cache = {
      fetchedAt: at(0),
      refs: {
        "refs/huddle/actors/frankfrk": { sha: "1".repeat(40), doc: { v: 0, kind: "actor", actor: "frankfrk", user: "frank", host: "h", updatedAt: at(0), sessions: [session("f1", { partial: { total: 250, cover: ["lib/**"] } })] } },
        "refs/huddle/actors/ginagina": { sha: "2".repeat(40), doc: { v: 0, kind: "actor", actor: "ginagina", user: "gina", host: "h", updatedAt: at(0), sessions: [session("g1", { partial: { total: 300, cover: [] } })] } },
      },
    } as unknown as Parameters<typeof buildView>[0];
    const view = buildView(cache, { actor: "selfself", session: "me" }, new Date(T0 + 1000));
    const byUser = (path: string) => overlaps(view, path).map((o) => [o.session.user, o.via, o.match]).sort();
    assert.deepEqual(byUser("lib/deep/two.ts"), [["frank", "coverage", "lib/**"], ["gina", "claim", "lib/**"]]);
    assert.deepEqual(byUser("docs/a.md"), [["frank", "claim", "docs/*.md"], ["gina", "claim", "docs/*.md"]]);
    assert.deepEqual(byUser("lib/one.ts"), [["frank", "file", "lib/one.ts"], ["gina", "file", "lib/one.ts"]]);
    const text = renderOverlaps("lib/deep/two.ts", overlaps(view, "lib/deep/two.ts"), new Date(T0 + 1000));
    assert.match(text, /frank .*has 250 files in flight, more than it lists, and lib\/\*\* covers the rest \(conservative/);
    // gina published part of her files with nothing covering the rest: the picture is incomplete.
    assert.deepEqual(teamCompleteness(cache, view), { complete: false, unreadableActors: 0, uncovered: 1 });
  });
});

describe("classifyFreshness (pure)", () => {
  const now = new Date(T0);
  const base = { cacheState: "ok" as const, now, syncIntervalSeconds: 15 };
  test("thresholds and precedence", () => {
    assert.equal(staleAfterSeconds(15), 60);
    assert.equal(staleAfterSeconds(30), 120);
    assert.equal(staleAfterSeconds(0), 60);
    assert.equal(classifyFreshness({ ...base, fetchedAt: at(-59) }).freshness, "fresh");
    assert.equal(classifyFreshness({ ...base, fetchedAt: at(-60) }).freshness, "stale");
    assert.equal(classifyFreshness({ ...base, fetchedAt: null }).freshness, "never");
    assert.equal(classifyFreshness({ ...base, cacheState: "missing", fetchedAt: null }).freshness, "never");
    assert.equal(classifyFreshness({ ...base, cacheState: "unreadable", fetchedAt: null }).freshness, "unreadable");
    for (const refresh of ["offline", "denied", "busy", "failed"] as const) {
      assert.equal(classifyFreshness({ ...base, fetchedAt: at(-1), refresh }).freshness, "stale", refresh);
    }
    assert.equal(classifyFreshness({ ...base, fetchedAt: at(0), refresh: "ok" }).freshness, "fresh");
    assert.equal(classifyFreshness({ ...base, fetchedAt: at(3600), refresh: "none" }).freshness, "stale", "a fetch stamped an hour ahead says nothing");
    assert.equal(classifyFreshness({ ...base, fetchedAt: at(-90) }).ageSeconds, 90);
  });

  test("the warning for a fetch stamped ahead of this clock does not call it recent", () => {
    const complete = { complete: true, unreadableActors: 0, uncovered: 0 };
    const ahead = freshnessWarnings(classifyFreshness({ ...base, fetchedAt: at(3600) }), complete, "origin");
    assert.equal(ahead.length, 1, ahead.join("\n"));
    assert.doesNotMatch(ahead[0]!, /just now|older than/);
    assert.match(ahead[0]!, /later than this machine's clock.*huddle sync/);
    const old = freshnessWarnings(classifyFreshness({ ...base, fetchedAt: at(-90) }), complete, "origin");
    assert.match(old[0] ?? "", /older than 60s/);
  });
});
