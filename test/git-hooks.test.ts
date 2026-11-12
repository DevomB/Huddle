import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { GIT_HOOKS, MAX_STAGED_PATHS, checkGitHooks, commandLine, gitHooks, hookBlock, installGitHooks, removeGitHooks, withBlock, withoutBlock } from "../src/adapters/git-hooks.ts";
import type { GitHook } from "../src/adapters/git-hooks.ts";
import { ADAPTERS, getAdapter } from "../src/adapters/index.ts";
import { SILENT } from "../src/adapters/types.ts";
import type { HookEvent, HookInput } from "../src/adapters/types.ts";
import type { GitResult } from "../src/core/git.ts";
import { manualSessionId } from "../src/core/identity.ts";
import { pathsFor } from "../src/core/paths.ts";
import { createHarness } from "./harness.ts";
import type { Clone, Harness } from "./harness.ts";

const BUNDLE = ".huddle/huddle.mjs";
const POSIX = process.platform !== "win32";

// ---------------------------------------------------------------------------
// A stand-in for the bundle: it writes down how it was started and leaves.
// ---------------------------------------------------------------------------

const RECORDER = `import { appendFileSync, existsSync, readFileSync } from "node:fs";
let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {}
const hook = process.argv[4] ?? "";
const hold = process.env.HUDDLE_TEST_HOLD;
if (hold && hook.startsWith("post-")) {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 1000 && !existsSync(hold); i++) Atomics.wait(nap, 0, 0, 20);
}
try {
  appendFileSync(process.env.HUDDLE_TEST_RECORD, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin, session: process.env.HUDDLE_SESSION ?? null }) + "\\n");
} catch {}
if (process.env.HUDDLE_TEST_STDERR) process.stderr.write(process.env.HUDDLE_TEST_STDERR + "\\n");
process.exit(Number(process.env.HUDDLE_TEST_EXIT || 0));
`;

interface Rec {
  args: string[];
  cwd: string;
  stdin: string;
  session: string | null;
}

interface Bench {
  h: Harness;
  /** Runs git with the node that runs the tests first on PATH, and the recorder pointed at this bench. */
  run(clone: Clone, args: string[], env?: Record<string, string | undefined>): Promise<GitResult>;
  /** Everything the recorder wrote so far, optionally for one hook. */
  records(hook?: GitHook): Rec[];
  /** Waits for the recorder to have written `count` records for `hook`. The post hooks run in the background. */
  settled(hook: GitHook, count: number): Promise<Rec[]>;
}

async function bench(t: TestContext): Promise<Bench> {
  const h = await createHarness(t);
  const file = join(h.root, "records.jsonl");
  const records = (hook?: GitHook): Rec[] => {
    if (!existsSync(file)) return [];
    const all = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Rec);
    return hook === undefined ? all : all.filter((rec) => rec.args[2] === hook);
  };
  return {
    h,
    records,
    run: (clone, args, env = {}) =>
      clone.gitResult(args, { env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, HUDDLE_TEST_RECORD: file, ...env } }),
    async settled(hook, count) {
      for (let i = 0; i < 2000; i++) {
        const found = records(hook);
        if (found.length >= count) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`the ${hook} hook never reported ${count} time(s); records: ${JSON.stringify(records())}`);
    },
  };
}

async function withRecorder(clone: Clone): Promise<Clone> {
  await clone.write(BUNDLE, RECORDER);
  return clone;
}

function hookFile(clone: Clone, hook: string, dir = ".git/hooks"): string {
  return join(clone.dir, dir, hook);
}

async function modeOf(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

async function script(file: string, text: string, mode = 0o755): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  await chmod(file, mode);
}

function ok(result: GitResult): GitResult {
  assert.ok(result.ok, `git failed (${result.code}): ${result.stderr}`);
  return result;
}

/** Stages one new file and commits it. */
async function commitFile(b: Bench, clone: Clone, rel: string, env: Record<string, string | undefined> = {}): Promise<GitResult> {
  await clone.write(rel, `${rel} ${Math.random()}\n`);
  ok(await b.run(clone, ["add", "--", rel], env));
  return b.run(clone, ["commit", "--quiet", "-m", `add ${rel}`], env);
}

const install = (clone: Clone, bundle = BUNDLE) => installGitHooks({ repoRoot: clone.dir, bundle });

// ---------------------------------------------------------------------------
// The block: adding it and taking it out again
// ---------------------------------------------------------------------------

const HUSKY_8_FIRST = '. "$(dirname -- "$0")/_/husky.sh"';

const NODE_NOTE =
  "The git hooks need node on the PATH of whatever runs git. A graphical git client or an editor's source control panel may not have it there (nvm, fnm and volta set it up in the shell). The hooks then do nothing and say nothing, and commits made there do not reach teammates.";

const SCRIPTS: Array<{ name: string; text: string; before: string }> = [
  { name: "an empty file", text: "", before: "" },
  { name: "only a shebang, no line break", text: "#!/bin/sh", before: "#!/bin/sh\n" },
  { name: "only a shebang", text: "#!/bin/sh\n", before: "#!/bin/sh\n" },
  { name: "a script", text: "#!/bin/sh\nnpm test\n", before: "#!/bin/sh\n" },
  { name: "a script whose last line has no line break", text: "#!/usr/bin/env bash\nset -e\nexec npm test", before: "#!/usr/bin/env bash\n" },
  { name: "no shebang", text: "npm test\n", before: "" },
  { name: "no shebang and no line break", text: "npm test", before: "" },
  { name: "blank lines only", text: "\n\n", before: "" },
  { name: "CRLF line ends", text: "#!/bin/sh\r\nnpm test\r\n", before: "#!/bin/sh\r\n" },
  { name: "a husky 8 hook", text: `#!/usr/bin/env sh\n${HUSKY_8_FIRST}\n\nnpx lint-staged\n`, before: `#!/usr/bin/env sh\n${HUSKY_8_FIRST}\n` },
  { name: "a husky 8 hook that ends on husky's line", text: `#!/usr/bin/env sh\n${HUSKY_8_FIRST}`, before: `#!/usr/bin/env sh\n${HUSKY_8_FIRST}\n` },
  { name: "a comment that looks a little like a marker", text: "#!/bin/sh\n# >>> not huddle >>>\necho hi\n# <<< huddle\n", before: "#!/bin/sh\n" },
];

