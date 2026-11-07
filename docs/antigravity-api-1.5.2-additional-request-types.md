# Google Antigravity API 1.5.2：补充动态请求证据

本次补齐官方 CLI 中此前只静态发现的 `web_search`、`image_gen`（生成和编辑）、`video_summarization`。四个成功场景均由未修改的官方 1.5.2 二进制构造并发出请求，代理在本机直接返回合成响应。没有连接真实 Google，没有读取真实账号，也没有录音。

这证明本机官方代码路径可达、请求格式真实；不证明合成目录中的模型在真实账号可用，也不证明 Google 已接受这些 mock 请求。此前真实媒体验收是另一份证据，不与本次混用。

## 环境与复现

- 官方二进制 SHA-256：`d972bb48e8b98ba99479de8cd66b6f3b4e8184d95789ea8cce39dd18855d5184`，与旧 1.5.2 抓包一致。
- 每场景独立临时 HOME、工作目录、合成 OAuth token、代理 CA 和端口，结束后删除；没有修改全局设置、系统信任、账号池或正式服务。
- 官方进程和代理均受 Seatbelt 限制：网络只允许 loopback；真实用户目录禁止读取，只允许官方 binary；文件写入只允许本次临时目录及 `/dev/null`。
- 代理采用 lazy 连接且对所有请求直接构造响应，不存在转发分支。请求头凭据在归档前脱敏。
- 脚本：[runner](../scripts/probe-official-request-types.py)、[全部响应的 mock](../scripts/official-request-types-mock-proxy.py)。返回的模型文本、签名、图片、搜索来源均为合成测试数据，不是服务端签名或真实网页内容。

```sh
python3 scripts/probe-official-request-types.py --scenario web-search --out /private/tmp/web-search.json
python3 scripts/probe-official-request-types.py --scenario image-tool --out /private/tmp/image-tool.json
python3 scripts/probe-official-request-types.py --scenario image-edit --out /private/tmp/image-edit.json
python3 scripts/probe-official-request-types.py --scenario video-summary --out /private/tmp/video-summary.json
```

输出文件必须不存在，脚本拒绝覆盖旧证据。成功与失败尝试均保留在 [fixture 目录](../tests/fixtures/official-request-types-20261107)。

| 场景 | 成功证据 | 实际官方上游发包 | 官方本地结果 |
|---|---|---|---|
| 搜索 | `web-search-v2.json` | `POST :generateContent` / `web_search` | ACP `search_web` 完成，搜索结果进入后续 `functionResponse`，随后结束本轮 |
| 生图 | `image-tool-v1.json` | `POST :generateContent` / `image_gen` | 官方保存合成 PNG，工具结果附带图片字节，随后结束本轮 |
| 编辑 | `image-edit-v1.json` | 同上，增加参考图 `inlineData` | 官方读取临时合成 PNG 后构造请求，保存返回图片并续聊 |
| 视频摘要 | `video-summary-v7.json` | `POST :streamGenerateContent?alt=sse` / `video_summarization` | Hub StartCascade/SendUserCascadeMessage 均 200，媒体摘要回调发包并返回 |

同步 `generateContent` 的三份官方证据使用 **Content-Length**（搜索 720B、生图 373B、编辑 517B）；流式 `streamGenerateContent` 使用 chunked。mock 连接中的 HTTP/1.1 版本受代理影响，不能用来替代官方真实 HTTP/2/TLS 传输证据。

## web_search：官方工具内部搜索

先观察官方真实工具声明，再返回其已声明的调用：

```json
{"name":"search_web","parameters":{"type":"OBJECT","properties":{"domain":{"type":"STRING"},"query":{"type":"STRING"}},"required":["query"]}}
```

本次调用 `query="synthetic blue circle fixture"`、`domain="example.invalid"`。官方构造：

```json
{
  "project": "synthetic-project",
  "request": {
    "contents": [{"role":"user","parts":[{"text":"synthetic blue circle fixture"}]}],
    "systemInstruction": {"role":"user","parts":[{"text":"You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar."}]},
    "tools": [{"googleSearch":{"enhancedContent":{"imageSearch":{"maxResultCount":5}},"includedDomains":["example.invalid"]}}],
    "generationConfig": {"candidateCount":1}
  },
  "model": "gemini-3.5-flash-lite",
  "userAgent": "antigravity",
  "requestType": "web_search"
}
```

