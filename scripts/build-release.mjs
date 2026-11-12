// Builds the one release archive: dist/huddle-<version>.tar.gz and its .sha256.
// Dependency-free. Run `npm run build` first (`npm run release` does both).
//
//   node scripts/build-release.mjs [--out <dir>]
//
// huddle-<version>/
//   huddle.mjs       the built engine (dist/huddle.mjs), one file, no dependencies
//   git-huddle       POSIX launcher: `git huddle` finds it on PATH; Git for Windows runs it with its sh
//   git-huddle.cmd   Windows launcher for direct calls from PowerShell and CMD
//   README.md, LICENSE
//
// The archive is reproducible: fixed owner, fixed modes, every entry dated by
// the last commit, text with LF line ends whatever the checkout did (CRLF only
// in the .cmd file, where cmd.exe wants it), and a fixed gzip header. The same
// source gives the same bytes on Linux and Windows.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const out = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(root, "dist"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const top = `huddle-${version}`;

const bundlePath = join(root, "dist", "huddle.mjs");
let bundle;
try {
  bundle = readFileSync(bundlePath);
} catch {
  console.error("build-release: dist/huddle.mjs is missing. Run `npm run build` first (`npm run release` does both).");
  process.exit(1);
}
const reported = execFileSync(process.execPath, [bundlePath, "--version"], { encoding: "utf8" }).trim();
if (reported !== version) {
  console.error(`build-release: dist/huddle.mjs says it is ${reported}, package.json says ${version}. Rebuild.`);
  process.exit(1);
}

/** The POSIX launcher. `git huddle` runs it; so does a direct call. */
const SH_LAUNCHER = `#!/bin/sh
# git huddle ${version}: runs huddle.mjs, which sits next to this file, with Node.
# Needs Node 22 or later and git on PATH. Put this directory on PATH, then: git huddle -h
if ! command -v node >/dev/null 2>&1; then
  echo "git huddle: Node 22 or later must be on PATH (https://nodejs.org)" >&2
  exit 1
fi
self=$0
# Followed through symbolic links, so a link to this file in a PATH directory works too.
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname -- "$self")/$link ;;
  esac
done
dir=$(dirname -- "$self")
exec node "$dir/huddle.mjs" "$@"
`;

/** The Windows launcher for PowerShell and CMD. `git huddle` does not use it: Git for Windows runs git-huddle. */
const CMD_LAUNCHER = [
  "@echo off",
  `rem git huddle ${version}: runs huddle.mjs, which sits next to this file, with Node.`,
  "rem Needs Node 22 or later and git on PATH. Put this directory on PATH, then: git huddle -h",
  "where node >nul 2>nul || (echo git huddle: Node 22 or later must be on PATH ^(https://nodejs.org^) 1>&2 & exit /b 1)",
  'node "%~dp0huddle.mjs" %*',
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

const lf = (text) => Buffer.from(text.toString("utf8").replace(/\r\n/g, "\n"), "utf8");

const entries = [
  { name: `${top}/`, type: "5", mode: 0o755, data: Buffer.alloc(0) },
  { name: `${top}/LICENSE`, mode: 0o644, data: lf(readFileSync(join(root, "LICENSE"))) },
  { name: `${top}/README.md`, mode: 0o644, data: lf(readFileSync(join(root, "README.md"))) },
  { name: `${top}/git-huddle`, mode: 0o755, data: Buffer.from(SH_LAUNCHER, "utf8") },
  { name: `${top}/git-huddle.cmd`, mode: 0o644, data: Buffer.from(CMD_LAUNCHER, "utf8") },
  { name: `${top}/huddle.mjs`, mode: 0o644, data: bundle }, // as built: esbuild writes LF on every platform
];

let mtime = 0;
try {
  mtime = Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8" }).trim()) || 0;
} catch {
  // Not a git checkout: entries are dated 1970, still reproducible.
}
if (process.env.SOURCE_DATE_EPOCH) mtime = Number(process.env.SOURCE_DATE_EPOCH) || mtime;

function octal(buffer, offset, length, value) {
  buffer.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "latin1");
}

/** One ustar header. Names here are short and ASCII, so no long-name extension is needed. */
function header({ name, type = "0", mode, data }) {
  if (Buffer.byteLength(name) > 100) throw new Error(`name too long for ustar: ${name}`);
  const b = Buffer.alloc(512, 0);
  b.write(name, 0, 100, "utf8");
  octal(b, 100, 8, mode);
  octal(b, 108, 8, 0); // uid
  octal(b, 116, 8, 0); // gid
  octal(b, 124, 12, type === "5" ? 0 : data.length);
  octal(b, 136, 12, mtime);
  b.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  b.write(type, 156, 1, "latin1");
  b.write("ustar\0", 257, 6, "latin1");
  b.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
  return b;
}

const blocks = [];
for (const entry of entries) {
  blocks.push(header(entry));
  if (entry.data.length > 0) {
    blocks.push(entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
}
blocks.push(Buffer.alloc(1024, 0));
const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
gz[9] = 3; // gzip OS field: zlib's build decides it otherwise; fixed so every platform writes the same bytes

mkdirSync(out, { recursive: true });
const file = join(out, `${top}.tar.gz`);
writeFileSync(file, gz);
const sha = createHash("sha256").update(gz).digest("hex");
writeFileSync(`${file}.sha256`, `${sha}  ${top}.tar.gz\n`);
const bundleSha = createHash("sha256").update(bundle).digest("hex");
console.log(`${file}`);
console.log(`sha256 ${sha}  ${gz.length} bytes`);
console.log(`huddle.mjs sha256 ${bundleSha}  ${bundle.length} bytes`);
