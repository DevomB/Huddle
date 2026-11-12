// T2.2. Claude Code hooks, installed into .claude/settings.json. Read the current docs first: https://code.claude.com/docs/en/hooks

import { todo } from "../core/io.ts";
import type { Adapter } from "./types.ts";

export const claudeCode: Adapter = {
  name: "claude-code",
  title: "Claude Code",
  detect: () => todo("claude-code.detect"),
  install: () => todo("claude-code.install"),
  check: () => todo("claude-code.check"),
  parse: () => todo("claude-code.parse"),
  format: () => todo("claude-code.format"),
};
