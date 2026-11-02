#!/usr/bin/env python3
"""Run eval tasks as Amp orb threads and measure them.

Usage: eval/run.py [--size a1.small] [--mode high] [--reps 1] [--out eval/results/<date>] TASK...
TASK is a name in eval/tasks (without .txt). Tasks run in parallel, one orb thread each.
A task ends when the thread's last assistant message contains a line "RESULT ...".
Metrics per run (from server timestamps in `amp threads export`):
  wall_s       first user message -> final assistant message
  cold_s       first user message -> first assistant message (orb start + first model call)
  parent_turns assistant messages, parent_tools tool calls of the Amp agent
  wakes        [tandem] messages the plugin posted
  child_turns  child turn times parsed from agent_list / reports
"""
import argparse, concurrent.futures as cf, datetime as dt, json, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get("TANDEM_PROJECT", "erikmay/amp-tandem")  # your Amp project with this repo


def iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def export(tid):
    try:
        return json.loads(subprocess.check_output(["amp", "threads", "export", tid], stderr=subprocess.DEVNULL))
    except Exception:
        return None


def texts(m):
    return [c.get("text", "") for c in m.get("content", []) if c.get("type") == "text"]


def finished(t):
    ms = t["messages"]
    if not ms or ms[-1]["role"] != "assistant":
        return None
    txt = "\n".join(texts(ms[-1]))
    if any(c.get("type") == "tool_use" for c in ms[-1]["content"]):
        return None
    res = re.findall(r"^RESULT .*$", txt, re.M)
    return res or None


def metrics(t, results):
    ms = t["messages"]
    t0 = iso(ms[0]["createdAt"])
    first_asst = next((iso(m["createdAt"]) for m in ms if m["role"] == "assistant"), None)
    end = iso(ms[-1]["createdAt"])
    tools = sum(1 for m in ms if m["role"] == "assistant" for c in m["content"] if c.get("type") == "tool_use")
    wakes = sum(1 for m in ms if m["role"] == "user" for x in texts(m) if x.startswith("[tandem] ") and "children:" not in x[:30])
    child = []
    for m in ms:
        for x in texts(m):
            for g in re.findall(r"Turn times: (.*)", x):
                child.append(g.strip())
    return {
        "wall_s": round(end - t0, 1),
        "cold_s": round(first_asst - t0, 1) if first_asst else None,
        "parent_turns": sum(1 for m in ms if m["role"] == "assistant"),
        "parent_tools": tools,
        "wakes": wakes,
        "child_turn_times": child[-3:],
        "results": results,
        "ok": bool(results) and all(" ok" in r for r in results),
    }


def run(task, size, mode, out, rep, timeout, project=PROJECT):
    prompt = open(os.path.join(ROOT, "tasks", task + ".txt")).read()
    d = os.path.join(out, f"{task}-{rep}")
    os.makedirs(d, exist_ok=True)
    cmd = ["amp", "-ox", prompt, "-m", mode, *(["--project", project] if project != "none" else []), "--orb-size", size, "--no-archive-after-execute", "--stream-json"]
    with open(os.path.join(d, "stream.jsonl"), "w") as so, open(os.path.join(d, "err.txt"), "w") as se:
        p = subprocess.Popen(cmd, stdout=so, stderr=se, stdin=subprocess.DEVNULL, cwd=os.path.dirname(ROOT) if project != "none" else "/tmp")
    tid = None
    deadline = time.time() + timeout
    while not tid and time.time() < deadline:
        time.sleep(2)
        try:
            first = open(os.path.join(d, "stream.jsonl")).readline()
            tid = json.loads(first).get("session_id") if first else None
        except Exception:
            pass
        if p.poll() not in (None, 0) and not tid:
            return {"task": task, "rep": rep, "error": open(os.path.join(d, "err.txt")).read()[-500:]}
    t, res = None, None
    while time.time() < deadline:
        time.sleep(10)
        t = export(tid)
        if t and (res := finished(t)) and p.poll() is not None:
            break
    if t:
        json.dump(t, open(os.path.join(d, "thread.json"), "w"))
    m = metrics(t, res) if t else {}
    m.update(task=task, rep=rep, thread=tid, size=size, mode=mode, timed_out=not res)
    json.dump(m, open(os.path.join(d, "metrics.json"), "w"), indent=1)
    subprocess.run(["amp", "threads", "archive", tid], capture_output=True)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks", nargs="+")
    ap.add_argument("--size", default="a1.small")
    ap.add_argument("--mode", default="high")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=1200)
    ap.add_argument("--project", default=PROJECT, help='Amp project, or "none" for an orb without repository (tests the personal plugin)')
    ap.add_argument("--out", default=os.path.join(ROOT, "results", dt.date.today().isoformat()))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    jobs = [(t, r) for r in range(1, a.reps + 1) for t in a.tasks]
    with cf.ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futs = {}
        for i, (t, r) in enumerate(jobs):
            futs[ex.submit(run, t, a.size, a.mode, a.out, r, a.timeout, a.project)] = (t, r)
            time.sleep(3)  # stagger orb starts
        for f in cf.as_completed(futs):
            m = f.result()
            print(json.dumps(m), flush=True)
            with open(os.path.join(a.out, "runs.jsonl"), "a") as fh:
                fh.write(json.dumps(m) + "\n")


if __name__ == "__main__":
    main()
