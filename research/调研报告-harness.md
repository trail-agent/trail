# 调研报告（二）：Agent Harness 专题

> 调研日期：2026-11-01
> 本篇是 [调研报告.md](调研报告.md) 的续篇，聚焦 **harness**（包在模型外面的那一层：主循环、工具、上下文、权限、执行环境、客户端协议）。
> 源码位置：`research/repos/`（`--depth 1` 浅克隆，**只阅读，未运行**）

## 0. 调研对象

| 项目 | 语言 | 许可证 | 版本 | 一句话定位 |
|---|---|---|---|---|
| [pi](repos/pi)（原 badlogic/pi-mono，现 earendil-works/pi） | TS | MIT | c9f4c7b / 2026-11-01 | 极简、可扩展的 harness 内核；**Proma 的底层运行时** |
| [DeepSeek Harness](repos/deepseek-harness)（`dsh`） | TS | MIT | ce7073d5 / 2026-10-30 | "一切皆插件"，Web UI + Electron 桌面 |
| [Proma](repos/Proma) | TS（Electron） | **AGPL-3.0** | 86d9dfb / 2026-09-26 | 基于 pi 的中文桌面 Agent 产品，接入微信/飞书/钉钉 |
| [Hermes Agent](repos/hermes-agent)（Nous Research） | Python | MIT | 557254fa / 2026-11-01 | 个人 agent，约 20 个聊天平台网关，会自我积累技能 |
| [Kimi CLI](repos/kimi-cli)（月之暗面） | Python | Apache-2.0 | 9ab1286 / 2026-09-22 | **已归档**；`kaos` 本地/SSH 抽象层值得学 |
| [Crush](repos/crush)（Charmbracelet） | Go | FSL-1.1-MIT（两年后转 MIT） | ef4993a / 2026-11-01 | 客户端/服务端分离，内置 POSIX shell 模拟器，LSP 工具 |

未单独拆的：**Qwen Code** 是 Gemini CLI 的分支（第一篇已读过 Gemini CLI）；**Roo Code** 已于 2026 年 5 月归档；**LangChain Deep Agents** 是构建 harness 的库，而不是 harness 本身。

> **许可证提醒**：Proma 是 AGPL-3.0，复制它的代码会让你的项目也必须以 AGPL 开源。**只参考思路，不要拷代码**。Crush 的 FSL 许可证禁止做竞品，两年后才转为 MIT。其余项目（pi、dsh、Hermes、Kimi）为 MIT 或 Apache-2.0，可以借鉴代码，但需保留版权声明。

---

## 1. pi：最值得精读的 harness 内核

pi 是这批项目里**最贴近"自己掌控全部细节"这一目标**的：内核小，层次清楚，而且 Proma 已经证明，在它上面可以做出完整的桌面产品。

### 1.1 包结构（[packages/](repos/pi/packages)）

| 包 | 作用 | 对你的价值 |
|---|---|---|
| `ai` | 统一多厂商 LLM API，自动发现模型 | 模型适配层范本 |
| `agent` | 通用 agent 循环、状态、传输抽象 | **主循环范本（959 行）** |
| `coding-agent` | read/bash/edit/write 等工具 + 会话管理 | 工具与会话范本 |
| `env` | **通过 SSH 部署到远端的小 daemon + 客户端** | SSH 进阶方案 |
| `durable` | 持久化会话运行时：先落盘再展示，崩溃后可续跑 | daemon 持久化思路 |
| `tui` / `mcp` / `codemode` / `schema` | 终端 UI、MCP 客户端、沙箱化 JS、无 eval 的 JSON Schema 校验 | 选读 |

### 1.2 主循环：[agent/src/agent-loop.ts](repos/pi/packages/agent/src/agent-loop.ts)

`runLoop`（第 172–340 行）是两层 while 循环：

