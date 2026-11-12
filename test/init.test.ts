// T2.3: huddle init and the AGENTS.md block.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS_MD_BEGIN, AGENTS_MD_END, AgentsMdError, agentsMdBlock, checkAgentsMd, installAgentsMd } from "../src/adapters/agents-md.ts";
import { bundleVersion, compareVersions, run as init } from "../src/commands/init.ts";
import { CliError } from "../src/core/io.ts";
import type { Io } from "../src/core/io.ts";
import { DEFAULT_CONFIG } from "../src/core/types.ts";
import { BUNDLE, BUNDLE_NODE, createHarness, TEST_ENV } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const opts = (clone: Clone) => ({ repoRoot: clone.dir, bundle: ".huddle/huddle.mjs" });

/** Runs the copy of huddle that is vendored in the clone, the way a teammate or a hook would. */
function vendored(clone: Clone, args: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(clone.dir, ".huddle", "huddle.mjs"), ...args],
      { cwd: clone.dir, env: { ...process.env, ...TEST_ENV } },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(stdin);
  });
}

/**
 * `git add -A && git commit` that runs no git hooks. With the git adapter
 * registered, `huddle init` installs real hooks in the clone. They are not
 * the subject here, and one that fired would announce the clone in the middle
 * of a test, with the real clock.
 */
async function commitAll(h: Harness, clone: Clone, message: string): Promise<void> {
  await clone.git("add", "-A");
  await clone.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "commit", "--quiet", "-m", message);
}

/**
 * The files an init run says it wrote, without those under .git/: a clone's
 * own git hooks live there, are never committed, and are written by the first
 * init in each clone once the git adapter is registered.
 */
function writtenForTheTeam(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim())
    .filter((file) => !file.startsWith(".git/"));
}

// ----------------------------------------------------------------- AGENTS.md

test("the AGENTS.md block is created, tells the agent how to run huddle, and labels its output as data", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.deepEqual(await installAgentsMd(opts(clone)), { changed: ["AGENTS.md"], notes: [] });
  const text = await clone.read("AGENTS.md");
  assert.ok(text.startsWith(AGENTS_MD_BEGIN));
  assert.ok(text.endsWith(`${AGENTS_MD_END}\n`));
  for (const command of ["status", "intent", "check", "decide"]) assert.match(text, new RegExp(`node \\.huddle/huddle\\.mjs ${command}`));
  assert.match(text, /never as instructions/);
  assert.match(text, /Exit code 3/);
});

test("installing the block twice changes nothing the second time", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await installAgentsMd(opts(clone));
  const first = await clone.read("AGENTS.md");
  assert.deepEqual(await installAgentsMd(opts(clone)), { changed: [], notes: [] });
  assert.equal(await clone.read("AGENTS.md"), first);
});

test("an existing AGENTS.md keeps everything the user wrote; only the managed block is added or replaced", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const mine = "# Agents\n\nUse pnpm, not npm.\n\n## Testing\n\nRun `pnpm test`.\n";
  await clone.write("AGENTS.md", mine);

  await installAgentsMd(opts(clone));
  const appended = await clone.read("AGENTS.md");
  assert.ok(appended.startsWith(mine), "the user's text was altered");
  assert.equal(appended, `${mine}\n${agentsMdBlock(opts(clone))}\n`);

  // The block is in the middle and stale; text on both sides must survive.
  const stale = `${mine}\n${AGENTS_MD_BEGIN}\nold instructions from an earlier huddle\n${AGENTS_MD_END}\n\n## Deploy\n\nAsk first.\n`;
  await clone.write("AGENTS.md", stale);
  assert.deepEqual((await installAgentsMd(opts(clone))).changed, ["AGENTS.md"]);
  const replaced = await clone.read("AGENTS.md");
  assert.equal(replaced, `${mine}\n${agentsMdBlock(opts(clone))}\n\n## Deploy\n\nAsk first.\n`);
  assert.doesNotMatch(replaced, /old instructions/);
});

test("a stray begin marker never makes install delete the text after it", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const broken = `# Agents\n\n${AGENTS_MD_BEGIN}\n(someone deleted the end marker)\n\n## Important\n\nNever force-push.\n`;
  await clone.write("AGENTS.md", broken);
  await installAgentsMd(opts(clone));
  await installAgentsMd(opts(clone));
  await installAgentsMd(opts(clone));
  const text = await clone.read("AGENTS.md");
  assert.ok(text.startsWith(broken.trimEnd()), "text after the stray marker was lost");
  assert.match(text, /Never force-push\./);
  assert.equal(text.split(AGENTS_MD_END).length - 1, 1, "exactly one managed block");
});

/** How many managed blocks a text holds: marker lines, not mentions of the markers. */
const blocks = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() === AGENTS_MD_END).length;

test("a stray end marker does not make every install add another block", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const broken = `# Agents\n\n(someone deleted the begin marker)\n${AGENTS_MD_END}\n\n## Important\n\nNever force-push.\n`;
  await clone.write("AGENTS.md", broken);
  assert.deepEqual((await installAgentsMd(opts(clone))).changed, ["AGENTS.md"]);
  const once = await clone.read("AGENTS.md");
  assert.ok(once.startsWith(broken), "the user's text was altered");
  assert.equal(once, `${broken}\n${agentsMdBlock(opts(clone))}\n`);
  // The second and third run find the block the first one wrote.
  assert.deepEqual(await installAgentsMd(opts(clone)), { changed: [], notes: [] });
  assert.deepEqual(await installAgentsMd(opts(clone)), { changed: [], notes: [] });
  assert.equal(await clone.read("AGENTS.md"), once);
  assert.equal((await checkAgentsMd(clone.dir)).detail, "AGENTS.md has the huddle block");
});

