# 官方 agy 1.5.2 登录、刷新与首次 onboard 请求证据

2026-11-07，使用已安装、未修改的官方 agy 1.5.2 二进制完成四组本地探测。脚本为 [`scripts/probe-official-auth.py`](../scripts/probe-official-auth.py)，脱敏记录在 [`tests/fixtures/official-auth-20261107`](../tests/fixtures/official-auth-20261107)。每份记录含二进制 SHA-256 和实际 `--version` 输出。

这四组官方 CLI 记录证明客户端实际生成的请求格式，其网络响应全部由本地假服务提供，没有访问 Google、使用真实账号、完成真实授权码兑换或真实注册项目。文末分别列出后续已有托管账号的真实刷新，以及用户通过隔离看板新增账号的真实授权验证；三批来源不能混作官方 CLI 的真实登录证据。

## 隔离方式

- 每个场景使用独立临时 HOME、工作目录和配置目录；仅写入合成 token 或合成授权码，不复制正式凭据。
- CLI 和代理都运行于 macOS Seatbelt：网络只允许 loopback；写入仅允许临时目录；禁止读取真实 HOME，唯一例外为官方二进制；禁止 Keychain 服务和 `/usr/bin/open`。
- `mitmdump` 使用 lazy connection；每个请求无条件由插件生成响应，不转发。代理 CA 仅通过该进程的 `SSL_CERT_FILE` 生效，不写系统信任库。
- OAuth secret、token、授权码、state、PKCE verifier/challenge 在保存记录前清理；临时目录结束后删除。

复现：

```sh
python3 scripts/probe-official-auth.py --out /private/tmp/agw-auth-evidence
node --test tests/official-auth-fixtures.test.js
```

## 登录授权 URL 与授权码交换

官方 `agy acp --login` 会打印授权 URL，并允许粘贴授权码。本次向它输入固定合成授权码，假 token 服务返回合成凭据；官方成功完成本地登录流程。没有打开浏览器或获得 Google 颁发的授权码。

实际授权地址为 `https://accounts.google.com/o/oauth2/auth`，参数包含：

| 字段 | 官方实抓值 |
| --- | --- |
| client_id | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` |
| access_type / prompt | `offline` / `consent` |
| response_type | `code` |
| redirect_uri | `https://antigravity.google/oauth-callback` |
| code_challenge_method | `S256`，同时有动态 code_challenge 和 state |
| scope | cloud-platform、userinfo.email、userinfo.profile、cclog、experimentsandconfigs、aicode，以及 `openid` |

前六个 Google scope 均使用 `https://www.googleapis.com/auth/` 前缀。这个 redirect_uri 来自官方终端粘贴流程；看板的本地回调属于自己的交互方式，不能据此声称已验证相同回调。

授权码交换实际为 `POST https://oauth2.googleapis.com/token`，HTTP/2，`User-Agent: Go-http-client/2.0`，`Content-Type: application/x-www-form-urlencoded`。表单字段为 `client_id`、`client_secret`、`code`、`code_verifier`、`grant_type=authorization_code`、`redirect_uri`。

## 凭据刷新与用户信息

在新的临时官方凭据文件中写入过期的合成 token，启动 ACP 并创建会话，官方实际发出刷新请求。

刷新同样使用上述 token endpoint、HTTP/2、Go UA 与表单编码；字段仅为 `client_id`、`client_secret`、`grant_type=refresh_token`、`refresh_token`。本次启动时观察到两个刷新请求，记录原样保留，没有据此要求网关重复刷新。

用户信息是 `GET https://www.googleapis.com/oauth2/v2/userinfo`，没有 `alt=json`。观察到 Go HTTP/2 与 HTTP/1.1 两种传输路径，带 Bearer 授权。

## 首次 onboard 与操作轮询

ACP `session/new` 会读取 metadata，但本次即使 `loadCodeAssist` 返回无 project，也未主动 onboard。官方 print 模式的账号资格检查才触发首次 onboard。

本地假 `loadCodeAssist` 返回 `allowedTiers: [{id: "free-tier", isDefault: true}]`，不提供已建立的 tier/project。官方实际请求如下：

