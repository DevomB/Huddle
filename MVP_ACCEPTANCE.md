# huddle 0.1.0 MVP: acceptance report

Written by the sprint lead (sprint `huddle-mvp-2026-11-12`, started 2026-11-12T22:00Z, hard stop 2026-11-13T01:30Z).
The repository is private. Nothing was published, no visibility was changed, and `main` was not touched.

**Late.** The workstation that ran all four sessions was suspended from about 23:57Z to 02:10Z, so the hard stop passed with nobody working. At the hard stop the verified commit was `e05631fa7f6b6da3f6ec5696123d0756c0ceddcf` (Linux and native Windows green in one run, section 3). At 02:12Z the owner said to keep building and get it done, and the work on the commits after `e05631f` was finished after the hard stop. Those commits change tests, CI and the README only: `src/` and the built `huddle.mjs` are byte for byte the same in every commit named in this report.

## 1. The candidate

| | |
|---|---|
| Branch | `t/mvp-lead-integration` |
| Verified commit | `9ab81f3a036439b2a32c5a7ae32f4327aa4cb0fe` (the parent of the commit that adds this file; this file is the only change after it) |
| Base | `0e799a4f6f358d46374d3f0d15a43e29b4711cbd` (remote `main` and `integration` at the start of the sprint, unchanged at the end) |
| Artifact | `dist/huddle-0.1.0.tar.gz`, built by `npm run release`; CI uploads it from the smoke job as `smoke-ubuntu-latest` and `smoke-windows-latest` |
| Artifact sha256 | `527c199724c8092d3f5da2db46326ef2c3d84c6da920e6545ac358993b8de6e9` (identical from the Linux and the Windows runner; the uncompressed tar is `2c02bac42454127adace178d34384da804a42a6eea6243385d7357395131e8ef`) |
| Private PR | https://github.com/DevomB/huddle/pull/20 (open, not a draft, not merged; merging is the owner's decision) |

The archive holds one directory, `huddle-0.1.0/`: `huddle.mjs` (the whole engine, one file, no dependencies), `git-huddle` (sh launcher, also what `git huddle` runs on every platform), `git-huddle.cmd` (PowerShell and CMD), `README.md`, `LICENSE`. Prerequisites are Node 22 or later and git. A user never runs npm and compiles nothing.

The `.tar.gz` bytes depend on the zlib inside the Node that builds it. The two CI runners agree with each other. A Node built against zlib-ng (Fedora's, on the sprint's workstation) gives a different `.tar.gz` around the same tar: the tar inside and `huddle.mjs` (sha256 `24fbf98c1a91ee177955757843fcce9ceb725c71f6e292e87fe6a1afd50b4800`) had the same checksums there as on both runners.

## 2. Try it

Build the artifact from a checkout of the verified commit (this is the only step that needs npm):

```sh
npm ci && npm run release        # writes dist/huddle-0.1.0.tar.gz and dist/huddle-0.1.0.tar.gz.sha256
```

Linux:

```sh
mkdir -p ~/.local/share && tar -xzf dist/huddle-0.1.0.tar.gz -C ~/.local/share
export PATH="$HOME/.local/share/huddle-0.1.0:$PATH"
git huddle --version
~/.local/share/huddle-0.1.0/git-huddle --version      # the launcher, called directly
```

Windows, PowerShell 7 (Git for Windows, native node.exe, no WSL):

```powershell
tar -xf dist\huddle-0.1.0.tar.gz -C $env:LOCALAPPDATA
$env:Path = "$env:LOCALAPPDATA\huddle-0.1.0;$env:Path"
git huddle --version
& "$env:LOCALAPPDATA\huddle-0.1.0\git-huddle.cmd" --version
```

Windows, CMD:

```bat
"%LOCALAPPDATA%\huddle-0.1.0\git-huddle.cmd" --version
```

In a repository with a remote the team can push to:

```sh
git huddle init --agent claude-code --agent codex --no-capture-intent
git huddle doctor
```

The two-clone demo, from the source checkout (the same line works in PowerShell 7):

```sh
npm ci && npm run build && npm run demo
node scripts/mvp-delivery-release.mjs     # the long way: builds the archive from clean source, unpacks it into a path with a space, runs the launchers and the demo from the unpacked directory
```

## 3. Results on the verified commit