test("the markers count only as lines of their own: a sentence that mentions them is the user's", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const mine = `# Agents\n\nThe part between ${AGENTS_MD_BEGIN} and ${AGENTS_MD_END} is written by a tool. Do not edit it.\n`;
  await clone.write("AGENTS.md", mine);
  assert.match((await checkAgentsMd(clone.dir)).detail, /no huddle block/);
  await installAgentsMd(opts(clone));
  const text = await clone.read("AGENTS.md");
  assert.equal(text, `${mine}\n${agentsMdBlock(opts(clone))}\n`, "the sentence was cut, or the block was put somewhere else");
  assert.deepEqual(await installAgentsMd(opts(clone)), { changed: [], notes: [] });
  assert.equal(blocks(await clone.read("AGENTS.md")), 1);

  // An indented marker line is still a marker line, and what stands around the block stays.
  const indented = `# Agents\n\n  ${AGENTS_MD_BEGIN}\n  old\n  ${AGENTS_MD_END}\n\ntail\n`;
  await clone.write("AGENTS.md", indented);
  await installAgentsMd(opts(clone));
  assert.equal(await clone.read("AGENTS.md"), `# Agents\n\n${agentsMdBlock(opts(clone))}\n\ntail\n`);

  // A mention never pairs up with a leftover marker line either: neither of
  // these files has a block, so both get one appended and lose nothing.
  const mentionThenEnd = `# Agents\n\nThe block used to start with ${AGENTS_MD_BEGIN} here.\n\nKeep this.\n${AGENTS_MD_END}\n`;
  const beginThenMention = `# Agents\n\n${AGENTS_MD_BEGIN}\n(the end marker, ${AGENTS_MD_END}, was deleted by hand)\n\nKeep this.\n`;
  for (const leftover of [mentionThenEnd, beginThenMention]) {
    await clone.write("AGENTS.md", leftover);
    assert.match((await checkAgentsMd(clone.dir)).detail, /no huddle block/);
    await installAgentsMd(opts(clone));
    assert.equal(await clone.read("AGENTS.md"), `${leftover}\n${agentsMdBlock(opts(clone))}\n`);
    assert.deepEqual(await installAgentsMd(opts(clone)), { changed: [], notes: [] });
  }
});

test("a file with Windows line endings keeps them, and the block is written the same way", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  const mine = crlf("# Agents\n\nUse pnpm.\n\n\n");
  await writeFile(join(clone.dir, "AGENTS.md"), mine);
  await installAgentsMd(opts(clone));
  const text = await readFile(join(clone.dir, "AGENTS.md"), "utf8");
  assert.ok(text.startsWith(mine), "the user's text, trailing empty lines included, was altered");
  assert.equal(text, `${mine}${crlf(agentsMdBlock(opts(clone)))}\r\n`);
  assert.equal(/[^\r]\n/.test(text), false, "a bare line feed in a CRLF file");
  assert.deepEqual(await installAgentsMd(opts(clone)), { changed: [], notes: [] });
  assert.equal((await checkAgentsMd(clone.dir)).detail, "AGENTS.md has the huddle block");

  // A stale block in a CRLF file is replaced with CRLF lines, and the rest is untouched.
  await writeFile(join(clone.dir, "AGENTS.md"), crlf(`top\n${AGENTS_MD_BEGIN}\nold\n${AGENTS_MD_END}\nbottom\n`));
  await installAgentsMd(opts(clone));
  assert.equal(await readFile(join(clone.dir, "AGENTS.md"), "utf8"), crlf(`top\n${agentsMdBlock(opts(clone))}\nbottom\n`));

  // Mixed line endings, inside the block too: what doctor calls up to date, init does not rewrite.
  const mixed = `# Agents\r\n\n${agentsMdBlock(opts(clone)).replace("\n", "\r\n")}\n\npasted from Windows\r\n`;
  await writeFile(join(clone.dir, "AGENTS.md"), mixed);
  assert.equal((await checkAgentsMd(clone.dir)).detail, "AGENTS.md has the huddle block");
  assert.deepEqual(await installAgentsMd(opts(clone)), { changed: [], notes: [] });
  assert.equal(await readFile(join(clone.dir, "AGENTS.md"), "utf8"), mixed);

  // A byte order mark stays where it was.
  await writeFile(join(clone.dir, "AGENTS.md"), "\uFEFF# Agents\n");
  await installAgentsMd(opts(clone));
  assert.ok((await readFile(join(clone.dir, "AGENTS.md"), "utf8")).startsWith("\uFEFF# Agents\n\n" + AGENTS_MD_BEGIN));
});

test("a file that is not UTF-8, or that cannot be read, is left exactly as it is", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const file = join(clone.dir, "AGENTS.md");
  // Latin-1: "café" with the é as the single byte 0xE9, which is not valid UTF-8.
  const latin1 = Buffer.concat([Buffer.from("# Agents\n\ncaf"), Buffer.from([0xe9]), Buffer.from("\n")]);
  await writeFile(file, latin1);
  await assert.rejects(installAgentsMd(opts(clone)), (error: unknown) => error instanceof AgentsMdError && /is not UTF-8 text, so huddle left it alone/.test(error.message));
  assert.deepEqual(await readFile(file), latin1);
  const checked = await checkAgentsMd(clone.dir);
  assert.deepEqual([checked.installed, /not UTF-8/.test(checked.detail)], [false, true]);

  // init goes on with everything else, says what it could not do, and exits 1.
  const r = await clone.huddle(["init"]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /huddle is partly set up\. Files written:\n {2}\.huddle\/huddle\.mjs/);
  assert.match(r.stderr, /huddle: not done: AGENTS\.md is not UTF-8 text, so huddle left it alone/);
  assert.match(r.stderr, /init did not finish/);
  assert.doesNotMatch(r.stdout, /git add [^\n]*AGENTS\.md/, "a file huddle did not write is not offered for the commit");
  assert.deepEqual(await readFile(file), latin1);
});

