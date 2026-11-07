# 临时网关 HTTP 媒体闭环验收

本项使用独立临时网关，检查 HTTP 前端 → 原生 Go TLS → 真实 Google 的媒体链路。对应[产品规格 A26/A27](antigravity-gateway-refactor-spec.md)，与此前直接调用 provider 的成功记录分开归档。

2026-11-07 02:11（UTC+8）第一轮执行六个代表场景，五项通过，图片编辑遇到真实上游 429。02:15 在真实冷却结束后仅补一次编辑，成功。**六个代表场景现均有真实 HTTP 成功证据**；首次 429 原样保留，没有重跑前五项，也没有用旧 provider 成功记录替代。

上述成功对应当时的独立媒体 HTTP 场景和源码快照。原生 `generate_image` 三步闭环随后另行验收：早期空图及硬额度 429 均保留为失败记录，05:10 的风景图场景已取得三次真实 200、图片文件及回执续答；各批范围如下。

第一轮固定源码/native 摘要为 `a2130573e4378eca57dd9647a6aa9a85ffcb1a3dba33e16822187f720bf7acd0`（53 个文件），编辑补验摘要为 `f5352b06bf541043bb384e69efb76b1d831e6d47ec772faa45e6c3d5a69e5e57`。分别在各自运行前后保持相同；两批摘要不同，不合并声称来自同一工作区版本。两轮正式账号目录、`state/account-pool.json` 和 `state/quota.json` 的前后摘要也全部相同。

## 实际结果

第一轮证据位于 [gateway-media-20261107](../tests/fixtures/gateway-media-20261107)，每个场景包含脱敏 HTTP、原生请求/响应、媒体哈希及验收结果；状态见[第一轮摘要](../tests/fixtures/gateway-media-20261107/summary.json)。单编辑补验单独保存在 [gateway-media-edit-20261107](../tests/fixtures/gateway-media-edit-20261107)，见[补验摘要](../tests/fixtures/gateway-media-edit-20261107/summary.json)。

| 场景 | 实际结果 |
| --- | --- |
| Messages 原始视频 | 网关/上游均 200，一次生成，原始 MP4 哈希一致，回答 `Red, blue` |
| Responses 原始视频 | 网关/上游均 200，一次生成，原始 MP4 哈希一致，回答 `Red, Blue` |
| Messages 内联图片 | 网关/上游均 200，一次生成，PNG 哈希一致，回答 `Red` |
| Files 上传后 Responses 图片引用 | 上传、文件内容下载、推理均 200；下载及上游 PNG 哈希一致，回答 `Red` |
| 图片生成与保存 | 网关/上游均 200，一次生成；1024×1024 JPEG，205204 字节，HTTP 下载、网关磁盘及上游响应哈希一致，中心 RGB 为 208/19/50 |
| 图片编辑第一轮 | 参考图哈希与上一张生成图相同，已到达真实上游；上游返回 `429 RESOURCE_EXHAUSTED / RATE_LIMIT_EXCEEDED`，客户端取消，此轮无编辑输出 |
| 图片编辑单独补验 | 网关/上游均 200，仅一次生成；参考图为第一轮生成的原 JPEG；输出 1024×1024 JPEG、116101 字节，HTTP 下载/网关磁盘/上游响应哈希相同，中心 RGB 为 1/57/155 |

[实际生成图片](../tests/fixtures/gateway-media-20261107/image-generation.jpg)的 SHA-256 为 `9cd80739f24dad269ea06adc91fda6fb4cd4cf4e5ca6ac0a5cbca63a5a7b448f`。

编辑 429 返回 `quotaResetDelay=3.335485178s`。网关正常调度在脚本检测并取消前已启动第二次内部 attempt；记录中因此有两个原生请求、一个 429 响应和一个取消错误。脚本没有重跑编辑场景、等待后重试或修改额度/冷却。不能将这次取消描述成网关已经向客户端返回 429，也不能把较早 provider 编辑成功当成本次 HTTP 编辑成功。

随后单编辑补验使用独立命令与独立目录：实际时钟 `2026-11-06T18:15:08.114Z`，此前 `quotaResetTimeStamp=2026-11-06T18:11:46Z`，已超过 202.114 秒；也核对了原响应 Date 加 RetryDelay，没有修改时钟或状态。[冷却核验记录](../tests/fixtures/gateway-media-edit-20261107/retry-eligibility.json)同时保存原失败证据哈希。原始失败 JSON 保持逐字节不变。

