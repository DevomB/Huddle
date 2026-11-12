// MVP sprint, worker 2 (audit A04; MVP_SCOPE: gate the unsafe supersession,
// no redesign). Two actors replacing one decision at the same moment both
// land, because each author's log is compare-and-swapped on its own. huddle
// must not silently pick one, nor present them as two independent rules:
// both stay listed, each marked as conflicting, in every reader. Replacing
// the contested decision once more is refused; the existing --supersedes on
// the one that should go settles it.
//
// The race is held at the real publication seam of both writers, against a
// real bare remote and real clones.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openContext } from "../src/core/context.ts";
import type { Ctx } from "../src/core/context.ts";
import { addDecision } from "../src/core/decisions.ts";
import { renderBriefing } from "../src/core/render.ts";
import { currentView } from "../src/core/session.ts";
import { sync } from "../src/core/sync.ts";
import { decisionsRef } from "../src/core/types.ts";
import type { Cache } from "../src/core/types.ts";
import { buildView } from "../src/core/view.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function context(clone: Clone, now: string): Promise<Ctx> {
  return openContext({ cwd: clone.dir, env: { ...(process.env as Record<string, string>), HUDDLE_NOW: now }, self: BUNDLE, out() {}, err() {}, readStdin: async () => "" });
}

/** Holds every writer at its real publish call for its own decision log until all of them have arrived. */
function holdAtPublish(contexts: Ctx[]): void {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const ctx of contexts) {
    const publish = ctx.transport.publish.bind(ctx.transport);
    ctx.transport.publish = async (ref, doc, expect) => {
      if (ref === decisionsRef(ctx.identity.actor)) {
        if (++arrivals === contexts.length) release();
        await gate;
      }
      return publish(ref, doc, expect);
    };
  }
}

async function viewOf(clone: Clone, now: string) {
  const ctx = await context(clone, now);
  await sync(ctx, { force: true });
  return currentView(ctx, "observer");
}

