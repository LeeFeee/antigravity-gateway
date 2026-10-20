# Antigravity Gateway

[中文](#中文) · [English](#english)

## 中文

Antigravity Gateway 是一个本地 Anthropic/OpenAI 兼容网关。它复用官方 Antigravity CLI（`agy`）的登录状态，让 Claude Code、Codex CLI、Trae 及其他兼容客户端通过本地接口调用当前账号可用的模型。

默认使用原生 Cloud Code 直连，不启动 `agy` Agent 子进程，也不整套覆盖客户端系统提示词。当前源码按已抓包的 agy 格式封装上游消息、工具和会话元数据，并适配已识别的固定身份句及等价工具表达；用户要求、项目规则和真实执行语义保持不变。客户端选择什么模型，网关就把该模型 ID 原样发送给上游；只有 Claude Code Auto Mode 的分类请求使用独立的快速模型。

> 非 Google 官方项目，仅用于学习、兼容性研究与个人测试。模型权限、额度、地区限制和服务条款均以上游为准。

当前版本：`v1.7.0`。详细更新记录见 [CHANGELOG.md](CHANGELOG.md)。

v1.7.0 汇入 Cloud Code 上游请求转译和 macOS Argon／Robin 三客户端适配，保留统一的对外接口与既有账号调度。合并后的本地回归共 704 项；Cloud Code 阶段的三类真实客户端、上下文/工具续接和原功能回归见 [最终验收矩阵](docs/agy-acceptance-matrix.md)，原始抓包及各阶段过程见 [实施记录](docs/agy-fidelity-plan.md)。下方按阶段保留的测试数量、待验证项和重试实验不替代本版边界，也不代表所有模型、客户端未来版本或 Google 内部识别信号都与官方客户端一致。

macOS Argon／Robin 现已接入三个客户端的定向适配：复用可逆工具映射，但通过 Robin 原生 MCP 目录与双向工具流传输，不套用 Cloud Code 请求结构、agy 身份或额外工具元数据。用户 SOUL、项目规则、权限和非等价工具保持原样，Windows 通道不启用这套改动。协议边界及验证记录见 [Robin 客户端适配](docs/robin-provider.md#macos-robin-客户端定向适配)。

v1.7.0 的执行边界（2026-10-20，优先于下方较早的实验记录）：网关做双向协议翻译，不代替 agent 决定任务恢复。默认恢复原网关有限传输重试，不插入隐藏的“继续任务”消息，不因旧断流终止记录阻止 agent 重试；原显式 `ANTIGRAVITY_DIRECT_RETRY_POLICY=agy` 配置仅作为兼容选项保留，不再默认开启。客户端提交的上下文是依据，能匹配的原始签名与工具映射尽量复用，不强制恢复旧任务。

已实现并实测 Claude Code 2.1.285 的 `Read ↔ view_file`、`Write ↔ write_to_file`：Google 侧使用原生工具名称/参数，客户端仍执行自己的工具和权限逻辑，工具结果再按实际原调用恢复名称及签名。保留读取范围、PDF 页码和写入覆盖语义，不虚构字节偏移、追加写入或后台执行能力；不等价的能力不冒称官方声明完全一致。只识别匹配的客户端版本、工具描述和 Schema，未知工具/版本或名称冲突保持兼容路径。已识别 Cloud Code 客户端的固定身份句使用官方表达，不新增“协议兼容客户端”身份声明；用户文字、项目规则和任意提示中的工具名不做全局替换。此处的 Cloud Code 身份和签名逻辑不应用于 Gemini App；macOS Robin 只复用可逆能力映射，并使用自己的原生 MCP 通道，Windows 保持原路径。

已增加实际捕获的 Hermes 0.21.7 CLI 固定框架及四类工具适配：`read_file/write_file/patch/terminal` 对应 `view_file/write_to_file/replace_file_content/run_command`。保留分页、模糊替换、写入保护、终端秒数超时与通知参数；按独立固定块识别，SOUL 自定义身份和项目上下文逐字保留，不把通用 OpenAI SDK 请求头当 Hermes 身份，也不虚构会话 ID。正式安装包已在正常加载 SOUL/AGENTS.md 的真实 CLI 中通过工具执行、首次回执前网关重启及恢复会话，并保留项目规则和先前记忆。已捕获编码说明中的旧 `mode` 提示与实际工具 Schema 不符，因此仅在该固定块内去掉不可执行的旧提示，不新增虚假参数。未知或重复歧义模板保持原兼容路径；延迟加载工具仍使用客户端原协议，不主动展开或增加能力声明。最终全量 686 项回归通过，69 个运行时文件与正式包一致。

同一适配层已扩展到 `Edit ↔ replace_file_content`、`Bash ↔ run_command`。精确匹配文本、替换全部开关、命令原文、执行超时、后台开关、说明和沙盒请求都双向保留；仅转换字段名，不执行命令、不放宽客户端权限。执行时限使用必要的 `TimeoutMs`，后台开关使用 `RunInBackground`，不误称 `WaitMsBeforeAsync` 或 `IsDaemon`；不声明客户端没有的行号限定编辑、独立 `Cwd`、持久终端等能力。工具说明中的已知参数及已适配读取工具引用同步转换，保留先读后改、Git 操作授权等原约束。正式安装包经真实 Claude CLI 完成 Read→Edit→Bash，网关重启后再次 Bash；上下游原始报文验证调用、结果关联与原签名保持一致。本地全量回归 664 项通过；真实测试为 macOS/Flash High 前台命令，不代表后台执行、所有客户端或全平台均已线上验收。

正式 npm 包已在 Linux ARM64 容器及 Linux x64 架构仿真容器中完成安装、原生二进制运行和各 553 项回归，无失败或跳过。测试没有账号凭据，传输数据来自容器内真实套接字；握手稳定字段与现有 macOS 官方 agy 样本一致，但不代表已完成 Linux 官方 agy 同平台对照、实体 x64 主机或 Windows 新传输验收。

Codex CLI 0.159.2 的实际 Responses 请求已接入 `exec_command ↔ run_command`、`write_stdin ↔ manage_task`、`view_image ↔ view_file`。仅匹配已抓取的版本、originator、会话头与兼容工具 Schema；命令、工作目录、等待时间、输出限额和权限请求双向保留。后台工具只支持真实可执行的 status/send_input，不声明 list/kill；图片工具仍仅看图，不虚构文本阅读能力。`apply_patch` 的多文件补丁语法保持原自定义工具，不冒充单块替换。真实正式包验证同回复双命令、回执前网关重启、原生补丁、后台会话输入与图片数据回传；672 项本地回归通过。识别信息只存本地，不新增上游身份字段，不接管客户端执行或授权。

已补测真实 Claude Code CLI 的 `Read → Write → Read` 和网关重启后续聊；客户端会话头仅用于本地映射，系统/环境消息不再计入用户轨迹步数。带工具声明的请求仍沿用整轮完成后发送的既有策略，不能把 SSE 心跳当成首字输出。

已补测真实 Codex CLI 的 Responses 并行工具、`apply_patch` 自定义工具和工具回传前重启。Codex 将同一回复拆成文字与多个调用项时，Cloud Code 转换会重新组成该模型步骤，再按严格历史前缀恢复真实上游签名；不会把并行调用各自算成一个模型步骤。这一合并不修改 Gemini App 通道收到的归一化消息。

Cloud Code 私有会话状态使用原子发布的非空目录锁。每个持有者拥有唯一归属文件，进程退出后的并发清理不能删除新持有者的锁；取消等待只清理自己的候选目录。真实 8 进程压力测试已复现并修正旧文件锁在恢复遗留锁时丢失计数的问题。这里的锁与归属数据仅保存在本地，不成为上游请求字段；Linux 正式包已运行现有多进程锁回归，Windows 的实际运行验收仍待完成。

普通文本生成的取消状态也已按官方 agy 实抓修正：尚未收到模型内容时不增加回答步骤；已收到思考或正文时保留该步骤，并更新原生执行标识。未完成思考不回传上游，部分正文只在客户端确实提交相同历史时恢复；客户端丢弃的部分不会自动补回。网关不会伪造官方进程重启时的后台任务通知。工具调用/压缩中途取消、强制杀进程及任意截断片段仍需分别验收。

同一账号、会话中切换官方目录已有的 `gemini-3.8-flash-high` / `medium` / `low`，现按官方实抓保留此前真实文本和工具调用签名；仍要求完整历史前缀与内容精确匹配。仅此三种已测模型开放跨模型复用，不推广到其他模型或跨模型生图回执。生成参数优先取实时目录，三种模型的实抓离线基线分别为 `thinkingBudget=-1/4000/1000`、最大输出 `65536`。这不是给 Gemini App Argon 添加档位，也不改变默认模型。

Cloud Code 的纯图片/文字附图消息已按实抓 agy 格式发送，不再携带网关的 `attached_media` 标记。引用文件保存在私有 `state/agy-sessions/images/`，同一会话的路径和包装时间跨重启稳定；图片编辑仍可使用这些路径，旧附件 ID 也保留兼容。缓存按 24 小时未使用及默认 256 MiB / 1024 文件阈值在请求时清理，当前请求用到的图片受到保护，不删除 Files API 上传或已生成图片。其他媒体和混合媒体的上游布局仍待核对。

非图片与混合附件也不再发送随机媒体 ID 或 `attached_media` 私有标签。必要文件名保留为紧邻附件的普通文字，媒体 MIME 与原始字节不变；这修正了同一附件每轮重新解析后前缀变化、导致回答签名恢复失败的问题。官方 agy 的音频/PDF/视频 `view_file` 结果与续聊已抓包，网关对应真实工具回传、重启和 Argon 视频转路由均已验证。用户直接附非图片文件的完整官方布局仍未捕获，当前保留兼容语义，不伪造工具调用，也不宣称这条布局已与 agy 完全一致。

Cloud Code 的普通对象型 JSON Schema 输出按官方 `agy --json-schema` 实抓使用 `finish` 终结工具，首次请求即携带输出字段，不增加 `responseSchema` 或网关专有字段。客户端只收到通过原始 Schema 校验的 JSON；官方工具附带的 `toolAction` / `toolSummary` 留在原生历史中。精确匹配的客户端历史可跨网关重启还原实际签名与完成结果。强制客户端工具、同名工具/属性、特殊根 Schema 和压缩请求保留既有兼容路径，不冒充已验证的原生情况；Robin、Windows 不使用这一转换。

客户端显式标记失败的工具结果，现在按官方 agy 实抓的 `Encountered error in tool execution:` 文本送入 Cloud Code 的 `functionResponse.response.output`，不新增错误 JSON 字段，也不丢掉 `is_error` 的语义。错误原文、附件和顺序保留；已有原生错误包装不重复添加。网关不知道外部工具的真实执行时间，不伪造 Created At / Completed At。普通成功结果不根据文本里是否出现 error 来重新分类；Gemini App 两条通道不变。

Cloud Code 的 503/429 重试现按官方实抓更新原生错误步数和请求时间戳，逻辑请求计数、轨迹、正文及签名保持不变；后续工具结果与重启续聊沿用实际步数，不添加错误消息或私有字段。重试调度的最新实测范围见下文。鉴权刷新、网络异常、压缩及其他未抓取失败场景不凭推断套用这一规则。

已进一步实抓 400 终止、429/503 重试耗尽以及 503 退避期间取消：错误步骤在收到错误时即保存，不再等到下次重试才记账；最终失败会保存执行边界，网关重启后续聊仍保持正确计数。已取消的请求不会再等待一个刚注册的退避计时器。正式安装包四组真实 HTTP 对照及真实 Claude Code Read/重启续聊通过，564 项回归通过；当时官方持续 429/503 各发出 9 次，网关原策略各 4 次；该调度差异现已在下述限定范围修正，历史证据仍保留。

原始线包进一步确认：模型目录、额度等已抓取的元数据查询使用 `Content-Length`，生成请求使用单个 HTTP 数据块及结束块。网关现在区分这两类请求，避免将查询也误设为 chunked。按官方连接顺序、相同报文字节和等长假凭据进行的本地对照，10 份脱敏 HTTP 线包及对应 TLS 记录长度序列全部一致；这些旧请求未重放到 Google。独立真实 Google 长上下文、工具与恢复，以及本地 Claude Code 另行验证通过。真实业务内容及连接调度不相同，不能把受控对照扩展为全链路或 Google 内部不可识别的结论。

生成图片按实际 MIME 保存为 `.jpg` / `.png` 等文件，旧 `.bin` 产物仍兼容。客户端仍收到原有交付回执；在同账号、同会话、同模型且完整前缀与已发回执匹配时，网关将其还原成此前真实发生的内部生图工具历史，不把客户端回执当作上游对话正文。该映射只存在私有会话状态，包含网关生成的工具结果和图片，受会话状态容量与过期限制，不是全部只存散列。真实 Claude Code 已完成生图 → Read 返回图片内容 → Write → 网关重启续聊。这里采用了实抓文件工具的文本结果结构，额外生图工具及交付说明仍是必要兼容语义，并非已证明与官方生图请求完全一致。

默认 `gemini-3.8-flash-high` 的已实抓 429/500/502/503/504 使用 agy 1.4.2 调度：普通 agent 最多 9 次、checkpoint 最多 5 次，均重试同一端点；agent 从 4 秒起按原生向下抖动退避，名义上限 30 秒，checkpoint 默认间隔 1 秒。忽略 HTTP `Retry-After`，但采纳 429 正文的标准 `google.rpc.RetryInfo`；9 秒实际等待，超过 30 秒停止当前账号重试并交回既有账号池处理。真实 CLI、旧/新正式包和真正 Claude Code Read/重启续聊已抓包对照；随机等待值不要求逐次相同，不宣称 Google 内部无法区分。

重试兼容设置仅在本地生效：`ANTIGRAVITY_DIRECT_RETRY_POLICY=agy|legacy` 可显式选择。未设置策略但配置了原来的 `ANTIGRAVITY_DIRECT_MAX_RETRIES` 或 `ANTIGRAVITY_DIRECT_RETRY_BASE_MS` 时，保留旧参数的轮次与 daily/normal 回退语义；显式 `agy` 优先并使用上述固定策略。其他模型、未验证 HTTP 状态、运输层异常、独立生图及 Gemini App 两条通道不套用新规则。账号权重、亲和性、冷却和跨账号轮询算法不变。

同一正式测试包已补充两个真实 Cloud Code 账号的新会话选号、客户端隔离、故障切换和重启续聊：真实 Claude Code 执行 Read，原账号遇到明确标记的本地 429/RetryInfo 31s 后由另一账号向 Google 完成请求，重启后仍正确续聊。客户端主动回传的工具签名保留；另一个客户端即使提交相同普通对话历史，也不恢复前者的私有回答签名。本轮 20 份推理请求中 18 份为完整 Google 200、2 份为未转发 Google 的本地故障注入，另保留一组未进入推理的准备脚本失败。77 份 ClientHello 的稳定字段及主模型 HTTP/原生外层结构匹配官方样本；客户端系统指令、工具名称和显式输出上限仍不同，不宣称完整请求或 Google 内部判别不可区分。这是 macOS/Flash High 的部分验收，不外推 Windows、Linux 或 Gemini App 两条通道。

Cloud Code 私有轨迹/签名缓存还绑定账号的 Google subject（缺失时使用规范化邮箱；两者皆无时按授权凭据隔离），不再只信任可复用的本地账号 ID。真实同 ID 身份替换已复现并修正旧签名误用；同一已知身份的 token 刷新仍保持轨迹，客户端主动提交的工具签名不删除。旧的未绑定身份缓存不自动迁移，已有客户端历史仍照常提交，只重新建立私有轨迹与缓存；不改账号 ID、凭据格式、轮询规则或上游字段。身份缺失且授权发生轮换时，宁可重新建立私有状态，不猜测两个 grant 属于同一人。

已修正实抓的 Flash High 工具结果后 SSE 读流中断：默认原生策略保留已收到的部分正文、不重放未完成思考，加入 agy 的原生恢复提示并推进两个步骤及一个逻辑请求。恢复提示只在严格绑定账号身份、会话、模型和完整历史前缀的私有记录中保存，不允许普通投影插入任意 user 消息；客户端仍接收连续回答。中断记录在退避前落盘，重启或取消不会创建未发送的逻辑请求，也不补回客户端删除的原始上下文。

真实 agy 连续 9 次断流确认最多自动续写 8 次，最后的网络错误消耗终止步骤但不再追加第 9 条恢复提示。正式安装包的真实 Claude Code 已验证正文/思考中断、实际 Read 不重复、网关内部续写及重启后历史/签名保持：两组上游步骤均为 1/3/5/7，不再由 Claude 改为非流式重发原历史。另一次真实 Claude 连续九次中断验证了上限；SDK 在预算耗尽后仍可重试，但网关保留真实隐藏恢复历史，不再退回原历史。过程中真实 401 刷新后保持轨迹与请求体，原始失败样本保留。无响应内容、半个工具调用、checkpoint、其他模型或未知运输错误尚未套用这条规则；不要把该边界修正等同于所有网络故障和完整指纹验收完成。

### 主要功能

进一步真实抓包已将上述恢复扩展到 Flash High 首轮纯对话，并统一 HTTP/读流连续失败预算与退避序号，避免交替故障重新从 4 秒开始或多发第十次自动请求。恢复段的思考只在客户端汇总一次，不再在正文后重复造成 Claude 空 result；未完成思考仍不进入上游历史。第九次终止若留下部分 model 正文，相同历史的客户端重试在本地返回不可重试的 400，等待新的用户消息，不再把 model 结尾请求发给 Google，也不虚构继续指令。此前 409 导致 SDK 重试十次，现已由两个真实 Claude 样本验证各只拒绝一次，随后停止，重启后仍能续聊。

真实 Claude 思考中断及混合故障恢复通过；正文恢复长回答有一组在约 300 秒收到“网关请求超时”，原始 SSE 和时序已确认它来自原有整请求期限而不是 Google 504；保留期限和失败样本，同一会话重启后正确回忆，不宣称已解决所有恢复和延迟问题。635 项本地回归通过，完整原始证据、旧/中间失败包及边界见 `docs/agy-fidelity-plan.md`。Gemini App 两通道和原有账号调度不改动，本次未重新做其线上验收。

恢复途中真实取消也已与官方 agy 对照：Claude 2.1.285 在客户端历史里写入的精确取消状态消息对，仅在匹配实际取消记录、同身份/会话/模型、完整历史前缀和已发部分回答时留在本地，不作为普通 user/model 对话上传。未知客户端、修改后的内容、正常正文、HTTP 失败和网关超时不触发过滤；新消息、已收到部分正文和原生恢复提示仍保留。实际 SIGINT、正式包重启和同会话续聊验证通过，其他取消/工具阶段不据此泛化。

空 SSE 内容阶段的读错误已另行实测并修正，不套用上述“部分回答续写”：保留同一个逻辑请求和原始正文，只增加错误步骤；与 HTTP 失败共享九次预算和退避，不插入模型回答或恢复提示。真实正式安装包的 Claude 测得约 4016ms 重试，官方样本约 4015ms；重启续聊保持原历史。九次混合失败后 Claude SDK 仍会重新请求，实抓五次请求被原有账号冷却在本地拒绝，之后新逻辑请求成功；这不是网关内部第十次重试，也不宣称整套客户端行为等同官方。该阶段 640 项本地回归通过；原始报文、故障注入失效样本及验收边界见开发记录。

完整带签名工具调用后的读流错误也已按官方实抓修正：只有收到完整 SSE 事件（终止空行）才交付工具，不要求先收到 STOP；保留真实调用、参数及签名，收到客户端实际工具回执后再接入原生中断历史，不重新生成该调用。仅收到 JSON 数据行但没有事件终止空行，不算已收到工具。连续工具断流沿用同一失败预算；第九次仍交付实际工具调用并保留真实结果，但不再追加恢复 user 或自动请求 Google，同一回执的客户端重试在本地以 400 停止，新用户消息可恢复。真实正式安装 Claude 已验证单次/连续两次断流、终止及重启续聊，工具各执行一次。最新 649 项本地回归通过；双工具实测均串行，不能据此宣称并行工具中断、结构化 finish、半参数或所有平台/模型已经验收。Gemini App 两通道和原账号调度不改动，整体指纹目标尚未完成。

Cloud Code 已补齐实抓的 Claude Code 2.1.285 自动压缩转换：完整压缩指令指纹匹配后，使用同轨迹 checkpoint 和 16384 输出上限，压缩不额外递增 agent 请求计数；随后把已识别的客户端摘要放入 `CONTEXT_SUMMARY`，摘要正文、恢复指令和工具定义不变。仅保存被客户端暂时省略的已完成回答的计数元数据，不补回删除的历史或挪用旧签名。未知版本、自定义压缩指令和未验证格式保留原兼容路径，不按“总结”等关键词猜测。官方真实长上下文自动压缩与正式安装包的真实 Claude Code/重启续聊已验证；checkpoint 429/500/502/503/504 重试只更新时间戳，最终 400/429/500/502/503/504 失败仅记一个错误步骤，取消不安装部分摘要，失败/取消后更新执行边界。普通 agent 对这些已实测 HTTP 错误则逐次计步，不能混用 checkpoint 规则。最新 635 项回归通过；已验证的重试调度范围见上文，不代表所有模型、网络状态或跨系统验收完成。Gemini App 两条通道不使用该转换。

- 同时提供 Anthropic Messages、OpenAI Responses 和 Chat Completions 接口。
- 支持 Claude Code、Codex CLI、Trae 和其他兼容客户端。
- 支持前台运行，以及 macOS、Linux、Windows 后台保活和开机自启。
- 支持自动导入本地 agy 账号，也可以输入 `add` 手动添加账号。
- 支持通过独立 Gemini 账号池反代 `gemini-4-argon`：`add-gemini` 保持原 Robin OAuth；`add-gemini-win` 新增 Windows 浏览器会话和 WebChannel 请求。两种凭据分开保存，复用统一接口和调度。
- 多账号之间轮询；同一会话保持账号一致，限流、认证或额度异常时自动尝试其他账号。
- 启动界面显示账号状态、历史用量、Token、缓存命中率和最近24小时图表。
- 支持客户端工具调用、SSE、Claude Code Auto Mode 和结构化输出。
- 支持图片生成、参考图编辑，以及图片、视频、音频、PDF 和普通文件理解。
- 支持 OpenAI Images/Files 接口，并让远程客户端先上传文件再在对话中引用。

### 使用条件

| 条件 | 说明 |
|---|---|
| Node.js | 20 或更高版本；npm 随 Node.js 一起安装 |
| Antigravity CLI | 已安装 `agy`，并至少完成一次登录和正常对话 |
| 操作系统 | macOS、Linux 或 Windows，ARM64/x64 |
| 网络 | 当前电脑能够正常访问 Antigravity/Google 上游服务 |

安装器会自动检查 Node.js 版本、操作系统、CPU 架构和临时目录，并由 npm 处理项目依赖。`agy` 及其登录账号是使用前提，不由本项目自动安装或注册。

没有 Node.js 时，可使用以下任一方式安装：

macOS（Homebrew）：

```bash
brew install node
```

macOS/Linux（nvm）：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

Windows PowerShell：

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
```

也可以从 [Node.js 官方网站](https://nodejs.org/en/download/) 安装 LTS 版本。

### 安装

一条命令全局安装，不需要克隆仓库，也不需要进入项目目录：

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

验证版本：

```bash
antigravity-gateway --version
```

部分 npm 11 版本会提示 `install scripts not yet covered by allowScripts`。如果最后显示 `changed 1 package` 且命令可以运行，说明安装已经完成；该提示不是网关运行错误。

### 启动

前台模式：

```bash
antigravity-gateway
```

默认监听：

```text
Anthropic: http://127.0.0.1:9897
OpenAI:    http://127.0.0.1:9897/v1
API Key:  antigravity-gateway（网关未设置专用 Key 时可使用任意非空内容）
```

关闭终端或按 `Ctrl+C` 会停止前台网关。

后台保活并设置自动启动：

```bash
antigravity-gateway service start
```

管理后台服务：

```bash
antigravity-gateway service status
antigravity-gateway service restart
antigravity-gateway service stop
antigravity-gateway service logs
antigravity-gateway service uninstall
```

重复执行 `service start` 会更新配置并重启现有服务，不会创建重复服务。后台模式没有交互输入框；需要添加账号时，先停止后台服务并以前台模式启动，添加完成后再执行 `service start`。

打开 Token 用量看板：

```bash
antigravity-gateway stats
```

网关启动后，无论使用前台模式还是后台保活模式，都可以另开一个终端执行这条命令。看板复用网关现有的 `9897` 端口，不会启动第二个后台服务；也可以直接访问 `http://127.0.0.1:9897/dashboard`。

如果 `agy` 不在默认位置：

```bash
antigravity-gateway --agy-path "/absolute/path/to/agy"
```

Windows：

```powershell
antigravity-gateway --agy-path "C:\path\to\agy.exe"
```

### 账号池

网关启动时会检测当前官方 agy 登录账号：

- 账号池中没有该账号：自动保存到账号池并立即参与请求。
- 已存在同一账号：不重复添加，也不使用本地登录态反复覆盖已保存凭据。
- 账号池非空后：请求以账号池凭据为主。

手动添加其他账号：启动前台网关，在 `gateway>` 后输入：

```text
add
```

网关会尝试打开浏览器，同时在终端显示完整授权链接。浏览器没有自动打开时，复制链接到浏览器完成授权。远程服务器无法访问 localhost 回调页时，把浏览器地址栏里的完整回调 URL 粘贴回 `gateway>`。

查看账号池：

```text
acc
```

新会话会在可用账号之间轮询，同一会话尽量保持在同一账号。终端会为每次上游尝试打印实际账号：

```text
[Antigravity Gateway] 路由账号=user@example.com source=managed-account model=gemini-3.8-flash-high attempt=1
```

账号文件保存在：

```text
~/.antigravity-gateway/accounts/
```

账号池凭据以普通 JSON 保存，Token 刷新后会同步更新。请自行管理本机文件和账号使用风险。

#### Gemini App / Argon（开发中）

**Windows 原生通道（基于 1.5.1 增量实现）**：在 Windows 前台终端输入 `add-gemini-win`，打开系统已安装的完整 Chrome/Edge。登录阶段不带调试或自动化参数；登录 Google、进入 Gemini 并完成网页确认后，关闭本次专用窗口，网关自动读取会话并保存到 `gemini-win-accounts/`。不需要 Gemini App，不发送模型试探请求，不因 Argon 暂时没额度而拒绝保存登录态。原 OAuth 保存在 `robin-accounts/`，同一 Google 账号的两种凭据可以并存，不会互相覆盖。

Windows 新通道支持文本、SSE、客户端工具兼容协议、结构化输出和账号持久保存；不是 macOS Robin 原生 MCP 通道。账号通过 Gemini 用量页面的只读接口获取 5 小时/周剩余额度和重置时间，独立保存并接入原有账号看板。Antigravity、macOS Robin、Windows 三条通道共用同一选号策略：固定会话黏性、周额度压力和 5 小时重置加权轮询；有其他可用账号时避开耗尽快照，仅在没有其他选择时保留兜底，查询失败不封禁账号。当前不支持非视频附件，token 实测仍未知。视频继续走既有 Cloud Code 路由。完整说明见 [Windows 原生通道](docs/windows-native.md)。

下面的原生任务、附件和额度能力描述针对原 **Robin OAuth 通道**，不能套用于 Windows 新通道。所有系统的 `add-gemini` 均保持 1.5.1 原行为。实际使用哪个上游通道由选中的凭据类型决定，不按网关运行系统猜测。

前台终端输入 `add-gemini` 可以独立授权 Gemini App 账号，凭据持久保存在 `~/.antigravity-gateway/robin-accounts/`，不与 Antigravity 账号混用。请求 `gemini-4-argon` 时进入 Robin 任务模式；仍使用同一网关、看板和 Messages / Chat Completions / Responses 接口，客户端工具仍由客户端执行。普通 Argon 请求不可用时明确报错，不降级到 Antigravity 的其他 Gemini 模型。唯一例外是实际携带视频的请求：Gemini App 依赖本地抽帧而不是可靠的 Argon 原生视频理解，因此网关沿用既有 Cloud Code 多媒体路径和 `ANTIGRAVITY_DEFAULT_MODEL`。现有 Antigravity 账号调度规则不变。

已实测文本、客户端工具往返、会话隔离与重启续接、图片/音频/PDF/文本输入和原生额度查询。视频请求的回退路由已有回归覆盖；真实视频理解由原有 Cloud Code 路径负责。遇到尚未接受 Gemini 服务条款的账号时，网关保留并直接返回上游原始错误，同时追加当前账号和中文处理提示；不会自动切换账号。网关不从实验接口推导或提供 Gemini App 中不存在的思考档位，并忽略客户端的 reasoning 控制，不向 Argon 请求写入隐藏思考字段。原生 token 用量等仍未验证完成。授权、部署、兼容与验证边界见 [Robin Provider 开发说明](docs/robin-provider.md)。

### 前台终端命令

| 命令 | 作用 |
|---|---|
| `add` | 添加 Antigravity 账号 |
| `add-gemini` | 原 Gemini App OAuth，支持粘贴回调 URL，行为保持不变 |
| `add-gemini-win` | Windows 原生会话授权，调用系统安装的完整 Chrome/Edge |
| `cancel` | 取消正在进行的 Windows 浏览器授权 |
| `acc` | 查看账号池和账号状态 |
| `models` | 查看当前发现的模型 |
| `status` | 重新显示网关和统计状态 |
| `usage` | 查看实时详细用量 |
| `stats` | 在默认浏览器打开 Token 用量看板 |
| `reload` | 重新加载账号与额度信息 |
| `config` | 查看客户端连接配置 |
| `logs` | 查看日志说明或位置 |
| `clear` | 清理当前终端显示 |
| `version` | 查看网关版本 |
| `help` | 查看命令帮助 |
| `quit` | 保存状态并关闭网关 |

额度查询在后台异步进行。启动画面中的 `1/1 额度可用` 表示当时成功取得了一个有效额度快照，并不代表其他账号一定没有额度；等待几秒后输入 `status` 可重新显示当前结果。

### 接入 Claude Code

在 `~/.claude/settings.json` 的 `env` 中配置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9897",
    "ANTHROPIC_AUTH_TOKEN": "antigravity-gateway",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.8-flash-low",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576"
  }
}
```

启动 Claude Code：

```bash
claude --model 'gemini-3.8-flash-high[1m]'
```

网关会生成包含当前真实模型的 Claude Code `modelPicker` 文件：

macOS/Linux：

```bash
claude --settings "$(antigravity-gateway --claude-config-path)"
```

Windows PowerShell：

```powershell
claude --settings (antigravity-gateway --claude-config-path)
```

也可以执行下面的命令，把输出的 `modelPicker` 合并进自己的 `~/.claude/settings.json`：

```bash
antigravity-gateway --claude-config
```

注意：

- 使用本地网关时，不要同时启用 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 或 `CLAUDE_CODE_USE_FOUNDRY`。
- Gemini 3.7/3.8 Flash 的上游目录当前返回 1,048,576 输入 Token；`[1m]` 或 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` 用于告诉 Claude Code 使用真实窗口。
- 正常请求使用客户端指定的模型。Auto Mode 分类请求单独使用快速模型，不改变主会话模型。

