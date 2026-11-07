# agy 1.5.2 上游请求迁移

日期：2026-11-06，macOS arm64。源码基线：1.7.4 / `7626f15`；本次版本：1.7.5。

## 取证方式

使用本机未修改的 `/Users/leefee/.local/bin/agy`（`--version` 为 `1.5.2`），
通过仅作用于探测进程的 `HTTPS_PROXY` 和 `SSL_CERT_FILE` 抓取真实请求与响应。
未修改系统证书信任或官方登录配置。Authorization 在写入证据前替换为 SHA-256；
不保存 access token、refresh token 或 OAuth client secret。

先完成官方 CLI 取证、源码迭代和离线回归，再允许新版网关向上游请求。
本次没有使用旧网关模式进行上游探测。

官方覆盖六个模型、文件读取及回传、结构化输出、会话恢复、`/compact` 和压缩后回忆。
这些官方生成请求全部返回 HTTP 200。CLI 输出事件和实际 HTTP 报文分别保存。

## HTTP 与认证

真实生成端点：`POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`。
本机实际发送的生成请求头按顺序为：

```http
Host: daily-cloudcode-pa.googleapis.com
User-Agent: antigravity/cli/1.5.2 (aidev_client; os_type=darwin; arch=arm64; cl=1015175089; auth_method=consumer)
Transfer-Encoding: chunked
Authorization: Bearer [REDACTED]
Content-Type: application/json
Accept-Encoding: gzip
```

- HTTP/1.1；未发送 Accept、X-API-Key、Cookie 或额外请求签名头。
- `loadCodeAssist`、`fetchAvailableModels`、额度等元数据请求使用 Content-Length。
- `loadCodeAssist` 请求体为 `{"metadata":{"ideType":"ANTIGRAVITY"}}`；目录/额度查询使用 `{"project":"…"}`。
- 官方 Bearer 的本机哈希与 `keychain:gemini/antigravity` 中登录态一致，authMethod 为 consumer。
  继续使用既有本地登录态读取与 OAuth 刷新机制，不把账户 Token 写入代码或 fixture。
- 这次账户已登录，没有重新执行新账户注册/onboardUser。其独立注册流程不作为本次发送消息格式的证据。

现有 Go 原生传输与新抓取的 ClientHello 稳定字段一致：cipher suites、扩展顺序、
supported groups、签名算法和无 ALPN；无需替换二进制。新 fixture 为
`tests/fixtures/agy-1.5.2-tls.json`。比较不包含随机数、临时密钥或 TCP 分段。

## JSON 格式

外层顺序仍为 `project, requestId, request, model, userAgent, requestType`。
`userAgent="antigravity"`、普通 `requestType="agent"`，压缩为 `checkpoint`。
`requestId` 为 `agent/<cascade>/<毫秒时间>/<trajectory>/<步骤>`。

内层依次为 contents、可选 systemInstruction、可选 tools、labels、generationConfig、
可选 toolConfig、sessionId；实抓 sessionId 仍为 `-3750763034362895579`。
用户文本使用 USER_REQUEST / ADDITIONAL_METADATA 包装；工具结果仍使用
`role="model"`、`functionResponse.response.output`。多轮请求保留真实 thoughtSignature。

labels 包含 cascade_id、last_step_index、model_enum、request_id、root_cascade_id、
trajectory_id、used_claude、used_claude_conservative、used_non_gemini_model；
续聊增加 last_execution_id。Claude 首轮三个 used 标志已为 true；GPT 首轮仅
used_non_gemini_model 为 true。网关此前在首轮错误地全部写 false，现已修正。

