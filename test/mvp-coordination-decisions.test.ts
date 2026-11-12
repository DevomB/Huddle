// MVP sprint, worker 2 (audit A04; CONTRACT 4.4): two actors replacing one
// decision at the same moment make an unresolved conflict, never two rules in
// force. The race is held at the real publication seam of both writers, with
// a real bare remote and real clones.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openContext } from "../src/core/context.ts";
import type { Ctx } from "../src/core/context.ts";
import { addDecision } from "../src/core/decisions.ts";
import { renderBriefing } from "../src/core/render.ts";
import { currentView } from "../src/core/session.ts";
import { sync } from "../src/core/sync.ts";
import { decisionsRef } from "../src/core/types.ts";
import { settleDecisions } from "../src/core/view.ts";
import type { ViewDecision } from "../src/core/view.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function context(clone: Clone, now: string): Promise<Ctx> {
  return openContext({ cwd: clone.dir, env: { ...(process.env as Record<string, string>), HUDDLE_NOW: now }, self: BUNDLE, out() {}, err() {}, readStdin: async () => "" });
}

/** Holds every writer at its real publish call for its own decision log until all `count` have arrived. */
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

describe("A04: concurrent replacement of one decision", () => {
  let h: Harness;
  let seed: Clone;
  let bob: Clone;
  let carol: Clone;
  let first = "";

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

  test("both replacements land, and the team sees one unresolved conflict, not two rules", async () => {
    const [b, c] = await Promise.all([context(bob, at(10)), context(carol, at(10))]);
    holdAtPublish([b, c]);
    const results = await Promise.all([
      addDecision(b, "Use format B exclusively", { supersedes: first }),
      addDecision(c, "Use format C exclusively", { supersedes: first }),
    ]);
    assert.ok(results.every((result) => result.ok), JSON.stringify(results));

    const view = await viewOf(seed, at(20));
    assert.deepEqual(view.decisions.map((d) => d.text), [], "neither competing rule is in force, and A is replaced");
    assert.equal(view.conflicts.length, 1);
    const conflict = view.conflicts[0]!;
    assert.equal(conflict.over, first);
    assert.equal(conflict.replaced?.text, "Use format A");
    assert.deepEqual(conflict.candidates.map((d) => [d.text, d.user]), [["Use format B exclusively", "bob"], ["Use format C exclusively", "carol"]]);

    // Every reader says the same: the list, status and the agent's briefing.
    const listed = await seed.huddle(["decisions"], { now: at(20) });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`Unresolved decision conflict over \\[${first}\\]`));
    assert.match(listed.stdout, /None of them is in force/);
    assert.match(listed.stdout, new RegExp(`huddle decide --resolve ${first} "<the rule>"`));
    assert.doesNotMatch(listed.stdout, /^- \[[a-z2-7]{8}\] Use format B exclusively\. \(/m, "not listed as a rule");
    const status = await seed.huddle(["status"], { now: at(20) });
    assert.match(status.stdout, /Unresolved decision conflict/);
    const briefing = renderBriefing(view).text;
    assert.match(briefing, /Unresolved decision conflict over/);
    assert.doesNotMatch(briefing, /Decisions \(/, "the briefing lists no competing rule as a decision");
    const json = JSON.parse((await seed.huddle(["decisions", "--json"], { now: at(20) })).stdout) as { decisions: unknown[]; conflicts?: unknown };
    assert.deepEqual(json.decisions, []);

    // Replacing the contested decision again is refused with the way out.
    const again = await seed.huddle(["decide", "--supersedes", first, "Use format D"], { now: at(21) });
    assert.equal(again.code, 3, again.stdout + again.stderr);
    assert.match(again.stderr, /unresolved conflict/);
    assert.match(again.stderr, new RegExp(`--resolve ${first}`));
  });

  test("--resolve settles it: one rule in force for everyone, and a later --supersedes of it replaces it whole", async () => {
    const settled = await bob.huddle(["decide", "--resolve", first, "Use format B exclusively"], { now: at(30) });
    assert.equal(settled.code, 0, settled.stdout + settled.stderr);
    assert.match(settled.stdout, new RegExp(`settling the conflict over ${first}`));

    const view = await viewOf(carol, at(31));
    assert.deepEqual(view.conflicts, []);
    assert.deepEqual(view.decisions.map((d) => d.text), ["Use format B exclusively"]);
    const rule = view.decisions[0]!;
    assert.ok(rule.sameAs && rule.sameAs.length >= 1, "the same rule was recorded for each competing decision");

    const next = await carol.huddle(["decide", "--supersedes", rule.id, "Use format E"], { now: at(40) });
    assert.equal(next.code, 0, next.stdout + next.stderr);
    const later = await viewOf(seed, at(41));
    assert.deepEqual([later.decisions.map((d) => d.text), later.conflicts.length], [["Use format E"], 0]);

    // --resolve of something that is in no conflict changes nothing.
    const none = await seed.huddle(["decide", "--resolve", later.decisions[0]!.id, "Whatever"], { now: at(42) });
    assert.equal(none.code, 2, none.stdout + none.stderr);
    assert.match(none.stderr, /in no unresolved conflict/);
  });

  test("two different resolutions at the same moment are a conflict again; no clock picks one", async () => {
    const base = await addDecision(await context(seed, at(50)), "Logs go to stdout");
    assert.ok(base.ok);
    const [b1, c1] = await Promise.all([context(bob, at(51)), context(carol, at(51))]);
    holdAtPublish([b1, c1]);
    await Promise.all([addDecision(b1, "Logs go to a file", { supersedes: base.decision.id }), addDecision(c1, "Logs go to syslog", { supersedes: base.decision.id })]);
    const [b2, c2] = await Promise.all([context(bob, at(60)), context(carol, at(61))]);
    holdAtPublish([b2, c2]);
    const both = await Promise.all([
      addDecision(b2, "Logs go to a file", { resolve: base.decision.id }),
      addDecision(c2, "Logs go to syslog", { resolve: base.decision.id }),
    ]);
    assert.ok(both.every((result) => result.ok), JSON.stringify(both));
    const view = await viewOf(seed, at(70));
    const conflict = view.conflicts.find((candidate) => candidate.over === base.decision.id);
    assert.ok(conflict, "still unresolved");
    assert.deepEqual([...new Set(conflict.candidates.map((d) => d.text))], ["Logs go to a file", "Logs go to syslog"]);
    assert.ok(!view.decisions.some((d) => d.text.startsWith("Logs go to")));
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
  });
});

