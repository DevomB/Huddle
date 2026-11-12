// MVP lead: the scrub's bar for durable shared text (src/hooks/intent.ts),
// which `huddle decide` and task titles use to refuse a credential, and the
// fixes that the review of the wider scrub asked for (draft PR #12, findings
// 1 and 2).

import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, hasCredential, scrubSecrets } from "../src/hooks/intent.ts";

// Everything below that is shaped like a credential is made up and is put
// together when the test runs, so that no line of this file holds a whole one
// (see test/source.test.ts and the note at the top of test/intent.test.ts).
const tok = (...parts: string[]) => parts.join("");

/**
 * Sentences a team records as decisions. The intent scrub blurs a word in each
 * of them, which costs an intent nothing. As durable text none may be refused:
 * a refused decision is a rule nobody gets to record.
 */
const ORDINARY: readonly string[] = [
  "Webhook signature: v2 format (HMAC-SHA256) from now on",
  "Primary key: uuid7 for all new tables",
  "Auth: oauth2 with PKCE only",
  "Pass: 3/5 retries max for webhooks",
  "the token is opaque2 format from now on",
  "Cookie: lang=en2 is the only cookie we set before consent",
  "Partition key: tenant_id2 in DynamoDB",
  "Sig: ed25519 for release artifacts",
  "Creds: 1Password only, vault Eng2",
  "Password: 12 characters minimum",
];

const RANDOM = tok("a1B2", "c3D4", "e5F6");
const HUNTER = tok("hun", "ter2");

/** What stays refused as durable text, each with the part that must not survive. */
const CREDENTIALS: ReadonlyArray<[text: string, secret: string]> = [
  [tok("deploy with API", "_KEY=", "AUDIT_FAKE_", "1234567890"), tok("AUDIT_FAKE_", "1234567890")],
  [tok("CI pushes with gh", "p_", "x".repeat(36)), "x".repeat(36)],
  [tok("staging db is postgres", "://", "admin", ":", HUNTER, "@", "db.internal:5432/app"), HUNTER],
  [tok("cache is redis", "://", ":", HUNTER, "@", "localhost:6379/0"), HUNTER],
  [tok("the staging login is pass", "word: ", HUNTER), HUNTER],
  [tok("signing key: ", RANDOM, " until Friday"), RANDOM],
  [tok("send Authorization: Bear", "er ", "ab12".repeat(6)), "ab12".repeat(6)],
  [tok("the session token is ", RANDOM), RANDOM],
  [tok("-----BEGIN RSA PRIV", "ATE KEY-----\nMIIB", "x".repeat(20)), tok("MIIB", "x".repeat(20))],
];

test("durable text: ordinary sentences with a short word after key, pass, auth or token are not taken for credentials", () => {
  for (const sentence of ORDINARY) {
    assert.equal(scrubSecrets(sentence, { durable: true }), sentence, sentence);
    assert.equal(hasCredential(sentence), false, sentence);
  }
});

test("durable text: the same sentences are still blurred in an intent, where a blurred word costs nothing", () => {
  const blurred = ORDINARY.filter((sentence) => scrubSecrets(sentence) !== sentence);
  // Not every sentence has to be: what matters is that the durable bar is the higher one, and that it is really in use.
  assert.ok(blurred.length >= 6, `the intent scrub changed only ${blurred.length} of ${ORDINARY.length}`);
  for (const sentence of blurred) assert.ok(scrubSecrets(sentence).includes(REDACTED), sentence);
});

test("durable text: what is shaped like a credential is still refused, and the scrub takes the secret out of what it shows", () => {
  for (const [text, secret] of CREDENTIALS) {
    assert.equal(hasCredential(text), true, text);
    const shown = scrubSecrets(text, { durable: true });
    assert.ok(shown.includes(REDACTED), text);
    assert.equal(shown.includes(secret), false, text);
    // Nothing that durable text refuses passes as an intent.
    assert.equal(scrubSecrets(text).includes(secret), false, text);
  }
});

test("a URL password with an empty user name is taken, as Redis URLs are written", () => {
  const url = tok("redis", "://", ":", HUNTER, "@", "localhost:6379/0");
  assert.equal(scrubSecrets(url), `redis://${REDACTED}@localhost:6379/0`);
  assert.equal(scrubSecrets(`REDIS_URL=${url}`).includes(HUNTER), false);
  // A port is not a password: there is no "@" after it.
  const plain = "http://localhost:8080/a@b and https://example.com: see the page";
  assert.equal(scrubSecrets(plain), plain);
});
