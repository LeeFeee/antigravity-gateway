# Antigravity Gateway

当前版本：**2.2.0**。

将看板管理的多个账号提供给 Claude Code CLI、Codex CLI、Hermes、Pi、dsh 使用。支持 **Google Antigravity API**（agy 1.5.8 协议基线）与 **Google Gemini API**（Gemini app 原生任务模式）两套直接上游，各用自己的账号池；客户端可以使用 **Anthropic Messages**、**OpenAI Responses** 或 **OpenAI Chat Completions**。

网关负责协议转换、账号选择、额度保护、请求历史转换与返回格式转换。文件读取、命令执行等客户端工具仍由客户端执行，保留客户端的权限和审批规则。Files、图片生成和图片编辑接口继续提供。

完整约定见 [重构产品说明](docs/antigravity-gateway-refactor-spec.md)，最初四客户端的实际请求结构见 [Agent 请求目录](docs/agent-request-catalog.md)，Codex 扩展见 [Codex 接入与验收](docs/codex-cli-integration.md)，当前实现与验收缺口见 [实施进度](docs/refactor-progress.md)。

## 2.2.0：新增 OpenAI Chat Completions

新增 `POST /v1/chat/completions`，与原有 Messages、Responses 并行提供服务；基址仍为 `/v1`，鉴权、模型名称、账号池、粘性、轮询及额度判断沿用原规则。

支持普通 JSON、SSE、工具往返、旧式 functions、结构化输出与原有媒体能力。真实验证覆盖 Antigravity／Gemini 工具调用、图片输入和生成，以及 Messages、Responses、Claude Auto 回归；1,206 项测试全部通过。接入方式见 [Chat Completions](docs/chat-completions.md)，具体覆盖与边界见 [验收记录](docs/chat-completions-verification.md)。

## 2.1.3：Pi 与 dsh 动态模型发现

新增客户端扩展与安装脚本，使 Pi、dsh 从网关 `/v1/models` 自动同步模型目录：启动时获取，运行期间每 60 秒刷新，新增模型无需手工追加本地清单。同步模型 ID、能力与固定思考档位，保留原连接、密钥和默认模型；网络失败时沿用上次成功的目录。

本机 Pi、dsh 已自动发现 24 个模型，原默认 Flash High 与新发现的 `gemini-4-hydrogen-sonar` 均通过真实工具调用验收，包含 dsh 网页模式。安装方式和实际覆盖范围见 [动态模型发现说明](docs/dynamic-model-discovery.md)。此功能需在运行客户端的机器上安装扩展。

## 2.1.2：dsh 网页模式请求兼容

补齐 dsh 网页模式的官方文件引用模板识别，并对已实测触发 429 的网页开发说明做精确、等义转换。保留原模型、档位、31 个工具、用户规则和权限；无需修改 dsh 配置。命令行模式的通过不能替代网页模式验收，具体证据见 [dsh 网页模式修复记录](docs/dsh-web-2.1.2.md)。

## 2.1.1：补齐真实交互模式

修复 Claude Code 直接打开终端交互时遗漏的框架转换，以及 Hermes 交互后台附加的用户指示说明中的默认客户端身份。此前 `claude -p` 和 Hermes `--format stream-json` 的通过记录不能覆盖这两条交互路径。本次按真实交互请求单独核验，保留原模型、思考档位、用户规则、完整工具和审批合同；无需修改客户端审批设置。具体范围见 [交互模式修复记录](docs/interactive-greeting-2.1.1.md)。

## 2.1.0：Gemini 任务模式与完整客户端兼容

新增 **Google Gemini API** 上游，直接使用 Gemini app 的任务模式接口，运行时无需安装或启动 Gemini app。通过看板“添加 Gemini 账号”完成授权并检查账号状态，凭据保存在独立的 `gemini-accounts/`，不导入旧 Robin/Windows Gemini 文件。原有 Antigravity 账号、端口和密钥继续沿用。

