# agy 请求转译：最终验收矩阵

日期：2026-10-20。状态：本次本地代码改造及下列验收完成，相关实现纳入 v1.7.0。本表保留 Cloud Code 阶段验收时的安装和测试事实；当前版本说明见 [CHANGELOG.md](../CHANGELOG.md)。

范围说明：下表记录 Cloud Code 阶段的 686 项验收及签名/重启机制。随后完成的 macOS Argon／Robin 定向适配单独记录在 [Robin Provider](robin-provider.md#macos-robin-客户端定向适配)；当前合并后的本地测试为 704 项。Robin 复用客户端能力映射，不复用本表中的 Cloud Code 签名或未完成工具流恢复机制；Windows 仍走原路径。

## 用户目标与证据

| 要求 | 当前实现和核验 | 结论 |
|---|---|---|
| 识别 Claude、Codex、Hermes 的请求 | Anthropic Messages、OpenAI Chat/Responses 统一规范化；已捕获客户端按版本/固定块/实际 Schema 识别，不把请求头或提示指纹当鉴权 | 通过 |
| 以 agy 请求特征发往上游 | 实际官方样本约束 Cloud Code 外层字段、原生消息/工具历史、HTTP 与稳定 TLS 字段；实际 Google 抓包核验 | 通过已声明范围，不声称服务器内部不可区分 |
| 工具和参数双向转换 | Claude Read/Write/Edit/Bash，Codex exec_command/write_stdin/view_image，Hermes read_file/write_file/patch/terminal 已真实执行；原参数、空值/默认值、权限和能力边界有回归 | 通过 |
| 非等价/自定义工具仍可执行 | Codex apply_patch 原始语法保留；Hermes 延迟工具、未知工具和名称冲突保留原兼容声明，不伪造 agy 原生能力 | 通过；这是设计边界，不强制改名 |
| 固定系统模板与业务内容分离 | 已识别身份及工具引用定向转译；实际普通 Hermes SOUL/AGENTS.md、用户消息、路径、参数逐字保留；歧义块不猜测 | 通过 |
| 历史、上下文和会话续接 | 三类实际 CLI 均有工具结果前网关重启、历史调用/签名恢复证据；Hermes 普通模式另验证原对话和项目规则标记。仅匹配完整实际历史时复用私有投影 | 通过 |
| 不接管 agent 重试/任务判断 | 默认有限传输重试；实际失败交回 agent，不补隐藏继续消息、不因旧终止状态阻止完整上下文重试；已有受控断流证据和当前回归 | 通过 |
| 不增加无用声明 | 不创建代理身份/私有客户端字段或展开延迟工具；仅保留已有必要生图工具，以及结构化输出所需 finish 路径。发现旧 mode 提示无对应参数后仅从已捕获固定段移除 | 通过 |
| 原账号池与三通道轮询 | 当前全量测试覆盖完整加权序列、粘性、额度耗尽后回退、每账号至多一次尝试、健康/模型过滤、固定窗口及持久化 | 通过本地回归 |
| 原额度、看板和 usage | Windows/Robin 额度独立归属、未知用量不造零、账号操作隔离和秘密不外泄等关键回归逐名通过 | 通过本地回归 |
| 原模型/媒体路由 | Argon 仍归 Gemini App；Argon 视频按原 Cloud Code 路径处理，三种公共协议均有回归；新框架配置仅传 Cloud Code 且工具转译限定已验证 Flash High | 通过本地回归；不新增档位 |
| 正式安装状态和部署隔离 | npm pack → 独立前缀全局安装，真实 CLI 连接该安装；69 个运行时文件与源码/安装/包一致。原服务未替换，临时凭据清理 | 通过 |

最终测试总数：686；失败 0；跳过 0。`acceptance.json` 逐名核验其中 18 项关键用例。原账号池、额度、看板和 Windows 断面使用隔离的确定性测试，不冒称重新登录或人为耗尽线上账号；工具链和上下游格式的证明来自真实 CLI 与 Google，不由这些模拟边界测试替代。

## 原始证据索引

证据位于本机项目同级目录，均包含原始报文、实际客户端结果、正式安装包、SHA256 和只读校验脚本：

- `antigravity-tool-adapter-20261020.IaCeXh/`：Claude Read/Write、上下文投影和 agent 决定重试的边界。
- `antigravity-edit-shell-20261020.sgo8us/`：实际 Claude Code 2.1.285 Edit/Bash；12 个完整 Google 200；本轮重新只读校验通过。
- `antigravity-codex-tools-20261020.ggEFE3/`：实际 Codex 0.159.2、同批命令、原始多文件补丁、后台输入、图片字节；13 个完整 Google 200；本轮重新只读校验通过。
- `antigravity-hermes-tools-20261020.5DjZBT/`：实际 Hermes 0.21.7 的初始固定模板、四类工具和重启续接。
- `antigravity-framework-context-20261020.BQHdVn/`：正常加载 SOUL/AGENTS.md 的最终 Hermes 验收；基线/最终 14 个 Google 200、24 个 TLS 稳定字段对比；中间失败样本另存，不算最终通过。

单轮往返耗时不是首字时间，少量样本不用于宣称性能增减。HTTP/TLS 的可观测稳定字段一致，不等于 TCP 时序、服务端内部状态或风控判断完全一致。

## 明确保留的边界

- 客户端负责工具执行、权限、是否重试和是否重新开始任务；网关不成为另一个 agent。
- 用户 SOUL/项目规则不是可随意删除的“指纹”。不存在原生等价能力时保留真实声明，不编造能力凑格式。
- 未知客户端版本、修改过的工具 Schema、未知/重复歧义框架继续兼容原协议；不承诺未来版本无需适配就启用原生命名。
- `ANTIGRAVITY_DIRECT_RETRY_POLICY=agy` 仍仅是既有显式兼容选项，默认不运行那套隐藏恢复状态机。
- 本表的原始验收使用隔离正式安装，不把其后的发布或本机部署冒称新的上游实测；Windows 虚拟机部署不在这次验收范围内。
