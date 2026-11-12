// Turning doc.json text into documents and back.
//
// Fetched documents are written by teammates' machines and end up inside an
// agent's context, so they are untrusted (plan.md §2, decision 7). parseDoc is
// the one gate: it checks the shape, caps every length, and removes anything
// from teammate-supplied strings that could forge a line of a briefing
// (newlines, control characters, bidi overrides). Code after this gate may
// trust the shapes. The same normalization runs on the way out.

import { randomBytes } from "node:crypto";
import { ID_RE, parseRef } from "./types.ts";
import type { ActorDoc, Decision, DecisionDoc, Doc, Iso, Owner, Ref, Session, SessionPartial, TaskDoc } from "./types.ts";

export const LIMITS = {
  /** doc.json larger than this is not parsed at all. */
  docBytes: 256 * 1024,
  intent: 200,
  files: 200,
  claims: 50,
  path: 400,
  sessions: 50,
  decisions: 200,
  decisionText: 500,
  taskTitle: 200,
  name: 80,
  sessionId: 128,
  branch: 200,
} as const;

// Built from code points so that this file stays plain ASCII: most of these
// characters are invisible, and two of them end a line.
//
// The rule is "nothing a reader cannot see". A character that renders as
// nothing is a way to put text in front of an agent's tokenizer that the human
// reading `huddle status` never sees (the Unicode tag block spells out whole
// sentences that way), and variation selectors can carry arbitrary bytes.
// The price is cosmetic: emoji lose their presentation selector and joined
// emoji sequences fall apart into their parts.
//
// The list holds every code point Unicode gives the property
// Default_Ignorable_Code_Point ("no visible glyph"), which a test checks
// against the Unicode tables of the node that runs it, and besides those the
// controls, the separators, the bidi marks that are not in that property and
// the one blank that is not white space.
export const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls, including tab, CR and LF
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner: joins nothing that can be seen
  [0x061c, 0x061c], // Arabic letter mark (a direction mark)
  [0x115f, 0x1160], // Hangul fillers: letters that render as nothing
  [0x17b4, 0x17b5], // Khmer inherent vowels, which render as nothing
  [0x180b, 0x180f], // Mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width characters and direction marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates, deprecated format characters
  [0x2800, 0x2800], // braille pattern blank: a blank that is not white space, so it would survive as one
  [0x3164, 0x3164], // Hangul filler
  [0xd800, 0xdfff], // a surrogate that is not half of a pair
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff0, 0xfffb], // code points reserved as invisible, and the interlinear annotation marks
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical formatting marks
  [0xe0000, 0xe0fff], // tag characters and the variation selector supplement
];
const escapeCodePoint = (codePoint: number) => `\\u{${codePoint.toString(16)}}`;
// The `u` flag makes the class work by code point, which the ranges above U+FFFF need.
const UNSAFE_CHARS = new RegExp(
  "[" + UNSAFE_RANGES.map(([from, to]) => `${escapeCodePoint(from)}-${escapeCodePoint(to)}`).join("") + "]",
  "gu",
);

/** `text` with every unsafe character replaced. For text that is shown or logged but is not a document field. */
export function replaceUnsafe(text: string, replacement: string): string {
  return text.replace(UNSAFE_CHARS, replacement);
}

/** U+2026, appended to text that was cut. */
export const ELLIPSIS = String.fromCodePoint(0x2026);

/**
 * One safe line of text: unsafe characters become spaces, whitespace runs
 * collapse, and the result is cut to `max` characters with an ellipsis.
 * Returns "" for anything that is not a string.
 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat); // by code point, so a surrogate pair is never split
  if (chars.length <= max) return flat;
  return chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + ELLIPSIS;
}

/** A repo-relative path or glob as data: unsafe characters removed, forward slashes, capped. "" when unusable. */
export function cleanPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.replace(UNSAFE_CHARS, "").replace(/\\/g, "/").trim();
  return Array.from(path).length > LIMITS.path ? "" : path;
}