### 接入 Codex CLI

先取得动态模型目录路径：

```bash
antigravity-gateway --codex-catalog-path
```

在 `~/.codex/config.toml` 中配置：

```toml
model = "gemini-3.8-flash-high"
model_provider = "antigravity"
model_catalog_json = "/ABSOLUTE/PATH/.antigravity-gateway/codex-models.json"

[model_providers.antigravity]
name = "Antigravity Gateway"
base_url = "http://127.0.0.1:9897/v1"
env_key = "ANTIGRAVITY_GATEWAY_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

Windows 路径建议使用 TOML 单引号：

```toml
model_catalog_json = 'C:\Users\YOUR_NAME\.antigravity-gateway\codex-models.json'
```

启动前设置 Key：

macOS/Linux：

```bash
export ANTIGRAVITY_GATEWAY_API_KEY=antigravity-gateway
codex
```

Windows PowerShell：

```powershell
$env:ANTIGRAVITY_GATEWAY_API_KEY = "antigravity-gateway"
codex
```

### 接入 Trae 或其他客户端

根据客户端支持的协议填写：

| API 格式 | Base URL | API Key | 模型 |
|---|---|---|---|
| Anthropic Messages | `http://127.0.0.1:9897` | `antigravity-gateway` | 从模型目录选择 |
| OpenAI Responses/Chat | `http://127.0.0.1:9897/v1` | `antigravity-gateway` | 从模型目录选择 |

