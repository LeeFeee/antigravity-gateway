# Google Antigravity API 1.5.2：静态 RPC 字段字典

这是对官方二进制嵌入 `FileDescriptorProto` 的只读提取，不是网关实现清单，也不代表这些 RPC 都已获得真实服务器响应。

- 二进制：官方 `agy 1.5.2`，SHA-256 `d972bb48e8b98ba99479de8cd66b6f3b4e8184d95789ea8cce39dd18855d5184`。
- [完整 JSON 字典](../tests/fixtures/antigravity-1.5.2-protobuf-rpc-dictionary.json)：64 个 RPC、66 条 `/v1internal` REST 绑定；620 个消息定义、158 个枚举，所有被引用类型均已解析。
- 两条额外 REST 绑定属于 `ProxyCommand` 和 `StreamProxyCommand` 的带目标路径版本，不是漏掉两个 RPC。
- 字典记录字段编号、proto 名、JSON 名、标量/消息/枚举类型、repeated/required、oneof、map entry、默认值、弃用及可读出的 field behavior，并保存来源文件、二进制偏移与描述符摘要。原始 proto 没有保留的源码注释无法还原；字段存在也不等于某模型或账号接受该字段。
- 额外收录三个内部请求 DTO（生图、视频摘要、搜索）、长任务 `Any` 对应的 `OnboardUserResponse`，以及音频双向 gRPC 的编译定义。内部 DTO 不等于最终上游 JSON。

## 提取与复核

[提取脚本](../scripts/catalog-official-protobuf.py) 不运行官方程序、不依赖网络或第三方 protobuf 包。它从合法文件名/包名边界解析 wire format，验证嵌套结构，排除 3 个并非完整描述符的相似数据候选，得到 397 个可解析描述符，再只保留目标 RPC 的类型闭包。已独立比对 [先前逐字节定位的 66 条 HTTP 注解](../tests/fixtures/antigravity-1.5.2-static-rpc-inventory.json)，集合完全相等。字典的 `unresolvedTypes` 为空。

```sh
python3 scripts/catalog-official-protobuf.py --out tests/fixtures/antigravity-1.5.2-protobuf-rpc-dictionary.json
python3 -m unittest discover -s tests -p test_official_request_catalog.py -v
```

6 项离线检查覆盖注解全集、引用类型闭包、map/oneof、真实官方搜索续聊、生图关联/图片结果和视频原字节。这些检查不向任何服务发请求。

## 可达性分类

“当前网关不调用”与“官方 CLI 不可达”必须分开。下表列出全部 64 个定义；每个方法的完整请求/响应类型及递归字段位于 JSON 的 `methods`、`messages`、`enums` 中。

| 分类 | 当前证据与范围 |
|---|---|
| 核心生成 | 官方普通、压缩、媒体和新增工具分支已有动态请求；实际账号/模型能力仍分别验收。 |
| 核心支撑 | 当前 consumer OAuth、项目发现、目录、额度、管理信息所需；已有抓包。首次新账号 onboard 的真实服务端分支仍单独欠证，不能用已有账号登录代替。 |
| 编译定义候选 | 有完整请求/响应结构；当前尚无 consumer CLI 实际调用链或发包证明。不得因名字相似自动接入。 |
| 官方工具/交互辅助 | 静态 client/caller 或 mock 发包可达；它们服务官方工具、设置、插件、对话共享等功能，网关不因此代执行客户端工具或扩大对外能力。 |
| 远程控制/设备 | 官方另有远程会话功能；可能使用 consumer 身份，不能简单归为企业不可达。当前网关只代理模型，不管理远程设备、执行远程命令或修改配对状态，故仅静态调查，不执行这些操作。 |
| 旧 IDE/云开发分支 | 描述符已链接，但当前 consumer CLI 主生成链使用 GenerateContent，未证实这些独立旧方法的当前入口。不能把定义存在当成要恢复旧上游通道的理由。 |

