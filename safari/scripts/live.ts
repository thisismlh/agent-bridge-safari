// Drives the real tools against Safari through a minimal fake engine.
// Usage: bun tests/live.ts <tool> '<json input>'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

import { register } from '../hooks/register'

const hooks = new Map<string, (...a: any[]) => any>()
const specs: any[] = []
const on = (event: string, matcher: any, hook?: any) => {
  if (typeof matcher === 'function') hook = matcher
  if (event === 'session.start') void hook($, {}, async (e: any) => e)
  else hooks.set(matcher.tool, hook)
}
const $ = {
  plugin: { name: 'safari', root: process.cwd() },
  tool: { register: async (s: any) => { specs.push(s); return { tool: `mcp__safari__${s.name}` } } },
  fs: { read: async (p: string) => ({ base64: (await readFile(p)).toString('base64') }) },
  process: {
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
const hook = hooks.get(`mcp__safari__${tool}`)
if (!hook) { console.error('no such tool'); process.exit(1) }
const res = await hook($, { tool: `mcp__safari__${tool}`, tool_use_id: 'x', ...(json ? JSON.parse(json) : {}) })
for (const b of res.result.content) console.log(b.type === 'text' ? b.text : `[image ${Math.round(b.data.length * 3 / 4 / 1024)} KB]`)
if (res.result.isError) { console.log('(isError)'); process.exit(2) }
