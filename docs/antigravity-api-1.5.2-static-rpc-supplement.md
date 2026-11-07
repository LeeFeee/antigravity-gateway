# Google Antigravity API 1.5.2：静态 RPC 补充目录

日期：2026-11-07。本次只读分析官方已安装二进制和已有证据；没有启动模型请求、访问外网、录音、修改源码或运行中的 OAuth 验收环境。新增的静态材料不能冒充官方发包或 Google 接受结果。

## 结论与证据范围

现有[请求目录](antigravity-api-1.5.2-request-catalog.md)确实主要由既有抓包汇总，尚不能称为“所有可达上游请求类型已调查完毕”。归档脚本 `catalog-antigravity-evidence.py` 只遍历 `*.request.json`，此前没有静态 RPC 枚举或逐项可达性闭环。

官方 `/Users/leefee/.local/bin/agy` 的 SHA-256 仍为 `d972bb48e8b98ba99479de8cd66b6f3b4e8184d95789ea8cce39dd18855d5184`，与 1.5.2 旧证据相同。只读 `go version -m` 报告其构建版本为 `go1.28-20261102-RC00 cl/1012564305 +298f53e483`，不应把 Gateway 使用的 Go 1.27.2 构建工具版本写成官方 CLI 的编译器版本。编译器版本不同本身不推翻已有实际 TLS 抓包与传输测试。

[独立静态 fixture](../tests/fixtures/antigravity-1.5.2-static-rpc-inventory.json)保存：

- 66 条 `/v1internal` HTTP 注解，按 protobuf 字段的动词和长度提取，避免相邻 Go 字符串拼接造成伪路径；**注解存在不等于 CLI 可达**。
- 210 个有独立函数入口的 `CodeAssistClient` 方法与选定的媒体、CLI 入口，共 225 条函数记录。二进制名称表还出现两个没有独立函数入口的名称，单独保留；不能排除内联或方法元数据。包含只读方法、修改操作、getter 和内部 helper，不把数量当作网络 RPC 数量。
- 直接调用者、选定直接被调用函数、HTTP 方法名称和请求类型的字面量引用位置。
- 三种内部媒体/搜索请求类型的 getter 字段；它们不是已经抓到的上游 JSON。

普通 `nm`/`go tool objdump -s` 没有恢复出这些 Go 名称。本次解析 Mach-O 的 Go pclntab（文件偏移 `0x43aa340`，181183 个函数），再对 ARM64 `BL` 相对目标匹配函数入口。正文 `.text` 文件偏移为 `0x11c0`。关键函数还以有界 `llvm-objdump` 反汇编核对地址。`ADRP+ADD` 用于定位字符串引用；fixture 明确只记录锚点，不声称已恢复完整参数长度、寄存器数据流或序列化结果。

静态直接调用图不包含接口派发、回调和方法值。没有找到直接调用者不能据此宣布死代码；找到函数和直接调用者也不能代替具体 CLI 场景、账号资格、功能开关和实际请求捕获。

## 与现有动态目录的对应

| 请求族 | 动态证据 | 本次静态补充 | Gateway 核心是否需要 |
| --- | --- | --- | --- |
| `loadCodeAssist`、`fetchAvailableModels`、`retrieveUserQuotaSummary` | 官方真实请求与成功响应 | 均有实际 `CodeAssistClient` 方法及调用链 | 是，项目、目录、额度 |
| `fetchUserInfo`、`fetchAdminControls`、`listExperiments` | 官方真实初始化抓包 | 实际客户端方法；其中实验/配置还有条件分支 | 用于完整理解官方初始化，不能据此要求网关复制遥测或所有客户端设置 |
| `streamGenerateContent`，`agent` / `checkpoint` | 官方真实生成、工具和压缩证据 | 生成方法及请求构造器存在 | 是 |
| `generateContent`，`image_gen` | 已有网关真实生图/编辑；官方默认 CLI 的该场景未捕获 | `GetImageGeneration → GenerateContent → generateContentFromCCPA`，明确引用 `image_gen` | 是，已保留图片能力；官方触发入口仍须单独补录 |
| OAuth URL、token、userinfo、onboard、operation 轮询 | 官方全 mock 发包；已有托管账号另有真实刷新；真实看板授权另行验收 | 本次没有重复触发或扩大这些证据 | 是；仍按原认证文档区分请求格式和真实接受结果 |

