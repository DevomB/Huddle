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
// One digit each, and not where a run of random characters would have them: only the prefix gives these two away.
const SK_KEY = tok("s", "k-", "ant-api03-", "a".repeat(20), "1");
const STRIPE_KEY = tok("s", "k_", "live_", "c".repeat(20), "4");
const BEARER = "ab12".repeat(6);
const DB_URL = tok("postgres", "://", "admin", ":", "hunter2", "@", "db.internal:5432/app");
const BASE64 = "Ab1/".repeat(11);
const HEX = "a1b2".repeat(12);
/** What "user:pass" is in an Authorization header. */
const BASIC = Buffer.from("user:pass").toString("base64");
/** A Basic value with no digit and no capital after a small letter: "=" at its end is all that tells it from a word. */
const PADDED = Buffer.from("a:").toString("base64");
/** Twenty small letters: only the length tells them from a word. */
const LETTERS = "abcdefghijklmnopqrst";

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
  { name: "an AWS access key id", text: `deploy with ${AWS_KEY_ID} ok`, leak: AWS_KEY_ID, scrubbed: `deploy with ${REDACTED} ok` },
  { name: "a Google API key", text: `maps key ${GOOGLE_KEY}`, leak: "a".repeat(35) },
  { name: "an npm token", text: `publish with ${NPM_TOKEN}`, leak: "b".repeat(36) },
  { name: "a JSON Web Token", text: `decode ${JWT} for me`, leak: JWT_HEAD, scrubbed: `decode ${REDACTED} for me` },
  { name: "a key that starts sk-", text: `call it with ${SK_KEY} now`, leak: "a".repeat(20), scrubbed: `call it with ${REDACTED} now` },
  { name: "a Stripe key", text: `charge with ${STRIPE_KEY}`, leak: "c".repeat(20), scrubbed: `charge with ${REDACTED}` },
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
  { name: "a long random base64 string", text: `sign with ${BASE64} ok`, leak: "Ab1/Ab1/", scrubbed: `sign with ${REDACTED} ok` },
  { name: "a long hex string", text: `seed ${HEX} done`, leak: "a1b2a1b2" },

  // Names. What stands before the word that gives a name away is of any length.
  {
    name: "a name of any length",
    text: tok("SPRING_DATASOURCE_HIKARI_CONNECTION_POOL_PRIMARY_PASS", "WORD=", "hunter2"),
    leak: "hunter2",
    scrubbed: tok("SPRING_DATASOURCE_HIKARI_CONNECTION_POOL_PRIMARY_PASS", "WORD=", REDACTED),
  },
  { name: "a passphrase", text: tok("PASSPHR", "ASE=", "swordfish"), leak: "swordfish", scrubbed: tok("PASSPHR", "ASE=", REDACTED) },
  // The short words count as a whole part of a name. In capitals that is an env file, and the value goes whatever it is.
  { name: "an env name that ends in PASS", text: tok("DB_HOST=localhost\nDB_PA", "SS=", "swordfish", "\nDB_USER=app"), leak: "swordfish" },
  { name: "an env name that ends in KEY", text: tok("ENCRYPTION_K", "EY=", "swordfish"), leak: "swordfish", scrubbed: tok("ENCRYPTION_K", "EY=", REDACTED) },
  { name: "AUTH in capitals", text: tok("AU", "TH=", "swordfish"), leak: "swordfish", scrubbed: tok("AU", "TH=", REDACTED) },
  { name: "key= in small letters, with a value that has digits", text: tok("the k", "ey=", "hunter29z", " is set"), leak: "hunter29z" },
  { name: "a camel-case name that ends in Key", text: tok("Account", "Key=", "hunter2Zq"), leak: "hunter2Zq", scrubbed: tok("Account", "Key=", REDACTED) },
  { name: "a signature in a URL", text: tok("https://s.test/f?s", "ig=", "hunter29zQ", "&x=1"), leak: "hunter29zQ" },
  { name: "a short word with a colon", text: tok("SIGNING_K", "EY: ", "hunter2"), leak: "hunter2", scrubbed: tok("SIGNING_K", "EY: ", REDACTED) },
  { name: "pass: and a value", text: tok("pa", "ss: ", "hunter2"), leak: "hunter2" },
  { name: "a weak word with a capital at the start of a line", text: tok("Sig", "nature: ", "v1a2b3c4x", " for the upload"), leak: "v1a2b3c4x" },
  { name: "a name that goes on after the word", text: tok("SECRET_K", "EY_BASE=", "swordfish", " rails s"), leak: "swordfish", scrubbed: tok("SECRET_K", "EY_BASE=", REDACTED, " rails s") },
  { name: "a connection string", text: tok("Server=db;User Id=sa;P", "wd=", "hunter2", ";"), leak: "hunter2", scrubbed: tok("Server=db;User Id=sa;P", "wd=", REDACTED) },
  { name: "a password of 16 letters, which is too long to be a word", text: tok("the pass", "word: ", "correcthorsebatt", " and go"), leak: "correcthorse", scrubbed: tok("the pass", "word: ", REDACTED, " and go") },
  { name: "a password that is a small number", text: tok("the pass", "word: ", "1234", " opens it"), leak: "1234", scrubbed: tok("the pass", "word: ", REDACTED, " opens it") },
  { name: "a JSON value that reads like a word", text: tok('{"pass', 'word": "', "swordfish", '"}'), leak: "swordfish", scrubbed: tok('{"pass', 'word": ', REDACTED, "}") },

  // A line that is nothing but a name and a value is a line of a config file, and its value goes whatever it looks like.
  {
    name: "a line of a YAML file",
    text: tok("why can it not connect\nhost: db.internal\npass", "word: ", "swordfish", "\nuser: admin"),
    leak: "swordfish",
    scrubbed: tok("why can it not connect\nhost: db.internal\npass", "word: ", REDACTED, "\nuser: admin"),
  },
  { name: "a line of a properties file", text: tok("spring.datasource.pass", "word = ", "swordfish"), leak: "swordfish", scrubbed: tok("spring.datasource.pass", "word = ", REDACTED) },
  { name: "an item of a YAML list", text: tok("  - pass", "word: ", "swordfish"), leak: "swordfish", scrubbed: tok("  - pass", "word: ", REDACTED) },
  { name: "an env name with a short word and blanks around the =", text: tok("DB_PA", "SS = ", "swordfish"), leak: "swordfish", scrubbed: tok("DB_PA", "SS = ", REDACTED) },
  { name: "a line of a Makefile", text: tok("DB_PASS", "WORD := ", "swordfish"), leak: "swordfish", scrubbed: tok("DB_PASS", "WORD := ", REDACTED) },
  {
    name: "an env name with a short word in a YAML file",
    text: tok("environment:\n  DB_PA", "SS: ", "swordfish", "\n  DB_USER: app"),
    leak: "swordfish",
    scrubbed: tok("environment:\n  DB_PA", "SS: ", REDACTED, "\n  DB_USER: app"),
  },
  {
    name: "a config line that ends with a carriage return",
    text: tok("user: admin\r\npass", "word: ", "swordfish", "\r\nhost: db"),
    leak: "swordfish",
    scrubbed: tok("user: admin\r\npass", "word: ", REDACTED, "\r\nhost: db"),
  },

  // Values. All of one goes, whatever is in it: what is left of a password after "[redacted]" is still most of it.
  { name: "a value with a comma in it", text: tok("PASS", "WORD=", "hunter2", ",Zx9!rest"), leak: "Zx9!rest", scrubbed: tok("PASS", "WORD=", REDACTED) },
  { name: "a value with a semicolon in it", text: tok("PASS", "WORD=", "hunter2", ";Zx9!rest"), leak: "Zx9!rest", scrubbed: tok("PASS", "WORD=", REDACTED) },
  { name: "a value with a quote in it", text: tok("pass", "word=", "it's", "hunter2"), leak: "hunter2", scrubbed: tok("pass", "word=", REDACTED) },
  {
    name: "a quoted value with an escaped quote in it",
    text: tok('"pass', 'word": "', 'ab\\"', "hunter2", '"'),
    leak: "hunter2",
    scrubbed: tok('"pass', 'word": ', REDACTED),
  },
  { name: "a value of 400 characters", text: tok("PASS", "WORD=", "ab1,".repeat(100), " and more"), leak: "ab1,ab1,", scrubbed: tok("PASS", "WORD=", REDACTED, " and more") },
  { name: "an assignment the way Go writes it", text: tok("set pass", 'word := "', "hunter2", '" in main.go'), leak: "hunter2", scrubbed: tok("set pass", "word := ", REDACTED, " in main.go") },
  { name: "a pair the way Ruby and PHP write it", text: tok("'pass", "word' => '", "hunter2", "',"), leak: "hunter2", scrubbed: tok("'pass", "word' => ", REDACTED, ",") },
  {
    name: "a sentence that says what the password is",
    text: tok("the admin pass", "word is ", "hunter2", ", please log in and fix the page"),
    leak: "hunter2",
    scrubbed: tok("the admin pass", "word is ", REDACTED, " please log in and fix the page"),
  },
  { name: "a sentence with 'is:' in it", text: tok("the pass", "word is: ", "hunter2"), leak: "hunter2", scrubbed: tok("the pass", "word is: ", REDACTED) },
  { name: "a sentence that says what the key is", text: tok("the k", "ey is ", "x7Kq2Lm9", " for now"), leak: "x7Kq2Lm9", scrubbed: tok("the k", "ey is ", REDACTED, " for now") },
  // Three places where a digit meets a letter are what "random-looking" asks for, and this has three.
  { name: "a random-looking word right after 'token'", text: tok("use to", "ken ", "abcd1234", "efgh5678", " for staging"), leak: "abcd1234", scrubbed: tok("use to", "ken ", REDACTED, " for staging") },
  { name: "a random-looking run of 24 characters with no name", text: `send ${"a1B2".repeat(6)} along`, leak: "a1B2a1B2", scrubbed: `send ${REDACTED} along` },

  // Command lines.
  { name: "a long flag and its value", text: tok("mysql -u root --pass", "word ", "hunter2", " app"), leak: "hunter2", scrubbed: tok("mysql -u root --pass", "word ", REDACTED, " app") },
  { name: "a long flag with the word at the end of one part", text: tok("tool --dbpass", "word ", "hunter2", " run"), leak: "hunter2", scrubbed: tok("tool --dbpass", "word ", REDACTED, " run") },
  { name: "a long flag that is a short word", text: tok("tool --pa", "ss ", "hunter2", " run"), leak: "hunter2", scrubbed: tok("tool --pa", "ss ", REDACTED, " run") },
  { name: "a long flag that ends in a short word", text: tok("tool --ssh-k", "ey ", "hunter2Zq", " run"), leak: "hunter2Zq", scrubbed: tok("tool --ssh-k", "ey ", REDACTED, " run") },
  { name: "-u and then -p", text: tok("docker login -u me -p ", "hunter2"), leak: "hunter2", scrubbed: `docker login -u me -p ${REDACTED}` },
  { name: "-u and then -p, written without blanks", text: tok("mysql -uroot -p", "swordfish", " app"), leak: "swordfish", scrubbed: `mysql -uroot -p${REDACTED} app` },
  { name: "sshpass", text: tok("sshpass -p ", "swordfish", " ssh host"), leak: "swordfish", scrubbed: `sshpass -p ${REDACTED} ssh host` },
  { name: "curl -u", text: tok("curl -u admin:", "hunter2", " https://x.test/api"), leak: "hunter2", scrubbed: `curl -u ${REDACTED} https://x.test/api` },
  { name: "curl --user", text: tok("curl --user admin:", "hunter2", " https://x.test/api"), leak: "hunter2", scrubbed: `curl --user ${REDACTED} https://x.test/api` },
  { name: "curl --user=", text: tok("curl --user=admin:", "hunter2", " https://x.test/api"), leak: "hunter2", scrubbed: `curl --user=${REDACTED} https://x.test/api` },

  // URLs and headers.
  {
    name: "a password inside a URL that has an @ in it",
    text: tok("https", "://", "user", ":", "p@", "hunter2", "@", "host.test/x"),
    leak: "hunter2",
    scrubbed: tok("https", "://", REDACTED, "@", "host.test/x"),
  },
  {
    name: "a token as the user name of a URL",
    text: tok("git clone https", "://", "a1b2".repeat(4), "@", "git.test/r.git"),
    leak: "a1b2a1b2",
    scrubbed: tok("git clone https", "://", REDACTED, "@", "git.test/r.git"),
  },
  { name: "a short Basic value", text: tok("Authorization: Ba", "sic ", BASIC), leak: BASIC, scrubbed: tok("Authorization: Ba", "sic ", REDACTED) },
  { name: "a short Bearer value", text: tok("Authorization: Bea", "rer ", "a1B2".repeat(3)), leak: "a1B2a1B2", scrubbed: tok("Authorization: Bea", "rer ", REDACTED) },
  { name: "a short value of another scheme", text: tok("Authorization: To", "ken ", "abc123"), leak: "abc123", scrubbed: tok("Authorization: To", "ken ", REDACTED) },
  { name: "a short Basic value that only its padding gives away", text: tok("Authorization: Ba", "sic ", PADDED), leak: PADDED, scrubbed: tok("Authorization: Ba", "sic ", REDACTED) },
  { name: "a long Bearer value of small letters only", text: tok("Authorization: Bea", "rer ", LETTERS), leak: LETTERS, scrubbed: tok("Authorization: Bea", "rer ", REDACTED) },
  { name: "a short Bearer value without the header", text: tok("send Bea", "rer ", "a1B2".repeat(3), " along"), leak: "a1B2a1B2", scrubbed: tok("send Bea", "rer ", REDACTED, " along") },
  { name: "a Cookie header", text: tok("Cookie: session=", "a1b2".repeat(3), "; theme=dark"), leak: "a1b2a1b2", scrubbed: `Cookie: ${REDACTED}` },
  {
    name: "a Set-Cookie header, to the end of its line",
    text: tok("Set-Cookie: sid=", "a1b2".repeat(3), "; Path=/; HttpOnly\nand then it fails"),
    leak: "a1b2a1b2",
    scrubbed: `Set-Cookie: ${REDACTED}\nand then it fails`,
  },
  { name: "32 hex digits that spell nothing random", text: `checksum ${"aaaaaaaabbbbbbbb".repeat(2)} is wrong`, leak: "aaaaaaaabbbbbbbb", scrubbed: `checksum ${REDACTED} is wrong` },
  { name: "32 hex digits in capitals", text: `checksum ${"AAAAAAAABBBBBBBB".repeat(2)} is wrong`, leak: "AAAAAAAABBBBBBBB", scrubbed: `checksum ${REDACTED} is wrong` },
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
  assert.match(PADDED, /^[A-Za-z]+=+$/);
  assert.doesNotMatch(PADDED, /[a-z][A-Z]/);
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
    "port sha256_hmac_v2_x86_64 to aarch64",

    // The words that say "secret", where what follows them is code or the next word of a sentence.
    "token = await getToken() is slow",
    "the password: field must be required",
    "why is api_key: undefined in prod",
    "token: implementation of refresh is broken",
    "password: must be at least 8 characters",
    "the password: notwithstanding the reset, is kept",
    "the User type needs a password: string",
    "password = generatePassword(16) is too slow",
    "secret: deriveKeyFromPassphrase(input) throws",
    "the password is 8 characters long and the token is expired",
    "token sha256sum and password argon2id are the two hashes",
    "move the token src/v2a3b4c5/x1 to lib",
    "check that password==confirm2 and token=>next2 still parse",
    "this line fails:\npassword==confirm\ntoken=>next",
    "run it with --token $CI_JOB_TOKEN_V2 and --password ./secrets/db2.txt",
    "pass --password -v2 or --token ~/t2.txt or --secret /run/s3 or --token C:\\keys\\t2.txt",
    "set --user-agent chrome120 and --password-stdin for docker",

    // The short words, which are in every other sentence.
    "auth: implement JWT refresh",
    "the key: value pairs in the map are sorted wrong",
    "use key=value pairs for the query string",
    "sort by key = name and then by date",
    "press the any key to continue, or pass the flag --verbose 2",
    "pass: 12 tests, fail: 3 tests in the last run",
    "the pass rate is 97% and the auth flow has 3 steps",
    "the key is 16 bytes and the sig is 64",
    "auth = require('./auth') fails on node 22",
    "signature: (a: number, b: number) => void is wrong for add",
    "make the primary key: id and the foreign key: user_id",
    'the map has "key": "id" and "sig": "none" in it',
    'the JSON {"key": "42", "value": "x"} is wrong',
    "for key:=0; key<n; key++ { is the loop",
    "why does keyboard.key = event.code not fire on arm64",
    "const pass = tests.filter(ok) and const sig = sign(body)",
    "the design: 3 columns, the passphrase prompt and the keymap",
    "set monkey=banana2 in the fixture",
    "the compass: 3d model is missing and author: jane2 wrote it",
    "the keys: a1 and b2 are swapped, passes: 3x faster, signed: v2 only",
    "the PWA: v2 shell and the pwd command",
    "use --key ./certs/server2.key and --auth basic with --bypass v2rules and --sig 4",
    "set key = 'id' and pass = 3 in the test",
    "the config has\nkey: value\nname: thing\nin it",
    "fields:\n  name: required\n  email: optional\nand the key: value pairs",

    // Command lines, URLs and headers with nothing secret in them.
    "mkdir -p out/v2 and cp -p a1 b2",
    "the sk-learn-compatible-estimators package",
    "run npm test -- -u to update snapshots, then git push -u origin main",
    "docker run -p 8080:80 nginx and ssh -p 2222 host",
    "docker run -u node -p 8080:80 app and -u node -p 127.0.0.1:3000:3000/tcp or -u app -p 5432",
    "mysql -u root -p asks for the password on the terminal",
    "grep -u is not a flag, use curl -u only with a netrc",
    "curl -u name:password is how basic auth goes",
    "git clone ssh://git@github.com/acme/app.git",
    "http://localhost:3000/@scope/pkg and https://example.com:8080/path",
    "email me at dev@example.com about the bypass: 2 options",
    "Authorization: Basic auth is not enough here",
    "Cookie: consent=yes is set by the banner",
  ];
  for (const text of ordinary) assert.equal(scrubSecrets(text), text);
});

