// T2.1: from a prompt to the intent that is published for it (src/hooks/intent.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ELLIPSIS, LIMITS } from "../src/core/docs.ts";
import { readLocal } from "../src/core/store.ts";
import { REDACTED, isBareWord, scrubSecrets, toIntent } from "../src/hooks/intent.ts";
import { createHarness } from "./harness.ts";

// Everything below that is shaped like a credential is made up, and it is put
// together when the test runs. Secret scanners read this repository and cannot
// tell a test value from a real one (see test/source.test.ts), so no line of
// this file holds a whole one, and what follows a prefix is as dull as the
// shape allows.
const tok = (...parts: string[]) => parts.join("");

const GITHUB_TOKEN = tok("gh", "p_", "x".repeat(36));
const FINE_GRAINED = tok("github", "_pat_", "11", "A".repeat(20), "_", "b".repeat(30));
const GITLAB_TOKEN = tok("gl", "pat-", "A".repeat(20));
const SLACK_TOKEN = tok("xo", "xb-", "1".repeat(12), "-", "a".repeat(12));
const AWS_KEY_ID = tok("AK", "IA", "ABCDEFGHIJKLMNOP");
const GOOGLE_KEY = tok("AI", "za", "a".repeat(35));
const NPM_TOKEN = tok("np", "m_", "b".repeat(36));
const JWT_HEAD = tok("ey", "J", "h".repeat(12));
const JWT = tok(JWT_HEAD, ".", "ey", "J", "z".repeat(12), ".", "s".repeat(12));
const SK_KEY = tok("s", "k-", "ant-api03-", "a1".repeat(10));
const STRIPE_KEY = tok("s", "k_", "live_", "c4".repeat(12));
const BEARER = "ab12".repeat(6);
const DB_URL = tok("postgres", "://", "admin", ":", "hunter2", "@", "db.internal:5432/app");
const BASE64 = "Ab1/".repeat(11);
const HEX = "a1b2".repeat(12);

const DASHES = "-".repeat(5);
const pemEdge = (edge: "BEGIN" | "END", kind: string) => tok(DASHES, edge, " ", kind, DASHES);
const PEM_BODY = "EXAMPLEBODY".repeat(3);
const PEM = [pemEdge("BEGIN", "RSA PRIVATE KEY"), PEM_BODY, PEM_BODY, pemEdge("END", "RSA PRIVATE KEY")].join("\n");

/** What must never reach an intent, each with the part of it that would be the leak. */
const SECRETS: Array<{ name: string; text: string; leak: string; scrubbed?: string }> = [
  { name: "a GitHub token", text: `push with ${GITHUB_TOKEN} please`, leak: GITHUB_TOKEN, scrubbed: `push with ${REDACTED} please` },
  { name: "a fine-grained GitHub token", text: `use ${FINE_GRAINED} here`, leak: "A".repeat(20) },
  { name: "a GitLab token", text: `${GITLAB_TOKEN} is the token`, leak: "A".repeat(20) },
  { name: "a Slack token", text: `post with ${SLACK_TOKEN}`, leak: "1".repeat(12) },
  { name: "an AWS access key id", text: `the key is ${AWS_KEY_ID} ok`, leak: AWS_KEY_ID, scrubbed: `the key is ${REDACTED} ok` },
  { name: "a Google API key", text: `maps key ${GOOGLE_KEY}`, leak: "a".repeat(35) },
  { name: "an npm token", text: `publish with ${NPM_TOKEN}`, leak: "b".repeat(36) },
  { name: "a JSON Web Token", text: `decode ${JWT} for me`, leak: JWT_HEAD, scrubbed: `decode ${REDACTED} for me` },
  { name: "a key that starts sk-", text: `call it with ${SK_KEY} now`, leak: "a1".repeat(10) },
  { name: "a Stripe key", text: `charge with ${STRIPE_KEY}`, leak: "c4".repeat(12) },
  {
    name: "an Authorization header",
    text: `curl -H 'Authorization: Bearer ${BEARER}' api.example.com`,
    leak: BEARER,
    scrubbed: `curl -H 'Authorization: Bearer ${REDACTED}' api.example.com`,
  },
  {
    name: "a password inside a URL",
    text: `connect to ${DB_URL}`,
    leak: "hunter2",
    scrubbed: tok("connect to postgres", "://", REDACTED, "@", "db.internal:5432/app"),
  },
  { name: "a line of an env file", text: tok("DB_PASS", "WORD=", "hunter2"), leak: "hunter2", scrubbed: tok("DB_PASS", "WORD=", REDACTED) },
  { name: "an exported variable, whatever the value looks like", text: tok("export API_", "KEY=", "swordfish", " then run it"), leak: "swordfish" },
  { name: "a quoted assignment with spaces", text: tok("set pass", 'word = "', "correct horse", '" in the config'), leak: "correct horse" },
  { name: "an assignment with spaces and a digit in the value", text: tok("the to", "ken = ", "aaa111aaa", " is wrong"), leak: "aaa111aaa" },
  {
    name: "a YAML value",
    text: tok("api_", "key: ", "1a1a1a1a1a1a", " in config.yml"),
    leak: "1a1a1a1a1a1a",
    scrubbed: tok("api_", "key: ", REDACTED, " in config.yml"),
  },
  { name: "a JSON value", text: tok('{"client_', 'secret": "', "s3cr3t-value", '"}'), leak: "s3cr3t-value" },
  { name: "a PEM block", text: `here is the key\n${PEM}\nuse it`, leak: PEM_BODY, scrubbed: `here is the key\n${REDACTED}\nuse it` },
  { name: "a PEM block that is never closed", text: tok(pemEdge("BEGIN", "OPENSSH PRIVATE KEY"), "\n", PEM_BODY, "\nmore of it"), leak: PEM_BODY },
  { name: "a long random base64 string", text: `the signing key is ${BASE64} ok`, leak: "Ab1/Ab1/" },
  { name: "a long hex string", text: `seed ${HEX} done`, leak: "a1b2a1b2" },
];