| RPC | HTTP 绑定 | 请求顶层字段 | 分类 |
|---|---|---|---|
| `GenerateContent` | `POST /v1internal:generateContent` | project, requestId, request, model, userPromptId, userAgent, requestType, enabledCreditTypes | 核心生成 |
| `StreamGenerateContent` | `POST /v1internal:streamGenerateContent` | project, requestId, request, model, userPromptId, userAgent, requestType, enabledCreditTypes | 核心生成 |
| `CountTokens` | `POST /v1internal:countTokens` | request | 编译定义候选 |
| `RetrieveUserQuota` | `POST /v1internal:retrieveUserQuota` | project | 编译定义候选 |
| `FetchAvailableModels` | `POST /v1internal:fetchAvailableModels` | project, requestId, entitlement, location | 核心支撑 |
| `RetrieveUserQuotaSummary` | `POST /v1internal:retrieveUserQuotaSummary` | project | 核心支撑 |
| `RegisterWebPush` | `POST /v1internal:registerWebPush` | subscriptionId, fcmToken, userAgent | 远程控制/设备 |
| `NotifyUser` | `POST /v1internal:notifyUser` | event, instanceId | 远程控制/设备 |
| `ConnectInstance` | `POST /v1internal:connectInstance` | metadata, payload, instanceId | 远程控制/设备 |
| `ConnectInstanceV2` | `POST /v1internal:connectInstanceV2` | metadata, instanceId, proxyResponse, supportsPayloadText | 远程控制/设备 |
| `ListInstances` | `GET /v1internal:listInstances` | project | 远程控制/设备 |
| `UpdateInstance` | `POST /v1internal:updateInstance` | instanceId, metadata, updateMask | 远程控制/设备 |
| `DeleteInstance` | `POST /v1internal:deleteInstance` | instanceId | 远程控制/设备 |
| `ProxyCommand` | `POST /v1internal:proxyCommand` | targetInstanceUuid, rpcPath, payload, headers | 远程控制/设备 |
| `StreamProxyCommand` | `POST /v1internal:streamProxyCommand` | targetInstanceUuid, rpcPath, payload, headers | 远程控制/设备 |
| `InitiateMeshSession` | `POST /v1internal:initiateMeshSession` | targetInstanceId, clientInstanceId, webCryptoPubKey | 远程控制/设备 |
| `SendSignalingMessage` | `POST /v1internal:sendSignalingMessage` | sessionId, payload, messageId, senderId, recipientId, payloadType | 远程控制/设备 |
| `PollSignalingMessages` | `POST /v1internal:pollSignalingMessages` | sessionId, instanceId, afterTimestamp, includeAuthorizedKeys | 远程控制/设备 |
| `ListAuthorizedDevices` | `POST /v1internal:listAuthorizedDevices` | targetInstanceId | 远程控制/设备 |
| `RevokeAuthorizedDevice` | `POST /v1internal:revokeAuthorizedDevice` | targetInstanceId, clientInstanceId, scope, reason | 远程控制/设备 |
| `ListAgentPlugins` | `GET /v1internal/agentPlugins` | filter, pageSize, pageToken | 官方工具/交互辅助 |
| `ListBuildWithGooglePlugins` | `GET /v1internal/buildWithGooglePlugins` | filter, pageSize, pageToken | 官方工具/交互辅助 |
| `GetAgentPlugin` | `GET /v1internal/{name=agentPlugins/*}` | name | 官方工具/交互辅助 |
| `ListCascadeNuxes` | `GET /v1internal/cascadeNuxes` | filter, pageSize, pageToken | 官方工具/交互辅助 |
| `ListWebDocsOptions` | `GET /v1internal/webDocsOptions` | pageSize, pageToken | 官方工具/交互辅助 |
| `RewriteUri` | `POST /v1internal:rewriteUri` | originalUri | 官方工具/交互辅助 |
| `FetchUserInfo` | `POST /v1internal:fetchUserInfo` | project | 核心支撑 |
| `SetUserSettings` | `POST /v1internal:setUserSettings` | userSettings | 官方工具/交互辅助 |
| `TabChat` | `POST /v1internal:tabChat` | project, request | 官方工具/交互辅助 |
| `CheckUrlDenylist` | `POST /v1internal:checkUrlDenylist` | url | 官方工具/交互辅助 |
| `CheckUrlAntivirus` | `POST /v1internal:checkUrlAntivirus` | url | 官方工具/交互辅助 |
| `GetHealth` | `GET /v1internal/{name=health}` | name | 官方工具/交互辅助 |
| `RecordTrajectoryAnalytics` | `POST /v1internal:recordTrajectoryAnalytics` | trajectory, startStepIndex, startGeneratorMetadataIndex, metadata, mendelExperimentIds | 官方工具/交互辅助 |
| `WriteTrajectoryACLs` | `POST /v1internal:writeTrajectoryAcls` | trajectoryId, attributedOwner | 官方工具/交互辅助 |
| `FetchFromTrawlerCache` | `POST /v1internal:fetchFromTrawlerCache` | url, liveFetch | 官方工具/交互辅助 |
| `RegisterInteraction` | `POST /v1internal:registerInteraction` | interaction | 官方工具/交互辅助 |
| `BattleModeOverrides` | `POST /v1internal:battleModeOverrides` | modelIds, autoTriggered, triggerTag | 官方工具/交互辅助 |
| `BattleModeAutoTrigger` | `POST /v1internal:battleModeAutoTrigger` | lastAutoTriggerRequestTime, modelId, prompt | 官方工具/交互辅助 |
| `UploadPerformanceProfile` | `POST /v1internal:uploadPerformanceProfile` | performanceProfile | 官方工具/交互辅助 |
| `ProvisionConversationBundleDir` | `POST /v1internal:provisionConversationBundleDir` | 空消息 | 官方工具/交互辅助 |
| `GetBundleWriteMint` | `POST /v1internal:getBundleWriteMint` | 空消息 | 官方工具/交互辅助 |
| `GenerateCode` | `POST /v1internal:generateCode` | project, requestId, ideContext, metadata, enablePromptEnhancement, tierId | 旧 IDE/云开发分支 |
| `CompleteCode` | `POST /v1internal:completeCode` | project, requestId, ideContext, metadata, enablePromptEnhancement, userContext, tierId | 旧 IDE/云开发分支 |
| `TransformCode` | `POST /v1internal:transformCode` | project, requestId, ideContext, userPrompt, command, metadata, enablePromptEnhancement, tierId | 旧 IDE/云开发分支 |
| `SearchSnippets` | `POST /v1internal:searchSnippets` | project, query, requestId | 旧 IDE/云开发分支 |
| `FetchCodeCustomizationState` | `POST /v1internal:fetchCodeCustomizationState` | project | 旧 IDE/云开发分支 |
| `GenerateChat` | `POST /v1internal:generateChat` | project, requestId, userMessage, history, ideContext, metadata, enablePromptEnhancement, yieldInfo, yieldedUserInput, retryDetails, functionDeclarations, includeThinkingSummaries, tierId, modelConfigId, userPromptId | 旧 IDE/云开发分支 |
| `StreamGenerateChat` | `POST /v1internal:streamGenerateChat` | project, requestId, userMessage, history, ideContext, metadata, enablePromptEnhancement, yieldInfo, yieldedUserInput, retryDetails, functionDeclarations, includeThinkingSummaries, tierId, modelConfigId, userPromptId | 旧 IDE/云开发分支 |
| `InternalAtomicAgenticChat` | `POST /v1internal:internalAtomicAgenticChat` | project, requestId, userMessage, history, ideContext, metadata, enablePromptEnhancement, toolDefinitions | 旧 IDE/云开发分支 |
| `MigrateDatabaseCode` | `POST /v1internal:migrateDatabaseCode` | project, requestId, ideContext, metadata | 旧 IDE/云开发分支 |
| `ListExperiments` | `POST /v1internal:listExperiments` | project, metadata | 核心支撑 |
| `LoadCodeAssist` | `POST /v1internal:loadCodeAssist` | cloudaicompanionProject, metadata, mode | 核心支撑 |
| `ListCloudAICompanionProjects` | `GET /v1internal:listCloudAICompanionProjects` | pageToken, pageSize, filter | 编译定义候选 |
| `ListAgents` | `GET /v1internal:listAgents` | project | 编译定义候选 |
| `ListRemoteRepositories` | `GET /v1internal:listRemoteRepositories` | project, pageToken, pageSize | 编译定义候选 |
| `ListModelConfigs` | `POST /v1internal:listModelConfigs` | metadata, domain | 编译定义候选 |
| `OnboardUser` | `POST /v1internal:onboardUser` | tierId, cloudaicompanionProject, metadata | 核心支撑 |
| `OnboardUserBackgroundTasks` | `POST /v1internal:onboardUserBackgroundTasks` | projectNumber, operation, tierId, isAntigravityUser | 编译定义候选 |
| `RecordSmartchoicesFeedback` | `POST /v1internal:recordSmartchoicesFeedback` | feedbackId, showCompletionFeedback | 官方工具/交互辅助 |
| `RecordCodeAssistMetrics` | `POST /v1internal:recordCodeAssistMetrics` | project, requestId, metadata, metrics | 官方工具/交互辅助 |
| `RecordClientEvent` | `POST /v1internal:recordClientEvent` | project, ideType, metric | 官方工具/交互辅助 |
| `GetCodeAssistGlobalUserSetting` | `GET /v1internal:getCodeAssistGlobalUserSetting` | cloudaicompanionProject, useReadApi | 官方工具/交互辅助 |
| `SetCodeAssistGlobalUserSetting` | `POST /v1internal:setCodeAssistGlobalUserSetting` | cloudaicompanionProject, freeTierDataCollectionOptin | 官方工具/交互辅助 |
| `FetchAdminControls` | `POST /v1internal:fetchAdminControls` | project | 核心支撑 |

