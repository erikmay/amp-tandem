// Send one request to a Codex app-server thread: start a turn or interrupt it.
// Usage: bun cxsend.ts URL THREAD turn "text" | bun cxsend.ts URL THREAD interrupt TURN
const [url, threadId, cmd, arg] = process.argv.slice(2)
const ws = new WebSocket(url)
let id = 0
const call = (method: string, params: any) => new Promise<any>((res) => {
  const i = ++id
  const h = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.id === i) { ws.removeEventListener('message', h); res(m) } }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }))
})
ws.onopen = async () => {
  await call('initialize', { clientInfo: { name: 'lab-send', version: '0' }, capabilities: { experimentalApi: true } })
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
  await call('thread/resume', { threadId, excludeTurns: true })
  const r = cmd === 'turn'
    ? await call('turn/start', { threadId, input: [{ type: 'text', text: arg }] })
    : await call('turn/interrupt', { threadId, turnId: arg })
  console.log(JSON.stringify(r).slice(0, 300))
  ws.close()
}
