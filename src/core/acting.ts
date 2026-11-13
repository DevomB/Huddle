// Which session a process is. The one resolver for every command, and for the
// hook events that name no session (a git hook).
//
// A process acts as a session only when something proves it is that session.
// Being the session last active in the worktree proves nothing: a person
// typing next to their agent, a second agent, or an agent whose hooks are not
// installed would all become it.
//
// What counts, in this order:
//   1. `--session <id>` on the command line (io.session). It is the only
//      statement made for this one command, so it wins over everything.
//   2. The environment, when everything in it names the same session:
//      HUDDLE_SESSION, and the variable each agent gives the commands it runs
//      (Adapter.sessionVariable). An environment is inherited: an agent started
//      from a shell, or from inside another agent, carries its parent's
//      variables. Two of them that disagree therefore prove nothing.
//   3. Nothing in the environment, and no other live session in this
//      worktree: the worktree's own session. That is a person at a prompt, and
//      the git hooks of a worktree no agent is in.
//   4. Otherwise nothing is proven: "unbound". A command that would change a
//      session then refuses (requireActing), and one that only reads is given
//      the team as seen from no session.
//
// Checked against the agents on 2026-11-13:
// - Claude Code sets CLAUDE_CODE_SESSION_ID in the Bash and PowerShell tools'
//   subprocesses, and "this matches the session_id field in the hook JSON
//   input and is updated on /clear" (code.claude.com/docs/en/env-vars; added
//   in 2.1.132 by its changelog, before the 2.1.139 that huddle's exec-form
//   hooks need).
// - Codex sets CODEX_SESSION_ID in every shell command from the same
//   session.session_id() it sends to hooks as session_id, "the identity shared
//   by the root thread and all descendant threads" (rust-v0.167.0:
//   core/src/exec_env.rs, core/src/hook_runtime.rs, core/src/session/session.rs).
//   CODEX_THREAD_ID is a subagent's own thread and is not used.

import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import { ageMs } from "./clock.ts";
import type { Ctx } from "./context.ts";
import { LIMITS, cleanText } from "./docs.ts";
import { manualSessionId } from "./identity.ts";
import { UsageError } from "./io.ts";
import type { Io } from "./io.ts";
import type { RepoPaths } from "./paths.ts";
import { formatAge } from "./render.ts";
import { readLocal } from "./store.ts";
import type { LocalSession, LocalState } from "./types.ts";

export type BindingKind = "explicit" | "agent" | "worktree" | "unbound";

/** What one variable of the environment says. `agent` is the adapter whose variable it is, "" for HUDDLE_SESSION. */
export interface Witness {
  source: string;
  id: string;
  agent: string;
}

export interface Acting {
  /** The session this process is. null when that cannot be proven (kind "unbound"). */
  id: string | null;
  kind: BindingKind;
  /** What decided it, for messages and doctor: "--session", "HUDDLE_SESSION", "CLAUDE_CODE_SESSION_ID", ...; "" for "worktree" and "unbound". */
  source: string;
  /** Session.agent for a session this process creates: the stored session's agent; else the agent whose variable names it; else "manual". */
  agent: string;
  /** The stored session. null when nothing has created it yet, and when unbound. */
  session: LocalSession | null;
  /** kind "unbound": the live sessions in this worktree that the process could be, most recently active first. [] otherwise. */
  candidates: LocalSession[];
  /** Everything the environment said, in the order it was asked. More than one id among them is why a process with an environment is unbound. */
  witnesses: Witness[];
}

/** What the resolver reads. A Ctx has all of it; the hook engine passes the worktree of its event. */
export type ActingContext = Pick<Ctx, "io" | "paths" | "config" | "now">;

/** The word that stands for the worktree's own session in `--session manual`. */
export const MANUAL = "manual";

/**
 * A session id the store accepts, the same one for the same input every time.
 * Ids come from agents: anything that is not one clean line is made one, and
 * an id over the limit keeps its start and gets a hash of the whole in place
 * of the rest, so that two long ids stay two sessions. "" when there is
 * nothing to use. A hook payload's id and an agent's variable both go through
 * here, which is what makes them the same session.
 */
export function sessionIdOf(raw: unknown): string {
  const flat = cleanText(raw, Number.MAX_SAFE_INTEGER);
  const chars = Array.from(flat);
  if (chars.length <= LIMITS.sessionId) return flat;
  const hash = createHash("sha256").update(flat).digest("hex").slice(0, 16);
  return `${chars.slice(0, LIMITS.sessionId - 17).join("").trimEnd()}-${hash}`;
}

