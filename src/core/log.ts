// The debug log at <git-common-dir>/huddle/log. Failures in hooks and
// background syncs are logged here and swallowed; `huddle doctor` points at it.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "./clock.ts";

const MAX_LOG_BYTES = 512 * 1024;

/** Appends one line. Never throws: logging must not be the thing that breaks a hook. */
export function log(target: { logFile: string } | null, scope: string, message: string, error?: unknown): void {
  if (!target) return;
  try {
    const detail = error === undefined ? "" : ` | ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    const line = `${nowIso()} ${process.pid} [${scope}] ${message}${detail}`.replace(/\r?\n/g, "\\n") + "\n";
    try {
      if (statSync(target.logFile).size > MAX_LOG_BYTES) renameSync(target.logFile, `${target.logFile}.1`);
    } catch {
      // No log yet.
    }
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