test("git block: goes after the first line that must stay first, and comes out again without a trace", () => {
  for (const hook of GIT_HOOKS) {
    for (const created of [false, true]) {
      const block = hookBlock(hook, BUNDLE, created);
      for (const { name, text, before } of SCRIPTS) {
        const added = withBlock(text, block);
        assert.ok(added.startsWith(before + block.trimEnd()), `${name}: the block is in the wrong place:\n${added}`);
        assert.equal(added.split(commandLine(hook, BUNDLE)).length, 2, `${name}: the command is there exactly once`);
        assert.equal(withoutBlock(added), text, `${name}: removing gives back the original`);
        assert.equal(withBlock(added, block), added, `${name}: adding twice changes nothing`);
      }
    }
  }
});

test("git block: an older block is replaced where it stands and nothing else moves", () => {
  const old = "# >>> huddle >>> an older wording\nnode old.mjs hook git pre-commit || exit 3\n# <<< huddle <<<\n";
  const block = hookBlock("pre-commit", BUNDLE, false);
  for (const [head, tail] of [
    ["#!/bin/sh\necho before\n", "echo after\n"],
    ["", ""],
    ["#!/bin/sh\n", "exec npm test"],
  ] as const) {
    assert.equal(withBlock(head + old + tail, block), head + block + tail);
    assert.equal(withoutBlock(head + old + tail), head + tail);
  }
  // A block that lost its last line break (it was the end of the file) is replaced without gaining one.
  assert.equal(withBlock(`#!/bin/sh\n${old.trimEnd()}`, block), `#!/bin/sh\n${block.trimEnd()}`);
  // A file with no block is returned as it is.
  assert.equal(withoutBlock("#!/bin/sh\nnpm test\n"), "#!/bin/sh\nnpm test\n");
});

test("git block: a marker line that is not part of a whole block is the user's text, and so is everything next to it", () => {
  const block = hookBlock("pre-commit", BUNDLE, false);
  const begin = "# >>> huddle >>> (the other two lines were deleted by hand)\n";
  const end = "# <<< huddle <<<\n";
  const leftovers: Array<[name: string, text: string]> = [
    // b6's case: a husky 8 hook, two of the three lines deleted. The block goes below husky's line, so the stray marker is above it.
    ["a begin line above the place the block goes", `#!/bin/sh\n${begin}npm test\n${HUSKY_8_FIRST}\nnpx lint-staged\n`],
    ["a begin line and nothing else", `#!/bin/sh\n${begin}npm test\n`],
    ["an end line and nothing else", `#!/bin/sh\nnpm test\n${end}npx lint-staged\n`],
    ["a begin and an end with the user's lines between them", `#!/bin/sh\n${begin}npm test\nnpx lint-staged\n${end}echo done\n`],
    ["a begin and an end with nothing between them", `#!/bin/sh\n${begin}${end}npm test\n`],
    // Three lines, and the one in the middle is not huddle's command.
    ["a begin and an end around one line of the user's", `#!/bin/sh\n${begin}npm test\n${end}npx lint-staged\n`],
    ["a begin and an end around a line that only mentions huddle", `#!/bin/sh\n${begin}echo "see the huddle hook, git people"\n${end}`],
    ["a begin line right above where a block will go", `#!/bin/sh\n${begin}`],
    ["an end line with something after the marker", "#!/bin/sh\n# >>> huddle >>>\nnpm test\n# <<< huddle <<< kept\n"],
    ["the begin marker indented", "#!/bin/sh\nif true; then\n  # >>> huddle >>>\n  npm test\n  # <<< huddle <<<\nfi\n"],
  ];
  for (const [name, text] of leftovers) {
    assert.equal(withoutBlock(text), text, `${name}: there is no block to take out`);
    const once = withBlock(text, block);
    // Every line of the user's is still there, in order, and the block was added whole.
    assert.equal(withoutBlock(once), text, `${name}: adding and removing gives back every line`);
    assert.equal(once.split(commandLine("pre-commit", BUNDLE)).length, 2, name);
    // The next `huddle init`, and the one after: nothing more changes.
    assert.equal(withBlock(once, block), once, `${name}: a second init changes nothing`);
    assert.equal(withBlock(withBlock(once, hookBlock("pre-commit", "tools/huddle.mjs", false)), block), once, `${name}: moving the bundle and back`);
  }
});

test("git block: two whole blocks, as a merge kept by hand can leave them, become one and are both taken out", () => {
  const block = hookBlock("pre-commit", BUNDLE, false);
  const other = hookBlock("pre-commit", "tools/huddle.mjs", false);
  const text = `#!/bin/sh\n${other}npm test\n${block}npx lint-staged\n${other.trimEnd()}`;
  assert.equal(withBlock(text, block), `#!/bin/sh\n${block}npm test\nnpx lint-staged\n`);
  assert.equal(withoutBlock(text), "#!/bin/sh\nnpm test\nnpx lint-staged\n");
  assert.equal(withBlock(withBlock(text, block), block), withBlock(text, block));
});