describe("A04: concurrent replacement of one decision is marked as a conflict", () => {
  let h: Harness;
  let seed: Clone;
  let bob: Clone;
  let carol: Clone;
  let first = "";
  let bobs = "";
  let carols = "";

  before(async () => {
    h = await createHarness();
    seed = await h.clone("seed");
    bob = await h.clone("bob");
    carol = await h.clone("carol");
    const initial = await addDecision(await context(seed, at(0)), "Use format A");
    assert.ok(initial.ok);
    first = initial.decision.id;
  });
  after(() => h.cleanup());

  test("both replacements land; every reader shows both, each marked as conflicting with the other", async () => {
    const [b, c] = await Promise.all([context(bob, at(10)), context(carol, at(10))]);
    holdAtPublish([b, c]);
    const results = await Promise.all([
      addDecision(b, "Use format B exclusively", { supersedes: first }),
      addDecision(c, "Use format C exclusively", { supersedes: first }),
    ]);
    assert.ok(results[0].ok && results[1].ok, JSON.stringify(results));
    bobs = results[0].decision.id;
    carols = results[1].decision.id;

    const view = await viewOf(seed, at(20));
    const byText = new Map(view.decisions.map((d) => [d.text, d]));
    assert.equal(byText.has("Use format A"), false, "the replaced decision is gone");
    assert.deepEqual(byText.get("Use format B exclusively")?.conflictsWith, [carols]);
    assert.deepEqual(byText.get("Use format C exclusively")?.conflictsWith, [bobs]);

    const listed = await seed.huddle(["decisions"], { now: at(20) });
    assert.equal(listed.code, 0, listed.stderr);
    for (const [mine, theirs] of [[bobs, carols], [carols, bobs]]) {
      assert.match(listed.stdout, new RegExp(`^- \\[${mine}\\] .* CONFLICT: this and \\[${theirs}\\] both replace \\[${first}\\], and huddle does not pick one\\.`, "m"));
    }
    const status = await seed.huddle(["status"], { now: at(20) });
    assert.equal((status.stdout.match(/CONFLICT: this and/g) ?? []).length, 2);
    const briefing = renderBriefing(view).text;
    assert.equal((briefing.match(/CONFLICT: this and/g) ?? []).length, 2, briefing);
    const json = JSON.parse((await seed.huddle(["decisions", "--json"], { now: at(20) })).stdout) as { decisions: { id: string; conflictsWith?: string[] }[] };
    assert.deepEqual(json.decisions.map((d) => [d.id, d.conflictsWith]).sort(), [[bobs, [carols]], [carols, [bobs]]].sort());
  });

  test("replacing the contested decision once more is refused, exit 3, and says how to settle it", async () => {
    const again = await seed.huddle(["decide", "--supersedes", first, "Use format D"], { now: at(21) });
    assert.equal(again.code, 3, again.stdout + again.stderr);
    assert.match(again.stderr, /They conflict, and huddle does not pick one\. The decision was NOT recorded/);
    assert.match(again.stderr, /huddle decide --supersedes <its id>/);
    assert.equal((await viewOf(seed, at(22))).decisions.some((d) => d.text === "Use format D"), false);
  });

  test("the existing --supersedes on the one that should go settles it for everyone", async () => {
    const yielded = await carol.huddle(["decide", "--supersedes", carols, "Use format B exclusively, as bob decided"], { now: at(30) });
    assert.equal(yielded.code, 0, yielded.stdout + yielded.stderr);
    const view = await viewOf(bob, at(31));
    assert.deepEqual(view.decisions.filter((d) => d.conflictsWith).map((d) => d.id), [], "no conflict is left");
    assert.deepEqual(view.decisions.map((d) => d.text).sort(), ["Use format B exclusively", "Use format B exclusively, as bob decided"]);
    assert.doesNotMatch((await bob.huddle(["decisions"], { now: at(31) })).stdout, /CONFLICT/);
  });

  test("sequential, nonconflicting decisions still propagate and render", async () => {
    const one = await seed.huddle(["decide", "API errors use problem+json"], { now: at(80) });
    assert.equal(one.code, 0, one.stderr);
    const id = /^decision ([a-z2-7]{8}) recorded/.exec(one.stdout)?.[1];
    assert.ok(id);
    const two = await bob.huddle(["decide", "--supersedes", id, "API errors use problem+json, version 2"], { now: at(81) });
    assert.equal(two.code, 0, two.stdout + two.stderr);
    const listed = await carol.huddle(["decisions"], { now: at(82) });
    assert.match(listed.stdout, /API errors use problem\+json, version 2\. \(bob/);
    assert.doesNotMatch(listed.stdout, /API errors use problem\+json\. \(/);
    assert.doesNotMatch(listed.stdout, /problem\+json.*CONFLICT/);
  });
});

describe("the conflict mark (pure)", () => {
  const log = (actor: string, decisions: { id: string; text: string; supersedes?: string; at: number }[]): Cache["refs"][string] => ({
    sha: "1".repeat(40),
    doc: { v: 0, kind: "decisions", actor, user: actor.slice(0, 4), decisions: decisions.map((d) => ({ id: d.id, at: at(d.at), agent: "manual", text: d.text, ...(d.supersedes ? { supersedes: d.supersedes } : {}) })) },
  });
  const view = (b: number, c: number) =>
    buildView(
      {
        fetchedAt: at(0),
        refs: {
          "refs/huddle/decisions/aaaaaaaa": log("aaaaaaaa", [{ id: "aaaaaaaa", text: "A", at: 0 }]),
          "refs/huddle/decisions/bbbbbbbb": log("bbbbbbbb", [{ id: "bbbbbbbb", text: "B", supersedes: "aaaaaaaa", at: b }]),
          "refs/huddle/decisions/cccccccc": log("cccccccc", [{ id: "cccccccc", text: "C", supersedes: "aaaaaaaa", at: c }, { id: "dddddddd", text: "D", at: 5 }]),
        },
      } as Cache,
      { actor: "zzzzzzzz", session: "me" },
      new Date(T0 + 60_000),
    );

  test("both rivals are listed and marked, whatever the clocks say; an unrelated decision is not", () => {
    for (const [b, c] of [[1, 2], [2, 1], [3, 3]] as [number, number][]) {
      const marks = Object.fromEntries(view(b, c).decisions.map((d) => [d.id, d.conflictsWith ?? null]));
      assert.deepEqual(marks, { bbbbbbbb: ["cccccccc"], cccccccc: ["bbbbbbbb"], dddddddd: null }, `clocks ${b}, ${c}`);
    }
  });
});
