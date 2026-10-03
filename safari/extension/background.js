// Background page: long-polls the local bridge for commands, runs them against
// Safari's tabs, and keeps per-tab console and network buffers.

var BRIDGE = 'http://127.0.0.1:47831';
var VERSION = '0.1.0';
var RING = 500;

var consoleLogs = new Map();
var networkLogs = new Map();

function push(map, tabId, entry) {
  if (tabId === undefined || tabId < 0) return;
  var list = map.get(tabId) || [];
  list.push(entry);
  if (list.length > RING) list.splice(0, list.length - RING);
  map.set(tabId, list);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

browser.runtime.onMessage.addListener(function (msg, sender) {
  if (msg && msg.type === 'console' && sender.tab) push(consoleLogs, sender.tab.id, msg.entry);
});

var requests = new Map();
browser.webRequest.onBeforeRequest.addListener(function (d) {
  requests.set(d.requestId, { id: d.requestId, tabId: d.tabId, method: d.method, url: d.url, type: d.type, started: d.timeStamp });
}, { urls: ['<all_urls>'] });
browser.webRequest.onCompleted.addListener(function (d) {
  var r = requests.get(d.requestId) || { id: d.requestId, tabId: d.tabId, method: d.method, url: d.url, type: d.type, started: d.timeStamp };
  requests.delete(d.requestId);
  r.status = d.statusCode; r.fromCache = !!d.fromCache; r.ms = Math.round(d.timeStamp - r.started);
  push(networkLogs, d.tabId, r);
}, { urls: ['<all_urls>'] });
browser.webRequest.onErrorOccurred.addListener(function (d) {
  var r = requests.get(d.requestId) || { id: d.requestId, tabId: d.tabId, method: d.method, url: d.url, type: d.type, started: d.timeStamp };
  requests.delete(d.requestId);
  r.error = d.error; r.ms = Math.round(d.timeStamp - r.started);
  push(networkLogs, d.tabId, r);
}, { urls: ['<all_urls>'] });
browser.tabs.onRemoved.addListener(function (tabId) { consoleLogs.delete(tabId); networkLogs.delete(tabId); });
browser.webNavigation.onCommitted.addListener(function (d) {
  if (d.frameId === 0) { consoleLogs.delete(d.tabId); networkLogs.delete(d.tabId); }
});

async function tabOrActive(tabId) {
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    try { return await browser.tabs.get(Number(tabId)); } catch (e) { throw new Error('No tab ' + tabId + '. Call tabs_context for current tab ids.'); }
  }
  var tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) tabs = await browser.tabs.query({ active: true });
  if (!tabs.length) throw new Error('Safari has no tabs open. Use tabs_create or navigate.');
  return tabs[0];
}

async function waitLoaded(tabId, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < deadline) {
    var t;
    try { t = await browser.tabs.get(tabId); } catch (e) { return false; }
    if (t.status === 'complete') return true;
    await sleep(150);
  }
  return false;
}

async function pageCall(tab, fn, args) {
  var reply;
  try {
    reply = await browser.tabs.sendMessage(tab.id, { type: 'page', fn: fn, args: args });
  } catch (e) {
    // The page loaded before the extension was enabled, or the script never ran: inject once and retry.
    try {
      await browser.tabs.executeScript(tab.id, { file: 'page-runtime.js' });
      await browser.tabs.executeScript(tab.id, { file: 'content.js' });
      reply = await browser.tabs.sendMessage(tab.id, { type: 'page', fn: fn, args: args });
    } catch (e2) {
      throw new Error('Cannot reach the page in tab ' + tab.id + ' (' + (tab.url || 'no url') + '). Safari internal pages, PDFs and pages that refused the extension cannot be scripted.');
    }
  }
  if (!reply) throw new Error('The page did not answer; it may still be loading.');
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.ok;
}

function dataUrlToBase64(u) { return u.slice(u.indexOf(',') + 1); }

async function scaleImage(dataUrl, width, height) {
  var img = await new Promise(function (resolve, reject) {
    var i = new Image(); i.onload = function () { resolve(i); }; i.onerror = reject; i.src = dataUrl;
  });
  var c = document.createElement('canvas'); c.width = width; c.height = height;
  c.getContext('2d').drawImage(img, 0, 0, width, height);
  return c.toDataURL('image/png');
}

