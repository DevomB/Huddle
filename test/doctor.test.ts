// T2.3: huddle doctor.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agentsMdBlock } from "../src/adapters/agents-md.ts";
import { redactUrl } from "../src/commands/doctor.ts";
import { REF_PATTERN } from "../src/core/types.ts";
import { createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const posixOnly = process.platform === "win32" ? "uses sh scripts as server-side hooks" : false;

interface Report {
  ok: boolean;
  failed: number;
  warnings: number;
  checks: { name: string; level: "ok" | "warn" | "fail" | "info"; detail: string; notes: string[] }[];
}

async function doctorJson(clone: Clone, args: string[] = []): Promise<{ code: number; report: Report }> {
  const r = await clone.huddle(["doctor", "--json", ...args]);
  assert.equal(r.stderr, "", "doctor --json writes nothing to stderr");
  return { code: r.code, report: JSON.parse(r.stdout) as Report };
}

function find(report: Report, name: string): Report["checks"][number] {
  const found = report.checks.find((c) => c.name === name);
  assert.ok(found, `no "${name}" check in ${report.checks.map((c) => c.name).join(", ")}`);
  return found;
}

/** Every huddle ref on the remote, read from the bare repository itself. */
async function huddleRefs(h: Harness): Promise<string> {
  return h.remoteGit("for-each-ref", "--format=%(refname)", REF_PATTERN.replace(/\/\*$/, ""));
}

/** A server-side `update` hook: git runs it once per pushed ref with <ref> <old> <new>. */
async function serverHook(h: Harness, body: string): Promise<void> {
  const file = join(h.remote, "hooks", "update");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
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

async function setUp(t: Parameters<typeof createHarness>[0]): Promise<{ h: Harness; alice: Clone }> {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  assert.equal((await alice.huddle(["init"])).code, 0);
  await commitAll(h, alice, "Set up huddle");
  await alice.push();
  return { h, alice };
}

test("a healthy repo passes, and says what it checked", async (t) => {
  const { alice } = await setUp(t);
  const r = await alice.huddle(["doctor"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok {4}toolchain: git \d+\.\d+\S*, node \d+\.\d+\.\d+, huddle \d+\.\d+\.\d+/);
  assert.match(r.stdout, /ok {4}bundle: \.huddle\/huddle\.mjs is huddle \S+ and committed/);
  assert.match(r.stdout, /ok {4}remote: remote "origin" \(.+\) answered in \d+\.\d s; 0 huddle refs on it/);
  assert.match(r.stdout, /ok {4}push: can create and replace refs under refs\/huddle\/ on this remote/);
  assert.match(r.stdout, /ok {4}AGENTS\.md: /);
  assert.match(r.stdout, /ok {4}base branch: origin\/HEAD \(origin\/main\)/);
  assert.doesNotMatch(r.stdout, /clock:|actor id:/, "checks that only appear when something is wrong");
  assert.match(r.stdout, /info {2}identity: this clone is actor [a-z2-7]{8} \(alice on \S+\) with 0 live sessions/);
  assert.match(r.stdout, /info {2}last sync: never synced/);
  assert.match(r.stdout, /prompt capture is on: the first 200 characters of each prompt are shared/);
  assert.match(r.stdout, /\nhuddle can work here\.\n$/);
  assert.doesNotMatch(r.stdout, /FAIL/);
});

test("hooks that are installed and cannot work are a warning that says what to do; hooks nobody installed are not", { skip: process.platform === "win32" ? "file modes" : false }, async (t) => {
  const { alice } = await setUp(t);
  const gitHooks = async () => find((await doctorJson(alice)).report, "hooks: git hooks");
  assert.equal((await gitHooks()).level, "ok", "a default init installs the git hooks");

  // One of them loses its executable bit. git skips it from now on and says nothing; doctor does.
  const hook = join(alice.dir, ".git", "hooks", "pre-commit");
  await chmod(hook, 0o644);
  const { code, report } = await doctorJson(alice);
  const broken = find(report, "hooks: git hooks");
  assert.equal(broken.level, "warn");
  assert.match(broken.detail, /^git ignores the pre-commit hook in \.git\/hooks: not executable\. Run chmod \+x on it\.$/);
  assert.deepEqual({ code, ok: report.ok, failed: report.failed }, { code: 0, ok: true, failed: 0 }, "a warning: the rest of huddle still works");
  assert.ok(report.warnings >= 1);
  const text = await alice.huddle(["doctor"]);
  assert.match(text.stdout, /warn {2}hooks: git hooks: git ignores the pre-commit hook/);

  // Fixed the way the message says.
  await chmod(hook, 0o755);
  assert.equal((await gitHooks()).level, "ok");

  // A hook huddle's lines were taken out of by hand is damage too: the other hooks still run, this one does nothing.
  const original = await readFile(hook, "utf8");
  await writeFile(hook, "#!/bin/sh\n");
  const partly = await gitHooks();
  assert.equal(partly.level, "warn");
  assert.match(partly.detail, /^huddle git hooks in \.git\/hooks are missing for pre-commit\. Run huddle init --agent git\.$/);
  await writeFile(hook, original);

  // No huddle hook at all is not damage: nobody set them up in this clone (they are per clone, not committed).
  for (const name of ["pre-commit", "post-commit", "post-checkout", "post-merge", "post-rewrite"]) await rm(join(alice.dir, ".git", "hooks", name), { force: true });
  const none = await gitHooks();
  assert.equal(none.level, "info");
  assert.match(none.detail, /^no huddle git hooks in \.git\/hooks\. Run huddle init --agent git\.$/);
});

test("hooks that work here and are not committed are a warning: teammates would not get them", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  // .claude is ignored, as it often is for the sake of settings.local.json.
  await alice.write(".gitignore", ".claude/\n");
  await commitAll(h, alice, "ignore rules");
  assert.equal((await alice.huddle(["init", "--agent", "claude-code", "--agent", "codex"])).code, 0);
  const hooksOf = async (title: string) => find((await doctorJson(alice, ["--offline"])).report, `hooks: ${title}`);

  // Nothing committed yet: both sets of hooks work in this clone and in no other.
  const fresh = await hooksOf("Codex");
  assert.equal(fresh.level, "warn");
  assert.equal(fresh.notes[0], ".codex/hooks.json is not committed as it is now, so teammates do not get it with a pull: git add .codex/hooks.json && git commit");

  // The user commits everything git shows them. The ignored file is not among it, and git never says so.
  await commitAll(h, alice, "Set up huddle");
  assert.equal(await alice.git("status", "--porcelain"), "");
  assert.equal((await hooksOf("Codex")).level, "ok");
  const hidden = await hooksOf("Claude Code");
  assert.equal(hidden.level, "warn");
  assert.match(hidden.detail, /hooks in \.claude\/settings\.json$/, "the hooks themselves are in order");
  assert.equal(
    hidden.notes[0],
    ".claude/settings.json is hidden from git by an ignore rule (.gitignore:1: .claude/) and is not committed, so teammates do not get it with a pull: change the rule, or git add -f .claude/settings.json && git commit",
  );
  const text = await alice.huddle(["doctor", "--offline"]);
  assert.match(text.stdout, /warn {2}hooks: Claude Code: .*\n {10}\.claude\/settings\.json is hidden from git by an ignore rule/);
  assert.equal(text.code, 0, "a warning: huddle works in this clone");

  // Shared the way the note says.
  await alice.git("add", "-f", ".claude/settings.json");
  await alice.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "commit", "--quiet", "-m", "Share the hooks");
  assert.equal((await hooksOf("Claude Code")).level, "ok");

  // A later change to a committed hook file is the same gap again.
  await alice.write(".codex/hooks.json", (await alice.read(".codex/hooks.json")) + "\n");
  assert.equal((await hooksOf("Codex")).level, "warn");
});

test("hooks the team commits next to its own git hooks are checked the same way; hooks under .git are nobody's to commit", { skip: process.platform === "win32" ? "file modes" : false }, async (t) => {
  const { h, alice } = await setUp(t);
  const gitHooks = async () => find((await doctorJson(alice, ["--offline"])).report, "hooks: git hooks");
  assert.deepEqual({ level: (await gitHooks()).level }, { level: "ok" }, "under .git/hooks: never committed, and no warning for that");

  // The team keeps its hooks in the repository.
  await alice.git("config", "core.hooksPath", ".githooks");
  assert.equal((await alice.huddle(["init", "--agent", "git"])).code, 0);
  const uncommitted = await gitHooks();
  assert.equal(uncommitted.level, "warn");
  assert.ok(uncommitted.notes.includes(".githooks/pre-commit is not committed as it is now, so teammates do not get it with a pull: git add .githooks/pre-commit && git commit"), uncommitted.notes.join("\n"));
  await commitAll(h, alice, "git hooks for the team");
  assert.equal((await gitHooks()).level, "ok");
});

test("AGENTS.md that is a link: the file it points at is the one that has to be committed", { skip: process.platform === "win32" ? "symbolic links" : false }, async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await alice.write("CLAUDE.md", "# Project rules\n");
  await symlink("CLAUDE.md", join(alice.dir, "AGENTS.md"));
  await commitAll(h, alice, "rules for agents");
  // Agents named, not detected: which agents a machine has installed must not decide what there is to add.
  assert.equal((await alice.huddle(["init", "--agent", "claude-code", "--agent", "codex"])).code, 0);
  // Everything but the file the block went into.
  await alice.git("add", ".huddle", ".claude", ".codex");
  await alice.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "commit", "--quiet", "-m", "Set up huddle");
  const agentsMd = async () => find((await doctorJson(alice, ["--offline"])).report, "AGENTS.md");
  const open = await agentsMd();
  assert.equal(open.level, "warn");
  assert.equal(open.detail, "AGENTS.md has the huddle block");
  assert.deepEqual(open.notes, ["CLAUDE.md is not committed as it is now, so teammates do not get it with a pull: git add CLAUDE.md && git commit"]);
  await commitAll(h, alice, "the block");
  assert.deepEqual({ level: (await agentsMd()).level, notes: (await agentsMd()).notes }, { level: "ok", notes: [] });
});

