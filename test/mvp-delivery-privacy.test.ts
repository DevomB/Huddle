// A06: a privacy opt-out must not fail open. A config layer that exists but
// cannot be read, is not JSON, is not an object, or has a captureIntent that is
// not a boolean turns prompt capture off, whatever the other layer says. An
// absent local file changes nothing. Valid values keep their precedence:
// local over team over default.
//
// Read failures use a real directory in the file's place (EISDIR on Linux and
// Windows alike) and an injected reader for access denied, because a chmod
// fixture cannot make a file unreadable on Windows.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ensureStateDir, loadConfigReport } from "../src/core/paths.ts";
import type { RepoPaths } from "../src/core/paths.ts";
import { DEFAULT_CONFIG } from "../src/core/types.ts";
import { createHarness } from "./harness.ts";
import type { Clone } from "./harness.ts";

/** A clone whose checkout path has a space and non-ASCII letters, with its state directory made. */
async function setUp(t: Parameters<typeof createHarness>[0]): Promise<{ clone: Clone; paths: RepoPaths }> {
  const h = await createHarness(t);
  const clone = await h.clone("ålice dev");
  const paths = await clone.paths();
  await ensureStateDir(paths);
  return { clone, paths };
}

const team = (clone: Clone, value: unknown): Promise<void> => clone.write(".huddle/config.json", typeof value === "string" ? value : JSON.stringify(value));
const local = (paths: RepoPaths, value: unknown): Promise<void> => writeFile(paths.localConfigFile, typeof value === "string" ? value : JSON.stringify(value));

/** A reader that fails for one file the way a locked or access-denied file does, and reads the rest. */
function denied(file: string, code: "EACCES" | "EPERM" | "EBUSY"): (path: string) => Promise<string> {
  return async (path) => {
    if (path === file) throw Object.assign(new Error(`${code}: operation not permitted, open '${path}'`), { code });
    return readFile(path, "utf8");
  };
}

const capture = async (paths: RepoPaths, options?: Parameters<typeof loadConfigReport>[1]): Promise<boolean> => (await loadConfigReport(paths, options)).config.captureIntent;

test("the platform's own paths are used: a drive letter on Windows, and a checkout path with a space and non-ASCII letters", async (t) => {
  const { paths } = await setUp(t);
  assert.match(paths.worktree, /ålice dev$/);
  if (process.platform === "win32") {
    assert.match(paths.localConfigFile, /^[A-Za-z]:\\/, "a Windows drive path");
    assert.match(paths.teamConfigFile, /^[A-Za-z]:\\/, "a Windows drive path");
  }
});

test("valid settings keep their precedence, and an absent local file changes nothing", async (t) => {
  const { clone, paths } = await setUp(t);
  assert.deepEqual(await loadConfigReport(paths), { config: { ...DEFAULT_CONFIG }, problems: [] }, "no files: the defaults");

  await team(clone, { captureIntent: true });
  assert.deepEqual(await loadConfigReport(paths), { config: { ...DEFAULT_CONFIG, captureIntent: true }, problems: [] }, "team on, no local file");

  await local(paths, { captureIntent: false });
  assert.deepEqual(await loadConfigReport(paths), { config: { ...DEFAULT_CONFIG, captureIntent: false }, problems: [] }, "the local opt-out wins over the team");

  await rm(join(clone.dir, ".huddle", "config.json"));
  assert.equal(await capture(paths), false, "and over the default");

  await team(clone, { captureIntent: false });
  await local(paths, { captureIntent: true });
  assert.deepEqual(await loadConfigReport(paths), { config: { ...DEFAULT_CONFIG, captureIntent: true }, problems: [] }, "a valid local true wins over a valid team false");

  await rm(paths.localConfigFile);
  assert.deepEqual(await loadConfigReport(paths), { config: { ...DEFAULT_CONFIG, captureIntent: false }, problems: [] }, "the local file removed: the team's choice, and no problem");
});

