#!/usr/bin/env python3
# Hook for Claude Code and Codex. Reads the hook event (JSON on stdin) and appends one
# normalized line to $TANDEM_RUN_DIR/events.jsonl. Never blocks the agent: always exits 0.
import json, os, re, sys, time


def short(v, n=120):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def describe(tool, inp):
    if isinstance(inp, str) or (isinstance(inp, dict) and isinstance(inp.get("input"), str) and "*** Begin Patch" in inp["input"]):
        text = inp if isinstance(inp, str) else inp["input"]
        files = re.findall(r"\*\*\* (?:Update|Add|Delete) File: (\S+)", text)
        if files:
            return f"{tool}: {', '.join(os.path.basename(f) for f in files)}"
    inp = inp if isinstance(inp, dict) else {}
    for key in ("description", "command", "file_path", "path", "pattern", "url", "query", "prompt"):
        if inp.get(key):
            return f"{tool}: {short(inp[key], 100)}"
    return f"{tool}: {short(inp, 100)}" if inp else tool


def main():
    run = os.environ.get("TANDEM_RUN_DIR")
    if not run:
        return
    try:
        d = json.load(sys.stdin)
    except Exception:
        return
    ev = d.get("hook_event_name", "")
    rec = {"t": round(time.time(), 3), "hook": ev}
    if ev == "SessionStart":
        rec.update(kind="session", session=d.get("session_id"))
    elif ev == "UserPromptSubmit":
        rec.update(kind="prompt", text=short(d.get("prompt", ""), 400))
    elif ev == "PreToolUse":
        rec.update(kind="tool", msg=describe(d.get("tool_name", "tool"), d.get("tool_input")))
    elif ev == "PermissionRequest":
        rec.update(kind="blocked", msg="approve " + describe(d.get("tool_name", "tool"), d.get("tool_input")))
    elif ev == "Stop":
        rec.update(kind="final", text=d.get("last_assistant_message") or "")
    elif ev == "StopFailure":
        rec.update(kind="error", msg=short(d.get("error") or d.get("message") or d, 300))
    elif ev == "SessionEnd":
        rec.update(kind="exit")
    else:
        return
    with open(os.path.join(run, "events.jsonl"), "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


try:
    main()
except Exception:
    pass
sys.exit(0)
