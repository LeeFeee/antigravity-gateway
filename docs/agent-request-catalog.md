# 本机 Agent 真实请求目录

采样日期：2026-11-07，Asia/Kuala_Lumpur。此目录记录 **真实客户端 → 本机合成服务** 的请求，不是静态源码推测，也不是客户端经网关访问真实 Google Antigravity API 的验收。

## 1. 证据与复现

脚本：[scripts/probe-agent-requests.js](../scripts/probe-agent-requests.js)。样本：[tests/fixtures/agent-requests-20261107](../tests/fixtures/agent-requests-20261107)。每份样本保存版本、命令、退出状态、请求顺序、完整脱敏 HTTP 头、请求体、客户端输出及错误。`captures[].stage` 区分首次进程与续接进程；`realModelValidated: false` 明确表示没有真实模型参与。

```sh
node scripts/probe-agent-requests.js --scenario first
node scripts/probe-agent-requests.js --scenario read
node scripts/probe-agent-requests.js --scenario thinking
node scripts/probe-agent-requests.js --scenario resume
node scripts/probe-agent-requests.js --agents hermes --scenario identity
node scripts/probe-agent-requests.js --agents claude --scenario tool-search
node scripts/probe-agent-requests.js --scenario read-error
node scripts/probe-agent-requests.js --scenario parallel-read
node scripts/probe-agent-requests.js --scenario image
node scripts/probe-agent-requests.js --agents claude,pi --scenario image-input
```

使用与已安装 CLI 对应的 Node；本次执行器为 Node 22.23.4。可用 `--agents` 选择客户端、`--out` 设置样本目录、`--timeout` 设置每次进程期限。探测失败会保存诊断并返回非零状态。

每次运行使用独立临时 HOME、配置、工作目录、测试文件和假密钥。macOS Seatbelt 禁止非 loopback 网络连接，并禁止写入本次临时目录以外的位置；只额外开放临时目录内的 Unix socket 供 Hermes 内部网关通信。脚本在其他平台拒绝不受隔离的运行。系统依赖只读使用；Hermes 的依赖环境指针与租约单独放在临时目录，不修改原配置、依赖或凭据。捕获完成后停止本次 HOME 对应的临时 Hermes 网关，保留临时目录供检查。

合成服务只返回固定文本、已声明的读取工具或客户端自己的工具声明查询。没有真实模型决定执行内容；所有文件读取目标均由脚本限定在临时测试文件。真实凭据不进入子进程环境。样本将假鉴权、用户目录、临时路径与动态端口替换为占位值，保留协议结构。合成文本按三段 SSE delta 返回，工具参数按至多 19 字符分片返回。

## 2. 当前基线与覆盖

| Agent | 实际版本 | 已捕获推理接口 | 首次声明 | 基础场景 |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.318 | `POST /v1/messages?beta=true` | 12 项，含 1 个不可调用占位项；ToolSearch 后 27 项 | 首请求、分片 SSE、读取／错误／同轮双工具、高思考配置、跨进程恢复、动态工具加载、直接图片与工具图片 |
| Hermes | 0.21.7+11153.g2bd378e | `POST /v1/responses` | 19 项 | 首请求、分片 SSE、读取／错误／同轮双工具、高思考配置、跨进程恢复、默认身份／用户 SOUL 对照、辅助标题、原生工具图片 |
| Pi | 1.5.0 | `POST /v1/responses` | 4 项 | 首请求、分片 SSE、读取／错误／同轮双工具、高思考配置、跨进程恢复、直接图片与工具图片 |
| dsh | 0.2.1-rc.2 | `POST /v1/responses` | 25 项 | 首请求、分片 SSE、读取／错误／同轮双工具、高思考配置、跨进程恢复、辅助标题、工具图片 |

所有基础场景均由真实 CLI 发起并正常退出。工具数量是本次隔离配置下声明的数量，不代表所有可安装扩展或所有权限模式的全集。Hermes 提交为 `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`；不能将其标成正式版 0.21.7。

后续[客户端搜索工具审计](client-web-tool-boundaries.md)另捕获 Claude 2.1.318 执行 WebSearch 时向同一 baseURL 发出的 `web_search_20250305` 二级 Messages；当前转换器明确拒绝，客户端将错误回传，不能因外层声明和正常退出而记为搜索成功。Hermes／dsh 的独立搜索后端仅作静态核查，未实际联网搜索。

