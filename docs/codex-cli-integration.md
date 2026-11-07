# Codex CLI 0.164.0 接入与协议验证

本文记录 2026-11-07 本机原始 Codex CLI 0.164.0 的请求、网关转换和验收证据。Codex 使用 OpenAI Responses 作为下游协议；网关仍只使用基于 agy 1.5.2 捕获的 **Google Antigravity API** 作为上游协议。新增客户端不改变看板 OAuth 账号入口、账号池、安装路径、默认 `9897` 端口、固定 5 小时账号粘性或额度保护规则。

本机为 npm `@openai/codex` 分发的 `codex-darwin-arm64`，版本输出 `codex-cli 0.164.0`，二进制 SHA-256：

```text
d8990e3ee7acfbc26f91265b12a1a83f0fee40d0e0f8f1f40a37d4ec21f499cf
```

三层证据分别判断：原始 CLI 对本地假 Responses 服务证明客户端实际发包；原始 CLI → 真实网关 → 本地假 Google 服务证明转换及客户端执行闭环；真实 Google 验证另列模型、请求数与传输证据。目录声明、mock 和单元测试不能代替真实模型接受结果。

## 1. 接入配置与目录采用

合并到 Codex 自己的配置文件，通常为 `~/.codex/config.toml`；已有自定义 `CODEX_HOME` 的用户沿用原目录。顶层键放在第一个 TOML 表之前：

```toml
model = "gemini-3.8-flash-high"
model_provider = "antigravity"
web_search = "disabled"

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
codex exec "说明当前项目的结构"
```

若网关已设置专用客户端 Key，环境变量应使用该值。这里的 Key 仅用于访问网关，Google 账号仍通过网关看板 OAuth 添加；项目规则、权限和工具审批由 Codex 管理。

`base_url` 路由推理，`model_catalog_url` 是独立的完整目录 URL，两者都配置。有效的 `model_catalog_json` 优先于远程目录：使用远程目录时移除旧本地设置，或主动更新为 `antigravity-gateway --codex-catalog-path` 返回的文件。配置方式与优先级见 [OpenAI 官方网关接入说明](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway)。

[text-gateway-catalog.json](../tests/fixtures/codex-0.164.0-20261107/text-gateway-catalog.json) 证明目录被实际采用：CLI 发出 `GET /v1/models?client_version=0.164.0`，首个 developer 指令变为网关中性 `base_instructions`，工具出现 freeform `apply_patch` 与 `multi_agent_v1`，随后收到 SSE 正常退出。没有目录的 [text-installation-metadata.json](../tests/fixtures/codex-0.164.0-20261107/text-installation-metadata.json) 使用内置 fallback 指令，缺少该 catalog 路径中的 `apply_patch`，两者不混作同一模板。

目录实现为 [antigravity-gateway.js](../antigravity-gateway.js) 的 `codexModelInfo` / `codexCatalogBody`：

| 字段 | 当前行为 |
| --- | --- |
| `prefer_websockets`、`use_responses_lite` | 均为 `false`，使用 HTTP/SSE |
| `tool_mode` | `direct`，客户端接收自己声明的工具调用 |
| `apply_patch_tool_type` / `multi_agent_version` | `freeform` / `v1` |
| `supports_parallel_tool_calls` | `true`；每个请求仍遵守 `parallel_tool_calls` |
| `base_instructions` | 中性客户端指令，不声明客户端品牌或虚构模型身份 |
| `input_modalities` | 依据实际目录能力输出 `text` 或 `text,image` |
| `supports_video` / `supports_audio` / `supported_mime_types` | 保留上游能力；不扩写 Codex 的 `text/image` 枚举 |
| `default_reasoning_level` / `supported_reasoning_levels` | 仅展示模型名固定档位；预算型配置不虚构 low/high 可切档 |

早期空账号池目录未声明图片能力，独立图片探针被 CLI 本地拒绝。最终完整网关场景先发现 `supportsImages`，再由 CLI 发送图片，见第 7 节；不把空池失败当作转换成功证据。

## 2. 实际请求头与字段

主推理、工具续轮和自动压缩均抓到 `POST /v1/responses`。实际 UA：

```text
codex_exec/0.164.0 (Mac OS 15.7.0; arm64) dumb (codex_exec; 0.164.0)
```

