// Drives the real tools against Safari through a minimal fake engine.
// Usage: bun tests/live.ts <tool> '<json input>'
import { spawn } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'

import { register } from '../hooks/register'

const hooks = new Map<string, (...a: any[]) => any>()
const commands = new Map<string, (...a: any[]) => any>()
const specs: any[] = []
const on = (event: string, matcher: any, hook?: any) => {
  if (typeof matcher === 'function') hook = matcher
  if (event === 'session.start') void hook($, {}, async (e: any) => e)
  else if (event === 'command.run') commands.set(matcher.command, hook)
  else hooks.set(matcher.tool, hook)
}
const $ = {
  plugin: { name: 'safari', root: process.cwd() },
  tool: { register: async (s: any) => { specs.push(s); return { tool: `mcp__safari__${s.name}` } } },
  command: { register: async () => ({ command: 'safari' }) },
  ui: { status: () => {} },
  fs: {
    read: async (p: string, o?: any) => (o && o.as === 'bytes' ? { base64: (await readFile(p)).toString('base64') } : (await readFile(p)).toString('utf8')),
    write: async (p: string, t: string) => { await writeFile(p, t) },
    stat: async (p: string) => { const s = await stat(p); return { size: s.size } },
  },
  env: { get: async (n: string) => process.env[n] },
  clock: { after: (ms: number, fn: () => void) => setTimeout(fn, ms) },
  http: {
    fetch: (url: string, init: any = {}) => new Promise((resolve, reject) => {
      const u = new URL(url)
      const req = http.request({ socketPath: init.socketPath, host: init.socketPath ? undefined : u.hostname, port: init.socketPath ? undefined : u.port, path: u.pathname + u.search, method: init.method ?? 'GET', headers: init.headers ?? {} }, res => {
        let text = ''; res.on('data', d => (text += d)); res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode! < 300, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), String(v)])), text }))
      })
      req.on('error', reject); if (init.body) req.write(init.body); req.end()
    }),
  },
  process: {
    spawn: (r: any) => {
      const child = spawn(r.argv[0], r.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      child.unref()
      return (async function* () { for await (const d of child.stdout!) yield { stream: 'stdout', text: String(d) } })()
    },
    run: (argv: string[], init: any = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        child.stdout.on('data', d => (stdout += d)); child.stderr.on('data', d => (stderr += d))
        const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, init.timeoutMs ?? 30000)
        child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }) })
        if (init.stdin) child.stdin.write(init.stdin); child.stdin.end()
      }),
  },
} as any
register(on as any, {} as any)
await new Promise(r => setTimeout(r, 50))

const [tool, json] = process.argv.slice(2)
if (!tool) { console.log(specs.map(s => s.name).join(', ')); process.exit(0) }
if (tool.startsWith('/')) { const c = commands.get(tool.slice(1))!; console.log((await c($, { args: json ?? '' })).text); process.exit(0) }
const hook = hooks.get(`mcp__safari__${tool}`)
if (!hook) { console.error('no such tool'); process.exit(1) }
const res = await hook($, { tool: `mcp__safari__${tool}`, tool_use_id: 'x', ...(json ? JSON.parse(json) : {}) })
if (res.deny !== undefined) { console.log(res.deny); console.log('(isError)'); process.exit(2) }
for (const b of res.result) console.log(b.type === 'text' ? b.text : `[image ${Math.round(b.source.data.length * 3 / 4 / 1024)} KB]`)
