# Google Gemini API 接入取证与实施记录

日期：2026-11-16。需求基线：[双上游项目改造说明](gemini-app-upstream-spec.md)。

发布前原 Antigravity 回归和升级演练的最新结论见 [2.1.0 候选版验收](release-2.1.0-preflight.md)。部分完整客户端请求仍有真实 Google 429；目前未发布，历史 Gemini 成功记录不覆盖这些失败。

最新范围：用户已明确只接入 Gemini app **Task 任务模式**。产品目录以 Task host=2 为依据，仅发布已验证的 Hydrogen/Argon Low 与默认别名；普通文本和 Auto 审核也走任务接口。下文 Chat High/Medium 的历史记录不再属于交付范围。旧样本中的审核曾走 Chat，不能当作本次 Task 审核的验收证据；修改后安装包的真实 Task 审核结果见 9.20。

状态：双上游接入基线安装包已通过五个本机客户端分别连接本地与 Linux 隔离网关的正常配置核心验收，具体见 9.21、9.22。Claude Auto、Pi、Codex、Hermes、dsh 均保留完整原环境，完成真实工具操作与最终响应；该基线全量代码回归 1176/1176 通过。后续 Auto 路由清理及新安装包验证见 9.26，不将此前五客户端矩阵的源码摘要混作新包。测试中修复了可选模型变体 ID 缺失的误判，以及待回传工具与下一步确认卡片交错的处理。本轮另经真实看板逐一重新授权 Chrome 的十个账号，十个均完成初始化核验、目录、额度和实际 Task 生成；本轮全部为已初始化账号，不冒充新的首次条款样本。多模态按用户要求暂缓，耗时优化后置。没有正式发布、部署或版本号变更，五客户端矩阵结束后接入配置已恢复；正式本机与服务器服务保持运行。

## 1. 取证对象与隔离

- 本机 Gemini app：`1.144.4.1467`。
- 原应用二进制 SHA-256：`3ea9e90a442982c36273d098d89b6f5c50d9a2c980de243fc1f5df5f8329b040`。
- 原应用本体未修改。取证副本使用独立 bundle、数据目录和钥匙串命名空间；未批准其读取原应用的钥匙串条目。
- 测试账号经用户已授权的 Google 登录流程取得新的授权。未导入旧 Robin/Windows Gemini 账号文件，未加入正式账号池。
- 原始响应、授权和完整日志保存在仓库外受限取证目录；本文件不包含凭据、邮箱或会话标识。

已从当前二进制生成的 Objective-C protobuf 描述符提取 2,651 个消息定义，并取得 Swift 字段反射信息。枚举按描述符的名称索引完整枚举，未再使用固定 0–511 数值范围。它们属于静态结构证据，不能代替原生实际发包。

## 2. 首次初始化的真实阻断与修正

同一测试账号出现如下区别：

| 请求条件 | 实际结果 |
| --- | --- |
| `GetUserStatus` 未声明 Mac 客户端类型 | `onboardingStatus=1`，可用 |
| 请求元数据声明 `clientType=21` | `onboardingStatus=7`，待接受条款 |
| 原生 app 登录该账号 | 显示首次引导；原生日志要求接受条款版本 9 |
| 初始化前直接 `ProcessQuery` | HTTP 200，但 gRPC 9，明确要求先接受条款 |

这证明“登录成功”和“默认状态查询可用”均不足以证明当前客户端协议已完成首次初始化。HTTP 200 也不能作为推理成功依据。

通过直接接口执行 `GetTermsOfServiceVersion → AcceptTermsOfService → GetUserStatus`，该账号从状态 7 变为 1。没有点击 Mac app 的“使用 Gemini”按钮代为提交确认。

本次样本证明的是该 Google 账号首次接受当前 Mac 客户端的必要条款；不声称它是刚注册的 Google 账号，也尚未证明它是免费订阅账号。

### 2.1 接受条款会改变活动偏好

`ReadUserPreferences` 的真实前后对照：

| 时点 | `userPreferences.bardActivityEnabled` |
| --- | --- |
| 接受条款前 | 明确返回 false |
| 接受条款后 | 明确返回 true |
| 精确更新该偏好并读回 | 明确返回 false |
| 真实令牌刷新后 | 明确返回 false |
| 关闭 app 后再次生成、再次读回 | 明确返回 false |

偏好更新使用 `UpdateUserPreferences`，只设置字段 5 为 false，field mask 为 `bard_activity_enabled`。对照中其余已返回偏好未改变。

首次探针在接受条款后、发现偏好被重置之前，已经提交过一次仅包含测试标识的生成请求。该次不能算作“不参加改进计划后才推理”的合格流程，失败顺序证据予以保留。发现后立即关闭并读回确认，后续生成均在已验证关闭的状态下执行。

正式实现已将顺序调整为：查询状态 → 必要条款确认 → 查询并关闭活动记录 → 再次读回验证 → 核对初始化状态 → 后续目录/额度/推理验证。不能只在接受条款前检查一次偏好。

原生引导还单独提供“自动发送使用情况统计信息和崩溃报告”选项，默认勾选。取证副本中已取消勾选并完成引导提交；这是隔离 app 的界面取证，不代替最终看板的纯接口初始化验收。任务模式另有首次介绍，是否对应独立服务端初始化仍需核实。网关不会因模仿请求而复制可选遥测上传；新增初始化模块只报告 `activityOptOutVerified`，没有把它扩大成所有可选改进项目均已验收。

## 3. 已直接调用的接口

服务原点为 `https://robinfrontend-pa.googleapis.com`。已从 1.144.4.1467 取证副本的实际 TLS 明文捕获主业务 RPC：路径为 `/assistant.mobile.robin.RobinService/<method>`，工具通道为 `/assistant.mobile.robin.notify.GeminiNotifyService/ExecuteRemoteTools`，均使用 HTTP/2 + gRPC protobuf。历史探针的 `/$rpc/` 别名虽被接受，但不是本次捕获的原生路径；新传输模块已按实际路径修正。协议中的服务名称不表示恢复旧网关 Robin 账号通道。

| RPC | 本次直接结果 | 范围 |
| --- | --- | --- |
| `GetUserStatus` | 成功 | 初始化状态、模型和策略目录 |
| `GetTermsOfServiceVersion` | Mac 元数据下成功，未声明客户端来源时失败 | 条款版本及客户端前置条件 |
| `AcceptTermsOfService` | 成功 | 单个真实待初始化账号，版本 9 |
| `ReadUserPreferences` | 成功 | 活动记录等偏好实际读回 |
| `UpdateUserPreferences` | 成功 | 仅关闭活动记录，field mask 限定范围 |
| `GetUsageInfo` | 成功 | 返回 5 小时与每周额度窗口；完整配额调度尚未实现 |
| `ProcessQuery` | 成功 | Hydrogen/Argon 普通流式文本，各思考档位 |

元数据本次使用的已验证字段包括：`loggingMetadata.clientVersion=1.144.4.1467`、`clientType=21`、`uiSource=1`、`languageCode=zh-CN`。这不是完整原生元数据保真声明。

捕获的主业务 RPC 请求没有 `user-agent` 头，包含 `authorization`、`x-server-token`、`x-ios-bundle-identifier`、`accept-language: zh_CN` 及 gRPC 内容类型等。取证副本的 bundle identifier 与原安装不同，这一差异单独记录；直连使用原安装的协议标识 `com.google.GeminiMacOS`。当前工具探针已移除历史候选 UA，并在原生服务路径上取得成功。不能将 OAuth、更新或实验接口的请求头混作主推理请求头。

原生 OAuth 页面观察到初始 scope 为 `flexible-api`；较早的独立授权探针使用了更宽的历史 scope 组合。后续认证实现必须继续核对原生令牌取得流程，不能把该探针的较宽授权当作已经对齐的最终配置。

## 4. 模型、思考配置与实际输出

| 模型 | 上游 ID | `requestedModeCategory` |
| --- | --- | --- |
| 4 Hydrogen | `56fdd199312815e2` | 1 |
| 4 Argon | `argon`（当前模式变体） | 8 |

状态响应同时存在旧式 `bardModeConfigs` 和新的 `geminiModePolicy`。原生样本有 7 条策略，同一类别包含不同变体及 Chat/Task 两种 host，不能按 category 放进 Map 后互相覆盖。类别 8 同时包含 Carbon 与 Argon；`95a4c0abcba24364` 是旧类别模型 ID，在任务模式使用它会返回“旧版”，不能当成通用 Argon 路由 ID。当前任务模式必须使用 `modeVariantId=argon`。新目录解析已保留变体和 host。最终响应的旧 `responseBardModeId` 也可能是 Hydrogen 的 ID；应同时核对变体、类别、模型归属和思考档位。

普通聊天策略与早期文本直连样本的思考档位如下；这些结果不证明任务模式支持相同档位：

| 对外档位 | `requestedThinkingLevel` | 真实响应核对 |
| --- | --- | --- |
| low | 1 | 默认请求返回档位 1，两个模型均正常完成 |
| medium | 4 | 显式提交 4，两个模型均返回 4 及 Medium 模型归属 |
| high | 2 | 显式提交 2，两个模型均返回 2 及 High 模型归属 |

中、高档的实连探针均检查了响应中的真实模型 ID、档位、模型归属、非空测试正文、消息树完成标志和 gRPC 最终状态。不能按数值大小猜测档位。

新增目录解析模块生成两个家族的候选 `-g` 名称及明确档位。无档位名称映射默认 low，同时保留任务模式允许档位。目录条目尚未接入正式 `/v1/models`；不能把 Chat 能力当作含工具的 agent 已验收能力。当前原生 Task 策略只列出档位 1。直接提交 Argon Task + high（2）虽完成工具闭环，但实际返回 1，该样本判定失败，不能以回答正确掩盖降档。当前变体在聊天模式的各档位以及带工具兼容方式仍需进一步验证。

### 4.1 当前原生工具协议与直接闭环

原生任务请求使用 feature mode 41、`isAgentChat=true`、远程设备目标及 `modeVariantId=argon`，随后打开 `ExecuteRemoteTools` 双向流。模型通过 `list_mcp` 获取完整工具声明，使用 `execute_mcp` 请求实际客户端工具；已捕获参数名 `ServerName`、`ToolName`、`Arguments`。返回采用 protobuf Struct，并保留调用 ID（上游有时明确为空）。