test("AGENTS.md that is a link out of the checkout: init does not write the block there, and doctor says why", { skip: process.platform === "win32" ? "symbolic links" : false }, async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  // A personal rules file kept in one place and linked into several repositories.
  const outside = join(h.root, "my-rules.md");
  await writeFile(outside, "# My rules\n");
  await symlink(outside, join(alice.dir, "AGENTS.md"));
  await commitAll(h, alice, "my rules");

  const r = await alice.huddle(["init", "--agent", "claude-code"]);
  assert.equal(r.code, 1, "the setup is not complete");
  assert.equal(await readFile(outside, "utf8"), "# My rules\n", "the file out there is left as it was");
  assert.match(r.stderr, /^huddle: not done: AGENTS\.md is a symbolic link to a file outside this checkout \(.*my-rules\.md\)\. huddle does not write the block there: teammates would not get it, and it would reach every other place that file is linked into\./m);
  assert.doesNotMatch(r.stdout, /^ {2}AGENTS\.md$/m, "not among the files written");
  assert.doesNotMatch(r.stdout, /add .*AGENTS\.md|my-rules/, "and not in the commit line");

  const agentsMd = async () => find((await doctorJson(alice, ["--offline"])).report, "AGENTS.md");
  const refused = await agentsMd();
  assert.equal(refused.level, "warn");
  assert.match(refused.detail, /^AGENTS\.md is a symbolic link to a file outside this checkout \(.*my-rules\.md\), so a huddle block in it does not reach teammates\. Put a real file in its place/);
  // The same when the file out there does have the block: it is still nobody else's.
  await writeFile(outside, `# My rules\n\n${agentsMdBlock({ bundle: ".huddle/huddle.mjs" })}\n`);
  assert.equal((await agentsMd()).level, "warn");

  // A link out of the checkout to a file that is not there yet: writing through it would create the file out there.
  await rm(join(alice.dir, "AGENTS.md"));
  await symlink("../not-yet.md", join(alice.dir, "AGENTS.md"));
  const dangling = await alice.huddle(["init", "--agent", "claude-code"]);
  assert.equal(dangling.code, 1);
  assert.match(dangling.stderr, /AGENTS\.md is a symbolic link to a file outside this checkout \(.*not-yet\.md\)/);
  assert.equal(existsSync(join(h.root, "not-yet.md")), false);
});

