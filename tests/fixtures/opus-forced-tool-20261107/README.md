# Opus 固定思考与强制工具：单次真实能力诊断

2026-11-07（UTC+8），主代理执行了一次受控诊断。真实 Google Antigravity API 返回 HTTP 400，明确错误为：

```text
Thinking may not be enabled when tool_choice forces tool use.
```

[real-result.json](real-result.json) 的 `validEvidence:true` 表示该拒绝结论与隔离检查有效，不表示模型生成或工具执行成功。仅发送 **1 次物理生成请求**，没有重试、账号／模型切换、工具执行或续接请求。结果补齐 Opus 此能力组合的真实依据，现有生产保护保持不变。

## 请求与诊断边界

| 项目 | 实际值 |
| --- | --- |
| 模型 | `claude-opus-4-6-thinking`，来自所选账号的实时目录 |
| 请求 | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` |
| 思考 | `includeThoughts:true, thinkingBudget:1024` |
| 输出上限 | `maxOutputTokens:2048` |
| 强制工具 | `mode:ANY, allowedFunctionNames:["read_file"]` |
| 工具声明 | 实抓 Claude Read 经现有契约转换出的官方受约束 `read_file` 视图；保留真实 `Path`、`StartLine`、`EndLine` Schema |
| 工具执行次数 | `0` |
| 上游结果 | HTTP `400`，`INVALID_ARGUMENT`，上述固定思考／强制工具冲突 |

脚本先调用标准生产 builder 构建 AUTO 基础包，再仅增加 `request.toolConfig`；完整前后包和 `changedFields:["request.toolConfig"]` 保存在报告中。固定模型、思考、输出上限、工具声明和其他字段均不随诊断更改。

这次直接能力诊断使用原生 `AgyNativeTransport.fetch` 与校验过 manifest 的 Go 二进制，**没有通过标准 Messages／Responses HTTP 入口**。标准入口原本会本地返回 `model_capability_conflict`；脚本没有修改该生产保护，而是在基础请求构建完成后添加诊断字段。因此它证明真实上游拒绝这一组合，不代表标准 HTTP 入口曾实际发出该请求，也不是一次端到端工具执行验收。

## 隔离与证据

- [prepared.json](prepared.json)：离线准备记录，`accountDataRead:false`、`realRequestsSent:false`。
- [real-result.json](real-result.json)：真实单次诊断；运行时间 `2026-11-06T20:57:22.531Z` 至 `2026-11-06T20:57:27.406Z`。
- 运行时快照：57 个文件，SHA-256 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`。
- 脚本 SHA-256：`909afae423b5e9d1a8e3e292f3ae10a6d56e434c3a14e1115221a21b5749e817`。
- 使用既有托管账号和额度／健康状态的临时副本，由原 AccountPool 完成目录、启停、健康、额度及冷却检查；选定账号未处于额度保护或冷却，生成前再次检查资格。
- `generationCount:1`、`generationLimitRespected:true`、`originalAccountsUnchanged:true`、`originalStateUnchanged:true`、`sourceUnchanged:true`。
- `nativeStopped:true`、`ownedWorkerStopped:true`、`temporaryCredentialsRemoved:true`；未操作正式服务，报告中账号身份和凭据已脱敏。

实现：[诊断脚本](../../../scripts/probe-opus-forced-tool.js)。离线护栏验证：[6 项测试](../../opus-forced-tool-probe.test.js)，覆盖精确单包限制、参数／账号变更拒绝、429／取消／网络失败停止、源码冻结、结论分类及不读取账号的 preflight。该测试与本次真实 400 分别记录，不能相互替代。
