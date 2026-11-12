// T1.3. Text for humans (status) and for agents (briefings, warnings). Pure.
//
// Everything rendered for an agent is teammates' text: data, never
// instructions. Every briefing and warning starts with the [huddle] label line
// that says so (plan.md §2 decision 7, §3 Briefing shape).

import { todo } from "./io.ts";
import type { Seen } from "./types.ts";
import type { Overlap, TeamView } from "./view.ts";

/**
 * Agents cap injected hook context (Claude Code: 10,000 characters, after
 * which it is replaced by a file path and a preview), so the default sits
 * well under that.
 */
export const DEFAULT_BRIEFING_CHARS = 4000;

/** `huddle status`: who is live, on which branch, doing what, touching which files; decisions; tasks. */
export function renderStatus(view: TeamView): string {
  void view;
  return todo("render.renderStatus");
}

export interface BriefingOptions {
  /**
   * What this session was last shown. Null or missing: render the full
   * briefing. Otherwise render only what changed since then.
   */
  since?: Seen | null;
  /** Hard cap on `text`. Truncation keeps the label line and the footer. */
  maxChars?: number;
}

export interface Briefing {
  /** "" when there is nothing (new) to say; the hook then injects nothing. */
  text: string;
  /** Pass back as `since` next time (store.writeSeen). Describes the whole view, not only what was rendered. */
  seen: Seen;
}

export function renderBriefing(view: TeamView, opts: BriefingOptions = {}): Briefing {
  void view;
  void opts;
  return todo("render.renderBriefing");
}

/**
 * The warning for one path that overlaps other sessions: used by `huddle check`
 * and by the pre-edit hook. "" when `found` is empty.
 */
export function renderOverlaps(path: string, found: Overlap[], now: Date): string {
  void path;
  void found;
  void now;
  return todo("render.renderOverlaps");
}