test("team settings changed and not committed are a warning: teammates go by the committed ones", async (t) => {
  const { h, alice } = await setUp(t);
  const config = async () => find((await doctorJson(alice, ["--offline"])).report, "config");
  assert.equal((await config()).level, "info");
  // Prompt capture switched off here, and the commit forgotten: for everyone else it is still on.
  await alice.write(".huddle/config.json", '{ "captureIntent": false }\n');
  const open = await config();
  assert.equal(open.level, "warn");
  assert.deepEqual(open.notes, [
    ".huddle/config.json is not committed as it is now, so teammates do not get it with a pull: git add .huddle/config.json && git commit",
    "prompt capture is off: agents announce what they are doing with huddle intent",
  ]);
  await commitAll(h, alice, "no prompt capture");
  assert.deepEqual({ level: (await config()).level, notes: (await config()).notes }, { level: "info", notes: ["prompt capture is off: agents announce what they are doing with huddle intent"] });
});

test("an ignore rule over .huddle: the bundle and settings lines give the command that works", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await alice.write(".gitignore", ".huddle/\n");
  await commitAll(h, alice, "ignore rules");
  assert.equal((await alice.huddle(["init", "--agent", "claude-code"])).code, 0);
  // git add -A passes over .huddle without a word.
  await commitAll(h, alice, "Set up huddle");
  const { report } = await doctorJson(alice, ["--offline"]);
  const bundle = find(report, "bundle");
  assert.equal(bundle.level, "warn");
  assert.deepEqual(bundle.notes, [
    ".huddle/huddle.mjs is hidden from git by an ignore rule (.gitignore:1: .huddle/) and is not committed, so teammates do not get it with a pull: change the rule, or git add -f .huddle/huddle.mjs && git commit",
  ]);
  const config = find(report, "config");
  assert.equal(config.level, "warn");
  assert.equal(
    config.notes[0],
    ".huddle/config.json is hidden from git by an ignore rule (.gitignore:1: .huddle/) and is not committed, so teammates do not get it with a pull: change the rule, or git add -f .huddle/config.json && git commit",
  );
});

