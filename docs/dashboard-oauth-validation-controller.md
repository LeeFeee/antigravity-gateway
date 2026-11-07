# 隔离看板 OAuth 验收控制器

`scripts/verify-dashboard-oauth.js` 为真实 Google 授权准备独立看板。`preflight` 只检查官方 agy 1.5.2 和原生传输包，并创建空账号池；`start` 启动本地看板并等待用户操作。两步都不会调用添加账号接口，也不会提前启动 OAuth 的 5 分钟计时。

## 启动与用户操作

在仓库目录执行；应等本次代码修改完成后再准备，以便绑定完整源码快照：

```sh
node scripts/verify-dashboard-oauth.js preflight
```

输出包含 `stateFile`、`reportFile`、随机端口的 `dashboardUrl` 和可直接执行的 `startCommand`。`preflight` 阶段该 URL 尚未监听。复制输出的命令，例如：

```sh
node scripts/verify-dashboard-oauth.js start --state /private/tmp/agw-oauth-live-XXXXXX/control.json
```

命令返回 `waiting_for_user` 和看板 URL 后，用户打开这个新看板，点击正常的 Antigravity 添加账号按钮，在 Google 页面完成账号选择与授权。从点击按钮起，核心 OAuthFlow 才开始自己的 5 分钟计时。控制器不会代替用户点击 Google 授权，也不会打开或操作浏览器。

保留核心现有回调：优先使用 `http://localhost:51121/oauth-callback`，端口被占用时由核心选择临时端口；用户仍可在看板粘贴本次完整回调 URL。回调的来源、端口、路径、授权码和 state 校验不变，控制器不会改用官方网页回调地址。如果 Google 拒绝当前回调地址，应保留这个失败结论，不能把本地模拟的官方登录请求当作真实授权成功。

控制器最多等待用户操作 30 分钟。它以独立后台子进程运行，不创建或修改 launchd 服务。全程只使用本次随机端口，不使用正式网关端口。

## 自动检查与清理

用户完成授权后，控制器执行：

1. 观察真实 `AccountStore` 保存的唯一账号，核对身份、访问令牌、刷新令牌、项目和 OAuth 客户端字段是否存在，以及过期时间和文件权限；报告只保存存在性布尔值。
2. 显式请求一次 `/v1/models`，记录 HTTP 状态与模型数量。
3. 观察看板成功保存账号后正常触发的完整额度查询，不重复创建同一查询任务；核对 `retrieveUserQuotaSummary` 的状态和额度快照已保存，只导出分组数量等结构信息。核心正常的后台刷新及失败重试不被伪装成“仅一次上游调用”，报告会记录实际观察次数。
4. 停止临时网关，将本次新账号复制到同一私有临时根下的第二个 `AccountStore`，只让这个副本过期，然后经真实 `ManagedAccountAuthProvider` 与原生 Go 传输发起一次刷新。核对保存的新令牌有效期、身份保持、原临时账号内容不变。
5. 关闭原生传输，检查临时网关退出和端口关闭，删除全部临时配置与凭据，只保留目录外的脱敏报告。

报告的 `configuredProfile: oauth-http2` 表示实际选择了原生 OAuth HTTP/2 配置，不单独声称从这个控制器测量到 Google 端每个连接的协商结果。它保留真实 Go 实现，没有把传输替换成 Node fetch。上游观察器仅允许认证、项目初始化和目录/额度 RPC，拒绝生成请求；本验收不会消耗模型生成额度。

`onboardingObserved` 只说明此次账号是否实际走过 `onboardUser`。已有项目的账号可能不经过首次初始化，不能据此宣称真实首次 onboard 已完成。成功的代码交换、账号保存、目录/额度与刷新检查也分别留证，不与之前的官方 CLI 本地 mock 证据混淆。

## 凭据与诊断边界

正式 `~/.antigravity-gateway/accounts` 和官方 agy 登录凭据不参与此控制器。新进程的 HOME、TMPDIR、配置目录和环境变量独立；只读取安装代码与 agy 二进制中公开的 OAuth 客户端配置。

本次根目录权限为 `0700`，真实核心保存的账号文件权限为 `0600`。为了验证实际保存与刷新链路，新的授权凭据会短暂存在这些私有临时账号文件中，`finally` 负责删除；不使用假的内存 AccountStore。浏览器按正常流程显示授权页面与回调 URL，控制器不会把授权 URL、回调 URL、code、PKCE verifier、访问令牌、刷新令牌、邮箱、身份 ID 或项目 ID 写入报告。

