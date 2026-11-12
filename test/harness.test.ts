import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BUNDLE, BUNDLE_NODE, createHarness, TEST_ENV } from "./harness.ts";

test("clones share one remote: what alice pushes, bob pulls", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");

  assert.equal(await alice.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(await bob.git("rev-parse", "--abbrev-ref", "origin/HEAD"), "origin/main");
  assert.equal(await alice.git("config", "user.name"), "alice");
  assert.equal(await bob.git("config", "user.name"), "bob");

  await alice.write("src/auth.ts", "export const a = 1;\n");
  const sha = await alice.commit("Add auth");
  await alice.push();
  await bob.git("pull", "--quiet");
  assert.equal(await bob.read("src/auth.ts"), "export const a = 1;\n");
  assert.equal(await bob.git("rev-parse", "HEAD"), sha);
  assert.equal(await h.remoteGit("rev-parse", "refs/heads/main"), sha);
});

test("git is isolated from the developer's own configuration", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal(process.env.GIT_CONFIG_GLOBAL, TEST_ENV.GIT_CONFIG_GLOBAL);
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
  const origins = await clone.git("config", "--list", "--show-origin");
  for (const line of origins.split("\n")) {
    assert.ok(
      line.startsWith(`file:${TEST_ENV.GIT_CONFIG_GLOBAL}\t`) || line.startsWith("file:.git/config\t") || line.startsWith("command line:\t"),
      `config from outside the harness: ${line}`,
    );
  }
  assert.equal(await clone.git("config", "--get", "commit.gpgsign"), "false");
});

test("huddle() runs the built bundle in the clone, with a pinned clock and stdin", async (t) => {
  assert.ok(existsSync(BUNDLE), "dist/huddle.mjs is missing: run npm run build");
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const r = await clone.huddle(["--version"], { now: "2026-01-01T00:00:00Z", session: "s1", stdin: "{}", env: { EXTRA: "1" } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  const first = (await readFile(BUNDLE, "utf8")).split("\n")[0];
  assert.equal(first, "#!/usr/bin/env node");
});

test("a snapshot is stable across reads and changes when the clone changes", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const before = await clone.snapshot();
  assert.equal(before.fetchHead, null, "a fresh clone has no FETCH_HEAD");
  assert.match(before.refs, /refs\/heads\/main [0-9a-f]{40}/);
  assert.match(before.head, /^refs\/heads\/main [0-9a-f]{40}$/);

  await clone.git("status");
  await clone.git("log", "--oneline");
  await clone.huddle(["--version"]);
  assert.deepEqual(await clone.snapshot(), before);

  await clone.write("new.txt", "x");
  const dirty = await clone.snapshot();
  assert.notEqual(dirty.status, before.status);
  assert.equal(dirty.index, before.index);

  await clone.commit("Add new.txt");
  const committed = await clone.snapshot();
  assert.notEqual(committed.refs, before.refs);
  assert.notEqual(committed.index, before.index);

  await clone.git("fetch", "--quiet");
  assert.notEqual((await clone.snapshot()).fetchHead, null, "a plain fetch writes FETCH_HEAD");

  // The repository's config is part of "the clone as the user left it".
  const configured = await clone.snapshot();
  assert.match(configured.config ?? "", /^[0-9a-f]{64}$/);
  await clone.git("config", "remote.origin.pushurl", "https://example.invalid/x.git");
  const reconfigured = await clone.snapshot();
  assert.notEqual(reconfigured.config, configured.config, "a changed git config must show up in the snapshot");
  assert.deepEqual({ ...reconfigured, config: null }, { ...configured, config: null }, "and nothing else changed");
});

test("the bundle is run with HUDDLE_TEST_NODE when it is set, with this node otherwise", () => {
  assert.equal(BUNDLE_NODE, process.env.HUDDLE_TEST_NODE || process.execPath);
});

test("a linked worktree is the same clone in another directory", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const linked = await clone.addWorktree("feature");
  assert.equal(await linked.git("rev-parse", "--abbrev-ref", "HEAD"), "feature");
  assert.equal(await linked.git("config", "user.name"), "alice");
  assert.equal((await linked.paths()).commonDir, join(clone.dir, ".git"));
  assert.equal((await linked.huddle(["--version"])).code, 0);
});

test("cleanup removes the remote and every clone", async () => {
  const h = await createHarness();
  await h.clone("alice");
  assert.ok(existsSync(h.remote));
  await h.cleanup();
  assert.equal(existsSync(h.root), false);
});
