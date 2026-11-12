// MVP sprint, worker 2 (audit A05, A08, A10, A12): task mutations tell the truth.
//
// A05: once a push has gone out, a missing answer does not say whether the
// remote took it. A task change in that position is reported as uncertain (or
// reconciled against what the remote holds), never as "nothing was changed".
//
// Every test here runs against a real bare remote and real clones. The ones
// that lose an acknowledgement do it two ways: in-process, by letting the real
// push through and then reporting it as timed out (runs everywhere), and with a
// remote whose post-receive hook outlasts the CLI's push timeout (Git for
// Windows runs server-side hooks through its own sh, so it runs there too).

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openContext } from "../src/core/context.ts";
import type { Ctx } from "../src/core/context.ts";
import { addTask, claimTask, dropTask, finishTask } from "../src/core/tasks.ts";
import type { TaskResult } from "../src/core/tasks.ts";
import { parseRef } from "../src/core/types.ts";
import { BUNDLE, createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function context(clone: Clone, now: string, session?: string): Promise<Ctx> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HUDDLE_NOW: now };
  if (session !== undefined) env.HUDDLE_SESSION = session;
  return openContext({ cwd: clone.dir, env, self: BUNDLE, out() {}, err() {}, readStdin: async () => "" });
}

/** Every task on the remote, read straight from the bare repository: independent of huddle's own reading. */
async function remoteTasks(h: Harness): Promise<Map<string, { title: string; status: string; owner: { session: string } | null }>> {
  const refs = (await h.remoteGit("for-each-ref", "--format=%(refname)", "refs/huddle/tasks")).split("\n").filter(Boolean);
  const out = new Map<string, { title: string; status: string; owner: { session: string } | null }>();
  for (const ref of refs) out.set(parseRef(ref)!.id, JSON.parse(await h.remoteGit("show", `${ref}:doc.json`)));
  return out;
}

/**
 * Lets the real push for task refs through and then answers as if it had timed
 * out. With `fetchToo` the next network reads fail as well, so nothing can be
 * reconciled.
 */
function loseTaskAcks(ctx: Ctx, opts: { fetchToo?: boolean } = {}): void {
  const transport = ctx.transport;
  const publish = transport.publish.bind(transport);
  const fetchAll = transport.fetchAll.bind(transport);
  let lost = false;
  transport.publish = async (ref, doc, expect) => {
    const result = await publish(ref, doc, expect);
    if (ref.startsWith("refs/huddle/tasks/")) {
      lost = true;
      return { ok: false, reason: "offline" };
    }
    return result;
  };
  transport.fetchAll = async (known) => (opts.fetchToo && lost ? { ok: false, reason: "offline" } : fetchAll(known));
}

function failure(result: TaskResult): Extract<TaskResult, { ok: false }> {
  assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
  return result as Extract<TaskResult, { ok: false }>;
}