test("the made-up credentials have the shape of the real thing", () => {
  // If one of them stopped matching what it stands for, the test below would pass for the wrong reason.
  assert.match(GITHUB_TOKEN, /^ghp_[a-z]{36}$/);
  assert.match(FINE_GRAINED, /^github_pat_[A-Za-z0-9_]{50,}$/);
  assert.match(GITLAB_TOKEN, /^glpat-[A-Z]{20}$/);
  assert.match(SLACK_TOKEN, /^xoxb-[0-9]{12}-[a-z]{12}$/);
  assert.match(AWS_KEY_ID, /^AKIA[A-Z]{16}$/);
  assert.match(GOOGLE_KEY, /^AIza[a-z]{35}$/);
  assert.match(NPM_TOKEN, /^npm_[a-z]{36}$/);
  assert.equal(JWT.split(".").length, 3);
  assert.ok(JWT.startsWith("eyJ"));
  assert.ok(SK_KEY.startsWith("sk-ant-"));
  assert.ok(STRIPE_KEY.startsWith("sk_live_"));
  assert.match(DB_URL, /^[a-z]+:\/\/[a-z]+:[a-z0-9]+@db\./);
  assert.equal(PEM.split("\n")[0], `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}`);
  assert.equal(DASHES, "-----");
});

test("scrubSecrets takes out what looks like a credential and keeps the words around it", () => {
  for (const { name, text, leak, scrubbed } of SECRETS) {
    const result = scrubSecrets(text);
    assert.ok(text.includes(leak), `${name}: the test itself is wrong, the text does not hold the leak`);
    assert.ok(!result.includes(leak), `${name}: the secret is still there in ${JSON.stringify(result)}`);
    assert.ok(result.includes(REDACTED), `${name}: nothing was marked as taken out in ${JSON.stringify(result)}`);
    if (scrubbed !== undefined) assert.equal(result, scrubbed, name);
    assert.ok(!toIntent(text).includes(leak), `${name}: the secret is in the intent`);
  }
});

test("scrubSecrets leaves ordinary prompts, code and paths alone", () => {
  const ordinary = [
    "Build the JWT middleware in src/auth.ts",
    "why does const token = await getToken() fail",
    "fix the password reset flow so the token expires after an hour",
    "rename getAccessToken to fetchAccessToken everywhere",
    "the token: field is missing from the response",
    "set the password to something longer than eight characters",
    "if (password === confirmation) and token => refresh(token) both look wrong",
    "add a secret santa page with a private key icon",
    "look at src/components/dashboard/widgets/RevenueChartContainer.tsx and tidy it up",
    "read https://example.com/docs/guides/getting-started/installation-on-linux first",
    "use bearer authentication and basic error handling",
    "skip the sk-learn import in the notebook and the task-management-service-integration tests",
    "bump react from 18.2.0 to 19.0.0 and node to 22.11.0 in package.json",
    "the build on 2026-11-12 failed at step 14 of 20 in release-candidate-pipeline-for-staging",
    "git log --oneline -5 shows nothing for feat/login-redirect",
  ];
  for (const text of ordinary) assert.equal(scrubSecrets(text), text);
});

