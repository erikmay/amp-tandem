// pi extension: append one JSON line per status change to $PI_STATUS_FILE.
import { appendFileSync } from "node:fs";
export default function (pi: any) {
  const file = process.env.PI_STATUS_FILE ?? "/tmp/pi-status.jsonl";
  const put = (state: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(file, JSON.stringify({ t: Date.now() / 1000, state, ...extra }) + "\n");
  pi.on("session_start", async (e: any, ctx: any) => put("idle", { event: "session_start", session: ctx.sessionManager?.getSessionFile?.() }));
  pi.on("agent_start", async () => put("working", { event: "agent_start" }));
  pi.on("tool_execution_start", async (e: any) => put("working", { event: "tool", msg: `${e.toolName} ${JSON.stringify(e.args).slice(0, 80)}` }));
  pi.on("ui_prompt_start", async (e: any) => put("blocked", { event: "ui_prompt_start", kind: e.kind, msg: e.title }));
  pi.on("ui_prompt_end", async () => put("working", { event: "ui_prompt_end" }));
  pi.on("agent_settled", async (e: any) => {
    const last = [...(e.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
    put(e.aborted ? "idle" : "done", { event: "agent_settled", aborted: e.aborted, keys: Object.keys(e) });
  });
  pi.on("agent_end", async (e: any) => {
    const last = [...(e.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
    const text = (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    put("ending", { event: "agent_end", stopReason: last?.stopReason, text });
  });
  pi.on("session_shutdown", async () => put("exited", { event: "session_shutdown" }));
}
