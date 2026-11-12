// T1.3. Glob matching for claims. Pure.
//
//   *    any run of characters except "/"
//   ?    one character except "/"
//   **   as a whole segment: zero or more path segments ("**/" also matches
//        zero directories); inside a segment it behaves like *
//   dir/ a trailing slash means everything under dir (same as dir/**)
// Everything else is literal, including "[" and "]", so framework route files
// such as app/[slug]/page.tsx can be claimed by name. Patterns are anchored at
// the repo root and match the whole path, case-sensitively, like git paths.
// Paths are repo-relative with forward slashes.
//
// Claim globs are written by teammates, so they are untrusted input on the
// pre-edit path, which has a 150 ms budget. Matching is therefore a bounded
// two-pointer walk, not a compiled RegExp: a translated pattern such as
// "*a*a*a*...*b" backtracks catastrophically, and this cannot.

const MAX_PATTERN_CHARS = 1024;
const MAX_PATH_CHARS = 4096;

type Segment =
  | { kind: "globstar" }
  | { kind: "literal"; text: string }
  | { kind: "wild"; chars: string[] };

/**
 * Canonical repo-relative form: forward slashes as given, no leading "./" or
 * "/", no empty or "." segments, no trailing slash. Converting an OS path
 * (absolute, or with backslashes) to repo-relative is the caller's job.
 */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    out.push(segment);
  }
  return out.join("/");
}

/** A path's segments, plus each segment's code points, filled in the first time a wildcard needs them. */
interface SplitPath {
  segments: string[];
  chars: Array<string[] | undefined>;
}

function splitPath(path: string): SplitPath | null {
  if (path.length > MAX_PATH_CHARS) return null;
  const normalized = normalizePath(path);
  const segments = normalized === "" ? [] : normalized.split("/");
  return { segments, chars: new Array<string[] | undefined>(segments.length) };
}

function compile(pattern: string): Segment[] | null {
  const trimmed = pattern.trim();
  if (trimmed === "" || trimmed.length > MAX_PATTERN_CHARS) return null;
  const raw = normalizePath(trimmed);
  const parts = raw === "" ? [] : raw.split("/");
  if (trimmed.endsWith("/") && parts.length > 0) parts.push("**");
  const segments: Segment[] = [];
  for (const part of parts) {
    if (part === "**") {
      const last = segments[segments.length - 1];
      if (last === undefined || last.kind !== "globstar") segments.push({ kind: "globstar" });
    } else if (part.includes("*") || part.includes("?")) {
      segments.push({ kind: "wild", chars: Array.from(part) });
    } else {
      segments.push({ kind: "literal", text: part });
    }
  }
  return segments;
}

/** `*` and `?` inside one segment. Iterative, O(pattern * text) worst case. */
function matchWild(pattern: string[], text: string[]): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

function matchOne(segment: Segment, path: SplitPath, index: number): boolean {
  const text = path.segments[index] as string;
  if (segment.kind === "literal") return segment.text === text;
  if (segment.kind !== "wild") return false;
  let chars = path.chars[index];
  if (chars === undefined) {
    chars = Array.from(text); // by code point, so ? matches one character, not half a surrogate pair
    path.chars[index] = chars;
  }
  return matchWild(segment.chars, chars);
}

/** The same walk one level up, over the first `length` segments: `**` is the only multi-segment matcher. */
function matchSegments(pattern: Segment[], path: SplitPath, length: number): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < length) {
    const segment = pattern[p];
    if (segment !== undefined && segment.kind === "globstar") {
      star = p++;
      mark = s;
    } else if (segment !== undefined && matchOne(segment, path, s)) {
      p++;
      s++;
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && (pattern[p] as Segment).kind === "globstar") p++;
  return p === pattern.length;
}

/** True when `pattern` matches the whole of `path`. Invalid input never matches. */
export function globMatch(pattern: string, path: string): boolean {
  const compiled = compile(pattern);
  const split = splitPath(path);
  if (compiled === null || split === null) return false;
  return matchSegments(compiled, split, split.segments.length);
}

/**
 * True when a claim covers `path`: the glob matches the path itself or any
 * directory above it. So `src/auth` claims everything under src/auth, the way
 * a .gitignore entry for a directory covers its contents, and `.` or `/`
 * claims the whole repo. This errs towards warning, which is the safe side
 * for an advisory check.
 */
export function claimMatches(claim: string, path: string): boolean {
  const compiled = compile(claim);
  const split = splitPath(path);
  if (compiled === null || split === null || split.segments.length === 0) return false;
  for (let length = split.segments.length; length >= 0; length--) {
    if (matchSegments(compiled, split, length)) return true;
  }
  return false;
}
