// Bundles src/cli.ts into one readable file, dist/huddle.mjs. No minification:
// the bundle is vendored into users' repos and should be reviewable.
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outfile = join(root, "dist", "huddle.mjs");

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node\n// git-huddle " + pkg.version + " - https://github.com/DevomB/huddle - generated file, do not edit" },
  define: { __HUDDLE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
