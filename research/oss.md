# OSS and protocols: start, watch, steer and stop coding-agent CLIs

Research date: 2026-11-02. Star counts and last push come from the GitHub API on that date.
Facts marked **(local)** were checked on this Mac with claude 2.1.316, codex 0.166.0, pi 1.5.0 and hc 0.1.15.

## 1. Main finding

Since October 2026, the major TUIs report their own status through **OSC 7501** (the Program Status Protocol by Mitchell Hashimoto).
Claude Code, Codex, pi, OpenCode, Crush and Amp all emit it.
This makes "interactive TUI in a PTY + structured status" possible without screen scraping.
herdr-core (`hc`) is a PTY host that answers the 7501 query and stores the reports.
The prior plugin already uses that path.

Each harness also has a native headless protocol with richer events (Claude stream-json/Agent SDK, Codex app-server, pi RPC, OpenCode server).
Codex and OpenCode let a TUI attach to the same server that a program drives.
For Claude Code and pi, the session transcript JSONL that the TUI writes anyway is the structured side channel.

## 2. Status protocols and native interfaces

| Mechanism | What it gives | Follow-up input | Stop | Notes / links |
|---|---|---|---|---|
| **OSC 7501** Program Status Protocol | `state` = idle/working/done/blocked/error/clear, `kind` (permission/question/auth), `progress`, `app`, `title`, `msg` (base64), hierarchical `id` | n/a (status only) | n/a | Spec rev 0.4, 2026-10-10: [superlogical.com/rex/docs/build/program-status](https://www.superlogical.com/rex/docs/build/program-status). Announcement: [mitchellh.com](https://mitchellh.com/writing/program-status-osc7501). Programs send `OSC 7501;? ST` and report only if the terminal answers. tmux does not answer, so you need a 7501-aware PTY host (hc, Ghostty, Rex, cmux, tuios). |
| **Claude Code** in the TUI | Emits 7501 natively **(local)**: the binary contains a `probe: OSC 7501 reply` path. | Type into the PTY | Ctrl+C / kill | Status only. No `msg` with the current activity was seen. |
| Claude Code `-p --output-format stream-json --input-format stream-json` | JSONL events: system/init, assistant, user/tool_result, final `result` (cost, turns, session_id). `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages`, `--json-schema` | More user messages on stdin (one long-lived process) | Close stdin / SIGINT | Most robust for structured data. No TUI. |
| Claude Agent SDK ([TS](https://github.com/anthropics/claude-agent-sdk-typescript), [Py](https://github.com/anthropics/claude-agent-sdk-python), MIT) | Same messages as stream-json, typed; `interrupt()`, streaming input, hooks as callbacks | `query()` with an async-iterable input | `interrupt()` / abort | Used by claude-agent-acp, Sculptor, Nimbalyst. |
| **Claude Code `--bg` + `claude agents --json`** (new, 2026) | Supervisor daemon runs sessions. `agents --json` gives `status` busy/waiting/idle, `waitingFor`, `state` working/blocked/done/failed/stopped **(local + [docs](https://code.claude.com/docs/en/agent-view))** | `claude attach <id>` (TUI). No documented non-interactive "send" command | `claude stop <id>` | `claude logs <id>` prints recent terminal output. This is a native "hc for Claude". Not tested in an orb (Linux supervisor). |
| Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`) | JSON on stdin to your command for each event: tool name and input, final message on Stop | No (hooks can block or add context, they cannot send prompts) | No | Used by Sculptor, workmux, agent-deck, herdr integrations. Works in TUI and in `-p` mode. |
| Claude Code channels (`--channels`, research preview since 2.1.80) | n/a | An MCP "channel" server can **push messages into a running interactive session** | n/a | Custom channels need `--dangerously-load-development-channels`. Flags may change. [overview](https://lilting.ch/en/articles/claude-code-channels-mcp-event-push) |
| `claude mcp serve` | Exposes Claude Code's *tools* (Read, Edit, Bash...) over MCP | n/a | n/a | Not an agent-as-tool. [steipete/claude-code-mcp](https://github.com/steipete/claude-code-mcp) (agent-as-tool) is archived. |
| **Codex** TUI | Emits 7501 natively (`codex-rs/tui/src/terminal_program_status.rs`), plus iTerm2 OSC 21337 with activity text | PTY | Ctrl+C | [openai/codex](https://github.com/openai/codex), Apache-2.0, 133k stars |
| **Codex `app-server`** (JSON-RPC 2.0; stdio, unix socket, or ws) | `thread/start`, `turn/start`, **`turn/steer`**, `turn/interrupt`, `thread/resume`/`fork`; notifications `turn/started`/`completed`, `item/started`/`completed`, `item/agentMessage/delta`, `thread/status/changed`; approval requests | `turn/steer` (mid-turn) or `turn/start` | `turn/interrupt` | [docs](https://learn.chatgpt.com/docs/app-server). `codex app-server generate-ts` / `generate-json-schema` give typed bindings. Several clients can subscribe to one thread. |
| Codex shared daemon (`codex app-server daemon start`, `codex --remote unix://…`, `codex agents`) | A TUI can connect to a running app-server **(local help)** | `codex queue --thread <id> --message …` queues a message from the shell **(local)** | | Gives TUI + programmatic control of the same thread. Not yet tested whether the TUI live-follows a turn that another client started. |
| `codex exec --json` | JSONL events; `-o` writes the last message to a file; `--output-schema` | `codex exec resume` (new process per turn) | kill | One-shot only. |
| `codex mcp-server` | Used to expose `codex` / `codex-reply` tools | | | **Absent** from `codex --help` in 0.166 **(local)**. Treat as removed or hidden. |
| Codex hooks (`hooks.json` or `[hooks]`; `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`...) and legacy `notify` | Same idea as Claude hooks; Stop gets the final message | No | No | [docs](https://developers.openai.com/codex/hooks). New hooks may need trust via `/hooks`. |
| **pi** TUI | Emits 7501 natively (`packages/tui/src/program-status.ts`). `msg` = session name or dialog title or error line. `PI_PROGRAM_STATUS=1` forces it on | PTY | Ctrl+C | [earendil-works/pi](https://github.com/earendil-works/pi), MIT. The prior plugin pins pi 1.4.0. Check that this version already has 7501 (the e2e run says status worked). |
| **pi `--mode rpc`** | JSONL commands, responses and events: `prompt`, **`steer`**, `follow_up`, `abort`, `get_state`, `get_messages`, `get_last_assistant_text`, `get_session_stats`; events `agent_start`, `message_update`, `tool_execution_start`, `turn_end`, `agent_end`, **`agent_settled`** (truly final) | `steer` / `follow_up` | `abort` | [rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [rpc-commands.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md). `--mode json` = one-shot JSONL. |
| pi extensions (in the TUI) | `pi.on("tool_execution_start" / "turn_end" / "agent_settled" …)`, `ctx.ui.setStatus` | `pi.sendUserMessage(...)` from the extension | | An extension in the interactive TUI can write events to a file or socket and accept commands. Gives TUI + structured channel in one process. [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) |
| **OpenCode `serve`** + SDK | HTTP + SSE `/event` (`session.status`, `session.idle`, message parts) | `POST /session/{id}/prompt_async` | `POST /session/{id}/abort` | The TUI is itself a client: `opencode attach <url>` shows the same session. Emits 7501 too. [anomalyco/opencode](https://github.com/anomalyco/opencode), MIT |
| Amp CLI `--stream-json` | JSONL (Claude-compatible shape) | `--stream-json-input` | | See the Amp docs on `--stream-json`. The Amp binary also contains 7501 strings. |
| **Session transcripts** (`~/.claude/projects/*/<id>.jsonl`, `~/.codex/sessions/YYYY/…`, `~/.pi/agent/sessions/…`) | Every message and tool call, written by the TUI as it works | n/a | n/a | No protocol needed. Format is internal and can change, but it is stable in practice and many tools parse it. |

## 3. Agent Client Protocol (ACP)

| Project | What | License, activity |
|---|---|---|
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | JSON-RPC over stdio between an editor (client) and an agent. `session/new`, `session/prompt`, `session/cancel`, `session/load`; streams `session/update` (agent_message_chunk, tool_call, tool_call_update, plan, mode/info updates); `session/request_permission`; client-side fs/terminal methods. Moved from zed-industries to its own org. | Apache-2.0, 4.6k stars, active |
| [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) | Claude Agent SDK behind ACP (formerly zed-industries/claude-code-acp) | Apache-2.0, 2.7k stars, active |
| [codex-acp](https://github.com/agentclientprotocol/codex-acp) | Codex behind ACP. The zed-industries repo is archived. | 506 stars, active |
| [svkozak/pi-acp](https://github.com/svkozak/pi-acp) | pi via its SDK behind ACP, with `/steering` modes | MIT, 757 stars, last push 2026-10 |
| [openclaw/acpx](https://github.com/openclaw/acpx) | Headless ACP **client** CLI: `acpx codex "…"`, `acpx claude …`, `acpx pi …`; 30 launch profiles; persistent sessions; text or JSON output. Made for agents that drive agents. | MIT, 3.4k stars, pre-1.0, active |
| [ACP registry](https://github.com/agentclientprotocol/registry) | List of ACP agents | Apache-2.0 |

ACP pros: one schema for all harnesses, with tool calls, plans and permission prompts.
ACP cons: an adapter sits between you and the harness, and the adapter lags behind harness features.
There is no human TUI. Steering mid-turn is not in the core spec (cancel + new prompt; pi-acp adds its own command).

## 4. Orchestrators and UIs

| Project | What it does | Live status from | Follow-up input | Human view | Maturity, license |
|---|---|---|---|---|---|
| [herdr-core `hc`](https://github.com/herdrdev/herdr-core) | Persistent PTYs for agents; `run --bg`, `wait`, `read`, `send`, `keys`, `interrupt`, `events`, `attach`; parent/child agents; remote machines; OpenRPC API (`hc schema`) | **OSC 7501 only** (never scrapes); `turn` counter; `hc events` stream | `hc send` (paste + enter) | `hc attach` | Apache-2.0, 305 stars, very active, protocol "preview" |
| [herdr](https://github.com/herdrdev/herdr) | Terminal multiplexer for agents (Erik's main driver) | Screen heuristics + `herdr integration install claude/codex/pi/opencode` (agent reports via `herdr pane report-agent`) | socket API | its own TUI | Apache-2.0, 47.5k stars |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | TUI that runs Claude/Codex/OpenCode/Amp in tmux + git worktrees | tmux `capture-pane` diff and prompt heuristics | tmux send-keys | tmux | AGPL-3.0, 8.7k stars, last push 2026-08 (slowing) |
| [agent-deck](https://github.com/asheshgoplani/agent-deck) | tmux session manager TUI for Claude/Codex/Gemini/pi/OpenCode; `session send`; containers; Telegram bot | "Smart polling" of panes (plus Claude hook files) | `agent-deck session send --message-file` (queues to busy Claude) | tmux | MIT, 1.2k stars, very active |
| [ntm](https://github.com/Dicklesworthstone/ntm) | Go control plane over tmux panes; `--robot-*` JSON, REST/SSE/WebSocket, OpenAPI; "Agent Mail" | Screen-based readiness/working detection with per-agent rules | Submission-verified `ntm send` | tmux | 465 stars, very active, custom license |
| [workmux](https://github.com/raine/workmux) | git worktrees + tmux windows; sandbox (container/VM); remote over SSH | **Agent hooks** installed by `workmux setup` set window status | tmux | tmux window names show status | MIT, 3k stars, active |
| [dmux](https://github.com/standardagents/dmux) | tmux pane per task, worktrees, resumes Claude/Codex sessions | pane heuristics, notifications | tmux | tmux | MIT, 1.8k stars |
| [Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) | Claude orchestrates Claude in tmux windows with scripts | `capture-pane` | `send-keys` script | tmux | no license, stale since 2025-07 |
| [coder/agentapi](https://github.com/coder/agentapi) | HTTP API over a terminal agent: `POST /message`, `GET /status` (stable/running), SSE `/events` | Screen snapshot diff | Types into the PTY | web chat | MIT, **archived** 2026-09 |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Kanban + worktrees; executors per agent; MCP server | **Native protocols**: Claude/Amp/Cursor/Droid `stream-json`, Codex `app-server` JSON-RPC, OpenCode server, Gemini/Qwen via ACP | per protocol | web UI log | Apache-2.0, 28.6k stars, active |
| [Nimbalyst](https://github.com/nimbalyst/nimbalyst) (was [Crystal](https://github.com/stravu/crystal)) | Desktop workspace for Claude Code, Codex, OpenCode; mobile companion | Claude Agent SDK; Codex app-server transport | SDK / app-server | own chat UI | MIT, 2k stars, active |
| [Sculptor](https://github.com/imbue-ai/sculptor) (Imbue) | Parallel agents in containers. Two modes: SDK chat mode, and **terminal-agent mode** (real Claude TUI in a PTY) | Chat: parse the message stream. Terminal: **Claude hooks** call `sculpt signal busy/idle/waiting` to a local HTTP signal API. "Sculptor never parses a terminal agent's output." | Chat API / PTY | chat or terminal panel | MIT, small but active |
| [Conductor](https://www.conductor.build) | Mac app, parallel Claude Code/Codex in worktrees; Conductor Cloud (microVMs) | Uses Claude/Codex programmatic interfaces (closed source) | | own UI | **closed source** |
| [Emdash](https://github.com/generalaction/emdash) (YC W26) | ADE with many providers | Claude hooks (plugin `agents/impl/claude`) | | | Apache-2.0, 6.2k stars |
| [Paradev](https://github.com/ParadevAI/Paradev) (was Superset), [coder/xum](https://github.com/coder/xum) (was mux), [t3code](https://github.com/pingdotgg/t3code) | Agentic IDEs / desktop apps running many agents | mix of SDKs and PTYs | | | active |
| [cmux](https://github.com/manaflow-ai/cmux), [tuios](https://github.com/Gaurav-Gosain/tuios), Ghostty, Rex | Terminals that **receive OSC 7501** and show agent status per tab | OSC 7501 | | | active |
| [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Use Codex from inside Claude Code (review, delegate) | Codex programmatic interface | | | Apache-2.0, OpenAI |
| [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), [omnara](https://github.com/omnara-ai/omnara) | Web/mobile UIs for Claude/Codex/OpenCode sessions | SDK / stream-json, transcripts | | web | AGPL / Apache |

Amp-specific: no public project runs other harnesses inside an Amp orb as a plugin. The closest existing pieces are Amp's agent-to-agent (Amp threads only) and the prior `agents-hc.ts`.

## 5. Which mechanism is most robust

Ratings: robust = no screen scraping, survives TUI redesigns, has a clear "turn done" signal and the final text.

| Harness | (a) Structured status + final result for the parent | (b) Live human view in a terminal | Both at once |
|---|---|---|---|
| **Claude Code** | `claude -p --input-format stream-json --output-format stream-json` (or the Agent SDK). The `result` event has final text, cost and turns. | Interactive TUI in a PTY (hc / tmux) | **TUI in an hc PTY** (7501 gives working/blocked/done) **+ a `Stop` hook** (or tailing the transcript JSONL) for the final message and tool activity. Sculptor and workmux use this TUI + hooks pattern. Alternative: `claude --bg` + `claude agents --json` + `claude attach`. |
| **Codex** | `codex app-server` (JSON-RPC: `turn/steer`, `turn/interrupt`, `turn/completed`, item events) | Interactive TUI | **app-server daemon + `codex --remote unix://…` TUI** on the same thread: the parent drives over JSON-RPC and the human watches the real TUI. Needs a live test. Fallback: TUI in hc PTY (7501) + `Stop` hook / rollout JSONL, with `codex queue` for follow-ups. |
| **pi** | `pi --mode rpc` (`steer`, `follow_up`, `abort`, `agent_settled`, `get_last_assistant_text`) | Interactive TUI | **TUI in an hc PTY (7501)** + a small **pi extension** that writes `tool_execution_start`/`turn_end`/`agent_settled` events and the last assistant text to a JSONL file. Follow-ups through `hc send`. Or tail the pi session JSONL. |

Headless JSON + a "rendered log" pane (for example `pi --mode rpc | renderer` in tmux) works, but the human sees a log and cannot type into the real TUI.
For an orb where the user wants to watch *and* take over, the real TUI is better.

### Why not ACP as the main path
ACP is good if one schema must cover many agents (acpx makes it a one-liner).
But it adds an adapter layer, has no TUI for the human, and steering is not standard.
Keep it as an option for a "headless batch" mode, not the default.

### Why not screen scraping
claude-squad, ntm, agent-deck and agentapi all scrape panes.
They need per-agent heuristics and break with TUI updates (agentapi is archived).
With 7501 now native in all three target harnesses, scraping is no longer needed.

## 6. Recommendations for the Amp orb plugin

1. **Keep hc + OSC 7501 as the base, and add a structured side channel per harness.**
   Claude: a `Stop` hook (and optionally `PostToolUse`) that appends JSON lines to `$RUN_DIR/events.jsonl`.
   pi: a 30-line extension that does the same.
   Codex: a `Stop` hook.
   This fixes "last report lost after exit" and gives the quick action a real `msg` (the last tool call or text line), which 7501 does not carry for Claude.
2. **Read the final answer from structured data, not from the screen.**
   Use the hook payload or the transcript JSONL (`~/.claude/projects`, `~/.codex/sessions`, `~/.pi/agent/sessions`).
   Use `hc read` only as a fallback.
3. **Prototype Codex via app-server daemon + `codex --remote` TUI.**
   If the TUI live-follows turns that the plugin starts, Codex gets full structured control (`turn/steer`, `turn/interrupt`) and a real TUI with no hooks at all.
   Also watch `claude --bg` / `claude agents --json`: it is a native supervisor that may replace hc for Claude once it works on Linux orbs.