test("scrubSecrets errs towards taking out: a commit id, a UUID and a long name with digits all through it go too", () => {
  assert.equal(scrubSecrets("revert 3f2a9c1e8b7d6f5a4e3d2c1b0a9f8e7d6c5b4a39 please"), `revert ${REDACTED} please`);
  assert.equal(scrubSecrets("order 123e4567-e89b-12d3-a456-426614174000 is stuck"), `order ${REDACTED} is stuck`);
  // Nothing tells these from key material but a dictionary, and that this has none of.
  assert.equal(scrubSecrets("fix test_utf8_to_utf16_base64_v2 on arm64"), `fix ${REDACTED} on arm64`);
  assert.equal(scrubSecrets("rename handleOAuth2CallbackForV3Tenants"), `rename ${REDACTED}`);
  // A line that is nothing but a name and one word is taken for a line of a config file.
  assert.equal(scrubSecrets(tok("pass", "word: required")), tok("pass", "word: ", REDACTED));
});

test("every word that says secret says so in capitals too, and anywhere in a name", () => {
  const strong = [
    tok("sec", "ret"),
    tok("to", "ken"),
    tok("pass", "wd"),
    tok("pass", "word"),
    tok("pass", "phrase"),
    "pwd",
    tok("api", "key"),
    tok("api_", "key"),
    tok("api-", "key"),
    tok("access", "key"),
    tok("access_", "key"),
    tok("access-", "key"),
    tok("private", "key"),
    tok("private_", "key"),
    tok("private-", "key"),
    "credential",
    "credentials",
  ];
  for (const word of strong) {
    for (const name of [word, word.toUpperCase(), `my${word}`, `MY_${word.toUpperCase()}_2`, `${word}.primary`]) {
      // Not a line of its own, and a value that is only a word: the name alone decides.
      assert.equal(scrubSecrets(`set ${name}=swordfish now`), `set ${name}=${REDACTED} now`, name);
      // The other ways of writing it take a value that looks like one.
      assert.equal(scrubSecrets(`set ${name}: sword9fish now`), `set ${name}: ${REDACTED} now`, name);
      assert.equal(scrubSecrets(`the ${name} is sword9fish now`), `the ${name} is ${REDACTED} now`, name);
    }
  }
});

