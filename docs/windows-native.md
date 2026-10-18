# Windows 原生 Gemini 通道

在 1.5.1 基础上增量实现。原 Antigravity 代理、`add-gemini` OAuth、看板和对外接口保留；新增 Windows 会话授权及 WebChannel / `ProcessSession` 上游适配器。三条通道共享原 Antigravity 的选号策略，凭据和上游协议保持隔离。

## 添加账号

在 Windows 桌面的前台网关输入：

```text
add-gemini-win
```

1. 网关打开系统已安装的完整 Chrome，未安装时使用 Edge，并打印实际可执行文件路径。不下载测试浏览器，不使用 WebView、精简 Chromium 或 headless 登录。
2. 在专用窗口登录 Google，进入 Gemini 网页并完成首次使用确认。
3. **关闭本次专用登录窗口**。网关自动读取本次会话，核对账号身份并独立保存，终端显示账号邮箱与保存结果。

只需添加时打开浏览器；后续模型请求直接由 Node.js 发出。登录与模型列表刷新都不发送 Argon 推理请求。保存成功表示登录身份有效，不等于该账号一定拥有 Argon 权限或剩余额度。

`cancel` 取消本次授权；正常退出网关也会清理本次窗口和临时资料目录。失败、取消或超时后释放授权锁，不持久化“正在授权”状态。只关闭本次流程启动的进程，不清理系统其他 Chrome/Edge 窗口。无需安装 Gemini App。

可用 `ANTIGRAVITY_GEMINI_BROWSER` 指定系统 `chrome.exe` 或 `msedge.exe` 的绝对路径。浏览器版本由系统安装及其自身更新维护，网关不会下载替代版本，也不宣称已检查全球最新版本。无桌面 SSH/后台服务不能完成首次人工登录。

## 为什么登录后需要关闭窗口