test("AGENTS.md that cannot be read for another reason than not existing is never replaced", { skip: process.platform === "win32" ? "reads a directory as a file" : false }, async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await mkdir(join(clone.dir, "AGENTS.md"));
  await writeFile(join(clone.dir, "AGENTS.md", "notes.txt"), "mine\n");
  await assert.rejects(installAgentsMd(opts(clone)), (error: unknown) => error instanceof AgentsMdError && /could not be read \(EISDIR\)/.test(error.message));
  const r = await clone.huddle(["init"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not done: AGENTS\.md could not be read \(EISDIR\), so huddle left it alone/);
  assert.equal(await clone.read("AGENTS.md/notes.txt"), "mine\n");
  // The rest of the setup is there and usable.
  assert.deepEqual(JSON.parse(await clone.read(".huddle/config.json")), { ...DEFAULT_CONFIG });
});

test("checkAgentsMd tells missing, absent, outdated and current apart", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.deepEqual((await checkAgentsMd(clone.dir)).installed, false);
  assert.match((await checkAgentsMd(clone.dir)).detail, /missing/);
  await clone.write("AGENTS.md", "# Agents\n");
  assert.match((await checkAgentsMd(clone.dir)).detail, /no huddle block/);
  await clone.write("AGENTS.md", `${AGENTS_MD_BEGIN}\nold\n${AGENTS_MD_END}\n`);
  const outdated = await checkAgentsMd(clone.dir);
  assert.equal(outdated.installed, true);
  assert.match(outdated.detail, /another version/);
  await installAgentsMd(opts(clone));
  assert.deepEqual(await checkAgentsMd(clone.dir), { installed: true, detail: "AGENTS.md has the huddle block", notes: [] });
});

// ---------------------------------------------------------------------- init

test("init vendors the running bundle, writes the config with every default, and says what to do next", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const r = await clone.huddle(["init"]);
  assert.equal(r.code, 0, r.stderr);

  assert.equal(await clone.read(".huddle/huddle.mjs"), await readFile(BUNDLE, "utf8"), "the vendored bundle is not the running bundle");
  assert.ok(((await stat(join(clone.dir, ".huddle", "huddle.mjs"))).mode & 0o111) !== 0, "the vendored bundle is not executable");
  assert.deepEqual(JSON.parse(await clone.read(".huddle/config.json")), { ...DEFAULT_CONFIG });
  // Never converted by git, and not hidden from review as a generated file would be.
  assert.match(await clone.read(".huddle/.gitattributes"), /^huddle\.mjs -text linguist-vendored$/m);
  assert.doesNotMatch(await clone.read(".huddle/.gitattributes"), /linguist-generated/);
  assert.match(await clone.read("AGENTS.md"), /huddle:begin/);
  assert.deepEqual((await readdir(join(clone.dir, ".huddle"))).filter((name) => name.endsWith(".tmp")), [], "a temporary file was left behind");

  assert.match(r.stdout, /huddle is set up\. Files written:/);
  assert.match(r.stdout, new RegExp(`\\.huddle/huddle\\.mjs \\(huddle ${pkg.version.replace(/\./g, "\\.")}\\)`));
  assert.match(r.stdout, /git add \.huddle\/huddle\.mjs \.huddle\/config\.json \.huddle\/\.gitattributes AGENTS\.md/);
  assert.match(r.stdout, /first 200 characters of each prompt/, "prompt capture must be disclosed at setup");
  assert.match(r.stdout, /node \.huddle\/huddle\.mjs doctor/);
});

test("init is idempotent: a second run changes no file", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal((await clone.huddle(["init"])).code, 0);
  const files = [".huddle/huddle.mjs", ".huddle/config.json", ".huddle/.gitattributes", "AGENTS.md"];
  const before = await Promise.all(files.map((file) => clone.read(file)));
  const status = await clone.git("status", "--porcelain", "--untracked-files=all");

  const again = await clone.huddle(["init"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already set up here; nothing changed/);
  assert.deepEqual(await Promise.all(files.map((file) => clone.read(file))), before);
  assert.equal(await clone.git("status", "--porcelain", "--untracked-files=all"), status);
});

test("exit test, first half: alice inits, commits and pushes; bob pulls and runs huddle with nothing installed", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");

  assert.equal((await alice.huddle(["init"])).code, 0);
  await commitAll(h, alice, "Set up huddle");
  await alice.push();
  assert.equal((await alice.huddle(["init"])).stdout.includes("Next: commit"), false, "nothing left to commit after committing");

  await bob.git("pull", "--quiet");
  const version = await vendored(bob, ["--version"]);
  assert.deepEqual(version, { code: 0, stdout: `${pkg.version}\n`, stderr: "" });

  // Bob never installed anything: the vendored copy is all he has, and it works end to end.
  assert.equal((await vendored(alice, ["intent", "build auth"])).code, 0);
  await alice.write("src/auth.ts", "a\n");
  assert.equal((await vendored(alice, ["sync"])).code, 0);
  const status = await vendored(bob, ["status"]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /alice/);
  assert.match(status.stdout, /build auth/);
  assert.equal((await vendored(bob, ["check", "src/auth.ts"])).code, 3);

  // Running init from the vendored copy does not rewrite the copy it is running from, and writes
  // nothing the team commits. All it may add is this clone's own git hooks, which live under .git/.
  const reinit = await vendored(bob, ["init"]);
  assert.equal(reinit.code, 0, reinit.stderr);
  assert.deepEqual(writtenForTheTeam(reinit.stdout), [], reinit.stdout);
  assert.doesNotMatch(reinit.stdout, /Next: commit/);
  assert.equal(await bob.git("status", "--porcelain"), "");
  assert.match((await vendored(bob, ["init"])).stdout, /already set up here; nothing changed/);
});