该分支从 `webSearchModelIds` 选搜索模型；旧真实目录与本次合成目录都包含 `gemini-3.5-flash-lite`。这里没有 requestId、labels、thinkingConfig，也没有强制函数 toolConfig。官方将 mock 的 `groundingMetadata.groundingChunks[].web` 转成搜索结果里的 Sources 链接，证明本地解析器的这条行为；链接本身是合成数据。

该 RPC 是官方 `search_web` 执行器内部的辅助模型请求。调查它不等于网关可以代执行客户端本地工具。Anthropic typed server `web_search` 是另一种服务端能力契约，能否在显式 Sonnet 型号上原生支持必须另验；不能据此把 Sonnet 请求悄悄切到搜索 Gemini。

静态字段字典中 `Tool.GoogleSearch` 有 `includedDomains`、`excludeDomains`、时间范围和搜索类型；没有与 Anthropic `max_uses` 等价的同名字段。GroundingMetadata 有查询、来源块和文本区间支持数据；字段存在不证明特定模型返回真实 citations，更不能伪造 Anthropic 加密引用数据。

另一个代理随后执行的[单次真实 Sonnet 能力探测](../tests/fixtures/client-web-tools-20261107/sonnet-native-search-real.json)保持 Sonnet 与固定思考/输出预算，返回 200/STOP 和普通文本，但没有 groundingMetadata、groundingChunks 或 webSearchQueries。它只证明请求被接受，尚不能证明实际搜索、域名约束或来源引用成立，因此不能据此宣称完整兼容 Claude 的 typed WebSearch。

## image_gen：生成与编辑

本次 mock 目录/默认配置分支实际声明 `generate_image`，而此前真实账号探测的默认工具集曾未声明。现在已经证明 CLI 有可执行分支；尚未单独改变每个开关来归因其唯一启用条件，因此不把“给出图片目录”写成已证实的充分条件。

| 官方工具参数 | 真实 Schema / 上游作用 |
|---|---|
| `Prompt` | 必填、非空字符串，成为 user.parts 的首个 text |
| `ImageName` | 必填、非空字符串，只用于官方本地保存名称，不是 image_gen 上游字段 |
| `AspectRatio` | 默认 1:1，枚举 1:1、2:3、3:2、3:4、4:3、9:16、16:9，进入 `generationConfig.imageConfig.aspectRatio` |
| `ImagePaths` | 可选字符串数组、最多 3 项；官方读取这些本地图片后转为后续 `inlineData` |

生成请求只有以下字段；编辑请求在 text 后追加 `inlineData`，没有另一种 requestType：

```json
{
  "project": "synthetic-project",
  "requestId": "image_gen/<毫秒时间>/<所属agent轨迹UUID>/<工具步骤>",
  "request": {
    "contents": [{"role":"user","parts":[{"text":"A synthetic blue circle on white."}]}],
    "generationConfig": {"candidateCount":1,"imageConfig":{"aspectRatio":"1:1"}}
  },
  "model": "gemini-3.1-flash-image",
  "userAgent": "antigravity",
  "requestType": "image_gen"
}
```

本次两份官方 image_gen 均没有 labels、systemInstruction、tools、responseModalities。只凭样本不能断言每个出现字段都是服务器必填；这里的“标准”指官方实际构造形状与条件，不推测服务器容错边界。

轨迹关系已经确认：首个 agent `requestId` 末尾 `/1`，labels.trajectory_id 为同一 UUID；image_gen 使用该 UUID 和 `/2`；后续 agent 为 `/3`。官方保存生成结果后返回：

```json
{
  "functionResponse": {
    "id": "synthetic-image-call",
    "name": "generate_image",
    "response": {"output":"Created At: <时间>\nCompleted At: <时间>\nGenerated image is saved at <实际保存路径>."},
    "parts": [{"inlineData":{"mimeType":"image/png","data":"<合成图片base64>"}}]
  }
}
```

### 与网关构造的核对记录

核对时 `src/direct-provider.js` 的 `generateImage` 在内容、顺序、模型、配置和顶层字段上对应上述请求；编辑也是 text 后跟图片，最多三张，比例枚举一致。

发现并已报告给主实现者的关联缺口：内部生图原先新建 UUID、固定步骤 `/1`，没有继承触发生图的原生轨迹和工具步骤。独立 `/images/generations` 没有父轨迹，独立生成轨迹合理；内部工具必须从真实原生状态接续，不能用客户端 sessionId 冒充。

