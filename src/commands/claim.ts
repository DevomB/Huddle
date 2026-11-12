// T1.4. huddle claim

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { LIMITS } from "../core/docs.ts";
import { currentBranch, toRepoPattern } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { resolveSession } from "../core/session.ts";
import { touchSession } from "../core/store.ts";
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

  const claims = [...existing];
  for (const raw of positionals) {
    const pattern = toRepoPattern(ctx.paths, io.cwd, raw);
    if (pattern === null) throw new UsageError(`"${raw}" is outside this repository\nUsage: ${USAGE}`);
    if (!claims.includes(pattern)) claims.push(pattern);
  }
  if (claims.length > LIMITS.claims) throw new UsageError(`a session can hold at most ${LIMITS.claims} claims; release some first`);

  await touchSession(ctx.paths, {
    id: me.id,
    worktree: ctx.paths.worktree,
    agent: me.agent,
    branch: await currentBranch(ctx.paths.worktree),
    claims,
    seenAt: ctx.now.toISOString(),
  });
  io.out(`claimed: ${claims.join(", ")}`);
  spawnBackgroundSync(ctx.paths, io.self, { force: true });
  return EXIT.OK;
}