test("git block: the command lines, word for word", () => {
  assert.equal(
    commandLine("pre-commit", BUNDLE),
    'huddle_root="$(git rev-parse --show-toplevel 2>/dev/null)" && test -f "$huddle_root/.huddle/huddle.mjs" && command -v node >/dev/null 2>&1 && ! git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && git diff --cached --name-only --no-renames -z 2>/dev/null | node "$huddle_root/.huddle/huddle.mjs" hook git pre-commit || :',
  );
  for (const hook of ["post-commit", "post-checkout", "post-merge"] as const) {
    assert.equal(
      commandLine(hook, BUNDLE),
      `huddle_root="$(git rev-parse --show-toplevel 2>/dev/null)" && test -f "$huddle_root/.huddle/huddle.mjs" && command -v node >/dev/null 2>&1 && (node "$huddle_root/.huddle/huddle.mjs" hook git ${hook} </dev/null >/dev/null 2>&1 &) || :`,
    );
  }
  const block = hookBlock("post-merge", BUNDLE, false).split("\n");
  assert.equal(block.length, 4, "three lines and the final line break");
  assert.match(block[0] ?? "", /^# >>> huddle >>> .*Never blocks git/);
  assert.equal(block[2], "# <<< huddle <<<");
});

// ---------------------------------------------------------------------------
// parse and format
// ---------------------------------------------------------------------------

const CWD = "/home/dev/acme";
const MANUAL = manualSessionId(pathsFor(CWD, CWD, CWD), {});

function input(args: string[], stdin = "", env: NodeJS.ProcessEnv = {}, cwd = CWD): HookInput {
  return { args, stdin, env, cwd };
}

test("git parse: the post hooks are signs of life in the worktree's own session", () => {
  for (const hook of ["post-commit", "post-checkout", "post-merge"]) {
    assert.deepEqual(gitHooks.parse(input([hook])), { type: "post-edit", agent: "git", sessionId: MANUAL, cwd: CWD, ambient: true, native: { hook } });
  }
  // Whatever git hands a hook as arguments or input is not huddle's business.
  assert.deepEqual(gitHooks.parse(input(["post-checkout", "abc", "def", "1"], "junk")), {
    type: "post-edit",
    agent: "git",
    sessionId: MANUAL,
    cwd: CWD,
    ambient: true,
    native: { hook: "post-checkout" },
  });
});

test("git parse: pre-commit carries the staged paths", () => {
  assert.deepEqual(gitHooks.parse(input(["pre-commit"], "src/a.ts\0docs/read me.md\0we\nird.ts\0")), {
    type: "pre-edit",
    agent: "git",
    sessionId: MANUAL,
    cwd: CWD,
    ambient: true,
    native: { hook: "pre-commit" },
    paths: ["src/a.ts", "docs/read me.md", "we\nird.ts"],
  });
  // One path per line, from a hook written by hand, with either line end.
  assert.deepEqual(gitHooks.parse(input(["pre-commit"], "src/a.ts\r\nsrc/b.ts\n"))?.paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(gitHooks.parse(input(["pre-commit"], "src/a.ts"))?.paths, ["src/a.ts"]);
  // A path is listed once.
  assert.deepEqual(gitHooks.parse(input(["pre-commit"], "a\0b\0a\0"))?.paths, ["a", "b"]);
  // A huge commit is cut off, not refused.
  const many = Array.from({ length: MAX_STAGED_PATHS + 500 }, (_, i) => `src/file-${i}.ts`);
  const paths = gitHooks.parse(input(["pre-commit"], `${many.join("\0")}\0`))?.paths ?? [];
  assert.equal(paths.length, MAX_STAGED_PATHS);
  assert.equal(paths[0], "src/file-0.ts");
  assert.equal(paths[MAX_STAGED_PATHS - 1], `src/file-${MAX_STAGED_PATHS - 1}.ts`);
});

test("git parse: a commit made from an agent's shell belongs to that agent's session, as a guest", () => {
  const event = gitHooks.parse(input(["post-commit"], "", { HUDDLE_SESSION: "claude-7f3a" }));
  assert.equal(event?.sessionId, "claude-7f3a");
  assert.equal(event?.subagent, true, "it must not relabel or move the agent's session");
  assert.equal((event as (HookEvent & { ambient?: boolean }) | null)?.ambient, true);
  // An empty or blank variable is no session.
  for (const blank of ["", "   "]) {
    const own = gitHooks.parse(input(["post-commit"], "", { HUDDLE_SESSION: blank }));
    assert.equal(own?.sessionId, MANUAL);
    assert.equal(own?.subagent, undefined);
  }
});

test("git parse: the session id is the one the CLI uses in the same worktree", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const tree = await alice.addWorktree("side");
  const inMain = gitHooks.parse(input(["post-commit"], "", {}, alice.dir));
  const inTree = gitHooks.parse(input(["post-commit"], "", {}, tree.dir));
  assert.equal(inMain?.sessionId, manualSessionId(await alice.paths(), {}));
  assert.equal(inTree?.sessionId, manualSessionId(await tree.paths(), {}));
  assert.notEqual(inMain?.sessionId, inTree?.sessionId);
});

test("git parse: null for everything that is not one of the four hooks with something to say, and never a throw", () => {
  assert.equal(gitHooks.parse(input([])), null);
  assert.equal(gitHooks.parse(input(["pre-push"])), null);
  assert.equal(gitHooks.parse(input(["commit-msg", ".git/COMMIT_EDITMSG"])), null);
  assert.equal(gitHooks.parse(input(["PRE-COMMIT"], "a\0")), null);
  assert.equal(gitHooks.parse(input(["pre-commit"], "")), null, "nothing staged");
  assert.equal(gitHooks.parse(input(["pre-commit"], "\0\0")), null, "separators only");
  assert.equal(gitHooks.parse(input(["pre-commit"], "\n\r\n")), null, "blank lines only");
  assert.equal(gitHooks.parse(input(["post-commit"], "", {}, "")), null, "no directory");
  for (const broken of [{}, { args: null }, { args: ["post-commit"] }, { args: ["pre-commit"], stdin: 7, env: {}, cwd: CWD }, null]) {
    assert.equal(gitHooks.parse(broken as unknown as HookInput), null);
  }
});

test("git format: an overlap warning goes to the terminal and the commit goes ahead", () => {
  const pre = gitHooks.parse(input(["pre-commit"], "src/a.ts\0"));
  const post = gitHooks.parse(input(["post-commit"]));
  assert.ok(pre && post);
  const warning = "[huddle] src/a.ts overlaps teammates' work in flight.\n- bob has it in flight: auth";
  assert.deepEqual(gitHooks.format(pre, { context: `${warning}\n` }), {
    stdout: "",
    stderr: `${warning}\n[huddle] The commit goes ahead. This is only a heads-up.\n`,
    exitCode: 0,
  });
  assert.equal(gitHooks.format(pre, {}), SILENT);
  assert.equal(gitHooks.format(pre, { context: "  \n" }), SILENT);
  assert.equal(gitHooks.format(pre, { env: { HUDDLE_SESSION: "x" } }), SILENT, "a git hook cannot set anyone's environment");
  // The post hooks run with no terminal: nothing is ever printed for them.
  assert.equal(gitHooks.format(post, { context: warning }), SILENT);
});

// ---------------------------------------------------------------------------
// install on a clone with no hooks
// ---------------------------------------------------------------------------

test("git install: a clone with no hooks gets four files that hold nothing but the block", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const before = (await readdir(join(alice.dir, ".git/hooks"))).sort();

  const result = await install(alice);
  assert.deepEqual(result.changed, GIT_HOOKS.map((hook) => `.git/hooks/${hook}`));
  assert.equal(result.notes.length, 3);
  assert.match(result.notes[0] ?? "", /each teammate runs huddle init once in their own clone/);
  assert.equal(result.notes[1], "The git hooks run .huddle/huddle.mjs from whatever is checked out, also right after a checkout or a merge. Checking out a branch you do not trust runs its copy.");
  // Without node the hooks are silent by design, so this is the only place anyone hears of it.
  assert.equal(result.notes[2], NODE_NOTE);
  // Hooks under .git are nobody's to commit.
  assert.deepEqual(result.files, []);
  for (const hook of GIT_HOOKS) {
    assert.equal(await readFile(hookFile(alice, hook), "utf8"), `#!/bin/sh\n${hookBlock(hook, BUNDLE, true)}`);
    assert.equal(await modeOf(hookFile(alice, hook)), 0o755);
  }
  assert.deepEqual((await readdir(join(alice.dir, ".git/hooks"))).sort(), [...before, ...GIT_HOOKS].sort(), "no other file appeared, none went away");

  assert.deepEqual(await install(alice), { changed: [], notes: result.notes, files: [] }, "a second run changes nothing");
  assert.deepEqual(await install(alice, "./.huddle/huddle.mjs"), { changed: [], notes: result.notes, files: [] }, "the bundle path is one spelling");
  assert.deepEqual(await checkGitHooks(alice.dir), { installed: true, detail: "4 git hooks in .git/hooks", notes: result.notes });
  assert.equal(await alice.git("status", "--porcelain", "--", ".git"), "", "nothing git tracks was touched");
});

