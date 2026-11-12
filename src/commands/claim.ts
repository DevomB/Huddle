// T1.4. huddle claim

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { LIMITS } from "../core/docs.ts";
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
    if (pattern === null) throw new UsageError(`"${raw}" is outside this repository\nUsage: ${USAGE}`);
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
