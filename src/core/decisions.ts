// T4.1. Shared decisions: the write path. The read side (union of all actors'
// decisions minus superseded ones, newest first) is buildView in view.ts.
//
// A clone's decisions live in one document, refs/huddle/decisions/<actor>, and
// the remote holds the only durable copy: cache.json is a copy of it that may
// be missing or behind. So a decision is always added to what the remote holds
// at that moment, and pushed on the condition that the remote still holds
// exactly that. Recording a decision needs the network for that reason.

import type { Ctx } from "./context.ts";
import { cleanText, LIMITS, newId, normalizeDoc, serializeDoc } from "./docs.ts";
import { log } from "./log.ts";
import { ensureStateDir } from "./paths.ts";
import { readCache, writeCache } from "./store.ts";
import { FORCED_LOCK_WAIT_MS, withSyncLock } from "./sync.ts";
import { decisionsRef, parseRef, REF_PREFIX } from "./types.ts";
import { settleDecisions } from "./view.ts";
import type { ViewDecision } from "./view.ts";
import type { Cache, Decision, DecisionDoc, FailReason, Identity } from "./types.ts";

export type DecideFailure =
  | FailReason
  /** --supersedes names no decision in anybody's log. */
  | "unknown-supersedes"
  /** --supersedes names a decision that another decision has replaced already. */
  | "already-superseded"
  /** This clone's log is at its limit and nothing in it can be dropped. */
  | "full"
  /** The remote holds something at this clone's decisions ref that this version cannot read; it is left alone. */
  | "unreadable"
  /** A sync held the lock for too long. */
  | "busy"
  /** --resolve names a decision that is in no unresolved conflict. */
  | "no-conflict";

/** A decision and whose log it is in. */
export interface Attributed {
  decision: Decision;
  user: string;
}

export type DecideResult =
  | {
      ok: true;
      decision: Decision;
      dropped: number;
      /**
       * The same rule recorded once more for each other decision it replaces,
       * in the same push: with --resolve, one per competing candidate; with
       * --supersedes of a settled rule (ViewDecision.sameAs), one per id of it.
       */
      also?: Decision[];
      /** What the new decision(s) replaced. */
      replaced?: string[];
    }
  | {
      ok: false;
      reason: DecideFailure;
      /**
       * True when the failure came after the push was started. With "offline"
       * that leaves the outcome unknown: the remote may have taken the push
       * and the answer got lost.
       */
      sent?: boolean;
      /** With "already-superseded": what is in force in place of the decision that was named. */
      inForce?: Attributed[];
    };

/** Tries before a lost race is reported: each one starts from what the remote holds then. */
const ATTEMPTS = 3;

/** Every decision in every log in the cache, hidden ones included. */
export function allDecisions(cache: Cache): Decision[] {
  return Object.values(cache.refs).flatMap((entry) => (entry.doc?.kind === "decisions" ? entry.doc.decisions : []));
}

/** The same, each with the user of the log it is in. */
function attributed(cache: Cache): Attributed[] {
  return Object.values(cache.refs).flatMap((entry) =>
    entry.doc?.kind === "decisions" ? entry.doc.decisions.map((decision) => ({ decision, user: (entry.doc as DecisionDoc).user })) : [],
  );
}

/** True when every decision log in the cache could be read. A decision that is not found may otherwise be in the one that could not. */
function logsComplete(cache: Cache): boolean {
  const prefix = `${REF_PREFIX}decisions/`;
  return Object.entries(cache.refs).every(([name, entry]) => !name.startsWith(prefix) || entry.doc?.kind === "decisions");
}

/**
 * What stands in place of decision `id` now: the decisions in force at the
 * end of every chain of replacements that starts at it, newest first. Empty
 * when nothing has replaced it.
 */
export function replacementsOf(id: string, everyone: Attributed[]): Attributed[] {
  const replacing = new Map<string, Attributed[]>();
  for (const entry of everyone) {
    const target = entry.decision.supersedes;
    if (target === undefined || target === entry.decision.id) continue;
    replacing.set(target, [...(replacing.get(target) ?? []), entry]);
  }
  const ends = new Map<string, Attributed>();
  const seen = new Set<string>([id]);
  const queue = [...(replacing.get(id) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.decision.id)) continue;
    seen.add(next.decision.id);
    const further = replacing.get(next.decision.id) ?? [];
    if (further.length === 0) ends.set(next.decision.id, next);
    else queue.push(...further);
  }
  return [...ends.values()].sort((a, b) => b.decision.at.localeCompare(a.decision.at));
}

