'use strict';
// 语言包维护工具（需要 Node.js 18+）
//   node tools/i18n.js fetch [--manifest <url>]   从 Postman 拉取最新英文语言包到 locales/en-US（默认从正在运行的 Postman 读取清单地址）
//   node tools/i18n.js export [ns...] [--limit N] 导出未翻译词条到 work/<ns>.txt，每行 "序号<TAB>英文"
//   node tools/i18n.js import [ns...]             读取 work/<ns>.zh.txt（每行 "序号<TAB>中文"），校验后写入 locales/zh-CN
//   node tools/i18n.js check                      校验全部译文的占位符 / 标签是否与英文一致
//   node tools/i18n.js stats                      查看各模块翻译进度

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EN = path.join(ROOT, 'locales', 'en-US');
const ZH = path.join(ROOT, 'locales', 'zh-CN');
const WORK = path.join(ROOT, 'work');

const args = process.argv.slice(2);
const cmd = args.shift();
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  else positional.push(args[i]);
}

const readJSON = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (fb !== undefined) return fb; throw e; }
};
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const namespaces = () => fs.readdirSync(EN).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

function flatten(obj, prefix = [], out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'string') out.push([prefix.concat(k), v]);
    else if (v && typeof v === 'object') flatten(v, prefix.concat(k), out);
  }
  return out;
}
const getIn = (o, keys) => keys.reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), o);
function setIn(o, keys, v) {
  let n = o;
  for (const k of keys.slice(0, -1)) n = n[k] = n[k] && typeof n[k] === 'object' ? n[k] : {};
  n[keys[keys.length - 1]] = v;
}
// 按英文文件的 key 顺序重排译文，方便 diff
function ordered(en, zh) {
  const out = {};
  for (const [k, v] of Object.entries(en)) {
    if (!(k in zh)) continue;
    if (v && typeof v === 'object') {
      const sub = ordered(v, zh[k] || {});
      if (Object.keys(sub).length) out[k] = sub;
    } else if (typeof zh[k] === 'string') out[k] = zh[k];
  }
  return out;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
const unesc = (s) => s.replace(/\\(\\|n|t)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));

// 占位符签名：ICU 变量名集合 + 富文本标签集合，中英文必须一致
// 简易 ICU 解析：收集参数名，跳过 plural/select 的分支关键字（分支内容可以自由翻译）
function icuVars(s) {
  const vars = new Set();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function message(nested) {
    while (i < s.length) {
      const c = s[i];
      if (c === '}' && nested) return;
      if (c === '{') arg();
      else i++;
    }
  }
  function arg() {
    i++;
    if (s[i] === '{') { // i18next 风格 {{name}}
      const end = s.indexOf('}}', i);
      vars.add(s.slice(i + 1, end < 0 ? s.length : end).trim());
      i = end < 0 ? s.length : end + 2;
      return;
    }
    ws();
    let name = '';
    while (i < s.length && !/[\s,}]/.test(s[i])) name += s[i++];
    vars.add(name);
    ws();
    if (s[i] === '}') { i++; return; }
    if (s[i] !== ',') { message(true); i++; return; }
    i++; ws();
    let type = '';
    while (i < s.length && /\w/.test(s[i])) type += s[i++];
    ws();
    if (/^(plural|select|selectordinal)$/.test(type)) {
      if (s[i] === ',') i++;
      while (i < s.length) {
        ws();
        if (s[i] === '}') { i++; return; }
        while (i < s.length && !/[\s{]/.test(s[i])) i++; // 分支关键字 / offset:1
        ws();
        if (s[i] === '{') { i++; message(true); i++; }
      }
    } else {
      let depth = 1;
      while (i < s.length && depth) { if (s[i] === '{') depth++; else if (s[i] === '}') depth--; i++; }
    }
  }
  message(false);
  return vars;
}

// 英文专用的变量（冠词 a/an 等）在中文里可以省略
const DROPPABLE_VARS = new Set(['article']);

function signature(s) {
  const vars = icuVars(s);
  for (const v of DROPPABLE_VARS) vars.delete(v);
  const tags = new Set();
  for (const m of s.matchAll(/<\s*(\/?)\s*([A-Za-z0-9][\w.-]*)[^>]*?(\/?)>/g)) tags.add(m[1] + m[2] + m[3]);
  return [...vars].sort().join(',') + ' | ' + [...tags].sort().join(',');
}
function braceBalanced(s) {
  let d = 0;
  for (const c of s) {
    if (c === '{') d++;
    else if (c === '}' && --d < 0) return false;
  }
  return d === 0;
}
function problem(en, zh) {
  if (!zh.trim()) return '译文为空';
  if (!braceBalanced(zh)) return '花括号不配对';
  if (signature(en) !== signature(zh)) return `占位符/标签不一致：英文 [${signature(en)}] 中文 [${signature(zh)}]`;
  return null;
}

async function cdpManifestUrl() {
  const port = fs.readFileSync(path.join(process.env.APPDATA || path.join(require('os').homedir(), 'Library/Application Support'), 'Postman', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /postman\.com/.test(t.url));
  if (!page) throw new Error('没有找到正在运行的 Postman 页面，请先打开 Postman 或用 --manifest 指定地址');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const expr = `performance.getEntriesByType('resource').map(e=>e.name).find(u=>u.includes('locale-asset-manifest'))`;
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== 1) return;
      ws.close();
      const v = d.result && d.result.result && d.result.result.value;
      v ? resolve(v) : reject(new Error('页面里没有找到 locale-asset-manifest，请用 --manifest 指定'));
    };
    ws.onerror = reject;
  });
}