test("git hooks: a plain commit, a checkout and a merge each start huddle at the top of the worktree", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await install(alice);

  ok(await commitFile(b, alice, "src/auth.ts"));
  assert.deepEqual(b.records("pre-commit"), [{ args: ["hook", "git", "pre-commit"], cwd: alice.dir, stdin: "src/auth.ts\0", session: null }]);
  assert.deepEqual(await b.settled("post-commit", 1), [{ args: ["hook", "git", "post-commit"], cwd: alice.dir, stdin: "", session: null }]);

  ok(await b.run(alice, ["checkout", "--quiet", "-b", "topic"]));
  assert.deepEqual(await b.settled("post-checkout", 1), [{ args: ["hook", "git", "post-checkout"], cwd: alice.dir, stdin: "", session: null }]);

  // From a subdirectory, and from an agent's shell: same top, and the agent's session id travels.
  await alice.write("src/deep/b.ts", "b\n");
  ok(await b.run(alice, ["-C", "src/deep", "add", "b.ts"]));
  ok(await b.run(alice, ["-C", "src/deep", "commit", "--quiet", "-m", "b"], { HUDDLE_SESSION: "codex-1" }));
  assert.deepEqual(b.records("pre-commit")[1], { args: ["hook", "git", "pre-commit"], cwd: alice.dir, stdin: "src/deep/b.ts\0", session: "codex-1" });
  await b.settled("post-commit", 2);

  ok(await b.run(alice, ["checkout", "--quiet", "main"]));
  await b.settled("post-checkout", 2);
  ok(await b.run(alice, ["merge", "--quiet", "--no-ff", "-m", "merge topic", "topic"]));
  assert.deepEqual(await b.settled("post-merge", 1), [{ args: ["hook", "git", "post-merge"], cwd: alice.dir, stdin: "", session: null }]);
});

test("git hooks: pre-commit sees what this commit holds, however the commit was made", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await install(alice);
  const staged = (): string => b.records("pre-commit").at(-1)?.stdin ?? "(no record)";

  // git commit -a: nothing was staged by hand.
  await alice.write("README.md", "# changed\n");
  ok(await b.run(alice, ["commit", "--quiet", "-a", "-m", "all"]));
  assert.equal(staged(), "README.md\0");

  // git commit <path>: another file is staged and stays out of this commit.
  await alice.write("later.txt", "later\n");
  ok(await b.run(alice, ["add", "later.txt"]));
  await alice.write("README.md", "# changed again\n");
  ok(await b.run(alice, ["commit", "--quiet", "-m", "only the readme", "README.md"]));
  assert.equal(staged(), "README.md\0");
  assert.equal(await alice.git("diff", "--cached", "--name-only"), "later.txt", "the other file is still waiting");

  // A rename counts under both names, and a path with a space or a non-ASCII letter arrives as it is.
  ok(await b.run(alice, ["mv", "README.md", "docs read me.md"]));
  await alice.write(`caf${String.fromCodePoint(0xe9)}.txt`, "x\n");
  ok(await b.run(alice, ["add", "-A", "--", ":!.huddle"]));
  ok(await b.run(alice, ["commit", "--quiet", "-m", "rename"]));
  assert.deepEqual(staged().split("\0").filter(Boolean).sort(), ["README.md", `caf${String.fromCodePoint(0xe9)}.txt`, "docs read me.md", "later.txt"]);

  // Nothing staged at all: huddle is still started, with nothing to read.
  ok(await b.run(alice, ["commit", "--quiet", "--allow-empty", "-m", "empty"]));
  assert.equal(staged(), "");
  assert.equal(b.records("pre-commit").length, 4);
  await b.settled("post-commit", 4);
});

test("git hooks: while a merge is being concluded pre-commit stays out of it", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await install(alice);
  await alice.write("f.txt", "base\n");
  ok(await b.run(alice, ["add", "f.txt"]));
  ok(await b.run(alice, ["commit", "--quiet", "-m", "base"]));
  ok(await b.run(alice, ["checkout", "--quiet", "-b", "topic"]));
  await alice.write("f.txt", "topic\n");
  await alice.write("theirs.txt", "a file the other branch added\n");
  ok(await b.run(alice, ["add", "f.txt", "theirs.txt"]));
  ok(await b.run(alice, ["commit", "--quiet", "-m", "topic"]));
  ok(await b.run(alice, ["checkout", "--quiet", "main"]));
  await alice.write("f.txt", "main\n");
  ok(await b.run(alice, ["commit", "--quiet", "-a", "-m", "main"]));
  assert.equal(b.records("pre-commit").length, 3);
  await b.settled("post-commit", 3);

  const merge = await b.run(alice, ["merge", "topic"]);
  assert.equal(merge.ok, false, "the merge stops on the conflict");
  await alice.write("f.txt", "both\n");
  ok(await b.run(alice, ["add", "f.txt"]));
  ok(await b.run(alice, ["commit", "--quiet", "--no-edit"]));
  assert.equal(b.records("pre-commit").length, 3, "no overlap check on the other branch's files");
  await b.settled("post-commit", 4);
});

test("git hooks: git does not wait for the post hooks, and neither does a program that reads git's output", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await install(alice);
  const release = join(b.h.root, "release");

  // The recorder will not finish a post hook until `release` exists. If git, or
  // the pipes this test reads git through, waited for it, this call would not
  // return before git's own timeout.
  ok(await commitFile(b, alice, "a.txt", { HUDDLE_TEST_HOLD: release }));
  assert.equal(b.records("pre-commit").length, 1);
  assert.deepEqual(b.records("post-commit"), [], "the commit is done and huddle is still running");
  await writeFile(release, "");
  await b.settled("post-commit", 1);
});

