# Gemini CLI hook payloads

These payloads were **not recorded from a live Gemini CLI session**. Each
`.json` file here was written by hand to match Gemini CLI's own definition of
what a hook receives on stdin, at the release that was current on 2026-11-12
(`v0.68.0` of github.com/google-gemini/gemini-cli):

- the input types in `packages/core/src/hooks/types.ts` (`HookInput` and the
  one per event that extends it): every file here has the fields of its type
  and no others;
- `packages/core/src/hooks/hookEventHandler.ts`, which builds the payloads:
  `cwd` is the directory Gemini CLI was started in, `mcp_context` is present
  only for an MCP tool, and `tool_response` is `llmContent`, `returnDisplay`
  and, when the tool failed, `error`;
- the hook reference (https://geminicli.com/docs/hooks/reference) for the
  values of `source` and `reason`, and the tools reference
  (https://geminicli.com/docs/reference/tools) for tool names and the keys of
  `tool_input`: `write_file` takes `file_path` and `content`, `replace` takes
  `file_path`, `instruction`, `old_string`, `new_string` and `allow_multiple`.

Ids, paths, timestamps, prompts and every `tool_response` are invented. The
adapter reads `hook_event_name`, `session_id`, `cwd`, `source`, `reason`,
`prompt`, `tool_name` and `tool_input.file_path`, and nothing else.

A live recording is still owed. It needs a Gemini CLI that is signed in and a
folder it has been told to trust, which a person has to do; when it is done,
replace these files with the recordings and update this note.

## Files

| File | What it stands for |
|---|---|
| `session-start.startup`, `session-start.clear` | a session starting, by `source` |
| `before-agent` | the user's prompt |
| `before-tool.write-file`, `before-tool.replace` | an edit about to be made |
| `before-tool.run-shell-command` | a shell command about to run (huddle's matcher does not select it) |
| `after-tool.write-file`, `after-tool.replace` | an edit that was made |
| `after-tool.replace.failed` | an edit that failed: `tool_response.error` is set |
| `after-tool.run-shell-command` | after a shell command |
| `after-tool.mcp` | after an MCP tool, with `mcp_context` |
| `after-tool.read-file` | after a read (huddle's matcher does not select it) |
| `after-agent` | the turn ended |
| `session-end.exit` | the session ended |
| `notification` | an event huddle registers nothing for |
