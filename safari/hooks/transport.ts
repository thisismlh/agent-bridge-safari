// Chooses how to reach Safari: the extension through the local bridge when it is
// connected, AppleScript otherwise. Tools call `page`, `command` and the tab helpers
// here and never care which transport answered.

import { parseTabId, type TabSpec } from './format'
import type { Io } from './io'
import { runInPage, SafariError } from './safari'

export type Transport = 'extension' | 'applescript'
export type BridgeStatus = { running: boolean; connected: boolean; extensionVersion?: string | null; pid?: number; error?: string; host?: 'app' | 'node' }

let bridgeStarted = false
let nodeBinary: string | null = null
export let lastStartError: string | null = null

export const APP_BUNDLE_ID = 'com.michaelhelms.agent-bridge-safari'

/** Where the bridge is: the app's loopback port with its token, or the Node bridge's socket. */
export type AppTarget = { kind: 'app'; url: string; token: string }
export type BridgeTarget = AppTarget | { kind: 'node'; socketPath: string }

export async function bridgeSocket(io: Io): Promise<string> {
  const home = (await io.home()) ?? '/tmp'
  return `${home}/.claude/safari-bridge.sock`
}

// The app is sandboxed and macOS keeps other processes out of its container, so the mod
// hands the app a token of its own through the agentbridge:// URL scheme and finds the
// port by scanning a short range for the X-Claude-Bridge header.
export const APP_PORTS = Array.from({ length: 10 }, (_, i) => 47831 + i)
let sessionToken: string | null = null
function pairingToken(): string {
  if (!sessionToken) sessionToken = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
  return sessionToken
}

async function pairWithApp(io: Io): Promise<void> {
  await io.run(['open', '-g', `agentbridge://pair?token=${pairingToken()}`], { timeoutMs: 15_000 })
}

/** Scans the port range for an app bridge that accepts this session's token (pairing once if it refuses). */
async function appTarget(io: Io, pair = true): Promise<AppTarget | null> {
  for (const port of APP_PORTS) {
    const url = `http://127.0.0.1:${port}`
    try {
      const r = await io.fetch(`${url}/status`, { headers: { authorization: `Bearer ${pairingToken()}` } })
      if (r.headers['x-claude-bridge'] !== '1') continue
      if (r.ok) return { kind: 'app', url, token: pairingToken() }
      if (r.status === 403 && pair) {
        await pairWithApp(io)
        for (let i = 0; i < 8; i++) {
          await io.after(250)
          const again = await io.fetch(`${url}/status`, { headers: { authorization: `Bearer ${pairingToken()}` } })
          if (again.ok) return { kind: 'app', url, token: pairingToken() }
        }
      }
    } catch {
      /* nothing on this port */
    }
  }
  return null
}

let target: BridgeTarget | null = null

