// @ts-nocheck — the @ampcode/plugin types are only available inside Amp.
//
// tandem: run Claude Code, Codex CLI and pi inside the orb, next to the tools.
// Each child runs its real TUI under herdr-core (hc). The user watches it in the Terminal pane;
// a quick action per child shows what it is doing right now. The child's own hooks write
// events.jsonl (tool calls, final answer), so the parent gets a clean report without screen
// scraping. When a child ends a turn, the plugin posts its report into the thread, so the
// parent agent does not need to poll.
import type { PluginAPI } from '@ampcode/plugin'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
const HOME = homedir()
const STATE = join(HOME, '.tandem') // survives plugin reloads and cache clears
const BIN = join(HOME, '.local', 'bin')
const HC = join(BIN, 'herdr-core') // the installer adds an 'hc' link only when no hc is on PATH
const HC_VERSION = '0.1.17'
const SOCKET = 'amp-terminal' // the Terminal pane's tmux server
const sessionFor = (tid: string) => `amp-terminal-${tid}`
const TICK_MS = 2000
const MAX_BUTTONS = 4 // Amp shows 5 quick actions per thread; leave one for others

type Harness = 'claude' | 'codex' | 'pi'
const HARNESSES: Record<Harness, { pkg: string; bin: string; model: () => string; effort: string }> = {
	claude: { pkg: '@anthropic-ai/claude-code@2.1.316', bin: 'claude', model: () => 'claude-opus-5-5', effort: 'medium' },
	codex: { pkg: '@openai/codex@0.166.0', bin: 'codex', model: () => 'gpt-6-astra', effort: 'medium' },
	pi: { pkg: '@earendil-works/pi-coding-agent@1.5.0', bin: 'pi', model: () => 'openai-codex/gpt-6-astra', effort: 'medium' },
}