图片结果没有遗漏：主入口 `media` 经 Direct 转为 `functionResponse.parts[].inlineData`。结果文本此前借用 write_to_file 的 `Created file ...`，这次获得真实 generate_image 文本后应更新该投影，并把网关额外的下载/交付说明明确作为业务补充。

主实现已接入上述修正：Direct 暴露真实 `nativeToolContext`，主入口经账号池传递；同原账号才继承轨迹，图片备用账号采用独立轨迹，独立 images 接口继续从新轨迹第 1 步开始。结果文本已改为官方 `Generated image is saved at ...`。对应回归见 [native-image-trajectory.test.js](../tests/native-image-trajectory.test.js)。同步生成的固定 Content-Length 也已由原生传输实现者修正，流式 chunked 保持原状。

## video_summarization：Hub 媒体摘要回调

普通 ACP inlineMedia 会先检查图片 MIME，已知 ACP 视频 resource 路径也未进入摘要处理。本次从真实本地 Hub 服务触发；不是虚构名为 GenerateMediaSummaries 的公开 RPC。

实际链路：

`LanguageServerService.SendUserCascadeMessage → 保存媒体 → local.Backend 的摘要回调 → Server.GenerateMediaSummaries → GetVideoSummarization → streamGenerateContent`。

隐藏 Hub 参数、请求描述符和固定模型枚举的静态依据见 [独立入口证据](../tests/fixtures/antigravity-1.5.2-video-summary-static-entrypoint.json)。动态复现有三个必要条件：

1. 非 TTY stdin 必须关闭到 EOF，否则 main.readStdinPrompt 会一直等输入。
2. 使用 `--hub --hub-port <临时端口>` 并以 `--print` 保持无终端模式；mock 延迟起始 agent 响应，给本地媒体 RPC 留出窗口。仅 `--hub` 的这条运行分支仍进入终端 UI，不能声称默认就是可独立常驻的服务。
3. StartCascade 必须提供非零 `source`；本次用真实枚举 `CORTEX_TRAJECTORY_SOURCE_CLI`，workspace 为临时目录。空 source 真实返回 400，不能把 proto3 optional 当作业务可省略。

SendUserCascadeMessage 提交合成 MP4 的 `mimeType`、`inlineData`、临时文件 URI。官方处理后发出的请求：

```json
{
  "project": "synthetic-project",
  "requestId": "video_summarization/<UUID>",
  "request": {
    "contents": [{"role":"user","parts":[
      {"inlineData":{"mimeType":"video/mp4","data":"<原始MP4 base64>"}},
      {"text":"Describe this video in A LOT OF detail. This text will be used in place of the video to answer questions about the video."}
    ]}],
    "generationConfig": {"candidateCount":1}
  },
  "model": "synthetic-video-summary",
  "userAgent": "antigravity",
  "requestType": "video_summarization"
}
```

视频为 8999B，SHA-256 `17ce432bfbce3c7ac17881b97156ee227082375d338ad3d57811a1ca06b5bed4`，与合成 MP4 文件完全一致。没有抽帧，没有剥离音轨。

模型选择来自内部固定 enum `MODEL_PLACEHOLDER_M8`（1008），不是用户主模型 M320。本次为该 enum 提供明确支持 video/mp4 的合成目录条目 `synthetic-video-summary`，因此成功发包；旧真实目录没有 M8 条目，真实账号下该辅助路径能否选到支持模型仍欠证。网关已验证的原始视频直传不依赖它，不能用摘要替换用户原视频。

失败尝试均留存：v1 是误加 ACP 专属 flag，v2–v4 卡在 stdin EOF，v5 为终端 UI 退出，v6 为缺少业务 source 的 400；它们是已定位的入口问题，不是“官方摘要功能不可达”。v7 才是成功发包证据。

Hub 还发出了 `writeTrajectoryAcls` 和 `play.googleapis.com/log`；mock 返回 404，前者是对话共享/授权辅助，后者是遥测。没有因此增加网关写远程权限或发送遥测的行为。

## 完整性边界

[静态 RPC 字典](antigravity-api-1.5.2-rpc-field-dictionary.md) 已对上 66 条 HTTP 注解，并列出全部候选的字段和功能分类。动态证据覆盖与静态定义覆盖分别记录：远程设备/命令、企业认证、音频录音 gRPC、首次新账号 onboard 等分支仍不能称已完成实网验收。本文也不把官方工具内部 RPC 变成网关代执行工具的授权。
