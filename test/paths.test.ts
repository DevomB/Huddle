import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { CliError } from "../src/core/io.ts";
import { ensureStateDir, loadConfig, locateRepo, mergeConfig, requireRepo, seenFile } from "../src/core/paths.ts";
import { DEFAULT_CONFIG } from "../src/core/types.ts";
import { createHarness } from "./harness.ts";

test("locateRepo finds the worktree, git dir and state dir from any subdirectory", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await mkdir(join(clone.dir, "src", "deep"), { recursive: true });

  for (const cwd of [clone.dir, join(clone.dir, "src", "deep")]) {
    const paths = await locateRepo(cwd);
    assert.ok(paths);
    assert.equal(paths.worktree, clone.dir);
    assert.equal(paths.gitDir, join(clone.dir, ".git"));
    assert.equal(paths.commonDir, join(clone.dir, ".git"));
    assert.equal(paths.stateDir, join(clone.dir, ".git", "huddle"));
    assert.equal(paths.actorFile, join(paths.stateDir, "actor"));
    assert.equal(paths.localFile, join(paths.stateDir, "local.json"));
    assert.equal(paths.cacheFile, join(paths.stateDir, "cache.json"));
    assert.equal(paths.syncLock, join(paths.stateDir, "sync.lock"));
    assert.equal(paths.seenDir, join(paths.stateDir, "seen"));
    assert.equal(paths.logFile, join(paths.stateDir, "log"));
    assert.equal(paths.localConfigFile, join(paths.stateDir, "config.json"));
    assert.equal(paths.teamConfigFile, join(clone.dir, ".huddle", "config.json"));
    assert.equal(paths.bundleFile, join(clone.dir, ".huddle", "huddle.mjs"));
  }
});

test("all worktrees of a clone share one state dir", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const linked = await clone.addWorktree("feature");
  const main = await clone.paths();
  const other = await linked.paths();

  assert.equal(other.worktree, linked.dir);
  assert.notEqual(other.worktree, main.worktree);
  assert.notEqual(other.gitDir, main.gitDir);
  assert.equal(other.commonDir, main.commonDir);
  assert.equal(other.stateDir, main.stateDir);
  assert.equal(other.teamConfigFile, join(linked.dir, ".huddle", "config.json"), "team config is read from the worktree in use");
});

test("outside a git repository locateRepo is null and requireRepo throws a CliError", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "huddle-norepo-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await locateRepo(dir), null);
  assert.equal(await locateRepo(join(dir, "missing")), null);
  await assert.rejects(requireRepo(dir), (error: unknown) => error instanceof CliError && /not inside a git repository/.test(error.message));
});

test("ensureStateDir creates the state and seen directories", async (t) => {
  const h = await createHarness(t);
  const paths = await (await h.clone("alice")).paths();
  await ensureStateDir(paths);
  await ensureStateDir(paths);
  assert.ok((await stat(paths.seenDir)).isDirectory());
});