test("git hooks: nothing huddle does or lacks can stop a commit or change what git prints", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await install(alice);

  // huddle fails: the commit is made, and what huddle wrote to stderr is shown.
  const failing = ok(await commitFile(b, alice, "one.txt", { HUDDLE_TEST_EXIT: "1", HUDDLE_TEST_STDERR: "[huddle] heads-up" }));
  assert.match(failing.stderr, /^\[huddle\] heads-up$/m, "pre-commit's stderr reaches the terminal");
  await b.settled("post-commit", 1);

  // No node on PATH.
  const bin = join(b.h.root, "bin");
  await mkdir(bin);
  await symlink(await which("git"), join(bin, "git"));
  const noNode = ok(await commitFile(b, alice, "two.txt", { PATH: bin }));
  assert.equal(noNode.stderr, "");
  assert.equal(b.records().length, 2, "huddle was not started");

  // The bundle is not in this checkout (a branch from before huddle init).
  await rm(join(alice.dir, BUNDLE));
  const noBundle = ok(await commitFile(b, alice, "three.txt"));
  assert.equal(noBundle.stderr, "");
  ok(await b.run(alice, ["checkout", "--quiet", "-b", "elsewhere"]));
  assert.equal(b.records().length, 2);
  assert.equal(await alice.git("log", "--format=%s", "-3"), "add three.txt\nadd two.txt\nadd one.txt");
});

async function which(name: string): Promise<string> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return realpath(candidate);
  }
  throw new Error(`${name} is not on PATH`);
}

// ---------------------------------------------------------------------------
// Hooks that are already there
// ---------------------------------------------------------------------------

const USER_HOOK = '#!/bin/sh\n# our own check\necho "user pre-commit ran" >> "$USER_MARKER"\nexec true\necho "never reached"\n';

test("git install: an existing hook keeps every byte and still runs, with huddle's lines in front of it", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const marker = join(b.h.root, "user-marker");
  await script(hookFile(alice, "pre-commit"), USER_HOOK, 0o700);

  const result = await install(alice);
  assert.deepEqual(result.changed, GIT_HOOKS.map((hook) => `.git/hooks/${hook}`));
  const added = hookBlock("pre-commit", BUNDLE, false);
  assert.equal(await readFile(hookFile(alice, "pre-commit"), "utf8"), USER_HOOK.replace("#!/bin/sh\n", `#!/bin/sh\n${added}`));
  assert.equal(await modeOf(hookFile(alice, "pre-commit")), 0o700, "the mode is the user's");
  assert.deepEqual((await install(alice)).changed, []);

  ok(await commitFile(b, alice, "a.txt", { USER_MARKER: marker }));
  assert.equal(await readFile(marker, "utf8"), "user pre-commit ran\n");
  assert.equal(b.records("pre-commit").length, 1, "huddle ran although the user's script ends in exec");
  await b.settled("post-commit", 1);

  // The user's hook still decides: when it refuses, the commit is refused.
  await script(hookFile(alice, "pre-commit"), (await readFile(hookFile(alice, "pre-commit"), "utf8")).replace("exec true", "exit 1"), 0o700);
  const refused = await commitFile(b, alice, "b.txt", { USER_MARKER: marker });
  assert.equal(refused.ok, false);
  assert.equal(await alice.git("log", "--format=%s", "-1"), "add a.txt");
  assert.equal(b.records("pre-commit").length, 2);
});

test("git remove: gives back exactly what was there", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const before = (await readdir(join(alice.dir, ".git/hooks"))).sort();
  await script(hookFile(alice, "pre-commit"), USER_HOOK, 0o700);
  await script(hookFile(alice, "post-merge"), "npm install", 0o755); // no shebang, no line break
  await install(alice);
  // After installing, the user adds a line of their own to a file huddle created.
  const created = hookFile(alice, "post-commit");
  await writeFile(created, `${await readFile(created, "utf8")}echo "mine"\n`);

  assert.deepEqual(await removeGitHooks(alice.dir), GIT_HOOKS.map((hook) => `.git/hooks/${hook}`));
  assert.equal(await readFile(hookFile(alice, "pre-commit"), "utf8"), USER_HOOK);
  assert.equal(await modeOf(hookFile(alice, "pre-commit")), 0o700);
  assert.equal(await readFile(hookFile(alice, "post-merge"), "utf8"), "npm install");
  assert.equal(await readFile(created, "utf8"), '#!/bin/sh\necho "mine"\n', "the user's line stays, in a file that still runs");
  assert.equal(existsSync(hookFile(alice, "post-checkout")), false, "a file huddle created and nobody added to is gone");
  assert.deepEqual((await readdir(join(alice.dir, ".git/hooks"))).sort(), [...before, "pre-commit", "post-merge", "post-commit"].sort());

  assert.deepEqual(await removeGitHooks(alice.dir), [], "nothing left to remove");
  ok(await commitFile(b, alice, "a.txt", { USER_MARKER: join(b.h.root, "marker") }));
  assert.deepEqual(b.records(), [], "huddle no longer runs");
});

test("git install: a hook huddle cannot add itself to is left exactly as it is, and named", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const python = "#!/usr/bin/env python3\nprint('checking')\n";
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]);
  await script(hookFile(alice, "pre-commit"), python);
  await writeFile(hookFile(alice, "post-commit"), binary);
  await chmod(hookFile(alice, "post-commit"), 0o755);
  // A link to a script the team keeps elsewhere.
  await script(join(alice.dir, "scripts/hook.sh"), "#!/bin/sh\necho shared\n");
  await symlink("../../scripts/hook.sh", hookFile(alice, "post-checkout"));

  const result = await install(alice);
  assert.deepEqual(result.changed, [".git/hooks/post-merge"]);
  assert.equal(await readFile(hookFile(alice, "pre-commit"), "utf8"), python);
  assert.deepEqual(await readFile(hookFile(alice, "post-commit")), binary);
  assert.ok((await lstat(hookFile(alice, "post-checkout"))).isSymbolicLink());
  assert.equal(await readlink(hookFile(alice, "post-checkout")), "../../scripts/hook.sh");
  assert.equal(await alice.read("scripts/hook.sh"), "#!/bin/sh\necho shared\n");

  const left = result.notes.find((note) => note.startsWith("huddle left 3 hooks alone")) ?? "";
  assert.match(left, /\.git\/hooks\/pre-commit is not a shell script \(it starts with "#!\/usr\/bin\/env python3"\)/);
  assert.match(left, /\.git\/hooks\/post-commit is not a text file/);
  assert.match(left, /\.git\/hooks\/post-checkout is a symbolic link/);
  assert.ok(left.endsWith(commandLine("post-commit", BUNDLE)), "and how to add huddle by hand");

  // doctor reports the one that is in, and names the three that are not.
  const check = await checkGitHooks(alice.dir);
  assert.equal(check.installed, true);
  assert.equal(check.detail, "1 git hook in .git/hooks; pre-commit, post-commit, post-checkout left alone");
  assert.equal(check.notes[3], "The pre-commit, post-commit, post-checkout hooks in .git/hooks are not shell scripts huddle can add itself to, so they were left alone.");
  assert.equal("broken" in check, false, "left alone on purpose is not broken");
});

