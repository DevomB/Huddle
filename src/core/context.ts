// What nearly every command needs, resolved once per process.

import { now } from "./clock.ts";
import { getIdentity } from "./identity.ts";
import type { Io } from "./io.ts";
import { loadConfig, requireRepo } from "./paths.ts";
import type { RepoPaths } from "./paths.ts";
import { createTransport } from "./transport.ts";
import type { Config, Identity, Transport } from "./types.ts";

export interface Ctx {
  io: Io;
  paths: RepoPaths;
  config: Config;
  identity: Identity;
  transport: Transport;
  /** Fixed for the life of the process; honors HUDDLE_NOW. */
  now: Date;
}

/** Throws a CliError when io.cwd is not inside a git repository. */
export async function openContext(io: Io): Promise<Ctx> {
  const paths = await requireRepo(io.cwd);
  const config = await loadConfig(paths);
  const identity = await getIdentity(paths);
  const transport = createTransport({ cwd: paths.worktree, remote: config.remote });
  return { io, paths, config, identity, transport, now: now(io.env) };
}
