// The adapter contract. An adapter translates one agent's hook payloads into
// the normalized events of plan.md §3 and encodes the engine's answer the way
// that agent expects it. The engine (hooks/engine.ts) never sees a native
// payload and an adapter never touches huddle state.

export type HookEventType = "session-start" | "prompt" | "pre-edit" | "post-edit" | "turn-end" | "session-end";

export interface HookEvent {
  type: HookEventType;
  /** The adapter's name: "claude-code", "codex", "git", ... Becomes Session.agent. */
  agent: string;
  /** The agent's own session id. Subagent events carry their parent session's id. */
  sessionId: string;
  /**
   * The agent's live working directory, taken from the payload. Not
   * process.cwd(), and not a fixed project dir: an agent that entered a
   * worktree reports that worktree here, and branch and files come from it.
   */
  cwd: string;
  /** `prompt` events: the user's prompt, uncut. The engine keeps the first 200 characters as the intent. */
  prompt?: string;
  /**
   * `pre-edit` and `post-edit` events: the files being edited, exactly as the
   * agent gave them (usually absolute; backslashes on Windows). The engine
   * makes them repo-relative with files.toRepoPath.
   */
  paths?: string[];
  /** `session-start`: the agent's own word for why (startup, resume, clear, compact, ...). */
  source?: string;
  /** `session-end`: the agent's own word for why. */
  reason?: string;
  /** The event came from a subagent of the session. */
  subagent?: boolean;
  /** Whatever the adapter needs to get back in format(), such as the native event name. The engine ignores it. */
  native?: unknown;
}

/**
 * What the engine wants done. Data only: the adapter decides how to encode it.
 * `turn-end` and `session-end` always produce an empty outcome, and an adapter
 * must print nothing for them (on Claude Code, output on Stop keeps the agent
 * going instead of stopping).
 */
export interface HookOutcome {
  /** Text to put in front of the agent: a briefing or an overlap warning. Absent or "" means print nothing. */
  context?: string;
  /**
   * Variables the agent's later shell commands should see. The engine sets
   * HUDDLE_SESSION on session-start, so that `huddle intent` typed by the agent
   * lands in the session its hooks created. An adapter whose agent has no way
   * to set environment ignores this.
   */
  env?: Record<string, string>;
}

/** A raw hook invocation: `huddle hook <agent> [args...]` with the payload on stdin. */
export interface HookInput {
  /** Arguments after the agent name. */
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** What the hook process prints and how it exits. Exit code 0 unless the agent's protocol demands otherwise. */
export interface HookOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Lines to append to files, for agents that take environment through a file
   * the hook writes to (Claude Code's CLAUDE_ENV_FILE). format() stays pure:
   * runHook does the appending, skips a line the file already contains, and
   * swallows errors. Such a file is executed as shell code by the agent, so the
   * adapter must build each line from values it has validated.
   */
  appendLines?: Array<{ path: string; line: string }>;
}

export interface InstallOptions {
  /** Top level of the worktree being set up. */
  repoRoot: string;
  /** Repo-relative path of the vendored bundle, forward slashes: ".huddle/huddle.mjs". */
  bundle: string;
}

export interface InstallResult {
  /** Repo-relative files that were created or changed. Empty when everything was already in place. */
  changed: string[];
  /** Things the user still has to do by hand (trust a project, review hooks, ...). */
  notes: string[];
}

export interface CheckResult {
  installed: boolean;
  /** One line for `huddle doctor`. */
  detail: string;
  /** Manual steps the user may still need, shown by doctor. */
  notes: string[];
}

export interface Adapter {
  /** Stable id, used in `huddle hook <name>` and as Session.agent. */
  name: string;
  /** Human name for init and doctor output. */
  title: string;
  /** Should `huddle init` install this adapter in this repo without being asked? */
  detect(repoRoot: string): Promise<boolean>;
  /** Writes the agent's hook config. Merges with what is there and is idempotent: a second run changes nothing. */
  install(opts: InstallOptions): Promise<InstallResult>;
  /** For doctor: is the hook config in place? */
  check(repoRoot: string): Promise<CheckResult>;
  /** Null means "not an event huddle cares about" (for example a tool call that edits nothing). Never throws. */
  parse(input: HookInput): HookEvent | null;
  format(event: HookEvent, outcome: HookOutcome): HookOutput;
}

/** Shared by adapters that have nothing to print. */
export const SILENT: HookOutput = Object.freeze({ stdout: "", stderr: "", exitCode: 0 });
