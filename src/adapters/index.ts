// The adapter registry. M0 wiring: a new adapter is one import and one line here.

import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { gitHooks } from "./git-hooks.ts";
import type { Adapter } from "./types.ts";

export const ADAPTERS: readonly Adapter[] = [claudeCode, codex, cursor, gitHooks];

export function getAdapter(name: string): Adapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name);
}
