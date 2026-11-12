// T1.4: src/core/files.ts against real repositories.

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { currentBranch, DETACHED, filesInFlight, resolveBase, resolveExisting, toRepoPath, toRepoPattern } from "../src/core/files.ts";
import { DEFAULT_CONFIG } from "../src/core/types.ts";
import { createHarness } from "./harness.ts";

const config = { ...DEFAULT_CONFIG };

test("currentBranch names the branch, and says so when HEAD is detached", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal(await currentBranch(clone.dir), "main");
  await clone.git("checkout", "--quiet", "-b", "feat/auth");
  assert.equal(await currentBranch(clone.dir), "feat/auth");
  await clone.git("checkout", "--quiet", "--detach");
  assert.equal(await currentBranch(clone.dir), DETACHED);
  assert.equal(await currentBranch(join(h.root, "nowhere")), DETACHED);
});

test("resolveBase prefers origin/HEAD, then origin/main, then origin/master", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  assert.equal(await resolveBase(clone.dir, config), "refs/remotes/origin/HEAD");

  await clone.git("remote", "set-head", "origin", "--delete");
  assert.equal(await resolveBase(clone.dir, config), "refs/remotes/origin/main");

  await clone.git("update-ref", "refs/remotes/origin/master", "HEAD");
  await clone.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(await resolveBase(clone.dir, config), "refs/remotes/origin/master");

  await clone.git("update-ref", "-d", "refs/remotes/origin/master");
  assert.equal(await resolveBase(clone.dir, config), null);
});

test("resolveBase honors an explicit base, remote first, and falls back when it does not exist", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.git("update-ref", "refs/remotes/origin/develop", "HEAD");
  assert.equal(await resolveBase(clone.dir, { ...config, base: "develop" }), "refs/remotes/origin/develop");
  await clone.git("branch", "local-only");
  assert.equal(await resolveBase(clone.dir, { ...config, base: "local-only" }), "refs/heads/local-only");
  assert.equal(await resolveBase(clone.dir, { ...config, base: "missing" }), "refs/remotes/origin/HEAD");
  assert.equal(await resolveBase(clone.dir, { ...config, remote: "upstream" }), null);
});

test("filesInFlight lists dirty files of every kind and leaves ignored ones out", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.write("tracked.txt", "one\n");
  await clone.write("to-delete.txt", "x\n");
  await clone.write("to-rename.txt", "a file that is long enough to be detected as a rename\n");
  await clone.write(".gitignore", "ignored/\n*.log\n");
  await clone.commit("base files");
  await clone.push();
  assert.deepEqual(await filesInFlight(clone.dir, config), [], "a clean worktree level with its base has nothing in flight");

  await clone.write("tracked.txt", "two\n"); // modified, unstaged
  await clone.write("staged.txt", "s\n");
  await clone.git("add", "staged.txt"); // added, staged
  await clone.write("src/new/untracked.ts", "u\n"); // untracked, in a new directory
  await rm(join(clone.dir, "to-delete.txt")); // deleted
  await clone.git("mv", "to-rename.txt", "renamed.txt"); // renamed: both names matter
  await clone.write("ignored/secret.txt", "i\n");
  await clone.write("debug.log", "i\n");
  await clone.write("name with spaces.txt", "w\n");

  assert.deepEqual(await filesInFlight(clone.dir, config), [
    "name with spaces.txt",
    "renamed.txt",
    "src/new/untracked.ts",
    "staged.txt",
    "to-delete.txt",
    "to-rename.txt",
    "tracked.txt",
  ]);
});

test("filesInFlight adds files changed in commits since the merge-base with the base branch", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");

  await alice.git("checkout", "--quiet", "-b", "feat/auth");
  await alice.write("src/auth.ts", "a\n");
  await alice.commit("auth");
  await alice.write("src/jwt.ts", "j\n");
  await alice.commit("jwt");
  await alice.write("wip.txt", "w\n");

  // main moves on after alice branched: bob's file is not alice's work.
  await bob.write("src/unrelated.ts", "b\n");
  await bob.commit("unrelated");
  await bob.push();
  await alice.git("fetch", "--quiet");

  assert.deepEqual(await filesInFlight(alice.dir, config), ["wip.txt", "src/auth.ts", "src/jwt.ts"], "dirty first, then committed");

  // Unpushed commits made directly on main count too.
  await bob.write("src/direct.ts", "d\n");
  await bob.commit("direct on main");
  assert.deepEqual(await filesInFlight(bob.dir, config), ["src/direct.ts"]);
  await bob.push();
  assert.deepEqual(await filesInFlight(bob.dir, config), []);
});

