# 公开模型名称与上游配置

基线：官方 agy 1.5.2 的实际请求和目录记录。实现见 [antigravity-model-config.js](../src/antigravity-model-config.js)、[image-model-config.js](../src/image-model-config.js)。本文列出已确认的配置，不表示所有账号在任意时刻都有权限或余额。

## 已捕获的推理配置

| 公开名称 | 请求体 model | 固定思考配置 | 已捕获输出上限 |
| --- | --- | --- | ---: |
| `gemini-3.8-flash-low` | 同公开名称 | `includeThoughts:true, thinkingLevel:LOW` | 65536 |
| `gemini-3.8-flash-medium` | 同公开名称 | `includeThoughts:true, thinkingLevel:MEDIUM` | 65536 |
| `gemini-3.8-flash-high` | 同公开名称 | `includeThoughts:true, thinkingLevel:HIGH` | 65536 |
| `claude-sonnet-4-6` | 同公开名称 | `includeThoughts:true, thinkingBudget:1024` | 64000 |
| `claude-opus-4-6-thinking` | 同公开名称 | `includeThoughts:true, thinkingBudget:1024` | 64000 |
| `gpt-oss-120b-medium` | 同公开名称 | `includeThoughts:true, thinkingBudget:8192` | 32768 |

证据为 [六模型请求 fixture](../tests/fixtures/agy-1.5.2-wire.json) 及[官方请求目录](antigravity-api-1.5.2-request-catalog.md)。目录中的内部模型枚举和实际生成请求中的 model 字符串分别保存，不将内部枚举擅自填入请求体。

公开名称决定固定思考配置。`thinking`、`reasoning_effort`、`reasoning.effort` 等客户端字段与名称冲突时忽略，不告警、不报错、不改变模型。客户端是否希望显示思考与上游实际思考档位分别处理。

输出上限不属于应忽略的客户端思考字段。客户端提供 `max_tokens` 或 `max_output_tokens` 时保留其正常含义，不为了容纳思考擅自扩大；没有提供时采用实际目录和已捕获配置。目录可以更新输出限制和能力信息，但不能悄悄改变上述名称的固定档位。

已有无 low/medium/high 后缀的 Claude 名称保留确定配置，不根据后缀猜测其新档位。未捕获名称只有在真实目录提供相应配置时才能使用该目录配置；不凭 `-high`、`-max` 字面值虚构能力。

当前对 `claude-sonnet-4-6` 和 `claude-opus-4-6-thinking` 的固定思考加强制工具 `ANY` 组合实施本地保护，返回 `model_capability_conflict`；两者均有受控回归验证不会关闭思考或改变工具选择。自动工具选择不受这一限制，该错误也不等于“客户端发来冲突思考字段”。

**Sonnet 的真实上游冲突证据**保留于旧取证目录 `antigravity-152-evidence-20261106.e1s7__26/gateway/ae5b3889-c37f-462e-9bc4-69a2199412bd.response.json`：配对请求的 model 为 `claude-sonnet-4-6`，返回 HTTP 400，错误为 `Thinking may not be enabled when tool_choice forces tool use.`。原始目录及历史背景见 [1.5.2 验收记录](agy-1.5.2-acceptance.md)，当前保护行为见 [模型配置回归](../tests/antigravity-model-config.test.js)。

