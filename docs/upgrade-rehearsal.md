# npm 原位升级与回退演练

## 最新冻结运行时快照复跑：v8

2026-11-07 **05:14:36—05:14:43（UTC+8）**，代码和打包文档冻结后，完成旧完整安装 → 当前工作快照 → 旧完整安装三次隔离 npm 安装。**33/33 语义检查、3/3 postinstall 实际执行、六平台 native 文件完整性全部通过**。新版对两个退役账号目录的运行期访问为 **0**，正式账号、全局安装及服务未改动，没有发起真实上游请求。

- 脱敏记录：[upgrade-rehearsal-20261107-v8.json](../tests/fixtures/upgrade-rehearsal-20261107-v8.json)。
- 完整证据：`/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/upgrade-rehearsal-v8/`，包含固定新旧 tgz、三阶段日志、前后来源清单、旧目录访问审计、归档清单及 `runtime-package-audit.json`。
- 控制器为备份根目录的 `audit-upgrade-runtime-v8.cjs`，复用 [verify-upgrade.js](../scripts/verify-upgrade.js)。v7 与更早固定包、证据均保留。

| v8 固定包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 真实旧完整安装，1.7.5 | 18,856,955 | `aca8eddd74b05980cc127a00c1472c951a49bfd762a1d8bf6e7ec8bd98d3f526` |
| 最终冻结工作快照，1.7.5 | 19,049,544 | `026f725c820a59516b4433f319a82269e5be5382f738dce9e49ef0641a95a486` |

**122 项归档文件**全部与打包前来源逐一一致。**90 个打包运行时文件**在演练前、演练后及 tgz 解包目录中完全相同，摘要为 `1be5fb552b4c42a83791eb10d864d99ca0b3c80389f6f3283eff5aaf5e6cded9`。相对 v7 仅两份验收脚本变化：`verify-gateway-media.js` 增加独立图片测试提示及对象语义比较；`verify-real-client-gateway.js` 增加匿名持久健康、额度和来源快照。没有新增运行时文件，也没有变更核心模型转发代码。

核心 **57 文件**摘要仍是 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`。核心摘要与包含 scripts/skills 的 90 文件运行时摘要范围不同。控制器同时确认 package-lock 和包含文档的打包来源在演练期间不变，归档没有 Python 缓存。

六个平台原生 gzip 的压缩 SHA、解压 SHA、字节数及 manifest 均匹配；包内 `go.mod + main.go` 摘要仍为 `47e34ff9c729c93109f673028e3e2435e7960b373e60b369dab9fa7e1be5f5dc`。本机三次 postinstall 实际执行 darwin-arm64 组件，其余五个平台仅完成完整性验证。

正式安装含依赖的 **566 个文件**、文件和目录权限、符号链接目标及全局命令链接全不变，内容摘要为 `a99e6d8e5963d01f7c5ab466d264d3bb1d868873e241ee1b947d2b6dd5036a59`。三阶段各 11 项检查继续覆盖原账号 ID/启停/删除、权重、固定粘性、健康隔离、两窗额度保护、统计、媒体、签名会话、命令和配置路径。使用隔离合成数据，不读取正式账号；本轮服务只核对配置契约，实际 macOS 生命周期仍见[独立服务验收](service-lifecycle-validation.md)。

**本节及 v8 fixture 在打包审计完成后写入**。固定包对应打包前完整来源，后续报告文字不声称与 tgz 逐字节相同。版本仍为 1.7.5 工作快照，未发布或替换正式安装；本演练不增加模型请求，也不改变其他独立验收的实测范围。

## 历史运行时快照复跑：v7

2026-11-07 **04:59:01—04:59:09（UTC+8）**，最终核心与打包文档冻结后，执行真实旧安装 → 当前工作快照 → 真实旧安装的三次隔离 npm 安装。**33/33 语义检查通过，3/3 postinstall 实际执行成功**。新版 `--version` 和模块探针对 Robin／Windows Gemini 旧账号目录的访问均为 **0**。正式账号、全局安装和服务未修改，没有真实上游模型请求。

- 脱敏结果：[upgrade-rehearsal-20261107-v7.json](../tests/fixtures/upgrade-rehearsal-20261107-v7.json)。
- 完整证据：`/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/upgrade-rehearsal-v7/`，包含固定新旧 tgz、三阶段安装日志、33 项检查、旧目录访问审计、前后完整清单、归档清单、解包目录及 `runtime-package-audit.json`。
- 复用 [verify-upgrade.js](../scripts/verify-upgrade.js)；外部控制器为备份根目录的 `audit-upgrade-runtime-v7.cjs`。v7 新增打包来源（含文档）及核心/package-lock 前后不变检查，v6 及更早包、证据均保留。

| v7 固定包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 真实旧完整安装，1.7.5 | 18,856,955 | `aca8eddd74b05980cc127a00c1472c951a49bfd762a1d8bf6e7ec8bd98d3f526` |
| 最终冻结工作快照，1.7.5 | 19,045,962 | `04e583cfdb1761135fa871a7f49beaa25ff2b74cf872598bb020939b4caae6b9` |

新包 **122 项归档文件**逐一与打包前来源一致。主入口、package.json、src、native、scripts、skills 的 **90 个打包运行时文件**在演练前、演练后和解包目录中完全相同，汇总 SHA-256 为 `38d22fbb3d0020cabdb47cb4578a518475bdc16aacb30a9b8cbd84437383e234`。相对 v6，运行时变更为 `src/direct-provider.js` 的明确额度耗尽重试修复，以及新增 `scripts/probe-opus-forced-tool.js`。两次打包来源均未变化，归档不包含 Python 缓存。

核心 **57 文件**摘要为 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`，与冻结时记录一致；范围是主入口、package.json、package-lock.json、src JavaScript 和 native/bin。它与上述 90 文件打包运行时摘要采用不同范围，不能混用。