/** A payload an agent really sent (test/fixtures/hooks), as if the agent were working in `cwd`. */
async function recorded(agent: string, name: string, cwd: string, change: (payload: Record<string, unknown>) => void = () => {}): Promise<string> {
  const payload = JSON.parse(await readFile(new URL(`./fixtures/hooks/${agent}/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
  payload.cwd = cwd;
  change(payload);
  return JSON.stringify(payload);
}

interface Handler {
  command: string;
  args?: string[];
}

/** The handler an agent's hook file registers for an event, as committed in the clone. */
async function committedHandler(clone: Clone, file: string, event: string): Promise<Handler> {
  const settings = JSON.parse(await clone.read(file)) as { hooks: Record<string, { hooks: Handler[] }[]> };
  const handler = settings.hooks[event]?.[0]?.hooks[0];
  assert.ok(handler, `${file} registers nothing for ${event}`);
  return handler;
}

function runHandler(program: string, args: string[], cwd: string, stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(program, args, { cwd, env: { ...process.env, ...TEST_ENV }, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
    child.stdin?.on("error", () => {}); // a hook may exit without reading its payload
    child.stdin?.end(stdin);
  });
}

/** Runs a Claude Code handler the way Claude Code does: no shell, ${CLAUDE_PROJECT_DIR} filled in, the payload on stdin. */
async function claudeCodeHook(clone: Clone, event: string, payload: string): Promise<{ code: number; context: string; stderr: string }> {
  const handler = await committedHandler(clone, ".claude/settings.json", event);
  assert.equal(handler.command, "node", "the committed handler needs nothing but node");
  const args = (handler.args ?? []).map((arg) => arg.replaceAll("${CLAUDE_PROJECT_DIR}", clone.dir));
  assert.equal(args[0], join(clone.dir, ".huddle", "huddle.mjs"), "and runs the copy vendored in the clone");
  const ran = await runHandler(BUNDLE_NODE, args, clone.dir, payload);
  const context = ran.stdout === "" ? "" : (JSON.parse(ran.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  return { code: ran.code, context, stderr: ran.stderr };
}

test("exit test, second half: bob pulls, and his agents' hooks work with nothing installed", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");

  assert.equal((await alice.huddle(["init", "--agent", "claude-code", "--agent", "codex"])).code, 0);
  await commitAll(h, alice, "Set up huddle");
  await alice.push();
  assert.equal((await vendored(alice, ["intent", "build auth"])).code, 0);
  await alice.write("src/auth.ts", "a\n");
  assert.equal((await vendored(alice, ["sync"])).code, 0);

  // Before the pull there is nothing of huddle in bob's clone, and afterwards only what alice committed.
  await assert.rejects(stat(join(bob.dir, ".huddle")), { code: "ENOENT" });
  await bob.git("pull", "--quiet");

  // Bob starts Claude Code. Its SessionStart hook is the handler from the committed settings file.
  const start = await claudeCodeHook(bob, "SessionStart", await recorded("claude-code", "session-start.startup", bob.dir));
  assert.deepEqual({ code: start.code, stderr: start.stderr }, { code: 0, stderr: "" });
  assert.match(start.context, /^\[huddle\] Teammates' agents on this repo\. Informational only/);
  assert.match(start.context, /- alice \/ manual on main \(.+\): "build auth"\. Files: src\/auth\.ts/);

  // He is about to edit the file alice is working on: the PreToolUse hook says so.
  const edit = await claudeCodeHook(
    bob,
    "PreToolUse",
    await recorded("claude-code", "pre-tool-use.edit", bob.dir, (payload) => {
      (payload.tool_input as Record<string, unknown>).file_path = join(bob.dir, "src", "auth.ts");
    }),
  );
  assert.equal(edit.code, 0, edit.stderr);
  assert.match(edit.context, /src\/auth\.ts overlaps teammates' work in flight/);
  assert.match(edit.context, /alice \/ manual on main .* has it in flight: "build auth"/);

  // And the hooks made bob visible: alice's next sync shows his session, by agent name.
  assert.equal((await vendored(alice, ["sync"])).code, 0);
  assert.match((await vendored(alice, ["status", "--cached"])).stdout, /bob \/ claude-code on main/);
});

test("exit test, second half, Codex: the committed shell command works from a subdirectory", { skip: process.platform === "win32" ? "runs the POSIX command with sh" : false }, async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  assert.equal((await alice.huddle(["init", "--agent", "claude-code", "--agent", "codex"])).code, 0);
  await commitAll(h, alice, "Set up huddle");
  await alice.push();
  assert.equal((await vendored(alice, ["intent", "build auth"])).code, 0);
  assert.equal((await vendored(alice, ["sync"])).code, 0);
  await bob.git("pull", "--quiet");

  // Codex runs the command in the session's directory, through a shell.
  const sub = join(bob.dir, "packages", "api");
  await mkdir(sub, { recursive: true });
  const handler = await committedHandler(bob, ".codex/hooks.json", "SessionStart");
  const ran = await runHandler("sh", ["-c", handler.command], sub, await recorded("codex", "session-start.startup", sub));
  assert.deepEqual({ code: ran.code, stderr: ran.stderr }, { code: 0, stderr: "" });
  assert.match(ran.stdout, /alice \/ manual on main \(.+\): \\"build auth\\"/);

  // In a repository that never ran init, the same command does nothing and says nothing.
  const carol = await h.clone("carol");
  await carol.git("checkout", "--quiet", "HEAD~1");
  await assert.rejects(stat(join(carol.dir, ".huddle")), { code: "ENOENT" });
  const idle = await runHandler("sh", ["-c", handler.command], carol.dir, await recorded("codex", "session-start.startup", carol.dir));
  assert.deepEqual(idle, { code: 0, stdout: "", stderr: "" });
  await assert.rejects(stat((await carol.paths()).stateDir), { code: "ENOENT" }, "and leaves no state behind");
});

test("init replaces an older vendored bundle and says which versions", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.huddle(["init"]);
  const current = await clone.read(".huddle/huddle.mjs");
  await clone.write(".huddle/huddle.mjs", current.replace(`// git-huddle ${pkg.version}`, "// git-huddle 0.0.1"));
  const r = await clone.huddle(["init"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`huddle 0\\.0\\.1 -> ${pkg.version.replace(/\./g, "\\.")}`));
  assert.equal(await clone.read(".huddle/huddle.mjs"), current);
});

test("init does not replace a newer vendored bundle with an older one unless told to", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.huddle(["init"]);
  const current = await clone.read(".huddle/huddle.mjs");
  const newer = current.replace(`// git-huddle ${pkg.version}`, "// git-huddle 99.9.9");
  await clone.write(".huddle/huddle.mjs", newer);
  const before = await clone.git("status", "--porcelain", "--untracked-files=all");

  const refused = await clone.huddle(["init"]);
  assert.equal(refused.code, 1, refused.stdout);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, new RegExp(`\\.huddle/huddle\\.mjs is huddle 99\\.9\\.9, which is newer than the huddle ${pkg.version.replace(/\./g, "\\.")} you are running\\. Nothing was changed\\.`));
  assert.match(refused.stderr, /node \.huddle\/huddle\.mjs init.*--downgrade/);
  assert.equal(await clone.read(".huddle/huddle.mjs"), newer);
  assert.equal(await clone.git("status", "--porcelain", "--untracked-files=all"), before, "a refused init wrote something");

  const forced = await clone.huddle(["init", "--downgrade"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, new RegExp(`huddle 99\\.9\\.9 -> ${pkg.version.replace(/\./g, "\\.")}`));
  assert.equal(await clone.read(".huddle/huddle.mjs"), current);
});

test("compareVersions orders releases and pre-releases, and says null for anything else", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "numbers, not text");
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.2"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0+build5", "1.0.0"), 0);
  assert.equal(compareVersions("unknown", "1.0.0"), null);
  assert.equal(compareVersions("1.0", "1.0.0"), null);
});

