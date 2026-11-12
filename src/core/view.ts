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
  /**
   * Other decisions that are the same rule: same text, competing replacements
   * of the same decision (a settled conflict, see DecisionConflict). Shown
   * once, under the smallest id. `huddle decide --supersedes` with any of the
   * ids replaces all of them.
   */
  sameAs?: string[];
}

/**
 * Two or more decisions replace the same decision, directly or down their
 * chains, and say different things (audit A04: each author's log is
 * compare-and-swapped on its own, so two replacements made at the same moment
 * both land). None of them is in force, and no clock picks a winner: the team
 * settles it with `huddle decide --resolve <over> "<rule>"`, which replaces
 * every candidate with the same text.
 */
export interface DecisionConflict {
  /** The id `huddle decide --resolve` takes: the decision they compete to replace, or for a loop the smallest id in it. */
  over: string;
  /** "fork": competing replacements. "loop": decisions that replace one another, with nothing at the end. */
  kind: "fork" | "loop";
  /** The decision at `over`, when it is in a readable log. */
  replaced: ViewDecision | null;
  /** The competing rules, by text and then id. */
  candidates: ViewDecision[];
}

/**
 * Where a claimed task's owner stands (CONTRACT 4.3):
 * - "live": the owner's session is live.
 * - "expired": the owner's actor document is readable and the session is not
 *   in it, or it was last seen ttlMinutes ago or more. Activity-based
 *   reclamation: the task may be claimed again. This is not an execution lock;
 *   a quiet owner can look expired while still working.
 * - "unknown": nothing readable says either way: the cache was never fetched
 *   (or could not be read), the owner's actor ref is missing or holds a
 *   document this version cannot read, or the session's seenAt is too far in
 *   the future to mean anything. Never taken as expired.
 */
export type OwnerPresence = "live" | "expired" | "unknown";