test("a local opt-out that becomes unusable keeps capture off while the team permits it", async (t) => {
  const { clone, paths } = await setUp(t);
  for (const permitting of [undefined, { captureIntent: true }, { ttlMinutes: 30 }]) {
    if (permitting === undefined) await rm(join(clone.dir, ".huddle", "config.json"), { force: true });
    else await team(clone, permitting);
    await local(paths, { captureIntent: false });
    assert.equal(await capture(paths), false, "the opt-out, while it is readable");

    const broken: Array<[string, RegExp]> = [
      ["{ nope", /is not valid JSON$/],
      ['{ "captureIntent": false', /is not valid JSON$/],
      ['<<<<<<< HEAD\n{ "captureIntent": false }\n=======\n{}\n>>>>>>> theirs\n', /is not valid JSON \(it has merge conflict markers\)$/],
      ["[]", /is not a JSON object$/],
      ['"captureIntent: false"', /is not a JSON object$/],
      ["null", /is not a JSON object$/],
      ["42", /is not a JSON object$/],
      ["false", /is not a JSON object$/],
      ["", /is not valid JSON$/],
    ];
    for (const [text, why] of broken) {
      await local(paths, text);
      const report = await loadConfigReport(paths);
      const label = `team ${JSON.stringify(permitting)}, local ${JSON.stringify(text)}`;
      assert.equal(report.config.captureIntent, false, label);
      assert.equal(report.problems.length, 2, `${label}: ${report.problems.join(" | ")}`);
      assert.match(report.problems[0] ?? "", /^the local override \(huddle\/config\.json in the git directory\) /, label);
      assert.match(report.problems[0] ?? "", why, label);
      assert.equal(report.problems[1], `the local override's settings are ignored and prompt capture is off until ${paths.localConfigFile} is fixed`, label);
    }
  }
});

test("a local file that cannot be read keeps capture off: a directory in its place, and access denied", async (t) => {
  const { clone, paths } = await setUp(t);
  await team(clone, { captureIntent: true, ttlMinutes: 30 });

  // A real read failure on every platform.
  await mkdir(paths.localConfigFile);
  const dir = await loadConfigReport(paths);
  assert.equal(dir.config.captureIntent, false);
  assert.equal(dir.config.ttlMinutes, 30, "the team's other settings still apply");
  assert.match(dir.problems[0] ?? "", /^the local override \(huddle\/config\.json in the git directory\) cannot be read \(E[A-Z]+\)$/);
  await rm(paths.localConfigFile, { recursive: true });

  // Access denied, locked: what Windows reports for a file another process holds or an ACL refuses.
  await local(paths, { captureIntent: false });
  for (const code of ["EACCES", "EPERM", "EBUSY"] as const) {
    const report = await loadConfigReport(paths, { readText: denied(paths.localConfigFile, code) });
    assert.equal(report.config.captureIntent, false, code);
    assert.deepEqual(report.problems, [
      `the local override (huddle/config.json in the git directory) cannot be read (${code})`,
      `the local override's settings are ignored and prompt capture is off until ${paths.localConfigFile} is fixed`,
    ]);
  }
  assert.equal(await capture(paths), false, "and with the real reader, the opt-out itself");
});

test("a team file that cannot be used keeps capture off even when the local file turns it on", async (t) => {
  const { clone, paths } = await setUp(t);
  await local(paths, { captureIntent: true, ttlMinutes: 20 });

  for (const text of ["{ nope", "[1, 2]", '"text"', "null", '<<<<<<< HEAD\n{ "captureIntent": false }\n=======\n{}\n>>>>>>> theirs\n']) {
    await team(clone, text);
    const report = await loadConfigReport(paths);
    assert.equal(report.config.captureIntent, false, text);
    assert.equal(report.config.ttlMinutes, 20, `${text}: the local file's other settings still apply`);
    assert.equal(report.problems.at(-1), "the team's settings are ignored and prompt capture is off until .huddle/config.json is fixed");
  }

  await rm(join(clone.dir, ".huddle", "config.json"));
  await mkdir(join(clone.dir, ".huddle", "config.json"));
  assert.equal(await capture(paths), false, "a directory in the team file's place");
  await rm(join(clone.dir, ".huddle", "config.json"), { recursive: true });

  await team(clone, { captureIntent: false });
  for (const code of ["EACCES", "EPERM"] as const) {
    const report = await loadConfigReport(paths, { readText: denied(paths.teamConfigFile, code) });
    assert.equal(report.config.captureIntent, false, code);
    assert.deepEqual(report.problems, [`.huddle/config.json cannot be read (${code})`, "the team's settings are ignored and prompt capture is off until .huddle/config.json is fixed"]);
  }
});

