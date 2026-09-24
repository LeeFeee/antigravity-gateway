# Antigravity Gateway

[中文](#中文) · [English](#english)

## 中文

Antigravity Gateway 是一个本地 Anthropic/OpenAI 兼容网关。它复用官方 Antigravity CLI（`agy`）的登录状态，让 Claude Code、Codex CLI、Trae 及其他兼容客户端通过本地接口调用当前账号可用的模型。

默认使用原生 Cloud Code 直连，不经过 `agy` Agent 的包装提示词。客户端选择什么模型，网关就把该模型 ID 原样发送给上游；只有 Claude Code Auto Mode 的分类请求使用独立的快速模型。

> 非 Google 官方项目，仅用于学习、兼容性研究与个人测试。模型权限、额度、地区限制和服务条款均以上游为准。

当前版本：`v0.7.0`。详细更新记录见 [CHANGELOG.md](CHANGELOG.md)。

### 主要功能

- 同时提供 Anthropic Messages、OpenAI Responses 和 Chat Completions 接口。
- 支持 Claude Code、Codex CLI、Trae 和其他兼容客户端。
- 支持前台运行，以及 macOS、Linux、Windows 后台保活和开机自启。
- 支持自动导入本地 agy 账号，也可以输入 `add` 手动添加账号。
- 多账号之间轮询；同一会话保持账号一致，限流、认证或额度异常时自动尝试其他账号。
- 启动界面显示账号状态、历史用量、Token、缓存命中率和最近24小时图表。
- 支持客户端工具调用、SSE、Claude Code Auto Mode 和结构化输出。

### 使用条件

| 条件 | 说明 |
|---|---|
| Node.js | 20 或更高版本；npm 随 Node.js 一起安装 |
| Antigravity CLI | 已安装 `agy`，并至少完成一次登录和正常对话 |
| 操作系统 | macOS、Linux 或 Windows，ARM64/x64 |
| 网络 | 当前电脑能够正常访问 Antigravity/Google 上游服务 |

安装器会自动检查 Node.js 版本、操作系统、CPU 架构和临时目录，并由 npm 处理项目依赖。`agy` 及其登录账号是使用前提，不由本项目自动安装或注册。

没有 Node.js 时，可使用以下任一方式安装：

macOS（Homebrew）：

```bash
brew install node
```

macOS/Linux（nvm）：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

Windows PowerShell：

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
```

也可以从 [Node.js 官方网站](https://nodejs.org/en/download/) 安装 LTS 版本。

### 安装

一条命令全局安装，不需要克隆仓库，也不需要进入项目目录：

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

验证版本：

```bash
antigravity-gateway --version
```

部分 npm 11 版本会提示 `install scripts not yet covered by allowScripts`。如果最后显示 `changed 1 package` 且命令可以运行，说明安装已经完成；该提示不是网关运行错误。

### 启动

前台模式：

```bash
antigravity-gateway
```

默认监听：

```text
Anthropic: http://127.0.0.1:9897
OpenAI:    http://127.0.0.1:9897/v1
API Key:  antigravity-gateway（网关未设置专用 Key 时可使用任意非空内容）
```

关闭终端或按 `Ctrl+C` 会停止前台网关。

后台保活并设置自动启动：

```bash
antigravity-gateway service start
```

管理后台服务：

```bash
antigravity-gateway service status
antigravity-gateway service restart
antigravity-gateway service stop
antigravity-gateway service logs
antigravity-gateway service uninstall
```

重复执行 `service start` 会更新配置并重启现有服务，不会创建重复服务。后台模式没有交互输入框；需要添加账号时，先停止后台服务并以前台模式启动，添加完成后再执行 `service start`。

打开 Token 用量看板：

```bash
antigravity-gateway stats
```

网关启动后，无论使用前台模式还是后台保活模式，都可以另开一个终端执行这条命令。看板复用网关现有的 `9897` 端口，不会启动第二个后台服务；也可以直接访问 `http://127.0.0.1:9897/dashboard`。

如果 `agy` 不在默认位置：

```bash
antigravity-gateway --agy-path "/absolute/path/to/agy"
```

Windows：

```powershell
antigravity-gateway --agy-path "C:\path\to\agy.exe"
```

### 账号池

网关启动时会检测当前官方 agy 登录账号：

- 账号池中没有该账号：自动保存到账号池并立即参与请求。
- 已存在同一账号：不重复添加，也不使用本地登录态反复覆盖已保存凭据。
- 账号池非空后：请求以账号池凭据为主。

手动添加其他账号：启动前台网关，在 `gateway>` 后输入：

```text
add
```

网关会尝试打开浏览器，同时在终端显示完整授权链接。浏览器没有自动打开时，复制链接到浏览器完成授权。远程服务器无法访问 localhost 回调页时，把浏览器地址栏里的完整回调 URL 粘贴回 `gateway>`。

查看账号池：

```text
acc
```

新会话会在可用账号之间轮询，同一会话尽量保持在同一账号。终端会为每次上游尝试打印实际账号：

```text
[Antigravity Gateway] 路由账号=user@example.com source=managed-account model=gemini-3.8-flash-high attempt=1
```

账号文件保存在：

```text
~/.antigravity-gateway/accounts/
```

账号池凭据以普通 JSON 保存，Token 刷新后会同步更新。请自行管理本机文件和账号使用风险。

### 前台终端命令

| 命令 | 作用 |
|---|---|
| `add` | 添加 Antigravity 账号 |
| `acc` | 查看账号池和账号状态 |
| `models` | 查看当前发现的模型 |
| `status` | 重新显示网关和统计状态 |
| `usage` | 查看实时详细用量 |
| `stats` | 在默认浏览器打开 Token 用量看板 |
| `reload` | 重新加载账号与额度信息 |
| `config` | 查看客户端连接配置 |
| `logs` | 查看日志说明或位置 |
| `clear` | 清理当前终端显示 |
| `version` | 查看网关版本 |
| `help` | 查看命令帮助 |
| `quit` | 保存状态并关闭网关 |

额度查询在后台异步进行。启动画面中的 `1/1 额度可用` 表示当时成功取得了一个有效额度快照，并不代表其他账号一定没有额度；等待几秒后输入 `status` 可重新显示当前结果。

### 接入 Claude Code

在 `~/.claude/settings.json` 的 `env` 中配置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9897",
    "ANTHROPIC_AUTH_TOKEN": "antigravity-gateway",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.8-flash-low",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576"
  }
}
```

启动 Claude Code：

```bash
claude --model 'gemini-3.8-flash-high[1m]'
```

网关会生成包含当前真实模型的 Claude Code `modelPicker` 文件：

macOS/Linux：

```bash
claude --settings "$(antigravity-gateway --claude-config-path)"
```

Windows PowerShell：

```powershell
claude --settings (antigravity-gateway --claude-config-path)
```

也可以执行下面的命令，把输出的 `modelPicker` 合并进自己的 `~/.claude/settings.json`：

```bash
antigravity-gateway --claude-config
```

注意：

- 使用本地网关时，不要同时启用 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 或 `CLAUDE_CODE_USE_FOUNDRY`。
- Gemini 3.7/3.8 Flash 的上游目录当前返回 1,048,576 输入 Token；`[1m]` 或 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` 用于告诉 Claude Code 使用真实窗口。
- 正常请求使用客户端指定的模型。Auto Mode 分类请求单独使用快速模型，不改变主会话模型。

