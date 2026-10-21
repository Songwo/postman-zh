# Postman 中文汉化插件（postman-zh）

Postman 桌面版目前只有英文和日文两种界面语言。这个项目给 Postman 桌面版加上**简体中文界面**：双击即可安装，随时可以一键还原，Postman 自动升级后也会自动保持汉化。

- ✅ **一键安装 / 卸载**：双击 `install.bat` / `uninstall.bat`，**不需要安装 Node.js**（直接借用 Postman 自带的运行时）
- ✅ **可完全还原**：卸载后 `app.asar` 与原版逐字节一致，不留任何痕迹
- ✅ **跟随升级**：Postman 自动下载新版本后，退出时会顺带给新版本打上汉化
- ✅ **不碰你的数据**：集合名、请求名、URL、请求体、代码编辑器、响应内容等一律不翻译
- ✅ **随 Postman 官方语言包走**：基于 Postman 自己的 i18n 词条 key 翻译，支持复数/变量等 ICU 语法，不怕界面改版

> 已在 Windows 11 + Postman 12.33.0 上实测。macOS / Linux 的安装脚本已提供，但尚未实测，欢迎反馈。

## 安装

1. 在 GitHub 页面点击 **Code → Download ZIP**，下载后**解压**到任意目录
2. 双击 **`install.bat`**
   - 如果 Postman 正在运行，脚本会询问是否关闭它（请先确认没有未保存的内容）
3. 重新打开 Postman，界面即为中文

> Postman 设置里的语言请保持 **English**，汉化会自动把英文替换成中文。

macOS / Linux：

```bash
./install.sh
```

## 卸载 / 还原英文

双击 **`uninstall.bat`**（macOS / Linux：`./install.sh uninstall`）。

临时关闭汉化而不卸载：用环境变量 `POSTMAN_ZH=0` 启动 Postman。

查看当前状态：

```bash
node installer/cli.js status
```

## 工作原理

Postman 桌面版是 Electron 应用，主界面从 `desktop.postman.com` 远程加载，界面文字由 i18next 按模块从 `/locales/en-US/<模块>-<hash>.json` 加载。本插件在 `app.asar` 里做了两处很小的挂载：

| 挂载点 | 作用 |
| --- | --- |
| `preload_desktop.js` 第一行 | 在页面脚本运行之前拦截语言包请求，按 key 把中文合并进英文语言包（**语言包层**）；再用 `MutationObserver` 兜底翻译少量写死在代码里的英文（**DOM 层**） |
| `main.js`（主进程入口）第一行 | 给控制台、Runner 等其他窗口注入 DOM 层；Postman 退出时检测到已下载的新版本，就自动给新版本打补丁 |

补丁只在 `app.asar` 末尾**追加**数据，原有数据一个字节都不改；原始入口记录在 `postman-zh/state.json` 中，卸载时据此还原并截掉追加部分。打补丁前会先写临时文件并校验，失败不会损坏原文件。

DOM 层只做“整段文本完全匹配”的替换，并且跳过输入框、代码编辑器（Monaco / CodeMirror）、侧边栏条目名、标签页标题、文档里的标题和正文等用户内容区域，HTTP 头名称（`Date`、`Server` 等）也在排除列表中。

## 翻译进度

```bash
node tools/i18n.js stats
```

目前已人工翻译主界面最常用的模块（顶栏、侧边栏、请求编辑器、授权、集合/文件夹/环境工作台、状态栏、控制台、历史记录、设置、运行器、查找替换、Cookie 管理、响应面板、导入、本地文件/Git、评论协作、监视器、模拟服务器、保险库、gRPC/WebSocket/MQTT/Kafka、团队设置、数据集等），约 11,500 / 20,400 条（56%）。其余模块暂时显示英文，欢迎一起补全。

## 参与翻译

需要 Node.js 18+。

```
locales/en-US/   Postman 官方英文语言包快照（按模块，自动拉取，请勿手改）
locales/zh-CN/   中文译文（与英文同结构，只放已翻译的 key）
dict/dom/        DOM 层词典：写死在代码里、不在语言包中的英文 → 中文
dict/exclude.json        DOM 层永不翻译的词（HTTP 头名等）
dict/skip-selectors.json DOM 层跳过的区域（CSS 选择器）
dict/patterns.json       DOM 层正则规则，如 ["Updated (\\d+) days ago", "$1 天前更新"]
```

### 人工翻译

```bash
node tools/i18n.js export settings      # 导出未翻译词条到 work/settings.txt（每行：序号<TAB>英文）
# 新建 work/settings.zh.txt，按相同序号写“序号<TAB>中文”
node tools/i18n.js import settings      # 导入并校验占位符 / 标签
node tools/i18n.js check                # 校验全部译文
node tests/run.js                       # 运行测试
```

翻译约定：用“你”不用“您”；中英文之间加空格；`{变量}`、`{count, plural, ...}`、`<0>...</0>` 等必须原样保留（`import` 会自动校验，不一致的条目会被拒绝）。常用术语：Collection=集合、Environment=环境、Headers=请求头、Body=请求体、Pre-request Script=前置脚本、Fork=复刻、Mock server=模拟服务器、Monitor=监视器、Flow=流程、Vault=保险库、Agent Mode=智能体模式。

### 用 Claude 批量翻译剩余词条

```bash
npm install
export ANTHROPIC_API_KEY=...            # 或先执行 `ant auth login`
node tools/translate-ai.js              # 翻译全部未翻译模块；也可以指定模块：node tools/translate-ai.js vault monitors-core
node tools/translate-ai.js --dry-run    # 只统计要翻译多少条，不调用 API
```

脚本会按术语表分批调用 Claude（默认 `claude-opus-5-5`，开启了服务端 fallback），结果同样经过 `import` 的占位符校验。机器翻译的结果建议抽查后再提交。

### Postman 发布新版本后

```bash
node tools/i18n.js fetch                # 打开 Postman 的情况下运行，自动拉取最新英文语言包
```

会提示新增了多少词条、哪些已翻译词条的英文原文变了（列在 `work/stale.txt`，需要复核）。

## 常见问题

**安装后还是英文？** 确认 Postman 设置 → General → Language 为 English；确认安装时 Postman 已完全退出（包括托盘图标）；运行 `node installer/cli.js status` 查看状态。

**Postman 更新后汉化没了？** 通常退出 Postman 时会自动给新版本打补丁；如果是在 Postman 运行期间直接“重启以更新”，偶尔会赶不上，再双击一次 `install.bat` 即可。

**某个词翻译得不对 / 我的请求名被翻译了？** 欢迎提 Issue，附上截图和英文原文。用户内容被误翻译通常需要在 `dict/skip-selectors.json` 中补充跳过的区域。

**安全吗？** 插件只修改本机 Postman 的 `app.asar`，不联网、不收集任何数据；所有代码都在 `src/` 目录中，可以自行审阅。

## 免责声明

本项目为非官方社区项目，与 Postman, Inc. 无关。“Postman”是 Postman, Inc. 的商标。修改应用文件可能不符合 Postman 的使用条款，请自行评估风险。

## 许可证

[MIT](LICENSE)