```text
POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser
User-Agent: antigravity/cli/1.5.2 (aidev_client; os_type=darwin; arch=arm64; cl=1015175089; auth_method=consumer)
Content-Type: application/json
```

```json
{"tierId":"free-tier","metadata":{"ideType":"ANTIGRAVITY"}}
```

HTTP 为 1.1；还有 Host、Content-Length、Authorization、Accept-Encoding。没有 Hub UA、`x-goog-api-client` 或未出现的附加 metadata。print 模式不带 host_path；ACP 场景的 metadata 请求带实际 ACP 客户端的 host_path。

第二组 mock 将首次 onboard 回包设为 `done:false`，官方随后实际发出：

```text
GET https://daily-cloudcode-pa.googleapis.com/v1internal/operations/synthetic-onboard
```

GET 无 JSON 内容，继续使用同一 Google Antigravity API 的 CLI 头。假 operation 完成回包使用 protobuf Any：`response.@type=type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse`，并附合成 project。官方接受该回包后继续执行，最终因为假目录故意不提供模型而退出；两组 onboard 均未发出模型生成请求。

## 证据边界

上述官方本地探测本身未验证真实 Google 授权页面、真实 token 兑换/刷新成功、Google 对本地回调的接受情况、企业登录、非默认 tier 或实际 project 创建。代理能够观察官方到本地代理的 HTTP 协议；不证明代理到 Google 的 TLS 行为。现有正式账号、正式服务与全局安装均未改动。后续真实刷新和看板新增授权分别取得了下文的独立证据；真实首次 onboard、企业登录与非默认 tier 仍未验证。

## 认证实现接入

同日重构已按这些请求证据更新 `oauth-flow.js`、托管账号刷新及原生传输：授权 endpoint／scope／PKCE、token 表单与 Go UA、无 `alt` 的 userinfo、daily 项目发现、camelCase onboard 字段及 GET operation 轮询均已接入。看板继续使用原来的本地回调和完整 URL 输入，校验本次 state；PKCE verifier 仅保留在授权任务内，未公开到看板状态，也未改成官方终端专用网页回调。

原生 Go 传输为 OAuth 建立独立 HTTP/2 连接池，模型 RPC 保留原 HTTP/1.1／TLS 配置；onboard 使用 Content-Length，operation GET 不带 JSON 请求体。六个平台产物已使用官方校验过的 Go 1.27.2 重建。Go 本地 TLS 服务测试验证真实协商 HTTP/2，打包后的 Node→Go 测试验证 OAuth ALPN，原模型 ClientHello 稳定字段回归继续通过。

认证、取消、状态绑定、项目轮询及托管刷新用合成凭据测试；错误 operation 标识不会转成任意带凭据 URL，轮询不会重复提交注册 POST。测试见 [`oauth-flow-profile.test.js`](../tests/oauth-flow-profile.test.js)、[`agy-native-transport.test.js`](../tests/agy-native-transport.test.js) 和 [`native/main_test.go`](../native/main_test.go)。实现与本地验证不能单独证明 Google 接受；真实授权结论以下文隔离看板的独立结果为准。

## 后续真实托管账号刷新验证

2026-11-07 使用 [`verify-managed-oauth-refresh.js`](../scripts/verify-managed-oauth-refresh.js)，只读复制一个启用的现有托管账号至新 `0700` 临时目录，通过真实 `AccountStore` 保存为 `0600` 文件，再将另一个临时副本的到期时间设为过去。未读取官方 agy 自身的登录凭据，未启动看板授权，未请求模型生成。

真实 `ManagedAccountAuthProvider` 经打包的原生 Go 传输只发出一次 `POST https://oauth2.googleapis.com/token`，使用表单字段 `client_id/client_secret/grant_type/refresh_token` 和 `Go-http-client/2.0`，Google 返回 HTTP 200。新访问令牌发生变化且有效期在未来，身份保持不变。`configuredProfile: oauth-http2` 表示使用原生 OAuth HTTP/2 配置；此控制器没有额外记录该 Google 连接的实际协商协议。

