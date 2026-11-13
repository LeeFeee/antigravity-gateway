# agy 1.5.6 与客户端协议验证

2026-11-12，macOS arm64。基线为网关 2.0.1（`36ece81`）。用未修改的官方 CLI 在本机隔离环境发包，合成账号和响应由本地代理提供。请求头、TLS 和六个模型的关键字段见 [报文样本](../tests/fixtures/agy-1.5.6-wire.json)和 [ClientHello 样本](../tests/fixtures/agy-1.5.6-tls.json)。[Google Antigravity CLI 更新记录](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)

| 上游路径 | 1.5.6 观察结果 |
| --- | --- |
| 模型 RPC | 从 HTTP/1.1 变为 HTTP/2，TLS ALPN 提供 `h2` 和 `http/1.1`。终端模式 UA 更新为 `antigravity/cli/1.5.6`，构建号 `1018951551`。ACP 实抓另外带客户端 `host_path` 和数据采集设置。 |
| OAuth 与账号元数据 | OAuth 授权链接、授权码兑换、刷新、用户信息和首次项目初始化轮询与前版一致。项目发现、目录及额度查询请求体字段相同，模型 RPC 随传输切到 HTTP/2。 |
| 对话、工具和压缩 | agent 和 checkpoint 封装、六个模型的生成配置、工具回传和结构化输出 `finish` 声明均与对应前版样本一致。流式 RPC 省略 `Content-Length`，同步生成和元数据带长度。 |
| 搜索 | 官方辅助请求把域名提示放入查询文本（`site:example.invalid`），`googleSearch` 不再带旧的 `includedDomains`。网关按现有公开接口转发查询，域名过滤参数继续由入口拒绝。 |
| 媒体 | 官方生图、图片编辑及 Hub 视频摘要请求体与前版一致。网关的视频理解仍传送用户提供的原始媒体，生图继续使用既有模型服务。 |

现有 Go helper 负责 HTTP/2，重新构建六个受支持平台的二进制。网关沿用原来的模型映射、账号选择、额度判断和工具转换。

| 客户端 | 实抓差异与适配 |
| --- | --- |
| Claude Code 2.1.322 | Messages 请求结构与读写编辑工具声明延续前版。更新身份模板的版本标记和 Auto Mode severity 政策指纹。SDK 和 TUI 的实际分类请求经网关验证仍把 `claude-sonnet-5` 路由至 `gemini-3.8-flash-low`，完整转回判定。 |
| Hermes 0.23.1 | Responses 主请求和 19 个工具声明相同，更新识别版本。实抓确认 `vision_analyze` 工具结果可携带 PNG。 |
| Pi 1.5.2 | 会话头改为 `session-id`，现有会话解析已支持。更新工具和身份识别版本。 |
| DSH 0.2.2-rc.1 | 会话头改为 `session-id`，headless 默认工具清单及审批描述有调整。读写编辑声明仍可由原转换器识别。最新版以临时 Node 24 环境运行，本机 PATH 中发现的版本为 0.2.1-rc.2。 |
| Codex CLI 0.167.2 | exec 和 TUI 仍使用 Responses，分别识别 `codex_exec` 和 `codex-tui` 请求标记。框架提示模板与前版一致。TUI 自动标题的 JSON Schema 请求通过既有 `finish` 转换。 |

五个真实客户端均经网关和本地合成上游验证文本与文件工具往返。Claude Code 与 Hermes 还验证了写入、编辑、终端，Claude Code 验证了 WebSearch 链路。Codex exec 验证了 9 个场景，包含图片、并行工具、namespace 和压缩。Codex TUI 启用及停用模型目录时均验证了对话和自动标题。

真实 Google 验证覆盖官方 CLI 目录与文本，隔离网关的 Claude Code 文本与文件读取（Flash Low）、Pi 文本（Sonnet 4.6）、Responses 视频理解和独立图片生成。首次隔离 Pi 的 Flash 请求在 40 秒内未收到上游结果，随后使用 Sonnet 成功，Claude Code 的 Flash 文本与读取也通过。新账号授权及首次项目初始化使用合成账号验证。六个平台的 helper 均已构建并核对摘要，实际网络验证在 macOS arm64 完成。

回归共 1107 项 Node 测试、6 项 Python 测试及 Go 原生测试通过。打包预检确认六个平台的 helper 均包含在安装包清单中。
