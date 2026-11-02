# Driving Claude Code, Codex and pi from a parent process

Tested on macOS on 2026-11-02 with claude 2.1.316, codex 0.166.0, pi 1.5.0, hc 0.1.15 and tmux.
Models: `claude-haiku-5-5` (Claude subscription), `openai/gpt-6-astra` with low effort (OpenAI API key) for codex and pi.
Lab: `/tmp/harness-lab`. Helper scripts are copied to `research/harness-lab/`.
Times are wall clock from `hc events` (timestamped by `evlog.py`) or from hook logs.

## Short answer

| | Claude Code | Codex | pi |
|---|---|---|---|
| Emits OSC 7501 itself | yes (`app=claude-code`) | **yes** (`app=codex`) | **yes** (`app=pi`) |
| States seen under hc | idle, working, done, blocked (permission, question), error | idle, working, done, blocked (permission), error | idle, working, done, blocked (extension dialog), error |
| `msg` in status | yes: tool description, permission or question text, error text | **never** | session name only (`--name`); error text on error |
| Final turn text | Stop hook `last_assistant_message`, or transcript | Stop hook / `notify` `last-assistant-message`, or rollout `task_complete` | extension `agent_end`, or session file, or RPC `get_last_assistant_text` |
| Resume after crash | `claude --resume <id>` (id fixed up front with `--session-id`) | `codex resume <id>` (or `--remote … resume <id>`) | `pi --session <id>` (id fixed up front with `--session-id`) |
| Recommended | **A + Stop hook** | **TUI on `codex app-server`** (A as fallback) | **A + small status extension** |

All three TUIs work under hc (A). hc gives one uniform API for watch, status, send, interrupt and
crash handling. The gaps are the `msg` text (codex, pi) and the final answer text (all three).
Close both gaps with each harness's own hook system writing one JSONL file per run (B-lite).
Headless modes (C) give the best data but lose the real TUI, so they are not recommended for this
use case, except Codex app-server, which keeps the real TUI as a second client.

## Common pitfalls (all harnesses)

1. **`hc run` does not pass the caller's environment.** The child gets the hc core's environment.
   Pass per-run variables in argv: `hc run … env CODEX_HOME=… OPENAI_API_KEY=… codex …`.
   (My first codex run used `~/.codex` because of this and wrote a trust entry there; reverted.)
2. **The hc core inherits the environment of whoever started it.** Started from inside Claude Code, it
   passed `CLAUDE_CODE_CHILD_SESSION` and others to children. Claude then showed
   "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker". Start the core with a clean
   env (`env -i HOME=… PATH=… hc server start`) or strip variables in argv (`env -u …`).
   In the orb, also strip `ANTHROPIC_API_KEY` (as agents-hc.ts already does).
3. **First-run dialogs report no status.** Claude's folder-trust dialog and Codex's folder-trust,
   hooks-review and login screens leave `status: null`. `hc wait` then times out. Pre-seed trust
   (Claude: `~/.claude.json` `projects[cwd].hasTrustDialogAccepted`; Codex: `[projects."<cwd>"] trust_level`
   in `$CODEX_HOME/config.toml`, both `/tmp/...` and `/private/tmp/...` spellings) and use
   `--dangerously-bypass-hook-trust` for codex hooks. Codex also needs `codex login --with-api-key`
   in `$CODEX_HOME`; `OPENAI_API_KEY` in the env alone shows the login screen in the TUI.
4. **`hc wait` right after launch can return `idle`** (codex and pi report `idle` ~0.1 s before
   `working`). Sleep 1–2 s or wait for `turn >= 1`.
5. **Print modes block on an open stdin.** `codex exec` and `pi -p` read stdin when it is not a TTY
   ("Reading additional input from stdin…") and hang. Use `</dev/null`.
6. **`hc send` refuses while blocked** (exit 9, `{"kind":"blocked","message":"t4 is blocked (permission)"}`).
   Answer the dialog with `hc keys <t> …` (Claude: `enter` = Yes; Codex: `y`; pi confirm: `enter`).
7. Slash commands sent with `hc send` return `"started": false` (no turn starts); this is not an error.

---

## Claude Code 2.1.316

### A. Interactive TUI under hc (works best)

