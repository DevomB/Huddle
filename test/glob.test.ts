import assert from "node:assert/strict";
import { test } from "node:test";
import { claimMatches, globMatch, normalizePath } from "../src/core/glob.ts";

test("glob: a literal pattern matches only that path", () => {
  assert.equal(globMatch("src/auth.ts", "src/auth.ts"), true);
  assert.equal(globMatch("src/auth.ts", "src/auth.tsx"), false);
  assert.equal(globMatch("src/auth.ts", "src/auth"), false);
  assert.equal(globMatch("src/auth.ts", "lib/src/auth.ts"), false);
  assert.equal(globMatch("src/Auth.ts", "src/auth.ts"), false, "matching is case-sensitive");
});

test("glob: * matches within one path segment and never crosses a slash", () => {
  assert.equal(globMatch("src/*.ts", "src/auth.ts"), true);
  assert.equal(globMatch("src/*.ts", "src/.ts"), true, "* may match nothing");
  assert.equal(globMatch("src/*.ts", "src/auth/jwt.ts"), false);
  assert.equal(globMatch("*.ts", "auth.ts"), true);
  assert.equal(globMatch("*.ts", "src/auth.ts"), false, "patterns are anchored at the repo root");
  assert.equal(globMatch("src/*/index.ts", "src/auth/index.ts"), true);
  assert.equal(globMatch("src/*/index.ts", "src/a/b/index.ts"), false);
  assert.equal(globMatch("src/a*b*c.ts", "src/aXbYc.ts"), true);
  assert.equal(globMatch("src/a*b*c.ts", "src/abc.ts"), true);
  assert.equal(globMatch("src/a*b*c.ts", "src/acb.ts"), false);
  assert.equal(globMatch("*", ".env"), true, "dotfiles are not special");
});

test("glob: ? matches exactly one character, never a slash", () => {
  assert.equal(globMatch("src/?.ts", "src/a.ts"), true);
  assert.equal(globMatch("src/?.ts", "src/ab.ts"), false);
  assert.equal(globMatch("src/?.ts", "src/.ts"), false);
  assert.equal(globMatch("src?auth.ts", "src/auth.ts"), false);
  assert.equal(globMatch("v?/api.ts", "v2/api.ts"), true);
  assert.equal(globMatch("docs/?.md", "docs/😀.md"), true, "one code point, not one UTF-16 unit");
});

test("glob: ** matches zero or more whole segments", () => {
  assert.equal(globMatch("src/**", "src/auth.ts"), true);
  assert.equal(globMatch("src/**", "src/auth/jwt/verify.ts"), true);
  assert.equal(globMatch("src/**", "lib/auth.ts"), false);
  assert.equal(globMatch("src/**", "srcs/auth.ts"), false);
  assert.equal(globMatch("**/jwt.ts", "jwt.ts"), true, "leading ** matches zero directories");
  assert.equal(globMatch("**/jwt.ts", "src/auth/jwt.ts"), true);
  assert.equal(globMatch("**/jwt.ts", "src/auth/jwt.tsx"), false);
  assert.equal(globMatch("src/**/jwt.ts", "src/jwt.ts"), true, "middle ** matches zero directories");
  assert.equal(globMatch("src/**/jwt.ts", "src/a/b/c/jwt.ts"), true);
  assert.equal(globMatch("src/**/jwt.ts", "lib/a/jwt.ts"), false);
  assert.equal(globMatch("**", "anything/at/all.ts"), true);
  assert.equal(globMatch("**/*.test.ts", "test/unit/glob.test.ts"), true);
  assert.equal(globMatch("**/*.test.ts", "test/unit/glob.ts"), false);
  assert.equal(globMatch("src/**/**/x.ts", "src/x.ts"), true, "repeated ** collapses");
  assert.equal(globMatch("a/**/b/**/c", "a/b/c"), true);
  assert.equal(globMatch("a/**/b/**/c", "a/x/b/y/z/c"), true);
  assert.equal(globMatch("a/**/b/**/c", "a/x/y/c"), false);
});

test("glob: ** inside a segment behaves like *", () => {
  assert.equal(globMatch("src/a**.ts", "src/auth.ts"), true);
  assert.equal(globMatch("src/a**.ts", "src/a/uth.ts"), false);
});

test("glob: a trailing slash means everything under that directory", () => {
  assert.equal(globMatch("src/auth/", "src/auth/jwt.ts"), true);
  assert.equal(globMatch("src/auth/", "src/auth/deep/er.ts"), true);
  assert.equal(globMatch("src/auth/", "src/authz/jwt.ts"), false);
});

