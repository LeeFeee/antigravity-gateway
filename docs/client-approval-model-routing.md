# 客户端审批与辅助模型路由

审查日期：2026-11-07。本文核对本机实际安装的客户端源码、配置和已有捕获，区分独立模型审批、本地权限规则及普通辅助请求。本轮静态审查不等同于已经触发各客户端的真实审批流程。

网关只负责协议转换、模型路由和账号调度。批准、拒绝、升级到人工确认及错误后的任务处理由客户端决定。不得为了返回成功而伪造批准结果，也不因发现“审批”字样就统一替换各客户端的模型。

## 当前结论

| 客户端 | 独立模型审批 | 本机当前状态 | 模型选择 |
| --- | --- | --- | --- |
| Claude Code 2.1.318 | Auto Mode 分类器 | 默认分类请求使用 `claude-sonnet-5`；本轮修复网关兼容路由 | 已识别的 Auto Mode 请求且原模型恰为 `claude-sonnet-5` 时转到 `gemini-3.8-flash-low`，无需设置 `CLAUDE_CODE_AUTO_MODE_MODEL` |
| Hermes 当前安装提交 `2bd378ed1b` | Smart Approvals | 内置配置默认 `smart`，本机配置没有覆盖该项；具体会话仍可覆盖审批模式 | `auxiliary.approval` 默认为 auto，继承当前主 provider／model；正式默认为 Antigravity High |
| Pi 1.5.0 | 默认流程未发现独立审批 LLM | 当前未启用全局 extensions／packages；`classify()` 是扩展或 codemode 显式调用能力 | 压缩和分支摘要使用当前会话模型，正式默认为 Antigravity High |
| dsh 0.2.1-rc.2 | 可选实验性 Auto review 插件 | 插件默认关闭，本机 headless／web／superagent 的 bundle 和 patch 未加载 | 开启后沿用最新主请求的 provider／model，无固定 Sonnet 5 分类器 |
| Codex CLI 0.164.0 | 可选 Auto-review／Guardian | 功能可用，但本机 `approval_policy="never"`、`approvals_reviewer="user"`，未启用 | 存在 `codex-auto-review` 等独立模型线索；实际 Guardian 请求去向未捕获，不能声称已兼容网关 |

## Claude Code：恢复默认分类请求的兼容路由

旧版 1.7.5 会识别 Auto Mode 的 `<severity>` 或 `<block>` 输出契约，为该类请求优先选择快速模型。2.0.0 重构一度将所有显式模型都直接保留，导致默认 `claude-sonnet-5` 分类请求不再转到网关可用的 Low 模型。

本轮修复限定为：

- 已由协议层识别为 Auto Mode 分类器，且请求模型为 `claude-sonnet-5`：路由到 `gemini-3.8-flash-low`。
- 普通对话请求 `claude-sonnet-5`：不套用分类器规则。
- 显式选择其他分类器模型，例如 `gemini-3.8-flash-high`：保留该选择。
- 分类器政策、用户上下文和实际判定内容保持；无效或缺失判定仍作为错误交回客户端。

实现见 [antigravity-gateway.js](../antigravity-gateway.js) 的 `resolveModel()`；识别见 [protocol.js](../src/protocol.js) 的 `detectAutoModeFormat()`；回归见 [api-classifier-isolation.test.js](../tests/api-classifier-isolation.test.js)。此处不宣称已完成本轮真实 Claude 验收；该结果由部署验收记录另行补充。

## Hermes：确有 Smart Approvals，默认继承主模型

本机安装来源为 `$HOME/.hermes/hermes-agent`，Git 描述为 `v0.21.7+canary.20261012T072214Z-11135-g2bd378ed1b`。

Hermes 会先用本地规则识别需要审批的命令，再在 Smart 模式下调用 `auxiliary.approval`，要求独立模型返回 `APPROVE`、`DENY` 或 `ESCALATE`。未知结果、空回答和调用异常均交由 Hermes 升级为人工确认，不能当成网关批准执行。

本机 `config.yaml` 没有 `approvals` 或 `auxiliary.approval` 覆盖。配置加载会先复制 `DEFAULT_CONFIG`，再合并用户配置；因此有效默认是 `approvals.mode=smart`。不能把 `_get_approval_mode()` 在读取失败时使用的防御默认 `manual` 当成实际默认配置。

辅助路由先使用明确的任务配置；`provider:auto` 表示优先继承当前主 provider 和主模型，之后才按 Hermes 的任务 fallback、主 fallback 或自动发现链处理。正式主模型是 `gemini-3.8-flash-high`，使用本地网关的 `codex_responses`，没有硬编码到不存在的 Sonnet 5。