async function cmdFetch() {
  const manifestUrl = typeof flags.manifest === 'string' ? flags.manifest : await cdpManifestUrl();
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/'));
  console.log('清单：' + manifestUrl);
  const manifest = await (await fetch(manifestUrl)).json();
  fs.mkdirSync(EN, { recursive: true });
  let added = 0, changed = 0, files = 0;
  const stale = [];
  for (const rel of Object.values(manifest)) {
    if (!rel.startsWith('/locales/en-US/')) continue;
    const ns = rel.replace('/locales/en-US/', '').replace(/-[0-9a-f]{8,}\.json$/, '');
    const res = await fetch(base + rel);
    if (!res.ok) { console.warn(`  跳过 ${ns}: HTTP ${res.status}`); continue; }
    const next = await res.json();
    const prev = readJSON(path.join(EN, ns + '.json'), {});
    const zh = readJSON(path.join(ZH, ns + '.json'), {});
    for (const [keys, v] of flatten(next)) {
      const old = getIn(prev, keys);
      if (old === undefined) added++;
      else if (old !== v) {
        changed++;
        if (getIn(zh, keys) !== undefined) stale.push(`${ns}:${keys.join('.')}`);
      }
    }
    writeJSON(path.join(EN, ns + '.json'), next);
    files++;
  }
  console.log(`已更新 ${files} 个模块，新增 ${added} 条，英文改动 ${changed} 条`);
  if (stale.length) {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, 'stale.txt'), stale.join('\n') + '\n');
    console.log(`其中 ${stale.length} 条已有译文的英文原文变了，列表见 work/stale.txt，请复核`);
  }
}

function cmdExport() {
  fs.mkdirSync(WORK, { recursive: true });
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  let total = 0;
  for (const ns of positional.length ? positional : namespaces()) {
    const en = readJSON(path.join(EN, ns + '.json'));
    const zh = readJSON(path.join(ZH, ns + '.json'), {});
    const todo = flatten(en).filter(([k]) => getIn(zh, k) === undefined).slice(0, limit);
    if (!todo.length) continue;
    fs.writeFileSync(path.join(WORK, ns + '.txt'), todo.map(([, v], i) => `${i}\t${esc(v)}`).join('\n') + '\n');
    writeJSON(path.join(WORK, ns + '.keys.json'), todo.map(([k]) => k));
    total += todo.length;
    console.log(`${ns}: ${todo.length}`);
  }
  console.log(`共导出 ${total} 条待翻译词条到 work/`);
}

function cmdImport() {
  const list = positional.length ? positional : fs.readdirSync(WORK).filter((f) => f.endsWith('.zh.txt')).map((f) => f.slice(0, -7));
  let ok = 0, bad = 0;
  for (const ns of list) {
    const en = readJSON(path.join(EN, ns + '.json'));
    const zh = readJSON(path.join(ZH, ns + '.json'), {});
    const keys = readJSON(path.join(WORK, ns + '.keys.json'));
    const lines = fs.readFileSync(path.join(WORK, ns + '.zh.txt'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = /^(\d+)\t(.*)$/.exec(line);
      if (!m) continue;
      const k = keys[Number(m[1])];
      const source = k && getIn(en, k);
      if (typeof source !== 'string') { console.warn(`  ${ns}#${m[1]}: 序号不存在`); bad++; continue; }
      const text = unesc(m[2]);
      const p = problem(source, text);
      if (p) { console.warn(`  ${ns}#${m[1]} ${k.join('.')}: ${p}`); bad++; continue; }
      setIn(zh, k, text);
      ok++;
    }
    fs.mkdirSync(ZH, { recursive: true });
    writeJSON(path.join(ZH, ns + '.json'), ordered(en, zh));
  }
  console.log(`导入 ${ok} 条，跳过 ${bad} 条有问题的译文`);
  if (bad) process.exitCode = 1;
}

function cmdCheck() {
  let bad = 0, n = 0;
  for (const ns of namespaces()) {
    const en = readJSON(path.join(EN, ns + '.json'));
    const zh = readJSON(path.join(ZH, ns + '.json'), null);
    if (!zh) continue;
    for (const [k, v] of flatten(zh)) {
      n++;
      const source = getIn(en, k);
      if (typeof source !== 'string') { console.warn(`${ns}:${k.join('.')}: 英文里已不存在（可删除）`); continue; }
      const p = problem(source, v);
      if (p) { console.warn(`${ns}:${k.join('.')}: ${p}`); bad++; }
    }
  }
  console.log(`检查 ${n} 条译文，${bad} 条有问题`);
  if (bad) process.exitCode = 1;
}

function cmdStats() {
  let all = 0, done = 0;
  const rows = [];
  for (const ns of namespaces()) {
    const total = flatten(readJSON(path.join(EN, ns + '.json'))).length;
    const zh = flatten(readJSON(path.join(ZH, ns + '.json'), {})).length;
    all += total; done += zh;
    rows.push([ns, zh, total]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  for (const [ns, zh, total] of rows) console.log(`${String(Math.round((zh / total) * 100)).padStart(3)}%  ${String(zh).padStart(5)}/${String(total).padEnd(5)} ${ns}`);
  console.log(`\n总计 ${done}/${all}（${((done / all) * 100).toFixed(1)}%）`);
}

const commands = { fetch: cmdFetch, export: cmdExport, import: cmdImport, check: cmdCheck, stats: cmdStats };
if (!commands[cmd]) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(commands[cmd]()).catch((e) => { console.error(e.message || e); process.exit(1); });