六个平台原生 gzip 均逐个验证压缩 SHA、解压 SHA、解压字节数及 manifest。包内 `go.mod + main.go` 与 manifest 的 `sourceSha256=47e34ff9c729c93109f673028e3e2435e7960b373e60b369dab9fa7e1be5f5dc` 一致，工具链为 Go 1.27.2。本机三次 postinstall 实际执行 darwin-arm64 组件，其余五平台只证明打包完整性，没有声称实际运行。

正式安装含依赖的 **566 个文件**、文件/目录权限、符号链接目标及全局命令链接均保持不变；内容摘要仍为 `a99e6d8e5963d01f7c5ab466d264d3bb1d868873e241ee1b947d2b6dd5036a59`。旧、升级、回退三阶段各通过 11 项契约，覆盖账号 ID、禁用/删除、权重、固定粘性、健康隔离、两窗额度保护、累计用量、媒体及签名会话。数据为隔离合成快照，不读取正式账号数据。服务仅检查配置契约；真实 macOS 生命周期证据见[独立服务验收](service-lifecycle-validation.md)。

**本节与 v7 fixture 在打包审计完成后更新**，因此固定包对应打包前的完整来源；后续报告文字不声称与 tgz 逐字节相同。版本仍为 1.7.5 工作快照，没有发布或替换正式安装。此升级演练不改变其他验收的边界，也不将受额度阻碍的内部生图链路标记为真实成功。

## 历史运行时快照复跑：v6

2026-11-07 **04:43:41—04:43:51（UTC+8）**，在单次服务器搜索转发及内部图片工具声明修正完成、运行源码与打包文档冻结后，再次执行真实旧安装 → 当前工作快照 → 真实旧安装的三次隔离 npm 安装。**33/33 语义检查通过，3/3 postinstall 实际执行成功**。新版 `--version` 和模块探针对两个退役账号目录的访问次数均为 **0**；没有安装到正式 prefix、读写正式账号数据、启停正式服务或发起真实上游请求。

- v6 脱敏记录：[upgrade-rehearsal-20261107-v6.json](../tests/fixtures/upgrade-rehearsal-20261107-v6.json)。
- 完整证据：`/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/upgrade-rehearsal-v6/`，包含固定新旧 tgz、三阶段安装和验证日志、运行时旧目录访问审计、前后完整清单、归档逐文件清单、解包目录及 `runtime-package-audit.json`。
- 使用原 [verify-upgrade.js](../scripts/verify-upgrade.js) 执行安装；外部审计控制器位于上述备份根目录的 `audit-upgrade-runtime-v6.cjs`，没有改写运行源码。v5/v4/v3 的证据和固定包均保留。

