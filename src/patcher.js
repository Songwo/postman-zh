'use strict';
// 给 Postman 的 app.asar 打 / 撤销汉化补丁。
// 补丁是可逆的：原始数据区一个字节都不改，只是在末尾追加我们的文件，
// 并把两个入口文件（主进程入口、preload_desktop.js）指向“前置一行 require + 原内容”的新副本。
// 原始入口记录在 postman-zh/state.json 里，卸载时据此还原并截掉追加的数据。

const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('./asar');

const MARK = 'postman-zh';

function hookLine(file) {
  return `try{require("./${MARK}/${file}")}catch(e){console.error("[postman-zh]",e)}\n`;
}

function mainEntryOf(info, file) {
  const pkg = asar.getEntry(info.header, 'package.json');
  if (!pkg) return 'main.js';
  try {
    const main = JSON.parse(asar.readEntry(file, info, pkg).toString('utf8')).main || 'index.js';
    return main.replace(/^\.\//, '');
  } catch (_) {
    return 'main.js';
  }
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// 读取当前补丁状态；未打补丁返回 null
function status(file) {
  const info = asar.readHeader(file);
  const dir = info.header.files[MARK];
  if (!dir) return null;
  try {
    const state = JSON.parse(asar.readEntry(file, info, dir.files['state.json']).toString('utf8'));
    return state;
  } catch (_) {
    return { broken: true };
  }
}

// 在内存中把 header 还原成未打补丁的样子，返回原始数据区长度
function revertInMemory(file, info) {
  const dir = info.header.files[MARK];
  if (!dir) return info.fileSize - info.dataOffset;
  const state = JSON.parse(asar.readEntry(file, info, dir.files['state.json']).toString('utf8'));
  for (const [p, entry] of Object.entries(state.entries)) asar.setEntry(info.header, p, entry);
  delete info.header.files[MARK];
  return state.dataLen;
}

function replaceFile(tmp, target) {
  asar.withNoAsar(() => {
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (e.code === 'EBUSY' || e.code === 'EPERM') {
        throw new Error('app.asar 正在被占用，请先完全退出 Postman（包括托盘图标）再试');
      }
      throw e;
    }
  });
}

// bundle: { 文件名: Buffer }，会放进 app.asar/postman-zh/ 目录
function patch(file, bundle, meta) {
  const info = asar.readHeader(file);
  const dataLen = revertInMemory(file, info);
  const header = info.header;

  const state = { dataLen, entries: {}, meta: meta || {}, patchedAt: new Date().toISOString() };
  const appends = [];
  let offset = dataLen;
  const add = (buf) => {
    const entry = { size: buf.length, offset: String(offset), integrity: asar.integrity(buf) };
    appends.push(buf);
    offset += buf.length;
    return entry;
  };

  const hooks = [
    [mainEntryOf(info, file), 'main-hook.js'],
    ['preload_desktop.js', 'preload.js'],
  ];
  const hooked = [];
  for (const [target, hookFile] of hooks) {
    const entry = asar.getEntry(header, target);
    if (!entry || entry.files || entry.unpacked) continue;
    state.entries[target] = clone(entry);
    const original = asar.readEntry(file, info, entry);
    asar.setEntry(header, target, add(Buffer.concat([Buffer.from(hookLine(hookFile)), original])));
    hooked.push(target);
  }
  if (!hooked.length) throw new Error('没有找到可挂载的入口文件，可能 Postman 版本结构已变化');

  const dir = { files: {} };
  for (const [name, buf] of Object.entries(bundle)) dir.files[name] = add(buf);
  dir.files['state.json'] = add(Buffer.from(JSON.stringify(state, null, 2)));
  header.files[MARK] = dir;

  const tmp = file + '.postman-zh.tmp';
  asar.writeArchive(file, info, header, dataLen, appends, tmp);
  verify(tmp, dataLen + appends.reduce((n, b) => n + b.length, 0));
  replaceFile(tmp, file);
  return { hooked };
}

function unpatch(file) {
  const info = asar.readHeader(file);
  if (!info.header.files[MARK]) return false;
  const dataLen = revertInMemory(file, info);
  const tmp = file + '.postman-zh.tmp';
  asar.writeArchive(file, info, info.header, dataLen, [], tmp);
  verify(tmp, dataLen);
  replaceFile(tmp, file);
  return true;
}

function verify(file, expectedDataLen) {
  const info = asar.readHeader(file);
  if (info.fileSize - info.dataOffset !== expectedDataLen) {
    try { asar.withNoAsar(() => fs.unlinkSync(file)); } catch (_) {}
    throw new Error('生成的 asar 校验失败，已放弃写入（原文件未改动）');
  }
  const pkg = asar.getEntry(info.header, 'package.json');
  if (pkg) JSON.parse(asar.readEntry(file, info, pkg).toString('utf8'));
}

// 从一个已打补丁的 asar 中读出我们的 bundle（用于 Postman 升级后自动给新版本打补丁）
function readBundle(file) {
  const info = asar.readHeader(file);
  const dir = info.header.files[MARK];
  if (!dir) return null;
  const bundle = {};
  for (const [name, entry] of Object.entries(dir.files)) {
    if (name === 'state.json' || entry.files) continue;
    bundle[name] = asar.readEntry(file, info, entry);
  }
  return bundle;
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// 找出本机所有 Postman 安装（按版本从新到旧）
function findInstalls() {
  const found = [];
  const push = (asarPath, version) => {
    if (asar.withNoAsar(() => fs.existsSync(asarPath))) found.push({ asar: asarPath, version: version || '' });
  };
  const scanSquirrel = (root) => {
    let names = [];
    try { names = asar.withNoAsar(() => fs.readdirSync(root)); } catch (_) { return; }
    for (const n of names) {
      const m = /^app-(\d+\.\d+\.\d+.*)$/.exec(n);
      if (m) push(path.join(root, n, 'resources', 'app.asar'), m[1]);
    }
  };

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const name of ['Postman', 'PostmanCanary', 'PostmanEnterprise']) scanSquirrel(path.join(local, name));
  } else if (process.platform === 'darwin') {
    for (const app of ['/Applications/Postman.app', path.join(os.homedir(), 'Applications/Postman.app')]) {
      push(path.join(app, 'Contents/Resources/app.asar'));
    }
  } else {
    for (const p of ['/opt/Postman/app/resources/app.asar', '/opt/postman/app/resources/app.asar',
      '/usr/share/postman/resources/app.asar', path.join(os.homedir(), 'Postman/app/resources/app.asar'),
      path.join(os.homedir(), '.local/share/Postman/app/resources/app.asar')]) push(p);
  }

  for (const f of found) {
    if (!f.version) {
      try {
        const info = asar.readHeader(f.asar);
        f.version = JSON.parse(asar.readEntry(f.asar, info, asar.getEntry(info.header, 'package.json'))).version || '';
      } catch (_) {}
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

module.exports = { MARK, patch, unpatch, status, readBundle, findInstalls, compareVersions };
