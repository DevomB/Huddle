// T2.3. huddle init: one teammate runs this once; everyone else only pulls.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { installAgentsMd } from "../adapters/agents-md.ts";
import { ADAPTERS, getAdapter } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import { parse } from "../core/args.ts";
import { git } from "../core/git.ts";
import { CliError, EXIT, NotImplementedError, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { loadConfigReport, mergeConfig, requireRepo } from "../core/paths.ts";
import type { RepoPaths } from "../core/paths.ts";
import { DEFAULT_CONFIG } from "../core/types.ts";

export const summary = "Set this repo up for huddle: vendor the bundle, write config, install agent hooks";

const USAGE = "huddle init [--agent <name>]... [--all] [--remote <name>] [--no-capture-intent] [--downgrade]";

/** Repo-relative, forward slashes: what hook configs and AGENTS.md refer to. */
export const BUNDLE = ".huddle/huddle.mjs";
const CONFIG = ".huddle/config.json";
const ATTRIBUTES = ".huddle/.gitattributes";
const AGENTS_MD = "AGENTS.md";

/**
 * The first two lines of a built bundle (scripts/build.mjs). init refuses to
 * vendor anything else. A checkout that converted line endings still counts:
 * node runs that file just the same.
 */
const BUNDLE_BANNER = /^#!\/usr\/bin\/env node\r?\n\/\/ git-huddle (\S+)/;

export function bundleVersion(text: string): string | null {
  return BUNDLE_BANNER.exec(text)?.[1] ?? null;
}

/**
 * The attributes of the vendored bundle. `-text`: git never converts its line
 * endings, so every checkout holds the same bytes (Git for Windows converts
 * text files by default). `linguist-vendored`: it stays out of the language
 * statistics on GitHub, and its diff stays visible in a pull request, which
 * matters because hooks execute this file.
 */
const ATTRIBUTES_LINE = "huddle.mjs -text linguist-vendored";
const ATTRIBUTES_FILE = `# huddle.mjs is run by hooks: keep its bytes as they are, and keep its diff visible in review.\n${ATTRIBUTES_LINE}\n`;

/** The file's text, or null when there is no such file. Any other failure is an error: the file is there and must not be replaced blindly. */
async function readText(file: string, shown: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new CliError(`${shown} could not be read (${code ?? (error instanceof Error ? error.message : String(error))}); nothing was changed`);
  }
}

/** All or nothing: a hook that starts while init runs sees the old file or the new one, never half of one. */
async function writeWhole(file: string, text: string, mode?: number): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text);
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * -1, 0 or 1 for two versions of the form x.y.z or x.y.z-pre, null when
 * either is something else. A pre-release comes before its release.
 */
