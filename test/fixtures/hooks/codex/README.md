# Codex hook payloads

These payloads were **not recorded from a live Codex session**. Each `.json`
file here was written by hand to match Codex's own definition of what a hook
receives on stdin, at the release that was current on 2026-11-12
(`codex-cli 0.167.0`, tag `rust-v0.167.0` of github.com/openai/codex):

- the generated wire schemas in `codex-rs/hooks/schema/generated/` (every file
  here was checked against the input schema for its event: all required fields,
  no field the schema does not have, allowed values only);
- Codex's hook tests in `codex-rs/core/tests/suite/hooks.rs`, which pin that
  an `apply_patch` call arrives as `tool_name: "apply_patch"` with the patch
  text in `tool_input.command`, and that its `tool_response` is a string
  starting with `Exit code: 0`;
- the patch grammar in `codex-rs/apply-patch/src/parser.rs`;
- `session-end.json`, which is the example payload printed in the hook
  reference (https://developers.openai.com/codex/hooks).

Ids, paths, the model name and the `tool_response` values are invented. The
adapter reads none of them except `session_id` and `cwd`.

A live recording is still owed. It needs hooks that Codex has been told to
trust (reviewed in `/hooks`), which a person has to do; when it is done,
replace these files with the recordings and update this note.

## Files

| File | What it stands for |
|---|---|
| `session-start.startup`, `session-start.resume` | a session starting, by `source` |
| `user-prompt-submit` | the user's prompt |
| `user-prompt-submit.subagent` | a prompt inside a subagent: parent's `session_id`, plus `agent_id` |
| `pre-tool-use.apply-patch.add` | a patch that adds one file |
| `pre-tool-use.apply-patch.mixed` | a patch that adds, deletes, updates and moves |
| `pre-tool-use.apply-patch.subdirectory` | a patch applied from a subdirectory: `cwd` is where the tool runs |
| `pre-tool-use.apply-patch.subagent` | a subagent's patch |
| `pre-tool-use.bash` | a shell command (huddle's matcher does not select it) |
| `post-tool-use.apply-patch`, `post-tool-use.bash` | after each tool |
| `stop` | the turn ended |
| `subagent-stop` | a subagent finished (huddle does not register for this event) |
| `session-end` | the session ended |