登录阶段使用正常完整浏览器，**不启用远程调试、WebDriver、headless 或反检测脚本**。旧试验版在登录阶段传入 `--remote-debugging-port=0`，会触发 `navigator.webdriver` 标记；Google 明确可能阻止自动化浏览器登录。[浏览器行为](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)、[Google 登录说明](https://support.google.com/accounts/answer/7675428?hl=en)。这是已确认的启动参数问题，不代表已证明所有 Google 拦截都只有这一个原因。

关闭登录窗口后，网关使用同一个系统浏览器、同一个专用资料目录启动短暂的 `about:blank` 窗口，仅通过本机临时调试连接导出 Cookie，随后关闭并清理。该阶段不控制 Google 登录页，不读取日常浏览器资料、不修改 Gemini App，不要求用户关闭任何原有浏览器。

## 凭据和路由

| 添加命令 | 独立目录 | 选中该凭据后的上游 |
|---|---|---|
| `add` | `accounts/` | 原 Antigravity Cloud Code |
| `add-gemini` | `robin-accounts/` | 原 Robin OAuth / 原生任务通道 |
| `add-gemini-win` | `gemini-win-accounts/` | Windows WebChannel / `ProcessSession` |

目录位于 `%USERPROFILE%\.antigravity-gateway\`，或配置的 `ANTIGRAVITY_GATEWAY_CONFIG_DIR`。Windows 凭据带显式 `gemini-windows-session` 类型，以独立账号 ID 保存账号身份、Google 会话 Cookie 和 Windows 请求实例标识。同一 Google 账号的 OAuth 与 Windows 凭据可以并存；重新添加只更新同一 Windows 账号，不替换 OAuth。

凭据由原账号存储逻辑原子写入。类 Unix 系统使用私有目录/文件权限，Windows 继承用户目录 ACL。Cookie 是敏感凭据，不写入日志、README 或发布包。请求时刷新初始化元数据和认证，服务端返回的 Cookie 轮换会回写对应 Windows 文件。会话被吊销或到期后需要重新登录，不承诺 OAuth 式永久续期。

网关不按宿主系统猜测传输：选中 Windows 凭据就只走 WebChannel；选中 OAuth 凭据仍走 Robin。继续复用同一个 Gemini 调度池、故障处理、客户端会话隔离和工具执行边界。

旧试验版曾把 Windows 会话混存进 `robin-accounts/`。本版不自动改写这些文件，也不会把它们当作 OAuth 使用；请重新执行 `add-gemini-win` 保存至正确目录。原文件保留，原有 1.5.1 OAuth 不受影响。

## 客户端不需要新接口

仍使用原网关地址、`gemini-4-argon` 模型名以及 Messages / Chat Completions / Responses。Windows 适配器把模型响应和工具调用转换成原有统一格式，工具继续由 agent 客户端执行，不执行模型输出中的本地命令。

支持文本、SSE、客户端工具往返与结构化输出。Windows 通道暂不支持非视频附件，实测 token 用量仍未知。5 小时/周额度单独查询并参与调度，见下节。视频仍走原 Cloud Code 判断和路由；原 Robin 的附件、MCP 和额度接口不变。不增加思考档位或猜测 Windows/Linux surface 值。

模型目录只声明支持的路由，真实权限与额度由实际调用时的上游响应决定。上游错误保留；响应模型与 Argon 不符时拒绝静默降级，不擅自判断成额度耗尽。账号切换沿用原机制，已交付的工具任务不会迁移或重放。

## 账号额度与轮询

- 使用当前 Windows 账号 Cookie，在身份核对后读取官方用量页面的 `UsagePageQuery → viewer.rpcs.getUsageInfo`，只发送 GET，不发送模型请求，也不修改付费额度或智能模型选择设置。
- 读取 `GXU_FIVE_HOURLY` / `GXU_WEEKLY` 的 `percentageUsed`（0～1）及 `gxu.windowRefreshesAt`，统一为剩余比例和重置时间。不是根据请求次数、token 数或错误信息猜额度。
- 额度写入该 Windows 账号的 `providerMetadata.geminiWindowsQuota`；原 OAuth 的 `robinQuota` 保持隔离。复用原账号看板、状态输出和调度；无需另一套轮询器。
- 新增账号后立即在后台查询；三条通道统一使用 30 分钟快照有效期及后台刷新周期。新绑定发现缺失/失效字段或实际调用额度失败时异步补查，同账号至少间隔 5 分钟，合并重复请求。查询失败保留上次结果及其原始观测时间，不把未知显示成 0% 或 100%，也不封禁账号。
- 三条通道调用同一个 `src/account-scheduling.js`：健康会话保持固定 5 小时黏性，成功请求不续期；新绑定和故障转移按账号权重 × Gemini 周额度压力权重 × 同档最早 5 小时重置权重进行平滑加权轮询。有效周压力的最高、相邻、其余档分别为 4/2/1 倍，同档最早重置再乘 2。
- 有其他可用账号时避开额度耗尽快照；只剩耗尽快照时保留最后兜底，以实际请求为准，不把快照当作账号禁用。已绑定的健康会话不因后台快照变化而切号。实际限流按上游重试时间冷却，无时间信息时默认 60 秒；瞬态失败冷却 15 秒，单次请求每账号最多尝试一次。
- 各额度窗口分别判断重置时间，5 小时重置不会解除仍有效的周额度耗尽标记。账号健康状态与额度展示分离；终端会明确提示耗尽快照仅作兜底。已经交付给客户端的工具任务保持原账号，不迁移或重放。
- 删除、停用或重新授权期间返回的旧查询结果不能覆盖新凭据；重新授权清除旧额度并重查。首次异步查询尚未完成、查询失败或快照过期时，实际请求的上游结果仍是最终依据。

`ANTIGRAVITY_AFFINITY_TTL_SECONDS` 统一控制三条通道的软黏性。旧 `ANTIGRAVITY_ROBIN_AFFINITY_TTL_SECONDS` 仅在前者未设置时作为统一兼容别名，不再让不同通道使用不同期限。上游任务生命周期、权限判断和工具任务保护仍由各自适配器负责。

2026-10-18 已在 Windows 虚拟机用两个真实已保存账号确认该接口返回 5 小时/周额度和重置时间，其中一个账号的 5 小时已用比例为 1，另一个为 0。实现使用当日官方客户端的已验证查询签名；上游若变更查询格式会报告额度未知，不回退到推理探测，不伪造余额。额度是服务端计算量预算，不等于精确 token 数。

## 验证边界

WebChannel 编解码、请求身份和客户端适配复用此前已在 Windows 跑通的实现，包括真实 Claude Code 工具往返。本次只重做授权入口、凭据隔离与无试探请求的目录逻辑，使用本地回归覆盖；不重复登录真实账号或消耗模型额度。新的普通浏览器登录流程尚未重新完成人工 Google 登录验收，不把旧测试结果冒充新流程已通过。

统一调度另有三通道对照回归：相同额度/权重下逐次选号序列一致，覆盖黏性期限、重启恢复、耗尽兜底、冷却与失败切换、凭据过滤，以及 OAuth/Windows 混合池分配。本轮不启动已安装网关，不发送真实模型请求。
