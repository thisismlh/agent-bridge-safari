// The bridge to Safari: builds a JXA (JavaScript for Automation) script, runs it
// through osascript, and hands back parsed JSON. Page-level work injects the
// page runtime with Safari's `do JavaScript`.

import type { Io } from './io'

import { PAGE_RUNTIME } from './page-script'
import { explainSafariError, type TabSpec } from './format'

export class SafariError extends Error {}

/** The JXA prelude every script shares: resolves the target tab. */
function prelude(tab: TabSpec): string {
  return `
    ObjC.import('stdlib');
    var Safari = Application('Safari');
    var SE = Application('System Events');
    SE.includeStandardAdditions = true;
    var spec = ${JSON.stringify(tab)};
    function frontWindow() {
      var ws = Safari.windows();
      if (!ws.length) throw new Error('NOWINDOW');
      return ws[0];
    }
    function targetWindow() {
      if (!spec) return frontWindow();
      var w = Safari.windows.byId(spec.windowId);
      try { w.id(); } catch (e) { throw new Error('Can\\'t get window ' + spec.windowId); }
      return w;
    }
    function targetTab() {
      var w = targetWindow();
      if (!spec) return w.currentTab();
      var tabs = w.tabs();
      var t = tabs[spec.tabIndex - 1];
      if (!t) throw new Error('Can\\'t get tab ' + spec.tabIndex + ' of window ' + spec.windowId);
      return t;
    }
    function tabIdOf(w, t) { return w.id() + ':' + t.index(); }
    function sleep(s) { delay(s); }
    function pageJs(t, src) { return Safari.doJavaScript(src, { in: t }); }
    function ready(t) { try { return pageJs(t, 'document.readyState') === 'complete'; } catch (e) { if (/Allow JavaScript/.test(String(e))) return null; return false; } }
    function waitReady(t, seconds) {
      var deadline = Date.now() + seconds * 1000;
      sleep(0.3);
      while (Date.now() < deadline) {
        var r = ready(t);
        if (r === true) return true;
        if (r === null) { sleep(1.5); return null; }
        sleep(0.25);
      }
      return false;
    }
  `
}

export async function runJxa<T>(io: Io, tab: TabSpec, body: string, timeoutMs = 45_000): Promise<T> {
  const script = `${prelude(tab)}\nJSON.stringify((function () { try { return { ok: (function () { ${body} })() }; } catch (e) { return { error: String(e && e.message || e) }; } })());`
  const ran = await io.run(['osascript', '-l', 'JavaScript'], { stdin: script, timeoutMs })
  const out = ran.stdout.trim()
  if (ran.exitCode !== 0 || !out) {
    throw new SafariError(explainSafariError(ran.stderr.trim() || `osascript exited ${ran.exitCode}`))
  }
  let parsed: { ok?: T; error?: string }
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new SafariError(`Unexpected reply from Safari: ${out.slice(0, 200)}`)
  }
  if (parsed.error !== undefined) {
    if (parsed.error === 'NOWINDOW') throw new SafariError('Safari has no window open. Use navigate or tabs_create first.')
    throw new SafariError(explainSafariError(parsed.error))
  }
  return parsed.ok as T
}

/** Calls one function of the page runtime in the target tab and returns its JSON result. */
export async function runInPage<T>(io: Io, tab: TabSpec, fn: string, args: unknown): Promise<T> {
  const pageSrc =
    PAGE_RUNTIME +
    `\n;JSON.stringify((function () { try { return { ok: window.__claude.${fn}(${JSON.stringify(args)}) }; } catch (e) { return { error: String(e && e.message || e) }; } })());`
  const body = `
    var t = targetTab();
    var raw = pageJs(t, ${JSON.stringify(pageSrc)});
    if (raw === undefined || raw === null) throw new Error('The page returned nothing; it may still be loading or be a non-HTML page.');
    var r = JSON.parse(raw);
    if (r.error !== undefined) throw new Error(r.error);
    return r.ok;
  `
  return runJxa<T>(io, tab, body)
}

export async function ensureSafari(io: Io): Promise<void> {
  await io.run(['open', '-g', '-a', 'Safari'], { timeoutMs: 10_000 })
}