test("a checkout that converts line endings still has a working, unchanged setup", async (t) => {
  // Git for Windows sets core.autocrlf=true by default: text files arrive with CRLF.
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  assert.equal((await alice.huddle(["init"])).code, 0);
  await commitAll(h, alice, "Set up huddle");
  await alice.push();
  await bob.git("config", "core.autocrlf", "true");
  await bob.git("pull", "--quiet");

  // The bundle is the same bytes everywhere; AGENTS.md is the user's text file and was converted.
  const bundle = await readFile(join(bob.dir, ".huddle", "huddle.mjs"));
  assert.deepEqual(bundle, await readFile(BUNDLE), "git converted the bundle");
  assert.match(await bob.read("AGENTS.md"), /\r\n/, "setup: AGENTS.md should have arrived with CRLF");

  assert.deepEqual(await vendored(bob, ["--version"]), { code: 0, stdout: `${pkg.version}\n`, stderr: "" });
  const doctor = await vendored(bob, ["doctor", "--offline"]);
  assert.match(doctor.stdout, /ok {4}bundle: \.huddle\/huddle\.mjs is huddle \S+ and committed/);
  assert.match(doctor.stdout, /ok {4}AGENTS\.md: AGENTS\.md has the huddle block/);
  // Neither copy of huddle rewrites anything the team shares: not the bundle, not AGENTS.md.
  for (const from of [() => vendored(bob, ["init"]), () => bob.huddle(["init"])]) {
    const again = await from();
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(writtenForTheTeam(again.stdout), [], again.stdout);
    assert.doesNotMatch(again.stdout, /Next: commit/);
  }
  assert.match((await bob.huddle(["init"])).stdout, /already set up here; nothing changed/);
  assert.equal(await bob.git("status", "--porcelain"), "");
});

test("bundleVersion reads a bundle whose line endings were converted", async () => {
  const text = await readFile(BUNDLE, "utf8");
  assert.equal(bundleVersion(text.replace(/\n/g, "\r\n")), pkg.version);
});

