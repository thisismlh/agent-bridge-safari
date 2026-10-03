import type { EngineInterface, Register, ToolSpec } from 'claude-code'

import { formatFind, formatTabs, formatTree, parseKeys, parseTabId, type TabRow } from './format'
import type { Io } from './io'
import { ensureSafari, runJxa, SafariError } from './safari'
import { bridgeStatus, command, ensureBridge, page, pickTransport } from './transport'

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }
type Answer = { result: { content: Block[]; isError: boolean } }

const ok = (text: string, extra: Block[] = []): Answer => ({ result: { content: [{ type: 'text', text }, ...extra], isError: false } })
const fail = (text: string): Answer => ({ result: { content: [{ type: 'text', text }], isError: true } })

const TAB = { tabId: { type: 'string', description: 'Tab id from tabs_context. Omit for the current tab of the front window.' } }
const REF = { ref: { type: 'string', description: 'Element ref such as "ref_12" from read_page or find.' } }

type Handler = (io: Io, input: Record<string, unknown>) => Promise<Answer>

/** Everything the helpers may do, as closures over the engine object of this hook call. */
function makeIo($: EngineInterface): Io {
  return {
    pluginRoot: $.plugin.root,
    run: (argv, init) => $.process.run(argv, init),
    spawn: argv => $.process.spawn({ argv }),
    fetch: (url, init) => $.http.fetch(url, init),
    home: () => $.env.get('HOME'),
    readBytes: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
    writeText: (path, text) => $.fs.write(path, text),
    fileSize: async path => (await $.fs.stat(path)).size,
    after: ms => new Promise<void>(resolve => $.clock.after(ms, () => resolve())),
  }
}
type Geometry = { innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number; dpr: number; scrollX: number; scrollY: number }

const SETUP = [
  'To connect the Safari extension:',
  '1. Open the built app once: the mod can do this with /safari install.',
  '2. Safari > Settings > Extensions > turn on "Claude Code for Safari" and allow it on every website.',
  '3. If the app was not signed with your Apple ID, also tick Develop > "Allow unsigned extensions" (resets when Safari restarts).',
  'Until then the AppleScript fallback is used, which needs Develop > "Allow JavaScript from Apple Events".',
].join('\n')

const normaliseUrl = (input: unknown): string | undefined => {
  if (input === undefined || input === null || String(input).trim() === '') return undefined
  const s = String(input).trim()
  if (/^(https?|file|about):/i.test(s)) return s
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(s) || /^localhost(:\d+)?(\/|$)/.test(s)) return `https://${s}`
  return undefined
}

