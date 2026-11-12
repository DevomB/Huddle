// init prints command lines for the user to type. On Windows they must work
// as typed in PowerShell 7 (the documented shell) and, where possible, CMD.

import assert from "node:assert/strict";
import { test } from "node:test";
import { shellWord } from "../src/commands/init.ts";

test("POSIX: inert words bare, anything else in single quotes", () => {
  assert.equal(shellWord(".huddle/huddle.mjs", "linux"), ".huddle/huddle.mjs");
  assert.equal(shellWord("../..", "linux"), "../..");
  assert.equal(shellWord("my dir/ü.md", "linux"), "'my dir/ü.md'");
  assert.equal(shellWord("it's", "linux"), "'it'\\''s'");
});

test("Windows: one spelling for PowerShell and CMD, PowerShell quoting only when double quotes would expand", () => {
  assert.equal(shellWord(".huddle/huddle.mjs", "win32"), ".huddle/huddle.mjs");
  assert.equal(shellWord("../..", "win32"), "../..");
  assert.equal(shellWord("my dir/ü.md", "win32"), '"my dir/ü.md"', "double quotes: both shells");
  assert.equal(shellWord("a,b.md", "win32"), '"a,b.md"', "a bare comma is a PowerShell array");
  assert.equal(shellWord("it's.md", "win32"), `"it's.md"`);
  assert.equal(shellWord("100%.md", "win32"), "'100%.md'", "% expands in CMD's double quotes");
  assert.equal(shellWord("$HOME.md", "win32"), "'$HOME.md'", "$ expands in PowerShell's double quotes");
  assert.equal(shellWord("it's $x", "win32"), "'it''s $x'", "PowerShell doubles a single quote");
});

test("the platform default is this process's", () => {
  assert.equal(shellWord("a b"), process.platform === "win32" ? '"a b"' : "'a b'");
});