[实际编辑图片](../tests/fixtures/gateway-media-edit-20261107/image-edit.jpg)的 SHA-256 为 `aca134c12c61fefe8b9258293388fd4a32f103c1dee9da0260d0af22cb183804`。补验沿用正常账号/额度/健康复制和调度，未禁用保护，未再生成参考图。此次一次性编辑成功后停止。

两轮临时前台网关均已退出，含私密账号副本的目录已删除；临时内存冷却不再存活。正式状态一直保持原样。

## A27：原生生图工具的分批实测与硬额度修复

2026-11-07 04:47（UTC+8），另以隔离 Messages 请求验证原生工具链路，证据保存在 [gateway-internal-image-native-20261107](../tests/fixtures/gateway-internal-image-native-20261107/README.md)。本轮 57 个运行时文件摘要为 `6ff6487b7558aba133f0d8fac0ca50e062b91b0d4f1b357f29b60ae2a20bfc92`，与上述独立生图／编辑成功批次不同。

| 原生步骤 | 实际结果 |
| --- | --- |
| 1：模型发起工具调用 | `gemini-3.8-flash-low` 返回 200，实际调用官方名称 `generate_image`，带真实上游思考签名；工具声明与官方 agy 1.5.2 样本逐字段一致 |
| 2：图片服务请求 | 同账号、同 trajectory，步骤序号从 1 到 2；`gemini-3.1-flash-image` 返回 `429 RESOURCE_EXHAUSTED`，Google `ErrorInfo.reason=QUOTA_EXHAUSTED`，没有图片输出 |
| 3：图片结果回执与模型续答 | 未发生；不能将步骤 1／2 的关联正确写成完整三步成功 |

上游明确返回 `quotaResetTimeStamp=2026-11-06T23:11:30Z`，当时 `quotaResetDelay=2h24m1.467006737s`，并有对应 `RetryInfo.retryDelay`。真实生成状态只有 **[200, 429]**。原验收保护器拒绝了 provider 随后的同账号重试尝试，客户端最终 500 来自保护器，不是实际 Google 500；[补充核对](../tests/fixtures/gateway-internal-image-native-20261107/assessment-review.json)与原始失败 JSON 分开保存。正式账号／pool／quota 与运行时摘要前后不变，临时凭据已删除、网关已停止。当时只读核对 4 个正式托管账号均启用，其中 3 个已有认证异常、1 个健康；没有解除保护或追加生图请求。

后续最小修复只调整 `Direct.generateImage`：真实 429 中存在 Google `ErrorInfo.reason=QUOTA_EXHAUSTED`，并带有效重置时间或正数重置／重试延迟时，立即结束该账号的 provider 尝试，以原 429 和完整脱敏 reset 诊断交给现有 Pool。Pool 继续按当前图片模型冷却、异步补查额度，并选择其他合资格账号；无可用后备时返回原错误。同账号不再换 host 或重试，避免后续网络错误覆盖明确的额度原因。普通临时 429、缺少有效 reset 的响应及 5xx 保持原有有限重试策略。

[新增硬额度测试](../tests/image-hard-quota.test.js)4 项通过；与[图片模型路由测试](../tests/image-model-routing.test.js)、[原生轨迹测试](../tests/native-image-trajectory.test.js)合计 **9/9**。全部是合成传输，其中硬额度体回放本次真实脱敏 429；验证同账号仅 1 次调用、完整 reset 保留、正确图片模型冷却、不误封账号、内部图片调用不改变主会话粘性，以及其他合资格账号仍可接续。这组回归本身没有真实发包，不能把 04:47 的失败改写成成功；随后真实请求另批归档，旧独立生图和编辑证据仍仅属于各自快照。

### 账号恢复与后续空图：时间线纠正

03:49 的[早期空图场景](../tests/fixtures/gateway-internal-image-20261107/README.md)和 04:47 的硬额度场景均早于用户重新认证。3 个账号在 **04:56:32—04:56:45** 保存新凭据，正式池于 **04:56:48** 清空原健康隔离；随后只读核对为 4 个启用、4 个健康、0 个认证异常。旧版与当前工作区都在 OAuth 保存后立即 reload，并通过新凭据指纹清除旧异常。后续曾继续使用“只有 1 个健康账号”的说法，是主代理将当时文件 hash 与新基线一致误当成旧健康结论仍有效；这是核对和归因错误，不是重新认证未恢复，也不是用户未操作。