/** The id of the worktree's own session, whatever the environment says. */
export function worktreeSessionId(paths: RepoPaths): string {
  return manualSessionId(paths, {});
}

/** What the environment says about which session this is: HUDDLE_SESSION first, then each agent in registry order. */
export function witnessesOf(env: NodeJS.ProcessEnv): Witness[] {
  const found: Witness[] = [];
  const explicit = cleanText(env.HUDDLE_SESSION, LIMITS.sessionId);
  if (explicit !== "") found.push({ source: "HUDDLE_SESSION", id: explicit, agent: "" });
  for (const adapter of ADAPTERS) {
    if (adapter.sessionVariable === undefined) continue;
    const id = sessionIdOf(env[adapter.sessionVariable]);
    if (id !== "") found.push({ source: adapter.sessionVariable, id, agent: adapter.name });
  }
  return found;
}

/** The live sessions of this worktree, most recently active first. */
function liveHere(ctx: ActingContext, local: LocalState): LocalSession[] {
  const ttlMs = ctx.config.ttlMinutes * 60_000;
  return local.sessions
    .filter((session) => session.worktree === ctx.paths.worktree && ageMs(session.seenAt, ctx.now) < ttlMs)
    .sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt));
}

/**
 * Which session this process is, by the rules at the top of this file. Never
 * throws for lack of identity: that is kind "unbound". It does throw a
 * UsageError for a `--session` that names nothing this process could be, so
 * that a typing mistake never acts as, or creates, some other session.
 * `state` is local.json when the caller has read it already.
 */
export async function resolveActing(ctx: ActingContext, state?: LocalState): Promise<Acting> {
  const local = state ?? (await readLocal(ctx.paths));
  const witnesses = witnessesOf(ctx.io.env);
  const own = worktreeSessionId(ctx.paths);
  const here = liveHere(ctx, local);

  const bound = (id: string, kind: BindingKind, source: string): Acting => {
    const session = local.sessions.find((candidate) => candidate.id === id) ?? null;
    const agent = session?.agent ?? witnesses.find((witness) => witness.id === id && witness.agent !== "")?.agent ?? MANUAL;
    return { id, kind, source, agent, session, candidates: [], witnesses };
  };
  const unbound = (): Acting => ({ id: null, kind: "unbound", source: "", agent: MANUAL, session: null, candidates: here, witnesses });

  const option = ctx.io.session;
  if (option !== undefined) {
    const id = option === MANUAL ? own : option;
    const stored = local.sessions.find((candidate) => candidate.id === id);
    const known = option === MANUAL || witnesses.some((witness) => witness.id === id) || stored?.worktree === ctx.paths.worktree;
    if (!known) throw new UsageError(unknownSession(option, stored, unbound(), ctx));
    return bound(id, "explicit", "--session");
  }

  const named = [...new Set(witnesses.map((witness) => witness.id))];
  if (named.length > 1) return unbound();
  const only = named[0];
  if (only !== undefined) {
    const explicit = witnesses.find((witness) => witness.agent === "");
    return explicit ? bound(only, "explicit", explicit.source) : bound(only, "agent", witnesses[0]?.source ?? "");
  }

  return here.some((session) => session.id !== own) ? unbound() : bound(own, "worktree", "");
}

/**
 * For a command that changes a session, or records one as the owner of
 * something: the session, or an IdentityRequired when it cannot be proven.
 * Nothing has been changed when it throws.
 */
export async function requireActing(ctx: ActingContext, state?: LocalState): Promise<Acting & { id: string }> {
  const acting = await resolveActing(ctx, state);
  if (acting.id === null) throw new IdentityRequired(acting, ctx);
  return acting as Acting & { id: string };
}

/**
 * Exit code 2. The message says that nothing was changed, what the doubt is,
 * and gives one command line per session this process could be.
 */
export class IdentityRequired extends UsageError {
  readonly acting: Acting;
  constructor(acting: Acting, ctx: Pick<ActingContext, "io" | "paths" | "now">) {
    super(refusal(acting, ctx));
    this.name = "IdentityRequired";
    this.acting = acting;
  }
}

