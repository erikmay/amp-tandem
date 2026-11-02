#!/bin/sh
# Append the hook event JSON (one line) to $STATUS_LOG.
python3 -c 'import json,sys,time; d=json.load(sys.stdin); d["_t"]=round(time.time(),2); open(sys.argv[1],"a").write(json.dumps(d)+"\n")' "${STATUS_LOG:-/tmp/harness-lab/hooks.jsonl}"