05:08 的[重新认证后蓝圆场景](../tests/fixtures/gateway-internal-image-reauth-20261107/README.md)实际为 **[200, 200]，没有 429**：第一步返回官方 `generate_image` 和真实签名；第二步图片响应 `content:{}`，`finishMessage` 表示无法显示生成图片、不会计费并建议改写提示，没有第三步续答。这是独立的真实空图失败，不能继续归因于此前认证隔离或额度 429。与官方及旧成功样本逐字段对比，除 prompt、项目及 requestId 等变量外，生成体相同；不存在“少传 responseModalities／imageSize”的证据。该批与下述风景图批次的运行时摘要均为 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`，原始失败记录保持不变。

### 风景图：真实三步闭环通过

05:10 使用独立合成风景提示，发起一个 Messages HTTP 请求，实际生成序列为 **agent → image_gen → agent，三次均 200**。前后两步固定 `gemini-3.8-flash-low`，图片模型为 `gemini-3.1-flash-image`，请求比例 16:9；同账号、同 trajectory 的步骤 1／2／3、原工具调用及真实签名、图片回执和最终描述均保留。证据见[风景图验收说明](../tests/fixtures/gateway-internal-image-landscape-20261107/README.md)。

实际产物 [internal-image.jpg](../tests/fixtures/gateway-internal-image-landscape-20261107/internal-image.jpg)为 **1376×768 JPEG，965271 字节**，SHA-256 为 `62551af9562ba44258102841b4e78178f00b9c26680258a531b17d04d6b853fc`。HTTP 文件回读、网关磁盘及上游图片字节哈希一致，图片可解码；网关 HTTP 200 且最终回答正常完成。57 个运行时文件摘要及正式账号／pool／quota 前后相同，临时凭据已删除，临时网关已退出。

原报告只有 `originalToolCallRetained` 被误判为 false：验收器使用 `JSON.stringify` 比较对象，工具调用的键顺序变化触发误报，ID、名称、参数值并未改变。修正为 `isDeepStrictEqual` 后，仅对已有证据[离线重判](../tests/fixtures/gateway-internal-image-landscape-20261107/assessment-review.json)，19 项全部通过，**新增真实请求数为 0**；原 `internal-image.json` 和 `summary.json` 未覆盖。新增[键顺序正例与篡改反例](../tests/internal-image-evidence-assessment.test.js)2 项，加原轨迹测试合计 **3/3**。风景图是另一个实际提示／比例场景；其通过既不是靠重发同一请求取得绿灯，也不证明之前空图已成功或任意提示均可出图。

## 场景与证据要求

| 场景 | HTTP 入口与输入 | 必须同时满足 |
| --- | --- | --- |
| 视频一 | Messages，Base64 MP4 内容块 | 上游原始字节/MIME 一致、原生传输成功、回答红色随后蓝色 |
| 视频二 | Responses，`input_video` Data URL | 同上 |
| 图片一 | Messages，Base64 PNG 内容块 | 上游字节/MIME 一致、回答红色 |
| 图片二 | `/v1/files` 上传 PNG，再以 Responses `input_image.file_id` 引用 | 上传及 HTTP 下载字节相同、真实上游输入相同、回答红色 |
| 生图 | `/v1/images/generations`，白底红圆，单张 | 显式图片模型不变、真实 `image_gen` 成功、结果 HTTP 下载/落盘/上游图片哈希相同、文件可解码且中心为红色 |
| 编辑 | `/v1/images/edits`，上一张生成图改蓝圆 | 参考图字节与上一张生成图一致、真实生成成功、结果三处哈希相同且中心为蓝色 |

理解模型固定 `gemini-3.8-flash-low`；生图和编辑固定真实目录中的 `gemini-3.1-flash-image`。只做上述代表样本，不凭它们声称全部 MIME、大小、比例、模型或多轮场景均已覆盖。

## 合成输入

仓库 [gateway-media-inputs](../tests/fixtures/gateway-media-inputs) 复用此前已生成的合成素材，没有用户私有媒体：

- PNG：64×64、红色、186 字节，SHA-256 `1951c0eba94f38034442b3e0cdbcecd1f033c5d73265616cf2dfef49f8663da7`。
- MP4：2 秒、128×96、画面先红后蓝、H.264 视频加 AAC 单声道 16 kHz 音轨、8999 字节，SHA-256 `17ce432bfbce3c7ac17881b97156ee227082375d338ad3d57811a1ca06b5bed4`。

完整 MP4 哈希一致证明上传没有抽帧、去掉音轨或重新编码。颜色顺序回答验证画面理解；不把这一结果解释为已独立验证音轨语义理解。

## 隔离和取证

[verify-gateway-media.js](../scripts/verify-gateway-media.js) 只向临时 `CONFIG_DIR` 复制既有 agy 管理账号和完整账号池/额度状态。私密目录为 0700，副本为 0600；保留禁用、健康、删除标记、粘性及额度保护，不清除冷却、不修改正式账号、不导入本机登录态。临时网关使用单独端口，正式配置目录被 Seatbelt 禁止读取，写入仅限临时目录；不改写 `HOME`，不启停正式服务。结束后删除包含凭据的临时目录。

观察器包装真实 `AgyNativeTransport.fetch` 并调用原实现，模型请求继续由实际 Go 子进程执行，不用 Node fetch 替换上游传输。观察器在落盘前隐藏凭据和账号元数据；媒体正文仅保存 MIME、字节数和 SHA-256，签名仅保存哈希。合成生成图片本身可留作证据。

首个上游 429 会取消当前 HTTP 请求，后续相同模型场景跳过并保留缺证状态，不修改账号状态强行继续。源码与 native 目录、正式账号及保护状态均做前后哈希对比；变化会使验收失败，不能把运行中变更的源码描述为同一个验证版本。

## 复跑和本地校验

仅准备素材和源码摘要，不读账号、不发上游：

```bash
node scripts/verify-gateway-media.js --out /独立证据目录
```

真实执行：

```bash
node scripts/verify-gateway-media.js --run \
  --source-config /已有网关配置目录 \
  --out /独立证据目录
