// T3.1. Codex hooks, installed into <repo>/.codex/hooks.json. Read the current docs first: https://developers.openai.com/codex/hooks

import { todo } from "../core/io.ts";
import type { Adapter } from "./types.ts";

export const codex: Adapter = {
  name: "codex",
  title: "Codex",
  detect: () => todo("codex.detect"),
  install: () => todo("codex.install"),
  check: () => todo("codex.check"),
  parse: () => todo("codex.parse"),
  format: () => todo("codex.format"),
};
