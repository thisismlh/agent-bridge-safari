// Runs in the page's own world: wraps console and error events and relays them
// to the content script through postMessage. Installed once per document.
(function () {
  if (window.__claudeConsoleHooked) return;
  window.__claudeConsoleHooked = true;
  function fmt(v) {
    try {
      if (v instanceof Error) return (v.stack || v.message || String(v));
      if (typeof v === 'string') return v;
      return JSON.stringify(v, function (k, x) { return typeof x === 'bigint' ? String(x) : x; });
    } catch (e) { try { return String(v); } catch (e2) { return '[unprintable]'; } }
  }
  function send(level, args) {
    var text = Array.prototype.map.call(args, fmt).join(' ');
    try { window.postMessage({ __claudeConsole: { level: level, text: text.slice(0, 4000), t: Date.now() } }, '*'); } catch (e) {}
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () { send(level, arguments); try { return orig.apply(console, arguments); } catch (e) {} };
  });
  window.addEventListener('error', function (e) { send('error', [e.message + ' (' + (e.filename || '') + ':' + (e.lineno || 0) + ')']); });
  window.addEventListener('unhandledrejection', function (e) { send('error', ['Unhandled promise rejection: ' + fmt(e.reason)]); });
})();
