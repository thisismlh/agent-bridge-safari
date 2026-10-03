import type { EngineInterface, Register, ToolSpec } from 'claude-code'

import { formatFind, formatTabs, formatTree, parseKeys, parseTabId, type TabRow } from './format'
import { ensureSafari, runInPage, runJxa, SafariError } from './safari'

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }
type Answer = { result: { content: Block[]; isError: boolean } }

const ok = (text: string, extra: Block[] = []): Answer => ({ result: { content: [{ type: 'text', text }, ...extra], isError: false } })
const fail = (text: string): Answer => ({ result: { content: [{ type: 'text', text }], isError: true } })

const TAB = { tabId: { type: 'string', description: 'Tab from tabs_context as "<windowId>:<tabIndex>". Omit for the current tab of the front window.' } }
const REF = { ref: { type: 'string', description: 'Element ref such as "ref_12" from read_page or find.' } }

type Handler = ($: EngineInterface, input: Record<string, unknown>) => Promise<Answer>

const TOOLS: (ToolSpec & { run: Handler })[] = [
  {
    name: 'tabs_context',
    description: 'List Safari windows and tabs with their tabId, url, title and which tab is active. Opens Safari if needed.',
    inputSchema: { type: 'object', properties: {} },
    run: async $ => {
      await ensureSafari($)
      const windows = await runJxa<{ windowId: number; tabs: TabRow[] }[]>($, null, `
        return Safari.windows().map(function (w) {
          var cur = w.currentTab(); var curIdx = cur ? cur.index() : -1;
          return { windowId: w.id(), tabs: w.tabs().map(function (t) { return { tabId: tabIdOf(w, t), url: t.url() || '', title: t.name() || '', active: t.index() === curIdx }; }) };
        });`)
      return ok(formatTabs(windows))
    },
  },
  {
    name: 'tabs_create',
    description: 'Open a new Safari tab, optionally at a URL, and make it current. Returns its tabId.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to load; "about:blank" when omitted.' } } },
    run: async ($, { url }) => {
      await ensureSafari($)
      const u = normaliseUrl(url) ?? 'about:blank'
      const r = await runJxa<{ tabId: string; url: string; title: string }>($, null, `
        var ws = Safari.windows();
        var w, t;
        if (!ws.length) { Safari.documents.push(Safari.Document({ url: ${JSON.stringify(u)} })); w = Safari.windows()[0]; t = w.currentTab(); }
        else { w = ws[0]; t = Safari.Tab({ url: ${JSON.stringify(u)} }); w.tabs.push(t); w.currentTab = t; t = w.currentTab(); }
        waitReady(t, 20);
        return { tabId: tabIdOf(w, t), url: t.url() || '', title: t.name() || '' };`)
      return ok(`Opened ${r.tabId}: ${r.title || '(untitled)'}  ${r.url}`)
    },
  },
  {
    name: 'tabs_close',
    description: 'Close one Safari tab by tabId.',
    inputSchema: { type: 'object', properties: { ...TAB }, required: ['tabId'] },
    run: async ($, { tabId }) => {
      const tab = parseTabId(tabId)
      await runJxa($, tab, `var t = targetTab(); t.close(); return true;`)
      return ok(`Closed ${tabId}. Tab indexes in that window may have shifted; call tabs_context before using another tabId there.`)
    },
  },
  {
    name: 'navigate',
    description: 'Load a URL in a Safari tab, or go "back", "forward" or "reload". Waits for the page to finish loading. Opens Safari and a window if needed.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'A URL, or "back", "forward", "reload".' }, ...TAB }, required: ['url'] },
    run: async ($, { url, tabId }) => {
      await ensureSafari($)
      const tab = parseTabId(tabId)
      const target = String(url).trim()
      let body: string
      if (target === 'back' || target === 'forward' || target === 'reload') {
        const js = target === 'reload' ? 'location.reload()' : `history.${target}()`
        body = `var t = targetTab(); pageJs(t, ${JSON.stringify(js)}); var r = waitReady(t, 30);`
      } else {
        const u = normaliseUrl(target)
        if (!u) return fail(`Not a URL: ${target}`)
        body = `
          var ws = Safari.windows(); var t;
          if (!ws.length && !spec) { Safari.documents.push(Safari.Document({ url: ${JSON.stringify(u)} })); t = Safari.windows()[0].currentTab(); }
          else { t = targetTab(); t.url = ${JSON.stringify(u)}; }
          var r = waitReady(t, 30);`
      }
      const r = await runJxa<{ url: string; title: string; ready: boolean | null }>($, tab, body + ` return { url: t.url() || '', title: t.name() || '', ready: r };`)
      const note = r.ready === false ? ' (still loading after 30 s)' : r.ready === null ? ' (load wait skipped: JavaScript from Apple Events is off)' : ''
      return ok(`${r.title || '(untitled)'}  ${r.url}${note}`)
    },
  },
  {
    name: 'read_page',
    description: 'Read the current page as an indented accessibility tree. Interactive elements carry a [ref_N] usable with click, type, form_input, scroll and hover. Prefer this over screenshots for text and structure.',
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
    run: async ($, { tabId, filter, ref, max_chars, depth }) => {
      const page = await runInPage<{ url: string; title: string; lines: string[] }>($, parseTabId(tabId), 'tree', { filter: filter ?? 'all', ref, depth: depth ?? 15 })
      return ok(formatTree(page, Number(max_chars) || 50_000))
    },
  },
  {
    name: 'find',
    description: 'Search the page for elements whose role, name, value or href contains the query (case-insensitive). Returns up to 20 refs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...TAB }, required: ['query'] },
    run: async ($, { query, tabId }) => {
      const rows = await runInPage<Parameters<typeof formatFind>[0]>($, parseTabId(tabId), 'find', String(query))
      return ok(formatFind(rows))
    },
  },
  {
    name: 'get_page_text',
    description: 'Extract the visible text of the page (article or main content first, then the whole body).',
    inputSchema: { type: 'object', properties: { ...TAB, max_chars: { type: 'number', description: 'Default 50000.' } } },
    run: async ($, { tabId, max_chars }) => {
      const r = await runInPage<{ url: string; title: string; text: string; truncated: boolean }>($, parseTabId(tabId), 'pageText', Number(max_chars) || 50_000)
      return ok(`${r.title} — ${r.url}\n\n${r.text}${r.truncated ? '\n… truncated' : ''}`)
    },
  },
  {
    name: 'click',
    description: 'Click an element by ref, or a point in viewport CSS pixels (the screenshot coordinate frame). Scrolls the element into view first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REF, ...TAB,
        x: { type: 'number' }, y: { type: 'number' },
        count: { type: 'number', description: '1 (default), 2 for double-click, 3 for triple-click (selects text).' },
        button: { type: 'string', enum: ['left', 'right'] },
        modifiers: { type: 'string', description: 'e.g. "cmd", "shift", "cmd+shift".' },
      },
    },
    run: async ($, { ref, x, y, tabId, count, button, modifiers }) => {
      if (!ref && (x === undefined || y === undefined)) return fail('Pass a ref, or both x and y.')
      const r = await runInPage<{ clicked: string; x: number; y: number; url: string }>($, parseTabId(tabId), 'click', { ref, x, y, count, button, modifiers })
      return ok(`Clicked ${r.clicked} at (${r.x}, ${r.y}). Page: ${r.url}`)
    },
  },
  {
    name: 'hover',
    description: 'Move the pointer over an element by ref or by viewport coordinates, to reveal menus and tooltips.',
    inputSchema: { type: 'object', properties: { ...REF, ...TAB, x: { type: 'number' }, y: { type: 'number' } } },
    run: async ($, { ref, x, y, tabId }) => {
      const r = await runInPage<{ hovered: string }>($, parseTabId(tabId), 'hover', { ref, x, y })
      return ok(`Hovering ${r.hovered}`)
    },
  },
  {
    name: 'type',
    description: 'Type text into the focused element, or into the element given by ref. Fires the key and input events sites listen for. Use press_key for Enter, Tab or shortcuts.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...REF, ...TAB, replace: { type: 'boolean', description: 'Clear the field first.' } }, required: ['text'] },
    run: async ($, { text, ref, tabId, replace }) => {
      const r = await runInPage<{ typed: number; into: string; value?: string }>($, parseTabId(tabId), 'type', { text: String(text), ref, replace })
      return ok(`Typed ${r.typed} characters into ${r.into || 'the focused element'}${r.value !== undefined ? `; value is now ${JSON.stringify(r.value)}` : ''}`)
    },
  },
  {
    name: 'press_key',
    description: 'Press real keys in Safari via macOS, e.g. "Return", "Tab", "Escape", "cmd+a", "shift+Tab", or several separated by spaces. Brings Safari to the front. Needs Accessibility permission for the app running Claude Code.',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' }, ...TAB, repeat: { type: 'number', description: 'Times to repeat the sequence, default 1.' } }, required: ['keys'] },
    run: async ($, { keys, tabId, repeat }) => {
      const presses = parseKeys(String(keys))
      const times = Math.min(100, Math.max(1, Number(repeat) || 1))
      const steps = presses
        .map(p => (p.keyCode !== undefined ? `SE.keyCode(${p.keyCode}, { using: ${JSON.stringify(p.modifiers)} });` : `SE.keystroke(${JSON.stringify(p.char)}, { using: ${JSON.stringify(p.modifiers)} });`))
        .join(' sleep(0.05); ')
      await runJxa($, parseTabId(tabId), `
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
    run: async ($, { ref, value, tabId }) => {
      const r = await runInPage<{ set: unknown; into: string }>($, parseTabId(tabId), 'formInput', { ref, value })
      return ok(`Set ${r.into || ref} to ${JSON.stringify(r.set)}`)
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a scrollable region by direction and wheel ticks (100 px each), or scroll an element into view by ref.',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', description: 'Ticks, default 3.' }, x: { type: 'number', description: 'Scroll the region under this point.' }, y: { type: 'number' }, ...REF, ...TAB },
    },
    run: async ($, { direction, amount, x, y, ref, tabId }) => {
      if (!ref && !direction) return fail('Pass a direction or a ref.')
      const r = await runInPage<{ scrollX: number; scrollY: number; pageHeight: number; viewportHeight: number }>($, parseTabId(tabId), 'scroll', { direction, amount, x, y, ref })
      return ok(`Scroll position (${r.scrollX}, ${r.scrollY}); page height ${r.pageHeight}, viewport ${r.viewportHeight}.`)
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the tab\'s viewport as a PNG scaled to CSS pixels, so coordinates read from it can be passed to click and scroll. Works on background windows.',
    inputSchema: { type: 'object', properties: { ...TAB, scale: { type: 'number', description: '0.1 to 1; shrinks the image to save tokens. Default 1.' } } },
    run: async ($, { tabId, scale }) => {
      const tab = parseTabId(tabId)
      const info = await runJxa<{ windowId: number; geom: Geometry | null; bounds: { x: number; y: number; w: number; h: number } }>($, tab, `
        var w = targetWindow(); var t = targetTab(); w.currentTab = t;
        var geom = null;
        try { geom = JSON.parse(pageJs(t, ${JSON.stringify(PAGE_GEOMETRY)})); } catch (e) { if (!/Allow JavaScript/.test(String(e))) throw e; }
        sleep(0.2);
        var b = w.bounds();
        return { windowId: w.id(), geom: geom, bounds: { x: b.x, y: b.y, w: b.width, h: b.height } };`)
      const path = `/tmp/claude-safari-${Date.now()}.png`
      try {
        const g = info.geom
        const s = Math.min(1, Math.max(0.1, Number(scale) || 1))
        let note = ''
        // First choice: the window itself, which works even when it is behind other windows.
        const byWindow = await $.process.run(['screencapture', '-x', '-o', '-l', String(info.windowId), path], { timeoutMs: 15_000 })
        if (byWindow.exitCode === 0 && g) {
          const top = Math.round((g.outerHeight - g.innerHeight) * g.dpr)
          const left = Math.round(((g.outerWidth - g.innerWidth) * g.dpr) / 2)
          await $.process.run(['sips', '--cropOffset', String(top), String(left), '-c', String(Math.round(g.innerHeight * g.dpr)), String(Math.round(g.innerWidth * g.dpr)), path], { timeoutMs: 15_000 })
        } else if (byWindow.exitCode !== 0) {
          // Fallback: the viewport's rectangle on screen, which needs the window in front.
          const b = info.bounds
          const x = b.x + (g ? (g.outerWidth - g.innerWidth) / 2 : 0)
          const y = b.y + (g ? g.outerHeight - g.innerHeight : 0)
          const w = g ? g.innerWidth : b.w, h = g ? g.innerHeight : b.h
          await runJxa($, tab, `var w = targetWindow(); w.index = 1; Safari.activate(); sleep(0.4); return true;`)
          const byRect = await $.process.run(['screencapture', '-x', '-R', `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`, path], { timeoutMs: 15_000 })
          if (byRect.exitCode !== 0) {
            return fail('Screenshots need Screen Recording permission: System Settings > Privacy & Security > Screen Recording, allow the app running Claude Code, then restart it and retry.')
          }
          note = 'Captured from the screen (window capture was refused), so Safari was brought to the front. '
        }
        if (g) {
          await $.process.run(['sips', '-z', String(Math.round(g.innerHeight * s)), String(Math.round(g.innerWidth * s)), path], { timeoutMs: 15_000 })
          note += `Viewport ${g.innerWidth}×${g.innerHeight} CSS px; coordinates in that frame${s < 1 ? ` (image shown at ${s}×)` : ''}. Scrolled to (${g.scrollX}, ${g.scrollY}).`
        } else {
          note += 'Whole window captured (viewport crop needs "Allow JavaScript from Apple Events"); coordinates are not viewport-aligned.'
        }
        const { base64 } = await $.fs.read(path, { as: 'bytes' })
        return ok(note, [{ type: 'image', data: base64, mimeType: 'image/png' }])
      } finally {
        void $.process.run(['rm', '-f', path], { timeoutMs: 5_000 })
      }
    },
  },
  {
    name: 'javascript',
    description: 'Run JavaScript in the page and return the result as JSON. Synchronous only (no await). For inspection and debugging, not for making UI changes.',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, ...TAB }, required: ['expression'] },
    run: async ($, { expression, tabId }) => {
      const src = `(function () { try { var v = eval(${JSON.stringify(String(expression))}); var s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } return JSON.stringify({ ok: s === undefined ? 'undefined' : s }); } catch (e) { return JSON.stringify({ error: String(e && (e.stack || e.message) || e) }); } })()`
      const r = await runJxa<string>($, parseTabId(tabId), `
        var t = targetTab(); var raw = pageJs(t, ${JSON.stringify(src)});
        var r = JSON.parse(raw); if (r.error !== undefined) throw new Error(r.error); return r.ok;`)
      return ok(r.length > 50_000 ? r.slice(0, 50_000) + '\n… truncated' : r)
    },
  },
  {
    name: 'wait',
    description: 'Wait a number of seconds, or until a CSS selector or visible text appears (up to timeout seconds, default 10).',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'number' }, ...TAB } },
    run: async ($, { seconds, selector, text, timeout, tabId }) => {
      if (!selector && !text) {
        const s = Math.min(30, Math.max(0, Number(seconds) || 1))
        await runJxa($, null, `sleep(${s}); return true;`, 40_000)
        return ok(`Waited ${s} s`)
      }
      const limit = Math.min(60, Math.max(1, Number(timeout) || 10))
      const probe = PAGE_WAIT(JSON.stringify({ selector, text }))
      const found = await runJxa<boolean>($, parseTabId(tabId), `
        var t = targetTab(); var deadline = Date.now() + ${limit * 1000};
        while (Date.now() < deadline) { if (pageJs(t, ${JSON.stringify(probe)}) === 'true') return true; sleep(0.25); }
        return false;`, (limit + 15) * 1000)
      return found ? ok(`Found ${selector ? `selector ${selector}` : `text ${JSON.stringify(text)}`}`) : fail(`Timed out after ${limit} s waiting for ${selector ?? JSON.stringify(text)}`)
    },
  },
]

type Geometry = { innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number; dpr: number; scrollX: number; scrollY: number }
const PAGE_GEOMETRY = `JSON.stringify({ innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) })`
const PAGE_WAIT = (argsJson: string) =>
  `(function (o) { if (o.selector && document.querySelector(o.selector)) return 'true'; if (o.text && (document.body && document.body.innerText || '').indexOf(o.text) >= 0) return 'true'; return 'false'; })(${argsJson})`

function normaliseUrl(input: unknown): string | undefined {
  if (input === undefined || input === null || String(input).trim() === '') return undefined
  const s = String(input).trim()
  if (/^(https?|file|about):/i.test(s)) return s
  if (/^[\w.-]+(\.[a-z]{2,})(:\d+)?(\/|$)/i.test(s) || /^localhost(:\d+)?/.test(s)) return `https://${s}`
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const { run: _run, ...spec } of TOOLS) await $.tool.register(spec)
    return next(e)
  })

  for (const tool of TOOLS) {
    on('tool.call', { tool: `mcp__safari__${tool.name}` }, async ($, e) => {
      const { tool: _t, tool_use_id: _id, ...input } = e as Record<string, unknown>
      try {
        return await tool.run($, input)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return fail(err instanceof SafariError ? msg : `safari ${tool.name} failed: ${msg}`)
      }
    })
  }
}