Gemini 模型以 `-g` 区分：`gemini-4-hydrogen-g`、`gemini-4-argon-g` 及其明确的 `-low-g` 名称。默认别名指向 Low。目录依据真实 Task 策略，不发布聊天模式的 High/Medium；没有客户端工具的文本请求和 Claude Auto 审批也使用 Task 接口。对外继续使用原有 Messages/Responses 地址，Gemini 模型只使用 Gemini 账号池，不跨上游降级。

Gemini 的任务多模态暂未接入，图片生成、编辑和视频理解继续使用 Antigravity 模型。首次原生登录弹窗与“不参加改进计划”选项的完整对应验证按用户决定暂缓，不宣称已覆盖所有新账号。实际验收范围、初始化与偏好设置的已验证项及缺口见 [Gemini 实施记录](docs/gemini-app-protocol-evidence.md)，完整边界见 [双上游改造说明](docs/gemini-app-upstream-spec.md)。

本版还修复 Pi、Claude、Hermes 固定框架文本触发的已复现 429，以及从 Codex Desktop 启动 CLI 时的识别缺口。只转换有来源和精确指纹的框架内容，保留用户规则、工具、权限、模型和思考档位。原 Antigravity 的真实工具、Auto、媒体与升级验收，以及 Gemini 五客户端的实际覆盖范围见 [2.1.0 验收](docs/release-2.1.0-preflight.md)和 [429 修复证据](docs/antigravity-429-compatibility-20261116.md)。

## 2.0.5 更新

- 修复 Hermes 默认身份段落与官方框架之间插入多段 SOUL／自定义规则后，网关无法识别框架的问题。仍以精确指纹处理默认身份句，保留用户规则、权限、技能、记忆、工具参数与结果。
- 将 Google 明确返回的 `RESOURCE_EXHAUSTED` 状态保留到 Messages／Responses 的 JSON 和 SSE 错误中，避免 Hermes 把通用资源耗尽误报为确定的余额耗尽；账号轮询、粘性和额度策略不变。
- 新增完整请求真实环境验收脚本。本地及服务器使用原始 Hermes 失败请求、原模型及全部 19 个工具验证，不改 Hermes 配置。真实客户端的对话、文件读取及错误分类另行验收，详见 [2.0.5 验收记录](docs/hermes-2.0.5-live-validation.md)。

## 2.0.4 更新

- 直接兼容 Claude Code 2.1.322 默认 Auto 请求中的 `safeguards`，由网关调用 Flash Low／LOW 评估待执行工具，再按工具 ID 返回 `safeguard_results`；支持 JSON 和 SSE。
- 不修改 Claude Code 配置，不要求审核环境变量或分类器模型覆盖。旧的独立 `claude-sonnet-5` 分类请求仍自动路由 Flash Low。
- 判定错误、缺失、重复、截断或上游不可用时返回审核不可用；保留模型明确的阻止结果，不生成默认批准。客户端工具继续由客户端执行。

## 2.0.3 更新

- 对齐 agy 1.5.8 的 UA/build 和模型 HTTP/1.1 传输；OAuth 继续使用独立 HTTP/2 传输。
- 修复 Claude Code 原始 Auto 判断请求的思考额度转换，保留默认 Flash Low／LOW 路由，无需配置分类器模型覆盖。
- 截断或过滤的 Auto 判定明确返回错误，由客户端处理。
- 当时通过客户端审核路径设置兼容 Auto；这一方案已由 2.0.4 的网关端协议适配替代。

