import json, sys
# Print the text of the last assistant turn in a Claude Code transcript.
texts = []
for line in open(sys.argv[1]):
    d = json.loads(line)
    t = d.get("type"); m = d.get("message") or {}
    if t == "user" and isinstance(m.get("content"), str):
        texts = []  # a new human prompt starts a new turn
    elif t == "user" and isinstance(m.get("content"), list) and any(c.get("type") == "text" for c in m["content"]):
        texts = []
    elif t == "assistant":
        texts += [c["text"] for c in m.get("content", []) if c.get("type") == "text"]
print("\n".join(texts))