```

依赖 macOS `sandbox-exec`、`ffprobe`、`ffmpeg`。可通过 `--ffprobe`、`--ffmpeg` 指定路径；`--scenarios` 可缩小代表场景。单个请求默认 180 秒。

脚本还支持仅编辑已有合成图片，无须重新执行前五项。以下是不发请求的准备命令；加入 `--run` 才会真实执行。真实执行拒绝覆盖已有 `summary.json`：

```bash
node scripts/verify-gateway-media.js \
  --scenarios image-edit \
  --edit-reference tests/fixtures/gateway-media-20261107/image-generation.jpg \
  --out /新的编辑证据目录
```

[gateway-media-verifier.test.js](../tests/gateway-media-verifier.test.js) 验证了两种实际 normalizer 保留视频字节、文件 ID 引用、脱敏摘要、Go 传输未被替换，以及验收器不会仅凭 URL、HTTP 200、伪造工具文本或错误媒体哈希判定通过。归档测试逐份重算首轮五项成功、原始 429、单编辑成功，核对生成/编辑图片文件与上游摘要，并验证冷却核验对应原失败记录。

## A26：两种协议的视频多轮真实验收

2026-11-07 03:02（UTC+8），新增两项独立真实场景，使用同一合成 8999 字节 MP4、固定 `gemini-3.8-flash-low`，每种协议两轮，合计 **4 次生成，全部 HTTP 200**。本轮不重新执行以上六个媒体场景，旧证据保持不变。

| 协议 | 第一轮 | 第二轮请求 | 第二轮实际回答 |
|---|---|---|---|
| Messages | 提交原始 MP4，回答 `Red, Blue` | 重放第一轮用户内容和真实 assistant 回答，仅新增文字追问最后颜色 | `Blue` |
| Responses | 提交原始 MP4，回答 `Red, blue` | 使用第一轮真实 `previous_response_id`，新 `input` 只有文字追问 | `Blue` |

第二轮没有重新上传文件或新增媒体块。逐项比对真实上游请求确认：两轮 MP4 的 MIME、8999 字节长度及 SHA-256 相同；第二轮保留首轮完整 `contents` 前缀、首轮真实上游可见回答及其实际 `thoughtSignature`；`cascade_id` 与 `trajectory_id` 相同，`last_step_index` 增长。两轮客户端响应都正常完成，不以截断文本判断成功。签名仅保存哈希，未写入原值。

证据单独保存在 [gateway-video-multiturn-20261107](../tests/fixtures/gateway-video-multiturn-20261107)，包含[摘要](../tests/fixtures/gateway-video-multiturn-20261107/summary.json)、[Messages 两轮记录](../tests/fixtures/gateway-video-multiturn-20261107/video-multiturn-messages.json)和[Responses 两轮记录](../tests/fixtures/gateway-video-multiturn-20261107/video-multiturn-responses.json)。本轮 53 个源码/native 文件摘要前后均为 `108427f424acf78aa8e59ba93a0be9cbbfd100237bf50fc0d68f9155e8a1f4cc`，与较早媒体批次是不同快照。正式 6 个账号文件、`state/account-pool.json` 和 `state/quota.json` 摘要分别前后一致；私有前台网关已退出，包含账号副本的临时目录已删除。

本次保留正常账号池额度保护和健康状态，继续调用真实原生 Go 传输。观察层额外限制最多 4 次生成；若任何一次真实返回 429，则停止下一次生成并保留缺证结果，不切换模型继续尝试。本轮未触发 429，也未使用额外重试。

以下命令仅准备素材和摘要；加 `--run` 才会读取正式托管账号的只读副本并发起真实请求。证据目录必须是新的目录：

```bash
node scripts/verify-gateway-media.js \
  --scenarios video-multiturn-messages,video-multiturn-responses \
  --generation-budget 4 \
  --out /新的多轮证据目录
