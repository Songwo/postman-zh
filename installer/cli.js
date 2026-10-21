'use strict';
// 用法（推荐直接双击 install.bat / uninstall.bat）：
//   node installer/cli.js install   [--path <app.asar>] [--yes]
//   node installer/cli.js uninstall [--path <app.asar>] [--yes]
//   node installer/cli.js status
// 不需要装 Node.js：bat 脚本会用 Postman 自带的 Electron（ELECTRON_RUN_AS_NODE=1）来跑本脚本。

process.noAsar = true;

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const patcher = require('../src/patcher');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const cmd = args[0] || 'install';
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] || true : undefined;
};

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`读取 ${path.relative(ROOT, p)} 失败：${e.message}`);
  }
}

function listJSON(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch (_) {
    return [];
  }
}

// 英文纯文本 -> 中文，供 DOM 层兜底翻译写死的英文
function deriveDom(en, zh, out) {
  if (!en || !zh || typeof en !== 'object' || typeof zh !== 'object') return;
  for (const k of Object.keys(zh)) {
    const e = en[k];
    const z = zh[k];
    if (typeof e === 'string' && typeof z === 'string') {
      const t = e.trim();
      if (t.length > 1 && z.trim() && /[A-Za-z]/.test(t) && !/[{}<>]/.test(e) && !/[{}<>]/.test(z) && !(t in out)) out[t] = z.trim();
    } else if (e && typeof e === 'object') {
      deriveDom(e, z, out);
    }
  }
}

function buildBundle() {
  const pkg = readJSON(path.join(ROOT, 'package.json'));
  const zhDir = path.join(ROOT, 'locales', 'zh-CN');
  const enDir = path.join(ROOT, 'locales', 'en-US');
  const catalog = {};
  const derived = {};
  for (const f of listJSON(zhDir)) {
    const ns = f.slice(0, -5);
    catalog[ns] = readJSON(path.join(zhDir, f));
    deriveDom(readJSON(path.join(enDir, f), {}), catalog[ns], derived);
  }
  const manual = {};
  for (const f of listJSON(path.join(ROOT, 'dict', 'dom'))) Object.assign(manual, readJSON(path.join(ROOT, 'dict', 'dom', f)));
  const dom = Object.assign(derived, manual);
  for (const word of readJSON(path.join(ROOT, 'dict', 'exclude.json'), [])) delete dom[word];

  const meta = { version: pkg.version, skip: readJSON(path.join(ROOT, 'dict', 'skip-selectors.json'), []) };
  const bundle = {
    'meta.json': Buffer.from(JSON.stringify(meta)),
    'catalog.json': Buffer.from(JSON.stringify(catalog)),
    'dom.json': Buffer.from(JSON.stringify(dom)),
    'patterns.json': Buffer.from(JSON.stringify(readJSON(path.join(ROOT, 'dict', 'patterns.json'), []))),
  };
  for (const f of ['runtime.js', 'preload.js', 'main-hook.js', 'patcher.js', 'asar.js']) {
    bundle[f] = fs.readFileSync(path.join(ROOT, 'src', f));
  }
  return { bundle, meta, stats: { namespaces: Object.keys(catalog).length, dom: Object.keys(dom).length } };
}

function ask(question) {
  if (opt('--yes')) return true;
  process.stdout.write(question + ' [Y/n] ');
  const buf = Buffer.alloc(256);
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch (_) {
    return true;
  }
  const a = buf.toString('utf8', 0, n).trim().toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

function runningPostmanPids() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FO CSV /NH /FI "IMAGENAME eq Postman.exe"', { encoding: 'utf8' });
      return out.split(/\r?\n/).map((l) => l.split('","')[1]).filter(Boolean).map(Number).filter((p) => p && p !== process.pid);
    }
    const out = execSync('pgrep -x Postman || pgrep -f "Postman.app/Contents/MacOS/Postman" || true', { encoding: 'utf8' });
    return out.split(/\s+/).map(Number).filter((p) => p && p !== process.pid);
  } catch (_) {
    return [];
  }
}

function ensurePostmanClosed() {
  const pids = runningPostmanPids();
  if (!pids.length) return;
  if (!ask('检测到 Postman 正在运行，需要先关闭它。是否现在关闭？（请确认没有未保存的内容）')) {
    throw new Error('已取消。请手动退出 Postman 后再运行。');
  }
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    } catch (_) {}
  }
  const until = Date.now() + 5000;
  while (runningPostmanPids().length && Date.now() < until) execSync(process.platform === 'win32' ? 'ping -n 2 127.0.0.1 >nul' : 'sleep 1');
}

function targets() {
  const p = opt('--path');
  if (typeof p === 'string') return [{ asar: path.resolve(p), version: '' }];
  const all = patcher.findInstalls();
  if (!all.length) throw new Error('没有找到 Postman 安装目录。可以用 --path 指定 app.asar 的完整路径。');
  return all;
}

function main() {
  console.log('Postman 汉化插件 (postman-zh)\n');
  if (cmd === 'status') {
    for (const t of targets()) {
      const s = patcher.status(t.asar);
      console.log(`${t.version || '?'}\t${s ? `已汉化 v${(s.meta && s.meta.version) || '?'}` : '未汉化'}\t${t.asar}`);
    }
    return;
  }
  if (cmd !== 'install' && cmd !== 'uninstall') throw new Error(`未知命令：${cmd}`);

  const list = targets();
  const installed = new Set(patcher.findInstalls().map((i) => path.resolve(i.asar).toLowerCase()));
  if (list.some((t) => installed.has(path.resolve(t.asar).toLowerCase()))) ensurePostmanClosed();

  if (cmd === 'install') {
    const { bundle, meta, stats } = buildBundle();
    console.log(`语言包：${stats.namespaces} 个模块，界面词条 ${stats.dom} 条\n`);
    for (const t of list) {
      process.stdout.write(`正在汉化 Postman ${t.version} ... `);
      const r = patcher.patch(t.asar, bundle, meta);
      console.log(`完成（挂载：${r.hooked.join(', ')}）`);
    }
    console.log('\n全部完成！现在可以正常打开 Postman 了。');
    console.log('提示：请保持 Postman 设置里的语言为 English，汉化会自动替换成中文。');
  } else {
    for (const t of list) {
      process.stdout.write(`正在还原 Postman ${t.version} ... `);
      console.log(patcher.unpatch(t.asar) ? '已还原' : '未汉化，跳过');
    }
    console.log('\n已恢复为英文原版。');
  }
}

try {
  main();
} catch (e) {
  console.error('\n出错了：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
}
