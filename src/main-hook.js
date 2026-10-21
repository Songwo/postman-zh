'use strict';
// 由 Postman 主进程入口（main.js）第一行 require。
// 1. 给没走 preload_desktop.js 的窗口（控制台、Runner、本地 Scratch Pad 等）在 dom-ready 时注入 DOM 层。
// 2. Postman 自动更新会下载到新的 app-x.y.z 目录；退出时把汉化补丁顺带打到新版本上，升级后不掉汉化。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

if (process.env.POSTMAN_ZH !== '0') {
  const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
  let injectCode = null;
  const getInjectCode = () => {
    if (injectCode === null) {
      const meta = JSON.parse(read('meta.json'));
      const data = { version: meta.version, catalog: {}, dom: JSON.parse(read('dom.json')), patterns: JSON.parse(read('patterns.json')), skip: meta.skip };
      injectCode = `;(function(){if(window.__PM_ZH__)return;var module={exports:{}};${read('runtime.js')}\n;module.exports(window,${JSON.stringify(data)});})();`;
    }
    return injectCode;
  };

  const allowed = (url) => /^file:/i.test(url) || /^https:\/\/([a-z0-9-]+\.)*(postman\.com|postman\.co|getpostman\.com)(\/|$)/i.test(url);

  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType && wc.getType() === 'devtools') return;
    wc.on('dom-ready', () => {
      try {
        if (!allowed(wc.getURL())) return;
        wc.executeJavaScript(getInjectCode(), false).catch(() => {});
      } catch (_) {}
    });
  });

  app.on('will-quit', () => {
    try {
      const patcher = require('./patcher.js');
      const self = path.resolve(__dirname, '..');
      const current = patcher.findInstalls().find((i) => path.resolve(i.asar) === self);
      if (!current) return;
      let bundle = null;
      for (const inst of patcher.findInstalls()) {
        if (patcher.compareVersions(inst.version, current.version) <= 0) continue;
        if (patcher.status(inst.asar)) continue;
        bundle = bundle || patcher.readBundle(self);
        patcher.patch(inst.asar, bundle, JSON.parse(bundle['meta.json'].toString('utf8')));
      }
    } catch (e) {
      console.error('[postman-zh] auto patch failed', e);
    }
  });
}