function logOf(identity: Identity, decisions: Decision[]): DecisionDoc {
  return { v: 0, kind: "decisions", actor: identity.actor, user: identity.user, decisions };
}

/**
 * Whether `decisions` make a log that can be published and read back. Over the
 * byte budget serializeDoc throws DocTooLargeError (docs.ts, CONTRACT 4.1),
 * which means "does not fit"; it is matched by name so that this also holds
 * with a docs.ts that still returns the long text.
 */
function fits(identity: Identity, decisions: Decision[]): boolean {
  if (decisions.length > LIMITS.decisions) return false;
  try {
    return Buffer.byteLength(serializeDoc(logOf(identity, decisions)), "utf8") <= LIMITS.docBytes;
  } catch (error) {
    if (error instanceof Error && (error.name === "DocTooLargeError" || error.constructor.name === "DocTooLargeError")) return false;
    throw error;
  }
}

/**
 * `mine` (this clone's log, newest first) cut down until it fits a document,
 * or null when it cannot be. Only decisions that nobody can see any more are
 * dropped, oldest first, and only when dropping them brings nothing back:
 *
 * - a decision is hidden when another decision, in any log, supersedes it;
 * - a hidden decision that supersedes a third one keeps that third one
 *   hidden, so it goes only when this log itself keeps another decision that
 *   supersedes the same one, or when the third one is gone from every log.
 *
 * Another clone's decision that supersedes the same one does not count. That
 * clone can be making the same judgement about this log at the same moment,
 * and the push is conditional on this clone's ref only: both would drop, and
 * the decision they were hiding would be back in every briefing.
 *
 * `everyone` is every decision in every log on the remote, this clone's
 * included or not. `complete` is false when some log could not be read: a
 * decision that is not found may then be in that log, and is treated as
 * still there.
 */
export function fitLog(identity: Identity, mine: Decision[], everyone: Decision[], complete = true): Decision[] | null {
  const mineIds = new Set(mine.map((decision) => decision.id));
  const others = everyone.filter((decision) => !mineIds.has(decision.id));
  const kept = [...mine];
  while (!fits(identity, kept)) {
    const everything = [...kept, ...others];
    const exists = new Set(everything.map((decision) => decision.id));
    const hidden = new Set<string>();
    for (const decision of everything) {
      if (decision.supersedes !== undefined && decision.supersedes !== decision.id) hidden.add(decision.supersedes);
    }
    const droppable = (decision: Decision): boolean => {
      if (!hidden.has(decision.id)) return false; // still in force
      const target = decision.supersedes;
      if (target === undefined || target === decision.id) return true;
      // Another decision of this log keeps the target hidden.
      if (kept.some((other) => other.supersedes === target && other.id !== decision.id && other.id !== target)) return true;
      // Or the target is gone, which is only known when every log was read.
      return complete && !exists.has(target);
    };
    // The log is newest first: look for the oldest from the end.
    let index = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (droppable(kept[i]!)) {
        index = i;
        break;
      }
    }
    if (index < 0) return null;
    kept.splice(index, 1);
  }
  return kept;
}

/**
 * Adds a decision to this clone's log on the remote.
 *
 * Under sync.lock: fetch, take this clone's log as the remote has it, put the
 * new decision in front, and push it on the condition that the ref has not
 * moved (compare-and-swap; "must not exist" for the first decision). If it
 * has moved, start again from the new state. Earlier decisions therefore
 * survive an empty or stale cache, and two `huddle decide` at once both land.
 *
 * `text` must already be one clean line within the limit; `agent` is the
 * agent of the session that decided.
 */
/** Every decision in the cache as the view sees it, with its log's actor and user. */
function viewDecisions(cache: Cache): ViewDecision[] {
  const out: ViewDecision[] = [];
  for (const [name, entry] of Object.entries(cache.refs)) {
    const where = parseRef(name);
    const doc = entry.doc;
    if (where?.kind !== "decisions" || doc?.kind !== "decisions" || doc.actor !== where.id) continue;
    for (const decision of doc.decisions) out.push({ ...decision, actor: doc.actor, user: doc.user });
  }
  return out;
}

