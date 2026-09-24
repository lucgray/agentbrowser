# AgentBrowser

**[English](README.md)** · 简体中文

> 一个 Chrome 侧边栏：编码 Agent 既能和你对话，又能通过 CDP 驱动你**真实登录态**的浏览器——并支持对页面选中文本直接提问。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-green.svg)](extension/manifest.json)
[![Node ≥ 20.11](https://img.shields.io/badge/Node-%E2%89%A5%2020.11-339933.svg)](server/package.json)
[![Protocol v1.4](https://img.shields.io/badge/Protocol-v1.4-orange.svg)](PROTOCOL.md)

本项目是 [VasiHemanth/agentbrowser](https://github.com/VasiHemanth/agentbrowser)
的 fork，补齐了 ContextLens 式的「选中即问」交互，并引入了更严格的错误处理规范。
消息格式、工具名、文件路径以 [PROTOCOL.md](PROTOCOL.md) 为准；
[DESIGN.md](DESIGN.md) 讲设计动机，[AGENTS.md](AGENTS.md) 记仓库约定。

---

## 本分支 vs 上游

| | [VasiHemanth/agentbrowser](https://github.com/VasiHemanth/agentbrowser) | **本分支** |
|---|---|---|
| 侧边栏对话 + 可插拔 Agent 后端（SDK、CLI、API 适配器） | ✅ | ✅ |
| 可信 CDP 输入，跑在你真实登录的浏览器上——无需自动化专用 Profile、无需重新登录 | ✅ | ✅ |
| 当前 Tab 上下文、`@` 跨 Tab 引用、附件、语音输入 | ✅ | ✅ |
| `mcp-proxy.mjs` — 任意支持 stdio MCP 的 Agent 均可驱动浏览器 | ✅ | ✅ |
| **选中文字 → 光标处浮出「Ask」按钮** | — | ✅ |
| **右键菜单 → "Ask AgentBrowser"** | — | ✅ |
| **选中内容自动补上下文** — 语义化 DOM 路径、最近章节标题、±800 字符上下文、所在 `<pre>`/代码块（含语言识别）、表格的表头+当前行渲染为 markdown → `context.selection`（协议 v1.4） | — | ✅ |
| **禁止静默 catch** — 每个 catch 必须按影响分级记日志或向上抛出（[AGENTS.md](AGENTS.md)） | — | ✅ |

致谢上游：侧边栏 ↔ hub ↔ 适配器的整体架构、十个浏览器工具、以及全部
适配器均为上游项目的工作成果。本分支只新增了选中交互层和约定文档。

## 为什么用 CDP

Content script 发出的合成事件带有 `isTrusted: false`，现代编辑器
（Lexical、React composer）会直接忽略。而 `chrome.debugger` 派发的输入是
可信的：CDP 点击和 `Input.insertText` 与真人操作完全等价（已于
2026-08-01 在 Threads 编辑器上验证）。由于扩展附着在你已有的浏览器
Profile 上，不存在独立的自动化 Profile，也无需重新登录。Agent 主循环
本身从不触碰页面 DOM——所有动作都走 `chrome.debugger`。唯一的小
content script（`extension/selection.js`）只监听文本选中（浮窗 Ask
按钮和右键菜单），从不驱动页面；为此 manifest 在 `debugger, tabs,
storage, offscreen, sidePanel` 之外追加了 `contextMenus, scripting` 和
`*://*/*` 主机权限。

## 架构

```
side panel  <-- runtime Port -->  service worker  <-- offscreen doc / WebSocket -->  hub (127.0.0.1:9010)
     ▲                                  |                                              |
     │                            chrome.debugger                              adapters (SDK, CLI, API)
selection.js                      (CDP executor)                              mcp-proxy.mjs (external harnesses)
(content script)
```

Hub（`server/hub.mjs`）在面板与当前适配器之间转发对话，并把任意
harness 的工具调用转发给扩展，由扩展经 CDP 执行并回传结果。content
script 捕获的选中文本按 content script → service worker →
`chrome.storage.session` → 面板的路径传递，随下一条消息以
`context.selection` 发出。

## 环境要求

- Chrome（或任意支持 `chrome.debugger` 与 `sidePanel` 的 Chromium）
- Node.js 20.11+
- 至少一个后端：PATH 上的编码 CLI，或 Anthropic/OpenAI API key

## 安装

```bash
git clone https://github.com/lucgray/agentbrowser.git
cd agentbrowser/server
npm install
npm start          # 监听 ws://127.0.0.1:9010
```

然后加载扩展：

1. 打开 `chrome://extensions`，开启开发者模式。
2. 「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录。
3. 点击工具栏的 AgentBrowser 图标打开侧边栏；hub 连通后状态点变绿。

输入消息，如需切换后端在下拉框选适配器（默认取自
`server/config.json`），发送即可。工具活动以紧凑 chip 形式显示在
对话流中。

可用 `AGENTCHAT_PORT` 覆盖端口。想让 hub 跨登录常驻，
[server/autostart.md](server/autostart.md) 里有 macOS 的 launchd 方案
（plist 放在仓库外）。日志写到 `/tmp/agentchat-hub.log`。如果 hub 报
端口被占用，说明已有 autostart 副本在运行。

## 选中即问

*本分支的标志性功能。*

- **浮窗 Ask**：在页面上划选任意文字，光标处会出现 **Ask** 按钮。点击后
  侧边栏打开，选中内容以可移除的 chip 暂存在输入框里。
- **右键菜单**：右键点击选中区域，选择 **Ask AgentBrowser**。
- **自动补富上下文**：下一条消息携带 `context.selection`（协议
  v1.4）——选中文本 + 语义化 DOM 路径（如 `article > section >
  pre`）、最近章节标题、±800 字符上下文；若选中内容位于代码块或表格
  内，还会带上整个外层块：代码块含识别出的语言，表格渲染为
  markdown 的表头+当前行。

Agent 能完整看到这些信息，所以「解释一下这个」「这个正则做什么」
「总结这张表」都精确作用于你划选的内容。

## Tab、文件与语音

每次发送的不只是你打的字。

- **Tab 上下文**：你正在看的标签页随每条消息发送，所以「总结这个页面」
  「帮我填这个表单」无需粘贴 URL。harness 拿到它的 tabId，用于
  `read_page`、`screenshot`、`eval_js`。
- **`@` 引用**：在输入框敲 `@`，按标题挑选其他已打开的标签页。同时引用
  两个标签页就可以让它们做对比。
- **附件**：拖文件进输入框或点选。面板将其 base64 编码，hub 写到
  `<tmpdir>/agentchat-uploads/<chatId>/<name>`，再把绝对路径告诉
  harness，由它用文件工具打开。单条消息解码后总大小上限 8 MB。chat
  会话销毁时上传目录一并删除。
- **语音**：麦克风按钮把口述填入输入框——只填字，不发送。

## 选模型

适配器下拉框由 hub 填充，不是写死的：连接时 hub 会告诉面板有哪些
适配器、各自的名字、能跑哪些模型、默认用哪个。无模型切换的适配器
（多数 CLI 读自己的配置）模型列表为空。

会话中换模型会重启该 chat 的 session——因为模型在 session 创建时定
死。对话流会出现一行 "session restarted with model X"，下一轮从零开
始。不换模型则一切照旧。

## 用 API key 代替 CLI

`anthropic-api` 和 `openai-api` 两个适配器直接调厂商 API，不起 CLI
子进程。适合没装/没登录对应 CLI，或想钉住某个具体模型而不动 CLI
配置的场景。

它们需要 key：粘到面板里，hub 会写入 `~/.agentchat/keys.json`（文件
0600、目录 0700），这是它唯一的去处。key 除了发往对应厂商的请求外
绝不离开本机，不会回传给面板（面板只能知道 key 有没有设置过），也
不会出现在 hub 日志、聊天消息或报错里。清空输入框即删除 key。

API 适配器拿到的十个浏览器工具与 CLI 适配器相同，所以「总结页面」
「填表单」行为一致。但它们没有 CLI 的文件和 shell 工具，附件对它们
来说只是打不开的路径——需要读本地文件的轮次请用 CLI 适配器。

给没配 key 的 API 适配器发消息不会启动任何进程：对话流直接报缺少
哪个 key，本轮结束。

## 接管表单

让 harness 帮你填当前打开的表单：它会先读表单（label、name、类
型、现值），逐个字段点击并用可信 CDP 输入，最后读回值供你核对。

除非你在对话里明确要求，它不会点提交/发送/发布/购买。填表不等于授
权提交。要走完整个流程就说清楚："fill it and submit"。

## 适配器

按 chat 选择，或配置在 `server/config.json`：

- `claude-agent-sdk`：在 hub 进程内运行
  `@anthropic-ai/claude-agent-sdk`。十个浏览器工具以进程内 MCP
  server 的形式暴露给模型，截图以图片形式返回给模型。每个 chat 一
  个 SDK session，上下文跨轮次保留。
- `claude-cli`：以 stream-json 模式拉起 `claude -p`，并生成指向
  `mcp-proxy.mjs` 的 MCP 配置。子进程在整个 session 期间存活。想要
  完整 Claude Code 工具集（文件、bash）加上浏览器工具时用。

另外六个 CLI 由 `server/adapters/generic-cli.mjs` 统一包装：每轮起
一个进程，轮次间恢复 CLI 自己的会话；浏览器工具经 `mcp-proxy.mjs`
接入：

- `codex`：`codex exec --json`，用 `codex exec resume <thread id>` 续
  接；每次调用以 `-c mcp_servers.browser.*` 覆盖项挂 MCP。
- `opencode`：`opencode run --format json`，用 `-s <sessionID>` 续接；
  MCP 写到临时目录里生成的 `opencode.json`，并以该目录为 cwd。
- `copilot`：`copilot -p ... -s`，纯文本回复；`--session-id <uuid>` 每
  轮复用保证确定性会话；MCP 经 `--additional-mcp-config`。
- `grok`：`grok -p ... --output-format json`，`--resume <sessionId>` 续
  接；MCP 写到临时 cwd 里的 `.grok/config.toml`。
- `agy`：`agy -p ...`，纯文本回复；`--conversation <id>` 续接（首轮后
  通过比对会话目录拿到 id，失败回退 `-c`）；MCP 只在全局
  `~/.gemini/config/mcp_config.json` 注册一次（merge-only，保留已有
  条目）。
- `gemini`：`gemini -p ... -o stream-json`，`-r <session_id>` 续接；
  MCP 写到临时 cwd 的 `.gemini/settings.json`；其他已配置 server 用
  `--allowed-mcp-server-names browser` 排除。

每个 CLI 都在你的 PATH 上查找。路径特殊的话用
`AGENTCHAT_BIN_<NAME>` 指定绝对路径，例如
`AGENTCHAT_BIN_CODEX=/opt/homebrew/bin/codex`。

还有两个直连厂商 API、需要 key 而非 CLI：

- `anthropic-api`：Anthropic API，key 存于 `anthropic` provider 名下。
- `openai-api`：OpenAI API，key 存于 `openai` provider 名下。

## 接入任意其他 harness

`server/mcp-proxy.mjs` 是一个 stdio MCP server，把工具调用经
WebSocket 转发给 hub。任何支持 MCP 的 harness 只要在 MCP 配置里加上
它就能驱动浏览器：

```json
{
  "mcpServers": {
    "agentbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/agentbrowser/server/mcp-proxy.mjs"]
    }
  }
}
```

启动 hub、保持扩展加载，harness 就拿到与内置适配器相同的十个工
具，无需专属适配器。Cursor、Cline、Qwen CLI、Codex、Gemini CLI、
Claude Code 都接受这种形态的配置，只是文件名不同（Codex 用
`config.toml`，Gemini 用 `settings.json`，Claude Code 用 `.mcp.json`）。

另有三个客户端用不同的键名放同样的 server 定义：

| 客户端 | 配置位置 |
|---|---|
| [OpenClaw](https://docs.openclaw.ai/cli/mcp) | `openclaw.json` 的 `mcp.servers`，或 `openclaw mcp add browser --command node --arg <path>` |
| [Muse Code](https://dev.meta.ai/docs/muse-code/extending) | 设置文件里的 `mcp_servers`，加 `"transport": "stdio"` |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) | `~/.hermes/config.yaml` 的 `mcp_servers`，或 `hermes mcp add browser --command node --args <path>` |

唯一硬性要求是 **stdio** transport——`mcp-proxy.mjs` 就是 stdio
server。只会走 HTTP 的 MCP 客户端暂时接不上。

Python agent 框架同理。LangGraph 和 DeepAgents 都通过
[`langchain-mcp-adapters`](https://github.com/langchain-ai/langchain-mcp-adapters)
加载 stdio MCP server：

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "agentbrowser": {
        "command": "node",
        "args": ["/absolute/path/to/agentbrowser/server/mcp-proxy.mjs"],
        "transport": "stdio",
    }
})
tools = await client.get_tools()
```

## 浏览器工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `tabs_list` | `{}` | `{tabs:[{tabId,url,title,active}]}` |
| `tab_new` | `{url?}` | `{tabId}` |
| `tab_close` | `{tabId}` | `{closed:true}` |
| `navigate` | `{url, tabId?}` | `{url, title}`（加载完成后，上限 20s） |
| `read_page` | `{tabId?, maxChars?}` | `{url, title, text}`（innerText，默认截断 60k 字符） |
| `screenshot` | `{tabId?}` | `{base64, mimeType:"image/png"}` |
| `click` | `{x, y, tabId?}` | `{clicked:true}` |
| `type_text` | `{text, tabId?}` | `{typed:<字符数>}`（插入当前聚焦元素） |
| `press_key` | `{key, tabId?}` | `{pressed:key}`（如 "Enter"、"Escape"、"Meta+A"） |
| `eval_js` | `{expression, tabId?}` | `{value}` |

省略 `tabId` 即当前活动标签页。service worker 按需 attach
debugger，每个标签页串行执行命令，被 Chrome 断开后自动重连。

## 测试

```bash
cd server
npm test           # pricing、API 适配器、协议 v1.3
npm run test:e2e   # 真实 hub + 真实 WebSocket 的端到端测试
npm run smoke      # hub 路由往返；需另一个终端先 `npm start`

cd ../extension
node --test markdown.test.mjs overlay.test.mjs sidepanel.test.mjs sidepanel.dom.test.mjs
```

所有测试都不花模型 token、不起 CLI。端到端套件通过
`AGENTCHAT_ADAPTER_MODULE` 把 hub 指向 `server/stub-adapter.mjs`。

## 已知限制

- Chrome 每个标签页只允许一个 debugger 客户端。如果某标签页开着
  DevTools 或被其他 CDP 客户端占用，该页的工具调用会失败，直到对方
  断开。换个标签页或关掉 DevTools 即可。
- debugger attach 期间 Chrome 会显示 "is being debugged" 提示条；把
  它关掉会断开 debugger，下一次工具调用会自动重连。
- hub 只接受一个扩展连接。在第二个 Chrome Profile 或窗口里加载扩展
  会挤掉前一个：旧 socket 被关闭，其未完成的工具调用以
  "displaced" 失败。
- 工具调用在 hub 侧 60 秒超时。
- 适配器 session 按 chat 保留，空闲 30 分钟后销毁；之后用旧 chatId
  发消息会新建 session。会话中切换适配器或模型下拉框也会结束旧
  session，下一轮从零开始。
- API key 按 provider 而非适配器存储：一个 Anthropic key 供所有走
  Anthropic 的适配器使用。key 以明文存在
  `~/.agentchat/keys.json`，靠文件权限保护，未加密。

## 许可证

MIT，见 [LICENSE](LICENSE)。上游部分 ©
[VasiHemanth/agentbrowser](https://github.com/VasiHemanth/agentbrowser)，
MIT 许可。
