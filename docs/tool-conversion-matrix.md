# 工具双向转换矩阵

基线为 Google Antigravity API 协议 1.5.2。实现位于 `src/antigravity-tool-contract.js`，测试位于 `tests/antigravity-tool-contract.test.js`。网关只转换声明、调用参数和结果关联；文件、shell、浏览器、子代理和客户端 MCP 工具仍由原 agent 执行。

## 证据和覆盖层级

| 证据 | 已证实内容 | 尚不能据此断言的内容 |
| --- | --- | --- |
| `tests/fixtures/antigravity-1.5.2-file-tools.json` | 官方 agy 1.5.2 实抓的 `read_file`、`write_file`、`edit_file` 名称、声明与参数；仅提取工具定义 | 客户端执行器与官方执行器所有输出格式、截断及状态副作用完全相同 |
| `tests/fixtures/antigravity-1.5.2-mcp.json` | 官方 MCP 名称形态、基本 Schema、必须的 `toolSummary`、成功和错误结果结构；官方复杂 Schema 转换确实存在丢失并导致 400 的样本 | 官方复杂 Schema 转换可直接复用 |
| `tests/fixtures/agent-requests-20261107/` | 四个真实客户端发给仅本机合成服务的请求；首轮、实际读取、错误、两个读取调用、图片工具结果、思考、恢复进程、Claude 动态工具加载 | 这些测试已调用真实模型供应商，或已经完成所有工具的真实执行验收 |
| 模块回归测试 | 实抓参数/结果可逆转换；官方字段子集；完整 Schema 校验；身份清理前后指纹；媒体、ID、签名和错误保留 | 模型每次都能选择最佳工具视图 |

当前匹配版本：Claude Code `2.1.318`，Pi `1.5.0`，Hermes `0.21.7+11153.g2bd378e`，dsh `0.2.1-rc.2`。只有身份模板版本与完整工具声明指纹同时匹配，才启用官方参数视图。提供 `clientVersion` 时还要求该版本一致；未知或修改过的声明仍获得完整 MCP 兼容声明。指纹不是基于名字的近似猜测。

Claude 同一版本选择 `gemini-3.8-flash-high` 时实测切换到精简 `# Harness` 模板，读写改三个工具的描述也随之变化。模块分别保存两组完整指纹，不因为 Schema 相同就放宽判断。精简分支证据保存在 `tests/fixtures/client-gateway-20261107/failures/claude-read-compact-template.json`；该文件记录发现分支时的失败现象，不能被描述为成功验收。

## 三种声明视图

一个客户端工具可以对应多个上游声明。`toClient` 总是恢复原客户端名和参数；上游调用 ID 和 thought signature 原样保留。

| 视图 | 何时使用 | 参数格式和边界 |
| --- | --- | --- |
| 官方参数子集 | 当前版本中经核查等价的读、写、精确全部替换操作 | 使用真实 `read_file` / `write_file` / `edit_file` 字段，收窄可调用范围；完整客户端功能同时有 MCP 入口 |
| 结构化 MCP | 根对象及嵌套 Schema 可表达为基础对象、数组、字符串、布尔、整数/数值、字符串枚举及支持的边界字段 | `mcp_gateway_tool_<稳定散列>`；保留原业务字段结构，新增声明所属的必填 `toolSummary`；本地仍执行原始 Schema |
| JSON MCP | 联合、引用、tuple、数值/对象枚举、const、条件、nullable、业务 `toolSummary` 冲突等不可直接表达的契约 | `mcp_gateway_tool_<稳定散列>_json`；外层 `{argumentsJson,toolSummary}`，内层是完整原始 JSON 值；解析一次后按原始 Schema 校验 |

名字遵循官方实抓的 `mcp_<server>_<tool>` 形态；`gateway` 是此转换层的命名空间，网关不因此启动 MCP 工具执行器。散列由原客户端工具名和视图种类确定，顺序变化不改变别名，名称重复或分配冲突不会静默覆盖。

`additionalProperties` 无法直接放入实测 protobuf Schema 字段。原 Schema 关闭对象时，用本地校验执行该限制；原 Schema 开放对象时，同时提供结构化的已知字段视图和完整 JSON 视图，额外业务字段走后者。嵌套开放对象同样处理。含 `exclusiveMinimum`、`format`、`$ref` 等不在直接投影词汇中的声明选择 JSON，不删掉约束后继续执行。官方 MCP 样本的整数最小值为 0，官方编码省略该 protobuf 默认值；本模块可以显式保留该值，仍以本地原始校验为准。

