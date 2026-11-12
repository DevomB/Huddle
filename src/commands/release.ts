// T1.4. huddle release

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { toRepoPattern } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { resolveSession } from "../core/session.ts";
import { touchSession } from "../core/store.ts";
import { spawnBackgroundSync } from "../core/sync.ts";

export const summary = "Release this session's claims";

const USAGE = "huddle release [<glob>...]   (no glob: release every claim)";

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals } = parse(args, {}, USAGE);
  const ctx = await openContext(io);
  const me = await resolveSession(ctx);
  const existing = me.session?.claims ?? [];
  if (!me.session || existing.length === 0) {
    io.out("(no claims)");
    return EXIT.OK;
  }

  let remaining: string[] = [];
  if (positionals.length > 0) {
    const targets = positionals.map((raw) => {
      const pattern = toRepoPattern(ctx.paths, io.cwd, raw);
      if (pattern === null) throw new UsageError(`"${raw}" is outside this repository\nUsage: ${USAGE}`);
      return pattern;
    });
    const unknown = targets.filter((target) => !existing.includes(target));
    if (unknown.length > 0) throw new UsageError(`not claimed by this session: ${unknown.join(", ")}`);
    remaining = existing.filter((claim) => !targets.includes(claim));
  }

  await touchSession(ctx.paths, { id: me.id, worktree: me.session.worktree, claims: remaining, seenAt: ctx.now.toISOString() });
  io.out(remaining.length === 0 ? "released all claims" : `still claimed: ${remaining.join(", ")}`);
  spawnBackgroundSync(ctx.paths, io.self, { force: true });
  return EXIT.OK;
}
