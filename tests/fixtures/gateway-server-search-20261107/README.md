# 独立搜索：实抓请求重放到真实 Google

2026-11-07 04:43（UTC+8）的单场景验收通过：**已捕获的 Claude 辅助 Messages 请求 → 完整临时网关 HTTP／SSE → AccountPool → Direct → 原生 Go 传输 → 真实 Google helper**。这是请求重放，本次没有启动 Claude CLI，也不是官方 agy CLI 动态发包。

## 输入与结果

- 输入取自 [Claude 实抓样本](../client-web-tools-20261107/claude-web-search.json)的 `captures[2]`。仅删除非空严格域名限制，将用户 query 替换为 `site:example.com Example Domain`；保留原 `max_tokens=32000`、`stream=true`、模型字段 `claude-sonnet-4-6`、三段 system、generation controls、工具声明和 `tool_choice`。身份清理按已验证模板完成。
- 正常账号资格及实时目录选择实际 helper `gemini-3.5-flash-lite`；HTTP 响应模型字段和 `x-antigravity-model` 均准确显示该 helper。没有调用或替换主对话模型。
- 仅 1 次模型目录查询和 1 次同步 `generateContent`，均为 200；生成结束原因为 `STOP`。没有生成重试、切号补发、OAuth 刷新、网页抓取或额外模型总结。
- 上游原摘要逐字保留；5 个 grounding 来源的 URL／标题逐项保持原值，包括 Google redirect URL，没有展开重定向、推断最终域名或生成 `cited_text`。查询中的 `site:` 是查询文本，不是严格域名过滤的验收。
- Messages 用量为输入 112、输出 110、缓存读写均 0，逻辑 `web_search_requests=1`。唯一 `message_start`、配对内容块及最后 `message_stop` 完整，`stop_reason=end_turn`；调用 ID 与搜索结果对应。
- `assessment` 的 17 项检查及总 `passed` 均为 true，worker 退出码 0；正式账号、正式 state、运行时源码前后摘要不变，native 已退出，临时凭据目录已删除。没有启停正式服务。

## 文件与快照

| 文件 | 含义 |
| --- | --- |
| [real-result.json](real-result.json) | 本次执行的脱敏请求、完整生成 JSON、原始 SSE、事件、用量、身份规则、传输记录、前后摘要与清理结果 |
| [prepared.json](prepared.json) | 执行前的离线准备记录；脚本随后补齐验收门禁，实际执行脚本摘要以 real-result.json 为准 |
| [guard.test.cjs](guard.test.cjs) | 4 项离线检查，验证原预算保留、端点及单生成约束、429 停止、SSE／用量及截断判定 |
| [verify-server-search-http.js](../../../scripts/verify-server-search-http.js) | 隔离执行和验收脚本；默认仅准备，真实执行需显式 `--run --expected-source` |

- 57 个运行时文件 SHA-256：`6ff6487b7558aba133f0d8fac0ca50e062b91b0d4f1b357f29b60ae2a20bfc92`。
- 执行脚本 SHA-256：`1bfeb9645bdfb533118c0e31b4b50a7b6949c2efbea71cf2ca5754ded96de623`。
- darwin-arm64 native SHA-256：`b0b55da8685bb1b6389c4524a77812468576e39d18ea9ee51a86753d1f54c9c5`，执行时与 manifest 核对一致。

本记录与[真实 Claude CLI → 完整网关 → 合成 Google v2](../client-web-tools-20261107/claude-complete-gateway-search-v2.json)互补：后者证明 CLI 的 WebSearch 加载、调用和结果续聊，本记录证明保留实抓预算的 HTTP 请求可经原生传输获得真实 helper 结果。两批不能合称“同一次真实 CLI 直连 Google 搜索”。仅覆盖这里列出的独立 typed 搜索场景；不扩展为所有模型、Responses 搜索或严格域名／location／混合工具支持。旧 400、原生模型探测及缓存失败记录均保留，边界见[客户端搜索说明](../../../docs/client-web-tool-boundaries.md)。
