---
name: delegate
description: Delegate coding work to Claude Code, Codex CLI or pi running inside this orb (agent_start, agent_wait, agent_send, agent_stop, agent_list). Use for multi-step edit/test loops, long refactors, parallel work, second opinions, or pi-autoresearch metric loops.
---

# Delegate to agents in the orb

Child agents run their tool loop inside the orb. One tool call costs them ~0.01 s.
Your own tool calls cost ~0.6 s each, because they go through the Amp server.
So a task with many tool calls finishes much faster in a child.

## When to delegate

Delegate:
- Edit/test/fix loops with many tool calls (refactors, failing tests, migrations, builds).
- Work you can split into independent parts. Run them in parallel, on separate files or branches.
- A second opinion or an independent review (another harness than the one that wrote the code).
- Metric loops with `pi` and `extensions: ["npm:pi-autoresearch"]`.

Do it yourself:
- Short tasks (fewer than ~5 tool calls), questions about the code, or work that needs this thread's context.

## Which harness

| Harness | Default model | Use for |
|---|---|---|
| `claude` | Claude Opus 5.5 (Claude subscription) | Default for code changes. |
| `codex` | GPT-6 Astra (ChatGPT subscription; OpenAI API key as fallback) | Second opinion, review, or when Claude is busy or rate-limited. |
| `pi` | GPT-6 Astra (ChatGPT subscription), any OpenRouter model with `or/<id>` | Extensions such as pi-autoresearch, other models. |

## Brief the child

The child does not see this thread. Give it the goal, the context (repository path, branch, relevant files, facts you found), constraints (files it may touch, no push, no new dependencies), the exact acceptance command, a stop condition (for loops: the maximum number of experiments), and "End with: changed files, commands run with results, open problems."

## While it runs

- The user can watch and type in the Terminal pane.
- For work longer than a minute, end your turn. The plugin posts an `[tandem] <name> ...`
  message with the report when the child ends a turn or needs input. That message wakes you.
- For short work, call `agent_wait` (blocks up to 600 s).
- Several children: give each a unique `name`, and separate files or worktrees.

## When the report arrives

- `done` / `idle`: review the work (below), then send follow-up work with `agent_send`
  or stop it with `agent_stop`.
- `blocked`: it waits for a decision. Read "Now:" and the screen. If a person must decide,
  ask the user. Otherwise answer with `agent_send` and `keys` (for example `["enter"]`).
- `error`: read the message. Retry with `agent_send`, or stop and restart with another model.
- `exited`: the process ended. Start a new agent if work remains.

## Review before you trust it

- Read the diff and run the acceptance check yourself; do not trust "tests pass" in the
  child's summary. Check reported facts (commit hashes, counts, file names).
- Report to the user: one line per child, what it did, and whether you verified it.