## 3. HTTP 与请求字段

| Agent | UA | 特有头部／行为 | 主请求顶层字段 |
| --- | --- | --- | --- |
| Claude | `claude-cli/2.1.318 (external, sdk-cli)` | `x-api-key`、`anthropic-version: 2023-06-01`、`anthropic-beta`、`x-claude-code-session-id`、`x-app: cli`、Stainless 头；SDK 内置 runtime 报告 Node 26.12.1 | `model,messages,system,tools,metadata,max_tokens,thinking,context_management,output_config,stream` |
| Hermes | `OpenAI/Python 2.54.0` | Bearer、Stainless Python/CPython 3.14.9 头；主请求 read timeout 1800，标题请求 30 | `include,instructions,model,parallel_tool_calls,prompt_cache_key,reasoning,store,stream,tool_choice,input,tools` |
| Pi | `pi/1.5.0 (darwin; node/v22.23.4; arm64)` | Bearer、`session_id`、`x-client-request-id`、Stainless 7.19.0 头 | `model,input,stream,prompt_cache_key,store,max_output_tokens,tools,reasoning,include` |
| dsh | `deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)` | Bearer、`session_id`、`x-client-request-id`、Stainless 7.19.0 头 | 同 Pi；标题请求省略 `tools` |

完整头部，包括 beta 列表、编码与 content length，以 fixture 为准。转换器不应把客户端身份头直接转发给 Google Antigravity API；上游头部由统一编码器生成。

Hermes 还会尝试 `GET /api/v1/models`、`GET /v1/models/:id`、`GET /v1/models`、`POST /api/show` 以探测模型元信息。本机合成服务对未知 `/api/show` 返回 404 后，主推理仍能完成；不能把这些探测路径误认成必须增加的第三种推理协议。Hermes 与 dsh 的标题请求是辅助推理，应分别识别其无工具、较短提示和流式配置，避免错误继承主工具集。

## 4. 思考、消息和恢复

| Agent | 实际观察 |
| --- | --- |
| Claude | 本次默认及显式 `--effort high` 都发送 `thinking:{type:"adaptive",display:"updates"}`、`output_config:{effort:"high"}`、`context_management.edits:[{type:"clear_thinking_20251015",keep:"all"}]`。不能据此推断所有 Claude 模型均使用相同配置。 |
| Hermes | 默认主请求 `reasoning:{effort:"medium",summary:"auto"}`；`--reasoning high` 发送 high。标题请求不带 reasoning。 |
| Pi | 默认 medium，`--thinking high` 发送 high；包含 `include:["reasoning.encrypted_content"]` 与 `store:false`。 |
| dsh | 本次配置将 provider 的 `reasoningEfforts.high` 和默认档位设置为 high，因此发送 high；这不是对其全局默认值的判断。 |

重构后的带档位模型名称决定 Google Antigravity API 思考配置；上述客户端字段仅记录为输入事实，冲突时按产品约定忽略，不能覆盖模型档位。

读取往返证据：Claude 使用 `assistant.tool_use → user.tool_result`；其他三者使用 Responses `function_call → function_call_output`。读取结果分别保留客户端原格式：Claude 为行号加 tab，Pi 为原文，Hermes 为带行号的读取结果，dsh 为 `<path>/<type>/<content>` 包装。它们不是可互换的结果文本模板。

`resume` 场景实际关闭第一个 CLI、用其返回的 session ID 启动第二个 CLI。在本次样本中四者都重新发送历史与新用户输入；Responses 客户端未依赖 `previous_response_id`。因此本次证实的是客户端持久化后的完整历史重放，不是 Responses 服务端存储或不透明思考签名恢复。

## 5. 身份与用户内容边界

