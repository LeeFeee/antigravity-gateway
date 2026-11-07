# 请求内容、工具类型与停止条件的入口边界

更新：2026-11-07。本页对应规格第 5.5 节对任务内容、工具契约和停止条件的要求。最终审计实际复现了三类问题：未识别的输入项或内容块被静默丢弃；有名字但类型未知的工具被当作普通函数；Messages 的 `stop_sequences` 没有进入上游生成配置。修复位于 [protocol.js](../src/protocol.js)，不增加新的供应商通道或云端管理 API。

## 内容与输入项

| 输入 | 现在的处理 |
| --- | --- |
| Responses 顶层 `item_reference` | 返回 `400 unsupported_input_item`。网关没有可验证的远端 item 解析来源，要求客户端提交完整受支持内容，不再忽略引用后继续生成。 |
| Messages 搜索 `server_tool_use`／`web_search_tool_result` 历史 | 专用搜索转换层校验配对调用及本网关签发的来源 receipt，恢复为明确标识的历史文本；未配对调用返回 `400 invalid_server_search_history`。其他服务器工具类型仍明确拒绝，不冒充客户端函数。 |
| 未识别的 typed input/content，包含普通 `text` 或 `role` 字段 | 仍按显式类型拒绝；不能通过附带文本或角色绕过类型判断，把另一种语义误当普通消息。 |
| Responses assistant 历史中的 `refusal` 内容块 | 将已有 `refusal` 字符串原样作为普通 assistant 文本，保留与前后文本的顺序；不生成新的拒绝话术、身份或本轮拒绝状态。缺少字符串时返回 `400 invalid_content_block`。 |
| 已支持的文本、媒体、客户端调用/结果、动态工具引用 | 继续走既有转换和校验。媒体类型识别不等于承诺所有格式已完成真实模型理解验收。 |

本次显式保留已知提示类内容的既有边界：Responses 的历史 `reasoning` 是不透明的供应商思考信息，不将其当作用户任务正文或可信 Google 签名；Messages 的 `thinking`/`redacted_thinking` 按原路径处理。`cache_control`、`prompt_cache_key` 等已采到的提示不会因本次类型检查被误拒绝。真实上游签名仍按账号、会话及完整历史投影恢复。

工具结果中的业务 JSON 是另一种来源。例如 `{"type":"business_receipt","payload":{"amount":0,"success":false}}` 仍作为完整回执保存，不因业务字段也叫 `type` 就当成未知协议类型拒绝。普通任务内容中的未知协议块与工具回执的业务字段分别处理。

本页只描述这次已复现并修复的入口范围，不宣称支持或逐项验证所有 OpenAI/Anthropic 云端扩展，也不表示对所有未知顶层字段都实施一刀切拒绝。

## 带类型的工具声明

工具类型按已支持路径检查。Messages 原有无 `type` 的 `name + input_schema` 声明继续兼容；其 `custom`/`function` 声明仍按对象 Schema 的客户端函数处理。Responses 的 `function` 保留参数 Schema，`custom` 保留字符串及 format 契约，后续仍由工具适配器执行完整约束校验。

例如 Messages 的 `{type:"computer_20250124",name:"computer",display_width:1024,display_height:768}` 现在返回 `400 unsupported_tool_type`，不会丢掉尺寸及执行语义后生成任意对象参数的普通函数。其他未知的显式类型即使有 `name`/`parameters`，也不会自动获得执行能力。这是对不支持契约的明确失败，不需要网关新增远端 computer/MCP 执行器。

独立 `web_search_20250305` 现由专用转换层转发官方搜索 helper，返回原始链接及摘要。非空严格域名限制、位置、混合工具等明确拒绝；普通 `auto` 请求也不能被强制改为搜索，除非完整命中已采集的 Claude 独立搜索模板。指定 `web_search`／`any` 才进入一次转发，`none` 继续普通对话。详情见[搜索边界](client-web-tool-boundaries.md)。

未知 grammar 的既有 `unsupported_tool_grammar` 边界保持不变；完整兼容视图、业务字段和工具执行归属见 [工具双向转换矩阵](tool-conversion-matrix.md)。

## 停止条件

Messages 的 `stop_sequences` 字符串数组映射到 Google Antigravity API 的 `generationConfig.stopSequences`，逐项保留原值和顺序。OpenAI 兼容输入的 `stop` 接受单个字符串或字符串数组，使用同一上游字段；保留内部 Chat normalizer 的此项兼容不代表恢复已退出的 Chat HTTP 推理入口。

停止条件只从生成级字段读取，不递归删除或转换工具参数中的同名业务字段。`max_tokens`/`max_output_tokens`、固定模型思考档位和其他普通生成设置不因此改变。错误类型的停止条件返回 `400 invalid_generation_config`；上游模型对具体停止序列的能力仍由实际 Google Antigravity API 判定。

## 验证证据

[protocol-input-boundaries.test.js](../tests/protocol-input-boundaries.test.js) 共 **11 项回归通过**：

- 两接口真实本地 HTTP 的未知内容、输入引用及 typed 工具失败，确认 **0 次账号派发**。
- refusal 历史经过 normalizer 和完整上游请求构造后保持原文本、位置和 assistant/model 角色。
- 工具结果业务 `type`、无类型/已支持类型的工具声明、普通输出上限和同名业务字段保留。
- 两入口及旧内部 Chat normalizer 的停止条件准确进入上游构造；验证合法与非法输入。
- 已知 thinking/reasoning/cache 提示兼容；逐个重放 Claude、Hermes、Pi、dsh 原始请求目录和 verified 压缩采样中的推理请求。

本次新增及相关协议、工具、压缩、响应结束和历史回归 **89/89** 通过。该历史快照随后全量回归为 **885/885**，包含本次 11 项以及同期 UI 3 项、账号重新检测 2 项。这里的测试使用现有脱敏样本、本地 HTTP 和合成响应，没有追加真实上游请求；停止序列证据验证到请求构造，不冒称已重新测量真实模型停止行为。先前真实客户端和媒体证据仍对应各自保存的源码摘要。

```sh
node --test tests/protocol-input-boundaries.test.js
```
