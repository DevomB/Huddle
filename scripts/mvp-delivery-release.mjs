// Release smoke, Linux and native Windows: build the one archive from clean
// source, unpack it where a user would, and run THAT. Dependency-free.
//
//   node scripts/mvp-delivery-release.mjs [--keep <dir>] [--no-demo]
//
// 1. Copies the files git tracks into a disposable directory (no dist/, no
//    node_modules/), runs npm ci and npm run release there. npm is development
//    tooling: the user of the archive never runs it.
// 2. Unpacks the archive with the system tar (Windows: its built-in tar.exe)
//    into a directory whose path has a space and non-ASCII letters.
// 3. Runs the launchers: --version and --help; on Windows git-huddle.cmd from
//    PowerShell and from CMD, by full path and by name on PATH. Then
//    `git huddle --version` through PATH, as the README documents.
// 4. `git huddle init --agent claude-code --agent codex --no-capture-intent` in
//    a fresh repository, and checks what it wrote.
// 5. Runs scripts/demo-mvp.mjs with --release <unpacked dir>: the two-clone demo
//    driven by the unpacked artifact.
// --keep <dir> copies the archive, its .sha256 and the evidence JSON there.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS = process.platform === "win32";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep") ? resolve(args[args.indexOf("--keep") + 1] ?? "") : null;
const demo = !args.includes("--no-demo");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const evidence = { platform: process.platform, arch: process.arch, node: process.version, sha: process.env.GITHUB_SHA ?? null, checks: [] };

class SmokeFailure extends Error {}

function check(name, ok, detail = "") {
  evidence.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new SmokeFailure(name);
}

// One PATH key: a copy of process.env on Windows may spell it "Path" and loses case-insensitive lookup.
const PATH = process.env.PATH ?? "";
function environment(extraPath) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") delete env[name];
  env.PATH = extraPath ? `${extraPath}${delimiter}${PATH}` : PATH;
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "HUDDLE_SESSION", "HUDDLE_NOW"]) delete env[name];
  return env;
}