```

归档测试重新计算两项记录中的全部判据，并校验四次原生状态、原始 MP4 哈希、正式状态不变与清理结果。这补齐了 A26 的真实视频多轮语义样本；其他视频格式、长视频、独立音轨语义及媒体断流恢复不由这两个样本推断。

## A26：HTTP 多模态边界验收（本地假上游）

新增 [media-boundary-acceptance.test.js](../tests/media-boundary-acceptance.test.js)，2026-11-07 本地 **13/13** 通过；与 `multimedia.test.js`、`media-input-compatibility.test.js`、`gateway-media-verifier.test.js` 合跑 **37/37** 通过。此组经真实 HTTP 网关、临时账号池、媒体存储、协议转换、Direct provider 和会话投影，最终传输被替换为仅允许 loopback 的合成 Google HTTP 服务。它不请求真实 Google、不读取正式账号、不证明模型理解或 Go TLS 行为，独立于上文六项真实媒体结果。

| 边界 | 已验证结果 |
|---|---|
| Messages / Responses 混合媒体 | `文本→PNG→文本→MP4→文本→PNG` 的顺序一致；发往假上游的 MIME、完整 Base64、解码字节与上述真实 PNG/MP4 fixture 完全相同。 |
| 单文件及总量限制 | 本次以单文件 **10,000 字节**、每请求总量 **15,000 字节** 缩小阈值。两接口单文件 10,001 字节返回 `413 media_too_large`；两个各 8,999 字节 MP4 返回 `413 media_total_too_large`，均零上游请求。Files 超限上传不落盘；恰好 10,000 字节单文件、合计恰好 15,000 字节均可原样转发。 |
| Files 生命周期与作用域 | 原作用域上传、读取、模型引用成功；跨作用域 metadata/delete 返回 `404 file_not_found`，模型引用返回 `404 media_file_not_found`。删除后两种接口继续引用、重复删除、底层文件丢失均清晰失败，零上游请求。 |
| 内容下载权限 | 普通上传的 `GET/HEAD /v1/files/:id/content` 在未鉴权时返回 401，跨作用域返回 404，原作用域返回 200；HEAD 不返回正文。`purpose=generated` 的图片仍允许匿名 GET/HEAD，保留公开产物链接。 |
| 视频多轮 | Messages 重放历史、Responses `previous_response_id` 续聊均保留首轮原视频完整字节和顺序，并恢复同一会话实际保存的**合成**回答签名。Responses 拒绝跨作用域 response ID；总量限制统计历史媒体；历史所引用文件删除后返回 404，不偷偷丢掉视频继续请求。 |
| 错误 MIME | 将 PNG 字节明确声明为 `image/jpeg`，两接口都保持声明与原字节发往假上游，假上游返回的 `400 direct_upstream_error` 及错误原因对客户端可见。当前网关不按魔数探测或自动修正 MIME；本测试不声称真实 Google 对所有 MIME 错配都返回相同错误。 |
| 畸形 Data URL | `input_image.image_url` 的畸形 Data URL 本地返回 `400 invalid_media_url`；`input_file.file_data` 返回 `400 invalid_media`，均零上游，不部分解码或重编码。 |

这一轮发现并修复了旧内容下载路由无条件 `allowPublic` 的问题：旧版本连普通上传也绕过鉴权和作用域；现在只有生成产物继续公开。原 `credentialScope` 的存储约定保持不变，测试使用能通过同一假 API key 鉴权、但作用域输入不同的 Bearer 与 `x-api-key` 来覆盖隔离。真实媒体验收脚本的 Files 回读本就经统一 `request()` 携带同一 Bearer 凭据，无需修改；历史成功 fixture 保持原快照，不回写成新权限实现的验证记录。

```bash
node --test tests/media-boundary-acceptance.test.js \
  tests/multimedia.test.js tests/media-input-compatibility.test.js \
  tests/gateway-media-verifier.test.js
```

这些小阈值测试验证容量守卫的边界和零上游行为，不代替默认 96 MiB 单文件 / 192 MiB 总量下的内存压力测试。本节假上游结果不证明真实语义；两种协议的真实 Google 视频多轮样本见上一节。独立音轨理解、媒体断流恢复及其他格式的真实语义仍未由这些验收覆盖。