```
外层：没有工具调用、也没有插话时，检查 follow-up 队列，有则继续
  内层：while (有工具调用 || 有插话消息)
    prepareNextTurn()     ← 可在这里压缩上下文、换模型、调整思考强度
    取出 steering 消息      ← 用户在 agent 运行中途插入的话
    prepareRequest()      ← 请求前最后一次改上下文的机会
    流式请求模型
    若 stopReason = length → 本轮所有工具调用一律判失败（参数可能被截断）
    执行工具（支持串行/并行）
    finishTurn()          ← 返回 end / continue，由上层决定是否继续
```

关键设计：
- **steering 与 follow-up 分离**：steering 是"运行中插话"，下一轮就生效；follow-up 是"等它做完再发"。**这正是你手机端需要的两种输入方式**：手机上看到 agent 走偏了立刻插话，或者先把下一个任务排进队列。
- **输出被截断时不执行工具**：模型因 max_tokens 被截断时，工具参数可能不完整，pi 会把整批工具调用直接判为失败，而不是去执行残缺的参数。
- **工具集变化用增量声明**：`declareToolChanges` 不重写 system prompt，而是插入一条带 `toolsAdded` / `toolsRemoved` 的 system 消息，以保护 prompt cache。
- 所有扩展点（`prepareNextTurn`、`prepareRequest`、`finishTurn`、`beforeToolCall` / `afterToolCall`、`getSteeringMessages`、`getFollowUpMessages`、`transformContext`、`convertToLlm`）都是回调。循环本身不知道存储、UI 或压缩的存在。

### 1.3 工具：依赖注入式的执行后端

[coding-agent/src/core/tools/](repos/pi/packages/coding-agent/src/core/tools) 里每个工具都接收一个 `Operations` 接口：

```ts
interface ReadOperations { readFile(path): Promise<Buffer>; access(path): Promise<void>; detectImageMimeType?(path) }
interface EditOperations { readFile(path); writeFile(path, content); access(path) }
interface BashOperations { exec(command, cwd, options): Promise<exitCode> }
```

**工具逻辑与执行位置完全解耦**：要在 SSH 机器上执行，只需传入 SSH 版的 Operations。这是比"给每个工具加一个 target 参数"更干净的做法，**建议直接采用**。

