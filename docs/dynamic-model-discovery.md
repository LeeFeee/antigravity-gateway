# Pi 与 dsh 动态模型发现

## 行为与安装

本集成随 **2.1.3** 发布，让已有客户端连接自动读取 Gateway `/v1/models`，也不再把每个新增模型写入客户端配置。实连验收时使用 Pi 1.5.2、dsh 0.2.1-rc.2、已部署的 Gateway 2.1.2；服务端已有所需目录接口，不必为了启用扩展而升级服务器。

在项目目录运行：

```sh
node scripts/install-model-discovery.js
```

通过 npm 全局安装 2.1.3 后，也可以在安装了 Pi 和 dsh 的客户端机器上运行（macOS / Linux）：

```sh
node "$(npm root -g)/antigravity-gateway/scripts/install-model-discovery.js"
```

默认接入 Pi 的 `antigravity` provider，以及 dsh `web`、`headless` profile 中的 `antigravity-gateway` provider。自定义名称：

```sh
node scripts/install-model-discovery.js --pi-provider antigravity --dsh-provider antigravity-gateway --dsh-profiles web,headless
```

安装器要求已有可用连接。它不新建密钥、不改地址、不改默认模型、不升级客户端版本。重复执行不会增加重复的插件项。客户端主版本升级后应先核对扩展 API，不能据此宣称兼容所有未来版本。

首次安装后，已打开的 Pi 执行 `/reload`，或重新启动 Pi；dsh 重启一次客户端进程。以后无需额外启动参数。

## 刷新机制

- Pi 在扩展加载时获取目录，并通过原生 `refreshModels` 接口在 `/model` 刷新时更新；会话运行期间每 60 秒刷新一次。
- dsh 保留原生 pi-ai 请求适配器，仅为其提供动态的内存模型目录。启动后立即读取、每 60 秒刷新；目录变化时发布 `llm/adapters-updated`，让已连接的网页菜单更新。
- 以 `data[].id` 为成员清单，与同一响应的 `models[]` 按 ID 合并，读取上下文长度、输出上限、输入类型和固定思考档位。不会把带 `-g` 与不带 `-g` 的模型互相改名或合并。
- 网关未报告输出上限时，保留同 ID 的现有客户端预算，或使用客户端预算默认值。这是客户端预算，不是上游能力认证。
- 刷新请求限时 10 秒、响应大小限制 4 MiB；异常、空目录、重复 ID 不覆盖上次成功结果。网络失败使用已缓存目录并显示/记录提示；首次无缓存时保留原配置中的模型。
- 缓存按地址、认证头隔离，原子写入，仅保存白名单模型元数据。缓存文件不含凭据或用户对话。后台刷新不发起模型推理。

## 文件与配置保留

| 内容 | 默认位置 |
| --- | --- |
| Pi 扩展 | `~/.pi/agent/extensions/antigravity-model-discovery/` |
| Pi 目录缓存 | `~/.pi/agent/cache/antigravity-models/` |
| dsh 插件 | `~/.dsh/integrations/antigravity-model-discovery/` |
| dsh 目录缓存 | `~/.dsh/cache/antigravity-models/` |
| 安装备份 | `~/.dsh/backups/model-discovery-<时间>/` |

Pi 的 `models.json`、`settings.json`、`auth.json` 保持不变。dsh 的 `cordis.patch.yml` 中，原 `llm-pi-ai` 项保留并停用，新增 `antigravity-dynamic-models` 插件项接管原配置；其连接、凭据引用、原始清单逐字段保留，默认模型项和其他配置不变。目录刷新只更新内存和独立缓存，不回写这些清单。原清单仅用作无缓存时的启动回退。

dsh patch 的 `name` 是身份校验字段，不是插件替换字段，因此不能直接改原条目的 `name`。新插件仍委托已安装的官方适配器完成鉴权、请求序列化、工具调用和流式响应，不另写一套推理转换器。

移除时恢复第一次安装的 profile 备份，移除两个集成目录，再重启客户端。缓存可独立删除，下一次联网会重新获取。

## 2026-11-17 本机验收

- 实际服务器 `https://anti.dreambook.chat/v1/models` 返回 24 个模型；Pi CLI 和 dsh 正式网页菜单均自动列出，包括原六项清单没有的 `gemini-4-hydrogen-sonar`、四个 `-g` 模型。
- Pi 原默认 `gemini-3.8-flash-high` 完成 `pwd` 工具往返，两个 assistant 结束原因为 `toolUse`、`stop`，总 token 分别 11613、11765。
- Pi `gemini-4-hydrogen-sonar` 完成真实 `pwd` 工具往返，保留完整四个工具和用户规则，成功取得实际目录及非零用量。
- Pi 真实 RPC 进程持续运行后，在 60 秒时自动再次 GET `/v1/models`，前后均为 24 个模型；随后两次 `/v1/responses` 均为 HTTP 200，完成 Sonar 工具往返。默认配置没有随临时会话选型改变。
- dsh headless 原默认 Flash High 完成真实 `pwd` 工具往返；两步总 token 分别 25908、26074，最终 `turn_end.reason.kind=completed`。
- dsh 冷启动直接为本次运行选择 Sonar，等待首次目录读取后成功完成工具往返，两步总 token 分别 25420、25501；没有依赖网页先加载，也没有把 Sonar 加进原静态清单。此测试仅使用临时命令级 patch 选型，正式默认模型未变。
- dsh 正式网页菜单选中 Sonar，保留 31 个工具，完成 `pwd` 及同会话复测；分别约 10 秒、9 秒。复测两次 HTTP 均为 200，SSE 均以 `response.completed` / `status=completed` 结束，两步总 token 为 30710、30777，无流内错误。
- 核对 Pi 三个配置文件和 dsh 两个凭据文件的 SHA-256 未变；核对 dsh 活跃 provider 配置与原值深相等、默认模型及其他配置深相等。网页新会话仍选择 Flash High。
- 早期安装中遇到的 dsh patch 身份不匹配，以及 headless 没有 credentials 服务的问题已修正，失败样本单独保留，不计为通过。

离线单元检查覆盖目录合并、删除旧成员、固定档位、错误目录拒绝、缓存隔离、网络失败回退及取消。它们不是 Google 实连证据。此次未逐个推理验证目录中的全部 24 个模型，也未在真实服务器新增/删除模型以制造变更场景。

私有请求、响应和客户端会话证据位于仓库外受限的 operations 目录；不提交密钥、SOUL 或完整用户上下文。

## 2.1.3 发布核对

发布前 `npm test` 通过 1198 项测试，`npm run check` 检查 106 个运行及脚本文件，CLI `--version` 返回 `2.1.3`。`npm pack --dry-run` 确认客户端集成、安装脚本和本文包含在安装包内，未包含本机生成的配置或凭据。

发布代码与本机已安装验收的三个集成文件逐字节一致：

| 文件 | SHA-256 |
| --- | --- |
| `catalog.cjs` | `9665ba73e5da91c6621285ef87faa4e4a32f6f5e1296738b1175b3f220747747` |
| `pi.ts` | `d3e8e1199d245c7e4047dee8794cc5b07839fbfa32b12a55391c0ac3a98421d6` |
| `dsh.mjs` | `dc930804bdbf16b463781e93e1b34785d0bce1c6708566ad6f2082080adcfa6a` |