| v6 固定包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 真实旧完整安装，1.7.5 | 18,856,955 | `aca8eddd74b05980cc127a00c1472c951a49bfd762a1d8bf6e7ec8bd98d3f526` |
| 本轮冻结运行时工作快照，1.7.5 | 19,035,401 | `054346980209f3ff48a146b6b0dd67c909b411338c3c8ab60d730525b8ccfd03` |

新包 **121 项归档文件**全部与打包前捕获的源码快照逐文件一致。主入口、package.json、src、native、scripts、skills 中 **89 个打包运行时文件**还分别核对了演练前、演练后及 tgz 解包内容，汇总 SHA-256 为 `12f738ac59f41fada0e07653cddc8a24e51e42e459277a0cef0e3934c7c3c137`。其中包含新增服务器搜索协议、来源凭据、Google 搜索转发、内部模型工具声明及两个搜索验收脚本。新旧源目录各自在打包期间没有变化；`.npmignore` 摘要单独记录，整个归档没有 `__pycache__` 或 `.pyc`。

本轮核心 `sourceSnapshot` 为 `6ff6487b7558aba133f0d8fac0ca50e062b91b0d4f1b357f29b60ae2a20bfc92`。它使用真实客户端验收脚本的算法，包含 package-lock.json、主入口、src JavaScript 和 native/bin；与上述 89 文件打包运行时摘要的范围不同，不能混用两个摘要。

六个平台的原生 gzip 均已逐个核对压缩 SHA、解压 SHA、解压字节数和 manifest；包内 `go.mod + main.go` 摘要与 manifest 的 `sourceSha256=47e34ff9c729c93109f673028e3e2435e7960b373e60b369dab9fa7e1be5f5dc` 一致，工具链标记为 Go 1.27.2。三次 postinstall 在本机实际执行 darwin-arm64 组件；其余五个平台只完成完整性校验，未声称实际运行。

正式安装全树**包含 node_modules 的 566 个文件**，内容、文件和目录权限、符号链接目标，以及全局 `antigravity-gateway` 命令链接在演练前后均不变；内容汇总 SHA-256 为 `a99e6d8e5963d01f7c5ab466d264d3bb1d868873e241ee1b947d2b6dd5036a59`。原脚本的 11 项阶段契约在旧版、升级、回退三个阶段各通过一次，继续覆盖账号身份/权重/禁用、固定五小时粘性、额度保护、健康隔离、统计、媒体、签名会话及安装路径。服务在本轮仍只验证配置生成，没有对正式服务执行操作。

本节与 v6 fixture 均在归档审计完成后写入，后续交付文档也可能继续更新。因此本次证明的是**固定包的全部文件对应打包前快照，89 个运行时文件与演练前后源码一致**，不声称收尾后的全部工作区文档与该 tgz 逐字节相同。版本仍为 1.7.5 工作快照，以固定包 SHA 区分新旧实现。

## 历史运行时快照复跑：v5

2026-11-07 **03:38:41—03:38:49（UTC+8）**，在本轮核心与原生组件冻结后，再次从真实旧安装和当前源码分别打包，执行旧版 → 新版 → 旧版三次隔离 npm 安装。**33/33 检查通过，3/3 postinstall 实际执行成功**；新版 `--version` 和模块探针对 Robin／Windows Gemini 两个旧账号目录的访问次数均为 **0**。没有发布、安装到正式 prefix、读写正式账号数据或启停正式服务。

- v5 脱敏记录：[upgrade-rehearsal-20261107-v5.json](../tests/fixtures/upgrade-rehearsal-20261107-v5.json)。
- 完整证据：`/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/upgrade-rehearsal-v5/`，包含两包、三阶段日志、合成持久化数据、前后完整目录摘要、解包目录和 `runtime-package-audit.json`。
- v4、v3 证据与固定包均保留，下方仍是各自当时的历史记录。

| v5 固定包 | 字节数 | SHA-256 |
|---|---:|---|
| 真实旧完整安装，1.7.5 | 18,856,955 | `aca8eddd74b05980cc127a00c1472c951a49bfd762a1d8bf6e7ec8bd98d3f526` |
| 最新冻结运行时工作快照，1.7.5 | 18,993,515 | `5b4bd6bd50b980ce98061afa3fb598fc3f5e322492d014b7ebdccb237150770b` |

