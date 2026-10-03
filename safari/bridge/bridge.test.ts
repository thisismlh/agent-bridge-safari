// End-to-end test of the bridge with a fake extension client. Run: bun test bridge/
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('./bridge.mjs', import.meta.url))

const SOCK = path.join(os.tmpdir(), `claude-safari-bridge-test-${process.pid}.sock`)
const PORT = 47900 + (process.pid % 90)
let child: ChildProcess

const modCall = (p: string, body?: unknown): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ socketPath: SOCK, path: p, method: data ? 'POST' : 'GET', headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let text = ''; res.on('data', c => (text += c)); res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject); if (data) req.write(data); req.end()
  })
const extCall = async (p: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'safari-web-extension://TEST' }, body: JSON.stringify(body) })
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}

beforeAll(async () => {
  child = spawn('node', [BRIDGE, '--sock', SOCK, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', d => { if (String(d).includes('listening')) resolve() })
    child.stderr!.on('data', d => reject(new Error(String(d))))
  })
})
afterAll(() => { child.kill() })

describe('bridge', () => {
  test('status reports no extension until one polls', async () => {
    const s = await modCall('/status')
    expect(s.status).toBe(200)
    expect(s.body.extensionConnected).toBe(false)
    const c = await modCall('/call', { name: 'ping' })
    expect(c.status).toBe(503)
  })

  test('relays a command to a polling extension and returns its result', async () => {
    const poll = extCall('/ext/poll', { version: 'test' })
    await new Promise(r => setTimeout(r, 50))
    const call = modCall('/call', { name: 'ping', params: { x: 1 } })
    const cmd = (await poll).body
    expect(cmd.name).toBe('ping')
    expect(cmd.params).toEqual({ x: 1 })
    await extCall('/ext/result', { id: cmd.id, result: { pong: true } })
    const out = await call
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ result: { pong: true } })
    expect((await modCall('/status')).body.extensionConnected).toBe(true)
  })

  test('an extension error comes back as 502 with its message', async () => {
    const poll = extCall('/ext/poll', { version: 'test' })
    const call = modCall('/call', { name: 'page' })
    const cmd = (await poll).body
    await extCall('/ext/result', { id: cmd.id, error: 'No tab 9' })
    const out = await call
    expect(out.status).toBe(502)
    expect(out.body.error).toBe('No tab 9')
  })

  test('a command queued before the poll is delivered on the next poll', async () => {
    const call = modCall('/call', { name: 'tabs.list' })
    await new Promise(r => setTimeout(r, 30))
    const cmd = (await extCall('/ext/poll', { version: 'test' })).body
    expect(cmd.name).toBe('tabs.list')
    await extCall('/ext/result', { id: cmd.id, result: [] })
    expect((await call).body).toEqual({ result: [] })
  })

  test('times out when the extension never answers', async () => {
    const call = modCall('/call', { name: 'slow', timeoutMs: 1000 })
    await extCall('/ext/poll', { version: 'test' })
    const out = await call
    expect(out.status).toBe(502)
    expect(out.body.error).toContain('did not answer')
  })

  test('a web page cannot pose as the extension', async () => {
    const asPage = await fetch(`http://127.0.0.1:${PORT}/ext/poll`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://127.0.0.1:48610' }, body: '{"version":"evil"}' })
    expect(asPage.status).toBe(403)
    const jsonNoOrigin = await fetch(`http://127.0.0.1:${PORT}/ext/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(jsonNoOrigin.status).toBe(403)
  })

  test('a timed-out command is not handed to a later poll', async () => {
    const call = modCall('/call', { name: 'late', timeoutMs: 1000 })
    const first = await extCall('/ext/poll', { version: 'test' })
    expect(first.body.name).toBe('late')
    await call
    // Simulate the extension never answering; queue a fresh command and make sure only it arrives.
    const next = modCall('/call', { name: 'fresh' })
    const second = await extCall('/ext/poll', { version: 'test' })
    expect(second.body.name).toBe('fresh')
    await extCall('/ext/result', { id: second.body.id, result: 1 })
    await next
  })

  test('a command nobody fetches within the pickup window answers 503', async () => {
    // lastSeen is recent from the previous tests, but no poll is waiting.
    const t0 = Date.now()
    const out = await modCall('/call', { name: 'orphan' })
    expect(out.status).toBe(503)
    expect(Date.now() - t0).toBeLessThan(8000)
    expect((await modCall('/status')).body.extensionConnected).toBe(false)
  }, 15000)

  test('a second bridge on the same socket refuses to start', async () => {
    const dup = spawn('node', [BRIDGE, '--sock', SOCK, '--port', String(PORT + 1)])
    const code = await new Promise<number | null>(r => dup.on('exit', r))
    expect(code).toBe(3)
  })
})
