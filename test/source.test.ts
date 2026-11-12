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

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mjs|json)$/.test(name) ? [path] : [];
  });
}

const HIDDEN_RANGES: [number, number][] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

test("no source file contains control, invisible or bidi characters", () => {
  const offenders: string[] = [];
  for (const dir of ["src", "test", "scripts"]) {
    for (const file of sourceFiles(join(root, dir))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const ch of line) {
          const codePoint = ch.codePointAt(0)!;
          if (HIDDEN_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to)) {
            offenders.push(`${relative(root, file)}:${index + 1} U+${codePoint.toString(16).padStart(4, "0")}`);
          }
        }
      });
    }
  }
  assert.deepEqual(offenders, []);
});
