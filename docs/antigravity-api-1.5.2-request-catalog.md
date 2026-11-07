# Google Antigravity API 1.5.2 请求目录与媒体验证

整理日期：2026-11-07，Asia/Kuala_Lumpur。本文归档已有官方请求，并补充合成媒体的官方入口与网关真实请求；不把静态发现、未完成的探测或网关请求冒充官方 CLI 抓包。

## 1. 版本与证据身份

当前 `/Users/leefee/.local/bin/agy --version` 为 `1.5.2`，二进制 SHA-256 为：

```text
d972bb48e8b98ba99479de8cd66b6f3b4e8184d95789ea8cce39dd18855d5184
```

该值与 2026-11-06 官方取证的 `manifest.json` 完全相同。因此旧的六模型、普通工具、结构化输出、恢复和压缩样本可以继续作为同一版本证据，没有为这些场景重复大量生成请求。

| 证据集合 | 位置与含义 |
| --- | --- |
| 旧官方 CLI | 本机 `/Users/leefee/Claude/antigravity-152-evidence-20261106.e1s7__26/official/` |
| 本次官方 MCP | 本机重构取证目录下 `official-mcp/`；详见 [MCP 说明](antigravity-api-1.5.2-mcp-evidence.md) |
| 本次官方媒体入口 | 本机 `/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/official-media/` 中的 `image/`、`video/`、`generate/` |
| 本次网关媒体 | 同一目录的 `gateway-validation/`；记录调用时源码摘要，独立进程与临时状态目录 |
| 官方认证格式 | [四组本地记录](../tests/fixtures/official-auth-20261107)：未修改官方 CLI 实际发包，上游响应为合成数据 |
| 网关真实认证 | [现有托管账号副本刷新](../tests/fixtures/managed-oauth-refresh-20261107.json)；[看板新增授权 v2](../tests/fixtures/dashboard-oauth-real-20261107-v2.json)，与[首次取消记录](../tests/fixtures/dashboard-oauth-real-20261107.json)分别保留 |
| 仓库精简材料 | [RPC 类型与计数](../tests/fixtures/antigravity-1.5.2-rpc-inventory.json)、[媒体与能力目录](../tests/fixtures/antigravity-1.5.2-media.json) |

RPC 清单由[离线归档脚本](../scripts/catalog-antigravity-evidence.py)生成，不执行上游请求。它保存字段类型与来源计数，避免复制账号信息、完整提示词和凭据。HTTP 响应缺失的样本单独计数，不算成功。

## 2. 已捕获的官方请求

以下旧官方样本均来自同一 SHA 的 CLI，主机均为 `daily-cloudcode-pa.googleapis.com`，方法为 POST。计数仅指 2026-11-06 的官方目录，避免混入本次重复的初始化请求。

| RPC | 旧样本数／结果 | 请求结构 | 响应与用途 |
| --- | --- | --- | --- |
| `/v1internal:loadCodeAssist` | 44／全部 200 | `metadata.ideType = ANTIGRAVITY` | `cloudaicompanionProject`、currentTier、allowedTiers、paidTier 等；项目发现与账号计划 |
| `/v1internal:fetchAvailableModels` | 11／全部 200 | `project` | models、排序和各用途模型列表；模型、思考档位、媒体能力及模型额度 |
| `/v1internal:retrieveUserQuotaSummary` | 38／全部 200 | `project` | groups → buckets，包含 bucketId、window、remainingFraction、resetTime 等 |
| `/v1internal:fetchUserInfo` | 22／全部 200 | `project` | userSettings、regionCode；不是 OAuth token 接口 |
| `/v1internal:fetchAdminControls` | 11／全部 200 | `project` | 当前消费账号样本返回空对象；不能泛化为所有账号无管控字段 |
| `/v1internal:listExperiments` | 11／全部 200 | `project` | experimentIds、flags；用于了解官方请求上下文 |
| `/v1internal:streamGenerateContent?alt=sse`，`requestType=agent` | 11／全部 200 | 标准生成 envelope | 六模型、普通工具、结构化输出、恢复与压缩后续聊 |
| 同一生成 RPC，`requestType=checkpoint` | 1／200 | 压缩 envelope | 真实 `/compact` 场景，不是另一个供应通道 |

官方 MCP 又提供了真实工具错误、扩展声明与参数约束失败样本。官方媒体入口另补了图片成功和 ACP 视频资源被遗漏的对照。详细计数和缺失响应记录见 fixture。