### 接入 Codex CLI

先取得动态模型目录路径：

```bash
antigravity-gateway --codex-catalog-path
```

在 `~/.codex/config.toml` 中配置：

```toml
model = "gemini-3.8-flash-high"
model_provider = "antigravity"
model_catalog_json = "/ABSOLUTE/PATH/.antigravity-gateway/codex-models.json"

[model_providers.antigravity]
name = "Antigravity Gateway"
base_url = "http://127.0.0.1:9897/v1"
env_key = "ANTIGRAVITY_GATEWAY_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

Windows 路径建议使用 TOML 单引号：

```toml
model_catalog_json = 'C:\Users\YOUR_NAME\.antigravity-gateway\codex-models.json'
```

启动前设置 Key：

macOS/Linux：

```bash
export ANTIGRAVITY_GATEWAY_API_KEY=antigravity-gateway
codex
```

Windows PowerShell：

```powershell
$env:ANTIGRAVITY_GATEWAY_API_KEY = "antigravity-gateway"
codex
```

### 接入 Trae 或其他客户端

根据客户端支持的协议填写：

| API 格式 | Base URL | API Key | 模型 |
|---|---|---|---|
| Anthropic Messages | `http://127.0.0.1:9897` | `antigravity-gateway` | 从模型目录选择 |
| OpenAI Responses/Chat | `http://127.0.0.1:9897/v1` | `antigravity-gateway` | 从模型目录选择 |