查询模型：

```bash
antigravity-gateway --models
curl http://127.0.0.1:9897/v1/models
```

模型取决于账号、套餐、地区和 Antigravity CLI 版本。模型目录只用于展示和诊断，不会阻止客户端把其他模型 ID 发给上游。

### 图片生成与多媒体理解

普通对话不依赖关键词判断。网关把文本和附件一并交给客户端指定的 Gemini 模型：模型认为附件只是资料时直接理解并回答；只有用户明确要求产出新图片或编辑参考图时，模型才会调用内置的原生生图工具。客户端自己的工具名、`tool_choice` 和工具执行流程不会被替换。

原生生图直接使用 agy 同款的 Antigravity 私有图片请求和账号池凭据，不会为每次请求启动本机 agy。新版本通过 `add` 授权的账号会同时保存后续刷新所需的 OAuth 客户端元数据；把完整账号 JSON 复制到服务器账号池后，即使服务器没有安装 agy，该账号也能刷新并参与对话和生图。旧版已保存但不含这些字段的账号仍按原有方式从本机 agy 安装中发现刷新配置。

OpenAI 标准文生图：

```bash
curl http://127.0.0.1:9897/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"白色背景中央的黑色六边形","size":"1024x1024","response_format":"url"}'
```

参考图编辑，最多 3 张参考图：

