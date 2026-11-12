// T2.3: huddle init and the AGENTS.md block.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS_MD_BEGIN, AGENTS_MD_END, agentsMdBlock, checkAgentsMd, installAgentsMd } from "../src/adapters/agents-md.ts";
import { bundleVersion, run as init } from "../src/commands/init.ts";
import { CliError } from "../src/core/io.ts";
import type { Io } from "../src/core/io.ts";
import { DEFAULT_CONFIG } from "../src/core/types.ts";
import { BUNDLE, createHarness, TEST_ENV } from "./harness.ts";
import type { Clone } from "./harness.ts";

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
  assert.equal(await clone.read(".huddle/.gitattributes"), "huddle.mjs linguist-generated=true\n");
  assert.match(await clone.read("AGENTS.md"), /huddle:begin/);

  assert.match(r.stdout, /huddle is set up\. Files written:/);
  assert.match(r.stdout, new RegExp(`\\.huddle/huddle\\.mjs \\(huddle ${pkg.version.replace(/\./g, "\\.")}\\)`));
  assert.match(r.stdout, /git add \.huddle AGENTS\.md/);
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
  await alice.commit("Set up huddle");
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

  // Running init from the vendored copy does not rewrite the copy it is running from.
  const reinit = await vendored(bob, ["init"]);
  assert.equal(reinit.code, 0, reinit.stderr);
  assert.match(reinit.stdout, /already set up here; nothing changed/);
  assert.equal(await bob.git("status", "--porcelain"), "");
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
  assert.match(r.stdout, /git -C \.\.\/\.\. add \.huddle AGENTS\.md/);
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
