// T1.4. huddle release

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import { toRepoPattern } from "../core/files.ts";
import { EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { changeSession, resolveSession } from "../core/session.ts";
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

  const targets = positionals.map((raw) => {
    const pattern = toRepoPattern(ctx.paths, io.cwd, raw);
    if (pattern === null) throw new UsageError(`"${raw}" is outside this repository\nUsage: ${USAGE}`);
    return pattern;
  });

  // Taken from the list as it is stored now, under the lock: `existing` above may already be out of date.
  const stored = await changeSession(ctx, me, { create: false }, (session) => {
    const unknown = targets.filter((target) => !session.claims.includes(target));
    if (unknown.length > 0) throw new UsageError(`not claimed by this session: ${unknown.join(", ")}`);
    session.claims = targets.length === 0 ? [] : session.claims.filter((claim) => !targets.includes(claim));
  });
  // Null: the session ended while this ran, and its claims went with it.
  const remaining = stored?.claims ?? [];
  io.out(remaining.length === 0 ? "released all claims" : `still claimed: ${remaining.join(", ")}`);
  spawnBackgroundSync(ctx.paths, io.self, { force: true });
  return EXIT.OK;
}