```bash
curl http://127.0.0.1:9897/v1/images/edits \
  -F 'image=@reference.png' \
  -F 'prompt=只把主体颜色改为紫色，其他内容不变' \
  -F 'response_format=url'
```

远程服务器或不能直接传本地路径的客户端，可以先上传文件：

```bash
curl http://127.0.0.1:9897/v1/files \
  -F 'file=@recording.mp4;type=video/mp4' \
  -F 'purpose=assistants'
```

返回的 `file_...` 可放进 Anthropic `source.file_id`、Chat Completions 的 `file_id`/`input_image`/`input_video`，或 Responses 的 `input_file`/`input_image`/`input_video`。协议转换器也接受 Base64/Data URL、HTTP(S) URL 和网关本机绝对路径；生成图片的 URL 可以直接作为后续参考图再次使用。上传与生成文件保存在 `~/.antigravity-gateway/media/`。

生图响应会同时提供普通文本回执、Markdown、可访问 URL、网关主机上的绝对路径，以及各协议中的 `artifacts` 结构化元数据；不识别扩展字段的客户端仍可从正文取得交付地址。文件内容接口同时支持 `GET` 和 `HEAD`。

如果 Agent 本身不会把本地视频转换成多媒体请求，可以使用随包附带的 `skills/antigravity-video-understanding`。该 Skill 的 Python 脚本会通过现有 Files API 上传本地视频，再以原生 `input_video` 调用 Chat Completions；本地或远程网关均使用同一流程：