describe("settleDecisions (pure)", () => {
  const d = (id: string, text: string, supersedes?: string, atSeconds = 0, actor = "aaaaaaaa"): ViewDecision => ({
    id, at: at(atSeconds), agent: "manual", text, actor, user: actor.slice(0, 3), ...(supersedes === undefined ? {} : { supersedes }),
  });

  test("a chain is one rule; a fork is a conflict at its top, following the chains below it", () => {
    assert.deepEqual(settleDecisions([d("aaaaaaaa", "A"), d("bbbbbbbb", "B", "aaaaaaaa")]).inForce.map((x) => x.id), ["bbbbbbbb"]);
    const forked = settleDecisions([d("aaaaaaaa", "A"), d("bbbbbbbb", "B", "aaaaaaaa"), d("cccccccc", "C", "aaaaaaaa"), d("dddddddd", "D", "bbbbbbbb")]);
    assert.deepEqual(forked.inForce, []);
    assert.deepEqual(forked.conflicts.map((c) => [c.over, c.kind, c.candidates.map((x) => x.id)]), [["aaaaaaaa", "fork", ["cccccccc", "dddddddd"]]]);
  });

  test("the result does not depend on the clocks", () => {
    const early = settleDecisions([d("aaaaaaaa", "A", undefined, 0), d("bbbbbbbb", "B", "aaaaaaaa", 1), d("cccccccc", "C", "aaaaaaaa", 999)]);
    const late = settleDecisions([d("aaaaaaaa", "A", undefined, 0), d("bbbbbbbb", "B", "aaaaaaaa", 999), d("cccccccc", "C", "aaaaaaaa", 1)]);
    assert.deepEqual(early.conflicts.map((c) => c.candidates.map((x) => x.id)), late.conflicts.map((c) => c.candidates.map((x) => x.id)));
    assert.deepEqual([early.inForce, late.inForce], [[], []]);
  });

  test("competing replacements that say the same thing are one rule, under its smallest id", () => {
    const same = settleDecisions([d("aaaaaaaa", "A"), d("cccccccc", "Same", "aaaaaaaa"), d("bbbbbbbb", "Same", "aaaaaaaa")]);
    assert.deepEqual(same.conflicts, []);
    assert.deepEqual(same.inForce.map((x) => [x.id, x.sameAs]), [["bbbbbbbb", ["cccccccc"]]]);
  });

  test("a replacement of a decision nobody can read still competes with another one", () => {
    const orphans = settleDecisions([d("bbbbbbbb", "B", "zzzzzzzz"), d("cccccccc", "C", "zzzzzzzz")]);
    assert.deepEqual(orphans.conflicts.map((c) => [c.over, c.replaced, c.candidates.length]), [["zzzzzzzz", null, 2]]);
    assert.deepEqual(settleDecisions([d("bbbbbbbb", "B", "zzzzzzzz")]).inForce.map((x) => x.id), ["bbbbbbbb"]);
  });

  test("a loop is never silently gone: with nothing at its end it is a conflict; something at its end is in force", () => {
    const loop = settleDecisions([d("aaaaaaaa", "A", "bbbbbbbb"), d("bbbbbbbb", "B", "aaaaaaaa")]);
    assert.deepEqual(loop.inForce, []);
    assert.deepEqual(loop.conflicts.map((c) => [c.over, c.kind, c.candidates.map((x) => x.id).sort()]), [["aaaaaaaa", "loop", ["aaaaaaaa", "bbbbbbbb"]]]);
    const out = settleDecisions([d("aaaaaaaa", "A", "bbbbbbbb"), d("bbbbbbbb", "B", "aaaaaaaa"), d("cccccccc", "C", "aaaaaaaa")]);
    assert.deepEqual(out.inForce.map((x) => x.id), ["cccccccc"]);
    const selfish = settleDecisions([d("aaaaaaaa", "A", "aaaaaaaa")]);
    assert.deepEqual(selfish.inForce.map((x) => x.id), ["aaaaaaaa"], "a decision that names itself replaces nothing");
  });
});
