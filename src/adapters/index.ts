// The adapter registry. M0 wiring: a new adapter is one import and one line here.
//
// MVP scope (2026-11-12): Claude Code and Codex are the agents this version
// sets up, and the plain git hooks are there for whoever asks for them
// (`huddle init --agent git`). The Gemini CLI and Cursor adapters are not
// part of it: they are in the history of this repository (src/adapters/
// gemini-cli.ts and cursor.ts, last present in commit 0346504), not in what ships.

import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { gitHooks } from "./git-hooks.ts";
import type { Adapter } from "./types.ts";

export const ADAPTERS: readonly Adapter[] = [claudeCode, codex, gitHooks];

export function getAdapter(name: string): Adapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name);
}
