// T2.1. From what a person typed to the intent that is published for it.
//
// The intent is the first 200 characters of a prompt (plan.md §2, decision 8)
// or the text given to `huddle intent`, and everyone who can read the repo can
// read it. A prompt can hold a pasted credential: agents mark only long pastes,
// so a two-line env file arrives as if it had been typed. scrubSecrets takes
// out what looks like one before the text is cut and stored.
//
// It is a best effort and not a guarantee. It knows shapes, not secrets: a
// password that reads like a word passes, and so does a key in a format it has
// never seen. `captureIntent: false` is the switch for a team that cannot
// accept that.

import { LIMITS, cleanText } from "../core/docs.ts";

export const REDACTED = "[redacted]";

/**
 * How much of the text is looked at. The intent is its first 200 characters;
 * the rest of the window is there so that a secret which starts before the cut
 * and ends after it is still recognized whole.
 */
const WINDOW_CHARS = 4000;

/** Words that say the value next to them is a secret. */
const SECRET_NAME = "(?:secret|token|passwd|password|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)";
const NAME = `[A-Za-z0-9_.-]{0,40}${SECRET_NAME}[A-Za-z0-9_.-]{0,40}`;
const VALUE = `(?:"[^"\\n]{1,300}"|'[^'\\n]{1,300}'|[^\\s"',;]{1,300})`;

/** A PEM block, to its END line or to the end of the window when the END line is beyond it. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g;

/** A user name and password in front of the host of a URL. What is kept is the scheme. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}@/gi;

/** The value of an Authorization header. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{16,})/gi;

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

/**
 * NAME=value. Written without spaces it is an env file or a command line, and
 * the value goes whatever it is. With spaces it is more often code
 * ("token = await getToken()"), so there the value has to look like a secret
 * as well (see looksSecret). "==" and "=>" are never an assignment.
 */
const ASSIGNED = new RegExp(`\\b(${NAME})(\\s{0,2}=(?![=>])\\s{0,2})(${VALUE})`, "gi");

/** NAME: value, as in YAML, JSON and prose. Prose is why the value has to look like a secret too. */
const LABELLED = new RegExp(`\\b(${NAME}["']?\\s{0,2}:\\s{0,2})(${VALUE})`, "gi");

/** Standard base64 long enough to be key material. Also what a long path looks like, hence the tests in scrubSecrets. */
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;

/** One unbroken word of the characters that hex, base62, base64url and UUIDs are made of. */
const TOKEN_RUN = /[A-Za-z0-9+=_-]{24,}/g;

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

/**
 * Does the value next to "password" look like a password rather than like the
 * next word of a sentence or of a line of code? A quoted string does, and so
 * does anything with a digit in it or too long to be a word.
 */
function looksSecret(value: string): boolean {
  return /^["']/.test(value) || /[0-9]/.test(value) || value.length >= 16;
}

/**
 * `text` with everything that looks like a credential replaced by
 * "[redacted]": PEM blocks, passwords inside URLs, Authorization values,
 * tokens with a known prefix, NAME=value and NAME: value where the name says
 * secret, token, password or key, and long runs that look random.
 *
 * Best effort (see the top of this file). It errs towards redacting: a commit
 * id or a UUID goes too, which costs a teammate nothing.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME, (match, scheme: string, gap: string, value: string) => (/[0-9]/.test(value) ? `${scheme}${gap}${REDACTED}` : match))
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(PREFIXED_KEY, (match) => (/[0-9]/.test(match) ? REDACTED : match))
    .replace(ASSIGNED, (match, name: string, equals: string, value: string) =>
      equals === "=" || looksSecret(value) ? `${name}${equals}${REDACTED}` : match,
    )
    .replace(LABELLED, (match, label: string, value: string) => (looksSecret(value) ? `${label}${REDACTED}` : match))
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
