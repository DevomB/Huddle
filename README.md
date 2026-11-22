# Huddle

A skill for Claude Code and Codex that lets several people's coding agents work on one repo without tripping over each other.

Each person gets one communicator agent. It watches the repo's GitHub Issues and speaks for that person's other agents, who only work on the tasks it hands them. The issues are the only channel between people. On a one-person project the skill says so and does nothing.

## Install

```bash
git clone https://github.com/DevomB/Huddle && cd Huddle
mkdir -p ~/.claude/skills ~/.agents/skills
ln -s "$PWD/skills/huddle" ~/.claude/skills/huddle   # Claude Code
ln -s "$PWD/skills/huddle" ~/.agents/skills/huddle   # Codex
```

On Windows copy the folder instead of linking it. You can also skip this: once one teammate has set a project up, the skill is inside that repo.

You need git and the [GitHub CLI](https://cli.github.com), logged in with `gh auth login`.

## Use

In the project, tell your agent "set up a huddle". Teammates pull and say "join the huddle" in every session they want in. The first session per person becomes the communicator.

## What to expect

- Agents comment from your GitHub account. Their comments start with `[agent]`.
- One issue is one task. Each task gets a branch and a pull request, and the communicator of the person who did the work merges it once checks pass.
- Every comment notifies the team, so a busy huddle is a busy inbox.

The full protocol is in [skills/huddle/SKILL.md](skills/huddle/SKILL.md).