原工具显式声明 `toolSummary` 时，整个业务对象放入 `argumentsJson`；开放对象在调用时携带同名业务字段，也走 JSON。仅移除本模块生成声明中的外层元数据，绝不对客户端业务对象全局删除同名字段。两个视图都保留完整本地约束，不启用类型转换、默认值填充或额外字段删除。

## 官方参数映射

| 客户端工具 | 官方参数子集 | 启用条件 | 保留在完整兼容声明中的能力 |
| --- | --- | --- | --- |
| Claude `Read` | `read_file`: `file_path→Path`, `offset→StartLine`, `offset+limit-1→EndLine` | 绝对路径、已知文本/源码扩展名、明确正整数起始行和行数，最多 800 行；没有额外参数 | 默认读取、`offset=0`、PDF `pages`、`allow_large`、图片、超过 800 行或非文本路径 |
| Pi `read` | `path→Path`，行范围同上 | 同上；客户端行数参数必须实际为安全整数 | 相对路径、默认截断、图片及其他完整原契约 |
| Hermes `read_file` | `path→Path`，行范围同上 | 同上 | 默认 2000 行、约 100K 字符预算、`next_offset`、Office/PDF/SQLite 等提取行为 |
| dsh `read` | `file_path→Path`，行范围同上 | 同上 | 相对路径、默认 2000 行及客户端其他行为 |
| Claude `Write` / Pi `write` / Hermes `write_file` / dsh `write` | `file_path` 或 `path→Path`，`content→Content`，`Overwrite:true` | 绝对路径，仅路径与完整内容字段 | dsh 权限参数、相对路径、其他业务扩展字段 |
| Claude `Edit` / dsh `edit` | `file_path→Path`, `old_string→Target`, `new_string→Replacement` | 绝对路径、非空且不同的目标文本、明确 `replace_all:true`、没有额外参数 | 默认或显式单次替换、dsh 权限参数及其他扩展 |

读取视图严格限定显式文本行范围，但**不会假装执行了官方 46080 字节截断**。客户端的字节限制、格式、读前状态与权限仍然适用，并写入上游声明说明。网关不读取文件来猜编码、文件大小或实际类型；扩展名筛选只是能力视图的保守入口，工具真实结果仍由客户端产生。需要图片、文档、字节游标或完整客户端读取语义时，模型使用兼容声明；未支持的 `ByteOffset` 不会换算为假的行偏移。

写入视图要求 `Overwrite:true`，因为这些客户端执行的是创建或完整覆盖。不会伪造官方 `Append`、`ArtifactMetadata`，也不删除客户端读前检查、并发修改检测、权限或 Hermes 语法检查。精确编辑只映射替换所有完全相同文本的情况；不会把单次唯一替换假装成官方全部替换。

## 所有已捕获工具的归属

下表覆盖首轮和 Claude 实际 ToolSearch 展开后的声明。完整字段定义以实抓 JSON 为准，模块保留原始 Schema 并对每次恢复调用执行校验。