async function appleScreenshot(io: Io, tabId: unknown, scale: number): Promise<Answer> {
  const tab = parseTabId(tabId)
  const info = await runJxa<{ windowId: number; geom: Geometry | null; bounds: { x: number; y: number; w: number; h: number } }>(io, tab, `
    var w = targetWindow(); var t = targetTab(); w.currentTab = t;
    var geom = null;
    try { geom = JSON.parse(pageJs(t, ${JSON.stringify(PAGE_GEOMETRY)})); } catch (e) { if (!/Allow JavaScript/.test(String(e))) throw e; }
    sleep(0.2);
    var b = w.bounds();
    return { windowId: w.id(), geom: geom, bounds: { x: b.x, y: b.y, w: b.width, h: b.height } };`)
  const path = `${(await io.home()) ?? '/tmp'}/.claude/safari-shot-${Date.now()}.png`
  try {
    const g = info.geom
    let note = ''
    const byWindow = await io.run(['screencapture', '-x', '-o', '-l', String(info.windowId), path], { timeoutMs: 15_000 })
    if (byWindow.exitCode === 0 && g) {
      const top = Math.round((g.outerHeight - g.innerHeight) * g.dpr)
      const left = Math.round(((g.outerWidth - g.innerWidth) * g.dpr) / 2)
      await io.run(['sips', '--cropOffset', String(top), String(left), '-c', String(Math.round(g.innerHeight * g.dpr)), String(Math.round(g.innerWidth * g.dpr)), path], { timeoutMs: 15_000 })
    } else if (byWindow.exitCode !== 0) {
      const b = info.bounds
      const x = b.x + (g ? (g.outerWidth - g.innerWidth) / 2 : 0)
      const y = b.y + (g ? g.outerHeight - g.innerHeight : 0)
      const w = g ? g.innerWidth : b.w, h = g ? g.innerHeight : b.h
      await runJxa(io, tab, `var w = targetWindow(); w.index = 1; Safari.activate(); sleep(0.4); return true;`)
      const byRect = await io.run(['screencapture', '-x', '-R', `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`, path], { timeoutMs: 15_000 })
      if (byRect.exitCode !== 0) return fail('Screenshots without the extension need Screen Recording permission: System Settings > Privacy & Security > Screen Recording, allow the app running Claude Code, then restart it. Or connect the extension (/safari).')
      note = 'Captured from the screen, so Safari was brought to the front. '
    }
    if (g) {
      await io.run(['sips', '-z', String(Math.round(g.innerHeight * scale)), String(Math.round(g.innerWidth * scale)), path], { timeoutMs: 15_000 })
      note += `Viewport ${g.innerWidth}×${g.innerHeight} CSS px; coordinates in that frame${scale < 1 ? ` (image shown at ${scale}×)` : ''}. Scrolled to (${g.scrollX}, ${g.scrollY}).`
    } else {
      note += 'Whole window captured (viewport crop needs "Allow JavaScript from Apple Events"); coordinates are not viewport-aligned.'
    }
    const base64 = await io.readBytes(path)
    return ok(note, [{ type: 'image', data: base64, mimeType: 'image/png' }])
  } finally {
    void io.run(['rm', '-f', path], { timeoutMs: 5_000 })
  }
}

const PAGE_GEOMETRY = `JSON.stringify({ innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) })`