独立取证客户端完成了声明 → 模型调用 → 实际读取唯一测试文件 → 回传 → 最终正确随机标识的闭环。成功样本 `tool-probes/1794772383983/report.json` 返回 4 Argon、变体 argon、类别 8、档位 1、正常业务结束和 gRPC 0。工具由取证客户端执行，不是网关执行，也不是安装后真实 agent 验收。

保留的失败样本包括：旧 ID 在任务模式落入旧版、feature mode 58 未暴露声明工具，以及 `1794772633846` 的 high 请求实际降为 low。不能将这些样本计入兼容通过。

目录还受客户端能力声明影响：精简元数据只返回 4 条 Chat 策略，即使同一账号已能真实调用 Task。对实际捕获能力逐项直接对照后，`MULTI_MODE_PICKER=903` 使目录返回 Hydrogen/Argon 的 Task 策略；单独补 591 或 935、或者 eligibility checks 1–6 都不能得到同样结果。新请求配置保留 903，未将整个原生界面能力数组盲目复制。证据：`catalog-capability-validation.json`。

### 4.2 新生成模块实连

取证 app 及其注入辅助进程退出后，`src/gemini-generation.js` 通过新传输直接请求真实 Google，结果如下：

| 私有用例 | 实际路径 | 结果 |
| --- | --- | --- |
| `generation-module-probes/1794773456623` | Hydrogen Low + 工具 | 目录缺少 Task 策略，被模块明确拒绝；原失败保留 |
| `generation-module-probes/1794773489538` | Argon High，普通聊天 | 返回变体 argon、类别 8、档位 2、正确标识、正常结束 |
| `generation-module-probes/1794773635656` | Hydrogen Low + 工具 | 增加 903 后，实际客户端读取及回传闭环通过，约 16.8 秒 |
| `generation-module-probes/1794773685094` | Argon Low + 工具 | 实际客户端读取及回传闭环通过，约 26.1 秒 |
| `generation-module-probes/1794774105213` | Argon Medium，普通聊天 | 返回变体 argon、类别 8、档位 4，正常结束，约 11.0 秒 |

上述生成前后均读回活动记录为关闭。这里的客户端是隔离协议测试程序，不是五个正式 agent；这些用例不计入安装后 HTTP 验收。模块只向调用方交付工具请求、接收调用方提供的结果，未实现任何文件/Shell 工具执行。

简单标识探针的总耗时约为 Hydrogen 2.6–3.3 秒、Argon 5.0–6.4 秒。此范围仅是本账号本时段的小请求样本，不是完整 agent 上下文的性能验收或长期延迟承诺。首个 gRPC 控制消息不当作模型首字。

## 5. 已新增代码与实际验证

- `src/gemini-wire.js`：有长度、字段数量、整数范围和截断检查的 protobuf 基础编解码。
- `src/gemini-rpc.js`：直接 HTTP/2 gRPC、双向流、单次 RPC、取消、超时、压缩限制、流完整性及最终状态校验；不自动重放请求。
- `src/gemini-onboarding.js`：必要条款与活动偏好顺序、服务端读回、明确阶段和不完整状态错误。
- `src/gemini-model-catalog.js`：解析实际目录及新模型策略，按账号可见性生成已验证家族的明确模型映射。
- `src/gemini-account-store.js`：独立目录、Google 身份标识和授权代次，拒绝同邮箱不同主体合并；不扫描旧目录。
- `src/gemini-request-profile.js`：当前请求头、必要能力、模型/档位字段与生成消息；工具模式不支持的档位明确拒绝，不能静默降档。
- `src/gemini-struct.js`：MCP 参数、完整 Schema 和结果使用的 protobuf Struct；保留空值及特殊键，限制循环/深度与非 JSON 值。
- `src/gemini-generation.js`：真实生成/工具双流、增量输出、工具关联、取消、业务终止与实际模型档位核验；不执行客户端工具，不重放任务。
- `src/gemini-auth.js`：独立账号的真实 OAuth 刷新与服务配置令牌取得；授权代次比较后保存，取消单个等待不取消其他会话的共享刷新。
- `tests/gemini-*.test.js`：14 项存储隔离、原生目录、档位保护和二进制边界检查通过。它们不算真实 agent 验收。原生目录夹具只保留公开模型策略字段。

新认证模块的真实强制刷新已通过：`auth-module-probes/1794773789619/report.json`。随后以刷新后的凭据取得 6 条策略，读回活动记录关闭，原授权代次保持。整个过程使用仓库外的隔离组件账号存储，不是看板新增账号验收，也没有向正式池导入账号。服务配置只请求当前 Gemini 账号包，版本数值与当前原生捕获一致，不复制统计上传相关配置包。

本阶段 `npm run check` 检查 87 个运行时/脚本文件通过。尚未改动原运行入口，未执行五客户端 HTTP 验收或正式部署，不能以这些检查宣称现有功能回归全部通过。

新增传输、初始化与目录模块已直接连接真实 Google。初始化模块覆盖的是该账号已初始化后的重加核验分支；完整的新账号分支仍需换一个真实未初始化样本，通过最终模块与看板再验收。

上述组件验证阶段尚未接入主入口。之后的 HTTP 集成已修改开发目录的主入口、账号池及审核模型选择，详见第 7 节；正式配置、正式安装及服务器部署仍未改动。

## 6. 下一阶段与缺口

1. 主 RPC 请求头、原生元数据、模型策略和任务工具闭环已取得当前原生捕获。继续核对 OAuth 最终范围、普通聊天与任务的模型档位差异，以及完整客户端上下文转换。
2. 接入 Gemini 独立账号存储、刷新、额度、路由和看板首次添加流程；使用最终实现补测新的待初始化样本。
3. 验证完整工具声明/回传、上下文、媒体和搜索协议。不能以当前短文本探针替代这些能力。
4. 将 Auto 审批按触发请求上游路由，完成同一会话及并发场景验证。
5. 五个真实客户端经实际安装 Gateway HTTP 入口测试，完成本地与 Linux 独立运行、原 Antigravity 回归和数据兼容。
6. 核实免费账号及 Windows 环境；完整改进计划范围、未触发错误分支和运行时性能保持明确未验收。

私有主证据目录：`antigravity-gateway-operations/gemini-direct-20261116/`。关键索引包括 `baseline.json`、`gateway-modules-live.json`、`thinking-validation.json`、`onboarding-module-validation.json`、`native-catalog-validation.json`、`native-ssl-decoded/` 和 `tool-probes/`。原生 TLS 捕获含认证头，禁止公开；仓库仅保存脱敏协议说明。旧目录解析和旧路由样本保留为历史证据，不能覆盖更新后的结果。

## 7. 隔离安装包与真实 Pi 工具闭环

### 7.1 已实现的 HTTP 集成及边界

- `GeminiProvider` 接收统一规范化的完整系统提示、历史、工具声明和工具结果；仅清理已有来源规则识别的框架身份，不删除用户 SOUL、技能、权限或历史来压缩测试。
- `GatewayUpstreams` 按登记的公开模型 ID 选择独立账号池。`-g` 模型不会落入 Antigravity 池；未知 `-g` 不通过截去后缀猜测上游 ID。原账号池的调度算法不变。
- Gemini 账号池独立存储和调度状态；主入口的模型目录、Messages/Responses 路由及服务器审核入口已开始集成。Auto 的客户端关联和实际分类评估尚未验收。
- 必要的工具关联按账号、调用者、会话及原始调用 ID 隔离。账号不可用仍按统一池内规则处理，不等待原账号、不重建用户历史；无法关联的旧工具结果明确报错。
- 当前 Gemini 媒体和服务器搜索路径仍明确返回未适配错误，没有偷偷切换到 Antigravity，也没有删掉附件后继续调用。
- 本阶段通过 npm tarball 安装到仓库外隔离 prefix，并实际启动该安装包的 HTTP 服务。账号是此前已授权的隔离测试凭据；这不等于正式看板添加流程已验收。

### 7.2 原生写入确认与工具连接生命周期

真实 Pi 请求首轮约 36.9 KB，包含 4 个正常客户端工具及完整上下文；后续轮次约 37.3–38.3 KB。没有使用 `--no-tools`、`--no-skills`、替换系统提示或权限覆盖。

最初读取文件成功，写入前却收到原生 `RemyConfirmationCard`：标题为 `Run write?`，说明为 `Allow Gemini to run write on your machine?`，折叠详情包含实际 JSON 参数，按钮动作是“允许/取消”的 `ToolAction.userQuery`。上游任务为 `GOAL_STATUS_BLOCKED=2`，正文只是卡片资源引用。这不是普通最终答案，也不是账号限流。

修正过程及保留的失败证据：

| 私有用例目录 `installed-http/runs/…` | 结果 |
| --- | --- |
| `1794775291028` | 验收脚本错误地检查不存在的 `/health`，未进入客户端测试；已改用实际 `/api/hello` |
| `1794775355402`、`1794775457337` | Pi 读取成功；未识别写入确认边界，返回错误；原先还被错误包装为 internal_error 并触发账号冷却 |
| `1794775697741` | Pi 已实际写入，但确认续接没有业务结束标记，整条用例失败 |
| `1794776025092` | 增加 streaming continuation 标识没有解决问题；该尝试已撤销 |
| `1794776133103` | 确认请求使用当前描述符的 `PromptSource.ACTION_BLOCKS=5`，但过早关闭工具连接仍导致失败 |
| `1794776272971` | 保留确认期间的原生工具连接后，Pi read → write → read → 最终回答全部通过 |
| `1794776540143` | 最新隔离安装包，Argon Low 同样完成 read → write → read → 最终回答；4 次 HTTP 请求、2 次原生 ProcessQuery |

最终通过用例中，网关把能严格对应已声明工具的确认卡片交回 Pi。Pi 按自身权限实际执行后，网关才发送该卡片的控制输入；后续原生 MCP 请求必须与客户端已经处理的工具名称和 JSON 参数完全一致，才能回传已有结果，避免重复执行。未知卡片、额外授权动作、未声明工具或参数不一致会明确失败。网关没有执行文件工具。

`RequestIdentifiers` 的会话、父请求及父响应用于当前原生确认，`PromptSource.ACTION_BLOCKS=5` 和 `isConfirmationResponse=true` 用于标明控制输入。工具连接保留至该调用完成、取消、过期或账号失效。未引入跨账号恢复或完整历史缓存。

通过用例的安装源码摘要为 `959612c271c059c0d5ffad1ff86d8b2ae75258ef67ad229ee7106288a9e8e67e`；包版本仍为开发基线 2.0.5，不代表已发布新版本。4 次 Responses 请求全部正常结束，真实执行 read/write/read，目标文件逐字节一致，最终答案包含随机文件标识。总耗时约 52.7 秒；上游最终返回 Hydrogen、category=1、thinkingLevel=1、goalStatus=1。网关返回 `usage:null, usage_known:false`，Pi 显示的 0 token 不能当作上游测量值。

