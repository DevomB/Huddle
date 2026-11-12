// T1.4. "Which session am I?" for CLI commands, and the team view from where
// that session stands. Agent hooks do not use resolveSession: their session id
// comes from the hook payload. A hook event that names no session does (a git
// hook, HookEvent.ambient): the hook engine resolves it here, so that a commit
// and a command typed in the same worktree are the same session.

import { ageMs } from "./clock.ts";
import type { Ctx } from "./context.ts";
import { cleanText, LIMITS, normalizeDoc } from "./docs.ts";
import { manualSessionId } from "./identity.ts";
import { readCache, readLocal } from "./store.ts";
import { actorRef } from "./types.ts";
import type { ActorDoc, Identity, LocalSession, LocalState, Session } from "./types.ts";
import { buildView } from "./view.ts";
import type { TeamView } from "./view.ts";

export interface CurrentSession {
  id: string;
  /** The agent recorded for the session, or "manual" when it does not exist yet. */
  agent: string;
  /** The session as stored in local.json; null when nothing has created it yet. */
  session: LocalSession | null;
}

/**
 * The session a CLI command acts as:
 *   1. HUDDLE_SESSION, when set;
 *   2. otherwise the most recently active live session in this worktree, so
 *      that an agent running `huddle intent` from its shell updates the session
 *      its own hooks created instead of adding a second one;
 *   3. otherwise the per-worktree manual session.
 */
export async function resolveSession(ctx: Ctx, state?: LocalState): Promise<CurrentSession> {
  const local = state ?? (await readLocal(ctx.paths));
  const found = (id: string): CurrentSession => {
    const session = local.sessions.find((candidate) => candidate.id === id) ?? null;
    return { id, agent: session?.agent ?? "manual", session };
  };

  const explicit = cleanText(ctx.io.env.HUDDLE_SESSION, LIMITS.sessionId);
  if (explicit) return found(explicit);

  const ttlMs = ctx.config.ttlMinutes * 60_000;
  const here = local.sessions
    .filter((session) => session.worktree === ctx.paths.worktree && ageMs(session.seenAt, ctx.now) < ttlMs)
    .sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt))[0];
  if (here) return { id: here.id, agent: here.agent, session: here };

  return found(manualSessionId(ctx.paths, ctx.io.env));
}

/** The published form of a local session: everything except the worktree path, which never leaves the machine. */
export function toPublicSession(session: LocalSession): Session {
  return {
    id: session.id,
    agent: session.agent,
    branch: session.branch,
    intent: session.intent,
    intentSource: session.intentSource,
    files: session.files,
    claims: session.claims,
    startedAt: session.startedAt,
    seenAt: session.seenAt,
  };
}

/** This clone's ActorDoc, from its live local sessions. */
export function toActorDoc(identity: Identity, sessions: LocalSession[], now: Date, ttlMinutes: number): ActorDoc {
  const ttlMs = ttlMinutes * 60_000;
  return {
    v: 0,
    kind: "actor",
    actor: identity.actor,
    user: identity.user,
    host: identity.host,
    updatedAt: now.toISOString(),
    sessions: sessions.filter((session) => ageMs(session.seenAt, now) < ttlMs).map(toPublicSession),
  };
}

/**
 * The team as session `sessionId` of this clone sees it, from the cache. This
 * clone's own entry is replaced with its current local sessions, so sessions
 * in other worktrees of the same clone show up at once rather than after the
 * next publish. No network. `worktree` is where the viewer is working; it
 * defaults to the worktree the context was opened in.
 */
export async function currentView(ctx: Ctx, sessionId: string, state?: LocalState, worktree?: string): Promise<TeamView> {
  const [cache, local] = await Promise.all([readCache(ctx.paths), state ?? readLocal(ctx.paths)]);
  const ref = actorRef(ctx.identity.actor);
  // Sessions that share the viewer's worktree share its dirty files: those are
  // the viewer's own work as much as theirs, so they are not shown as someone
  // else's files in flight. Their intent and claims still are.
  const viewer = worktree ?? ctx.paths.worktree;
  const sessions = local.sessions.map((session) =>
    session.worktree === viewer && session.id !== sessionId ? { ...session, files: [] } : session,
  );
  const own = normalizeDoc(toActorDoc(ctx.identity, sessions, ctx.now, ctx.config.ttlMinutes));
  if (own) cache.refs[ref] = { sha: cache.refs[ref]?.sha ?? "", doc: own };
  return buildView(cache, { actor: ctx.identity.actor, session: sessionId }, ctx.now, { ttlMinutes: ctx.config.ttlMinutes });
}