| 请求头 | 实抓内容及处理 |
| --- | --- |
| `originator` | `codex_exec`；与精确 UA、非空 `session-id` 一起识别版本 profile |
| `session-id`、`thread-id` | 不透明会话标识；本次由 `session-id` 提供稳定会话来源 |
| `x-client-request-id`、`x-codex-window-id` | 请求/窗口元数据，不写入模型对话 |
| `x-codex-turn-metadata` | JSON，含 session/thread/turn/window、请求类别和 installation 标识；证据脱敏 installation 值 |
| `x-codex-beta-features` | 样本为 `remote_compaction_v2`，不能据此断言实际调用远程 compact |
| `accept` / `content-type` | `text/event-stream` / `application/json` |
| `authorization` | 网关客户端凭据，不原样转发为 Google 令牌 |

这些是下游头。上游仍由 `agy-request-profile` 和原生传输构造 Google Antigravity API 的 UA、请求头与 envelope，不把 `codex_exec` 或安装标识带入上游身份。

| 请求体字段 | 实抓值或语义 | 转换边界 |
| --- | --- | --- |
| `model` | 带档位公开名称 | 精确解析；不因辅助任务暗换模型 |
| `stream` | `true` | Responses SSE |
| `input` | developer/user/assistant、function/custom call 与 output | 保留角色和工具关联；developer/system 投影为系统指令 |
| `tools` | function/custom/namespace；压缩轮可为 `[]` | 完整可逆声明转换 |
| `tool_choice` | 样本为 `auto` | named/required/none 另有协议回归；不能选未声明工具 |
| `parallel_tool_calls` | 普通轮 `true`；压缩轮 `false` | `false` 限制单次客户端调用，多调用明确拒绝；工具参数中的同名业务字段保留 |
| `reasoning` | `{ "effort": "low" }` | effort 不覆盖模型名配置 |
| `store` | `false` | 不要求 OpenAI 云端存储；网关自己的会话恢复仍工作 |
| `include` | `["reasoning.encrypted_content"]` | 不伪造 OpenAI 加密推理；输入 opaque reasoning 不能成为 Google 签名 |
| `prompt_cache_key` | 不透明键 | 明确 `session-id` 优先；不承诺 Google 同名缓存语义 |
| `client_metadata` | 客户端元数据 | 不改写成系统身份或用户文本 |

实抓没有顶层 `instructions`，框架与权限是独立 developer 块。normalizer 仍区分 Responses `instructions` 与历史 `instructionMessages`，上一轮顶层 `instructions` 不自动继承。

## 3. 13 个叶子工具与可逆契约

catalog 路径为 **9 个顶层声明、13 个可执行叶子声明**，其中 1 个 namespace 含 5 个 function。下表列名称与第一层参数；完整嵌套 Schema、枚举、必填项和描述见 [原始请求](../tests/fixtures/codex-0.164.0-20261107/text-gateway-catalog.json)，转换器使用完整契约。

| 名称 / namespace | 类型 | 参数 |
| --- | --- | --- |
| `exec_command` | function | `cmd`, `justification`, `login`, `max_output_tokens`, `prefix_rule`, `sandbox_permissions`, `shell`, `tty`, `workdir`, `yield_time_ms` |
| `write_stdin` | function | `chars`, `max_output_tokens`, `session_id`, `yield_time_ms` |
| `request_user_input` | function | `questions` |
| `apply_patch` | custom | 原始补丁字符串，Lark grammar |
| `view_image` | function | `path` |
| `multi_agent_v1.close_agent` | function | `target` |
| `multi_agent_v1.resume_agent` | function | `id` |
| `multi_agent_v1.send_input` | function | `interrupt`, `items`, `message`, `target` |
| `multi_agent_v1.spawn_agent` | function | `fork_context`, `items`, `message`, `model`, `reasoning_effort` |
| `multi_agent_v1.wait_agent` | function | `targets`, `timeout_ms` |
| `get_goal` | function | 无参数对象 |
| `create_goal` | function | `objective`, `token_budget` |
| `update_goal` | function | `status` |

