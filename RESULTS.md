# Eval results

## tandem with ChatGPT subscription (run `2026-11-02-tandem`): 7/7 ok

Codex and pi read the personal Amp secret `CODEX_AUTH_JSON`. Every codex and pi child reported
"via ChatGPT subscription"; Claude reported "via Claude subscription". No OpenAI API key was used.

| Task | Wall | Child turn |
|---|---|---|
| E1 three in parallel (project plugin) | 106 s | cc 18 s, cx 36 s, pi 35 s |
| E1 three in parallel (personal plugin, orb without repo) | 123 s | cc 26 s, cx 46 s, pi 42 s |
| E2-codex (16 calls) | 90 s | 38 s |
| E2-pi (16 calls) | 92 s | 38 s |
| E5 interrupt + steer (codex) | 79 s | 23 s + 6 s |
| E6-codex (40 calls) | 162 s | 110 s |
| E6-pi (40 calls) | 144 s | 92 s |

Single runs. Wall times are within the spread of the API-key runs below; the subscription changes
who pays, not the speed.

## Final regression (plugin as deployed, run `2026-11-02-final`): 18/18 ok

| Task | Native (Amp alone) | Claude | Codex | pi |
|---|---|---|---|---|
| E2: 16 tool calls | 94 s | 58 s | 58 s | 76 s |
| E3: TS bug fix (~5 calls) | 81 s | 77 s | 66 s | 100 s |
| E6: 40 tool calls | 169 s | 124 s | 105 s | 127 s |
| E7: 3 × 16 calls in parallel | 229 s | 87 s (claude + codex + pi) | | |

Also ok: E1 parallel three (101 s), E4 blocked dialog (42 s), E5 interrupt + steer (63 s),
E8 plugin reload with a running child (97 s). Single runs; the medians of the earlier runs
below show the same picture.

Date: 2026-11-02. Orb a1.small. Parent: Amp agent, mode `high` (GPT-6 Astra via ChatGPT
subscription). Children: Claude Code 2.1.316 (Opus 5.5, effort low, Claude subscription),
Codex 0.166.0 (GPT-6 Astra low, OpenAI API key), pi 1.5.0 (GPT-6 Astra low, OpenAI API key).
The plugin was then called `agents-hc`; it is now `tandem`, and codex/pi use the ChatGPT subscription by default.
Wall time = first user message → final assistant message, server timestamps, including the
orb cold start (~16–27 s). Per-run metrics: `eval/results/2026-11-02-*/runs.jsonl` (raw thread exports are not published).

## Final suite (plugin after review fixes, runs c + d)

| Task | Runs | OK | Wall (s, median) | Cold start (s) | Parent turns | Parent tool calls | Wakes |
|---|---|---|---|---|---|---|---|
| E2-native (16 tool calls) | 2 | 2 | 87.5 | 22.1 | 18.5 | 17.5 | 0 |
| E2-claude | 2 | 2 | 89.6 | 23.2 | 6.5 | 5 | 1 |
| E2-codex | 2 | 2 | 75.7 | 26.8 | 6.5 | 5.5 | 1 |
| E2-pi | 2 | 2 | 78.7 | 23.8 | 6.5 | 5 | 1 |
| E3-native (TS bug fix, ~5 calls) | 2 | 2 | 70.6 | 19.4 | 11 | 10 | 0 |
| E3-claude | 2 | 2 | 71.2 | 19.6 | 8 | 7 | 1 |
| E3-codex | 2 | 2 | 63.6 | 19.6 | 6 | 4 | 1 |
| E3-pi | 2 | 2 | 69.3 | 15.9 | 7.5 | 6.5 | 1 |
| E4-blocked (question dialog) | 5 | 5 | 58.7 | 25.1 | 8 | 7 | 2 |
| E5-steer (interrupt + new task) | 5 | 4 | 88.1 | 25.2 | 10 | 9 | 1 |
| E6-native (40 tool calls) | 2 | 2 | **194.4** | 16.9 | 43.5 | 42.5 | 0 |
| E6-claude | 2 | 2 | 122.7 | 17.9 | 7 | 5 | 1 |
| E6-codex | 2 | 2 | 122.3 | 20.4 | 6 | 4 | 1 |
| E6-pi | 2 | 2 | 133.0 | 19.6 | 7 | 5 | 1 |
| E7-parallel-native (3 × 16 calls) | 2 | 2 | **267.4** | 22.0 | 53 | 52 | 0 |
| E7-parallel-agents (claude + codex + pi) | 2 | 2 | **93.8** | 20.3 | 9 | 8 | 3 |

