// T2.1. From what a person typed to the intent that is published for it.
//
// The intent is the first 200 characters of a prompt (plan.md §2, decision 8)
// or the text given to `huddle intent`, and everyone who can read the repo can
// read it. A prompt can hold a pasted credential: agents mark only long pastes,
// so a two-line env file arrives as if it had been typed. scrubSecrets takes
// out what looks like one before the text is cut and stored.
//
// It is a best effort and not a guarantee. It knows shapes, not secrets, and
// what it cannot tell from ordinary writing passes:
//
//   - a password that reads like a word, in a line that goes on after it:
//     "the password: swordfish works" could be prose. (A line that is nothing
//     but "password: swordfish" is a config file, and is taken.)
//   - what comes after the first blank of a value that is not in quotes
//   - a word with no digit in it after "key", "pass" or "auth" in small
//     letters: "key=value" is how people write about maps
//   - a random run that no name announces and that is shorter than 24
//     characters, has punctuation in it, or is broken by a line wrap
//   - the one-letter flags of particular tools, other than -p after -u,
//     sshpass -p and curl -u
//   - text written to get past it: a character that only looks like "=", an
//     invisible one inside a name
//
// `captureIntent: false` is the switch for a team that cannot accept that.

import { LIMITS, cleanText } from "../core/docs.ts";

export const REDACTED = "[redacted]";

/**
 * How much of the text is looked at. The intent is its first 200 characters;
 * the rest of the window is there so that a secret which starts before the cut
 * and ends after it is still recognized whole.
 */
const WINDOW_CHARS = 4000;

// ---------------------------------------------------------------------------
// Names that say "secret", and the values next to them
// ---------------------------------------------------------------------------

/** Words that say the value next to them is a secret, wherever they stand in a name: DB_PASSWORD, clientSecret. */
const STRONG = "(?:secret|token|passwd|password|passphrase|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)";

/**
 * Words that say so only as a whole part of a name: DB_PASS, signingKey, AUTH,
 * sig. Inside a longer word they are something else (compass, monkey, author,
 * design). The patterns they are in tell capitals from small letters, which is
 * how the K of accountKey starts a part and the k of monkey does not, so each
 * word is spelled out in the three ways it is written.
 */
const WEAK_WORDS = ["pass", "pw", "psw", "key", "auth", "sig", "signature", "creds"];
const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
const WEAK =
  `(?:(?<![A-Za-z])(?:${WEAK_WORDS.flatMap((word) => [word, capital(word), word.toUpperCase()]).join("|")})` +
  `|(?<=[a-z])(?:${WEAK_WORDS.map(capital).join("|")}))(?![A-Za-z])`;

/** What a name may go on with after such a word: PASSWORD_FILE, token.primary. What comes before the word needs no pattern. */
const TAIL = "[A-Za-z0-9_.-]{0,80}";

/** A value in quotes. A quote with a backslash before it does not end it. */
const QUOTED = `"(?:[^"\\\\\\n]|\\\\.)+"|'(?:[^'\\\\\\n]|\\\\.)+'`;
/**
 * A value: in quotes, or else everything up to the next blank. Not up to the
 * next comma or quote: a password may have either in it, and what is left of
 * one after "[redacted]" is still most of a password.
 */
const VALUE = `(?:${QUOTED}|\\S+)`;

/**
 * NAME=value. Written without spaces it is an env file or a command line, and
 * the value goes whatever it is. With spaces it is more often code
 * ("token = await getToken()"), so there the value has to look like a secret
 * as well (see looksSecret). ":=" is an assignment too; "==" and "=>" never are.
 */
const assigned = (name: string, flags: string): RegExp => new RegExp(`(${name}${TAIL})(\\s{0,2}:?=(?![=>])\\s{0,2})(${VALUE})`, flags);
/** NAME: value, as in YAML, JSON and prose. Prose is why the value has to look like a secret too. */
const labelled = (name: string, flags: string): RegExp => new RegExp(`(${name}${TAIL}["']?\\s{0,2}:(?!=)\\s{0,2})(${VALUE})`, flags);
/** "the password is value", as people write it. */
const stated = (name: string, flags: string): RegExp => new RegExp(`(${name}${TAIL}\\s+is:?\\s+)(${VALUE})`, flags);

