#!/usr/bin/env python3
"""Aggregate eval runs into a markdown table. Usage: eval/report.py RUNS.jsonl..."""
import json, statistics as st, sys
from collections import defaultdict

rows = [json.loads(l) for f in sys.argv[1:] for l in open(f) if l.strip()]
g = defaultdict(list)
for r in rows:
    g[r["task"]].append(r)
med = lambda xs: round(st.median(xs), 1) if xs else "-"
print("| Task | Runs | OK | Wall (s, median) | Cold start (s) | Parent turns | Parent tool calls | Wakes | Child turn |")
print("|---|---|---|---|---|---|---|---|---|")
for task in sorted(g):
    rs = g[task]
    ok = [r for r in rs if r.get("ok")]
    child = "; ".join(sorted({(r.get("child_turn_times") or [""])[-1] for r in ok if r.get("child_turn_times")}))[:60]
    f = lambda k: med([r[k] for r in ok if r.get(k) is not None])
    print(f"| {task} | {len(rs)} | {len(ok)} | {f('wall_s')} | {f('cold_s')} | {f('parent_turns')} | {f('parent_tools')} | {f('wakes')} | {child} |")
