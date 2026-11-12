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
import type { ActorDoc, Decision, DecisionDoc, Doc, Iso, Owner, Ref, Session, TaskDoc } from "./types.ts";

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

function cleanPaths(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const path = cleanPath(item);
    if (path) seen.add(path);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeSession(value: unknown): Session | null {
  const raw = record(value);
  if (!raw) return null;
  const id = cleanText(raw.id, LIMITS.sessionId);
  const startedAt = cleanIso(raw.startedAt);
  const seenAt = cleanIso(raw.seenAt);
  if (!id || !startedAt || !seenAt) return null;
  const intent = cleanText(raw.intent, LIMITS.intent);
  const source = raw.intentSource;
  return {
    id,
    agent: cleanText(raw.agent, LIMITS.name) || "unknown",
    branch: cleanText(raw.branch, LIMITS.branch),
    intent,
    intentSource: intent === "" ? "none" : source === "prompt" || source === "manual" ? source : "none",
    files: cleanPaths(raw.files, LIMITS.files),
    claims: cleanPaths(raw.claims, LIMITS.claims),
    startedAt,
    seenAt,
  };
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
    const doc: ActorDoc = {
      v: 0,
      kind: "actor",
      actor,
      user: cleanText(raw.user, LIMITS.name) || "unknown",
      host: cleanText(raw.host, LIMITS.name) || "unknown",
      updatedAt,
      sessions: items(raw.sessions, LIMITS.sessions, normalizeSession),
    };
    return doc;
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
 * The doc.json text for a document. Normalizes first, so what we publish obeys
 * the same caps we enforce on what we read. Throws when the document is not
 * valid: publishing garbage is a bug on our side.
 */
export function serializeDoc(doc: Doc): string {
  const normalized = normalizeDoc(doc);
  if (!normalized) throw new Error(`cannot serialize an invalid ${String((doc as { kind?: unknown }).kind)} document`);
  return JSON.stringify(normalized, null, 2) + "\n";
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A random lowercase base32 id (5 bits per character). Used for actors, tasks and decisions. */
export function newId(length = 8): string {
  const bytes = randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i++) id += BASE32[bytes[i]! & 31];
  return id;
}