test("the push test leaves no trace when this clone has nothing to announce", async (t) => {
  const { h, alice } = await setUp(t);
  const before = await alice.snapshot();
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0);
  assert.equal(find(report, "push").level, "ok");
  assert.equal(await huddleRefs(h), "", "doctor left a ref on the remote");
  assert.deepEqual(await alice.snapshot(), before, "doctor changed local refs, FETCH_HEAD, the index or the working tree");
});

test("the push test keeps a live session's document on the remote, and teammates still see it", async (t) => {
  const { h, alice } = await setUp(t);
  const bob = await h.clone("bob");
  assert.equal((await alice.huddle(["intent", "build auth"], { session: "s1" })).code, 0);
  assert.equal((await alice.huddle(["sync", "--force"], { session: "s1" })).code, 0);
  const published = await huddleRefs(h);
  assert.match(published, /^refs\/huddle\/actors\/[a-z2-7]{8}$/);

  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0);
  assert.match(find(report, "identity").detail, /with 1 live session$/);
  assert.match(find(report, "last sync").detail, /^last synced \d+s ago$/);
  assert.equal(await huddleRefs(h), published, "the session's ref must survive the push test");

  assert.equal((await bob.huddle(["sync", "--force"])).code, 0);
  assert.match((await bob.huddle(["status", "--cached"])).stdout, /alice .*"build auth"/);
});

test("the push test never touches this clone's own document, so no sync can take it for a second writer", async (t) => {
  const { h, alice } = await setUp(t);
  const paths = await alice.paths();
  assert.equal((await alice.huddle(["intent", "build auth"], { session: "s1" })).code, 0);
  assert.equal((await alice.huddle(["sync", "--force"], { session: "s1" })).code, 0);
  const own = await h.remoteGit("for-each-ref", "--format=%(refname) %(objectname)", "refs/huddle/actors");

  // The intent changes and no sync has published it yet (a prompt hook whose sync was throttled):
  // what is on the remote is behind local state. Written to local.json directly, standing in for the hook.
  const local = JSON.parse(await readFile(paths.localFile, "utf8")) as { sessions: { id: string; intent: string }[] };
  for (const session of local.sessions) session.intent = "changed since the last publish";
  await writeFile(paths.localFile, JSON.stringify(local));

  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0);
  assert.equal(find(report, "push").level, "ok");
  assert.equal(await h.remoteGit("for-each-ref", "--format=%(refname) %(objectname)", "refs/huddle/actors"), own, "doctor pushed to, or left something next to, this clone's document");

  // The session ends before the next sync has fetched. That sync must find nothing strange.
  local.sessions = [];
  await writeFile(paths.localFile, JSON.stringify(local));
  assert.equal((await alice.huddle(["sync", "--force"])).code, 0);
  const log = await readFile(paths.logFile, "utf8").catch(() => "");
  assert.doesNotMatch(log, /another clone is publishing as this one/);
  const after = await doctorJson(alice);
  assert.equal(after.report.checks.some((c) => c.name === "actor id"), false, "doctor now warns about a second writer that does not exist");
});

test("a remote that does not let refs be deleted: a warning that names the ref left behind", { skip: posixOnly }, async (t) => {
  const { h, alice } = await setUp(t);
  const zero = "0000000000000000000000000000000000000000";
  await serverHook(h, `case "$1" in refs/huddle/*) if [ "$3" = ${zero} ]; then echo "no deletions" >&2; exit 1; fi;; esac`);
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0, "huddle works without deleting refs");
  const push = find(report, "push");
  assert.equal(push.level, "warn");
  assert.match(push.detail, /can create and replace refs under refs\/huddle\/ on this remote, but not delete them/);
  const left = await huddleRefs(h);
  assert.match(left, /^refs\/huddle\/actors\/[a-z2-7]{8}$/);
  assert.ok(push.notes.join("\n").includes(`git push origin :${left}`), push.notes.join("\n"));
  // What is left is an actor with no sessions: nobody sees it.
  const bob = await h.clone("bob");
  assert.equal((await bob.huddle(["sync", "--force"])).code, 0);
  assert.match((await bob.huddle(["status", "--cached"])).stdout, /No teammates' agents are live/);
});

