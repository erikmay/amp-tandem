// Join a running Codex app-server thread as a second client and print status events.
// Usage: bun cxwatch.ts ws://127.0.0.1:PORT [threadId]
const [url, wanted] = process.argv.slice(2)
const ws = new WebSocket(url)
let id = 0
const pending = new Map<number, (r: any) => void>()
const call = (method: string, params: any) =>
  new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params })) })
const t = () => (Date.now() / 1000).toFixed(2)
const brief = (m: any) => {
  const p = m.params ?? {}
  switch (m.method) {
    case 'thread/status/changed': return JSON.stringify(p.status)
    case 'turn/started': return `turn ${p.turn?.id}`
    case 'turn/completed': return `turn ${p.turn?.id} ${p.turn?.status} ${JSON.stringify(p.turn?.error ?? null)}`
    case 'item/started': case 'item/completed': {
      const it = p.item ?? {}
      return `${it.type} ${(it.command ?? it.text ?? it.tool ?? '').toString().slice(0, 100)}`
    }
    default: return JSON.stringify(p).slice(0, 160)
  }
}
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return }
  if (m.method?.endsWith('Delta') || m.method?.endsWith('/delta')) return
  console.log(t(), m.id != null ? 'SERVER-REQUEST' : 'notif', m.method, brief(m))
}
ws.onopen = async () => {
  await call('initialize', { clientInfo: { name: 'lab-watch', version: '0' }, capabilities: { experimentalApi: true } })
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
  let tid = wanted
  while (!tid) {
    const r = await call('thread/loaded/list', {})
    tid = r.result?.data?.[0]
    if (!tid) await Bun.sleep(500)
  }
  const r = await call('thread/resume', { threadId: tid })
  console.log(t(), 'joined', tid, r.error ? JSON.stringify(r.error) : JSON.stringify(r.result?.thread?.status))
}