```bash
python3 skills/antigravity-video-understanding/scripts/analyze_video.py \
  "/absolute/path/recording.mp4" \
  --prompt "分析这段视频并回答我的问题"
```

网关分别管理客户端身份、独立对话和账号黏性：同一对话及其工具调用优先使用同一账号；子 Agent 使用独立会话状态，但通过父会话继承账号黏性。软黏性映射会在本地保存固定 5 小时（可通过 `ANTIGRAVITY_AFFINITY_TTL_SECONDS` 调整），网关重启后仍会优先恢复当前窗口内的账号；窗口内的后续请求只检查本地可用状态，不重复读取或排序额度。窗口到期、上游返回额度耗尽、网络异常、凭据失效、访问受限或 Google 要求安全核验时会重新按 Gemini 周额度压力、5 小时重置时间和账号权重加权选择，避免单一高压力账号独占全部新流量。认证和账号风控会把账号标记为异常并停止继续尝试；重新授权导致凭据变化时自动恢复，也可以在看板中点击“重新检测”，以不生成内容、不消耗模型 Token 的轻量鉴权确认核验结果。网络瞬态故障仍由直连传输重试，失败后只进入短暂冷却。

首次选择账号或故障转移时，保留当前模型的可用性优先规则，然后仅参考 Gemini 模型组的周额度计算 `Pressure = remainingFraction / 距周重置小时数`，以 `floor(log2(Pressure))` 分档。最高压力档、相邻档和其余可用档分别获得 4、2、1 倍权重；同档中 Gemini 5 小时额度最早重置的账号再获得 2 倍权重，最后叠加账号自身权重进行平滑加权轮询。无论请求使用 Gemini、Claude 还是 GPT，都不使用 Claude/GPT 周额度参与压力排序。已有可用的黏性账号及生图的优先账号直接续接，不重算压力或变更轮询权重；切号时重新读取快照，单次请求不重复尝试同一账号。

三条通道复用同一个选号模块，只读取本地保存的真实上游额度快照，不等待联网查询，也不根据 Token 用量推算余额。有效的 Gemini 周压力档位优先，未知压力账号随后，已知周额度耗尽账号保留为最终兜底。快照过期、周重置已到或字段缺失时按未知处理，并异步补刷新；同档未知的 5 小时重置时间仍退回加权轮询。后台保留约 30 分钟一次的完整刷新；缺失/失效快照及实际额度失败只补查相关账号的额度汇总，普通补刷新每账号至少间隔 5 分钟，重复请求合并；Cloud Code 的额度查询最多同时刷新两个账号，Gemini 后台批次逐个查询。新增账号、凭据变化及重新检测成功会触发该账号的完整刷新。额度汇总单独记录观测时间，套餐或模型目录查询成功不会把旧额度标记为最新。

支持客户端显式发送 `x-client-id`/`x-agent-id`、`x-session-id`/`x-conversation-id`、`x-parent-session-id` 和 `x-routing-affinity-id`；未提供时继续兼容现有 Claude、Codex、OpenAI 和 Anthropic 客户端字段。这些客户端原始标识仅用于本地散列路由，不写入模型提示词。Cloud Code 使用独立的原生 cascade/trajectory UUID 与已实抓的上游 sessionId，不把本地路由哈希冒充该字段；其他通道沿用各自的会话映射。日志中的 request、client、session 和 affinity 短标识可用于区分并发链路。

### 用量和额度

启动界面显示：

- 账号池可用状态和已取得的额度快照。
- 历史请求数、上游调用数、输入/输出 Token、缓存 Token 与命中率。
- 最近24小时每小时用量图。

输入 `usage` 查看实时明细，输入 `status` 刷新展示。用量每5分钟保存一次，24小时图表每小时更新，历史总量展示每24小时更新。额度快照约每30分钟刷新；上游实时返回始终是最终依据。

网关以前台或后台模式运行时，都可以另开终端执行下面的命令查看完整图形看板：

```bash
antigravity-gateway stats
```

看板提供历史与所选时段 Token、请求和上游调用、输入/输出/思考/缓存、失败率、账号额度、小时热力图、模型趋势和模型消耗占比；支持最近1天、3天、7天、30天及按账号筛选，浏览器会记住上次选择的统计周期。账号列表只来自当前账号池；额度与 agy `/usage` 保持一致，默认按账号完整展示 Gemini 模型组、Claude/GPT 模型组共享的每周额度和 5 小时额度，也可切换为只看 Gemini 模型组的额度概览，浏览器同样会记住上次选择。异常账号提供一次性轻量鉴权的“重新检测”按钮；“删除账号”会移除账号凭据、健康状态、额度快照与会话黏性，并防止已主动删除的本地 agy 身份在重启时被自动导回。若账号池因此变空，网关不会绕过账号池退回该本地登录态；重新使用需通过 `add` 明确加入账号。具体模型的调用次数与 Token 只按真实请求的模型 ID 统计，不再把模型目录中的单项余额误写成账号总额度。点击“生成图片”会在浏览器本地生成账号脱敏的高清 PNG，桌面端直接下载，移动端提供长按保存预览；该过程不依赖第三方服务，也不会增加网关后端截图负担。网页每分钟读取一次本地聚合数据，关闭页面后不会继续轮询，也不保存提示词或模型回复。账号与模型的小时细分从 v0.8.0 起累计。

```text
~/.antigravity-gateway/state/account-pool.json
~/.antigravity-gateway/state/quota.json
~/.antigravity-gateway/usage/usage-state.json
```

`account-pool.json` 只保存账号 ID、不可逆会话路由标识、被主动删除身份的不可逆哈希、时间和账号健康状态，不保存提示词、模型回复或账号 Token；用量统计也只保存数字。

### 更新与卸载

更新：

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

更新后必须重启正在运行的网关。前台模式按 `Ctrl+C` 后重新运行；后台模式执行：

```bash
antigravity-gateway service start
```

卸载：

```bash
antigravity-gateway service uninstall
npm uninstall --global antigravity-gateway
```

### 常见问题

#### `401 本地 agy 登录态刷新失败`

先在官方 `agy` 中重新登录并完成一次正常对话，然后重启网关。输入 `acc` 检查账号池状态；若看板仍标记异常，可点击该账号的“重新检测”确认新凭据或安全核验已经生效。

#### `429 Resource has been exhausted`

通常表示当前账号或模型额度受限。网关会尝试其他可用账号；如果所有账号都受限，请等待额度恢复或切换模型。

#### `EADDRINUSE 127.0.0.1:9897`

已有网关占用端口。关闭旧进程，或使用其他端口：

```bash
antigravity-gateway --port 9898
```

客户端 Base URL 也必须改成新端口。

#### Claude Code 请求没有出现在网关日志

检查 `ANTHROPIC_BASE_URL`，并移除 Bedrock、Vertex、Foundry 等会覆盖本地 Base URL 的 provider 开关。系统代理环境下可设置：

```bash
export NO_PROXY=127.0.0.1,localhost
```

#### 鉴权与休眠恢复诊断日志

网关会把账号隔离、手动重新检测、Token 刷新阶段、上游鉴权探测结果，以及疑似休眠或挂起造成的运行时间断层写入 `~/.antigravity-gateway/logs/auth-diagnostics.jsonl`。每行都是带 ISO 时间的独立 JSON，便于按事件还原链路；文件达到约 5 MB 后保留一份 `.1` 轮转副本。日志只记录账号掩码、状态、耗时、HTTP 状态和脱敏错误，不记录 access token、refresh token、client secret、提示词或模型回答。