test("glob: brackets, braces and regex metacharacters are literal", () => {
  assert.equal(globMatch("app/[slug]/page.tsx", "app/[slug]/page.tsx"), true);
  assert.equal(globMatch("app/[slug]/page.tsx", "app/s/page.tsx"), false);
  assert.equal(globMatch("app/[...all]/*.tsx", "app/[...all]/page.tsx"), true);
  assert.equal(globMatch("src/a+b(c).{ts}", "src/a+b(c).{ts}"), true);
  assert.equal(globMatch("src/a.ts", "src/abts"), false, "a dot is a dot");
  assert.equal(globMatch("src/$^|.ts", "src/$^|.ts"), true);
});

test("glob: pattern and path are normalized the same way", () => {
  assert.equal(globMatch("./src/*.ts", "src/auth.ts"), true);
  assert.equal(globMatch("/src/*.ts", "src/auth.ts"), true);
  assert.equal(globMatch("src//auth.ts", "./src/auth.ts"), true);
  assert.equal(globMatch("  src/auth.ts  ", "src/auth.ts"), true, "surrounding whitespace is not part of a pattern");
  assert.equal(normalizePath("./src//auth/./jwt.ts/"), "src/auth/jwt.ts");
  assert.equal(normalizePath("/"), "");
  assert.equal(normalizePath("."), "");
});

test("glob: empty, blank and oversized input never matches", () => {
  assert.equal(globMatch("", "src/auth.ts"), false);
  assert.equal(globMatch("   ", "src/auth.ts"), false);
  assert.equal(globMatch("", ""), false);
  assert.equal(globMatch("src/*", ""), false);
  assert.equal(globMatch(`${"a".repeat(2000)}*`, "a".repeat(2000)), false, "patterns over the cap are rejected");
  assert.equal(globMatch("**", "a/".repeat(3000)), false, "paths over the cap are rejected");
});

test("glob: patterns built to make a regex engine backtrack still finish at once", () => {
  const started = performance.now();
  // Translated to a RegExp, patterns like these backtrack catastrophically.
  assert.equal(globMatch(`${"*a".repeat(40)}*b`, "a".repeat(400)), false);
  assert.equal(globMatch(`${"**/".repeat(40)}nope`, `${"x/".repeat(200)}y`), false);
  assert.equal(globMatch(`${"**/a/".repeat(30)}b`, `${"a/".repeat(300)}c`), false);
  assert.equal(claimMatches(`${"*?".repeat(60)}z`, `${"q".repeat(300)}/${"q".repeat(300)}`), false);
  assert.ok(performance.now() - started < 2000, "pathological patterns must not hang a pre-edit hook");
});

test("claims: a claim covers the path it matches and everything under a directory it matches", () => {
  assert.equal(claimMatches("src/auth", "src/auth/jwt.ts"), true, "a bare directory claims its contents");
  assert.equal(claimMatches("src/auth", "src/auth/deep/er/file.ts"), true);
  assert.equal(claimMatches("src/auth", "src/auth"), true);
  assert.equal(claimMatches("src/auth", "src/authz/jwt.ts"), false, "a prefix of a name is not a parent directory");
  assert.equal(claimMatches("src/auth", "src"), false, "a claim does not cover its own parents");
  assert.equal(claimMatches("src/*", "src/auth/jwt.ts"), true, "a glob that matches a directory claims its contents");
  assert.equal(claimMatches("src/pages/**", "src/pages/login.tsx"), true);
  assert.equal(claimMatches("src/pages/**", "src/components/Form.tsx"), false);
  assert.equal(claimMatches("*.md", "README.md"), true);
  assert.equal(claimMatches("*.md", "docs/guide.md"), false);
  assert.equal(claimMatches("**/*.md", "docs/guide.md"), true);
  assert.equal(claimMatches("src/auth.ts", "src/auth.ts"), true);
  assert.equal(claimMatches("src/auth.ts", "src/auth.tsx"), false);
});

test("claims: the repo root claims everything; nothing claims the empty path", () => {
  assert.equal(claimMatches(".", "src/auth.ts"), true);
  assert.equal(claimMatches("/", "README.md"), true);
  assert.equal(claimMatches("./", "a/b/c"), true);
  assert.equal(claimMatches("**", "a/b/c"), true);
  assert.equal(claimMatches("**", ""), false);
  assert.equal(claimMatches("", "src/auth.ts"), false);
  assert.equal(claimMatches("   ", "src/auth.ts"), false);
});
