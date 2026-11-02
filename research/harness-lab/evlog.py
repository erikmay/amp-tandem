import json, subprocess, sys, time
# Follow hc events and print compact, timestamped status lines.
p = subprocess.Popen(["hc", "events", "--json"], stdout=subprocess.PIPE, text=True)
t0 = time.time()
for line in p.stdout:
    try: d = json.loads(line)
    except Exception: continue
    if d.get("method") != "event": continue
    e = d["params"]; ty = e["type"]; data = e.get("data", {})
    if ty == "created": data = {"name": data.get("name"), "argv0": data.get("argv", [""])[0]}
    print(f"{time.time():.2f} {e.get('terminal')} {ty} {json.dumps(data)}", flush=True)
