// Clean-source pack and install smoke, Linux and native Windows. Dependency-free.
//
//   node scripts/mvp-delivery-pack.mjs [--keep <dir>]
//
// 1. Copies the files git tracks (no dist/, no node_modules/) into a disposable
//    directory whose name has a space and non-ASCII letters: a clean source checkout.
// 2. npm ci, then npm pack there. `prepack` must build the bundle by itself.
// 3. Checks the tarball holds dist/huddle.mjs, package.json, README.md, LICENSE, nothing else.
// 4. Installs the tarball into a disposable global prefix and into a disposable
//    project, and runs the installed bins: directly on POSIX; on Windows the
//    npm shims huddle.cmd and git-huddle.cmd from PowerShell and from CMD.
// 5. Prints SHA-256 of the tarball and the bundle. --keep copies the tarball,
//    SHA256SUMS and the evidence JSON to <dir>.
//
// Nothing is published. npm's .cmd shim cannot be spawned without a shell on
// Windows, so npm itself is run as `node npm-cli.js`, and the shims are run
// through cmd.exe and PowerShell explicitly, the way a user runs them.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS = process.platform === "win32";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keepIndex = args.indexOf("--keep");
const keep = keepIndex >= 0 ? resolve(args[keepIndex + 1] ?? "") : null;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const evidence = { platform: process.platform, arch: process.arch, node: process.version, sha: process.env.GITHUB_SHA ?? null, checks: [] };

function fail(message) {
  throw new Error(message);
}

function check(name, ok, detail = "") {
  evidence.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) fail(`${name}${detail ? `: ${detail}` : ""}`);
}