test("git install: which first lines count as a shell script", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const file = hookFile(alice, "pre-commit");
  const shells = ["#!/bin/sh", "#! /bin/sh", "#!/bin/sh -e", "#!/usr/bin/env sh", "#!/usr/bin/env bash", "#!/bin/bash -eu", "#!/usr/bin/env -S bash -e", "#!/usr/local/bin/zsh", "#!/bin/dash", "#!/bin/ksh", "echo no shebang at all"];
  const others = ["#!/usr/bin/env python3", "#!/usr/bin/env node", "#!/usr/bin/perl -w", "#!/usr/bin/fish", "#!/usr/bin/env pwsh", "#!/usr/bin/env shellcheck", "#!/usr/bin/ruby"];
  for (const first of shells) {
    await script(file, `${first}\necho rest\n`);
    await install(alice);
    assert.ok((await readFile(file, "utf8")).includes(commandLine("pre-commit", BUNDLE)), `${first}: huddle is in`);
  }
  for (const first of others) {
    await script(file, `${first}\nrest\n`);
    await install(alice);
    assert.equal(await readFile(file, "utf8"), `${first}\nrest\n`, `${first}: untouched`);
  }
});

test("git install: a hook file git would not run is not made to run", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const disabled = "#!/bin/sh\necho switched off by removing the x bit\n";
  await script(hookFile(alice, "pre-commit"), disabled, 0o644);
  await mkdir(hookFile(alice, "post-merge"));

  const result = await install(alice);
  assert.deepEqual(result.changed, [".git/hooks/post-commit", ".git/hooks/post-checkout"]);
  assert.equal(await readFile(hookFile(alice, "pre-commit"), "utf8"), disabled);
  assert.equal(await modeOf(hookFile(alice, "pre-commit")), 0o644);
  const left = result.notes.find((note) => note.startsWith("huddle left 2 hooks alone")) ?? "";
  assert.match(left, /\.git\/hooks\/pre-commit is not executable, so git does not run it/);
  assert.match(left, /\.git\/hooks\/post-merge is not a regular file/);

  // Windows has no such bit: there the same file is a hook that runs.
  await rm(hookFile(alice, "post-merge"), { recursive: true });
  assert.deepEqual((await installGitHooks({ repoRoot: alice.dir, bundle: BUNDLE }, "win32")).changed, [".git/hooks/pre-commit", ".git/hooks/post-merge"]);
});

test("git install: when no hook can be installed it says why and changes nothing", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  for (const hook of GIT_HOOKS) await script(hookFile(alice, hook), "#!/usr/bin/env node\nconsole.log(1)\n");
  await assert.rejects(install(alice), (error: Error) => {
    assert.match(error.message, /^huddle left every hook alone: \.git\/hooks\/pre-commit is not a shell script/);
    assert.ok(error.message.endsWith(commandLine("post-commit", BUNDLE)));
    return true;
  });
  for (const hook of GIT_HOOKS) assert.equal(await readFile(hookFile(alice, hook), "utf8"), "#!/usr/bin/env node\nconsole.log(1)\n");
  const check = await checkGitHooks(alice.dir);
  assert.equal(check.installed, false);
  assert.match(check.detail, /^no huddle git hooks in \.git\/hooks \(pre-commit, post-commit, post-checkout, post-merge: not shell scripts huddle can add itself to\)/);

  // A bundle path that would need quoting is refused before anything is written.
  const bob = await b.h.clone("bob");
  const before = (await readdir(join(bob.dir, ".git/hooks"))).sort();
  for (const bundle of [".huddle/hud dle.mjs", ".huddle/$(id).mjs", '.huddle/a".mjs', ".huddle/a;b.mjs", ".huddle/a'b.mjs"]) {
    await assert.rejects(install(bob, bundle), /cannot be written into a shell command/);
  }
  await assert.rejects(install(bob, ""), /the bundle path is empty/);
  assert.deepEqual((await readdir(join(bob.dir, ".git/hooks"))).sort(), before);
});

test("git install: a hook manager that rewrites its files is pointed out", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await script(hookFile(alice, "pre-commit"), '#!/bin/sh\n\nif [ "$LEFTHOOK" = "0" ]; then\n  exit 0\nfi\n\ncall_lefthook run "pre-commit" "$@"\n');
  await script(hookFile(alice, "post-merge"), "#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\n# ID: 138fd403232d2ddd5efb44317e38bf03\nexec pre-commit hook-impl\n");
  const first = await install(alice);
  assert.equal(first.notes.length, 5);
  assert.match(first.notes[3] ?? "", /^lefthook rewrites the hook files it manages/);
  assert.match(first.notes[4] ?? "", /^pre-commit rewrites its hook file when `pre-commit install` runs/);
  // The reminder does not depend on huddle's own lines being new.
  assert.deepEqual(await install(alice), { changed: [], notes: first.notes, files: [] });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

test("git check: says what is missing, changed, switched off or pointing nowhere", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await b.h.clone("alice");
  assert.deepEqual(await checkGitHooks(alice.dir), { installed: false, detail: "no huddle git hooks in .git/hooks. Run huddle init.", notes: [] });

  await install(alice);
  // Never installed is one thing; there and not able to work is `broken`, which doctor warns about.
  assert.deepEqual(await checkGitHooks(alice.dir), {
    installed: false,
    broken: true,
    detail: "git hooks in .git/hooks run .huddle/huddle.mjs, which is not in this checkout. Run huddle init.",
    notes: [],
  });
  await withRecorder(alice);
  assert.equal((await checkGitHooks(alice.dir)).installed, true);

  await rm(hookFile(alice, "post-merge"));
  const edited = (await readFile(hookFile(alice, "pre-commit"), "utf8")).replace(" --no-renames", "");
  await writeFile(hookFile(alice, "pre-commit"), edited);
  assert.deepEqual(await checkGitHooks(alice.dir), {
    installed: false,
    broken: true,
    detail: "huddle git hooks in .git/hooks are missing for post-merge and not what this version installs for pre-commit. Run huddle init.",
    notes: [],
  });
  assert.deepEqual((await install(alice)).changed, [".git/hooks/pre-commit", ".git/hooks/post-merge"], "init repairs both");
  assert.equal((await checkGitHooks(alice.dir)).installed, true);

  await chmod(hookFile(alice, "post-commit"), 0o644);
  assert.deepEqual(await checkGitHooks(alice.dir), {
    installed: false,
    broken: true,
    detail: "git ignores the post-commit hook in .git/hooks: not executable. Run chmod +x on it.",
    notes: [],
  });
  assert.equal((await checkGitHooks(alice.dir, "win32")).installed, true, "no such bit on Windows");
  await chmod(hookFile(alice, "post-commit"), 0o755);

  // A block that ends the file without a line break is still the block.
  const file = hookFile(alice, "post-checkout");
  await writeFile(file, (await readFile(file, "utf8")).trimEnd());
  assert.equal((await checkGitHooks(alice.dir)).installed, true);
  assert.deepEqual((await install(alice)).changed, []);

  // One hook in another language: the other three count, and the fourth is named.
  await script(hookFile(alice, "pre-commit"), "#!/usr/bin/env python3\n");
  const mixed = await checkGitHooks(alice.dir);
  assert.equal(mixed.installed, true);
  assert.equal(mixed.detail, "3 git hooks in .git/hooks; pre-commit left alone");
  assert.equal(mixed.notes[2], NODE_NOTE);
  assert.match(mixed.notes[3] ?? "", /^The pre-commit hook in \.git\/hooks is not a shell script huddle can add itself to, so it was left alone\.$/);

  // Two whole blocks in one hook, as a merge kept by hand leaves them: huddle would run twice for every commit.
  await install(alice, BUNDLE);
  const twice = hookFile(alice, "post-commit");
  await writeFile(twice, `${await readFile(twice, "utf8")}${hookBlock("post-commit", BUNDLE, false)}`);
  assert.deepEqual(await checkGitHooks(alice.dir), {
    installed: false,
    broken: true,
    detail: "huddle git hooks in .git/hooks are not what this version installs for post-commit. Run huddle init.",
    notes: [],
  });
  assert.deepEqual((await install(alice)).changed, [".git/hooks/post-commit"], "init makes them one");
  assert.equal(await readFile(twice, "utf8"), `#!/bin/sh\n${hookBlock("post-commit", BUNDLE, true)}`);
});

