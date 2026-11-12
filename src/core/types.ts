// The protocol v0 data model (plan.md §3). Changes to this file go through the lead.
//
// Everything here is plain data plus the ref-naming helpers, so pure modules
// (view, render) can import it without pulling in git or the filesystem.

export type Iso = string; // UTC ISO-8601
export type Sha = string; // 40 lowercase hex characters
export type Ref = string; // full ref name, e.g. refs/huddle/actors/abcd2345

// ---------------------------------------------------------------------------
// Documents. Every ref points at a parentless commit whose tree holds exactly
// one file, doc.json, containing one of these.
// ---------------------------------------------------------------------------

export interface ActorDoc {
  v: 0;
  kind: "actor";
  actor: string;
  user: string;
  host: string;
  updatedAt: Iso;
  sessions: Session[];
}

export interface Session {
  /** Agent session id from the hook payload; HUDDLE_SESSION or a per-worktree id for manual use. */
  id: string;
  /** "claude-code" | "codex" | "gemini-cli" | "cursor" | "opencode" | "manual" | ... */
  agent: string;
  branch: string;
  /** Max 200 chars. */
  intent: string;
  intentSource: "prompt" | "manual" | "none";
  /** Repo-relative, max 200: dirty files plus files changed since the merge-base with the base branch. */
  files: string[];
  /** Optional explicit globs. */
  claims: string[];
  startedAt: Iso;
  /** Last activity. */
  seenAt: Iso;
  /**
   * Present only when `files` is not this session's complete exact set: more
   * files were in flight than the document carries. Additive to v0. A reader
   * that does not know the field ignores it and still warns, because every
   * `cover` glob is also one of `claims`.
   */
  partial?: SessionPartial;
}

export interface SessionPartial {
  /** How many files were in flight when this was published, before anything was cut. */
  total: number;
  /** The entries of `claims` that huddle generated to cover the files not listed. Never a claim the user made. */
  cover: string[];
}

export interface DecisionDoc {
  v: 0;
  kind: "decisions";
  actor: string;
  user: string;
  decisions: Decision[];
}

export interface Decision {
  id: string;
  at: Iso;
  agent: string;
  text: string;
  supersedes?: string;
}

export interface TaskDoc {
  v: 0;
  kind: "task";
  id: string;
  title: string;
  status: "open" | "claimed" | "done";
  owner: Owner | null;
  createdBy: Owner;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Owner {
  actor: string;
  user: string;
  session: string;
  agent: string;
}

export type Doc = ActorDoc | DecisionDoc | TaskDoc;
export type DocKind = Doc["kind"];

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** force-update | create only if missing | replace only if still at Sha */
export type Expect = "own" | "absent" | Sha;

export type FailReason = "lost-race" | "offline" | "denied";

/**
 * On a failure, `sent` is false only when the transport knows that nothing
 * left this machine. Absent or true: the write may have reached the remote
 * and been applied, so the outcome is unknown until the ref is read again.
 */
export type PublishResult = { ok: true; sha: Sha } | { ok: false; reason: FailReason; sent?: boolean };

/**
 * `doc` is null when the ref exists but its content is not a valid v0 document
 * (garbage, or a newer protocol version). The sha is still reported so the
 * caller can cache it and not refetch the same bad ref on every sync.
 */
export interface FetchedDoc {
  sha: Sha;
  doc: Doc | null;
}

export type FetchResult =
  | { ok: true; changed: Map<Ref, FetchedDoc>; removed: Ref[] }
  | { ok: false; reason: FailReason };

export interface Transport {
  publish(ref: Ref, doc: Doc, expect: Expect): Promise<PublishResult>;
  fetchAll(known: Map<Ref, Sha>): Promise<FetchResult>;
  remove(ref: Ref, expect: Sha): Promise<PublishResult>;
}

// ---------------------------------------------------------------------------
// Refs on the shared remote
// ---------------------------------------------------------------------------

export const REF_PREFIX = "refs/huddle/";
/** Pattern for `git ls-remote`. Not valid as a fetch refspec without a destination. */
export const REF_PATTERN = "refs/huddle/*";

/** Ids (actor, task, decision) are lowercase base32: safe in ref names, file names and shells. */
export const ID_RE = /^[a-z2-7]{4,32}$/;

export type RefKind = "actor" | "decisions" | "task";

const REF_DIRS: Record<RefKind, string> = { actor: "actors", decisions: "decisions", task: "tasks" };

export function actorRef(actorId: string): Ref {
  return `${REF_PREFIX}actors/${actorId}`;
}

export function decisionsRef(actorId: string): Ref {
  return `${REF_PREFIX}decisions/${actorId}`;
}

export function taskRef(taskId: string): Ref {
  return `${REF_PREFIX}tasks/${taskId}`;
}

/** Null for anything that is not a well-formed huddle ref. Ref names come from the remote: untrusted. */
export function parseRef(ref: Ref): { kind: RefKind; id: string } | null {
  if (!ref.startsWith(REF_PREFIX)) return null;
  const [dir, id, ...rest] = ref.slice(REF_PREFIX.length).split("/");
  if (rest.length > 0 || id === undefined || !ID_RE.test(id)) return null;
  for (const kind of Object.keys(REF_DIRS) as RefKind[]) {
    if (REF_DIRS[kind] === dir) return { kind, id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config: team-wide in .huddle/config.json, local override in
// <git-common-dir>/huddle/config.json.
// ---------------------------------------------------------------------------

export interface Config {
  /** Name of a configured git remote. Never a URL. */
  remote: string;
  /** "auto" (origin/HEAD, else origin/main, else origin/master) or a branch name. */
  base: string;
  syncIntervalSeconds: number;
  heartbeatMinutes: number;
  ttlMinutes: number;
  mode: "warn";
  captureIntent: boolean;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  remote: "origin",
  base: "auto",
  syncIntervalSeconds: 15,
  heartbeatMinutes: 3,
  ttlMinutes: 15,
  mode: "warn",
  captureIntent: true,
});

// ---------------------------------------------------------------------------
// Local state in <git-common-dir>/huddle/. Never committed, never published.
// Persisted as JSON, hence Records rather than Maps.
// ---------------------------------------------------------------------------

/** A session of this clone. `worktree` is an absolute path and never leaves the machine. */
export interface LocalSession extends Session {
  worktree: string;
}

/** local.json */
export interface LocalState {
  v: 0;
  sessions: LocalSession[];
  /** The last ActorDoc publish: when, a hash of its content (ignoring timestamps), and the commit it produced. */
  published: { at: Iso; hash: string; sha: Sha } | null;
}

export interface CacheEntry {
  sha: Sha;
  /** Null: fetched, but not a valid v0 document. See FetchedDoc. */
  doc: Doc | null;
}

/** cache.json: the last fetched team state. */
export interface Cache {
  fetchedAt: Iso | null;
  refs: Record<Ref, CacheEntry>;
}

/**
 * seen/<session>: what was last injected into that session, for delta briefings.
 * `items` maps an item key (a teammate session, a decision, the task summary)
 * to a fingerprint of what was shown. An item is "changed" when its fingerprint
 * differs or is missing.
 */
export interface Seen {
  at: Iso;
  items: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Identity of this clone
// ---------------------------------------------------------------------------

export interface Identity {
  /** 8 random base32 characters, minted once per clone. */
  actor: string;
  /** git's user.name, else the OS user name. One clean line. */
  user: string;
  /** The first label of the machine's host name ("laptop", not "laptop.corp.example.com"): no domain is published. */
  host: string;
}
