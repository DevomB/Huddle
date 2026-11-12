// T0.1 exit test: the bundle runs, prints its version, and every command that
// is still a stub exits 1 with "not implemented: <command>".

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHarness } from "./harness.ts";

const COMMANDS = ["init", "doctor", "sync", "status", "intent", "claim", "release", "check", "decide", "decisions", "task", "hook"];
const commandsDir = fileURLToPath(new URL("../src/commands/", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

test("--version prints the package version", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  for (const flag of ["--version", "-V", "version"]) {
    const r = await clone.huddle([flag]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${pkg.version}\n`);
    assert.equal(r.stderr, "");
  }
});

test("--help lists every command in plan.md §3 and exits 0", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const r = await clone.huddle(["--help"]);
  assert.equal(r.code, 0, r.stderr);
  for (const name of COMMANDS) assert.match(r.stdout, new RegExp(`^  ${name}\\s+\\S`, "m"), `help is missing ${name}`);
});

test("there is exactly one command file per command", () => {
  const files = readdirSync(commandsDir).map((file) => file.replace(/\.ts$/, "")).sort();
  assert.deepEqual(files, [...COMMANDS].sort());
});

test("no command prints usage to stderr and exits 2", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const r = await clone.huddle([]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /Usage: huddle <command>/);
});

test("an unknown command exits 2 and names it", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  for (const name of ["frobnicate", "constructor", "__proto__", "toString"]) {
    const r = await clone.huddle([name]);
    assert.equal(r.code, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`unknown command "${name}"`));
  }
});

// Self-adjusting: when a task implements a command it removes the
// notImplemented() call from that file, and the command drops out of this test
// without anyone editing it.
test("every command that is still a stub exits 1 with `not implemented: <command>`", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  for (const name of COMMANDS) {
    const source = readFileSync(`${commandsDir}${name}.ts`, "utf8");
    if (!source.includes(`notImplemented("${name}"`)) continue;
    const r = await clone.huddle([name]);
    assert.equal(r.code, 1, `${name} should exit 1`);
    assert.equal(r.stderr, `not implemented: ${name}\n`);
    assert.equal(r.stdout, "");
  }
});
