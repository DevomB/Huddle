// T2.3: huddle doctor.

import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
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

async function setUp(t: Parameters<typeof createHarness>[0]): Promise<{ h: Harness; alice: Clone }> {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  assert.equal((await alice.huddle(["init"])).code, 0);
  await alice.commit("Set up huddle");
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
});
