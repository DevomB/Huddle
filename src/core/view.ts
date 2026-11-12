// T1.3. The team as this session sees it. Pure: no git, no filesystem, no clock.
// Implements the read side for all three document kinds (plan.md §3 Rules).

import { todo } from "./io.ts";
import { DEFAULT_CONFIG } from "./types.ts";
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

export function buildView(cache: Cache, self: Self, now: Date, opts: ViewOptions = {}): TeamView {
  void cache;
  void self;
  void now;
  void (opts.ttlMinutes ?? DEFAULT_CONFIG.ttlMinutes);
  return todo("view.buildView");
}

export interface Overlap {
  session: ViewSession;
  /** The path is one of the session's files in flight, or it matches one of its claim globs. */
  via: "file" | "claim";
  /** The file or the glob that matched. */
  match: string;
}

/** The live sessions in the view that `path` (repo-relative, forward slashes) overlaps. One entry per session. */
export function overlaps(view: TeamView, path: string): Overlap[] {
  void view;
  void path;
  return todo("view.overlaps");
}