export async function addDecision(
  ctx: Ctx,
  text: string,
  opts: { supersedes?: string; resolve?: string; agent?: string } = {},
): Promise<DecideResult> {
  const { paths, identity, transport, now } = ctx;
  const clean = cleanText(text, LIMITS.decisionText);
  if (clean === "") throw new TypeError("a decision needs text");
  const ref = decisionsRef(identity.actor);
  await ensureStateDir(paths);

  const locked = await withSyncLock(paths, FORCED_LOCK_WAIT_MS, async (): Promise<DecideResult> => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const cache = await readCache(paths);
      const fetched = await transport.fetchAll(new Map(Object.entries(cache.refs).map(([name, entry]) => [name, entry.sha])));
      if (!fetched.ok) {
        log(paths, "decide", `fetch failed: ${fetched.reason}`);
        return { ok: false, reason: fetched.reason };
      }
      for (const [name, entry] of fetched.changed) cache.refs[name] = { sha: entry.sha, doc: entry.doc };
      for (const name of fetched.removed) delete cache.refs[name];
      cache.fetchedAt = now.toISOString();

      const current = cache.refs[ref];
      if (current && current.doc?.kind !== "decisions") {
        await writeCache(paths, cache);
        log(paths, "decide", `${ref} holds something this version cannot read; not replacing it`);
        return { ok: false, reason: "unreadable" };
      }
      const mine = current?.doc?.kind === "decisions" ? current.doc.decisions : [];
      const everyone = allDecisions(cache);
      if (opts.supersedes !== undefined) {
        if (!everyone.some((decision) => decision.id === opts.supersedes)) {
          await writeCache(paths, cache);
          return { ok: false, reason: "unknown-supersedes" };
        }
        // Replacing a decision that was replaced already would leave two rules in force with nothing saying so.
        const inForce = replacementsOf(opts.supersedes, attributed(cache));
        if (inForce.length > 0) {
          await writeCache(paths, cache);
          return { ok: false, reason: "already-superseded", inForce };
        }
      }

      // What the new rule replaces: the one decision named, every id of a settled rule it names, or
      // with --resolve every candidate of the conflict. One decision per replaced id, all in this push.
      const settled = settleDecisions(viewDecisions(cache));
      let targets: string[] = opts.supersedes === undefined ? [] : [opts.supersedes];
      if (opts.supersedes !== undefined) {
        const rule = settled.inForce.find((candidate) => candidate.id === opts.supersedes || candidate.sameAs?.includes(opts.supersedes!));
        if (rule?.sameAs) targets = [rule.id, ...rule.sameAs];
      }
      if (opts.resolve !== undefined) {
        const conflict = settled.conflicts.find((candidate) => candidate.over === opts.resolve || candidate.candidates.some((c) => c.id === opts.resolve));
        if (!conflict) {
          await writeCache(paths, cache);
          return { ok: false, reason: "no-conflict" };
        }
        // An end of a chain is replaced directly. In a loop with no end, every member is.
        const ends = conflict.candidates.map((candidate) => candidate.id);
        targets = ends;
      }

      const taken = new Set(everyone.map((decision) => decision.id));
      const fresh = (): string => {
        let id = newId();
        while (taken.has(id)) id = newId();
        taken.add(id);
        return id;
      };
      const made = (target: string | undefined): Decision => {
        const next: Decision = { id: fresh(), at: now.toISOString(), agent: cleanText(opts.agent, LIMITS.name) || "manual", text: clean };
        if (target !== undefined) next.supersedes = target;
        return next;
      };
      const [decision, ...also] = targets.length === 0 ? [made(undefined)] : targets.map(made);
      if (decision === undefined) throw new Error("unreachable: no decision to record");

      const kept = fitLog(identity, [decision, ...also, ...mine], everyone, logsComplete(cache));
      if (kept === null) {
        await writeCache(paths, cache);
        return { ok: false, reason: "full" };
      }

      const doc = logOf(identity, kept);
      const published = await transport.publish(ref, doc, current ? current.sha : "absent");
      if (published.ok) {
        cache.refs[ref] = { sha: published.sha, doc: normalizeDoc(doc) };
        await writeCache(paths, cache);
        const result: Extract<DecideResult, { ok: true }> = { ok: true, decision, dropped: mine.length + 1 + also.length - kept.length };
        if (also.length > 0) result.also = also;
        if (targets.length > 0) result.replaced = targets;
        return result;
      }
      await writeCache(paths, cache);
      log(paths, "decide", `publish failed: ${published.reason} (attempt ${attempt} of ${ATTEMPTS})`);
      if (published.reason !== "lost-race") return { ok: false, reason: published.reason, sent: true };
    }
    return { ok: false, reason: "lost-race", sent: true };
  });
  return locked.acquired ? locked.value : { ok: false, reason: "busy" };
}
