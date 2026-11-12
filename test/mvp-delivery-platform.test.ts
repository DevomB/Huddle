// CI sets HUDDLE_EXPECT_PLATFORM per job. This test fails if a job that claims
// to be the Windows (or Linux) run is executing anywhere else, so a green
// Windows job is evidence that the suite actually ran on win32.

import assert from "node:assert/strict";
import { test } from "node:test";

test("the tests run on the platform CI claims", (t) => {
  const expected = process.env.HUDDLE_EXPECT_PLATFORM;
  if (!expected) {
    t.skip("HUDDLE_EXPECT_PLATFORM is not set (local run)");
    return;
  }
  assert.equal(process.platform, expected);
});