const ASSIGNED_STRONG = assigned(STRONG, "gi");
const ASSIGNED_WEAK = assigned(WEAK, "g");
const LABELLED_STRONG = labelled(STRONG, "gi");
const LABELLED_WEAK = labelled(WEAK, "g");
const STATED_STRONG = stated(STRONG, "gi");
const STATED_WEAK = stated(WEAK, "g");

/** 'password' => 'value', the way Ruby and PHP write a pair. Only with the value in quotes: "token => refresh(token)" is a function. */
const ROCKET = new RegExp(`(${STRONG}${TAIL}["']?\\s{0,2}=>\\s{0,2})(?:${QUOTED})`, "gi");

/**
 * --password value: a long flag whose name ends with one of the words. With
 * "=" in between it is an assignment, see above. A weak word is the whole last
 * part of the name: --pass and --ssh-key, and not --bypass.
 */
const FLAG_STRONG = new RegExp(`(--[A-Za-z0-9_-]{0,80}?${STRONG}\\s+)(${VALUE})`, "gi");
const FLAG_WEAK = new RegExp(`(--(?:[A-Za-z0-9]+[-_])*(?:${WEAK_WORDS.join("|")})\\s+)(${VALUE})`, "g");

/** A strong word and then the next word, as in "use token a1B2c3D4". Counts when that word looks random (see nextTo). */
const NEXT_TO = new RegExp(`(${STRONG}${TAIL}\\s+)(\\S+)`, "gi");

/** A name in capitals, as in an env file: there even "KEY=" is not prose. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * A line that is nothing but NAME: value or NAME = value, as a YAML file and a
 * properties file have them. Nobody writes a sentence that way, so there the
 * value goes whatever it looks like, when the name has a strong word in it or
 * is an env name with a weak one. "key: value" stays: it is not in capitals.
 */
const CONFIG_LINE = new RegExp(`^([ \\t]*(?:[-*][ \\t]+)?)([A-Za-z_][A-Za-z0-9_.-]{0,120})([ \\t]{0,2}(?::=?|=)(?![=>])[ \\t]{0,2})(${VALUE})[ \\t]*$`, "gm");
const HAS_STRONG = new RegExp(STRONG, "i");
const HAS_WEAK = new RegExp(WEAK);

// ---------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------

/**
 * -u name -p value, as mysql and `docker login` take it, with or without the
 * blanks. Only after a -u: a -p alone is a port, or "parents", or "preserve".
 */
const USER_THEN_P = /(?<![\w-])(-u\s?[^\s-]\S{0,80}\s+-p)(\s?)(\S+)/g;
/** What -p means for docker: 8080, 8080:80, 127.0.0.1:8080:80/tcp. */
const PORTS = /^(?:[\d.]+:)?\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/;

/** sshpass -p value: there the -p is never anything else. */
const SSHPASS = /(\bsshpass\s+-p\s?)(\S+)/g;

/** -u name:password and --user name:password, as curl takes them. */
const USER_COLON = /(?<![\w-])((?:-u|--user)(?:\s+|=))[^\s:]{1,80}:(\S+)/g;

// ---------------------------------------------------------------------------
// Shapes that need no name
// ---------------------------------------------------------------------------

/** A PEM block, to its END line or to the end of the window when the END line is beyond it. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g;

/**
 * A user name and password in front of the host of a URL. What is kept is the
 * scheme. The password ends at the last "@" before the path: one that has an
 * "@" in it should have been written %40, and often is not.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/:@]{1,256}:[^\s/]{1,256}@/gi;
/** A URL with nothing but a user name in front of the host. A token is used that way (https://<token>@host); so is "git". */
const URL_USER = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/:@]{1,256})@/gi;