核心 stdout/stderr 只排空、不保存；本次进程的普通核心诊断文件写入关闭。唯一保留的诊断是上游 endpoint、固定字段名、配置类型、HTTP 状态和固定枚举状态的结构投影。请求体和响应体的值都不写入证据。

## 查询与主动停止

等待期间查询：

```sh
node scripts/verify-dashboard-oauth.js status --state /private/tmp/agw-oauth-live-XXXXXX/control.json
```

主动停止：

```sh
node scripts/verify-dashboard-oauth.js stop --state /private/tmp/agw-oauth-live-XXXXXX/control.json
```

仅 `prepared` 状态会立即删除空目录；已运行的控制器接到停止请求后关闭自己启动的进程并清理。完成后临时 `stateFile` 已删除，使用最初输出的 `reportFile` 查询结果：

```sh
node scripts/verify-dashboard-oauth.js status --report /private/tmp/agw-oauth-result-XXXXXXXXXXXXXXXX.json
```

只有 `passed: true` 且 `temporaryCredentialsRemoved`、`gatewayStopped`、`portClosed`、`sourceUnchanged` 都为 `true`，才算这次控制器全流程通过。`preflight` 和受控 mock 测试通过不代表真实 Google 新授权完成。

## 当前验证范围

2026-11-07 的准备阶段：实际 `preflight` 通过，确认 agy 1.5.2、原生包校验、空账号池及 `0700/0600` 权限，随后删除未启动的空目录。控制器新增 7 项受控测试与当时的 OAuth/看板测试合计 23 项通过。受控测试以假 Google 响应连接真实 OAuthFlow、DashboardAccountAuth、AccountStore 和 ManagedAccountAuthProvider，验证保存、一次副本刷新、原文件不变、失败清理与脱敏；这些是后续真实验证之前的独立准备证据。

首次真实尝试保存在 [`dashboard-oauth-real-20261107.json`](../tests/fixtures/dashboard-oauth-real-20261107.json)。用户发现授权链接为空：前端仍只接受旧 `/oauth2/v2/auth` 路径，当前 OAuthFlow 则生成 `/o/oauth2/auth`。该次已取消、停止临时网关并删除凭据，结果为 `passed=false`，未被覆盖。路径校验和脚本内容版本缓存已修复；[`dashboard-auth-ui.test.js`](../tests/dashboard-auth-ui.test.js) 的 3 项回归覆盖当前 OAuthFlow 到前端显示／复制、非法目标拒绝及升级缓存版本。

修复后的独立真实结果见 [`dashboard-oauth-real-20261107-v2.json`](../tests/fixtures/dashboard-oauth-real-20261107-v2.json)：本地时间 02:52:11–02:59:05，`phase=completed`、`passed=true`，运行前后源码集合摘要均为 `6978dc4c32a2b7baab9ccbc79929d7bd1761ea6359bda5f1204f3cf15da56087`。用户完成 Google 浏览器授权，看板原有本地回调／完整 URL 提交流程成功完成授权与保存。观察到的授权码交换是 **401 → 200**，不能写成一次无失败的兑换；记录没有响应正文，不推断首次 401 的原因。

随后 `userinfo` 与项目发现均为 200；新账号必需字段齐全、令牌未过期。模型目录返回 200 和 20 个模型；正常保存账号触发一次额度查询并返回 200，持久化快照含 2 个 groups 和 19 个 modelQuota。停止临时网关后，新账号的隔离副本只刷新一次并取得 200，访问令牌更新、身份保持，原临时账号不变。`temporaryCredentialsRemoved`、`gatewayStopped`、`portClosed`、`sourceUnchanged` 全为 true。全部临时真实凭据已清理，正式账号未读取，未请求模型生成。

本次 `onboardingObserved=false`，验证的是已有项目账号的新授权，不是首次创建项目。用户已确认目前没有未初始化的 Google 测试账号；真实首次 onboard／operation 接受结果因缺少测试前提仍未验证。官方 CLI 的本地合成服务发包证据和相关受控回归保留，不能据此把首次初始化标为真实通过。
