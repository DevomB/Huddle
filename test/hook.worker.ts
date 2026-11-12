// A child process for hook.test.ts: a hook process in which something throws
// where nothing catches it, or in which something lives on after the event is
// done. Not a test file itself.
//
//   node test/hook.worker.ts hook <clone> <throw | reject | linger>
//
// The first argument has to be "hook". It is how the guard in the first lines
// of the bundle and the hook command both know that this is a hook process.

import { GUARD } from "../scripts/banner.mjs";
import { getAdapter } from "../src/adapters/index.ts";
import type { HookEvent } from "../src/adapters/types.ts";
import { run } from "../src/commands/hook.ts";
import { processIo } from "../src/core/io.ts";

// What the bundle starts with, before any of its modules has loaded.
new Function(GUARD)();

const [, clone = "", how = ""] = process.argv.slice(2);
const adapter = getAdapter("codex");
if (adapter === undefined) throw new Error("there is no codex adapter to borrow");

// The engine gets an ordinary event. By the time its answer is formatted it
// knows which clone the event is about, and with that where the debug log is.
adapter.parse = (): HookEvent => ({ type: "post-edit", agent: "codex", sessionId: "s-crash", cwd: clone });
adapter.format = () => {
  if (how === "reject") void Promise.reject(new Error("boom in a promise"));
  if (how === "throw") {
    setTimeout(() => {
      throw new Error("boom in a timer");
    }, 0);
  }
  return { stdout: "", stderr: "", exitCode: 0 };
};

// No script to start a background sync with: this process is not the bundle.
await run(["codex"], { ...processIo(""), cwd: clone });

// After a crash the guard ends the process the moment the error surfaces. A
// process that lingers is ended by the limit on its lifetime, which the hook
// command set. Whichever it is: if it has not ended the process by now, it
// never will, and the exit code says so.
setTimeout(() => process.exit(7), how === "linger" ? 30_000 : 10_000);
