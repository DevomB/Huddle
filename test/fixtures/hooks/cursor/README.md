# Cursor hook payloads

These payloads were **not recorded from a live Cursor session**. Each `.json`
file here was written by hand to match what Cursor's hook reference says a
hook receives on stdin, as the page read on 2026-11-12
(https://cursor.com/docs/hooks): the fields under "Input (all hooks)", plus
the fields listed for the event. Cursor was not installed on the machine this
was written on, so nothing here has been compared with the real thing.

Ids, paths, tool outputs and error messages are invented, except where a
file says it is the reference's own example. The model name and the version
are the reference's example values. The adapter reads `conversation_id` (or
`session_id`), `cwd`, `prompt`, `reason`, `file_path`, `tool_name` and
`tool_input`, and nothing else. Of `tool_input` it reads `file_path` and
`path`; of anything else in there it reads the names of the fields, for the
one line it writes to stderr when a `Write` or `Delete` names no file, and
never a value.

One thing in these files is a guess and is marked as such in
`src/adapters/cursor.ts`: what `tool_input` holds for the `Write` and `Delete`
tools. The reference shows `tool_input` for `Shell` only. `file_path` is the
name every documented Cursor payload uses for a file (`afterFileEdit`,
`beforeReadFile`); `path` is the second name the adapter tries.

A live recording is owed. When Cursor is at hand: register a hook that
appends its stdin to a file for `sessionStart`, `beforeSubmitPrompt`,
`postToolUse`, `postToolUseFailure`, `afterFileEdit`, `stop` and `sessionEnd`,
make one edit, run one shell command and one that fails, then replace these
files with what was recorded and update this note. The things to look at
first: the `tool_input` of a `Write`; whether `additional_context` returned
from `postToolUse` reaches the agent; and what the tool types are called, since
the matcher `Write|Delete|Shell` is written from the reference alone.

## Files

| File | What it stands for |
|---|---|
| `session-start.json` | A new conversation. |
| `before-submit-prompt.json` | A prompt the user sent, with one attached file. |
| `post-tool-use.shell.json` | A shell command that ran in a subdirectory. The reference's own example, completed with the common fields. |
| `post-tool-use.write.json` | A file written, the file named in `tool_input.file_path` (a guess, see above). |
| `post-tool-use.write.path.json` | The same with the file in `tool_input.path`, relative. |
| `post-tool-use.write.unnamed.json` | A `Write` whose input names the file in a field the adapter does not know. |
| `post-tool-use.delete.json` | A file deleted. |
| `post-tool-use.mcp.json` | An MCP tool, as it would arrive if someone widened the matcher. |
| `post-tool-use-failure.shell.json` | A shell command that timed out. The reference's own example, completed with the common fields. |
| `post-tool-use-failure.write.json` | A `Write` that was denied. It names a file, and no edit happened. |
| `after-file-edit.json` | `afterFileEdit` for one edit; `file_path` is documented as absolute. |
| `stop.json` | The end of a turn. |
| `session-end.json` | The conversation closed by the user. |
| `pre-tool-use.write.json` | An event huddle does not register: before a tool call. |
| `before-shell-execution.json` | An event huddle does not register. |
| `subagent-stop.json` | An event huddle does not register. |
| `workspace-open.json` | An app event, outside any conversation: no `conversation_id`. |