describe("A05: a task change whose answer was lost", () => {
  let h: Harness;
  let alice: Clone;
  let bob: Clone;

  before(async () => {
    h = await createHarness();
    alice = await h.clone("alice");
    bob = await h.clone("bob");
  });
  after(() => h.cleanup());

  test("create: the remote took it and nothing can be checked, so the result is unknown with the task's id", async () => {
    const ctx = await context(alice, at(0), "alice-1");
    loseTaskAcks(ctx, { fetchToo: true });
    const result = failure(await addTask(ctx, "Lost acknowledgement", { session: "alice-1", agent: "manual" }));
    assert.equal(result.reason, "unknown");
    assert.ok(result.task, "the result names the task it tried to create");
    const remote = await remoteTasks(h);
    assert.equal(remote.get(result.task.id)?.title, "Lost acknowledgement", "the remote did create it: that is what makes the outcome uncertain");
  });

  test("create: when the remote can be read again, the task is confirmed instead", async () => {
    const ctx = await context(alice, at(1), "alice-1");
    loseTaskAcks(ctx);
    const result = await addTask(ctx, "Confirmed after loss", { session: "alice-1", agent: "manual" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await remoteTasks(h)).get(result.ok ? result.task.id : "")?.title, "Confirmed after loss");
  });

  test("create: running it again with the same id does not add a second task", async () => {
    const ctx = await context(alice, at(2), "alice-1");
    loseTaskAcks(ctx, { fetchToo: true });
    const lost = failure(await addTask(ctx, "Exactly once", { session: "alice-1", agent: "manual" }));
    assert.equal(lost.reason, "unknown");
    const id = lost.task!.id;
    const before = (await remoteTasks(h)).size;

    const again = await alice.huddle(["task", "add", "--id", id, "Exactly once"], { now: at(3), session: "alice-1" });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`\\[${id}\\] Exactly once`));
    assert.equal((await remoteTasks(h)).size, before, "no second task");

    const clash = await alice.huddle(["task", "add", "--id", id, "Something else"], { now: at(3), session: "alice-1" });
    assert.equal(clash.code, 3, clash.stdout + clash.stderr);
    assert.equal((await remoteTasks(h)).get(id)?.title, "Exactly once", "an id that is taken by another title is left alone");
  });

  test("claim, done and drop: unknown with the id when nothing can be checked, and a rerun is safe", async () => {
    const id = /added \[([a-z2-7]{8})\]/.exec((await alice.huddle(["task", "add", "Three steps"], { now: at(10) })).stdout)?.[1];
    assert.ok(id);

    for (const [verb, run, wanted] of [
      ["claim", claimTask, (t: { status: string; owner: { session: string } | null }) => t.status === "claimed" && t.owner?.session === "bob-1"],
      ["drop", dropTask, (t: { status: string }) => t.status === "open"],
      ["claim", claimTask, (t: { status: string }) => t.status === "claimed"],
      ["done", finishTask, (t: { status: string }) => t.status === "done"],
    ] as const) {
      const ctx = await context(bob, at(11), "bob-1");
      loseTaskAcks(ctx, { fetchToo: true });
      const result = failure(await run(ctx, id, { session: "bob-1", agent: "manual" }));
      assert.equal(result.reason, "unknown", `${verb}: ${JSON.stringify(result)}`);
      assert.equal(result.task?.id, id);
      assert.ok(wanted((await remoteTasks(h)).get(id)!), `${verb} did land on the remote`);
      // Running the same command again finds the change already made and changes nothing.
      const rerun = await bob.huddle(["task", verb, id], { now: at(11), session: "bob-1" });
      assert.equal(rerun.code, 0, `${verb} rerun: ${rerun.stdout}${rerun.stderr}`);
    }
  });

  test("real CLI and remote: a create whose answer outlasts the timeout is confirmed, not reported as unchanged", async () => {
    // A remote whose post-receive hook outlasts the push timeout, for task refs
    // only. The ref is updated before post-receive runs, so the task is created
    // and the answer is lost. The CLI then reads the remote back and finds it.
    const marker = join(h.root, "hook-done");
    const delay = join(h.root, "delay.mjs");
    writeFileSync(delay, `import { writeFileSync } from "node:fs";\nsetTimeout(() => writeFileSync(${JSON.stringify(marker)}, "x"), 2500);\n`);
    const slash = (path: string): string => path.replaceAll("\\", "/");
    const hook = join(h.remote, "hooks", "post-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\nslow=\nwhile read old new ref; do case "$ref" in refs/huddle/tasks/*) slow=1 ;; esac; done\n` +
        `if [ -n "$slow" ]; then "${slash(process.execPath)}" "${slash(delay)}"; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const before = (await remoteTasks(h)).size;
    try {
      const result = await alice.huddle(["task", "add", "Slow remote"], { now: at(20), session: "alice-1", env: { HUDDLE_TIMEOUT_MS: "1000" } });
      assert.doesNotMatch(result.stderr + result.stdout, /nothing was changed/);
      const id = /\[([a-z2-7]{8})\] Slow remote/.exec(result.stdout + result.stderr)?.[1];
      assert.ok(id, `the output names the task: ${result.stdout}${result.stderr}`);
      for (let waited = 0; waited < 8000 && !existsSync(marker); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      const remote = await remoteTasks(h);
      assert.equal(remote.size, before + 1, "exactly one task was created");
      assert.equal(remote.get(id)?.title, "Slow remote");
      // Whichever way it was reported, the output never invites a blind retry.
      assert.equal(result.code === 0 || /--id/.test(result.stderr), true, `${result.code}: ${result.stdout}${result.stderr}`);
    } finally {
      writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      for (let waited = 0; waited < 8000 && !existsSync(marker); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});