查询模型：

```bash
antigravity-gateway --models
curl http://127.0.0.1:9897/v1/models
```

模型取决于账号、套餐、地区和 Antigravity CLI 版本。模型目录只用于展示和诊断，不会阻止客户端把其他模型 ID 发给上游。

### 用量和额度

启动界面显示：

- 账号池可用状态和已取得的额度快照。
- 历史请求数、上游调用数、输入/输出 Token、缓存 Token 与命中率。
- 最近24小时每小时用量图。

输入 `usage` 查看实时明细，输入 `status` 刷新展示。用量每5分钟保存一次，24小时图表每小时更新，历史总量展示每24小时更新。额度快照约每30分钟刷新；上游实时返回始终是最终依据。

网关以前台或后台模式运行时，都可以另开终端执行下面的命令查看完整图形看板：

```bash
antigravity-gateway stats
```

看板提供历史与所选时段 Token、请求和上游调用、输入/输出/思考/缓存、失败率、账号额度、小时热力图、模型趋势和每日构成；支持最近1天、3天、7天、30天及按账号筛选。账号列表只来自当前账号池；额度与 agy `/usage` 保持一致，按账号分别展示 Gemini 模型组、Claude/GPT 模型组共享的每周额度和 5 小时额度。具体模型的调用次数与 Token 只按真实请求的模型 ID 统计，不再把模型目录中的单项余额误写成账号总额度。网页每分钟读取一次本地聚合数据，关闭页面后不会继续轮询，也不保存提示词或模型回复。账号与模型的小时细分从 v0.8.0 起累计。

```text
~/.antigravity-gateway/state/quota.json
~/.antigravity-gateway/usage/usage-state.json
```

统计只保存数字，不保存提示词和模型回复。

### 更新与卸载

更新：

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

更新后必须重启正在运行的网关。前台模式按 `Ctrl+C` 后重新运行；后台模式执行：

```bash
antigravity-gateway service start
```

卸载：

```bash
antigravity-gateway service uninstall
npm uninstall --global antigravity-gateway
```

### 常见问题

#### `401 本地 agy 登录态刷新失败`

先在官方 `agy` 中重新登录并完成一次正常对话，然后重启网关。输入 `acc` 检查账号池状态。

#### `429 Resource has been exhausted`

通常表示当前账号或模型额度受限。网关会尝试其他可用账号；如果所有账号都受限，请等待额度恢复或切换模型。

#### `EADDRINUSE 127.0.0.1:9897`

已有网关占用端口。关闭旧进程，或使用其他端口：

```bash
antigravity-gateway --port 9898
```

客户端 Base URL 也必须改成新端口。

#### Claude Code 请求没有出现在网关日志

检查 `ANTHROPIC_BASE_URL`，并移除 Bedrock、Vertex、Foundry 等会覆盖本地 Base URL 的 provider 开关。系统代理环境下可设置：

```bash
export NO_PROXY=127.0.0.1,localhost
```

#### 启动时只发现少量模型

模型探测可能暂时失败或账号目录尚未刷新。输入 `models`、`reload`，或使用 `antigravity-gateway --models` 再次查询。客户端明确指定的模型仍会原样发给上游。