/** The value of an Authorization header, of whatever length. Proxy-Authorization ends with the same word. */
const AUTH_HEADER = /\b(Authorization["']?\s{0,2}:\s{0,2}(?:Bearer|Basic|Digest|Token|Negotiate)\s+)([^\s"']+)/gi;
/** The same two words without the header in front of them. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/** A Cookie or Set-Cookie header: everything on its line, once the first cookie in it has a value that looks like one. */
const COOKIE = /\b(Cookie["']?\s{0,2}:\s{0,2})[^\s=;"']{1,80}=([^\s;"']+)[^\n"']*/gi;

/** Tokens that announce themselves by their first characters. */
const KNOWN_TOKEN = new RegExp(
  "(?<![A-Za-z0-9_-])(?:" +
    [
      "gh[pousr]_[A-Za-z0-9]{20,}", // GitHub
      "github_pat_[A-Za-z0-9_]{20,}",
      "glpat-[A-Za-z0-9_-]{16,}", // GitLab
      "xox[abeoprs]-[A-Za-z0-9-]{10,}", // Slack
      "(?:AKIA|ASIA)[0-9A-Z]{16}", // AWS access key id
      "AIza[0-9A-Za-z_-]{30,}", // Google API key
      "npm_[A-Za-z0-9]{30,}",
      "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}", // a JSON Web Token
    ].join("|") +
    ")",
  "g",
);

/**
 * "sk-..." (OpenAI, Anthropic and the many that copied the shape) and Stripe's
 * "sk_live_...". Also the start of ordinary hyphenated words, so a match only
 * counts when it has a digit in it.
 */
const PREFIXED_KEY = /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|[rs]k_(?:live|test)_[A-Za-z0-9]{10,})/g;

/** 32 or more hex digits in one case: a digest or a key, whatever the letters in it spell. */
const HEX_RUN = /(?<![A-Za-z0-9])(?:[0-9a-f]{32,}|[0-9A-F]{32,})(?![A-Za-z0-9])/g;

/** Standard base64 long enough to be key material. Also what a long path looks like, hence the tests in scrubSecrets. */
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;

/** One unbroken word of the characters that hex, base62, base64url and UUIDs are made of. */
const TOKEN_RUN = /[A-Za-z0-9+=_-]{24,}/g;

// ---------------------------------------------------------------------------
// Does it look like a secret?
// ---------------------------------------------------------------------------

/**
 * How often a digit sits directly next to a letter. Random key material
 * switches between the two every few characters; identifiers, file names and
 * dates keep their digits together.
 */
function mixing(text: string): number {
  let count = 0;
  let previous = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const kind = code >= 48 && code <= 57 ? 1 : (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ? 2 : 0;
    if (kind !== 0 && previous !== 0 && kind !== previous) count++;
    previous = kind;
  }
  return count;
}

const RANDOM_LOOKING = 3;

/** "getToken(" and the like: the start of a call, which is code and not a value. */
const CALL = /^[A-Za-z_$][\w$.]*\(/;
/** Up to five digits and nothing else: a count, a port, a status code. */
const SMALL_NUMBER = /^[0-9]{1,5}[.,;:)\]}]?$/;
/** Where a value starts when it is a path, a variable or the next flag. */
const PATH_LIKE = /^(?:[-$~./]|[A-Za-z]:[\\/])/;

/**
 * Does the value next to "password" look like a password rather than like the
 * next word of a sentence or of a line of code? A quoted string does, and so
 * does anything with a digit in it or too long to be a word. A call does not.
 *
 * Next to a weak word (`weak`) the bar is higher, because "key" and "pass" are
 * in every other sentence: the quotes prove nothing ("key": "id"), and a small
 * number is a count ("pass: 12 tests").
 */