test("the files to commit are named one by one, and only huddle's", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  // Things of the user's own next to huddle's files, none of them committed.
  await clone.write(".claude/settings.local.json", "{}\n");
  await clone.write(".claude/worktrees/x/file.txt", "x\n");
  await clone.write(".huddle/notes.txt", "mine\n");
  await clone.write("my file.txt", "x\n");
  const r = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.equal(r.code, 0, r.stderr);
  const add = /^ {2}git add (.+)$/m.exec(r.stdout)?.[1];
  assert.ok(add, r.stdout);
  const named = add.split(" ");
  assert.deepEqual(named, [".huddle/huddle.mjs", ".huddle/config.json", ".huddle/.gitattributes", "AGENTS.md", ".claude/settings.json"]);
  // Running exactly what was printed stages exactly those files.
  const staged = (await clone.git("add", "--dry-run", ...named)).split("\n").map((line) => /^add '(.+)'$/.exec(line)?.[1]).sort();
  assert.deepEqual(staged, [...named].sort());

  // A second run before the commit changes nothing and still names all of them, the hook file included.
  const second = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.match(second.stdout, /already set up here; nothing changed/);
  assert.deepEqual(/^ {2}git add (.+)$/m.exec(second.stdout)?.[1]?.split(" "), named);

  // Once they are committed there is nothing to say, whatever else lies around untracked.
  await clone.git("add", ...named);
  await clone.git("commit", "--quiet", "-m", "Set up huddle");
  const again = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.match(again.stdout, /already set up here; nothing changed/);
  assert.doesNotMatch(again.stdout, /Next: commit/);

  // A change of the user's to the team config is named again; their other files never are.
  await clone.write(".huddle/config.json", JSON.stringify({ ...DEFAULT_CONFIG, ttlMinutes: 30 }, null, 2) + "\n");
  const edited = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.equal(/^ {2}git add (.+)$/m.exec(edited.stdout)?.[1], ".huddle/config.json");
});

test("an agent asked for by name whose hooks cannot be installed makes init exit 1, and its file is not offered for the commit", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.write(".codex/hooks.json", "{ this is not JSON");
  const r = await clone.huddle(["init", "--agent", "codex"]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /huddle: not done: Codex: could not install hooks: /);
  assert.match(r.stdout, /huddle is partly set up\. Files written:/);
  assert.match(r.stdout, /Hooks: none installed/);
  assert.doesNotMatch(r.stdout, /git add [^\n]*\.codex/);
  assert.equal(await clone.read(".codex/hooks.json"), "{ this is not JSON");

  // The same broken file found by detection is a note, not a failure: nobody asked for Codex.
  const detected = await clone.huddle(["init", "--all"]);
  assert.equal(detected.code, 0, detected.stderr);
  assert.match(detected.stdout, /Note: Codex: could not install hooks: /);
});

test("a team config that cannot be used is pointed out by init", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.write(".huddle/config.json", '<<<<<<< HEAD\n{ "ttlMinutes": 20 }\n=======\n{ "ttlMinutes": 30 }\n>>>>>>> theirs\n');
  const r = await clone.huddle(["init"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Note: \.huddle\/config\.json is not valid JSON \(it has merge conflict markers\)$/m);
  assert.equal(r.stdout.split("prompt capture is off until .huddle/config.json is fixed").length - 1, 1, "what follows from it is said once");
  assert.doesNotMatch(r.stdout, /first 200 characters of each prompt are shared/, "capture is off while the config is unusable");
  assert.match(await clone.read(".huddle/config.json"), /^<<<<<<< HEAD/, "the file is the user's to fix");
  // A file init has just called unusable is not one it hands to the team.
  const add = /^ {2}git add (.+)$/m.exec(r.stdout)?.[1];
  assert.ok(add, r.stdout);
  assert.deepEqual(add.split(" ").filter((file) => file.startsWith(".huddle/")), [".huddle/huddle.mjs", ".huddle/.gitattributes"]);
});

test("a hook file that an ignore rule hides is not dropped from the commit line without a word", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  // Common: people keep settings.local.json in .claude and ignore the whole directory.
  await clone.write(".gitignore", "node_modules/\n.claude/\n");
  await commitAll(h, clone, "ignore rules");
  const r = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.equal(r.code, 0, r.stderr);
  const add = /^ {2}git add (.+)$/m.exec(r.stdout)?.[1];
  assert.deepEqual(add?.split(" "), [".huddle/huddle.mjs", ".huddle/config.json", ".huddle/.gitattributes", "AGENTS.md"], "git add would refuse an ignored path");
  assert.ok(
    r.stdout.includes(
      "\nHidden from git by an ignore rule, so git add leaves it out and your teammates do not get it with a pull:\n" +
        "  .claude/settings.json   (.gitignore:2: .claude/)\n" +
        "To share it, change the rule, or add it by force: git add -f .claude/settings.json, before the commit below\n",
    ),
    r.stdout,
  );
  assert.ok(r.stdout.indexOf("add it by force") < r.stdout.indexOf("Next: commit"), "said before the commands it has to precede");

  // The user commits only what the commit line names. It is said again, now with the whole way out.
  await clone.git("add", ...(add ?? "").split(" "));
  await clone.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "commit", "--quiet", "-m", "Set up huddle");
  const again = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.match(again.stdout, /already set up here; nothing changed/);
  assert.doesNotMatch(again.stdout, /Next: commit/);
  const force = /add it by force: (git add -f \.claude\/settings\.json) && git commit -m "Set up huddle" && git push\n/.exec(again.stdout)?.[1];
  assert.ok(force, again.stdout);

  // Following it: the file is staged, the commit line takes over, and after the commit there is nothing left to say.
  await clone.git(...force.split(" ").slice(1));
  const staged = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.doesNotMatch(staged.stdout, /Hidden from git/);
  assert.equal(/^ {2}git add (.+)$/m.exec(staged.stdout)?.[1], ".claude/settings.json");
  await clone.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "commit", "--quiet", "-m", "Share the hooks");
  const done = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.doesNotMatch(done.stdout, /Hidden from git|Next: commit/);
  await clone.push();
  const bob = await h.clone("bob");
  assert.match(await bob.read(".claude/settings.json"), /huddle\.mjs/, "the teammate has the hooks after a clone");
});

