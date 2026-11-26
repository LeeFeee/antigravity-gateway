# Antigravity Gateway 2.4.1

将 Google Antigravity API 与 Google Gemini API 接入 Claude Code、Codex、Hermes、Pi 和 dsh，提供 Anthropic Messages、OpenAI Responses、Chat Completions，以及文件和图片接口。

2.4.1 默认使用 Google Antigravity API 的 `gemini-4-hydrogen-high`，模型列表优先展示 Gemini 4 系列；用户显式指定的模型及档位仍原样路由。Claude Code 的 Antigravity Auto 审批使用 `gemini-4-hydrogen-low`，Gemini API 审批继续使用对应的 `-g` 模型，不依赖修改客户端 Auto 设置。

本版减少重复 Schema 编译通信和模型目录请求，保留逐次工具参数校验及独立取消；完善采样空值、Responses 缓存/思考用量、辅助接口 401 刷新、异步解压与看板截图加载。普通带工具请求可实时输出正文，工具参数和签名仍完整校验，生成中途失败不跨账号拼接答案。搜索、生图及结构化响应保留各自回程约束。

同时修复 Codex 生图后的 `image_generation_call` 历史回显，保留图片字节与严格签名关联。用户 SOUL、规则、技能、权限和完整工具契约继续保留。

Google 已公告 Gemini 3.8 Flash、Gemini 4 Argon、GPT-OSS 120B 和 Claude 4.6 于 **2026 年 11 月 30 日**下线，见[官方模型说明](https://antigravity.google/docs/models)。网关仍依据账号的实时目录展示可用模型，不把旧模型请求静默替换成新模型。

## 安装与更新

需要 **Node.js 20+**。安装包自带原生传输二进制，支持 **macOS、Linux、Windows 的 arm64 与 x64**，无需安装 Go 编译器。

安装、更新使用同一命令；`--allow-scripts` 的值应与后面的完整安装 URL 一致：

```bash
npm install --global --foreground-scripts --allow-scripts=https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
antigravity-gateway --version
```

默认监听 `127.0.0.1:9897`，数据保存在 `~/.antigravity-gateway`。首次启动可设置网关访问 Key，再注册后台服务：

```bash
export ANTIGRAVITY_GATEWAY_API_KEY=xxxxx
antigravity-gateway service start
antigravity-gateway stats
```

本文所有 `xxxxx` 都是需要自行替换的凭据占位。也可直接运行 `antigravity-gateway` 使用前台模式。

```bash
antigravity-gateway service status
antigravity-gateway service restart
antigravity-gateway service stop
antigravity-gateway service logs
antigravity-gateway service uninstall
```

更新已有后台服务时，先执行 `service stop`，运行上面的安装命令，再执行 `service restart`，沿用原服务配置。`service start` 用于首次注册或更新服务环境；更改环境变量后需带着新设置重新执行它。

升级时沿用原 Node/npm 全局安装位置、数据目录和服务配置，账号、访问 Key、累计用量和文件继续保留。`service uninstall` 移除后台注册，不删除账号池和媒体数据。

## 从看板添加账号

打开 `http://localhost:9897/dashboard`，或执行 `antigravity-gateway stats`。分别点击“添加 Antigravity 账号”和“添加 Gemini 账号”，在浏览器完成 Google OAuth。若无法打开网关机器的 localhost 回调页，可将浏览器中的完整回调 URL 粘贴回看板提交。

**新增账号仅通过看板 OAuth。** 两个上游独立管理账号与额度，分别保存到 `accounts/` 和 `gemini-accounts/`。网关不导入本机客户端的登录账号，也不会用另一个池补齐空池。看板提供账号删除、重新认证、额度和用量查看。

Antigravity 授权所需的 OAuth 客户端元数据可从已安装的 agy 发现；需要指定位置时使用 `--agy-path /path/to/agy` 或 `ANTIGRAVITY_CLI_PATH`。网关不会启动 agy 执行推理。

## 接口与模型

| 协议 | 客户端基址 | 推理路径 |
| --- | --- | --- |
| Anthropic Messages | `http://localhost:9897` | `/v1/messages` |
| OpenAI Responses | `http://localhost:9897/v1` | `/v1/responses` |
| OpenAI Chat Completions | `http://localhost:9897/v1` | `/v1/chat/completions` |

模型目录为 `GET /v1/models`，也可运行：

```bash
antigravity-gateway --models
```

按目录选择完整模型名：

- 带 `-g` 后缀的已注册模型使用 Google Gemini API，例如 `gemini-4-hydrogen-low-g`；其他模型使用 Google Antigravity API。
- 带档位的模型名固定思考配置。例如 `gemini-4-hydrogen-high` 始终使用其 HIGH 档位，客户端冲突的 `reasoning_effort` 或 thinking budget 不覆盖它。切换档位应更换模型名。
- 不同上游使用各自账号池。网关不因失败而暗中改换模型或档位。

Google Gemini API 当前使用任务模式，任务多模态暂未接入；图片生成、图片编辑和视频理解使用支持相应能力的 Antigravity 模型。

客户端填写自己的网关 Key。未设置 `ANTIGRAVITY_GATEWAY_API_KEY` 的本机服务可接受任意客户端 Key；非本机监听必须设置专用 Key。

## Claude Code

将以下内容合并到 `~/.claude/settings.json` 的现有配置中：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:9897",
    "ANTHROPIC_AUTH_TOKEN": "xxxxx",
    "ANTHROPIC_MODEL": "gemini-4-hydrogen-high"
  }
}
```

启动 `claude`。如需网关生成的动态模型列表，可使用：

```bash
claude --settings "$(antigravity-gateway --claude-config-path)"
```

Claude Code Auto 的工具审批由实际模型评估后返回客户端，客户端继续决定是否执行。无需为接入网关修改权限规则或开启额外审批开关。

## Codex 0.171.0

推荐创建独立的 `~/.codex/antigravity.config.toml`。使用自定义 `CODEX_HOME` 时，将文件放入该目录。`--profile antigravity` 会将此文件叠加到原基础配置，保留原有规则、MCP、技能和审批设置；无需改写主 `config.toml` 或 ChatGPT 的 `auth.json`。

```toml
model = "gemini-4-hydrogen-high"
model_provider = "antigravity"

