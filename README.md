# tandem

Run **Claude Code, Codex CLI and pi inside an Amp orb**, driven by the Amp agent.

tandem is an Amp plugin. The child agents run their own tool loop in the orb, next to the code,
so a tool call costs them ~0.01 s instead of an Amp server roundtrip (~0.6 s). The Amp agent
becomes the parent: it briefs, watches, steers and reviews.

What you see:
- The child's **real TUI** in the Terminal pane. You can type into it.
- **One button per child** above the composer, updated every 2 s:
  `cc working: Bash: bun test`, `cx done: ANSWER 42`, `q blocked: answer: Which color?`.
  A click shows that child in the Terminal pane.
- A **`[tandem]` message** in the thread when a child ends a turn, needs input, or exits.
  It contains the child's final message, its tool calls, changed files and turn times.
  This message wakes the parent, so the parent can end its turn instead of polling.

Which subscription pays:
- **Claude Code** uses the Claude subscription token that Amp puts into the orb
  (`CLAUDE_CODE_OAUTH_TOKEN`, from Amp model routing).
- **Codex and pi** use your **ChatGPT subscription** from the personal Amp secret
  `CODEX_AUTH_JSON` (your full `~/.codex/auth.json`). Without it they fall back to
  `OPENAI_API_KEY`. `agent_start` accepts `billing: "subscription" | "api"`.

Set up the ChatGPT secret once on your machine (after `codex login`):

```bash
bin/sync-codex-auth              # upload ~/.codex/auth.json as personal secret CODEX_AUTH_JSON
bin/sync-codex-auth --install    # keep it current: daily launchd job (macOS)
```

Note: the secret contains your refresh token. OpenAI rotates the refresh token on each refresh.
tandem makes codex in the orb refresh only when the access token really expires (~10 days),
and the daily sync keeps the secret fresher than that. If an orb still refreshes first, your
local codex login can become invalid; then run `codex login` and `bin/sync-codex-auth` again.

## Results (2026-11-02, a1.small orbs, GPT-6 Astra parent)

See [RESULTS.md](RESULTS.md). In short: 40 tool calls took the Amp agent 201 s alone and 111 s
when delegated to Codex. Three 16-call tasks took 239 s alone and 93 s with three parallel
children. Short tasks (≈5 tool calls) are faster without delegation; the skill says so.

## Layout

```
.amp/plugins/tandem/      the plugin (directory plugin; project precedence overrides the personal one)
  index.ts                tools agent_start / agent_wait / agent_send / agent_stop / agent_list,
                          watcher, quick actions, [tandem] notifications, keepAlive
  hook.py                 Claude Code + Codex hook → events.jsonl (tool calls, final message)
  pi-status.ts            pi extension → events.jsonl
  skills/delegate/        skill tandem:delegate: when/which/how to brief/how to review
bin/sync-codex-auth       uploads your Codex ChatGPT login as Amp secret CODEX_AUTH_JSON
eval/                     eval suite: tasks, runner, report, local mock of the plugin API
research/                 harness tests (status, hooks, steering per harness) and an open-source survey
```

## How it works

1. `agent_start` writes a launch script per run and starts it under **[herdr-core](https://github.com/herdrdev/herdr-core)** (`hc run --bg`).
   hc keeps the TUI alive, answers the OSC 7501 status query, and exposes `hc get/wait/send/keys/interrupt`.
2. Claude Code, Codex and pi report their state themselves via OSC 7501 (working, done, idle,
   blocked, error). hc's `turn` counter goes up each time a turn ends.
3. Each harness also writes `events.jsonl` through its own hook system (Claude `--settings` hooks,
   Codex `hooks.json`, pi extension). That gives "what is it doing now" and the final message.
4. A 2 s watcher updates the buttons, holds an orb keepAlive while a child works, and posts the
   `[tandem]` report with `appendUserMessage({steer: true})`.
5. Credentials: each child gets only what it needs. Claude: `CLAUDE_CODE_OAUTH_TOKEN`. Codex and
   pi: an `auth.json` in their own config dir, written from `CODEX_AUTH_JSON` (or an API-key login
   with `OPENAI_API_KEY`). Env vars come from a 0600 file that the launch script deletes after
   reading; all other credential vars are unset for the child.
6. Run state lives in `~/.tandem/runs/<thread>/<name>/` and is rebuilt after a plugin reload.

Pinned versions: hc 0.1.17, Claude Code 2.1.316, Codex 0.166.0, pi 1.5.0. Installed on first use
(prewarmed when the plugin loads in an orb).

## Use it

In an orb thread of this project, the plugin is active. For all your orbs, copy
`.amp/plugins/tandem/` into your personal Amp plugins repo (`https://ampcode.com/git/@<you>/-/plugins`).
In a thread, the agent loads the skill `tandem:delegate` and uses the `agent_*` tools.

The parent's mode must not be a Claude model while Claude usage is "Subscription only": Amp
rejects such orb threads with "not authorized". Use `-m high` (GPT-6 Astra) or allow paid usage.

## Eval

```bash
TANDEM_PROJECT=<you>/<project> python3 eval/run.py --reps 2 E2-native E2-claude E2-codex E2-pi …   # one orb thread per run, in parallel
python3 eval/report.py eval/results/<dir>/runs.jsonl                # markdown table
HOME=/tmp/mockhome bun eval/mock/mock-amp.ts /tmp/script.json       # local test without an orb
```

Tasks (`eval/tasks/`): E1/E7 three children in parallel, E2 16 tool calls, E3 TypeScript bug fix,
E4 blocked on a question, E5 interrupt and steer, E6 40 tool calls; `*-native` = the Amp agent alone.

## Credits

- [herdr-core](https://github.com/herdrdev/herdr-core) runs and watches the child TUIs.
- [Claude Code](https://github.com/anthropics/claude-code), [Codex CLI](https://github.com/openai/codex)
  and [pi](https://github.com/badlogic/pi-mono) are the harnesses.

## License

MIT