function looksSecret(value: string, weak = false): boolean {
  const quoted = /^["']/.test(value);
  if (quoted && !weak) return true;
  const bare = quoted ? value.slice(1).replace(/["'][.,;:)\]}]?$/, "") : value;
  if (CALL.test(bare)) return false;
  if (weak && SMALL_NUMBER.test(bare)) return false;
  return /[0-9]/.test(bare) || bare.length >= 16;
}

/**
 * Is the word after "token" a token? Only when it looks random, as the long
 * runs below have to: "token sha256sum" and "password argon2id" are how
 * people write about code.
 */
function nextTo(value: string): boolean {
  return !value.includes("/") && mixing(value) >= RANDOM_LOOKING;
}

/** What follows "Authorization: Basic": a digit, a capital inside the word, padding, or too long to be a word. */
function looksEncoded(value: string): boolean {
  return /[0-9]|[a-z][A-Z]|=$/.test(value) || value.length >= 16;
}

/**
 * `text` with everything that looks like a credential replaced by
 * "[redacted]": PEM blocks, passwords and tokens inside URLs, Authorization
 * and Cookie values, tokens with a known prefix, NAME=value, NAME: value and
 * "NAME is value" where the name says secret, token, password or key, the
 * lines of a config file with such a name, the passwords of the usual command
 * lines, and long runs that look random.
 *
 * Best effort (see the top of this file). It errs towards redacting: a commit
 * id or a UUID goes too, which costs a teammate nothing.
 */
export function scrubSecrets(text: string): string {
  const named = (weak: boolean) => (match: string, label: string, value: string) => (looksSecret(value, weak) ? `${label}${REDACTED}` : match);
  return text
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(URL_USER, (match, scheme: string, user: string) => (looksSecret(user) ? `${scheme}${REDACTED}@` : match))
    .replace(AUTH_HEADER, (match, head: string, value: string) => (looksEncoded(value) ? `${head}${REDACTED}` : match))
    .replace(AUTH_SCHEME, (match, scheme: string, gap: string, value: string) => (/[0-9]/.test(value) ? `${scheme}${gap}${REDACTED}` : match))
    .replace(COOKIE, (match, head: string, first: string) => (looksSecret(first, true) ? `${head}${REDACTED}` : match))
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(PREFIXED_KEY, (match) => (/[0-9]/.test(match) ? REDACTED : match))
    .replace(CONFIG_LINE, (match, head: string, name: string, separator: string) =>
      HAS_STRONG.test(name) || (ENV_NAME.test(name) && HAS_WEAK.test(name)) ? `${head}${name}${separator}${REDACTED}` : match,
    )
    .replace(ASSIGNED_STRONG, (match, name: string, equals: string, value: string) =>
      equals === "=" || looksSecret(value) ? `${name}${equals}${REDACTED}` : match,
    )
    .replace(ASSIGNED_WEAK, (match, name: string, equals: string, value: string) =>
      (equals === "=" && ENV_NAME.test(name)) || looksSecret(value, true) ? `${name}${equals}${REDACTED}` : match,
    )
    .replace(ROCKET, `$1${REDACTED}`)
    .replace(LABELLED_STRONG, named(false))
    .replace(LABELLED_WEAK, named(true))
    // In a sentence a small number is a length or a count, whatever word it follows: "the password is 8 characters".
    .replace(STATED_STRONG, (match, label: string, value: string) => (!SMALL_NUMBER.test(value) && looksSecret(value) ? `${label}${REDACTED}` : match))
    .replace(STATED_WEAK, named(true))
    .replace(FLAG_STRONG, (match, flag: string, value: string) => (!PATH_LIKE.test(value) && looksSecret(value) ? `${flag}${REDACTED}` : match))
    .replace(FLAG_WEAK, (match, flag: string, value: string) => (!PATH_LIKE.test(value) && looksSecret(value, true) ? `${flag}${REDACTED}` : match))
    .replace(NEXT_TO, (match, name: string, value: string) => (nextTo(value) ? `${name}${REDACTED}` : match))
    .replace(SSHPASS, `$1${REDACTED}`)
    .replace(USER_THEN_P, (match, head: string, gap: string, value: string) =>
      !PORTS.test(value) && (gap === "" || looksSecret(value)) ? `${head}${gap}${REDACTED}` : match,
    )
    .replace(USER_COLON, (match, head: string, value: string) => (looksSecret(value, true) ? `${head}${REDACTED}` : match))
    .replace(HEX_RUN, REDACTED)
    .replace(BASE64_RUN, (run) => (/[+/]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && mixing(run) >= RANDOM_LOOKING ? REDACTED : run))
    .replace(TOKEN_RUN, (run) => (mixing(run) >= RANDOM_LOOKING ? REDACTED : run));
}

/**
 * The intent for a prompt, or for the text given to `huddle intent`: scrubbed,
 * then made one clean line of at most 200 characters. "" for anything that is
 * not text or has nothing in it.
 */
export function toIntent(text: unknown): string {
  if (typeof text !== "string") return "";
  return cleanText(scrubSecrets(text.slice(0, WINDOW_CHARS)), LIMITS.intent);
}

/**
 * One short word: "yes", "continue", "ok", "/compact". As a prompt it tells a
 * teammate nothing about the work, so it does not replace an intent that does.
 * ASCII only, because a whole sentence can be one unbroken run in scripts that
 * do not put spaces between words.
 */
export function isBareWord(intent: string): boolean {
  return /^[\x21-\x7e]{1,24}$/.test(intent);
}