[model_providers.antigravity]
name = "Antigravity Gateway"
base_url = "http://localhost:9897/v1"
model_catalog_url = "http://localhost:9897/v1/models"
wire_api = "responses"
env_key = "ANTIGRAVITY_CLIENT_API_KEY"
requires_openai_auth = false
supports_websockets = false
```

```bash
export ANTIGRAVITY_CLIENT_API_KEY=xxxxx
codex --profile antigravity
# 非交互任务
codex --profile antigravity exec "说明当前项目的结构"
```

`env_key` 是读取 Key 的环境变量名，实际 Key 放在该变量中。直接运行 `codex` 仍使用原基础配置与 ChatGPT 登录态。

`base_url` 和 `model_catalog_url` 都应配置。若旧配置含 `model_catalog_json`，它会优先于远程目录，需要移除旧覆盖项或同步其内容。此接入使用 HTTP/SSE；命令、补丁、图片查看与 MCP 工具仍由 Codex 执行。

## Hermes

合并到 `~/.hermes/config.yaml`；自定义 `HERMES_HOME` 时沿用原目录。明确选择 Responses 传输：

```yaml
model:
  provider: antigravity
  default: gemini-4-hydrogen-high
providers:
  antigravity:
    api: http://localhost:9897/v1
    api_key: xxxxx
    transport: codex_responses
    default_model: gemini-4-hydrogen-high