/** Runs a real executable with an argv array, no shell. */
function run(file, argv, options = {}) {
  return new Promise((done) => {
    const child = spawn(file, argv, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, windowsVerbatimArguments: options.verbatim ?? false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 300_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

function onPath(names) {
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** npm's own JavaScript entry point, so npm runs as `node npm-cli.js` on every platform. */
function npmCli() {
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) return process.env.npm_execpath;
  const shim = onPath(WINDOWS ? ["npm.cmd"] : ["npm"]);
  if (shim) {
    const real = realpathSync(shim);
    if (real.endsWith(".js")) return real;
    for (const candidate of [join(dirname(shim), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(real), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return fail("cannot find npm-cli.js (npm is needed to pack and install)");
}

const NPM = npmCli();
const npm = (argv, cwd, env) => run(process.execPath, [NPM, ...argv, "--no-audit", "--no-fund", "--loglevel=error"], { cwd, env });

/** cmd.exe's own quoting: /s /c and the whole line in quotes, each word that needs it in double quotes. */
function viaCmd(command, argv, env) {
  const line = [command, ...argv].map((word) => (/[\s&()^|<>"]/.test(word) ? `"${word}"` : word)).join(" ");
  return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { verbatim: true, env });
}

/** PowerShell 7 if present (the documented shell), else Windows PowerShell. */
function viaPowerShell(script, env) {
  const shell = onPath(["pwsh.exe"]) ?? onPath(["powershell.exe"]) ?? "powershell.exe";
  return run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { env });
}

const psQuote = (word) => `'${word.replace(/'/g, "''")}'`;
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function removeAll(dir) {
  // Windows can hold a file a moment after its process exits (an antivirus scan, a closing handle).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 4) console.log(`note: could not remove ${dir}: ${error.code ?? error.message}`);
    }
  }
}

const base = realpathSync(mkdtempSync(join(tmpdir(), "huddle pack ü-")));
const source = join(base, "source ü");
const out = join(base, "out");
const prefix = join(base, "prefix ü");
const consumer = join(base, "consumer project");

try {
  console.log(`huddle pack smoke on ${process.platform} ${process.arch}, node ${process.version}, in ${base}`);

  // 1. A clean source checkout: what git tracks, as this checkout has it (line endings included).
  const listed = await run("git", ["ls-files", "-z"], { cwd: root });
  if (listed.code !== 0) fail(`git ls-files: ${listed.stderr}`);
  const files = listed.stdout.split("\0").filter(Boolean);
  for (const file of files) {
    const from = join(root, file);
    if (!existsSync(from)) continue; // deleted in the working tree and not committed yet
    const to = join(source, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root });
  if (dirty.stdout.trim() !== "") console.log("note: the working tree has uncommitted changes to tracked files; they are in this copy");
  check("clean source has no bundle", !existsSync(join(source, "dist", "huddle.mjs")), `${files.length} tracked files copied`);

  // 2. Install dev dependencies and pack. prepack has to build the bundle with no other step.
  const ci = await npm(["ci"], source);
  check("npm ci in the clean source", ci.code === 0, ci.code === 0 ? "" : ci.stderr.slice(-800));
  mkdirSync(out, { recursive: true });
  const packed = await npm(["pack", "--json", "--pack-destination", out], source);
  check("npm pack from the clean source", packed.code === 0, packed.code === 0 ? "" : packed.stderr.slice(-800));
  const report = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0];
  const contents = report.files.map((f) => f.path).sort();
  const expected = ["LICENSE", "README.md", "dist/huddle.mjs", "package.json"];
  check("tarball contents", JSON.stringify(contents) === JSON.stringify(expected), contents.join(", "));
  const tarball = join(out, report.filename);
  const bundle = join(source, "dist", "huddle.mjs");
  const bundleEntry = report.files.find((f) => f.path === "dist/huddle.mjs");
  check("the bundle in the tarball is the one prepack built", bundleEntry.size === readFileSync(bundle).length, `${bundleEntry.size} bytes`);
  check("package stays private", pkg.private === true);
  evidence.tarball = { file: report.filename, bytes: readFileSync(tarball).length, sha256: sha256(tarball), npmIntegrity: report.integrity };
  evidence.bundle = { bytes: readFileSync(bundle).length, sha256: sha256(bundle) };

  // 3. Install into a disposable global prefix and a disposable project.
  const globalInstall = await npm(["install", "--global", "--prefix", prefix, tarball], base);
  check("npm install --global --prefix <disposable>", globalInstall.code === 0, globalInstall.code === 0 ? "" : globalInstall.stderr.slice(-800));
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "huddle-pack-consumer", version: "0.0.0", private: true }) + "\n");
  const localInstall = await npm(["install", tarball], consumer);
  check("npm install <tarball> in a project", localInstall.code === 0, localInstall.code === 0 ? "" : localInstall.stderr.slice(-800));

  const version = `huddle ${pkg.version}`;
  const versionOk = (r) => r.code === 0 && r.stdout.includes(pkg.version);
  const helpOk = (r) => r.code === 0 && /huddle/.test(r.stdout) && /init/.test(r.stdout);
  const show = (r) => `exit ${r.code}${r.stdout ? `, ${JSON.stringify(r.stdout.trim().split("\n")[0])}` : ""}${r.code !== 0 && r.stderr ? `, stderr ${JSON.stringify(r.stderr.trim().slice(-300))}` : ""}`;

  const installedBundle = WINDOWS ? join(prefix, "node_modules", pkg.name, "dist", "huddle.mjs") : join(prefix, "lib", "node_modules", pkg.name, "dist", "huddle.mjs");
  const direct = await run(process.execPath, [installedBundle, "--version"]);
  check("node <installed bundle> --version", versionOk(direct), show(direct));

  // The bins as a user runs them, with the prefix on PATH.
  const binDir = WINDOWS ? prefix : join(prefix, "bin");
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` };
  if (WINDOWS) delete env.Path;
  if (!WINDOWS) {
    for (const bin of ["huddle", "git-huddle"]) {
      const r = await run(join(binDir, bin), ["--version"], { env });
      check(`${bin} --version (installed bin, no shell)`, versionOk(r), show(r));
    }
    const help = await run(join(binDir, "huddle"), ["--help"], { env });
    check("huddle --help", helpOk(help), show(help));
    const local = await run(join(consumer, "node_modules", ".bin", "huddle"), ["--version"], { env });
    check("project node_modules/.bin/huddle --version", versionOk(local), show(local));
  } else {
    for (const bin of ["huddle", "git-huddle"]) {
      check(`${bin}.cmd shim exists`, existsSync(join(binDir, `${bin}.cmd`)), join(binDir, `${bin}.cmd`));
      const cmd = await viaCmd(join(binDir, `${bin}.cmd`), ["--version"], env);
      check(`CMD: "${bin}.cmd" --version (full path)`, versionOk(cmd), show(cmd));
      const ps = await viaPowerShell(`& ${psQuote(join(binDir, `${bin}.cmd`))} --version; exit $LASTEXITCODE`, env);
      check(`PowerShell: & '${bin}.cmd' --version (full path)`, versionOk(ps), show(ps));
    }
    const cmdByName = await viaCmd("huddle", ["--help"], env);
    check("CMD: huddle --help (by name on PATH)", helpOk(cmdByName), show(cmdByName));
    const psByName = await viaPowerShell("huddle.cmd --version; exit $LASTEXITCODE", env);
    check("PowerShell: huddle.cmd --version (by name on PATH)", versionOk(psByName), show(psByName));
    // Bare `huddle` in PowerShell picks npm's huddle.ps1, which a local execution policy may block. Recorded, not required:
    // the documented route is huddle.cmd, which no policy blocks.
    const psBare = await viaPowerShell("$c = Get-Command huddle; Write-Output \"resolved: $($c.Source)\"; huddle --version; exit $LASTEXITCODE", env);
    evidence.checks.push({ name: "PowerShell: bare huddle --version (informational)", ok: versionOk(psBare), detail: show(psBare) + " " + psBare.stdout.trim().split("\n").join(" | ") });
    console.log(`info PowerShell: bare huddle --version: ${show(psBare)} ${psBare.stdout.trim().split(/\r?\n/).join(" | ")}`);
    const local = await viaCmd(join(consumer, "node_modules", ".bin", "huddle.cmd"), ["--version"], env);
    check("CMD: project node_modules\\.bin\\huddle.cmd --version", versionOk(local), show(local));
  }
  evidence.version = version;
  console.log(`tarball ${report.filename}  sha256 ${evidence.tarball.sha256}  ${evidence.tarball.bytes} bytes`);
  console.log(`bundle dist/huddle.mjs  sha256 ${evidence.bundle.sha256}  ${evidence.bundle.bytes} bytes`);

  if (keep) {
    mkdirSync(keep, { recursive: true });
    copyFileSync(tarball, join(keep, report.filename));
    writeFileSync(join(keep, "SHA256SUMS"), `${evidence.tarball.sha256}  ${report.filename}\n${evidence.bundle.sha256}  dist/huddle.mjs\n`);
    writeFileSync(join(keep, `pack-evidence-${process.platform}.json`), JSON.stringify(evidence, null, 2) + "\n");
    console.log(`kept: ${keep}`);
  }
  console.log(`PASS: ${evidence.checks.filter((c) => c.ok).length} checks`);
} catch (error) {
  console.error(`huddle pack smoke failed: ${error.message}`);
  if (keep) {
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, `pack-evidence-${process.platform}.json`), JSON.stringify({ ...evidence, error: error.message }, null, 2) + "\n");
  }
  process.exitCode = 1;
} finally {
  removeAll(base);
}
