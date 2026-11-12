# huddle

Coding agents on different laptops coordinating through the git remote they share. `plan.md` is the source of truth. Read it before doing anything.

## Working rules

- One task from `plan.md` §5 per session. Do only that task.
- Work in your own git worktree on branch `t/<id>-<slug>`, for example `t/1.2-transport`. Never work in the main checkout: other sessions are running in parallel.
- Touch only the files your task owns (`plan.md` §4 and §5). If you need a change elsewhere, especially in `src/core/types.ts` or `src/cli.ts`, flag it at the top of your PR.
- Done means the task's exit test passes and `npm run typecheck && npm test` are green. Then push and open a PR titled `T<id>: <summary>`. Do not merge it.
- Zero runtime dependencies. Dev dependencies are typescript, esbuild and @types/node.
- Do not edit `plan.md`. Put proposed plan changes in your PR description.
- The repo is private. Never publish to npm, change its visibility, or post about it without the user's explicit go-ahead.
- For any agent's hook format, read its current docs (links in `plan.md` §2). Do not rely on memory.
- Follow the hard rules for git calls in `plan.md` §3. Each one prevents a real failure.

## Commands

Available once T0.1 lands:

- `npm run build` bundles to `dist/huddle.mjs`
- `npm run typecheck`
- `npm test`
