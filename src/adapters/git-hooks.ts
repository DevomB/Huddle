// T3.2. Plain git hooks: the floor under every agent, and under people who use
// none. A commit, a checkout or a merge shows teammates that this clone is
// alive and what it has in flight, and a commit that touches files a teammate
// is working on says so in the terminal.
//
//   git hook        huddle event   what the hook line does
//   pre-commit      pre-edit       pipes the staged paths to huddle and waits for it
//   post-commit     post-edit      starts huddle in the background and returns
//   post-checkout   post-edit      same
//   post-merge      post-edit      same
//
// The post hooks are post-edit (a heartbeat and a throttled sync) and not
// turn-end (a sync that is never skipped) on purpose: rebase and bisect run
// these hooks in bursts, and a forced sync per run would pile up processes.
//
// pre-commit says nothing while a merge is being concluded: what is staged
// then is mostly the other branch's work, not this clone's.
//
// Where the hooks go: the directory git itself reads them from, which
// `git rev-parse --git-path hooks` names and core.hooksPath can move. Three
// cases:
// - <git-common-dir>/hooks, the default. Not committed, shared by every
//   worktree of the clone: each teammate gets it by running
//   `huddle init --agent git`, which installs these and nothing else.
// - A directory inside the worktree (a team's own .githooks, husky 8's
//   .husky). Those files are the team's to commit.
// - .husky/_, which husky 9 generates and rewrites. The hooks a team writes
//   live one level up, in .husky/<name>, and that is where huddle's go.
// A hooks directory outside the repository (one shared by all of a user's
// repositories) is left alone.
//
// Living with hooks that are already there. Nothing is replaced, renamed or
// wrapped. huddle adds three lines to a hook, between two marker comments, and
// those three lines are all it ever changes or removes:
// - No file: huddle creates it, with nothing in it but "#!/bin/sh" and the block.
// - A shell script: the block goes right after the "#!" line, so that it runs
//   however the rest of the script ends (`exec`, `exit`).
// - Anything else (another language, a binary, a symbolic link, a file git
//   ignores because it is not executable): huddle leaves it alone and says so.
// The line itself cannot fail and cannot hold git up: every step is guarded,
// it ends in "|| :", and the post hooks start node in the background. So it is
// safe under `set -e`, which husky uses.
//
// What the line runs is the bundle in the checkout, the same file the agent
// hooks run. Unlike those it runs on plain git commands: after `git checkout`
// of someone's branch, post-checkout runs that branch's copy. husky, lefthook
// and pre-commit work the same way, but a clone that had none of them did not,
// so install() and check() say it in a note.
//
// Other hook managers, read from their sources on 2026-11-12:
// - husky 9.1.7: .husky/_/<hook> runs .husky/<hook> with `sh -e` when that
//   file exists, whatever its mode.
// - husky 8.0.3: core.hooksPath is .husky, and a hook starts by sourcing
//   _/husky.sh, which runs the whole hook a second time and exits. Lines above
//   that line run twice, so the block goes below it.
// - lefthook: deletes and rewrites the hook files it recognizes as its own (by
//   the word LEFTHOOK in them) on `lefthook install`, and by itself when its
//   configuration changes. huddle's lines in such a file go with it.
// - pre-commit: `pre-commit install` rewrites the hook file it recognizes as
//   its own, the same way.

import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cleanText, LIMITS } from "../core/docs.ts";
import { git } from "../core/git.ts";
import { manualSessionId } from "../core/identity.ts";
import { locateRepo, pathsFor } from "../core/paths.ts";
import { bundlePath, exists } from "./json-hooks.ts";
import { SILENT } from "./types.ts";
import type { Adapter, CheckResult, HookEvent, HookInput, HookOutcome, HookOutput, InstallOptions, InstallResult } from "./types.ts";

const NAME = "git";

