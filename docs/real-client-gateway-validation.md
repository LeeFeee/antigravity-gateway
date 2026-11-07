# 四客户端真实 Google 上游最小验收

2026-11-07（Asia/Kuala_Lumpur），四个本机 CLI 经临时完整 Gateway HTTP 服务和原生 Go 传输访问真实 Google Antigravity API，文本及读取工具闭环 **8/8 通过**。本次显式选择已公布的 `claude-sonnet-4-6`；没有把 Gemini 请求静默改成 Claude。

这份证据独立于此前“真实 CLI → 网关 → 本地合成 Google 服务”的 8/8，也独立于真实 CLI 直接访问本地捕获服务的协议样本。

## 结果与证据

聚合报告：[verified-summary.json](../tests/fixtures/real-client-gateway-20261107/verified-summary.json)。每条记录包含原始证据文件 SHA-256、运行时源码摘要、账号目录前后摘要、判定明细。选中的单场景文件保留脱敏客户端请求、上游请求及原生返回。

| 客户端 | 本机版本 | 公开入口 | 文本 | 读取及回传 | 实际上游工具名 | 成功场景生成请求数 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.318 | Anthropic Messages | 通过 | 通过 | `read_file`，恢复为 `Read` | 1 + 2 |
| Pi | 1.5.0 | OpenAI Responses | 通过 | 通过 | `read_file`，恢复为 `read` | 1 + 2 |
| dsh | 0.2.1-rc.2 | OpenAI Responses | 通过 | 通过 | `mcp_gateway_tool_9120d3e96e5e451d`，恢复为 `read` | 2 + 3 |
| Hermes | 0.21.7+11153.g2bd378e | OpenAI Responses | 通过 | 通过 | `mcp_gateway_tool_9bb48e8eede6f8dd`，恢复为 `read_file` | 2 + 3 |

证据目录分别为 [Claude](../tests/fixtures/real-client-gateway-20261107/sonnet)、[Pi / dsh](../tests/fixtures/real-client-gateway-20261107/sonnet-rest)、[Hermes](../tests/fixtures/real-client-gateway-20261107/sonnet-hermes-fixed)。Hermes 和 dsh 还会发送辅助推理，因此生成数量高于主会话轮数。共 16 次生成属于表中成功场景；此数字不含下文保留的早期失败尝试。

读取文件包含随机第二行，提示只提供文件路径与行范围，未给出该随机内容。判定同时要求：CLI 正常退出、客户端推理 HTTP 200、原生传输收到 Google HTTP 200、正确客户端工具名、没有其他执行工具、随机内容出现在真实上游 `functionResponse`、发生后续生成、随机内容最终出现在 assistant 文本。工具参数或原始 SSE 中偶然出现同样字符串不能充当最终回答。

Claude 和 Pi 的真实模型调用使用官方 `read_file` 的 `Path/StartLine/EndLine`；Hermes 和 dsh 这两次选择完整 MCP 兼容声明，保留客户端参数并移除网关自己生成的 `toolSummary` 后交回客户端执行。此结果没有要求模型必须选择 native 视图，也不把兼容视图声称为官方文件工具。

## 运行快照

各组运行前后源码摘要一致，但四者不属于同一源码快照：

- Claude / Pi / dsh：`97a6d784375f4c5930c2ea1aaa4f72bb8a343b72e3470f7bf0585e29284c0a5a`，51 个文件。
- Hermes：`584b09fc6d9dbccf48fe79a988dc4c941ba253dbd2555b2906eda636560acc66`，52 个文件。

摘要范围是主入口、package 文件、`src/*.js` 和 `native/bin/*`。后续认证、原生传输或图片路由修改不自动继承这次实跑结论；离线回归可以复验所保存的协议证据。

原账号目录 6 个文件的名称与内容聚合摘要前后均为 `a9e0027d0ce3910c2eee3dc072add6f18676611271639533373286fb094302db`。仅复制现有 `accounts/*.json`、`state/account-pool.json`、`state/quota.json`；状态文件按字节复制，未清除额度保护、冷却、禁用或健康状态，也未读取旧 Robin / Windows Gemini 账号目录。

## 隔离与传输证据

复现脚本：[verify-real-client-gateway.js](../scripts/verify-real-client-gateway.js)。脚本默认只准备与校验，不发模型请求；加 `--run` 才真实调用。

临时根目录权限 700，复制凭据文件权限 600；每个 CLI 使用独立 HOME、配置和只读工作目录。CLI 不能读取正式 HOME 的配置、账号池或网关的临时凭据副本。Node / Python 安装代码仅做只读例外。CLI 网络只允许临时 Gateway 的一个 loopback 端口；Hermes 额外允许它自己的一个专用 loopback WebSocket 端口及私有目录 Unix socket。

Hermes 0.21.7 先用 Unix socket 发现自身网关，再通过本地 WebSocket 发送会话。脚本使用其真实 `webapp.enabled/host/port` 配置固定这个专用端口，不开放任意本机服务。Hermes 的 `file` toolset 包含写入和 patch；本次提示只要求读取，并由 Seatbelt 禁止工作目录写入。其他 CLI 仅启用读取工具或对应只读权限，dsh 禁用 shell、后台任务、子代理等插件。

上游观察器包装 `AgyNativeTransport.prototype.fetch` 后仍调用原实现，记录真实 `agy-transport-*` 子进程和 Google HTTP 响应。未将模型传输替换成 Node fetch。这证明原生传输路径实际执行成功，不代表新增了 ClientHello 逐字段抓包比对。

