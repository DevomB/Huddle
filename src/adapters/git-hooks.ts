// T3.2. Plain git hooks (post-commit, post-checkout, post-merge, pre-commit): the floor that covers every agent and humans. Chains with existing hooks and respects core.hooksPath.

import { todo } from "../core/io.ts";
import type { Adapter } from "./types.ts";

export const gitHooks: Adapter = {
  name: "git",
  title: "git hooks",
  detect: () => todo("git.detect"),
  install: () => todo("git.install"),
  check: () => todo("git.check"),
  parse: () => todo("git.parse"),
  format: () => todo("git.format"),
};
