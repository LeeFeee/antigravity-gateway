# agy 1.5.2 / Gateway 1.7.5 验收

> 本文及相关取证文档中的绝对证据路径用于标识验收时的本机归档，原始归档未随仓库发布。仓库内可复核的脱敏样本位于 `tests/fixtures/`；本机路径不是安装或运行依赖。

2026-11-06，本机 macOS arm64；详细协议见 [迁移报告](agy-1.5.2-compatibility.md)。

| 要求 | 当前证据 | 结果 |
| --- | --- | --- |
| 从已登录官方 1.5.2 探测 | 未修改 CLI 二进制版本与 SHA-256；12 次真实生成抓包 | 全部 HTTP 200 |
| UA、认证、HTTP 和 JSON 格式 | 原始请求头、脱敏 Authorization 哈希、目录与生成体、响应、客户端 ClientHello | 已核对 |
| 禁止用旧网关先试上游 | 官方探测先完成；源码改造及离线 845 项通过后才启动新版网关实测 | 已遵守 |
| 避免旧标识与工具声明兼容问题 | 新 UA/build、thinkingLevel、Claude 标签；Direct 保留客户端工具合同；默认零额外工具；finish 无旧元数据 | 已实现 |
| 六模型兼容 | 六个模型分别通过官方 CLI 与新版网关真实文本调用 | 全部通过 |
| 三种协议及真实工具能力 | Chat、Messages、Responses、SSE、JSON Schema、Gemini 与 Claude 指定工具/回传 | 14 次成功生成抓包 |
| Claude 强制工具冲突 | 1 次 400 捕获 → 补充显式冲突检测/默认思考抑制 → 2 次真实工具往返 200 | 已修复 |
| 离线回归 | 全量 `node --test tests/*.test.js`，临时配置目录且禁止外部出站；`npm run check` | 846 通过，0 失败 |
| 本机安装 | `npm pack`，离线全局安装；74 个运行时文件 SHA-256 与源码一致 | 1.7.5 |
| 正式运行 | launchd 正常运行，`GET /dashboard/data` 返回 1.7.5 / 200 | 通过 |
| 正式推理 | `POST http://127.0.0.1:9897/v1/chat/completions` 返回 `GATEWAY152_INSTALLED_OK` / 200 | 通过 |

正式服务首次验收被旧账号池状态本地拦截（429）；已确认当前 CLI 对应的同一个账号仍启用、
未被删除，但池中凭据过期。将已验证的新登录态同步到该现有账号，并通过原有 recheck 的
实际推理门槛恢复 available。没有直接清除隔离状态，没有启用其他停用/删除账号或修改额度保护。

本次只升级本机安装；未发布 npm、未推送 Git、未修改远程部署。

## 证据路径

原始证据目录（仅本机，目录 0700 / 文件 0600）：

`/Users/leefee/Claude/antigravity-152-evidence-20261106.e1s7__26/`

- `official/`：官方 CLI 的请求、响应、实体与 ClientHello。
- `gateway/`：新版网关的实际请求和响应，包含已修复的 Claude 400 样本。
- `verification-summary.json`：生成请求计数、成功模型与实际 HTTP 头比较。
- `live-results.json`、`live-model-results.json`、`live-claude-tool-results.json`：真实接口输出。
- `suite-final.log`：846 项离线回归；`check-release.log`：语法和原生环境检查。
- `deployment.json`：安装文件比对、账号复核与正式服务推理结果。
- `SHA256SUMS`：归档文件校验。
- `antigravity-gateway-1.7.5.tgz`：最终本地安装包。

旧安装备份：`/Users/leefee/.antigravity-gateway-backup-1.7.5-evdteysc/installed-1.7.4.tar.gz`。

所有 Authorization 均在落盘前脱敏；登录 Token 未进入源码、fixture 或证据归档。
UA/传输层直接对照限于本机 macOS arm64；其他平台仍由原跨平台原生二进制承载，
本次没有把其运行支持宣称为逐平台官方 CLI 1.5.2 实抓验证。
