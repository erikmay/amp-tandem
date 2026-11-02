// Minimal stand-in for Amp's PluginAPI, to run the agents plugin locally.
// Usage: HOME=/tmp/mockhome bun eval/mock/mock-amp.ts <script.json>
// The script is a list of steps: {"tool": "agent_start", "input": {...}} or {"sleep": 5}
// or {"waitFor": {"name": "cx", "states": ["done","idle"], "timeout": 120}}.
import { $ } from 'bun'
import { readFileSync } from 'node:fs'

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a)
const tools = new Map<string, any>()
const handlers = new Map<string, Function[]>()
const quick: Record<string, any> = {}
const messages: string[] = []
const tid = process.env.MOCK_THREAD ?? 'T-mock-000001'

const shell = (strings: TemplateStringsArray, ...values: unknown[]) =>
	$(strings, ...values).nothrow().quiet().then((r) => ({ exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }))

const thread = {
	id: tid,
	createQuickAction(def: any) {
		const id = Object.keys(quick).length
		quick[id] = def
		log('QA+', JSON.stringify(def))
		return { update: (d: any) => { quick[id] = d; log('QA~', d.text, d.icon) }, unsubscribe: () => { delete quick[id]; log('QA-', id) } }
	},
	async appendUserMessage(m: any, o: any) {
		messages.push(m.content)
		log('MSG', JSON.stringify(o), '\n' + m.content.split('\n').map((l: string) => '    | ' + l).join('\n'))
	},
}
const amp: any = {
	$: shell,
	system: { cacheDirectory: '/tmp/mock-cache', workspaceRoot: null, executor: { kind: 'local', keepAlive: async () => ({ unsubscribe() {} }) } },
	helpers: { filePathFromURI: (u: string) => u.replace('file://', '') },
	threads: { get: () => thread },
	logger: { log: (s: string) => log('LOG', s) },
	registerTool: (t: any) => tools.set(t.name, t),
	registerCommand: (id: string) => { log('CMD', id); return { unsubscribe() {}, setAvailability() {} } },
	registerSkill: async (s: any) => { log('SKILL', s.path); return { unsubscribe() {} } },
	on: (e: string, h: Function) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
	onDispose: () => {},
}
const ctx = { thread, ui: { perform: async (a: any) => log('UI', JSON.stringify(a)), notify: async () => {} }, signal: new AbortController().signal }

const plugin = (await import(process.env.PLUGIN ?? '../../.amp/plugins/tandem/index.ts')).default
plugin(amp)

const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const t0 = Date.now()
for (const s of steps) {
	if (s.sleep) await Bun.sleep(s.sleep * 1000)
	if (s.tool) {
		log('CALL', s.tool, JSON.stringify(s.input).slice(0, 200))
		try {
			const out = await tools.get(s.tool).execute(s.input ?? {}, ctx)
			log('RET', '\n' + String(out).split('\n').map((l) => '    > ' + l).join('\n'))
		} catch (e) {
			log('ERR', String(e))
		}
	}
	if (s.waitMessages) {
		const until = Date.now() + (s.timeout ?? 180) * 1000
		while (messages.length < s.waitMessages && Date.now() < until) await Bun.sleep(500)
		log('WAITED', `${messages.length} messages after ${Math.round((Date.now() - t0) / 1000)}s`)
	}
	if (s.agentStart) {
		const r = await handlers.get('agent.start')?.[0]?.({ message: 'x' }, ctx)
		log('AGENT.START', JSON.stringify(r))
	}
}
log('DONE', `${messages.length} messages, ${Object.keys(quick).length} quick actions`)
process.exit(0)
