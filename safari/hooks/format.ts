// Pure helpers, unit tested, no engine access.

export type TabSpec = { windowId: number; tabIndex: number } | null

/** Parses "4752:2" into a window id and a 1-based tab index; empty means the current tab. */
export function parseTabId(id: unknown): TabSpec {
  if (id === undefined || id === null || id === '') return null
  const m = /^(\d+):(\d+)$/.exec(String(id).trim())
  if (!m) throw new Error(`Bad tabId ${JSON.stringify(id)}: expected "<windowId>:<tabIndex>" from tabs_context.`)
  return { windowId: Number(m[1]), tabIndex: Number(m[2]) }
}

export type TabRow = { tabId: string; url: string; title: string; active: boolean }

export function formatTabs(windows: { windowId: number; tabs: TabRow[] }[]): string {
  if (windows.length === 0) return 'Safari has no windows open. Use tabs_create or navigate.'
  return windows
    .map(w => [`Window ${w.windowId}:`, ...w.tabs.map(t => `  ${t.active ? '*' : ' '} ${t.tabId}  ${t.title || '(untitled)'}  ${t.url}`)].join('\n'))
    .join('\n')
}

export function formatTree(page: { url: string; title: string; lines: string[] }, maxChars: number): string {
  const head = `${page.title || '(untitled)'} — ${page.url}\n`
  let body = page.lines.join('\n')
  if (head.length + body.length > maxChars) {
    body = body.slice(0, Math.max(0, maxChars - head.length - 60)) + `\n… truncated; pass a larger max_chars or a ref to narrow the tree.`
  }
  return head + (body || '(no visible elements)')
}

export function formatFind(rows: { ref: string; role: string; name: string; value?: string; href?: string }[]): string {
  if (rows.length === 0) return 'No matching elements.'
  return rows
    .map(r => `${r.ref}  ${r.role}${r.name ? ' ' + JSON.stringify(r.name) : ''}${r.value ? ' value=' + JSON.stringify(r.value) : ''}${r.href ? ' ' + r.href : ''}`)
    .join('\n')
}

/** macOS virtual key codes for keys `keystroke` cannot type. */
const KEY_CODES: Record<string, number> = {
  return: 36, enter: 76, tab: 48, space: 49, backspace: 51, delete: 117, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
}
const MODS: Record<string, string> = { cmd: 'command down', meta: 'command down', command: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' }

export type KeyPress = { modifiers: string[]; keyCode?: number; char?: string }

/** Parses one chord like "cmd+shift+a", "Return" or "x" into what System Events needs. */
export function parseKey(chord: string): KeyPress {
  const parts = chord.trim().split('+').filter(Boolean)
  if (parts.length === 0) throw new Error('Empty key.')
  const key = parts[parts.length - 1]!
  const modifiers = parts.slice(0, -1).map(m => {
    const mod = MODS[m.toLowerCase()]
    if (!mod) throw new Error(`Unknown modifier ${JSON.stringify(m)}; use cmd, ctrl, alt or shift.`)
    return mod
  })
  const code = KEY_CODES[key.toLowerCase()]
  if (code !== undefined) return { modifiers, keyCode: code }
  if (key.length === 1) return { modifiers, char: key }
  throw new Error(`Unknown key ${JSON.stringify(key)}. Use a single character or one of: ${Object.keys(KEY_CODES).join(', ')}.`)
}

export function parseKeys(text: string): KeyPress[] {
  return text.trim().split(/\s+/).filter(Boolean).map(parseKey)
}

/** Turns a bridge error message into the one sentence the model should read. */
export function explainSafariError(message: string): string {
  if (/Allow JavaScript from Apple Events/i.test(message)) {
    return 'Safari is blocking JavaScript from Apple Events. In Safari: Settings > Advanced > turn on "Show features for web developers", then menu bar Develop > "Allow JavaScript from Apple Events". Then retry.'
  }
  if (/not allowed assistive access|osascript is not allowed|-1719.*System Events|-25211/i.test(message)) {
    return 'macOS is blocking keyboard control. Open System Settings > Privacy & Security > Accessibility and allow the app running Claude Code (and osascript), then retry.'
  }
  if (/Not authorized to send Apple events|-1743/i.test(message)) {
    return 'macOS is blocking Automation of Safari. Open System Settings > Privacy & Security > Automation and allow the app running Claude Code to control Safari, then retry.'
  }
  if (/Invalid index|Can.t get window|Can.t get tab|-1719|-1728/.test(message)) {
    return 'That window or tab no longer exists. Call tabs_context for current tab ids.'
  }
  return message.replace(/^\d+:\d+: execution error: /, '').replace(/ \(-?\d+\)$/, '')
}
