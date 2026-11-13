// T1.4. "Which session am I?" for CLI commands, and the team view from where
// that session stands. Agent hooks do not use resolveSession: their session id
// comes from the hook payload. A hook event that names no session does (a git
// hook, HookEvent.ambient): the hook engine resolves it here, so that a commit
// and a command typed in the same worktree are the same session.

import { ageMs } from "./clock.ts";
import type { Ctx } from "./context.ts";
import { cleanText, LIMITS, normalizeDoc } from "./docs.ts";
import { manualSessionId } from "./identity.ts";
import { readCache, readCacheStatus, readLocal, updateLocal } from "./store.ts";
import type { CacheState } from "./store.ts";
import { teamStateLine } from "./render.ts";
import type { SyncResult } from "./sync.ts";
import { actorRef } from "./types.ts";
import type { ActorDoc, Cache, Identity, LocalSession, LocalState, Session } from "./types.ts";
import { buildView, classifyFreshness, teamCompleteness } from "./view.ts";
import type { Completeness, FreshnessReport, RefreshOutcome, TeamView } from "./view.ts";

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

/**
 * Changes the session a command acts as, under the local lock. `change` sees
 * the session as it is stored at that moment, not as it was when the command
 * read it, so commands that run at once (an agent claiming in parallel tool
 * calls) all take effect instead of the last one overwriting the others.
 *
 * A session that is not stored is created first when `create` is set;
 * otherwise `change` is not called and the result is null. When `change`
 * throws, nothing is written and the error reaches the caller.
 */
export async function changeSession(
  ctx: Ctx,
  me: CurrentSession,
  opts: { create: boolean },
  change: (session: LocalSession) => void,
): Promise<LocalSession | null> {
  const stamp = ctx.now.toISOString();
  const state = await updateLocal(ctx.paths, (current) => {
    let session = current.sessions.find((candidate) => candidate.id === me.id);
    if (!session) {
      if (!opts.create) return;
      session = {
        id: me.id,
        agent: me.agent,
        branch: "",
        intent: "",
        intentSource: "none",
        files: [],
        claims: [],
        startedAt: stamp,
        seenAt: stamp,
        worktree: ctx.paths.worktree,
      };
      current.sessions.push(session);
    }
    change(session);
    session.seenAt = stamp;
  });
  return state.sessions.find((candidate) => candidate.id === me.id) ?? null;
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
  return viewFrom(ctx, cache, local, sessionId, worktree);
}

/** buildView over `cache` with this clone's own entry replaced by its local sessions (see currentView). Edits `cache`. */
function viewFrom(ctx: Ctx, cache: Cache, local: LocalState, sessionId: string, worktree?: string): TeamView {
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

/** What a sync this command ran says about its own refresh (CONTRACT 4.2). */
export function refreshOutcome(result: SyncResult): RefreshOutcome {
  if (result.error === "offline" || result.error === "denied") return result.error;
  if (result.skipped === "throttled") return "none"; // a round ran moments ago; fetchedAt says how long
  if (result.skipped === "locked") return "busy";
  if (result.fetched) return "ok";
  return "failed";
}

/** The team view together with how far it can be trusted. */
export interface TeamRead {
  view: TeamView;
  cacheState: CacheState;
  freshness: FreshnessReport;
  completeness: Completeness;
  /** teamStateLine: "" when fresh and complete. The same words on stderr, in JSON `warnings` and in hook context. */
  line: string;
}

/**
 * currentView, plus the freshness and completeness of what it shows. `refresh`
 * is what this command's own sync did, "none" when it did not run one. Reads
 * cache.json and local.json only: no git, no network, so the hook engine can
 * call it on every event, with the same `state` and `worktree` as currentView.
 */
export async function readTeam(ctx: Ctx, sessionId: string, refresh: RefreshOutcome = "none", state?: LocalState, worktree?: string): Promise<TeamRead> {
  const [{ cache, state: cacheState }, local] = await Promise.all([readCacheStatus(ctx.paths), state ?? readLocal(ctx.paths)]);
  const freshness = classifyFreshness({ cacheState, fetchedAt: cache.fetchedAt, now: ctx.now, syncIntervalSeconds: ctx.config.syncIntervalSeconds, refresh });
  const view = viewFrom(ctx, cache, local, sessionId, worktree);
  const completeness = teamCompleteness(cache, view);
  return { view, cacheState, freshness, completeness, line: teamStateLine(freshness, completeness, ctx.config.remote) };
}

/** The keys CONTRACT 4.2 adds to every JSON read, next to the command's own. */
export function envelope(team: TeamRead): { schemaVersion: 1; freshness: FreshnessReport["freshness"]; complete: boolean; ageSeconds: number | null; warnings: string[] } {
  return { schemaVersion: 1, freshness: team.freshness.freshness, complete: team.completeness.complete, ageSeconds: team.freshness.ageSeconds, warnings: team.line === "" ? [] : [team.line] };
}