/** A real executable with an argv array, no shell. */
function run(file, argv, options = {}) {
  return new Promise((done) => {
    const child = spawn(file, argv, { cwd: options.cwd, env: options.env ?? environment(), windowsHide: true, windowsVerbatimArguments: options.verbatim ?? false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 600_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

function onPath(names, path = PATH) {
  for (const dir of path.split(delimiter)) for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/** npm's JavaScript entry point, so npm runs as `node npm-cli.js` (its .cmd shim cannot be spawned without a shell). */
function npmCli() {
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) return process.env.npm_execpath;
  const shim = onPath(WINDOWS ? ["npm.cmd"] : ["npm"]);
  const candidates = [];
  if (shim) {
    const real = realpathSync(shim);
    if (real.endsWith(".js")) return real;
    candidates.push(join(dirname(shim), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(real), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  }
  candidates.push(join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new SmokeFailure("cannot find npm-cli.js (npm is needed to build the archive from source)");
  return found;
}

/** cmd.exe's own quoting: /s /c with the whole line in quotes. */
function viaCmd(line, env) {
  return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { verbatim: true, env });
}
const q = (word) => (/[\s&()^|<>]/.test(word) ? `"${word}"` : word);
function viaPowerShell(script, env) {
  const shell = onPath(["pwsh.exe"]) ?? onPath(["powershell.exe"]) ?? "powershell.exe";
  return run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { env });
}
const psQuote = (word) => `'${word.replace(/'/g, "''")}'`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const show = (r) => `exit ${r.code}${r.stdout.trim() ? `, ${JSON.stringify(r.stdout.trim().split(/\r?\n/)[0])}` : ""}${r.code !== 0 && r.stderr.trim() ? `, stderr ${JSON.stringify(r.stderr.trim().slice(-400))}` : ""}`;

function removeAll(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 4) console.log(`note: could not remove ${dir}: ${error.code ?? error.message}`);
    }
  }
}

const base = realpathSync.native(mkdtempSync(join(tmpdir(), "huddle release ü-")));
const source = join(base, "source ü");
const unpackDir = join(base, "Program Files ü");

try {
  console.log(`huddle release smoke on ${process.platform} ${process.arch}, node ${process.version}, in ${base}`);

  // 1. Clean source, then the archive, the way a maintainer makes it.
  const listed = await run("git", ["ls-files", "-z"], { cwd: root });
  check("git ls-files", listed.code === 0, listed.code === 0 ? "" : listed.stderr);
  let copied = 0;
  for (const file of listed.stdout.split("\0").filter(Boolean)) {
    const from = join(root, file);
    if (!existsSync(from)) continue;
    const to = join(source, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
  }
  const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root });
  if (dirty.stdout.trim() !== "") console.log("note: tracked files have uncommitted changes; the copy has them");
  check("clean source copy has no build output", !existsSync(join(source, "dist")), `${copied} tracked files`);
  const NPM = npmCli();
  const npm = (argv) => run(process.execPath, [NPM, ...argv, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: source });
  const ci = await npm(["ci"]);
  check("npm ci (development tooling, maintainer side)", ci.code === 0, ci.code === 0 ? "" : ci.stderr.slice(-800));
  const release = await npm(["run", "release"]);
  check("npm run release builds the archive", release.code === 0, release.code === 0 ? "" : (release.stdout + release.stderr).slice(-800));
  const archiveName = `huddle-${pkg.version}.tar.gz`;
  const archive = join(source, "dist", archiveName);
  check("the archive and its checksum exist", existsSync(archive) && existsSync(`${archive}.sha256`), archiveName);
  const archiveBytes = readFileSync(archive);
  const archiveSha = sha256(archiveBytes);
  check("the .sha256 file matches the archive", readFileSync(`${archive}.sha256`, "utf8").startsWith(`${archiveSha}  ${archiveName}`), archiveSha);
  evidence.archive = { file: archiveName, bytes: archiveBytes.length, sha256: archiveSha };

  // 2. Unpack with the system tar, where a user would put it.
  mkdirSync(unpackDir, { recursive: true });
  const tar = WINDOWS ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const unpack = await run(tar, ["-xzf", archive, "-C", unpackDir]);
  check(`unpack with ${WINDOWS ? "Windows' built-in tar.exe" : "tar"}`, unpack.code === 0, unpack.code === 0 ? "" : unpack.stderr);
  const dir = join(unpackDir, `huddle-${pkg.version}`);
  const files = readdirSync(dir).sort();
  check("archive contents", JSON.stringify(files) === JSON.stringify(["LICENSE", "README.md", "git-huddle", "git-huddle.cmd", "huddle.mjs"]), files.join(", "));
  const builtBundle = readFileSync(join(source, "dist", "huddle.mjs"));
  const shippedBundle = readFileSync(join(dir, "huddle.mjs"));
  check("huddle.mjs in the archive is the clean build, byte for byte", shippedBundle.equals(builtBundle), `sha256 ${sha256(shippedBundle)}`);
  evidence.bundle = { bytes: shippedBundle.length, sha256: sha256(shippedBundle) };
  const sh = readFileSync(join(dir, "git-huddle"), "utf8");
  check("git-huddle is a #!/bin/sh script with LF line ends", sh.startsWith("#!/bin/sh\n") && !sh.includes("\r"));
  if (!WINDOWS) check("git-huddle is executable", (statSync(join(dir, "git-huddle")).mode & 0o111) !== 0);
  const cmdText = readFileSync(join(dir, "git-huddle.cmd"), "utf8");
  check("git-huddle.cmd has CRLF line ends", cmdText.includes("\r\n") && !/[^\r]\n/.test(cmdText));

  // 3. The launchers, as a user runs them.
  const withDir = environment(dir);
  const versionOk = (r) => r.code === 0 && r.stdout.trim().split(/\r?\n/)[0] === pkg.version;
  const helpOk = (r) => r.code === 0 && /huddle/.test(r.stdout) && /\binit\b/.test(r.stdout);
  if (!WINDOWS) {
    const v = await run(join(dir, "git-huddle"), ["--version"]);
    check("<dir>/git-huddle --version", versionOk(v), show(v));
    const h = await run(join(dir, "git-huddle"), ["--help"]);
    check("<dir>/git-huddle --help", helpOk(h), show(h));
  } else {
    const launcher = join(dir, "git-huddle.cmd");
    const cv = await viaCmd(`${q(launcher)} --version`, withDir);
    check("CMD: <dir>\\git-huddle.cmd --version", versionOk(cv), show(cv));
    const ch = await viaCmd(`git-huddle --help`, withDir);
    check("CMD: git-huddle --help (by name on PATH)", helpOk(ch), show(ch));
    const pv = await viaPowerShell(`& ${psQuote(launcher)} --version; exit $LASTEXITCODE`, withDir);
    check("PowerShell: & '<dir>\\git-huddle.cmd' --version", versionOk(pv), show(pv));
    const ph = await viaPowerShell(`& ${psQuote(launcher)} --help; exit $LASTEXITCODE`, withDir);
    check("PowerShell: & '<dir>\\git-huddle.cmd' --help", helpOk(ph), show(ph));
    const pn = await viaPowerShell("$c = Get-Command git-huddle; Write-Output \"resolved $($c.Source)\"; git-huddle --version; exit $LASTEXITCODE", withDir);
    const lines = pn.stdout.trim().split(/\r?\n/);
    check("PowerShell: git-huddle --version (by name on PATH)", pn.code === 0 && lines.at(-1) === pkg.version, `${lines[0] ?? ""}; ${show(pn)}`);
  }
  const gv = await run("git", ["huddle", "--version"], { env: withDir });
  check("git huddle --version (the launcher directory on PATH)", versionOk(gv), show(gv));
  // git itself turns `git <command> --help` into a manual-page lookup, so through git the help flag is -h.
  const gh = await run("git", ["huddle", "-h"], { env: withDir });
  check("git huddle -h", helpOk(gh), show(gh));
  // The way the README says to get there: the launcher dir on PATH, `git huddle` from PowerShell / sh.
  if (WINDOWS) {
    const pg = await viaPowerShell("git huddle --version; exit $LASTEXITCODE", withDir);
    check("PowerShell: git huddle --version", versionOk(pg), show(pg));
    const cg = await viaCmd("git huddle --version", withDir);
    check("CMD: git huddle --version", versionOk(cg), show(cg));
  }
  const noNode = await run(WINDOWS ? process.env.ComSpec || "cmd.exe" : "/bin/sh", WINDOWS ? ["/d", "/s", "/c", `"${q(join(dir, "git-huddle.cmd"))} --version"`] : [join(dir, "git-huddle"), "--version"], {
    env: { ...environment(), PATH: WINDOWS ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin".split(":").filter((d) => !existsSync(join(d, "node"))).join(":") || "/nonexistent" },
    verbatim: WINDOWS,
  });
  check("without node on PATH the launcher says what is missing and exits 1", noNode.code === 1 && /Node 22 or later must be on PATH/.test(noNode.stderr + noNode.stdout), show(noNode));

  // 4. Setup in a fresh repository, through `git huddle`, for Claude Code and Codex, without prompt capture.
  const repo = join(base, "fresh repo ü");
  mkdirSync(repo, { recursive: true });
  const gitEnv = { ...withDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(base, "gitconfig") };
  writeFileSync(join(base, "gitconfig"), "[user]\n\tname = Smoke\n\temail = smoke@example.invalid\n[init]\n\tdefaultBranch = main\n");
  await run("git", ["init", "--quiet"], { cwd: repo, env: gitEnv });
  const init = await run("git", ["huddle", "init", "--agent", "claude-code", "--agent", "codex", "--no-capture-intent"], { cwd: repo, env: gitEnv });
  check("git huddle init --agent claude-code --agent codex --no-capture-intent", init.code === 0, show(init));
  check(".huddle/huddle.mjs is the archive's huddle.mjs", readFileSync(join(repo, ".huddle", "huddle.mjs")).equals(shippedBundle));
  const config = JSON.parse(readFileSync(join(repo, ".huddle", "config.json"), "utf8"));
  check("prompt capture is off in .huddle/config.json", config.captureIntent === false);
  check("Claude Code and Codex hook files written", existsSync(join(repo, ".claude", "settings.json")) && existsSync(join(repo, ".codex", "hooks.json")));
  const claude = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  const handler = claude.hooks?.PreToolUse?.[0]?.hooks?.[0];
  check("the Claude Code hook is exec form: node + .huddle/huddle.mjs, no shell", handler?.command === "node" && Array.isArray(handler.args) && /\.huddle\/huddle\.mjs$/.test(handler.args[0] ?? ""), JSON.stringify(handler));
  const doctor = await run("git", ["huddle", "doctor", "--offline", "--json"], { cwd: repo, env: gitEnv });
  check("git huddle doctor --offline --json runs", doctor.code === 0 || doctor.code === 1, show(doctor));

  // 5. The two-clone demo, driven by the unpacked artifact.
  if (demo) {
    const demoArgs = [join(root, "scripts", "demo-mvp.mjs"), "--release", dir];
    if (keep) demoArgs.push("--evidence", keep);
    const d = await run(process.execPath, demoArgs, { env: environment() });
    process.stdout.write(d.stdout.split(/\r?\n/).map((line) => (line ? `  demo | ${line}` : line)).join("\n"));
    if (d.stderr.trim()) process.stdout.write(`  demo stderr | ${d.stderr.trim().slice(-2000)}\n`);
    check("two-clone demo from the unpacked artifact", d.code === 0, `exit ${d.code}`);
  }

  console.log(`archive ${archiveName}  sha256 ${archiveSha}  ${archiveBytes.length} bytes`);
  console.log(`huddle.mjs  sha256 ${evidence.bundle.sha256}  ${evidence.bundle.bytes} bytes`);
  if (keep) {
    mkdirSync(keep, { recursive: true });
    copyFileSync(archive, join(keep, archiveName));
    copyFileSync(`${archive}.sha256`, join(keep, `${archiveName}.sha256`));
  }
  console.log(`PASS: ${evidence.checks.length} checks`);
} catch (error) {
  if (!(error instanceof SmokeFailure)) console.log(`FAIL unexpected: ${error.stack ?? error}`);
  evidence.error = String(error.message ?? error);
  process.exitCode = 1;
} finally {
  evidence.passed = process.exitCode !== 1;
  if (keep) {
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, `release-evidence-${process.platform}.json`), JSON.stringify(evidence, null, 2) + "\n");
  }
  removeAll(base);
}
