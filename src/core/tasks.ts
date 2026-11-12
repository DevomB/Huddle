// T5.1. Atomic tasks: the one shared-writer case. Every state change is a
// compare-and-swap on refs/huddle/tasks/<id>, so exactly one claimer wins.

import type { Ctx } from "./context.ts";
import { todo } from "./io.ts";
import type { FailReason, Owner, TaskDoc } from "./types.ts";

/** Which session is acting; with ctx.identity it makes the Owner. */
export type Who = Pick<Owner, "session" | "agent">;

export type TaskResult =
  | { ok: true; task: TaskDoc }
  | {
      ok: false;
      reason: FailReason | "not-found" | "not-owner" | "already-claimed" | "already-done";
      /** The task as it stands now, when known. On a lost claim, task.owner is the winner. */
      task?: TaskDoc;
    };

export async function addTask(ctx: Ctx, title: string, who: Who): Promise<TaskResult> {
  void ctx;
  void title;
  void who;
  return todo("tasks.addTask");
}

/** Open tasks can be claimed, and so can claimed tasks whose owner session is no longer live. */
export async function claimTask(ctx: Ctx, id: string, who: Who): Promise<TaskResult> {
  void ctx;
  void id;
  void who;
  return todo("tasks.claimTask");
}

export async function finishTask(ctx: Ctx, id: string, who: Who): Promise<TaskResult> {
  void ctx;
  void id;
  void who;
  return todo("tasks.finishTask");
}

/** Gives a claimed task back (status "open", no owner). */
export async function dropTask(ctx: Ctx, id: string, who: Who): Promise<TaskResult> {
  void ctx;
  void id;
  void who;
  return todo("tasks.dropTask");
}
