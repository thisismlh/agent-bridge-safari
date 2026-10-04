// The local bridge between the Claude Code mod and the Safari extension.
// Plain Node, no dependencies. Two listeners:
//   - a Unix socket for the mod:        POST /call, GET /status
//   - 127.0.0.1:PORT for the extension: POST /ext/poll, POST /ext/result
// Run: node bridge.mjs [--sock PATH] [--port N]

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const SOCK = opt('--sock', path.join(os.homedir(), '.claude', 'safari-bridge.sock'))
const PORT = Number(opt('--port', 47831))
const POLL_HOLD_MS = 25_000
const CONNECTED_WINDOW_MS = 40_000

const queue = []            // commands waiting for the extension
const waiters = []          // extension polls waiting for a command: { res, timer, origin }
const instances = new Map() // origin -> { lastSeen, tabs, version }: several copies of the extension may run
const pending = new Map()   // id -> { resolve, timer }
let lastSeen = 0
let extensionVersion = null
let lastOrigin = null
let lastContentType = null
const PICKUP_MS = 8_000

const json = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
const readBody = req => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch (e) { reject(e) } })
  req.on('error', reject)
})
const isConnected = () => Date.now() - lastSeen < CONNECTED_WINDOW_MS

// Safari can keep stale copies of the extension alive after a rebuild, each polling here.
// Commands go to the copy that can see tabs; ties go to the most recently seen one.
// Sticky: once chosen, the primary stays while it is alive and no other copy sees strictly
// more tabs, so tab ids and "current tab" stay consistent across calls (Safari runs one copy
// per profile, each with its own windows).
let primary = null
function primaryOrigin() {
  const now = Date.now()
  const alive = [...instances].filter(([, i]) => now - i.lastSeen <= CONNECTED_WINDOW_MS)
  const current = alive.find(([o]) => o === primary)
  let best = null
  // Rank: can reach the active page's content script, then sees more tabs, then most recent.
  const score = i => i.reach * 1000 + i.tabs
  for (const [origin, i] of alive) {
    if (!best || score(i) > score(best) || (score(i) === score(best) && i.lastSeen > best.lastSeen)) best = { origin, ...i }
  }
  if (!best) { primary = null; return null }
  if (!current || score(best) > score(current[1])) primary = best.origin
  return primary
}
function dispatch() {
  const primary = primaryOrigin()
  while (queue.length) {
    const idx = waiters.findIndex(w => w.origin === primary && !w.res.destroyed && !w.res.writableEnded)
    if (idx < 0) return
    const w = waiters.splice(idx, 1)[0]
    clearTimeout(w.timer)
    const cmd = queue.shift()
    try { json(w.res, 200, cmd) } catch { queue.unshift(cmd) }
  }
}

// ---- mod side (Unix socket)
const modServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, { ok: true, pid: process.pid, extensionConnected: isConnected(), lastSeen, extensionVersion, primary: primaryOrigin(), instances: Object.fromEntries(instances), lastOrigin, lastContentType, queued: queue.length, pending: pending.size, port: PORT })
    }
    if (req.method === 'POST' && req.url === '/call') {
      const body = await readBody(req)
      if (!isConnected()) return json(res, 503, { error: 'Safari extension is not connected.' })
      const id = randomUUID()
      const timeoutMs = Math.min(600_000, Math.max(1000, Number(body.timeoutMs) || 60_000))
      const cmd = { id, name: body.name, params: body.params || {}, deadline: Date.now() + timeoutMs }
      const unqueue = () => { const i = queue.findIndex(c => c.id === id); if (i >= 0) queue.splice(i, 1) }
      const done = new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); unqueue(); resolve({ error: `Safari did not answer ${body.name} within ${Math.round(timeoutMs / 1000)} s.` }) }, timeoutMs)
        // Nothing fetched it within PICKUP_MS: the extension is gone even if lastSeen is recent.
        const pickup = setTimeout(() => {
          if (queue.some(c => c.id === id)) { clearTimeout(timer); pending.delete(id); unqueue(); lastSeen = 0; resolve({ status: 503, error: 'Safari extension is not connected.' }) }
        }, PICKUP_MS)
        pending.set(id, { resolve, timer, pickup })
      })
      req.on('close', () => { const p = pending.get(id); if (p && !res.writableEnded) { clearTimeout(p.timer); clearTimeout(p.pickup); pending.delete(id); unqueue() } })
      queue.push(cmd)
      dispatch()
      const out = await done
      return json(res, out.status || (out.error !== undefined ? 502 : 200), { result: out.result, error: out.error })
    }
    if (req.method === 'POST' && req.url === '/shutdown') { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 50); return }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) })
  }
})