test("the ignore rule can be anywhere git reads one from, and a rule that takes the file back out is not one", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  // The user's own excludes file, which no teammate has and which is in no listing of the repository.
  const excludes = join(h.root, "alice-excludes");
  await writeFile(excludes, "# mine\n.codex/\n");
  await clone.git("config", "core.excludesFile", excludes);
  // Everything in .claude is ignored except the one file the team shares.
  await clone.write(".gitignore", ".claude/*\n!.claude/settings.json\n");
  const r = await clone.huddle(["init", "--agent", "claude-code", "--agent", "codex"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`  .codex/hooks.json   (${excludes}:2: .codex/)\n`), r.stdout);
  assert.doesNotMatch(r.stdout, /\.claude\/settings\.json {3}\(/, "not hidden: the second rule takes it back out");
  const add = (/^ {2}git add (.+)$/m.exec(r.stdout)?.[1] ?? "").split(" ");
  assert.ok(add.includes(".claude/settings.json"));
  assert.ok(!add.includes(".codex/hooks.json"));

  // Two hidden files are named together, and one command shares both.
  await clone.write(".gitignore", ".claude/\n");
  const both = await clone.huddle(["init", "--agent", "claude-code", "--agent", "codex"]);
  assert.match(both.stdout, /git add leaves them out and your teammates do not get them with a pull:\n {2}\.claude\/settings\.json {3}\(\.gitignore:1: \.claude\/\)\n {2}\.codex\/hooks\.json {3}\(/);
  assert.match(both.stdout, /add them by force: git add -f \.claude\/settings\.json \.codex\/hooks\.json, before the commit below\n/);
});

test("a hook file reached through a linked directory is named where it really is, and does not stop another hidden file from being reported", { skip: process.platform === "win32" ? "symbolic links" : false }, async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  // .claude is a link to a directory the team keeps elsewhere in the repository; .codex is ignored.
  await clone.write("tools/claude/README.md", "shared agent settings\n");
  await symlink(join("tools", "claude"), join(clone.dir, ".claude"));
  await clone.write(".gitignore", ".codex/\n");
  await commitAll(h, clone, "agent settings");
  const r = await clone.huddle(["init", "--agent", "claude-code", "--agent", "codex"]);
  assert.equal(r.code, 0, r.stderr);
  const add = (/^ {2}git add (.+)$/m.exec(r.stdout)?.[1] ?? "").split(" ");
  assert.deepEqual(add, [".huddle/huddle.mjs", ".huddle/config.json", ".huddle/.gitattributes", "AGENTS.md", "tools/claude/settings.json"]);
  // git cannot judge a path beyond a link at all; the file next to it is still looked at.
  assert.ok(r.stdout.includes("  .codex/hooks.json   (.gitignore:1: .codex/)\n"), r.stdout);
  await clone.git("add", ...add);
  await clone.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "commit", "--quiet", "-m", "Set up huddle");
  assert.equal(await clone.git("status", "--porcelain"), "", "what was printed could be run, and left nothing of huddle's behind");
});