test("an unreachable remote fails with git's reason and how to fix it", async (t) => {
  const { h, alice } = await setUp(t);
  await alice.git("remote", "set-url", "origin", join(h.root, "no-such-remote.git"));
  const r = await alice.huddle(["doctor"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL {2}remote: cannot reach remote "origin" \(.*no-such-remote\.git\): /);
  assert.match(r.stdout, /huddle never prompts for credentials/);
  assert.doesNotMatch(r.stdout, / push: /, "no push test against a remote that cannot be reached");
  assert.match(r.stdout, /1 problem must be fixed before huddle can work here\./);
});

test("a missing remote fails and says what a remote is for", async (t) => {
  const { alice } = await setUp(t);
  await alice.git("remote", "rename", "origin", "github");
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 1);
  assert.equal(report.ok, false);
  const remote = find(report, "remote");
  assert.equal(remote.level, "fail");
  assert.equal(remote.detail, 'there is no git remote named "origin"');
  assert.match(remote.notes.join(" "), /set `remote` in \.huddle\/config\.json/);
});

test("a remote that refuses refs/huddle/* fails the push test with the usual causes", { skip: posixOnly }, async (t) => {
  const { h, alice } = await setUp(t);
  await serverHook(h, 'case "$1" in refs/huddle/*) echo "huddle refs are not allowed here" >&2; exit 1;; esac');
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 1);
  assert.equal(find(report, "remote").level, "ok", "reading still works");
  const push = find(report, "push");
  assert.equal(push.level, "fail");
  assert.match(push.detail, /^the remote refused a push to refs\/huddle\/\* \(denied\)$/);
  assert.match(push.notes.join("\n"), /ruleset or push rule/);
  assert.match(push.notes.join("\n"), /git push origin HEAD:refs\/huddle\/probe/);
  assert.equal(await huddleRefs(h), "");
});

test("a remote that takes new refs but not replacements fails the push test", { skip: posixOnly }, async (t) => {
  // Creating a ref and replacing one are separate permissions on some servers (a hook, or Gerrit's
  // Force Push). huddle replaces every document with a forced push, so creating alone is not enough.
  const { h, alice } = await setUp(t);
  const zero = "0000000000000000000000000000000000000000";
  await serverHook(h, `case "$1" in refs/huddle/*) if [ "$2" != ${zero} ] && [ "$3" != ${zero} ]; then echo "no forced updates" >&2; exit 1; fi;; esac`);
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 1);
  const push = find(report, "push");
  assert.equal(push.level, "fail");
  assert.match(push.detail, /^the remote accepts new refs under refs\/huddle\/ but refuses to replace them \(denied\)$/);
  assert.match(push.notes.join("\n"), /Force Push/);
  assert.equal(await huddleRefs(h), "", "the probe ref is removed again");
});

test("receive.denyNonFastForwards on the remote does not get in the way", async (t) => {
  // `git init --bare --shared` sets it. git applies it to refs/heads/ only, so huddle's forced
  // updates of its own refs still work; this test is here so that stays known.
  const { h, alice } = await setUp(t);
  await h.remoteGit("config", "receive.denyNonFastForwards", "true");
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0);
  assert.equal(find(report, "push").level, "ok");
});

test("--offline skips the network and can still pass", async (t) => {
  const { h, alice } = await setUp(t);
  await alice.git("remote", "set-url", "origin", join(h.root, "no-such-remote.git"));
  const { code, report } = await doctorJson(alice, ["--offline"]);
  assert.equal(code, 0);
  assert.deepEqual(find(report, "remote"), { name: "remote", level: "info", detail: "not checked (--offline)", notes: [] });
  assert.equal(report.checks.some((c) => c.name === "push"), false);
});

test("--json is one object with a verdict and every check", async (t) => {
  const { alice } = await setUp(t);
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.equal(report.failed, 0);
  for (const name of ["toolchain", "bundle", "config", "remote", "push", "AGENTS.md", "identity", "last sync", "log"]) find(report, name);
  for (const c of report.checks) {
    assert.match(c.level, /^(ok|warn|fail|info)$/);
    assert.equal(typeof c.detail, "string");
    assert.ok(Array.isArray(c.notes));
  }
});

test("a repo that never ran init gets warnings, not failures", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const r = await clone.huddle(["doctor"]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /warn {2}bundle: \.huddle\/huddle\.mjs is missing/);
  assert.match(r.stdout, /run "huddle init"/);
  assert.match(r.stdout, /huddle can work here; 1 thing to look at\./);
});