正式账号目录的 6 个文件汇总摘要前后均为 `8ba43fd4c5fa142e6694a110561cb5f3912a6d1aa23239f8b85179e4a1601d70`，临时原始副本未改变，全部临时凭据已删除，原生子进程已退出。相关认证源码集合的摘要在本次运行前后保持一致。报告只含字段存在性、状态、固定 endpoint、摘要和布尔结果，没有令牌、邮箱、身份 ID 或项目 ID。证据见 [`managed-oauth-refresh-20261107.json`](../tests/fixtures/managed-oauth-refresh-20261107.json)。

这项结果关闭已有托管账号的真实刷新成功缺口。它没有执行新的 Google 用户授权、授权码交换或看板回调；这些属于下面的另一批验证，不能从已有账号刷新成功推导出来。

## 后续真实看板新增账号验证

2026-11-07，用户通过[隔离看板控制器](dashboard-oauth-validation-controller.md)完成浏览器授权。首次尝试时，用户发现看板授权链接为空；前端仍只接受旧 `/oauth2/v2/auth` 路径，拒绝了当前 OAuthFlow 生成的 `/o/oauth2/auth` URL。该次运行已取消并清理，保留为 [`dashboard-oauth-real-20261107.json`](../tests/fixtures/dashboard-oauth-real-20261107.json)，不能算成功。前端路径校验与脚本内容版本缓存已修复；[3 项 UI 回归](../tests/dashboard-auth-ui.test.js)覆盖真实 OAuthFlow URL 的显示与复制、非法目标拒绝和升级后的缓存版本。

修复后独立运行的 [`dashboard-oauth-real-20261107-v2.json`](../tests/fixtures/dashboard-oauth-real-20261107-v2.json) 在本地时间 02:52:11–02:59:05 完成，`phase=completed`、`passed=true`。源码集合摘要为 `6978dc4c32a2b7baab9ccbc79929d7bd1761ea6359bda5f1204f3cf15da56087`，与首次取消批次的摘要分开保存。

| 检查 | v2 实际结果 |
| --- | --- |
| Google 授权码交换 | `POST oauth2.googleapis.com/token` 实际先返回 401、随后返回 200，最终兑换成功；脱敏记录未保留响应正文，不推测首次 401 的原因 |
| 用户资料与项目发现 | `userinfo`、`loadCodeAssist` 均返回 200；此账号已有项目 |
| 账号保存 | 真实 AccountStore 保存身份、访问令牌、刷新令牌、project 和 OAuth 客户端字段；令牌有效期在未来，账号已启用；报告只记字段存在性 |
| 模型目录 | `/v1/models` 返回 200，共 20 个模型 |
| 额度 | 正常账号保存触发一次 `retrieveUserQuotaSummary`，返回 200；额度快照已保存，2 个 groups、19 个 modelQuota |
| 新账号副本刷新 | 停止临时网关后，只让私有副本过期；一次真实刷新返回 200，访问令牌改变、身份保持、原临时账号不变 |
| 收尾 | `gatewayStopped`、`portClosed`、`sourceUnchanged`、`temporaryCredentialsRemoved` 全为 true；全部临时真实凭据已删除 |

这批结果证明看板既有的本地回调／完整 URL 提交流程可完成真实新授权、兑换、保存及后续目录、额度与刷新；没有把回调改成官方终端的网页回调，也没有请求模型生成。`formalAccountsRead=false`、`automaticAuthorization=false`：正式账号目录不参与，Google 浏览器授权由用户完成。`configuredProfile=oauth-http2` 证明使用原生 Go OAuth 配置，不等于本次另抓了 Google 连接的 ALPN。

`onboardingObserved=false`：已有项目的新授权没有触发 `onboardUser`，真实首次初始化和 operation 接受结果仍未验证。用户已确认目前没有未初始化的 Google 测试账号，因此缺少这项测试前提；现有官方本地实抓与受控回归保留，但不能将它们或本次新增授权成功标成真实首次 onboard 通过。