表中的点号仅便于阅读。实际 Responses 回程保留 `name:"close_agent"` 和 `namespace:"multi_agent_v1"` 两个字段，与 [OpenAI namespace 调用示例](https://developers.openai.com/api/docs/guides/tools-tool-search) 一致；引用它不代表网关实现了托管 tool search。

[protocol.js](../src/protocol.js) 与 [antigravity-tool-contract.js](../src/antigravity-tool-contract.js) 的处理规则：

- namespace 与叶子名共同构成稳定内部键；同名普通工具、不同 namespace 和形似内部前缀的客户端名称分别编码，避免碰撞。
- 分组与叶子描述均保留；声明顺序不改变归属。缺名、嵌套分组、归属冲突和重复声明明确报错。
- 上游声明使用 `mcp_gateway_tool_<hash>` 兼容视图。无法完整投影的 Schema 使用 `argumentsJson`，原 Schema 本地完整校验。
- `toolSummary` 仅在对应视图中作为传输字段；客户端同名业务参数保留。回程不暴露包装函数名。
- Codex 读取实际使用 `exec_command`。网关不将它偷换成 `read_file`，不代执行命令、补丁或子代理工具。
- 回程保留 `call_id`、原名、namespace、function/custom 类型和参数；回执再关联真实上游 function call、function response 和签名。

实抓 `apply_patch` 的原始 grammar 为 **578 字符**，SHA-256 `d6367f4826ed608c424b0a308f3d6163527df63c22513d089b91863552f8bfeb`。下列内容对应 fixture 的 `format.definition`（原字段保留末尾换行）：

```lark
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
```

上游用 `{input: <原始字符串>}` 包装 custom 工具；回程恢复 `custom_tool_call.input`，不双重 JSON 编码。仅完整匹配已验证 grammar 才启用补丁校验，未知 grammar 明确报能力错误。回归还覆盖 namespace 内的同类 custom 工具。

## 4. 按来源清理身份

[agy-client-profile.js](../src/agy-client-profile.js) 以精确 UA、`originator=codex_exec` 和非空 `session-id` 识别 `codex-exec-0.164.0`。这是模板能力识别，不是认证凭据；旧 0.159.2 profile 保留，未知版本不继承清理规则。

[client-identity.js](../src/client-identity.js) 提供 `sanitizeClientIdentity(normalized, {clientProfile})`。Codex 必须同时满足 Responses、确认的 0.164.0 profile、首块 developer、完整模板及一致的系统投影：

| 来源 | 处理 |
| --- | --- |
| 无 catalog 的 fallback | 校验前 16,979 字符 SHA-256 `3b08633fa672906666659d764864dfda1d7af5b5111ea5817c8f46e5de4e1a8d`，只删开头 Codex CLI/OpenAI 介绍与后续 Codex 名称解释两处 |
| catalog 中性首 developer | 识别但原文不改，没有身份可删 |
| 后续权限、AGENTS/SOUL、项目规则、引用、工具参数 | 原文保留 |
| 未知版本、近似模板、引用包装、位置不同、额外顶层 instructions 或投影不一致 | 保守保留 |

fallback 的精确性、工具使用、AGENTS 适用范围和权限行为要求保留，完整模板后追加的用户尾文也保留。不会改写成假 Google 身份；命中 metadata 仅留在网关内部。实际中性首句为 `Follow the client instructions and use only client-provided tools when needed.`。external-sandbox 的权限块不同于早期 workspace-write 块，但两者均不属于身份删除范围。

## 5. 固定模型、会话与压缩

公开模型名唯一决定思考。例如 `gemini-3.8-flash-low` 固定 `LOW`，即使客户端传 `reasoning.effort=high` 也不改档、不报冲突、不警告。切档必须更换模型名；见 [responses-parallel-control.test.js](../tests/responses-parallel-control.test.js) 与 [模型矩阵](model-profile-matrix.md)。

[session-manager.js](../src/session-manager.js) 使用实际 `session-id`，并按客户端与凭据来源隔离。`prompt_cache_key` 变化不会覆盖明确会话 ID；原账号池粘性不变。上游历史、签名和映射由既有会话状态恢复，客户端 opaque reasoning 不能伪造 Google 签名。

自动压缩见 [原始样本](../tests/fixtures/codex-0.164.0-20261107/compact-external-sandbox.json) 与 [完整网关样本](../tests/fixtures/codex-gateway-0.164.0-20261107/compact-v3.json)：

1. 首轮 Responses 发出读取工具。
2. 第二轮仍为 `/v1/responses`，`tools=[]`、`parallel_tool_calls=false`，保留旧调用与回执并生成摘要。
3. 第三轮恢复工具声明，用摘要替代较早历史继续任务。

三轮 profile、session 和路由身份一致，没有冒充 agy checkpoint。实际没有 `/responses/compact` 调用或 WebSocket 握手；本次只承诺配置的 HTTP/SSE 及上述实际压缩流程。

## 6. SSE 与结束语义

SSE 以 `data:` JSON 的 `type` 表示事件，并提供递增 `sequence_number`，不要求另有 `event:` 行。文本使用 `response.output_text.delta/done`，function 参数使用 `response.function_call_arguments.delta/done`，custom 原文使用 `response.custom_tool_call_input.delta/done`；输出项保留名称、namespace 和 `call_id`。

正常完成为 `response.completed`。截断、过滤和流中错误遵循 [终止语义说明](response-termination-and-json-boundaries.md)，HTTP 200 不等于完整成功；未完整校验的工具调用不会交给客户端执行。usage 依据实际上游字段转换，缺失不编造。

客户端工具错误作为真实回执进入下一轮，不改写成成功。`view_image` 图片回执与 `--image` 输入走既有媒体转换，与内部生图服务分开；Codex 图片 mock 不代表真实 Google 图片理解或生成能力已验收。

## 7. 验收证据与范围

### 原始 CLI 捕获

[probe-codex-requests.js](../scripts/probe-codex-requests.js) 生成 [codex-0.164.0-20261107](../tests/fixtures/codex-0.164.0-20261107/) 中的有效 catalog/fallback、read、patch、error 和 compact 样本，工具由真实 CLI 对临时文件执行。较早 `passed:false` 启动、权限、空池图片诊断保留，不计为通过。旧首份样本的 `installationIdContentUnchanged` 布尔值曾一起脱敏，不能拿该字符串作通过断言；后续报告已使用真实布尔及摘要。

### 真实 CLI → 真实网关 → 本地假 Google

[verify-codex-gateway.js](../scripts/verify-codex-gateway.js) 已完成下列 **9/9 场景**。生成数不包含目录与额度元数据 RPC：

| 场景 | 生成数 | 关键判据 | 证据 |
| --- | --- | --- | --- |
| 文本 | 1 | CLI 最终文本 | [text-v3.json](../tests/fixtures/codex-gateway-0.164.0-20261107/text-v3.json) |
| 读取 | 2 | 真实 exec 读取、内容回传、续轮 | [read-v3.json](../tests/fixtures/codex-gateway-0.164.0-20261107/read-v3.json) |
| 补丁 | 2 | custom 原文、精确磁盘内容 | [patch-v3.json](../tests/fixtures/codex-gateway-0.164.0-20261107/patch-v3.json) |
| 工具失败 | 2 | 不存在文件的真实错误回传 | [error-v3.json](../tests/fixtures/codex-gateway-0.164.0-20261107/error-v3.json) |
| 图片工具回执 | 2 | view_image 结果成为 inlineData | [image-v3.json](../tests/fixtures/codex-gateway-0.164.0-20261107/image-v3.json) |
| 图片输入 | 1 | CLI --image 成为 inlineData | [image-input-v3.json](../tests/fixtures/codex-gateway-0.164.0-20261107/image-input-v3.json) |
| 自动压缩 | 3 | 空工具摘要轮、摘要续接 | [compact-v3.json](../tests/fixtures/codex-gateway-0.164.0-20261107/compact-v3.json) |
| namespace | 2 | close_agent 对不存在 UUID 的真实错误；不启动子代理 | [namespace-error-v4.json](../tests/fixtures/codex-gateway-0.164.0-20261107/namespace-error-v4.json) |
| 并行回执 | 2 | 两次 exec 返回各自文件内容 | [parallel-v1.json](../tests/fixtures/codex-gateway-0.164.0-20261107/parallel-v1.json) |

9 份 `assessment.checks` 合计 **127 项 true、17 次合成生成**，汇总见 [summary.json](../tests/fixtures/codex-gateway-0.164.0-20261107/summary.json)。每景包含 CLI exit 0、完整 HTTP/SSE、目录采用、AGENTS 保留、固定 low 模型和思考、源码/installation 内容不变、临时清理。48 文件源码快照 SHA 为 `bb69a30be3c72a2aed88e0b9f4cf5389a29100644a25166abdd2d7cce03d0d82`。

保留真实 handler、AccountPool、Direct、会话和转换，只将原生 fetch 出口替换为限制 loopback 的 fetch，使用假凭据。因此此组不证明原生 TLS 或真实 Google 接受；对应 `nativeTLSValidated` / `realModelValidated` 不冒充通过。

### 真实 CLI → 真实网关 → 真实 Google

[verify-real-codex-gateway.js](../scripts/verify-real-codex-gateway.js) 的 [summary.json](../tests/fixtures/real-codex-gateway-20261107/summary.json) 记录 **3/3 场景通过，6 次物理生成全部 HTTP 200**，模型明确为 `gemini-3.8-flash-low`：

| 场景 | 生成数 | 实际结果 |
| --- | --- | --- |
| [text.json](../tests/fixtures/real-codex-gateway-20261107/text.json) | 1 | 完整 SSE 与最终标记 |
| [read.json](../tests/fixtures/real-codex-gateway-20261107/read.json) | 2 | 原名 exec、真实随机文件内容、原 call ID/签名和回执续轮 |
| [patch.json](../tests/fixtures/real-codex-gateway-20261107/patch.json) | 3 | 真实 custom 补丁失败回执、修正执行、精确磁盘内容与最终回复 |

补丁首轮给出的 `@@ -1,1 +1,1 @@` 上下文被 Codex 实际拒绝，错误回传后模型改用正确 `@@` 补丁并写入成功。这是同一任务中的客户端真实错误恢复，不是网关暗重试或另跑实验；3 次生成均计入验收预算。

实际使用原生 Google 传输，报告校验官方 UA、原生调用、工具 call ID/签名回传。57 文件 runtime 摘要 `22ab8a34c9344c949a439e4dced55ebf341dabce37484bb8b834baa2b7d60c90` 前后相同；正式 accounts/state 与 installation 文件内容不变，临时网关/native 进程退出，临时目录清理完成。该摘要与上节 48 文件 mock 摘要的统计集合不同，不直接比较字符串断言源码变化。

首次生成前的 OAuth 支持请求共 11 次：3 次 HTTP 200 返回有效期 3599 秒的 token，8 次 HTTP 401；没有整条刷新失败日志。结合 `local-agy-auth` 的候选循环，可推断存在候选失败后成功，但脱敏记录不能逐 token、逐账号证明对应关系，因此不写成所有账号或所有候选认证均成功。本组只证明上述模型及 3 个场景；图片、压缩、namespace 和并行场景的 Codex 证据仍属 mock。

### 隔离、回归与未扩展范围

探针使用原签名 CLI，不重设 `HOME` / `CODEX_HOME`；sqlite/log/work 使用临时目录并受外层 Seatbelt 限制。启动所需的现有非凭据 `installation_id` 为唯一精确写打开例外，内容 SHA 前后不变；Codex 正式 auth/config 内容保持隔离，报告不输出安装标识或令牌。

版本/身份/旧 Codex/会话回归 **70/70**，namespace 独立回归 **5/5**，覆盖前缀碰撞、不同 namespace 同名、named choice、custom、乱序回执和重启签名恢复。新增 [codex-cli-evidence.test.js](../tests/codex-cli-evidence.test.js) 的 **9/9** 证据回归检查完整矩阵与失败反例。最终整体回归 **1006/1006**、70 个 JS 文件语法检查、`git diff --check` 通过；57 文件 runtime 摘要与真实验收一致。这些验证不代表实际执行全部 13 个工具。

代表范围为文本、受控读取/补丁、错误恢复、图片传递、namespace 分派、并行回执、压缩及 SSE。本轮未新增 TUI、跨进程 resume 或 CLI 取消的真实实跑；也未宣称全部插件/MCP server、实际子代理任务、远程 compact、WebSocket 或 OpenAI 托管工具均已验证。Responses 服务器搜索未提供，接入配置明确 `web_search = "disabled"`。