test("seenFile keeps every session id inside seen/ and distinct ids apart", async (t) => {
  const h = await createHarness(t);
  const paths = await (await h.clone("alice")).paths();

  const uuid = "0b9c2f5e-6a3d-4c1b-9f7e-2d8a4b6c1e3f";
  assert.equal(seenFile(paths, uuid), join(paths.seenDir, uuid));

  const hostile = ["../../../etc/passwd", "a/b", "a\\b", "..", ".", "", "x".repeat(500), "sp ace", "nul\u0000byte"];
  const files = hostile.map((id) => seenFile(paths, id));
  for (const file of files) {
    assert.equal(dirname(file), paths.seenDir, file);
    assert.match(basename(file), /^[A-Za-z0-9_.-]{1,100}$/, file);
    assert.notEqual(basename(file), "..");
    assert.notEqual(basename(file), ".");
  }
  assert.equal(new Set(files).size, files.length, "two ids mapped to the same file");
  assert.notEqual(seenFile(paths, "a/b"), seenFile(paths, "a_b"));
  assert.equal(seenFile(paths, "a/b"), seenFile(paths, "a/b"), "stable");

  // On a case-insensitive filesystem two names that differ only by case are one file,
  // and Windows refuses device names. Compare the way such a filesystem would.
  const tricky = ["Session-A", "session-a", "SESSION-A", "con", "CON", "aux", "nul", "com1", "lpt9", "manual-0a1b2c3d"];
  const folded = tricky.map((id) => basename(seenFile(paths, id)).toLowerCase());
  assert.equal(new Set(folded).size, tricky.length, `ids collide once case is ignored: ${folded.join(", ")}`);
  // Windows reserves a device name with any extension too ("con.txt").
  for (const name of folded) assert.doesNotMatch(name, /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/, name);
  assert.equal(seenFile(paths, "session-a"), join(paths.seenDir, "session-a"), "a lower-case id is still used as it is");
  assert.equal(seenFile(paths, "manual-0a1b2c3d"), join(paths.seenDir, "manual-0a1b2c3d"));
});

test("mergeConfig starts from the defaults and lets later sources win", () => {
  assert.deepEqual(mergeConfig(), { ...DEFAULT_CONFIG });
  assert.deepEqual(mergeConfig(undefined, null, "x", [], 3), { ...DEFAULT_CONFIG });
  const merged = mergeConfig({ remote: "upstream", ttlMinutes: 30, captureIntent: false }, { ttlMinutes: 5 });
  assert.equal(merged.remote, "upstream");
  assert.equal(merged.ttlMinutes, 5);
  assert.equal(merged.captureIntent, false);
  assert.equal(merged.syncIntervalSeconds, DEFAULT_CONFIG.syncIntervalSeconds);
  assert.equal(Object.isFrozen(merged), false);
});

test("mergeConfig ignores values a teammate should not be able to set", () => {
  const hostile = mergeConfig({
    remote: "--upload-pack=touch /tmp/pwned",
    base: "--output=/etc/passwd",
    syncIntervalSeconds: 0,
    heartbeatMinutes: -1,
    ttlMinutes: "15",
    mode: "block",
    captureIntent: "yes",
  });
  assert.deepEqual(hostile, { ...DEFAULT_CONFIG });
  for (const remote of ["https://evil.example/x.git", "git@evil.example:x.git", "ext::sh -c id", "../other", "a b", "", "-x"]) {
    assert.equal(mergeConfig({ remote }).remote, "origin", remote);
  }
  for (const base of ["main..evil", "-x", "a b", "HEAD@{1}", "x^{tree}", ""]) {
    assert.equal(mergeConfig({ base }).base, "auto", base);
  }
  assert.equal(mergeConfig({ base: "release/2.x" }).base, "release/2.x");
  assert.equal(mergeConfig({ syncIntervalSeconds: Number.NaN }).syncIntervalSeconds, 15);
  assert.equal(mergeConfig({ syncIntervalSeconds: 1e9 }).syncIntervalSeconds, 15);
});

test("loadConfig reads the team file, then the local override; broken files are skipped", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const paths = await clone.paths();
  assert.deepEqual(await loadConfig(paths), { ...DEFAULT_CONFIG });

  await clone.write(".huddle/config.json", JSON.stringify({ ttlMinutes: 30, syncIntervalSeconds: 5 }));
  assert.equal((await loadConfig(paths)).ttlMinutes, 30);

  await ensureStateDir(paths);
  await writeFile(paths.localConfigFile, JSON.stringify({ ttlMinutes: 45 }));
  const both = await loadConfig(paths);
  assert.equal(both.ttlMinutes, 45);
  assert.equal(both.syncIntervalSeconds, 5);

  await writeFile(paths.localConfigFile, "{ not json");
  assert.equal((await loadConfig(paths)).ttlMinutes, 30);
});
