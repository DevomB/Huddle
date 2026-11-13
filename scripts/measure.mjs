#!/usr/bin/env node
// What huddle costs: git processes and wall time per operation, and the bytes
// of the bundle and the archive (CONTRACT section 6). Prints one JSON document
// on stdout and a short table on stderr. Anyone can rerun it:
//
//   npm run build && node scripts/measure.mjs [--bundle <huddle.mjs>] [--archive <tar.gz>]
//       [--reps 5] [--slow-reps 3] [--delay-ms 60] [--only <key,...>] [--out <file.json>]
//
// The method is worker 1's (WORKER-1.md of the hardening phase, 2026-11-13):
// - One bare remote and four clones in a fresh temporary directory, with an
//   isolated HOME and git config. alice runs `init --agent claude-code
//   --no-capture-intent`, commits and pushes it; bob, carol and dave clone; each
//   says an intent and syncs. alice has two uncommitted files.
// - Each operation: N timed runs with nothing in the way (the median, minimum
//   and maximum are reported), then one counted run. Counting is git's own
//   trace2: every git process writes a "start" event, and one that git itself
//   started has a session id with a "/" in it. Those are left out, so what is
//   counted is the git processes huddle started, on every platform. On Linux,
//   worker 1's PATH shim counts the same run as a cross-check
//   (`shimAgrees`).
// - The slow column (POSIX only): the shim sleeps --delay-ms before every git
//   start it sees, a model of the process start cost on Windows. On Windows the
//   real column is the measurement and the slow column is null.
//
// Background syncs are off (HUDDLE_NO_BACKGROUND=1, as in the tests) except in
// the cases named "background on", which wait for the sync they start.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS = process.platform === "win32";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const { values: opt } = parseArgs({
  options: {
    bundle: { type: "string", default: join(ROOT, "dist", "huddle.mjs") },
    archive: { type: "string" },
    reps: { type: "string", default: "5" },
    "slow-reps": { type: "string", default: "3" },
    "delay-ms": { type: "string", default: "60" },
    only: { type: "string", default: "" },
    out: { type: "string" },
  },
});
const bundle = resolve(opt.bundle);
const reps = Number(opt.reps);
const slowReps = Number(opt["slow-reps"]);
const delayMs = WINDOWS ? 0 : Number(opt["delay-ms"]);
const only = new Set(opt.only.split(",").filter(Boolean));
const wanted = (key) => only.size === 0 || only.has(key);
const say = (line) => process.stderr.write(`${line}\n`);

if (!existsSync(bundle)) {
  say(`measure: ${bundle} does not exist; run npm run build first`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function bundleFacts(file) {
  const bytes = readFileSync(file);
  const version = /^#!\/usr\/bin\/env node\r?\n\/\/ git-huddle (\S+)/.exec(bytes.subarray(0, 200).toString("utf8"))?.[1] ?? null;
  return { file, bytes: bytes.length, sha256: sha256(bytes), version };
}

function archiveFacts(file) {
  if (!file || !existsSync(file)) return null;
  const gz = readFileSync(file);
  const tar = gunzipSync(gz);
  return { file, bytes: gz.length, sha256: sha256(gz), tarBytes: tar.length, tarSha256: sha256(tar) };
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function run(command, args, { cwd, env, input = "", timeoutMs = 30_000 } = {}) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = [];
    const err = [];
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code, ms: performance.now() - started, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      err.push(Buffer.from(`\n[measure] killed after ${timeoutMs} ms\n`));
      settle(-1);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      err.push(Buffer.from(String(error)));
      settle(-1);
    });
    child.on("close", (code) => settle(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** The git that PATH names, as an absolute file: the shim must exec the real one and not itself. */
function realGit() {
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of WINDOWS ? ["git.exe"] : ["git"]) {
      const file = join(dir, name);
      try {
        accessSync(file, constants.X_OK);
        if (statSync(file).isFile()) return realpathSync(file);
      } catch {
        // Not here.
      }
    }
  }
  throw new Error("git is not on PATH");
}

// ---------------------------------------------------------------------------
// The environment: isolated like test/harness.ts, and free of any agent's or
// git's variables from the shell that runs this (CONTRACT 3.1).
// ---------------------------------------------------------------------------

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "huddle tést measure-")));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
const gitconfig = join(root, "gitconfig");
writeFileSync(
  gitconfig,
  "[user]\n\tname = Test User\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n\tlongpaths = true\n[advice]\n\tdetachedHead = false\n",
);

