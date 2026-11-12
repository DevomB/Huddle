// The debug log at <git-common-dir>/huddle/log. Failures in hooks and
// background syncs are logged here and swallowed; `huddle doctor` points at it.

import { appendFileSync, mkdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "./clock.ts";
import { replaceUnsafe } from "./docs.ts";

export const MAX_LOG_BYTES = 512 * 1024;
const ROTATION_GUARD_MAX_AGE_MS = 10_000;

/**
 * Moves a full log to log.1. Hooks fail in bursts, so several processes see
 * the full log at once; without a guard the second one would move the first
 * one's fresh, nearly empty log over the history it just saved. mkdir is
 * atomic, so only one of them rotates. A guard left by a process that died in
 * between is removed once it is old.
 */
function rotateIfFull(logFile: string): void {
  try {
    if (statSync(logFile).size <= MAX_LOG_BYTES) return;
  } catch {
    return; // No log yet.
  }
  const guard = `${logFile}.rotating`;
  try {
    mkdirSync(guard);
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > ROTATION_GUARD_MAX_AGE_MS) rmdirSync(guard);
    } catch {
      // Gone already.
    }
    return;
  }
  try {
    // Checked again now that we are alone: another process may have rotated a moment ago.
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
  } catch {
    // Nothing to rotate after all.
  } finally {
    try {
      rmdirSync(guard);
    } catch {
      // Best effort.
    }
  }
}

/** Appends one line. Never throws: logging must not be the thing that breaks a hook. */
export function log(target: { logFile: string } | null, scope: string, message: string, error?: unknown): void {
  if (!target) return;
  try {
    const detail = error === undefined ? "" : ` | ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    // One entry is one line. Line breaks stay readable as "\n"; any other control or invisible
    // character (error text can quote a teammate's document, or a terminal escape) becomes "?".
    const line = replaceUnsafe(`${nowIso()} ${process.pid} [${scope}] ${message}${detail}`.replace(/\r?\n/g, "\\n"), "?") + "\n";
    rotateIfFull(target.logFile);
    try {
      appendFileSync(target.logFile, line);
    } catch {
      mkdirSync(dirname(target.logFile), { recursive: true });
      appendFileSync(target.logFile, line);
    }
  } catch {
    // Nothing useful to do.
  }
}
