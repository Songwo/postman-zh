'use strict';
// 由 preload_desktop.js 第一行 require。Postman 主窗口 contextIsolation=false，
// 所以这里的 window 就是页面的 window，能赶在页面脚本之前装好语言包拦截。

const fs = require('fs');
const path = require('path');

function isPostmanPage(loc) {
  if (!loc) return false;
  if (loc.protocol === 'file:') return true;
  return /(^|\.)(postman\.com|postman\.co|getpostman\.com|pstmn\.io)$/i.test(loc.hostname);
}

function readJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
}

if (process.env.POSTMAN_ZH !== '0' && typeof window !== 'undefined' && !window.__PM_ZH__ && isPostmanPage(window.location)) {
  try {
    const meta = readJSON('meta.json');
    require('./runtime.js')(window, {
      version: meta.version,
      catalog: readJSON('catalog.json'),
      dom: readJSON('dom.json'),
      patterns: readJSON('patterns.json'),
      skip: meta.skip,
    });
  } catch (e) {
    console.error('[postman-zh] preload failed', e);
  }
}