export interface ViewTask extends TaskDoc {
  /** ownerPresence === "live". Kept for readers that know only this field. */
  ownerLive: boolean;
  /** For a claimed task with an owner, where that owner stands; null otherwise. Only "expired" may be claimed again. */
  ownerPresence: OwnerPresence | null;
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
  /** The union of all actors' decisions, minus superseded ones and conflicted ones, newest first. */
  decisions: ViewDecision[];
  /** Unresolved decision conflicts (see DecisionConflict), by `over`. Their candidates are not in `decisions`. */
  conflicts: DecisionConflict[];
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
    conflicts: [],
    tasks: [],
  };

  const live = new Set<string>();
  if (self.session !== undefined) live.add(sessionKey(self.actor, self.session)); // the viewer is running right now
  // Every actor ref in the cache: its sessions by id (latest stamp wins), or null when its document cannot be read.
  const actors = new Map<string, Map<string, Session> | null>();
  const decisions: ViewDecision[] = [];
  const tasks: TaskDoc[] = [];

  const refs = cache.refs ?? {};
  for (const ref of Object.keys(refs).sort()) {
    const where = parseRef(ref);
    const doc = refs[ref]?.doc;

    if (where?.kind === "actor" && (doc === null || doc === undefined || doc.kind !== "actor" || doc.actor !== where.id)) {
      actors.set(where.id, null);
      continue;
    }
    if (where === null || doc === null || doc === undefined) continue;

    if (where.kind === "actor" && doc.kind === "actor" && doc.actor === where.id) {
      // One entry per session id; if a doc repeats an id, the most recently seen wins.
      const latest = new Map<string, Session>();
      const stamps = new Map<string, Session>();
      for (const session of doc.sessions) {
        const previousStamp = stamps.get(session.id);
        if (previousStamp === undefined || Date.parse(session.seenAt) > Date.parse(previousStamp.seenAt)) stamps.set(session.id, session);
        // Skipped here, not below, so that a stamp from the far future cannot
        // win over a believable entry for the same id.
        if (Date.parse(session.seenAt) - nowMs > MAX_CLOCK_SKEW_MS) continue;
        const previous = latest.get(session.id);
        if (previous === undefined || Date.parse(session.seenAt) > Date.parse(previous.seenAt)) latest.set(session.id, session);
      }
      actors.set(doc.actor, stamps);
      for (const session of latest.values()) {
        if (!(nowMs - Date.parse(session.seenAt) < ttlMs)) continue;
        live.add(sessionKey(doc.actor, session.id));
        const own = doc.actor === self.actor;
        if (own && session.id === self.session) continue;
        view.sessions.push({
          ...session,
          files: [...session.files],
          claims: [...session.claims],
          ...(session.partial === undefined ? {} : { partial: { total: session.partial.total, cover: [...session.partial.cover] } }),
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
  // name is unambiguous across actors. Competing replacements are a conflict.
  const settled = settleDecisions(decisions);
  view.decisions = settled.inForce.sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at) || compareText(a.actor, b.actor) || compareText(a.id, b.id),
  );
  view.conflicts = settled.conflicts;

  const presence = (task: TaskDoc): OwnerPresence | null => {
    if (task.status !== "claimed" || task.owner === null) return null;
    if (live.has(sessionKey(task.owner.actor, task.owner.session))) return "live";
    if (view.fetchedAt === null) return "unknown"; // never fetched, or the cache could not be read
    const sessions = actors.get(task.owner.actor);
    if (sessions === undefined || sessions === null) return "unknown";
    const session = sessions.get(task.owner.session);
    if (session === undefined) return "expired"; // the owner's clone says the session is over
    // Not live: either last seen a TTL ago or more, or stamped too far ahead to mean anything.
    return Date.parse(session.seenAt) - nowMs > MAX_CLOCK_SKEW_MS || Number.isNaN(Date.parse(session.seenAt)) ? "unknown" : "expired";
  };
  view.tasks = tasks
    .map((task) => {
      const ownerPresence = presence(task);
      return {
        ...task,
        owner: task.owner === null ? null : { ...task.owner },
        createdBy: { ...task.createdBy },
        ownerLive: ownerPresence === "live",
        ownerPresence,
      };
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareText(a.id, b.id));

  return view;
}

/**
 * Splits decisions into the rules in force and the unresolved conflicts. Pure.
 *
 * Every decision replaces at most one (`supersedes`), so the decisions form
 * chains that branch where two decisions replace the same one (a fork). The
 * ends of the chains (decisions nothing replaces) are the candidates. Each end
 * belongs to the top-most fork above it; an end with no fork above it is in
 * force. The ends under one fork are one rule when they all say the same
 * thing (a settled conflict: `sameAs`), and a conflict when they do not.
 * A loop (crafted or damaged logs: a decision can only replace one that
 * already exists) is handled the same way, with the loop in place of the
 * fork; a loop with nothing at its end is a conflict of its members, never
 * silently gone.
 */
export function settleDecisions(all: ViewDecision[]): { inForce: ViewDecision[]; conflicts: DecisionConflict[] } {
  const byId = new Map<string, ViewDecision>();
  for (const decision of all) if (!byId.has(decision.id)) byId.set(decision.id, decision);
  const parentOf = (decision: ViewDecision): string | undefined =>
    decision.supersedes !== undefined && decision.supersedes !== decision.id ? decision.supersedes : undefined;
  const children = new Map<string, number>();
  for (const decision of byId.values()) {
    const parent = parentOf(decision);
    if (parent !== undefined) children.set(parent, (children.get(parent) ?? 0) + 1);
  }

  /** Walks up from `start`; the key of the top-most fork, or of the loop it runs into, or undefined. */
  const reached = new Set<string>();
  const topOf = (start: ViewDecision): { key: string; loop: boolean } | undefined => {
    let top: string | undefined;
    const path: string[] = [];
    const seen = new Set<string>([start.id]);
    reached.add(start.id);
    let current = parentOf(start);
    while (current !== undefined) {
      if (seen.has(current)) {
        // `start` itself is in the loop only when it is replaced (a loop with no end, found from inside).
        const loop = (current === start.id ? [start.id, ...path] : path.slice(path.indexOf(current))).sort(compareText);
        return { key: loop[0] ?? current, loop: true };
      }
      seen.add(current);
      path.push(current);
      reached.add(current);
      if ((children.get(current) ?? 0) >= 2) top = current;
      const node = byId.get(current);
      current = node === undefined ? undefined : parentOf(node);
    }
    return top === undefined ? undefined : { key: top, loop: false };
  };

  const inForce: ViewDecision[] = [];
  const groups = new Map<string, { loop: boolean; members: ViewDecision[] }>();
  for (const decision of byId.values()) {
    if (children.has(decision.id)) continue; // replaced: not an end
    const top = topOf(decision);
    if (top === undefined) {
      inForce.push(decision);
      continue;
    }
    const group = groups.get(top.key) ?? { loop: top.loop, members: [] };
    group.members.push(decision);
    groups.set(top.key, group);
  }
  // What no end leads to can only be a loop with nothing at its end.
  const unreached = [...byId.values()].filter((decision) => !reached.has(decision.id));
  for (const decision of unreached) {
    const top = topOf(decision);
    const key = top?.key ?? decision.id;
    const group = groups.get(key) ?? { loop: true, members: [] };
    group.loop = true;
    if (!group.members.some((member) => member.id === decision.id)) group.members.push(decision);
    groups.set(key, group);
  }

  const conflicts: DecisionConflict[] = [];
  for (const [over, group] of [...groups.entries()].sort(([a], [b]) => compareText(a, b))) {
    const members = group.members.sort((a, b) => compareText(a.text, b.text) || compareText(a.id, b.id));
    const texts = new Set(members.map((member) => member.text));
    const ends = members.filter((member) => !children.has(member.id));
    if (texts.size === 1 && ends.length === members.length) {
      const [first, ...rest] = [...members].sort((a, b) => compareText(a.id, b.id));
      if (first) inForce.push(rest.length > 0 ? { ...first, sameAs: rest.map((member) => member.id) } : first);
      continue;
    }
    conflicts.push({ over, kind: group.loop ? "loop" : "fork", replaced: byId.get(over) ?? null, candidates: members });
  }
  return { inForce, conflicts };
}

/**
 * open: nobody has it. taken: claimed by a live session. stale: claimed, but
 * the owner's session has expired, so it may be claimed again. unclear:
 * claimed, and nothing readable says whether the owner is still there; it may
 * not be claimed. done.
 */
export type TaskState = "open" | "taken" | "stale" | "unclear" | "done";

export function taskState(task: ViewTask): TaskState {
  if (task.status === "open") return "open";
  if (task.status === "done") return "done";
  // A document from before ownerPresence existed has only ownerLive.
  const presence = task.ownerPresence ?? (task.ownerLive ? "live" : "expired");
  return presence === "live" ? "taken" : presence === "expired" ? "stale" : "unclear";
}

export function countTasks(view: TeamView): Record<TaskState, number> {
  const counts: Record<TaskState, number> = { open: 0, taken: 0, stale: 0, unclear: 0, done: 0 };
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
  /**
   * "file": the path is one of the session's files in flight. "claim": it
   * matches one of the session's claims. "coverage": it matches a glob huddle
   * generated because the session has more files in flight than it could
   * list (Session.partial): conservative, the file may not be one of them.
   * All three are an overlap.
   */
  via: "file" | "claim" | "coverage";
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
    if (claim !== undefined) found.push({ session, via: session.partial?.cover.includes(claim) ? "coverage" : "claim", match: claim });
  }
  return found;
}

// ------------------------------------------------------------------ freshness

/**
 * How far the team picture can be trusted (CONTRACT 4.2):
 * - "fresh": cache.json readable, fetched within staleAfterSeconds, and any
 *   refresh this command tried worked;
 * - "stale": fetched once, but longer ago than that, or this command's
 *   refresh failed;
 * - "never": this clone has no successful fetch;
 * - "unreadable": cache.json exists and cannot be used.
 */
export type Freshness = "fresh" | "stale" | "never" | "unreadable";

/**
 * What the command's own refresh did. "none": it did not try (a cache-only
 * read, or the throttle found the last sync recent). "ok": it fetched.
 * Anything else: why it did not.
 */
export type RefreshOutcome = "none" | "ok" | "offline" | "denied" | "busy" | "failed";

export interface FreshnessInput {
  /** From readCacheStatus (store.ts): "missing" is no cache.json at all. */
  cacheState: "ok" | "missing" | "unreadable";
  fetchedAt: Iso | null;
  now: Date;
  syncIntervalSeconds: number;
  refresh?: RefreshOutcome;
}

export interface FreshnessReport {
  freshness: Freshness;
  /** Whole seconds since the last successful fetch, never negative; null when there is none to go by. */
  ageSeconds: number | null;
  /** Older than this is stale. */
  staleAfterSeconds: number;
  refresh: RefreshOutcome;
}

/** max(4 × syncIntervalSeconds, 60): a clone with live hooks syncs every interval, so four missed rounds is a real gap. */
export function staleAfterSeconds(syncIntervalSeconds: number): number {
  const interval = Number.isFinite(syncIntervalSeconds) && syncIntervalSeconds > 0 ? syncIntervalSeconds : DEFAULT_CONFIG.syncIntervalSeconds;
  return Math.max(4 * interval, 60);
}

/** Pure. The one place freshness is decided; commands and hooks both call it. */
export function classifyFreshness(input: FreshnessInput): FreshnessReport {
  const limit = staleAfterSeconds(input.syncIntervalSeconds);
  const refresh = input.refresh ?? "none";
  const fetchedMs = input.fetchedAt === null ? Number.NaN : Date.parse(input.fetchedAt);
  const nowMs = input.now.getTime();
  const raw = Number.isNaN(fetchedMs) || Number.isNaN(nowMs) ? null : (nowMs - fetchedMs) / 1000;
  const report = (freshness: Freshness, ageSeconds: number | null): FreshnessReport => ({ freshness, ageSeconds, staleAfterSeconds: limit, refresh });
  if (input.cacheState === "unreadable") return report("unreadable", null);
  if (raw === null) return report("never", null);
  const age = Math.max(0, Math.floor(raw));
  if (refresh !== "none" && refresh !== "ok") return report("stale", age);
  // A fetch stamped far ahead of this clock says nothing about how old it is.
  if (raw >= limit || raw < -MAX_CLOCK_SKEW_MS / 1000) return report("stale", age);
  return report("fresh", age);
}

export interface Completeness {
  /** False when some of the team cannot be seen, or a live session published only part of its files with nothing covering the rest. */
  complete: boolean;
  /** Actor refs whose document this version cannot read: those teammates' sessions are missing from the view. */
  unreadableActors: number;
  /** Live sessions in the view with `partial` and no `cover`. */
  uncovered: number;
}

/** Pure. `view` must be built from `cache`. */
export function teamCompleteness(cache: Cache, view: TeamView): Completeness {
  let unreadableActors = 0;
  for (const [ref, entry] of Object.entries(cache.refs ?? {})) {
    const where = parseRef(ref);
    if (where?.kind !== "actor") continue;
    const doc = entry?.doc;
    if (doc === null || doc === undefined || doc.kind !== "actor" || doc.actor !== where.id) unreadableActors++;
  }
  const uncovered = view.sessions.filter((session) => session.partial !== undefined && session.partial.cover.length === 0).length;
  return { complete: unreadableActors === 0 && uncovered === 0, unreadableActors, uncovered };
}
