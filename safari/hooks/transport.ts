// Chooses how to reach Safari: the extension through the local bridge when it is
// connected, AppleScript otherwise. Tools call `page`, `command` and the tab helpers
// here and never care which transport answered.

import { parseTabId, type TabSpec } from './format'
import type { Io } from './io'
import { runInPage, SafariError } from './safari'

export type Transport = 'extension' | 'applescript'
export type BridgeStatus = { running: boolean; connected: boolean; extensionVersion?: string | null; pid?: number; error?: string }

let bridgeStarted = false
let nodeBinary: string | null = null
export let lastStartError: string | null = null

export async function bridgeSocket(io: Io): Promise<string> {
  const home = (await io.home()) ?? '/tmp'
  return `${home}/.claude/safari-bridge.sock`
}

export async function bridgeStatus(io: Io): Promise<BridgeStatus> {
  try {
    const r = await io.fetch('http://bridge/status', { socketPath: await bridgeSocket(io) })
    if (!r.ok) return { running: false, connected: false }
    const s = JSON.parse(r.text) as { extensionConnected: boolean; extensionVersion: string | null; pid: number }
    return { running: true, connected: !!s.extensionConnected, extensionVersion: s.extensionVersion, pid: s.pid }
  } catch {
    return { running: false, connected: false }
  }
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
  let r
  try {
    r = await io.fetch('http://bridge/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, params, timeoutMs }),
      socketPath: await bridgeSocket(io),
    })
  } catch {
    throw new SafariError('The Safari bridge is not running. Run /safari start, or call tabs_context to use AppleScript tab ids.')
  }
  let parsed: { result?: T; error?: string }
  try { parsed = JSON.parse(r.text) } catch { throw new SafariError(`Bridge answered ${r.status} with no JSON.`) }
  if (parsed.error !== undefined) throw new SafariError(parsed.error)
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