test("git install: moving the bundle updates the one block in each hook", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await script(hookFile(alice, "pre-commit"), USER_HOOK);
  await install(alice);
  const moved = await install(alice, "tools/huddle.mjs");
  assert.deepEqual(moved.changed, GIT_HOOKS.map((hook) => `.git/hooks/${hook}`));
  assert.equal(await readFile(hookFile(alice, "pre-commit"), "utf8"), USER_HOOK.replace("#!/bin/sh\n", `#!/bin/sh\n${hookBlock("pre-commit", "tools/huddle.mjs", false)}`));
  assert.equal(await readFile(hookFile(alice, "post-commit"), "utf8"), `#!/bin/sh\n${hookBlock("post-commit", "tools/huddle.mjs", true)}`);
  assert.equal((await checkGitHooks(alice.dir)).detail, "git hooks in .git/hooks run tools/huddle.mjs, which is not in this checkout. Run huddle init.");
});

// ---------------------------------------------------------------------------
// core.hooksPath, husky, linked worktrees
// ---------------------------------------------------------------------------

test("git install: core.hooksPath inside the repository is where the hooks go, and git runs them there", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await alice.git("config", "core.hooksPath", ".githooks");
  const before = (await readdir(join(alice.dir, ".git/hooks"))).sort();

  const result = await install(alice);
  assert.deepEqual(result.changed, GIT_HOOKS.map((hook) => `.githooks/${hook}`));
  assert.deepEqual(result.notes, [
    "The git hooks are in .githooks, which is part of the working tree: commit them, and teammates whose git reads hooks from there get them too.",
    "The git hooks run .huddle/huddle.mjs from whatever is checked out, also right after a checkout or a merge. Checking out a branch you do not trust runs its copy.",
    NODE_NOTE,
  ]);
  // These are files the team commits: init names them, changed by this run or not.
  assert.deepEqual(result.files, GIT_HOOKS.map((hook) => `.githooks/${hook}`));
  assert.deepEqual((await readdir(join(alice.dir, ".git/hooks"))).sort(), before, "the directory git no longer reads is left alone");
  assert.deepEqual(await checkGitHooks(alice.dir), { installed: true, detail: "4 git hooks in .githooks", notes: result.notes });

  ok(await commitFile(b, alice, "a.txt"));
  assert.equal(b.records("pre-commit").length, 1);
  await b.settled("post-commit", 1);

  // The same directory named by its absolute path is still inside the repository.
  await alice.git("config", "core.hooksPath", join(alice.dir, ".githooks"));
  assert.deepEqual(await install(alice), { changed: [], notes: result.notes, files: GIT_HOOKS.map((hook) => `.githooks/${hook}`) });
});

test("git install: a hooks directory outside the repository is not huddle's to change", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const shared = join(b.h.root, "shared-hooks");
  await script(join(shared, "pre-commit"), "#!/bin/sh\necho for every repository of this user\n");
  await alice.git("config", "core.hooksPath", shared);

  await assert.rejects(install(alice), (error: Error) => {
    assert.equal(error.message, `core.hooksPath points outside this repository (${shared}), at hooks that may serve other repositories too, so huddle left them alone`);
    return true;
  });
  assert.deepEqual(await readdir(shared), ["pre-commit"]);
  assert.equal(await readFile(join(shared, "pre-commit"), "utf8"), "#!/bin/sh\necho for every repository of this user\n");
  const check = await checkGitHooks(alice.dir);
  assert.equal(check.installed, false);
  assert.match(check.detail, /^no git hooks: core\.hooksPath points outside this repository/);
  assert.deepEqual(await removeGitHooks(alice.dir), []);
  assert.equal(await gitHooks.detect(alice.dir), true, "init still asks, so that the reason is shown");

  // Through a link, too: the hooks directory inside .git is a link to the shared one.
  await alice.git("config", "--unset", "core.hooksPath");
  await rm(join(alice.dir, ".git/hooks"), { recursive: true });
  await symlink(shared, join(alice.dir, ".git/hooks"));
  await assert.rejects(install(alice), /points outside this repository/);
  assert.deepEqual(await readdir(shared), ["pre-commit"]);
});

