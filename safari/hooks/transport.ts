// Chooses how to reach Safari: the extension through the local bridge when it is
// connected, AppleScript otherwise. Tools call `page`, `command` and the tab helpers
// here and never care which transport answered.

import type { EngineInterface } from 'claude-code'

import { parseTabId, type TabSpec } from './format'
import { runInPage, SafariError } from './safari'

export type Transport = 'extension' | 'applescript'
export type BridgeStatus = { running: boolean; connected: boolean; extensionVersion?: string | null; pid?: number }

let bridgeStarted = false
let nodeBinary: string | null = null

export async function bridgeSocket($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  return `${home}/.claude/safari-bridge.sock`
}

export async function bridgeStatus($: EngineInterface): Promise<BridgeStatus> {
  try {
    const r = await $.http.fetch('http://bridge/status', { socketPath: await bridgeSocket($) })
    if (!r.ok) return { running: false, connected: false }
    const s = JSON.parse(r.text) as { extensionConnected: boolean; extensionVersion: string | null; pid: number }
    return { running: true, connected: !!s.extensionConnected, extensionVersion: s.extensionVersion, pid: s.pid }
  } catch {
    return { running: false, connected: false }
  }
}

async function findNode($: EngineInterface): Promise<string> {
  if (nodeBinary) return nodeBinary
  // A login shell sees nvm, Homebrew and friends; the host process may not.
  const ran = await $.process.run(['/bin/zsh', '-lc', 'command -v node || command -v bun'], { timeoutMs: 15_000 })
  const found = ran.stdout.trim().split('\n').pop()?.trim()
  if (!found) throw new SafariError('The Safari bridge needs node or bun on your PATH, and neither was found.')
  nodeBinary = found
  return found
}

/** Starts the bridge daemon if nothing answers on the socket. Resolves once it answers or after 3 s. */
export async function ensureBridge($: EngineInterface): Promise<BridgeStatus> {
  const first = await bridgeStatus($)
  if (first.running) return first
  if (!bridgeStarted) {
    bridgeStarted = true
    const node = await findNode($)
    const script = `${$.plugin.root}/bridge/bridge.mjs`
    const stream = $.process.spawn({ argv: [node, script, '--sock', await bridgeSocket($)] })
    void (async () => {
      try {
        for await (const piece of stream) {
          if ('text' in piece && /listening|already running/.test(piece.text)) continue
        }
      } catch {
        /* the child ended; the next ensure respawns it */
      } finally {
        bridgeStarted = false
      }
    })()
  }
  for (let i = 0; i < 12; i++) {
    await new Promise<void>(r => $.clock.after(250, () => r()))
    const s = await bridgeStatus($)
    if (s.running) return s
  }
  return { running: false, connected: false }
}

export async function command<T>($: EngineInterface, name: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  const r = await $.http.fetch('http://bridge/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, params, timeoutMs }),
    socketPath: await bridgeSocket($),
  })
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

export async function pickTransport($: EngineInterface, tabId: unknown): Promise<Transport> {
  const t = transportFor(tabId, false)
  if (t === 'extension' && tabId !== undefined && tabId !== null && tabId !== '') return 'extension'
  const s = await ensureBridge($)
  return transportFor(tabId, s.connected)
}

/** Calls one page runtime function in a tab through whichever transport fits. */
export async function page<T>($: EngineInterface, tabId: unknown, fn: string, args: unknown): Promise<T> {
  const t = await pickTransport($, tabId)
  if (t === 'extension') return command<T>($, 'page', { tabId: tabId === '' ? undefined : tabId, fn, args })
  const spec: TabSpec = parseTabId(tabId)
  return runInPage<T>($, spec, fn, args)
}
