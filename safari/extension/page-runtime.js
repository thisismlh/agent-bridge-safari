// The page runtime: installed once per document and exposed as window.__claude.
// Single source of truth. The Safari extension loads it as a content script;
// bun scripts/sync-runtime.ts copies it into hooks/page-script.ts for the
// AppleScript transport. Plain ES5, no dependencies, JSON-serialisable returns.
(function () {
  if (window.__claude && window.__claude.version === 1) return;
  var refs = [];
  var refIndex = new WeakMap();
  var INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[onclick],[contenteditable=""],[contenteditable=true]';

  // hidden: the element and everything under it is invisible, so skip the subtree.
  // hidden: nothing under the element can be seen, so skip the subtree. display:none is the
  // only style that reliably propagates; visibility and opacity can be overridden by children.
  function hidden(el) {
    if (!(el instanceof Element)) return true;
    return getComputedStyle(el).display === 'none';
  }
  // A form control hidden with opacity 0 or visibility hidden is still the thing to drive
  // (styled checkboxes, file inputs under a label); anything else that way is treated as hidden.
  function faded(el) {
    var cs = getComputedStyle(el);
    return cs.visibility === 'hidden' || cs.opacity === '0';
  }
  function isControl(el) { var t = el.tagName; return t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA'; }
  // hasBox: the element itself takes up space. A zero-size wrapper is walked but not listed.
  function hasBox(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function visible(el) { return !hidden(el) && hasBox(el) && (!faded(el) || isControl(el)); }
  // Every element in the document including open shadow roots, in document order.
  function allElements(root) {
    var out = [];
    (function walk(node) {
      var kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (var i = 0; i < kids.length; i++) { out.push(kids[i]); if (kids[i].shadowRoot) walk(kids[i].shadowRoot); }
    })(root || document);
    return out;
  }
  function refOf(el) {
    var i = refIndex.get(el);
    if (i === undefined) { refs.push(el); i = refs.length - 1; refIndex.set(el, i); }
    return 'ref_' + (i + 1);
  }
  function byRef(ref) {
    var m = /^ref_(\d+)$/.exec(String(ref || ''));
    var el = m ? refs[Number(m[1]) - 1] : null;
    if (!el || !el.isConnected) throw new Error('No element for ' + ref + '. Call read_page or find again to get fresh refs.');
    return el;
  }
  function role(el) {
    var r = el.getAttribute('role');
    if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'input') {
      var ty = (el.type || 'text').toLowerCase();
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'file') return 'fileinput';
      return 'textbox';
    }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img') return 'img';
    if (t === 'li') return 'listitem';
    if (t === 'nav') return 'navigation';
    if (t === 'main') return 'main';
    if (t === 'form') return 'form';
    if (t === 'table') return 'table';
    if (t === 'option') return 'option';
    if (t === 'label') return 'label';
    if (el.isContentEditable) return 'textbox';
    return '';
  }
  function text(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function name(el) {
    var t = el.tagName.toLowerCase();
    var n = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder');
    if (!n && el.getAttribute('aria-labelledby')) {
      n = el.getAttribute('aria-labelledby').split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? x.innerText : ''; }).join(' ');
    }
    if (!n && el.id && (t === 'input' || t === 'select' || t === 'textarea')) {
      var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) n = lab.innerText;
    }
    if (!n && (t === 'input' || t === 'select' || t === 'textarea')) {
      var wrap = el.closest('label');
      if (wrap) n = wrap.innerText;
    }
    if (!n && (t === 'input') && (el.type === 'submit' || el.type === 'button')) n = el.value;
    if (!n && (t === 'input' || t === 'select' || t === 'textarea') && el.name) n = el.name;
    if (!n && t === 'select' && el.selectedOptions.length) n = el.selectedOptions[0].text;
    var container = t === 'form' || t === 'main' || t === 'nav' || t === 'section' || t === 'table' || t === 'article' || t === 'aside' || t === 'header' || t === 'footer' || t === 'ul' || t === 'ol' || t === 'dialog';
    if (!n && !container && t !== 'input' && t !== 'select' && t !== 'textarea') n = el.innerText;
    return text(n).slice(0, 120);
  }
  function isInteractive(el) {
    if (el.matches(INTERACTIVE) || el.isContentEditable) return true;
    // React-style click targets: a pointer cursor with no interactive ancestor.
    if (el.tagName !== 'DIV' && el.tagName !== 'SPAN' && el.tagName !== 'LI' && el.tagName !== 'TD' && el.tagName !== 'IMG') return false;
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    var up = el.parentElement;
    while (up) { if (up.matches(INTERACTIVE) || getComputedStyle(up).cursor === 'pointer') return false; up = up.parentElement; }
    return true;
  }
  function describe(el) {
    var out = { role: role(el), name: name(el) };
    var t = el.tagName.toLowerCase();
    if (t === 'input' || t === 'textarea') {
      if (el.type === 'password') out.value = el.value ? '••••' : '';
      else if (el.type === 'checkbox' || el.type === 'radio') out.checked = el.checked;
      else out.value = text(el.value).slice(0, 80);
    }
    if (t === 'a' && el.href) out.href = el.href.slice(0, 200);
    if (el.disabled) out.disabled = true;
    if (el.getAttribute('aria-expanded')) out.expanded = el.getAttribute('aria-expanded') === 'true';
    if (document.activeElement === el) out.focused = true;
    return out;
  }
  function headingLevel(el) { var m = /^H([1-6])$/.exec(el.tagName); return m ? Number(m[1]) : (Number(el.getAttribute('aria-level')) || 0); }

  function tree(opts) {
    var interactiveOnly = opts.filter === 'interactive';
    var root = opts.ref ? byRef(opts.ref) : document.body;
    var lines = [];
    function walk(el, depth) {
      if (depth > (opts.depth || 15)) return;
      if (hidden(el)) return;
      var boxed = hasBox(el);
      var t = el.tagName.toLowerCase();
      if (t === 'script' || t === 'style' || t === 'noscript' || t === 'svg' || t === 'template') return;
      if (t === 'iframe' || t === 'frame') { if (boxed) lines.push('  '.repeat(Math.min(depth, 30)) + 'iframe ' + JSON.stringify((el.getAttribute('title') || el.getAttribute('name') || '')) + (el.src ? ' src=' + el.src.slice(0, 160) : '') + ' (contents not readable from this tab)'); return; }
      if (faded(el) && !isControl(el)) return;
      var r = role(el);
      var inter = isInteractive(el);
      var ownText = '';
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3) ownText += n.textContent;
      }
      ownText = text(ownText);
      var show = boxed && (inter || (!interactiveOnly && (r || ownText)));
      var indent = '  '.repeat(Math.min(depth, 30));
      if (show) {
        var d = describe(el);
        var parts = [];
        parts.push(d.role || (inter ? 'clickable' : ownText ? 'text' : t));
        if (inter) parts.push('[' + refOf(el) + ']');
        if (r === 'heading') parts.push('h' + headingLevel(el));
        var label = inter || r ? d.name : ownText;
        if (!inter && r && ownText && ownText !== d.name) label = d.name;
        if (label) parts.push(JSON.stringify(label.slice(0, 120)));
        if (d.value !== undefined && d.value !== '') parts.push('value=' + JSON.stringify(d.value));
        if (d.checked !== undefined) parts.push(d.checked ? 'checked' : 'unchecked');
        if (d.href) parts.push('href=' + d.href);
        if (d.disabled) parts.push('disabled');
        if (d.focused) parts.push('focused');
        if (d.expanded !== undefined) parts.push(d.expanded ? 'expanded' : 'collapsed');
        if (faded(el)) parts.push('(visually hidden)');
        lines.push(indent + parts.join(' '));
        if (inter && (t === 'a' || t === 'button' || t === 'select')) return;
      } else if (boxed && !interactiveOnly && !r && ownText && lines.length) {
        // text-only wrapper: fold its text into a line of its own
        lines.push(indent + 'text ' + JSON.stringify(ownText.slice(0, 160)));
      }
      var kids = el.children;
      for (var k = 0; k < kids.length; k++) walk(kids[k], show ? depth + 1 : depth);
      if (el.shadowRoot) { var sk = el.shadowRoot.children; for (var s = 0; s < sk.length; s++) walk(sk[s], depth + 1); }
    }
    walk(root, 0);
    return { url: location.href, title: document.title, lines: lines };
  }

  function find(q) {
    q = String(q || '').toLowerCase();
    var out = [];
    var all = allElements(document);
    for (var i = 0; i < all.length && out.length < 40; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var inter = isInteractive(el);
      var r = role(el);
      if (!inter && !r) continue;
      var d = describe(el);
      var hay = (d.role + ' ' + d.name + ' ' + (d.value || '') + ' ' + (d.href || '')).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
      out.push({ el: el, inter: inter, row: { role: d.role || (inter ? 'clickable' : el.tagName.toLowerCase()), name: d.name, value: d.value, href: d.href } });
    }
    // Interactive matches first: a query like "name" should surface the field before its label.
    out.sort(function (a, b) { return (b.inter ? 1 : 0) - (a.inter ? 1 : 0); });
    return out.slice(0, 20).map(function (m) { m.row.ref = refOf(m.el); return m.row; });
  }

  function center(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function elementAt(x, y) {
    var el = document.elementFromPoint(x, y), inner;
    while (el && el.shadowRoot && (inner = el.shadowRoot.elementFromPoint(x, y)) && inner !== el) el = inner;
    return el;
  }
  function mouseInit(x, y, mods) {
    var i = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0, buttons: 1 };
    mods = mods || '';
    i.shiftKey = /shift/.test(mods); i.ctrlKey = /ctrl/.test(mods); i.altKey = /alt/.test(mods); i.metaKey = /cmd|meta/.test(mods);
    return i;
  }
  function click(opts) {
    var el, x, y;
    if (opts.ref) { el = byRef(opts.ref); var c = center(el); x = c.x; y = c.y; }
    else { x = opts.x; y = opts.y; el = elementAt(x, y); if (!el) throw new Error('Nothing at ' + x + ',' + y); }
    var hit = elementAt(x, y);
    var target = (opts.ref && hit && !el.contains(hit) && !hit.contains(el)) ? el : (hit || el);
    var init = mouseInit(x, y, opts.modifiers);
    var count = opts.count || 1;
    try { target.dispatchEvent(new PointerEvent('pointerdown', init)); } catch (e) {}
    target.dispatchEvent(new MouseEvent('mousedown', init));
    if (target.focus) { try { target.focus({ preventScroll: true }); } catch (e) {} }
    try { target.dispatchEvent(new PointerEvent('pointerup', init)); } catch (e) {}
    target.dispatchEvent(new MouseEvent('mouseup', init));
    for (var n = 0; n < count; n++) {
      init.detail = n + 1;
      if (opts.button === 'right') target.dispatchEvent(new MouseEvent('contextmenu', init));
      else target.dispatchEvent(new MouseEvent('click', init));
    }
    if (count === 2) target.dispatchEvent(new MouseEvent('dblclick', init));
    if (count === 3) { var sel = window.getSelection(); var range = document.createRange(); range.selectNodeContents(target); sel.removeAllRanges(); sel.addRange(range); }
    var d = describe(target);
    return { clicked: (d.role || target.tagName.toLowerCase()) + (d.name ? ' ' + JSON.stringify(d.name) : ''), x: Math.round(x), y: Math.round(y), url: location.href };
  }
  function hover(opts) {
    var el, x, y;
    if (opts.ref) { el = byRef(opts.ref); var c = center(el); x = c.x; y = c.y; } else { x = opts.x; y = opts.y; el = elementAt(x, y); }
    if (!el) throw new Error('Nothing to hover');
    var init = mouseInit(x, y);
    try { el.dispatchEvent(new PointerEvent('pointerover', init)); el.dispatchEvent(new PointerEvent('pointerenter', init)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseover', init)); el.dispatchEvent(new MouseEvent('mouseenter', init)); el.dispatchEvent(new MouseEvent('mousemove', init));
    return { hovered: name(el) || el.tagName.toLowerCase() };
  }

  function setNative(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function fire(el, type, init) { el.dispatchEvent(new Event(type, Object.assign({ bubbles: true, cancelable: true }, init || {}))); }
  function typeText(opts) {
    var el = opts.ref ? byRef(opts.ref) : document.activeElement;
    if (!el || el === document.body) throw new Error('Nothing is focused. Pass a ref or click a field first.');
    el.focus();
    var s = String(opts.text);
    if (el.isContentEditable) {
      if (opts.replace) el.textContent = '';
      document.execCommand('insertText', false, s);
      return { typed: s.length, into: name(el) || 'contenteditable' };
    }
    if (!('value' in el)) throw new Error('Element is not editable: ' + el.tagName);
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      var code = ch.charCodeAt(0);
      var kinit = { key: ch, keyCode: code, which: code, charCode: code, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', kinit));
      el.dispatchEvent(new KeyboardEvent('keypress', kinit));
      if (i === 0 && opts.replace) setNative(el, '');
      setNative(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keyup', kinit));
    }
    fire(el, 'change');
    return { typed: s.length, into: name(el) || el.tagName.toLowerCase(), value: el.value.slice(0, 80) };
  }
  function formInput(opts) {
    var el = byRef(opts.ref);
    var v = opts.value;
    var t = el.tagName.toLowerCase();
    if (t === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      var want = typeof v === 'boolean' ? v : /^(true|1|yes|on|checked)$/i.test(String(v));
      if (el.checked !== want) el.click();
      return { set: el.checked, into: name(el) };
    }
    if (t === 'select') {
      var opt = Array.prototype.find.call(el.options, function (o) { return o.value === String(v) || o.text.trim() === String(v); });
      if (!opt) throw new Error('No option ' + JSON.stringify(v) + '. Options: ' + Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).join(', '));
      el.focus(); el.value = opt.value; fire(el, 'input'); fire(el, 'change');
      return { set: opt.text.trim(), into: name(el) };
    }
    if (el.isContentEditable) { el.focus(); el.textContent = ''; document.execCommand('insertText', false, String(v)); return { set: String(v), into: name(el) }; }
    if (!('value' in el)) throw new Error('Element is not a form control: ' + t);
    el.focus(); setNative(el, String(v));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(v) }));
    fire(el, 'change');
    return { set: el.type === 'password' ? '••••' : String(v).slice(0, 80), into: name(el) || t };
  }
  function scroll(opts) {
    if (opts.ref) { byRef(opts.ref).scrollIntoView({ block: 'center', behavior: 'instant' }); }
    else {
      var amt = (opts.amount || 3) * 100;
      var dx = opts.direction === 'left' ? -amt : opts.direction === 'right' ? amt : 0;
      var dy = opts.direction === 'up' ? -amt : opts.direction === 'down' ? amt : 0;
      var target = (opts.x !== undefined && opts.y !== undefined) ? elementAt(opts.x, opts.y) : null;
      while (target && target !== document.body) {
        var cs = getComputedStyle(target);
        var canY = /(auto|scroll)/.test(cs.overflowY) && target.scrollHeight > target.clientHeight;
        var canX = /(auto|scroll)/.test(cs.overflowX) && target.scrollWidth > target.clientWidth;
        if ((dy && canY) || (dx && canX)) break;
        target = target.parentElement;
      }
      if (target && target !== document.body) target.scrollBy(dx, dy); else window.scrollBy(dx, dy);
    }
    return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
  }
  function pageText(max) {
    var root = document.querySelector('article, main, [role=main]') || document.body;
    var s = root.innerText || '';
    return { url: location.href, title: document.title, text: s.slice(0, max || 50000), truncated: s.length > (max || 50000) };
  }
  function geometry() {
    return { innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight, screenX: screenX, screenY: screenY, dpr: devicePixelRatio, scrollX: scrollX, scrollY: scrollY };
  }
  function waitFor(opts) {
    if (opts.selector) { var found = allElements(document).some(function (el) { try { return el.matches(opts.selector); } catch (e) { return false; } }); if (found) return true; }
    if (opts.text && (document.body.innerText || '').indexOf(opts.text) >= 0) return true;
    return false;
  }
  function upload(opts) {
    var el = byRef(opts.ref);
    if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('Element is not a file input: ' + el.tagName);
    var dt = new DataTransfer();
    (opts.files || []).forEach(function (f) {
      var bin = atob(f.base64); var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
    });
    el.files = dt.files;
    fire(el, 'input'); fire(el, 'change');
    return { attached: Array.prototype.map.call(el.files, function (f) { return f.name; }), into: name(el) || 'file input' };
  }
  function focusables() {
    var sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
    return Array.prototype.filter.call(document.querySelectorAll(sel), function (el) { return !el.disabled && visible(el); });
  }
  function pressKey(opts) {
    var key = opts.key;
    var el = document.activeElement || document.body;
    var codes = { Enter: 13, Tab: 9, Escape: 27 };
    var init = { key: key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, shiftKey: !!opts.shift, bubbles: true, cancelable: true };
    var down = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    if (down) {
      if (key === 'Enter') {
        if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertText', false, '\n');
        else if (el.tagName === 'BUTTON' || el.tagName === 'A' || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button' || el.type === 'checkbox' || el.type === 'radio'))) el.click();
        else if (el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
      } else if (key === 'Tab') {
        var list = focusables(); var i = list.indexOf(el);
        var next = list[(i + (opts.shift ? -1 : 1) + list.length) % list.length];
        if (next) next.focus();
      } else if (key === 'Escape') {
        if (el !== document.body) el.blur();
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    var now = document.activeElement;
    return { pressed: key, focus: now && now !== document.body ? (name(now) || now.tagName.toLowerCase()) : 'body', url: location.href };
  }
  function evaluate(expression) {
    var v = eval(expression);
    var s; try { s = JSON.stringify(v); } catch (e) { s = String(v); }
    return s === undefined ? 'undefined' : s;
  }
  window.__claude = { version: 1, pressKey: pressKey, evaluate: evaluate, upload: upload, tree: tree, find: find, click: click, hover: hover, type: typeText, formInput: formInput, scroll: scroll, pageText: pageText, geometry: geometry, waitFor: waitFor, refCount: function () { return refs.length; } };
})();
