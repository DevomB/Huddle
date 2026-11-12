// The MVP demo: two clones of one remote coordinate through it. Linux and native
// Windows, unchanged. Dependency-free: Node, real git processes, the built bundle.
//
//   npm run build && node scripts/demo-mvp.mjs [--bundle <file>] [--keep] [--evidence <dir>]
//   node scripts/demo-mvp.mjs --release <unpacked huddle-<version> directory>
//
// With --release, the demo runs the shipped artifact: Alice's setup is
// `git huddle init`, found through PATH in that directory, and the bundle
// compared against is the archive's huddle.mjs.
//
// Everything happens in a disposable directory under the OS temp directory, with
// a space and non-ASCII letters in its name: one bare remote, Alice's and Bob's
// clones, and a third clone that never synced. Names, session ids and content are
// synthetic. git runs with its own throwaway global config, never the user's.
// Nothing is pushed anywhere but that bare remote.
//
// Claude Code hooks are exercised by REPLAY: recorded native payloads from
// test/fixtures/hooks/claude-code, their paths rewritten to the demo's native
// paths (drive letter and backslashes on Windows), fed to the exact command and
// argument vector that init committed, spawned without a shell as Claude Code
// does. This proves the committed handler runs; it does not prove a live Claude
// session or model.
//
// Exits 1 on the first failed assertion, with what was seen. --keep leaves the
// directory for inspection; --evidence <dir> writes demo-evidence-<platform>.json.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS = process.platform === "win32";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const releaseDir = option("--release") ? resolve(option("--release")) : null;
const candidate = resolve(releaseDir ? join(releaseDir, "huddle.mjs") : (option("--bundle") ?? join(root, "dist", "huddle.mjs")));
const keep = argv.includes("--keep");
const evidenceDir = option("--evidence") ? resolve(option("--evidence")) : null;
const fixtures = join(root, "test", "fixtures", "hooks", "claude-code");

const evidence = { platform: process.platform, arch: process.arch, node: process.version, sha: process.env.GITHUB_SHA ?? null, bundle: null, steps: [], replay: "recorded Claude Code payloads, paths rewritten; not a live session" };
let stepNo = 0;

class DemoFailure extends Error {}

function ok(name, detail = "") {
  stepNo += 1;
  evidence.steps.push({ n: stepNo, name, ok: true, detail });
  console.log(`ok ${String(stepNo).padStart(2)} ${name}${detail ? ` — ${detail}` : ""}`);
}

function assert(condition, name, seen) {
  if (condition) return;
  stepNo += 1;
  evidence.steps.push({ n: stepNo, name, ok: false, seen });
  console.log(`FAIL ${stepNo} ${name}`);
  if (seen !== undefined) console.log(`   seen: ${typeof seen === "string" ? seen : JSON.stringify(seen, null, 2)}`.split("\n").map((line) => `   ${line}`).join("\n"));
  throw new DemoFailure(name);
}

/**
 * A check whose failure does not stop the demo: the later steps still run and
 * report. The demo still exits 1. For outcomes another lane delivers.
 */
let softFailures = 0;
function expect(condition, name, seen) {
  if (condition) return true;
  stepNo += 1;
  softFailures += 1;
  evidence.steps.push({ n: stepNo, name, ok: false, seen });
  console.log(`FAIL ${stepNo} ${name}`);
  if (seen !== undefined) console.log(`   seen: ${typeof seen === "string" ? seen : JSON.stringify(seen, null, 2)}`.split("\n").map((line) => `   ${line}`).join("\n"));
  return false;
}