test("the short words say secret as a whole part of a name: always in an env name, otherwise with a value that looks like one", () => {
  for (const word of ["pass", "pw", "psw", "key", "auth", "sig", "signature", "creds"]) {
    const upper = word.toUpperCase();
    const capital = `${upper.charAt(0)}${word.slice(1)}`;
    // In capitals it is an env name, and the value goes whatever it is.
    assert.equal(scrubSecrets(`run DB_${upper}=swordfish make`), `run DB_${upper}=${REDACTED} make`, word);
    assert.equal(scrubSecrets(`run ${upper}_2=swordfish make`), `run ${upper}_2=${REDACTED} make`, word);
    // In small letters it is a word like any other, until the value has a digit in it.
    assert.equal(scrubSecrets(`the ${word}=swordfish pair`), `the ${word}=swordfish pair`, word);
    assert.equal(scrubSecrets(`the ${word}=sword9fish pair`), `the ${word}=${REDACTED} pair`, word);
    assert.equal(scrubSecrets(`the ${word}: sword9fish pair`), `the ${word}: ${REDACTED} pair`, word);
    assert.equal(scrubSecrets(`${capital}: sword9fish`), `${capital}: ${REDACTED}`, word);
    // The capital that starts a part of a camel-case name.
    assert.equal(scrubSecrets(`the account${capital}=sword9fish pair`), `the account${capital}=${REDACTED} pair`, word);
    // Inside a longer word it is not there at all.
    const inside = `the x${word}=sword9fish and ${word}x: sword9fish and ${upper}X=swordfish pairs`;
    assert.equal(scrubSecrets(inside), inside, word);
  }
});