### 常用配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `ANTIGRAVITY_GATEWAY_HOST` | `127.0.0.1` | 网关监听地址 |
| `ANTIGRAVITY_GATEWAY_PORT` | `9897` | 网关监听端口 |
| `ANTIGRAVITY_GATEWAY_API_KEY` | 空 | 自定义网关 Key；非本机监听时必须设置 |
| `ANTIGRAVITY_CLI_PATH` | 自动查找 `agy` | 指定 agy 路径 |
| `ANTIGRAVITY_LOCAL_AUTH_FILE` | 自动读取本地登录态 | 指定本地 agy 凭据文件 |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | `~/.antigravity-gateway` | 账号、额度、用量和客户端配置目录 |
| `ANTIGRAVITY_DEFAULT_MODEL` | `gemini-3.8-flash-high` | 请求未提供模型时使用 |
| `ANTIGRAVITY_FAST_MODEL` | 自动选择 | Claude Code Auto Mode 分类请求使用 |
| `ANTIGRAVITY_MODEL_ALIASES` | `{}` | 用户主动设置的精确模型映射 |
| `ANTIGRAVITY_DIRECT_MODEL_DISCOVERY_TIMEOUT_MS` | `8000` | 模型目录探测超时，单位毫秒 |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | `300000` | 单次请求总超时，单位毫秒 |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | `4` | 最大并发请求数 |
| `ANTIGRAVITY_GATEWAY_MAX_QUEUE` | `32` | 最大排队请求数 |
| `ANTIGRAVITY_GATEWAY_CORS_ORIGIN` | 空 | 允许访问本地网关的浏览器 Origin |
| `ANTIGRAVITY_GATEWAY_DEBUG` | 空 | 设置为 `1` 输出更多诊断信息 |
| `ANTIGRAVITY_GATEWAY_TOOL_NARRATION` | 空（关闭） | 设置为 `1` 后，要求模型按目的说明进度；同一目的内的多个工具调用不逐个解说 |

非必要情况下不建议手动设置 access token、refresh token、project ID 或上游地址。普通用户使用本地 agy 登录态和账号池即可。

#### 工具调用前的进度说明（`ANTIGRAVITY_GATEWAY_TOOL_NARRATION`）

Agent 客户端只渲染模型写出来的内容。有些模型（例如 Cloud Code 背后的 Gemini）在默认情况下会沉默地直接发起工具调用，于是界面从提问到整轮结束之间一直是静止的，看起来像"卡住了"；另一些模型（例如 DeepSeek）则会主动补一句过渡说明。

把这个开关设为 `1` 后，网关会在上游系统指令末尾追加一段约定，让**所有**模型按**目的**报告进度：开始一个目的时候用一句话说明它要达成什么，同一目的下需要的多个工具调用（包括依赖前次结果的跨轮连续调用）不再逐个插话；只有目的完成、实质改变或遇到需要用户输入的阻碍时才再次说明。工具返回或新一轮回复本身不代表目的改变。这是提示词约定，不保证每次模型输出都遵守，也不会由网关生成或删减模型正文。

按目的而不是按工具来分界，是因为一个目的通常需要连着调好几个工具，每个工具前都说一句只会变成噪声——实测一个 4 工具的目的产生了 4 句近乎重复的话。

- 默认关闭，行为与之前完全一致。
- 只作用于**带工具**的请求；没有工具就没有需要说明的动作。
- **不会**影响 Claude Code Auto mode 分类请求（必须只返回一段 XML）和结构化输出请求（必须只返回一个 JSON 值）——给这两类请求追加正文会破坏客户端契约。
- 仅 `direct` 传输支持；`agy` CLI 回退路径要求工具调用信封前后不能有正文。

```sh
export ANTIGRAVITY_GATEWAY_TOOL_NARRATION=1
antigravity-gateway service restart
```

当前是否生效可以从健康接口读取：`curl -s http://127.0.0.1:9897/ | grep -o '"tool_narration":[a-z]*'`。

### 接口

```text
GET  /
GET  /v1/models
POST /v1/messages
POST /v1/messages/count_tokens
POST /v1/responses
POST /v1/chat/completions
```

### 工作原理

客户端请求先进入本地兼容接口，网关完成 Anthropic/OpenAI 与 Cloud Code 之间的格式转换，再使用本地账号池凭据请求上游，最后把结果转换回客户端协议。工具由 Claude Code、Codex 等客户端执行，网关只负责传递工具定义、调用和结果。

### 已知限制

- 直连使用的是非公开 Cloud Code 内部接口，上游升级后可能需要同步适配。
- 可用模型和额度取决于账号；本项目不会绕过上游限制。
- 工具调用、Auto Mode 和结构化输出请求可能需要先完整校验，再向客户端返回。
- 本地账号文件是普通 JSON，由使用者自行保管。

### License

MIT，见 [LICENSE](LICENSE)。

---

## English

