# 四客户端工具真实执行验收

2026-11-07，**真实 CLI → 临时完整 Gateway → 本地合成 Google Antigravity API** 共 12/12 场景通过，包含 16 次客户端工具执行。没有真实模型调用，也没有证明本次 mock 通道的 TLS 指纹。

与仅断言转换结果的单元测试不同，本次由各 CLI 自己执行工具；随后核对实际磁盘内容、返回网关的工具结果、网关再次生成及最终回答。网关进程的 Seatbelt 明确禁止写入客户端工作目录。

## 已完成场景

| 客户端 | Write | Edit | Terminal |
| --- | --- | --- | --- |
| Claude Code 2.1.318 | 官方 `write_file` → `Write`，创建新文件 | 先 `Read`，再官方 `edit_file` → `Edit(replace_all:true)`，两处 old 均变 new | MCP → `Bash`，固定 printf 输出 marker |
| Pi 1.5.0 | 官方 `write_file` → `write`，创建新文件 | 先 read，再 MCP → `edit`，单次原始 `edits[]` 含两项，不拆成顺序调用 | MCP → `bash`，固定 printf 输出 marker |
| Hermes 0.21.7+11153.g2bd378e | 官方 `write_file` → `write_file`，创建新文件 | 先 read_file，再 MCP → `patch`，保留 path/old_string/new_string/replace_all | JSON MCP → `terminal`，保留 timeout/workdir/background，固定 printf 输出 marker |
| dsh 0.2.1-rc.2 | 官方 `write_file` → `write`，创建新文件 | 先 read，再官方 `edit_file` → `edit(replace_all:true)`，两处 old 均变 new | MCP → `bash`，保留 description/workdir/timeoutMs/run_in_background，固定 printf 输出 marker |

Hermes patch 本次实际执行的是精确替换分支；其完整模糊匹配契约仍由 MCP 保留，但不把本次结果宣传为九种模糊策略全部实跑。终端全部前台运行固定 `printf '%s\n' 'AGW_FIXED_TERMINAL_MARKER'`，未测试 PTY、后台任务或任意 shell 工作流。

聚合证据：[verified-summary.json](../tests/fixtures/client-tool-execution-20261107/verified-summary.json)。每项链接到完整脱敏样本，记录版本、源码前后摘要、原客户端声明、上游声明和调用、客户端 HTTP 响应、执行输出、磁盘 before/expected/actual、判定结果。各次运行源码稳定，但不同批次使用不同源码快照，不合并声称同一次运行。

执行过程中，网关接收到的工具声明直接来自当次真实 CLI 请求。合成 Google 服务通过同一转换器从指定客户端调用生成上游调用，并确认名称确实出现在当次上游声明中；随后完整网关将其反向转换。最终独立解析 Messages / Responses SSE，逐字段比较实际交给 CLI 的工具名称和参数，验证与计划完全一致，并核对调用 ID 与回传 native 名称。

## 隔离与故障修正

脚本：[verify-client-tool-execution.js](../scripts/verify-client-tool-execution.js)。账户是新建的假账号；不读取真实账号池。CLI 只能连接临时 Gateway 和 Hermes 自己的专用本地 WS 端口，正式 HOME 的配置不可读；文件写入只能发生在本次临时根目录。Google 服务只返回预先定义的目标文件操作及固定打印命令。结束后 `agy-tool-exec-*` 临时目录均已删除。

本次发现并完成了以下修正，初始失败样本仍保留：

- Claude 在 `--tools Write` 或 `Read,Edit` 下省略 compact system 中的 Session-specific guidance；Pi 仅启用 write 时省略 read 规则。身份识别已按实抓模板分支调整，权限、环境和用户规则保留，补测官方 Write/Edit 视图通过。
- Claude Bash 默认要写 `/private/tmp/claude-501`，外层隔离拒绝。使用其真实支持的 `CLAUDE_CODE_TMPDIR` 将运行状态放入私有目录后通过。
- dsh 原有 workspace-write sandbox 在外层 Seatbelt 中无法再创建嵌套 Seatbelt。仅本次测试进程使用安装包真实配置 `DSH_PERMISSION_MODE=danger-full-access`；**外层 Seatbelt 的目录、网络和正式 HOME 限制始终生效**。未给工具调用添加宽权限参数，也未修改全局设置。
- 一次并行启动碰到 Gateway 数据目录守护端口冲突，尚未发生推理和工具执行；改为单独启动后通过。脚本默认按顺序运行。

上述环境问题没有通过放松网关工具校验来解决。初始 Claude / Pi Write 即使只走完整兼容视图也真实执行成功，正式选择记录则使用补测后的官方 `write_file`。

## 复现与检查

```sh
node scripts/verify-client-tool-execution.js \
  --agents claude,pi,hermes,dsh --scenarios write,edit,terminal \
  --out tests/fixtures/client-tool-execution-new-run

node --test tests/client-tool-execution.test.js
```

需要 macOS Seatbelt 和本机对应 CLI。测试文件当前 14/14 通过，覆盖 12 份成功证据重放检查以及固定执行计划边界。所有能力结论限定为表中的实际参数和执行分支；真实模型是否主动正确选择这些工具，需与真实上游测试分开评价。