export function compareVersions(a: string, b: string): number | null {
  const read = (version: string) => {
    const found = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    return found ? { numbers: [Number(found[1]), Number(found[2]), Number(found[3])], pre: found[4] ?? null } : null;
  };
  const [x, y] = [read(a), read(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.numbers[i]! !== y.numbers[i]!) return x.numbers[i]! < y.numbers[i]! ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const order = x.pre.localeCompare(y.pre, "en", { numeric: true });
  return order === 0 ? 0 : order < 0 ? -1 : 1;
}

interface BundlePlan {
  /** The text to write, or null when the vendored copy is already right. */
  text: string | null;
  /** The line for "Files written". */
  line: string;
}

/** What to do about the vendored bundle. Reads only; throws when init must not go on. */
async function planBundle(paths: RepoPaths, io: Io, allowDowngrade: boolean): Promise<BundlePlan> {
  const running = io.self ? await readFile(io.self, "utf8").catch(() => null) : null;
  const version = running === null ? null : bundleVersion(running);
  if (running === null || version === null) {
    throw new CliError(`huddle init must be run from the built bundle (dist/huddle.mjs or ${BUNDLE}), not from ${io.self || "an unknown script"}`);
  }
  if (resolve(io.self) === paths.bundleFile) return { text: null, line: "" }; // running the vendored copy itself
  const existing = await readText(paths.bundleFile, BUNDLE);
  if (existing === running) return { text: null, line: "" };
  if (existing === null) return { text: running, line: `${BUNDLE} (huddle ${version})` };

  const previous = bundleVersion(existing);
  // One teammate with an old install must not roll the whole team back by running init.
  if (previous !== null && compareVersions(previous, version) === 1 && !allowDowngrade) {
    throw new CliError(
      `${BUNDLE} is huddle ${previous}, which is newer than the huddle ${version} you are running. Nothing was changed. ` +
        `Use the copy in the repository (node ${BUNDLE} init), or pass --downgrade to replace it with ${version}.`,
    );
  }
  return { text: running, line: `${BUNDLE} (huddle ${previous ?? "unknown"} -> ${version})` };
}

/** .huddle/.gitattributes with the bundle's line in it. Lines for other files are kept. Returns whether the file changed. */
async function ensureAttributes(file: string): Promise<boolean> {
  const existing = await readText(file, ATTRIBUTES);
  if (existing === null) {
    await writeWhole(file, ATTRIBUTES_FILE);
    return true;
  }
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const at = lines.findIndex((line) => /^huddle\.mjs\s/.test(line));
  if (at !== -1 && lines[at]!.trim() === ATTRIBUTES_LINE) return false;
  if (at !== -1) lines[at] = ATTRIBUTES_LINE;
  else {
    if (lines[lines.length - 1] === "") lines.pop();
    lines.push(ATTRIBUTES_LINE, "");
  }
  await writeWhole(file, lines.join(eol));
  return true;
}

function chooseAdapters(names: string[], all: boolean): Adapter[] | null {
  if (all) return [...ADAPTERS];
  if (names.length === 0) return null; // detect
  return names.map((name) => {
    const adapter = getAdapter(name);
    if (!adapter) throw new UsageError(`unknown agent "${name}". Known: ${ADAPTERS.map((a) => a.name).join(", ")}`);
    return adapter;
  });
}

/** A word for a shell command line: as it is when every character is inert, in single quotes otherwise. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A path that can be committed from this worktree: relative, inside it, and not in the git directory. */
function committable(path: string): boolean {
  if (path === "" || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split(/[\\/]/);
  return !parts.includes("..") && parts[0] !== ".git";
}

/** Of `files`, the ones git reports as new or changed. Exact paths: a directory would take in files that are not huddle's. */
async function uncommitted(repoRoot: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const status = await git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...files], { cwd: repoRoot });
  if (!status.ok) return [];
  const dirty = new Set<string>();
  const entries = status.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    dirty.add(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files.filter((file) => dirty.has(file));
}

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      agent: { type: "string", multiple: true, default: [] },
      all: { type: "boolean", default: false },
      remote: { type: "string" },
      "no-capture-intent": { type: "boolean", default: false },
      downgrade: { type: "boolean", default: false },
    },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);

  // Everything that can be refused is checked before the first file is written.
  const requested: Record<string, unknown> = {};
  if (values.remote !== undefined) {
    if (mergeConfig({ remote: values.remote }).remote !== values.remote) {
      throw new UsageError(`"${values.remote}" is not a remote name. Use the name of a configured git remote, such as origin.`);
    }
    requested.remote = values.remote;
  }
  if (values["no-capture-intent"]) requested.captureIntent = false;
  const named = values.all !== true && (values.agent ?? []).length > 0;
  const chosen = chooseAdapters(values.agent ?? [], values.all === true);

  const paths = await requireRepo(io.cwd);
  const repoRoot = paths.worktree;
  const changed: string[] = [];
  const notes: string[] = [];
  /** What was asked for and did not happen. Any entry makes the exit code 1. */
  const failures: string[] = [];
  /** The files the team commits, changed by this run or not. A file huddle could not set up is not one of them. */
  const teamFiles = new Set<string>([BUNDLE, CONFIG, ATTRIBUTES]);

  const plan = await planBundle(paths, io, values.downgrade === true);
  const existingConfig = await readText(paths.teamConfigFile, CONFIG);
  let currentConfig: Record<string, unknown> | null = null;
  if (existingConfig !== null && Object.keys(requested).length > 0) {
    try {
      const parsed: unknown = JSON.parse(existingConfig);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      currentConfig = parsed as Record<string, unknown>;
    } catch {
      throw new CliError(`${CONFIG} is not a JSON object; fix or delete it and run init again`);
    }
  }

  // 1. The bundle. Vendoring it pins the whole team to one protocol version.
  await mkdir(paths.teamDir, { recursive: true });
  if (plan.text !== null) {
    await writeWhole(paths.bundleFile, plan.text, 0o755);
    changed.push(plan.line);
  }
  if (await ensureAttributes(resolve(repoRoot, ATTRIBUTES))) changed.push(ATTRIBUTES);

  // 2. Team config. Written once with every default spelled out; afterwards only the keys asked for change.
  if (existingConfig === null) {
    await writeWhole(paths.teamConfigFile, JSON.stringify(mergeConfig(DEFAULT_CONFIG, requested), null, 2) + "\n");
    changed.push(CONFIG);
  } else if (currentConfig !== null) {
    const next = JSON.stringify({ ...currentConfig, ...requested }, null, 2) + "\n";
    if (next !== existingConfig) {
      await writeWhole(paths.teamConfigFile, next);
      changed.push(CONFIG);
    }
  }
  // A settings file that cannot be used is skipped by every command; here is where the user hears about it.
  const { config, problems } = await loadConfigReport(paths);
  for (const problem of problems) notes.push(`${problem}. Until it is fixed huddle runs on defaults, with prompt capture off.`);

  // 3. AGENTS.md, for agents with no hook adapter.
  try {
    const agentsMd = await installAgentsMd({ repoRoot, bundle: BUNDLE });
    changed.push(...agentsMd.changed);
    teamFiles.add(AGENTS_MD);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  // 4. Hook adapters: the ones asked for, or the ones that detect themselves.
  const installed: string[] = [];
  for (const adapter of chosen ?? ADAPTERS) {
    try {
      if (chosen === null && !(await adapter.detect(repoRoot))) continue;
      const result = await adapter.install({ repoRoot, bundle: BUNDLE });
      installed.push(adapter.title);
      changed.push(...result.changed);
      for (const file of result.files ?? result.changed) teamFiles.add(file);
      notes.push(...result.notes.map((note) => `${adapter.title}: ${note}`));
    } catch (error) {
      // An adapter that was asked for by name and is not installed is a failure; one that init tried by itself is a note.
      const stub = error instanceof NotImplementedError;
      const why = stub ? `${adapter.title}: not available in this version of huddle` : `${adapter.title}: could not install hooks: ${error instanceof Error ? error.message : String(error)}`;
      if (named) failures.push(why);
      else if (!stub || chosen !== null) notes.push(why);
    }
  }

  // 5. Report.
  const remote = await git(["remote", "get-url", config.remote], { cwd: repoRoot });
  if (!remote.ok) {
    notes.push(`there is no git remote named "${config.remote}". huddle shares state through a remote everyone pushes to: add one, or run init --remote <name>.`);
  }
  if (config.captureIntent) {
    notes.push("the first 200 characters of each prompt are shared with everyone who can read this repo, as the session's intent. Turn that off with: huddle init --no-capture-intent");
  }

  const unique = [...new Set(changed)];
  const partly = failures.length > 0;
  if (unique.length === 0) {
    io.out(partly ? "huddle changed nothing here." : "huddle is already set up here; nothing changed.");
  } else {
    io.out(partly ? "huddle is partly set up. Files written:" : "huddle is set up. Files written:");
    for (const file of unique) io.out(`  ${file}`);
  }
  io.out(installed.length > 0 ? `Hooks: ${installed.join(", ")}.` : "Hooks: none installed. Agents can still use huddle through AGENTS.md.");
  for (const note of notes) io.out(`Note: ${note}`);

  const toCommit = await uncommitted(repoRoot, [...teamFiles].filter(committable));
  if (toCommit.length > 0) {
    const here = relative(io.cwd, repoRoot);
    const gitHere = here === "" ? "git" : `git -C ${shellWord(here)}`;
    io.out("");
    io.out("Next: commit and push these files so your teammates get huddle with their next pull:");
    io.out(`  ${gitHere} add ${toCommit.map(shellWord).join(" ")}`);
    io.out(`  ${gitHere} commit -m "Set up huddle" && ${gitHere} push`);
    io.out(`Then check the setup with: node ${BUNDLE} doctor`);
  }

  if (partly) {
    for (const failure of failures) io.err(`huddle: not done: ${failure}`);
    io.err("huddle: init did not finish. What it wrote is listed above and is valid; fix what is named here and run init again.");
    return EXIT.ERROR;
  }
  return EXIT.OK;
}