```sh
hc run --bg --no-parent --name cc --cwd "$CWD" \
  claude --model claude-haiku-5-5 --session-id "$UUID" \
         --settings /path/run-settings.json "<task>"
hc wait cc --timeout 180          # ends on done / idle / blocked / error / exit
hc get cc --json                  # .status = {app,state,msg,kind}, .turn, .title
hc send cc "follow-up"            # refuses while blocked
hc keys cc enter                  # answer a permission dialog ("1. Yes")
hc interrupt cc                   # → {"key":"esc","outcome":"stopped"}
```

Raw status events (`hc events --json`, compacted):

```
561.03 created cc
561.37 status {"app":"claude-code","state":"working"}
562.34 title  "Directory entry count via ls -la"
565.18 status {"app":"claude-code","state":"done"}          turn 1   (4.2 s for an ls task)
...    status {"app":"claude-code","msg":"Listing all files including hidden in current directory","state":"working"}
588.86 status {"app":"claude-code","kind":"permission","msg":"approve Write: /private/tmp/harness-lab/proj/hello.txt","state":"blocked"}
...    status {"app":"claude-code","kind":"question","msg":"answer: Do you prefer red or blue? (Red · Blue)","state":"blocked"}
578.61 status {"app":"claude-code","msg":"There's an issue with the selected model (claude-nonexistent-9). …","state":"error"}
582.45 status {"app":"claude-code","state":"idle"}           after hc interrupt (within 20 ms)
kill -9 → finished, reason "exited", status null
```

Latency: launch → `working` 0.3 s; tool start → blocked 1.0 s; interrupt → idle immediately.
The terminal title is a short topic of the session ("Count entries in ls -la"): a good fallback `msg`.

Final text: `~/.claude/projects/<cwd with / → ->/<sessionId>.jsonl`. Take the assistant `text`
blocks after the last human `user` entry (`research/harness-lab/claude-last.py`).
**Race:** right after the `done` status the transcript may not be flushed yet (read returned
empty, a second read 1 s later was fine). The entry `{"type":"system","subtype":"turn_duration"}`
marks the end of a turn. The Stop hook (below) avoids the race.

Session id: pass `--session-id <uuid>`. Otherwise read `~/.claude/sessions/<pid>.json`
(`sessionId`, `status: busy|idle`, `name`). `claude agents --json` lists the same registry.

Resume after crash (tested with `kill -9`): `claude … --resume <sessionId> "<next message>"` in a
new hc terminal; the model remembered earlier turns and the same transcript file continued.
Note: the permission mode is not restored on resume; pass it again.

### B. Plain tmux + hooks via `--settings`

