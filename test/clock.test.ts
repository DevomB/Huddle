import assert from "node:assert/strict";
import { test } from "node:test";
import { ageMs, now, nowIso, parseIso } from "../src/core/clock.ts";

test("HUDDLE_NOW pins the clock, as ISO-8601 or epoch milliseconds", () => {
  assert.equal(now({ HUDDLE_NOW: "2026-01-02T03:04:05Z" }).toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(now({ HUDDLE_NOW: "1767323045000" }).toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(nowIso({ HUDDLE_NOW: "2026-01-02T03:04:05Z" }), "2026-01-02T03:04:05.000Z");
});

test("without HUDDLE_NOW, or with one that is not a date, the clock is the real one", () => {
  for (const env of [{}, { HUDDLE_NOW: "" }, { HUDDLE_NOW: "next tuesday" }]) {
    const before = Date.now();
    const value = now(env).getTime();
    assert.ok(value >= before && value <= Date.now() + 1);
  }
});

test("ageMs measures from a timestamp to a point in time", () => {
  const at = new Date("2026-01-01T00:15:00Z");
  assert.equal(ageMs("2026-01-01T00:00:00Z", at), 15 * 60 * 1000);
  assert.equal(ageMs("2026-01-01T00:16:00Z", at), -60 * 1000);
  assert.ok(Number.isNaN(ageMs("garbage", at)));
  assert.ok(Number.isNaN(parseIso(undefined as unknown as string)));
});
