// T1.3. The team as this session sees it. Pure: no git, no filesystem, no clock.
// Implements the read side for all three document kinds (plan.md §3 Rules).

import { claimMatches, normalizePath } from "./glob.ts";
import { DEFAULT_CONFIG, parseRef } from "./types.ts";
import type { Cache, Decision, Iso, Session, TaskDoc } from "./types.ts";

/** Who is looking. Without `session`, every session of the actor counts as "someone else". */
export interface Self {
  actor: string;
  session?: string;
}

export interface ViewSession extends Session {
  actor: string;
  user: string;
  host: string;
  /** Another session of this same clone (same actor, different session id). */
  sameClone: boolean;
}

export interface ViewDecision extends Decision {
  actor: string;
  user: string;
}

export interface ViewTask extends TaskDoc {
  /** status "claimed" and the owner's session is live. A claimed task that is not ownerLive may be claimed again. */
  ownerLive: boolean;
}

export interface TeamView {
  now: Iso;
  /** When the cache was last refreshed from the remote; null = never synced. */
  fetchedAt: Iso | null;
  self: Self;
  /**
   * Live sessions (now - seenAt < ttl), excluding the viewer's own session,
   * most recently seen first. Other sessions of the viewer's own clone are
   * included: two agents in two worktrees of one clone collide like any others.
   */
  sessions: ViewSession[];
  /** The union of all actors' decisions, minus superseded ones, newest first. */
  decisions: ViewDecision[];
  /** All tasks, oldest first. */
  tasks: ViewTask[];
}

export interface ViewOptions {
  ttlMinutes?: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * How far ahead of this machine's clock a teammate's seenAt may be and still
 * count as "just seen". Clocks that are set by hand drift by minutes; beyond
 * this the stamp says nothing about when the session was last alive.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function sessionKey(actor: string, session: string): string {
  return `${actor}/${session}`;
}

/**
 * Builds the view from the last fetched team state.
 *
 * Live: `now - seenAt < ttlMinutes`. A session last seen exactly ttlMinutes
 * ago is not live. A seenAt up to MAX_CLOCK_SKEW_MS in the future counts as
 * just seen. One further ahead than that is not live at all: taken at its
 * word, a session with a clock an hour fast would stay live for an hour after
 * it ended, and one stamped with next year would never leave. The price is
 * that a teammate whose clock is that wrong is not shown until it is fixed.
 *
 * The cache holds what the remote had at the last sync, including this
 * clone's own ActorDoc as last published. A caller that wants this clone's
 * other sessions to be as fresh as local.json can overlay its local ActorDoc
 * on the cache entry for its own actor ref before calling.
 *
 * Docs in the cache passed parseDoc on the way in. An entry whose doc is null
 * (fetched, but not a valid v0 document) or that sits under a ref it does not
 * belong to is ignored.
 *
 * The view shares no arrays or objects with the cache, so either may be
 * edited afterwards without changing the other.
 */
export function buildView(cache: Cache, self: Self, now: Date, opts: ViewOptions = {}): TeamView {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new TypeError("buildView: `now` is not a valid date");
  const ttlMinutes = opts.ttlMinutes !== undefined && opts.ttlMinutes > 0 ? opts.ttlMinutes : DEFAULT_CONFIG.ttlMinutes;
  const ttlMs = ttlMinutes * 60_000;

  const view: TeamView = {
    now: now.toISOString(),
    fetchedAt: cache.fetchedAt ?? null,
    self: self.session === undefined ? { actor: self.actor } : { actor: self.actor, session: self.session },
    sessions: [],
    decisions: [],
    tasks: [],
  };

  const live = new Set<string>();
  if (self.session !== undefined) live.add(sessionKey(self.actor, self.session)); // the viewer is running right now
  const decisions: ViewDecision[] = [];
  const tasks: TaskDoc[] = [];

  const refs = cache.refs ?? {};
  for (const ref of Object.keys(refs).sort()) {
    const where = parseRef(ref);
    const doc = refs[ref]?.doc;
    if (where === null || doc === null || doc === undefined) continue;

    if (where.kind === "actor" && doc.kind === "actor" && doc.actor === where.id) {
      // One entry per session id; if a doc repeats an id, the most recently seen wins.
      const latest = new Map<string, Session>();
      for (const session of doc.sessions) {
        // Skipped here, not below, so that a stamp from the far future cannot
        // win over a believable entry for the same id.
        if (Date.parse(session.seenAt) - nowMs > MAX_CLOCK_SKEW_MS) continue;
        const previous = latest.get(session.id);
        if (previous === undefined || Date.parse(session.seenAt) > Date.parse(previous.seenAt)) latest.set(session.id, session);
      }
      for (const session of latest.values()) {
        if (!(nowMs - Date.parse(session.seenAt) < ttlMs)) continue;
        live.add(sessionKey(doc.actor, session.id));
        const own = doc.actor === self.actor;
        if (own && session.id === self.session) continue;
        view.sessions.push({
          ...session,
          files: [...session.files],
          claims: [...session.claims],
          actor: doc.actor,
          user: doc.user,
          host: doc.host,
          sameClone: own,
        });
      }
    } else if (where.kind === "decisions" && doc.kind === "decisions" && doc.actor === where.id) {
      for (const decision of doc.decisions) decisions.push({ ...decision, actor: doc.actor, user: doc.user });
    } else if (where.kind === "task" && doc.kind === "task" && doc.id === where.id) {
      tasks.push(doc);
    }
  }

  view.sessions.sort(
    (a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt) || compareText(a.user, b.user) || compareText(a.actor, b.actor) || compareText(a.id, b.id),
  );

  // A decision is hidden once any other decision names it in `supersedes`,
  // whoever wrote it and whatever their clocks said. Ids are random, so the
  // name is unambiguous across actors.
  const superseded = new Set<string>();
  for (const decision of decisions) {
    if (decision.supersedes !== undefined && decision.supersedes !== decision.id) superseded.add(decision.supersedes);
  }
  view.decisions = decisions
    .filter((decision) => !superseded.has(decision.id))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || compareText(a.actor, b.actor) || compareText(a.id, b.id));

