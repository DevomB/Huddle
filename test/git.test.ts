// The safety rules in src/core/git.ts (plan.md §3, "Hard rules for every git call").

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { STOP_GRACE_MS, endRunningGits, git, GitError, gitEnv, gitOut, hardenSshCommand } from "../src/core/git.ts";
import { createHarness, posixOnly } from "./harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("git() never throws: failures come back as a result", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");

  const failed = await git(["rev-parse", "--verify", "no-such-ref"], { cwd: clone.dir });
  assert.equal(failed.ok, false);
  assert.notEqual(failed.code, 0);
  assert.equal(failed.timedOut, false);

  const noDir = await git(["status"], { cwd: join(h.root, "does-not-exist") });
  assert.equal(noDir.ok, false);
  assert.equal(noDir.code, -1);
  assert.match(noDir.stderr, /could not start git/);

  const fine = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: clone.dir });
  assert.deepEqual({ ok: fine.ok, code: fine.code, stdout: fine.stdout }, { ok: true, code: 0, stdout: "main\n" });
});

test("gitOut() trims the trailing newline and throws GitError on failure", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: clone.dir }), "main");
  await assert.rejects(gitOut(["rev-parse", "--verify", "no-such-ref"], { cwd: clone.dir }), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.equal(error.result.ok, false);
    assert.match(error.message, /git rev-parse --verify no-such-ref exited/);
    return true;
  });
});

test("input is fed to stdin; without input stdin is closed", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal(await gitOut(["hash-object", "--stdin"], { cwd: clone.dir, input: "hello\n" }), "ce013625030ba8dba906f756967f9e9ca394464a");
  // Reads stdin to EOF: would hang if stdin were left open.
  const r = await git(["hash-object", "--stdin"], { cwd: clone.dir, timeoutMs: 5000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout.trim(), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("a process that exits without reading its stdin does not crash the caller", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const big = "x".repeat(4 * 1024 * 1024);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => git(["rev-parse", "--verify", "no-such-ref"], { cwd: clone.dir, input: big })),
  );
  for (const r of results) assert.equal(r.ok, false);
});

test("inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE do not redirect a call", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  const saved = { ...process.env };
  t.after(() => {
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  // What git sets when it runs a hook in bob's clone.
  process.env.GIT_DIR = join(bob.dir, ".git");
  process.env.GIT_WORK_TREE = bob.dir;
  process.env.GIT_INDEX_FILE = join(bob.dir, ".git", "index");
  // resolve(): Git for Windows prints C:/x/y where node:path gives C:\x\y. Same directory.
  assert.equal(resolve(await gitOut(["rev-parse", "--show-toplevel"], { cwd: alice.dir })), alice.dir);
  // An explicit env entry is still honored.
  assert.equal(resolve(await gitOut(["rev-parse", "--show-toplevel"], { cwd: alice.dir, env: { GIT_DIR: join(bob.dir, ".git"), GIT_WORK_TREE: bob.dir } })), bob.dir);
});

test("every call runs with gc and maintenance off, no prompts, no optional locks, unlocalized output", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal(await gitOut(["config", "--get", "gc.auto"], { cwd: clone.dir }), "0");
  assert.equal(await gitOut(["config", "--get", "maintenance.auto"], { cwd: clone.dir }), "false");
  const env = await gitOut(["-c", "alias.printenv=!env", "printenv"], { cwd: clone.dir });
  assert.match(env, /^GIT_TERMINAL_PROMPT=0$/m);
  assert.match(env, /^GIT_OPTIONAL_LOCKS=0$/m);
  assert.match(env, /^LC_ALL=C$/m);
});

test("git status through the wrapper does not rewrite the index", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const indexFile = join(clone.dir, ".git", "index");
  const hash = async () => createHash("sha256").update(await readFile(indexFile)).digest("hex");

  // Same content, new mtime: the index entry is now stat-dirty, which a plain
  // `git status` fixes by rewriting the index.
  const future = new Date(Date.now() + 60_000);
  await utimes(join(clone.dir, "README.md"), future, future);
  const before = await hash();
  assert.equal(await gitOut(["status", "--porcelain"], { cwd: clone.dir }), "");
  assert.equal(await hash(), before, "index was rewritten by the wrapper");

  // Control: without the rule, git does rewrite it. Proves the assertion above can fail.
  await gitOut(["status", "--porcelain"], { cwd: clone.dir, env: { GIT_OPTIONAL_LOCKS: "1" } });
  assert.notEqual(await hash(), before, "control: a plain git status should have refreshed the index");
});

