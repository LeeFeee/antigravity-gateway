# 四客户端压缩与长会话请求

采样日期：2026-11-07。四个本机已安装客户端实际生成压缩请求，再继续同一会话；上游全部是 loopback 合成服务，**没有真实 Google 或其他模型供应商调用**。最终证据为 [agent-compaction-20261107/verified](../tests/fixtures/agent-compaction-20261107/verified)，不是静态推测。

脚本：[probe-agent-compaction.js](../scripts/probe-agent-compaction.js)。使用临时 HOME、假 key、只读工作目录和 Seatbelt；首轮只返回一个读取临时文件的真实客户端工具调用，其后返回确定性长文本，压缩时返回固定摘要。所有 provider message/response ID 唯一。usage 数字是固定合成值，不能用于真实 token 成本或压缩率评价。

## 实际触发方法与请求

| 客户端版本 | 本次真实触发 | 压缩请求 | 工具与身份 | 后续历史变化 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.318 | 3 轮隔离会话后 `-p '/compact Preserve controlled fixture facts.' --resume ID` | 2 次 `POST /v1/messages?beta=true`，仍带 `system/tools/metadata/thinking/context_management/output_config/stream` | 保留 SDK system 身份及 Read 声明；最后 user 内容追加 TEXT ONLY 和摘要指令 | 注入 “This session is being continued from a previous conversation…”、`tools-used-before-summary` 和摘要；已消失的 Read 调用不再作为 tool_use 回放，读取结果可转为 system-reminder 文本 |
| Pi 1.5.0 | 官方 `--mode rpc`，依次 `prompt` → `compact` → `prompt`；本次临时设置 `keepRecentTokens:128`、关闭自动压缩 | 2 次 `POST /v1/responses`：主摘要和 split-turn 摘要；无 `tools/prompt_cache_key` | developer 改为中性 `You are a context summarization assistant…`，旧工具调用和结果序列化进 user 文本 | 正常 Pi developer、read 声明恢复；summary、Turn Context、read-files 进入历史，旧结构化调用消失 |
| Hermes 0.21.7+11153.g2bd378e | 官方 `/compress` 使用的已安装 `gateway_client.connect_gateway` + `PreparedMutations.apply(...,'compress',{})` API；CLI 先建立并续接 3 轮会话 | 1 次 `POST /v1/responses`，`instructions/model/prompt_cache_key/store/stream/input`；不走 Chat Completions | 无 tools；instructions 为 `You are a helpful assistant.` | 官方返回 8→4 messages、`noop:false`、`fallback_used:false`、`aborted:false`；正常 instructions、用户 SOUL、4 项 file 工具恢复，历史包含摘要 |
| dsh 0.2.1-rc.2 | headless 将输入作为普通任务；本次使用官方 `compaction-basic` 配置在第 4 轮开启自动阈值压缩 | 第 4 轮 2 次摘要 Responses + 1 次正常生成；之后续聊又有 1 次摘要 + 1 次正常生成 | 摘要沿用原 developer 和 25 工具；末尾 user 为 `You are now acting as a compaction engine…`，摘要调用不带主请求 reasoning | 用 user `<compacted-summary>` 替换旧历史；第一次摘要仍保留旧 function_call/output，之后摘要和续聊已移除 |

本次 Hermes 为了让短测试可压缩，临时配置 `protect_first_n:0/protect_last_n:3/tail_mode:legacy/target_ratio:0.01` 并关闭自动压缩。dsh 临时配置 `retainTokens:128/headroomTokens:1024/maxTokens:512`，准备完历史后开启 `auto:true/thresholdRatio:0.04`。这些是测试配置，不代表客户端默认值，也未修改全局配置。

Hermes 使用与 CLI `/compress` 相同的官方控制 API，因为 `chat -q` 的有限查询直接调用 `prompt.submit`，不等于交互式 slash 命令分派。证据记录具体 API 调用，未冒称通过 `chat -q /compress` 执行。

## 静态位置

以下路径均为本机已安装版本，仅用于说明真实触发入口：