| 客户端 | 工具 | 转换策略 |
| --- | --- | --- |
| Claude | `Read`, `Write`, `Edit` | 官方受约束视图 + 完整 MCP |
| Claude | `Bash` | MCP；毫秒超时、后台执行、沙箱开关保留，不能近似成官方 shell |
| Claude | `Agent`, `ListAgents`, `ReportFindings`, `SendMessage` | MCP；客户端代理和协作语义保留 |
| Claude | `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `Monitor` | MCP；定时、通知和监视契约保留 |
| Claude | `EnterWorktree`, `ExitWorktree`, `NotebookEdit` | MCP；工作树/Notebook 参数不虚构官方等价工具 |
| Claude | `TaskCreate`, `TaskGet`, `TaskList`, `TaskStop`, `TaskUpdate` | MCP；任务/后台任务契约保留 |
| Claude | `Skill`, `Workflow`, `WebFetch` | MCP；客户端技能、工作流及网络工具契约保留 |
| Claude | `WebSearch` | MCP 外层契约保留；Claude 自行执行后发出独立 `web_search_20250305` 二级 Messages，专用转换层一次转发官方 helper 并交回原始链接/摘要。严格限制及验收状态见[实际边界](client-web-tool-boundaries.md) |
| Claude | `ToolSearch` | MCP；结果 `tool_reference` 展开为当轮实际已声明的上游视图，返回客户端时反向恢复并去重 |
| Claude | `DeferredToolPlaceholder` | 保留声明以维持客户端延迟工具布局；已验证的占位模板不可执行，调用时报明确错误 |
| Pi | `read`, `write` | 官方受约束视图 + 完整 MCP |
| Pi | `edit` | MCP；`edits[]` 对原始文件同时匹配、唯一性和非重叠约束不能降级为顺序官方编辑 |
| Pi | `bash` | MCP；保留秒单位超时与客户端执行语义 |
| Hermes | `read_file`, `write_file` | 官方受约束视图 + 完整 MCP |
| Hermes | `patch` | MCP；9 级模糊匹配、语法检查和原始参数保留，不声称等价于官方 exact edit |
| Hermes | `terminal` | JSON MCP；`notify` 联合类型、秒单位超时、后台/PTY、heartbeat、持久会话保留 |
| Hermes | `browser_exec`, `delegate_task`, `execute_code`, `manage_connections`, `memory` | MCP；原浏览器、子任务、执行器、连接和记忆契约保留 |
| Hermes | `search_files`, `skill_manage`, `skill_view`, `skills_list`, `vision_analyze`, `web_extract`, `web_search` | MCP；原检索、技能、视觉和网络契约保留 |
| Hermes | `tool_search`, `tool_describe`, `tool_call` | MCP；客户端工具注册与动态调用契约保留 |
| dsh | `read`, `write`, `edit` | 官方受约束视图 + 完整 MCP |
| dsh | `bash`, `job_kill`, `job_list`, `job_output` | MCP；毫秒时间、转后台、job ID、工作目录和权限参数保留 |
| dsh | `create_goal`, `get_goal`, `update_goal`, `todo_write`, `exit_plan_mode` | MCP；目标/待办/规划状态契约保留 |
| dsh | `interrupt_agent`, `list_agents`, `send_message`, `subagent`, `subagent_fork` | MCP；客户端协作和子代理行为保留 |
| dsh | `glob`, `grep`, `read_image`, `web_fetch`, `web_search` | MCP；原搜索、图片和网络契约保留 |
| dsh | `skill`, `workflow`, `working_directory` | MCP；技能、工作流和当前目录语义保留 |
| 其他客户端/版本 | 任意合法 function Schema | 简单结构 MCP 或完整 JSON MCP；未知工具名称不套用官方语义 |
| custom 文本工具 | `format:text` 或无 format | 包装 `{input:string}`，原始字符串完整保留，包括看似 JSON 的文本 |
| 已验证 custom `apply_patch` | 实抓 Codex `0.159.2` 的精确 Lark grammar | 原补丁全文保留；本地验证 Begin/End、Add/Delete/Update/Move、变更行及 EOF 格式 |
| 其他 custom grammar | 通过 `customToolValidators[name]` 提供明确校验器 | 无校验器时返回 `unsupported_tool_grammar`，不删除 grammar 后声称支持 |

这份表列的是请求转换能力。其最初请求采样只让客户端读取临时文件或图片、产生可控缺失文件错误，并返回合成模型响应；该批样本未执行批量编辑、shell、子代理、网络和文件写入，不能把声明抓取当成执行验收。

后续[网络工具执行来源审计](client-web-tool-boundaries.md)曾实抓到 Claude WebSearch 的二级服务器工具请求缺口；现按用户约定补入独立搜索服务转发，验收与不支持范围另行记录。Hermes 和 dsh 的内置搜索后端则独立配置并由客户端访问；它们的 MCP 契约保留不代表本网关提供这些搜索服务，也不代表实际搜索已验收。

后续验收已另行完成：[四客户端工具执行](client-tool-execution-validation.md) 的 **12/12 场景、16 次实际客户端执行**覆盖写入、Claude/dsh 精确全部替换、Pi 批量编辑、Hermes patch 和四客户端固定终端命令，经过完整临时网关、使用本地合成上游并核对磁盘结果；[四客户端压缩](agent-compaction-catalog.md) 实际触发压缩与续聊，并离线检查历史投影；[真实上游最小验收](real-client-gateway-validation.md) 的 **8/8** 是四 CLI 文本与读取的真实 Google 结果。这些是独立批次和不同证据层级，不把最初“仅读取”写成项目最终状态，也不把后续结果扩展为所有后台、PTY、子代理和网络工具已执行。

## 调用、结果与会话关联

`toProvider(call)` 把客户端调用转为当轮合适的声明视图，校验完整原契约后选择官方子集、结构化 MCP 或 JSON MCP。`toClient(call)` 必须接收已声明的上游名，先校验该视图，再恢复原参数并再次执行完整原契约校验。未知上游名、未知客户端名、缺失必填值、非法值或不支持的视图参数都返回明确错误。不能丢弃调用或把非法值改成默认值继续执行。

`toProviderResult(result, issuedCall)` 的第二个参数是**当时发出的上游调用** `{id,name,...}` 或已保存的上游工具名。一个客户端工具有多个视图时，不能只靠客户端工具名猜测结果应该回给哪个上游名；缺少关联时明确报错。名称或双方都存在的 ID 不匹配时也报错。它只映射结果名和工具引用，不重写 `content`、`isError`、媒体、签名或调用 ID，不制造客户端执行时间。

官方 MCP 的 `response.output` / `response.error` 容器由上层结果编码器构建；`resultContract(providerName)` 返回这两个字段名及 `timestamps:not-generated`、`media:preserve` 约定。真实 Claude 的 `is_error:true`、Pi 的 ENOENT 文本、Hermes 的 JSON 错误、dsh 的 Error 文本保持原始差异。图片继续保留在媒体结构中，不转成假文本结果。

`toProviderReferences(items)` 支持字符串或 `{type:'tool_reference',tool_name:...}`，把一个客户端工具展开为当轮所有已声明视图；逆向函数恢复并去重。工具发现下一轮添加的新声明必须重新建适配器。旧签名覆盖的调用、参数和历史，必须按当轮保存的上游投影恢复，不能拿新轮声明或仅凭名字重算。

## 集成接口

```js
const sourceTools = normalized.tools;
const cleaned = sanitizeClientIdentity(normalized);
const adapter = prepareAntigravityTools(cleaned.normalized, {
  sourceTools,
  clientIdentity: cleaned.metadata.profile,
  // clientVersion: 已验证的当前客户端版本，可选
});
```

| 字段/方法 | 集成含义 |
| --- | --- |
| `normalized` | 替换后的工具及 named tool choice；不修改 system、messages 或历史内容 |
| `instructions` | 原客户端工具名到各上游视图的索引；由集成层附加到上游系统指令，不写回用户历史 |
| `declarations` | 可直接发送的 `{name,description,parameters}` 列表 |
| `normalized.tools[].nativeSchema` | 大写类型的 protobuf Schema；不得再送入旧有损 `cleanToolSchema` |
| `records` | 原工具名、kind、完整 Schema/format、指纹、版本依据、视图清单；供审计/会话契约保存 |
| `toClient` / `toProvider` | 调用参数双向映射；保留 ID 和签名 |
| `toClientName` / `toProviderName` | 反向恢复名称 / 取得覆盖完整原契约的兼容视图名；named choice 使用完整视图 |
| `toProviderNames` | 一个客户端工具对应的全部视图 |
| `toClientReferences` / `toProviderReferences` | 动态工具引用双向转换 |
| `toClientResult` / `toProviderResult` | 结果名与引用双向映射；必须关联当时调用 |
| `resultContract` | 结果容器字段和媒体/时间边界 |

集成层须保存每轮真实上游调用名、参数、ID、签名及已恢复的客户端投影。`records` 是契约元数据，不等于已持久化的调用投影。结构化输出终结工具或网关自身图片工具若在适配之后添加，应由其专用分支处理；不能作为未知客户端工具交给该适配器猜测。

参数上限为 4 MiB、最大结构深度 64；完整 Schema 上限和方言支持由 `schema-contract.js` 管理。非有限数值、undefined、稀疏数组等不能无损 JSON 往返的值会明确报错。测试命令：

```sh
node --test tests/antigravity-tool-contract.test.js tests/agent-request-fixtures.test.js tests/schema-contract.test.js tests/client-identity.test.js
```