/**
 * UTC with a "Z", the only form the protocol allows. Date.parse alone would
 * also take "1" or "Jan 1 2026" and read them in the reader's own time zone,
 * so two teammates could disagree about the same document.
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function cleanIso(value: unknown): Iso | null {
  if (typeof value !== "string" || !ISO_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Files and claims on the wire: exact where they fit, covered where they do not
// ---------------------------------------------------------------------------
//
// A session's files in flight can be more than a document carries: more than
// LIMITS.files, paths that cleanPath would change or drop, or more bytes than
// LIMITS.docBytes leaves for them next to the other sessions. Leaving the rest
// out would turn files a teammate cannot see into a clean overlap check. So the
// files that do not go out exactly go out as generated coverage globs instead
// (`dir/**`, widening up to `**`), which say "something under here". They are
// listed in `partial.cover` and are also among `claims`, so a reader that does
// not know `partial` still warns for them. Coverage is always a superset of
// what was cut. A user's own claims are never mixed with it in local.json:
// there, `claims` holds only the user's and `partial.cover` the generated ones.

/** True when `value` goes on the wire exactly as it is: cleanPath leaves it unchanged. */
export function wireExact(value: string): boolean {
  return value !== "" && cleanPath(value) === value;
}

/** The glob that covers everything. Also the last resort of every widening. */
export const COVER_ALL = "**";

/**
 * A file or a glob to cover, as the directories above it, plus the file name
 * when it is a file (or a glob that is not a whole directory).
 */
interface CoverItem {
  dirs: string[];
  file: string | null;
}

function itemOf(pathOrGlob: string): CoverItem | null {
  const segments = pathOrGlob.split("/").filter((segment) => segment !== "");
  const last = segments.at(-1);
  if (last === undefined) return null;
  if (last === "**") return { dirs: segments.slice(0, -1), file: null };
  return { dirs: segments.slice(0, -1), file: last };
}

/**
 * The glob for an item with at most `depth` directories kept: "a/b/**" for a
 * file under a/b, or the file name itself for a file at the top of the repo.
 * Widened (fewer directories kept) until the glob goes on the wire exactly;
 * "**" in the end. Keeping fewer directories only ever matches more.
 */
function coverGlob(item: CoverItem, depth: number): string {
  for (let keep = Math.min(depth, item.dirs.length); keep >= 1; keep--) {
    const glob = `${item.dirs.slice(0, keep).join("/")}/**`;
    if (wireExact(glob)) return glob;
  }
  if (depth >= 1 && item.dirs.length === 0 && item.file !== null && wireExact(item.file)) return item.file;
  return COVER_ALL;
}

/** How many directories a cover glob keeps: "a/b/**" 2, a top-level file name 1, "**" 0. */
function globDepth(glob: string): number {
  const item = itemOf(glob);
  if (!item || glob === COVER_ALL) return 0;
  return item.file === null ? item.dirs.length : Math.max(1, item.dirs.length);
}

/** Drops globs that another one in the set already covers ("a/b/**" under "a/**"). Sorted. */
function minimalCover(globs: Set<string>): string[] {
  if (globs.has(COVER_ALL)) return [COVER_ALL];
  const dirs = new Set([...globs].filter((glob) => glob.endsWith("/**")).map((glob) => glob.slice(0, -3)));
  const kept: string[] = [];
  for (const glob of globs) {
    const item = itemOf(glob);
    if (!item) continue;
    // Covered when one of the directories strictly above it is itself covered.
    const above = item.file === null ? item.dirs.length - 1 : item.dirs.length;
    let covered = false;
    for (let keep = 1; keep <= above && !covered; keep++) covered = dirs.has(item.dirs.slice(0, keep).join("/"));
    if (!covered) kept.push(glob);
  }
  return kept.sort();
}

/**
 * Coverage for `items` in at most `slots` globs (at least one), keeping at
 * most `maxDepth` directories: the narrowest that fits, widening level by
 * level, `["**"]` in the end.
 */
