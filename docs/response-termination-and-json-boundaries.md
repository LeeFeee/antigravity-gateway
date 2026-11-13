# 响应结束状态与工具 JSON 边界

更新：2026-11-13。本页说明本地协议修复、对应实测范围及保留的边界。

## 结束状态

Direct 保留 Google Antigravity API 响应中的 `candidate.finishReason` 与 `promptFeedback.blockReason`。协议转换和流式末事件使用同一判断，不能用存在工具调用或已有部分文本覆盖明确的截断、过滤或错误状态。

| 上游结果 | Messages | Responses |
| --- | --- | --- |
| `STOP`，无工具调用 | `end_turn` | `completed` |
| `STOP`，完整合法的客户端工具调用 | `tool_use` | `completed`，包含工具调用项 |
| `MAX_TOKENS` | `max_tokens` | `incomplete`，`incomplete_details.reason=max_output_tokens`；输出项也为 `incomplete` |
| `SAFETY`、`RECITATION`、`BLOCKLIST`、`PROHIBITED_CONTENT`、`SPII` 或对应图片过滤原因 | `refusal` | `incomplete`，`incomplete_details.reason=content_filter` |
| 已知过滤类 `promptFeedback.blockReason`，即使没有 candidate | `refusal` | `incomplete/content_filter` |
| `OTHER`、`LANGUAGE`、格式错误类、其他无法等价转换的显式结束原因、未来未知值 | 转换错误 `502 unsupported_upstream_finish_reason` | 相同转换错误 |