**Opus 的独立真实能力诊断**于 2026-11-07 完成：[原始脱敏报告](../tests/fixtures/opus-forced-tool-20261107/real-result.json)记录唯一一次 `claude-opus-4-6-thinking` 生成请求返回同一明确 HTTP 400。诊断通过原账号池的实时目录、健康与额度资格检查，使用原生 Go 传输；先由生产 builder 构建固定 `thinkingBudget:1024`、`maxOutputTokens:2048` 和真实受约束 `read_file` 声明的 AUTO 基础包，再仅增加 `request.toolConfig`，指定 `ANY` 与 `allowedFunctionNames:["read_file"]`。这是直接上游能力诊断，不能写成标准 Messages／Responses HTTP 入口发起的成功调用；生产入口的本地保护未修改，也没有关闭思考、重试、换账号／模型、执行工具或发送续接请求。源码快照为 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`，正式账号及额度／健康状态前后不变，临时凭据与受控进程已清理。详细边界见[诊断说明](../tests/fixtures/opus-forced-tool-20261107/README.md)。两种 Claude 模型的该项保护现均有真实上游拒绝依据，但不据此推断其他模型或其他组合的能力。

## 图片模型

| 入口名称 | 实际 model | 用途 |
| --- | --- | --- |
| `gemini-3.1-flash-image` | `gemini-3.1-flash-image` | 已验证的 `requestType:image_gen`，生成与参考图编辑 |
| `gpt-image-1` | `gemini-3.1-flash-image` | 原图片接口的明确历史别名，仍使用 Google Antigravity API |
| 未填写 model | `ANTIGRAVITY_IMAGE_MODEL` 指定值；未设置时为上项实际模型 | 保留原默认模型配置机制 |
| 其他名称 | 原名称 | 必须来自实际 `imageGenerationModelIds`，不能按名称猜测或随意替换 |

HTTP 入口、账号模型支持检查、额度和冷却、实际发包及用量记录使用同一解析结果。历史别名始终指向其明确目标，不随默认图片模型环境变量漂移。未知图片模型返回 `unsupported_image_model`，不会静默换成默认模型。

`GET /v1/models` 的 `image_generation_model_ids` 单独公布图片生成目录，普通推理模型列表与图片用途列表保持区分。

图片能力证据分开记录：[独立 Images HTTP 生图／编辑](gateway-media-integration.md)已有各自旧源码快照的真实成功结果；04:47 的[原生 `generate_image` 场景](../tests/fixtures/gateway-internal-image-native-20261107/README.md)实际为 [200,429]，虽有官方声明、签名及步骤 1／2，第 3 步未发生。3 个账号于 04:56 重新认证并恢复健康；05:08 的[独立蓝圆场景](../tests/fixtures/gateway-internal-image-reauth-20261107/README.md)为 [200,200] 空图，不再是此前认证或额度错误。旧失败全部保留。

针对该硬额度响应，`Direct.generateImage` 现立即将原 429 和完整 reset 信息交给既有 Pool 模型冷却／其他合资格账号规则，不再同账号换 host 或重试；临时 429 和 5xx 保持原策略。[新增 4 项测试](../tests/image-hard-quota.test.js)及相关 **9/9** 回归全部采用合成传输，这组回归本身不新增真实图片请求。目录存在模型、旧成功样本或本地回归通过，均不能证明当前账号此刻有可用图片额度。

05:10 的[风景图实测](../tests/fixtures/gateway-internal-image-landscape-20261107/README.md)已通过完整 Messages HTTP → 原生 Go → 真实 Google 的三步闭环：`gemini-3.8-flash-low → gemini-3.1-flash-image → gemini-3.8-flash-low` 三次均 200，同账号／同 trajectory 的步骤 1／2／3、真实工具调用／签名、图片回执及最终回答保持一致。比例请求 16:9，实际输出 1376×768 JPEG、965271 字节，文件回读／磁盘／上游哈希相同。运行时摘要为 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`。原验收器仅因 JSON 对象键顺序误判工具历史；修正比较后对原证据离线重判通过，没有额外真实发包，原报告保留。新 2 项验收器回归加原轨迹回归 **3/3**，不扩大为全部比例、提示或模型的成功保证。

## 能力与账号

图片、视频、音频能力来自真实目录与实测。`supportsImages`、`supportsVideo`、`supportsAudio` 的明确布尔值优先；缺省不等于明确 false，可结合 `supportedMimeTypes` 判断。Codex 格式的 `input_modalities` 仅使用其 text/image 枚举，视频和音频信息保存在独立字段。

具体账号仍按原有模型权限、启停、健康、粘性、额度保护和冷却条件选择。目录有模型不代表一次生成必然成功；真实限流和额度错误仍执行原有账号池规则。

回归覆盖见 [固定档位测试](../tests/antigravity-model-config.test.js)、[图片模型路由测试](../tests/image-model-routing.test.js)、[对外模型目录测试](../tests/model-catalog-capabilities.test.js)。这些测试不能替代尚未实测的未来模型能力。