旧 `official/` 共 149 个请求、8 个分组；`official-mcp/` 共 31 个请求、8 个分组。`official-media/` 下的两条 `generateContent/image_gen` 位于 **gateway-validation/**，不能因父目录叫 official-media 就将它们改标为官方 CLI 证据。

当前 Gateway 核心实际使用的 RPC 族均能在原目录中找到对应调查记录。本次未发现“核心已经发出、但此前完全没有调查”的新 RPC；新发现主要是官方程序其他功能的覆盖缺口。视频原始字节经 `agent` 请求已真实成功，不等同于官方视频摘要辅助请求已经捕获。

## 新发现的实际客户端候选

以下均有实际实现、字面量引用或调用链，强于纯 protobuf 注解。表中 HTTP 路径表示 CCPA 分支；若实现调用 `doJetskiRequestAndUnmarshal`，仍存在 Jetski endpoint 选择及回落分支，具体账号下使用哪个主机未在本轮动态验证。

| 功能/候选 | 传输、路径或请求类型 | 已确认的调用链 | Gateway 核心边界 |
| --- | --- | --- | --- |
| 视频摘要 | `streamGenerateContent`，`requestType=video_summarization` | `Server.GenerateMediaSummaries.func1 → Server.generateVideoSummarization → modelapiinterface.GetVideoSummarization`；CCPA 实现为 `modelapiccpa.Client.GetVideoSummarization → CodeAssistClient.GetVideoSummarization → StreamGenerateContent` | 当前原始视频输入不依赖此辅助摘要；不能擅自抽帧或替换用户视频 |
| 网页搜索 | `generateContent`，`requestType=web_search` | `PlatformClient.GetWebSearchResults` / `modelapiccpa.Client.GetWebSearchResults → CodeAssistClient.GetWebSearchResults → GenerateContent`；存在 `SearchWebToolConverter` 与 `SearchWebHandler` | 官方工具执行路径。网关不得因调查该 RPC 而代执行客户端搜索 |
| 网页重定向 | POST `rewriteUri` | `PlatformClient.RewriteURL → CodeAssistClient.GetWebSearchRedirect → doJetskiRequestAndUnmarshal` | 官方网页工具配套，不是默认转发必须 RPC |
| URL 拒绝列表检查 | POST `checkUrlDenylist` | `PlatformClient.IsUrlDenied → CodeAssistClient.CheckUrlDenylist → doJetskiRequestAndUnmarshal` | 同上 |
| URL 安全检查 | POST `checkUrlAntivirus` | `PlatformClient.CheckURLAntivirus → CodeAssistClient.CheckUrlAntivirus → doJetskiRequestAndUnmarshal` | 同上 |
| 网页缓存读取 | POST `fetchFromTrawlerCache` | `PlatformClient.FetchFromTrawlerCache → CodeAssistClient.FetchFromTrawlerCache → doJetskiRequestAndUnmarshal`；有 `ReadUrlContentHandler.fetchViaProxy` 实现 | 不应在网关中执行客户端网页读取 |
| 用户设置更新 | POST `setUserSettings` | `PlatformClient.UpdateUserAccountSettings → CodeAssistClient.SetUserSettings → doJetskiRequestAndUnmarshal` | 远端设置变更；不是本次网关本地设置保存 |
| 交互记录 | POST `registerInteraction` | `PlatformClient.RegisterInteraction → CodeAssistClient.RegisterInteraction` | 非模型转发必需；本轮未发送 |
| 轨迹统计 | POST `recordTrajectoryAnalytics` | `telemetry.Client.RecordTrajectorySegmentAnalytics → CodeAssistClient.RecordTrajectorySegmentAnalytics`；先检查 `SkipTelemetry` 等条件 | 不要求网关上送用户轨迹或遥测 |
| 轨迹 ACL | POST `writeTrajectoryAcls` | `telemetry.Client.RecordCortexTrajectory.func1 → CodeAssistClient.WriteTrajectoryACLs` | 非模型转发必需；本轮未变更 ACL |
| Battle 模式 | POST `battleModeAutoTrigger` / `battleModeOverrides` | `Server.DetectBattleModeAutoTrigger` / `Server.resolveServerModels → CodeAssistClient` 对应方法 | 比较/选择模型功能，非本次唯一上游转发的必要请求 |
| 插件目录、单插件、内置插件、新手提示、网页文档选项 | GET `/v1internal/agentPlugins`、`/v1internal/{name=agentPlugins/*}`、`/v1internal/buildWithGooglePlugins`、`/v1internal/cascadeNuxes`、`/v1internal/webDocsOptions` | `PlatformClient` 到对应 `GetAvailableCascadePlugins` / `GetCascadePluginById` / `GetBuildWithGooglePlugins` / `ListCascadeNuxes` / `GetWebDocsOptions`；`ServerBackend.ListCascadeNuxes` 也存在 | 官方客户端扩展/界面请求，网关不需要模拟插件执行环境 |
| Tab 模型分支 | POST `tabChat`，构造时带 `alt=sse` | `CodeAssistClient.GetChatMessage → getChatMessageTabModel → construct…EndpointWithParams + http.NewRequestWithContext` | 实际实现存在，但未证明当前普通 CLI agent 模式会选中；不能当作已移除的第二通道重新接入 |
| 音频听写 | `aicode.googleapis.com:443`；gRPC `/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent`；引用 `audio/pcm;rate=16000` | `ServerBackend.startTranscription → audiotranscribe.Start`；`Server.StreamAudioTranscription`、`Server.startVoiceTranscriber` 也调用同一实现；CLI 有 `dictateCommand`/`startDictation` | CLI 录音/实时听写功能，不等同于向模型转发已有音视频附件；网关不录麦、不增设该执行通道 |

`GetBundleWriteMint`、`ProvisionConversationBundleDir`、`UploadPerformanceProfile` 有实际客户端实现和 HTTP 注解，但本次没有找到直接调用者；仍保留为条件可达候选，不能据此宣布已测试或必需。

二进制还包含实际 `GenerateContentFromAICode/BusinessAICode/VertexAI/Gateway` 和对应流式方法，`GenerateContent` / `StreamGenerateContent` 有到这些方法的直接分支引用。账号授权方式、服务端配置和环境开关尚未穷尽；本轮已取证的 consumer CCPA 请求不能覆盖所有条件分支。这是官方程序的可达性边界，不是要求 Gateway 恢复 Robin、Gemini 网页或子进程兜底。

客户端方法名录还包括远程 agent 的会话、项目、文件、终端、触发器和语音操作，以及许可和企业配置方法。它们在 fixture 中完整列出，部分经动态资源 URL 构造；本轮没有解读每个请求的条件和字段，更没有执行远程操作。这些官方产品功能不应混入网关的客户端工具转换职责。

`countTokens`、`retrieveUserQuota`、`completeCode`、`generateCode`、`generateChat`、`streamGenerateChat` 等仅靠 HTTP 注解尚不能证明 CLI 场景可达。本次没有找到 `CodeAssistClient.CountTokens`；依赖库中的 `genai.Models.CountTokens` 也不能自动算作当前 CLI 的调用。Gateway 当前本地 token 估算接口不是上述 RPC 已被调查或接入的证据。

## 请求构造字段：已知与未证实

| 内部请求类型 | 二进制 getter 明确存在的字段 | 本次可直接确认的上游构造 |
| --- | --- | --- |
| `GetVideoSummarizationRequest` | Metadata、VideoBytes、MimeType、ChatModel | 经过 MIME 能力判断，调用流式生成，引用 `video_summarization`；包含用于替代视频的详细文字描述提示。完整内层 part 布局、生成预算和具体模型选择仍须发包确认 |
| `GetImageGenerationRequest` | Metadata、Prompt、Model、LatencyInfo、InputImages、InputMedia、TrajectoryId、StepIndex、AspectRatio | 调用同步 GenerateContent，引用 `image_gen` 并调用 `getImageGenerationModelID`；现有网关 `image_gen` 格式另有真实成功，不反向冒充官方同字段发包 |
| `GetWebSearchResultsRequest` | Metadata、Query、Model、CustomModelInfoOverride、Limit、Domain、ThirdPartyConfig、ImageSearch | 调用同步 GenerateContent，引用 `web_search` 和专用搜索提示，使用 `getWebSearchModelID`；完整搜索配置、工具字段与结果格式尚未捕获 |
| 音频听写 | 上述 Start 及双向流实现 | 确认 gRPC 方法、默认 host 和 PCM MIME；setup、ASR context、音频 chunk、半关闭及错误帧仍须专用本地 gRPC 模拟确认 |

字段名称来自内部 API 类型，不能直接当作 Google HTTP JSON 的键名。fixture 提供相应 getter 及方法引用，不包含猜测的完整上游请求模板。

## 后续本地探测入口方案

1. **视频摘要优先查本地 `GenerateMediaSummaries` 入口。** 现有 ACP `resource` 视频块已实证被遗漏，重复该入口不会补齐摘要请求。先确认官方进程暴露该语言服务 RPC 的启动方式与本地访问约束，再以合成 MP4 和假模型目录触发；若只能在桌面路径可达，明确记录 CLI 不可直接触发，不能假造 ACP 成功。
2. **搜索与生图从官方工具注册入手。** 已找到 `SearchWebToolConverter`/`SearchWebHandler`、`GenerateImageToolConverter`/`GenerateImageHandler`，以及 `ImageGeneratorSubagentEnabled → buildDefaultAgent` 的配置关系。后续可在全 mock 上游中给官方 agent 回传其实际声明的工具调用；必须先观察官方声明和功能开关，不能编造不存在的名称或参数强迫执行。网页目标只能是本地合成服务，图片输出只能是合成字节。
3. **听写保留为独立协议边界。** CLI 有 `/dictate` 对应命令对象，但不通过真实录麦触发。现有认证 HTTP mock 代理主要模拟 JSON/form 请求，不能直接宣称已覆盖双向 gRPC；后续若做，应单独增加本地 BidiGenerateContent 服务和合成 PCM 注入入口，并继续强制仅 loopback 网络。
4. 当前 `probe-official-auth.py` 故意返回空模型目录，且代理对未实现路径返回 404；不能原样运行它就声称完成搜索、视频摘要或生图取证。需要独立新探测脚本/fixture，保持现有认证脚本和正式 OAuth 环境不变。

完成“所有可达请求类型”需要给每个候选记录触发条件、实际发包或明确排除依据。当前做到的是：核心已用请求族有独立动态依据；新增静态候选已归档并分级；工具执行专用、远程 agent、企业/其他 provider、听写及未触发分支仍然不应标成全部完成。
