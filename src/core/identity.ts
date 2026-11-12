// T1.1. Who this clone is.

import { todo } from "./io.ts";
import type { RepoPaths } from "./paths.ts";
import type { Identity } from "./types.ts";

/**
 * The clone's identity. Mints the actor id (8 random base32 characters, see
 * newId in docs.ts) into paths.actorFile on first use; safe when several
 * processes call it for the first time at once (they all end up with the same
 * id). `user` is git's user.name, falling back to the OS user name; `host` is
 * the machine's host name.
 */
export async function getIdentity(paths: RepoPaths): Promise<Identity> {
  void paths;
  return todo("identity.getIdentity");
}

/**
 * The session id for manual use (CLI, git hooks), when no agent supplies one:
 * HUDDLE_SESSION if set, otherwise an id that is stable per worktree and
 * differs between worktrees of the same clone.
 */
export function manualSessionId(paths: RepoPaths, env: NodeJS.ProcessEnv = process.env): string {
  void paths;
  void env;
  return todo("identity.manualSessionId");
}