/** What husky 9 puts in .husky/_ (index.js and the `husky` script of 9.1.7), cut down to what runs a hook. */
async function husky9(clone: Clone, dir = ".husky"): Promise<void> {
  await script(join(clone.dir, dir, "_/h"), 'n=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s" "$@"\nexit $?\n', 0o644);
  for (const hook of ["pre-commit", "commit-msg", "post-commit", "post-checkout", "post-merge", "pre-push"]) {
    await script(join(clone.dir, dir, "_", hook), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"');
  }
  await writeFile(join(clone.dir, dir, "_/.gitignore"), "*");
  await clone.git("config", "core.hooksPath", `${dir}/_`);
}

test("git install: with husky 9 the hooks go next to the team's own, not into the directory husky rewrites", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await husky9(alice);
  const marker = join(b.h.root, "marker");
  // A husky 9 hook is a list of commands: no shebang, not executable.
  await script(join(alice.dir, ".husky/pre-commit"), 'echo "husky ran" >> "$USER_MARKER"\n', 0o644);
  const generated = await readFile(join(alice.dir, ".husky/_/pre-commit"), "utf8");

  const result = await install(alice);
  assert.deepEqual(result.changed, GIT_HOOKS.map((hook) => `.husky/${hook}`));
  assert.match(result.notes[0] ?? "", /^The git hooks are in \.husky, which is part of the working tree: commit them/);
  assert.deepEqual(result.files, GIT_HOOKS.map((hook) => `.husky/${hook}`), "not the directory husky generates");
  assert.equal(await readFile(join(alice.dir, ".husky/_/pre-commit"), "utf8"), generated);
  assert.equal(await alice.read(".husky/pre-commit"), `${hookBlock("pre-commit", BUNDLE, false)}echo "husky ran" >> "$USER_MARKER"\n`);
  assert.equal(await modeOf(join(alice.dir, ".husky/pre-commit")), 0o644);
  assert.deepEqual(await checkGitHooks(alice.dir), { installed: true, detail: "4 git hooks in .husky", notes: result.notes });

  ok(await commitFile(b, alice, "a.txt", { USER_MARKER: marker }));
  assert.equal(await readFile(marker, "utf8"), "husky ran\n");
  assert.equal(b.records("pre-commit").length, 1);
  await b.settled("post-commit", 1);

  // husky runs hooks with `sh -e`: a missing bundle must not turn into a failed hook.
  await rm(join(alice.dir, BUNDLE));
  ok(await commitFile(b, alice, "b.txt", { USER_MARKER: marker }));
  assert.equal(await readFile(marker, "utf8"), "husky ran\nhusky ran\n");

  assert.deepEqual(await removeGitHooks(alice.dir), GIT_HOOKS.map((hook) => `.husky/${hook}`));
  assert.equal(await alice.read(".husky/pre-commit"), 'echo "husky ran" >> "$USER_MARKER"\n');
  assert.deepEqual((await readdir(join(alice.dir, ".husky"))).sort(), ["_", "pre-commit"]);
});

test("git install: husky 9 in a directory of another name is recognized by the runner it generates", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  await husky9(alice, "config/hooks");
  assert.deepEqual((await install(alice)).changed, GIT_HOOKS.map((hook) => `config/hooks/${hook}`));
  ok(await commitFile(b, alice, "a.txt"));
  assert.equal(b.records("pre-commit").length, 1);
  await b.settled("post-commit", 1);
});

test("git install: in a husky 8 hook the block goes below the line that runs the hook a second time", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await withRecorder(await b.h.clone("alice"));
  const marker = join(b.h.root, "marker");
  // husky.sh of 8.0.3, cut down to the part that matters here.
  await script(
    join(alice.dir, ".husky/_/husky.sh"),
    '#!/usr/bin/env sh\nif [ -z "$husky_skip_init" ]; then\n  readonly husky_skip_init=1\n  export husky_skip_init\n  sh -e "$0" "$@"\n  exit $?\nfi\n',
    0o644,
  );
  const hook = `#!/usr/bin/env sh\n${HUSKY_8_FIRST}\n\necho "husky ran" >> "$USER_MARKER"\n`;
  await script(join(alice.dir, ".husky/pre-commit"), hook);
  await alice.git("config", "core.hooksPath", ".husky");

  assert.deepEqual((await install(alice)).changed, GIT_HOOKS.map((name) => `.husky/${name}`));
  assert.equal(await alice.read(".husky/pre-commit"), hook.replace(`${HUSKY_8_FIRST}\n`, `${HUSKY_8_FIRST}\n${hookBlock("pre-commit", BUNDLE, false)}`));

  ok(await commitFile(b, alice, "a.txt", { USER_MARKER: marker }));
  assert.equal(await readFile(marker, "utf8"), "husky ran\n");
  assert.equal(b.records("pre-commit").length, 1, "once, not once per run of the script");
  await b.settled("post-commit", 1);
});

test("git install: a linked worktree shares the clone's hooks, and each worktree runs its own bundle", { skip: !POSIX }, async (t) => {
  const b = await bench(t);
  const alice = await b.h.clone("alice");
  const tree = await withRecorder(await alice.addWorktree("side tree", "side"));

  const result = await install(tree);
  assert.deepEqual(result.changed, GIT_HOOKS.map((hook) => join(alice.dir, ".git/hooks", hook)), "outside this worktree, so named in full");
  assert.deepEqual(result.files, [], "and not files anyone commits");
  assert.deepEqual(await checkGitHooks(tree.dir), { installed: true, detail: `4 git hooks in ${join(alice.dir, ".git/hooks")}`, notes: result.notes });
  assert.deepEqual((await install(alice)).changed, [], "the main checkout finds them in place");

  ok(await commitFile(b, tree, "in tree.txt"));
  assert.deepEqual(b.records("pre-commit"), [{ args: ["hook", "git", "pre-commit"], cwd: tree.dir, stdin: "in tree.txt\0", session: null }]);
  assert.equal((await b.settled("post-commit", 1))[0]?.cwd, tree.dir);

  // The main checkout is on a branch without the bundle: its commits go through, and huddle stays out.
  ok(await commitFile(b, alice, "in main.txt"));
  assert.equal(b.records().length, 2);
  assert.equal((await checkGitHooks(alice.dir)).detail, "git hooks in .git/hooks run .huddle/huddle.mjs, which is not in this checkout. Run huddle init.");
});

// ---------------------------------------------------------------------------
// detect and the registry
// ---------------------------------------------------------------------------

test("git adapter: registered, and on for every repository with a working tree", async (t) => {
  assert.equal(getAdapter("git"), gitHooks);
  assert.ok(ADAPTERS.includes(gitHooks));
  assert.equal(gitHooks.name, "git");
  assert.equal(gitHooks.title, "git hooks");

  const h = await createHarness(t);
  const alice = await h.clone("alice");
  assert.equal(await gitHooks.detect(alice.dir), true);
  assert.equal(await gitHooks.detect(h.remote), false, "a bare repository has no working tree to commit from");
  const nowhere = await realpath(await mkdtemp(join(tmpdir(), "huddle-nowhere-")));
  t.after(() => rm(nowhere, { recursive: true, force: true }));
  assert.equal(await gitHooks.detect(nowhere), false);
  await assert.rejects(gitHooks.install({ repoRoot: nowhere, bundle: BUNDLE }), /this is not a git repository with a working tree/);
  assert.deepEqual(await gitHooks.check(nowhere), { installed: false, detail: "no git hooks: this is not a git repository with a working tree", notes: [] });
});
