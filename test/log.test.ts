// The debug log: one line per entry, safe to print, and rotated without losing history.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { log, MAX_LOG_BYTES } from "../src/core/log.ts";

// As a URL: the workers below import it, and on Windows a path with a drive letter is not something `import` takes.
const LOG_MODULE = new URL("../src/core/log.ts", import.meta.url).href;

async function tempLog(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "huddle-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "huddle", "log");
}

test("an entry is one line with a time, the pid and the scope; the directory is created on demand", async (t) => {
  const logFile = await tempLog(t);
  log({ logFile }, "sync", "fetch failed: offline");
  log({ logFile }, "hook", "could not parse the payload", new Error("Unexpected token"));
  log(null, "sync", "nowhere to write: ignored");
  const lines = (await readFile(logFile, "utf8")).split("\n");
  assert.equal(lines.length, 3, "two entries and the final newline");
  assert.match(lines[0]!, new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z ${process.pid} \\[sync\\] fetch failed: offline$`));
  assert.match(lines[1]!, /\[hook\] could not parse the payload \| Error: Unexpected token\\n {4}at /, "a stack trace stays on the entry's line");
});

test("control and invisible characters never reach the log file raw", async (t) => {
  const logFile = await tempLog(t);
  const esc = String.fromCodePoint(0x1b);
  const rlo = String.fromCodePoint(0x202e);
  const tag = String.fromCodePoint(0xe0041);
  log({ logFile }, "transport", `remote said: ${esc}[2J${esc}[31mFAKE${rlo}x${tag}\r\nsecond line\ttabbed`);
  const text = await readFile(logFile, "utf8");
  assert.equal(text.split("\n").length, 2, "still exactly one line");
  assert.match(text, /remote said: \?\[2J\?\[31mFAKE\?x\?\\nsecond line\?tabbed\n$/);
  for (const ch of [esc, rlo, tag, "\r", "\t"]) assert.equal(text.includes(ch), false);
});

test("a full log is moved to log.1 once, and logging never throws", async (t) => {
  const logFile = await tempLog(t);
  await mkdir(join(logFile, ".."), { recursive: true });
  await writeFile(logFile, "x".repeat(MAX_LOG_BYTES + 1) + "\n");
  log({ logFile }, "sync", "first entry after the log filled up");
  assert.equal((await stat(`${logFile}.1`)).size, MAX_LOG_BYTES + 2);
  assert.match(await readFile(logFile, "utf8"), /^\S+ \d+ \[sync\] first entry after the log filled up\n$/);
  await assert.rejects(stat(`${logFile}.rotating`), { code: "ENOENT" }, "the rotation guard is removed again");

  // A path that cannot be written must not throw either.
  log({ logFile: join(logFile, "not-a-directory", "log") }, "sync", "ignored");
});

test("processes that all find the log full keep the history: only one of them rotates", async (t) => {
  const logFile = await tempLog(t);
  await mkdir(join(logFile, ".."), { recursive: true });
  const gate = join(logFile, "..", "gate");
  const worker = [
    `import { existsSync } from "node:fs";`,
    `import { log } from ${JSON.stringify(LOG_MODULE)};`,
    `const [logFile, gate, id] = process.argv.slice(1);`,
    `while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 1));`,
    `log({ logFile }, "burst", "entry from " + id);`,
  ].join("\n");

  for (let round = 0; round < 6; round++) {
    await rm(`${logFile}.1`, { force: true });
    await rm(gate, { force: true });
    await writeFile(logFile, `history round ${round}\n` + "x".repeat(MAX_LOG_BYTES) + "\n");
    // The exit listeners are attached when the process starts. Attached after the gate opens,
    // they can miss a process that has already finished, and the test then waits for ever.
    const exits = Array.from({ length: 12 }, (_, id) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", worker, logFile, gate, String(id)], { stdio: ["ignore", "ignore", "inherit"] });
      return new Promise<number>((resolve) => {
        child.on("error", () => resolve(-1));
        child.on("exit", (code) => resolve(code ?? -1));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 700)); // let every process load and reach the gate
    await writeFile(gate, "");
    const codes = await Promise.all(exits);
    assert.deepEqual(codes, Array(12).fill(0));

    const history = await readFile(`${logFile}.1`, "utf8");
    assert.ok(history.startsWith(`history round ${round}\n`), `round ${round}: log.1 no longer holds the history; it starts with ${JSON.stringify(history.slice(0, 60))}`);
    const entries = ((await readFile(logFile, "utf8")) + history).split("\n").filter((line) => line.includes("[burst] entry from "));
    assert.equal(entries.length, 12, `round ${round}: every process's entry is in log or log.1`);
  }
});

test("a rotation guard left by a process that died is cleared once it is old", async (t) => {
  const logFile = await tempLog(t);
  await mkdir(`${logFile}.rotating`, { recursive: true });
  await writeFile(logFile, "x".repeat(MAX_LOG_BYTES + 1) + "\n");

  log({ logFile }, "sync", "guard is fresh: no rotation, the entry is still written");
  await assert.rejects(stat(`${logFile}.1`), { code: "ENOENT" });
  assert.match(await readFile(logFile, "utf8"), /guard is fresh/);

  const old = new Date(Date.now() - 60_000);
  await utimes(`${logFile}.rotating`, old, old);
  log({ logFile }, "sync", "this call clears the stale guard");
  log({ logFile }, "sync", "and this one rotates");
  assert.ok((await stat(`${logFile}.1`)).size > MAX_LOG_BYTES);
  assert.match(await readFile(logFile, "utf8"), /^\S+ \d+ \[sync\] and this one rotates\n$/);
});
