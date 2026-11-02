// pi extension: appends normalized events to $TANDEM_RUN_DIR/events.jsonl (same format as hook.py).
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export default function (pi: any) {
	const run = process.env.TANDEM_RUN_DIR
	if (!run) return
	const put = (rec: Record<string, unknown>) => {
		try {
			appendFileSync(join(run, 'events.jsonl'), JSON.stringify({ t: Date.now() / 1000, ...rec }) + '\n')
		} catch {}
	}
	const short = (s: string, n = 100) => {
		s = s.replace(/\s+/g, ' ').trim()
		return s.length <= n ? s : s.slice(0, n - 1) + '…'
	}
	pi.on('session_start', async (_e: any, ctx: any) => put({ kind: 'session', session: ctx?.sessionManager?.getSessionFile?.() }))
	pi.on('tool_execution_start', async (e: any) => {
		const a = e.args ?? {}
		const what = a.command ?? a.path ?? a.file_path ?? a.pattern ?? JSON.stringify(a)
		put({ kind: 'tool', msg: `${e.toolName}: ${short(String(what))}` })
	})
	pi.on('ui_prompt_start', async (e: any) => put({ kind: 'blocked', msg: short(String(e.title ?? e.kind ?? 'dialog'), 200) }))
	pi.on('agent_end', async (e: any) => {
		const last = [...(e.messages ?? [])].reverse().find((m: any) => m.role === 'assistant')
		const text = (last?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
		put({ kind: last?.stopReason === 'error' ? 'error' : 'final', text, msg: last?.errorMessage })
	})
	pi.on('session_shutdown', async () => put({ kind: 'exit' }))
}
