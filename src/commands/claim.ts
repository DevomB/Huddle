// T1.4. huddle claim

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { LIMITS, cleanPath, replaceUnsafe } from "../core/docs.ts";
import { currentBranch, toRepoPattern } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { changeSession, resolveSession } from "../core/session.ts";
import { spawnBackgroundSync } from "../core/sync.ts";

export const summary = "Claim files by glob for this session";

const USAGE = "huddle claim <glob>... | huddle claim";

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals } = parse(args, {}, USAGE);
  const ctx = await openContext(io);
  const me = await resolveSession(ctx);
  const existing = me.session?.claims ?? [];

  if (positionals.length === 0) {
    io.out(existing.length === 0 ? "(no claims)" : existing.join("\n"));
    return EXIT.OK;
  }

  const wanted: string[] = [];
  for (const raw of positionals) {
    const pattern = toRepoPattern(ctx.paths, io.cwd, raw);
    if (pattern === null) throw new UsageError(`"${shown(raw)}" is outside this repository\nUsage: ${USAGE}`);
    const problem = unsharable(pattern);
    if (problem) throw new UsageError(`"${shown(pattern)}" cannot be claimed: ${problem}. Nothing was changed.\nUsage: ${USAGE}`);
    if (!wanted.includes(pattern)) wanted.push(pattern);
  }

  const branch = await currentBranch(ctx.paths.worktree);
  // Added to the list as it is stored now, under the lock: `existing` above may already be out of date.
  const stored = await changeSession(ctx, me, { create: true }, (session) => {
    const claims = [...session.claims];
    for (const pattern of wanted) if (!claims.includes(pattern)) claims.push(pattern);
    if (claims.length > LIMITS.claims) throw new UsageError(`a session can hold at most ${LIMITS.claims} claims; release some first`);
    session.claims = claims;
    session.worktree = ctx.paths.worktree;
    session.agent = me.agent;
    session.branch = branch;
  });
  const claims = stored?.claims ?? [];
  io.out(`claimed: ${claims.join(", ")}`);
  spawnBackgroundSync(ctx.paths, io.self, { force: true });
  return EXIT.OK;
}

/**
 * Why teammates could not receive `pattern` exactly as it is stored, or null
 * when they can. A claim goes out through the same gate as everything a
 * teammate reads (cleanPath in docs.ts), which drops a path that is too long
 * and removes characters a reader cannot see. A claim accepted here but changed
 * there would be a claim the user believes in and nobody else sees, so it is
 * refused before anything is stored.
 */
export function unsharable(pattern: string): string | null {
  const length = Array.from(pattern).length;
  if (length > LIMITS.path) return `a claim is at most ${LIMITS.path} characters, and this one is ${length}`;
  if (cleanPath(pattern) !== pattern) return "it holds characters that are not shared with teammates (control or invisible characters, or a backslash)";
  return null;
}

/** For an error message: the text with characters a terminal would act on made visible, and cut. */
function shown(text: string): string {
  const visible = replaceUnsafe(text, "?");
  return Array.from(visible).length > 120 ? `${Array.from(visible).slice(0, 117).join("")}...` : visible;
}