**42 of 43 runs passed** (plus 10/10 in runs f–h after the last fixes, see below). The failure (E5-steer, run c-2) was a real bug: after an interrupt,
Codex reports `working` until the killed command ends, and the steering message typed during
that time was lost. Fixed in `agent_send` (wait until the agent has stopped); the 3 reruns passed.

## What the numbers say

- **Long tool loops: 1.5–1.6× faster.** 40 tool calls: 194 s alone vs 122 s delegated.
  The Amp agent needs ~4.3 s per tool call (model turn + server roundtrip); a child needs
  ~1.5–2.2 s (model turn only).
- **Parallel work: 2.9× faster.** Three 16-call tasks: 267 s alone vs 94 s with three children.
- **Short tasks: no gain.** At ~5–16 tool calls, delegation costs about as much as it saves.
  Fixed parent overhead is ~35–45 s: load skill, start, end turn, wake, verify, answer.
  The skill tells the agent to do short tasks itself.
- **Fewer parent model turns:** 6–9 instead of 18–53. Less Amp agent usage per task.
- **Wake-up works:** every delegated run ended its turn and was woken by the `[agents]` message (now `[tandem]`).
- **Blocked and steering work:** the parent answered Claude's question dialog with keys (5/5)
  and redirected a working Codex agent with an interrupt (after the fix 3/3).
- Child start: `agent_start` returns in ~1–3 s (harnesses are prewarmed at plugin load).

## Earlier runs (before the review fixes)

- Run a (10 tasks, 1 rep): 10/10 ok. Run b (E6, E7): 6/6 ok. Same picture:
  E6 native 201 s vs Codex 111 s; E7 native 239 s vs agents 93 s.
- E1 (first orb test): three children in parallel, all ok, 34 s from start to all done.

## Plugin reload (E8) and regression after the core change (runs f, g, h)

- **E8 first run failed:** `reload_plugins` restarts every plugin process, and the hc core started
  by the plugin died with it, so the child agent exited. Fix: in orbs the plugin runs the core as a
  supervised Amp service (`amp orb service start agents-hc-core --command 'hc serve'`).
- **E8 rerun: ok.** The child kept working through the reload; the new plugin process picked the
  run up again, posted the report by itself and recreated the button (`r done: FINISHED`).
- **Regression (run h), 8/8 ok:** E1 89 s, E2-codex 69 s, E3-claude 63 s, E3-pi 57 s,
  E4-blocked 53 s, E5-steer 62 s, E6-codex 118 s vs E6-native 193 s.

## Quick-action buttons (in-orb check, run e)

`agent_list` reports the plugin's own button state. In an orb, all three buttons were created
with `run-command` and updated without error, e.g. `cc done: SUM 1240` (icon `check`),
`cx done: SUM 1240`, `pi done: SUM 1240`. The live texts during work were checked with the local
mock (`pi working: bash: echo $((6*7))`, `cx working: apply_patch: answer.txt`).

## UI check in the Amp Mac app (agent-desktop, demo U1)

Screenshots in `eval/results/2026-11-02-ui/`.
- **Buttons:** one per child, live: `cc working: Computing square of 7`,
  `pi working: bash: sleep 2 && echo $((6*…`, `cx working: Bash: sleep 2 && echo …`, then
  `cc done: SUM 22140`. Amp puts its own actions (+5, Ship, Snooze) first, so the row scrolls.
- **Bug found and fixed:** the Terminal pane is a tmux *control-mode* client and drew the output
  of all agent windows into one view (`before-mixed-terminal.png`). Now there is one window,
  `agents`; a button click swaps the shown child with `respawn-pane`. After the fix, clicking cx,
  pi and cc showed each TUI cleanly (`after-*.png`).
- The demo ended with `RESULT ui ok`: all three children did 40 steps, the parent checked each file.

## Not covered by automated evals

- Orb pause/wake with a running child (the lease keeps the orb awake while a child works).