const PATH = process.env.PATH ?? "";
const base = { ...process.env };
for (const name of Object.keys(base)) {
  if (name.toUpperCase() === "PATH" || /^GIT_TRACE/.test(name)) delete base[name];
}
for (const name of [
  "CLAUDE_ENV_FILE",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "HUDDLE_NOW",
  "HUDDLE_SESSION",
  "HUDDLE_TIMEOUT_MS",
  "HUDDLE_HOOK_PATIENCE",
]) {
  delete base[name];
}
Object.assign(base, {
  PATH,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  HUDDLE_NO_BACKGROUND: "1",
});

const traceFile = join(root, "trace2.json");
const shimLog = join(root, "shim.log");
const shimDir = join(root, "shim");
if (!WINDOWS) {
  mkdirSync(shimDir);
  const git = realGit().replace(/'/g, "'\\''");
  writeFileSync(
    join(shimDir, "git"),
    [
      "#!/bin/sh",
      'if [ -n "$MEASURE_GIT_LOG" ]; then',
      '  comm=?; [ -r "/proc/$PPID/comm" ] && read comm < "/proc/$PPID/comm"',
      '  printf "%s %s %s\\n" "$PPID" "$comm" "$*" >> "$MEASURE_GIT_LOG"',
      "fi",
      '[ -n "$MEASURE_GIT_DELAY" ] && sleep "$MEASURE_GIT_DELAY"',
      `exec '${git}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(shimDir, "git"), 0o755);
}
const shimmed = (extra) => ({ PATH: `${shimDir}${delimiter}${PATH}`, ...extra });

/** Mode "real": nothing in the way. "counted": trace2 on, and on Linux the shim logging. "slow": the shim sleeping before every git. */
function modeEnv(mode) {
  if (mode === "real") return {};
  if (mode === "slow") return shimmed({ MEASURE_GIT_DELAY: (delayMs / 1000).toFixed(3) });
  const counted = { GIT_TRACE2_EVENT: traceFile };
  return WINDOWS ? counted : { ...counted, ...shimmed({ MEASURE_GIT_LOG: shimLog }) };
}

function resetCounters() {
  rmSync(traceFile, { force: true });
  rmSync(shimLog, { force: true });
}

/** The first argument that is not an option, skipping the value of each -c and -C. */
function verbOf(argv) {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "-c" || argv[i] === "-C") {
      i++;
      continue;
    }
    if (!argv[i].startsWith("-")) return argv[i];
  }
  return "?";
}

/** The git processes huddle started, from trace2: "start" events of processes no git process started. */
function traced() {
  if (!existsSync(traceFile)) return [];
  const verbs = [];
  for (const line of readFileSync(traceFile, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.event === "start" && typeof event.sid === "string" && !event.sid.includes("/")) verbs.push(verbOf(event.argv ?? []));
  }
  return verbs;
}

/** The same count from the shim's log (Linux): git processes whose parent is a node process. Null where the shim cannot tell. */
function shimCount() {
  if (WINDOWS || !existsSync("/proc/self/comm")) return null;
  if (!existsSync(shimLog)) return 0;
  return readFileSync(shimLog, "utf8")
    .split("\n")
    .filter((line) => line.split(" ")[1]?.startsWith("node")).length;
}

function byVerb(verbs) {
  const counts = {};
  for (const verb of verbs) counts[verb] = (counts[verb] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stats = (xs) => (xs.length === 0 ? null : { median: Math.round(median(xs)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// The repositories
// ---------------------------------------------------------------------------

async function git(cwd, ...args) {
  const result = await run("git", args, { cwd, env: base });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const remote = join(root, "remote.git");

async function clone(name) {
  const dir = join(root, name);
  await git(root, "clone", "--quiet", remote, dir);
  await git(dir, "config", "user.name", name);
  await git(dir, "config", "user.email", `${name}@example.invalid`);
  const common = resolve(dir, await git(dir, "rev-parse", "--git-common-dir"));
  return {
    name,
    dir,
    state: join(common, "huddle"),
    huddle: (args, { session, env = {}, stdin = "", timeoutMs } = {}) =>
      run(process.execPath, [bundle, ...args], { cwd: dir, env: { ...base, ...(session ? { HUDDLE_SESSION: session } : {}), ...env }, input: stdin, timeoutMs }),
    write(rel, text) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    },
  };
}

async function must(result, what) {
  if (result.code !== 0) throw new Error(`${what}: exit ${result.code}: ${result.stderr.trim()}`);
  return result;
}

const taskId = (stdout) => /\[([a-z2-7]{8})\]/.exec(stdout)?.[1] ?? null;

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

const operations = [];
const races = [];
const errors = [];

const counterBytes = () => (existsSync(traceFile) ? statSync(traceFile).size : 0) + (existsSync(shimLog) ? statSync(shimLog).size : 0);

/**
 * The background work a run left behind, waited for until it is done: a
 * detached sync (it holds sync.lock while it runs) or a deferred one (it waits
 * in sync-pending until the throttle interval is over, up to
 * syncIntervalSeconds). A detached node takes a while to start on a loaded
 * machine, so the first phase waits up to 2 s for any sign of it before
 * concluding there is none.
 */
async function settled(c) {
  const lock = join(c.state, "sync.lock");
  const pending = join(c.state, "sync-pending");
  const busy = () => existsSync(lock) || existsSync(pending);
  const start = counterBytes();
  for (let waited = 0; waited < 2000 && !busy() && counterBytes() === start; waited += 50) await sleep(50);
  let last = -1;
  let quiet = 0;
  for (let waited = 0; waited < 40_000; waited += 100) {
    await sleep(100);
    const size = counterBytes();
    quiet = !busy() && size === last ? quiet + 1 : 0;
    if (quiet === 3) return;
    last = size;
  }
  errors.push(`background work in ${c.name} did not finish within 40 s`);
}

/**
 * One operation. `before(i)` prepares run i and is not timed; `run(i, env)` is
 * timed; `settle` waits for what the run left running. `ok` lists the exit
 * codes that are not a failure of the run (3 is an overlap).
 */
async function measure(key, label, { before = async () => {}, run: go, settle, ok = [0] }) {
  if (!wanted(key)) return;
  let i = 0;
  const series = async (mode, count) => {
    const times = [];
    for (let n = 0; n < count; n++, i++) {
      await before(i);
      const result = await go(i, modeEnv(mode));
      times.push(result.ms);
      if (!ok.includes(result.code)) errors.push(`${key} (${mode} run ${n + 1}): exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
      if (settle) await settle();
    }
    return times;
  };
  const real = await series("real", reps);
  const slow = delayMs > 0 ? await series("slow", slowReps) : [];
  await before(i);
  resetCounters();
  const counted = await go(i, modeEnv("counted"));
  const foreground = traced();
  if (settle) await settle();
  if (!ok.includes(counted.code)) errors.push(`${key} (counted run): exit ${counted.code}: ${counted.stderr.trim().slice(0, 300)}`);
  const verbs = traced();
  const shim = shimCount();
  const entry = {
    key,
    label,
    wallMs: stats(real),
    slowWallMs: stats(slow),
    // `git`: the processes the command started before it exited. `background`: those of the sync it left running, null when it leaves none by design.
    git: foreground.length,
    background: settle ? verbs.length - foreground.length : null,
    gitByVerb: byVerb(verbs),
    shimAgrees: shim === null ? null : shim === verbs.length,
    exit: counted.code,
    loadAverage: WINDOWS ? null : Number(loadavg()[0].toFixed(2)),
  };
  operations.push(entry);
  const bg = entry.background === null ? "" : ` + ${entry.background} in the background`;
  say(`${label}: ${entry.wallMs.median} ms${entry.slowWallMs ? ` (+${delayMs} ms per git: ${entry.slowWallMs.median} ms)` : ""}, git ${entry.git}${bg}${shim !== null && shim !== verbs.length ? ` (shim saw ${shim})` : ""}`);
}

/** All contenders claim one new task at the same moment. Total: first start to last exit. Rounds: the remote listings (ls-remote). */
async function race(key, label, clones, per, times, bob) {
  if (!wanted(key) && !wanted("races")) return;
  for (const mode of delayMs > 0 ? ["counted", "slow"] : ["counted"]) {
    for (let n = 0; n < times; n++) {
      const add = await must(await bob.huddle(["task", "add", `race ${key} ${mode} ${n}`], { session: "bob-main" }), "task add");
      const id = taskId(add.stdout);
      resetCounters();
      const env = mode === "slow" ? { ...modeEnv("slow"), GIT_TRACE2_EVENT: traceFile } : modeEnv("counted");
      const started = performance.now();
      const results = await Promise.all(
        clones.flatMap((c) =>
          Array.from({ length: per }, (_, s) => c.huddle(["task", "claim", id], { session: `${c.name}-s${s + 1}`, env, timeoutMs: 120_000 }).then((r) => ({ ...r, who: `${c.name}-s${s + 1}` }))),
        ),
      );
      const total = performance.now() - started;
      const verbs = traced();
      const exits = results.map((r) => r.code).sort((a, b) => a - b);
      const winners = exits.filter((code) => code === 0).length;
      if (winners !== 1 || exits.some((code) => code !== 0 && code !== 3)) {
        errors.push(`${key} (${mode} ${n + 1}): exits ${exits.join("")}: ${results.find((r) => r.code !== 0 && r.code !== 3)?.stderr.trim().slice(0, 300) ?? "not exactly one winner"}`);
      }
      const entry = {
        key,
        label,
        mode: mode === "slow" ? `+${delayMs} ms per git` : "real",
        run: n + 1,
        totalMs: Math.round(total),
        perContenderMs: { median: Math.round(median(results.map((r) => r.ms))), max: Math.round(Math.max(...results.map((r) => r.ms))) },
        exits: exits.join(""),
        git: verbs.length,
        rounds: verbs.filter((v) => v === "ls-remote").length,
        push: verbs.filter((v) => v === "push").length,
        fetch: verbs.filter((v) => v === "fetch").length,
        loadAverage: WINDOWS ? null : Number(loadavg()[0].toFixed(2)),
      };
      races.push(entry);
      say(`${label} #${n + 1} (${entry.mode}): ${entry.totalMs} ms, git ${entry.git}, rounds ${entry.rounds}, exits ${entry.exits}`);
    }
  }
}

let exitCode = 0;
const loadAtStart = WINDOWS ? null : Number(loadavg()[0].toFixed(2));
try {
  await git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = join(root, ".seed");
  await git(root, "clone", "--quiet", remote, seed);
  writeFileSync(join(seed, "README.md"), "# measure\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "--quiet", "-m", "Initial commit");
  await git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  rmSync(seed, { recursive: true, force: true });

  const alice = await clone("alice");
  await must(await alice.huddle(["init", "--agent", "claude-code", "--no-capture-intent"], { session: "alice-main" }), "init");
  await git(alice.dir, "add", "-A");
  await git(alice.dir, "commit", "--quiet", "-m", "huddle init");
  await git(alice.dir, "push", "--quiet", "--set-upstream", "origin", "HEAD");
  const bob = await clone("bob");
  const carol = await clone("carol");
  const dave = await clone("dave");
  const all = [alice, bob, carol, dave];
  for (const c of all) {
    await must(await c.huddle(["intent", `work of ${c.name}`], { session: `${c.name}-main` }), `intent ${c.name}`);
    await must(await c.huddle(["sync", "--force"], { session: `${c.name}-main` }), `sync ${c.name}`);
  }
  alice.write("src/a.ts", "export const a = 1;\n");
  alice.write("src/b.ts", "export const b = 1;\n");
  const A = { session: "alice-main" };
  const B = { session: "bob-main" };
  const stamp = join(alice.state, "sync-stamp");

  // Worker 1's table, in its order.
  await measure("startup", "node startup (huddle --version)", { run: (_i, env) => alice.huddle(["--version"], { env }) });
  await measure("sync", "sync, not throttled, nothing to publish", { before: async () => rmSync(stamp, { force: true }), run: (_i, env) => alice.huddle(["sync"], { ...A, env }) });
  await measure("sync-force", "sync --force, nothing to publish", { run: (_i, env) => alice.huddle(["sync", "--force"], { ...A, env }) });
  await measure("sync-force-publish", "sync --force with a publish (intent changed)", {
    before: async (i) => void (await must(await alice.huddle(["intent", `step ${i}`], A), "intent")),
    run: (_i, env) => alice.huddle(["sync", "--force"], { ...A, env }),
  });
  const ids = [];
  await measure("task-claim", "task claim, uncontended", {
    before: async (i) => void (ids[i] = taskId((await must(await bob.huddle(["task", "add", `task ${i}`], B), "task add")).stdout)),
    run: (i, env) => alice.huddle(["task", "claim", ids[i]], { ...A, env }),
  });
  await measure("claim", "claim <glob>, background off", { run: (i, env) => alice.huddle(["claim", `src/x${i}/**`], { ...A, env }) });
  await measure("claim-bg", "claim <glob>, background on", {
    run: (i, env) => alice.huddle(["claim", `src/y${i}/**`], { ...A, env: { ...env, HUDDLE_NO_BACKGROUND: "0" } }),
    settle: () => settled(alice),
  });
  const preEdit = (i) => {
    const payload = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "hooks", "claude-code", "pre-tool-use.edit.json"), "utf8"));
    payload.session_id = "6835a033-358b-4497-a94e-356ac1bac1e3";
    payload.cwd = alice.dir;
    payload.tool_input.file_path = join(alice.dir, i % 2 ? "src/a.ts" : "src/b.ts");
    delete payload.transcript_path;
    return JSON.stringify(payload);
  };
  await measure("hook-pre-edit", "pre-edit hook (Claude Code), background off", { run: (i, env) => alice.huddle(["hook", "claude-code"], { stdin: preEdit(i), env }) });
  await measure("hook-pre-edit-bg", "pre-edit hook (Claude Code), background on", {
    run: (i, env) => alice.huddle(["hook", "claude-code"], { stdin: preEdit(i), env: { ...env, HUDDLE_NO_BACKGROUND: "0" } }),
    settle: () => settled(alice),
  });

  // The rest of CONTRACT section 6. alice publishes her two files first, so bob's check meets an overlap.
  await must(await alice.huddle(["sync", "--force"], A), "sync alice");
  await must(await bob.huddle(["sync", "--force"], B), "sync bob");
  await measure("status", "status", { run: (_i, env) => bob.huddle(["status"], { ...B, env }) });
  await measure("check", "check <path> on a teammate's file (exit 3)", { run: (_i, env) => bob.huddle(["check", "src/a.ts"], { ...B, env }), ok: [3] });

  // The hook scenarios and the injected-context probe are the lead's (CONTRACT section 6); they go here.

  await race("race-5", "5 claims in one clone", [alice], 5, 3, bob);
  await race("race-20", "20 claims, 4 clones x 5", all, 5, 2, bob);
} catch (error) {
  errors.push(`setup or measurement stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  const gitVersion = (await run("git", ["--version"], { env: base })).stdout.trim();
  const archive = opt.archive ?? join(dirname(bundle), `huddle-${pkg.version}.tar.gz`);
  const report = {
    tool: "scripts/measure.mjs",
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    // The 1-minute load average at the start and the end (null on Windows). Wall times on a machine busier than its cores are not comparable; the git counts are.
    loadAverage: { start: loadAtStart, end: WINDOWS ? null : Number(loadavg()[0].toFixed(2)) },
    node: process.version,
    git: gitVersion,
    method: {
      reps,
      slowReps: delayMs > 0 ? slowReps : 0,
      gitDelayMs: delayMs,
      counting: "git trace2 start events whose session id has no '/' (git processes huddle started)",
      crossCheck: WINDOWS ? null : "PATH shim, git processes whose parent is node",
      median: "the middle of the sorted times, the upper one for an even count",
    },
    bundle: bundleFacts(bundle),
    archive: archiveFacts(archive),
    operations,
    races,
    context: [],
    errors,
  };
  const json = JSON.stringify(report, null, 2);
  process.stdout.write(`${json}\n`);
  if (opt.out) writeFileSync(opt.out, `${json}\n`);
  if (errors.length > 0) {
    for (const error of errors) say(`measure: ${error}`);
    exitCode = 1;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: WINDOWS ? 20 : 3, retryDelay: 100 });
}
process.exitCode = exitCode;