Argon Low 通过用例安装源码摘要为 `655a97374af32d06dbe77e5ade2baecd977e0dc27a5aac79b5ce44dbe2382406`，耗时约 55.2 秒。最终上游 category=8、modeVariantId=argon、thinkingLevel=1、goalStatus=1，HTTP 200、gRPC 0；返回的基础 modelId 仍为 `56fdd199312815e2`，因此不能仅靠这个基础字段判断 Argon，必须同时核对变体、类别和上游归属文本。

错误边界已改为保留已知 Gemini 错误类别；本地转换错误不作为账号认证或健康故障。物理调用计数按实际 ProcessQuery 完成记录，避免把跨多次客户端 HTTP 的一个原生任务重复统计，或漏掉确认后的新 RPC；最新 Argon 用例已核对原始帧与落盘的分模型计数。历史看板汇总存在原有刷新周期，不能用尚未刷新的展示值代替实际计数。

### 7.3 Gemini 额度字段

当前客户端描述符和直接 `GetUsageInfo` 响应共同确认：响应字段 2 为订阅枚举，字段 3 为重复 Usage；budgetPoolType=1/2 分别是 GXU 五小时/每周窗口，gxu 字段 2 为显式 float `pctUsed`，字段 1 为重置时间。credits 是另一种池，不能混算。

新增 `gemini-quota.js` 及 Provider 的 `getQuota()`，已通过真实上游调用取得两个窗口的使用比例和重置时间。缺失、非法比例和重复歧义窗口标为未知；没有把 tier=2 擅自命名为具体商业套餐，也没有推算 token、图片余额或每个模型的独立额度。

证据为私有 `quota-module-live.json` 和 `usage-info-*.bin`。本节取证后已继续接入额度缓存、调度保护与看板分组，最新结果及限制见第 8 节。

### 7.4 Antigravity 对照回归尚未通过

同一授权账号的隔离副本、同一真实 Pi 完整工具场景：

| 用例目录 | 安装包与模型 | 真实结果 |
| --- | --- | --- |
| `1794776333439` | 新集成包，Flash High | Google `RESOURCE_EXHAUSTED`，未执行工具 |
| `1794776407584` | 新集成包，Sonnet 4.6 | 同样返回 `RESOURCE_EXHAUSTED` |
| `1794776466217` | 本机原有全局安装包，Flash High | 同样返回 `RESOURCE_EXHAUSTED` |

旧包在相同账号条件下能复现该错误，不能将其直接归因于新增 Gemini 路由；也不能据此宣称回归通过。仍需其他可用账号及服务器的真实验收。正式账号文件、Pi 原有模型配置和正式服务未被这些隔离测试修改。


## 8. 双池额度集成与授权范围对照

### 8.1 已接入的额度与看板

新增 `GeminiQuotaManager`，复用现有刷新队列、并发限制、刷新周期及额度保护规则，独立写入 `state/gemini-quota.json`。其唯一额度来源为 Gemini `GetUsageInfo`，不调用 Antigravity 的项目、目录或额度端点。原 `state/quota.json` 保留原用途。

保持真实五小时/每周 GXU 窗口，缺失比例仍为未知；过期快照不恢复为新额度，失败查询不释放已知保护。旧授权、已删除账号或已更换 Provider 的迟到结果不写回。额度接口的普通 403 不直接等同于模型推理被拒绝；确切 401 才交给账号认证故障处理。

看板数据合并两个池，账号卡片分别显示 Google Antigravity API 与 Google Gemini API。实际浏览器中已核对两个分组、Gemini 两个额度窗口与“Token 未提供”。Gemini 未提供真实 token 用量时，不作为已测量零值进入 token 统计。独立额度刷新已接入服务启动、退出排空和目录守护。

实际安装包用例 `1794777787244` 使用本机 Pi 1.5.2 的完整配置、技能和四个文件/Shell 工具，Hydrogen Low 完成读取 → 写入 → 再读取 → 最终回答，约 49.1 秒；文件逐字节核对一致，客户端原配置摘要未变。安装源码摘要为 `685814faf097eeedd1b91e787fa395ca299267a1e562835366534dda45381986`。运行时看板 JSON 同时含两个池及真实 GetUsageInfo 数据。之后仅补充额度失败快照落盘和看板说明文案；失败额度分支仍只有本地生命周期检查，未宣称真实上游负面场景已覆盖。

### 8.2 OAuth 请求范围与实际授予范围不能混同

新隔离浏览器授权仅请求 `openid email profile https://www.googleapis.com/auth/flexible-api`，PKCE S256、offline、`include_granted_scopes=false`。身份读取、当前版本服务配置令牌及强制 OAuth 刷新成功，无 Gemini app 进程参与。

但 Google 令牌响应仍返回 52 项 first-party scope，与早期较宽授权的返回集合完全相同。因此只能证明“授权请求不再显式列出历史额外权限”，不能声称所得令牌只有这些较小权限，也不能以 scope 列表相同证明两次授权在所有协议行为上完全等价。网关探针仅访问本项目已确认的身份、配置和 Gemini 业务接口。

新增 `gemini-oauth-profile.js`、`GeminiOAuthFlow`，独立定义 Gemini OAuth 端点、PKCE、取消/超时、经 Google 验证的身份及未初始化状态；无需读取本机 app 或旧账号目录。它只复用原 OAuthFlow 的回环回调监听与活动任务锁，不复用 agy 凭据发现、兑换或项目初始化。该模块目前尚未接入正式看板流程，OAuth 返回的账号默认未启用，不将授权成功直接等同于初始化/可推理。

私有证据：`oauth-scope-validation/authorization-result.json`、`refresh-report.json`、`direct-compare/report.json`；授权值及完整原始响应均不进入仓库。

### 8.3 新失败样本与仍待定位的差异

| 用例 | 条件与结果 |
| --- | --- |
| `1794777471154` | 新授权范围、带额度集成的安装包；Pi read/write 真实执行，确认续接缺少业务结束标记，失败 |
| `1794777636041` | 尝试在确认续接中复用同一工具流；仍出现相同业务未完成错误，失败；这项未证实的改动已撤销 |
| `1794777787244` | 恢复原测试授权、原工具流行为，保留额度集成；Pi 完整 read/write/read 闭环通过 |

失败不是仅凭 HTTP 200 判定的：客户端实际收到 `gemini_generation_incomplete`。失败样本没有计入成功，没有用删除结束校验、伪造正文或改变客户端工具权限掩盖。

随后对两份授权分别强制刷新，并直接读取模型目录、活动偏好和额度：两者解析后的目录完全相同，均为 8 个公开模型、userTier=2，活动偏好均为 false。一次原授权成功与两次新授权失败不足以证明根因一定是 scope，也不足以证明工具连接生命周期已经完全解决；需要进一步原生协议对照与重复的完整客户端证据。

本轮本地定向检查 73/73 通过，语法检查 95 个文件、`git diff --check` 通过。这些检查不替代真实客户端验收。正式本地服务仍运行，4 个正式账号文件摘要未变；没有正式部署、提交、推送或版本变更。看板添加/重新认证/初始化、全部可选改进项、其他四个真实客户端、Auto、多模态及服务器验收仍未完成。

## 9. 看板真实授权与完整客户端进展

本节更新第 8 节的阶段性状态，不覆盖或删除其中失败证据。

### 9.1 已初始化账号的产品授权流程

新 `DashboardGeminiAuth` 已接入实际安装包和看板。通过独立空数据目录启动的真实看板，浏览器完成 Google 授权后，网关依次兑换凭据、读取身份、核验初始化与活动偏好、查询模型和额度、执行最小真实生成，再将该账号标记为可路由。私有证据位于 `dashboard-implementation/authorization-report.json`，完成时间为 2026-11-15T21:41:21Z。

该账号原先已初始化，因此 `acceptedTermsVersion=null`；只能证明已有账号的真实看板添加闭环，不能替代全新免费账号首次接受条款的验收。活动偏好读回为不参加，网关未发送可选客户端遥测；全套首次引导可选项目及 Windows 实机流程仍未验收。

未初始化账号正常推理返回 `gemini_initialization_required`；只有当前初始化任务可以使用待启用凭据。失败时账号保持不可路由，取消、重新授权和删除使用授权代次隔离迟到结果。本地生命周期检查用于补充边界验证，不作为真实 Google 负面场景验收。

### 9.2 使用看板新授权的真实客户端闭环

| 用例 | 客户端与完整请求 | 结果 |
| --- | --- | --- |
| `1794778905641` | Pi 1.5.2，4 个工具，首请求 36,877 字节 | Hydrogen Low；read → write → read → 最终回答，4 个 Responses 均完整结束，文件逐字节一致，44.681 秒 |
| `1794779349829` | Hermes 0.23.1，19 个工具 | 测试接入失败：旧凭据池覆盖了隔离 provider 的新 API key，401，未抵达 Google；保留为失败 |
| `1794779440549` | Hermes 0.23.1 / Python 3.14.9 / OpenAI SDK 2.54.0，19 个工具，首生成请求 48,150 字节 | 明确选择隔离入口密钥后，read_file → write_file → read_file → 最终回答，4 个生成 SSE 完整结束，文件一致，50.341 秒 |

两次成功均保留正常上下文、技能、工具和客户端权限，原配置摘要未变。Pi 安装源码摘要 `903d376d15e00c885a4f218a9c0ad54474e7fc670c79a69212acc0db292bbee8`；Hermes 为 `dcfb7f9a46e03140fca7c41d84f0044162dbe50d11037430eaff8224fe02008d`。这些是各自安装包的测试，不能直接替代后续修改包的回归。

Hermes 初版记录器将结果保持为未评估；检查真实 stream-json 的 tool_use/tool_result/text/result 事件后，在独立 `assessment.json` 记录 8 项检查通过，原始 report 未改写。其 provider 自动识别的其他产品探针 404 与生成错误分别记录。

看板新授权已能通过 Pi/Hermes，说明此前两次失败不能简单归因为新 OAuth scope 必然不可用；原生确认续接的间歇失败仍保留为未解释样本。

### 9.3 Codex 完整目录与原生搜索

Codex CLI 0.167.2 的完整首请求为 682,909 字节，28 个顶层工具条目展开为 278 个客户端工具，同时含原生 `web_search` 声明。

