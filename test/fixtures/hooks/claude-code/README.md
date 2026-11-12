# Claude Code hook payloads

Each `.json` file here is the stdin of one real hook invocation, recorded from
Claude Code 2.1.322 on 2026-11-12 in headless runs (`claude -p`) against a
scratch repository. `test/claude-code.test.ts` parses every one of them and
fails if a file is added here without an expectation there.

What was changed after recording, and nothing else:

- The JSON is pretty-printed.
- The scratch repository's path is rewritten to `/home/dev/acme`, and the
  recording user's home directory to `/home/dev`.

Ids (`session_id`, `prompt_id`, `tool_use_id`, `agent_id`) are as recorded.

## What the hook process saw besides stdin

- Arguments: whatever the settings entry put in `args` after the script path
  (`hook claude-code`).
- Working directory: the project directory.
- `CLAUDE_PROJECT_DIR`: the project directory, on every event.
- `CLAUDE_ENV_FILE`: only on `SessionStart`, as
  `~/.claude/session-env/<session_id>/sessionstart-hook-0.sh`. A resumed
  session gets the same path again.
- `HUDDLE_SESSION`, exported through that file by the SessionStart hook, was
  visible to the session's Bash commands and not to later hook processes.

## Files

| File | Recorded when |
|---|---|
| `session-start.startup` | a new session started |
| `session-start.resume` | `claude -p --resume <id>`; same `session_id` as before |
| `user-prompt-submit.typed` | the user's prompt |
| `user-prompt-submit.task-notification` | a background Bash command finished |
| `user-prompt-submit.subagent-handback` | a background subagent reported back |
| `pre-tool-use.write`, `.edit`, `.notebook-edit` | before each file-editing tool |
| `pre-tool-use.bash`, `.read` | before tools that name no file to edit |
| `pre-tool-use.subagent-write` | a subagent's Write: parent's `session_id`, plus `agent_id` |
| `post-tool-use.write`, `.edit`, `.notebook-edit`, `.bash` | after each tool |
| `post-tool-use.bash-changed-files` | after `echo three >> notes.txt` with `bashEditDiffEnabled` on |
| `post-tool-use.subagent-write` | after the subagent's Write |
| `stop` | the turn ended |
| `stop.background-task-running` | the turn ended while a subagent was still running |
| `subagent-stop` | the subagent finished (huddle does not register for this event) |
| `session-end` | the headless run exited (`reason` is `other`) |

## Seen in these recordings and not spelled out in the hook reference

- `NotebookEdit` names its file in `tool_input.notebook_path`, not `file_path`.
- Prompts that nobody typed arrive on `UserPromptSubmit` wrapped in a tag:
  `<task-notification>` and `<agent-message from="...">` here.
- `Stop` fires while background work is still running, and again afterwards.
- `tool_response.bashEditDiff` is absent unless Claude Code recorded the
  command's changes.

## Recording again

Point every event in a scratch repository's `.claude/settings.json` at a script
that writes its stdin to a file, run `claude -p` with prompts that make the
agent write, edit, edit a notebook, run a shell command in the background and
start a subagent, then rewrite the paths as above. Read the current hook
reference first (https://code.claude.com/docs/en/hooks): the format changes.