**仅看到 `requestType=checkpoint` 不能判断用户执行了 `/compact`。** 本次 ACP 启动后还观察到轻量模型的辅助 checkpoint 请求；没有保留对应响应的记录不算完成。压缩验收以旧目录中带明确触发步骤的 `/compact` 与随后回忆样本为准。

### HTTP 与通用字段

官方生成 UA：

```text
antigravity/cli/1.5.2 (aidev_client; os_type=darwin; arch=arm64; cl=1015175089; auth_method=consumer)
```

生成使用 HTTP/1.1、Bearer 认证、JSON、chunked 请求体、gzip 响应能力；未添加客户端 Anthropic／OpenAI 标识头。元数据查询使用 Content-Length，不能为了形式一致将所有 RPC 改成同一传输布局。

生成外层字段为 `project/requestId/request/model/userAgent/requestType`；普通生成的内层包含 contents、可选 systemInstruction/tools/toolConfig、labels、generationConfig、sessionId。请求 ID、会话与轨迹标识属于运行时数据，不能复制 fixture 中的值。真实签名必须来自实际响应并按其历史关系恢复。

## 3. 登录、刷新与首次初始化的证据边界

此前媒体与模型采样使用已有登录态；2026-11-07 又以同一未修改的官方 agy 1.5.2 补齐登录、刷新与首次 onboard 发包证据。新增探测使用独立临时 HOME、合成 token／授权码和本地全 mock 上游，CLI 与代理均被限制为仅可访问 loopback，不读取正式账号、不打开真实浏览器、不向 Google 发请求。详见[官方认证协议取证](official-auth-protocol-evidence.md)与[四组脱敏原始记录](../tests/fixtures/official-auth-20261107)。

因此需要分开判断：下表中的官方请求已实际捕获；随后网关已有托管账号的一次真实刷新获得 Google HTTP 200，详见[独立刷新记录](../tests/fixtures/managed-oauth-refresh-20261107.json)。再后续用户通过隔离看板完成真实新增授权，授权码兑换实际为 401 → 200，账号保存、目录、额度和新账号副本刷新通过，详见 [v2 结果](../tests/fixtures/dashboard-oauth-real-20261107-v2.json)。这次账号已有项目，`onboardingObserved=false`，不能将新增授权等同于首次创建项目。

| 请求族 | 当前已知内容 | 证据级别与缺口 |
| --- | --- | --- |
| 终端 OAuth 授权 URL | 官方 `agy acp --login` 输出 `accounts.google.com/o/oauth2/auth`；PKCE S256、动态 state、`access_type=offline`、`prompt=consent`，回调为 `https://antigravity.google/oauth-callback`；scope 含原五项、aicode、openid | 官方实际输出；该官方采样批次没有真实浏览器授权。网关本地回调流程另有 v2 真实成功证据，不能混称验证了官方终端回调 |
| 授权码交换 | POST `oauth2.googleapis.com/token`，HTTP/2、`Go-http-client/2.0`、表单编码；字段为 client_id、client_secret、code、code_verifier、grant_type=authorization_code、redirect_uri | 官方请求由合成授权码触发并收到本地假响应；独立网关 v2 观察到真实 Google 401 → 200，最终兑换成功，未记录首次 401 的响应正文或确定其原因 |
| 刷新 | 同一 token 端点、HTTP/2 与 Go UA；表单字段为 refresh_token、client_id、client_secret、grant_type=refresh_token | 官方合成凭据请求已捕获；现有托管账号副本与 v2 新授权账号副本两批均各刷新一次获得 Google 200，身份保持、各自原账号不变；真实失败分支未主动诱发 |
| OAuth 用户资料 | GET `www.googleapis.com/oauth2/v2/userinfo`，无 `alt=json`；观察到 Go HTTP/2 与 HTTP/1.1 两路径 | 官方实际发包、合成资料响应；独立网关 v2 真实返回 200。与 Google Antigravity API 的 fetchUserInfo 是不同接口 |
| 首次 onboard | POST `/v1internal:onboardUser`；JSON 为 `{"tierId":"free-tier","metadata":{"ideType":"ANTIGRAVITY"}}`；使用 CLI 1.5.2 UA 与 HTTP/1.1，没有 Hub／Node 标记 | 以无既有 tier/project 的假 loadCodeAssist 触发官方 print 模式资格检查；请求已捕获，真实注册项目未执行 |
| onboard 操作轮询 | 首次假回包 `done:false` 后，官方 GET `/v1internal/operations/synthetic-onboard`，沿用同一 CLI 请求头 | 官方实际轮询已捕获；假完成回包的 response 含 protobuf Any 的 OnboardUserResponse `@type`，不代表真实 operation 状态已验证 |
| 已登录项目发现 | `loadCodeAssist` 返回 cloudaicompanionProject | 已有官方真实成功证据；独立网关 v2 真实返回 200，使用已有项目，未触发 onboard |