## 已调查但不能混同的边界

1. **CountTokens / RetrieveUserQuota**：有 HTTP 与字段定义，不等于当前 CLI 已调用；当前额度实证是 `retrieveUserQuotaSummary`，计数不能假冒一次已执行的 CountTokens。
2. **项目/仓库/代理列表**：`ListCloudAICompanionProjects`、`ListRemoteRepositories`、`ListAgents`、`ListModelConfigs` 等定义已列全。当前 consumer 网关所需项目由 `loadCodeAssist` 返回；其他入口未在本次主路径触发，不能声称业务不可达。
3. **后台任务与遥测**：`OnboardUserBackgroundTasks` 及各 Record 方法不因字段字典存在就变成网关必发请求。Hub mock 运行实际看到 `writeTrajectoryAcls` 和 `https://play.googleapis.com/log`，后者是遥测而非模型 API；本地 mock 对它们返回 404，只能证明官方发出请求。
4. **企业 / BusinessAICode / Vertex / Gateway 分支**：静态分析发现共享库包含这些生成实现；它们有不同的选择条件/认证配置，本次 consumer 登录态未切到这些分支，网关也不恢复为新兜底。这里没有把它们归为“不可达”，而是明确未完成对应认证条件下的动态验收。
5. **音频听写**：实际 caller 为 `ServerBackend.startTranscription → audiotranscribe.Start`，代码中引用 `aicode.googleapis.com:443` 和 `/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent`；嵌入描述符却是 `google.gca.aicode.v1main.PredictionService`。字典分别标明 URL 与编译定义，不能宣称版本路径已验证相同。未录麦、未发音频 gRPC；该实时录音功能不等于网关转发用户已有音频附件。
6. **HTTP 之外的认证与长任务**：OAuth token、userinfo、浏览器授权 URL、onboard operation 轮询另外见认证/请求目录，不在这 66 条服务内 HTTP 注解集合内。字典完整不表示 OAuth 首次新账号授权与后台任务都已真实触发。

新增 `web_search`、`image_gen`、`video_summarization` 的本机官方动态发包及模型条件，见[新增请求类型证据](antigravity-api-1.5.2-additional-request-types.md)。原静态 client 方法/调用链见[静态补充目录](antigravity-api-1.5.2-static-rpc-supplement.md)。
