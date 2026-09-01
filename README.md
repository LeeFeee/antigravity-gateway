# Antigravity Gateway

[中文](#中文) · [English](#english)

## 中文

Antigravity Gateway 是一个实验性的本地兼容网关。它从官方 Antigravity/agy 已有的 macOS Keychain 登录记录或本地会话文件中读取登录态，仅在内存中使用，并通过 Cloud Code 原生请求、请求头、JSON 信封和 SSE 响应直接访问 Antigravity 上游服务。这样可以绕过 `agy` Agent 包装层注入的长系统提示词，让 Claude Code、Codex CLI 和 Trae 通过本地 HTTP 接口调用模型。

默认传输模式是 `direct`，不会回退到 `agy` 执行模型请求。macOS 上，网关通过系统 `security` 命令读取当前用户钥匙串中的 `gemini / antigravity` 登录记录；找不到时才检查兼容的本地会话文件。令牌不会进入日志、响应或仓库，刷新后的短期令牌也只保存在当前进程内存中。

> 非 Google 官方项目。仅用于学习、兼容性研究与个人测试。使用本项目不代表你获得额外模型权限，也不能绕过 Antigravity 的套餐、额度、地区限制或服务条款。

当前发布版本：`v0.2.1`。每次发布都会同步更新 `package.json`、启动横幅、`--version` 与 `CHANGELOG.md`。

### 已实现

- Anthropic Messages：`POST /v1/messages`
- Anthropic Token Count：`POST /v1/messages/count_tokens`（估算值）
- OpenAI Responses：`POST /v1/responses`
- OpenAI Chat Completions：`POST /v1/chat/completions`
- OpenAI 与 Codex 双格式模型目录：`GET /v1/models`
- 非流式与 SSE 响应
- Claude Code Auto mode XML 结果规范化
- Claude Code 连通性探测与本地遥测批次兼容（遥测不会转发）
- JSON Schema 结构化输出修复
- 实验性客户端工具调用桥
- 模型别名映射、传输字节保护、真实模型上下文元数据、并发队列、超时与取消
- 子进程环境变量隔离、日志清理和进程组清理

### 运行条件

| 项目 | 处理方式 |
|---|---|
| Node.js 20+ 与 npm | 执行安装命令的基础环境；安装器会自动检查版本 |
| 项目运行依赖 | 由 npm 自动安装；当前版本没有第三方运行时依赖 |
| 操作系统与架构 | 安装时自动检查 macOS/Linux/Windows 与 ARM64/x64 支持 |
| 临时存储 | 安装时自动验证操作系统临时目录是否可写 |
| 官方 Antigravity CLI（`agy`） | 视为用户已经安装并登录；macOS 网关复用其系统 Keychain 登录记录，其他受支持环境可使用本地会话文件 |

安装过程中会自动检查 Node 版本、操作系统、CPU 架构和临时目录，并由 npm 自动处理项目依赖。检查不通过时安装会停止并给出明确原因。网关会从 `PATH` 以及官方默认安装位置查找 `agy`，不依赖用户名或固定 Home 目录。

> Node/npm 无法由 npm 包自身从零安装，因为安装命令已经依赖 npm 才能运行。除此以外，项目依赖无需用户手动处理。`agy` 及其账号登录按本项目的使用前提处理。

#### 没有 Node.js/npm 时

npm 会随 Node.js 一起安装，不需要单独安装。任选对应系统的一种方式：

macOS（已安装 Homebrew）：

```bash
brew install node
```

macOS/Linux（使用 Node.js 官网推荐的 nvm 方式）：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

Windows PowerShell：

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
```

安装后可用 `node --version` 和 `npm --version` 验证。也可以直接前往 [Node.js 官方下载页](https://nodejs.org/en/download/) 安装 LTS 版本。

### 安装与启动

> **结论：新版本仍然是一条命令安装、一条命令启动。** 安装完成后不需要进入安装目录，也不需要手动处理项目依赖。

全局安装，只需一条命令：

```bash
npm install --global --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

安装过程中会自动完成环境检查并安装项目依赖。npm 11 会限制未授权的生命周期脚本，因此命令显式允许本项目自己的 `postinstall` 环境检查；不要使用 `--ignore-scripts`。

检查安装版本：

```bash
antigravity-gateway --version
# 0.2.1
```

安装后，无论终端当前位于哪个目录，都可以直接启动：

```bash
antigravity-gateway
```

不需要进入安装目录，也不需要执行 `npm start`。项目没有第三方运行时依赖。网关的临时工作区和日志默认位于操作系统临时目录，退出请求后会自动清理。

默认监听：

```text
http://127.0.0.1:9897
```

如果 `agy` 不在默认位置：

```bash
antigravity-gateway --agy-path "/absolute/path/to/agy"
```

Windows PowerShell 示例：

```powershell
antigravity-gateway --agy-path "C:\path\to\agy.exe"
```

查看帮助：

```bash
antigravity-gateway --help
```

### 默认模式：复用本地登录态并直连 Cloud Code

默认 `ANTIGRAVITY_GATEWAY_TRANSPORT=direct`。网关按以下顺序工作：

1. macOS 优先读取当前用户系统 Keychain 中 `service=gemini`、`account=antigravity` 的官方登录记录。
2. 找不到 Keychain 记录时，再检查 `~/.gemini/jetski-standalone-oauth-token` 和 `~/.gemini/oauth_creds.json`。
3. 找到登录态后，按 Cloud Code 原生协议直接请求 `daily-cloudcode-pa.googleapis.com` / `cloudcode-pa.googleapis.com`，跳过 `agy` Agent 包装层。
4. access token 过期时，网关从本机安装的 agy 中运行时识别对应的 OAuth 客户端配置，只向 Google OAuth token endpoint 续期；不会启动 agy Agent，也不会把模型请求交给 agy。
5. 找不到登录态时直接返回明确的 401，不会自动切换到 agy 模式。

普通用户不需要再次配置 OAuth，也不需要把 Google token 手工复制到环境变量。只要 agy/Antigravity 已登录，直接启动网关即可：

```bash
antigravity-gateway
```

默认已是直连；也可以显式固定：

```bash
# 固定跳过 agy，直接访问 cloudcode-pa.googleapis.com
export ANTIGRAVITY_GATEWAY_TRANSPORT=direct

# 仅在没有可识别的本地 agy 会话、且你明确知道自己在做什么时，才使用手动凭据
export ANTIGRAVITY_ACCESS_TOKEN='YOUR_ACCESS_TOKEN'
export ANTIGRAVITY_PROJECT_ID='YOUR_CLOUD_CODE_PROJECT_ID'

# 方式二：使用外部生成的 Antigravity OAuth 认证 JSON
export ANTIGRAVITY_AUTH_FILE="$HOME/.config/antigravity-gateway/antigravity-auth.json"

antigravity-gateway
```

认证 JSON 可以是标准 Antigravity 记录，也可以是只包含以下字段的 JSON。它是手动兜底方式，不是默认路径：

```json
{
  "type": "antigravity",
  "access_token": "YOUR_ACCESS_TOKEN",
  "refresh_token": "YOUR_REFRESH_TOKEN",
  "project_id": "YOUR_CLOUD_CODE_PROJECT_ID",
  "expired": "2030-01-01T00:00:00Z"
}
```

`access_token` 过期且记录中存在 `refresh_token` 时，网关会按 Google OAuth 刷新方式向 token endpoint 更新内存中的访问令牌。网关不会打印令牌，也不会把刷新结果写回任何认证文件；认证文件应保持 `0600` 权限。直连模式是对非公开 `v1internal` 接口的实验性兼容，不代表 Google 官方支持，协议可能随服务端变化。

如果 agy 使用了不同的会话文件位置，可以显式指定：

```bash
export ANTIGRAVITY_LOCAL_AUTH_FILE="$HOME/.gemini/jetski-standalone-oauth-token"
```

直连模式的上游地址、模型目录和项目 ID 也可以显式配置：

```bash
export ANTIGRAVITY_DIRECT_BASE_URL=https://cloudcode-pa.googleapis.com
export ANTIGRAVITY_DIRECT_MODELS='gemini-3.7-flash-high,gemini-3.7-flash-low'
```

默认仅监听本机回环地址，API Key 可以为空。如需设置本地接口密码：

```bash
ANTIGRAVITY_GATEWAY_API_KEY=change-me antigravity-gateway
```

Windows PowerShell：

```powershell
$env:ANTIGRAVITY_GATEWAY_API_KEY = "change-me"; antigravity-gateway
```

更新与卸载：

```bash
npm install --global --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
npm uninstall --global antigravity-gateway
```

更新安装不会替换已经运行在内存中的旧进程。更新后请先在旧网关终端按 `Ctrl+C`，再运行 `antigravity-gateway`；启动横幅中的 `网关版本` 应显示当前版本。

只有参与项目开发时才需要克隆源码，然后在项目根目录运行 `npm test` 或 `npm start`；普通用户直接使用上面的全局安装和 `antigravity-gateway` 启动命令即可。

健康检查与模型目录：

```bash
curl http://127.0.0.1:9897/
curl http://127.0.0.1:9897/v1/models
```

### 客户端接口

| 客户端 | Base URL | API Key | 模型 ID |
|---|---|---|---|
| Claude Code | `http://127.0.0.1:9897` | 任意非空值；若网关设置了 Key，必须一致 | 例如 `gemini-3.7-flash-high` |
| Codex CLI | `http://127.0.0.1:9897/v1` | 同上 | 例如 `gemini-3.7-flash-high` |
| OpenAI Chat 客户端 | `http://127.0.0.1:9897/v1` | 同上 | 以 `/v1/models` 为准 |

如系统配置了代理，建议加入：

```bash
export NO_PROXY=127.0.0.1,localhost
```

#### Claude Code

临时测试，不修改配置文件：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:9897
export ANTHROPIC_AUTH_TOKEN=change-me
export ANTHROPIC_API_KEY=change-me
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576
claude --model 'gemini-3.7-flash-high[1m]'
```

Windows PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:9897"
$env:ANTHROPIC_AUTH_TOKEN = "change-me"
$env:ANTHROPIC_API_KEY = "change-me"
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "1048576"
claude --model "gemini-3.7-flash-high[1m]"
```

Cloud Code 当前为 Gemini 3.7 Flash 返回 `1,048,576` 输入 tokens 和 `65,536` 最大输出 tokens。Claude Code 不认识第三方模型 ID 时会自行采用 200K 回退窗口；模型名后缀 `[1m]` 或 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` 用于告诉 Claude Code 真实窗口，并不会修改或压缩网关输入。网关只保留 64 MiB 的 HTTP/内存字节保护，模型 token 上限由上游判定。

如果 `settings.json` 里启用了 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 或 `CLAUDE_CODE_USE_FOUNDRY`，Claude Code 会优先走对应云 provider，而不是 `ANTHROPIC_BASE_URL`。使用本地网关时请移除这些开关；这类请求不会到达网关日志。

Claude Code 的内置 `Claude Code Guide`、Explore 等辅助 Agent 会指定 Haiku，Auto mode 也会产生独立的分类请求。网关默认把 Haiku 和已识别的 Auto mode 请求路由到当前账号可用的低延迟模型，避免和主会话争用高档模型容量；其他 `claude-*` 别名仍映射到 `ANTIGRAVITY_DEFAULT_MODEL`。可显式指定辅助模型或精确别名：

```bash
export ANTIGRAVITY_FAST_MODEL=gemini-3.7-flash-low
export ANTIGRAVITY_MODEL_ALIASES='{"claude-sonnet-5":"gemini-3.7-flash-high"}'
```

直连上游返回暂时性的 `429 RESOURCE_EXHAUSTED` 时，网关会先切换备用 Cloud Code 端点，再做一次有限指数退避。它不会压缩或删除客户端上下文；持续 429 仍会按真实错误返回。

Claude Code 2.1.251 会额外注入一条 Anthropic SDK 身份声明，Cloud Code 会把该声明拒绝为 `429 RESOURCE_EXHAUSTED`。网关仅把这条供应商专属身份行替换为中性兼容身份；其余安全规则、权限约束、项目说明、用户提示和完整对话均原样保留。

#### Codex CLI

网关启动时会根据当前账号的真实模型目录生成 Codex catalog。先取得当前用户机器上的绝对路径：

```bash
antigravity-gateway --codex-catalog-path
```

启动横幅也会显示同一路径。把它填入 `model_catalog_json`，可避免 Codex 对第三方模型使用回退元数据；Windows 路径建议使用 TOML 单引号，避免转义反斜杠。

在 `~/.codex/config.toml` 中添加一个 provider：

```toml
model = "gemini-3.7-flash-high"
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

Windows 示例：

```toml
model_catalog_json = 'C:\Users\YOUR_NAME\.antigravity-gateway\codex-models.json'
```

然后在运行 Codex 前设置：

```bash
export ANTIGRAVITY_GATEWAY_API_KEY=change-me
codex
```

Windows PowerShell：

```powershell
$env:ANTIGRAVITY_GATEWAY_API_KEY = "change-me"
codex
```

Codex 的标准函数工具与 `apply_patch` 自由格式工具均会保持原始 Responses 类型；网关不会再把 `custom_tool_call` 错降级为普通 `function_call`。

### 选择模型

可用模型取决于用户自己的 Antigravity 账号、套餐、地区及 CLI 版本，项目不内置或承诺固定模型清单。`agy` 回退模式读取 `agy models`；直连模式优先调用 Cloud Code 的 `fetchAvailableModels`，失败时才使用保守默认 ID。也可以用 `ANTIGRAVITY_DIRECT_MODELS` 固定目录。启动网关后请查询当前网关目录：

```bash
curl http://127.0.0.1:9897/v1/models
```

把返回结果中的 `id` 填入 Claude Code、Codex CLI 或其他客户端的模型配置。README 中出现的 `gemini-3.7-flash-high` 仅为配置格式示例；如果你的目录里没有该 ID，请替换为实际返回值。

### 技术原理

```text
Claude Code / Codex CLI
          │ Anthropic / Responses / Chat Completions
          ▼
Antigravity Gateway（协议转换、校验、SSE、会话上下文）
          │ macOS Keychain / 本地会话（仅内存）
          │ Cloud Code JSON/SSE 直连
          ▼
     Antigravity 服务
```

直连分支使用本地 agy 会话对应的 Google OAuth Bearer，优先尝试 `daily-cloudcode-pa.googleapis.com`，再尝试 `cloudcode-pa.googleapis.com`，向 `/v1internal:generateContent` 或 `/v1internal:streamGenerateContent?alt=sse` 发送 Antigravity 原生请求，并填写 `project`、`requestId`、`request.sessionId`、`userAgent`、`request.contents`、`request.tools` 和 `request.toolConfig`。它不启动 `agy`，所以不会注入 `agy` 的 Agent 系统提示词；Anthropic、Responses、Chat Completions 的协议转换仍由本地网关负责。

没有本地会话时，网关使用的官方回退参数是：

```bash
agy --input-format stream-json \
    --output-format stream-json \
    --mode plan \
    --sandbox \
    --model MODEL_ID
```

网关不会加入 `--dangerously-skip-permissions`，并让 `agy` 在网关创建的空白临时目录中运行。网关不会主动把 Claude Code 或 Codex 的工程目录作为 `agy` 工作目录。

### 工具调用如何工作

两种传输模式的工具链路不同：

- `direct` 模式使用 Cloud Code 原生 Function Calling，把 Claude/OpenAI 的 `tool_use`、`tool_calls`、`tool_result` 和 `function_call_output` 结构化映射为 `functionCall`/`functionResponse`，并在会话内保留工具 ID、工具名称和 `thoughtSignature`。对于网关重启后遗留的 Gemini 3 工具历史，如果客户端没有回传签名，会使用 Cloud Code 兼容的首个调用标记，避免直接触发 `missing a thought_signature`；真实签名仍优先使用。
- `agy` 模式的无头协议没有直接接收 Claude Code/Codex 外部工具定义的原生接口，因此仍采用“结构化工具投影”：

  1. 网关把客户端提供的工具名称、说明和 JSON Schema 放进受控提示区。
  2. 模型需要工具时返回一个专用 JSON 信封。
  3. 网关严格检查工具名称与参数 Schema，并生成客户端调用 ID。
  4. Claude Code 或 Codex 在自己的权限体系内执行工具。
  5. 下一次请求把工具结果交回网关，模型继续回答。

网关本身不执行客户端工具。直连模式使用原生 Function Calling；`agy` 模式的信封投影仍属于实验性兼容层。

### 安全与隐私

- 默认只监听 `127.0.0.1`。
- 非本机地址监听时强制要求设置 API Key。
- macOS 直连模式调用系统 `/usr/bin/security` 读取当前用户 Keychain 中官方 agy 登录记录，仅在内存中解析；令牌不会进入日志、响应、配置文件或仓库。
- `agy` 子进程只继承 HOME、PATH、语言和终端等最小环境，不继承 OpenAI Key、网关 Key或其他云凭据。
- 每次请求结束后删除独立工作目录和 `agy` 日志。
- 默认日志只记录接口、实际模型、请求字符数、工具数和错误摘要，不记录提示词正文。
- 工具名和参数必须匹配客户端白名单，网关不会自行执行它们。
- Antigravity CLI 1.1.18 没有“完全关闭全部内置工具”的无头参数。本项目使用 `plan + sandbox + 空白工作目录 + 内置工具事件拒绝` 降低风险，但这不是强安全边界；不要用它处理不可信提示词或高度敏感工程。

### 已知限制

- 默认 `direct` 模式不会启动 agy Agent；只有用户显式设置 `ANTIGRAVITY_GATEWAY_TRANSPORT=agy` 才使用旧兼容传输。
- Keychain 项目名、本地会话字段和 agy 内置 OAuth 客户端格式都属于官方客户端实现细节，可能随 CLI 更新而变化；识别失败时网关会返回登录态诊断，不会静默回退。
- 请求会消耗 Antigravity 账号对应的额度，并可能出现在 Antigravity 的会话历史或缓存中。
- 当前只支持文本输入；图片、音频和文件输入会返回 400。
- `agy` 模式的工具、Auto mode 和结构化输出仍以整轮结果校验为主；直连模式的普通纯文本流式请求会把上游 SSE 增量转发给客户端，带工具或结构化约束时仍可能缓冲到结果完成。
- `agy` 模式的工具桥依赖模型遵守结构化信封；直连模式虽然使用原生 Function Calling，但复杂并行工具仍需继续测试。
- Claude Code/Codex 的系统提示里可能包含当前工程路径；虽然 `agy` 的工作目录是隔离的，不能把它视为对用户目录的绝对访问隔离。
- Antigravity CLI 更新可能改变模型 ID、NDJSON 字段或系统行为。升级 `agy` 后请先运行 `npm test` 和最小真实请求。
- `count_tokens` 是字符估算值，不是 Antigravity 官方 Tokenizer 结果。

### 配置项

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `ANTIGRAVITY_CLI_PATH` | `agy` | `agy` 命令或绝对路径；默认从 `PATH` 查找 |
| `ANTIGRAVITY_GATEWAY_TRANSPORT` | `direct` | 默认直连；`auto`、`agy` 仅作为显式兼容选项 |
| `ANTIGRAVITY_LOCAL_AUTH_FILE` | Keychain，其次本地会话文件 | 可选；设置后覆盖自动登录态发现并只读取指定文件 |
| `ANTIGRAVITY_AUTH_FILE` | 空 | 外部 Antigravity OAuth JSON 路径（手动兜底） |
| `ANTIGRAVITY_ACCESS_TOKEN` | 空 | 直连模式的 OAuth access token |
| `ANTIGRAVITY_REFRESH_TOKEN` | 空 | 直连模式的 OAuth refresh token |
| `ANTIGRAVITY_PROJECT_ID` | 空 | Cloud Code project；未设置时尝试 `loadCodeAssist` |
| `ANTIGRAVITY_DIRECT_BASE_URL` | `https://cloudcode-pa.googleapis.com` | 直连上游地址 |
| `ANTIGRAVITY_DIRECT_MODELS` | 空（自动探测） | 可选；固定直连 `/v1/models` 展示的逗号分隔模型列表 |
| `ANTIGRAVITY_DIRECT_MODEL_DISCOVERY_TIMEOUT_MS` | `3000` | 直连上游模型目录探测超时；失败时使用保守默认模型 |
| `ANTIGRAVITY_DIRECT_USER_AGENT` | 自动生成 `antigravity/cli/... (aidev_client; ...)` | 直连请求 User-Agent |
| `ANTIGRAVITY_GATEWAY_HOST` | `127.0.0.1` | 监听地址 |
| `ANTIGRAVITY_GATEWAY_PORT` | `9897` | 监听端口 |
| `ANTIGRAVITY_GATEWAY_API_KEY` | 空 | 本地接口密码；非本机监听时必填 |
| `ANTIGRAVITY_GATEWAY_RUNTIME_DIR` | 操作系统临时目录 | 隔离工作区和临时日志所在目录 |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | `~/.antigravity-gateway` | 持久化 Codex 模型目录所在位置 |
| `ANTIGRAVITY_DEFAULT_MODEL` | `gemini-3.7-flash-high` | 默认模型与 Claude 别名目标 |
| `ANTIGRAVITY_FAST_MODEL` | 自动选择账号中的低延迟模型 | Haiku 辅助 Agent 与 Auto mode 分类请求目标 |
| `ANTIGRAVITY_MODEL_ALIASES` | `{}` | JSON 模型别名表 |
| `ANTIGRAVITY_DIRECT_MAX_RETRIES` | `1` | 429/5xx 在备用端点失败后的额外重试轮数 |
| `ANTIGRAVITY_DIRECT_RETRY_BASE_MS` | `1500` | 直连瞬时错误的初始退避毫秒数 |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | `300000` | 单轮超时 |
| `ANTIGRAVITY_GATEWAY_BODY_LIMIT` | `67108864` | HTTP 请求体字节保护；不是模型 token 窗口 |
| `ANTIGRAVITY_GATEWAY_PROMPT_BYTE_LIMIT` | `67108864` | `agy` 兼容模式规范化提示的字节保护；不是模型 token 窗口 |
| `ANTIGRAVITY_GATEWAY_CONTEXT_LIMIT` | 空 | 旧版字节配置别名，仅兼容已有配置；建议改用 `PROMPT_BYTE_LIMIT` |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | `4` | 同时处理的上游请求数量 |
| `ANTIGRAVITY_GATEWAY_MAX_QUEUE` | `32` | 等待队列长度 |

### 项目验证范围

- 自动化测试覆盖 worker、HTTP 协议转换、SSE、工具结果回传、会话隔离和错误处理。
- 已在 Windows 11 x64 上用官方 agy 1.1.22 本地登录态验证 Claude Code 2.1.251 的 1M 会话、PowerShell 工具、Auto mode 与 Explore 子代理，以及 Codex CLI 0.151.0 的 Responses、终端工具和 `apply_patch` 闭环。
- 已在 macOS ARM64 上用 Keychain 登录态回归 Anthropic/Responses、Claude Code 文件工具与 Codex CLI 文件工具，Windows 修复不会替换原有 macOS 认证路径。
- 不同 CLI 版本、账号模型目录及复杂开发任务仍可能存在兼容性差异，提交 Issue 时请附 Node、`agy` 和客户端版本以及脱敏后的错误日志。

## English

Antigravity Gateway is an experimental local compatibility gateway. It reads the official Antigravity/agy login state from the current user's macOS Keychain or compatible local session files, keeps credentials in memory, and uses the native Cloud Code request envelope, headers, and SSE response shape. This lets Claude Code, Codex CLI, and Trae call Antigravity through local Anthropic/OpenAI-compatible endpoints without the long `agy` Agent wrapper prompt.

The default transport is `direct`; model requests never silently fall back to the agy Agent. On macOS, the gateway uses the system `security` command to read the `gemini / antigravity` Keychain record in memory. Tokens are never logged, returned to clients, committed, or written back to plaintext files.

Claude Code connectivity probes are handled locally. Its telemetry batch endpoint is acknowledged with HTTP 204 and is never forwarded upstream.

> This is not an official Google project. It is intended for learning, interoperability research, and personal testing. It does not grant additional model access or bypass plan, quota, regional, or Terms of Service restrictions.

Current release: `v0.2.1`. Every release updates `package.json`, the startup banner, `--version`, and `CHANGELOG.md`.

### Requirements

| Item | Handling |
|---|---|
| Node.js 20+ and npm | Bootstrap environment used to run the install command; the installer validates the version |
| Project runtime dependencies | Installed automatically by npm; the current release has no third-party runtime dependencies |
| Operating system and architecture | macOS/Linux/Windows and ARM64/x64 support are checked during installation |
| Temporary storage | The operating system's temporary directory is checked for write access |
| Official Antigravity CLI (`agy`) | Assumed to be installed and signed in; the gateway reuses agy's local session state and does not manage installation or accounts |

The install process validates Node, the operating system, CPU architecture, and temporary storage. npm handles project dependencies automatically. Installation stops with a clear error when an environment check fails. The gateway searches both `PATH` and the official default `agy` install location.

> An npm package cannot bootstrap Node/npm from nothing because npm is already required to run the install command. All other project dependencies are handled automatically. An installed and authenticated `agy` is treated as a usage prerequisite.

#### If Node.js/npm is not installed

npm is bundled with Node.js and does not need to be installed separately. Choose one method for your platform.

macOS with Homebrew:

```bash
brew install node
```

macOS/Linux using the nvm method recommended on the Node.js download page:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

Windows PowerShell:

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
```

Verify with `node --version` and `npm --version`, or install an LTS release from the [official Node.js download page](https://nodejs.org/en/download/).

### Install and start

> **Summary: the new release still uses one command to install and one command to start.** After installation, users do not need to enter the package directory or manage project dependencies manually.

Install globally with one command:

```bash
npm install --global --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

The environment is checked and project dependencies are installed automatically. npm 11 restricts unapproved lifecycle scripts, so the command explicitly allows this package's own `postinstall` check. Do not use `--ignore-scripts`.

Check the installed version:

```bash
antigravity-gateway --version
# 0.2.1
```

Start from any directory with one command:

```bash
antigravity-gateway
```

There is no need to enter the installation directory or run `npm start`. The package has no third-party runtime dependencies. The default address is `http://127.0.0.1:9897`. Isolated workspaces and temporary logs are stored under the operating system's temporary directory and are cleaned up after each request.

### Fast direct transport

The default `ANTIGRAVITY_GATEWAY_TRANSPORT=direct` reads the official `gemini / antigravity` record from the current user's macOS Keychain, then checks `~/.gemini/jetski-standalone-oauth-token` and `~/.gemini/oauth_creds.json` as compatibility fallbacks. The gateway calls the Cloud Code `v1internal` endpoints directly and skips the `agy` Agent wrapper prompt. If no login state is found, it returns 401 instead of silently switching transports.

You do not need a second OAuth setup. Sign in once through agy/Antigravity, then run:

```bash
antigravity-gateway
```

To override the local session path:

```bash
export ANTIGRAVITY_LOCAL_AUTH_FILE="$HOME/.gemini/jetski-standalone-oauth-token"
```

Only for an explicit manual fallback, you can force direct transport and provide a standard Antigravity credential:

```bash
export ANTIGRAVITY_GATEWAY_TRANSPORT=direct
export ANTIGRAVITY_ACCESS_TOKEN='YOUR_ACCESS_TOKEN'
export ANTIGRAVITY_PROJECT_ID='YOUR_CLOUD_CODE_PROJECT_ID'
antigravity-gateway
```

Alternatively point `ANTIGRAVITY_AUTH_FILE` at an Antigravity OAuth JSON record. The file may contain `access_token`, `refresh_token`, `project_id`, and `expired`. Refresh tokens are exchanged in memory through Google's OAuth token endpoint and are never printed or written back. Direct transport is experimental because the `v1internal` service is not a documented public API.

Use a custom CLI path when needed:

```bash
antigravity-gateway --agy-path "/absolute/path/to/agy"
```

Windows PowerShell:

```powershell
antigravity-gateway --agy-path "C:\path\to\agy.exe"
```

Set a local gateway key before exposing the endpoint to clients:

```bash
ANTIGRAVITY_GATEWAY_API_KEY=change-me antigravity-gateway
```

Windows PowerShell:

```powershell
$env:ANTIGRAVITY_GATEWAY_API_KEY = "change-me"; antigravity-gateway
```

Update or uninstall:

```bash
npm install --global --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
npm uninstall --global antigravity-gateway
```

Updating the package does not replace an already-running process in memory. Stop the old gateway with `Ctrl+C`, start `antigravity-gateway` again, and confirm the `Gateway version` line in the startup banner.

Cloning the repository and using `npm test` or `npm start` is only necessary for contributors. Regular users should use the global install command and run `antigravity-gateway` from any directory.

### Endpoints

- `GET /`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`
- `POST /v1/chat/completions`

### Claude Code

```bash
export NO_PROXY=127.0.0.1,localhost
export ANTHROPIC_BASE_URL=http://127.0.0.1:9897
export ANTHROPIC_AUTH_TOKEN=change-me
export ANTHROPIC_API_KEY=change-me
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576
claude --model 'gemini-3.7-flash-high[1m]'
```

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:9897"
$env:ANTHROPIC_AUTH_TOKEN = "change-me"
$env:ANTHROPIC_API_KEY = "change-me"
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "1048576"
claude --model "gemini-3.7-flash-high[1m]"
```

Cloud Code currently reports a 1,048,576-token input window and 65,536 maximum output tokens for Gemini 3.7 Flash. Claude Code falls back to 200K for an unknown third-party model ID; `[1m]` or `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` tells the client the real window. The gateway does not compress the conversation.

Remove `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` when using the local gateway. Those provider switches take precedence over `ANTHROPIC_BASE_URL`, so such requests never reach the gateway.

Claude Code built-in helper agents such as Claude Code Guide and Explore request Haiku, while Auto mode sends separate classifier turns. The gateway routes Haiku aliases and detected Auto mode classifiers to an available low-latency model so they do not compete with the main high-tier route. Override the auxiliary model or an exact alias when needed:

```bash
export ANTIGRAVITY_FAST_MODEL=gemini-3.7-flash-low
export ANTIGRAVITY_MODEL_ALIASES='{"claude-haiku-4-5-20251001":"gemini-3.7-flash-low"}'
```

For transient `429 RESOURCE_EXHAUSTED` responses, direct transport tries the alternate Cloud Code endpoint and then performs one bounded exponential-backoff retry. It does not compress or discard client context; persistent quota errors remain visible to the client.

Claude Code 2.1.251 injects a standalone Anthropic SDK provider-identity line that Cloud Code rejects as `429 RESOURCE_EXHAUSTED`. The gateway replaces only that provider-specific identity marker with a neutral compatibility identity; all safety rules, permissions, project instructions, user prompts, and conversation content remain intact.

### Codex CLI

At startup the gateway writes a dynamic Codex model catalog from the current account. Print its absolute path with:

```bash
antigravity-gateway --codex-catalog-path
```

```toml
model = "gemini-3.7-flash-high"
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

On Windows, use a TOML literal string so backslashes do not need escaping:

```toml
model_catalog_json = 'C:\Users\YOUR_NAME\.antigravity-gateway\codex-models.json'
```

```bash
export ANTIGRAVITY_GATEWAY_API_KEY=change-me
codex
```

The catalog prevents Codex from applying fallback metadata to the third-party model ID. Standard function tools and free-form tools such as `apply_patch` preserve their native Responses types.

### Models

Available models depend on the user's Antigravity account, plan, region, and CLI version. The `agy` fallback reads `agy models`; direct mode first calls Cloud Code `fetchAvailableModels` and uses a conservative default only if discovery fails. `ANTIGRAVITY_DIRECT_MODELS` can pin the direct catalog. This project does not ship or guarantee a fixed catalog.

```bash
curl http://127.0.0.1:9897/v1/models
```

Use an `id` returned by this endpoint in the client configuration. Model IDs shown elsewhere in this README are examples only.

### Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `ANTIGRAVITY_CLI_PATH` | `agy` | CLI command or absolute path; resolved from `PATH` by default |
| `ANTIGRAVITY_GATEWAY_TRANSPORT` | `direct` | Direct by default; `auto` and `agy` remain explicit compatibility options |
| `ANTIGRAVITY_LOCAL_AUTH_FILE` | Keychain, then local session files | Optional override; when set, only the specified file is read |
| `ANTIGRAVITY_AUTH_FILE` | empty | External Antigravity OAuth JSON path (manual fallback) |
| `ANTIGRAVITY_ACCESS_TOKEN` | empty | OAuth access token for direct transport |
| `ANTIGRAVITY_REFRESH_TOKEN` | empty | OAuth refresh token for direct transport |
| `ANTIGRAVITY_PROJECT_ID` | empty | Cloud Code project ID; otherwise `loadCodeAssist` is attempted |
| `ANTIGRAVITY_DIRECT_BASE_URL` | `https://cloudcode-pa.googleapis.com` | Direct upstream base URL |
| `ANTIGRAVITY_DIRECT_MODELS` | empty (auto-discover) | Optional comma-separated models shown by direct `/v1/models` |
| `ANTIGRAVITY_DIRECT_MODEL_DISCOVERY_TIMEOUT_MS` | `3000` | Direct upstream model discovery timeout; falls back to a conservative default |
| `ANTIGRAVITY_DIRECT_USER_AGENT` | generated `antigravity/cli/... (aidev_client; ...)` | Direct upstream User-Agent |
| `ANTIGRAVITY_GATEWAY_HOST` | `127.0.0.1` | Listen address |
| `ANTIGRAVITY_GATEWAY_PORT` | `9897` | Listen port |
| `ANTIGRAVITY_GATEWAY_API_KEY` | empty | Gateway key; required for non-loopback binding |
| `ANTIGRAVITY_GATEWAY_RUNTIME_DIR` | OS temporary directory | Isolated workspaces and temporary logs |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | `~/.antigravity-gateway` | Persistent generated Codex model catalog directory |
| `ANTIGRAVITY_DEFAULT_MODEL` | `gemini-3.7-flash-high` | Default model and client-alias target |
| `ANTIGRAVITY_FAST_MODEL` | auto-selected low-latency account model | Target for Haiku helper agents and Auto mode classifiers |
| `ANTIGRAVITY_MODEL_ALIASES` | `{}` | JSON model alias map |
| `ANTIGRAVITY_DIRECT_MAX_RETRIES` | `1` | Additional retry rounds after both endpoints return 429/5xx |
| `ANTIGRAVITY_DIRECT_RETRY_BASE_MS` | `1500` | Initial direct-transport backoff in milliseconds |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | `300000` | Per-turn timeout |
| `ANTIGRAVITY_GATEWAY_BODY_LIMIT` | `67108864` | HTTP request byte guard; not a model token window |
| `ANTIGRAVITY_GATEWAY_PROMPT_BYTE_LIMIT` | `67108864` | Normalized-prompt byte guard for `agy` compatibility mode; not a model token window |
| `ANTIGRAVITY_GATEWAY_CONTEXT_LIMIT` | empty | Deprecated byte-limit alias retained for existing configurations |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | `4` | Maximum concurrent `agy` workers |
| `ANTIGRAVITY_GATEWAY_MAX_QUEUE` | `32` | Maximum queued requests |

### How it works

In `agy` mode, the gateway starts an isolated headless subprocess and exchanges NDJSON over stdin/stdout. In direct mode, it reads the local agy session in memory and follows the native Cloud Code protocol: daily endpoint first, production endpoint fallback, OAuth Bearer, Antigravity `User-Agent`, `project`, `requestId`, `request.sessionId`, `request.contents`, `request.tools`, and `request.toolConfig`. No `agy` process or `agy` wrapper prompt is involved. Client requests are converted back into Anthropic or OpenAI responses.

Client tools use native Function Calling in direct mode: Claude/OpenAI tool blocks are mapped to Cloud Code `functionCall`/`functionResponse` parts, with tool IDs, names, and `thoughtSignature` retained across the turn. If a stale Gemini 3 tool history has lost its signature after a gateway restart or client replay, the first missing signature uses Cloud Code's compatibility sentinel instead of sending an invalid function-call part; a real signature always takes precedence. The `agy` fallback uses an experimental structured projection. The gateway validates tool names and JSON arguments, but the actual tool is executed only by Claude Code or Codex under the client's own permission system.

### Limitations

- `agy` mode is an agent-harness compatibility layer and adds the CLI's system context. Direct mode avoids that wrapper and prefers the local agy session; external OAuth files are only an explicit fallback.
- Local session filenames and fields are agy implementation details and may change across releases. If discovery fails, the root status endpoint reports that the gateway is using the official agy fallback.
- Text input only.
- Plain-text direct SSE requests stream upstream deltas; tool, Auto mode, and structured-output requests may still be buffered for validation.
- The `agy` tool projection is experimental; direct native Function Calling is preferred, but complex parallel calls still need testing.
- Calls consume normal Antigravity quota and may appear in Antigravity history/cache.
- CLI updates can change model IDs and NDJSON behavior.

### License

MIT. See [LICENSE](LICENSE).