`--settings <file>` adds hooks without touching `~/.claude/settings.json`. `--setting-sources project`
skips user settings (useful on this Mac; the user's `"tui": "fullscreen"` makes `hc read` history empty).
All hook payloads arrive on stdin as JSON (`hooklog.sh` appends them to a file). Observed:

```
621.24 SessionStart      source=startup model=claude-haiku-5-5 session_id=…
621.27 UserPromptSubmit  prompt="Run ls, then create file b.txt …"
622.25 PreToolUse        tool_name=Bash tool_input={"command":"ls","description":"List files in current directory"}
623.65 PermissionRequest tool_name=Write tool_input={file_path:…, content:"b"}
629.67 Notification      notification_type=permission_prompt message="Claude needs your permission"   (+6 s!)
637.47 Stop              last_assistant_message="FINAL: ok"
638.45 SubagentStop      (internal helper agent, after Stop — ignore)
```

Use `PermissionRequest` (immediate), not `Notification` (6 s late), for "blocked".
`Stop.last_assistant_message` is the clean source of the final text.

### C. Headless `claude -p` stream-json (bidirectional)

```sh
claude -p --model claude-haiku-5-5 --input-format stream-json --output-format stream-json \
  --verbose --permission-prompt-tool stdio --permission-mode default < fifo > out.jsonl
# stdin:  {"type":"user","message":{"role":"user","content":"…"}}
# stdin:  {"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}
# stdout: {"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":"Write",…}}
# stdin:  {"type":"control_response","response":{"subtype":"success","request_id":"…",
#          "response":{"behavior":"allow","updatedInput":{…}}}}
# stdout: {"type":"result","subtype":"success"|"error_during_execution","result":"…","session_id":"…"}
```

Multi-turn, permission round trip, and interrupt all worked; `--resume <id>` continues the
session in a new process. It needs a renderer for the human, and the process did not exit
promptly on stdin EOF in one test (had to kill it). Not needed, because A already gives everything.

### D. `claude --bg` background sessions (new, noted only)

`claude --bg …` prints a short id; `claude agents --json` shows `"kind":"background","state":"working|blocked"`;
`claude attach <id>`, `claude logs <id>` (raw ANSI), `claude stop|rm <id>`. Background sessions force
worktree isolation: in a repo without commits, the Write failed ("background-session guard").
Not suitable as the main path.

### Recommendation for Claude Code

**A + Stop hook.** hc for TUI, state, `msg`, send, keys, interrupt. Add one `--settings` file with a
`Stop` hook (final text) and optionally `PreToolUse`/`PermissionRequest` (richer history) writing to
a per-run JSONL file. Fix the session id with `--session-id`. Pre-seed trust and onboarding.

---

## Codex CLI 0.166.0

Per-run home: `CODEX_HOME=/tmp/…/codex-home` with its own `config.toml` and
`printenv OPENAI_API_KEY | codex login --with-api-key`. `approval_policy = "untrusted"` is rejected
("no longer supported"); only `-a on-request|never`. Use `-s read-only -a on-request` to force approvals in tests.

### A. Interactive TUI under hc

```sh
hc run --bg --no-parent --name cx --cwd "$CWD" \
  env CODEX_HOME=… OPENAI_API_KEY=… codex --no-daemon "<task>"
hc keys cx y      # approve a command
```

`--no-daemon` is required (hc manual: otherwise commands run in the shared daemon, outside hc).

Raw status events:

```
013.75 created cx
013.83 status {"app":"codex","state":"idle"}
013.86 status {"app":"codex","state":"working"}
021.73 status {"app":"codex","state":"done"}       turn 1   (8 s for an ls task)
046.28 status {"app":"codex","kind":"permission","state":"blocked"}      (no msg)
613.96 status {"app":"codex","state":"error"}      16 s after a 401 (retries first)
title: "⠼ Count entries with ls -la | proj" — spinner frame every 100 ms (noisy event stream)
```

Pitfalls:
- **No `msg` ever.** The title holds the thread name only. Use hooks for "what is it doing".
- **Interrupt:** `hc interrupt` reports `"outcome":"still_working"`. Codex aborts the turn but keeps the
  running command as a "background terminal" and reports `working` until that command ends
  (33 s later in the test), then `idle`. Status cannot be trusted after an interrupt.
- `hc wait` can return the initial `idle`.

Final text: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`, last line
`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"FINAL: done.",…}}`.
Interrupted turns end with `{"type":"turn_aborted","reason":"interrupted"}`.

Resume after `kill -9`: `codex --no-daemon resume <threadId> "<msg>"` — worked, same rollout file.

### B. Plain tmux + hooks and `notify`

`$CODEX_HOME/hooks.json` with `[features] hooks = true`, Claude-style event names, and
`--dangerously-bypass-hook-trust` (else a "Hooks need review" dialog). `notify = [script]` must be a
top-level key (placed after a table, it broke config parsing: "invalid type: sequence, expected u32").
Observed:

```
238.41 SessionStart      source=startup
238.43 UserPromptSubmit  prompt=…  turn_id=…
240.00 PreToolUse        tool_name=Bash tool_input={"command":"ls"}
240.15 PostToolUse       tool_response="b.txt\nc.txt\n…"
242.13 PermissionRequest tool_name=Bash tool_input={"command":"touch b2.txt","description":"Allow creating b2.txt? …"}
246.04 notify agent-turn-complete thread-id=<OTHER> last-assistant-message='{"title":"Run ls and touch b2.txt"}'
257.01 Stop              last_assistant_message="FINAL: ok"
257.03 notify agent-turn-complete thread-id=<main> last-assistant-message="FINAL: ok"
```

Pitfall: `notify` also fires for Codex's internal title-generation turn (different `thread-id`).
Filter by the main thread id, or use the `Stop` hook.

### C1. `codex app-server` + TUI as a remote client (best Codex option)

The Codex TUI can be a client of an app-server. The parent connects to the same server as a
second client and joins the running thread. Both see everything.

```sh
CODEX_HOME=… OPENAI_API_KEY=… codex app-server --listen ws://127.0.0.1:47011     # or unix://PATH
CODEX_HOME=… OPENAI_API_KEY=… codex --remote ws://127.0.0.1:47011 "<task>"     # in tmux or under hc
bun cxwatch.ts ws://127.0.0.1:47011        # initialize → thread/loaded/list → thread/resume {threadId}
bun cxsend.ts  ws://… <thread> turn "text" # turn/start   (shows up in the TUI)
bun cxsend.ts  ws://… <thread> interrupt <turnId>   # turn/interrupt
```

Events seen by the observer (JSON-RPC notifications):

```
295.84 thread/status/changed {"type":"active","activeFlags":[]}
297.97 item/completed agentMessage "I’ll run `ls`, then `touch r.txt`."
298.32 item/started commandExecution "/bin/zsh -lc ls"
299.41 thread/status/changed {"type":"idle"}              ← title-generation thread: filter by threadId!
300.46 thread/status/changed {"type":"active","activeFlags":["waitingOnApproval"]}
300.46 SERVER-REQUEST item/commandExecution/requestApproval {…"threadId":…,"itemId":…}
313.39 serverRequest/resolved                               (answered in the TUI)
314.91 item/completed agentMessage "FINAL: ok"
314.93 thread/status/changed {"type":"idle"}
314.93 turn/completed {status:"completed"}
332.13 turn/completed {status:"interrupted"} + thread idle  ← right after turn/interrupt (no 30 s lag)
```

Status set: `notLoaded | idle | systemError | active[waitingOnApproval|waitingOnUserInput]`.
"Doing now" comes from `item/started` (command, tool, message). The final text is the last
`agentMessage` of the turn. The approval request reaches every client, so the parent could also answer it.
Crash test: after `kill -9` of the app-server the TUI showed "Reconnecting to server…". A new
server plus `codex --remote … resume <threadId>` continued the thread. The remote TUI also emits OSC 7501 under hc.
Caveats: app-server is marked experimental; it is one more process to supervise; `thread/resume`
without `excludeTurns:true` gives a deprecation notice; with ChatGPT-less API-key auth it logs plugin-sync 401 warnings (harmless).

### C2. `codex exec --json`

```sh
codex exec --json --skip-git-repo-check "<task>" </dev/null
# {"type":"thread.started","thread_id":"…"} {"type":"turn.started"}
# {"type":"item.completed","item":{"type":"agent_message","text":"OK"}} {"type":"turn.completed","usage":{…}}
codex exec --json resume <thread_id> "<next>" </dev/null     # follow-up (worked)
```

One turn per process, no approvals, interrupt only by signal. 6.3 s for "Reply OK". Fine for
one-shot jobs, not for steering. `codex mcp-server` was not tested (app-server supersedes it).

### Recommendation for Codex

**TUI on app-server** if the plugin can hold a websocket: the real TUI for the human, exact
structured status, `msg` from `item/started`, final text, send and interrupt that work at once.
Run the TUI under hc anyway (hc gives the tmux attach and crash handling).
**Simpler fallback:** A (`codex --no-daemon` under hc) + `hooks.json` (`PreToolUse` for `msg`,
`PermissionRequest`, `Stop` for the final text). Accept that status stays `working` after an interrupt
until the killed command's background terminal ends.

---

## pi 1.5.0

Per-run dir: `PI_CODING_AGENT_DIR=/tmp/…/pi-home` with `settings.json`
`{"defaultProjectTrust":"always","quietStartup":true}`. Built-in provider `openai` reads `OPENAI_API_KEY`.

### A. Interactive TUI under hc

```sh
hc run --bg --no-parent --name pi --cwd "$CWD" \
  env PI_CODING_AGENT_DIR=… OPENAI_API_KEY=… \
  pi --model openai/gpt-6-astra --thinking low --session-id "$UUID" --name "$NAME" "<task>"