证据落盘前按敏感字段及启动时秘密值脱敏；最终脚本另补了 Bearer、id_token 和序列化 token 字段清理。没有将真实凭据写进仓库。完成后所有本脚本创建的 `agy-real-*` 临时凭据目录均已删除，私有 Hermes 网关退出；正式服务和各 CLI 全局配置未修改。

## 保留的失败证据

首次 `gemini-3.8-flash-high` 真实生成收到 HTTP 429 `RESOURCE_EXHAUSTED`，正文只有通用的 “Resource has been exhausted (e.g. check quota).”。同一时段模型目录显示 remainingFraction 为 1。响应没有提供具体额度维度或 retryDelay，不能把原因断言为余额耗尽或临时容量不足；正常池调度随后返回 `account_pool_unavailable`。脚本现会停止 CLI 重复等待，不清保护重试。

之后一次显式 `gemini-3.8-flash-low` 尝试受本地控制进程生命周期中断，未取得完整结果。它属于验收脚手架中断，不能算模型通过或协议失败。相关记录保存在 [claude-text-high-429.json](../tests/fixtures/real-client-gateway-20261107/claude-text-high-429.json) 与 [interrupted-gemini-summary.json](../tests/fixtures/real-client-gateway-20261107/interrupted-gemini-summary.json)。

Claude 以外的最早 Sonnet 尝试还遇到源目录元数据权限、Hermes Python 安装路径权限、Hermes 独立 WebSocket 端口限制。这些失败均保留，且相应客户端没有发出模型请求；修复隔离脚手架后使用新目录保存成功记录，没有覆盖原失败证据。

## 复现与范围

```sh
# 不调用模型；复制、验证并清理临时状态
node scripts/verify-real-client-gateway.js

# 四客户端真实文本与读取测试，明确指定模型
node scripts/verify-real-client-gateway.js --run \
  --model claude-sonnet-4-6 \
  --out tests/fixtures/real-client-gateway-new-run

# 仅补测一个客户端
node scripts/verify-real-client-gateway.js --run --agents hermes \
  --model claude-sonnet-4-6 --scenarios text,read \
  --out tests/fixtures/real-client-gateway-hermes-new-run

node --test tests/real-client-gateway-verifier.test.js
```

本次需要 macOS Seatbelt 和已安装的上述 CLI。真实测试使用现有账号的正常调度规则；若池被保护、请求失败或运行期间源码/原账号变化，脚本返回非零状态并保留诊断，再清理临时凭据。

这 8 项只覆盖文本与单次安全读取闭环，不证明所有模型、全部工具、写入执行、并行工具、会话恢复、多模态、OAuth 刷新或 HTTP/2 新认证路径均已通过真实上游验收。这些能力需分别看对应测试和证据层级。

## 最终运行时快照的两入口补验

2026-11-07 02:41（Asia/Kuala_Lumpur），结束状态、工具 JSON 根值及认证传输等修改收敛后，在冻结的最终运行时上仅重跑 Claude 与 Pi 的读取闭环。仍显式指定 `claude-sonnet-4-6`，原脚本直接使用 `--agents claude,pi --scenarios read`，没有修改源码或验收脚本。

新证据独立保存在 [final 目录](../tests/fixtures/real-client-gateway-final-20261107/summary.json)，旧 8/8 及失败样本均保留。[结束字段复核](../tests/fixtures/real-client-gateway-final-20261107/finish-verification.json)记录每条证据的 SHA-256、真实上游结束原因与客户端末事件。

| 客户端 | 两轮上游 | 第 1 轮客户端结束 | 第 2 轮客户端结束 | 实际读取工具 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.318 | 两次 HTTP 200，均 `finishReason=STOP` | Messages `tool_use` / `message_stop` | Messages `end_turn` / `message_stop` | 上游 `read_file`，客户端 `Read` |
| Pi 1.5.0 | 两次 HTTP 200，均 `finishReason=STOP` | Responses `completed` / `response.completed`，含工具调用 | Responses `completed` / `response.completed`，含最终文本 | 上游 `read_file`，客户端 `read` |

两项均通过全部九项验收条件，包括随机文件内容经真实 `functionResponse` 回传、后续模型生成和正确最终文本。合计四次真实生成，无 429，无更换模型重试。本次实证覆盖正常 `STOP` 的工具与文本结束语义；`MAX_TOKENS`、过滤、未知原因及错误流仍由独立 mock 回归验证，没有为了制造这些状态增加真实请求。

最终运行时摘要为 `919d115ca217e164764e10e65b115efc33bca862e8c2d29d168c42d17b9f40c3`，运行前后相同，范围共 53 个文件：主入口、`package.json`、`package-lock.json`、`src/*.js`、`native/bin/*`。文档、测试与脚本不在该运行时摘要范围内；该摘要与完整 npm 包 SHA-256 不同。

[正式数据完整性报告](../tests/fixtures/real-client-gateway-final-20261107/production-integrity.json)确认：账号目录聚合摘要 `d8842152b0ad8abf366d30453f8bae60694ace0b1e5cd2cb919b81176ff00bbb`、健康/亲和状态文件摘要 `c18c32383e2a8ba2142d23ba35436ecd152aef89b9f9dd8fec05312d0e4a9321`、额度状态文件摘要 `1d61b00fff471705593117a189390777996bd35d93b0190996c04f341c10f776` 均前后不变。六个账号和两个状态文件按原规则复制到独立临时目录，未清冷却、改额度或修改正式账号；临时网关及凭据目录已清理，正式服务未启停。看板 OAuth 流程未操作。

本次 trace 没有记录到 token 刷新端点请求，不据此宣称刷新或新授权码交换成功，也未观测原生响应的实际 HTTP 协议版本。