function onPath(names, path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter)) {
    for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** A real executable, argv array, no shell. */
function run(file, args, { cwd, env, input = "", timeoutMs = 90_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, error: error.code ?? String(error), stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const show = (r) => ({ code: r.code, error: r.error, stdout: r.stdout.slice(-1500), stderr: r.stderr.slice(-1500) });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const json = (r, what) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    assert(false, `${what} prints JSON`, show(r));
  }
};

// ---------------------------------------------------------------------------
// The disposable world.
// ---------------------------------------------------------------------------

if (!existsSync(candidate)) {
  console.error(`demo: no bundle at ${candidate}. Run \`npm run build\` first, or pass --bundle <file>.`);
  process.exit(1);
}
// The native long-form path: on Windows, tmpdir() can be an 8.3 short name that git spells differently.
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "huddle demo ü-")));
const home = join(base, "home");
mkdirSync(home, { recursive: true });
const gitconfig = join(base, "gitconfig");
writeFileSync(
  gitconfig,
  [
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[advice]",
    "\tdetachedHead = false",
    // Git for Windows' default, kept: a Windows user's checkout converts line endings.
    ...(WINDOWS ? ["[core]", "\tautocrlf = true"] : []),
    "",
  ].join("\n"),
);
// A copy of process.env is a plain object: on Windows it loses the case-insensitive lookup, and PATH may be
// spelled "Path". Keep exactly one key, PATH, with process.env's own (case-insensitive) value.
const PATH = process.env.PATH ?? "";
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") delete env[name];
env.PATH = releaseDir ? `${releaseDir}${delimiter}${PATH}` : PATH;
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES", "HUDDLE_SESSION", "HUDDLE_NOW", "HUDDLE_DEBUG", "CLAUDE_PROJECT_DIR"]) delete env[name];

const remote = join(base, "remote.git");
const node = process.execPath;
const git = (cwd, ...args) => run("git", args, { cwd, env });
async function gitOk(cwd, ...args) {
  const r = await git(cwd, ...args);
  assert(r.code === 0, `git ${args.join(" ")}`, show(r));
  return r.stdout;
}

function person(name, dirName) {
  const dir = join(base, dirName);
  return {
    name,
    dir,
    session: `${name.toLowerCase()}-cli`,
    /** The vendored copy, the way a teammate runs huddle after a pull. */
    huddle: (args, extra = {}) => run(node, [join(extra.cwd ?? dir, ".huddle", "huddle.mjs"), ...args], { cwd: extra.cwd ?? dir, env: { ...env, HUDDLE_SESSION: extra.session ?? `${name.toLowerCase()}-cli` } }),
  };
}

async function cloneAs(who) {
  await gitOk(base, "clone", "--quiet", remote, who.dir);
  await gitOk(who.dir, "config", "user.name", who.name);
  await gitOk(who.dir, "config", "user.email", `${who.name.toLowerCase()}@example.invalid`);
}

/** Claude Code's committed handler for an event, run as Claude Code runs it. */
async function claudeHook(who, event, fixture, change = () => {}, { bundleDir = who.dir, path = env.PATH } = {}) {
  const settings = JSON.parse(readFileSync(join(who.dir, ".claude", "settings.json"), "utf8"));
  const handler = settings.hooks?.[event]?.[0]?.hooks?.[0];
  assert(handler && handler.type === "command", `.claude/settings.json registers a command hook for ${event}`, settings.hooks?.[event]);
  // ${CLAUDE_PROJECT_DIR} is replaced as text with the native project directory: mixed separators on Windows.
  const args = (handler.args ?? []).map((arg) => arg.replaceAll("${CLAUDE_PROJECT_DIR}", bundleDir));
  // Exec form: the command is a program on PATH, never a shell line.
  const program = onPath(WINDOWS ? [`${handler.command}.exe`, handler.command] : [handler.command], path);
  const payload = JSON.parse(readFileSync(join(fixtures, `${fixture}.json`), "utf8"));
  payload.cwd = who.dir;
  if (typeof payload.transcript_path === "string") payload.transcript_path = join(home, ".claude", "projects", "demo", `${payload.session_id}.jsonl`);
  change(payload);
  if (program === null) return { handler, args, program, result: { code: null, error: "ENOENT", stdout: "", stderr: "" } };
  const result = await run(program, args, { cwd: who.dir, env: { ...env, PATH: path, CLAUDE_PROJECT_DIR: who.dir }, input: JSON.stringify(payload) });
  return { handler, args, program, result };
}