```

Raw status events:

```
466.40 created pi
466.55 status {"app":"pi","state":"idle"}
467.25 status {"app":"pi","state":"working"}                       (with --name: "msg":"labrun")
470.30 status {"app":"pi","state":"done"}         turn 1   (3.9 s for an ls task)
479.30 status {"app":"pi","state":"idle"}         after hc interrupt → {"outcome":"stopped"}
556.09 status {"app":"pi","kind":"permission","msg":"Deploy now?","state":"blocked"}   (extension ctx.ui.confirm)
570.21 status {"app":"pi","msg":"OpenAI API error (401): {…}","state":"error"}
```

pi documents this (docs/terminal-setup.md "Program status"): `msg` is the session name, never prompt
or output. `PI_PROGRAM_STATUS=1` forces reports without the terminal query (tmux drops them anyway).
pi has no built-in permission prompts, so `blocked` only comes from extension dialogs.

Final text: `$PI_CODING_AGENT_DIR/sessions/--<cwd>--/<time>_<id>.jsonl`, last
`{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text",…}]}}`.
An aborted turn ends with `stopReason:"error"` and empty content.
`--session-id <uuid>` creates the session with that id, so the parent knows the file in advance.

Resume after `kill -9`: `pi … --session <id> "<msg>"` — worked.

### B. Status extension (`research/harness-lab/pi-status.ts`, loaded with `-e`)

```
506.629 idle     session_start  session=/…/sessions/--private-tmp-harness-lab-proj--/…jsonl
506.635 working  agent_start
510.236 working  tool  msg="bash {\"command\":\"ls\",\"timeout\":null}"
511.914 ending   agent_end      stopReason=stop text="FINAL: ok"
511.915 done     agent_settled  aborted=false
```

Use `agent_settled` (final; `aborted` flag) for state and `agent_end` messages for the text;
`ui_prompt_start/end` for blocked; `tool_execution_start` for `msg`.

### C. `pi --mode rpc`

```
{"id":"p1","type":"prompt","message":"…"}  → response {disposition:"started"}, agent_start … tool_execution_start {toolName,args} … agent_end, agent_settled {aborted:false}
{"id":"a1","type":"abort"}                   → agent_settled {aborted:true}
{"id":"g1","type":"get_last_assistant_text"} / {"type":"get_state"} / steer / follow_up
```

Clean and well documented (docs/rpc.md, rpc-commands.md), but there is no TUI client for an RPC
process, so the human would only see a rendered log.

### Recommendation for pi

**A + status extension.** hc for TUI, state, send, interrupt; the extension adds `msg` (tool) and
the final text in one JSONL file. Use `--session-id` and `--name`.

---

## Suggested uniform design for the plugin

1. Start the hc core with a clean env. Launch each agent with `hc run --bg --no-parent --name X --cwd D env <vars> <agent argv>`.
2. Fix the session id up front (claude/pi `--session-id`; codex: take it from the `SessionStart` hook or the app-server).
3. Give each run a status file `$RUN/events.jsonl`, written by the harness's own hooks:
   claude `--settings` (PreToolUse, PermissionRequest, Stop), codex `hooks.json` (same names),
   pi `-e pi-status.ts`. This adds `msg` and the final text and survives a crash of the TUI.
4. State from `hc get --json` / `hc events` (OSC 7501); `msg` = OSC msg (claude) or last PreToolUse/tool event.
5. After `done`, read the final text from the status file (Stop / agent_end), else from the session file.
6. On crash (`state: finished`): relaunch with the resume flag and the saved session id.
7. Codex upgrade path: app-server + `--remote` TUI for exact status and instant interrupt.

## Files

- `research/harness-lab/evlog.py` — timestamped `hc events` follower
- `research/harness-lab/hooklog.sh` — generic hook → JSONL logger (claude, codex)
- `research/harness-lab/notifylog.sh` — codex `notify` logger
- `research/harness-lab/claude-last.py` — last turn text from a Claude transcript
- `research/harness-lab/pi-status.ts`, `pi-ask.ts` — pi status extension, dialog test extension
- `research/harness-lab/cxwatch.ts`, `cxsend.ts` — Codex app-server observer and sender (bun)

Cleanup done: lab hc core stopped, `tmux -L lab` killed, app-server stopped, trust entry for
`/private/tmp/harness-lab/proj` removed from `~/.claude.json` and `~/.codex/config.toml`, API key file deleted.
Lab transcripts remain in `~/.claude/projects/-private-tmp-harness-lab-proj/` and `/tmp/harness-lab/`.