- `1794779105269`：网关原先拒绝 `web_search`，在抵达 Google 前失败。
- 新增 Gemini 专用 Responses 搜索声明投影，保留原声明与全部客户端工具，交给原生 Google Search；仅有真实原生搜索完成证据才返回 `web_search_call`。暂未支持的域名、位置或离线限制明确报错，不静默删除限制。
- `1794779755643`：请求已抵达 Google，但读取完整 MCP 目录时返回 `Message recursion depth exceeds maximum of 50`。6 次请求由真实 Codex 的自动重连产生，并非网关跨账号重放。未执行客户端工具，仍为失败。
- 深层工具 schema 在 protobuf Struct 中每个对象层会增加多个消息层。新增仅针对过深声明的 JSON 字符串传输转换，完整原 schema 保留在声明中，参数解码后继续使用原客户端校验和映射。未删减工具、schema 或上下文；完整 Codex 实测结果另行记录。

独立原生搜索探针 `search-protocol/1794779215325` 观察到真实 Google Search 及官方来源，但最终正文插入 `[span_N]` 引用标记使旧累计文本检查失败。根据实际 MessageTree 注释和来源结构加入解析：只移除可验证的成对显示标记，保留全部正文和来源，不抓取网页；文字发生实质性改写仍报错。捕获帧回归通过尚不能代替修复后的完整客户端搜索验收。

目前没有正式部署、版本变更、提交或推送。Claude、dsh、真实 Auto、深层工具实际执行、多模态、服务器/Windows、全部首次引导选项，以及原有 Antigravity 功能回归仍需继续完成。

### 9.4 Codex 完整工具闭环通过，搜索状态按模式解析

`1794780320216`：Codex CLI 0.167.2 保留完整首请求 682,909 字节及展开后的 278 个工具，真实执行文件读取、复制、复读；3 个 Responses 全部正常结束，文件逐字节一致，67.168 秒。安装源码摘要为 `f543bf802c08f72b69595886126087d8375f9bb3e70940801c88daec573ee473`。这证明深层工具目录已被 Google 接收，不表示每个被编码工具都已实际调用。

`1794780436301`：完整 Codex 搜索任务返回正文和链接，但网关没有输出搜索事件，记录为未通过。原始帧和当前描述符确认 Task 模式使用 `LAMDAStatusUpdateResponse.remyProcessingState` 的 typed `permissionId.functionCallId = google/search` 以及 `allToolsUsed`；普通聊天则使用 `toolProcessingState`。补齐两种状态解析，不能按模型正文声称“已搜索”判定执行。

`1794780706144`：修复后第一次复测被真实五小时额度保护拦截，未抵达 Google，保留失败，不降低保护阈值。

随后经真实看板添加第二个已初始化账号，完成令牌兑换、原先开启的活动偏好关闭及读回、目录、额度与真实生成检查。私有证据为 `dashboard-implementation/runs/1794780766826/authorization-report.json`。原有 Antigravity 同邮箱账号未合并或改写。该样本验证已有账号退出活动记录设置；`acceptedTermsVersion=null`，仍不能替代全新账号首次条款流程。

`1794780894933`：同样完整的 Codex 搜索任务通过，首请求 682,776 字节、28 个顶层工具条目；原生 Google Search 的 typed 使用记录、正常任务完成、Responses `web_search_call` 与客户端 `web_search` 完成事件相互对应，最终回答包含官方帮助链接，30.623 秒。安装源码摘要 `d708e0326aa91351d2b7ca1ae5e4091146d09f69eaa004d775deb05f5aba84a5`。

此 Task 样本没有返回独立 sourceUrls 或正文引文元数据，因此结构化 sources 保持空数组；正文里的链接原样交回客户端。没有把普通 Markdown 链接伪造成有原文证据的引用，也没有网关网页抓取。

### 9.5 dsh 与失败结束事件

`1794780942820`：dsh 0.2.1-rc.2 保留原 headless profile、25 个工具与完整 48,751 字节主请求；另有客户端实际产生的 1,338 字节辅助请求。真实 read/write/read 及 5 个 Responses 正常结束，43.653 秒，但模型的 write 参数遗漏文件末尾换行，文件逐字节验收失败。客户端最终声称一致不能覆盖实际字节差异；原失败和独立 assessment 均保留。

`1794781179847`：保留全部工具和原权限，在同类任务中明确要求保留末尾换行并进行字节比对后，真实执行 read → write → bash（cmp 与长度检查）→ read。主请求 48,808 字节，另有 1,395 字节辅助请求；6 个 Responses 均正常结束，两个文件逐字节一致，69.274 秒。安装源码摘要 `6bf89499acfddd1e70ef2059adef2b5374432fcc8d3e877837fc02f98dff91e9`。该结果证明当前工具转换闭环可用，不把模型首次遗漏换行的失败改记为通过。

Responses 流式错误原先仅发送通用 error 事件，Codex 将其呈现为未收到完成事件的断流。现改为返回 `response.failed`，保留真实错误代码、消息和已交付的未完成正文；不发送假 `response.completed`。普通 JSON 错误与 Messages 协议保持原语义。

真实受保护账号用例 `1794781079766` 已能在 Codex 中显示具体的额度保护原因，但 Codex 仍按自身策略重试 5 次。不能声称该修复消除了客户端重试，原“单次终止”预期仍为失败；期间没有实际 ProcessQuery 调用，也没有绕过额度保护。其行为与 [Codex 0.167.2 的失败响应解析](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/codex-api/src/sse/responses_error.rs)一致：未识别的 code 会进入可重试类别。未将保护阈值伪装为账单耗尽来阻止客户端重试。

新增上游后，旧测试全局覆盖 AccountPool 原型会同时伪造 Gemini 池，导致目录重复计数及 Auto 错误归属；测试夹具已限定原 Antigravity 池。旧“禁用 Gemini 文件名”断言调整为继续禁止退役 Robin/Windows 实现和目录扫描，允许本次新看板账号存储。完整本地测试最终 1163/1163 通过；这仍不能替代真实 Antigravity、Auto、多模态及其他未完成场景。

### 9.6 Claude 完整请求暴露运行期上下文更新缺口

`1794781320986`：Claude Code 2.1.322 使用原有规则、插件、工具和权限设置，仅以附加 settings 指定隔离网关地址与密钥，并选择 Hydrogen Low。首请求 73,686 字节、12 个工具，已取得真实工具调用并返回客户端结果；下一请求 75,054 字节被网关拒绝为 `gemini_tool_context_changed`，最终客户端退出失败。

完整请求对比确认：系统文本从 26,797 字符增加到 27,649 字符，新增的是客户端在运行期追加的 MCP 连接失败及工具不可用说明；原系统前缀完全保留。输出配置没有变化，工具结果之后也没有额外用户消息。当前 Gemini Provider 的不可变合同检查拒绝了这项 852 字符的新增上下文，不能通过删掉说明、禁用 MCP 或仅测一个简化客户端来计为通过。

该样本为明确未通过。后续需要按实际原生协议支持运行期上下文更新并复测；目前尚未完成 Claude 和 Auto 验收。原生等待任务之后缺少完成标记是次生现象，不应掩盖最先发生的本地转换拒绝。

### 9.7 完整客户端上下文通过工具结果载体继续转发

当前未找到已验证的独立原生 system 更新接口。新增兼容编码使用已经实测的 MCP 文本内容载体：实际工具输出保持在第一个内容块，另一个明确标记的文本块转发客户端本轮完整请求，包括系统提示、原有历史、工具结果、追加消息和输出要求；初始指令说明该块的来源及角色边界。网关不补造或自行压缩历史，也不把该编码称为 Google 官方 system 更新协议。

`1794782197953`：Claude Code 2.1.322 的正常默认权限流程，首请求仍为 73,686 字节、12 个工具。运行期系统文本从 26,797 字符增加到 27,480，再增加到 27,649。原先拒绝新增上下文的检查已移除；实际 native 工具响应中的当前请求，与第二次客户端提交经正常转换后的完整内容逐项一致。3 个 Messages 均正常结束，40.324 秒，原客户端配置摘要不变。但 Write 被客户端默认权限模式拒绝，文件未产生，因此文件任务仍记为失败，不用放宽权限将其改记成功。

动态工具目录继续由客户端提交的当前声明更新。确认卡片对应的已执行调用在回传时按原调用名称和参数核对，不因客户端随后移除该工具而丢弃既有结果；新的工具调用仍必须属于当前目录。工具目录变化、并行结果等更广泛实际场景仍需单独验收。

### 9.8 Claude 真实 Auto 正向闭环：Hydrogen 和 Argon

`1794782324060`：实际 Claude Code 2.1.322 使用 `--permission-mode auto` 启动本次 Auto 功能验收，保留原用户/项目配置、MCP、技能和工具，没有设置分类器模型覆盖项。主模型 Hydrogen Low，首请求 79,234 字节、12 个工具；Read → Write → Read，最终文件逐字节一致，4 个 Messages 正常结束，总计 58.949 秒。安装源码摘要 `5a669b9fee7723d05643a6534a8f0b5a26fb8af7a8c4ba137a0d60a881cb307f`。

三个工具调用均携带客户端真实 safeguards 合同；网关分别向 Google Gemini API 的 Hydrogen Low 发出实际独立审核请求。上游生成帧确认 category=1、thinkingLevel=1，真实 JSON 判定中的工具 ID、outcome 与返回客户端的 `safeguard_results` 一一对应。客户端实际继续执行，无权限拒绝。`auto-upstream-assessment.json` 保存此对应关系，不以网关自行返回的状态字段作为唯一证据。

`1794782519142`：同样完整的 Claude Auto 文件流程，将主模型选为 Argon Low；4 个 Messages 和真实读写复读通过，91.194 秒，安装源码摘要 `41229b1f0a191d02c2ec0eaf63cc09a511f2df23a8686528c4614a1735fab4d4`。主生成按 Argon 配置执行，三次独立审核均为同上游 Hydrogen Low。每轮系统文本、追加消息与完整历史的 native 转发内容均与客户端提交一致，原配置摘要不变。

这些结果证明当前两种 Low 主模型的服务器 safeguards 正向路径可用，不能推及独立分类器关联、审核 flagged/不可用/超时、并发模型切换、Antigravity 回归或所有模型档位。

### 9.9 客户端拒绝工具时保留失败原因，及线程清理回归

默认权限样本同时揭示旧取消流程只发送原生取消按钮文本，没有传递实际工具错误和更新的上下文。现保留真实取消选择，在同一 UserQuery 文本载体后附本轮完整客户端请求；不向被拒绝的操作发送 Allow，不伪造成功工具结果。

