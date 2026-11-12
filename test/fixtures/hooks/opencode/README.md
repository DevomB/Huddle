# opencode hook payloads

opencode has no hook commands. It loads plugins, and huddle's plugin
(`.opencode/plugins/huddle.js`, written by `huddle init`) starts
`node <bundle> hook opencode` with one JSON object on stdin. So the format of
these payloads is **huddle's own**: the plugin writes it and the adapter
(`src/adapters/opencode.ts`) reads it. Nothing here is an opencode wire format.

Each `.json` file is a payload the plugin sends. The test `fixtures: each one
is a payload the plugin sends, to the letter` in `test/opencode.test.ts` loads
the installed plugin, plays opencode's side, and compares what arrives on stdin
with these files, key for key and in the same order.

**None of this was recorded from a live opencode.** opencode's side in the
tests is a stand-in, written after the source of the two majors in use on
2026-11-12:

- opencode 2: tag `v2.2.7` of github.com/anomalyco/opencode, the plugin API in
  `packages/plugin/src/promise/` (`ctx.session.hook("prompt")`,
  `ctx.tool.hook("execute.after")`, `ctx.session.hook("experimental.idle")`,
  `ctx.session.hook("compaction")`, `ctx.session.get`, `ctx.session.synthetic`);
- opencode 1: tag `v1.19.5`, `packages/plugin/src/index.ts` and
  `packages/opencode/src/plugin/index.ts` (`"chat.message"`,
  `"tool.execute.after"`, `"shell.env"`, `event`, `dispose`).

What the stand-ins hand the plugin (the shape of a prompt event, of a tool
call and its result, of a message's parts) is therefore read from source and
not observed. A live run on both majors is still owed; it needs opencode
installed, which a person has to decide. When it is done, check these files
against what the plugin sent there and update this note.

The session id, the project directory `/home/dev/acme` and the file names are
invented.

## Fields

| Field | Meaning |
|---|---|
| `hook_event_name` | `start`, `prompt`, `tool`, `idle` or `end` |
| `session_id` | the session at the top: a subagent's events carry its root session's id |
| `cwd` | the directory opencode runs the session in |
| `subagent` | `true` when the event came from a subagent's session; absent otherwise |
| `prompt` | on `prompt`: what the user typed |
| `tool` | on `tool`: opencode's name of the tool that finished |
| `input` | on `tool`, for the edit tools only: `path`, `filePath` and `patchText` of the call, whichever it has. Never what was written into a file by `edit` or `write` |

## Files

| File | What it stands for |
|---|---|
| `start` | the first prompt of a session, before the prompt itself is sent |
| `prompt` | the user's prompt |
| `tool.edit`, `tool.write` | opencode 2's `edit` and `write`: the file is `path`, as the model wrote it (relative or absolute) |
| `tool.patch` | opencode 2's `patch`: updates and moves one file, adds one (a line of its content looks like a header), deletes one |
| `tool.edit.v1`, `tool.write.v1` | opencode 1's `edit` and `write`: the file is `filePath` |
| `tool.apply-patch.v1` | opencode 1's `apply_patch` |
| `tool.edit.subagent` | an edit made by a subagent |
| `tool.shell.subagent` | a shell command run by a subagent |
| `tool.shell` | a shell command: a tool that is no edit, so no `input` |
| `tool.mcp` | a tool opencode does not ship (an MCP server's) |
| `idle` | the session went idle: the end of a turn |
| `end` | the plugin was unloaded with the session started |

The plugin sends nothing for tools that only read (`read`, `glob`, `grep`,
`lsp`, `question`, `skill`, `todowrite`, `webfetch`, `websearch`, `invalid`),
for a tool call that failed, or for a subagent's prompt and end of turn, so
there is no fixture for those.
