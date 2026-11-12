// T5.1. Atomic tasks: the one shared-writer case. Every state change is a
// compare-and-swap on refs/huddle/tasks/<id>, so exactly one claimer wins.
//
// Every change follows the same three steps:
//   1. Sync, so the decision is made on what the remote holds now and not on a
//      cache that may be 15 seconds old.
//   2. Decide from one snapshot of the cache: the task's document and the sha
//      it was read at come from the same read.
//   3. Publish the new document with that sha as the expectation. If the ref
//      moved in between, the push is refused, nothing is overwritten, and the
//      caller is told what the task looks like now.
//
// A claim holds only while the claiming session is live (plan.md §3 Rules).
// claimTask therefore records the session and lets the sync in step 1 publish
// it before the claim itself is pushed: a claim must never be visible before
// its owner is, or a teammate would see it as abandoned and take it.

import type { Ctx } from "./context.ts";
import { LIMITS, cleanText, newId, normalizeDoc } from "./docs.ts";
import { UsageError } from "./io.ts";
import { log } from "./log.ts";
import { toActorDoc } from "./session.ts";
import { readCache, readLocal, touchSession, writeCache } from "./store.ts";
import { sync, withSyncLock } from "./sync.ts";
import type { SyncResult } from "./sync.ts";
import { actorRef, taskRef } from "./types.ts";
import type { FailReason, Owner, Sha, TaskDoc } from "./types.ts";
import { buildView } from "./view.ts";
import type { ViewTask } from "./view.ts";

/** Which session is acting; with ctx.identity it makes the Owner. */
export type Who = Pick<Owner, "session" | "agent">;

/**
 * Why the sync before a change did not leave fresh state (see syncFailure):
 * the remote could not be reached ("offline") or refused us ("denied"), another
 * sync of this clone held the lock for the whole wait ("busy"), or the round
 * ran and did not finish ("sync-failed").
 */
export type SyncFailure = "offline" | "denied" | "busy" | "sync-failed";

export type TaskResult =
  | { ok: true; task: TaskDoc }
  | {
      ok: false;
      reason: FailReason | SyncFailure | "not-found" | "not-owner" | "already-claimed" | "already-done";
      /** The task as it stands now, when known. On a lost claim, task.owner is the winner. */
      task?: TaskDoc;
      /** With a claimed `task`: whether its owner's session is live. False means the task may be claimed. */
      ownerLive?: boolean;
    };

/** A random id colliding with an existing task is a one in 2^40 event; this many tries is plenty. */
const ADD_ATTEMPTS = 3;
/** How long to wait for a running sync before giving up on recording our own change in the cache. */
const CACHE_LOCK_WAIT_MS = 5_000;

function ownerOf(ctx: Ctx, who: Who): Owner {
  return { actor: ctx.identity.actor, user: ctx.identity.user, session: who.session, agent: who.agent };
}

function owns(task: TaskDoc, me: Owner): boolean {
  return task.owner !== null && task.owner.actor === me.actor && task.owner.session === me.session;
}

