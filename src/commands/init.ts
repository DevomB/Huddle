// T2.3. huddle init: one teammate runs this once; everyone else only pulls.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { installAgentsMd } from "../adapters/agents-md.ts";
import { ADAPTERS, getAdapter } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import { parse } from "../core/args.ts";
import { git } from "../core/git.ts";
import { CliError, EXIT, NotImplementedError, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { loadConfig, mergeConfig, requireRepo } from "../core/paths.ts";
import type { RepoPaths } from "../core/paths.ts";
import { DEFAULT_CONFIG } from "../core/types.ts";

export const summary = "Set this repo up for huddle: vendor the bundle, write config, install agent hooks";

const USAGE = "huddle init [--agent <name>]... [--all] [--remote <name>] [--no-capture-intent]";

/** Repo-relative, forward slashes: what hook configs and AGENTS.md refer to. */
export const BUNDLE = ".huddle/huddle.mjs";
const CONFIG = ".huddle/config.json";
const ATTRIBUTES = ".huddle/.gitattributes";

/** First bytes of a built bundle (scripts/build.mjs). init refuses to vendor anything else. */
const BUNDLE_BANNER = "#!/usr/bin/env node\n// git-huddle ";

export function bundleVersion(text: string): string | null {
  if (!text.startsWith(BUNDLE_BANNER)) return null;
  return /^\/\/ git-huddle (\S+)/m.exec(text)?.[1] ?? null;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Copies the running bundle into the repo. Returns a line for the report, or null when it was already in place. */
async function vendorBundle(paths: RepoPaths, io: Io): Promise<string | null> {
  const running = await readText(io.self);
  const version = running === null ? null : bundleVersion(running);
  if (running === null || version === null) {
    throw new CliError(`huddle init must be run from the built bundle (dist/huddle.mjs or ${BUNDLE}), not from ${io.self || "an unknown script"}`);
  }
  if (resolve(io.self) === paths.bundleFile) return null; // running the vendored copy itself
  const existing = await readText(paths.bundleFile);
  if (existing === running) return null;
  await mkdir(paths.teamDir, { recursive: true });
  await writeFile(paths.bundleFile, running);
  await chmod(paths.bundleFile, 0o755);
  const previous = existing === null ? null : bundleVersion(existing);
  if (existing === null) return `${BUNDLE} (huddle ${version})`;
  return `${BUNDLE} (huddle ${previous ?? "unknown"} -> ${version})`;
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

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      agent: { type: "string", multiple: true, default: [] },
      all: { type: "boolean", default: false },
      remote: { type: "string" },
      "no-capture-intent": { type: "boolean", default: false },
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
  const chosen = chooseAdapters(values.agent ?? [], values.all === true);

  const paths = await requireRepo(io.cwd);
  const repoRoot = paths.worktree;
  const changed: string[] = [];
  const notes: string[] = [];
  const existingConfig = await readText(paths.teamConfigFile);
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
  const vendored = await vendorBundle(paths, io);
  if (vendored) changed.push(vendored);
  await mkdir(paths.teamDir, { recursive: true });
  if ((await readText(resolve(repoRoot, ATTRIBUTES))) === null) {
    // Generated, but kept diffable: hooks execute this file, so a change to it must stay reviewable.
    await writeFile(resolve(repoRoot, ATTRIBUTES), "huddle.mjs linguist-generated=true\n");
    changed.push(ATTRIBUTES);
  }

  // 2. Team config. Written once with every default spelled out; afterwards only the keys asked for change.
  if (existingConfig === null) {
    await writeFile(paths.teamConfigFile, JSON.stringify(mergeConfig(DEFAULT_CONFIG, requested), null, 2) + "\n");
    changed.push(CONFIG);
  } else if (currentConfig !== null) {
    const next = JSON.stringify({ ...currentConfig, ...requested }, null, 2) + "\n";
    if (next !== existingConfig) {
      await writeFile(paths.teamConfigFile, next);
      changed.push(CONFIG);
    }
  }
  const config = await loadConfig(paths);

  // 3. AGENTS.md, for agents with no hook adapter.
  const agentsMd = await installAgentsMd({ repoRoot, bundle: BUNDLE });
  changed.push(...agentsMd.changed);

  // 4. Hook adapters: the ones asked for, or the ones that detect themselves.
  const installed: string[] = [];
  for (const adapter of chosen ?? ADAPTERS) {
    try {
      if (chosen === null && !(await adapter.detect(repoRoot))) continue;
      const result = await adapter.install({ repoRoot, bundle: BUNDLE });
      installed.push(adapter.title);
      changed.push(...result.changed);
      notes.push(...result.notes.map((note) => `${adapter.title}: ${note}`));
    } catch (error) {
      if (error instanceof NotImplementedError) {
        // An adapter that is still a stub: only worth a word when it was asked for by name.
        if (chosen !== null) notes.push(`${adapter.title}: not available in this version of huddle`);
      } else {
        notes.push(`${adapter.title}: could not install hooks: ${error instanceof Error ? error.message : String(error)}`);
      }
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
  if (unique.length === 0) {
    io.out("huddle is already set up here; nothing changed.");
  } else {
    io.out("huddle is set up. Files written:");
    for (const file of unique) io.out(`  ${file}`);
  }
  io.out(installed.length > 0 ? `Agent hooks: ${installed.join(", ")}.` : "Agent hooks: none installed. Agents can still use huddle through AGENTS.md.");
  for (const note of notes) io.out(`Note: ${note}`);

  const dirty = await git(["status", "--porcelain", "--", ".huddle", "AGENTS.md", ".claude", ".codex"], { cwd: repoRoot });
  if (dirty.ok && dirty.stdout.trim() !== "") {
    const here = relative(io.cwd, repoRoot);
    const gitHere = here === "" ? "git" : `git -C ${here}`;
    const extra = [".claude", ".codex"].filter((dir) => dirty.stdout.includes(`${dir}/`)).join(" ");
    io.out("");
    io.out("Next: commit and push these files so your teammates get huddle with their next pull:");
    io.out(`  ${gitHere} add .huddle AGENTS.md${extra ? ` ${extra}` : ""}`);
    io.out(`  ${gitHere} commit -m "Set up huddle" && ${gitHere} push`);
    io.out(`Then check the setup with: node ${BUNDLE} doctor`);
  }
  return EXIT.OK;
}