One commit, one CI run, both platforms: https://github.com/DevomB/huddle/actions/runs/43350892027

That run was started by the push of worker 1's branch `t/mvp-1-publication`, which pointed at this commit. The candidate branch was then moved forward to the same commit, with no new commit in between.

| | Linux (`ubuntu-latest`) | Windows (`windows-latest`) |
|---|---|---|
| Machine | Ubuntu, kernel 7.0.0-1019-azure, x64, Node 22.23.4, git 2.56.1, PowerShell 7.6.10, runner image ubuntu26 20261111.196.1, `core.autocrlf=unset` | Windows Server 2025 Datacenter 10.0.26100, x64, Node 22.23.4, git 2.56.0.windows.4, PowerShell 7.6.9, runner image win25-vs2026 20261103.298.1, `core.autocrlf=true` |
| `npm ci`, build, typecheck | pass | pass |
| `npm test` | 770 tests, 768 pass, 0 fail, 2 skipped | 767 tests, 737 pass, 0 fail, 30 skipped |
| Archive smoke (`scripts/mvp-delivery-release.mjs`) | pass, 24 checks | pass, 28 checks (the launcher from PowerShell and from CMD as well) |
| Demo from the unpacked archive | pass, 15 steps | pass, 15 steps |
| Bundle run by Node 20 (CLI tests) | pass | not run there |

The Linux workstation gate on the same commit: 770 tests, 767 pass, 0 fail, 3 skipped (the two Windows-only tests, and one that needs the platform variable CI sets). The Linux sequence of section 2 and the demo (15 steps) were run there from this commit as well.

### Every candidate run