Antigravity Gateway is a local Anthropic/OpenAI-compatible gateway. It reuses the official Antigravity CLI (`agy`) login state so Claude Code, Codex CLI, Trae, and other compatible clients can access models available to the current account through local HTTP endpoints.

The default `direct` transport calls Cloud Code without the agy Agent wrapper prompt. Normal requests preserve the exact model ID selected by the client. Only detected Claude Code Auto Mode classifier requests use a separate fast model.

> Unofficial and intended for learning, compatibility research, and personal testing. Upstream plans, quotas, regional restrictions, and terms still apply.

Current version: `v0.7.0`. See [CHANGELOG.md](CHANGELOG.md) for release notes.

### Features

- Anthropic Messages, OpenAI Responses, and Chat Completions endpoints.
- Claude Code, Codex CLI, Trae, and other compatible clients.
- Foreground mode and cross-platform background keepalive/autostart.
- Automatic local agy account import plus interactive `add` authorization.
- Sticky-session account rotation and failover on authentication, quota, or rate-limit failures.
- Request, token, cache, account, quota, and 24-hour usage displays.
- Client-side tools, SSE, Claude Code Auto Mode, and structured output support.

### Requirements

- Node.js 20 or newer with npm.
- Official Antigravity CLI (`agy`) installed, signed in, and verified with one successful conversation.
- macOS, Linux, or Windows on ARM64/x64.
- Network access to Antigravity/Google upstream services.

Install Node.js if needed:

```bash
# macOS with Homebrew
brew install node

# macOS/Linux with nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

Windows PowerShell:

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
```

### Install and run

Install globally from any directory:

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

Foreground mode:

```bash
antigravity-gateway
```

Background keepalive and autostart:

```bash
antigravity-gateway service start
```

Open the local Token dashboard while either foreground or background mode is running:

```bash
antigravity-gateway stats
```

Once the gateway is running in either foreground or background mode, run this command from another terminal. The dashboard reuses the gateway process and port `9897`; it does not start another persistent web service. The direct URL is `http://127.0.0.1:9897/dashboard`.

Service management:

```bash
antigravity-gateway service status
antigravity-gateway service restart
antigravity-gateway service stop
antigravity-gateway service logs
antigravity-gateway service uninstall
```

Default client endpoints:

```text
Anthropic: http://127.0.0.1:9897
OpenAI:    http://127.0.0.1:9897/v1
API Key:  antigravity-gateway (any non-empty value when no custom gateway key is set)
```

If npm 11 prints `install scripts not yet covered by allowScripts`, but installation ends with `changed 1 package` and the command works, the installation succeeded.

### Accounts and terminal commands

At startup, a usable official local agy identity is added to the pool only when it is new. Existing matching identities are not duplicated or overwritten. Once the pool is non-empty, requests use its stored credentials.

Run the gateway in foreground mode and type `add` to authorize another account. The complete OAuth URL is always printed. On a remote host, paste the final localhost callback URL back at `gateway>`.

| Command | Purpose |
|---|---|
| `add` | Add an Antigravity account |
| `acc` | Show pool and account state |
| `models` | Show discovered models |
| `status` | Refresh gateway and dashboard status |
| `usage` | Show live detailed usage |
| `stats` | Open the local Token dashboard |
| `reload` | Reload accounts and quota snapshots |
| `config` | Show client configuration |
| `logs` | Show log information |
| `clear` | Clear the terminal |
| `version` | Show gateway version |
| `help` | Show command help |
| `quit` | Save state and stop the gateway |

Each upstream attempt prints the selected account, model, and attempt number. Account files are stored under `~/.antigravity-gateway/accounts/` as ordinary JSON.

### Claude Code

Add these values to the `env` object in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9897",
    "ANTHROPIC_AUTH_TOKEN": "antigravity-gateway",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.8-flash-low",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576"
  }
}
```

Start with a Gemini 1M context declaration:

```bash
claude --model 'gemini-3.8-flash-high[1m]'
```

Load the generated model picker:

```bash
# macOS/Linux
claude --settings "$(antigravity-gateway --claude-config-path)"
```

```powershell
# Windows PowerShell
claude --settings (antigravity-gateway --claude-config-path)
```

Do not enable Bedrock, Vertex, or Foundry provider switches while using the local `ANTHROPIC_BASE_URL`.

### Codex CLI

Print the generated catalog path:

```bash
antigravity-gateway --codex-catalog-path
```

Add to `~/.codex/config.toml`:

```toml
model = "gemini-3.8-flash-high"
model_provider = "antigravity"
model_catalog_json = "/ABSOLUTE/PATH/.antigravity-gateway/codex-models.json"