Claude Code 2.1.322 的 TUI、SDK **独立分类器请求**已重放至真实 Google 并返回完整判定。该记录不代表默认服务器审核路径已受支持。补充使用生成配置的实际 TUI 测试已完成“主模型调用 → 独立模型判断 → 客户端执行工具 → 主模型续答”闭环，1112 项回归通过。范围见 [Auto Mode 验收记录](docs/response-termination-and-json-boundaries.md#auto-mode-分类器的闭合停止序列)。

## 2.0.2 更新

- 对齐 agy 1.5.6 的上游请求，模型 RPC 通过原生传输协商 HTTP/2，并更新请求头和搜索格式。
- 适配 Claude Code 2.1.322、Hermes 0.23.1、Pi 1.5.2、Codex CLI 0.167.2 和 DSH 0.2.2-rc.1。
- 更新 Claude Code Auto Mode 和 WebSearch 的请求识别，Codex 同时支持 `exec` 和交互界面的新版模板。

五个客户端均完成隔离网关的文本和工具往返验证。Claude Code 文本与文件读取、Pi 文本、视频理解及独立生图已实连 Google 验证。详见 [agy 1.5.6 验证记录](docs/agy-1.5.6-compatibility.md)和 [历史更新](CHANGELOG.md)。

## 安装和更新

需要 Node.js 20 或更新版本。安装包包含原生 HTTP/TLS 传输组件，支持的系统与架构由安装时环境检查确认。已有 Antigravity CLI 可用于发现 OAuth 客户端元数据；网关不会启动它执行推理，也不会导入它的登录账号。

安装和更新继续使用同一命令：

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
antigravity-gateway --version
```

包名、可执行命令及当前 npm 全局 prefix 下的安装位置不变。默认数据目录仍为 `~/.antigravity-gateway`，默认端口仍为 `9897`。

前台启动：

```bash
antigravity-gateway
```

后台保活与服务管理：

```bash
antigravity-gateway service start
antigravity-gateway service status
antigravity-gateway service restart
antigravity-gateway service stop
antigravity-gateway service logs
antigravity-gateway service uninstall
```

`service start` 更新并启动现有服务；已有服务身份保持不变。macOS 原服务标签仍为 `io.github.leefeee.antigravity-gateway`。

## 从看板添加账号

启动网关后执行：

```bash
antigravity-gateway stats
```

或打开 `http://127.0.0.1:9897/dashboard`。在“账号池与额度”中点击添加账号，打开 Google 授权链接并完成 OAuth。若浏览器无法访问网关所在机器的 localhost 回调页，可将地址栏中的完整回调 URL 粘贴回看板提交。授权令牌保存在网关端。

**看板 OAuth 是新增账号的唯一入口。** 面板分别提供“添加 Antigravity 账号”和“添加 Gemini 账号”，并按两个上游展示账号与额度。Antigravity 的 `accounts/` 与 Gemini 的 `gemini-accounts/` 独立保存，已有 `accounts/` 数据继续沿用；空账号池会明确返回不可用，不读取本机登录态或其他凭据补齐账号。看板继续提供账号启停、权重、删除、重新检测、额度和用量。

当需要指定 OAuth 客户端元数据的发现位置时，可使用 `--agy-path /absolute/path/to/agy` 或 `ANTIGRAVITY_CLI_PATH`。这个路径不选择推理通道。

## 客户端接口和模型

| 用途 | 地址或路径 |
| --- | --- |
| Anthropic Messages 基址 | `http://127.0.0.1:9897` |
| OpenAI Responses 基址 | `http://127.0.0.1:9897/v1` |
| OpenAI Chat Completions 基址 | `http://127.0.0.1:9897/v1` |
| 推理接口 | `POST /v1/messages`、`POST /v1/responses`、`POST /v1/chat/completions` |
| 模型目录 | `GET /v1/models` |
| 文件 | `/v1/files` 及已有文件读取、删除接口 |
| 图片生成与编辑 | `POST /v1/images/generations`、`POST /v1/images/edits` |

未设置网关专用 Key 时，客户端可填写 `antigravity-gateway`；设置了 `ANTIGRAVITY_GATEWAY_API_KEY` 时，所有客户端填写该值。非本机监听必须设置专用 Key。

模型目录来自账号池的真实模型能力，可用 `antigravity-gateway --models` 查看。下文以 `gemini-3.8-flash-high` 为例，实际应选择目录中的公开模型名。

**带档位模型名唯一决定上游思考配置。** 例如选择 `gemini-3.8-flash-high` 时，即使客户端同时发送 `low`、`none`、budget 等冲突思考参数，上游仍按该名称的配置发送；冲突参数直接忽略，不报错、不警告。除下文明确列出的默认 Auto Mode 分类器映射外，辅助分类或标题请求也不会改写显式模型。未提供模型时才使用相应默认模型。

三个推理入口共用原有模型目录、鉴权、账号粘性、轮询和额度判断。Chat Completions 支持普通 JSON、SSE、客户端工具往返、结构化输出与现有媒体输入转换；详见 [Chat Completions 接入说明](docs/chat-completions.md)。基址同为 `/v1` 不代表使用同一种协议，客户端需要选择相应的传输方式。未知模型与不支持的工具/参数组合会按实际校验结果明确失败，不静默换成其他模型。

## Claude Code CLI

已捕获版本：**2.1.322**；使用 Anthropic Messages。将下列环境设置合并到自己的 Claude Code 设置中，或在启动前设置等价环境变量：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9897",
    "ANTHROPIC_AUTH_TOKEN": "antigravity-gateway",
    "ANTHROPIC_MODEL": "gemini-3.8-flash-high"
  }
}
```

也可沿用网关生成的模型配置路径：

```bash
claude --settings "$(antigravity-gateway --claude-config-path)"
```

该文件仍位于原数据目录，随账号池模型目录更新。网关只生成模型目录，不写入审核模式、权限规则或分类器模型设置。

Claude Code 默认 Auto 会在主请求中携带 `safeguards`。网关保持所选主模型，获得完整工具调用后，再按所选上游使用 Antigravity `gemini-3.8-flash-low`／LOW 或 Gemini `gemini-4-hydrogen-low-g` Task，对工具参数、会话中的用户边界和 `classifier_context` 规则做一次实际模型评估。结果按原工具调用 ID 返回；客户端继续决定是否执行，网关不执行 shell、文件或 MCP 工具。JSON 响应返回 `safeguard_results`，SSE 在结束的 `message_delta.delta` 中返回同一结构。

此路径不要求 `CLAUDE_CODE_AUTO_MODE_SERVER`，也不要求修改 Claude Code 的默认审核方式。旧版配置若已显式选择客户端独立审核，下面的旧分类请求路由仍兼容。当前覆盖 `dangerous_tool_use`／上下文 v1；未知契约明确返回错误。服务端 Anthropic 的私有审核政策并未由 Google 提供：本实现是使用请求上下文和网关公开评估指令的独立模型审核，不宣称判定与 Anthropic 服务端完全相同。模型截断、无效返回或调用失败均不能转成放行。详见 [服务器审核适配](docs/response-termination-and-json-boundaries.md#claude-code-21322-的服务器审核与客户端独立审核)。

对于旧的独立 Auto 分类请求，也无需额外配置分类器模型：网关让识别到的默认 `claude-sonnet-5` 判断请求沿用同会话最近主请求的上游，分别选择 Flash Low 或 Hydrogen Low；没有会话记录时保留原有 Flash Low 路由。普通对话仍使用所选主模型；其他显式分类器模型也保留原选择。分类政策和判断由 Claude 与实际模型负责，网关只转换并转发，不补写允许执行结论。

Auto 判断请求会在上游输出额度中预留思考空间，避免 Claude 的 `max_tokens=64` 在 Gemini 生成判定前耗尽：带思考配置的分类请求至少申请 4096 tokens，数值思考预算另计，并受模型输出上限约束。模型名称对应的思考档位保持不变。被截断或过滤的判定返回 `incomplete_auto_mode_classifier_output`，交给客户端处理；普通对话的输出额度保持原有规则。

## Codex CLI

已捕获版本：**0.167.2**；使用 OpenAI Responses。将以下设置合并到 `~/.codex/config.toml`，顶层选项放在第一个 TOML 表之前；自定义 `CODEX_HOME` 的用户沿用自己的配置目录：

```toml
model = "gemini-3.8-flash-high"
model_provider = "antigravity"

