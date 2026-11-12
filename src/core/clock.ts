// The one clock. Every module that needs "now" gets it from here so that tests
// can pin time with HUDDLE_NOW (an ISO-8601 string or epoch milliseconds).

import type { Iso } from "./types.ts";

export function now(env: NodeJS.ProcessEnv = process.env): Date {
  const pinned = env.HUDDLE_NOW;
  if (pinned !== undefined && pinned !== "") {
    const parsed = /^\d+$/.test(pinned) ? new Date(Number(pinned)) : new Date(pinned);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function nowIso(env: NodeJS.ProcessEnv = process.env): Iso {
  return now(env).toISOString();
}

/** Milliseconds since the epoch, or NaN when `iso` is not a date. */
export function parseIso(iso: Iso): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

/** Milliseconds from `iso` until `at`. NaN when `iso` is not a date. Negative when `iso` is in the future. */
export function ageMs(iso: Iso, at: Date): number {
  return at.getTime() - parseIso(iso);
}
