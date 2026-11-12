// T2.3. The AGENTS.md block: tier 2, for any agent that reads AGENTS.md and can
// run a shell command. Not a hook adapter, so it does not implement Adapter.

import { todo } from "../core/io.ts";
import type { CheckResult, InstallOptions, InstallResult } from "./types.ts";

/** Delimits the managed block so install can replace it in place and leave the rest of the file alone. */
export const AGENTS_MD_BEGIN = "<!-- huddle:begin -->";
export const AGENTS_MD_END = "<!-- huddle:end -->";

/** The block itself, markers included: when and how to run huddle status / intent / decide / check. */
export function agentsMdBlock(opts: Pick<InstallOptions, "bundle">): string {
  void opts;
  return todo("agents-md.agentsMdBlock");
}

/** Creates AGENTS.md or updates the managed block in it. Idempotent. */
export async function installAgentsMd(opts: InstallOptions): Promise<InstallResult> {
  void opts;
  return todo("agents-md.installAgentsMd");
}

export async function checkAgentsMd(repoRoot: string): Promise<CheckResult> {
  void repoRoot;
  return todo("agents-md.checkAgentsMd");
}