/** A view task without its computed liveness: the document as it is stored. */
function stored(task: ViewTask): TaskDoc {
  return {
    v: 0,
    kind: "task",
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner === null ? null : { ...task.owner },
    createdBy: { ...task.createdBy },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * Why a sync round did not leave the cache current and this clone's sessions
 * published, or null when it did. A change is only decided on a cache that was
 * just refreshed, so anything short of that stops it. The reason says whether
 * the remote had anything to do with it:
 *
 * - "offline", "denied": the remote could not be reached, or refused us. A
 *   remote that refuses this clone's own document will refuse a task too.
 * - "busy": the round never ran, because another sync of this clone held the
 *   lock for the whole wait. The remote was not asked.
 * - "sync-failed": the round ran and did not finish. This clone's own document
 *   lost its push to another writer (the remote was reached), or something
 *   failed on our side. The log says which.
 */
export function syncFailure(result: SyncResult): SyncFailure | null {
  if (result.error === "offline" || result.error === "denied") return result.error;
  if (result.error) return "sync-failed";
  if (!result.fetched) return "busy";
  return null;
}

/**
 * Brings the cache up to date with the remote, and publishes this clone's
 * sessions if they changed. Null when the cache is now current.
 */
async function refresh(ctx: Ctx): Promise<SyncFailure | null> {
  const result = await sync(ctx, { force: true });
  const failed = syncFailure(result);
  if (failed === "busy") log(ctx.paths, "tasks", `no fresh state: the sync was skipped (${result.skipped ?? "unknown reason"})`);
  else if (failed === "sync-failed") log(ctx.paths, "tasks", `no fresh state: the sync did not finish (${result.error ?? "unknown reason"})`);
  return failed;
}

/**
 * The task and the sha it is at, from a single read of the cache, with
 * liveness worked out as `session` of this clone sees it. Reads only local
 * files; the callers sync first. Exported for its test.
 */
export async function lookup(ctx: Ctx, id: string, session: string): Promise<{ task: ViewTask; sha: Sha } | null> {
  const [cache, local] = await Promise.all([readCache(ctx.paths), readLocal(ctx.paths)]);
  const sha = cache.refs[taskRef(id)]?.sha;
  // This clone's own sessions are judged by local state, as in currentView. Its
  // published document can trail that by a heartbeat, and a task held by a
  // session working in the next worktree must not look abandoned from here.
  const ownRef = actorRef(ctx.identity.actor);
  const own = normalizeDoc(toActorDoc(ctx.identity, local.sessions, ctx.now, ctx.config.ttlMinutes));
  if (own) cache.refs[ownRef] = { sha: cache.refs[ownRef]?.sha ?? "", doc: own };
  const view = buildView(cache, { actor: ctx.identity.actor, session }, ctx.now, { ttlMinutes: ctx.config.ttlMinutes });
  const task = view.tasks.find((candidate) => candidate.id === id);
  return task && sha ? { task, sha } : null;
}

/** Records a change we just made, so `huddle task list` shows it without waiting for the next sync. */
async function remember(ctx: Ctx, task: TaskDoc, sha: Sha): Promise<void> {
  try {
    // The cache belongs to sync; its lock keeps a running round from writing an older copy over this.
    const held = await withSyncLock(ctx.paths, CACHE_LOCK_WAIT_MS, async () => {
      const cache = await readCache(ctx.paths);
      cache.refs[taskRef(task.id)] = { sha, doc: task };
      await writeCache(ctx.paths, cache);
    });
    if (!held.acquired) log(ctx.paths, "tasks", `task ${task.id} changed on the remote; the cache will catch up on the next sync`);
  } catch (error) {
    // The change is on the remote, which is what counts. The next sync brings the cache along.
    log(ctx.paths, "tasks", `could not record task ${task.id} in the cache`, error);
  }
}

/**
 * Replaces the task with `next` if it is still at `expect`. When it is not,
 * someone changed it first: nothing is overwritten and the result carries the
 * task as it is now.
 */
async function swap(ctx: Ctx, who: Who, next: TaskDoc, expect: Sha): Promise<TaskResult> {
  const published = await ctx.transport.publish(taskRef(next.id), next, expect);
  if (published.ok) {
    // What was published is the normalized document; hand back the same thing.
    const task = (normalizeDoc(next) as TaskDoc | null) ?? next;
    await remember(ctx, task, published.sha);
    return { ok: true, task };
  }
  if (published.reason !== "lost-race") return { ok: false, reason: published.reason };

  await refresh(ctx); // if this fails, the task below is the best we know
  const now = await lookup(ctx, next.id, who.session);
  return now ? { ok: false, reason: "lost-race", task: stored(now.task), ownerLive: now.task.ownerLive } : { ok: false, reason: "lost-race" };
}

/**
 * A lost race leaves the task in a state someone else chose. Sometimes that is
 * the very state the caller was after: the same session claimed it from another
 * terminal, or the task it wanted to give back is open already. And a task that
 * was finished in that moment is reported as finished, whoever did it. Anything
 * else stays a lost race, with the task as it is now.
 */
function settle(result: TaskResult, wanted: (now: TaskDoc) => boolean): TaskResult {
  if (result.ok || result.reason !== "lost-race" || !result.task) return result;
  if (wanted(result.task)) return { ok: true, task: result.task };
  if (result.task.status === "done") return { ok: false, reason: "already-done", task: result.task };
  return result;
}

/** Creates an open task with a fresh id. Throws a UsageError when the title is empty. */
export async function addTask(ctx: Ctx, title: string, who: Who): Promise<TaskResult> {
  const clean = cleanText(title, LIMITS.taskTitle);
  if (!clean) throw new UsageError("a task needs a title");
  const at = ctx.now.toISOString();
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt++) {
    const task: TaskDoc = {
      v: 0,
      kind: "task",
      id: newId(),
      title: clean,
      status: "open",
      owner: null,
      createdBy: ownerOf(ctx, who),
      createdAt: at,
      updatedAt: at,
    };
    const published = await ctx.transport.publish(taskRef(task.id), task, "absent");
    if (published.ok) {
      await remember(ctx, task, published.sha);
      return { ok: true, task };
    }
    if (published.reason !== "lost-race") return { ok: false, reason: published.reason };
    // That id exists already. Try another.
  }
  return { ok: false, reason: "lost-race" };
}

/**
 * Open tasks can be claimed, and so can claimed tasks whose owner session is
 * no longer live. Claiming a task this session already holds succeeds and
 * changes nothing.
 */
export async function claimTask(ctx: Ctx, id: string, who: Who): Promise<TaskResult> {
  const me = ownerOf(ctx, who);
  // The session must exist and be published before the claim is: see the header.
  await touchSession(ctx.paths, { id: who.session, worktree: ctx.paths.worktree, agent: who.agent, seenAt: ctx.now.toISOString() });
  const failed = await refresh(ctx);
  if (failed) return { ok: false, reason: failed };

  const found = await lookup(ctx, id, who.session);
  if (!found) return { ok: false, reason: "not-found" };
  const task = stored(found.task);
  if (task.status === "done") return { ok: false, reason: "already-done", task };
  if (task.status === "claimed") {
    if (owns(task, me)) return { ok: true, task };
    if (found.task.ownerLive) return { ok: false, reason: "already-claimed", task, ownerLive: true };
    // Claimed, but by a session that is gone: it may be claimed again.
  }
  const claimed = await swap(ctx, who, { ...task, status: "claimed", owner: me, updatedAt: ctx.now.toISOString() }, found.sha);
  return settle(claimed, (now) => now.status === "claimed" && owns(now, me));
}

/**
 * Marks a task done. The session that claimed it can, and anyone can finish a
 * task nobody holds. A task claimed by another session, live or not, has to
 * be claimed first.
 */
export async function finishTask(ctx: Ctx, id: string, who: Who): Promise<TaskResult> {
  const me = ownerOf(ctx, who);
  const failed = await refresh(ctx);
  if (failed) return { ok: false, reason: failed };

  const found = await lookup(ctx, id, who.session);
  if (!found) return { ok: false, reason: "not-found" };
  const task = stored(found.task);
  if (task.status === "done") return { ok: false, reason: "already-done", task };
  if (task.status === "claimed" && !owns(task, me)) return { ok: false, reason: "not-owner", task, ownerLive: found.task.ownerLive };
  const finished = await swap(ctx, who, { ...task, status: "done", owner: me, updatedAt: ctx.now.toISOString() }, found.sha);
  return settle(finished, () => false);
}

/** Gives a claimed task back (status "open", no owner). Dropping a task that is already open succeeds and changes nothing. */
export async function dropTask(ctx: Ctx, id: string, who: Who): Promise<TaskResult> {
  const me = ownerOf(ctx, who);
  const failed = await refresh(ctx);
  if (failed) return { ok: false, reason: failed };

  const found = await lookup(ctx, id, who.session);
  if (!found) return { ok: false, reason: "not-found" };
  const task = stored(found.task);
  if (task.status === "done") return { ok: false, reason: "already-done", task };
  if (task.status === "open") return { ok: true, task };
  if (!owns(task, me)) return { ok: false, reason: "not-owner", task, ownerLive: found.task.ownerLive };
  const dropped = await swap(ctx, who, { ...task, status: "open", owner: null, updatedAt: ctx.now.toISOString() }, found.sha);
  return settle(dropped, (now) => now.status === "open");
}
