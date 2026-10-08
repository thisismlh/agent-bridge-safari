// Bridge protocol tests, run against both implementations:
//   - the Node bridge (bridge.mjs) over its Unix socket
//   - the app-hosted Swift bridge over TCP with a pairing token (skipped when the app is not built)
// Run: bun test bridge/
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_MJS = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
const APP_BIN = fileURLToPath(new URL('../app/Agent Bridge for Safari.app/Contents/MacOS/Agent Bridge for Safari', import.meta.url))
const TOKEN = 'a'.repeat(48)

type Driver = {
  name: string
  start: () => Promise<void>
  stop: () => void
  mod: (p: string, body?: unknown) => Promise<{ status: number; body: any }>
  ext: (p: string, body: unknown, origin?: string) => Promise<{ status: number; body: any }>
  spawnDuplicate?: () => Promise<number | null>
}

function nodeDriver(): Driver {
  const SOCK = path.join(os.tmpdir(), `claude-safari-bridge-test-${process.pid}.sock`)
  const PORT = 47900 + (process.pid % 40)
  let child: ChildProcess
  return {
    name: 'node bridge',
    start: () => new Promise<void>((resolve, reject) => {
      child = spawn('node', [BRIDGE_MJS, '--sock', SOCK, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout!.on('data', d => { if (String(d).includes('listening')) resolve() })
      child.stderr!.on('data', d => reject(new Error(String(d))))
    }),
    stop: () => child.kill(),
    mod: (p, body) => request({ socketPath: SOCK, path: p }, body),
    ext: (p, body, origin = 'safari-web-extension://TEST') => request({ host: '127.0.0.1', port: PORT, path: p }, body, { origin }),
    spawnDuplicate: () => new Promise(r => spawn('node', [BRIDGE_MJS, '--sock', SOCK, '--port', String(PORT + 1)]).on('exit', r)),
  }
}

function appDriver(): Driver {
  const PORT = 47950 + (process.pid % 40)
  let child: ChildProcess
  return {
    name: 'app bridge',
    start: async () => {
      child = spawn(APP_BIN, ['--port', String(PORT), '--token', TOKEN, '--background'], { stdio: 'ignore' })
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 150))
        try { const r = await request({ host: '127.0.0.1', port: PORT, path: '/status' }, undefined, { authorization: `Bearer ${TOKEN}` }); if (r.status === 200) return } catch {}
      }
      throw new Error('app bridge did not start')
    },
    stop: () => child.kill(),
    mod: (p, body) => request({ host: '127.0.0.1', port: PORT, path: p }, body, { authorization: `Bearer ${TOKEN}` }),
    ext: (p, body, origin = 'safari-web-extension://TEST') => request({ host: '127.0.0.1', port: PORT, path: p }, body, { origin }),
  }
}

function request(opts: { socketPath?: string; host?: string; port?: number; path: string }, body: unknown, extraHeaders: Record<string, string> = {}, contentType = 'application/json'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const headers: Record<string, string> = { ...extraHeaders }
    if (data !== undefined) { headers['content-type'] = contentType; headers['content-length'] = String(Buffer.byteLength(data)) }
    const req = http.request({ socketPath: opts.socketPath, host: opts.host, port: opts.port, path: opts.path, method: data !== undefined ? 'POST' : 'GET', headers }, res => {
      let text = ''; res.on('data', c => (text += c)); res.on('end', () => { try { resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }) } catch { resolve({ status: res.statusCode!, body: text }) } })
    })
    req.on('error', reject); if (data !== undefined) req.write(data); req.end()
  })
}

const drivers: Driver[] = [nodeDriver()]
if (existsSync(APP_BIN)) drivers.push(appDriver())

