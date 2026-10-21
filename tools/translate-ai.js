'use strict';
// 用 Claude 批量翻译还没有译文的词条（维护者工具，需要 npm install 和 Anthropic API 凭证）
//   node tools/translate-ai.js [ns...] [--batch 120] [--dry-run]
// 流程：i18n.js export -> 分批发给 Claude -> 写 work/<ns>.zh.txt -> i18n.js import（会校验占位符，有问题的条目会被跳过）
// 凭证：ANTHROPIC_API_KEY，或 `ant auth login` 登录后的配置文件，SDK 会自动读取。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'work');
const I18N = path.join(__dirname, 'i18n.js');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--dry-run'));
const BATCH = Number(flag('batch', 120));
const DRY = Boolean(flag('dry-run', false));
const MODEL = 'claude-opus-5-5';

// 统一术语，和已人工翻译的模块保持一致
const GLOSSARY = `Collection=集合, Folder=文件夹, Request=请求, Environment=环境, Globals=全局变量, Variable=变量,
Workspace=工作区, Headers=请求头（响应里为响应头）, Body=请求体（响应里为响应体）, Params=参数, Authorization=授权,
Pre-request Script=前置脚本, Post-response script=后置脚本, Tests=测试, Fork=复刻, Pull request=拉取请求,
Mock server=模拟服务器, Mock=模拟, Monitor=监视器, Flow=流程, Spec/Specification=规范, Runner=运行器,
Vault=保险库, Secret=密钥, Agent Mode=智能体模式, Agent(AI)=智能体, Desktop Agent=桌面代理, Cloud Agent=云端代理,
Team=团队, Partner=合作伙伴, Guest=访客, Editor=编辑者, Viewer=查看者, Insights=洞察, Dataset=数据集, Toolset=工具集,
Learn more=了解更多, Upgrade=升级, Retry=重试, Something went wrong=出了点问题。
保持英文：Postman, Postbot, API, URL, HTTP, GraphQL, gRPC, WebSocket, MQTT, OAuth, JSON, CLI, SDK, Newman, Interceptor 等专有名词。`;

const SYSTEM = `你是 Postman 桌面应用的简体中文本地化译者。用户会给你若干行，每行格式为“序号<TAB>英文”，英文里的换行写成 \\n。
请逐行翻译成自然、简洁的简体中文软件界面用语，并按相同格式输出“序号<TAB>中文”，只输出这些行，不要任何其他内容，不要遗漏或合并行。
规则：
1. ICU 占位符和语法必须原样保留：{name}、{{name}}、{count, plural, one {...} other {...}}、{x, select, a {...} other {...}}、#、{d, date, medium} 等。plural/select 的分支关键字（one、other、=0、collection 等）不翻译，只翻译分支 {} 里的文字。
2. 富文本标签必须原样保留且嵌套结构不变：<0>...</0>、<1></1>、<3 />、<Link>...</Link>、<b>、<strong> 等；可以根据中文语序调整标签外的文字位置。
3. \\n 原样保留；URL、代码、键名（如 accessTokenUrl）、快捷键（⌘S、Ctrl+K）原样保留。
4. 用“你”而不是“您”；中文与英文/数字之间加空格；用中文标点。
5. 术语表：${GLOSSARY}`;

function run(argv) {
  return execFileSync(process.execPath, [I18N, ...argv], { cwd: ROOT, encoding: 'utf8' });
}

async function translateBatch(client, lines) {
  const response = await client.beta.messages
    .stream({
      model: MODEL,
      max_tokens: 64000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: lines.join('\n') }],
    })
    .finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('模型拒绝了这批内容：' + JSON.stringify(response.stop_details));
  if (response.stop_reason === 'max_tokens') throw new Error('输出被截断，请减小 --batch');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function main() {
  // 清掉上一轮导出的残留，只处理本次 export 出来的待翻译文件
  if (fs.existsSync(WORK)) {
    for (const f of fs.readdirSync(WORK)) if (/^[^.]+\.(txt|keys\.json)$/.test(f) && f !== 'stale.txt') fs.unlinkSync(path.join(WORK, f));
  }
  console.log(run(['export', ...positional]).trim());
  const todo = fs.existsSync(WORK) ? fs.readdirSync(WORK).filter((f) => /^[^.]+\.txt$/.test(f) && f !== 'stale.txt') : [];
  if (!todo.length) return console.log('没有需要翻译的词条。');

  let client = null;
  if (!DRY) {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.default || sdk;
    client = new Anthropic();
  }

  const done = [];
  for (const file of todo) {
    const ns = file.slice(0, -4);
    const lines = fs.readFileSync(path.join(WORK, file), 'utf8').split(/\r?\n/).filter((l) => /^\d+\t/.test(l));
    const out = [];
    for (let i = 0; i < lines.length; i += BATCH) {
      const chunk = lines.slice(i, i + BATCH);
      process.stdout.write(`${ns}: ${i + chunk.length}/${lines.length}\r`);
      if (DRY) continue;
      out.push((await translateBatch(client, chunk)).trim());
    }
    console.log(`${ns}: ${lines.length} 条${DRY ? '（dry-run，未调用 API）' : ''}`);
    if (DRY) continue;
    fs.writeFileSync(path.join(WORK, ns + '.zh.txt'), out.join('\n') + '\n');
    done.push(ns);
  }
  if (!done.length) return;
  try {
    console.log(run(['import', ...done]).trim());
  } catch (e) {
    // import 遇到占位符不一致的条目会跳过并以非 0 退出，其余条目已写入
    console.log(String(e.stdout || '').trim());
    console.log('部分译文没通过校验被跳过，可以再运行一次本脚本补翻。');
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