- Pi：rpc-mode.js（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:417`） 分派 `compact`，进入 agent-session.js（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2248`）。摘要逻辑位于该包 `dist/core/compaction/compaction.js`，默认保留最近 20000 token、预留 16384 token；本次以显式配置降低保留量。
- Hermes：gateway_chat_view.py（`$HOME/.hermes/hermes-agent/hermes_cli/gateway_chat_view.py:390`） 分派 `/compress`，进入 gateway_mutations.py（`$HOME/.hermes/hermes-agent/hermes_cli/gateway_mutations.py:10`） 的 `PreparedMutations`，包含 revision/generation 条件；conversation_compression_manual.py（`$HOME/.hermes/hermes-agent/agent/conversation_compression_manual.py:19`） 定义 MIN_MESSAGES=4；context_compressor.py（`$HOME/.hermes/hermes-agent/agent/context_compressor.py:3786`） 经辅助 compression 路由调用摘要模型。
- dsh：compaction-basic README（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/README.md`） 说明阈值、保留预算、自动和手动入口；实现（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:242`） 定义摘要指令并回放原 system/tools；headless README（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-headless/README.md:142`） 明确任务作为普通 user 消息。本次没有伪造 headless slash 命令成功。
- Claude 的手动命令依据实际 CLI `local_command:"compact"` 成功输出和捕获请求；其本机实现为原生可执行文件，没有将猜测的反编译位置当作源码引用。

## 身份与历史恢复回归

[verify-agent-compaction-replay.js](../scripts/verify-agent-compaction-replay.js) 对最终真实样本执行当前 `normalizeAnthropic/normalizeResponses → buildDirectRequest → prepareNativeContext`。首轮工具调用使用**合成**但合法形状的 Google Antigravity API tool call；在真实首请求的准确 prefix 保存 native 名称、参数、调用 ID 和 mock 签名投影，然后重放后续原始客户端结构，没有改写 fixture 的旧历史。

[offline-replay.json](../tests/fixtures/agent-compaction-20261107/offline-replay.json) 保存源码摘要和逐请求结果：四者首次工具回传 prefix 均完全匹配；所有保留的旧结构化调用恢复同一次 native 投影；所有压缩及续聊 `unrestoredToolCalls:[]`。已经转成摘要文本的调用没有补造签名。Hermes 用户 SOUL 全程保留。

Claude 和 dsh 的压缩请求仍需原有身份清理；Pi/Hermes 的独立中性摘要提示不应强行识别为框架自称。三个正常续聊模板继续走各自身份边界。Hermes `--toolsets file` 使用不含 skills 的 docs 模板；该分支源码为 prompt_builder.py（`$HOME/.hermes/hermes-agent/agent/prompt_builder.py:185`） 的 `HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS`。首次离线报告里此分支 profile 为 null，工具安全使用全兼容声明；该事实已交给身份模块负责方；当前实现已补这个精确分支，并保留用户 SOUL。归档 offline-replay.json 保持当时源码摘要与判定，动态回归使用当前实现。

采样时没有发现因合法压缩而触发旧 `native_history_missing` 检查的样本；这一结论仅描述当时的捕获与实现。当前已按用户约定移除该历史准入限制：所有请求统一选号，缺少本地原生历史也按 agent 提交的历史转换并发送，上游上下文错误交回 agent。原生投影匹配时可以复用，不能据此要求等待原账号或拒绝其他可用账号。

初版合成服务跨响应重复 `msg_probe_1`，造成 Claude 将后续 assistant 文本并入旧调用；唯一 ID 后此差异消失。`initial/retry/hermes-final` 保留调试过程，正式回归只选择 `verified`，不把早期脚手架问题算生产缺陷。

同账号、同会话、匹配前缀的校验现在只决定是否复用已有原生投影；无匹配投影不再拒绝结构合法的工具历史。结构无效输入仍返回 `400 invalid_tool_history`。摘要替换后缺失的 call 不重新插入，用户自己写的摘要或引用不根据品牌词改写。上下文管理由 agent 负责；长会话自动阈值和真实模型摘要质量不由本地合成结果证明。归档捕获、源码摘要及旧回归结论保持原样。

## 复现

```sh
node scripts/probe-agent-compaction.js --agents claude,pi,hermes,dsh \
  --out tests/fixtures/agent-compaction-new-run
node scripts/verify-agent-compaction-replay.js
node --test tests/agent-compaction.test.js
```

第一个命令启动真实本机客户端但只允许本地合成服务；后两项完全离线，不启动 CLI，不使用账号。