  view.tasks = tasks
    .map((task) => ({
      ...task,
      owner: task.owner === null ? null : { ...task.owner },
      createdBy: { ...task.createdBy },
      ownerLive: task.status === "claimed" && task.owner !== null && live.has(sessionKey(task.owner.actor, task.owner.session)),
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareText(a.id, b.id));

  return view;
}

/**
 * open: nobody has it. taken: claimed by a live session. stale: claimed, but
 * the owner's session is gone, so it may be claimed again. done.
 */
export type TaskState = "open" | "taken" | "stale" | "done";

export function taskState(task: ViewTask): TaskState {
  if (task.status === "open") return "open";
  if (task.status === "done") return "done";
  return task.ownerLive ? "taken" : "stale";
}

export function countTasks(view: TeamView): Record<TaskState, number> {
  const counts: Record<TaskState, number> = { open: 0, taken: 0, stale: 0, done: 0 };
  for (const task of view.tasks) counts[taskState(task)]++;
  return counts;
}

/** True for the form git prints paths in, which is what sessions publish: nothing for normalizePath to do. */
function isNormalized(path: string): boolean {
  const first = path.charCodeAt(0);
  return first !== 46 /* . */ && first !== 47 /* / */ && !path.endsWith("/") && !path.includes("//") && !path.includes("/./");
}

export interface Overlap {
  session: ViewSession;
  /** The path is one of the session's files in flight, or it matches one of its claim globs. */
  via: "file" | "claim";
  /** The file or the glob that matched. */
  match: string;
}

/**
 * The live sessions in the view that `path` (repo-relative, forward slashes)
 * overlaps: the path is one of the session's files in flight, or one of the
 * session's claims covers it (see claimMatches). `path` may also name a
 * directory, in which case any file in flight under it counts. One entry per
 * session, in view order; a file hit wins over a claim hit.
 */
export function overlaps(view: TeamView, path: string): Overlap[] {
  const target = normalizePath(path);
  if (target === "") return [];
  const under = `${target}/`;
  const found: Overlap[] = [];
  for (const session of view.sessions) {
    let file: string | undefined;
    for (const candidate of session.files) {
      const normalized = isNormalized(candidate) ? candidate : normalizePath(candidate);
      if (normalized === target) {
        file = candidate;
        break;
      }
      if (file === undefined && normalized.startsWith(under)) file = candidate;
    }
    if (file !== undefined) {
      found.push({ session, via: "file", match: file });
      continue;
    }
    const claim = session.claims.find((candidate) => claimMatches(candidate, target));
    if (claim !== undefined) found.push({ session, via: "claim", match: claim });
  }
  return found;
}