[model_providers.antigravity]
name = "Antigravity Gateway"
base_url = "http://127.0.0.1:9897/v1"
env_key = "ANTIGRAVITY_GATEWAY_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

Windows path:

```toml
model_catalog_json = 'C:\Users\YOUR_NAME\.antigravity-gateway\codex-models.json'
```

Start Codex:

```bash
export ANTIGRAVITY_GATEWAY_API_KEY=antigravity-gateway
codex
```

### Trae and other clients

| API format | Base URL | API Key |
|---|---|---|
| Anthropic Messages | `http://127.0.0.1:9897` | `antigravity-gateway` |
| OpenAI Responses/Chat | `http://127.0.0.1:9897/v1` | `antigravity-gateway` |

List available models:

```bash
antigravity-gateway --models
curl http://127.0.0.1:9897/v1/models
```

### Usage, update, and troubleshooting

The browser dashboard shows lifetime and selected-period Tokens, requests, upstream calls, input/output/thinking/cache usage, failures, per-account quota, hourly heatmaps, model trends, and daily composition. It supports 1/3/7/30-day windows and account filtering. Accounts come exclusively from the active account pool. Quota cards mirror agy `/usage`: each account shows the shared weekly and five-hour limits for the Gemini group and the Claude/GPT group. Per-model request and Token charts use the exact model IDs actually called instead of treating a model-catalog balance as the account's total quota. The page reads local aggregate data once per minute only while open; it never stores prompts or model responses. Hourly account/model breakdowns begin with v0.8.0. Type `usage` for terminal details or run `antigravity-gateway stats` while either foreground or background mode is active. Usage is persisted every five minutes; quota snapshots refresh asynchronously.

Update:

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

Restart the foreground process after updating, or run `antigravity-gateway service start` again for background mode.

Common failures:

- `401`: sign in through official agy again, complete one successful conversation, restart the gateway, and check `acc`.
- `429`: the account/model is rate-limited or out of quota; wait, switch models, or add another account.
- `EADDRINUSE`: stop the old process or use `antigravity-gateway --port 9898`, then update the client URL.
- No gateway request log: verify `ANTHROPIC_BASE_URL` and remove Bedrock/Vertex/Foundry provider switches.

### Common configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTIGRAVITY_GATEWAY_HOST` | `127.0.0.1` | Listen address |
| `ANTIGRAVITY_GATEWAY_PORT` | `9897` | Listen port |
| `ANTIGRAVITY_GATEWAY_API_KEY` | empty | Custom gateway key; required for non-loopback binding |
| `ANTIGRAVITY_CLI_PATH` | auto-detected | Custom agy path |
| `ANTIGRAVITY_LOCAL_AUTH_FILE` | auto-detected | Custom local agy credential file |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | `~/.antigravity-gateway` | Accounts, quota, usage, and generated client configuration |
| `ANTIGRAVITY_DEFAULT_MODEL` | `gemini-3.8-flash-high` | Used only when a request omits `model` |
| `ANTIGRAVITY_FAST_MODEL` | auto-selected | Auto Mode classifier model |
| `ANTIGRAVITY_MODEL_ALIASES` | `{}` | Explicit exact model aliases |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | `300000` | Request timeout in milliseconds |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | `4` | Maximum concurrent requests |
| `ANTIGRAVITY_GATEWAY_MAX_QUEUE` | `32` | Maximum queued requests |

### How it works

Clients call the local Anthropic/OpenAI endpoints. The gateway converts requests to the Cloud Code protocol, selects a local pool account, sends the upstream request, and converts the result back. Tools are executed by Claude Code, Codex, or another client; the gateway only transports tool definitions, calls, and results.

### Limitations

- Direct transport uses an undocumented Cloud Code internal API and may require updates after upstream changes.
- Available models and quotas depend on the account and upstream service.
- Tool, Auto Mode, and structured-output requests may be buffered for validation.
- Account credentials are ordinary local JSON files and remain the user's responsibility.

### License

MIT. See [LICENSE](LICENSE).