const TOOLS: (ToolSpec & { run: Handler })[] = [
  {
    name: 'tabs_context',
    description: 'List Safari windows and tabs with tabId, url, title and which tab is active. Also reports whether the Safari extension is connected. Opens Safari if needed.',
    inputSchema: { type: 'object', properties: {} },
    run: async io => {
      await ensureSafari(io)
      const bridge = await ensureBridge(io)
      if (bridge.connected) {
        const tabs = await command<{ tabId: number; windowId: number; index: number; url: string; title: string; active: boolean }[]>(io, 'tabs.list')
        const byWindow = new Map<number, TabRow[]>()
        for (const t of tabs) {
          const list = byWindow.get(t.windowId) ?? []
          list.push({ tabId: String(t.tabId), url: t.url, title: t.title, active: t.active })
          byWindow.set(t.windowId, list)
        }
        const windows = [...byWindow.entries()].map(([windowId, rows]) => ({ windowId, tabs: rows }))
        return ok(`Transport: Safari extension (connected).\n${formatTabs(windows)}`)
      }
      const windows = await runJxa<{ windowId: number; tabs: TabRow[] }[]>(io, null, `
        return Safari.windows().map(function (w) {
          var cur = w.currentTab(); var curIdx = cur ? cur.index() : -1;
          return { windowId: w.id(), tabs: w.tabs().map(function (t) { return { tabId: tabIdOf(w, t), url: t.url() || '', title: t.name() || '', active: t.index() === curIdx }; }) };
        });`)
      return ok(`Transport: AppleScript (extension not connected; run /safari for setup).\n${formatTabs(windows)}`)
    },
  },
  {
    name: 'tabs_create',
    description: 'Open a new Safari tab, optionally at a URL, and make it current. Returns its tabId.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to load; "about:blank" when omitted.' } } },
    run: async (io, { url }) => {
      await ensureSafari(io)
      const u = normaliseUrl(url) ?? 'about:blank'
      if ((await ensureBridge(io)).connected) {
        const r = await command<{ tabId: number; url: string; title: string }>(io, 'tabs.create', { url: u })
        return ok(`Opened tab ${r.tabId}: ${r.title || '(untitled)'}  ${r.url}`)
      }
      const r = await runJxa<{ tabId: string; url: string; title: string }>(io, null, `
        var ws = Safari.windows(); var w, t;
        if (!ws.length) { Safari.documents.push(Safari.Document({ url: ${JSON.stringify(u)} })); w = Safari.windows()[0]; t = w.currentTab(); }
        else { w = ws[0]; t = Safari.Tab({ url: ${JSON.stringify(u)} }); w.tabs.push(t); w.currentTab = t; t = w.currentTab(); }
        waitReady(t, 20);
        return { tabId: tabIdOf(w, t), url: t.url() || '', title: t.name() || '' };`)
      return ok(`Opened tab ${r.tabId}: ${r.title || '(untitled)'}  ${r.url}`)
    },
  },
  {
    name: 'tabs_close',
    description: 'Close one Safari tab by tabId.',
    inputSchema: { type: 'object', properties: { ...TAB }, required: ['tabId'] },
    run: async (io, { tabId }) => {
      if ((await pickTransport(io, tabId)) === 'extension') {
        await command(io, 'tabs.close', { tabId })
        return ok(`Closed tab ${tabId}.`)
      }
      await runJxa(io, parseTabId(tabId), `var t = targetTab(); t.close(); return true;`)
      return ok(`Closed ${tabId}. Tab indexes in that window may have shifted; call tabs_context before using another tabId there.`)
    },
  },
  {
    name: 'navigate',
    description: 'Load a URL in a Safari tab, or go "back", "forward" or "reload". Waits for the page to finish loading. Opens Safari and a window if needed.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'A URL, or "back", "forward", "reload".' }, ...TAB }, required: ['url'] },
    run: async (io, { url, tabId }) => {
      await ensureSafari(io)
      const target = String(url).trim()
      const isNav = target === 'back' || target === 'forward' || target === 'reload'
      const u = isNav ? target : normaliseUrl(target)
      if (!u) return fail(`Not a URL: ${target}`)
      if ((await pickTransport(io, tabId)) === 'extension') {
        const r = await command<{ tabId: number; url: string; title: string; ready: boolean }>(io, 'navigate', { tabId, url: u })
        return ok(`${r.title || '(untitled)'}  ${r.url}${r.ready ? '' : ' (still loading after 30 s)'} [tab ${r.tabId}]`)
      }
      const tab = parseTabId(tabId)
      const body = isNav
        ? `var t = targetTab(); pageJs(t, ${JSON.stringify(u === 'reload' ? 'location.reload()' : `history.${u}()`)}); var r = waitReady(t, 30);`
        : `var ws = Safari.windows(); var t;
           if (!ws.length && !spec) { Safari.documents.push(Safari.Document({ url: ${JSON.stringify(u)} })); t = Safari.windows()[0].currentTab(); }
           else { t = targetTab(); t.url = ${JSON.stringify(u)}; }
           var r = waitReady(t, 30);`
      const r = await runJxa<{ url: string; title: string; ready: boolean | null }>(io, tab, body + ` return { url: t.url() || '', title: t.name() || '', ready: r };`)
      const note = r.ready === false ? ' (still loading after 30 s)' : r.ready === null ? ' (load wait skipped: JavaScript from Apple Events is off)' : ''
      return ok(`${r.title || '(untitled)'}  ${r.url}${note}`)
    },
  },
  {
    name: 'read_page',
    description: 'Read the current page as an indented accessibility tree. Interactive elements carry a [ref_N] usable with click, type, form_input, scroll, hover and upload_file. Prefer this over screenshots for text and structure.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TAB,
        filter: { type: 'string', enum: ['all', 'interactive'], description: '"interactive" lists only clickable and typable elements. Default "all".' },
        ref: { type: 'string', description: 'Restrict the tree to this element and its descendants.' },
        max_chars: { type: 'number', description: 'Output limit, default 50000.' },
        depth: { type: 'number', description: 'Maximum tree depth, default 15.' },
      },
    },
    run: async (io, { tabId, filter, ref, max_chars, depth }) => {
      const p = await page<{ url: string; title: string; lines: string[] }>(io, tabId, 'tree', { filter: filter ?? 'all', ref, depth: depth ?? 15 })
      return ok(formatTree(p, Number(max_chars) || 50_000))
    },
  },
  {
    name: 'find',
    description: 'Search the page for elements whose role, name, value or href contains the query (case-insensitive). Returns up to 20 refs, interactive elements first.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...TAB }, required: ['query'] },
    run: async (io, { query, tabId }) => ok(formatFind(await page<Parameters<typeof formatFind>[0]>(io, tabId, 'find', String(query)))),
  },
  {
    name: 'get_page_text',
    description: 'Extract the visible text of the page (article or main content first, then the whole body).',
    inputSchema: { type: 'object', properties: { ...TAB, max_chars: { type: 'number', description: 'Default 50000.' } } },
    run: async (io, { tabId, max_chars }) => {
      const r = await page<{ url: string; title: string; text: string; truncated: boolean }>(io, tabId, 'pageText', Number(max_chars) || 50_000)
      return ok(`${r.title} — ${r.url}\n\n${r.text}${r.truncated ? '\n… truncated' : ''}`)
    },
  },
  {
    name: 'click',
    description: 'Click an element by ref, or a point in viewport CSS pixels (the screenshot coordinate frame). Scrolls the element into view first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REF, ...TAB, x: { type: 'number' }, y: { type: 'number' },
        count: { type: 'number', description: '1 (default), 2 for double-click, 3 for triple-click (selects text).' },
        button: { type: 'string', enum: ['left', 'right'] },
        modifiers: { type: 'string', description: 'e.g. "cmd", "shift", "cmd+shift".' },
      },
    },
    run: async (io, { ref, x, y, tabId, count, button, modifiers }) => {
      if (!ref && (x === undefined || y === undefined)) return fail('Pass a ref, or both x and y.')
      const r = await page<{ clicked: string; x: number; y: number; url: string }>(io, tabId, 'click', { ref, x, y, count, button, modifiers })
      return ok(`Clicked ${r.clicked} at (${r.x}, ${r.y}). Page: ${r.url}`)
    },
  },
  {
    name: 'hover',
    description: 'Move the pointer over an element by ref or by viewport coordinates, to reveal menus and tooltips.',
    inputSchema: { type: 'object', properties: { ...REF, ...TAB, x: { type: 'number' }, y: { type: 'number' } } },
    run: async (io, { ref, x, y, tabId }) => ok(`Hovering ${(await page<{ hovered: string }>(io, tabId, 'hover', { ref, x, y })).hovered}`),
  },
  {
    name: 'type',
    description: 'Type text into the focused element, or into the element given by ref. Fires the key and input events sites listen for. Use press_key for Enter, Tab or shortcuts.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...REF, ...TAB, replace: { type: 'boolean', description: 'Clear the field first.' } }, required: ['text'] },
    run: async (io, { text, ref, tabId, replace }) => {
      const r = await page<{ typed: number; into: string; value?: string }>(io, tabId, 'type', { text: String(text), ref, replace })
      return ok(`Typed ${r.typed} characters into ${r.into || 'the focused element'}${r.value !== undefined ? `; value is now ${JSON.stringify(r.value)}` : ''}`)
    },
  },
  {
    name: 'press_key',
    description: 'Press keys in Safari: "Return", "Tab", "Escape", "cmd+a", "shift+Tab", or several separated by spaces. Enter, Tab and Escape are sent to the page directly; other keys go through macOS and need Accessibility permission for the app running Claude Code.',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' }, ...TAB, repeat: { type: 'number', description: 'Times to repeat the sequence, default 1.' } }, required: ['keys'] },
    run: async (io, { keys, tabId, repeat }) => {
      const presses = parseKeys(String(keys))
      const times = Math.min(100, Math.max(1, Number(repeat) || 1))
      const synthetic = presses.every(p => p.modifiers.length === 0 && (p.keyCode === 36 || p.keyCode === 76 || p.keyCode === 48 || p.keyCode === 53))
      if (synthetic) {
        const names = presses.map(p => (p.keyCode === 48 ? 'Tab' : p.keyCode === 53 ? 'Escape' : 'Enter'))
        for (let i = 0; i < times; i++) for (const k of names) await page(io, tabId, 'pressKey', { key: k })
        return ok(`Pressed ${keys}${times > 1 ? ` ×${times}` : ''} in the page`)
      }
      const steps = presses
        .map(p => (p.keyCode !== undefined ? `SE.keyCode(${p.keyCode}, { using: ${JSON.stringify(p.modifiers)} });` : `SE.keystroke(${JSON.stringify(p.char)}, { using: ${JSON.stringify(p.modifiers)} });`))
        .join(' sleep(0.05); ')
      if ((await pickTransport(io, tabId)) === 'extension') await command(io, 'activate', { tabId })
      const spec = /^\d+:\d+$/.test(String(tabId ?? '')) ? parseTabId(tabId) : null
      await runJxa(io, spec, `
        var w = targetWindow(); var t = targetTab(); w.currentTab = t; w.index = 1; Safari.activate(); sleep(0.3);
        for (var i = 0; i < ${times}; i++) { ${steps} sleep(0.05); }
        return true;`)
      return ok(`Pressed ${keys}${times > 1 ? ` ×${times}` : ''}`)
    },
  },
  {
    name: 'form_input',
    description: 'Set a form control by ref: text inputs and textareas (value), checkboxes and radios (true/false), selects (option value or label), contenteditable (text).',
    inputSchema: { type: 'object', properties: { ...REF, value: { description: 'String, number or boolean.' }, ...TAB }, required: ['ref', 'value'] },
    run: async (io, { ref, value, tabId }) => {
      const r = await page<{ set: unknown; into: string }>(io, tabId, 'formInput', { ref, value })
      return ok(`Set ${r.into || ref} to ${JSON.stringify(r.set)}`)
    },
  },
  {
    name: 'upload_file',
    description: 'Attach local files to a file input by ref. Needs the Safari extension. Up to 10 MB in total.',
    inputSchema: { type: 'object', properties: { ...REF, paths: { type: 'array', items: { type: 'string' }, description: 'Absolute or working-directory-relative file paths.' }, ...TAB }, required: ['ref', 'paths'] },
    run: async (io, { ref, paths, tabId }) => {
      if ((await pickTransport(io, tabId)) !== 'extension') return fail('upload_file needs the Safari extension connected. Run /safari for setup.')
      const files: { name: string; type: string; base64: string }[] = []
      let total = 0
      for (const p of paths as string[]) {
        total += await io.fileSize(p)
        if (total > 10 * 1024 * 1024) return fail('Uploads are limited to 10 MB in total.')
        const base64 = await io.readBytes(p)
        files.push({ name: p.split('/').pop() ?? p, type: mimeOf(p), base64 })
      }
      const r = await page<{ attached: string[]; into: string }>(io, tabId, 'upload', { ref, files })
      return ok(`Attached ${r.attached.join(', ')} to ${r.into}`)
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a scrollable region by direction and wheel ticks (100 px each), or scroll an element into view by ref.',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', description: 'Ticks, default 3.' }, x: { type: 'number', description: 'Scroll the region under this point.' }, y: { type: 'number' }, ...REF, ...TAB },
    },
    run: async (io, { direction, amount, x, y, ref, tabId }) => {
      if (!ref && !direction) return fail('Pass a direction or a ref.')
      const r = await page<{ scrollX: number; scrollY: number; pageHeight: number; viewportHeight: number }>(io, tabId, 'scroll', { direction, amount, x, y, ref })
      return ok(`Scroll position (${r.scrollX}, ${r.scrollY}); page height ${r.pageHeight}, viewport ${r.viewportHeight}.`)
    },
  },
  {
    name: 'screenshot',
    description: "Capture the tab's viewport as a PNG scaled to CSS pixels, so coordinates read from it can be passed to click and scroll. Optionally save it to disk.",
    inputSchema: { type: 'object', properties: { ...TAB, scale: { type: 'number', description: '0.1 to 1; shrinks the image to save tokens. Default 1.' }, save_to: { type: 'string', description: 'A .png path to write the image to as well.' } } },
    run: async (io, { tabId, scale, save_to }) => {
      const s = Math.min(1, Math.max(0.1, Number(scale) || 1))
      let answer: Answer
      if ((await pickTransport(io, tabId)) === 'extension') {
        const r = await command<{ base64: string; width: number; height: number; geometry: Geometry }>(io, 'screenshot', { tabId, scale: s })
        const g = r.geometry
        answer = ok(`Viewport ${g.innerWidth}×${g.innerHeight} CSS px; coordinates in that frame${s < 1 ? ` (image shown at ${s}×)` : ''}. Scrolled to (${g.scrollX}, ${g.scrollY}).`, [{ type: 'image', data: r.base64, mimeType: 'image/png' }])
      } else {
        answer = await appleScreenshot(io, tabId, s)
      }
      if (save_to && !answer.result.isError) {
        const img = answer.result.content.find(b => b.type === 'image')
        if (img && img.type === 'image') {
          await io.writeText(String(save_to), '')
          const r = await io.run(['/bin/sh', '-c', 'base64 -d > "$0"', String(save_to)], { stdin: img.data, timeoutMs: 15_000 })
          if (r.exitCode === 0) answer.result.content[0] = { type: 'text', text: `${(answer.result.content[0] as { text: string }).text} Saved to ${save_to}.` }
        }
      }
      return answer
    },
  },
  {
    name: 'console_messages',
    description: 'Read console output (log, info, warn, error, debug, uncaught errors) captured in a tab since its last navigation. Needs the Safari extension. Filter by pattern rather than reading everything.',
    inputSchema: { type: 'object', properties: { ...TAB, pattern: { type: 'string', description: 'Substring filter.' }, onlyErrors: { type: 'boolean' }, limit: { type: 'number', description: 'Default 50, max 200.' } } },
    run: async (io, { tabId, pattern, onlyErrors, limit }) => {
      if ((await pickTransport(io, tabId)) !== 'extension') return fail('console_messages needs the Safari extension connected. Run /safari for setup.')
      const r = await command<{ tabId: number; entries: { level: string; text: string; t: number }[] }>(io, 'console', { tabId, pattern, onlyErrors, limit: Math.min(200, Number(limit) || 50) })
      if (!r.entries.length) return ok(`No console output captured in tab ${r.tabId}${pattern ? ` matching ${JSON.stringify(pattern)}` : ''}. Pages with a strict Content-Security-Policy block the capture hook.`)
      return ok(r.entries.map(e => `[${e.level}] ${e.text}`).join('\n'))
    },
  },
  {
    name: 'network_requests',
    description: 'List network requests observed in a tab since its last navigation: method, url, type, status and timing. Needs the Safari extension.',
    inputSchema: { type: 'object', properties: { ...TAB, urlPattern: { type: 'string', description: 'Substring filter on the URL.' }, limit: { type: 'number', description: 'Default 50, max 200.' } } },
    run: async (io, { tabId, urlPattern, limit }) => {
      if ((await pickTransport(io, tabId)) !== 'extension') return fail('network_requests needs the Safari extension connected. Run /safari for setup.')
      const r = await command<{ tabId: number; entries: { method: string; url: string; type: string; status?: number; error?: string; ms: number; fromCache?: boolean }[] }>(io, 'network', { tabId, urlPattern, limit: Math.min(200, Number(limit) || 50) })
      if (!r.entries.length) return ok(`No requests observed in tab ${r.tabId}${urlPattern ? ` matching ${JSON.stringify(urlPattern)}` : ''}.`)
      return ok(r.entries.map(e => `${e.method} ${e.status ?? e.error ?? '?'} ${e.type} ${e.ms}ms${e.fromCache ? ' (cache)' : ''}  ${e.url}`).join('\n'))
    },
  },
  {
    name: 'javascript',
    description: 'Run JavaScript in the page and return the result as JSON. Synchronous only (no await). For inspection and debugging, not for making UI changes.',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, ...TAB }, required: ['expression'] },
    run: async (io, { expression, tabId }) => {
      const r = await page<string>(io, tabId, 'evaluate', String(expression))
      return ok(r.length > 50_000 ? r.slice(0, 50_000) + '\n… truncated' : r)
    },
  },
  {
    name: 'wait',
    description: 'Wait a number of seconds, or until a CSS selector or visible text appears (up to timeout seconds, default 10).',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'number' }, ...TAB } },
    run: async (io, { seconds, selector, text, timeout, tabId }) => {
      if (!selector && !text) {
        const s = Math.min(30, Math.max(0, Number(seconds) || 1))
        await io.after(s * 1000)
        return ok(`Waited ${s} s`)
      }
      const limit = Math.min(60, Math.max(1, Number(timeout) || 10))
      const deadline = Date.now() + limit * 1000
      while (Date.now() < deadline) {
        if (await page<boolean>(io, tabId, 'waitFor', { selector, text })) return ok(`Found ${selector ? `selector ${selector}` : `text ${JSON.stringify(text)}`}`)
        await io.after(300)
      }
      return fail(`Timed out after ${limit} s waiting for ${selector ?? JSON.stringify(text)}`)
    },
  },
]