| Commit | Run | Linux | Windows |
|---|---|---|---|
| `6630fa0` | [43327891042](https://github.com/DevomB/huddle/actions/runs/43327891042) | 766 tests, 0 fail | 763 tests, 705 pass, 0 fail, 58 skipped. First commit green on both |
| `e05631f` | [43329408366](https://github.com/DevomB/huddle/actions/runs/43329408366) | 770 tests, 0 fail | 767 tests, 709 pass, 0 fail, 58 skipped. The commit verified at the hard stop |
| `1414a92` | [43332590082](https://github.com/DevomB/huddle/actions/runs/43332590082) | 770 tests, 0 fail | 767 tests, 732 pass, **2 fail**, 33 skipped. Both failures are tests that depend on the load of the runner, see below |
| `ba63c16` | [43350640152](https://github.com/DevomB/huddle/actions/runs/43350640152) | 770 tests, 0 fail | 767 tests, 736 pass, **1 fail**, 30 skipped. The claim race passed; the store test failed again |
| `9ab81f3` | [43350892027](https://github.com/DevomB/huddle/actions/runs/43350892027) | 770 tests, 0 fail | 767 tests, 737 pass, 0 fail, 30 skipped. **The verified commit** |

Between `e05631f` and `1414a92`, 25 git hook tests that had been skipped on Windows without a reason were made to run there, which is why the skips drop from 58 to 33. In `ba63c16` three more tests, whose fixtures are server-side hook scripts, run on Windows as well (33 to 30).

The failures of `1414a92` and `ba63c16`, all on Windows only, in two tests that had passed in every earlier run:

- `test/tasks.test.ts`, "one claim race with 20 contenders: four clones, five sessions each". There was exactly one winner and the remote agreed. Of the nineteen others, some were refused as busy after 20 seconds in their clone's queue and some were ended by the test harness at 30 seconds while still inside their own limits (section 8, "Commands in one clone take turns"). The test now gives each contender 120 seconds, lets the remote say who won, and runs a contender that got no verdict once more, where it must lose to the winner by name.
- `test/store.test.ts`, "a reader never sees a partial file while a writer rewrites it". The writer's replacement of `local.json` met an open reader on each of its 17 attempts in about two seconds and gave up with `EPERM`. The test reads the file in a loop without a pause, which no hook or command does. It failed in two runs in a row (`1414a92`, `ba63c16`), the first two after the git hook tests began to run in the same Windows job and added to its load. The reader now pauses one millisecond between reads (`9ab81f3`). The test still requires more than twenty reads to overlap the writer, every read to be a whole document, and the writer to finish all 150 rewrites. The product's budget of about two seconds is unchanged (section 8, "Replacing a file on Windows").

Hosted Windows Server runners are native Windows (Git for Windows, PowerShell 7, node.exe). They are not a Windows desktop, and no Claude Code or Codex session ran on them.

### Skips

Every skipped test gives its reason in the run's Evidence summary job.

Linux, 2 skipped:

| Tests | What they need | Why not on this platform |
|---|---|---|
| 2 | Windows-only tests | they need `cmd.exe`, or a case-insensitive file system with drive letters |

Windows, 30 skipped. One of the entries below is a suite skipped as a whole (`test/transport.test.ts`, "fetchAll when the remote moves under it", three tests): Node counts it under suites and not under skipped tests, and its three tests are not registered. That is why Windows has 767 tests where Linux has 770.

| Tests | What they need | Why not on this platform |
|---|---|---|
| 4 | Signals to a process group, and `sh` job control | Windows has neither. A Node test in the same file covers ending a timed-out git with its process tree on Windows |
| 2 | A shell script standing in for git | the fixture is a POSIX script. The deadlines themselves are tested on Windows by the engine tests; a git that hangs under the bundled hook is not tested there |
| 10 | Symbolic links, file modes, inode numbers, a directory read as a file | Windows has no mode bits and no stable inode numbers, and making a link needs a privilege huddle does not ask for |
| 2 | The `sh` command line of the Codex hook | on Windows Codex runs the `commandWindows` line, which has its own test through `cmd.exe` |
| 12 | Fixtures written as `sh` scripts: server-side hooks, a fake ssh, a fake upload-pack | the fixture, not the product, is POSIX-only. Three tests of this kind, with server-side hooks, were converted in the sprint and pass on Windows, where Git for Windows runs the hook with its own sh. These were not converted |
| 1 | A path with a colon in it | not a valid Windows path |

## 4. What the run shows, against the acceptance list

| Acceptance item | Evidence on the verified commit |
|---|---|
| Unpack the one artifact, call its launcher, no npm, no compilation | Archive smoke on both platforms: built from a clean copy of the source, unpacked into a path with a space and a non-ASCII letter, launchers called directly and through `git huddle`; on Windows from PowerShell and CMD |
| `init` for Claude Code and Codex, generated hooks usable | Smoke, and demo steps 2 and 3: `init --agent claude-code --agent codex --no-capture-intent`, commit, push; a second clone pulls and runs the vendored bundle with nothing installed |
| Two clones share state | Demo: Bob's `status --json` shows Alice's name, branch, intent and file |
| An overlap warning | Demo: `check src/auth.ts` exits 3 and names Alice; the replayed Claude Code pre-edit hook prints the warning; with `init --agent git` Bob's commit prints it and goes ahead, after the hook that was already there |
| Explicit degraded status | Demo: a clone that never synced gets `unknown:` and exit 1, never a clear result. `test/mvp-coordination-freshness.test.ts`: stale, unreadable, incomplete, offline, and a listing git could not produce |
| Safe task claims | Demo: two claims at the same moment, one winner, the other exit 3 with the winner's name. `test/tasks.test.ts`: races of four clones, and one of twenty contenders (four clones, five sessions each). `test/mvp-coordination-tasks.test.ts`: a push with no answer, an owner whose state cannot be read |
| Privacy preferences honored | Demo: with capture off a submitted prompt reaches no teammate and no object on the remote. `test/mvp-delivery-privacy.test.ts`: an opt-out stays off when its file is broken |
| Real hook command invocation | Claude Code: the committed exec-form command is spawned without a shell with recorded payloads (native Windows paths on Windows). Codex: the committed `command` runs in the shells of the Linux machine (sh, bash, dash, and zsh and fish where they are installed), and the committed `commandWindows` runs through `cmd.exe /C` on Windows the way Codex's runner starts it. Git: real commits, checkouts and merges, on Linux and under Git for Windows on the Windows runner, where git's own sh runs huddle's lines |
| Boundary and failure checks kept | `test/mvp-publication.test.ts` (201 files, 1,000 files in non-ASCII directories, the audit's 323,645-byte document), `test/transport.test.ts` (no local ref, `FETCH_HEAD`, index or working tree change), hook deadline tests |

## 5. Agents: what was verified, and how

| Agent | Linux | Windows |
|---|---|---|
| Claude Code | The hooks ran in real Claude Code 2.1.322 sessions on Linux before this sprint (the README's recorded run), and the payloads in the tests were recorded from the agent. In this sprint: fixtures and replay only | **Replay only.** The committed command, spawned as Claude Code spawns it (exec form, no shell), with payloads carrying drive-letter and backslash paths. No live session |
| Codex | **Fixtures and replay only.** Payloads written by hand to Codex's schemas at `rust-v0.167.0`; the committed command line run in the Linux shells that are installed (sh, bash, dash; zsh and fish where present). No live session | **Replay only.** The committed `commandWindows` run through `cmd.exe` in the form Codex's `command_runner.rs` uses at that tag. No live session |
| Git hooks (`init --agent git`, by request only) | Real git: commit, checkout, merge, linked worktrees, husky layouts | Real git on the hosted runner (Git for Windows runs the hooks with its own sh): the same tests as on Linux, without the checks of the executable bit, which Windows does not have. In the demo, Bob's commit prints the overlap warning after a hook that was already there, and goes ahead |

Not supported and not claimed: Gemini CLI, Cursor, OpenCode. A Cursor session in a repository with huddle's Claude Code hooks stays invisible to the team (the adapter stands down for Cursor's payloads, and `doctor` says so).

Each teammate still has to trust the hooks in their own agent (Claude Code's workspace trust; Codex's project trust and `/hooks` review). huddle does not and cannot do that for them.

## 6. Audit findings

| Id | Finding | State | Where |
|---|---|---|---|
| A01 | A published document could exceed the size limit | fixed | `docs.ts`: `serializeDoc` refuses before anything is written; actor documents are cut to fit, every session kept. `test/mvp-publication.test.ts` |
| A02, A09 | `check` and the read commands could report a clear picture from stale or partial state | fixed | `check` exits 0 only on a fresh and complete picture, 3 on overlap, 1 with `unknown:` otherwise; JSON carries `freshness`, `complete`, `warnings`. `test/mvp-coordination-freshness.test.ts` |
| A03 | Files past the 200th were silently dropped | fixed | Past 200 the rest is covered by generated globs (`partial`), matched conservatively and labelled so; a bare `check` covers every file; a hook that checked only the first 200 paths of one edit says so |
| A04 | Two decisions replacing the same one: last writer silently won | gated, not redesigned | Both replacements stay listed, each marked as in conflict with the other, whatever the clocks say. A third replacement of the contested decision is refused (exit 3) with the way to settle it: the existing `--supersedes`, on the rival that should go. No new command. `test/mvp-coordination-decisions.test.ts` |
| A05 | A task push with no answer was reported as failed or as done | fixed | The remote is read back; otherwise the result is `unknown`, exit 1, with the way to reconcile |
| A06 | A broken privacy file turned prompt capture back on | fixed | The opt-out fails closed; `doctor` explains. `test/mvp-delivery-privacy.test.ts` |
| A07 | `claim` could store a pattern the wire would change | fixed | Refused with exit 2 before anything changes |
| A08, A10 | Task text printed raw; credentials accepted in task titles | fixed | One display boundary for task text; a title that looks like a credential is refused before publishing |
| A11 | Two agents in one checkout can act as each other's session | deferred, documented | One agent session per worktree. A universal session identity is a redesign |
| A12 | A task could be taken over from an owner who was only unreadable | fixed, with a stated limit | A takeover needs the owner's document, readable and written after the claim, in which the session has expired. Unreadable or missing: refused, exit 1, the task stays the owner's. It is reclamation by observed inactivity, not a lock: an owner who works on with no huddle activity past the TTL can lose the task. `test/mvp-coordination-tasks.test.ts` |
| A13 | An OpenCode fixture test depends on the environment | deferred with the adapter | `t/3.5-opencode` is not in the candidate |

Not every item of the audit is claimed as resolved: A04 is a gate, A11 is deferred, and A12 keeps its limit.

## 7. Earlier branches

| Branch | State | Reason |
|---|---|---|
| 15 of the 19 task branches | in `main` already | tips are ancestors of `0e799a4` |
| `t/3.2-e2e`, `t/3.4-e2e` | in `main` already | patch-equivalent to `c845808`, `dfd0aa7` |
| `t/2.1-hook-engine` (draft PR #12, head `79c416d`) | **included** | six safety patches cherry-picked with `-x` (hook lifetime limit and patience, bounded warnings, stronger credential scrubbing, path escaping, git process cleanup, test isolation), and the seven open review findings on it closed |
| `t/3.5-opencode` (PR #15, head `d708d92`) | **deferred, not merged** | a new adapter outside the MVP; never run against a live OpenCode |
| Gemini CLI and Cursor adapters (in `main`) | **removed from the candidate** | out of the frozen scope; last present in `0346504`, still in history and in `main` |

## 8. Limits

- **Advisory.** huddle warns. It never blocks an edit or a commit, and a hook that fails or runs out of time says nothing.
- **Polling.** Teammates see each other within about 15 to 30 seconds. Nothing pushes.
- **Hook deadlines.** 150 ms before an edit, 300 ms at a prompt, 4 s at session start. On a slow or busy machine, Windows above all, a hook can run out of time before it has done its work; it then says nothing and writes a line to `.git/huddle/log`. `HUDDLE_HOOK_PATIENCE` (1 to 20) lengthens every deadline. On the hosted Windows runner a test that starts eleven hooks at once saw none of them find its repository before the 150 ms had passed. One hook at a time, as in the demo, did its work inside the default deadline in every run of the candidate.
- **A commit waits at most one second for a sync**, so the first commit after a long pause may be checked against the older team state.
- **Hooks say nothing about freshness.** `check` and `status` say when the team state is stale or unknown. A hook's warning does not; silence from a hook is not a clear result.
- **Commands in one clone take turns.** A task command (`task add`, `task claim`, `task done`, `task drop`) and `decide` sync with the remote first, and the syncs of one clone run one at a time. A command that has waited 20 seconds for its turn stops with exit 1 and says that nothing was changed; run it again. Seen twice on the Windows runner (runs 43330873462 and 43332590082). In the first, of twenty claims started at once, five in each of four clones, six were refused this way and six had no answer after 30 seconds. There was still exactly one winner. The lock waits of one claim alone can add up to 45 seconds. Sharing one sync between queued commands is deferred.
- **Replacing a file on Windows.** Windows does not let a file be replaced while another process has it open. huddle tries again for about two seconds and then gives up on that write: a hook then says nothing, and a command reports the error. Readers open a state file once and close it, so this takes something that holds the file for seconds.
- **Session identity.** One agent session per worktree (A11).
- **Tasks are not locks** (A12).
- **Decisions.** Competing replacements are shown as a conflict for people to settle (A04).
- **Git hooks** are an option (`init --agent git`), per clone, and need node on the `PATH` of whatever runs git.
- **Trusted collaborators only.** Everyone with push access to the remote can read and write the team state. There are no accounts and no access control beyond the remote's.
- **Windows evidence is from GitHub's hosted Windows Server 2025 runner.** No Windows desktop was used, and none is attached to the workstation the sprint ran on.
- **Not verified:** a live Claude Code or Codex session on Windows; a live Codex session anywhere; a Windows desktop; macOS; WSL (not part of the support statement); remotes other than local ones and one private GitHub repository over SSH; Node versions other than 20 (bundle only) and 22.

## 9. Remote state at the end of the sprint

| | |
|---|---|
| Remote `main` | `0e799a4f6f358d46374d3f0d15a43e29b4711cbd` (not updated: landing on `main` needs the owner's explicit word) |
| Candidate branch | `t/mvp-lead-integration`: the verified commit, and on top of it the commit that adds this file |
| Worker branches | `t/mvp-1-publication`, `t/mvp-2-coordination`, `t/mvp-3-delivery`: every commit of theirs that matters is in the candidate |
| Left over, safe to delete | `t/mvp-lead-probe` (a CI probe, never merged); PR #19 (worker 3's CI vehicle) |
| npm | nothing published; `package.json` stays `private: true` |

## 10. Left for the owner

1. Merging PR #20 into `main`. No agent session may do it.
2. A live Claude Code session on Windows, and a live Codex session on any system, each with the hooks trusted by hand. Until then both are replays.
3. What to do with the older pull requests: #12 (its six patches are in this candidate), #15 (OpenCode, deferred), #19 (worker 3's CI vehicle, superseded by #20).
4. Deferred work, none of it started: one agent session identity that holds across agents in one worktree (A11); letting queued commands of one clone share a sync; a note about freshness inside hook output; Windows versions of the test fixtures that are `sh` scripts.
