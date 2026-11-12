// The first lines of the bundle: what `huddle init` recognizes, and the guard
// that keeps a hook from ever breaking the agent that runs it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { banner, GUARD } from "../scripts/banner.mjs";
import { BUNDLE } from "./harness.ts";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the guard followed by `body` as its own script, the way the bundle starts. */
async function runGuarded(t: { after(fn: () => Promise<void>): void }, body: string, args: string[], env: Record<string, string> = {}, preload = ""): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), "huddle-banner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "script.mjs");
  await writeFile(script, `${preload}\n${GUARD}\n${body}\n`);
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr });
    });
    child.stdin?.end(); // end of input, as after a hook's payload
  });
}

const FAILURES: [string, string][] = [
  ["a throw while the file is still loading", `throw new Error("boom at load");`],
  ["a throw in a timer", `setTimeout(() => { throw new Error("boom in a timer"); }, 5);`],
  ["a rejection nobody awaits", `Promise.reject(new Error("boom in a promise"));`],
  ["a rejection with a value that is not an Error", `Promise.reject("just a string");`],
  ["a throw in a stream callback", `process.stdin.on("end", () => { throw new Error("boom in a callback"); }); process.stdin.resume();`],
];

test("the built bundle starts with the banner", async () => {
  const text = await readFile(BUNDLE, "utf8");
  assert.ok(text.startsWith(banner(pkg.version) + "\n"), "dist/huddle.mjs does not start with scripts/banner.mjs");
  assert.ok(text.startsWith(`#!/usr/bin/env node\n// git-huddle ${pkg.version} - `), "the two lines `huddle init` looks for");
});

for (const [name, body] of FAILURES) {
  test(`hook: ${name} exits 0 and prints nothing`, async (t) => {
    assert.deepEqual(await runGuarded(t, body, ["hook", "claude-code"]), { code: 0, stdout: "", stderr: "" });
  });

  test(`any other command: ${name} still fails loudly`, async (t) => {
    const ran = await runGuarded(t, body, ["status"]);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /boom|just a string/);
  });
}

test("HUDDLE_DEBUG shows what a hook swallowed, and it still exits 0", async (t) => {
  const ran = await runGuarded(t, `throw new Error("boom at load");`, ["hook", "codex"], { HUDDLE_DEBUG: "1" });
  assert.equal(ran.code, 0);
  assert.match(ran.stderr, /^huddle hook: Error: boom at load\n\s+at /);
});

test("a hook that works is not disturbed by the guard", async (t) => {
  const ran = await runGuarded(t, `process.stdout.write("context"); process.exitCode = 0;`, ["hook", "claude-code"]);
  assert.deepEqual(ran, { code: 0, stdout: "context", stderr: "" });
});

test("on a Node older than 20 a hook exits 0 silently and other commands say what is needed", async (t) => {
  // There is no old Node here, so the script is told it runs on one.
  const pretend = `Object.defineProperty(process, "versions", { value: { ...process.versions, node: "18.19.1" } });`;
  const body = `process.stdout.write("the bundle ran");`;
  assert.deepEqual(await runGuarded(t, body, ["hook", "claude-code"], {}, pretend), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await runGuarded(t, body, ["status"], {}, pretend), { code: 1, stdout: "", stderr: "huddle needs Node 20 or newer; this is Node 18.19.1\n" });
  assert.deepEqual(await runGuarded(t, body, ["status"]), { code: 0, stdout: "the bundle ran", stderr: "" });
});