// ---- extension side (loopback TCP)
const EXT_ORIGIN = /^safari-web-extension:\/\//
function fromExtension(req) {
  const ct = String(req.headers['content-type'] || '')
  const origin = String(req.headers.origin || '')
  lastContentType = ct; lastOrigin = origin
  // A web page cannot send application/json without a CORS preflight (which we never answer),
  // and cannot forge Origin. Both together keep pages on 127.0.0.1 out of the bridge.
  return ct.startsWith('application/json') && EXT_ORIGIN.test(origin)
}

const extServer = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || !fromExtension(req)) return json(res, 403, { error: 'not the Safari extension' })
    if (req.url === '/ext/poll') {
      const body = await readBody(req)
      lastSeen = Date.now()
      const origin = String(req.headers.origin || '')
      for (const [o, i] of instances) if (Date.now() - i.lastSeen > 5 * CONNECTED_WINDOW_MS) instances.delete(o)
      instances.set(origin, { lastSeen, tabs: typeof body.tabs === 'number' ? body.tabs : -1, reach: typeof body.reach === 'number' ? body.reach : 0, version: body.version || null })
      if (body.version && origin === primaryOrigin()) extensionVersion = body.version
      const w = { res, timer: null, origin }
      w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res.writeHead(204); res.end() }, POLL_HOLD_MS)
      req.on('close', () => { clearTimeout(w.timer); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1) })
      waiters.push(w)
      dispatch()
      return
    }
    if (req.url === '/ext/result') {
      const body = await readBody(req)
      lastSeen = Date.now()
      const p = pending.get(body.id)
      if (p) { clearTimeout(p.timer); clearTimeout(p.pickup); pending.delete(body.id); p.resolve(body.error !== undefined ? { error: body.error } : { result: body.result }) }
      return json(res, 200, { ok: true })
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) })
  }
})
extServer.keepAliveTimeout = 65_000

// Refuse to start twice: if a bridge already answers on the socket, exit 3.
async function alreadyRunning() {
  return new Promise(resolve => {
    const req = http.request({ socketPath: SOCK, path: '/status', method: 'GET', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

if (await alreadyRunning()) { console.error(`bridge already running on ${SOCK}`); process.exit(3) }
try {
  await new Promise((resolve, reject) => { extServer.on('error', reject); extServer.listen(PORT, '127.0.0.1', resolve) })
} catch (e) {
  if (e && e.code === 'EADDRINUSE') { console.error(`bridge already running on port ${PORT}`); process.exit(3) }
  throw e
}
fs.mkdirSync(path.dirname(SOCK), { recursive: true })
try { fs.unlinkSync(SOCK) } catch {}
await new Promise((resolve, reject) => { modServer.on('error', reject); modServer.listen(SOCK, resolve) })
fs.chmodSync(SOCK, 0o600)
console.log(`safari bridge listening: ${SOCK} and 127.0.0.1:${PORT}`)

const bye = () => { try { fs.unlinkSync(SOCK) } catch {} process.exit(0) }
process.on('SIGTERM', bye); process.on('SIGINT', bye); process.on('SIGHUP', bye)