| 模型 | 目录 thinkingLevel | 实发 thinkingConfig（均 includeThoughts=true） | maxOutputTokens |
| --- | --- | --- | ---: |
| gemini-3.8-flash-high | 3 | thinkingLevel: HIGH | 65536 |
| gemini-3.8-flash-medium | 2 | thinkingLevel: MEDIUM | 65536 |
| gemini-3.8-flash-low | 1 | thinkingLevel: LOW | 65536 |
| claude-sonnet-4-6 | 无 | thinkingBudget: 1024 | 64000 |
| claude-opus-4-6-thinking | 无 | thinkingBudget: 1024 | 64000 |
| gpt-oss-120b-medium | 无 | thinkingBudget: 8192 | 32768 |

映射来自同一账号的目录响应和各模型实际生成请求，未将预算数值改名冒充 level。
实时目录优先；同时出现 level 和旧预算时使用有效 level。显式客户端输出上限仍保留。
六模型默认请求均无 toolConfig；新版网关不再为 Claude 自动添加 VALIDATED。

## 工具声明与兼容策略

1.5.2 官方仍声明自己的工具，实抓名称为 read_file、run_command、manage_task、
send_message、schedule、invoke_subagent、define_subagent、manage_subagents、
write_file、edit_file、search_web、ask_question。它们不是客户端实际拥有的工具，
因此网关不复制这套 Agent 能力，也不再把 Read/exec_command 等改写成旧 view_file/run_command。

本次采用“只发送实际需要的声明”的策略：

- 无客户端工具的普通对话不发送 tools/toolConfig，包括自然语言提及生图的普通请求。
- 客户端实际声明的工具保留名字、参数与业务字段，继续做协议 Schema 转换；
  不新增 toolAction/toolSummary、不改写固定身份句。调用与结果按同一客户端合同往返。
- 原自动 generate_image 工具默认关闭，显式 `ANTIGRAVITY_ENABLE_IMAGE_TOOL=1` 可启用；
  用户主动声明同名工具时归客户端所有。图片输入与独立图片 API 保留。
- 客户端显式请求对象型 JSON Schema 输出时，按官方实抓保留 finish 终结工具；
  1.5.2 的 finish 只包含输出 Schema，不再附加 toolAction/toolSummary，且不再删除同名业务字段。
- 显式 named/required 工具选择映射 ANY（named 同时传 allowedFunctionNames）；
  none 保留 NONE，auto 不增加 toolConfig。
- Claude 的 ANY 与思考配置同时发送会真实返回 400：
  `Thinking may not be enabled when tool_choice forces tool use.`
  现让强制工具覆盖目录默认思考；若客户端同时显式要求思考，则本地报
  `thinking_tool_choice_conflict`，不向上游发送冲突请求。
- 本地会话存储版本升至 2：旧的工具别名、签名投影缓存不再回放，使用客户端提交的完整历史重建。
  不删除客户端历史，不触动 Robin 的独立工具适配。

普通对话“没有工具声明”和客户端主动请求工具/结构化输出“有必要声明”是不同路径；
本版本没有把工具偷偷编码为提示词模拟调用。

## 验证与可复核文件

- `tests/fixtures/agy-1.5.2-wire.json`：六模型的实抓生成配置、稳定标签、请求头和原始 body SHA-256。
- `tests/agy-152-wire.test.js`：六模型 profile、目录数字枚举、无额外声明、三协议工具合同、
  业务字段、Claude 强制工具冲突与旧缓存失效。
- 全量 Node 回归与 `npm run check`；传输测试使用本地套接字，回归阶段禁止外部出站网络。
- 真实新版网关通过完整 HTTP 接口验证 Chat Completions、Anthropic Messages、Responses、
  Chat SSE、JSON Schema、Gemini 指定工具与回传；六个模型均完成文本调用。
- Claude 强制工具初次实测暴露思考冲突，修复后再验证强制调用及回传。失败样本保留，
  不以 Mock 或 CLI 成功代替新版网关验证。

最终测试数量、打包/安装结果和本机原始证据路径见 [验收记录](agy-1.5.2-acceptance.md)。
本报告验证协议兼容和上述真实场景，不把它解释成所有未来模型/客户端、未捕获附件布局，
或服务端内部识别行为的证明。
