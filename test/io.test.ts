// Reading a hook's payload from stdin without waiting longer than the hook may take.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readAll } from "../src/core/io.ts";

/** Resolves with the text and how long it took. */
async function timed(run: Promise<string>): Promise<{ text: string; ms: number }> {
  const started = performance.now();
  const text = await run;
  return { text, ms: performance.now() - started };
}

test("readAll returns everything once the input ends", async () => {
  const stream = new PassThrough();
  const reading = timed(readAll(stream, 5000));
  stream.write("first ");
  stream.write("second");
  stream.end();
  const { text, ms } = await reading;
  assert.equal(text, "first second");
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test("readAll gives up at the caller's deadline and returns what arrived", async () => {
  const stream = new PassThrough();
  const reading = timed(readAll(stream, 120));
  stream.write('{"hook_event_name":"PreToolUse"');
  const { text, ms } = await reading;
  assert.equal(text, '{"hook_event_name":"PreToolUse"');
  assert.ok(ms >= 100 && ms < 1500, `a 120 ms deadline took ${ms} ms`);
});

test("in json mode a complete payload is returned at once, even when the writer keeps the pipe open", async () => {
  const stream = new PassThrough();
  const reading = timed(readAll(stream, 5000, true));
  stream.write('{"session_id":"abc","tool_input":{"file_path":"src/a.ts"}}\n');
  const { text, ms } = await reading;
  assert.deepEqual(JSON.parse(text), { session_id: "abc", tool_input: { file_path: "src/a.ts" } });
  assert.ok(ms < 1000, `should not wait for the 5000 ms timeout; took ${ms} ms`);
});

test("in json mode a payload that arrives in pieces is returned when the last piece completes it", async () => {
  const stream = new PassThrough();
  const reading = timed(readAll(stream, 5000, true));
  // The first piece ends with "}" but is not a whole document yet.
  stream.write('{"a":{"b":1}');
  await new Promise((resolve) => setTimeout(resolve, 60));
  stream.write(',"multibyte":"caf');
  stream.write(Buffer.from([0xc3])); // first byte of a two-byte character, split across writes
  stream.write(Buffer.from([0xa9]));
  stream.write('"}');
  const { text, ms } = await reading;
  assert.deepEqual(JSON.parse(text), { a: { b: 1 }, multibyte: `caf${String.fromCodePoint(0xe9)}` });
  assert.ok(ms >= 50 && ms < 1500, `took ${ms} ms`);
});

test("without json mode a complete JSON text still waits for the end of input", async () => {
  // Free text on stdin may start with something that parses; only a hook may stop early.
  const stream = new PassThrough();
  const reading = timed(readAll(stream, 150));
  stream.write("[1]");
  const { text, ms } = await reading;
  assert.equal(text, "[1]");
  assert.ok(ms >= 130, `returned after ${ms} ms, before the deadline`);
});

test("a terminal on stdin reads as empty at once, and a stream error ends the read", async () => {
  const tty = Object.assign(new PassThrough(), { isTTY: true });
  assert.equal(await readAll(tty, 5000), "");

  const broken = new PassThrough();
  const reading = timed(readAll(broken, 5000));
  broken.write("partial");
  await new Promise((resolve) => setImmediate(resolve));
  broken.destroy(new Error("EIO"));
  const { text, ms } = await reading;
  assert.equal(text, "partial");
  assert.ok(ms < 1000);
});
