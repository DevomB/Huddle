// CI evidence for the MVP's Linux and native Windows runs. Dependency-free.
//
//   node scripts/ci-evidence.mjs platform <out-dir> [shell-version]
//     Prints the platform under test and writes <out-dir>/platform.json:
//     OS build, architecture, shell, Node and git versions, GITHUB_SHA.
//
//   node scripts/ci-evidence.mjs summary <dir>
//     Reads every platform.json and test-results.xml (Node's junit reporter)
//     under <dir>, one directory per job, and prints per platform: the
//     platform record, the totals, every skipped test with its reason, and
//     every failure. Exits 1 if a platform has a failure or no results.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

const [mode, dir, shellVersion] = process.argv.slice(2);

if (mode === "platform" && dir) {
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8" }).trim();
    } catch (error) {
      return `unavailable (${error.code ?? error.message})`;
    }
  };
  const record = {
    sha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    job: process.env.HUDDLE_JOB ?? null,
    runner: { os: process.env.RUNNER_OS ?? null, arch: process.env.RUNNER_ARCH ?? null, image: [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join(" ") || null },
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    node: process.version,
    git: run("git", ["--version"]),
    shell: shellVersion ? `pwsh ${shellVersion}` : null,
    autocrlf: run("git", ["config", "--get", "core.autocrlf"]).replace(/^unavailable .*/, "unset"),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "platform.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record, null, 2));
} else if (mode === "summary" && dir) {
  process.exitCode = summary(dir);
} else {
  console.error("usage: node scripts/ci-evidence.mjs platform <out-dir> [shell-version] | summary <dir>");
  process.exitCode = 2;
}

function unescape(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescape(m[1]) : "";
}

/** Totals from the reporter's trailing comments, and the skipped and failed test cases. */
function parseJunit(xml) {
  const totals = {};
  for (const m of xml.matchAll(/<!-- (\w+) ([\d.]+) -->/g)) totals[m[1]] = Number(m[2]);
  const skipped = [];
  const failed = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = attr(m[1], "name");
    const body = m[3] ?? "";
    const skip = /<skipped\b([^>]*)\/?>/.exec(body);
    if (skip) skipped.push({ name, reason: attr(skip[1], "message"), type: attr(skip[1], "type") });
    const fail = /<failure\b([^>]*)>/.exec(body);
    if (fail) failed.push({ name, message: unescape(attr(fail[1], "message")).split("\n")[0].slice(0, 300) });
  }
  return { totals, skipped, failed };
}

function summary(root) {
  const jobs = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory());
  const byPlatform = new Map();
  for (const job of jobs) {
    let platform;
    try {
      platform = JSON.parse(readFileSync(join(job, "platform.json"), "utf8"));
    } catch {
      console.log(`${job}: no platform.json`);
      continue;
    }
    let xml = null;
    try {
      xml = readFileSync(join(job, "test-results.xml"), "utf8");
    } catch {
      // A job that died before the tests ran.
    }
    const entry = byPlatform.get(platform.platform) ?? { platforms: [], shards: 0, missing: [], totals: {}, skipped: [], failed: [] };
    entry.platforms.push(platform);
    if (xml === null) entry.missing.push(platform.job ?? job);
    else {
      entry.shards += 1;
      const parsed = parseJunit(xml);
      for (const [key, value] of Object.entries(parsed.totals)) entry.totals[key] = (entry.totals[key] ?? 0) + value;
      entry.skipped.push(...parsed.skipped);
      entry.failed.push(...parsed.failed);
    }
    byPlatform.set(platform.platform, entry);
  }
  let bad = byPlatform.size === 0;
  for (const [name, entry] of byPlatform) {
    const p = entry.platforms[0];
    console.log(`\n=== ${name} (${entry.shards} shard result(s))`);
    console.log(`sha ${p.sha}  ${p.osVersion} ${p.osRelease}  ${p.arch}  node ${p.node}  ${p.git}  ${p.shell ?? ""}  image ${p.runner?.image ?? "?"}  core.autocrlf=${p.autocrlf}`);
    const t = entry.totals;
    console.log(`tests ${t.tests ?? 0}  pass ${t.pass ?? 0}  fail ${t.fail ?? 0}  cancelled ${t.cancelled ?? 0}  skipped ${t.skipped ?? 0}  todo ${t.todo ?? 0}`);
    for (const job of entry.missing) console.log(`MISSING results: ${job}`);
    for (const s of entry.skipped) console.log(`SKIP ${s.type === "todo" ? "(todo) " : ""}${s.name} — ${s.reason || "(no reason given)"}`);
    for (const f of entry.failed) console.log(`FAIL ${f.name} — ${f.message}`);
    if (entry.failed.length > 0 || (t.fail ?? 0) > 0 || (t.cancelled ?? 0) > 0 || entry.missing.length > 0 || entry.shards === 0) bad = true;
  }
  return bad ? 1 : 0;
}