test("without a base branch, committed files are those of commits not pushed to the remote", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  // A trunk called develop, and a clone that does not know the remote's default branch.
  await alice.git("push", "--quiet", "origin", "main:refs/heads/develop", "main:refs/heads/release/1.x");
  await alice.git("fetch", "--quiet");
  await alice.git("checkout", "--quiet", "-b", "feat/auth", "origin/develop");
  await alice.git("remote", "set-head", "origin", "--delete");
  await alice.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(await resolveBase(alice.dir, config), null);

  await alice.write("src/auth.ts", "a\n");
  await alice.commit("auth");
  await alice.write("src/jwt.ts", "j\n");
  await alice.write("src/auth.ts", "a2\n");
  await alice.commit("jwt, and auth again");
  await alice.write("wip.txt", "w\n");
  assert.deepEqual(await filesInFlight(alice.dir, config), ["wip.txt", "src/auth.ts", "src/jwt.ts"], "dirty first, then each committed file once");

  // The stated limit of the fallback: a pushed branch is visible to the team as a branch, and its files leave the list.
  await alice.git("push", "--quiet", "origin", "feat/auth");
  assert.deepEqual(await filesInFlight(alice.dir, config), ["wip.txt"]);

  // Setting `base` restores the full answer.
  assert.deepEqual(await filesInFlight(alice.dir, { ...config, base: "develop" }), ["wip.txt", "src/auth.ts", "src/jwt.ts"]);
});

test("without a base branch and with nothing fetched from the remote, history is not mistaken for work in flight", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  await alice.write("src/old.ts", "o\n");
  await alice.commit("old work");
  await alice.push();
  for (const ref of (await alice.git("for-each-ref", "--format=%(refname)", "refs/remotes/origin")).split("\n").filter(Boolean)) {
    await alice.git("update-ref", "-d", ref).catch(() => alice.git("symbolic-ref", "-d", ref));
  }
  assert.equal(await resolveBase(alice.dir, config), null);
  await alice.write("wip.txt", "w\n");
  assert.deepEqual(await filesInFlight(alice.dir, config), ["wip.txt"]);
});

test("a shallow clone with no merge-base still reports its unpushed commits", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const bob = await h.clone("bob");
  await alice.git("checkout", "--quiet", "-b", "feat/long");
  await alice.write("src/first.ts", "1\n");
  await alice.commit("first");
  await alice.write("src/second.ts", "2\n");
  await alice.commit("second");
  await alice.git("push", "--quiet", "origin", "feat/long");

  // Bob has only the tip of alice's branch and only the tip of main: the commit they share is not in his clone.
  const shallow = join(h.root, "shallow");
  await bob.git("clone", "--quiet", "--depth=1", "--no-single-branch", `file://${h.remote}`, shallow);
  const git = (...args: string[]) => bob.git("-C", shallow, ...args);
  await git("config", "user.name", "bob");
  await git("config", "user.email", "bob@example.invalid");
  await git("checkout", "--quiet", "feat/long");
  assert.notEqual(await resolveBase(shallow, config), null);
  assert.equal((await bob.gitResult(["-C", shallow, "merge-base", "HEAD", "origin/main"])).ok, false, "the test needs a clone with no merge-base");

  await bob.write("../shallow/src/third.ts", "3\n");
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "third");
  assert.deepEqual(await filesInFlight(shallow, config), ["src/third.ts"]);
});

test("filesInFlight is capped at 200, keeping dirty files ahead of committed ones", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.git("checkout", "--quiet", "-b", "big");
  for (let i = 0; i < 150; i++) await clone.write(`committed/c${String(i).padStart(3, "0")}.txt`, "c\n");
  await clone.commit("many committed files");
  for (let i = 0; i < 120; i++) await clone.write(`dirty/d${String(i).padStart(3, "0")}.txt`, "d\n");

  const files = await filesInFlight(clone.dir, config);
  assert.equal(files.length, 200);
  assert.equal(files.filter((file) => file.startsWith("dirty/")).length, 120);
  assert.equal(files.filter((file) => file.startsWith("committed/")).length, 80);
  assert.equal(files[0], "dirty/d000.txt");
});

