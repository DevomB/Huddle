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
import { decisionsRef } from "./types.ts";
import type { Cache, Decision, DecisionDoc, FailReason, Identity } from "./types.ts";

export type DecideFailure =
  | FailReason
  /** --supersedes names no decision in anybody's log. */
  | "unknown-supersedes"
  /** This clone's log is at its limit and nothing in it can be dropped. */
  | "full"
  /** The remote holds something at this clone's decisions ref that this version cannot read; it is left alone. */
  | "unreadable"
  /** A sync held the lock for too long. */
  | "busy";

export type DecideResult = { ok: true; decision: Decision; dropped: number } | { ok: false; reason: DecideFailure };

/** Tries before a lost race is reported: each one starts from what the remote holds then. */
const ATTEMPTS = 3;

/** Every decision in every log in the cache, hidden ones included. */
export function allDecisions(cache: Cache): Decision[] {
  return Object.values(cache.refs).flatMap((entry) => (entry.doc?.kind === "decisions" ? entry.doc.decisions : []));
}

function logOf(identity: Identity, decisions: Decision[]): DecisionDoc {
  return { v: 0, kind: "decisions", actor: identity.actor, user: identity.user, decisions };
}

function fits(identity: Identity, decisions: Decision[]): boolean {
  return decisions.length <= LIMITS.decisions && Buffer.byteLength(serializeDoc(logOf(identity, decisions)), "utf8") <= LIMITS.docBytes;
}

/**
 * `mine` (this clone's log, newest first) cut down until it fits a document,
 * or null when it cannot be. Only decisions that nobody can see any more are
 * dropped, oldest first, and only when dropping them brings nothing back:
 *
 * - a decision is hidden when another decision, in any log, supersedes it;
 * - dropping a hidden decision that is the only one superseding a third would
 *   make that third one visible again, so such a decision stays.
 *
 * `others` is every decision in the other clones' logs.
 */
export function fitLog(identity: Identity, mine: Decision[], others: Decision[]): Decision[] | null {
  const kept = [...mine];
  while (!fits(identity, kept)) {
    const everything = [...kept, ...others];
    const exists = new Set(everything.map((decision) => decision.id));
    const supersededBy = new Map<string, number>();
    for (const decision of everything) {
      if (decision.supersedes !== undefined && decision.supersedes !== decision.id) {
        supersededBy.set(decision.supersedes, (supersededBy.get(decision.supersedes) ?? 0) + 1);
      }
    }
    const droppable = (decision: Decision): boolean => {
      if (!supersededBy.has(decision.id)) return false; // still in force
      const target = decision.supersedes;
      if (target === undefined || target === decision.id || !exists.has(target)) return true;
      return (supersededBy.get(target) ?? 0) > 1; // something else keeps the target hidden
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
export async function addDecision(ctx: Ctx, text: string, opts: { supersedes?: string; agent?: string } = {}): Promise<DecideResult> {
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
      if (opts.supersedes !== undefined && !everyone.some((decision) => decision.id === opts.supersedes)) {
        await writeCache(paths, cache);
        return { ok: false, reason: "unknown-supersedes" };
      }

      const taken = new Set(everyone.map((decision) => decision.id));
      let id = newId();
      while (taken.has(id)) id = newId();
      const decision: Decision = { id, at: now.toISOString(), agent: cleanText(opts.agent, LIMITS.name) || "manual", text: clean };
      if (opts.supersedes !== undefined) decision.supersedes = opts.supersedes;

      const mineIds = new Set(mine.map((entry) => entry.id));
      const kept = fitLog(identity, [decision, ...mine], everyone.filter((entry) => !mineIds.has(entry.id)));
      if (kept === null) {
        await writeCache(paths, cache);
        return { ok: false, reason: "full" };
      }

      const doc = logOf(identity, kept);
      const published = await transport.publish(ref, doc, current ? current.sha : "absent");
      if (published.ok) {
        cache.refs[ref] = { sha: published.sha, doc: normalizeDoc(doc) };
        await writeCache(paths, cache);
        return { ok: true, decision, dropped: mine.length + 1 - kept.length };
      }
      await writeCache(paths, cache);
      log(paths, "decide", `publish failed: ${published.reason} (attempt ${attempt} of ${ATTEMPTS})`);
      if (published.reason !== "lost-race") return { ok: false, reason: published.reason };
    }
    return { ok: false, reason: "lost-race" };
  });
  return locked.acquired ? locked.value : { ok: false, reason: "busy" };
}