新包共 **115 项文件**。对主入口、package.json、src、native、scripts、skills 共 **83 个实际打包运行时文件**逐文件核验，打包前、演练后及 tgz 解包内容一致；汇总 SHA-256 为 `f83136e784f9a51c1f0a66b71e1f642a4f9ca7ca4522c64bf15d1ea369fc291d`。新旧源目录在各自打包期间没有变化。`.npmignore` 属打包规则单独记录摘要；Python 缓存不属于该运行时集合，且已直接检查整个新 tgz，**没有 `__pycache__` 或 `.pyc`**。

六个平台的 gzip 文件都与工作区相同；逐个验证压缩 SHA、解压后 SHA、解压字节数及 manifest。还将包内 `go.mod + main.go` 重新计算摘要，与 manifest 的 `sourceSha256=47e34ff9c729c93109f673028e3e2435e7960b373e60b369dab9fa7e1be5f5dc` 对齐。本机 postinstall 实际运行 darwin-arm64，原始二进制 SHA 为 `b0b55da8685bb1b6389c4524a77812468576e39d18ea9ee51a86753d1f54c9c5`；其余五平台只验证文件完整性，没有声称跨平台执行。

正式旧安装全树**包含 node_modules 的 566 个文件**，文件内容、权限及符号链接目标在演练前后均相同；本次摘要为 `a99e6d8e5963d01f7c5ab466d264d3bb1d868873e241ee1b947d2b6dd5036a59`。摘要算法和逐文件清单均保留在 audit 与 before/after snapshot；不把读取引起的 atime 变化算作内容修改。

版本号仍是 1.7.5 工作快照，以包 SHA 区分新旧实现。本节和随后更新的交付文字发生在固定 tgz 生成之后，不能据此声称最终工作区全部文档与该 tgz 逐字节相同；已核验冻结的是上述 83 文件运行时集合。账号粘性、额度保护、媒体、会话签名恢复、退役文件清理等具体检查复用下方 11 项阶段契约。服务仍只检查配置生成，**v5 不能代替正式服务启停或完整 A30 服务验收**。

## 历史运行时快照复跑：v4

2026-11-07 **02:40:32—02:40:39（UTC+8）**，核心冻结后重新打包并实际执行旧版 → 新版 → 旧版三次隔离 npm 安装。**33/33 检查通过，3/3 postinstall 实际执行成功**；新版 `--version` 初始化及模块探针对两个旧账号目录的访问均为 **0**。版本仍为 `1.7.5` 工作快照，没有发布或改动正式安装、服务、账号。

- v4 脱敏证据：[upgrade-rehearsal-20261107-v4.json](../tests/fixtures/upgrade-rehearsal-20261107-v4.json)。
- 完整证据目录：`/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/upgrade-rehearsal-v4/`。包含两包、三次安装及运行日志、作用域审计、`summary.json`、`runtime-package-audit.json` 和解包核验目录。
- v3 目录与原脱敏 fixture 均保留不变；下方 v3 记录是历史快照，不覆盖成 v4 结果。

| v4 固定包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 旧完整安装包，1.7.5 | 18,856,955 | `aca8eddd74b05980cc127a00c1472c951a49bfd762a1d8bf6e7ec8bd98d3f526` |
| 最终运行时工作快照，1.7.5 | 18,937,482 | `6e192b7ebd8359da2cbe393126a2711b5c417781c747b53dc82b29ec2394bdfc` |

新包包含 104 项文件。对 `antigravity-gateway.js`、`package.json`、`src/`、`native/`、`scripts/`、`skills/` 共 **78 个运行时文件**逐文件 SHA 校验，打包前后源码与实际解包内容完全一致，汇总 SHA-256 为 `5a50cbde3b6d6777e043f719b009cd1073d90559a081442f4eb6452befc759ad`。新旧两个源目录在各自打包期间都没有变化。本报告此后补入的验收文字不属于已经固定的 tgz 快照；运行时一致性以该 78 文件摘要和包 SHA 为准。

darwin / linux / win32 的 arm64、x64 六个平台原生组件均实际装入 tgz，并逐个验证压缩 SHA、解压 SHA、解压字节数与 manifest 一致。manifest 的原生源码摘要是 `e36320ceb167d75dffc24e746d42b173d78dccd3b66d9a1c41680c550e7c05e7`，各平台摘要见 v4 fixture。postinstall 在本机实际执行的是 darwin-arm64 原生组件，不将六平台静态完整性校验写成六平台运行验收。