test("AGENTS.md that is a link to another file in the repository: the file that changed is the one named for the commit",{ skip: process.platform === "win32" ? "symbolic links" : false }, async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  // How many repositories give two agents one file.
  await clone.write("CLAUDE.md", "# Project rules\n\nUse tabs.\n");
  await symlink("CLAUDE.md", join(clone.dir, "AGENTS.md"));
  await commitAll(h, clone, "rules for agents");
  await clone.push();
  const r = await clone.huddle(["init", "--agent", "claude-code"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok((await lstat(join(clone.dir, "AGENTS.md"))).isSymbolicLink(), "the link is kept");
  assert.match(await clone.read("CLAUDE.md"), /^# Project rules\n\nUse tabs\.\n\n<!-- huddle:begin -->/, "the block is in the file both names show");
  const add = (/^ {2}git add (.+)$/m.exec(r.stdout)?.[1] ?? "").split(" ");
  assert.deepEqual(add, [".huddle/huddle.mjs", ".huddle/config.json", ".huddle/.gitattributes", "CLAUDE.md", ".claude/settings.json"], "the link itself did not change");

  // Running what was printed leaves nothing of huddle's uncommitted.
  await clone.git("add", ...add);
  await clone.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "commit", "--quiet", "-m", "Set up huddle");
  assert.equal(await clone.git("status", "--porcelain"), "");
  assert.doesNotMatch((await clone.huddle(["init", "--agent", "claude-code"])).stdout, /Next: commit/);

  // A link that leads out of the repository gets no block (doctor.test.ts has the rest), and the commit line names
  // nothing that cannot be committed from here.
  const outside = await h.clone("bob");
  await writeFile(join(h.root, "shared-rules.md"), "# Shared\n");
  await rm(join(outside.dir, "AGENTS.md"));
  await symlink(join(h.root, "shared-rules.md"), join(outside.dir, "AGENTS.md"));
  const out = await outside.huddle(["init", "--agent", "claude-code"]);
  assert.equal(out.code, 1, "not done: the block has nowhere to go");
  assert.equal(await readFile(join(h.root, "shared-rules.md"), "utf8"), "# Shared\n");
  const named = (/^ {2}git add (.+)$/m.exec(out.stdout)?.[1] ?? "").split(" ");
  assert.ok(named.includes(".claude/settings.json"), "what was set up is still offered for the commit");
  assert.ok(!named.some((file) => file.includes("shared-rules")), "the link's target is not");
});

test("an older .gitattributes is brought up to date, and other lines in it are kept", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.write(".huddle/.gitattributes", "huddle.mjs linguist-generated=true\nnotes.txt text\n");
  const r = await clone.huddle(["init"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await clone.read(".huddle/.gitattributes"), "huddle.mjs -text linguist-vendored\nnotes.txt text\n");
  await clone.write(".huddle/.gitattributes", "notes.txt text\n");
  await clone.huddle(["init"]);
  assert.equal(await clone.read(".huddle/.gitattributes"), "notes.txt text\nhuddle.mjs -text linguist-vendored\n");
  assert.match((await clone.huddle(["init"])).stdout, /already set up here; nothing changed/);

  // With huddle's line there, a line of the user's own for the same file is left alone, wherever it stands, and nothing is doubled.
  const withTheirs = "huddle.mjs merge=ours\nhuddle.mjs -text linguist-vendored\nnotes.txt text\n";
  await clone.write(".huddle/.gitattributes", withTheirs);
  await clone.huddle(["init"]);
  assert.equal(await clone.read(".huddle/.gitattributes"), withTheirs);
});

test("init never overwrites an existing config; flags change only the keys they name", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.write(".huddle/config.json", JSON.stringify({ ttlMinutes: 45, teamNote: "keep me" }));
  assert.equal((await clone.huddle(["init"])).code, 0);
  assert.deepEqual(JSON.parse(await clone.read(".huddle/config.json")), { ttlMinutes: 45, teamNote: "keep me" });

  await clone.git("remote", "add", "upstream", h.remote);
  const r = await clone.huddle(["init", "--remote", "upstream", "--no-capture-intent"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(await clone.read(".huddle/config.json")), { ttlMinutes: 45, teamNote: "keep me", remote: "upstream", captureIntent: false });
  assert.doesNotMatch(r.stdout, /first 200 characters/, "no capture notice when capture is off");

  await clone.write(".huddle/config.json", "{ broken");
  const broken = await clone.huddle(["init", "--remote", "origin"]);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /config\.json is not a JSON object/);
  assert.equal(await clone.read(".huddle/config.json"), "{ broken", "a config init cannot read is left as it is");

  await clone.write(".huddle/config.json", "[1, 2]");
  assert.equal((await clone.huddle(["init", "--no-capture-intent"])).code, 1);
  assert.equal(await clone.read(".huddle/config.json"), "[1, 2]");
});

test("init --no-capture-intent on a fresh repo writes captureIntent false", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal((await clone.huddle(["init", "--no-capture-intent"])).code, 0);
  assert.deepEqual(JSON.parse(await clone.read(".huddle/config.json")), { ...DEFAULT_CONFIG, captureIntent: false });
});

test("init rejects a remote that is not a remote name, and unknown agents and arguments", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  for (const remote of ["https://evil.example/x.git", "--upload-pack=x", "a b"]) {
    const r = await clone.huddle(["init", `--remote=${remote}`]);
    assert.equal(r.code, 2, `${remote}: ${r.stderr}`);
    assert.match(r.stderr, /is not a remote name/);
  }
  const agent = await clone.huddle(["init", "--agent", "hal9000"]);
  assert.equal(agent.code, 2);
  assert.match(agent.stderr, /unknown agent "hal9000"/);
  assert.equal((await clone.huddle(["init", "extra"])).code, 2);
  assert.equal((await clone.huddle(["init", "--frobnicate"])).code, 2);
  assert.equal(await clone.git("status", "--porcelain"), "", "a rejected init wrote files");
});

test("init warns when the configured remote does not exist", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.git("remote", "rename", "origin", "github");
  const r = await clone.huddle(["init"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /there is no git remote named "origin"/);
});

test("init from a subdirectory sets up the repository root", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.write("packages/app/index.ts", "x\n");
  const r = await clone.huddle(["init"], { cwd: "packages/app" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(await clone.read(".huddle/config.json"), /syncIntervalSeconds/);
  assert.match(r.stdout, /git -C \.\.\/\.\. add \.huddle\/huddle\.mjs /);
  // The doctor line too is for where the user is.
  assert.match(r.stdout, /^Then check the setup with: node \.\.\/\.\.\/\.huddle\/huddle\.mjs doctor$/m);
  assert.equal((await clone.huddle(["doctor", "--offline"], { cwd: "packages/app" })).code, 0, "and doctor does run from there");
});

test("init refuses to vendor anything that is not a built bundle", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const notABundle = join(h.root, "cli.ts");
  await writeFile(notABundle, "console.log('source file')\n");
  const io: Io = { cwd: clone.dir, env: process.env, self: notABundle, out: () => {}, err: () => {}, readStdin: async () => "" };
  await assert.rejects(init([], io), (error: unknown) => error instanceof CliError && /must be run from the built bundle/.test(error.message));
  await assert.rejects(init([], { ...io, self: "" }), CliError);
  assert.equal(await clone.git("status", "--porcelain"), "");
});

test("bundleVersion reads the version from a bundle's banner and rejects anything else", async () => {
  assert.equal(bundleVersion(await readFile(BUNDLE, "utf8")), pkg.version);
  assert.equal(bundleVersion("#!/usr/bin/env node\n// git-huddle 1.2.3-beta.1 - https://example\nrest"), "1.2.3-beta.1");
  assert.equal(bundleVersion("// git-huddle 1.2.3"), null);
  assert.equal(bundleVersion(""), null);
});