function coverFor(items: Iterable<CoverItem>, slots: number, maxDepth = Infinity): string[] {
  // Only the directories matter, and a file name only at the top: many files, few distinct items.
  const distinct = new Map<string, CoverItem>();
  let deepest = 0;
  for (const item of items) {
    const key = item.dirs.length > 0 ? `d:${item.dirs.join("/")}` : `f:${item.file ?? ""}`;
    if (distinct.has(key)) continue;
    distinct.set(key, item.dirs.length > 0 ? { dirs: item.dirs, file: null } : item);
    if (item.dirs.length > deepest) deepest = item.dirs.length;
  }
  if (distinct.size === 0) return [];
  for (let depth = Math.min(Math.max(deepest, 1), maxDepth); depth >= 1; depth--) {
    const globs = new Set<string>();
    for (const item of distinct.values()) globs.add(coverGlob(item, depth));
    const cover = minimalCover(globs);
    if (cover.length <= Math.max(1, slots)) return cover;
  }
  return [COVER_ALL];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** What a session's files and claims are made of, before they are cut to fit. */
interface Sources {
  /** Files that go on the wire exactly, deduplicated, in the order given. */
  exact: string[];
  /** Files that do not (cleanPath would change or drop them): they can only be covered. */
  lossy: string[];
  /** Generated globs from an earlier cut: from local state, or from a published document. */
  cover: string[];
  /** The user's claims, each one exact on the wire (one that was not is widened until it is). */
  claims: string[];
  /** How many files were in flight, as far as anyone counted. */
  total: number;
  /** The input said `partial`, so it was not complete even if nothing here shows why. */
  partial: boolean;
}

function sourcesOf(files: unknown, claims: unknown, partial: unknown): Sources {
  const given = record(partial);
  const cover = new Set<string>();
  for (const glob of strings(given?.cover)) if (glob.trim() !== "") cover.add(glob);

  const exact = new Set<string>();
  const lossy = new Set<string>();
  for (const file of strings(files)) {
    if (wireExact(file)) exact.add(file);
    else if (file.trim() !== "") lossy.add(file);
  }

  const user = new Set<string>();
  for (const claim of strings(claims)) {
    if (cover.has(claim)) continue; // generated, not the user's
    if (wireExact(claim)) user.add(claim);
    else {
      // A claim that would not survive the trip (from an older version that let it in): its widening does.
      const item = itemOf(claim.replace(/\\/g, "/"));
      if (item) user.add(coverGlob(item, Infinity));
    }
  }

  const counted = typeof given?.total === "number" && Number.isSafeInteger(given.total) && given.total >= 0 ? given.total : 0;
  return {
    exact: [...exact],
    lossy: [...lossy],
    cover: [...cover],
    claims: [...user],
    total: Math.max(counted, exact.size + lossy.size),
    partial: given !== null,
  };
}

/** How far a session is cut down: how many exact files it keeps, how deep its coverage goes, whether its own claims give way to "**". */
interface Cut {
  exact: number;
  depth: number;
  dropClaims: boolean;
}

const UNCUT: Cut = { exact: LIMITS.files, depth: Infinity, dropClaims: false };

type Shaped = Pick<Session, "files" | "claims"> & { partial?: SessionPartial };

function shape(sources: Sources, cut: Cut): Shaped {
  const files = sources.exact.slice(0, Math.max(0, Math.min(cut.exact, LIMITS.files)));
  const items: CoverItem[] = [];
  for (const file of sources.exact.slice(files.length)) items.push(itemOf(file)!);
  for (const file of sources.lossy) {
    const item = itemOf(file.replace(/\\/g, "/"));
    items.push(item ?? { dirs: [], file: null }); // nothing usable to keep: "**"
  }
  for (const glob of sources.cover) {
    const item = itemOf(glob);
    if (item) items.push(item);
  }

  const total = Math.max(sources.total, files.length);
  const over = sources.claims.length > LIMITS.claims;
  if (cut.dropClaims || over || (items.length > 0 && sources.claims.length >= LIMITS.claims)) {
    // No room left for coverage next to the user's claims: one glob that covers both.
    return { files, claims: [COVER_ALL], partial: { total, cover: [COVER_ALL] } };
  }
  if (items.length === 0) {
    // Complete, unless the input said otherwise and we cannot tell what is missing (a reader then knows it is incomplete).
    const claims = sources.claims;
    return sources.partial && total > files.length ? { files, claims, partial: { total, cover: [] } } : { files, claims };
  }
  const cover = coverFor(items, LIMITS.claims - sources.claims.length, cut.depth);
  const generated = new Set(cover);
  return {
    files,
    claims: [...sources.claims.filter((claim) => !generated.has(claim)), ...cover],
    partial: { total, cover },
  };
}

/**
 * The published form of a local session: exact files that fit, and generated
 * coverage for the rest, also listed in `claims` (see the section comment).
 * `local.files` and `local.claims` are what local.json holds: the files in
 * flight (files.ts already cut them to LIMITS.files and put the rest in
 * `partial`) and the user's own claims. Fields other than files, claims and
 * partial are copied as they are; normalizeDoc cleans them on the way out.
 */
export function wireSession(local: Session): Session {
  const shaped = shape(sourcesOf(local.files, local.claims, local.partial), UNCUT);
  const session: Session = {
    id: local.id,
    agent: local.agent,
    branch: local.branch,
    intent: local.intent,
    intentSource: local.intentSource,
    files: shaped.files,
    claims: shaped.claims,
    startedAt: local.startedAt,
    seenAt: local.seenAt,
  };
  if (shaped.partial) session.partial = shaped.partial;
  return session;
}

/**
 * Files in flight as local.json keeps them: at most LIMITS.files exact paths,
 * in the order given, and `partial` with coverage for everything else (null
 * when nothing was left out). Coverage here uses all LIMITS.claims slots;
 * publishing widens it further when the user's claims need room.
 */
export function cutFiles(all: readonly string[]): { files: string[]; partial: SessionPartial | null } {
  const shaped = shape(sourcesOf(all, [], undefined), UNCUT);
  return { files: shaped.files, partial: shaped.partial ?? null };
}

/** A session from the wire or from us, with text cleaned and files and claims shaped by `cut`. */
interface Normalized {
  session: Session;
  sources: Sources;
}

function normalizeSessionParts(value: unknown): Normalized | null {
  const raw = record(value);
  if (!raw) return null;
  const id = cleanText(raw.id, LIMITS.sessionId);
  const startedAt = cleanIso(raw.startedAt);
  const seenAt = cleanIso(raw.seenAt);
  if (!id || !startedAt || !seenAt) return null;
  const intent = cleanText(raw.intent, LIMITS.intent);
  const source = raw.intentSource;
  const sources = sourcesOf(raw.files, raw.claims, raw.partial);
  return { session: withShape({
    id,
    agent: cleanText(raw.agent, LIMITS.name) || "unknown",
    branch: cleanText(raw.branch, LIMITS.branch),
    intent,
    intentSource: intent === "" ? "none" : source === "prompt" || source === "manual" ? source : "none",
    files: [],
    claims: [],
    startedAt,
    seenAt,
  }, shape(sources, UNCUT)), sources };
}

function withShape(session: Session, shaped: Shaped): Session {
  const out: Session = { ...session, files: shaped.files, claims: shaped.claims };
  delete out.partial;
  if (shaped.partial) out.partial = shaped.partial;
  return out;
}

/** The serialized size of a document, in UTF-8 bytes. */
function docBytes(doc: Doc): number {
  return Buffer.byteLength(docText(doc), "utf8");
}

function docText(doc: Doc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** What one session adds to its actor document's size: its text indented two levels down, plus the separator. */
function sessionBytes(session: Session): number {
  const text = JSON.stringify(session, null, 2);
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return Buffer.byteLength(text, "utf8") + 4 * lines + 2;
}

/**
 * Cuts the sessions of an actor document until it fits LIMITS.docBytes,
 * always the largest session first, one step at a time: halve its exact
 * files (the rest goes into coverage), then widen its coverage a level, then
 * let its own claims give way to "**". Every session stays in the document.
 * Fifty sessions with nothing but "**" fit (a test proves it), so this always
 * ends with a document that fits.
 */
function fitActor(doc: ActorDoc, parts: Normalized[]): ActorDoc {
  if (docBytes(doc) <= LIMITS.docBytes) return doc;
  const cuts: Cut[] = parts.map(() => ({ ...UNCUT }));
  const sessions = [...doc.sessions];
  const sizes = sessions.map(sessionBytes);
  const base = docBytes({ ...doc, sessions: [] });
  const done = new Set<number>();
  let total = base + sizes.reduce((sum, size) => sum + size, 0);
  for (;;) {
    if (total <= LIMITS.docBytes || done.size === sessions.length) {
      const fitted: ActorDoc = { ...doc, sessions };
      if (docBytes(fitted) <= LIMITS.docBytes || done.size === sessions.length) return fitted;
      total = LIMITS.docBytes + 1; // the estimate was short; keep cutting
    }
    let largest = -1;
    for (let i = 0; i < sessions.length; i++) {
      if (!done.has(i) && (largest === -1 || sizes[i]! > sizes[largest]!)) largest = i;
    }
    const session = sessions[largest]!;
    const cut = cuts[largest]!;
    const coverDepth = Math.max(0, ...(session.partial?.cover ?? []).map(globDepth));
    if (session.files.length > 0) cut.exact = session.files.length >> 1;
    else if (!cut.dropClaims && coverDepth > 0) cut.depth = coverDepth - 1;
    else if (!cut.dropClaims && !(session.claims.length === 1 && session.claims[0] === COVER_ALL)) cut.dropClaims = true;
    else {
      done.add(largest);
      continue;
    }
    sessions[largest] = withShape(session, shape(parts[largest]!.sources, cut));
    const size = sessionBytes(sessions[largest]!);
    total += size - sizes[largest]!;
    sizes[largest] = size;
  }
}

function normalizeOwner(value: unknown): Owner | null {
  const raw = record(value);
  if (!raw) return null;
  const actor = cleanId(raw.actor);
  const session = cleanText(raw.session, LIMITS.sessionId);
  if (!actor || !session) return null;
  return {
    actor,
    user: cleanText(raw.user, LIMITS.name) || "unknown",
    session,
    agent: cleanText(raw.agent, LIMITS.name) || "unknown",
  };
}

function normalizeDecision(value: unknown): Decision | null {
  const raw = record(value);
  if (!raw) return null;
  const id = cleanId(raw.id);
  const at = cleanIso(raw.at);
  const text = cleanText(raw.text, LIMITS.decisionText);
  if (!id || !at || !text) return null;
  const decision: Decision = { id, at, agent: cleanText(raw.agent, LIMITS.name) || "unknown", text };
  const supersedes = cleanId(raw.supersedes);
  if (supersedes) decision.supersedes = supersedes;
  return decision;
}

function items<T>(value: unknown, max: number, normalize: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const normalized = normalize(item);
    if (normalized) out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Validates and normalizes a value into a document. Null when it is not a v0
 * document of a known kind. A malformed list item (one session, one decision)
 * is dropped; a malformed required top-level field rejects the whole document.
 */
export function normalizeDoc(value: unknown): Doc | null {
  const raw = record(value);
  if (!raw || raw.v !== 0) return null;

  if (raw.kind === "actor") {
    const actor = cleanId(raw.actor);
    const updatedAt = cleanIso(raw.updatedAt);
    if (!actor || !updatedAt) return null;
    const parts = items(raw.sessions, LIMITS.sessions, normalizeSessionParts);
    const doc: ActorDoc = {
      v: 0,
      kind: "actor",
      actor,
      user: cleanText(raw.user, LIMITS.name) || "unknown",
      host: cleanText(raw.host, LIMITS.name) || "unknown",
      updatedAt,
      sessions: parts.map((part) => part.session),
    };
    return fitActor(doc, parts);
  }

  if (raw.kind === "decisions") {
    const actor = cleanId(raw.actor);
    if (!actor) return null;
    const doc: DecisionDoc = {
      v: 0,
      kind: "decisions",
      actor,
      user: cleanText(raw.user, LIMITS.name) || "unknown",
      decisions: items(raw.decisions, LIMITS.decisions, normalizeDecision),
    };
    return doc;
  }

  if (raw.kind === "task") {
    const id = cleanId(raw.id);
    const title = cleanText(raw.title, LIMITS.taskTitle);
    const createdBy = normalizeOwner(raw.createdBy);
    const createdAt = cleanIso(raw.createdAt);
    const updatedAt = cleanIso(raw.updatedAt);
    const status = raw.status;
    if (!id || !title || !createdBy || !createdAt || !updatedAt) return null;
    if (status !== "open" && status !== "claimed" && status !== "done") return null;
    const owner = raw.owner === null || raw.owner === undefined ? null : normalizeOwner(raw.owner);
    // A claimed task must say who claimed it; an open one has no owner.
    if (status === "claimed" && !owner) return null;
    const doc: TaskDoc = {
      v: 0,
      kind: "task",
      id,
      title,
      status,
      owner: status === "open" ? null : owner,
      createdBy,
      createdAt,
      updatedAt,
    };
    return doc;
  }

  return null;
}

/**
 * Parses doc.json text fetched from the remote. Null when the text is too
 * large, is not JSON, or is not a valid v0 document. When `ref` is given the
 * document must also belong there: an actor doc under refs/huddle/actors/X
 * must name actor X, and so on. Never throws.
 */
export function parseDoc(text: string, ref?: Ref): Doc | null {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > LIMITS.docBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const doc = normalizeDoc(value);
  if (!doc) return null;
  if (ref !== undefined) {
    const where = parseRef(ref);
    if (!where) return null;
    if (where.kind === "task") {
      if (doc.kind !== "task" || doc.id !== where.id) return null;
    } else if (doc.kind !== where.kind || doc.actor !== where.id) {
      return null;
    }
  }
  return doc;
}

/**
 * A document that does not fit LIMITS.docBytes, so that no reader would take
 * it. Thrown by serializeDoc before anything is written. Actor documents never
 * get here: they are cut to fit (see fitActor). A decision log can.
 */
export class DocTooLargeError extends Error {
  kind: Doc["kind"];
  bytes: number;
  limit: number;
  constructor(kind: Doc["kind"], bytes: number) {
    super(`the ${kind} document would be ${bytes} bytes, more than the ${LIMITS.docBytes} a reader accepts`);
    this.name = "DocTooLargeError";
    this.kind = kind;
    this.bytes = bytes;
    this.limit = LIMITS.docBytes;
  }
}

/**
 * The doc.json text for a document. Normalizes first, so what we publish obeys
 * the same caps we enforce on what we read, and parseDoc(serializeDoc(doc))
 * always succeeds. Throws DocTooLargeError when the text would be larger than
 * a reader accepts, and a plain Error when the document is not valid:
 * publishing garbage is a bug on our side.
 */
export function serializeDoc(doc: Doc): string {
  const normalized = normalizeDoc(doc);
  if (!normalized) throw new Error(`cannot serialize an invalid ${String((doc as { kind?: unknown }).kind)} document`);
  const text = docText(normalized);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > LIMITS.docBytes) throw new DocTooLargeError(normalized.kind, bytes);
  return text;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A random lowercase base32 id (5 bits per character). Used for actors, tasks and decisions. */
export function newId(length = 8): string {
  const bytes = randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i++) id += BASE32[bytes[i]! & 31];
  return id;
}
