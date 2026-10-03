// Content script: answers page calls from the background page by delegating to
// window.__claude (page-runtime.js, loaded just before this file), and relays
// console output from the page world.
(function () {
  if (window.__claudeContentInstalled) return;
  window.__claudeContentInstalled = true;

  // Console hook in the page world. A strict page CSP can refuse the script; console
  // capture is then unavailable on that page, while every other tool still works.
  try {
    var s = document.createElement("script");
    s.src = browser.runtime.getURL('console-hook.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.addEventListener('load', function () { s.remove(); });
  } catch (e) {}

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || !ev.data.__claudeConsole) return;
    try { browser.runtime.sendMessage({ type: 'console', entry: ev.data.__claudeConsole }); } catch (e) {}
  });

  var hookReady = false;
  var evalWaiters = {};
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.__claudeHookReady) hookReady = true;
    var r = ev.data.__claudeEvalResult;
    if (r && evalWaiters[r.id]) { evalWaiters[r.id](r); delete evalWaiters[r.id]; }
  });
  // Runs an expression in the page's own world (page variables visible, console captured);
  // falls back to this isolated world when the hook could not be installed.
  function evaluateInPage(expression) {
    if (!hookReady) return Promise.resolve({ ok: window.__claude.evaluate(expression) });
    return new Promise(function (resolve) {
      var id = String(Date.now()) + Math.random();
      var timer = setTimeout(function () { delete evalWaiters[id]; resolve({ error: 'The page did not answer the evaluation within 10 s.' }); }, 10000);
      evalWaiters[id] = function (r) { clearTimeout(timer); resolve(r.error !== undefined ? { error: r.error } : { ok: r.ok }); };
      window.postMessage({ __claudeEval: { id: id, expression: expression } }, '*');
    });
  }

  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'page') return;
    if (msg.fn === 'evaluate') return evaluateInPage(String(msg.args));
    return new Promise(function (resolve) {
      try {
        if (!window.__claude || typeof window.__claude[msg.fn] !== 'function') throw new Error('Page runtime has no function ' + msg.fn);
        resolve({ ok: window.__claude[msg.fn](msg.args) });
      } catch (e) {
        resolve({ error: String((e && e.message) || e) });
      }
    });
  });
})();