test("scrubSecrets errs towards taking out: a commit id and a UUID go too", () => {
  assert.equal(scrubSecrets("revert 3f2a9c1e8b7d6f5a4e3d2c1b0a9f8e7d6c5b4a39 please"), `revert ${REDACTED} please`);
  assert.equal(scrubSecrets("order 123e4567-e89b-12d3-a456-426614174000 is stuck"), `order ${REDACTED} is stuck`);
});

test("toIntent gives one clean line of at most 200 characters, scrubbed before it is cut", () => {
  assert.equal(toIntent("  build\n\tthe login   page \r\n"), "build the login page");
  assert.equal(toIntent(""), "");
  assert.equal(toIntent(" \n "), "");
  for (const notText of [undefined, null, 42, {}, ["a prompt"]]) assert.equal(toIntent(notText), "");

  const long = toIntent(`refactor ${"the parser ".repeat(40)}`);
  assert.equal(Array.from(long).length, LIMITS.intent);
  assert.ok(long.endsWith(ELLIPSIS));
  assert.equal(toIntent("x".repeat(200)), "x".repeat(200), "exactly 200 characters are not cut");

  // The cut comes after the scrub: a secret that starts before character 200 and ends after it is recognized whole.
  const straddling = toIntent(`${"word ".repeat(37)}${GITHUB_TOKEN} and more`);
  assert.ok(!straddling.includes("xxxx"), straddling);
  assert.ok(straddling.includes(REDACTED), straddling);
  assert.equal(Array.from(straddling).length, LIMITS.intent);
  // A PEM block whose END line is far beyond what is looked at still goes, to the end.
  const endless = tok("deploy with ", pemEdge("BEGIN", "PRIVATE KEY"), "\n", `${PEM_BODY}\n`.repeat(200), pemEdge("END", "PRIVATE KEY"));
  assert.equal(toIntent(endless), `deploy with ${REDACTED}`);
  // Unsafe characters never get through, whatever the scrub did.
  assert.equal(toIntent(`build${String.fromCodePoint(0x202e)}auth${String.fromCodePoint(0x2028)}now`), "build auth now");
});

test("toIntent stays fast on text built to make a pattern backtrack", () => {
  const hostile = [
    "a".repeat(100_000),
    `${DASHES}BEGIN `.repeat(5_000),
    `${DASHES}BEGIN ${"A ".repeat(3_000)}`,
    "x=".repeat(50_000),
    `password=${"'".repeat(50_000)}`,
    'password="'.repeat(10_000),
    "token ".repeat(20_000),
    "token".repeat(20_000),
    "a://".repeat(20_000),
    `a://${"b".repeat(300)}:${"c".repeat(50_000)}`,
    "secret: ".repeat(10_000),
    "Bearer ".repeat(10_000),
    `${"A1".repeat(19)} `.repeat(2_000),
    "sk-".repeat(30_000),
    "eyJ.".repeat(20_000),
  ];
  for (const text of hostile) {
    const started = performance.now();
    const intent = toIntent(text);
    const took = performance.now() - started;
    assert.ok(took < 250, `${JSON.stringify(text.slice(0, 20))}... took ${Math.round(took)} ms`);
    assert.ok(Array.from(intent).length <= LIMITS.intent);
  }
});

test("isBareWord: one short ASCII word, which as a prompt says nothing about the work", () => {
  for (const word of ["yes", "continue", "ok.", "/compact", "y", "LGTM!", "x".repeat(24)]) assert.equal(isBareWord(word), true, word);
  for (const not of ["", "two words", "x".repeat(25), "fix it", `caf${String.fromCodePoint(0xe9)}`, String.fromCodePoint(0x7d9a, 0x3051, 0x3066)]) {
    assert.equal(isBareWord(not), false, JSON.stringify(not));
  }
});

test("huddle intent stores the scrubbed text, like a prompt's intent", async (t) => {
  const h = await createHarness(t);
  const alice = await h.clone("alice");
  const assigned = tok("API_", "KEY=");
  const set = await alice.huddle(["intent", "deploy", "with", `${assigned}abc123`, "then", GITHUB_TOKEN]);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout, `intent: deploy with ${assigned}${REDACTED} then ${REDACTED}\n`);
  const [session] = (await readLocal(await alice.paths())).sessions;
  assert.equal(session?.intent, `deploy with ${assigned}${REDACTED} then ${REDACTED}`);
  assert.equal(session?.intentSource, "manual");
  assert.equal((await alice.huddle(["intent"])).stdout, `deploy with ${assigned}${REDACTED} then ${REDACTED}\n`);

  // A text that is nothing but a secret is still an intent: teammates learn that something is going on.
  assert.equal((await alice.huddle(["intent", GITHUB_TOKEN])).stdout, `intent: ${REDACTED}\n`);
  // Blank is still refused.
  assert.equal((await alice.huddle(["intent", "  "])).code, 2);
});
