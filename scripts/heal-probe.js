/*
===============================================================================
Page Probe (the element inventory a client collects and sends)
===============================================================================
Run in the page as `page.evaluate(<this file>)` for the whole page, or as `locator.evaluate(<this file>)` to describe just
that one element (a client uses that to check a healed locator against the element it expected). It returns
{items, more, page}: the elements a locator could hook on, and a small record of the page they came from. The service has
no browser and never fetches a page, so this list is the only view of the page it ever gets: what is not in it cannot be
matched, and what is in it is what it learns.

What it reads is attributes and visible copy, never what a person typed. That is the line this file is written around:
    - an input's value is never read, except the label of a button / submit / reset input (it is the button's text);
      a textarea's content, a select's chosen option and a contenteditable region's text are never read, and the copy of
      a container skips them too
    - a password field is listed like any other field (tag, type, label, placeholder, box) and carries no value
    - a data-* attribute whose NAME looks like a credential or an address (token, csrf, auth, session, secret, email,
      password) is dropped, and every attribute value has its control characters removed and its length capped, so a page
      cannot smuggle a line break into a prompt or a log line

Features:
    ✓ Open shadow roots and same-origin frames are walked too (a plain querySelectorAll stops at both); an item says
      where it is (shadow: the host tags, frame: the iframe's name or id) and which row it sits in (row: the nearest
      ancestor with a test hook; row_attr: which attribute it is), so two "pending" badges can be told apart and a
      locator can be scoped to the row
    ✓ Things a step acts on without being a control are listed too (an anchor with no href, onclick, tabindex,
      contenteditable, summary, and the outermost element with a pointer cursor); plain containers are not
    ✓ testid is data-testid ONLY; data-test, data-qa and data-cy are separate keys (data_test, data_qa, data_cy), so the
      service can honour whichever attribute the client's Playwright config names as its test id attribute
    ✓ Every other data-* attribute is listed as data_<name> (hyphens become underscores) when its name is lower-case
      letters, digits and hyphens (at most 60 after `data-`): a name with `_` could not be told from its hyphenated twin,
      and any other name would be refused by the service's schema
    ✓ `name` is aria-label, else the element's own copy; `text` is the element's own copy; `disabled` and `hidden` flags
    ✓ `pw_text` is the element's text as Playwright's has_text reads it (no separator between elements, hidden text
      included, at most 200 characters) and `pw_cut` says it is incomplete (longer, too big, or holding a textarea, a
      select or an editable region, whose text is never read)
    ✓ No ref: the service numbers the items (e0, e1, ...) in the order they come back
    ✓ At most MAX (500) items; `more` counts the ones left out, so the service knows the list is not complete
    ✓ `page`: path (no query or hash: they can carry tokens), lang, browser_lang, viewport, scroll, dpr

Environment Variables:
    None.

Author: PMAC
===============================================================================
*/
(only) => {
  const sel = 'iframe,input,select,textarea,button,a,summary,[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable],'
    + '[role],[id],[data-testid],[data-test],[data-qa],[data-cy]';
  const MAX = 500;
  const items = []; let more = 0;
  // control characters (line breaks included) become a space: a value cannot break a line in a prompt or a log
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
  const cl = s => String(s == null ? '' : s).slice(0, 2000).replace(CONTROL, ' ');
  const clean = s => cl(s).replace(/\s+/g, ' ').trim();
  const SECRETISH = /token|csrf|auth|session|secret|email|password/i;
  const VALUE_TAGS = /^(input|textarea|select|script|style|template|noscript)$/i;   // their content is a value or markup
  const hasData = el => el.getAttributeNames().some(n => n.startsWith('data-'));
  const HOOKS = ['data-qa', 'data-testid', 'data-test', 'data-cy', 'id'];
  // [value, attribute] of the element's first hook in HOOKS order, or ['', '']
  const hookOf = el => {
    for (const a of HOOKS) {
      const v = clean(a === 'id' ? el.id : el.getAttribute(a));
      if (v) return [v, a];
    }
    return ['', ''];
  };
  const rowOf = el => {
    for (let p = el.parentElement, n = 0; p && n < 100; p = p.parentElement, n++) {     // bounded: a page can clobber it
      const [h, a] = hookOf(p);
      if (h) return [h.slice(0, 80), a];
    }
    return ['', ''];
  };
  // The copy of a node: its text nodes, with the subtrees of form controls, contenteditable regions, text-entry roles and display:none
  // elements left out. Block boundaries read as a space, inline ones do not ("Sa<b>ve</b>" is "Save"). Bounded in
  // length and depth: it is the one place text is read from a page, so it is the one place a value could slip in.
  // a text-entry widget by any token of its role (Playwright reads role as a token list): its text may be typed data
  const ENTRY_ROLE = /(^|\s)(textbox|searchbox|combobox|spinbutton|slider)(?=\s|$)/i;
  const copy = (node, win, depth = 0) => {
    let out = '';
    for (const c of node.childNodes) {
      if (out.length > 400 || depth > 30) break;
      if (c.nodeType === 3) { out += c.nodeValue; continue; }
      if (c.nodeType !== 1 || VALUE_TAGS.test(c.tagName) || c.isContentEditable || ENTRY_ROLE.test(c.getAttribute('role') || '')) continue;
      const d = win.getComputedStyle(c).display;
      if (d === 'none') continue;
      const inner = copy(c, win, depth + 1);
      out += d.startsWith('inline') ? inner : ' ' + inner + ' ';
    }
    return out;
  };
  const ownCopy = (el, win, raw = false) => {
    if (VALUE_TAGS.test(el.tagName) && !(/^input$/i.test(el.tagName) && /^(button|submit|reset)$/i.test(el.type))) return '';
    if (/^input$/i.test(el.tagName)) {
      const inputLabel = String(el.value || '');                  // a button / submit / reset input's label is its value
      return raw ? inputLabel : clean(inputLabel).slice(0, 80);
    }
    if (el.isContentEditable || ENTRY_ROLE.test(el.getAttribute('role') || '')) return '';
    return clean(copy(el, win)).slice(0, 80);
  };
  // The text Playwright's has_text reads, so the service can prove a .filter(has_text=...) from the listing: text nodes and
  // every descendant's text joined with no separator, hidden ones included, a button / submit / reset input's raw label,
  // open shadow roots; HTML script, style and noscript skipped (Playwright's test is the upper-case name, so an SVG
  // <style> is read); whitespace collapsed as Playwright does. At most PW_CHARS; `pw_cut` when it is longer, too big to
  // walk, or holds a textarea, a select, an editable region or a text-entry widget role (their text can be typed or
  // chosen data, so it is never read): the service then cannot say the text is NOT there. Hidden text is read because
  // has_text reads it; a text holding a token-like run (24+ letters and digits) is not sent at all (pw_cut, empty).
  const PW_CHARS = 200, PW_NODES = 2000, PW_RAW = 2000;
  const pwText = (el, win) => {
    let raw = '', nodes = 0, cut = false;
    const walk = n => {
      if (cut) return;
      if (++nodes > PW_NODES || raw.length > PW_RAW) { cut = true; return; }
      if (n.nodeType === 3) { raw += n.nodeValue || ''; return; }
      if (n.nodeType === 1) {
        if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE' || n.tagName === 'NOSCRIPT') return;
        if (/^(textarea|select)$/i.test(n.tagName) || n.isContentEditable
            || ENTRY_ROLE.test(n.getAttribute('role') || '')) { cut = true; return; }
        if (/^input$/i.test(n.tagName)) {
          if (/^(button|submit|reset)$/i.test(n.type)) raw += ownCopy(n, win, true);
          return;
        }
      } else if (n.nodeType !== 11) {
        return;
      }
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
      if (n.nodeType === 1 && n.shadowRoot) walk(n.shadowRoot);
    };
    walk(el);
    const t = raw.replace(/\u200b/g, '').trim().replace(/\s+/g, ' ');
    if (t.split(' ').some(w => w.length >= 24 && /\d/.test(w) && /[A-Za-z]/.test(w))) return {pw_text: '', pw_cut: true};
    return {pw_text: t.slice(0, PW_CHARS), pw_cut: cut || t.length > PW_CHARS};
  };
  const describeOnly = only instanceof Element;      // called through locator.evaluate: just that element
  const queue = [{root: document, frame: '', shadow: [], ox: window.scrollX, oy: window.scrollY}];
  while (queue.length) {
    const {root, frame, shadow, ox, oy} = queue.shift();
    for (const el of root.querySelectorAll('*')) {
      if (/^(script|style|template|noscript)$/i.test(el.tagName)) continue;
      if (el.shadowRoot) queue.push({root: el.shadowRoot, frame, shadow: shadow.concat(el.tagName.toLowerCase()), ox, oy});
      if (el.tagName === 'IFRAME') {
        try {
          const d = el.contentDocument;
          if (d) {
            const fr = el.getBoundingClientRect();
            queue.push({root: d, frame: clean(el.getAttribute('name') || el.id || 'iframe').slice(0, 80), shadow: [],
              ox: fr.left + ox + el.clientLeft, oy: fr.top + oy + el.clientTop});
          }
        } catch (_) { /* a cross-origin frame cannot be read from here */ }
      }
      const win = el.ownerDocument.defaultView || window;
      const pointer = el => win.getComputedStyle(el).cursor === 'pointer';
      const clickable = el => !!el.parentElement && el.tagName !== 'BODY' && pointer(el) && !pointer(el.parentElement);
      if (describeOnly ? el !== only : !(el.matches(sel) || hasData(el) || clickable(el))) continue;
      if (items.length >= MAX) { more++; continue; }
      const r = el.getBoundingClientRect(), cs = win.getComputedStyle(el);
      const hidden = !(r.width || r.height) || cs.visibility === 'hidden' || cs.display === 'none';
      const labels = el.labels ? Array.from(el.labels).map(l => clean(copy(l, win))).join(' ') : '';
      const byIds = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(i => el.getRootNode().getElementById ? el.getRootNode().getElementById(i) : null).filter(Boolean)
        .map(n => clean(copy(n, win))).join(' ');
      const at = n => cl(String(el.getAttribute(n) || '').slice(0, 400)).trim().slice(0, 200);
      const text = ownCopy(el, win);
      const item = {tag: el.tagName.toLowerCase(), type: at('type'), role: at('role'),
        name: clean(at('aria-label') || text).slice(0, 80),
        aria_label: at('aria-label').slice(0, 80), label: (labels || byIds).slice(0, 80),
        placeholder: at('placeholder'), id: cl(el.id || '').slice(0, 200),
        testid: at('data-testid'), data_test: at('data-test'), data_qa: at('data-qa'), data_cy: at('data-cy'),
        class: at('class').slice(0, 120), name_attr: at('name'), title: at('title').slice(0, 80), alt: at('alt').slice(0, 80),
        text, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        hidden, box: hidden || !(r.width > 0 && r.height > 0) ? null
          : {x: r.left + ox, y: r.top + oy, width: r.width, height: r.height}};
      for (const n of el.getAttributeNames()) {
        // only names the key maps back to one way (no `_`: data-a_b and data-a-b would share data_a_b) and the service accepts
        if (/^data-[a-z0-9-]{1,60}$/.test(n) && !['data-testid', 'data-test', 'data-qa', 'data-cy'].includes(n) && !SECRETISH.test(n)) {
          item['data_' + n.slice(5).replace(/-/g, '_')] = at(n).slice(0, 80);
        }
      }
      // Whether this element (or something inside it) is what a click at its box centre would hit. The service's
      // place proof needs it: a box alone can be taken over by another element moved into the freed spot. Only for a
      // centre inside the element's own viewport; off-screen is unknown, not false.
      if (item.box) {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx >= 0 && cy >= 0 && cx < win.innerWidth && cy < win.innerHeight) {
          const rootNode = el.getRootNode();
          const hit = (rootNode.elementFromPoint ? rootNode : el.ownerDocument).elementFromPoint(cx, cy);
          item.top_at_center = !!hit && (hit === el || el.contains(hit));
        }
      }
      const [row, rowAttr] = rowOf(el);
      if (row) { item.row = row; item.row_attr = rowAttr; }
      if (frame) item.frame = frame;
      if (shadow.length) item.shadow = shadow.join(' >> ');
      Object.assign(item, pwText(el, win));
      items.push(item);
    }
  }
  const page = {path: clean(location.pathname).slice(0, 200), lang: clean(document.documentElement.lang).slice(0, 35),
    browser_lang: clean(navigator.language).slice(0, 35),
    viewport: {width: window.innerWidth, height: window.innerHeight}, scroll: {x: window.scrollX, y: window.scrollY},
    dpr: window.devicePixelRatio};
  return {items, more, page};
}