其他细节：
- 内置 `powershell` 工具：命令前加 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`，解决 Windows 中文乱码（[tools/powershell.ts](repos/pi/packages/coding-agent/src/core/tools/powershell.ts)）
- `file-mutation-queue.ts`：同一文件的写操作排队，避免并行工具互相覆盖
- `truncate.ts`：输出截断

### 1.4 System prompt：分段 + 增量补丁

[coding-agent/src/core/system-prompt.ts](repos/pi/packages/coding-agent/src/core/system-prompt.ts)：
- 默认 prompt **极短**：一句身份说明 + 工具列表 + 规则 + 文档位置 + 项目上下文（AGENTS.md）+ skills + cwd
- 每段包在 `<section_name>` 标签里
- `diffSystemPromptSections()`：段落变化时只发补丁，**不整体重写**，保护 prompt cache

### 1.5 会话存储：JSONL 树

[coding-agent/src/core/session-manager.ts](repos/pi/packages/coding-agent/src/core/session-manager.ts)：
- 每个会话一个 `.jsonl` 文件，只追加
- 每条记录带 `id` + `parentId`，**会话是一棵树**，可以从任意历史节点分叉重来
- 切换分支时生成 `branch_summary`（分支摘要），压缩时生成 `compaction_summary`
- 按工作目录组织在 `~/.pi/agent/sessions/` 下

### 1.6 SSH 方案 C：pi-env

[packages/env/README.md](repos/pi/packages/env/README.md)、[docs/protocol.md](repos/pi/packages/env/docs/protocol.md)：

- **agent、存储、密钥都留在本地**，远端只运行一个很小的 **Rust daemon**（`pi-env`），负责文件操作和命令执行
- 连接时自动探测远端系统，**缺少 daemon 就自动上传**（按 SHA-256 命名，每次启动前校验），支持 Linux、macOS、Windows 和 Android Termux，覆盖 x64 与 arm64
- 通信走 **SSH 的 stdin/stdout**，自定义二进制帧：`长度 | 类型 | 请求id | JSON长度 | JSON | 原始字节`，帧类型包括 request、result、error、event（流式输出）、cancel、ping
- 启动握手：daemon 先输出 `PI-ENV <token>`，客户端丢弃这之前的所有输出，因为 shell 启动脚本可能会打印杂乱内容
- **不需要端口转发**；SSH 运行在 `BatchMode`，使用应用自己的 known_hosts 文件，严格校验 host key
- 首次连接：`scanHostKey()` 取出指纹给用户核对，`acceptHostKey()` 保存
- 调度细节：结果、错误、ping 优先于大块输出发送，慢网络下回复不会被输出堵住
- **一致性测试**：同一套测试分别跑本地实现和远程实现，确保两边行为一致

### 1.7 模型适配：[packages/ai](repos/pi/packages/ai/src)

- `api/` 下按线协议分：`anthropic-messages`、`openai-completions`、`openai-responses`、`google-generative-ai`、`bedrock-converse-stream`、`mistral-conversations`…
- `providers/` 下按厂商分，每个厂商有一个 `.models.ts` 模型清单（上下文窗口、价格、能力）
- `compat-schema.ts`：**描述各家 OpenAI 兼容接口的"方言"差异**，例如思考预算字段叫 `thinking_budget` 还是 `thinking_budget_tokens`、是否支持 `store` 字段、session affinity 头怎么写。你接国产模型时一定会遇到这类问题
- `transform-messages.ts`：会话中途切换模型时，转换历史消息格式（例如思考块）
- `faux.ts`：假模型 provider，用于测试

---

## 2. DeepSeek Harness：插件化与工程纪律

### 2.1 架构（[docs/architecture.md](repos/deepseek-harness/docs/architecture.md)）

- 基于 **Cordis** 插件框架：模型适配器、工具注册表、会话日志，**甚至主循环本身都是插件**，都可以替换。插件注册的东西在卸载时自动撤销
- **profile + bundle**：`web`、`headless`、`sdk`、`acp` 等 profile 由多层 bundle 叠加组成，用户通过 YAML patch 覆盖任意一行配置
- 桌面端：Electron 启动一个私有的 Desktop Host，Host 运行完整的 Web 应用，窗口加载 Web 前端。**桌面端和 Web 端是同一套代码**，这对你"桌面 + 手机 PWA 复用 React 组件"的思路是有力的佐证

### 2.2 三条核心原则（值得写进你自己的设计文档）

1. **"模型能看到的，必须记录在日志里"**（Model-visible means logged）：每一次模型请求都必须能从会话日志完整重建。新的模型输入必须先成为会话事件
2. **会话日志只追加，带版本迁移**：`session.vN.jsonl`，旧版本永不改写，迁移时写出新文件
3. **能力接缝（Capability seam）**：文件系统和子进程 provider 共享同一个"执行世界"。把它们一起换成远程沙箱，Bash、PTY、LSP 就一起搬到了远端。这和 pi 的 Operations 注入是同一个思想

### 2.3 一轮的流程

```
turn/start
  取出下一条输入（外加一条排队消息）
  agent/pre-step   ← 可接受、改写或拒绝本轮输入
  step/start → 组装 prompt → 冻结请求 → 流式请求
  tool/call* → tools/pre-execute → 守卫 → tools/execute → tools/post-execute → tool/result*
  step/end
  工具还欠一次请求，或有新输入 → 下一个 step
