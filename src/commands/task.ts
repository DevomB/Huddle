// T5.1. huddle task add | list | claim | done | drop

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { cleanText } from "../core/docs.ts";
import { CliError, EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderTasks } from "../core/render.ts";
import { currentView, resolveSession } from "../core/session.ts";
import { sync } from "../core/sync.ts";
import { addTask, claimTask, dropTask, finishTask } from "../core/tasks.ts";
import type { SyncFailure, TaskResult, Who } from "../core/tasks.ts";
import { ID_RE } from "../core/types.ts";
import type { Owner, TaskDoc } from "../core/types.ts";

export const summary = "Shared tasks: add | list | claim | done | drop";

const USAGE = 'huddle task add "<title>" | list [--json] [--cached] | claim <id> | done <id> | drop <id>';

type Verb = "claim" | "done" | "drop";

export async function run(args: string[], io: Io): Promise<number> {
  // `huddle task` and `huddle task --json` both mean list.
  const first = args[0];
  if (first === undefined || first.startsWith("-")) return list(args, io);
  const rest = args.slice(1);
  switch (first) {
    case "list":
      return list(rest, io);
    case "add":
      return add(rest, io);
    case "claim":
    case "done":
    case "drop":
      return change(first, rest, io);
    default:
      throw new UsageError(`unknown task command "${first}"\nUsage: ${USAGE}`);
  }
}

async function acting(ctx: Ctx): Promise<Who> {
  const me = await resolveSession(ctx);
  return { session: me.id, agent: me.agent };
}

/** "bob / codex", the way the briefing names a teammate. Owner strings were cleaned when the task was read. */
function name(owner: Owner): string {
  return `${cleanText(owner.user, 40) || "unknown"} / ${cleanText(owner.agent, 30) || "unknown"}`;
}

function label(task: TaskDoc): string {
  return `[${task.id}] ${task.title}`;
}

/**
 * Why a change stopped before anything was decided, in the user's words. Each
 * one says what was at fault, because the next step differs: wait for the
 * network, fix the remote, or just run the command again.
 */
export function notSynced(reason: SyncFailure, remote: string, logFile: string): string {
  switch (reason) {
    case "offline":
      return `could not reach remote "${remote}"; nothing was changed`;
    case "denied":
      return `remote "${remote}" refused a push to refs/huddle/*; nothing was changed. Run "huddle doctor"`;
    case "busy":
      return "another huddle command is still syncing in this clone; nothing was changed. Run the command again";
    case "sync-failed":
      return `remote "${remote}" answered, but this clone's own state could not be published; nothing was changed. Run the command again; if it keeps failing, the reason is in ${logFile}`;
  }
}

function syncStopped(ctx: Ctx, reason: SyncFailure): CliError {
  return new CliError(notSynced(reason, ctx.config.remote, ctx.paths.logFile));
}

async function add(args: string[], io: Io): Promise<number> {
  const { positionals } = parse(args, {}, USAGE);
  const title = positionals.join(" ");
  if (cleanText(title, 1) === "") throw new UsageError(`a task needs a title\nUsage: ${USAGE}`);
  const ctx = await openContext(io);
  const result = await addTask(ctx, title, await acting(ctx));
  if (result.ok) {
    io.out(`added ${label(result.task)}`);
    return EXIT.OK;
  }
  if (result.reason === "offline" || result.reason === "denied") throw syncStopped(ctx, result.reason);
  throw new CliError(`could not add the task (${result.reason}); try again`);
}

async function list(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    { json: { type: "boolean", default: false }, cached: { type: "boolean", default: false } },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);
  const ctx = await openContext(io);

  // Refreshed like `huddle status`: throttled, and a failure just means cached data.
  let warning = "";
  if (!values.cached) {
    const result = await sync(ctx);
    if (result.error === "offline") warning = `could not reach remote "${ctx.config.remote}"; showing the last known state`;
    else if (result.error === "denied") warning = `remote "${ctx.config.remote}" refused a push to refs/huddle/*; run "huddle doctor"`;
  }
  const me = await resolveSession(ctx);
  const view = await currentView(ctx, me.id);
  io.out(values.json ? JSON.stringify({ fetchedAt: view.fetchedAt, tasks: view.tasks }, null, 2) : renderTasks(view));
  if (warning) io.err(`huddle: ${warning}`);
  return EXIT.OK;
}

async function change(verb: Verb, args: string[], io: Io): Promise<number> {
  const { positionals } = parse(args, {}, USAGE);
  const id = positionals[0];
  if (id === undefined || positionals.length > 1) throw new UsageError(`huddle task ${verb} takes one task id\nUsage: ${USAGE}`);
  if (!ID_RE.test(id)) throw new UsageError(`"${cleanText(id, 40)}" is not a task id; see "huddle task list"`);

  const ctx = await openContext(io);
  const who = await acting(ctx);
  const result = verb === "claim" ? await claimTask(ctx, id, who) : verb === "done" ? await finishTask(ctx, id, who) : await dropTask(ctx, id, who);

  if (result.ok) {
    const task = result.task;
    if (verb === "claim") io.out(`claimed ${label(task)}`);
    else if (verb === "done") io.out(`done ${label(task)}`);
    else io.out(`dropped ${label(task)}; it is open again`);
    return EXIT.OK;
  }
  return refused(ctx, verb, id, result, io);
}

/** Says why a change did not happen. When someone else holds or took the task, the message names them. */
function refused(ctx: Ctx, verb: Verb, id: string, result: Extract<TaskResult, { ok: false }>, io: Io): number {
  const task = result.task;
  switch (result.reason) {
    case "offline":
    case "denied":
    case "busy":
    case "sync-failed":
      throw syncStopped(ctx, result.reason);
    case "not-found":
      throw new CliError(`no task ${id}; see "huddle task list"`);
    case "already-done":
      if (task) io.out(`${label(task)} is already done${task.owner ? ` (by ${name(task.owner)})` : ""}`);
      // Finishing a finished task is not a conflict. Claiming or dropping one is.
      return verb === "done" ? EXIT.OK : EXIT.CONFLICT;
    case "already-claimed":
      if (task?.owner) io.out(`${label(task)} is taken by ${name(task.owner)}`);
      return EXIT.CONFLICT;
    case "not-owner":
      if (task?.owner) {
        const holder = `${label(task)} is held by ${name(task.owner)}, not by this session`;
        // Only a task whose owner is gone can be taken over; saying so for a live owner would send the caller into a wall.
        io.out(result.ownerLive === false ? `${holder}. That session is gone, so you can take the task over: huddle task claim ${id}` : holder);
      }
      return EXIT.CONFLICT;
    case "lost-race":
      if (!task) io.out(`task ${id} was changed by someone else at the same moment and is gone now`);
      else if (verb === "claim" && task.status === "claimed" && task.owner) io.out(`${label(task)} was claimed first by ${name(task.owner)}`);
      else io.out(`${label(task)} was changed by someone else at the same moment; it is now ${describe(task)}. Nothing was changed`);
      return EXIT.CONFLICT;
  }
}

function describe(task: TaskDoc): string {
  if (task.status === "open") return "open";
  const by = task.owner ? ` by ${name(task.owner)}` : "";
  return task.status === "done" ? `done${by}` : `claimed${by}`;
}