```bash
tail -f ~/.antigravity-gateway/logs/auth-diagnostics.jsonl
```

#### 启动时只发现少量模型

模型探测可能暂时失败或账号目录尚未刷新。输入 `models`、`reload`，或使用 `antigravity-gateway --models` 再次查询。客户端明确指定的模型仍会原样发给上游。

### 常用配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `ANTIGRAVITY_GATEWAY_HOST` | `127.0.0.1` | 网关监听地址 |
| `ANTIGRAVITY_GATEWAY_PORT` | `9897` | 网关监听端口 |
| `ANTIGRAVITY_GATEWAY_API_KEY` | 空 | 自定义网关 Key；非本机监听时必须设置 |
| `ANTIGRAVITY_CLI_PATH` | 自动查找 `agy` | 指定 agy 路径 |
| `ANTIGRAVITY_LOCAL_AUTH_FILE` | 自动读取本地登录态 | 指定本地 agy 凭据文件 |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | `~/.antigravity-gateway` | 账号、额度、用量和客户端配置目录 |
| `ANTIGRAVITY_DEFAULT_MODEL` | `gemini-3.8-flash-high` | 请求未提供模型时使用 |
| `ANTIGRAVITY_FAST_MODEL` | 自动选择 | Claude Code Auto Mode 分类请求使用 |
| `ANTIGRAVITY_MODEL_ALIASES` | `{}` | 用户主动设置的精确模型映射 |
| `ANTIGRAVITY_DIRECT_MODEL_DISCOVERY_TIMEOUT_MS` | `8000` | 模型目录探测超时，单位毫秒 |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | `300000` | 单次请求总超时，单位毫秒 |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | `12`（`agy` 模式为 `4`） | 最大并发请求数 |
| `ANTIGRAVITY_GATEWAY_MAX_QUEUE` | `32` | 最大排队请求数 |
| `ANTIGRAVITY_AFFINITY_TTL_SECONDS` | `18000` | 三条通道共用的账号软黏性固定窗口，单位秒；成功请求不会续期 |
| `ANTIGRAVITY_GATEWAY_CORS_ORIGIN` | 空 | 允许访问本地网关的浏览器 Origin |
| `ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW` | 空 | 额外允许访问看板的 IP、CIDR 或 `*`，逗号分隔；默认仅本机 |
| `ANTIGRAVITY_GATEWAY_DEBUG` | 空 | 设置为 `1` 输出更多诊断信息 |
| `ANTIGRAVITY_IMAGE_MODEL` | `gemini-3.1-flash-image` | 原生图片请求使用的 Antigravity 图片模型 |
| `ANTIGRAVITY_GATEWAY_MEDIA_LIMIT` | `100663296` | 单个多媒体文件内存/解析上限，单位字节 |
| `ANTIGRAVITY_GATEWAY_TOTAL_MEDIA_LIMIT` | `201326592` | 单次对话解析的多媒体总上限，单位字节 |

非必要情况下不建议手动设置 access token、refresh token、project ID 或上游地址。普通用户使用本地 agy 登录态和账号池即可。

跨设备查看看板时，需要同时把监听地址改为非回环地址并设置 API Key。例如只允许局域网 `192.168.1.0/24`：

```bash
export ANTIGRAVITY_GATEWAY_HOST=0.0.0.0
export ANTIGRAVITY_GATEWAY_API_KEY=请设置自己的密钥
export ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW=192.168.1.0/24
antigravity-gateway
```

看板本身不校验 API Key，白名单来源可以看到账号邮箱、额度和用量；不建议在公网环境中使用 `*`。来源按真实 TCP 对端地址判断，不信任 `X-Forwarded-For`。使用后台模式时重新执行 `antigravity-gateway service start`，即可保存配置并重启服务。

### 接口

```text
GET  /
GET  /v1/models
POST /v1/files
GET  /v1/files/:id
GET  /v1/files/:id/content
DELETE /v1/files/:id
POST /v1/images/generations
POST /v1/images/edits
POST /v1/messages
POST /v1/messages/count_tokens
POST /v1/responses
POST /v1/chat/completions
```

### 工作原理

客户端请求先进入本地兼容接口，网关完成 Anthropic/OpenAI 与 Cloud Code 之间的格式转换，再使用本地账号池凭据请求上游，最后把结果转换回客户端协议。普通客户端工具仍由 Claude Code、Codex 等客户端执行；只有网关私有的原生生图工具由网关拦截，并直接调用 Antigravity 图片接口。

### 已知限制

- 直连使用的是非公开 Cloud Code 内部接口，上游升级后可能需要同步适配。
- 可用模型和额度取决于账号；本项目不会绕过上游限制。
- 工具调用、Auto Mode 和结构化输出请求可能需要先完整校验，再向客户端返回。
- 私有生图和多媒体协议并非公开稳定接口，上游格式或权限发生变化时可能需要同步适配。
- 本地账号文件是普通 JSON，由使用者自行保管。

### License

MIT，见 [LICENSE](LICENSE)。

---

## English

Antigravity Gateway is a local Anthropic/OpenAI-compatible gateway. It reuses the official Antigravity CLI (`agy`) login state so Claude Code, Codex CLI, Trae, and other compatible clients can access models available to the current account through local HTTP endpoints.

The default `direct` transport calls Cloud Code without launching the agy Agent or replacing the caller's entire system prompt. The current source formats upstream messages, tools and session metadata according to captured agy requests and adapts recognized identity templates and equivalent tool expressions, preserving user instructions, project rules and execution semantics. Normal requests preserve the exact model ID selected by the client. Only detected Claude Code Auto Mode classifier requests use a separate fast model.

The captured Claude Code 2.1.285 profile supports reversible Read/view_file, Write/write_to_file, Edit/replace_file_content and Bash/run_command mappings. Native names do not imply unsupported native capabilities: command execution limits and background flags retain their own semantics, and permissions remain with the client. Actual packaged CLI Read/Edit/Bash and gateway-restart tests pass, with signed upstream calls and correlated receipts preserved.

The captured Codex CLI 0.159.2 Responses profile also maps exec_command/run_command, write_stdin/manage_task and view_image/view_file. Command options, approval requests, numeric sessions and image bytes are preserved; task management advertises only status/send_input and image viewing remains image-only. The multi-file apply_patch custom grammar is unchanged. Captured Hermes 0.21.7 framework blocks map read_file/write_file/patch/terminal while preserving custom SOUL identity, project instructions, actual executor semantics and signed history across restarts. Actual installed clients verify these workflows; all 686 local regressions pass. Unknown or ambiguous templates and non-equivalent tools retain compatibility. See the final acceptance matrix for evidence and explicit limits; no complete Google-internal indistinguishability is claimed.

> Unofficial and intended for learning, compatibility research, and personal testing. Upstream plans, quotas, regional restrictions, and terms still apply.

Current version: `v1.7.0`. See [CHANGELOG.md](CHANGELOG.md) for release notes.