test("scrubSecrets knows shapes and not secrets: what the top of intent.ts says gets through does", () => {
  // These are limits that are written down there. A change that closes one of them takes it off that list too.
  const through: Array<[text: string, left: string]> = [
    [tok("the pass", "word: ", "swordfish", " works on staging"), "swordfish"],
    [tok("pass", "word=", "correct", " horse battery"), " horse battery"],
    [tok("the k", "ey=", "swordfish", " pair"), "swordfish"],
    [`send ${"a1B2".repeat(6).slice(0, 23)} along`, "a1B2a1B2"],
    [tok("ssh-keygen -N ", "sword9fish", " -f id"), "sword9fish"],
  ];
  for (const [text, left] of through) assert.ok(scrubSecrets(text).includes(left), text);
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
    // For the command lines, the flags, the headers and the config lines.
    "=-u".repeat(30_000),
    "=--user=aaaaaaaa".repeat(5_000),
    "-ua     -p     ".repeat(5_000),
    `--${"a-".repeat(50_000)}`,
    `--${"token-".repeat(10_000)}`,
    `password="${'\\"'.repeat(50_000)}`,
    'key: "aaaa bbbb '.repeat(5_000),
    "password is ".repeat(5_000),
    "Cookie: a=b; ".repeat(5_000),
    `Cookie: ${"a".repeat(50_000)}`,
    `${"a".repeat(31)}g`.repeat(2_000),
    "name: value\n".repeat(5_000),
    `${"a".repeat(130)}: b\n`.repeat(500),
    "a://b@".repeat(10_000),
    `a://b:${"c@".repeat(20_000)}`,
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