turn/end
```

`turn/*`、`step/*`、`tool/*`、`*/message` 是**持久事件**；`agent/*` 是**运行时拦截点**（waterfall，每个监听者需调用 `next()`）。

### 2.4 工具执行管线（[docs/tool-execution-pipeline.md](repos/deepseek-harness/docs/tool-execution-pipeline.md)）

```
tool/call 事件（执行前先落盘）
 → tools/pre-execute（hooks、权限、沙箱策略）
     deny → 跳过   ask → 一次性审批（无人可答 → deny）
 → 守卫（只能拒绝，不能放行）
 → tools/execute（超时、重试、指标）
 → fs/write-intent 或 fs/edit-intent（文件写入意图检查）
 → tools/post-execute（可拦截或替换结果、追加上下文）
 → tool/result 事件
```

可以直接作为你权限系统的流程图。

### 2.5 其他值得看的包

| 包 | 内容 |
|---|---|
| [packages/guard/repeat-tool-reminder](repos/deepseek-harness/packages/guard/repeat-tool-reminder) | 相同工具调用重复时提醒模型 |
| [packages/guard/timeout-policy](repos/deepseek-harness/packages/guard/timeout-policy) | 工具超时转成清晰的模型可读错误 |
| [packages/spill](repos/deepseek-harness/packages/spill) | 超大输出"溢出"到存储，返回定位符（同 OpenCode 落盘思路） |
| [packages/compaction](repos/deepseek-harness/packages/compaction) | 压缩拆成多个插件：基础摘要、**工具结果裁剪**、图片卸载、`/compact` 命令 |
| [packages/sandbox/sandbox-windows-acl](repos/deepseek-harness/packages/sandbox/sandbox-windows-acl) | **Windows 沙箱**：用受限令牌（restricted token）限制写入 |
| [packages/ssh](repos/deepseek-harness/packages/ssh) | 远端安装 helper；控制通道走 OpenSSH master，每个程序流单独走 Unix socket 转发 + TLS-PSK。**仅支持 Linux/macOS 端点，不支持密码**，比 pi-env 重得多 |

每个包的 README 都有 "Model Experience" 和 "KV Cache effect" 两节，**专门说明这个包对模型输入和缓存前缀的影响**。这个文档习惯值得学习。

### 2.6 ⚠ 隐私注意

使用 DeepSeek 官方接口时，适配器**默认**会在请求体中附加两个扩展字段（[docs/deepseek-llm-api-wire-extensions.md](repos/deepseek-harness/docs/deepseek-llm-api-wire-extensions.md)）：
- `dsh_session_log`：**会话日志的增量部分**（不只是模型输入）
- `dsh_plugin_packages`：你安装的插件清单

二者都可以通过 `enabled: false` 关闭。如果你借鉴它的适配器，或者直接把它当后端用，需要知道这一点。

---

## 3. Proma：在 pi 之上做桌面产品

[AGENTS.md](repos/Proma/AGENTS.md) · Electron + React + Jotai + Radix/shadcn · Bun monorepo

| 设计点 | 位置 | 说明 |
|---|---|---|
| **agent 跑在子进程** | [agent-runtime-client.ts](repos/Proma/apps/electron/src/main/lib/agent-runtime-client.ts) | Electron `utilityProcess` + `MessagePort`，协议带版本号和握手。agent 崩溃不会拖垮界面 |
| IPC 四层契约 | AGENTS.md | shared 常量/类型 → main handler → preload bridge → renderer，每次改动必须四处同步 |
| 本地优先存储 | AGENTS.md | JSON / JSONL，不用数据库；写入用原子封装（`safe-file.ts`） |
| **IM 桥接** | `wechat-bridge.ts`、`feishu-bridge.ts`、`dingtalk-bridge.ts`、`slack-bridge.ts` | **微信走官方 iLink Bot API**（扫码登录 + HTTP 长轮询），飞书、钉钉、Slack 同理 |
| 统一桥接注册 | [bridge-registry.ts](repos/Proma/apps/electron/src/main/lib/bridge-registry.ts) | 每个桥接提供 `shouldAutoStart`、`needsRecovery`（自愈）、`start`、`stop` |
| 手机端命令 | [bridge-command-handler.ts](repos/Proma/apps/electron/src/main/lib/bridge-command-handler.ts) | `/new`、`/list`、`/stop`、`/switch`、`/workspace`、`/model`… |
| **防休眠** | `feishu-sleep-blocker.ts` | 开启远程镜像时调用 `powerSaveBlocker`，防止电脑睡眠导致断连 |
| 日志脱敏 | `bridge-log-redaction.ts` | 桥接日志中去掉敏感内容 |
| Windows | `windows-shell-selection.ts`、`git-bash-detector.ts`、`wsl-detector.ts` | 选择 shell、探测 Git Bash 和 WSL |
| 其他 | `agent-fork-workspace-copy.ts`、worktree、子会话 | "平行探索"：复制工作区或分叉会话，去探索别的方案 |

**对你的启示**：手机入口不一定非要自己做 App。**接入微信或飞书机器人是成本最低的第一版手机端**，后续再做 PWA。

---

## 4. Hermes Agent：多平台网关与两条铁律

[AGENTS.md](repos/hermes-agent/AGENTS.md) 开头写的两条不变量，适合直接抄进你的设计原则：

1. **对话内的 prompt cache 神圣不可侵犯**：对话进行中不修改历史、不换工具集、不重载记忆、不重建 system prompt，唯一的例外是上下文压缩。会改变 system prompt 的命令**推迟到下一个会话生效**（需要立即生效时加 `--now`）
2. **内核是窄腰，能力放在边缘**：每个工具定义都会随每次请求发送，所以新增核心工具的门槛很高。新能力优先做成 CLI 命令 + skill、按需启用的工具或插件

其他要点：
- **网关**：[gateway/](repos/hermes-agent/gateway) 支持 Telegram、Discord、Slack、WhatsApp 等约 20 个平台；新增平台的指南见 [platforms/ADDING_A_PLATFORM.md](repos/hermes-agent/gateway/platforms/ADDING_A_PLATFORM.md)
- **配对**（[gateway/pairing.py](repos/hermes-agent/gateway/pairing.py)）：陌生用户收到一次性码，主人在命令行批准。8 位码，从去掉 0/O、1/I 的 32 个字符中选取；1 小时过期；每个平台最多 3 个待批准；每个用户 10 分钟 1 次；失败 5 次锁定；数据文件权限 0600；**配对码永不写入日志**。参数可以直接照抄
- **执行环境**（[tools/environments/](repos/hermes-agent/tools/environments)）：local、docker、ssh、modal、daytona、vercel_sandbox 共用一个基类；远程环境通过 `file_sync.py` 按 mtime + size 增量同步文件
- **⚠ Windows 的坑**：[ssh.py](repos/hermes-agent/tools/environments/ssh.py) 注释写明，**Windows 自带的 OpenSSH 不支持 ControlMaster 连接复用**，所以每条命令都要重新建立连接。在 Windows 上做 SSH 应该用纯库实现（Node 用 `ssh2`）自己维护长连接
- 学习闭环：从经验中自动生成 skill，使用中改进；会话存在 SQLite 中，带全文检索（FTS），可以检索自己的历史对话
- 审批：`approval_smart.py`（智能审批）、`approval_floors.py`（审批下限）、`approval_gateway_wait.py`（等待手机端审批）

---

## 5. Kimi CLI：kaos，就是你要的 SSH 方案 A

> 仓库已归档，不再维护，但代码可以参考（Apache-2.0）。

- **[packages/kaos](repos/kimi-cli/packages/kaos/src/kaos)**：约 1000 行的"Agent 操作系统抽象层"
  - [`__init__.py`](repos/kimi-cli/packages/kaos/src/kaos/__init__.py) 定义 `Kaos` 协议：`getcwd`、`chdir`、`stat`、`iterdir`、`glob`、`readbytes`、`readtext`、`writetext`、`mkdir`、`exec`
  - [`local.py`](repos/kimi-cli/packages/kaos/src/kaos/local.py)：180 行
  - [`ssh.py`](repos/kimi-cli/packages/kaos/src/kaos/ssh.py)：**296 行**，基于 `asyncssh`，**支持密码与私钥登录**，文件操作走 SFTP，命令走 exec
  - **这是本次调研中唯一一个原生支持 SSH 密码登录、且足够小、可以一口气读完的实现**
- **D-Mail**（[soul/denwarenji.py](repos/kimi-cli/src/kimi_cli/soul/denwarenji.py)）：模型可以调用工具"给过去的检查点发消息"，把上下文回滚到某个检查点，并附上一句"我已经试过 X，行不通"。这是一种很有意思的上下文自救机制
- **Agent spec**：用 YAML 定义 agent（可继承），在其中选择工具、子 agent 和 system prompt 模板
- **Wire 协议**（[wire/](repos/kimi-cli/src/kimi_cli/wire)）：主循环（soul）和 UI 之间的事件协议，JSON-RPC 风格
- 审批运行时 `approval_runtime/`：会话级别的待审批请求中心，投射到事件流供各种 UI 使用

---

## 6. Crush：Go 实现的客户端/服务端分离

- **客户端/服务端**：[internal/server](repos/crush/internal/server)、[internal/client](repos/crush/internal/client)。支持多客户端（`multiclient_test.go`），Windows 上走命名管道（`net_windows.go`）
- **内置 POSIX shell 模拟器**（[internal/shell](repos/crush/internal/shell)）：基于 `mvdan.cc/sh`，**在 Windows 上也模拟 bash 并内置 coreutils**，让模型永远面对同一种 shell，彻底绕开 cmd 和 PowerShell 的差异。这是解决 Windows 兼容问题的另一种思路（Go 生态有现成的库，Node 生态没有同等成熟的方案）
- **SSH 密码交给界面处理**：`sshaskpass/` + [server/ssh.go](repos/crush/internal/server/ssh.go)。OpenSSH 要密码时，服务端挂起请求，客户端在界面里弹窗，用户输入后通过 `/workspaces/{id}/ssh/answer` 提交。**密码不落盘，也不经过模型**。这和 OpenCode 的 askpass 是同一个思路，而且对远程客户端（手机）同样适用
- **LSP 工具**：definition、references、symbols、rename、call hierarchy、diagnostics。模型可以"跳转到定义"和"查看编译错误"，比 grep 准确得多
- **Hooks 兼容 Claude Code 格式**（[internal/hooks](repos/crush/internal/hooks)）
- `filetracker/`：记录每个会话读过哪些文件，用于实现"先读后改"的约束
- 工具描述单独写成 `.md` 或 `.md.tpl` 文件，与代码分离，方便迭代 prompt

---

## 7. 横向对比：这一轮改变了哪些结论

### 7.1 SSH：从"两种方案"变成"三种方案 + 演进路线"

| | A：库直连（kaos / ssh2） | **C：本地 agent + 远端微型 daemon（pi-env）** | B：远端完整 agent（Cline / dsh） |
|---|---|---|---|
| 远端需要 | 只要 sshd | 自动上传的小二进制 | Node + 完整 agent |
| 密码登录 | ✅ 原生支持 | 依赖 ssh，需配合 askpass | ❌ 两家都不支持 |
| 性能 | 每次操作一个往返 | 帧协议 + 流式 + 取消，接近本地 | 本地级 |
| 复杂度 | **低（约 300 行）** | 中（需要写 daemon 和协议） | 高 |
| 代表 | Kimi `kaos/ssh.py` | pi `packages/env` | Cline remote、dsh `packages/ssh` |

**修正后的建议**：
1. **M3 做方案 A**：用 `ssh2` 照着 kaos 的接口写，支持密码和密钥，接入 pi 风格的 `Operations` 注入
2. 以后觉得慢了，**升级到方案 C**：协议直接参考 pi-env 的帧格式，daemon 可以先用 Node 写（复用 `ssh2` 的 exec 通道作为传输），以后再换 Rust
3. 不做方案 B

### 7.2 手机端：先接 IM，再做 PWA

| 方案 | 代表 | 成本 | 体验 |
|---|---|---|---|
| IM 机器人（微信 / 飞书 / 钉钉 / Telegram） | Proma、Hermes、Goose gateway | **低**：无需自建网关和 App | 文字交互，审批靠回复命令 |
| 自建网关 + PWA / App | Happy、OpenCode | 高 | 完整界面、diff、审批卡片 |

**修正后的建议**：M4 拆成两步：
- **M4a**：先做一个 IM 桥接（推荐飞书或企业微信，个人微信用 iLink Bot API），实现 `/new /list /stop /switch /model` + 审批命令 + 防休眠。几天就能在手机上用起来
- **M4b**：再做自建网关 + PWA + E2E（原计划不变）
- 两者都只是 daemon 的"客户端"，共用同一套协议和审批中心（参考 Kimi `approval_runtime`、Hermes `approval_gateway_wait`）

### 7.3 主循环：补充三个机制

| 机制 | 来源 | 价值 |
|---|---|---|
| steering / follow-up 两个队列 | pi | 手机插话、排队任务 |
| 截断时整批工具判失败 | pi | 防止执行残缺参数 |
| 检查点回滚 + 留言（D-Mail） | Kimi | 上下文自救（进阶） |

### 7.4 Prompt cache：上升为架构原则

pi、dsh、Hermes 三家**都把保护 prompt cache 放在架构层面**：
- system prompt 分段，只发增量补丁（pi）
- 工具集变化用 system 消息声明，而不是重写工具列表（pi）
- 会改 system prompt 的操作推迟到下一个会话（Hermes）
- 每个模块写明"对缓存前缀的影响"（dsh）

对你来说，用 DeepSeek、Kimi 等按缓存命中计费的模型时，这直接决定成本。

### 7.5 Windows：三种 shell 策略

| 策略 | 代表 | 评价 |
|---|---|---|
| PowerShell + UTF-8 前缀 | pi、Gemini CLI | 简单，模型对 PowerShell 熟悉度一般 |
| Git Bash | pi-env、Proma | 模型最熟悉 bash；需要用户安装 Git |
| 内置 POSIX 模拟器 | Crush | 最统一；Node 生态缺少成熟实现 |

**建议**：探测到 Git Bash 就用 bash，否则退回 PowerShell，同时提供两个工具，让模型知道当前用的是哪个 shell。

---

## 8. 更新后的学习路线（替换第一篇的第 4 节）

| 顺序 | 读什么 | 学什么 |
|---|---|---|
| 1 | mini-swe-agent `default.py` | 循环本质（半天） |
| 2 | **pi `agent/src/agent-loop.ts` + `types.ts`** | 生产级但仍然精简的循环、扩展点、steering |
| 3 | **pi `coding-agent/src/core/tools/`** + `system-prompt.ts` | Operations 注入、工具细节、prompt 分段 |
| 4 | **Kimi `kaos/`**（约 1000 行） | 本地/SSH 抽象，密码登录 |
| 5 | pi `ai/src/api` + `compat-schema.ts` | 多模型适配和兼容接口的方言差异 |
| 6 | dsh `docs/architecture.md`、`tool-execution-pipeline.md` | 事件、管线、插件化 |
| 7 | Hermes `AGENTS.md` 开头 + `gateway/pairing.py` | 设计原则、配对安全参数 |
| 8 | Proma `bridge-*.ts`、`agent-runtime-client.ts`（**只看不抄**） | IM 桥接、子进程运行时 |
| 9 | pi `env/docs/protocol.md` | SSH 方案 C 的协议 |
| 10 | 第一篇中的 OpenHands、Happy、OpenCode 相关部分 | 事件日志、网关、E2E |

---

## 附：本次调研的局限
- 所有项目都只读了源码和文档，**没有运行**。
- 星数、热度等信息来自网络搜索，仅供参考；技术结论均来自源码。
- Hermes、dsh 体量很大，只抽读了与你需求相关的模块。
- 参考链接：[pi](https://github.com/earendil-works/pi) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Proma](https://github.com/proma-ai/Proma) · [Hermes Agent](https://github.com/NousResearch/hermes-agent) · [Kimi CLI](https://github.com/MoonshotAI/kimi-cli) · [Crush](https://github.com/charmbracelet/crush) · [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents) · [best-of-Agent-Harnesses](https://github.com/RyanAlberts/best-of-Agent-Harnesses)