test("filesInFlight leaves the index, refs and working tree alone", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await clone.write("a.txt", "a\n");
  await clone.git("add", "a.txt");
  await clone.write("b.txt", "b\n");
  const before = await clone.snapshot();
  await filesInFlight(clone.dir, config);
  await currentBranch(clone.dir);
  await resolveBase(clone.dir, config);
  assert.deepEqual(await clone.snapshot(), before);
});

test("filesInFlight outside a repository is empty rather than an error", async (t) => {
  const h = await createHarness(t);
  assert.deepEqual(await filesInFlight(h.root, config), []);
  assert.deepEqual(await filesInFlight(join(h.root, "nowhere"), config), []);
});

test("toRepoPath makes agent-supplied paths repo-relative and rejects paths outside the worktree", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const paths = await clone.paths();
  await mkdir(join(clone.dir, "src", "deep"), { recursive: true });
  const deep = join(clone.dir, "src", "deep");

  assert.equal(toRepoPath(paths, clone.dir, join(clone.dir, "src", "auth.ts")), "src/auth.ts", "absolute");
  assert.equal(toRepoPath(paths, clone.dir, "src/auth.ts"), "src/auth.ts", "relative to the root");
  assert.equal(toRepoPath(paths, deep, "file.ts"), "src/deep/file.ts", "relative to a subdirectory");
  assert.equal(toRepoPath(paths, deep, "../../README.md"), "README.md");
  assert.equal(toRepoPath(paths, clone.dir, "./src//auth.ts"), "src/auth.ts", "normalized");
  assert.equal(toRepoPath(paths, clone.dir, "not/created/yet.ts"), "not/created/yet.ts", "need not exist");

  assert.equal(toRepoPath(paths, clone.dir, clone.dir), null, "the root itself");
  assert.equal(toRepoPath(paths, clone.dir, "."), null);
  assert.equal(toRepoPath(paths, clone.dir, ""), null);
  assert.equal(toRepoPath(paths, clone.dir, "../bob/src/auth.ts"), null, "a sibling clone");
  assert.equal(toRepoPath(paths, clone.dir, "/etc/passwd"), null);
  assert.equal(toRepoPath(paths, clone.dir, join(h.root, "alice-other", "x.ts")), null, "a directory that merely shares the prefix");
});

test("toRepoPath sees through a symlink to the worktree", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const paths = await clone.paths();
  const link = join(h.root, "link-to-alice");
  await symlink(clone.dir, link);
  assert.equal(toRepoPath(paths, link, "src/auth.ts"), "src/auth.ts");
  assert.equal(toRepoPath(paths, clone.dir, join(link, "src", "new", "file.ts")), "src/new/file.ts");
});

test("toRepoPath answers at once for a path no file system would take", async (t) => {
  // A hook hands toRepoPath whatever its agent sent, and has 150 ms for the whole event.
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const paths = await clone.paths();
  const link = join(h.root, "link-to-alice");
  await symlink(clone.dir, link);
  const timed = <T>(run: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = run();
    return { value, ms: performance.now() - started };
  };

  // Longer than any path can be: not a file, wherever it points. (64,000 directories took 48 s before.)
  const endless = join(clone.dir, ...Array.from({ length: 64_000 }, () => "d"), "f.ts");
  const refused = timed(() => toRepoPath(paths, clone.dir, endless));
  assert.equal(refused.value, null);
  assert.ok(refused.ms < 1000, `took ${Math.round(refused.ms)} ms`);

  // As long as a path can be, thousands of directories that do not exist, reached through a symlink
  // and from outside: both ask the file system, a handful of times however long the missing tail is
  // (the count is pinned in the next test; the clock here only catches a return to seconds).
  const tail = Array.from({ length: 10_000 }, () => "d");
  const through = timed(() => toRepoPath(paths, clone.dir, join(link, ...tail, "f.ts")));
  const outside = timed(() => toRepoPath(paths, clone.dir, join(h.root, "elsewhere", ...tail, "f.ts")));
  assert.equal(outside.value, null);
  assert.equal(through.value, [...tail, "f.ts"].join("/"), "the symlink is resolved however deep the new file is");
  for (const { ms } of [through, outside]) assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);

  // Inside the worktree as given, the file system is not asked at all; a deep new file is still found through a symlink.
  const deepInside = timed(() => toRepoPath(paths, clone.dir, join(clone.dir, ...tail, "f.ts")));
  assert.equal(deepInside.value, [...tail, "f.ts"].join("/"));
  assert.ok(deepInside.ms < 1000, `took ${Math.round(deepInside.ms)} ms`);
  const fewMissing = Array.from({ length: 40 }, (_, i) => `new${i}`);
  assert.equal(toRepoPath(paths, clone.dir, join(link, ...fewMissing, "f.ts")), [...fewMissing, "f.ts"].join("/"));
});