for (const d of drivers) {
  describe(d.name, () => {
    beforeAll(() => d.start())
    afterAll(() => d.stop())

    test('status reports no extension until one polls', async () => {
      const s = await d.mod('/status')
      expect(s.status).toBe(200)
      expect(s.body.extensionConnected).toBe(false)
      expect((await d.mod('/call', { name: 'ping' })).status).toBe(503)
    })

    test('relays a command to a polling extension and returns its result', async () => {
      const poll = d.ext('/ext/poll', { version: 'test', tabs: 1 })
      await new Promise(r => setTimeout(r, 80))
      const call = d.mod('/call', { name: 'ping', params: { x: 1 } })
      const cmd = (await poll).body
      expect(cmd.name).toBe('ping')
      expect(cmd.params).toEqual({ x: 1 })
      await d.ext('/ext/result', { id: cmd.id, result: { pong: true } })
      const out = await call
      expect(out.status).toBe(200)
      expect(out.body.result).toEqual({ pong: true })
      expect((await d.mod('/status')).body.extensionConnected).toBe(true)
    })

    test('an extension error comes back as 502 with its message', async () => {
      const poll = d.ext('/ext/poll', { version: 'test', tabs: 1 })
      await new Promise(r => setTimeout(r, 80))
      const call = d.mod('/call', { name: 'page' })
      const cmd = (await poll).body
      await d.ext('/ext/result', { id: cmd.id, error: 'No tab 9' })
      const out = await call
      expect(out.status).toBe(502)
      expect(out.body.error).toBe('No tab 9')
    })

    test('a command queued before the poll is delivered on the next poll', async () => {
      const call = d.mod('/call', { name: 'tabs.list' })
      await new Promise(r => setTimeout(r, 80))
      const cmd = (await d.ext('/ext/poll', { version: 'test', tabs: 1 })).body
      expect(cmd.name).toBe('tabs.list')
      await d.ext('/ext/result', { id: cmd.id, result: [] })
      expect((await call).body.result).toEqual([])
    })

    test('times out when the extension never answers', async () => {
      const call = d.mod('/call', { name: 'slow', timeoutMs: 1000 })
      await new Promise(r => setTimeout(r, 80))
      await d.ext('/ext/poll', { version: 'test', tabs: 1 })
      const out = await call
      expect(out.status).toBe(502)
      expect(out.body.error).toContain('did not answer')
    })

    test('a web page cannot pose as the extension', async () => {
      const r1 = await request({ host: '127.0.0.1', port: portOf(d), path: '/ext/poll' }, '{"version":"evil"}', { origin: 'http://127.0.0.1:48610' }, 'text/plain').catch(() => ({ status: 0 }))
      expect(r1.status === 403 || r1.status === 0).toBe(true)
      const r2 = await d.ext('/ext/poll', {}, '').catch(() => ({ status: 0 }))
      expect(r2.status === 403 || r2.status === 0).toBe(true)
    })

    test('a timed-out command is not handed to a later poll', async () => {
      const call = d.mod('/call', { name: 'late', timeoutMs: 1000 })
      await new Promise(r => setTimeout(r, 80))
      const first = await d.ext('/ext/poll', { version: 'test', tabs: 1 })
      expect(first.body.name).toBe('late')
      await call
      const next = d.mod('/call', { name: 'fresh' })
      await new Promise(r => setTimeout(r, 80))
      const second = await d.ext('/ext/poll', { version: 'test', tabs: 1 })
      expect(second.body.name).toBe('fresh')
      await d.ext('/ext/result', { id: second.body.id, result: 1 })
      await next
    })

    test('a command nobody fetches within the pickup window answers 503', async () => {
      const t0 = Date.now()
      const out = await d.mod('/call', { name: 'orphan' })
      expect(out.status).toBe(503)
      expect(Date.now() - t0).toBeLessThan(9500)
      expect((await d.mod('/status')).body.extensionConnected).toBe(false)
    }, 15000)

    test('commands go to the extension copy that can reach the page', async () => {
      void d.ext('/ext/poll', { version: 'old' }, 'safari-web-extension://STALE').catch(() => {})
      void d.ext('/ext/poll', { version: 'new', tabs: 2, reach: 1 }, 'safari-web-extension://LIVE').then(async cmd => {
        if (cmd.body && cmd.body.id) await d.ext('/ext/result', { id: cmd.body.id, result: 'from live' }, 'safari-web-extension://LIVE')
      }).catch(() => {})
      await new Promise(r => setTimeout(r, 120))
      const out = await d.mod('/call', { name: 'ping' })
      expect(out.body.result).toBe('from live')
      expect((await d.mod('/status')).body.primary).toBe('safari-web-extension://LIVE')
    }, 10000)

    if (d.spawnDuplicate) {
      test('a second bridge on the same socket refuses to start', async () => {
        expect(await d.spawnDuplicate!()).toBe(3)
      })
    }
  })
}

function portOf(d: Driver): number {
  // Both drivers expose the extension listener on a loopback port derived the same way.
  return d.name === 'node bridge' ? 47900 + (process.pid % 40) : 47950 + (process.pid % 40)
}