test("in a worktree whose branch has no .huddle, doctor says whose settings are in force and what the branch lacks", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const old = await alice.addWorktree("old"); // a branch from before huddle was set up
  // The git hooks live in the clone's .git/hooks, which this worktree shares.
  assert.equal((await alice.huddle(["init", "--agent", "claude-code", "--agent", "git"])).code, 0);
  await alice.write(".huddle/config.json", `${JSON.stringify({ ttlMinutes: 45 })}\n`);
  await commitAll(h, alice, "Set up huddle");

  const { code, report } = await doctorJson(old, ["--offline"]);
  assert.equal(code, 0);
  const config = find(report, "config");
  assert.match(config.detail, /sessions expire after 45m/, "the settings a command typed here really runs on");
  assert.match(config.notes[0] ?? "", /^this checkout has no \.huddle: these are the settings of .*[\\/]alice$/);
  const bundle = find(report, "bundle");
  assert.equal(bundle.level, "warn");
  assert.match(bundle.detail, /^\.huddle\/huddle\.mjs is missing in this checkout; .*[\\/]alice has it$/);
  assert.match(bundle.notes[0] ?? "", /An agent started here runs no huddle hooks until the branch gets \.huddle: merge or rebase onto the branch that has it\.$/);
  assert.doesNotMatch(bundle.notes.join("\n"), /run "huddle init"/, "a second init on this branch would meet the first in a conflict");

  // The hook lines and AGENTS.md wait for the branch too, and do not repeat that advice either; the git hooks
  // (installed for the clone, with no bundle here to run) are not a second thing to look at.
  const waiting = report.checks.filter((c) => c.name.startsWith("hooks: ") || c.name === "AGENTS.md");
  assert.ok(waiting.some((c) => c.name === "hooks: git hooks") && waiting.length >= 6, waiting.map((c) => c.name).join(", "));
  for (const line of waiting) assert.deepEqual({ name: line.name, level: line.level, detail: line.detail }, { name: line.name, level: "info", detail: "not on this branch yet" });
  assert.deepEqual(find(report, "hooks: git hooks").notes, ["this branch does not have huddle yet (see bundle); the hooks work here once it does"]);
  assert.deepEqual(find(report, "AGENTS.md").notes, ["this branch does not have huddle yet (see bundle); the block comes with it"]);
  assert.doesNotMatch((await old.huddle(["doctor", "--offline"])).stdout, /huddle init/);

  // The checkout that is set up says nothing of the kind.
  const main = (await doctorJson(alice, ["--offline"])).report;
  assert.ok(!find(main, "config").notes.some((note) => note.includes("has no .huddle")));
  assert.equal(find(main, "bundle").level, "ok");
  const mainClaude = find(main, "hooks: Claude Code");

  // A settings file that cannot be used is the same problem seen from either checkout.
  await alice.write(".huddle/config.json", "{ broken");
  const broken = find((await doctorJson(old, ["--offline"])).report, "config");
  assert.equal(broken.level, "warn");
  assert.ok(broken.notes.some((note) => /^\.huddle\/config\.json is not valid JSON/.test(note)), broken.notes.join("\n"));

  // Once the branch has huddle, its lines are checked as in any set-up checkout.
  await old.git("-c", `core.hooksPath=${join(h.root, "no-hooks")}`, "merge", "--quiet", "main");
  const merged = (await doctorJson(old, ["--offline"])).report;
  assert.equal(find(merged, "bundle").level, "ok");
  const claude = find(merged, "hooks: Claude Code");
  assert.deepEqual({ level: claude.level, detail: claude.detail }, { level: mainClaude.level, detail: mainClaude.detail });
  assert.equal(find(merged, "AGENTS.md").level, "ok");
});

test("no base branch to compare with is a warning that says what is lost and how to fix it", async (t) => {
  const { alice } = await setUp(t);
  await alice.git("remote", "set-head", "origin", "--delete");
  await alice.git("update-ref", "-d", "refs/remotes/origin/main");
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0, "a warning, not a failure");
  const base = find(report, "base branch");
  assert.equal(base.level, "warn");
  assert.equal(base.detail, "no base branch found: no origin/HEAD, origin/main or origin/master");
  assert.match(base.notes.join("\n"), /committed files are then shared only until their branch is pushed/);
  assert.match(base.notes.join("\n"), /set "base" in \.huddle\/config\.json/);
});

test("a configured base that does not exist is pointed out, with what is used instead", async (t) => {
  const { alice } = await setUp(t);
  const file = join(alice.dir, ".huddle", "config.json");
  await writeFile(file, JSON.stringify({ ...(JSON.parse(await readFile(file, "utf8")) as object), base: "develop" }, null, 2));
  let base = find((await doctorJson(alice)).report, "base branch");
  assert.equal(base.level, "warn");
  assert.equal(base.detail, '"base" is "develop", but there is no such branch here or on origin; using origin/HEAD (origin/main)');

  // Once the branch exists on the remote and is fetched, the check is content.
  await alice.git("push", "--quiet", "origin", "main:refs/heads/develop");
  await alice.git("fetch", "--quiet");
  base = find((await doctorJson(alice)).report, "base branch");
  assert.deepEqual({ level: base.level, detail: base.detail }, { level: "ok", detail: "origin/develop" });
});