function mimeOf(p: string): string {
  const ext = (p.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', zip: 'application/zip' }
  return map[ext] ?? 'application/octet-stream'
}

async function statusText(io: Io): Promise<string> {
  const s = await bridgeStatus(io)
  const lines = [
    `Bridge: ${s.running ? `running (pid ${s.pid})` : 'not running'}`,
    `Extension: ${s.connected ? `connected (v${s.extensionVersion ?? '?'})` : 'not connected'}`,
    `Transport in use: ${s.connected ? 'Safari extension' : 'AppleScript fallback'}`,
  ]
  if (s.error) lines.push(`Bridge start failed: ${s.error}`)
  if (!s.connected) lines.push('', SETUP)
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const { run: _run, ...spec } of TOOLS) await $.tool.register(spec)
    await $.command.register({ name: 'safari', description: 'Safari integration: status, start the bridge, install or open the extension app.' })
    void ensureBridge(makeIo($)).then(s => $.ui.status(s.connected ? 'safari: extension' : undefined)).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'safari' }, async ($, e) => {
    const io = makeIo($)
    const arg = String((e as { args?: string }).args ?? '').trim()
    if (arg === 'install' || arg === 'open') {
      const app = `${io.pluginRoot}/app/Claude Code for Safari.app`
      const r = await io.run(['open', app], { timeoutMs: 15_000 })
      if (r.exitCode !== 0) return { text: `Could not open the app at ${app}: ${r.stderr.trim()}. Build it with: cd "${io.pluginRoot}" && ./scripts/build-extension.sh` }
      return { text: `Opened "Claude Code for Safari". Now in Safari: Settings > Extensions > turn on "Claude Code for Safari" and allow it on every website.\n\n${await statusText(io)}` }
    }
    if (arg === 'start' || arg === 'reconnect') {
      const s = await ensureBridge(io)
      return { text: `${s.running ? 'Bridge running.' : 'Bridge could not be started; is node on your PATH?'}\n\n${await statusText(io)}` }
    }
    return { text: `${await statusText(io)}\n\nCommands: /safari status, /safari start, /safari install` }
  })

  for (const tool of TOOLS) {
    on('tool.call', { tool: `mcp__safari__${tool.name}` }, async ($, e) => {
      const { tool: _t, tool_use_id: _id, ...input } = e as Record<string, unknown>
      try {
        return await tool.run(makeIo($), input)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return fail(err instanceof SafariError ? msg : `safari ${tool.name} failed: ${msg}`)
      }
    })
  }
}