const context = (r) => {
  if (r.stdout.trim() === "") return "";
  try {
    const out = JSON.parse(r.stdout);
    return out.hookSpecificOutput?.additionalContext ?? out.systemMessage ?? "";
  } catch {
    return r.stdout;
  }
};

const alice = person("Alice", "alice tést");
const bob = person("Bob", "bob tést");
const carol = person("Carol", "carol never synced");

try {
  const bundleText = readFileSync(candidate);
  evidence.bundle = { path: candidate, sha256: sha256(bundleText), bytes: bundleText.length };
  const version = (await run(node, [candidate, "--version"], { env })).stdout.trim();
  console.log(`huddle MVP demo: huddle ${version} on ${process.platform} ${process.arch}, node ${process.version}, git ${(await git(base, "--version")).stdout.trim().replace(/^git version /, "")}`);
  console.log(`in ${base}`);

  // 1. One bare remote, Alice's and Bob's clones.
  await gitOk(base, "init", "--quiet", "--bare", remote);
  await cloneAs(alice);
  mkdirSync(join(alice.dir, "src"), { recursive: true });
  writeFileSync(join(alice.dir, "README.md"), "# Demo project\n");
  writeFileSync(join(alice.dir, "src", "auth.ts"), "export const login = () => true;\n");
  writeFileSync(join(alice.dir, "src", "log.ts"), "export const log = console.log;\n");
  await gitOk(alice.dir, "add", "-A");
  await gitOk(alice.dir, "commit", "--quiet", "-m", "Initial commit");
  await gitOk(alice.dir, "push", "--quiet", "-u", "origin", "main");
  await cloneAs(bob);
  ok("one bare remote, Alice's and Bob's clones", `checkout paths with a space and non-ASCII letters${WINDOWS ? ", core.autocrlf=true" : ""}`);

  // 2. Alice sets the repo up from the candidate bundle and pushes the setup; Bob pulls it.
  const setup = ["init", "--agent", "claude-code", "--agent", "codex", "--no-capture-intent"];
  const init = releaseDir ? await run("git", ["huddle", ...setup], { cwd: alice.dir, env }) : await run(node, [candidate, ...setup], { cwd: alice.dir, env });
  assert(init.code === 0, `${releaseDir ? "git huddle" : "node <candidate bundle>"} ${setup.join(" ")} succeeds in Alice's clone`, show(init));
  await gitOk(alice.dir, "add", "-A");
  await gitOk(alice.dir, "commit", "--quiet", "-m", "Set up huddle");
  await gitOk(alice.dir, "push", "--quiet");
  ok(`Alice: ${releaseDir ? "git huddle" : "huddle"} ${setup.join(" ")}, committed and pushed`, releaseDir ? `launcher from ${releaseDir}` : "");
  await gitOk(bob.dir, "pull", "--quiet");
  const vendored = readFileSync(join(bob.dir, ".huddle", "huddle.mjs"));
  assert(vendored.equals(bundleText), "Bob's pulled .huddle/huddle.mjs is byte for byte the candidate bundle (no line-ending conversion)", { bytes: vendored.length, crlf: vendored.includes("\r\n") });
  const bobVersion = await bob.huddle(["--version"]);
  assert(bobVersion.code === 0 && bobVersion.stdout.trim() === version, "Bob runs the vendored bundle: node .huddle/huddle.mjs --version", show(bobVersion));
  ok("Bob pulled the setup; the vendored bundle is intact and runs", `huddle ${version}, sha256 ${evidence.bundle.sha256.slice(0, 12)}…`);
  // A clone that pulls the setup and never syncs.
  await cloneAs(carol);

  // 3. Alice publishes an explicit intent and a changed file.
  const intent = await alice.huddle(["intent", "Refactor the login flow"]);
  assert(intent.code === 0, "Alice: huddle intent", show(intent));
  writeFileSync(join(alice.dir, "src", "auth.ts"), "export const login = (user: string) => user.length > 0;\n");
  const aliceSync = await alice.huddle(["sync"]);
  assert(aliceSync.code === 0, "Alice: huddle sync publishes", show(aliceSync));
  ok("Alice published intent \"Refactor the login flow\" and src/auth.ts in flight");

  // 4. Bob syncs and sees Alice: name, branch, intent, path.
  const bobSync = await bob.huddle(["sync"]);
  assert(bobSync.code === 0, "Bob: huddle sync", show(bobSync));
  const status = await bob.huddle(["status", "--json"]);
  assert(status.code === 0, "Bob: huddle status --json", show(status));
  const statusText = JSON.stringify(json(status, "status --json"));
  for (const expected of ["Alice", "main", "Refactor the login flow", "src/auth.ts"]) {
    assert(statusText.includes(expected), `Bob's status --json carries Alice's ${expected}`, json(status));
  }
  const statusHuman = await bob.huddle(["status", "--cached"]);
  ok("Bob sees Alice's session: name, branch, intent, path", statusHuman.stdout.split(/\r?\n/).find((line) => line.includes("Alice")) ?? "");

  // 5. Bob checks the path: overlap, exit 3, Alice named.
  const check = await bob.huddle(["check", "src/auth.ts"]);
  assert(check.code === 3, "Bob: huddle check src/auth.ts exits 3 (overlap)", show(check));
  assert(/Alice/.test(check.stdout + check.stderr), "the overlap names Alice", show(check));
  const checkJson = json(await bob.huddle(["check", "--json", "src/auth.ts"]), "check --json");
  ok("Bob: check src/auth.ts → exit 3, names Alice", (check.stdout.split(/\r?\n/).find((line) => line.includes("Alice")) ?? "").trim());
  evidence.checkJson = checkJson;

  // The clone that never synced must not call that path clear (contract 4.2: verdict unknown, exit 1).
  const blind = await carol.huddle(["check", "src/auth.ts"]);
  const blindJson = json(await carol.huddle(["check", "--json", "src/auth.ts"]), "check --json in a never-synced clone");
  evidence.uncached = { code: blind.code, verdict: blindJson.verdict ?? null, freshness: blindJson.freshness ?? null };
  if (
    expect(blind.code === 1 && blindJson.verdict === "unknown" && blindJson.freshness === "never", "a clone that never synced: check is unknown (exit 1, verdict unknown, freshness never), never clear", { text: show(blind), json: blindJson }) &&
    expect(/^unknown:/m.test(blind.stdout + blind.stderr) && !/no overlap/i.test(blind.stdout), "its text starts with unknown: and does not say no overlap", show(blind))
  ) {
    ok("Carol (never synced): check → unknown, exit 1, not clear", (blind.stdout + blind.stderr).trim().split(/\r?\n/)[0]);
  }

  // 6. Claude Code hooks, by replay of recorded payloads with native paths.
  const start = await claudeHook(bob, "SessionStart", "session-start.startup");
  assert(start.handler.command === "node" && start.args[0] !== undefined, "the committed handler is exec form: node + the vendored bundle", start.handler);
  assert(resolve(start.args[0]) === join(bob.dir, ".huddle", "huddle.mjs"), "the handler runs the copy vendored in Bob's clone", start.args);
  assert(start.result.code === 0 && start.result.stderr === "", "SessionStart handler exits 0, quietly", show(start.result));
  assert(/Alice/.test(context(start.result)) && /Refactor the login flow/.test(context(start.result)) && /src\/auth\.ts/.test(context(start.result)), "the SessionStart briefing names Alice, her intent and her file", context(start.result));
  ok("REPLAY Claude SessionStart (Bob): exec-form handler briefs Alice's work", `${start.program} ${start.args.map((a) => JSON.stringify(a)).join(" ")}`);

  const nativeFile = join(bob.dir, "src", "auth.ts"); // C:\...\src\auth.ts on Windows
  const edit = await claudeHook(bob, "PreToolUse", "pre-tool-use.edit", (payload) => {
    payload.tool_input.file_path = nativeFile;
  });
  assert(edit.result.code === 0, "PreToolUse handler exits 0 (advisory, never blocks)", show(edit.result));
  assert(/src\/auth\.ts overlaps/.test(context(edit.result)) && /Alice/.test(context(edit.result)), "the PreToolUse warning names src/auth.ts and Alice", context(edit.result));
  ok("REPLAY Claude PreToolUse Edit (Bob) on a native path: overlap warning, exit 0", nativeFile);

  // Privacy preference honored: the team set --no-capture-intent, so a prompt never becomes published intent.
  const privatePrompt = "PRIVATE-PROMPT-7f3c: draft the Globex pricing memo";
  const prompt = await claudeHook(bob, "UserPromptSubmit", "user-prompt-submit.typed", (payload) => {
    payload.prompt = privatePrompt;
  });
  assert(prompt.result.code === 0, "UserPromptSubmit handler exits 0", show(prompt.result));
  assert((await bob.huddle(["sync"])).code === 0, "Bob: huddle sync after the prompt");
  assert((await alice.huddle(["sync"])).code === 0, "Alice: huddle sync");
  const seenByAlice = await alice.huddle(["status", "--json"]);
  assert(!seenByAlice.stdout.includes("PRIVATE-PROMPT-7f3c") && /claude-code/.test(seenByAlice.stdout), "Alice sees Bob's Claude session, and not his prompt", json(seenByAlice, "status --json"));
  const objects = await git(remote, "cat-file", "--batch-all-objects", "--batch");
  assert(objects.code === 0 && !objects.stdout.includes("PRIVATE-PROMPT-7f3c"), "the prompt text is in no object on the remote", { code: objects.code });
  ok("REPLAY Claude UserPromptSubmit with capture off: the prompt reaches no teammate and no object on the remote");

  // The bundle missing: node fails, and never with exit 2, Claude Code's blocking code.
  const parked = join(bob.dir, ".huddle", "huddle.mjs.parked");
  renameSync(join(bob.dir, ".huddle", "huddle.mjs"), parked);
  const noBundle = await claudeHook(bob, "PreToolUse", "pre-tool-use.edit", (payload) => {
    payload.tool_input.file_path = nativeFile;
  });
  renameSync(parked, join(bob.dir, ".huddle", "huddle.mjs"));
  assert(noBundle.result.code !== 0 && noBundle.result.code !== 2 && noBundle.result.stdout === "", "with the bundle missing the hook fails, not with the blocking exit 2", show(noBundle.result));
  // Node missing from PATH: the exec-form command cannot start; Claude Code reports a non-blocking hook error.
  const noNode = await claudeHook(bob, "PreToolUse", "pre-tool-use.edit", () => {}, { path: join(base, "empty-path") });
  assert(noNode.program === null, "with node missing from PATH the handler cannot start (no shell fallback)", { program: noNode.program });
  // Claude Code treats a hook that cannot start as a non-blocking error unless the handler sets onFailure: "block".
  assert(noNode.handler.onFailure === undefined || noNode.handler.onFailure !== "block", "the committed handler does not set onFailure: block", noNode.handler);
  ok("missing bundle → exit " + noBundle.result.code + " (not 2); missing node → spawn ENOENT, nothing blocks");

  // 7. A decision propagates.
  const decide = await alice.huddle(["decide", "Validate request bodies with one shared schema module"]);
  assert(decide.code === 0, "Alice: huddle decide", show(decide));
  await bob.huddle(["sync"]);
  const decisions = await bob.huddle(["decisions", "--json"]);
  assert(decisions.code === 0 && JSON.stringify(json(decisions, "decisions --json")).includes("Validate request bodies with one shared schema module"), "Bob: decisions --json lists Alice's decision", show(decisions));
  ok("Alice's decision reaches Bob");

  // 8. A real simultaneous claim race: exactly one winner.
  const add = await alice.huddle(["task", "add", "--id", "demorace", "Upgrade the logger"]);
  assert(add.code === 0, "Alice: huddle task add --id demorace", show(add));
  await bob.huddle(["sync"]);
  const [aClaim, bClaim] = await Promise.all([alice.huddle(["task", "claim", "demorace"]), bob.huddle(["task", "claim", "demorace"])]);
  const codes = [aClaim.code, bClaim.code].sort();
  assert(JSON.stringify(codes) === JSON.stringify([0, 3]), "two simultaneous claims: one exits 0, the other 3 (lost race)", { alice: show(aClaim), bob: show(bClaim) });
  const [winner, loser, lost] = aClaim.code === 0 ? ["Alice", "Bob", bClaim] : ["Bob", "Alice", aClaim];
  assert(lost.stdout.concat(lost.stderr).includes(winner), "the loser is told who won", show(lost));
  await alice.huddle(["sync"]);
  const tasks = json(await alice.huddle(["task", "list", "--json"]), "task list --json");
  assert(JSON.stringify(tasks).includes(winner), "the task list shows the winner as owner", tasks);
  ok("simultaneous claim race: exactly one assignment", `${winner} won, ${loser} got exit 3`);

  // 9. A linked worktree of Bob's clone shares its view.
  const linkedDir = join(base, "bob linked ü");
  await gitOk(bob.dir, "worktree", "add", "--quiet", "-b", "bob-feature", linkedDir);
  const linkedCheck = await bob.huddle(["check", "src/auth.ts"], { cwd: linkedDir, session: "bob-linked" });
  assert(linkedCheck.code === 3 && /Alice/.test(linkedCheck.stdout + linkedCheck.stderr), "in Bob's linked worktree, check src/auth.ts is an overlap with Alice", show(linkedCheck));
  ok("linked worktree: same overlap, exit 3", linkedDir);

  // 10. Plain git commit hook: per clone, chained after the hook already there, advisory.
  const hooksDir = join(bob.dir, ".git", "hooks");
  const marker = join(base, "existing-hook-ran");
  writeFileSync(join(hooksDir, "pre-commit"), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\nexit 0\n`, { mode: 0o755 });
  const gitInit = await bob.huddle(["init", "--agent", "git"]);
  assert(gitInit.code === 0, "Bob: huddle init --agent git (per clone)", show(gitInit));
  writeFileSync(join(bob.dir, "src", "auth.ts"), "export const login = () => false;\n");
  await gitOk(bob.dir, "add", "src/auth.ts");
  const commit = await git(bob.dir, "commit", "-m", "Tweak login");
  assert(commit.code === 0, "Bob's commit of src/auth.ts goes through (the hook is advisory)", show(commit));
  assert(/Alice/.test(commit.stdout + commit.stderr) && /src\/auth\.ts/.test(commit.stdout + commit.stderr), "the commit hook warns about the overlap with Alice", show(commit));
  assert(existsSync(marker), "the pre-commit hook that was there before still ran (chained)", { marker });
  ok("git commit hook: overlap warning, commit not blocked, existing hook chained", (commit.stdout + commit.stderr).split(/\r?\n/).find((line) => line.includes("Alice"))?.trim() ?? "");

  if (softFailures > 0) throw new DemoFailure(`${softFailures} check(s) failed`);
  console.log(`\nPASS: ${stepNo} steps on ${process.platform}. Claude hooks were replayed from recorded payloads, not run in a live session.`);
} catch (error) {
  if (!(error instanceof DemoFailure)) {
    console.log(`FAIL unexpected error: ${error.stack ?? error}`);
    evidence.steps.push({ n: stepNo + 1, name: "unexpected error", ok: false, seen: String(error.stack ?? error) });
  }
  process.exitCode = 1;
  console.log(`\nDEMO FAILED: ${evidence.steps.filter((s) => !s.ok).length} failed, ${evidence.steps.filter((s) => s.ok).length} passed. ${keep ? "" : "Re-run with --keep to inspect the directory."}`);
} finally {
  evidence.passed = process.exitCode !== 1;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `demo-evidence-${process.platform}.json`), JSON.stringify(evidence, null, 2) + "\n");
  }
  if (keep) console.log(`kept: ${base}`);
  else {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        break;
      } catch (error) {
        if (attempt === 4) console.log(`note: could not remove ${base}: ${error.code ?? error.message}`);
      }
    }
  }
}