const POST_HOOKS = ["post-commit", "post-checkout", "post-merge"] as const;
/** The hooks huddle uses, in the order they are reported. */
export const GIT_HOOKS = ["pre-commit", ...POST_HOOKS] as const;
export type GitHook = (typeof GIT_HOOKS)[number];

function isGitHook(value: unknown): value is GitHook {
  return typeof value === "string" && (GIT_HOOKS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// parse: `huddle hook git <hook>` -> a normalized event
// ---------------------------------------------------------------------------

/** More staged paths than this are not passed on; the engine has its own, lower limit on how many it checks. */
export const MAX_STAGED_PATHS = 2000;

/**
 * What the pre-commit line pipes in: the output of
 * `git diff --cached --name-only --no-renames -z`, paths relative to the top
 * of the worktree with a NUL after each. One path per line is read too, for a
 * hook someone wrote by hand.
 */
function stagedPaths(stdin: string): string[] {
  const separator = stdin.includes("\0") ? "\0" : "\n";
  const paths = new Set<string>();
  for (const raw of stdin.split(separator)) {
    const path = separator === "\n" ? raw.replace(/\r$/, "") : raw;
    if (path === "") continue;
    paths.add(path);
    if (paths.size === MAX_STAGED_PATHS) break;
  }
  return [...paths];
}

/**
 * A git hook has no session of its own, so the event is marked `ambient`: the
 * engine picks the session the way CLI commands do, and treats the event as a
 * sign of life that never renames, moves or ends that session. The id given
 * here says the same thing for a reader of the event alone: HUDDLE_SESSION
 * when an agent's shell ran git, otherwise the worktree's manual session.
 */
function parseHook(input: HookInput): HookEvent | null {
  const hook = input.args[0];
  if (!isGitHook(hook)) return null;
  // git runs a hook from the top of the worktree.
  const cwd = input.cwd;
  if (typeof cwd !== "string" || cwd === "") return null;

  const fromAgent = cleanText(input.env.HUDDLE_SESSION, LIMITS.sessionId);
  const event: HookEvent = {
    type: hook === "pre-commit" ? "pre-edit" : "post-edit",
    agent: NAME,
    sessionId: fromAgent || manualSessionId(pathsFor(cwd, cwd, cwd), {}),
    cwd,
    ambient: true,
    native: { hook },
  };
  // The session is the agent's: this event keeps it alive and must not relabel or move it.
  if (fromAgent !== "") event.subagent = true;

  if (hook === "pre-commit") {
    const paths = stagedPaths(typeof input.stdin === "string" ? input.stdin : "");
    if (paths.length === 0) return null; // nothing staged that huddle could check
    event.paths = paths;
  }
  return event;
}

function parse(input: HookInput): HookEvent | null {
  try {
    return parseHook(input);
  } catch {
    return null; // nothing huddle can use
  }
}

// ---------------------------------------------------------------------------
// format: the engine's outcome -> what the hook prints
// ---------------------------------------------------------------------------

const NOT_BLOCKED = "[huddle] The commit goes ahead. This is only a heads-up.";

/** An overlap warning goes to the terminal on stderr. Always exit code 0: huddle never stops a commit. */
function format(event: HookEvent, outcome: HookOutcome): HookOutput {
  if (event.type !== "pre-edit") return SILENT; // the post hooks run in the background with no terminal
  const context = typeof outcome.context === "string" ? outcome.context.trim() : "";
  if (context === "") return SILENT;
  return { stdout: "", stderr: `${context}\n${NOT_BLOCKED}\n`, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// The lines huddle adds to a hook
// ---------------------------------------------------------------------------

const BEGIN = "# >>> huddle >>>";
const END = "# <<< huddle <<<";
const ADDED = `${BEGIN} Shows teammates what this clone is working on. Never blocks git. Added by "huddle init": delete these three lines to remove it.`;
const CREATED = `${BEGIN} Shows teammates what this clone is working on. Never blocks git. "huddle init" created this file: delete it to remove this.`;
/** What a file holds besides the block when huddle created it. */
const OWN_FILE = "#!/bin/sh\n";

/** The bundle path goes into a shell command, so it is written only when every character is inert in a shell. */
const SHELL_INERT = /^[A-Za-z0-9._/-]+$/;

/**
 * The one line that does the work. Each step guards the next: the repository
 * root is known, the bundle is there (a worktree on a branch from before
 * `huddle init` has none), and node exists. "|| :" turns any failure into
 * success, so the line is safe under `set -e` and never changes the hook's
 * exit code.
 *
 * pre-commit asks git for the staged paths here, in the hook's own
 * environment: for `git commit -a` and `git commit <paths>` git points
 * GIT_INDEX_FILE at the index of this commit, and only a git started from the
 * hook sees it. --no-renames lists a renamed file under both names.
 *
 * The post hooks give node no terminal and do not wait for it.
 */
export function commandLine(hook: GitHook, bundle: string): string {
  const ready = `huddle_root="$(git rev-parse --show-toplevel 2>/dev/null)" && test -f "$huddle_root/${bundle}" && command -v node >/dev/null 2>&1`;
  const run = `node "$huddle_root/${bundle}" hook ${NAME} ${hook}`;
  if (hook === "pre-commit") {
    return `${ready} && ! git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && git diff --cached --name-only --no-renames -z 2>/dev/null | ${run} || :`;
  }
  return `${ready} && (${run} </dev/null >/dev/null 2>&1 &) || :`;
}

/** The three lines for one hook. `created` says the file is huddle's own. */
export function hookBlock(hook: GitHook, bundle: string, created: boolean): string {
  return `${created ? CREATED : ADDED}\n${commandLine(hook, bundle)}\n${END}\n`;
}

/**
 * Huddle's block: the BEGIN line, one line that runs `hook git`, the END line,
 * and the line break after it when there is one. Exactly those three lines,
 * because that is all huddle ever writes. A BEGIN or END line that is not
 * part of such a triple (the other two deleted by hand, a merge of a committed
 * hook resolved by hand) is the user's text, and so are the lines next to it:
 * matching from a BEGIN to the next END, whatever lay between, would take
 * those lines out.
 */
const BLOCK = /^# >>> huddle >>>[^\n]*\n[^\n]*\bhook git [^\n]*\n# <<< huddle <<<\r?(?:\n|$)/m;

interface Split {
  before: string;
  block: string;
  after: string;
}

function splitBlock(text: string): Split | null {
  const found = BLOCK.exec(text);
  if (found === null) return null;
  return { before: text.slice(0, found.index), block: found[0], after: text.slice(found.index + found[0].length) };
}

/**
 * `text` with every block taken out. Used on what follows the first block: a
 * second one is a leftover (two branches that each got a block, merged with
 * both kept) and would run huddle twice for every commit.
 */
function withoutMore(text: string): string {
  let rest = text;
  for (let split = splitBlock(rest); split !== null; split = splitBlock(rest)) rest = split.before + split.after;
  return rest;
}

/** husky 8's first line of every hook. It runs the hook a second time, so whatever is above it runs twice. */
const HUSKY_8_LINE = /^[ \t]*(?:\.|source)[ \t]+\S[^\n]*\/_\/husky\.sh"?[ \t]*\r?(?:\n|$)/m;

/** Where the block goes in a script that has none: after husky 8's line, or else after the "#!" line, or else first. */
function insertionPoint(text: string): number {
  const husky = HUSKY_8_LINE.exec(text);
  if (husky !== null) return husky.index + husky[0].length;
  if (!text.startsWith("#!")) return 0;
  const lineEnd = text.indexOf("\n");
  return lineEnd === -1 ? text.length : lineEnd + 1;
}

/**
 * `text` with huddle's block in it: in place of the block that is there, or
 * at insertionPoint(). withoutBlock() undoes it exactly.
 */
export function withBlock(text: string, block: string): string {
  const split = splitBlock(text);
  if (split !== null) return split.before + (split.block.endsWith("\n") ? block : block.slice(0, -1)) + withoutMore(split.after);
  const at = insertionPoint(text);
  // After a last line that has no line break: the break that separates that
  // line from the block is the block's, and the block gives up its own.
  if (at === text.length && text !== "" && !text.endsWith("\n")) return `${text}\n${block.slice(0, -1)}`;
  return text.slice(0, at) + block + text.slice(at);
}

/** `text` with huddle's block taken out again: what the file held before withBlock(). */
export function withoutBlock(text: string): string {
  const split = splitBlock(text);
  if (split === null) return text;
  if (!split.block.endsWith("\n") && split.before.endsWith("\n")) return split.before.slice(0, -1) + split.after;
  return split.before + withoutMore(split.after);
}

/** Does the text hold more than one block? */
function hasSecondBlock(text: string): boolean {
  const split = splitBlock(text);
  return split !== null && splitBlock(split.after) !== null;
}

/** The bundle a block runs, read back out of its command line. */
function bundleOf(block: string): string | null {
  return /test -f "\$huddle_root\/([A-Za-z0-9._/-]+)"/.exec(block)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Where the hooks live
// ---------------------------------------------------------------------------

interface Place {
  /** The top of the worktree, symbolic links resolved. */
  root: string;
  /** The directory huddle's hooks go into. */
  dir: string;
  /** For messages: relative to the worktree when it is inside it, absolute otherwise. */
  shown: string;
  /** Inside the worktree: the files can be committed. */
  inWorktree: boolean;
  /** husky 9 runs these files with `sh -e`, whatever their mode. */
  husky: boolean;
}

/** `path` with symbolic links resolved, as far as it exists. */
async function real(path: string): Promise<string> {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function shownPath(root: string, path: string): string {
  return path !== root && isInside(path, root) ? relative(root, path).split(sep).join("/") : path;
}

/** The place, or a sentence saying why huddle will not put hooks anywhere here. */
async function findPlace(repoRoot: string): Promise<Place | string> {
  const paths = await locateRepo(repoRoot);
  if (paths === null) return "this is not a git repository with a working tree";
  // A relative core.hooksPath is relative to where hooks run: the top of the worktree.
  const asked = await git(["rev-parse", "--git-path", "hooks"], { cwd: paths.worktree });
  const answer = asked.ok ? asked.stdout.replace(/\r?\n$/, "") : "";
  if (answer === "") return "git did not say where this repository keeps its hooks";

  const [root, common] = await Promise.all([real(paths.worktree), real(paths.commonDir)]);
  let dir = await real(resolve(paths.worktree, answer));
  let husky = false;
  if (basename(dir) === "_" && (basename(dirname(dir)) === ".husky" || (await exists(join(dir, "h"))))) {
    dir = dirname(dir);
    husky = true;
  }
  const inWorktree = isInside(dir, root) && !isInside(dir, common);
  if (!inWorktree && !isInside(dir, common)) {
    return `core.hooksPath points outside this repository (${dir}), at hooks that may serve other repositories too, so huddle left them alone`;
  }
  return { root, dir, shown: shownPath(root, dir), inWorktree, husky };
}

// ---------------------------------------------------------------------------
// One hook file
// ---------------------------------------------------------------------------

/** A hand-written hook is a few lines. Anything this large is not one. */
const MAX_HOOK_BYTES = 1024 * 1024;

type Standing =
  | { kind: "absent" }
  /** A script huddle can add its block to, or has. `block` is the one in it now. */
  | { kind: "script"; text: string; block: string | null; executable: boolean }
  /** Not huddle's to touch: `why` finishes the sentence "<file> ...". */
  | { kind: "foreign"; why: string };

/** The interpreters whose scripts the block can sit in: it is written in the language they share. */
const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:sh|bash|dash|ash|ksh|zsh)(?:\s|$)/;

async function standingOf(file: string, place: Place, platform: NodeJS.Platform): Promise<Standing> {
  let bytes: Buffer;
  let mode: number;
  try {
    const found = await lstat(file);
    // Writing through a link would change a file somewhere else, which may be shared by several hooks or several repositories.
    if (found.isSymbolicLink()) return { kind: "foreign", why: "is a symbolic link, and huddle does not change the file it points to" };
    if (!found.isFile()) return { kind: "foreign", why: "is not a regular file" };
    if (found.size > MAX_HOOK_BYTES) return { kind: "foreign", why: "is too large to be a script written by hand" };
    mode = found.mode;
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  let text: string;
  try {
    if (bytes.includes(0)) throw new Error("binary");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "foreign", why: "is not a text file" };
  }
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (firstLine.startsWith("#!") && !SHELL_SHEBANG.test(firstLine)) {
    return { kind: "foreign", why: `is not a shell script (it starts with ${JSON.stringify(firstLine.trim().slice(0, 60))})` };
  }
  // Without the bit git skips the file (and says so), except on Windows, which
  // has no such bit, and under husky 9, which hands the file to sh itself.
  const executable = platform === "win32" || place.husky || (mode & 0o111) !== 0;
  return { kind: "script", text, block: splitBlock(text)?.block ?? null, executable };
}

/** All or nothing, keeping the mode of a file that exists. */
async function writeHook(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const mode = await stat(file).then(
    (found) => found.mode & 0o777,
    () => 0o755,
  );
  const temporary = `${file}.huddle-${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, "utf8");
    await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// install, remove, check, detect
// ---------------------------------------------------------------------------

/** The hooks do nothing without node, and say nothing: so init and doctor say it. */
const NODE_NOTE =
  "The git hooks need node on the PATH of whatever runs git. A graphical git client or an editor's source control panel may not have it there (nvm, fnm and volta set it up in the shell). The hooks then do nothing and say nothing, and commits made there do not reach teammates.";

const PER_CLONE_NOTE =
  "Git hooks are not committed: each teammate runs huddle init --agent git once in their own clone to get them. That installs the git hooks and nothing else; a plain huddle init would also set up every other agent it finds on their machine, in files the whole team shares. The git hooks cover commits, checkouts and merges made without an agent.";

/**
 * Said once per install and by doctor, because it is new to a clone that had
 * no hook manager: before, checking out a branch ran nothing.
 */
const RUNS_CHECKOUT_NOTE = (bundle: string): string =>
  `The git hooks run ${bundle} from whatever is checked out, also right after a checkout or a merge. Checking out a branch you do not trust runs its copy.`;

function committedNote(place: Place): string {
  return `The git hooks are in ${place.shown}, which is part of the working tree: commit them, and teammates whose git reads hooks from there get them too.`;
}

const REWRITERS: ReadonlyArray<{ sign: RegExp; note: string }> = [
  {
    sign: /LEFTHOOK/,
    note: "lefthook rewrites the hook files it manages (on `lefthook install`, and by itself when its configuration changes), which removes huddle's lines from them. If huddle doctor reports git hooks missing, run huddle init --agent git again.",
  },
  {
    sign: /generated by pre-commit/i,
    note: "pre-commit rewrites its hook file when `pre-commit install` runs, which removes huddle's lines from it. If huddle doctor reports git hooks missing, run huddle init --agent git again.",
  },
];

function byHand(bundle: string): string {
  return `To add huddle there by hand, have the hook run a line like this one (for post-commit): ${commandLine("post-commit", bundle)}`;
}

/**
 * install(), with the platform passed in for tests. Throws when no hook could
 * be installed at all, with the reason: `huddle init` reports it as a note.
 */
export async function installGitHooks(opts: InstallOptions, platform: NodeJS.Platform = process.platform): Promise<InstallResult> {
  const bundle = bundlePath(opts.bundle);
  if (!SHELL_INERT.test(bundle)) {
    throw new TypeError(`the bundle path ${JSON.stringify(bundle)} cannot be written into a shell command (letters, digits, ".", "_", "-" and "/" only)`);
  }
  const place = await findPlace(opts.repoRoot);
  if (typeof place === "string") throw new Error(place);

  // Look at all four before writing any.
  const plans: Array<{ hook: GitHook; file: string; shown: string; standing: Standing }> = [];
  for (const hook of GIT_HOOKS) {
    const file = join(place.dir, hook);
    plans.push({ hook, file, shown: shownPath(place.root, file), standing: await standingOf(file, place, platform) });
  }
  const left: string[] = [];
  for (const { shown, standing } of plans) {
    if (standing.kind === "foreign") left.push(`${shown} ${standing.why}`);
    else if (standing.kind === "script" && !standing.executable) left.push(`${shown} is not executable, so git does not run it`);
  }
  if (left.length === plans.length) throw new Error(`huddle left every hook alone: ${left.join("; ")}. ${byHand(bundle)}`);

  const changed: string[] = [];
  const notes: string[] = [];
  /** The files that hold huddle's lines when this is done. */
  const holding: string[] = [];
  for (const { hook, file, shown, standing } of plans) {
    if (standing.kind === "absent") {
      await writeHook(file, OWN_FILE + hookBlock(hook, bundle, true));
      changed.push(shown);
      holding.push(shown);
      continue;
    }
    if (standing.kind !== "script" || !standing.executable) continue;
    holding.push(shown);
    for (const rewriter of REWRITERS) {
      if (rewriter.sign.test(withoutBlock(standing.text)) && !notes.includes(rewriter.note)) notes.push(rewriter.note);
    }
    // A block that says huddle created the file keeps saying so.
    const created = standing.block !== null && standing.block.startsWith(CREATED);
    const wanted = withBlock(standing.text, hookBlock(hook, bundle, created));
    if (wanted === standing.text) continue;
    await writeHook(file, wanted);
    changed.push(shown);
  }

  notes.unshift(place.inWorktree ? committedNote(place) : PER_CLONE_NOTE, RUNS_CHECKOUT_NOTE(bundle), NODE_NOTE);
  if (left.length > 0) notes.push(`huddle left ${left.length === 1 ? "one hook" : `${left.length} hooks`} alone: ${left.join("; ")}. ${byHand(bundle)}`);
  // Hooks under .git are nobody's to commit.
  return { changed, notes, files: place.inWorktree ? holding : [] };
}

/**
 * Takes huddle's lines out of every hook again and returns the files that
 * changed. A file huddle created, and that holds nothing else, is deleted; a
 * hook that was there before is left exactly as it was.
 */
export async function removeGitHooks(repoRoot: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const place = await findPlace(repoRoot);
  if (typeof place === "string") return [];
  const changed: string[] = [];
  for (const hook of GIT_HOOKS) {
    const file = join(place.dir, hook);
    const standing = await standingOf(file, place, platform);
    if (standing.kind !== "script" || standing.block === null) continue;
    const rest = withoutBlock(standing.text);
    if (standing.block.startsWith(CREATED) && rest.trim() === OWN_FILE.trim()) await rm(file, { force: true });
    else await writeHook(file, rest);
    changed.push(shownPath(place.root, file));
  }
  return changed;
}

/** check(), with the platform passed in for tests. */
export async function checkGitHooks(repoRoot: string, platform: NodeJS.Platform = process.platform): Promise<CheckResult> {
  const place = await findPlace(repoRoot);
  if (typeof place === "string") return { installed: false, detail: `no git hooks: ${place}`, notes: [] };

  const missing: string[] = [];
  const differs: string[] = [];
  const ignored: string[] = [];
  const foreign: string[] = [];
  const strays = new Set<string>();
  const bundles = new Set<string>();
  for (const hook of GIT_HOOKS) {
    const standing = await standingOf(join(place.dir, hook), place, platform);
    if (standing.kind === "foreign") foreign.push(hook);
    else if (standing.kind === "absent" || standing.block === null) missing.push(hook);
    else if (!standing.executable) ignored.push(hook);
    else {
      const bundle = bundleOf(standing.block);
      const created = standing.block.startsWith(CREATED);
      // The block at the very end of a file may have lost its last line break.
      if (bundle === null || standing.block.trimEnd() !== hookBlock(hook, bundle, created).trimEnd() || hasSecondBlock(standing.text)) differs.push(hook);
      else if (!(await exists(join(place.root, bundle)))) strays.add(bundle);
      else bundles.add(bundle);
    }
  }

  const found = GIT_HOOKS.length - missing.length - foreign.length;
  if (found === 0) {
    const why = foreign.length === 0 ? "" : ` (${foreign.join(", ")}: not ${foreign.length === 1 ? "a shell script" : "shell scripts"} huddle can add itself to)`;
    return { installed: false, detail: `no huddle git hooks in ${place.shown}${why}. Run huddle init --agent git.`, notes: [] };
  }
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing for ${missing.join(", ")}`);
  if (differs.length > 0) problems.push(`not what this version installs for ${differs.join(", ")}`);
  if (problems.length > 0) return { installed: false, broken: true, detail: `huddle git hooks in ${place.shown} are ${problems.join(" and ")}. Run huddle init --agent git.`, notes: [] };
  if (ignored.length > 0) {
    const one = ignored.length === 1;
    return { installed: false, broken: true, detail: `git ignores the ${ignored.join(", ")} ${one ? "hook" : "hooks"} in ${place.shown}: not executable. Run chmod +x on ${one ? "it" : "them"}.`, notes: [] };
  }
  if (strays.size > 0) {
    return { installed: false, broken: true, detail: `git hooks in ${place.shown} run ${[...strays].join(", ")}, which is not in this checkout. Run huddle init --agent git.`, notes: [] };
  }
  const notes = [place.inWorktree ? committedNote(place) : PER_CLONE_NOTE, ...[...bundles].map(RUNS_CHECKOUT_NOTE), NODE_NOTE];
  const count = `${found} git ${found === 1 ? "hook" : "hooks"} in ${place.shown}`;
  // The hooks that hold huddle's lines, where they are the team's to commit (.husky and the like). Hooks under .git are nobody's.
  const files = place.inWorktree ? GIT_HOOKS.filter((hook) => !foreign.includes(hook)).map((hook) => shownPath(place.root, join(place.dir, hook))) : [];
  if (foreign.length === 0) return { installed: true, detail: count, notes, files };
  const one = foreign.length === 1;
  notes.push(`The ${foreign.join(", ")} ${one ? "hook" : "hooks"} in ${place.shown} ${one ? "is not a shell script" : "are not shell scripts"} huddle can add itself to, so ${one ? "it was" : "they were"} left alone.`);
  return { installed: true, detail: `${count}; ${foreign.join(", ")} left alone`, notes, files };
}

/**
 * Never by itself: the git hooks are an option someone asks for, with
 * `huddle init --agent git` (or --all). Every repository has git, so
 * detecting it would put these hooks into every clone that runs a plain
 * `huddle init`, next to the hooks of the agent that clone really uses.
 */
async function detect(_repoRoot: string): Promise<boolean> {
  return false;
}

export const gitHooks: Adapter = {
  name: NAME,
  title: "git hooks",
  detect,
  install: (opts) => installGitHooks(opts),
  check: (repoRoot) => checkGitHooks(repoRoot),
  parse,
  format,
};