正式旧安装全树**包含 `node_modules` 的 566 个文件**在演练前后保持一致，汇总 SHA-256 为 `7dbda345dee1a887cc1d0bd1013067151c9d20848aaf481f638fba83dd138926`。这项检查补充了原脚本排除 `node_modules` 的目录清单校验。安装 prefix、配置、npm cache、日志和临时目录均位于 v4 证据目录，正式服务没有启动、停止或重启。

v4 复用下面相同的 11 项阶段检查及逐文件持久化校验。服务仍仅验证配置生成和路径契约，因此不将 v4 扩大解释为正式服务启停验收。

## v3 原始演练记录

2026-11-07 01:58:43—01:58:50（UTC+8）完成一次真实 npm 安装演练：旧版安装 → 新版原位覆盖 → 旧版原位回退。三个阶段的 postinstall 均实际执行成功；每阶段 11 项语义检查通过，另做持久化文件逐字节校验。没有发现本轮覆盖范围内的数据兼容问题。

本报告对应[产品规格第 13 节、A30/A31](antigravity-gateway-refactor-spec.md)。A30 中的安装、命令、路径与服务配置契约已检查，**正式后台服务的启动、重启和停机未执行**，因此本报告不宣称完成 A30 的全部服务验收。

## 证据与版本

- 可复跑脚本：[scripts/verify-upgrade.js](../scripts/verify-upgrade.js)。
- 脱敏摘要：[upgrade-rehearsal-20261107.json](../tests/fixtures/upgrade-rehearsal-20261107.json)。
- 完整本机证据：`/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/upgrade-rehearsal-v3/`，包含两个 tgz、完整打包清单、三次安装日志、运行期文件访问审计、合成数据及 `summary.json`。
- 环境：macOS arm64，Node.js `v22.23.4`，npm `10.9.9`。

| 项目 | 旧包 | 新包 |
| --- | --- | --- |
| 来源 | 本机已安装的完整 npm 包，只读打包 | 本轮重构工作区的打包快照 |
| 包名 | `antigravity-gateway` | `antigravity-gateway` |
| package.json 版本 | `1.7.5` | `1.7.5` |
| tgz 字节数 | 18,856,955 | 18,867,241 |
| SHA-256 | `aca8eddd74b05980cc127a00c1472c951a49bfd762a1d8bf6e7ec8bd98d3f526` | `ce16e1c7a4d6046ba91ccb49d9c2a17804973d4b5e922db8049a528220815380` |
| 打包时间 UTC | `2026-11-06T17:58:44.207Z` | `2026-11-06T17:58:44.877Z` |

两包当时都尚未更改版本号，故以 tgz 哈希辨别实现。旧包来自 `/Users/leefee/.nvm/versions/node/v22.23.4/lib/node_modules/antigravity-gateway`，保留其完整原生组件；未用缺少 native 的源码备份替代旧安装。两次打包前后的源目录清单哈希均未发生变化。其后工作区仍在修改，本报告仅证明上述固定包快照，最终发布包应再执行本脚本。

## 实际执行过程

分别在旧安装目录、新源码目录执行：

```bash
npm pack --ignore-scripts --json --pack-destination <独立证据目录>
```

然后对同一个临时 npm prefix，依次安装旧、新、旧 tgz：

```bash
npm install --global --foreground-scripts --allow-scripts=antigravity-gateway \
  --prefix <证据目录>/npm-prefix <旧包或新包.tgz>
```

保留原安装命令的三个标志，仅将包来源固定为可计算哈希的本地 tgz，并将 prefix 指向一次性目录。没有使用 `--ignore-scripts` 安装，也没有使用 `--force` 或手工删除旧安装。三次日志均出现 `postinstall → node scripts/check-environment.js → Environment ready`；环境检查实际解压并执行随包原生组件的 `--version`。

`ANTIGRAVITY_GATEWAY_CONFIG_DIR`、npm cache、npm 用户及全局配置文件、临时文件目录均指向演练目录。`HOME` 未改写。旧/新版运行探针显式禁用网络、监听与子进程，拒绝访问正式账号数据和钥匙串；npm 本身仍可下载所需依赖。