```

```bash
hermes
```

需要原生图片输入时，按模型能力配置 `model.supports_vision: true` 和 `agent.image_input_mode: native`。

## Pi

合并到 `~/.pi/agent/models.json`，或 `PI_CODING_AGENT_DIR` 指定的目录：

```json
{
  "providers": {
    "antigravity": {
      "baseUrl": "http://localhost:9897/v1",
      "api": "openai-responses",
      "apiKey": "xxxxx",
      "models": [{
        "id": "gemini-4-hydrogen-high",
        "name": "Gemini 4 Hydrogen (High)",
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
pi --provider antigravity --model gemini-4-hydrogen-high
```

示例的上下文与输出限制应按实际模型目录调整；`cost` 是客户端显示估算，不表示账号没有额度消耗。

## dsh

将下列 patch 合并到所用 profile 的 `~/.dsh/profiles/<profile>/cordis.patch.yml`，或保存为 `antigravity.yml` 后通过 `--patch` 加载：

```yaml
- id: agent-default-model
  config:
    provider: antigravity-gateway
    model: gemini-4-hydrogen-high
    reasoningEffort: high
- id: llm-pi-ai
  config:
    providers:
      antigravity-gateway:
        displayName: Antigravity Gateway
        apiKeyEnv: ANTIGRAVITY_CLIENT_API_KEY
        api: openai-responses
        baseURL: http://localhost:9897/v1
        models:
          - id: gemini-4-hydrogen-high
            name: Gemini 4 Hydrogen (High)
            contextWindow: 200000
            maxTokens: 8192
            input: [text, image]
            reasoningEfforts:
              high: high
```

```bash
export ANTIGRAVITY_CLIENT_API_KEY=xxxxx
dsh web --patch ./antigravity.yml
# headless 调用
dsh --profile headless --patch ./antigravity.yml --json "你的请求"
```

模型限制同样按目录调整。Web 与 headless 使用各自的 profile 配置。

## Pi / dsh 动态模型发现

在运行客户端的机器上，先安装好 Pi、dsh，并持久保存它们原有的网关连接，再运行包内安装器：

```bash
node "$(npm root -g)/antigravity-gateway/scripts/install-model-discovery.js"
```

安装器同时配置 Pi 扩展和 dsh 插件，复用现有连接、Key、默认模型与权限，通过 `/v1/models` 刷新模型目录。默认 Pi provider 为 `antigravity`，dsh provider 为 `antigravity-gateway`，dsh profiles 为 `web,headless`。不同命名可显式指定：

```bash
node "$(npm root -g)/antigravity-gateway/scripts/install-model-discovery.js" \
  --pi-provider antigravity \
  --dsh-provider antigravity-gateway \
  --dsh-profiles web,headless
```

Pi 首次安装后执行 `/reload`，dsh 首次安装后重启客户端。扩展文件位于包内 `integrations/model-discovery/`；连接仍由各客户端自己的配置管理。

## 图片、视频与文件

普通自动选工具的 Antigravity 对话默认提供图片生成能力，由模型决定是否调用，无需开启开关。图片生成默认模型为 `gemini-3.1-flash-image`，可用 `ANTIGRAVITY_IMAGE_MODEL` 指定目录中的其他图片模型。生成结果交回原主模型续答。

客户端声明的 shell、文件、图片查看和 MCP 工具仍由客户端执行。结构化输出、Auto 分类器、禁止或强制工具选择等不兼容契约不额外注入生图工具。用户规则、技能、记忆与执行权限继续保留。

| 功能 | HTTP 入口 |
| --- | --- |
| 文件上传、信息、内容读取与删除 | `/v1/files` 及其子路径 |
| 图片生成 | `POST /v1/images/generations` |
| 图片编辑 | `POST /v1/images/edits` |

客户端可通过 Files 上传图片、视频等内容，再以 `file_id` 引用，或发送支持的内联内容和远程 URL。上传内容默认私有；生成图片可返回 URL 或 Base64。图片模型列表见 `/v1/models` 的 `image_generation_model_ids`。

本地视频可使用随包提供的[视频理解技能](skills/antigravity-video-understanding/SKILL.md)，脚本自动上传视频、发送原生 `input_video`，完成后删除本次临时上传：

```bash
python3 "$(npm root -g)/antigravity-gateway/skills/antigravity-video-understanding/scripts/analyze_video.py" \
  "/path/to/video.mp4" \
  --base-url http://localhost:9897 \
  --api-key xxxxx \
  --model gemini-4-hydrogen-high \
  --prompt "概括视频内容，并说明关键变化。"
```

HTTP 默认不读取网关服务器上的 `file_path` 或 `file://`。确需读取可信本机媒体时，设置 `ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS=1`，并用 `ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS` 指定允许目录的绝对路径 JSON 数组。

## 常用环境变量

| 变量 | 作用 |
| --- | --- |
| `ANTIGRAVITY_GATEWAY_HOST` / `--host` | 监听地址，默认 `127.0.0.1` |
| `ANTIGRAVITY_GATEWAY_PORT` / `--port` | 监听端口，默认 `9897` |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | 数据目录，默认 `~/.antigravity-gateway` |
| `ANTIGRAVITY_GATEWAY_API_KEY` | 客户端访问 Key |
| `ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW` | 额外允许访问看板的来源 IP/CIDR，默认仅本机 |
| `ANTIGRAVITY_DEFAULT_MODEL` / `--model` | 请求未指定模型时的默认模型 |
| `ANTIGRAVITY_IMAGE_MODEL` | 默认图片生成模型 |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | 推理并发上限，默认 `12` |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | 请求期限，默认 `300000` 毫秒 |
| `ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS` | 设为 `1` 时允许受限的本机媒体路径 |
| `ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS` | 本机媒体允许目录的绝对路径 JSON 数组 |

上游选择以模型名为准，`ANTIGRAVITY_GATEWAY_TRANSPORT` 不切换推理上游。后台服务使用注册时保存的环境配置；保持原数据目录即可沿用原账号与历史数据。
