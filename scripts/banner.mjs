// The first lines of dist/huddle.mjs. They run before any bundled module does,
// which is the point: the guard below also covers a module that throws while
// the bundle is still loading.

/** Plain JavaScript that must run on old versions of Node too. Exported for tests. */
export const GUARD = `{
  const hook = process.argv[2] === "hook";
  if (Number(process.versions.node.split(".")[0]) < 20) {
    // An agent runs its hooks with whatever node is on its PATH. An old one must not turn every tool call into an error.
    if (!hook) process.stderr.write("huddle needs Node 20 or newer; this is Node " + process.versions.node + "\\n");
    process.exit(hook ? 0 : 1);
  }
  if (hook) {
    // A hook never breaks the agent: whatever goes wrong, it exits 0 and stays quiet. HUDDLE_DEBUG=1 shows why.
    const quiet = (error) => {
      if (process.env.HUDDLE_DEBUG) process.stderr.write("huddle hook: " + ((error && error.stack) || error) + "\\n");
      process.exit(0);
    };
    process.on("uncaughtException", quiet);
    process.on("unhandledRejection", quiet);
  }
}`;

/** `huddle init` recognizes a bundle by the first two lines (see commands/init.ts). */
export function banner(version) {
  return ["#!/usr/bin/env node", `// git-huddle ${version} - https://github.com/DevomB/huddle - generated file, do not edit`, GUARD].join("\n");
}