test("a captureIntent that is not a boolean, in either layer, keeps capture off whatever the other says", async (t) => {
  const { clone, paths } = await setUp(t);
  for (const value of ["false", "true", "no", 0, 1, null, [], {}]) {
    await team(clone, { captureIntent: value, ttlMinutes: 30 });
    await local(paths, { captureIntent: true });
    const fromTeam = await loadConfigReport(paths);
    assert.equal(fromTeam.config.captureIntent, false, `team ${JSON.stringify(value)}`);
    assert.equal(fromTeam.config.ttlMinutes, 30, "the rest of a readable team file still applies");
    assert.deepEqual(fromTeam.problems, [".huddle/config.json has a captureIntent that is not true or false, so prompt capture is off until it is fixed"]);

    await team(clone, { captureIntent: true });
    await local(paths, { captureIntent: value });
    const fromLocal = await loadConfigReport(paths);
    assert.equal(fromLocal.config.captureIntent, false, `local ${JSON.stringify(value)}`);
    assert.deepEqual(fromLocal.problems, [`the local override has a captureIntent that is not true or false, so prompt capture is off until ${paths.localConfigFile} is fixed`]);
  }
});

test("a linked worktree shares the clone's local override, broken or not", async (t) => {
  const { clone, paths } = await setUp(t);
  const linked = await clone.addWorktree("wt ü", "wt-u");
  const linkedPaths = await linked.paths();
  assert.notEqual(linkedPaths.worktree, paths.worktree);
  assert.equal(linkedPaths.localConfigFile, paths.localConfigFile, "one local override per clone");

  await team(linked, { captureIntent: true });
  await local(paths, { captureIntent: false });
  assert.equal(await capture(linkedPaths), false, "the opt-out reaches the linked worktree");
  await local(paths, "{ nope");
  assert.equal(await capture(linkedPaths), false, "and still holds there when the file breaks");
});

test("doctor, run from the bundle, says capture is off and why when the local opt-out breaks", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("ålice dev");
  assert.equal((await alice.huddle(["init", "--agent", "claude-code"])).code, 0);
  const paths = await alice.paths();
  type Check = { name: string; level: string; notes: string[] };
  const configCheck = async (): Promise<Check> => {
    const r = await alice.huddle(["doctor", "--json", "--offline"]);
    const found = (JSON.parse(r.stdout) as { checks: Check[] }).checks.find((c) => c.name === "config");
    assert.ok(found, r.stdout);
    return found;
  };
  const on = /^prompt capture is on/;
  const off = "prompt capture is off: agents announce what they are doing with huddle intent";

  assert.match((await configCheck()).notes.at(-1) ?? "", on, "init leaves the default on");
  await local(paths, { captureIntent: false });
  assert.equal((await configCheck()).notes.at(-1), off);

  await local(paths, "{ nope");
  const broken = await configCheck();
  assert.equal(broken.level, "warn");
  assert.equal(broken.notes.at(-1), off, "the bug was: on again");
  assert.ok(broken.notes.includes("the local override (huddle/config.json in the git directory) is not valid JSON"), broken.notes.join("\n"));
  // The path as the CLI resolved it, which may be spelled differently from this process's (short names on Windows).
  assert.ok(broken.notes.some((note) => /^the local override's settings are ignored and prompt capture is off until .*huddle[\\/]config\.json is fixed$/.test(note)), broken.notes.join("\n"));
  void paths;
});