Version 1.7.0 combines the Cloud Code request translation with macOS Robin adapters for Claude Code, Codex and Hermes. The combined local suite has 704 passing tests; the 686-test count above describes the earlier Cloud Code stage. Robin uses its own external MCP catalog and bidirectional streams, without Cloud Code envelopes, agy identity or extra tool metadata. Three actual CLIs completed 11 real Argon tool executions. Windows routing, account scheduling, quota reporting and video fallback retain their existing behavior. See [Robin client adapters](docs/robin-provider.md#macos-robin-客户端定向适配).

The default remains bounded transport retries, not hidden task continuation or agent-side retry decisions. The explicit `ANTIGRAVITY_DIRECT_RETRY_POLICY=agy` mode is retained only as an opt-in compatibility option. Later sections preserve earlier experiment records, not additional default behavior. An unfinished Robin tool stream cannot survive a gateway process restart.

Cloud Code text/image user messages now use the captured agy upload layout without gateway attachment markers. Real reference files live in private `state/agy-sessions/images/`; paths and message timestamps survive session reloads and remain usable by image editing. Request-time cleanup evicts idle (24-hour), over-size (256 MiB) or over-count (1024) cached files while protecting the current request, without deleting Files API uploads or generated artifacts. Other/mixed-media layouts and complete fingerprint equivalence remain under verification.

### Features

Cloud Code recognizes the exactly captured Claude Code 2.1.285 automatic-compaction instruction and maps it to a same-trajectory checkpoint with the observed 16384 output cap and unchanged agent counter. Recognized client summaries use CONTEXT_SUMMARY while retaining all caller text and tools. Only timeline metadata is retained for temporarily omitted completed answers; removed history/signatures are not reconstructed. Unknown versions, customized instructions and unverified envelopes keep the existing route. Captured checkpoint 429/500/502/503/504 retries update only the timestamp; terminal 400/429/500/502/503/504 failures consume one error step, cancellations do not install partial summaries, and failed/canceled executions receive a new boundary. Ordinary agent attempts instead consume one step per observed HTTP failure. Actual official captures and formally installed real Claude Code retry/cancel/restart tests verify these bounded paths; 594 regressions pass. Account/endpoint failover, retry counts/backoff and Robin/Windows routing remain unchanged, so full temporal fingerprint and cross-platform equivalence remain unverified.

- Anthropic Messages, OpenAI Responses, and Chat Completions endpoints.
- Claude Code, Codex CLI, Trae, and other compatible clients.
- Foreground mode and cross-platform background keepalive/autostart.
- Automatic local agy account import plus interactive `add` authorization.
- Gemini App `gemini-4-argon` proxying through the existing account pool: `add-gemini` retains Robin OAuth on every OS; `add-gemini-win` adds Windows web-session credentials and WebChannel requests. Credential directories are separate; client APIs and scheduling are shared.
- Sticky-session account rotation and failover on authentication, quota, or rate-limit failures.
- Request, token, cache, account, quota, and 24-hour usage displays.
- Client-side tools, SSE, Claude Code Auto Mode, and structured output support.
- Native image generation/reference editing and multimodal understanding for images, video, audio, PDFs, and files.
- OpenAI-compatible Images and Files endpoints for local and remote clients.

### Requirements

- Node.js 20 or newer with npm.
- Official Antigravity CLI (`agy`) installed, signed in, and verified with one successful conversation.
- macOS, Linux, or Windows on ARM64/x64.
- Network access to Antigravity/Google upstream services.

Install Node.js if needed:

```bash
# macOS with Homebrew
brew install node

# macOS/Linux with nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

Windows PowerShell:

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
```

### Install and run

Install globally from any directory:

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

Foreground mode:

```bash
antigravity-gateway
```

Background keepalive and autostart:

```bash
antigravity-gateway service start
```

Open the local Token dashboard while either foreground or background mode is running:

```bash
antigravity-gateway stats
```

Once the gateway is running in either foreground or background mode, run this command from another terminal. The dashboard reuses the gateway process and port `9897`; it does not start another persistent web service. The direct URL is `http://127.0.0.1:9897/dashboard`.

Service management:

```bash
antigravity-gateway service status
antigravity-gateway service restart
antigravity-gateway service stop
antigravity-gateway service logs
antigravity-gateway service uninstall
```

Default client endpoints:

```text
Anthropic: http://127.0.0.1:9897
OpenAI:    http://127.0.0.1:9897/v1
API Key:  antigravity-gateway (any non-empty value when no custom gateway key is set)
```

If npm 11 prints `install scripts not yet covered by allowScripts`, but installation ends with `changed 1 package` and the command works, the installation succeeded.

### Accounts and terminal commands

At startup, a usable official local agy identity is added to the pool only when it is new. Existing matching identities are not duplicated or overwritten. Once the pool is non-empty, requests use its stored credentials.

Run the gateway in foreground mode and type `add` to authorize another account. The complete OAuth URL is always printed. On a remote host, paste the final localhost callback URL back at `gateway>`.

On Windows, `add-gemini-win` opens the system-installed full Chrome/Edge browser without debugging or automation flags during sign-in. Sign in, finish Gemini onboarding, then close this dedicated window; the gateway reads that session and saves it in `gemini-win-accounts/`. Login and model listing do not send inference probes. Requests use WebChannel / `ProcessSession` directly from Node.js; no Gemini App installation or macOS impersonation is needed. Text, streaming and client-tool compatibility reuse the existing APIs. Five-hour/weekly quota and reset times are fetched through the read-only Gemini Usage page query and persisted independently. Antigravity, macOS Robin and Windows share one scheduling policy: fixed affinity and smooth rotation weighted by weekly pressure and five-hour reset time. Depleted snapshots are avoided when alternatives exist, but remain last-resort fallbacks; telemetry failures do not disable accounts. Non-video attachments remain unsupported and token usage remains unknown. Video retains the established Cloud Code route. See [Windows native channel](docs/windows-native.md).

On every OS, `add-gemini` retains the 1.5.1 OAuth flow and `robin-accounts/` storage. Its native Robin task, attachment and quota capabilities remain unchanged. OAuth and Windows credentials for the same Google account coexist without overwriting one another. The selected credential's type chooses the upstream transport, not the host OS. Ordinary Argon failures never silently fall back to other models; neither path adds hidden thinking tiers. See [Robin Provider development notes](docs/robin-provider.md).

| Command | Purpose |
|---|---|
| `add` | Add an Antigravity account |
| `add-gemini` | Original 1.5.1 OAuth flow on every OS, including pasted callback URLs |
| `add-gemini-win` | Windows session login using installed full Chrome/Edge |
| `cancel` | Cancel an active Windows browser login |
| `acc` | Show pool and account state |
| `models` | Show discovered models |
| `status` | Refresh gateway and dashboard status |
| `usage` | Show live detailed usage |
| `stats` | Open the local Token dashboard |
| `reload` | Reload accounts and quota snapshots |
| `config` | Show client configuration |
| `logs` | Show log information |
| `clear` | Clear the terminal |
| `version` | Show gateway version |
| `help` | Show command help |
| `quit` | Save state and stop the gateway |

Each upstream attempt prints the selected account, model, and attempt number. Account files are stored under `~/.antigravity-gateway/accounts/` as ordinary JSON.

### Claude Code

Add these values to the `env` object in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9897",
    "ANTHROPIC_AUTH_TOKEN": "antigravity-gateway",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.8-flash-low",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576"
  }
}
```

Start with a Gemini 1M context declaration:

```bash
claude --model 'gemini-3.8-flash-high[1m]'
```

Load the generated model picker:

```bash
# macOS/Linux
claude --settings "$(antigravity-gateway --claude-config-path)"
```

```powershell
# Windows PowerShell
claude --settings (antigravity-gateway --claude-config-path)
```

Do not enable Bedrock, Vertex, or Foundry provider switches while using the local `ANTHROPIC_BASE_URL`.

### Codex CLI

Print the generated catalog path:

```bash
antigravity-gateway --codex-catalog-path
```

Add to `~/.codex/config.toml`:

```toml
model = "gemini-3.8-flash-high"
model_provider = "antigravity"
model_catalog_json = "/ABSOLUTE/PATH/.antigravity-gateway/codex-models.json"

[model_providers.antigravity]
name = "Antigravity Gateway"
base_url = "http://127.0.0.1:9897/v1"
env_key = "ANTIGRAVITY_GATEWAY_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

Windows path:

```toml
model_catalog_json = 'C:\Users\YOUR_NAME\.antigravity-gateway\codex-models.json'
```

Start Codex:

```bash
export ANTIGRAVITY_GATEWAY_API_KEY=antigravity-gateway
codex
```

### Trae and other clients

| API format | Base URL | API Key |
|---|---|---|
| Anthropic Messages | `http://127.0.0.1:9897` | `antigravity-gateway` |
| OpenAI Responses/Chat | `http://127.0.0.1:9897/v1` | `antigravity-gateway` |

List available models:

```bash
antigravity-gateway --models
curl http://127.0.0.1:9897/v1/models
```

### Images and multimodal input

Normal conversation has no keyword router. The selected Gemini model receives both the text and attachments, understands them as context by default, and invokes a private native image tool only when the requested deliverable is a new or edited image. Existing client tools and `tool_choice` semantics are preserved.

The image path mirrors agy's private Antigravity image request and uses the managed account pool directly; it does not launch agy for each image. Accounts newly authorized with `add` retain the OAuth client metadata needed for token refresh if the complete account JSON is later moved to a server without agy.

```bash
# Text to image
curl http://127.0.0.1:9897/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a black hexagon on white","size":"1024x1024","response_format":"url"}'

# Reference-image edit (up to three images)
curl http://127.0.0.1:9897/v1/images/edits \
  -F 'image=@reference.png' \
  -F 'prompt=change only the subject to purple' \
  -F 'response_format=url'

# Upload media for a remote client
curl http://127.0.0.1:9897/v1/files \
  -F 'file=@recording.mp4;type=video/mp4' \
  -F 'purpose=assistants'
```