审批函数传入 `max_tokens=16` 并默认要求关闭思考，但当前 Responses 辅助适配器会省略 `max_output_tokens`。因此不能将“16 token 与 High 冲突”认定为当前已经证实的问题。审批默认 30 秒超时，High 的延迟可能导致客户端升级到人工确认；本轮未针对该场景进行真实审批测试。

其他辅助请求也要单独区分：标题任务当前已通过 Hermes 自身配置指定 Low、120 秒超时；压缩等未覆盖的任务默认继承主模型。此前标题的真实验收不能代替本轮 Smart Approvals 验收。

本机源码定位：

- 默认审批模式（`$HOME/.hermes/hermes-agent/hermes_cli/config_defaults.py:1661`）、配置默认值合并（`$HOME/.hermes/hermes-agent/hermes_cli/config.py:2248`）。
- 审批触发流程（`$HOME/.hermes/hermes-agent/tools/approval.py:1256`）、独立判断与异常处理（`$HOME/.hermes/hermes-agent/tools/approval_smart.py:88`）。
- 主模型继承（`$HOME/.hermes/hermes-agent/agent/auxiliary_client.py:4455`）、辅助路由顺序（`$HOME/.hermes/hermes-agent/agent/auxiliary_client.py:4568`）、Responses 输出参数（`$HOME/.hermes/hermes-agent/agent/auxiliary_client.py:1488`）。

## Pi：显式分类能力不等于默认审批

Pi 的 `classify()` 是供扩展或 codemode 显式调用的 API，不是每次工具执行前自动发起的独立审批。包内 `permission-gate` 是示例扩展：通过正则识别危险命令后向用户确认，不额外调用模型。

压缩和分支摘要会使用模型，但调用取当前会话的 `this.model`。本机正式默认为 `antigravity / gemini-3.8-flash-high`，没有发现默认辅助请求固定到网关缺失模型的情况。该结论不覆盖用户之后安装的任意扩展。

本机源码位于 `$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@earendil-works/pi-coding-agent/`：`dist/core/model-runtime.js:561`、`docs/codemode.md:62`、`examples/extensions/permission-gate.ts:14`、`dist/core/agent-session.js:2254` 和 `:3352`。

## dsh：实验性审批存在，当前没有启用

`@deepseek-ai/dsh-experimental-auto-review` 开启后会为原生或 PTC 内层工具调用发送独立判断请求，要求严格的 `risk`／`decision` JSON；失败时工具不执行。判断沿用最新主请求的 provider 和 model，没有硬编码的隐藏分类器模型。

本机 headless、web 和 superagent 的 bundle／patch 均未启用该插件，因此不能把“安装包包含插件”写成“当前每次工具调用都使用模型审批”。本轮也没有触发真实 Auto review 请求。

标题任务在未覆盖模型时使用主请求 route；压缩模型按“显式摘要配置 → 最新请求 route → Agent 默认模型”选择。正式默认 route 为 `antigravity-gateway / gemini-3.8-flash-high`。

源码目录为 `$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，定位包括：`dsh-experimental-auto-review/README.md:12` 和 `:87`、`dsh-experimental-auto-review/lib/index.js:398`、`dsh-base/cordis.patch.yml:67`、`dsh-session-title-llm/lib/index.js:115`、`dsh-compaction-basic/lib/index.js:292`。

## Codex CLI：Guardian 尚未在网关路径验收

本机 Codex CLI 为 0.164.0，`guardian_approval` 功能标记为 stable，但当前配置是 `approval_policy="never"`、`approvals_reviewer="user"`。当前不会触发独立 Guardian 审批。启用条件与模式含义见 [官方 Auto-review 文档](https://learn.chatgpt.com/docs/sandboxing/auto-review)。

本机二进制存在 `codex-auto-review` 模型、`auto_review_model_override` 和 `guardian_model_provider_id` 等线索，能证明独立判断机制和模型选择入口存在，不能据此确定开启后一定走当前自定义 provider。现有网关探针采用 `approval_policy="never"`，没有捕获 Guardian 请求，故不将其计为网关已兼容能力。

本机默认 Codex CLI 当前使用 `gpt-6-astra`，配置中没有自定义 `model_provider` 或 profiles，默认入口尚未配置为本地网关。此前网关验收是显式探针接入，不能等同于默认 CLI 已切换。

压缩与权限判断也不是同一功能。已有显式网关捕获中的压缩仍使用同一个 `gemini-3.8-flash-low`，工具数从 9 到 0 再回到 9，见 [Codex 接入记录](codex-cli-integration.md)。`review_model` 则属于 `/review` 代码审查覆盖项，不是 Guardian 的权限审批设置。

## 验收边界

本文件仅新增只读审查结论和 Claude 路由修复说明。没有替其他客户端新增模型映射、修改审批模式、迁移默认 Codex 接入或将未触发的审批流程记录为真实成功。启用这些可选判断能力后，应分别捕获实际请求和返回格式，再判断是否需要网关兼容。
