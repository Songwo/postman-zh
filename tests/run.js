'use strict';
// 无依赖的测试：node tests/run.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const asar = require('../src/asar');
const patcher = require('../src/patcher');

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack : e));
  }
}

// 用自己的 writer 造一个最小的 asar：package.json / main.js / preload_desktop.js / sub/a.txt
function makeAsar(file) {
  const files = {
    'package.json': Buffer.from('{"name":"Postman","version":"9.9.9","main":"main.js"}'),
    'main.js': Buffer.from('module.exports = "main";\n'),
    'preload_desktop.js': Buffer.from('window.x = 1;\n'),
    'sub/a.txt': Buffer.from('hello'),
  };
  const header = { files: {} };
  const bufs = [];
  let off = 0;
  for (const [p, buf] of Object.entries(files)) {
    asar.setEntry(header, p, { size: buf.length, offset: String(off), integrity: asar.integrity(buf) });
    bufs.push(buf);
    off += buf.length;
  }
  fs.writeFileSync(file, Buffer.concat([asar.encodeHeader(header), ...bufs]));
}

function read(file, p) {
  const info = asar.readHeader(file);
  return asar.readEntry(file, info, asar.getEntry(info.header, p)).toString('utf8');
}

(async () => {
  console.log('asar / patcher');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-zh-test-'));
  const file = path.join(dir, 'app.asar');
  makeAsar(file);
  const original = fs.readFileSync(file);
  const bundle = { 'meta.json': Buffer.from('{"version":"t"}'), 'runtime.js': Buffer.from('//rt') };

  await test('patch 挂载两个入口并写入 bundle', () => {
    const r = patcher.patch(file, bundle, { version: 't' });
    assert.deepStrictEqual(r.hooked.sort(), ['main.js', 'preload_desktop.js']);
    assert.ok(read(file, 'main.js').startsWith('try{require("./postman-zh/main-hook.js")}'));
    assert.ok(read(file, 'main.js').endsWith('module.exports = "main";\n'));
    assert.ok(read(file, 'preload_desktop.js').includes('require("./postman-zh/preload.js")'));
    assert.strictEqual(read(file, 'postman-zh/runtime.js'), '//rt');
    assert.strictEqual(read(file, 'sub/a.txt'), 'hello');
    assert.strictEqual(patcher.status(file).meta.version, 't');
  });

  await test('重复 patch 不会叠加 hook', () => {
    patcher.patch(file, bundle, { version: 't2' });
    const main = read(file, 'main.js');
    assert.strictEqual(main.split('postman-zh/main-hook.js').length, 2);
    assert.strictEqual(patcher.status(file).meta.version, 't2');
  });

  await test('readBundle 能取回 bundle（不含 state.json）', () => {
    const b = patcher.readBundle(file);
    assert.deepStrictEqual(Object.keys(b).sort(), ['meta.json', 'runtime.js']);
  });

  await test('unpatch 后与原文件逐字节一致', () => {
    assert.strictEqual(patcher.unpatch(file), true);
    assert.ok(fs.readFileSync(file).equals(original));
    assert.strictEqual(patcher.status(file), null);
    assert.strictEqual(patcher.unpatch(file), false);
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('runtime');
  await test('fetch 拦截按 key 合并中文，并生成 DOM 词条', async () => {
    const install = require('../src/runtime');
    const en = { a: 'Save', nested: { b: 'Send {count} items', c: 'Keep' }, extra: 'Only EN' };
    const zh = { a: '保存', nested: { b: '发送 {count} 项' }, unknown: '不存在的 key' };
    const fakeWindow = {
      fetch: async () => new Response(JSON.stringify(en), { status: 200 }),
      document: { documentElement: null },
      MutationObserver: class { observe() {} },
    };
    install(fakeWindow, { version: 't', catalog: { 'app-header': zh }, dom: {}, patterns: [] });
    const res = await fakeWindow.fetch('https://x/_ar-assets/locales/en-US/app-header-a866b9f6d88ae1bd.json');
    const out = await res.json();
    assert.deepStrictEqual(out, { a: '保存', nested: { b: '发送 {count} 项', c: 'Keep' }, extra: 'Only EN' });
    assert.strictEqual(fakeWindow.__PM_ZH__.dict.get('Save'), '保存');
    assert.ok(!fakeWindow.__PM_ZH__.dict.has('Send {count} items'));
    const other = await (await fakeWindow.fetch('https://x/_ar-assets/locales/ja/app-header-a866b9f6d88ae1bd.json')).json();
    assert.strictEqual(other.a, 'Save');
  });

  console.log('语言包');
  await test('所有译文占位符一致', () => {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'i18n.js'), 'check'], { stdio: 'pipe' });
  });

  console.log(failed ? `\n${failed} 个测试失败` : '\n全部通过');
  process.exitCode = failed ? 1 : 0;
})();