| 来源 | 实际证据 | 转换约束 |
| --- | --- | --- |
| Claude 框架 system | 第一个 text 块为 `x-anthropic-billing-header:`；另一个独立块为 `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | 可定位删除计费标记及身份句；不删除其他系统规则 |
| Claude 自动 user 提醒 | `<system-reminder>` 内从 `Attribution for git commits and pull requests you create from here on` 开始，列出框架默认 Co-Authored-By 与 PR attribution | 用完整框架结构锚点定位；不能删除用户自己写的提交规则、引用内容或任何仅包含 Claude 的文本 |
| Claude 自动模型提醒 | 独立 `<system-reminder>` 块含 `You are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6. Assistant knowledge cutoff is August 2025.` | 本次由 CLI 注入，必须同时有已识别框架和提醒前缀作为来源依据；脱离来源组合的用户引用保留 |
| Hermes 默认身份 | `hermes-identity.json` 的 instructions 首句为 `You are Hermes Agent, built by Nous Research.`，同段随后是 `Be direct: ...` 行为要求 | 只处理身份句，保留后半段行为要求 |
| Hermes 用户 SOUL | 其余 Hermes 场景临时 SOUL 的唯一内容是 `PROBE_USER_SOUL: You are a fixture assistant. Preserve this user-authored identity.`；原样出现在 instructions 开头 | 这是用户来源哨兵，必须保留；随后框架自动追加帮助文档、工具和执行规则，不能按整个 instructions 统一删除 |
| Pi 框架 developer | `You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.` | 可中性化框架自称，保留能力与行为描述、工具和文档规则 |
| dsh 框架 developer | `You are an AI agent powered by DeepSeek Harness.`；下一段为 `You are a coding agent powered by the gemini-3.8-flash-high model.` | 框架自称及其注入的模型身份可按模板处理；不得删后续读取、权限或后台任务规则 |
| dsh runtime context | 用户角色中自动插入 cwd、文件策略与 approval policy | 这是执行约束，不是可随身份清理删掉的噪声 |

这些样本没有加载真实用户项目、AGENTS.md 或用户对话。它们证明已知模板的边界，不证明任意混合 system 文本都可以无误还原来源。误把权限约束当作身份、按品牌词全局替换，均不符合产品约定。

## 6. 工具声明索引

以下表格从真实 fixture 提取顶层参数名。完整类型、默认值、required、描述、嵌套数组和约束全部保存在原 fixture，表格不能替代 Schema。工具按客户端实际契约转换；名称相同不代表语义等价。

关键差异：

- Claude `Read` 包含 PDF `pages`、`allow_large` 以及图片能力；不能只按文本行号映射全部能力。
- Pi `edit` 的参数已是 `path + edits[]`，每个替换针对原始文件的唯一、不重叠区域，不能静默拆成多个顺序 edit。
- Hermes `patch` 声明九种模糊匹配策略并自动语法检查；不等价于单纯精确字符串替换。其 `read_file` 还会提取 Office、PDF、SQLite 等文档，且明确不读图片／二进制。
- dsh 文件编辑参数包含 `sandbox_permissions`、`justification`；终端包含 `workdir`、后台和权限语义。这些必须保留为客户端执行契约。
- Claude `ToolSearch` 已实际返回 `tool_result.content:[{type:"tool_reference",tool_name:...}]`；下一轮声明由 12 增至 27。转换器必须同步处理动态声明和引用，不能丢弃 `tool_reference` 或继续使用旧声明映射。`DeferredToolPlaceholder` 的描述明确要求 never call，不得把它当成可执行能力。

<!-- GENERATED_TOOL_TABLES -->

### Claude Code（含已加载延迟工具）

| 名称 | 顶层参数 |
| --- | --- |
| `Agent` | `description, prompt, subagent_type, model, effort, run_in_background, isolation` |
| `Bash` | `command, timeout, description, run_in_background, dangerouslyDisableSandbox` |
| `CronCreate` | `cron, prompt, recurring, durable` |
| `CronDelete` | `id` |
| `CronList` | `无` |
| `Edit` | `file_path, old_string, new_string, replace_all` |
| `EnterWorktree` | `name, path` |
| `ExitWorktree` | `action, discard_changes` |
| `ListAgents` | `channel, q` |
| `Monitor` | `description, timeout_ms, command, ws` |
| `NotebookEdit` | `notebook_path, cell_id, new_source, cell_type, edit_mode` |
| `Read` | `file_path, offset, limit, pages, allow_large` |
| `ReportFindings` | `level, findings` |
| `ScheduleWakeup` | `delaySeconds, reason, prompt, stop, noop` |
| `SendMessage` | `to, summary, message, notify_when_idle` |
| `Skill` | `skill, args` |
| `TaskCreate` | `subject, description, activeForm, metadata` |
| `TaskGet` | `taskId` |
| `TaskList` | `无` |
| `TaskStop` | `task_id, shell_id` |
| `TaskUpdate` | `taskId, subject, description, activeForm, status, addBlocks, addBlockedBy, owner, metadata` |
| `ToolSearch` | `query, max_results` |
| `WebFetch` | `url, prompt, offset` |
| `WebSearch` | `query, allowed_domains, blocked_domains` |
| `Workflow` | `script, name, description, title, args, scriptPath, resumeFromRunId` |
| `DeferredToolPlaceholder` | `无` |
| `Write` | `file_path, content` |

### Hermes

| 名称 | 顶层参数 |
| --- | --- |
| `browser_exec` | `code, session, timeout_s` |
| `delegate_task` | `tasks` |
| `execute_code` | `code, reset` |
| `manage_connections` | `action, connectors, force` |
| `memory` | `target, operations` |
| `patch` | `path, old_string, new_string, replace_all` |
| `read_file` | `path, offset, limit` |
| `search_files` | `pattern, target, path, file_glob, limit, offset, order, output_mode, context` |
| `skill_manage` | `operations` |
| `skill_view` | `name, file_path` |
| `skills_list` | `category` |
| `terminal` | `command, background, timeout, workdir, pty, notify, heartbeat, persist_on_release` |
| `vision_analyze` | `image_url, question, region` |
| `web_extract` | `urls, char_limit` |
| `web_search` | `query, limit` |
| `write_file` | `path, content` |
| `tool_search` | `queries, limit` |
| `tool_describe` | `names` |
| `tool_call` | `calls` |

### Pi

| 名称 | 顶层参数 |
| --- | --- |
| `read` | `path, offset, limit` |
| `bash` | `command, timeout` |
| `edit` | `path, edits` |
| `write` | `path, content` |

### dsh

| 名称 | 顶层参数 |
| --- | --- |
| `bash` | `description, command, timeoutMs, workdir, run_in_background, sandbox_permissions, justification` |
| `create_goal` | `objective, max_goal_rounds` |
| `edit` | `file_path, old_string, new_string, replace_all, sandbox_permissions, justification` |
| `exit_plan_mode` | `plan` |
| `get_goal` | `无` |
| `glob` | `pattern, path` |
| `grep` | `pattern, path, include` |
| `interrupt_agent` | `agent_id` |
| `job_kill` | `job_id, reason` |
| `job_list` | `无` |
| `job_output` | `job_id, wait, timeout_ms` |
| `list_agents` | `scope` |
| `read` | `file_path, offset, limit` |
| `read_image` | `file_path` |
| `send_message` | `agent_id, message` |
| `skill` | `name` |
| `subagent` | `cwd, description, prompt` |
| `subagent_fork` | `cwd, description, prompt` |
| `todo_write` | `todos` |
| `update_goal` | `goal_id, revision, action, objective, max_goal_rounds, blocked_reason` |
| `web_fetch` | `url` |
| `web_search` | `queries` |
| `workflow` | `script, meta, args, run_in_background` |
| `working_directory` | `cd` |
| `write` | `file_path, content, sandbox_permissions, justification` |

## 7. 错误、同轮多工具与图片

当前共有 33 份场景样本：32 份成功捕获并正常退出，1 份记录当前 Hermes oneshot 不支持 `--image` 的客户端拒绝。后者没有发出模型请求，不列作图片接口成功。

### 7.1 读取错误

四个客户端均真实尝试读取不存在的临时文件 `probe-missing.txt`，保留各自错误编码后完成后续请求：

| Agent | 发给模型的错误形态 |
| --- | --- |
| Claude | `tool_result.is_error:true`，文本 `File does not exist...`；仍保留 `tool_use_id` |
| Pi | `function_call_output.output` 为 `ENOENT: no such file or directory...` 字符串 |
| Hermes | `function_call_output.output` 为 JSON 字符串，含 `error`、`not_found:true`、`similar_files`，以及空 content 和文件信息 |
| dsh | `function_call_output.output` 为 `Error: cannot read ...: not found` 字符串 |

不能假设 Responses 输入一定携带独立 `is_error` 布尔值，也不能把这些错误内容转换成成功的空文本。

### 7.2 同轮双工具

`parallel-read` 在同一次合成模型响应中返回两次读取，使用不同调用 ID、不同临时文件。四个客户端均在后续请求中正确关联两次结果。样本验证的是同轮并列工具与结果关联，没有测量客户端执行器是否在时间上真正并发执行。

### 7.3 图片输入与工具媒体

测试图片由脚本直接编码为 2×2 RGB PNG，77 字节，SHA-256 为 `886eca293713dd0dc77ee8c492c64e81359f6e0286b79d5f6df20c506466d1e2`；不调用图片生成模型。

| Agent | 成功入口／触发 | 实际请求结构 |
| --- | --- | --- |
| Claude | CLI 的 stream-json 用户输入；`Read` 读取 PNG | 用户 content 或 tool_result.content 内的 `{type:"image",source:{type:"base64",media_type:"image/png",data:...}}` |
| Pi | CLI `@图片路径`；`read` 读取 PNG | Responses 的 `{type:"input_image",detail:"auto",image_url:"data:image/png;base64,..."}`；工具图片放入 `function_call_output.output` 内容数组 |
| Hermes | `vision_analyze` 读取本地 PNG，配置 `model.supports_vision:true` 和 `agent.image_input_mode:native` | `function_call_output.output:[{type:"input_text",...},{type:"input_image",image_url:"data:image/png;base64,..."}]`；本轮未走辅助视觉模型 |
| dsh | 模型配置声明 `input:[text,image]` 后调用 `read_image` | `function_call_output.output` 内容数组含说明文本与 input_image；说明包含尺寸、MIME、内容哈希和只读附件路径 |

这些是媒体传输证据，不证明真实模型理解了图片。模型能力配置与请求编码分别记录；没有声明图片能力时，dsh 的读取工具会在客户端拒绝读图，不能据此判定上游模型不支持图片。

Hermes 当前 `chat --oneshot --image` 被 `hermes_cli/gateway_chat.py` 的 `_UNSUPPORTED` 明确拒绝，并提示改用 TUI 或 Desktop。`hermes-image-input.json` 保留这一实际错误；不能因为 `--help` 中有 `--image` 就宣称该运行路径支持直接附件。dsh 的 headless CLI 公开参数为 task、session ID、JSON 输出，没有图片附件参数；本次通过它已声明的 `read_image` 获取真实媒体请求，不伪造不存在的 CLI 选项。

## 8. 尚未验证的边界

本目录的原始采样不包含真实 Google Antigravity API 响应、真实思考签名、模型生成图片／视频、长会话自动压缩、所有 MCP 服务、所有用户扩展、取消重试和断流恢复。因此不能把这批样本写成这些能力已经全部通过的证明。工具声明的抓取不等于已执行每个工具；这批采样只执行受控读取和 Claude 的元数据查询。

项目后续已有独立证据：[四客户端真实上游最小验收](real-client-gateway-validation.md) 记录文本及读取 **8/8**；[四客户端工具执行](client-tool-execution-validation.md) 记录完整临时网关加本地合成上游的 **12/12 场景、16 次实际工具执行**，覆盖写入、精确编辑、批量编辑、patch 和固定终端命令；[四客户端压缩目录](agent-compaction-catalog.md) 记录真实客户端触发压缩/续聊及离线历史投影回归。[媒体 HTTP 验收](gateway-media-integration.md) 另有真实 Google 代表结果和本地边界测试。这些后续结果不回写为原始采样的能力，但也不能因本节“仅读取”的历史边界把它们遗漏。

尚未抓取 Hermes TUI／Desktop 的直接附件、更多图片格式及尺寸、图片工具失败、音视频与文档附件。公开接口与 Google Antigravity API 的转换和真实上游回归由网关集成验收覆盖。

当前入口对本次发现的未知语义内容块、输入引用与带类型工具的处理，以及停止序列修复，见 [请求输入边界](input-boundaries.md)。