test("a settings file with a merge conflict is reported, and prompt capture is off until it is fixed", async (t) => {
  const { alice } = await setUp(t);
  const file = join(alice.dir, ".huddle", "config.json");
  const good = await readFile(file, "utf8");
  await writeFile(file, `<<<<<<< HEAD\n${good}=======\n{ "captureIntent": true }\n>>>>>>> theirs\n`);
  const { code, report } = await doctorJson(alice);
  assert.equal(code, 0);
  const config = find(report, "config");
  assert.equal(config.level, "warn");
  assert.deepEqual(config.notes, [
    ".huddle/config.json is not valid JSON (it has merge conflict markers)",
    "the team's settings are ignored and prompt capture is off until .huddle/config.json is fixed",
    "prompt capture is off: agents announce what they are doing with huddle intent",
  ]);
});

test("HUDDLE_NOW left set in the environment is a warning", async (t) => {
  const { alice } = await setUp(t);
  const r = await alice.huddle(["doctor", "--offline"], { now: "2026-01-01T00:00:00Z" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /warn {2}clock: HUDDLE_NOW is set: huddle believes it is 2026-01-01T00:00:00\.000Z/);
  assert.match(r.stdout, /HUDDLE_NOW is for tests; unset it/);
});

test("a copy of the repository publishing under the same actor id is reported while it is recent", async (t) => {
  const { h, alice } = await setUp(t);
  assert.equal((await alice.huddle(["intent", "the original"])).code, 0);
  assert.equal((await alice.huddle(["sync"])).code, 0);
  await cp(alice.dir, join(h.root, "copy"), { recursive: true });
  assert.equal((await alice.huddle(["intent", "the copy"], { cwd: "../copy" })).code, 0);
  assert.equal((await alice.huddle(["sync"], { cwd: "../copy" })).code, 0);
  assert.equal((await alice.huddle(["sync"])).code, 0);

  const paths = await alice.paths();
  const shared = find((await doctorJson(alice, ["--offline"])).report, "actor id");
  assert.equal(shared.level, "warn");
  assert.match(shared.detail, /^another clone is publishing under this clone's actor id [a-z2-7]{8} \(seen \d+s ago\)$/);
  assert.ok(shared.notes.join("\n").includes(`delete ${paths.actorFile} in the copy`));

  // The same line from two days ago is history, not a problem to fix today.
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(paths.logFile, `${old} 123 [sync] another clone is publishing as this one: refs/huddle/actors/abcd2345 holds session x\n`);
  const { report } = await doctorJson(alice, ["--offline"]);
  assert.equal(report.checks.some((c) => c.name === "actor id"), false);
});

test("a vendored bundle that is not committed, or is not a bundle, is reported", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal((await clone.huddle(["init"])).code, 0);
  assert.match((await clone.huddle(["doctor", "--offline"])).stdout, /warn {2}bundle: \.huddle\/huddle\.mjs \(huddle \S+\) is not committed/);
  // Committed, then changed (an upgrade by init that was never committed): tracked is not the same as committed.
  await commitAll(h, clone, "Set up huddle");
  assert.match((await clone.huddle(["doctor", "--offline"])).stdout, /ok {4}bundle: \.huddle\/huddle\.mjs is huddle \S+ and committed/);
  const bundle = await clone.read(".huddle/huddle.mjs");
  await clone.write(".huddle/huddle.mjs", `${bundle}\n// a local change\n`);
  const changed = await clone.huddle(["doctor", "--offline"]);
  assert.match(changed.stdout, /warn {2}bundle: \.huddle\/huddle\.mjs \(huddle \S+\) has changes that are not committed/);
  assert.match(changed.stdout, /until then teammates run the copy from the last commit/);
  await clone.git("add", ".huddle/huddle.mjs");
  assert.match((await clone.huddle(["doctor", "--offline"])).stdout, /has changes that are not committed/, "staged is not committed either");

  await clone.write(".huddle/huddle.mjs", "console.log('not huddle')\n");
  const r = await clone.huddle(["doctor", "--offline"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL {2}bundle: \.huddle\/huddle\.mjs is not a huddle bundle/);
});

test("credentials in a remote URL never reach the output", async (t) => {
  const { alice } = await setUp(t);
  // Port 1 on loopback: refused at once, and nothing leaves the machine.
  await alice.git("remote", "set-url", "origin", "https://deploy:s3cr3t-token@127.0.0.1:1/team/repo.git");
  const text = await alice.huddle(["doctor"]);
  assert.equal(text.code, 1);
  assert.match(text.stdout, /cannot reach remote "origin" \(https:\/\/\*\*\*@127\.0\.0\.1:1\/team\/repo\.git\)/);
  assert.doesNotMatch(text.stdout + text.stderr, /s3cr3t-token|deploy:/);
  const json = await alice.huddle(["doctor", "--json"]);
  assert.doesNotMatch(json.stdout + json.stderr, /s3cr3t-token|deploy:/);
});

test("git's own error text is shown without its unhelpful ending and without credentials", { skip: posixOnly }, async (t) => {
  const { h, alice } = await setUp(t);
  // A stand-in for ssh that fails the way a proxy or a wrapper might: with a URL that carries a token.
  const fakeSsh = join(h.root, "fake-ssh.sh");
  await writeFile(fakeSsh, "#!/bin/sh\necho \"proxy: cannot reach https://bot:leaky-token@proxy.example/x\" >&2\nexit 255\n");
  await chmod(fakeSsh, 0o755);
  await alice.git("remote", "set-url", "origin", "ssh://git@huddle.invalid/team/repo.git");
  await alice.git("config", "core.sshCommand", fakeSsh);
  const r = await alice.huddle(["doctor"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /cannot reach remote "origin" \(ssh:\/\/\*\*\*@huddle\.invalid\/team\/repo\.git\): proxy: cannot reach https:\/\/\*\*\*@proxy\.example\/x \/ fatal: Could not read from remote repository\./);
  assert.doesNotMatch(r.stdout, /leaky-token|correct access rights|and the repository exists/);
});

test("a push URL that differs from the fetch URL is pointed out", async (t) => {
  const { h, alice } = await setUp(t);
  const elsewhere = join(h.root, "elsewhere.git");
  await alice.git("clone", "--quiet", "--bare", h.remote, elsewhere);
  await alice.git("remote", "set-url", "--push", "origin", elsewhere);
  const { report } = await doctorJson(alice);
  const notes = report.checks.filter((c) => c.name === "remote");
  assert.equal(notes.length, 2);
  assert.equal(notes[1]?.level, "info");
  assert.match(notes[1]?.detail ?? "", /^pushes go to a different URL: .*elsewhere\.git$/);
});

test("doctor outside a git repository says so", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const r = await clone.huddle(["doctor"], { cwd: ".." }); // the harness root holds the clones and is not a repository
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not inside a git repository/);
});

test("doctor rejects arguments it does not know", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal((await clone.huddle(["doctor", "--fix"])).code, 2);
  assert.equal((await clone.huddle(["doctor", "now"])).code, 2);
});

