// T5.1. huddle task add | list | claim | done | drop

import { parse } from "../core/args.ts";
import { openContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { cleanText, LIMITS } from "../core/docs.ts";
import { CliError, EXIT, UsageError } from "../core/io.ts";
import type { Io } from "../core/io.ts";
import { renderTasks, shownText } from "../core/render.ts";
import { envelope, readTeam, refreshOutcome, resolveSession } from "../core/session.ts";
import type { RefreshOutcome } from "../core/view.ts";
import { sync } from "../core/sync.ts";
import { addTask, claimTask, dropTask, finishTask } from "../core/tasks.ts";
import type { SyncFailure, TaskResult, Who } from "../core/tasks.ts";
import { scrubSecrets } from "../hooks/intent.ts";
import { ID_RE } from "../core/types.ts";
import type { Owner, TaskDoc } from "../core/types.ts";

export const summary = "Shared tasks: add | list | claim | done | drop";

const USAGE = 'huddle task add [--id <id>] "<title>" | list [--json] [--cached] | claim <id> | done <id> | drop <id>';

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

/**
 * "bob / codex", the way the briefing names a teammate. A teammate's text, and
 * an agent may be the one reading it: shown the way the renderer shows it
 * (render.ts, shownText), one line and without "<" or ">".
 */
function name(owner: Owner): string {
  return `${shownText(owner.user, LIMITS.name) || "unknown"} / ${shownText(owner.agent, LIMITS.name) || "unknown"}`;
}

/** "[id] title", shown like name(). */
function label(task: TaskDoc): string {
  return `[${shownText(task.id, 40)}] ${shownText(task.title, LIMITS.taskTitle)}`;
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
  const { values, positionals } = parse(args, { id: { type: "string" } }, USAGE);
  const title = positionals.join(" ");
  if (cleanText(title, 1) === "") throw new UsageError(`a task needs a title\nUsage: ${USAGE}`);
  const id = values.id?.trim();
  if (id !== undefined && !ID_RE.test(id)) throw new UsageError(`"${shownText(id, 40)}" is not a task id: 8 characters, a-z and 2-7\nUsage: ${USAGE}`);
  // A task title is read by everyone who can read the repository, like a decision, and a task
  // is never removed. What looks like a credential (hooks/intent.ts; best effort) is refused
  // the way `huddle decide` refuses it, before anything is published.
  const typed = cleanText(title, LIMITS.taskTitle);
  const scrubbed = durableScrub(typed);
  if (scrubbed !== typed) {
    throw new UsageError(
      "part of this title looks like a credential, so the task was NOT added: a task is read by everyone who can read the repository and is never removed. " +
        `What huddle would have published:\n  ${shownText(scrubbed, LIMITS.taskTitle)}\nSay it without that part, for example by naming the file or the setting that holds the value.`,
    );
  }
  const ctx = await openContext(io);
  const result = await addTask(ctx, title, await acting(ctx), id === undefined ? {} : { id });
  if (result.ok) {
    io.out(`added ${label(result.task)}`);
    if (result.confirmed === "existing") io.err(`huddle: task ${result.task.id} was already on the remote with this title; it was not added twice`);
    else if (result.confirmed === "read-back") io.err(`huddle: remote "${ctx.config.remote}" did not answer in time, so huddle read it back: the task is there`);
    return EXIT.OK;
  }
  switch (result.reason) {
    case "offline":
    case "denied":
    case "busy":
    case "sync-failed":
      throw syncStopped(ctx, result.reason);
    case "unknown":
      throw new CliError(uncertain(ctx, "add", result.task));
    case "lost-race":
      if (id !== undefined) {
        io.out(result.task ? `task id ${id} is taken by another task: ${label(result.task)}. Nothing was added` : `task id ${id} is taken. Nothing was added`);
        return EXIT.CONFLICT;
      }
      throw new CliError("could not find a free task id; nothing was added. Run the command again");
    default:
      throw new CliError(`could not add the task (${result.reason}); nothing was added`);
  }
}

/**
 * The push went out and no answer came back, and reading the remote back did
 * not settle it. Says so, names the task, and gives a next step that is safe
 * whichever way it went: a rerun of claim, done or drop checks the task first
 * and changes nothing that is already changed; a create is only safe to run
 * again under the same id.
 */
export function uncertain(ctx: Pick<Ctx, "config">, verb: Verb | "add", task: TaskDoc | undefined): string {
  const remote = ctx.config.remote;
  const named = task ? label(task) : "the task";
  if (verb === "add") {
    const id = task ? shownText(task.id, 40) : "<id>";
    return (
      `remote "${remote}" stopped answering after task ${named} was sent, so it may or may not have been created. ` +
      `Do not add it again as a new task. Check with "huddle sync" and then "huddle task list"; if [${id}] is not there, run "huddle task add --id ${id}" with the same title: under that id it cannot be created twice`
    );
  }
  const id = task ? shownText(task.id, 40) : "<id>";
  return (
    `remote "${remote}" stopped answering after the change to task ${named} was sent, so it may or may not have been made. ` +
    `Running "huddle task ${verb} ${id}" again is safe: it looks at the task first and changes nothing that is already changed. "huddle sync" and then "huddle task list" show where it stands`
  );
}

/**
 * The title as huddle would publish it with what looks like a credential taken
 * out. One place, so the detector for durable text (decisions, task titles)
 * can change without touching the policy above.
 */
function durableScrub(text: string): string {
  return scrubSecrets(text, { durable: true });
}

async function list(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    { json: { type: "boolean", default: false }, cached: { type: "boolean", default: false } },
    USAGE,
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\nUsage: ${USAGE}`);
  const ctx = await openContext(io);

  // Refreshed like `huddle status`: throttled, and a failure just means cached data, which the warnings say.
  let refresh: RefreshOutcome = "none";
  if (!values.cached) refresh = refreshOutcome(await sync(ctx));
  const me = await resolveSession(ctx);
  const team = await readTeam(ctx, me.id, refresh);
  const view = team.view;
  io.out(values.json ? JSON.stringify({ fetchedAt: view.fetchedAt, tasks: view.tasks, ...envelope(team) }, null, 2) : renderTasks(view));
  for (const warning of team.warnings) io.err(`huddle: ${warning}`);
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
    if (result.confirmed === "read-back") io.err(`huddle: remote "${ctx.config.remote}" did not answer in time, so huddle read it back: the change is there`);
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
    case "unknown":
      throw new CliError(uncertain(ctx, verb, task));
    case "not-found":
      throw new CliError(`no task ${id}; see "huddle task list"`);
    case "already-done":
      if (task) io.out(`${label(task)} is already done${task.owner ? ` (by ${name(task.owner)})` : ""}`);
      // Finishing a finished task is not a conflict. Claiming or dropping one is.
      return verb === "done" ? EXIT.OK : EXIT.CONFLICT;
    case "already-claimed":
      if (task?.owner) io.out(`${label(task)} is taken by ${name(task.owner)}`);
      return EXIT.CONFLICT;
    case "owner-unknown":
      throw new CliError(
        `${task ? label(task) : `task ${id}`} is held by ${task?.owner ? name(task.owner) : "another session"}, and whether that session is still active cannot be seen from here ` +
          "(its clone's published state is missing or unreadable, or this clone has no team state yet). It was NOT taken over. " +
          `Run "huddle sync" and try again; if it stays unclear, ask the holder to run "huddle task drop ${id}". ` +
          "A huddle task is reclaimed only on observed inactivity; it is not an execution lock",
      );
    case "not-owner":
      if (task?.owner) {
        const holder = `${label(task)} is held by ${name(task.owner)}, not by this session`;
        // Only a task whose owner is gone can be taken over; saying so for a live owner would send the caller into a wall.
        io.out(result.ownerPresence === "expired" ? `${holder}. That session is gone, so you can take the task over: huddle task claim ${id}` : holder);
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