/** One line on who this process acts as and why, for `huddle doctor` and for a read that is seen from no session. */
export function describeActing(acting: Acting): string {
  if (acting.id === null) return `not proven: ${doubt(acting)}`;
  if (acting.kind === "worktree") return `acting as this worktree's own session ${acting.id} (no other session is active here)`;
  const what = acting.agent === MANUAL ? `session ${acting.id}` : `${acting.agent} session ${acting.id}`;
  return `acting as ${what} (${acting.source === "--session" ? "--session" : `from ${acting.source}`})`;
}

/** Why nothing is proven, as the end of a sentence. */
function doubt(acting: Acting): string {
  const ids = new Set(acting.witnesses.map((witness) => witness.id));
  if (ids.size > 1) {
    return `${acting.witnesses.map((witness) => `${witness.source} names ${witness.id}`).join(", ")}. A process started inside an agent session inherits that session's variables`;
  }
  const count = acting.candidates.length;
  return `${count === 1 ? "another session is" : `${count} sessions are`} active in this worktree, and nothing says whether this command comes from ${count === 1 ? "it" : "one of them"}`;
}

/** The sessions a refusal offers: what the environment named, then the live sessions of this worktree, each once. */
function choices(acting: Acting, own: string): Array<{ id: string; label: string }> {
  const offered = new Map<string, string>();
  for (const witness of acting.witnesses) {
    if (!offered.has(witness.id)) offered.set(witness.id, `what ${witness.source} names`);
  }
  for (const session of acting.candidates) {
    if (session.id === own || offered.has(session.id)) continue;
    offered.set(session.id, session.agent);
  }
  return [...offered].map(([id, label]) => ({ id, label }));
}

function refusal(acting: Acting, ctx: Pick<ActingContext, "io" | "paths" | "now">): string {
  const own = worktreeSessionId(ctx.paths);
  const again = rerun(ctx.io, ctx.paths);
  const lines = [`this command acts as a session, and which one is ${describeActing(acting)}. Nothing was changed.`, "Run it again and say which session it is:"];
  for (const choice of choices(acting, own)) {
    const session = acting.candidates.find((candidate) => candidate.id === choice.id);
    const seen = session ? `, active ${formatAge(ageMs(session.seenAt, ctx.now))}` : "";
    lines.push(`  ${again(choice.id)}   (${choice.label}${seen})`);
  }
  lines.push(`  ${again(MANUAL)}   (yourself, typing in this worktree)`);
  return lines.join("\n");
}

function unknownSession(option: string, stored: LocalSession | undefined, fallback: Acting, ctx: ActingContext): string {
  const shown = cleanText(option, 80);
  if (stored !== undefined) {
    return `--session ${shown} is a session of another worktree (${stored.worktree}). Run the command there, or use --session ${MANUAL} for this worktree's own session.`;
  }
  const own = worktreeSessionId(ctx.paths);
  const offered = choices(fallback, own);
  const list = offered.length === 0 ? "No agent session is active in this worktree." : `Sessions here: ${offered.map((choice) => `${choice.id} (${choice.label})`).join(", ")}.`;
  return `--session ${shown} is not a session of this worktree, so nothing was done. ${list} Use the whole id, or --session ${MANUAL} for this worktree's own session.`;
}

// ---------------------------------------------------------------------------
// The command line again
// ---------------------------------------------------------------------------

/** An argument as a POSIX shell or cmd.exe and PowerShell take it back unchanged. */
function quoted(arg: string, windows: boolean): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return windows ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** No command line is offered for arguments that one line cannot carry. */
const MAX_RERUN_CHARS = 400;

/**
 * This run's command line with `--session <id>` in it, for a refusal. The
 * program is named the way this process was started, as far as that can be
 * told: the bundle inside the worktree by its path from here, anything else
 * as `git huddle`.
 */
function rerun(io: Io, paths: RepoPaths, windows: boolean = process.platform === "win32"): (id: string) => string {
  let program = "git huddle";
  if (io.self) {
    const fromTop = relative(paths.worktree, io.self);
    if (fromTop !== "" && !fromTop.startsWith("..") && !isAbsolute(fromTop)) {
      program = `node ${quoted(relative(io.cwd, io.self).split(sep).join("/"), windows)}`;
    }
  }
  const argv = io.argv ?? [];
  const rest = argv.map((arg) => quoted(arg, windows)).join(" ");
  // A control character cannot be typed back on one line, and a very long line is no help.
  const usable = argv.length > 0 && rest.length <= MAX_RERUN_CHARS && !argv.some((arg) => /[\u0000-\u001f\u007f]/.test(arg));
  return (id) => `${program} --session ${quoted(id, windows)} ${usable ? rest : "<the same command>"}`;
}