test("redactUrl removes credentials from URLs and leaves everything else alone", () => {
  assert.equal(redactUrl("https://user:token@github.com/team/repo.git"), "https://***@github.com/team/repo.git");
  assert.equal(redactUrl("https://ghp_abc123@github.com/team/repo.git"), "https://***@github.com/team/repo.git");
  assert.equal(redactUrl("ssh://git@example.com:2222/team/repo.git"), "ssh://***@example.com:2222/team/repo.git");
  assert.equal(redactUrl("https://github.com/team/repo.git"), "https://github.com/team/repo.git");
  assert.equal(redactUrl("git@github.com:team/repo.git"), "git@github.com:team/repo.git");
  assert.equal(redactUrl("/srv/git/repo.git"), "/srv/git/repo.git");
  assert.equal(
    redactUrl("fatal: unable to access 'https://u:p@host.example/x.git/': Could not resolve host"),
    "fatal: unable to access 'https://***@host.example/x.git/': Could not resolve host",
  );
  assert.equal(redactUrl("two https://a:b@x.example/1 and http://c@y.example/2"), "two https://***@x.example/1 and http://***@y.example/2");
  assert.equal(redactUrl("mail me at someone@example.com about https://example.com/a@b"), "mail me at someone@example.com about https://example.com/a@b");

  // A password may hold an "@": everything up to the last one before the host goes. Built from parts,
  // so that this file holds nothing a secret scanner could take for a real credential.
  const at = "@";
  const login = ["user", ["p", "ss", "word"].join(at)].join(":");
  assert.equal(redactUrl(`https://${login}${at}host.example/x.git`), "https://***@host.example/x.git");
  assert.equal(redactUrl(`fetch https://${login}${at}host.example/x.git failed, see https://docs.example/a${at}b`), `fetch https://***@host.example/x.git failed, see https://docs.example/a${at}b`);

  // A secret in the query string, by the name of its parameter.
  const value = ["abc", "def", "123"].join("");
  for (const name of ["access_token", "private_token", "token", "api_key", "password", "X-Amz-Signature", "auth"]) {
    assert.equal(redactUrl(`https://host.example/x.git?${name}=${value}&ref=main`), `https://host.example/x.git?${name}=***&ref=main`, name);
    assert.equal(redactUrl(`https://host.example/x?ref=main&${name}=${value}`), `https://host.example/x?ref=main&${name}=***`, name);
  }
  assert.equal(redactUrl("https://host.example/x?page=2&sort=name"), "https://host.example/x?page=2&sort=name");
});