async function fetchBridge(io: Io, t: BridgeTarget, path: string, init: { method?: string; body?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (t.kind === 'app') {
    headers.authorization = `Bearer ${t.token}`
    return io.fetch(`${t.url}${path}`, { ...init, headers })
  }
  return io.fetch(`http://bridge${path}`, { ...init, headers, socketPath: t.socketPath })
}

async function statusOf(io: Io, t: BridgeTarget): Promise<BridgeStatus | null> {
  try {
    const r = await fetchBridge(io, t, '/status')
    if (!r.ok) return null
    const s = JSON.parse(r.text) as { extensionConnected: boolean; extensionVersion: string | null; pid: number }
    return { running: true, connected: !!s.extensionConnected, extensionVersion: s.extensionVersion, pid: s.pid, host: t.kind }
  } catch {
    return null
  }
}

/** Finds a live bridge: the app first, then the Node bridge. Remembers the one that answered. */
export async function bridgeStatus(io: Io): Promise<BridgeStatus> {
  const cur = target
  const candidates: BridgeTarget[] = []
  if (cur) candidates.push(cur)
  const app = await appTarget(io)
  if (app && !(cur && cur.kind === 'app' && cur.url === app.url)) candidates.push(app)
  const node: BridgeTarget = { kind: 'node', socketPath: await bridgeSocket(io) }
  if (!(cur && cur.kind === 'node')) candidates.push(node)
  for (const c of candidates) {
    const s = await statusOf(io, c)
    if (s) { target = c; return s }
  }
  target = null
  return { running: false, connected: false }
}

async function findNode(io: Io): Promise<string> {
  if (nodeBinary) return nodeBinary
  // A login shell sees nvm, Homebrew and friends; the host process may not.
  const ran = await io.run(['/bin/zsh', '-lc', 'command -v node || command -v bun'], { timeoutMs: 15_000 })
  const found = ran.stdout.trim().split('\n').pop()?.trim()
  if (!found) throw new SafariError('The Safari bridge needs node or bun on your PATH, and neither was found.')
  nodeBinary = found
  return found
}

/** Starts the bridge daemon if nothing answers on the socket. Resolves once it answers or after 3 s. */
export async function ensureBridge(io: Io): Promise<BridgeStatus> {
  const first = await bridgeStatus(io)
  if (first.running) return first
  if (!bridgeStarted) {
    bridgeStarted = true
    // The app hosts the bridge when it is installed: launch it hidden and wait for its discovery file.
    const launched = await io.run(['open', '-g', '-b', APP_BUNDLE_ID, '--args', '--background'], { timeoutMs: 15_000 })
    if (launched.exitCode === 0) {
      await io.after(1500)
      await pairWithApp(io)
      for (let i = 0; i < 16; i++) {
        await io.after(250)
        const s = await bridgeStatus(io)
        if (s.running) { bridgeStarted = false; return s }
      }
    }
    try {
      const node = await findNode(io)
      const script = `${io.pluginRoot}/bridge/bridge.mjs`
      const stream = io.spawn([node, script, '--sock', await bridgeSocket(io)])
      void (async () => {
        try {
          for await (const _piece of stream) {
            /* drain until the child ends */
          }
        } catch {
          /* the child ended; the next ensure respawns it */
        } finally {
          bridgeStarted = false
        }
      })()
    } catch (err) {
      // No node or bun: the AppleScript transport still works, so fall back quietly.
      bridgeStarted = false
      lastStartError = err instanceof Error ? err.message : String(err)
      return { running: false, connected: false, error: lastStartError }
    }
  }
  for (let i = 0; i < 12; i++) {
    await io.after(250)
    const s = await bridgeStatus(io)
    if (s.running) return s
  }
  return { running: false, connected: false }
}

export async function command<T>(io: Io, name: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  if (!target) await bridgeStatus(io)
  const t = target
  if (!t) throw new SafariError('The Safari bridge is not running. Run /safari start, or call tabs_context to use AppleScript tab ids.')
  let r
  try {
    r = await fetchBridge(io, t, '/call', { method: 'POST', body: JSON.stringify({ name, params, timeoutMs }) })
  } catch {
    target = null
    throw new SafariError('The Safari bridge is not running. Run /safari start, or call tabs_context to use AppleScript tab ids.')
  }
  let parsed: { result?: T; error?: string }
  try { parsed = JSON.parse(r.text) } catch { throw new SafariError(`Bridge answered ${r.status} with no JSON.`) }
  if (parsed.error !== undefined) throw new SafariError(parsed.error)
  if (parsed.result === undefined) throw new SafariError(`Safari returned no result for ${name}; try again.`)
  return parsed.result as T
}

/** Which transport a tab id selects: "window:index" is AppleScript, a number is the extension. */
export function transportFor(tabId: unknown, connected: boolean): Transport {
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    return /^\d+:\d+$/.test(String(tabId)) ? 'applescript' : 'extension'
  }
  return connected ? 'extension' : 'applescript'
}

export async function pickTransport(io: Io, tabId: unknown): Promise<Transport> {
  const s = await ensureBridge(io)
  const t = transportFor(tabId, s.connected)
  if (t === 'extension' && !s.connected) {
    throw new SafariError(`Tab ${String(tabId)} belongs to the Safari extension, which is not connected. Run /safari, or call tabs_context for current tab ids.`)
  }
  return t
}

/** Calls one page runtime function in a tab through whichever transport fits. */
export async function page<T>(io: Io, tabId: unknown, fn: string, args: unknown): Promise<T> {
  const t = await pickTransport(io, tabId)
  if (t === 'extension') return command<T>(io, 'page', { tabId: tabId === '' ? undefined : tabId, fn, args })
  const spec: TabSpec = parseTabId(tabId)
  return runInPage<T>(io, spec, fn, args)
}
