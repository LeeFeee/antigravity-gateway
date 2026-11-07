# Codex 0.164.0 完整网关本地验收

这些文件来自原签名、实际安装的 `codex-cli 0.164.0`。链路为真实 CLI → 临时完整 Gateway HTTP → 本地合成 Google Antigravity API 响应。仅替换原生传输出口；HTTP、账号池、会话、协议和工具转换使用实际工作树代码。这里不证明真实 Google 接受或 TLS 指纹，真实上游批次由独立验收器记录。

最终 **9/9 场景、127 个逐景判据、17 次合成生成** 通过，索引与逐文件 SHA 见 [summary.json](summary.json)。每景运行时代码快照一致：`bb69a30be3c72a2aed88e0b9f4cf5389a29100644a25166abdd2d7cce03d0d82`（入口与 src JavaScript，算法见脚本 sourceSnapshot）。安装标识仅允许既有文件正常 RW 打开，前后内容 SHA 相同；不记录原值。临时目录均已删除。

| 文件 | 实际证明 |
| --- | --- |
| [text-v3.json](text-v3.json) | 远程目录被采用；中性 developer 模板；Responses SSE 完整结束 |
| [read-v3.json](read-v3.json) | `exec_command` 执行固定 `/bin/cat`，文件标记回传、再次生成 |
| [patch-v3.json](patch-v3.json) | 自定义 `apply_patch` 原文往返；CLI 成功事件与磁盘字节完全一致 |
| [error-v3.json](error-v3.json) | 固定不存在文件的真实命令错误回传 |
| [image-v3.json](image-v3.json) | `view_image` 真实 PNG 工具结果，转换后原字节保留 |
| [image-input-v3.json](image-input-v3.json) | `--image` 首轮图片输入与原字节保留 |
| [compact-v3.json](compact-v3.json) | 低阈值触发实际自动压缩；工具历史签名恢复；摘要后续聊 |
| [namespace-error-v4.json](namespace-error-v4.json) | `multi_agent_v1.close_agent` 指定不存在 UUID，客户端实际分组分派和错误回传 |
| [parallel-v1.json](parallel-v1.json) | 同轮两个固定文件读取，独立 call ID 与两份真实工具结果回传 |

所有场景都携带临时 `AGENTS.md` 的 `PROBE_USER_RULE`，且转换后仍存在。模型名 `gemini-3.8-flash-low` 与上游 `thinkingLevel: LOW` 一致。工具调用的原参数、ID、合成 thoughtSignature 在后续原生历史中恢复；合成签名不冒充 Google 颁发的签名。压缩在本配置下使用三次普通 `/v1/responses`，并未调用 `/responses/compact`。

复现单景（请用新的输出文件名，脚本拒绝覆盖证据）：

```sh
node scripts/verify-codex-gateway.js --scenario read --out /tmp/codex-read-new.json
node --test tests/codex-cli-evidence.test.js
```

本次保留的失败尝试：`text.json` 是外层 Seatbelt 监听规则过窄、0 次生成；`text-v2.json` 是验收器误要求 SSE 必须出现 `event:` 行，CLI 已成功，修正为解析合法 `data.type` 后另存 v3；`namespace-error-v3.json` 是测试选择器误选 `resume_agent` 而非 `close_agent`，不存在 UUID 的恢复返回真实错误，没有创建子代理，修正后另存 v4。不能把这些文件当成功验收。

边界：实测入口为 `codex exec`；跨进程 resume、TUI 首轮、用户中断及真实网络截断没有新增 CLI 实跑。断流末事件的验收器反例已有测试，现有通用协议单测另行覆盖。无真实配置、凭据、用户历史读取；不重设 HOME/CODEX_HOME。CLI 内层使用 danger-full-access 避免 macOS 嵌套 Seatbelt 失败，实际权限仍由外层 Seatbelt 限制为临时写入、唯一网关 loopback 出站与正式 auth/config 拒读写。
