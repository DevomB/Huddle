// Source hygiene. Invisible and bidi characters in source are a review hazard,
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