`1794782438906`：真实 Claude 默认权限拒绝 Write。文件确实未产生，3 个 Messages 正常结束，43.616 秒。第一轮工具结果后的上下文从工具响应内容块转发；拒绝后的完整上下文从取消 UserQuery 转发，均与对应原始请求转换结果一致。最终模型明确说明 `user_declined` 和未完成写入、复读。原文件任务报告仍保留失败，单独的 `permission-denial-assessment.json` 仅证明这项真实拒绝处理通过；不是 Auto 模型返回 flagged 的验收。

全量回归还发现原 SchemaWorkerPool 会把正在 terminate 的线程当空闲线程 unref，导致清理 promise 未完成时进程提前正常退出。独立子进程对照中，旧实现 3/3 次未到达清理完成标记，修复后 3/3 次到达；保留空闲线程可以自然退出的原要求。新增清理生命周期回归后，全量 1166/1166 通过，无取消项。私有证据为 `worker-cleanup/report.json` 和 `full-regression-context-worker-fixed.tap`。这项代码检查不替代真实客户端验收。

### 9.10 最新隔离安装包的完整 Codex 与深层工具实测

安装源码摘要 `780ab9325b3bf970e199e96294926e1874be87f9ee107c4f30a7f4e5106c9d03`，包含上下文回传、拒绝工具信息传递和线程清理修复。

- `1794782689170`：Codex CLI 0.167.2，Hydrogen Low，首请求 682,909 字节、28 个顶层工具条目，后续动态变为 29 个。真实文件读取、复制与复读通过，文件逐字节一致，3 个 Responses 正常结束，70.010 秒。
- `1794782801211`：同一完整客户端和模型，首请求 682,811 字节、28 个顶层条目。要求使用客户端 `search_service.web_run`，实际客户端 MCP 调用成功，2 个 Responses 正常结束，59.155 秒；原生 Google Search 状态未触发。搜索由 Codex 的客户端工具执行，网关没有额外读取网页或代替客户端执行搜索。

深层工具证据从 native `list_mcp` 目录、`execute_mcp` 的 `arguments_json`、Codex 的实际 MCP 参数和工具回传逐项核对：完整原 Schema 保留在兼容声明中，JSON 解码后参数与客户端实际执行参数一致，真实结果内容完整回传。此处首次验证了被兼容编码的工具实际执行，而不仅是目录被上游接受。私有 `deep-tool-assessment.json` 保留对应关系及原 Schema 摘要。两次客户端配置摘要均未改变。

本轮结束时正式本机进程仍运行，4 个正式账号文件与既有基线摘要一致；未更新正式部署、版本号或仓库远端。首次免费账号完整初始化、全部可选改进项目、其他模型档位工具能力、多模态、独立分类器、服务器与 Windows，以及既有 Antigravity 的真实回归仍是未完成项。

### 9.11 真正首次看板初始化、刷新及实际工具调用

私有看板用例 `dashboard-implementation/runs/1794783142087` 使用最新隔离安装包，源码摘要仍为 `780ab9325b3bf970e199e96294926e1874be87f9ee107c4f30a7f4e5106c9d03`。本轮先添加一个已初始化账号，随后选择另一个真实返回待初始化状态的账号；两者的报告分别保存，不以第一项代替首次流程。

后者实际调用顺序为：

1. `GetUserStatus` 返回 `onboardingStatus=7`。
2. `GetTermsOfServiceVersion` 返回必要条款版本 9，`AcceptTermsOfService` 正常完成。
3. `ReadUserPreferences` 返回活动记录开启；精确更新该字段后再次读取，明确返回关闭。
4. `GetUserStatus` 返回 1，目录和额度检查成功。
5. 首个 `ProcessQuery` 在关闭偏好读回完成之后才发出；真实返回 Hydrogen、category=1、thinkingLevel=1、正常完成且正文非空。

完整路径由看板 OAuth 与网关直接请求完成，没有启动 Mac app 代为接受条款。私有 `first-initialization-order-assessment.json` 记录 unary RPC 时序及首个生成帧创建时间；`first-initialization-report.json` 记录产品保存状态；`first-initialization-completed.jpg` 为看板结果截图。账号在完成推理验证后才启用。

该账号 `GetUsageInfo.userTier=2`（当前描述符名称 TIER1），尚未核实实际免费/订阅性质，**不作为免费账号验收通过证据**。

随后仅复制这一个看板测试授权到独立验收数据目录，保留来源和文件摘要；这不是产品凭据导入入口。

- `first-initialization-lifecycle/1794783968513-refresh`：强制实际 OAuth 刷新，授权代次保持，服务配置令牌可用；初始化复核未重复接受条款，也未再写偏好，前后活动记录均关闭。
- `installed-http/runs/1794783996271`：新 Gateway 进程加载上述数据，真实 Pi 1.5.2，Hydrogen Low，完整首请求 36,877 字节、4 个工具，read → write → read，文件逐字节一致，47.806 秒。四个 Responses 均有唯一正常结束事件，无流内失败；上游用量未知继续输出 `usage_known:false`，不把 Pi 显示的 0 当作实测 Token。
- `first-initialization-lifecycle/1794784060453-after-client`：另一新进程在实际 Task 工具调用后再次读取状态和偏好，仍为已初始化、活动记录关闭。无需重复条款确认。

Google My Activity 的该账号页面另提供独立只读证据：保留活动记录关闭，关闭日期为 2026-11-16；“允许 Google 使用录音、Gemini Live 视频及共享屏幕改进服务”复选框未勾选且不可操作。没有在该页面更改设置。私有 `privacy-ui-readback.json` 记录页面、时间及核验范围。