var handlers = {
  ping: async function () {
    var tabs = await browser.tabs.query({});
    return { version: VERSION, tabs: tabs.length };
  },
  'tabs.list': async function () {
    var tabs = await browser.tabs.query({});
    return tabs.map(function (t) { return { tabId: t.id, windowId: t.windowId, index: t.index, url: t.url || '', title: t.title || '', active: !!t.active }; });
  },
  'tabs.create': async function (p) {
    var t = await browser.tabs.create({ url: p.url || 'about:blank', active: true });
    await waitLoaded(t.id, 20000);
    t = await browser.tabs.get(t.id);
    return { tabId: t.id, url: t.url || '', title: t.title || '' };
  },
  'tabs.close': async function (p) {
    var t = await tabOrActive(p.tabId);
    await browser.tabs.remove(t.id);
    return { closed: t.id };
  },
  navigate: async function (p) {
    var t = await tabOrActive(p.tabId);
    if (p.url === 'back') await browser.tabs.goBack(t.id);
    else if (p.url === 'forward') await browser.tabs.goForward(t.id);
    else if (p.url === 'reload') await browser.tabs.reload(t.id);
    else await browser.tabs.update(t.id, { url: p.url });
    var ready = await waitLoaded(t.id, 30000);
    t = await browser.tabs.get(t.id);
    return { tabId: t.id, url: t.url || '', title: t.title || '', ready: ready };
  },
  page: async function (p) {
    var t = await tabOrActive(p.tabId);
    return pageCall(t, p.fn, p.args);
  },
  screenshot: async function (p) {
    var t = await tabOrActive(p.tabId);
    if (!t.active) { await browser.tabs.update(t.id, { active: true }); await sleep(250); }
    var g = await pageCall(t, 'geometry', {});
    var raw = await browser.tabs.captureVisibleTab(t.windowId, { format: 'png' });
    var s = Math.min(1, Math.max(0.1, Number(p.scale) || 1));
    var w = Math.round(g.innerWidth * s), h = Math.round(g.innerHeight * s);
    var scaled = await scaleImage(raw, w, h);
    return { base64: dataUrlToBase64(scaled), width: w, height: h, geometry: g };
  },
  activate: async function (p) {
    var t = await tabOrActive(p.tabId);
    await browser.tabs.update(t.id, { active: true });
    try { await browser.windows.update(t.windowId, { focused: true }); } catch (e) {}
    return { tabId: t.id };
  },
  console: async function (p) {
    var t = await tabOrActive(p.tabId);
    var list = consoleLogs.get(t.id) || [];
    if (p.onlyErrors) list = list.filter(function (e) { return e.level === 'error'; });
    if (p.pattern) list = list.filter(function (e) { return e.text.indexOf(p.pattern) >= 0; });
    return { tabId: t.id, entries: list.slice(-(p.limit || 50)) };
  },
  network: async function (p) {
    var t = await tabOrActive(p.tabId);
    var list = networkLogs.get(t.id) || [];
    if (p.urlPattern) list = list.filter(function (r) { return r.url.indexOf(p.urlPattern) >= 0; });
    return { tabId: t.id, entries: list.slice(-(p.limit || 50)) };
  },
};

async function handle(cmd) {
  var h = handlers[cmd.name];
  if (!h) throw new Error('Unknown command ' + cmd.name);
  return h(cmd.params || {});
}

async function post(path, body) {
  await fetch(BRIDGE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function loop() {
  for (;;) {
    try {
      var r = await fetch(BRIDGE + '/ext/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: VERSION }) });
      if (r.status === 204) continue;
      if (!r.ok) { await sleep(1000); continue; }
      var cmd = await r.json();
      handle(cmd).then(
        function (result) { return post('/ext/result', { id: cmd.id, result: result }); },
        function (err) { return post('/ext/result', { id: cmd.id, error: String((err && err.message) || err) }); }
      ).catch(function () {});
    } catch (e) {
      await sleep(1500);
    }
  }
}
loop();