type Run = {
	name: string
	harness: Harness
	threadID: string
	cwd: string
	dir: string
	model: string
	effort: string
	billing?: string
	session?: string
	hc: string
	started: number
	notify: boolean
	lastTurn: number
	lastState: string
	turnStarted: number
	turns: { turn: number; state: string; seconds: number; at: number }[]
	ended?: number
	stuck?: boolean
	skipUntil?: number
	waitFrom?: number
	pending?: { reason: string; turn: number; since: number }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const short = (s: string, n: number) => {
	s = String(s ?? '').replace(/\s+/g, ' ').trim()
	return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
const json = (s: string) => {
	try {
		return JSON.parse(s)
	} catch {
		return null
	}
}
const readJSONL = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').map(json).filter(Boolean) : [])
const ago = (ms: number) => {
	const s = Math.round(ms / 1000)
	return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export default function (amp: PluginAPI) {
	const runs = new Map<string, Run>() // key: threadID/name
	const buttons = new Map<string, any>() // key: threadID/name
	const commands = new Map<string, any>() // key: name
	const leases = new Map<string, any>() // key: threadID
	const waiting = new Set<string>() // runs with an agent_wait in progress
	const threads = new Map<string, any>() // thread handles seen in tool calls
	const thread = (tid: string) => threads.get(tid) ?? amp.threads.get(tid)
	const key = (tid: string, name: string) => `${tid}/${name}`
	let ticking = false

	const sh = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const r = await amp.$(strings, ...values)
		if (r.exitCode !== 0) throw new Error(`${strings.join('…').trim()}: ${r.stderr || r.stdout}`.slice(0, 800))
		return r.stdout.trim()
	}
	const env = async (name: string) => process.env[name] || (await amp.$`printenv ${name}`).stdout.trim()
	const workspace = () => {
		const uri = amp.system.workspaceRoot
		return uri ? amp.helpers.filePathFromURI(uri) : process.cwd()
	}

	// ---------- install (pinned), prewarmed at load in orbs ----------
	const pathEnv = async () => {
		const bunBin = (await amp.$`bun pm bin -g`).stdout.trim()
		const base = (process.env.PATH || (await amp.$`printenv PATH`).stdout.trim() || '/usr/local/bin:/usr/bin:/bin').split(':')
		return [...new Set([BIN, bunBin, join(HOME, '.bun', 'bin'), ...base, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(':')
	}
	const which = async (bin: string) =>
		(await amp.$`sh -c ${`command -v ${bin} || { p="$(bun pm bin -g 2>/dev/null)/${bin}"; [ -x "$p" ] && echo "$p"; }`}`).stdout.trim()
	let hcReady: Promise<void> | null = null
	const ensureHc = () =>
		(hcReady ??= (async () => {
			if (!existsSync(HC)) {
				mkdirSync(STATE, { recursive: true })
				const script = join(STATE, 'hc-install.sh')
				await sh`curl -fsSL -o ${script} https://releases.herdr.dev/core/install.sh`
				await sh`env HC_VERSION=${HC_VERSION} sh ${script}`
				if (!existsSync(HC)) throw new Error(`herdr-core install did not create ${HC}.`)
			}
			await startCore()
		})().catch((e) => {
			hcReady = null
			throw e
		}))
	// The core keeps the orb's environment (project secrets, proxy, CA) minus agent-session markers
	// that change how child agents behave. launch.sh removes the model keys per harness.
	const STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SSE_PORT', 'HC_TERMINAL_ID', 'HC_SESSION', 'HC_SCOPE', 'HC_TERMINAL_SOCKET', 'PORT', 'PUBLIC_URL', 'AMP_THREAD_ID']
	const inOrb = process.env.AMP_ORB === '1' || amp.system.executor.kind === 'remote'
	const startCore = async () => {
		const path = await pathEnv()
		const envArgs = [...STRIP.flatMap((v) => ['-u', v]), `PATH=${path}`, 'LANG=C.UTF-8', 'TERM=xterm-256color']
		let r: any
		if (inOrb) {
			// In an orb the core must not belong to the plugin process: a plugin reload restarts that
			// process and would take the core and every child agent with it. Amp supervises services.
			const svc = await amp.$`amp orb service status tandem-core`
			if (svc.exitCode !== 0 || !/Active: active \(running\)/.test(svc.stdout)) {
				const cmd = ['env', ...envArgs, HC, 'serve'].map(shq).join(' ')
				r = await amp.$`amp orb service start tandem-core --cwd ${HOME} --command ${cmd}`
			}
			// Wait for the core's socket. Any hc call before that would start a second core outside the service.
			const sock = join(HOME, '.local', 'state', 'herdr-core', 'default', 'default.sock')
			for (let i = 0; i < 40 && !existsSync(sock); i++) await new Promise((res) => setTimeout(res, 250))
			if (!existsSync(sock)) throw new Error(`herdr-core service did not open ${sock}: ${(await amp.$`amp orb service logs tandem-core`).stdout.slice(-400)}`)
		} else {
			r = await amp.$`env ${envArgs} ${HC} server start`
		}
		const st = await amp.$`${HC} server status`
		if (st.exitCode !== 0) throw new Error(`herdr-core did not start: ${r?.stderr || r?.stdout || st.stderr}`)
	}
	let installChain: Promise<unknown> = Promise.resolve() // bun i -g runs one at a time
	const installs = new Map<Harness, Promise<string>>()
	const ensureHarness = (h: Harness) => {
		if (!installs.has(h))
			installs.set(
				h,
				(async () => {
					let p = await which(HARNESSES[h].bin)
					if (!p) {
						const job = installChain.then(() => sh`bun i -g ${HARNESSES[h].pkg}`)
						installChain = job.catch(() => {})
						await job
						p = await which(HARNESSES[h].bin)
					}
					if (!p) throw new Error(`Could not install ${HARNESSES[h].pkg}.`)
					return p
				})().catch((e) => {
					installs.delete(h)
					throw e
				}),
			)
		return installs.get(h)!
	}
	if (process.env.AMP_ORB === '1' || amp.system.executor.kind === 'remote') {
		ensureHc().catch(() => {})
		for (const h of Object.keys(HARNESSES) as Harness[]) ensureHarness(h).catch(() => {})
	}

	// ---------- per-harness setup (no secrets written except the 0600 env file) ----------
	const hookCmd = `python3 ${shq(join(HERE, 'hook.py'))}`
	const hookEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd']
	const hooksBlock = (timeout?: number) =>
		Object.fromEntries(hookEvents.map((e) => [e, [{ hooks: [{ type: 'command', command: hookCmd, ...(timeout ? { timeout } : {}) }] }]]))

	const setupClaude = async (cwd: string, bin: string) => {
		const version = (await sh`${bin} --version`).split(' ')[0]
		const p = join(HOME, '.claude.json')
		const d = existsSync(p) ? json(readFileSync(p, 'utf8')) : {}
		if (!d) throw new Error(`${p} is not valid JSON; not touching it.`)
		Object.assign(d, { hasCompletedOnboarding: true, lastOnboardingVersion: version, lastReleaseNotesSeen: version })
		d.projects ??= {}
		for (const dir of new Set([cwd, realpathSync(cwd)]))
			d.projects[dir] = { ...d.projects[dir], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true }
		writeFileSync(p + '.tandem-tmp', JSON.stringify(d))
		renameSync(p + '.tandem-tmp', p)
		const s = join(HOME, '.claude', 'settings.json')
		mkdirSync(dirname(s), { recursive: true })
		const c = existsSync(s) ? json(readFileSync(s, 'utf8')) ?? {} : {}
		Object.assign(c, { skipDangerousModePermissionPrompt: true, theme: c.theme ?? 'dark' })
		writeFileSync(s, JSON.stringify(c))
		const hooks = join(STATE, 'claude-hooks.json')
		writeFileSync(hooks, JSON.stringify({ hooks: hooksBlock() }))
		return hooks
	}
	// ---------- ChatGPT subscription for codex and pi ----------
	// Amp puts only CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY and OPENAI_API_KEY into orbs. The
	// ChatGPT subscription comes from the personal secret CODEX_AUTH_JSON: the user's full
	// ~/.codex/auth.json (access + refresh token), uploaded by bin/sync-codex-auth.
	type ChatGPT = { access_token: string; id_token?: string; account_id?: string; refresh_token?: string; expires: number; expired?: boolean }
	const jwtExp = (t: string) => {
		try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp as number } catch { return 0 }
	}
	const chatgpt = async (): Promise<ChatGPT | null> => {
		const a = json(await env('CODEX_AUTH_JSON'))
		const t = a?.tokens
		if (a?.auth_mode !== 'chatgpt' || !t?.access_token) return null
		const expires = jwtExp(t.access_token)
		// With a refresh token the harness renews an expired access token by itself.
		return { ...t, expires, expired: !t.refresh_token && expires * 1000 < Date.now() + 30 * 60_000 }
	}
	const pickBilling = async (want: string | undefined, harness: Harness) => {
		if (harness === 'claude') return { billing: 'subscription', sub: null }
		const sub = await chatgpt()
		if (want === 'api' || (!want && (!sub || sub.expired))) return { billing: 'api', sub: null, note: sub?.expired && want !== 'api' ? 'ChatGPT token in CODEX_AUTH_JSON expired: run bin/sync-codex-auth on your machine. Using the OpenAI API key.' : undefined }
		if (!sub) throw new Error('billing "subscription" needs the personal Amp secret CODEX_AUTH_JSON (your ~/.codex/auth.json). Run bin/sync-codex-auth on your machine.')
		if (sub.expired) throw new Error('The ChatGPT token in CODEX_AUTH_JSON has expired. Run bin/sync-codex-auth on your machine, or use billing "api".')
		return { billing: 'subscription', sub }
	}

	const codexHome = join(STATE, 'codex-home')
	const setupCodex = async (cwd: string, bin: string, sub: ChatGPT | null) => {
		mkdirSync(codexHome, { recursive: true })
		const tf = join(STATE, 'codex-trust.json')
		const trusted = new Set<string>((existsSync(tf) && json(readFileSync(tf, 'utf8'))) || [])
		trusted.add(cwd)
		trusted.add(realpathSync(cwd)) // codex compares the resolved path
		writeFileSync(join(STATE, 'codex-trust.json'), JSON.stringify([...trusted]))
		const toml = [
			'approval_policy = "never"',
			'sandbox_mode = "danger-full-access"',
			'suppress_unstable_features_warning = true',
			'',
			'[features]',
			'hooks = true',
			'',
			'[tui]',
			'screen_reader_detection_done = true',
			...[...trusted].flatMap((d) => ['', `[projects.${JSON.stringify(d)}]`, 'trust_level = "trusted"']),
		].join('\n')
		writeFileSync(join(codexHome, 'config.toml'), toml + '\n')
		writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: hooksBlock(10) }))
		if (sub) {
			const auth = {
				auth_mode: 'chatgpt',
				OPENAI_API_KEY: null,
				tokens: { access_token: sub.access_token, id_token: sub.id_token ?? '', account_id: sub.account_id ?? '', refresh_token: sub.refresh_token ?? '' },
				// "now": codex refreshes only when the access token really expires. Each refresh
				// rotates the refresh token, so fewer refreshes here mean fewer clashes with your machine.
				last_refresh: new Date().toISOString(),
			}
			writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
		} else {
			const key = await env('OPENAI_API_KEY')
			if (!key) throw new Error('OPENAI_API_KEY is not set in this orb. Connect an OpenAI API key in Amp model routing.')
			const r = await amp.$`sh -c ${'printenv OPENAI_API_KEY | CODEX_HOME="$1" "$2" login --with-api-key'} _ ${codexHome} ${bin}`
			if (r.exitCode !== 0) throw new Error(`codex login failed: ${r.stderr || r.stdout}`)
		}
	}
	const piHome = join(STATE, 'pi-home')
	const setupPi = (model: string, sub: ChatGPT | null) => {
		mkdirSync(piHome, { recursive: true })
		// pi's provider "openai-codex" is the ChatGPT subscription; "openai" uses OPENAI_API_KEY.
		const auth = sub
			? { 'openai-codex': { type: 'oauth', access: sub.access_token, refresh: sub.refresh_token ?? '', expires: sub.expires * 1000, accountId: sub.account_id } }
			: {}
		writeFileSync(join(piHome, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
		const mp = join(piHome, 'models.json')
		const m = existsSync(mp) ? json(readFileSync(mp, 'utf8')) ?? {} : {}
		m.providers ??= {}
		const or = (m.providers.or ??= { api: 'openai-completions', apiKey: '$OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', models: [] })
		const id = model.replace(/^or\//, '')
		if (model.startsWith('or/') && !or.models.some((x: any) => x.id === id)) or.models.push({ id, input: ['text'], reasoning: true, contextWindow: 200000 })
		writeFileSync(mp, JSON.stringify(m))
		writeFileSync(join(piHome, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always', quietStartup: true }))
	}

	// ---------- run files ----------
	const runDir = (tid: string, name: string) => join(STATE, 'runs', tid, name)
	const save = (r: Run) => writeFileSync(join(r.dir, 'run.json'), JSON.stringify(r, null, 1))
	const load = (tid: string, name: string): Run | null => {
		const k = key(tid, name)
		if (runs.has(k)) return runs.get(k)!
		const f = join(runDir(tid, name), 'run.json')
		if (!existsSync(f)) return null
		const r = json(readFileSync(f, 'utf8'))
		if (r && !r.ended) runs.set(k, r)
		return r
	}
	const mustLoad = (tid: string, name: string) => {
		const r = load(tid, name)
		if (!r) {
			const names = listNames(tid)
			throw new Error(`No agent named "${name}" in this thread.${names.length ? ` Known: ${names.join(', ')}.` : ' Start one with agent_start.'}`)
		}
		return r
	}
	const listNames = (tid: string) => {
		const d = join(STATE, 'runs', tid)
		return existsSync(d) ? readdirSync(d).filter((n) => existsSync(join(d, n, 'run.json'))) : []
	}
	const events = (r: Run) => readJSONL(join(r.dir, 'events.jsonl'))

	// ---------- status ----------
	// hc semantics: `turn` goes up each time the agent's status leaves `working` (done, idle,
	// blocked or error). So `turn > lastTurn` is the one reliable "a turn ended" signal.
	const hcName = (r: Run) => r.hc
	const getOne = async (r: Run) => json((await amp.$`${HC} get ${hcName(r)} --json`).stdout)
	// Returns null when hc itself fails, so a broken core never looks like "all agents gone".
	const getAll = async (tid: string): Promise<Map<string, any> | null> => {
		const res = await amp.$`${HC} ls --all --json --label ${`amp_thread=${tid}`}`
		const list = res.exitCode === 0 ? json(res.stdout) : null
		if (!list) return null
		const ts = Array.isArray(list) ? list : list.terminals ?? []
		// `hc ls` has no status; `hc get` has it (state, msg, kind, turn, title).
		const full = await Promise.all(ts.map(async (t: any) => (t.state === 'finished' ? t : json((await amp.$`${HC} get ${t.name} --json`).stdout) ?? t)))
		return new Map<string, any>(full.map((t: any) => [t.name, t]))
	}
	const stateOf = (t: any) => (!t ? 'gone' : t.state === 'finished' ? 'exited' : t.status?.state ?? 'starting')
	const finalText = (r: Run, ev: any[]) => {
		const last = [...ev].reverse().find((e) => e.kind === 'final' || e.kind === 'error')
		if (!last || last.t * 1000 < r.turnStarted - 1000) return ''
		return last.kind === 'error' ? `ERROR: ${last.msg ?? ''}\n${last.text ?? ''}`.trim() : last.text ?? ''
	}
	const doingNow = (r: Run, t: any, ev: any[]) => {
		const st = stateOf(t)
		const lastTool = [...ev].reverse().find((e) => e.kind === 'tool' || e.kind === 'blocked')
		const fresh = lastTool && lastTool.t * 1000 >= r.turnStarted - 1000
		const title = String(t?.title ?? '').replace(/^[⠀-⣿]\s*/, '')
		if (st === 'blocked') return t?.status?.msg || (lastTool?.kind === 'blocked' ? lastTool.msg : '') || 'needs input'
		if (st === 'error') return t?.status?.msg || 'error'
		if (st === 'working') return (r.harness === 'claude' && t?.status?.msg) || (fresh ? lastTool.msg : '') || title || 'thinking'
		if (st === 'exited') return `exit ${t?.exit_code ?? '?'}`
		if (st === 'starting' && r.stuck) return 'did not start, see screen'
		return short(finalText(r, ev), 60) || title
	}

	const report = async (r: Run, t?: any) => {
		if (t === undefined) t = await getOne(r)
		const ev = events(r)
		const st = r.stuck && stateOf(t) === 'starting' ? 'stuck' : stateOf(t)
		const lines = [
			`Agent "${r.name}" (${r.harness}, ${r.model}, effort ${r.effort}${r.billing === 'api' ? ', OpenAI API key' : ''}) in ${r.cwd}`,
			`State: ${st}${t?.status?.kind ? ` (${t.status.kind})` : ''} · turn ${t?.turn ?? r.lastTurn} · running ${ago(Date.now() - r.started)}`,
		]
		const now = doingNow(r, t, ev)
		if (now) lines.push(`Now: ${now}`)
		const fin = finalText(r, ev)
		if (fin) lines.push('', 'Final message of the last turn:', fin.length > 6000 ? fin.slice(0, 6000) + '\n…(cut)' : fin)
		const tools = ev.filter((e) => e.kind === 'tool' && e.t * 1000 >= r.turnStarted - 1000)
		if (tools.length) lines.push('', `Tool calls this turn (${tools.length}${tools.length > 10 ? ', last 10' : ''}):`, ...tools.slice(-10).map((e) => `- ${e.msg}`))
		if (!fin || st === 'blocked' || st === 'error' || st === 'stuck') {
			const read = t ? (await amp.$`${HC} read ${hcName(r)} --lines 40`).stdout : ''
			const screen = read.split('\n').filter((l) => l.trim() && !/^[─━-]{20,}/.test(l.trim()) && !l.startsWith('[hc]')).slice(-25)
			if (screen.length) lines.push('', 'Screen (last lines):', ...screen)
		}
		const changed = (await amp.$`git -C ${r.cwd} status --short`).stdout.trim()
		lines.push('', 'Changed files (git status --short):', changed ? changed.split('\n').slice(0, 40).join('\n') : '(none)')
		if (r.turns.length) lines.push('', `Turn times: ${r.turns.map((x) => `#${x.turn} ${x.state} ${x.seconds}s`).join(', ')}`)
		const text = lines.join('\n')
		writeFileSync(join(r.dir, 'report.md'), text)
		return text
	}

	// ---------- quick actions ----------
	const ICON: Record<string, string> = { working: 'activity', starting: 'play', done: 'check', idle: 'check', blocked: 'message-square', error: 'bug', exited: 'archive', gone: 'archive' }
	const ensureCommand = (name: string) => {
		if (commands.has(name)) return
		commands.set(
			name,
			amp.registerCommand(
				`show-${name}`,
				{ title: `Show agent ${name}`, category: 'Tandem', description: `Show the ${name} agent in the Terminal pane` },
				async (ctx) => {
					const tid = ctx.thread?.id
					const r = tid ? load(tid, name) : null
					if (r && !r.ended) await showInTerminalPane(r).catch(() => {})
					await ctx.ui.perform({ action: 'open-pane', args: { pane: 'terminal' } })
				},
			),
		)
	}
	const setButton = (r: Run, text: string, icon: string) => {
		const k = key(r.threadID, r.name)
		const def = { text: short(text, 40), icon, action: 'run-command', args: { command: `show-${r.name}` } }
		const b = buttons.get(k)
		try {
			if (b) {
				if (b.text === def.text && b.icon === icon) return
				b.handle.update(def)
				Object.assign(b, { text: def.text, icon })
			} else {
				if ([...buttons.keys()].filter((x) => x.startsWith(r.threadID + '/')).length >= MAX_BUTTONS) return
				ensureCommand(r.name)
				const handle = thread(r.threadID).createQuickAction(def)
				buttons.set(k, { handle, text: def.text, icon })
			}
			uiErrors.delete(k)
		} catch (e) {
			uiErrors.set(k, String(e).slice(0, 200))
			amp.logger?.log?.(`tandem: quick action failed: ${e}`)
		}
	}
	const uiErrors = new Map<string, string>()
	const dropButton = (r: Run) => {
		const k = key(r.threadID, r.name)
		try {
			buttons.get(k)?.handle.unsubscribe()
		} catch {}
		buttons.delete(k)
	}

	// ---------- the Terminal pane ----------
	// Amp's Terminal pane is a tmux control-mode client of this session and draws the output of
	// every window into one view. So there is one window, "agents", that shows one child at a time;
	// a button click swaps the child with respawn-pane. The other children keep running in hc.
	const VIEW = 'tandem'
	const viewing = new Map<string, string>() // threadID -> agent name in the view
	const showInTerminalPane = async (r: Run) => {
		const session = sessionFor(r.threadID)
		const target = `${session}:${VIEW}`
		const cmd = `${shq(HC)} attach ${shq(hcName(r))}`
		if ((await amp.$`tmux -L ${SOCKET} has-session -t ${session}`).exitCode !== 0)
			await sh`tmux -L ${SOCKET} new-session -d -s ${session} -x 200 -y 50`
		await amp.$`tmux -L ${SOCKET} set -g focus-events on`
		if ((await amp.$`tmux -L ${SOCKET} respawn-pane -k -t ${target} ${cmd}`).exitCode !== 0)
			await sh`tmux -L ${SOCKET} new-window -t ${session + ':'} -n ${VIEW} ${cmd}`
		await amp.$`tmux -L ${SOCKET} set-option -w -t ${target} remain-on-exit on`
		await amp.$`tmux -L ${SOCKET} select-window -t ${target}`
		viewing.set(r.threadID, r.name)
	}
	// When the shown child goes away, show another live one (or leave the last screen).
	const viewNext = async (gone: Run) => {
		if (viewing.get(gone.threadID) !== gone.name) return
		const next = [...runs.values()].find((x) => x.threadID === gone.threadID && !x.ended && x !== gone)
		if (next) await showInTerminalPane(next).catch(() => {})
		else viewing.delete(gone.threadID)
	}

	// ---------- watcher: one loop for all runs ----------
	// A notification is queued on the run (r.pending) and delivered by the tick, so a failed
	// delivery is retried. A claim file per (turn, reason) stops a second Amp process from
	// posting the same notification.
	const queueNotify = (r: Run, reason: string) => {
		if (!r.notify) return
		r.pending = { reason, turn: r.lastTurn, since: Date.now() }
	}
	const deliver = async (r: Run, t: any) => {
		const p = r.pending
		if (!p) return
		if (waiting.has(key(r.threadID, r.name))) return void (r.pending = undefined) // agent_wait returns the report
		// Give the Stop hook a moment to write the final message.
		if (p.reason === 'turn' && !finalText(r, events(r)) && Date.now() - p.since < 5000) return
		const claim = join(r.dir, `notified-${p.turn}-${p.reason}`)
		try {
			closeSync(openSync(claim, 'wx'))
		} catch {
			return void (r.pending = undefined) // another process posted it
		}
		const st = stateOf(t)
		const head =
			p.reason === 'blocked' ? 'needs input' : p.reason === 'exited' ? 'exited' : p.reason === 'stuck' ? 'did not start' : `ended turn ${p.turn} (${st})`
		try {
			const text = await report(r, t)
			await thread(r.threadID).appendUserMessage(
				{ type: 'user-message', content: `[tandem] ${r.name} ${head}. Review its work before you trust it.\n\n${text}` },
				{ steer: true },
			)
			r.pending = undefined
		} catch (e) {
			rmSync(claim, { force: true })
			amp.logger?.log?.(`tandem: notify failed, will retry: ${e}`)
		}
	}
	const updateLease = async (tid: string) => {
		const busy = [...runs.values()].some((r) => r.threadID === tid && !r.ended && !r.stuck && (r.lastState === 'working' || r.lastState === 'starting'))
		const held = leases.get(tid)
		if (busy && !held && amp.system.executor.kind === 'remote') {
			leases.set(tid, 'pending')
			try {
				leases.set(tid, await amp.system.executor.keepAlive())
			} catch {
				leases.delete(tid)
			}
		} else if (!busy && held && held !== 'pending') {
			held.unsubscribe()
			leases.delete(tid)
		}
	}
	const STUCK_MS = 90_000
	const step = async (r: Run, t: any) => {
		const st = stateOf(t)
		const ev = events(r)
		if (!r.session) r.session = ev.find((e) => e.kind === 'session' && e.session)?.session
		const turn = t?.turn ?? r.lastTurn
		const prev = r.lastState
		if (st === 'working' && prev !== 'working') r.turnStarted = Date.now()
		if (turn > r.lastTurn) {
			const endState = st === 'working' ? 'done' : st // a new turn may already run
			r.turns.push({ turn, state: endState, seconds: Math.round((Date.now() - r.turnStarted) / 1000), at: Date.now() })
			r.lastTurn = turn
			if (r.skipUntil && Date.now() < r.skipUntil) r.skipUntil = 0 // ended by our own interrupt
			else queueNotify(r, endState === 'blocked' ? 'blocked' : 'turn')
		}
		if (st !== 'starting') r.stuck = false
		if (st === 'starting' && !r.stuck && Date.now() - r.started > STUCK_MS) {
			r.stuck = true
			queueNotify(r, 'stuck')
		}
		if ((st === 'exited' || st === 'gone') && !r.ended) {
			r.ended = Date.now()
			queueNotify(r, 'exited')
		}
		r.lastState = st
		setButton(r, `${r.name} ${st}${doingNow(r, t, ev) ? ': ' + doingNow(r, t, ev) : ''}`, ICON[st] ?? 'terminal')
		await deliver(r, t)
		if (runs.get(key(r.threadID, r.name)) !== r) return // replaced by agent_stop/agent_start meanwhile
		save(r)
		if (r.ended && !r.pending) {
			dropButton(r)
			runs.delete(key(r.threadID, r.name))
			await viewNext(r)
		}
	}
	const tick = async () => {
		if (ticking) return
		ticking = true
		try {
			const tids = new Set([...runs.values()].map((r) => r.threadID))
			for (const tid of tids) {
				const all = await getAll(tid)
				if (!all) {
					// hc failed: try to bring the core back, never mark runs as gone.
					hcReady = null
					await ensureHc().catch((e) => amp.logger?.log?.(`tandem: hc down: ${e}`))
					continue
				}
				for (const r of [...runs.values()].filter((x) => x.threadID === tid)) {
					try {
						await step(r, all.get(hcName(r)))
					} catch (e) {
						amp.logger?.log?.(`tandem: ${r.name}: ${e}`)
					}
				}
				await updateLease(tid)
			}
		} finally {
			ticking = false
		}
	}
	const timer = setInterval(tick, TICK_MS)

	// Rebuild state after a plugin reload or orb wake: only runs whose terminal still exists.
	const rehydrate = async (tid: string) => {
		const names = listNames(tid).filter((n) => !runs.has(key(tid, n)))
		if (!names.length) return
		await ensureHc().catch(() => {})
		const all = await getAll(tid)
		if (!all) return
		for (const n of names) {
			const r = load(tid, n)
			if (!r || r.ended) continue
			if (all.has(hcName(r))) runs.set(key(tid, n), r)
			else {
				r.ended = Date.now() // terminal is gone (orb restarted): close silently
				save(r)
				runs.delete(key(tid, n))
			}
		}
	}
	if (process.env.AMP_ORB === '1' || amp.system.executor.kind === 'remote') {
		try {
			const root = join(STATE, 'runs')
			if (existsSync(root)) for (const tid of readdirSync(root)) rehydrate(tid).catch(() => {})
		} catch {}
	}
	amp.on('session.start', async (event, ctx) => {
		if (ctx?.thread) threads.set(event.thread.id, ctx.thread)
		await rehydrate(event.thread.id).catch(() => {})
	})

	// Tell each new parent turn what its children are doing, without a tool call.
	amp.on('agent.start', async (_event, ctx) => {
		const tid = ctx.thread?.id
		if (!tid) return
		const live = [...runs.values()].filter((r) => r.threadID === tid && !r.ended)
		if (!live.length) return
		return {
			message: {
				content: `[tandem] children: ${live.map((r) => `${r.name} (${r.harness}) ${r.lastState}, turn ${r.lastTurn}`).join('; ')}`,
				display: false,
			},
		}
	})

	// ---------- tools ----------
	amp.registerTool({
		name: 'agent_start',
		title: 'Start agent',
		defer: false,
		transcriptGroup: { active: 'Starting agent', complete: 'Started agent' },
		description:
			'Start a coding agent CLI inside this orb, next to the code: "claude" (Claude Code, default Opus 5.5, Claude subscription), "codex" (Codex CLI, default GPT-6 Astra, ChatGPT subscription when set up) or "pi" (pi, default GPT-6 Astra via ChatGPT subscription; supports extensions such as npm:pi-autoresearch). Its tool calls run locally, much faster than your own. It runs its real TUI in the Terminal pane; a button above the composer shows what it is doing. Returns at once. When it ends a turn or needs input, its report arrives in this thread as an [tandem] message, so you can end your turn instead of waiting. Use agent_wait only when you want to block. The agent does not see this thread: give it the complete task. Load the skill tandem:delegate first if you have not.',
		inputSchema: {
			type: 'object',
			properties: {
				task: { type: 'string', description: 'Complete task: goal, context, files, constraints, acceptance check, and what the final message must contain.' },
				harness: { type: 'string', enum: ['claude', 'codex', 'pi'], description: 'Default: claude' },
				name: { type: 'string', description: 'Short unique name (a-z, 0-9, -). Default: the harness name.' },
				model: { type: 'string', description: 'Optional model. claude: claude-opus-5-5, claude-sonnet-5-5 … codex: gpt-6-astra … pi: provider/model, e.g. openai/gpt-6-astra or or/<openrouter id>.' },
				effort: { type: 'string', description: 'low, medium, high, xhigh. Default: medium.' },
				cwd: { type: 'string', description: 'Working directory. Default: the workspace.' },
				extensions: { type: 'array', items: { type: 'string' }, description: 'pi only, e.g. ["npm:pi-autoresearch"].' },
				notify: { type: 'boolean', description: 'Post the report into this thread when the agent ends a turn. Default: true.' },
				billing: { type: 'string', enum: ['subscription', 'api'], description: 'codex and pi: "subscription" uses the ChatGPT subscription (personal secret CODEX_AUTH_JSON), "api" the OpenAI API key. Default: subscription when available. claude always uses the Claude subscription from Amp.' },
			},
			required: ['task'],
		},
		async execute(input, ctx) {
			const tid = ctx.thread.id
			threads.set(tid, ctx.thread)
			const harness = (input.harness ?? 'claude') as Harness
			if (!HARNESSES[harness]) throw new Error(`Unknown harness "${harness}". Use claude, codex or pi.`)
			const name = String(input.name ?? harness).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24) || harness
			const cwd = input.cwd ? String(input.cwd) : workspace()
			if (!existsSync(cwd)) throw new Error(`Directory ${cwd} does not exist.`)
			await ensureHc()
			const old = load(tid, name)
			if (old && !old.ended) {
				const t = await getOne(old)
				if (t && t.state !== 'finished') throw new Error(`Agent "${name}" is still running. Use agent_send, or agent_stop it first, or pick another name.`)
			}
			const bin = await ensureHarness(harness)
			const { billing, sub, note } = (await pickBilling(input.billing as string | undefined, harness)) as any
			let model = String(input.model ?? HARNESSES[harness].model())
			if (harness === 'pi' && !sub && model.startsWith('openai-codex/')) model = model.replace('openai-codex/', 'openai/')
			if (harness === 'pi' && sub && model.startsWith('openai/')) model = model.replace('openai/', 'openai-codex/')
			const effort = String(input.effort ?? HARNESSES[harness].effort)
			const dir = runDir(tid, name)
			await amp.$`rm -rf ${dir}`
			mkdirSync(dir, { recursive: true })
			// A brief that starts with "-" would be read as a CLI option; a huge one exceeds Linux's
			// 128 KiB per-argument limit, so pass a pointer to the file instead.
			let task = String(input.task)
			writeFileSync(join(dir, 'task.txt'), task)
			if (task.length > 100_000) task = `Your task is in the file ${join(dir, 'task.txt')}. Read it first, then do it.`
			if (task.startsWith('-')) task = `Task: ${task}`
			writeFileSync(join(dir, 'prompt.txt'), task)

			// Credentials: only what this harness needs, in a 0600 file, never in argv.
			const vars: Record<string, string> = {}
			const unset = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_AUTH_JSON']
			let argv: string[]
			const session = randomUUID()
			if (harness === 'claude') {
				vars.CLAUDE_CODE_OAUTH_TOKEN = await env('CLAUDE_CODE_OAUTH_TOKEN')
				// Without the subscription token, fall back to an API key; else Claude's own login.
				if (!vars.CLAUDE_CODE_OAUTH_TOKEN) vars.ANTHROPIC_API_KEY = await env('ANTHROPIC_API_KEY')
				const settings = await setupClaude(cwd, bin)
				argv = [bin, '--dangerously-skip-permissions', '--model', model, '--effort', effort, '--session-id', session, '--settings', settings]
			} else if (harness === 'codex') {
				await setupCodex(cwd, bin, sub)
				vars.CODEX_HOME = codexHome
				argv = [bin, '--no-daemon', '--dangerously-bypass-hook-trust', '-m', model, '-c', `model_reasoning_effort="${effort}"`]
			} else {
				for (const k of sub ? ['OPENROUTER_API_KEY'] : ['OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
					const v = await env(k)
					if (v) vars[k] = v
				}
				setupPi(model, sub)
				vars.PI_CODING_AGENT_DIR = piHome
				argv = [bin, '--model', model, '--thinking', effort, '--session-id', session, '--name', name, '-e', join(HERE, 'pi-status.ts')]
				for (const e of (input.extensions as string[]) ?? []) argv.push('-e', e)
			}
			// The env file is 0600 from the start, single-quoted, and deleted by launch.sh after use.
			const envFile = join(dir, 'env')
			const q = shq
			writeFileSync(envFile, Object.entries(vars).filter(([, v]) => v).map(([k, v]) => `export ${k}=${q(v)}`).join('\n') + '\n', { mode: 0o600 })
			const launch = [
				'#!/bin/bash',
				`unset ${unset.join(' ')}`,
				`. ${q(envFile)}; rm -f ${q(envFile)}`,
				`export TANDEM_RUN_DIR=${q(dir)} PATH=${q(await pathEnv())} TERM=xterm-256color COLORTERM=truecolor`,
				`exec ${argv.map(q).join(' ')} "$(cat ${q(join(dir, 'prompt.txt'))})"`,
			].join('\n')
			writeFileSync(join(dir, 'launch.sh'), launch + '\n')
			chmodSync(join(dir, 'launch.sh'), 0o700)

			const hc = `${name}-${tid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, '')}`
			await amp.$`${HC} rm ${hc}`
			await sh`${HC} run --bg --no-parent --no-notify --name ${hc} --cwd ${cwd} --label ${`amp_thread=${tid}`} --label ${`agent=${name}`} bash ${join(dir, 'launch.sh')}`
			const r: Run = {
				name, harness, threadID: tid, cwd, dir, model, effort, hc, billing,
				session: harness === 'codex' ? undefined : session,
				started: Date.now(), notify: input.notify !== false,
				lastTurn: 0, lastState: 'starting', turnStarted: Date.now(), turns: [], waitFrom: 0,
			}
			runs.set(key(tid, name), r)
			save(r)
			await showInTerminalPane(r).catch((e) => amp.logger?.log?.(`tandem: tmux failed: ${e}`))
			setButton(r, `${name} starting`, 'play')
			ctx.ui.perform?.({ action: 'open-pane', args: { pane: 'terminal' } }).catch?.(() => {})
			updateLease(tid)
			const via = harness === 'claude' ? 'Claude subscription' : billing === 'subscription' ? 'ChatGPT subscription' : 'OpenAI API key'
			return `${note ? note + '\n' : ''}Started ${harness} as "${name}" (${model}, effort ${effort}, via ${via}) in ${cwd}. Watch it in the Terminal pane, window "${name}". Its report will arrive in this thread when it ends a turn${r.notify ? '' : ' (notify is off: call agent_wait)'}.`
		},
	})

	amp.registerTool({
		name: 'agent_wait',
		title: 'Wait for agent',
		defer: false,
		transcriptGroup: { active: 'Waiting for agent', complete: 'Waited for agent' },
		description:
			'Block until the agent ends its turn (done, idle, blocked, error, exited) or the timeout, then return its report: state, what it is doing, its final message, tool calls of this turn, changed files. seconds: 0 returns the report at once. Prefer ending your turn and waiting for the [tandem] message for long work.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Agent name. Default: the only agent, or claude.' },
				seconds: { type: 'number', description: '0 to 600. Default: 120.' },
			},
		},
		async execute(input, ctx) {
			const tid = ctx.thread.id
			const names = listNames(tid)
			const name = String(input.name ?? (names.length === 1 ? names[0] : 'claude'))
			const r = mustLoad(tid, name)
			const k = key(tid, name)
			const until = Date.now() + Math.min(600, Math.max(0, Number(input.seconds ?? 120))) * 1000
			// Wait for hc's own turn counter, not the 2 s tick: right after agent_send the old
			// "done" would end the wait at once. Also covers the brief idle before working.
			let t = await getOne(r)
			// waitFrom = hc turn when the work was handed over (agent_start: 0, agent_send: turn then),
			// so a turn that already ended before this call returns at once.
			const startTurn = r.waitFrom ?? t?.turn ?? r.lastTurn
			const settled = (t: any) => !t || t.state === 'finished' || (t.turn ?? 0) > startTurn || ['blocked', 'error'].includes(t.status?.state)
			waiting.add(k)
			try {
				while (Date.now() < until && !ctx.signal?.aborted && !settled(t)) {
					await new Promise((res) => setTimeout(res, 1000))
					t = await getOne(r)
				}
				// Let the Stop hook write the final message.
				for (let i = 0; i < 5 && settled(t) && t?.state !== 'finished' && !finalText(r, events(r)); i++) await new Promise((res) => setTimeout(res, 500))
				if ((t?.turn ?? 0) > startTurn) {
					r.pending = undefined
					r.waitFrom = undefined
				}
			} finally {
				waiting.delete(k)
			}
			return report(r, t)
		},
	})

	amp.registerTool({
		name: 'agent_send',
		title: 'Message agent',
		defer: false,
		description:
			'Type a message into the agent and press Enter (follow-up work, steering, an answer). While it works, the agent queues the message. If it is blocked on a dialog, pass keys instead, e.g. ["enter"] to accept the highlighted option, ["esc"] to cancel, ["down","enter"] to pick the next option. interrupt: true stops the current turn first.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				message: { type: 'string' },
				keys: { type: 'array', items: { type: 'string' }, description: 'Keys to press: enter, esc, up, down, tab, y, n, ctrl+c …' },
				interrupt: { type: 'boolean' },
			},
			required: ['name'],
		},
		async execute(input, ctx) {
			const r = mustLoad(ctx.thread.id, String(input.name))
			const out: string[] = []
			if (input.interrupt) {
				r.skipUntil = Date.now() + 60_000 // the turn our interrupt ends is not news for the parent
				out.push((await amp.$`${HC} interrupt ${hcName(r)}`).stdout.trim())
				// Codex keeps reporting "working" until the interrupted command ends; a message typed
				// before that is lost. Wait until the agent has really stopped (max 60 s).
				let t = await getOne(r)
				for (let i = 0; i < 60 && t?.status?.state === 'working' && t.state !== 'finished'; i++) {
					await new Promise((res) => setTimeout(res, 1000))
					t = await getOne(r)
				}
				if (t?.turn > r.lastTurn) {
					r.turns.push({ turn: t.turn, state: 'interrupted', seconds: Math.round((Date.now() - r.turnStarted) / 1000), at: Date.now() })
					r.lastTurn = t.turn // absorb the interrupted turn silently
				}
				r.skipUntil = 0
				r.lastState = t?.status?.state ?? stateOf(t)
				r.turnStarted = Date.now()
				out.push(`now ${r.lastState}`)
			}
			if (Array.isArray(input.keys) && input.keys.length) out.push(await sh`${HC} keys ${hcName(r)} ${input.keys.map(String)}`)
			if (input.message) {
				r.waitFrom = (await getOne(r))?.turn ?? r.lastTurn
				const res = await amp.$`${HC} send ${hcName(r)} ${String(input.message)}`
				if (res.exitCode !== 0) throw new Error(`Not sent: ${res.stdout || res.stderr}. If it is blocked, answer with keys.`)
				if (r.lastState !== 'working') r.turnStarted = Date.now() // while working, the message queues
				save(r)
			}
			return `Done for "${r.name}". ${out.filter(Boolean).join(' ')} Its report will arrive when it ends the turn.`
		},
	})

	amp.registerTool({
		name: 'agent_stop',
		title: 'Stop agent',
		defer: false,
		description: 'Stop an agent and close its window. Its changes in the working copy stay. Returns its last report.',
		inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
		async execute(input, ctx) {
			const tid = ctx.thread.id
			const r = mustLoad(tid, String(input.name))
			const final = await report(r)
			r.ended = Date.now()
			r.lastState = 'exited'
			save(r)
			await amp.$`${HC} kill ${hcName(r)}`
			await amp.$`${HC} rm ${hcName(r)}`
			await viewNext(r)
			r.pending = undefined
			dropButton(r)
			runs.delete(key(tid, r.name))
			await updateLease(tid)
			return `Stopped "${r.name}".\n\n${final}`
		},
	})

	amp.registerTool({
		name: 'agent_list',
		title: 'List agents',
		defer: false,
		description: 'List the agents of this thread with state, turn, timings and session ids (JSON lines).',
		inputSchema: { type: 'object', properties: {} },
		async execute(_input, ctx) {
			const tid = ctx.thread.id
			const all = (await getAll(tid)) ?? new Map()
			const rows = listNames(tid).map((n) => {
				const r = load(tid, n)!
				const t = all.get(hcName(r))
				const k = key(tid, n)
				const ui = buttons.get(k) ? { button: buttons.get(k).text, icon: buttons.get(k).icon } : { button: null, error: uiErrors.get(k) ?? null }
				return JSON.stringify({ name: r.name, harness: r.harness, billing: r.billing, ui, model: r.model, state: r.ended ? 'exited' : stateOf(t), turn: t?.turn ?? r.lastTurn, started: r.started, running_s: Math.round(((r.ended ?? Date.now()) - r.started) / 1000), turns: r.turns, session: r.session, cwd: r.cwd })
			})
			return rows.length ? rows.join('\n') : 'No agents in this thread.'
		},
	})

	amp.registerSkill({ path: 'skills/delegate' }).catch((e) => amp.logger?.log?.(`tandem: skill failed: ${e}`))

	amp.onDispose(() => {
		clearInterval(timer)
		for (const l of leases.values()) if (l !== 'pending') l.unsubscribe()
	})
}