test("a call that outlives its timeout is killed along with its children", posixOnly("sh, sleep and $! (an MSYS pid on Windows); the Node test below covers Windows"), async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const pidFile = join(h.root, "child.pid");
  // git runs the alias through a shell, which starts sleep: a grandchild, like ssh under git.
  const alias = `alias.hang=!sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`;
  const started = Date.now();
  const r = await git(["-c", alias, "hang"], { cwd: clone.dir, timeoutMs: 500 });
  const elapsed = Date.now() - started;
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /timed out after 500 ms/);
  assert.ok(elapsed < 3000, `returned after ${elapsed} ms`);

  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(pid > 0);
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false, "the grandchild survived the timeout");
});

test("a call that outlives its timeout is killed along with its children: Node grandchild, every platform", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const pidFile = join(h.root, "grandchild.pid");
  // git runs the alias, which runs node, which starts another node that would sleep for 30 s: a grandchild of git,
  // like ssh or a credential helper. On Windows git.exe is itself a launcher, so this is one level deeper still.
  const hang = join(h.root, "hang.mjs");
  await writeFile(
    hang,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setTimeout(() => {}, 30000);",
      "",
    ].join("\n"),
  );
  // Git for Windows runs a "!" alias with its own sh too, which takes forward slashes; each path is one quoted word.
  const word = (path: string) => `'${path.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
  const started = Date.now();
  const r = await git(["-c", `alias.hang=!${word(process.execPath)} ${word(hang)}`, "hang"], { cwd: clone.dir, timeoutMs: 3000 });
  const elapsed = Date.now() - started;
  assert.equal(r.timedOut, true, r.stderr);
  assert.equal(r.ok, false);
  assert.ok(elapsed < 8000, `returned after ${elapsed} ms`);

  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(pid > 0);
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false, "the grandchild survived the timeout");
  // And the clone can be removed: on Windows a survivor would hold its directory open (EBUSY).
});

// ---------------------------------------------------------------------------
// How a git call is ended: SIGTERM, and SIGKILL if git still runs STOP_GRACE_MS later
// ---------------------------------------------------------------------------

interface Sent {
  group: number;
  signal: string;
  at: number;
}

/** The signals sent to process groups from now until the test ends. git.ts signals a group, never a single process. */
function groupSignals(t: TestContext): Sent[] {
  const sent: Sent[] = [];
  const original = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0) sent.push({ group: -pid, signal: String(signal), at: performance.now() });
    return original.call(process, pid, signal);
  }) as typeof process.kill;
  t.after(() => {
    process.kill = original;
  });
  return sent;
}

/**
 * A shell script that runs in place of git: found first on the PATH of the environment this returns. It sets its
 * trap, then writes its process id (the number of its process group) where `pid` reads it, then does what it does.
 * So once `pid` has an answer, a SIGTERM meets the trap.
 */
async function standIn(dir: string, trap: string, ...body: string[]) {
  const bin = join(dir, "bin");
  const pidFile = join(dir, "git.pid");
  const notes = join(dir, "notes");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "git"), ["#!/bin/sh", trap, 'echo "$$" > "$STAND_IN_PID"', ...body, ""].join("\n"));
  await chmod(join(bin, "git"), 0o755);
  return {
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, STAND_IN_PID: pidFile, STAND_IN_NOTES: notes },
    pid: async (): Promise<number> => {
      for (let i = 0; i < 200; i++) {
        const text = await readFile(pidFile, "utf8").catch(() => "");
        if (text.endsWith("\n")) return Number(text.trim());
        await sleep(10);
      }
      throw new Error("the stand-in for git never started");
    },
    notes: async (): Promise<string> => readFile(notes, "utf8").catch(() => ""),
  };
}

const POSIX = process.platform !== "win32";

test("a git that does not stop on SIGTERM is killed STOP_GRACE_MS after it", posixOnly("signals to a process group (process.kill(-pid)), which Windows does not have"), async (t) => {
  const h = await createHarness(t);
  const sent = groupSignals(t);
  // A git that is stuck where a signal cannot reach it is the same thing as one that ignores SIGTERM. So is its child.
  const stuck = await standIn(h.root, "trap '' TERM", "exec sleep 30");

  // A second is long enough for the stand-in to set its trap, however busy the machine.
  const result = await git(["fetch"], { cwd: h.root, timeoutMs: 1000, env: stuck.env });
  assert.deepEqual([result.ok, result.timedOut, result.code], [false, true, -1]);
  const pid = await stuck.pid();
  t.after(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  assert.deepEqual(
    sent.map(({ group, signal }) => [group, signal]),
    [[pid, "SIGTERM"]],
    "at the timeout git is asked to stop, and not killed yet",
  );
  await sleep(STOP_GRACE_MS / 2);
  assert.equal(alive(pid), true, "it ignores SIGTERM");

  for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false, "it was never killed");
  assert.deepEqual(
    sent.map(({ group, signal }) => [group, signal]),
    [
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ],
  );
  const waited = (sent[1]?.at ?? 0) - (sent[0]?.at ?? 0);
  // A timer may fire a millisecond or two early by performance.now() (CI saw 1999 ms for 2000).
  assert.ok(waited >= STOP_GRACE_MS - 10, `SIGKILL came ${Math.round(waited)} ms after SIGTERM`);
});

test("a git that stops on SIGTERM gets the time to, and no SIGKILL: not before it is done, and not after it is gone", posixOnly("signals to a process group (process.kill(-pid)), which Windows does not have"), async (t) => {
  const h = await createHarness(t);
  const sent = groupSignals(t);
  // Like git removing its lock files: it takes a moment, and then it exits by itself. Its child goes with the group.
  const tidy = await standIn(
    h.root,
    `trap 'echo stopping >> "$STAND_IN_NOTES"; sleep 1; echo stopped >> "$STAND_IN_NOTES"; exit 143' TERM`,
    "sleep 30 &",
    "wait",
  );

  const result = await git(["fetch"], { cwd: h.root, timeoutMs: 1000, env: tidy.env });
  assert.equal(result.timedOut, true);
  const pid = await tidy.pid();
  t.after(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false);
  assert.equal(await tidy.notes(), "stopping\nstopped\n", "it was killed before it was done");

  // By now the group's number may belong to another process: it must not get the SIGKILL that would have been due.
  await sleep(STOP_GRACE_MS + 500);
  assert.deepEqual(
    sent.map(({ group, signal }) => [group, signal]),
    [[pid, "SIGTERM"]],
  );
});

test("endRunningGits ends the calls that are still running the way a timeout does, and leaves the ones that are done alone", posixOnly("signals to a process group (process.kill(-pid)), which Windows does not have"), async (t) => {
  const h = await createHarness(t);
  const sent = groupSignals(t);

  // A call that is done is not running any more: nothing is sent to it.
  assert.equal((await git(["--version"], { cwd: h.root })).ok, true);
  endRunningGits();
  assert.equal(sent.length, 0);

  // Two calls that are running, with no timeout near: one git stops on SIGTERM, the other does not.
  const tidy = await standIn(join(h.root, "tidy"), `trap 'echo stopped >> "$STAND_IN_NOTES"; exit 143' TERM`, "sleep 30 &", "wait");
  const stuck = await standIn(join(h.root, "stuck"), "trap '' TERM", "exec sleep 30");
  const calls = [git(["fetch"], { cwd: h.root, env: tidy.env }), git(["fetch"], { cwd: h.root, env: stuck.env })];
  const pids = [await tidy.pid(), await stuck.pid()];
  t.after(() => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  const ended = performance.now();
  endRunningGits();

  const results = await Promise.all(calls);
  assert.deepEqual(
    results.map((result) => [result.ok, result.timedOut]),
    [
      [false, false],
      [false, false],
    ],
  );
  assert.equal(await tidy.notes(), "stopped\n");
  assert.equal(alive(pids[1] ?? 0), false);
  await sleep(Math.max(0, ended + STOP_GRACE_MS + 500 - performance.now()));
  const signals = sent.map(({ group, signal }) => [group, signal]);
  assert.deepEqual(signals.filter(([group]) => group === pids[0]), [[pids[0], "SIGTERM"]], "the git that stopped got no SIGKILL");
  assert.deepEqual(
    signals.filter(([group]) => group === pids[1]),
    [
      [pids[1], "SIGTERM"],
      [pids[1], "SIGKILL"],
    ],
    "the git that did not stop was killed",
  );
  const kill = sent.find(({ group, signal }) => group === pids[1] && signal === "SIGKILL");
  assert.ok((kill?.at ?? 0) - ended >= STOP_GRACE_MS - 1, "not before STOP_GRACE_MS");
});

test("network calls get the no-prompt environment", () => {
  const local = gitEnv({ PATH: "/bin" });
  assert.equal(local.GIT_ASKPASS, undefined);
  assert.equal(local.GIT_SSH_COMMAND, undefined);

  const net = gitEnv({ PATH: "/bin" }, { network: true });
  assert.equal(net.GIT_TERMINAL_PROMPT, "0");
  assert.equal(net.GIT_ASKPASS, "");
  assert.equal(net.GCM_INTERACTIVE, "never");
  assert.equal(net.GIT_SSH_COMMAND, "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2");
});

test("an existing ssh command is extended, not replaced", () => {
  assert.equal(
    gitEnv({ GIT_SSH_COMMAND: "ssh -i ~/.ssh/work" }, { network: true, sshCommand: "ssh -p 2222" }).GIT_SSH_COMMAND,
    "ssh -i ~/.ssh/work -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
    "GIT_SSH_COMMAND wins over core.sshCommand, as in git",
  );
  assert.equal(
    gitEnv({}, { network: true, sshCommand: "ssh -p 2222" }).GIT_SSH_COMMAND,
    "ssh -p 2222 -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
  );
  assert.equal(gitEnv({ GIT_SSH: "/opt/ssh" }, { network: true }).GIT_SSH_COMMAND, undefined, "GIT_SSH takes no options");
  assert.equal(hardenSshCommand("C:\\tools\\plink.exe -load work"), "C:\\tools\\plink.exe -load work -batch");
  assert.equal(hardenSshCommand("plink -batch"), "plink -batch");
  // PuTTY's default install path has a space in it, so the program is quoted.
  assert.equal(hardenSshCommand('"C:\\Program Files\\PuTTY\\plink.exe" -load work'), '"C:\\Program Files\\PuTTY\\plink.exe" -load work -batch');
  assert.equal(hardenSshCommand("'/opt/my tools/plink' -i key"), "'/opt/my tools/plink' -i key -batch");
  assert.equal(hardenSshCommand('"C:\\Program Files\\TortoiseGit\\bin\\TortoisePlink.exe"'), '"C:\\Program Files\\TortoiseGit\\bin\\TortoisePlink.exe" -batch');
  // A quoted OpenSSH, and a path that merely contains "plink", still get OpenSSH options.
  assert.match(hardenSshCommand('"C:\\Program Files\\OpenSSH\\ssh.exe" -p 22'), /ssh\.exe" -p 22 -o BatchMode=yes /);
  assert.match(hardenSshCommand("/opt/plink-tools/ssh"), /^\/opt\/plink-tools\/ssh -o BatchMode=yes /);
  assert.match(hardenSshCommand('"/opt/plink dir/ssh" -v'), / -v -o BatchMode=yes /);
  assert.equal(hardenSshCommand(""), "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2");
});

test("a network call really runs the repo's core.sshCommand in batch mode", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const record = join(h.root, "ssh-args");
  // A stand-in for ssh in Node, so the same test runs on Windows: Git for Windows runs core.sshCommand
  // with its own sh too, which takes forward slashes. Each path is quoted as one word (harness paths hold a space).
  const fakeSsh = join(h.root, "fake-ssh.mjs");
  await writeFile(fakeSsh, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)}, process.argv.slice(2).join(" "));\nprocess.exit(255);\n`);
  const word = (path: string) => `'${path.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
  await clone.git("config", "core.sshCommand", `${word(process.execPath)} ${word(fakeSsh)} -p 2222`);

  const r = await git(["ls-remote", "ssh://git@example.invalid/x.git"], { cwd: clone.dir, network: true });
  assert.equal(r.ok, false);
  const args = await readFile(record, "utf8");
  assert.match(args, /-p 2222/, "the user's own options are kept");
  assert.match(args, /-o BatchMode=yes/);
  assert.match(args, /-o ConnectTimeout=10/);
  assert.match(args, /-o ServerAliveInterval=5 -o ServerAliveCountMax=2/, "ssh gives up on a silent connection by itself");
});

test("network calls tell git to give up on a stalled HTTP transfer; local calls are left alone", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  // `git config --get` sees the -c options of its own command line.
  const get = (key: string, network: boolean) => git(["config", "--get", key], { cwd: clone.dir, network });
  assert.equal((await get("http.lowSpeedLimit", true)).stdout.trim(), "1000");
  assert.equal((await get("http.lowSpeedTime", true)).stdout.trim(), "10");
  assert.equal((await get("http.lowSpeedTime", false)).ok, false, "not set on a local call");
  assert.equal((await get("gc.auto", false)).stdout.trim(), "0");
});

test("an explicit env entry can remove a variable", () => {
  assert.equal(gitEnv({ FOO: "1" }, { env: { FOO: undefined } }).FOO, undefined);
  assert.equal(gitEnv({ FOO: "1" }, { env: { FOO: "2" } }).FOO, "2");
});
