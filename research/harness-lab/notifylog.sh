#!/bin/sh
# Codex notify: JSON comes as the last argument.
python3 -c 'import json,sys,time; d=json.loads(sys.argv[1]); d["_t"]=round(time.time(),2); d["_src"]="notify"; open("/tmp/harness-lab/cx-hooks.jsonl","a").write(json.dumps(d)+"\n")' "$1"