这些证据覆盖当前账号的活动偏好和相关 Live 改进选项，不能替代全部可选隐私项目的验收。[Google 的隐私说明](https://support.google.com/gemini/answer/13594961)区分活动记录、反馈与其他数据处理，关闭活动记录也不等于零保留或所有 Google 设置均关闭。

### 9.12 可选改进项目的取证边界

当前原生资源另含两项文案：`TOSViewModelUsePromptsAndConversationsForModelImprovementsTitle` 与 `TOSViewModelUseScreenshotsForModelImprovementsTitle`。Swift 字段反射将对应属性定位到 `Google_Gdm_Janus_V1_UserConsentSettings`，分别为 `usePromptsAndConversationsForModelImprovementsAccepted`、`useScreenshotsForModelImprovementsAccepted`。它们不在已经实测的 `ROBINUserPreferences` 活动偏好字段内。

这是当前 app 的静态线索，尚未证明现行 Gemini 引导会显示这些选项、使用哪条服务提交，或它们与旧 Janus 流程的关系。不能仅凭名字向未知字段写 false，也不能将活动记录关闭当成这两项的独立服务端读回。现有产品只报告已验证的活动偏好及网关不发送可选客户端遥测，完整“不参加改进计划”覆盖仍待补齐。

`SEND_CRASH_REPORTS_AND_USAGE_DATA_TITLE` 的中英文资源与先前隔离 app 的实际复选框一致；`DataSharingServiceImpl` 和 `shouldSendCrashesAndUsageData` 是后续定位客户端遥测控制的线索。静态符号存在不作为请求实际上传或设置实际生效的证明。

### 9.13 Linux 隔离安装包首次实连

服务器在独立目录安装 npm tarball，执行原 postinstall 环境检查，Node 24.22.1、Linux x64；正式包、服务和数据目录未用于测试实例。隔离实例仅监听回环地址，本机真实 Pi 通过 SSH 转发访问其 HTTP 入口，Google RPC 从服务器直接发出；SSH 仅提供测试入口连接，不参与上游推理协议。

安装源码摘要与本地最新隔离包一致：`780ab9325b3bf970e199e96294926e1874be87f9ee107c4f30a7f4e5106c9d03`。

`installed-http/runs/1794784210403`：真实 Pi 1.5.2、Hydrogen Low，完整首请求 36,877 字节、4 个工具；read → write → read，文件逐字节一致，4 次 Responses 返回并正常完成，39.067 秒。原 Pi 配置摘要不变。Linux 隔离进程随后独立完成强制 OAuth 刷新、目录、5 小时/每周额度和偏好读回，授权代次保持，活动记录仍关闭。

`installed-http/runs/1794784444935`：强制刷新之后终止原隔离进程、从同一私有数据目录启动新进程，真实 Pi 使用 Argon Low 再次完成 read → write → read，文件逐字节一致，4 次 Responses 正常完成，57.391 秒。服务器原始响应确认 category=8、modeVariantId=`argon`、thinkingLevel=1、goalStatus=1；没有将返回的共享基础 modelId 误认为 Hydrogen 降级。

随后通过服务器隔离看板实际添加另一个账号：浏览器完成 Google 登录，未转发 OAuth 回环端口，浏览器显示连接拒绝；按产品现有流程将完整回调 URL 提交到看板，由 Linux 服务器验证 state、兑换授权、保存账号、关闭并读回活动记录、检查目录和额度，完成真实 Hydrogen 生成。看板成功截图保存为 `server-isolated/1794784165314/dashboard-authorization-completed.jpg`。这验证了服务器手动回调流程，不要求远端安装 app，也没有把认证代码放入公开报告。

新增账号返回 `acceptedTermsVersion=null`，因此是已初始化账号授权，不能作为 Linux 首次条款确认样本。其独立强制刷新复测成功，授权代次保持，活动偏好仍关闭。首次刷新报告有一项验收器误判：在多账号环境比较了所选账号与列表第一个账号的代次；修正为按账号 ID 查找后重跑通过，原失败报告保留。此问题发生在私有验收脚本，不是网关重新授权覆盖。

服务器原始帧与安装记录集中保存在私有 `server-isolated/1794784165314` 对应目录。该轮基线中的 14 个正式配置和账号文件摘要全部未变，正式服务进程仍运行。上述结果不替代 Linux 真实未初始化账号、免费账号、所有客户端矩阵或 Windows 验收；正式部署尚未进行。

### 9.14 原生工具会话结束消息与确认续接

服务器 Hermes 样本 `1794784941277` 在真实读取、写入后，确认续接的 ProcessQuery 未返回业务完成标记。原实现每遇到新 ProcessQuery 的同会话声明就重建 ExecuteRemoteTools。只改成保留旧通道也没有解决：源码摘要 `a149a505fd33e71e9f61c72f643336e41a76ee5e487e0550b6d215abe4d3055a` 的服务器 Hermes `1794785611852`、本地 Hermes `1794785782310`、服务器 Claude `1794785744475` 均保留为失败样本。

新增逐物理 RPC 观察后发现：ExecuteRemoteTools 的 `sessionComplete`（当前描述符字段 3）已经到达，但 HTTP/2 RPC 仍未结束。它是本轮工具交换结束的显式消息。原代码忽略该消息：提前重建通道与一直复用已完成的通道都不足以表达真实生命周期；后者复测出现约 30 秒等待后不完整结束。

当前处理为：同一轮保留通道；新 ProcessQuery 宣告继续同一会话时记录待连接的下一轮；收到旧轮明确的 sessionComplete 后释放旧通道，再接续已经宣布的下一轮。如果消息先于下一轮声明到达，则下一次声明正常建立新通道。关闭旧通道之后的回调不能影响新通道；活动通道的真实错误仍会使请求失败。不重建客户端历史、不换账号恢复任务，也不代替客户端执行工具。

四项生命周期检查覆盖真实关闭、错误及两种消息先后顺序，只作为本地逻辑回归。最终实际安装源码摘要为 `2ee3275f2e3e00182556641c1e610decc6b823fefec7826b0e754dfa8f01b784`，全量测试 1170/1170 通过，真实验收见下一节。所有旧失败报告保留，不能将这项修复推及尚未核对的全部历史失败。

### 9.15 当前修复包的真实客户端结果

以下使用同一源码摘要 `2ee3275f2e3e00182556641c1e610decc6b823fefec7826b0e754dfa8f01b784`，均保留客户端原配置、规则和工具，仅采用验收所需的连接及模型选择。

| 样本 | 环境与模型 | 实际结果 |
| --- | --- | --- |
| `1794785925909` | 本地 Hermes 0.23.1，Hydrogen Low | 19 个工具、首请求 48,150 字节；read_file → write_file → read_file，文件逐字节一致，Responses 全部正常结束；50.056 秒，通过 |
| `1794786062123` | 本地 Codex CLI 0.167.2，Hydrogen Low | 保留完整客户端请求，真实文件闭环、逐字节比较和 Responses 结束通过；67.404 秒 |
| `1794786047642` | Linux Gateway，真实本机 Hermes，Hydrogen Low | 三次工具及最终响应正常，50.598 秒；模型写入时遗漏一个末尾换行，整项失败 |
| `1794786149661` | Linux Gateway，真实本机 Claude Code 2.1.322 Auto，Argon Low | Read → Write → Read，文件一致、完整 Messages、无权限拒绝；70.358 秒，通过 |

Linux Hermes 的原生确认卡片参数与客户端实际 write_file 参数完全相同，写入文件也与该参数一致，均缺少源文件的末尾换行。`newline-failure-assessment.json` 明确区分模型未忠实复制和网关转换丢失；未改写文件或放宽比较以使样本通过。

Claude 的三个实际 safeguards 审核均由 Google Gemini API 的 Hydrogen Low 完成。原生请求与响应的 category=1、thinkingLevel=1、工具 ID 和真实 JSON outcome 均与返回客户端的三次 evaluated/not_flagged 相符。主生成仍为 Argon Low；没有通过客户端分类模型覆盖项实现。`auto-upstream-assessment.json` 保存对应关系。这仍是服务器审核合同正向路径，独立分类器关联、flagged、超时、并发切换和 Antigravity 审批回归尚未补齐。

本地 Hermes/Codex 与 Linux Claude 的 `tool-round-assessment.json` 同时核对两个 ProcessQuery 正常结束、旧轮显式 sessionComplete、后续工具通道和真实客户端结果。Linux Hermes 仅有协议闭环证据，整体验收状态继续为失败。

### 9.16 证据关联与正式数据核对边界

私有验收器的初始时间比较出现两类误判，均保留原报告并更正验证方法：RPC done 的异步记录可能晚于新 RPC 创建，不能代替 sessionComplete 到达时间；本机与服务器时钟有偏差，不能用本机 HTTP 时间窗口直接筛选服务器帧。现按完整原生提示中的本次测试路径／审批 ID、物理请求字节 SHA-256 和会话关联选择帧，并保留原始文件时间。复制证据时也显式保留时间属性。这些是验收器修正，不是修改客户端请求或伪造上游响应。

本机正式进程保持运行，4 份原账号文件仍与原摘要基线一致。服务器正式进程保持运行，4 份非账号配置文件摘要未变；10 份账号文件中有 7 份在运行期间改变，文件更新时间为 23:37:33–36 UTC，令牌有效期对应延长至下一小时，与正式服务令牌刷新相符。初始基线只有整文件摘要，不能据此逐字段证明变化仅限刷新字段，因此不再将该轮写成“14 个文件全部未变”。没有为恢复旧摘要回滚有效凭据，也未对正式服务进行安装、重启或配置写入。

隔离 Linux 包、端口与数据目录继续独立；已结束验收产生的 Hermes 临时后台进程已按所属运行目录清理。版本号、正式包和仓库远端未更新。


### 9.17 原生 Task 的档位与自动选模证据

隔离原生 app 1.144.4.1467 的新一轮实际操作保存在私有 `native-high-tools/1794786838583`。Chat 选择 Argon High 后切换 Task，界面不再显示 High；Task 模型菜单只有 Hydrogen/Argon，没有思考档位选择。附加仅含随机标识的测试目录后，原生文件读取成功。最终界面显示 Hydrogen，但实际 ProcessQuery 完成响应为 category=8、variant=argon、thinking=1。因此界面模型标签不能代替真实返回模型字段。

该次实际 GenerateRequest 含 featureMode=41、isAgentChat=true、isSmartModelSelectionEnabled（56）=true，没有 requestedThinkingLevel（48）和 isFirstRequestAfterManualPickerOverride（59）。这证明该原生任务未提交 High，不证明网关能让 Task 使用 High。仍保留产品的档位限制和返回档位校验，不能把 Low 工具成功计为 High 成功。

此次 ProcessQuery 的额外 1008 消息经解码是 session context update，包含设备、时区、连接目录和同意状态的上下文；不能将其误认作 ClientToolsUpdateRequest 或已找到内联工具声明。已解析的 ClientToolsFeature 1013 等静态扩展继续只作为线索。

本轮原生取证进程在读取完成后退出；后续隔离网关实连仍须在 app 不运行的条件下进行。是否通过已发现的手动选模字段保持 High，需要独立实际验证，不据静态字段名称提前修改产品行为。


### 9.18 按用户要求仅接入 Task

用户明确纠正范围：只接入真实 Gemini app 的 Task 任务模式，停止 Chat High/Medium 的兼容探索。模型注册改为使用 host=2 的真实 Task 策略；当前公开 Hydrogen/Argon 的默认别名和 Low，共四个 ID。Chat 策略不再决定可路由模型，无客户端工具的生成及 Auto 审核也固定使用 featureMode=41，而非按工具数量切换 Chat/Task。

该首次修改包源码摘要 `6eb875d176d1c427aa08afee9810097d1f9d0ca08c37f25a96f0c94b2ece06c7`：服务器隔离安装下的本机 Pi 1.5.2，`gemini-4-hydrogen-g` 真实 read/write/read 文件逐字节一致，53.885 秒，记录 `1794788421383`。本地 Claude Auto Argon Low 用例 `1794788328074` 失败，未记为兼容通过。

Claude 失败时主生成和真实 Hydrogen 审核的 ProcessQuery 均正常结束传输，却仍报告 GOAL_STATUS_RUNNING=4，未携带最终正文。之后通过原生 ListConversationTurns 读取这两个实际任务，得到完整 SavedGenerateResponse：审核模型的真实结果为匹配工具 ID 的 not_flagged，最终 category=1/thinking=1；主任务最终说明远程工具等待超时和客户端通道断开。这证明不能把 Task RPC EOF 直接解释成任务完成或模型未生成结果。

实现新增仅针对当前任务/当前请求的结果读取：核对 conversationId、requestId（有值时）、完整当前 prompt 与已处理请求 ID，按 SavedGenerateResponse 的实际完成、失败、模型、档位和输出字段转回响应。既不重新发起模型生成，也不拼接其他账号或替客户端恢复历史。无客户端工具的任务在 RUNNING 后即读取结果，减少等待 EOF 对 Auto 审核造成的延迟；客户端工具仍只由客户端执行，审批真实结果必须另行验证。当前实现完整回归 1174/1174 通过，真实 Claude 重测正在进行，不提前记为通过。

此前手动选择字段实验 `1794787685102` 保留为历史失败：真实 Pi 工具闭环成功，但 Task 仍返回 Low，网关报模型配置不匹配。按最新范围，这不再驱动 High/Medium 接入工作。中断的图片附件取证未提交模型请求，其原生副本进程已退出。


### 9.19 Task 结果读取与等待期限

仅 Task 的后续实测 `1794788876502` 已取得三次真实 Hydrogen Low 审核、Read/Write/Read 和一致文件，但初始实现将整个 Task 的寿命限制为首次请求后的固定 180 秒，导致最后一轮被取消，完整用例仍失败。改为在每次有效客户端请求及工具交付时更新等待期限，并明确返回任务超时错误；不更改客户端权限或网关配置中的超时数值。

`1794789266563` 继续验证该修正：后续控制请求原生流结束时，没有重发 GOAL_STATUS_RUNNING，旧的读回触发条件因此漏掉最终结果。随后用相同任务的原生 ListConversationTurns 请求确实读回新增的“允许”控制轮及 finalResponse=1。读回触发改为成功结束的 Task 流尚无业务完成标记且具有已确认的任务 ID，不再要求该轮重复 RUNNING；明确失败、punt 和 fallback 不走这一正常结果读取分支。旧失败保留，新的完整 Claude Auto 及服务器 Pi 验收分别另记结果。

`1794789303095`：Linux 隔离网关下真实 dsh 0.2.1-rc.2，4 次文件/命令工具完成，目标文件逐字节一致，34.904 秒。五个主 Responses 请求结束；另一个无客户端工具的辅助请求在 CLI 结束时没有最终响应，completeSse=false，因此原验收报告整项保持失败，不将其写成完整客户端通过。

Task 结果读取只消费真实 SavedGenerateResponse：`finalResponse`、失败/中止字段、返回模型/档位、模型正文及状态事件均来自上游。当前任务和请求匹配、已消费请求排除以及失败结果拒绝有独立回归；这不替代真实客户端测试。原生应用进程已经退出，测试中的模型请求由隔离网关直接发往 Google。


### 9.20 Task 单通道当前安装包的真实验收

当前本地及 Linux 隔离安装包的运行源码摘要一致：`34a352961e43726e447fe543eae7ef28f6cc57627c80c22d515386bf1b901918`。仅提供 `gemini-4-hydrogen-g`、`gemini-4-hydrogen-low-g`、`gemini-4-argon-g`、`gemini-4-argon-low-g`，两个默认别名均为 Low。普通文本、带工具请求及服务器 Auto 审核统一使用真实 Task 配置 `featureMode=41`；Chat High/Medium 不再是产品或后续验收目标。未知 `-g` 模型拒绝，不转到 Antigravity。

| 当前包实连用例 | 实际结果 | 用时 |
| --- | --- | --- |
| `1794792512578`，本机 Claude Code 2.1.322，Argon Low，原配置和 Auto 模式 | Read → Write → Read → 最终回复完成，文件逐字节一致，流正常结束，无权限拒绝，客户端配置摘要不变 | 240.178 秒 |
| `1794792107832`，本机 Pi 1.5.2 → SSH HTTP 隧道 → Linux 安装包 → Google，Argon 默认别名 | 真实读取、写入、复读和最终回复完成，文件逐字节一致，4 个 Responses 请求均 HTTP 200 且 response.completed，无 JSON/SSE 错误 | 250.373 秒 |

Claude 的三次独立审核从真实 native 请求和响应核验：均为 Task 41、category=1、thinkingLevel=1，实际模型归属为 4 Hydrogen；生成的真实判定、工具 ID 与返回客户端的 safeguards 结果一一对应。`auto-upstream-assessment.json` 为 passed=true。客户端续轮系统文本从 26,794 字符增加到 27,477、27,646，三次完整当前请求均在原生工具响应载体中准确转发，实际工具结果保持独立；`context-forwarding-assessment.json` 的 allForwardedContextsExact=true。

Linux Pi 的实际主请求为 Task 41、category=8、thinkingLevel=1、variant=argon；最终响应核对模型、档位和真实完成状态。当前包没有依赖 Mac app 进程，也没有让网关执行文件或命令工具。完整私有 HTTP、原生帧、Task 结果读取及工具输出证据留在仓库外。两个用例证明本轮功能路径通过；约 4 分钟的完整任务耗时仍偏慢，尚未完成首字延迟与各阶段耗时归因，不能将总用时直接归因于模型思考。

以下失败和环境中断样本继续保留：

- `1794789699506`：测试期间 macOS 于本地时间 08:42:19 因合盖进入睡眠，08:51:52 才 DarkWake；超时回调在唤醒后出现。此样本未通过，不能当作已定位的 Google 或 Task 协议故障。
- `1794792253937`：隔离测试池账号的 5 小时剩余额度约 2%，低于保留阈值，网关按原规则拒绝，未向 Google 生成。没有关闭额度保护；最终成功用例选用此前已经通过看板授权且具有可用额度的另一隔离测试池。
- 9.18、9.19 的生命周期修复前失败仍分别保留；dsh 辅助请求未完成的样本仍为整项失败，不计入当前完整通过。

当前源码全量回归 1174/1174 通过，无失败、取消或跳过，`npm run check` 和 `git diff --check` 通过。代码回归不替代上述实连，也不补齐尚未覆盖的真实分支。

本轮没有改动正式安装、重启正式服务或写入正式配置。本机原 4 个账号文件与基线摘要一致。服务器先前 10 个正式账号文件中有 7 个整体摘要变化，现有证据与后台令牌刷新一致，但只有整文件旧摘要，无法逐字段证明原因；4 个非账号配置摘要未变。不得将服务器记录写成“全部账号文件逐字节未变”。

本节只结束本次 Task 范围收敛及其明确用例的验证，不代表整个双上游项目已经全部验收或正式发布。其余已承诺功能的缺口保持可见，不再继续探索 Chat 线路。


### 9.21 五客户端正常配置验收与可选模型变体字段

用户进一步明确：五个客户端须在正常配置接入后真实调用，全部通过才允许发布；任务模式多模态暂缓，速度优化后置，首次登录弹窗中条款确认与“不参与改进计划”的请求取证及自动化放在最后。本轮只调整正常接入所需的 endpoint/key/model/provider/协议选项，备份原配置并在用例结束后逐字节恢复；保留原用户目录、SOUL、MCP、技能、工具和执行权限。启动命令不再覆盖模型、provider、endpoint，不使用临时 HOME 或配置目录代替原环境。

源码摘要 `34a352961e43726e447fe543eae7ef28f6cc57627c80c22d515386bf1b901918` 的正常配置样本：

- `1794795504774`：Hermes 0.23.1，Hydrogen Low，62.938 秒，读取、写入、复读及最终回复通过，4 个 Responses 生成请求完成，文件逐字节一致，原配置恢复。客户端另有 5 个服务类型探测请求收到 404；这些不是模型生成失败，单独保留。
- `1794795592550`：dsh 0.2.1-rc.2，Argon Low，147.334 秒，6 个 Responses（含无工具辅助请求）均完整结束，文件逐字节一致，两条真实任务均为 Argon/Low，原配置恢复。
- `1794795757279`：Claude 2.1.322，Argon Low，三次 Auto 审核及读写复读完成，文件一致，但最终响应错误，整项失败。实际原生完成结果明确返回 category=8、thinkingLevel=1、归属“使用了 4 Argon 模型”，省略可选 modeVariantId。旧代码强制要求该 ID，从而误报模型不一致，随后客户端重试已终止任务得到 409。外层验收进程 330 秒看门狗最终结束该样本；不能把它记为通过，也不能把原因为正常模型耗时。

修正后的模型验证保持类别与档位严格一致：有显式变体 ID 时必须匹配；省略时仅接受真实原生 metadata 中与已验证模型完全一致的归属字段。不能用 category=8 或共享旧 modelId 单独推断 Argon，也不从模型回答正文推断，不补造返回的 ID。其他显式变体、Carbon/旧版归属、缺失归属或不同档位均继续拒绝。

当前新安装包运行源码摘要 `3f5b5f68ddd171ce6cd8db22c22b4aee05e7680abc945bb762ceaa602df98279`，全量回归 1175/1175、语法和差异检查通过。五客户端正在用该同一安装包重新验收，旧包的 Hermes/dsh 正向结果不直接计入新包矩阵。后续验收进程的外层看门狗允许 15 分钟以区分慢与失败；客户端实际请求超时和 Gateway 请求超时不因该看门狗调整而改变，不能以更长等待掩盖真实协议错误。


`1794796317500`：上述模型归属修复后的正常配置 Claude 用例仍失败，原因另记。真实原生帧显示先下发 Read 并收到结果，随后再次下发 Read；第二个读取结果尚未回传时，ListConversationTurns 已返回下一步 `Run Write?` 确认卡片，`finalResponse=1` 但任务状态是等待用户确认（2），并非整项任务完成。旧实现先检查 pending 工具数，错误抛出 `gemini_tool_exchange_incomplete`。该失败没有被计入客户端通过。

修正为：只有真实等待确认边界可以延迟交付卡片，保留当前待回传工具；收到全部真实客户端结果后再交付一次确认卡片。不会自动批准、执行工具、补造结果或把真正任务结束时未回传工具的错误吞掉。同一确认边界重复到达也不会重复生成客户端工具调用。此修正有生命周期回归；当前运行源码摘要为 `6a741c81b8a8df4c50b1750b1877067c19a35c9cd2da3baae626fee7d7076cc7`，全量 1176/1176 通过。真实五客户端验收继续以这个安装包为准。


#### 当前同一安装包的最终五客户端矩阵

所有下列用例均为本机正常安装的客户端，通过正常用户配置文件选择隔离 Gateway，再由实际安装的 Gateway 直接访问 Google Task 接口。配置调整仅涉及接入地址、密钥、provider、模型和实际需要的协议字段；未改权限、SOUL、工具或客户端源代码。不是通过临时模型/provider CLI 参数或临时 HOME 完成验收。

| 客户端与版本 | 模型 | 用例 | 完整任务用时 | 结果 |
| --- | --- | --- | --- | --- |
| claude 2.1.322 (Claude Code) | `gemini-4-argon-low-g` | `1794796712826`，4 个生成 HTTP 请求 | 272.443 秒 | 通过 |
| pi 1.5.2 | `gemini-4-hydrogen-low-g` | `1794796997711`，4 个生成 HTTP 请求 | 60.507 秒 | 通过 |
| codex codex-cli 0.167.2 | `gemini-4-argon-low-g` | `1794797070306`，3 个生成 HTTP 请求 | 112.412 秒 | 通过 |
| hermes 0.23.1（3b4215785882） | `gemini-4-hydrogen-low-g` | `1794797194860`，4 个生成 HTTP 请求 | 54.100 秒 | 通过 |
| dsh 0.2.1-rc.2 | `gemini-4-argon-low-g` | `1794797259145`，6 个生成 HTTP 请求 | 111.882 秒 | 通过 |

运行源码摘要统一为 `6a741c81b8a8df4c50b1750b1877067c19a35c9cd2da3baae626fee7d7076cc7`。五项均核对了实际文件逐字节一致、工具执行及回传、最终回复、HTTP/SSE 结束和真实上游 Task/模型/Low 元数据。Claude 额外核对三次真实 Hydrogen Low Task 审批与客户端 safeguards 判定一致，以及续轮完整上下文准确转发；dsh 包含其无工具辅助请求的完整结束。Codex 首请求 680,459 字节，工具目录从 27 个顶层条目增至 29 个，保留完整动态声明。

五项测试结束后，六份正常客户端接入配置与各自测试前备份逐字节一致，五个隔离 Gateway 进程全部退出。本机和服务器正式进程仍运行，未对正式 Gateway 安装或配置执行更新。完整私有矩阵、配置摘要、原生证据和清理结果保存在仓库外；前述失败记录没有删除或改记成功。

本矩阵达到本轮“五个客户端正常配置后真实调用”的核心验收门槛；不代表已经覆盖每个模型在每个操作系统上的全部工具、搜索和故障分支，也不替代原 Antigravity 的实连回归。当前没有发布；后续按用户确定的次序推进，Gemini 任务多模态暂缓、先可用后优化耗时、首次登录弹窗流程最后处理。

### 9.22 同一最新安装包的 Linux 五客户端正常配置验收

矩阵 `configured-matrices/1794808415515/matrix.json`：五个本机客户端分别通过自己的正常配置连接 Linux 隔离安装实例，Google 请求由 Linux 进程直接发出，不依赖本机 Gemini 应用。源码摘要与 9.21 一致，为 `6a741c81b8a8df4c50b1750b1877067c19a35c9cd2da3baae626fee7d7076cc7`，安装 tarball 摘要为 `bc44a517de3da01b7cafcda7a48b43a3a643c72c1095b6c1330d3188d007899f`。服务运行于 Linux x64、Node 24.22.1；正式端口和服务没有用于本矩阵。

| 实际客户端 | 模型 | 私有用例 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.322，Auto | Argon Low | 1794808415660 | 216.126 秒 | 工具闭环、真实 Hydrogen Low Auto 判断、完整上下文逐项核对通过 |
| Pi 1.5.2 | Hydrogen Low | 1794808640627 | 37.059 秒 | 真实 read/write/read、文件字节与 Responses 结束事件通过 |
| Codex CLI 0.167.2 | Argon Low | 1794808694622 | 135.619 秒 | 完整真实工具与最终响应通过 |
| Hermes 0.23.1，build 3b4215785882 | Hydrogen Low | 1794808839903 | 64.255 秒 | 完整真实工具与最终响应通过 |
| dsh 0.2.1-rc.2 | Argon Low | 1794808942959 | 112.571 秒 | 完整真实工具、辅助请求与最终响应通过 |

五项均核对实际 native Task 类型 41、模型类别及 Low 思考元数据；各客户端正常配置在用例结束后恢复。服务端原始捕获通过 SSH 下载至私有目录，再按本用例实际请求标识筛选核验，避免混入其他测试流量。SSH 只连接测试 HTTP 入口，不是上游应用桥接。上述结果覆盖这一真实功能矩阵，不表示全部错误分支或 Windows 实机已通过，也不将耗时计为优化结果。

### 9.23 十个浏览器账号的看板授权与实际生成

范围澄清：本节的十次生成是授权流程中的无工具 `只回复 OK` 探测，不是十个账号分别完成真实 agent 工具任务。授权入口包含初始化逻辑，不能将本节当作“未经条款确认也能执行任务”的对照实验。新的固定账号真实任务结果见 9.25。

本轮使用 Chrome 中已登录的十个 Google 账号，逐一执行实际看板“添加 Gemini 账号”，不是批量导入凭据，也不是直接复制本机应用登录态。即使其中四个此前已有隔离授权，本轮仍重新完成授权与生成，不能将旧记录算作本轮成功。

私有 `account-onboarding-batch/completed.json` 记录 A01–A10 的独立授权开始时间、完成时间、状态、额度验证与活动偏好；真实 RPC 和 Task 帧保存于 `dashboard-implementation/runs/1794808026151`。十个账号均在本轮返回完整非空 Task 生成，使用公开模型别名 `gemini-4-hydrogen-g`（Hydrogen Low）；账号在生成验证成功后才启用。十个账号的活动记录均经接口读回为关闭。

本轮十个账号均已具备当前客户端的条款初始化状态，`acceptedTermsVersion=null`；没有遇到必须打开原生应用才能恢复生成的账号。真正待初始化账号的状态 7 → 条款版本 9 → 活动记录关闭 → 状态 1 → 首次生成证据仍见 9.11，本轮重复授权不替代该证据，也不证明十个账号都是免费账号。新增授权保存于仓库外隔离账号池，正式账号池未因此增加或合并账号。

### 9.24 原 Antigravity 线路的本轮实连限制

Linux 最新隔离包使用正式池账号的受限副本，真实 Pi 正常配置请求 `gemini-3.8-flash-high`。用例 `1794809836568` 返回 HTTP 200，但 SSE 为 `resource_exhausted`，47.452 秒结束，工具和输出文件未完成，**不得记为回归通过**。

随后将该真实 Pi 的完整第一条请求逐字节原样提交现有正式服务器，得到相同 `resource_exhausted`，47.123 秒，无 `response.completed`。两次请求体摘要同为 `43d141480011116eca298dac8275d791c5001bd5c21d30662151865636a3d236`，对照证据为私有 `account-onboarding-batch/formal-agy-comparison.json`。此对照支持该样本存在原有上游资源/额度限制，不能据此声称整个 Antigravity 回归已通过，也不能仅凭错误文本确定是哪个额度窗口。

另保留 `1794809656125`：验收器先复制账号、后调用一个已经以空 Antigravity 池启动的测试进程，导致 `account_pool_unavailable`。该次是验收实例准备顺序错误；仅重启隔离实例重新加载账号后，才进行了上述有效上游对照。没有清除正式池健康状态或调整额度保护来制造成功。

### 9.25 十账号固定身份的真实 Pi 任务基线

2026-11-16，私有批次 `single-account-task-1794812256593` 使用同一个本机 Pi 1.5.2、同一个 `gemini-4-hydrogen-low-g` 模型和完全相同的文件读取、原样写入、读回核对任务，逐个测试十个账号。每个隔离安装实例只装载对应的一份 Gemini 凭据，Antigravity 池为空；原账号文件未改动。测试前不调用看板添加或初始化入口。私有观察器验证凭据所属账号，并阻止及记录初始化或条款、偏好写入；没有替换成功响应、生成内容或工具结果。产品运行文件仍为 9.21 的 `6a741c81…` 同一摘要。

| 账号标签 | 完整任务耗时 | 结果 |
| --- | --- | --- |
| A01 | 48.573 秒 | 通过 |
| A02 | 39.347 秒 | 通过 |
| A03 | 0.847 秒 | 额度保护阻断，未进入模型生成，失败 |
| A04 | 51.978 秒 | 通过 |
| A05 | 42.853 秒 | 通过 |
| A06 | 45.130 秒 | 通过 |
| A07 | 44.630 秒 | 通过 |
| A08 | 59.776 秒 | 通过 |
| A09 | 47.784 秒 | 通过 |
| A10 | 50.271 秒 | 通过 |

九个通过样本共 36 次完整 Responses 响应、27 次实际 read/write/read 工具执行；文件逐字节一致，最终标识、HTTP/SSE 结束、真实 Task 41、Hydrogen 与 Low 元数据均核对通过。十轮固定账号检查通过，无账号切换、无初始化调用、无 AcceptTermsOfService / UpdateUserPreferences 请求。Pi 正常配置在每轮结束后恢复，最终两份原配置摘要均一致。上游用量继续未知，不能将客户端的 0 Token 记为实测用量。

A03 的 Google GetUsageInfo 返回五小时额度已用约 98%、剩余约 2%，低于网关保留的 10% 保护线；周额度剩余约 93.87%。客户端收到 HTTP 200 内的 `account_quota_protected` 失败 SSE，没有 ProcessQuery / ExecuteRemoteTools。该失败属于网关依据真实额度作出的准入保护，不能写成模型生成成功或 Google 因条款拒绝生成。上游窗口重置时间为 `2026-11-16T08:04:57.167Z`，未据此假定已恢复。

基线结束后仅尝试在正式 Gemini 应用检查 A03：菜单可见对应账号，但切换与后续窗口/状态读取连续超时，无法核实是否出现弹窗。没有点击确认，没有重启或关闭应用，也没有取得确认请求或确认后复测证据。应用检查明确未完成，不记为“无弹窗”。

本批整体为 **9 通过、1 失败**。十个账号在本轮 GetUserStatus 都返回 1，且此前已有初始化历史；本批不构成从未初始化账号的实验，不能证明首次确认限制消失。完整账号映射、原始请求、工具结果、隔离身份记录、失败和清理证明均保存在上述仓库外私有批次目录。没有发布或更新正式部署。

### 9.26 删除未经实证的 Auto 路由拒绝条件

用户要求删除此前按假设添加的“无法关联上游就拒绝审批”逻辑。核对本轮保存的 538 份响应、报告和日志，没有发现该错误的真实样本；9.21 与 9.22 的两组 Claude 请求均在各自四轮中携带一致的显式会话标识。历史上确实存在独立分类器请求，但不能据此推断它没有会话关联。此前将该防御分支称作已经发生的兼容故障不准确，不将这项假设作为后续开发或上线阻塞项。

当前行为：独立审批沿用同一会话最近主请求的上游，Antigravity 使用 Flash Low，Gemini 使用 Hydrogen Low；没有会话记录时保留原有 Sonnet 5 → Flash Low 路由。新增 Gemini 账号不再引入额外拒绝条件。默认服务器 safeguards 继续按触发请求的模型选择审批上游。未改客户端审批设置、审批政策、上游真实错误或审批结果。

本次安装包运行源码摘要 `3c7a39b87646c2db4df8be54e76c475653742add64c351d6823517f42edfb5e2`，tarball 摘要 `aa5b4b78899023141d58d0245aedfae26716286dd7923fc3362db9f915eedfca`。9 项定向回归、101 个运行时及脚本文件语法检查和差异检查通过。定向回归覆盖按会话关联、不同会话隔离、会话切换上游，以及保留既有默认分类路由；不将这些本地检查当作真实上游调用。

真实验证保存于私有 `auto-routing-cleanup-1794816259038`：

- 取自此前真实 Claude 调用的完整独立 severity 审批请求，保持 `claude-sonnet-5`、原政策、上下文和全部 body 字段，经新安装的隔离 Gateway HTTP 入口实连 Google Antigravity API。该实例同时装载两类账号池，且没有预先添加主请求记录。请求体摘要 `7fe706162f7cc4006548ac48613cca330636b7ffb64eda45e0fdb5719b0c962a`。实际只发出一次 Flash Low 请求，thinkingLevel=LOW、maxOutputTokens=4096；26.286 秒正常结束并返回完整 severity 判定，用量 input=31615、output=83。没有执行被历史审批请求描述的工具。这是完整真实请求重放，不是新启动客户端的独立审批闭环，也不证明此前发生过缺少关联的故障。
- `installed-http/runs/1794816342791`：当前 Claude Code 2.1.322 通过正常用户接入配置连接新包，Auto 模式、Argon Low，完整读取、写入、读回及最终回复通过，234.250 秒。三次真实审批均使用 Gemini Hydrogen Low Task，与客户端收到的判定一致；主任务保持 Argon Low。完整流结束、文件字节、工具结果和无权限拒绝均核对通过。接入配置在结束后逐字节恢复，没有设置分类器模型或审核路径覆盖。

私有验收器首次启动时误用了观察器导出名称，Gateway 尚未启动便退出；仅修正验收观察器后执行上述实际请求，启动失败记录独立保留，不作为产品上游失败。两个隔离 Gateway 均已退出。未发布、未部署正式服务、未变更版本号。
