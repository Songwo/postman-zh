'use strict';
// 运行在 Postman 页面（主世界）里的汉化运行时。两层：
// 1. 语言包层：拦截 i18next 加载的 /locales/en-US/<ns>-<hash>.json，按 key 合并中文译文（支持 ICU 复数/插值）。
// 2. DOM 层：MutationObserver 兜底翻译 Postman 里写死、没有走 i18n 的英文文本和 placeholder/title 等属性。
// 注意：此文件也会被主进程以字符串形式 executeJavaScript 注入，所以不能 require 任何东西。

module.exports = function install(window, data) {
  if (!window || window.__PM_ZH__) return;
  window.__PM_ZH__ = { version: data.version };
  const document = window.document;
  const catalog = data.catalog || {};
  const dict = new Map(Object.entries(data.dom || {}));
  const patterns = (data.patterns || []).map((p) => [new RegExp('^(?:' + p[0] + ')$'), p[1]]);

  // ---------- 1. 语言包层 ----------
  const LOCALE_RE = /\/locales\/en-US\/([A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*?)(?:-[0-9a-f]{8,})?\.json(?:[?#]|$)/;
  const PLAIN = /^[^{}<>]*$/;

  function nsOf(url) {
    const m = LOCALE_RE.exec(String(url || ''));
    return m && catalog[m[1]] ? m[1] : null;
  }

  // 只覆盖英文里存在且类型一致的 key；顺手把“纯文本”的英文 -> 中文放进 DOM 词典
  function merge(en, zh) {
    if (!en || typeof en !== 'object' || !zh || typeof zh !== 'object') return en;
    const out = Array.isArray(en) ? en.slice() : Object.assign({}, en);
    for (const k of Object.keys(zh)) {
      const e = en[k];
      const z = zh[k];
      if (typeof e === 'string' && typeof z === 'string' && z) {
        out[k] = z;
        const t = e.trim();
        if (PLAIN.test(e) && PLAIN.test(z) && t.length > 1 && !dict.has(t)) dict.set(t, z.trim());
      } else if (e && typeof e === 'object') {
        out[k] = merge(e, z);
      }
    }
    return out;
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && (input.url || input.href);
      const ns = nsOf(url);
      const p = origFetch.apply(this, arguments);
      if (!ns) return p;
      return p.then((res) => {
        if (!res || !res.ok) return res;
        return res.clone().text().then((text) => {
          const body = JSON.stringify(merge(JSON.parse(text), catalog[ns]));
          const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
          try { Object.defineProperty(out, 'url', { value: res.url }); } catch (_) {}
          return out;
        }).catch(() => res);
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const proto = XHR.prototype;
    const origOpen = proto.open;
    proto.open = function (method, url) {
      this.__pmzhNs = nsOf(url);
      this.__pmzhOut = undefined;
      return origOpen.apply(this, arguments);
    };
    const translated = (xhr, raw) => {
      if (xhr.__pmzhOut === undefined) {
        try {
          xhr.__pmzhOut = merge(typeof raw === 'string' ? JSON.parse(raw) : raw, catalog[xhr.__pmzhNs]);
        } catch (_) {
          xhr.__pmzhOut = null;
        }
      }
      return xhr.__pmzhOut;
    };
    for (const name of ['responseText', 'response']) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.get) continue;
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          const raw = d.get.call(this);
          if (!this.__pmzhNs || this.readyState !== 4 || raw == null || raw === '') return raw;
          const obj = translated(this, raw);
          if (obj === null) return raw;
          return typeof raw === 'string' ? JSON.stringify(obj) : obj;
        },
      });
    }
  }

  // ---------- 2. DOM 层 ----------
  // 不翻译的区域：输入框、代码/编辑器、用户自己起的名字（侧边栏条目、标签页标题）等
  const SKIP = [
    'script', 'style', 'noscript', 'textarea', 'input', 'code', 'pre', 'kbd', 'samp',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '.monaco-editor', '.CodeMirror', '.cm-editor', '.notranslate', '[translate="no"]', '.pm-zh-skip',
    '[data-testid="sidebar-row-name"]', '[data-testid="requester-tabs"]',
  ].concat(data.skip || []).join(',');
  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-placeholder', 'alt'];
  const HAS_LETTER = /[A-Za-z]/;
  const cache = new Map();

  function lookup(t) {
    let z = dict.get(t);
    if (z !== undefined) return z;
    if (cache.has(t)) return cache.get(t);
    z = null;
    for (const [re, rep] of patterns) {
      if (re.test(t)) {
        z = t.replace(re, (...m) => rep.replace(/\$(\d)/g, (_, i) => {
          const g = m[+i] || '';
          return dict.get(g) || g;
        }));
        break;
      }
    }
    if (cache.size > 5000) cache.clear();
    cache.set(t, z);
    return z;
  }

  function translateString(s) {
    if (!s || s.length > 500 || !HAS_LETTER.test(s)) return null;
    const t = s.trim();
    const z = lookup(t);
    if (z == null || z === t) return null;
    const start = s.indexOf(t);
    return s.slice(0, start) + z + s.slice(start + t.length);
  }

  function skipped(el) {
    return !el || (el.closest && el.closest(SKIP));
  }

  function doText(node) {
    if (skipped(node.parentElement)) return;
    const z = translateString(node.nodeValue);
    if (z !== null) node.nodeValue = z;
  }

  function doAttrs(el) {
    if (el.closest(SKIP) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const z = translateString(v);
      if (z !== null) el.setAttribute(a, z);
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) {
      const z = translateString(el.value);
      if (z !== null) el.value = z;
    }
  }

  function walk(root) {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (root.closest(SKIP) && !root.matches('input,textarea')) return;
      doAttrs(root);
    }
    const it = document.createTreeWalker(root, 5 /* ELEMENT | TEXT */, {
      acceptNode(n) {
        if (n.nodeType === 1 && n.matches(SKIP)) {
          if (n.matches('input,textarea')) doAttrs(n);
          return 2; // REJECT：整棵子树都不碰
        }
        return 1;
      },
    });
    let n;
    while ((n = it.nextNode())) {
      if (n.nodeType === 3) {
        const z = translateString(n.nodeValue);
        if (z !== null) n.nodeValue = z;
      } else {
        doAttrs(n);
      }
    }
  }

  const observer = new window.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) walk(n);
      } else if (r.type === 'characterData') {
        doText(r.target);
      } else if (r.type === 'attributes') {
        doAttrs(r.target);
      }
    }
  });

  function start() {
    observer.observe(document, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
    if (document.documentElement) walk(document.documentElement);
  }
  start();

  window.__PM_ZH__.dict = dict;
  window.__PM_ZH__.retranslate = () => document.documentElement && walk(document.documentElement);
};