[model_providers.antigravity]
name = "Antigravity Gateway"
base_url = "http://127.0.0.1:9897/v1"
model_catalog_url = "http://127.0.0.1:9897/v1/models"
wire_api = "responses"
env_key = "ANTIGRAVITY_CLIENT_API_KEY"
requires_openai_auth = false
supports_websockets = false
```

```bash
export ANTIGRAVITY_CLIENT_API_KEY=antigravity-gateway
codex
# 非交互任务也使用同一配置
codex exec "说明当前项目的结构"
```

设置了网关专用 Key 时，将环境变量改为该值。`model_catalog_url` 是完整目录地址，`base_url` 是 Responses 基址；两者都应配置。目录向 Codex 提供模型名称、上下文、工具和固定思考档位。若已有 `model_catalog_json`，它会优先于远程目录：移除该旧配置以使用远程目录，或主动更新为 `antigravity-gateway --codex-catalog-path` 返回的本机目录文件。目录设置及优先级见 [OpenAI 官方网关接入说明](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway)。

选择其他思考档位时更换带档位模型名；Codex 的 `model_reasoning_effort` 不覆盖该约定。命令、补丁、图片查看及 MCP 工具由 Codex 执行，权限和审批沿用 Codex 配置。此接入使用 HTTP/SSE。两类上游均可接收内置 `web_search` 声明，不需要为了普通对话关闭搜索；仅在模型实际选择搜索时调用相应上游的搜索能力。离线、域名过滤、位置限制等尚不能等价支持的附加合同会明确拒绝。

## Hermes

已捕获版本：**0.23.1**。在当前 Hermes 配置中添加一个自定义 provider，明确指定 `codex_responses`；这里的配置名称表示 Responses 传输，不要求使用另一客户端。

将下列内容合并到 `~/.hermes/config.yaml`（使用自定义 `HERMES_HOME` 时按原目录）：

```yaml
model:
  provider: antigravity
  default: gemini-3.8-flash-high