Use the returned `file_...` in Anthropic, Chat Completions, or Responses media blocks. Base64/Data URLs, HTTP(S) URLs, gateway-local absolute paths, and previously generated gateway URLs are also accepted. Files are kept under `~/.antigravity-gateway/media/`. The gateway separates client identity, conversation state, parent-child relationships, request tracing, and account affinity. Explicit `x-client-id`/`x-agent-id`, `x-session-id`/`x-conversation-id`, `x-parent-session-id`, and `x-routing-affinity-id` headers are supported alongside existing Claude, Codex, OpenAI, Anthropic, and Responses identifiers. Child agents keep independent upstream sessions while inheriting parent account affinity. Raw client identifiers remain in local hashed routing; Cloud Code uses independent native cascade/trajectory UUIDs and the captured upstream sessionId rather than substituting a local routing hash. Other transports retain their own conversation mappings.

All three transports share the same scheduling module. Soft affinity is persisted locally for a fixed five-hour window, configurable through `ANTIGRAVITY_AFFINITY_TTL_SECONDS`, and successful requests do not extend that window. Healthy continuations reuse local affinity without recalculating quota ranks; expiry or failure triggers weighted selection using Gemini weekly pressure, Gemini five-hour reset time, and configured account weights without starving lower-ranked healthy accounts. Account-level authentication, access-denial, and Google verification challenges mark that account unhealthy and stop further routing or quota probes until its credentials change or the user runs the dashboard's token-free authentication recheck; transient network failures retain transport retries and only cause a short cooldown.

For new bindings and failover, retain current-model availability priority, then calculate Gemini-only weekly pressure bands as `floor(log2(remainingFraction / hoursUntilWeeklyReset))`, with a one-minute minimum denominator. The highest, adjacent, and remaining usable bands receive 4x, 2x, and 1x weights; the earliest Gemini five-hour reset within each band receives a further 2x boost before applying the configured account weight through smooth weighted rotation. Claude/GPT weekly quota does not affect pressure regardless of the requested model. Healthy sticky continuations and preferred image accounts skip recalculation and do not spend rotation weights. Failover rereads snapshots and tries each account at most once per request.

Scheduling reads locally stored quota summaries without waiting for network queries or estimating quota from Token counts. Unknown/expired weekly data follows known positive pressure, and exhausted snapshots remain advisory fallbacks. Full background refreshes remain approximately half-hourly. Missing/expired data and live quota failures trigger asynchronous per-account summary refreshes, coalesced and throttled to once per five minutes (Cloud Code limits refresh concurrency to two; Gemini background batches are sequential); account additions, changed credentials and successful authentication rechecks trigger full account refreshes. Summary freshness is tracked independently, so successful plan/catalog queries cannot renew stale quota data.

Generated-image responses include a readable text receipt, Markdown, an accessible URL, the absolute path on the gateway host, and structured `artifacts` metadata for each protocol. Clients that ignore extension fields can still obtain the delivery address from the assistant text. File content supports both `GET` and `HEAD`.

For agents that cannot construct video inputs themselves, the bundled `skills/antigravity-video-understanding` package uploads a local video through the existing Files API and submits it as native `input_video` through Chat Completions:

```bash
python3 skills/antigravity-video-understanding/scripts/analyze_video.py \
  "/absolute/path/recording.mp4" \
  --prompt "Analyze this video and answer my question."
```

### Usage, update, and troubleshooting

The browser dashboard shows lifetime and selected-period Tokens, requests, upstream calls, input/output/thinking/cache usage, failures, per-account quota, hourly heatmaps, model trends, and model consumption share. It supports 1/3/7/30-day windows and account filtering, and remembers the last selected time window in the browser. Accounts come exclusively from the active account pool. Quota cards mirror agy `/usage`: by default each account shows the shared weekly and five-hour limits for both the Gemini and Claude/GPT groups, with a compact overview that shows only the Gemini group; the browser also remembers the last selected quota view. Unhealthy accounts expose a one-shot authentication recheck, while Delete Account removes the credential, health record, quota snapshot, and affinity bindings and prevents an explicitly removed local agy identity from being auto-imported or used as an implicit fallback again; use `add` to explicitly restore it. Per-model request and Token charts use the exact model IDs actually called instead of treating a model-catalog balance as the account's total quota. The Generate Image action creates an account-masked, high-resolution PNG entirely in the browser: desktop browsers download it directly, while mobile browsers show a long-press save preview. No third-party screenshot service or extra gateway-side rendering process is used. The page reads local aggregate data once per minute only while open; it never stores prompts or model responses. Hourly account/model breakdowns begin with v0.8.0. Type `usage` for terminal details or run `antigravity-gateway stats` while either foreground or background mode is active. Usage is persisted every five minutes; quota snapshots refresh asynchronously.

Authentication diagnostics are written as timestamped JSON Lines to `~/.antigravity-gateway/logs/auth-diagnostics.jsonl`, with one rotated `.1` copy at approximately 5 MB. Events cover account quarantine and recovery, manual rechecks, token-refresh stages, upstream authentication probes, and runtime gaps consistent with sleep or suspension. Credentials, prompts, and model responses are never written to this file.

Update:

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway https://github.com/LeeFeee/antigravity-gateway/archive/refs/heads/main.tar.gz
```

Restart the foreground process after updating, or run `antigravity-gateway service start` again for background mode.

Common failures:

- `401`: sign in through official agy again, complete one successful conversation, restart the gateway, and check `acc`.
- `429`: the account/model is rate-limited or out of quota; wait, switch models, or add another account.
- `EADDRINUSE`: stop the old process or use `antigravity-gateway --port 9898`, then update the client URL.
- No gateway request log: verify `ANTHROPIC_BASE_URL` and remove Bedrock/Vertex/Foundry provider switches.

### Common configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTIGRAVITY_GATEWAY_HOST` | `127.0.0.1` | Listen address |
| `ANTIGRAVITY_GATEWAY_PORT` | `9897` | Listen port |
| `ANTIGRAVITY_GATEWAY_API_KEY` | empty | Custom gateway key; required for non-loopback binding |
| `ANTIGRAVITY_CLI_PATH` | auto-detected | Custom agy path |
| `ANTIGRAVITY_LOCAL_AUTH_FILE` | auto-detected | Custom local agy credential file |
| `ANTIGRAVITY_GATEWAY_CONFIG_DIR` | `~/.antigravity-gateway` | Accounts, quota, usage, and generated client configuration |
| `ANTIGRAVITY_DEFAULT_MODEL` | `gemini-3.8-flash-high` | Used only when a request omits `model` |
| `ANTIGRAVITY_FAST_MODEL` | auto-selected | Auto Mode classifier model |
| `ANTIGRAVITY_MODEL_ALIASES` | `{}` | Explicit exact model aliases |
| `ANTIGRAVITY_GATEWAY_TIMEOUT_MS` | `300000` | Request timeout in milliseconds |
| `ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY` | `12` (`4` in `agy` mode) | Maximum concurrent requests |
| `ANTIGRAVITY_GATEWAY_MAX_QUEUE` | `32` | Maximum queued requests |
| `ANTIGRAVITY_AFFINITY_TTL_SECONDS` | `18000` | Shared fixed account-affinity window for all three transports, in seconds; successful requests do not renew it |
| `ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW` | empty | Extra IPs, CIDRs, or `*` allowed to open the dashboard; comma-separated and local-only by default |
| `ANTIGRAVITY_IMAGE_MODEL` | `gemini-3.1-flash-image` | Native Antigravity image model |
| `ANTIGRAVITY_GATEWAY_MEDIA_LIMIT` | `100663296` | Maximum bytes per media item |
| `ANTIGRAVITY_GATEWAY_TOTAL_MEDIA_LIMIT` | `201326592` | Maximum resolved media bytes per request |

For remote dashboard access, bind the gateway to a non-loopback address, configure an API key, and allow only the required LAN address or CIDR. The dashboard itself does not validate the API key, so allowed sources can see account emails, quotas, and usage; avoid `*` on public networks. Matching uses the TCP peer address and does not trust `X-Forwarded-For`. Re-run `antigravity-gateway service start` to persist changed environment settings in background mode.

### How it works

Clients call the local Anthropic/OpenAI endpoints. The gateway converts requests to the Cloud Code protocol, selects a pool account, sends the upstream request, and converts the result back. Normal tools remain client-executed. Only the private native image tool is intercepted and sent directly to the Antigravity image endpoint.

### Limitations

- Direct transport uses an undocumented Cloud Code internal API and may require updates after upstream changes.
- Available models and quotas depend on the account and upstream service.
- Tool, Auto Mode, and structured-output requests may be buffered for validation.
- Private image and multimodal protocols are undocumented upstream interfaces and may require compatibility updates.
- Account credentials are ordinary local JSON files and remain the user's responsibility.

### License

MIT. See [LICENSE](LICENSE).
