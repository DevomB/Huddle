// Source hygiene, part one. Invisible and bidi characters in source are a review hazard,
// and a raw U+2028 or U+2029 inside a regex or string literal is a syntax
// error. Editing tools have turned \u escapes into the real characters before,
// so this is checked rather than assumed. Write such characters as
// String.fromCodePoint(0x2028) or "\u{2028}".

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { UNSAFE_RANGES } from "../src/core/docs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mjs|json)$/.test(name) ? [path] : [];
  });
}

// Everything the document gate removes (see UNSAFE_RANGES in docs.ts), except the
// tab and the line endings a source file is made of.
const ALLOWED_IN_SOURCE = new Set([0x09, 0x0a, 0x0d]);
const isHidden = (codePoint: number) =>
  !ALLOWED_IN_SOURCE.has(codePoint) && UNSAFE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);

test("no source file contains control, invisible or bidi characters", () => {
  const offenders: string[] = [];
  for (const dir of ["src", "test", "scripts"]) {
    for (const file of sourceFiles(join(root, dir))) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const ch of line) {
          const codePoint = ch.codePointAt(0)!;
          if (isHidden(codePoint)) {
            offenders.push(`${relative(root, file)}:${index + 1} U+${codePoint.toString(16).padStart(4, "0")}`);
          }
        }
      });
    }
  }
  assert.deepEqual(offenders, []);
});

// Source hygiene, part two. The repository is read by secret scanners (a
// GitGuardian check on every pull request, GitHub's push protection). They
// cannot tell a made-up credential in a test from a real one, and they read
// every commit: once a commit with such a literal is pushed, every branch that
// contains it fails the check until someone marks the finding by hand. So
// tests that need something shaped like a credential build it at run time from
// parts, for example ["gh", "p_", "x".repeat(36)].join(""), and no source line
// holds a complete match.

const TOKEN_SHAPES: [string, RegExp][] = [
  ["a GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["a GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{20,}/],
  ["a GitLab token", /glpat-[A-Za-z0-9_-]{16,}/],
  ["a Slack token", /xox[abeoprs]-[A-Za-z0-9-]{10,}/],
  ["an AWS access key id", /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ["a Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["an npm token", /npm_[A-Za-z0-9]{30,}/],
  ["a Stripe key", /[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/],
  ["an sk- key", /sk-(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}/],
  ["a JSON Web Token", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/],
  ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** NAME=value or NAME: value where the name says it is a secret. The value is judged by looksRandom. */
const SECRET_ASSIGNMENT = /(?:secret|token|passw(?:or)?d|api_?key|access_?key|private_?key)[A-Za-z0-9_]*["']?\s{0,2}[=:]\s{0,2}["'`]?([A-Za-z0-9/+_-]{16,})/gi;

function entropyBits(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

/** What scanners call a high-entropy string: mixed character classes and few repeats. Words and identifiers are not. */
function looksRandom(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[/+]/].filter((kind) => kind.test(value)).length;
  return classes >= 3 && entropyBits(value) >= 3.5;
}

export function secretShapes(line: string): string[] {
  const found = TOKEN_SHAPES.filter(([, shape]) => shape.test(line)).map(([name]) => name);
  for (const match of line.matchAll(SECRET_ASSIGNMENT)) {
    if (looksRandom(match[1]!)) found.push("a secret-looking value assigned to a secret-looking name");
  }
  return found;
}

test("no source file contains a literal that a secret scanner would take for a credential", () => {
  const offenders: string[] = [];
  for (const dir of ["src", "test", "scripts"]) {
    for (const file of sourceFiles(join(root, dir))) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          for (const what of secretShapes(line)) offenders.push(`${relative(root, file)}:${index + 1} looks like ${what}`);
        });
    }
  }
  assert.deepEqual(offenders, [], "build such test values at run time from parts; see the comment above this test");
});

test("the credential rule recognizes what it is for and leaves ordinary code alone", () => {
  const join_ = (...parts: string[]) => parts.join("");
  const flagged = [
    join_("gh", "p_", "a1B2".repeat(9)),
    join_("AK", "IA", "ABCDEFGH12345678"),
    join_("sk_", "live_", "abcdefghij1234"),
    join_("ey", "J", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", "abc123def456"),
    join_("-----BEGIN RSA ", "PRIVATE KEY-----"),
    join_("AWS_SECRET_", "ACCESS_KEY=", "wJalrXUtn", "FEMI/K7MDENG"),
    join_('"api_key": "', "Zx9Qw3Er7Ty1Ui5Op2As", '"'),
  ];
  for (const line of flagged) assert.notDeepEqual(secretShapes(line), [], line.slice(0, 12));
  const fine = [
    "const token = await getTokenFromTheKeychain(paths, options);",
    'password: cleanText(raw.password, LIMITS.name) || "unknown",',
    "AWS_SECRET_ACCESS_KEY=EXAMPLEEXAMPLEEXAMPLE",
    "DB_PASSWORD=hunter2",
    'const SECRET_NAME = "(?:secret|token|passwd|password|pwd|api[_-]?key)";',
    "  session_id: 6835a033-358b-4497-a94e-356ac1bac1e3",
    "sha: 33a14c5feb7c5dccc5e6dd99ff4f0d8215659304",
  ];
  for (const line of fine) assert.deepEqual(secretShapes(line), [], line);
});
