// A child process for the store and identity tests, so that they exercise real
// cross-process behavior. Not a test file itself.
//
//   node test/store.worker.ts <mode> <worktree> <commonDir> [args...]

import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { getIdentity } from "../src/core/identity.ts";
import { pathsFor } from "../src/core/paths.ts";
import { touchSession, updateLocal, withLock } from "../src/core/store.ts";
import type { LockOptions } from "../src/core/store.ts";

const [mode = "", worktree = "", commonDir = "", ...rest] = process.argv.slice(2);
const paths = pathsFor(worktree, commonDir, commonDir);

// With HUDDLE_TEST_GATE set, the worker announces "ready" and then waits for a start time (epoch
// milliseconds) on stdin, spinning until exactly then. A test uses this to release many workers
// in the same instant, instead of in the order the OS happened to start them. Without it, process
// start-up jitter is far larger than the races these tests are after.
if (process.env.HUDDLE_TEST_GATE) {
  process.stdout.write("ready\n");
  const line = await new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk)));
  });
  process.stdin.destroy();
  const startAt = Number(line);
  while (performance.timeOrigin + performance.now() < startAt) {
    // Spin: a timer would spread the workers out again.
  }
}

switch (mode) {
  // touch <id>: upsert one session
  case "touch": {
    const id = rest[0] ?? "";
    await touchSession(paths, { id, worktree, agent: "worker", intent: `work of ${id}` });
    break;
  }
  // bump <count>: append <count> unique entries to one shared session, one update each, printing each one
  case "bump": {
    const count = Number(rest[0]);
    for (let i = 0; i < count; i++) {
      await updateLocal(paths, (state) => {
        let shared = state.sessions.find((s) => s.id === "shared");
        if (!shared) {
          const stamp = new Date().toISOString();
          shared = {
            id: "shared",
            agent: "worker",
            branch: "",
            intent: "",
            intentSource: "none",
            files: [],
            claims: [],
            startedAt: stamp,
            seenAt: stamp,
            worktree,
          };
          state.sessions.push(shared);
        }
        shared.files.push(`${process.pid}-${i}`);
      });
      // Printed only after the update has returned, so a printed entry is a committed one.
      process.stdout.write(`${process.pid}-${i}\n`);
    }
    break;
  }
  // die-holding: take the local lock and die inside the update, leaving the lock behind
  case "die-holding":
    await updateLocal(
      paths,
      () => {
        process.kill(process.pid, "SIGKILL");
      },
      { waitMs: 60_000 },
    );
    break;
  // counter <file> <count>: an unprotected read-modify-write that only the lock makes safe
  case "counter": {
    const file = rest[0] ?? "";
    const count = Number(rest[1]);
    for (let i = 0; i < count; i++) {
      const result = await withLock(
        paths,
        "counter",
        async () => {
          const value = Number(await readFile(file, "utf8"));
          await sleep(1);
          await writeFile(file, String(value + 1));
        },
        { waitMs: 60_000 },
      );
      if (!result.acquired) process.exit(3);
    }
    break;
  }
  // hammer <count>: rewrite local.json many times with a large payload
  case "hammer": {
    const count = Number(rest[0]);
    const filler = "x".repeat(4000);
    for (let i = 0; i < count; i++) {
      await touchSession(paths, { id: "hammer", worktree, intent: `${i} ${filler}` });
    }
    break;
  }
  // hold <lock> <ms> [staleMs]: take a lock, announce it, keep it for <ms>
  case "hold": {
    const opts: LockOptions = { waitMs: 0 };
    if (rest[2]) opts.staleMs = Number(rest[2]);
    const result = await withLock(
      paths,
      rest[0] ?? "",
      async () => {
        process.stdout.write("held\n");
        await sleep(Number(rest[1]));
      },
      opts,
    );
    if (!result.acquired) process.exit(3);
    break;
  }
  // identity: print this clone's actor id
  case "identity":
    process.stdout.write((await getIdentity(paths)).actor);
    break;
  default:
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
}
