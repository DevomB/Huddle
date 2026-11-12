// T1.1. Who this clone is.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { LIMITS, cleanText, newId } from "./docs.ts";
import { git } from "./git.ts";
import { ensureStateDir } from "./paths.ts";
import type { RepoPaths } from "./paths.ts";
import { StoreBusyError, withLock, writeFileAtomic } from "./store.ts";
import { ID_RE } from "./types.ts";
import type { Identity } from "./types.ts";

const IDENTITY_LOCK = "identity";
const IDENTITY_WAIT_MS = 5_000;

/** The actor id in the file, or null when the file is missing, unreadable or not an id. */
async function readActor(file: string): Promise<string | null> {
  try {
    const id = (await readFile(file, "utf8")).trim();
    return ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Reads the actor id, minting it on first use. The common case is one file
 * read with no lock. Minting (and replacing a damaged file) happens under a
 * lock and re-reads first, so processes that ask for the first time at once
 * all end up with the same id.
 */
async function loadOrMintActor(paths: RepoPaths): Promise<string> {
  const existing = await readActor(paths.actorFile);
  if (existing) return existing;
  const result = await withLock(
    paths,
    IDENTITY_LOCK,
    async () => {
      const settled = await readActor(paths.actorFile);
      if (settled) return settled;
      const id = newId();
      await ensureStateDir(paths);
      await writeFileAtomic(paths.actorFile, `${id}\n`);
      return id;
    },
    { waitMs: IDENTITY_WAIT_MS },
  );
  if (!result.acquired) throw new StoreBusyError(IDENTITY_LOCK, IDENTITY_WAIT_MS);
  return result.value;
}

/** git's user.name, else the OS user name, else "unknown". Always one clean line. */
async function userName(paths: RepoPaths): Promise<string> {
  const configured = await git(["config", "--get", "user.name"], { cwd: paths.worktree });
  const fromGit = configured.ok ? cleanText(configured.stdout, LIMITS.name) : "";
  if (fromGit) return fromGit;
  try {
    const fromOs = cleanText(userInfo().username, LIMITS.name);
    if (fromOs) return fromOs;
  } catch {
    // No passwd entry for this uid (happens in some containers).
  }
  return "unknown";
}

/** The first label of the host name: enough to tell machines apart without publishing a full domain name. */
function hostLabel(): string {
  return cleanText(hostname().split(".")[0], LIMITS.name) || "unknown";
}

/**
 * The clone's identity. Mints the actor id (8 random base32 characters, see
 * newId in docs.ts) into paths.actorFile on first use; safe when several
 * processes call it for the first time at once (they all end up with the same
 * id). `user` is git's user.name, falling back to the OS user name; `host` is
 * the first label of the machine's host name.
 */
export async function getIdentity(paths: RepoPaths): Promise<Identity> {
  const [actor, user] = await Promise.all([loadOrMintActor(paths), userName(paths)]);
  return { actor, user, host: hostLabel() };
}

/**
 * The session id for manual use (CLI, git hooks), when no agent supplies one:
 * HUDDLE_SESSION if set, otherwise an id that is stable per worktree and
 * differs between worktrees of the same clone. The result is always an id the
 * store accepts.
 */
export function manualSessionId(paths: RepoPaths, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = cleanText(env.HUDDLE_SESSION, LIMITS.sessionId);
  if (explicit) return explicit;
  return `manual-${createHash("sha256").update(paths.worktree).digest("hex").slice(0, 8)}`;
}