providers:
  antigravity:
    api: http://127.0.0.1:9897/v1
    api_key: antigravity-gateway
    transport: codex_responses
    default_model: gemini-3.8-flash-high
```

```bash
hermes chat --provider antigravity --model gemini-3.8-flash-high
```

若要让 Hermes 原生传递图片，在其配置中按实际模型能力设置 `model.supports_vision: true` 与 `agent.image_input_mode: native`。当前采样已包含真实读取图片工具往返；`--image` 首轮直接附件场景在本次版本的隔离探测中未产生有效推理请求，不能据此声称已验证。

## Pi

已有 Pi / dsh 网关连接可启用[动态模型发现](docs/dynamic-model-discovery.md)：在项目目录执行 `node scripts/install-model-discovery.js`。Pi 通过 provider 扩展、dsh 通过 Cordis 插件同步现有网关的 `/v1/models`，启动及运行期间自动刷新，不再逐项维护新增模型。安装器保留原连接、密钥、默认模型和原始配置，目录缓存不保存密钥。已打开的 Pi 首次安装后执行一次 `/reload`；dsh 首次安装后重启客户端进程。

已捕获版本：**1.5.2**。将 provider 合并到 `~/.pi/agent/models.json`（或 `PI_CODING_AGENT_DIR` 指定目录），显式使用 `openai-responses`：

```json
{
  "providers": {
    "antigravity": {
      "baseUrl": "http://127.0.0.1:9897/v1",
      "api": "openai-responses",
      "apiKey": "antigravity-gateway",
      "models": [{
        "id": "gemini-3.8-flash-high",
        "name": "Antigravity Flash High",
        "reasoning": true,
        "input": ["text", "image"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 200000,
        "maxTokens": 8192
      }]
    }
  }
}
```

```bash
pi --provider antigravity --model gemini-3.8-flash-high
```

示例的上下文与输出限制是客户端配置值，应按所选模型实际目录调整；`cost` 为客户端展示估算，不表示账号没有额度消耗。

## dsh

已捕获版本：**0.2.2-rc.1**。通过配置 patch 明确选择 `openai-responses`。保存为自己的 `antigravity.yml`：

```yaml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash-high
    reasoningEffort: high
- id: llm-pi-ai
  config:
    providers:
      antigravity:
        displayName: Antigravity Gateway
        apiKeyEnv: ANTIGRAVITY_CLIENT_API_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:9897/v1
        models:
          - id: gemini-3.8-flash-high
            name: Antigravity Flash High
            contextWindow: 200000
            maxTokens: 8192
            input: [text, image]
            reasoningEfforts:
              high: high
```

```bash
export ANTIGRAVITY_CLIENT_API_KEY=antigravity-gateway
dsh --patch ./antigravity.yml
```

非交互调用可使用已捕获的 `dsh --profile headless --patch ./antigravity.yml --json "你的请求"`。该版本 headless CLI 没有直接图片附件参数；图片场景通过其真实 `read_image` 工具传递。上下文与输出限制同样应按所选模型调整。

## 工具、身份和文件

转换器按客户端实际声明和可确认的契约处理工具名称、参数、返回值及历史；不能等价映射的工具保留其客户端合同或明确拒绝。不会因为名称相似就把客户端工具交给网关执行。

身份清理只处理有可靠模板来源与块边界的框架自我介绍、默认模型自报及默认归属说明，并对已确认工具说明做局部处理。用户 SOUL、AGENTS、项目规则、权限、工具使用语义、普通引用及未知自定义文本保留，不将客户端替换成虚构的 Google 模型身份。

Files 保留原上传、保存、读取和后续引用方式。Images 保留生成、编辑、参考图及 URL/Base64 返回。`gpt-image-1` 是明确保留的**历史兼容别名**，映射至实际图片模型 `gemini-3.1-flash-image`，并不表示请求由 OpenAI 图片服务处理；其他未列出的图片模型不会任意映射到该模型。实际图片能力仍取决于账号的模型目录。

上传输入默认私有，`generated` 是服务端保留用途。只有网关实际生成、类型签名与内容摘要验证通过的图片才提供公开结果链接；HTML、SVG 等其他文件使用附件下载和隔离响应头。旧版 `purpose=generated` 记录无法证明来源，文件继续保留，但下载需要原 API Key 和作用域，不能继续匿名读取。

HTTP 请求默认不接受网关服务器上的 `file_path` 或 `file://`。客户端可先调用 Files 上传本机图片、视频和文档，再通过 `file_id` 引用，或传入内联内容与支持的远程 URL。可信本机流程确需读取服务器路径时，显式设置 `ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS=1`，并以 `ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS='["/absolute/media-dir"]'` 指定媒体目录。路径解析会检查真实路径与符号链接，配置和凭据目录仍被排除；通过 Nginx 转发到 loopback 不会自动开启该能力。

未指定图片模型时沿用 `ANTIGRAVITY_IMAGE_MODEL`，默认 `gemini-3.1-flash-image`。其他图片模型必须来自真实图片目录；HTTP 入口、账号选择、冷却、实际请求和用量记录采用同一模型。`GET /v1/models` 的 `image_generation_model_ids` 给出图片用途列表，完整规则见[模型配置表](docs/model-profile-matrix.md)。

对话生图是网关内置能力，无需配置开启，也不提供关闭开关。普通自动选工具的对话统一提供官方 `generate_image` 服务声明，由所选主模型决定是否调用，不通过“画图”等关键词改写请求或强制生图。生成时调用专用图片模型，再把真实结果交回原主模型续答；普通对话不会因此自动产生图片调用。

客户端已声明的同名工具仍属于客户端。结构化输出、Auto Mode 分类器、禁止或强制工具选择等不兼容契约不添加图片服务声明；客户端的 shell、文件和 MCP 工具仍由客户端执行。独立 Images 生成、编辑接口继续提供。

## 调度和旧数据兼容

所有请求，包括携带工具历史的请求，都采用同一套账号选择策略：默认固定五小时粘性，从首次绑定起计时，成功续聊不滑动延长；健康且符合额度要求的绑定优先复用。新绑定、过期或失败后按权重与额度压力重新选择，不检查候选账号是否持有该对话的原生历史。Gemini 五小时余额低于 10% 或周余额低于 5% 时进入额度保护；五小时余额低于 15% 时每分钟刷新，恢复须有成功且有效的额度读数。

普通额度刷新、失败切换、冷却与手动重检继续保留。重新检测必须有真实文本推理成功，只有模型目录请求成功不能恢复异常账号。已经向客户端交付内容的请求不能为自动切号重复执行。

上游返回 429 后，目标模型可能进入短期冷却，即使账号认证和目录额度仍显示可用。所有账号都仅因该模型冷却时，网关返回明确提示及 `Retry-After`；冷却到期表示可以重试，不保证上游已恢复，也不会自动改用其他思考档位。

```text
~/.antigravity-gateway/
├── accounts/                  # 原账号文件，继续读取
├── state/
│   ├── account-pool.json      # 原粘性与健康状态
│   ├── quota.json             # 原额度及保护状态
│   └── agy-sessions/          # 原会话派生状态
├── usage/usage-state.json     # 原累计用量
├── media/                    # 原上传和生成文件
├── logs/                     # 原日志
├── antigravity-gateway-service.json
├── claude-models.json
└── codex-models.json
```

不改名现有账号文件、不重算账号 ID、不启用已停用账号，也不重建空白数据覆盖原数据。旧 `robin-accounts/`、`gemini-win-accounts/` 等目录原位保留，当前版本不扫描、不刷新、不路由这些凭据。已有 `codex-models.json` 文件名作为历史兼容路径保留，使用 Responses 的其他客户端也可按需配置。

平滑轮询累计权重、短暂冷却和 Responses 进程内缓存继续保持原有内存生命周期，不声称这些状态全部跨重启保存。上下文保留、压缩与失败恢复由 agent 管理；网关按客户端提交的历史转换请求。本地匹配的原生历史仅作为可复用的协议转换缓存，缺少缓存不会阻止请求发往其他可用账号，也不会要求等待原账号恢复。

上游拒绝上下文时，网关通过对应客户端协议返回原上游错误，由 agent 判断如何处理。结构无效的工具历史仍返回 `400 invalid_tool_history`。默认传输策略不插入隐藏的恢复消息或自动续接中断回答；正常传输重试、账号切换和必要的协议状态仍保留。

## 常用配置

| 配置 | 作用 |
| --- | --- |
| `ANTIGRAVITY_GATEWAY_HOST` / `--host` | 监听地址，默认 `127.0.0.1` |
| `ANTIGRAVITY_GATEWAY_PORT` / `--port` | 端口，默认 `9897` |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | 数据根目录，默认 `~/.antigravity-gateway` |
| `ANTIGRAVITY_GATEWAY_API_KEY` | 客户端访问 Key |
| `ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW` | 看板允许来源，沿用已有设置 |
| `ANTIGRAVITY_DEFAULT_MODEL` / `--model` | 未提供模型时的默认模型 |
| `ANTIGRAVITY_FAST_MODEL` | 未提供模型的已识别辅助请求默认模型 |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | 网关推理并发上限 |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | 请求期限，默认 `300000` 毫秒 |
| `ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS` | 仅值为 `1` 时开启受限本地媒体路径，默认关闭 |
| `ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS` | 本地媒体允许目录的绝对路径 JSON 数组，开启本地路径时必须非空 |

`ANTIGRAVITY_GATEWAY_TRANSPORT` 不选择其他推理实现；公开模型名的 `-g` 后缀选择 Google Gemini API，其余模型使用 Google Antigravity API。已有 API Key、监听地址、看板访问设置和服务配置继续兼容。

## 验证范围与开发

[agy 1.5.6 与五个新版客户端的验证记录](docs/agy-1.5.6-compatibility.md)包含传输变更、客户端请求差异和各验证场景。

早期四客户端证据是 **真实安装客户端 → 本机合成服务** 的隔离捕获，覆盖首轮、工具读取、错误结果、并行调用、思考参数、会话续接及各客户端可用的图片路径。它证明客户端请求与工具往返的结构，不等于“客户端 → 重构网关 → 真实 Google 上游”的完整验收。具体失败样本和未覆盖项保留在请求目录中。

随后新增的 [真实网关链路验证](docs/client-gateway-integration.md) 已完成四客户端各文本与临时文件读取两个场景（8/8）：真实 CLI 经过真实网关转换后连接本机合成 Google Antigravity API，读取结果实际返回上游协议。此项仍不验证真实 Google 模型、OAuth 或 TLS。

[真实 Google 上游最小验收](docs/real-client-gateway-validation.md) 另已完成四 CLI 文本/读取 8/8，经原生 Go 传输共 16 次生成；明确使用 `claude-sonnet-4-6`，各运行源码摘要分别保存。它覆盖实际文本及读取闭环，其他工具、压缩、媒体和新账号授权按各自报告验收。

认证实现已按[官方发包证据](docs/official-auth-protocol-evidence.md)接入 PKCE、Go HTTP/2 token 请求及首次初始化轮询；当前 agy 1.5.8 的模型请求通过原生传输协商 HTTP/1.1。隔离看板真实新增授权、保存、目录、额度及刷新已通过；首次项目初始化尚缺未初始化测试账号。图片、视频和文件的 HTTP 链路见[媒体验收](docs/gateway-media-integration.md)，安装与旧数据兼容见[升级回退演练](docs/upgrade-rehearsal.md)。

[补充官方请求取证](docs/antigravity-api-1.5.2-additional-request-types.md)覆盖搜索、生图、编辑和视频摘要；[字段字典](docs/antigravity-api-1.5.2-rpc-field-dictionary.md)列出 64 个 RPC、66 条 REST 绑定及完整引用类型，分别标记实际发包和静态发现。它们不代表所有路径均已通过真实 Google 验收。

独立 Messages typed `web_search_20250305` 沿用一次转发：调用真实目录声明的 Google 搜索辅助模型，将真实来源链接和上游摘要交回 agent。Responses 内置 `web_search` 可以与客户端工具共存：Antigravity 使用已捕获的 `search_web` 声明，让原模型决定查询，将搜索辅助接口的真实结果回传同一模型继续作答；Gemini 使用原生 Task 搜索。主模型与思考档位不变，网关不抓取网页、不代替客户端执行命令或文件工具，不把搜索摘要当作网页原文。非空域名过滤、离线和位置等未等价实现的附加合同仍明确拒绝。

搜索的代表场景已分层验收：真实 Claude Code 经完整网关到合成 Google 的 WebSearch 闭环通过，另有 8 个 HTTP／SSE 与错误边界场景；[实抓辅助请求重放到真实 Google](tests/fixtures/gateway-server-search-20261107/README.md)也已通过，保留原 `max_tokens=32000`，真实目录选择 `gemini-3.5-flash-lite`，仅一次生成得到 200／STOP、真实链接及上游原摘要，模型展示、用量和 SSE 均核对一致。重放场景仅删除严格域名限制并替换测试 query，本批未启动 CLI，不能与 CLI → 合成上游证据合称同一次真实 CLI 直连 Google 搜索，也不扩大为其他模型或不支持组合。具体见[客户端搜索边界](docs/client-web-tool-boundaries.md)，当前完成项见[验收记录](docs/refactor-progress.md)。

```bash
npm run check
npm test
```

历史验收与退役通道文档仅供追溯，不能作为当前启动、添加账号或客户端接入说明。新请求类型必须先补捕获证据、字段规则和回归用例，再纳入当前协议配置。