此处的正常 `STOP` 不能被推测成客户端 `stop_sequence`：上游没有提供可恢复的匹配序列时，网关不编造该字段。原因分类依据 [Google 官方 SDK 的 FinishReason 定义](https://github.com/googleapis/python-genai/blob/main/google/genai/types.py)，客户端语义依据 [Anthropic stop_reason 文档](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)与 [OpenAI Responses 类型定义](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts)。

过滤发生前已收到或已流出的文本原样保留；网关只映射结束状态，不把部分普通文本改写成拒绝正文，也不虚构 `refusal` 内容块。Responses 的实时文本与缓冲输出均以 `response.incomplete` 结束，最终 response 保留过滤原因。没有可见文本、只有思考或额度用量，也不能将 `MAX_TOKENS` 当成成功完成。

完整客户端工具参数仍须通过原 Schema 校验。若上游同时返回完整工具调用与 `MAX_TOKENS`，保留合法调用及其真实历史，但截断状态优先于 `tool_use`/`completed`；网关不执行这些客户端工具。参数本身不完整或不合法时，继续返回工具转换错误，不编造可执行参数。

内部 `finish` 和 `generate_image` 具有额外边界：截断的 `finish` 不能生成“任务完成”回执，返回 `502 incomplete_structured_tool_call`；未正常结束的内部生图调用不得触发生图或后续模型请求，返回 `502 incomplete_native_image_call`，未知原因仍使用上表错误。原始文本结构化输出被截断时，返回部分文本及截断状态，不再用完整 JSON 校验把它误判成应自动重试的结构化错误。

这些错误属于转换错误，不触发账号冷却或跨账号重试。HTTP 头尚未发出时返回对应 400/502；已开始 SSE 时发送合法错误事件并关闭流。Messages 使用 `error`；Responses 使用带连续 `sequence_number` 的 `error` 事件及 `code/message/param`，不再发送缺少 response 对象的伪 `response.failed`。

缺失 `finishReason` 与显式未知原因分开处理：官方实抓存在无需后续 `STOP` 的完整工具事件，因此没有新增强制 `STOP` 限制。当前缺失字段继续采用既有正常传输完成语义；这不代表已经观测到上游发送了 `STOP`。

## Auto Mode 分类器的闭合停止序列

已识别的 Claude Code Auto Mode 分类器若使用 `severity` 或 `block` 格式，网关仅在构造上游请求时移除该格式精确的闭合停止序列 `</severity>` 或 `</block>`。Google 的停止序列会从生成结果中剔除，而网关需要模型实际生成完整 XML 才能校验判定；其他停止序列、普通请求、客户端原始请求及用户规则保持原样。[Google 生成参数与结束原因](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)

返回路径继续校验完整判定：缺失、重复、冲突或越界值仍返回 `502 invalid_auto_mode_classifier_output`。网关不补数字、不补闭合标签、不生成允许执行结论。

agy 1.5.8 实连确认，默认 Claude 分类请求的 `max_tokens=64` 会被固定 LOW 档思考耗尽，Google 返回 `MAX_TOKENS` 而没有判定文本。仅对已识别的 `severity`／`block` 分类器，上游思考请求增加输出额度：命名档位使用 4096 tokens 下限，数值预算至少保留“客户端输出额度 + 思考预算”，最终受模型目录输出上限约束。客户端原始请求、分类政策和固定思考档位不修改；普通请求、未知分类格式和未开启思考的模型不应用此下限。

分类器的截断或过滤终止会返回 `incomplete_auto_mode_classifier_output`（非流式 HTTP 502；流式 `error` 事件），即使截断文本已经包含一个完整样式的判定也不转成成功。该错误不会触发网关的格式修复重发，由客户端决定重试或审批。普通对话仍保留原有 `max_tokens`／`refusal` 终止语义。

2026-11-13 修复后，已捕获的 Claude Code 2.1.322 TUI 和 SDK 原始 Auto 请求分别经隔离网关实连 Google，通过 agy 1.5.8 原生传输返回完整判定，耗时 33.401 秒和 60.884 秒。输入均保持 `claude-sonnet-5`、`max_tokens=64`，未设置分类器模型覆盖；实际提交 Flash Low／LOW、上限 4096。两次均只有一次生成请求，完整政策和会话上下文保留，计费身份头清理，返回 `end_turn`。原捕获工具设置了 `CLAUDE_CODE_AUTO_MODE_SERVER=0`；此验收仅重放独立分类器请求，不执行被判定的工具命令，也未覆盖默认服务器审核路径。源码组合摘要为 `4987ae228d4e23bc2e48dd326e1c9e142f2e9809cdac39a2bfad0ce32535c7ff`，生产账号和配置/状态文件前后摘要一致。

回归新增覆盖思考耗尽额度、完整样式但被截断的判定、过滤结束、非流式错误和 SSE 错误；确认未完成判定不会触发格式修复重发，普通请求的输出额度与终止行为仍保留。全部 1111 项 Node 测试及 75 个运行/脚本文件语法检查通过。

Claude Code 2.1.318 的独立分类器不含主对话身份句，另按原始三个 text system 块核对来源：首块必须是该版本已捕获的 `cli` 或 `sdk-cli` billing 行，第二块必须完整匹配已确认 `severity` 或 `block` 政策的长度和 SHA-256，第三块保留原会话上下文。通过后只删除首 billing 块；政策内品牌文字、权限、用户规则、消息和附加 system 指令不改。来源证据仅含类型、长度和哈希，不转发上游；合并块、未知版本、政策改动或来源证据不匹配均不清理。完整私有政策不存入仓库测试夹具，正例用外部私有捕获离线回放。独立搜索 helper 仍单独要求其已捕获的 `cli` 模板。

Claude Code 默认以 `claude-sonnet-5` 发起的 Auto Mode 分类请求，内置路由至 `gemini-3.8-flash-low`，无需配置 `CLAUDE_CODE_AUTO_MODE_MODEL`。该映射仅对已识别的分类请求生效；普通 Sonnet 对话及其他显式分类器模型保持原样。上游思考配置由实际选中的 Low 模型名决定，客户端原始请求、完整分类政策和会话上下文保持，上游输出额度按上述规则预留思考空间。可用账号仍由统一账号池按额度和冷却选择；没有可用 Low 账号时保留真实错误，不生成批准结论。

## Claude Code 2.1.322 的服务器审核与客户端独立审核

默认 Auto 会在主 Messages 请求中发送 `dangerous-tool-use-2026-09-03` beta 和顶层 `safeguards: [{ type, classifier_context }]`，从响应读取 `safeguard_results`。Google Antigravity 没有等价的 Anthropic 服务器审核接口；网关不能忽略这一要求后声称已审核，也不能编造允许执行结果。

2026-11-13 使用本机实际 Claude Code 2.1.322 TUI、隔离 HOME 和仅允许回环网络的合成服务复现：Gemini Flash High 和 Sonnet 4.6 主模型收到缺少审核结果的响应时，均提示无法检查；明确返回命名 `safeguards` 的 `400 invalid_request_error` 后，客户端虽去掉该字段重试，但仍未发起独立分类器。此行为与官方文档所述自动回退并不一致，不能依赖该回退。

设置官方参数 `CLAUDE_CODE_AUTO_MODE_SERVER=0` 后，同一客户端改为自己发送 `claude-sonnet-5` 独立分类器请求，并根据判定管理执行；已有路由将该请求转到 Flash Low。网关生成的 Claude 配置现包含此项，用户自建配置需要合并并重启会话。不设置 `CLAUDE_CODE_AUTO_MODE_MODEL`，不修改权限模式或允许列表，也不改变用户所选主模型。该选择保留审核，只改变审核请求的发起方式。[官方服务器审核说明](https://code.claude.com/docs/en/permission-modes#server-side-classifier-review)

网关现在对非空或格式错误的顶层 `safeguards` 返回 `400 invalid_request_error`，明确说明兼容设置；在账号分配和 SSE 开始前返回。缺省、`null`、空数组和工具 Schema 等业务数据中的同名字段不被拒绝。回归覆盖以上入口边界和生成配置持久化。客户端工具始终由 Claude 执行。

2026-11-13 补充真实闭环：实际 Claude Code 2.1.322 TUI 加载网关生成配置，使用 Flash High 主模型和 Auto 模式，无允许规则、无手动确认；客户端置于独立 HOME 和仅允许回环的沙箱。三次请求全部经本机网关实连 Google：主请求 9.680 秒 → 独立 `claude-sonnet-5` 请求路由 Flash Low，10.117 秒返回 `<severity>0</severity>`／`end_turn` → Claude 执行只输出固定字符串的 `node -e` 命令 → 主模型 12.099 秒正常续答。请求不含 `safeguards`，无合成模型响应、无分类器模型覆盖。工具结果为 `AGW_AUTO_ACTION_OK`、`is_error=false`。本轮 1112 项 Node 回归通过。此结论限定当前已捕获客户端版本及所测路径。

## 客户端历史与统一账号切换

所有请求统一按账号健康、模型支持、固定五小时粘性、权重、额度和冷却状态选择候选。携带旧工具调用或结果不会触发额外的原生历史准入检查；原账号不可用时可以切换其他可用账号，不等待原账号恢复，也不通过历史归属强制找回原账号。固定粘性窗口仍不因续聊延长。

上下文保留、压缩和失败恢复由 agent 管理。网关按客户端提交的历史执行协议转换；同账号、同会话且前缀匹配的本地原生投影可以复用，但它只是转换缓存。没有匹配缓存时仍转换并发送客户端历史，不再本地抛出 `native_history_missing`，也不跨账号复制缓存或补造签名。上游是否接受这些历史由实际响应决定；上下文错误通过对应客户端协议返回原上游错误，由 agent 处理。

所有位置的工具结果仍必须对应先前唯一且匹配的客户端工具调用；孤儿、重复、乱序或名称冲突等结构无效输入返回 `400 invalid_tool_history`，不降为普通文本。这项结构校验不检查账号历史归属。Responses 的 `previous_response_id` 仍先恢复原请求与工具调用，再核对新工具结果。

账号限流、健康故障或临时服务错误继续按统一规则冷却并切换候选；已向客户端交付内容时不把另一账号的生成拼进同一响应。所有账号均仅因目标模型冷却时返回原有 `429` 和 `Retry-After`。转换契约错误仍保留原错误类型，不据此误冷却账号。账号失败诊断仅记录模型、尝试序号、错误类别、错误码和状态码，不记录请求正文或凭据。

## SSE 与调用标识

标准 SSE 先按空行组合一个事件的所有 `data:` 行，再解析 JSON，适用于 high、low 和 Claude 模型。损坏的完整事件返回 `502 invalid_upstream_response`，不再丢弃后返回空的成功响应。

已捕获的 high 模型仍严格要求事件终止空行才能提交内容/调用。其他配置保留旧兼容：正常 EOF 可提交完整尾事件；标准多行 JSON 解析失败后，仅当每个数据行都能独立解析为完整 JSON 或 `[DONE]`，才接受旧逐行格式。

默认使用 `legacy` 传输重试策略，不插入隐藏的恢复消息、不自动续接中断回答。正常传输重试与统一账号切换仍保留；已交付的部分内容和后续错误如实交回 agent。旧 `agy` 恢复模式的捕获与回归记录保留其历史验证范围，不表示当前默认会执行这些恢复步骤。

同一上游调用 ID 若出现不同工具名，返回 `502 invalid_tool_call`，禁止将工具 A 的名称和工具 B 的参数混合。相同 ID、相同名称的合法流式参数片段继续合并。

## 工具 JSON 与入口校验

Responses 的 `function_call.arguments` 是 JSON 字符串；归一化时只解析一遍，之后内部 `arguments` 始终表示原始 JSON 值。MCP 兼容封装、客户端输出序列化和历史投影均保留数组、`null`、`false`、`0`、空字符串，以及内容看似 JSON 的普通字符串。例如原始字符串 `"[1,2]"` 不会在历史恢复时被再次解释成数组。原 Schema 始终参与结果校验。[OpenAI 官方字段契约](https://developers.openai.com/api/reference/resources/responses/methods/create)

Messages 的 `Tool.InputSchema.type` 在 [Anthropic 官方 SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)中要求为 `object`。因此该入口对非对象根声明直接返回 `400 invalid_tool_schema`，不会先发给上游再后置报错，也不通过增加业务参数包裹来改写客户端契约；需要其他 JSON 根值时使用 Responses。未提供 Schema 的既有默认仍为对象。

`required`/`any` 但没有工具、named 选择缺少名称、或指定未声明名称，均在请求归一化时返回 `400 invalid_tool_choice`，账号调度和生成请求均不启动。Direct 构造层也保留防御校验。

## 验证

新增 [response-termination.test.js](../tests/response-termination.test.js) 和 [tool-root-values.test.js](../tests/tool-root-values.test.js)。最初 15 个失败复现全部通过；补充边界后共 23 项新增回归，覆盖两协议真实本地 HTTP、两种 Responses SSE 输出路径、已发 delta 后过滤/错误、内部工具零执行、账号健康不变、JSON 根值跨重启且删除声明后的精确签名恢复。

本轮相关协议、Direct、工具、历史、流恢复、用量、内部生图和超时测试共 231 项通过，语法检查通过。全部使用合成凭据、临时目录与本地 mock 上游；本轮没有真实模型调用，未操作正式服务与正式账号。
