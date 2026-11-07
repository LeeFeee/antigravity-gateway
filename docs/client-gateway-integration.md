# 四客户端真实网关链路验证

日期：2026-11-07。验证对象是当前工作区源码，链路为 **真实安装客户端 → 真实临时网关 → 本机合成 Google Antigravity API 服务**。本轮 8 个场景全部通过，共捕获 16 次生成请求。

这不是客户端直接连接合成 OpenAI/Anthropic 服务的旧探测：本次实际经过网关 HTTP 入口、账号池、托管凭据、Direct 请求构建、1.5.2 外层、工具转换、会话状态、上游 SSE 解析与客户端响应转换。仅将 `nativeCloudCodeFetch` 替换为限定到本次 loopback 端口的 Node `fetch`，没有替换 `AccountPool.send`、Direct handler 或工具执行逻辑。

Google 服务与账号凭据均为本地合成数据，因此 **不验证真实 Google 模型、账号授权、TLS 指纹或正式安装包**。

## 结果

| 客户端 | 版本 | 文本场景生成请求数 | 读取场景生成请求数 | 实际客户端工具 | 结果 |
| --- | --- | ---: | ---: | --- | --- |
| Claude Code | 2.1.318 | 1 | 2 | `Read` | 两场景通过 |
| Hermes | 0.21.7+11153.g2bd378e | 2 | 3 | `read_file` | 两场景通过 |
| Pi | 1.5.0 | 1 | 2 | `read` | 两场景通过 |
| dsh | 0.2.1-rc.2 | 2 | 3 | `read` | 两场景通过 |

Hermes 与 dsh 实际产生额外辅助请求，因此请求数比主文本/工具链多一次。各场景均保留这些请求，不把它们算作工具重复执行。

四个读取场景都由假上游从**收到的真实声明**选择原生 `read_file`，发送临时文件绝对路径及 `StartLine:1, EndLine:2`。网关将其还原为对应客户端的原工具名和参数；真实客户端读取临时文件，并将包含 `PROBE_FIXTURE_LINE_1` 的结果返回网关。后续上游请求实际包含 `read_file` 的 `functionResponse`，最终客户端收到 `LOCAL_GATEWAY_VERIFIED` 并正常结束。

所有生成包均具有 Google Antigravity API 的 `project/requestId/request/model/userAgent/requestType` 外层，HTTP UA 为 `antigravity/cli/1.5.2 ...`，公开模型 `gemini-3.8-flash-high` 对应 `thinkingLevel:HIGH`。实际目录响应也验证了固定 high 展示，以及视频/MIME 能力与 Codex text/image 枚举的分离。

## 证据和回归

- [完整摘要](../tests/fixtures/client-gateway-20261107/summary.json)
- 每个场景的 `agent-text.json`、`agent-read.json` 保存真实客户端 HTTP 请求与响应、Google API 请求、CLI 输出、网关日志及逐项判定。
- [验证脚本](../scripts/verify-client-gateway.js)；[证据及当前转换器重放测试](../tests/client-gateway-fixtures.test.js)；[验证器边界测试](../tests/client-gateway-verifier.test.js)。

复现需要本机已安装对应版本的四客户端和 macOS Seatbelt：

```bash
node scripts/verify-client-gateway.js --timeout 60 --out tests/fixtures/client-gateway-20261107
```

可用 `--agents claude,pi`、`--scenarios text,read` 缩小范围，或 `--hermes-repo` 指定安装源码位置。脚本不会启动正式网关，也不会全局安装或重启服务。

每场景使用独立临时 HOME、配置、工作目录、端口和假账号 JSON；假账号文件用于模拟已有托管数据，不构成产品新增账号入口。Seatbelt 限制网络为 loopback、写入为临时目录，并拒绝读取真实网关账号目录及主要客户端配置。Hermes 仅只读复用安装依赖元数据和依赖文件，租约与后台服务均归临时 HOME，结束时只停止本次临时服务。导出证据会替换假密钥、用户目录、临时根路径和端口。

## 此轮发现并修复的模板分支

Claude Code 2.1.318 在选择 Gemini 模型时使用精简 `# Harness` 模板，其 `Read/Write/Edit` 描述与同版本 Claude 模型下的模板不同。首轮验证的 Claude 读取场景没有原生读取视图，只有保守 MCP 兼容视图；验证器要求原生 `read_file`，因而拒绝继续。这不是一次真实客户端读取失败，也没有触发其他工具执行。

[原始失败样本](../tests/fixtures/client-gateway-20261107/failures/claude-read-compact-template.json) 保留。补入该精简系统模板的可靠组合边界、默认 attribution 的精确首轮布局，以及三种工具声明的实际完整指纹后，重跑整个 8 场景矩阵全部通过。权限、安全、记忆和项目行为文字仍保留；未知模板和用户改写内容继续保守处理。

当前矩阵只证明文本与一个普通文本文件读取闭环。它不替代写入/编辑/命令/图片/复杂 JSON Schema、取消、跨重启续接和故障切号等各自的回归或真实上游验收。