最初取证时的 `oauth-flow.js` `_onboard` 带有旧 `antigravity/hub/2.9.1` UA、`ide_version: 2.9.1` 和 Node 客户端标记。随后本次重构已按新增证据移除这些字段，接入官方授权 endpoint／scope／PKCE、token 与 userinfo 的独立原生 HTTP/2 传输、daily 项目发现、camelCase onboard 与 GET operation 轮询；看板本地回调及 state 绑定保留。实现与本地回归说明见[认证实现接入](official-auth-protocol-evidence.md#认证实现接入)；代码接入本身不是 Google 接受证据，实际接受结果以下述独立运行记录为准。

首次看板真实尝试因前端仍校验旧授权路径而显示空链接，用户发现后取消；[失败记录](../tests/fixtures/dashboard-oauth-real-20261107.json)保留。修复当前路径及脚本缓存版本并通过 [3 项 UI 回归](../tests/dashboard-auth-ui.test.js)后，[隔离看板控制器](dashboard-oauth-validation-controller.md)的 v2 获得 `passed=true`、`phase=completed`：目录 200／20 个模型，额度 200／2 个 groups／19 个 modelQuota，新账号副本一次刷新 200。临时凭据删除、网关停止、端口关闭、源码不变四项全为 true，没有请求模型生成或读取正式账号。

真实首次 onboard／operation 接受结果、非默认 tier 和未覆盖的异常分支仍没有实测结论。用户已确认目前没有未初始化的 Google 测试账号，首次初始化缺少测试前提；官方本地 mock 的 HTTP 200 和已有项目的新授权成功均不能替代这一项。

## 4. 模型目录中的媒体字段

本次官方 `fetchAvailableModels` 响应明确包含：

- `imageGenerationModelIds: ["gemini-3.1-flash-image"]`。
- Gemini 3.8 Flash Low：`supportsImages: true`、`supportsVideo: true`，`supportedMimeTypes["video/mp4"]: true`。
- Claude Sonnet 4.6：图片 MIME 在目录中；本次条目未声明 `video/mp4`，不能因为 Gemini 能读视频就把同样能力赋给 Claude。
- 模型条目还有 maxTokens、maxOutputTokens、思考配置、quotaInfo 等；用途列表与普通 agent 模型排序分别存在。

应保留 `supportsVideo`、`supportedMimeTypes` 和顶层 `imageGenerationModelIds`，供能力解析和图片模型选择使用。不能只保留 supportsImages/supportsThinking，也不能把 MIME 目录全部当成逐项实测通过。

二进制里仍能找到 `gemini-3-pro-image` 字面值；当前真实目录和网关成功调用使用 `gemini-3.1-flash-image`。仅有静态旧字符串不能覆盖已验证的服务端目录。

## 5. 官方图片输入：成功

合成图片为 64×64 的单色 PNG，186 字节。ACP 输入使用 image 内容块，`mimeType=image/png`，data 为 Base64；这种内容块属于 ACP 明确的图片输入形式。[ACP 内容格式](https://agentclientprotocol.com/protocol/v1/content)

实际 Google Antigravity API 请求结构为：

```text
request.contents[0].role = user
request.contents[0].parts[0].text = USER_REQUEST + ADDITIONAL_METADATA + USER_SETTINGS_CHANGE
request.contents[0].parts[1].inlineData.mimeType = image/png
request.contents[0].parts[1].inlineData.data = 原始 PNG 的 Base64
```

图片内容 SHA-256 与合成源文件完全一致。ADDITIONAL_METADATA 引用的是官方 CLI 真正保存的 `.user_uploaded/uploaded_media_<时间>.png` 文件。模型返回 `Red`，HTTP 200。

当前网关应保留相同的 inlineData 内容表达；若提供本地引用，必须引用网关真实保存的缓存文件，不能编造官方 CLI 路径。这个小 PNG 样本没有验证所有图片类型、尺寸或多图布局。

## 6. 视频：入口限制与模型能力分开

合成 MP4 为两秒、128×96，视频轨为 H.264，音轨为 AAC，画面先红后蓝；文件为 8999 字节。

### 官方 ACP 的二进制资源入口

使用 `resource.resource.blob` 和 `mimeType=video/mp4` 发送合成视频。官方 ACP 接受了请求，但实际生成体中没有 inlineData/fileData，视频内容被遗漏，模型返回 `VIDEO_NOT_AVAILABLE`。

这证明**此次 ACP 资源入口没有把视频传入模型**，不是上游拒绝 MP4 的证据。不能把这个 HTTP 200 当作视频理解通过，也不能据此删除网关的视频能力。

### 当前网关的原始视频输入

独立临时进程调用当前网关 provider，将完整 MP4 编为：

```json
{
  "inlineData": {
    "mimeType": "video/mp4",
    "data": "<完整原始 MP4 的 Base64>"
  }
}
```

实际发送到 `streamGenerateContent?alt=sse`，模型为 `gemini-3.8-flash-low`，HTTP 200，回答颜色先 red 后 blue。请求中的字节数与 SHA-256 和源 MP4 一致，证明传输没有抽帧或移除 AAC 音轨。

该样本验证原始 MP4 输入及画面顺序；没有独立证明模型对音轨内容的理解，也没有验证大视频、所有编码、远程 fileData 引用或完整多轮媒体范围。

## 7. 独立图片生成与编辑：网关真实验证

官方默认 CLI 本轮声明的工具不包含 `generate_image`。要求使用原生图片工具时，模型返回 `IMAGE_TOOL_UNAVAILABLE`。因此以下成功记录明确属于**当前网关真实调用**，没有包装成官方 CLI 生成证据。

生成与编辑均成功使用：

```text
POST https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent
model = gemini-3.1-flash-image
requestType = image_gen
userAgent = antigravity
request.generationConfig = { candidateCount: 1, imageConfig: { aspectRatio: "1:1" } }
```

外层仍为 project、requestId、request、model、userAgent、requestType。该成功图片请求的内层只有 contents 与 generationConfig，没有机械附加普通 agent 请求的 tools、labels 或 sessionId。

| 场景 | 输入 | 实际结果 |
| --- | --- | --- |
| 生成 | 白底中央红圆的简短文本 | HTTP 200，1024×1024 JPEG，392577 字节；中心平均 RGB 约 220/1/0 |
| 编辑 | 将红圆改为蓝圆；原生成 JPEG 作为 inlineData/image/jpeg 参考图 | HTTP 200，1024×1024 JPEG，420591 字节；中心平均 RGB 约 1/35/133 |

编辑请求中参考图的 SHA-256 与前一步生成文件完全相同。响应图片位于 `response.candidates[0].content.parts[].inlineData`，同一 part 含 thoughtSignature；同时有 usageMetadata、modelVersion、responseId。签名不写成可回放 fixture，也不由网关编造。

这些字段已有真实成功依据，应继续保留。比例 1:1 与单张参考图已验证，不扩写为全部比例、三张参考图、所有尺寸或任意编辑任务均已通过。

## 8. 本轮需要接入与继续补齐的事项

1. 保留目录里的视频、MIME 和图片模型用途字段，避免能力在模型目录解析中丢失。
2. 当前 inlineData 视频、生图和编辑格式已实测可用；不能因为 ACP 的视频入口限制而降级为抽帧。
3. 保持普通 agent、checkpoint、image_gen 各自结构，不能给所有请求无条件套用同一组内层字段。
4. 官方 OAuth、刷新及首次 onboard 的动态请求已通过本地全 mock 捕获；网关已有托管账号刷新和看板 v2 真实新增授权、兑换、保存、目录／额度、新账号副本刷新均已通过。首次项目初始化仍缺少未初始化测试账号，未观察到真实 onboard；旧 Hub 标记不得宣称属于 1.5.2 规范。
5. 网关 `/v1/files` 是本地文件持久化接口；本轮图片与视频直接内联，没有捕获到必须使用独立 Google 文件上传 RPC 的证据。大文件、远程引用与过期行为仍属于待验证范围。
6. 取消、断流、错误 MIME、失效媒体、其他平台及全部媒体类型不能由本轮成功样本替代验收。

正式网关服务、账号池和用户全局设置未被这次取证修改。网关媒体验证只在内存读取已有官方登录态，并把缓存与会话写入取证目录内的独立配置目录；没有导入账号。代理证书只影响对应探测进程，完整证据在落盘前脱敏。