test("resolveExisting finds the existing part of a path in a handful of looks, whatever its length", async (t) => {
  // It runs before an edit, inside a hook's 150 ms, and each look is synchronous. One look per
  // missing directory took 0.2 s for the longest path there is; the number of looks is what is pinned
  // here, because a clock in a test says more about the machine than about the code.
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  await mkdir(join(clone.dir, "src", "deep"), { recursive: true });
  const link = join(h.root, "link-to-alice");
  await symlink(clone.dir, link);
  const counted = (path: string): { value: string; looks: number } => {
    let looks = 0;
    const value = resolveExisting(path, (prefix) => {
      looks++;
      return realpathSync(prefix);
    });
    return { value, looks };
  };

  // The longest path taken (32,767 characters) of one-letter directories, through the symlink.
  const letters = Array.from({ length: 16_000 }, () => "d");
  const longest = counted(join(link, ...letters, "f.ts"));
  assert.equal(longest.value, join(clone.dir, ...letters, "f.ts"));
  assert.ok(longest.looks <= 20, `${longest.looks} looks`);

  // Every place the existing part can end, counted from the symlink: nothing below it, one directory, two, the file itself.
  assert.deepEqual(counted(join(link, "new.ts")).value, join(clone.dir, "new.ts"));
  assert.deepEqual(counted(join(link, "src", "new.ts")).value, join(clone.dir, "src", "new.ts"));
  assert.deepEqual(counted(join(link, "src", "deep", "a", "b", "c", "new.ts")).value, join(clone.dir, "src", "deep", "a", "b", "c", "new.ts"));
  assert.deepEqual(counted(join(link, "README.md")), { value: join(clone.dir, "README.md"), looks: 1 }, "a path that exists is one look");
  for (let missing = 1; missing <= 70; missing++) {
    const extra = Array.from({ length: missing }, (_, i) => `n${i}`);
    assert.equal(counted(join(link, "src", ...extra)).value, join(clone.dir, "src", ...extra), `${missing} missing`);
  }

  // A file where a directory is expected, and a symlink that points nowhere: resolved up to there, the rest as given.
  assert.equal(counted(join(link, "README.md", "x", "y")).value, join(clone.dir, "README.md", "x", "y"));
  await symlink(join(h.root, "nowhere"), join(clone.dir, "dangling"));
  assert.equal(counted(join(link, "dangling", "x")).value, join(clone.dir, "dangling", "x"));

  // Nothing resolves, not even the root: the path comes back as it was given.
  const never = (): string => {
    throw new Error("no file system");
  };
  assert.equal(resolveExisting(join(link, "a", "b"), never), join(link, "a", "b"));
});

test("toRepoPattern resolves claim globs from where they were typed", async (t) => {
  const h = await createHarness(t);
  const clone = await h.clone("alice");
  const paths = await clone.paths();
  await mkdir(join(clone.dir, "src", "auth"), { recursive: true });
  const sub = join(clone.dir, "src", "auth");

  assert.equal(toRepoPattern(paths, clone.dir, "src/auth/**"), "src/auth/**");
  assert.equal(toRepoPattern(paths, clone.dir, "./src/*.ts"), "src/*.ts");
  assert.equal(toRepoPattern(paths, sub, "*.ts"), "src/auth/*.ts", "relative to the subdirectory");
  assert.equal(toRepoPattern(paths, sub, "../payments/**"), "src/payments/**");
  assert.equal(toRepoPattern(paths, sub, "/docs/**"), "docs/**", "a leading slash means the repo root");
  assert.equal(toRepoPattern(paths, clone.dir, "src\\auth\\*.ts"), "src/auth/*.ts");

  assert.equal(toRepoPattern(paths, clone.dir, "../outside/**"), null);
  assert.equal(toRepoPattern(paths, sub, "../../../x"), null);
  assert.equal(toRepoPattern(paths, h.root, "*.ts"), null, "typed outside the worktree");
  assert.equal(toRepoPattern(paths, clone.dir, ""), null);
  assert.equal(toRepoPattern(paths, clone.dir, "."), null);
});