## 对比结果

| 验证项 | 新版原位升级 | 回退旧包 |
| --- | --- | --- |
| 包名、`bin/antigravity-gateway` 链接及 `lib/node_modules/antigravity-gateway` 位置规则 | 保持 | 保持 |
| 实际执行已安装的 `antigravity-gateway --version` | 成功 | 成功 |
| 默认 `9897`、`~/.antigravity-gateway`、配置目录环境变量规则 | 保持 | 保持 |
| 6 个假 agy 账号的 ID、主体、禁用状态和权重 | 保持 | 保持 |
| 已删除的第 7 个假账号及删除身份标记 | 未恢复账号，标记保留 | 相同 |
| 固定 5 小时粘性 | 同账号再次绑定不延长；原截止时刻有效，下一毫秒失效 | 相同 |
| 401 健康隔离及凭据指纹关联 | 保持 `authentication_error`，不进入候选 | 相同 |
| Gemini 5 小时低于 10%、周低于 5% 的保护 | 两个窗口均保持；旧快照和已过 resetTime 不擅自解除 | 相同 |
| 最终可路由账号集合 | 仅两个健康、启用且未受保护账号 | 相同 |
| 累计、按账号、按模型统计 | 保持 | 保持 |
| 上传和生成媒体 | 字节、ID 和访问 scope 保持 | 相同 |
| 会话 cascade/trajectory、requestIndex、已记录签名响应 | 原数据可恢复；新版重新 checkpoint 后仍可读 | 旧包恢复同一会话及响应 |
| 服务配置、客户端模型文件、历史日志 | 文件字节不变 | 文件字节不变 |

账号、账号池、额度、统计、媒体、两个旧账号目录、服务配置、客户端模型文件和日志，均按旧模块生成后的 SHA-256 逐文件比较。会话状态特意由新版写回一次，因此按会话 ID、索引和原始已记录响应做语义验证，不声称会话 JSON 字节完全不变。额度测试使用已经过期的快照和已经过去的 resetTime，确认保护不会仅因时间推移或重新加载而消失。

所有账号、token、项目、媒体字节、签名、API key 均为测试合成数据。本轮验证的是存储、恢复和路由过滤契约，不验证假签名能被真实上游接受，也不发起模型推理、刷新凭据或额度查询。

## 旧目录与旧代码退出运行

在 `robin-accounts/`、`gemini-win-accounts/` 各放一个损坏 JSON 和一个可解析的假凭据。新版实际 `--version` 初始化过程以及账号/额度/会话模块探针，对这两个目录的文件系统访问次数均为 **0**，没有扫描、解析、改写或加入候选。

新版包以及原位覆盖后的安装目录，都不再存在旧包中的 20 个已移除运行时文件，覆盖 Robin、Windows Gemini、组合路由、本机登录态导入、agy 子进程兜底和旧工具适配器。完整列表见脱敏摘要。回退安装旧 tgz 后，这些旧包文件按预期重新出现；旧目录内的合成数据始终未被修改。旧版初始化仍会扫描旧目录，这是回退到旧行为的结果，不能误写为新版回归。

## 服务与发布边界

通过新旧安装包的真实 `service-manager` 纯函数，生成并逐字比较 macOS 服务配置，验证标签 `io.github.leefeee.antigravity-gateway`、Node/runner/gateway 路径、配置文件及日志位置不变。没有调用 `launchctl`，也没有启动临时或正式后台服务。

因此，发布前还需针对最终包执行隔离服务启停/重启验收，或在用户授权的发布操作中验证正式服务；不得仅凭本报告将完整 A30 标记为通过。A31 的所列合成旧数据原位升级与回退已实际通过。滚动权重累计值、短暂冷却等原有内存状态没有被伪造为可持久恢复。

## 复跑

```bash
node scripts/verify-upgrade.js \
  --old-install /完整旧版安装路径 \
  --worktree /新版本源码路径 \
  --output /全新空证据目录
```

省略 `--output` 时自动创建临时目录。脚本拒绝复用非空输出目录，保留 tgz、日志和合成数据供检查，不自动删除证据。正常完成输出 `Passed. Evidence: .../summary.json`；失败会写入失败阶段和日志位置。演练不替代正式数据备份，也不修改真实安装。
