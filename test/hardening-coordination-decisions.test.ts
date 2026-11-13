// Hardening, worker 2 (audit A04-1, LEADER.md D6): decisions that replace one
// another in a ring must not all disappear. By "replaced means hidden" every
// member of a ring is hidden and nothing stands in their place. `decide` only
// replaces a decision it can see, so only a damaged or hand-made log holds a
// ring; the reader still must not lose rules over it. The members stay in
// force, each marked as conflicting with the others, no clock picks one, and
// one ordinary `decide --supersedes` on any member settles it.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openContext } from "../src/core/context.ts";
import { renderDecisions } from "../src/core/render.ts";
import { decisionsRef } from "../src/core/types.ts";
import type { Cache, Decision } from "../src/core/types.ts";
import { buildView } from "../src/core/view.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function decision(id: string, seconds: number, supersedes?: string): Decision {
  return { id, at: at(seconds), agent: "manual", text: `Rule ${id}`, ...(supersedes === undefined ? {} : { supersedes }) };
}

/** One log per entry of `logs`, keyed by actor id. */
function cacheOf(logs: Record<string, Decision[]>): Cache {
  const refs: Cache["refs"] = {};
  for (const [actor, decisions] of Object.entries(logs)) {
    refs[decisionsRef(actor)] = { sha: "1".repeat(40), doc: { v: 0, kind: "decisions", actor, user: actor.slice(0, 4), decisions } };
  }
  return { fetchedAt: at(0), refs };
}

function inForce(cache: Cache): Record<string, string[] | null> {
  const view = buildView(cache, { actor: "selfself", session: "me" }, new Date(T0 + 60_000));
  return Object.fromEntries(view.decisions.map((d) => [d.id, d.conflictsWith ?? null]));
}

describe("A04-1: a ring of replacements (pure)", () => {
  test("two that replace each other both stay in force, each conflicting with the other; an unrelated one is untouched", () => {
    const cache = cacheOf({ aaaaaaaa: [decision("bbbbbbbb", 1, "cccccccc"), decision("cccccccc", 2, "bbbbbbbb"), decision("dddddddd", 3)] });
    assert.deepEqual(inForce(cache), { dddddddd: null, cccccccc: ["bbbbbbbb"], bbbbbbbb: ["cccccccc"] });
  });

  test("a ring of three across two logs: all three, each with the other two; the order of the logs does not matter", () => {
    const a = [decision("aaaa2222", 1, "bbbb2222")];
    const b = [decision("bbbb2222", 2, "cccc2222"), decision("cccc2222", 3, "aaaa2222")];
    const expected = { cccc2222: ["aaaa2222", "bbbb2222"], bbbb2222: ["aaaa2222", "cccc2222"], aaaa2222: ["bbbb2222", "cccc2222"] };
    assert.deepEqual(inForce(cacheOf({ xxxxxxxx: a, yyyyyyyy: b })), expected);
    assert.deepEqual(inForce(cacheOf({ yyyyyyyy: b, xxxxxxxx: a })), expected);
  });

  test("a ring that a decision outside it replaces is settled: only that decision is in force", () => {
    const cache = cacheOf({ aaaaaaaa: [decision("bbbbbbbb", 1, "cccccccc"), decision("cccccccc", 2, "bbbbbbbb"), decision("eeeeeeee", 3, "bbbbbbbb")] });
    assert.deepEqual(inForce(cache), { eeeeeeee: null });
  });

  test("unchanged without a ring: a chain leaves its last decision, a self-reference hides nothing, two rivals conflict", () => {
    assert.deepEqual(inForce(cacheOf({ aaaaaaaa: [decision("aaaaaaaa", 1), decision("bbbbbbbb", 2, "aaaaaaaa"), decision("cccccccc", 3, "bbbbbbbb")] })), { cccccccc: null });
    assert.deepEqual(inForce(cacheOf({ aaaaaaaa: [decision("ffffffff", 1, "ffffffff")] })), { ffffffff: null });
    assert.deepEqual(inForce(cacheOf({ aaaaaaaa: [decision("aaaaaaaa", 1), decision("bbbbbbbb", 2, "aaaaaaaa"), decision("cccccccc", 3, "aaaaaaaa")] })), {
      cccccccc: ["bbbbbbbb"],
      bbbbbbbb: ["cccccccc"],
    });
  });

  test("the text says they replace one another and how to settle it, not that they replace a third", () => {
    const view = buildView(cacheOf({ aaaaaaaa: [decision("bbbbbbbb", 1, "cccccccc"), decision("cccccccc", 2, "bbbbbbbb")] }), { actor: "selfself" }, new Date(T0 + 60_000));
    const text = renderDecisions(view);
    assert.match(text, /^- \[cccccccc\] Rule cccccccc\. .* CONFLICT: this and \[bbbbbbbb\] replace one another in a ring, and huddle does not pick one\. .*huddle decide --supersedes <its id>/m);
    assert.match(text, /^- \[bbbbbbbb\] Rule bbbbbbbb\. .* CONFLICT: this and \[cccccccc\] replace one another in a ring/m);
    assert.doesNotMatch(text, /both replace/);
  });
});

describe("A04-1 end to end: a ring in a log on the remote", () => {
  let h: Harness;
  let bob: Clone;

  before(async () => {
    h = await createHarness();
    bob = await h.clone("bob");
    // A log nobody's huddle would write, put on the remote through the real transport.
    const ctx = await openContext({ cwd: bob.dir, env: { ...(process.env as Record<string, string>), HUDDLE_NOW: at(0) }, self: BUNDLE, out() {}, err() {}, readStdin: async () => "" });
    const doc = { v: 0 as const, kind: "decisions" as const, actor: "ringring", user: "mallory", decisions: [decision("bbbbbbbb", 1, "cccccccc"), decision("cccccccc", 2, "bbbbbbbb")] };
    const published = await ctx.transport.publish(decisionsRef("ringring"), doc, "absent");
    assert.ok(published.ok, JSON.stringify(published));
  });
  after(() => h.cleanup());

  test("every reader lists both members as conflicting, and one decide --supersedes on either settles it", async () => {
    const listed = await bob.huddle(["decisions"], { now: at(10) });
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal((listed.stdout.match(/replace one another in a ring/g) ?? []).length, 2, listed.stdout);
    const status = await bob.huddle(["status", "--cached"], { now: at(10) });
    assert.equal((status.stdout.match(/replace one another in a ring/g) ?? []).length, 2, status.stdout);

    // Replacing a member is allowed: nothing stands in its place yet.
    const settled = await bob.huddle(["decide", "--supersedes", "bbbbbbbb", "Rule settled together"], { now: at(20) });
    assert.equal(settled.code, 0, settled.stdout + settled.stderr);
    const after = JSON.parse((await bob.huddle(["decisions", "--json", "--cached"], { now: at(21) })).stdout) as { decisions: { text: string; conflictsWith?: string[] }[] };
    assert.deepEqual(after.decisions.map((d) => [d.text, d.conflictsWith ?? null]), [["Rule settled together", null]]);
  });
});
