# 客户端搜索工具的执行边界

本文以用户最新确认的转发边界为准：已有 Google 真实来源链接和上游摘要足够，后续处理交回 agent。下文保留此前客户端抓包、模型能力及缓存失败证据；此前“必须取得网页原文或证明 Sonnet 自身搜索才能交付”的推断已经被这一约定取代，不再构成当前阻碍，也不再继续 Trawler／aicode／网页原文探测。

## 当前产品约定与实现状态

- 仅独立 Messages typed `web_search_20250305`／`name=web_search` 请求进入搜索转发。普通客户端 function／MCP 搜索仍由 agent 自己执行；Responses 不在本次 typed 搜索支持范围内。
- 网关调用真实账号目录 `webSearchModelIds` 中的官方 helper，一次允许执行的逻辑搜索最多一次物理生成，不隐式重试或循环搜索。结果准确显示实际 helper 模型及用量；普通对话命名模型与思考档位不变。
- 来源链接／标题来自真实 Google grounding，摘要直接取上游原输出。网关只转换协议，不抓网页、不解析重定向取页面、不规划、不另调模型总结，也不执行客户端工具。不得伪造网页摘录、`cited_text` 或上游签名；必要的不透明续接数据仅认证真实结果，不冒充原文证据。
- 非空 `allowed_domains`／`blocked_domains` 不能在未解析最终来源域名时忠实执行，因此明确拒绝；`user_location`、混合客户端工具及其他不能忠实转换的执行要求同样在上游前拒绝，不降成软提示。
- `max_uses` 限制对外逻辑搜索调用；不足以允许本次搜索时不发生成。Google 内部 query、来源及支持片段数量不是这个计数。

| 层次 | 已有证据与状态 |
| --- | --- |
| 官方协议 | 未修改 agy 1.5.2 的本地 mock 实抓已有真实 `web_search` 请求格式和目录选择行为 |
| 新 pool／provider | 已真实通过：目录选择 `gemini-3.5-flash-lite`，一次生成 200／STOP，返回真实来源与上游摘要，完整 JSON 已保存 |
| Messages HTTP／SSE 接入 | 8 个完整本地 HTTP 场景通过：流式/非流式搜索、合法历史、篡改、跨作用域、零预算双格式、严格域名拒绝；另有真实 Claude Code 到合成 Google 的完整搜索闭环，辅助生成仅 1 次 |
| 实抓请求重放 → 真实 Google | 已通过完整 HTTP／SSE 单场景：保留原 `max_tokens=32000`，真实目录 helper `gemini-3.5-flash-lite`，1 次目录查询及 1 次生成，200／STOP，链接／原摘要／用量准确；本批未启动 Claude CLI |
| 网页原文与抓取 | 不属于当前产品范围；既有失败材料只供追溯，不作为待补请求或交付阻碍 |

最新本地完整链路证据：[claude-complete-gateway-search-v2.json](../tests/fixtures/client-web-tools-20261107/claude-complete-gateway-search-v2.json)，脚本 [verify-claude-search-gateway.js](../scripts/verify-claude-search-gateway.js)。真实 Claude Code 2.1.318 的 4 个 Messages 请求均 200：加载 WebSearch、外层工具调用、typed 辅助请求、结果回传后完成。辅助物理生成恰好 1 次，响应准确标为 `gemini-3.5-flash-lite`，CLI 把原始 URI 和上游原摘要作为成功工具结果送回主会话；没有 citations，也无需网页原文。上游由 loopback 合成服务提供，不能将该批次写成真实 Google 搜索；临时目录与三个进程均清理。

真实 HTTP 验收另见[请求重放记录](../tests/fixtures/gateway-server-search-20261107/README.md)及[完整脱敏结果](../tests/fixtures/gateway-server-search-20261107/real-result.json)。2026-11-07 04:43（UTC+8），从原 Claude 辅助请求中删除非空严格域名限制，仅替换用户 query，保留 `max_tokens=32000`、流式、system 和其他原始生成参数，经完整临时网关及原生 Go 传输完成一次真实 helper 生成。结果为 200／STOP，实际模型 `gemini-3.5-flash-lite`，输入 112／输出 110 token；5 个来源的 URL／标题和原摘要保持上游原值，SSE、调用结果关联及全部 17 项检查通过。仅有 1 次目录查询和 1 次生成，无网页抓取、OAuth 刷新或生成重试；正式账号／state、57 个运行时文件摘要 `6ff6487b7558aba133f0d8fac0ca50e062b91b0d4f1b357f29b60ae2a20bfc92` 前后不变，native 已停止、临时凭据已清理。此批是 **captured 请求重放，不是真实 CLI 直连 Google**；它与上面的 CLI → 合成 Google v2 互补，不扩大为所有模型、严格域名限制或其他未支持组合的验收。

本网关只接受明确指定 `web_search`／`any` 的独立搜索，或完整匹配已采集 Claude 独立搜索模板的 `auto` 请求。普通 `auto` 允许模型不搜索，不能在没有规划步骤时强行改为搜索，因此明确拒绝；`none` 继续普通对话。生产模块仅保留 metadata-only 结果凭据，不包含引文生成或结果域名筛选执行器。

Claude Code 2.1.318 交互界面的辅助模板单独识别：原始 system 必须恰有三块 text，依次为该版本 `cli` billing 行、官方 CLI 身份句、完整已确认搜索指令。归一化保留块长度和哈希，清理时重核源边界；仅删除前两块并中和第三块中固定的模型品牌词，用户查询及其他规则不改。未知版本、引用、合并或改写模板不清理。此 TUI 模板的 `auto` 放行还要求唯一 user 消息、唯一 text 块、已捕获查询前缀及非空 query；有历史、附加 system 消息或其他形状时不把自动决策强制成搜索。显式 `any`／named 搜索保留原有纯文本历史能力。

这项兼容沿用原有一次官方 helper 转发，不改主对话模型档位或输出预算。新增合成 HTTP／SSE 回归验证 TUI `auto` 成功、未知 TUI 模板及普通 `auto` 在上游前拒绝；当前脚本共 11 个场景。上文 8 场景与真实调用记录仍对应原批次，不据此扩展真实上游验收结论。

下文的“当时”均指对应 fixture 记录的版本与场景。历史探测命令只用于说明证据来源，不表示仍需继续发起真实请求。

## 历史证据：Claude 实际二级 Messages 请求

复现脚本 [`probe-claude-web-search.js`](../scripts/probe-claude-web-search.js) 使用真实已安装的 Claude Code 2.1.318、临时 HOME、假 API key 和只监听 loopback 的合成 Messages 服务。Seatbelt 仅放行该捕获端口，拒绝读取真实 HOME 中的用户配置，工作目录只读；运行结束删除临时目录。只有 `ToolSearch`、`WebSearch` 被允许，服务返回固定查询和域名，不让模型决定执行内容。

```sh
node scripts/probe-claude-web-search.js
```

原始脱敏证据：[`claude-web-search.json`](../tests/fixtures/client-web-tools-20261107/claude-web-search.json)。这次是“真实 CLI → 本地合成 HTTP 服务”，二级请求另送入当时真实 `normalizeAnthropic` 离线检查；没有启动完整网关，也没有将合成 400 包装为真实上游结果。记录保存该次 `protocol.js` SHA-256。

实际顺序如下：

1. Claude 首请求只直接声明 `ToolSearch` 和占位项；合成模型请求 `ToolSearch(query="select:WebSearch", max_results=1)`。
2. Claude 返回真实 `tool_reference: WebSearch`，下一轮展开 `WebSearch` 的完整声明。
3. 合成模型调用 `WebSearch`，参数为固定合成 query 和 `allowed_domains=["example.com"]`。
4. Claude 自己向同一 `ANTHROPIC_BASE_URL` 的 `/v1/messages?beta=true` 发出两次二级请求；两次请求的 beta 头不同，记录未把它们推断成同一种重试机制。
5. 二级请求经过当时归一化器均得到 `400 unsupported_tool_type`。捕获服务返回同样错误，Claude 将其作为原 `WebSearch` 的 `is_error:true` 工具结果回传主会话。
6. CLI 最终正常退出，只证明错误能够回传；搜索没有成功，`realSearchValidated=false`。

二级请求的关键结构为：

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: ANTIGRAVITY_LOCAL_WEBSEARCH_PROBE_20261107"}]}],
  "tools": [{"type":"web_search_20250305","name":"web_search","allowed_domains":["example.com"],"max_uses":8}],
  "tool_choice": {"type":"tool","name":"web_search"},
  "max_tokens": 32000,
  "thinking": {"type":"disabled"},
  "temperature": 1,
  "output_config": {"effort":"high"},
  "stream": true
}
```

请求还带客户端 UA、beta、session／metadata 和三段 system：计费标记、Claude Agent SDK 身份、为另一个 Claude 模型执行一次搜索并总结的专用指令。完整字段以 fixture 为准；转换需要识别这份辅助模板并保留可忠实表达的请求内容，不能据此让网关新增规划或总结步骤。该历史样本含非空 allowed_domains，即使独立搜索接入完成，也仍属于需要明确拒绝的严格域名限制组合。

当时工具矩阵中的 `WebSearch` MCP 支持仅覆盖外层声明、调用参数、调用 ID 和结果往返，搜索未通过。这份失败证据保持不变；最新方案单独识别 typed 搜索并转发官方 helper，不删除 `type` 后假装普通 function，也不将外层 MCP 往返当成搜索成功。

### 客户端结果解析的独立合成验证

随后只改变本地服务的回复，以 `--reply-mode synthetic-search-result` 保存到独立 [`claude-web-search-synthetic-result.json`](../tests/fixtures/client-web-tools-20261107/claude-web-search-synthetic-result.json)，没有覆盖原 400 记录。合成 SSE 顺序为：

1. `server_tool_use`，含独立服务器调用 ID、`name=web_search` 和 query。
2. `web_search_tool_result`，关联该 ID，content 包含 `web_search_result` 的 url、title、合成 encrypted_content 和 page_age。
3. 文本摘要与 `citations_delta`，引用类型为 `web_search_result_location`，含 url、title、cited_text 和合成 encrypted_index。
4. `end_turn`。

真实 Claude 随后产生非错误的外层 `WebSearch` 工具结果：正文包含 query、`Links:[{title,url}]`、摘要和引用提醒；CLI 结构化结果包含 `searchCount:1`。这证明该完整形状可以被当前客户端解析，**不证明每个字段都不可缺少、不证明合成加密字段具备任何真实含义，也不证明 Google 搜索成功**。本次所有页面标题、URL 后缀、摘要与引用均为测试数据，没有获取网页。

### 历史调查：原生搜索转换假设

另一组[官方搜索请求实抓](../tests/fixtures/official-request-types-20261107/web-search-v2.json)显示，agy 的 `search_web` 内部使用 `generateContent`、`requestType=web_search`，并选择目录里的独立搜索模型；本次目录指定 `gemini-3.5-flash-lite`。这是官方工具内部的辅助请求行为，不是“显式 Sonnet 可任意换成搜索模型”的证据。

早期调查曾将“由请求中的主模型直接搜索、域名限制全部等价、提供原文引用”作为同一条兼容路径。后续用户明确区分独立官方 helper 与普通对话模型，并确认只需真实链接及上游摘要。故无需继续证明 Sonnet 自身搜索或补网页原文；严格域名限制保留明确拒绝，逻辑 `max_uses` 由网关在一次转发边界上约束。

旧原生能力探测仍用于说明观察结果，不再作为独立 helper 的启用前提。网关仍不得静默改变普通对话模型、降低明确限制或新增搜索执行器；独立 helper 必须准确展示实际模型，并保持客户端工具执行边界。

### 唯一一次真实 Sonnet 原生搜索能力探测

脚本 [`probe-sonnet-native-search.js`](../scripts/probe-sonnet-native-search.js) 与脱敏结果 [`sonnet-native-search-real.json`](../tests/fixtures/client-web-tools-20261107/sonnet-native-search-real.json) 记录了后续独立探测。正式托管账号和 pool／quota 状态只读复制到 `0700` 临时根，账号文件为 `0600`；真实 `AccountPool`、`QuotaManager` 按原资格、健康、冷却、额度与实时模型目录选择账号。只向实际可用且目录包含 Sonnet 的账号发送一次物理生成，不重试、不切账号、不换模型。

探测保留上述官方同步 `generateContent`／`requestType=web_search` envelope、明确要求搜索的官方 system 和唯一 `googleSearch` 工具，仅将模型设为 `claude-sonnet-4-6`，查询设为 `site:example.com Example Domain`，includedDomains 设为 `example.com`；输出上限 2048，`thinkingConfig={includeThoughts:true,thinkingBudget:1024}`。没有添加未在该官方分支实抓的 `toolConfig.ANY`，也没有声称 system 指令能等价保证客户端 named `tool_choice` 或 `max_uses=8`。

此次在同步生成 Content-Length 修复及六平台原生重建之后执行，实际使用原 Go 传输。manifest 源摘要为 `47e34ff9c729c93109f673028e3e2435e7960b373e60b369dab9fa7e1be5f5dc`；darwin-arm64 实际二进制 SHA-256 为 `b0b55da8685bb1b6389c4524a77812468576e39d18ea9ee51a86753d1f54c9c5`，与 manifest 一致。此次运行没有额外抓 TLS 数据包。

结果：一次模型目录查询 200，一次生成 **200／STOP**，usage 为 107 输入、309 输出、416 总 token。响应仅含普通文本；虽然文本自行写出 “Search Results”，实际候选没有 `groundingMetadata`，完整响应结构也没有 grounding chunks 或 `webSearchQueries`。因此只能确认 Google 接受了该显式模型和配置的请求，**没有获得实际检索、域名过滤、真实来源或引用的证据**。不能从这段正文拼造 `web_search_tool_result` 或引用后宣称兼容通过；也不能据此断言 Google 明确拒绝该组合。

这次没有 ANY／命名函数强制调用，不改变此前 Sonnet“固定思考 + 强制函数调用”真实 400 的结论。原账号 6 个文件的汇总 SHA 前后均为 `d8842152b0ad8abf366d30453f8bae60694ace0b1e5cd2cb919b81176ff00bbb`；正式 pool 与 quota 文件摘要也分别保持不变。运行源码摘要前后相同，`temporaryCredentialsRemoved`、`nativeStopped` 均为 true。这批严格只有一次生成，其记录保持不变；下面另列随后获准的独立追加批次。

### 独立追加批次：相同最新信息查询，两种显式模型

简单的 Example Domain 查询不足以区分模型记忆与检索，因此另设有界批次，最多两个物理生成，每个显式模型仅一次。复现入口为：

```sh
node scripts/probe-sonnet-native-search.js --batch latest-release --run
```

只有显式 `--batch latest-release` 才运行这个固定列表；普通 `--run` 不自动追加模型，已存在的输出文件会拒绝覆盖。脚本在任何观察到的 429 后阻止后续派发并停止批次，不重试、不降档、不改生产模型路由。

两条请求都使用官方 `web_search` envelope，查询同一公开 GitHub 仓库截至测试日期的最新发布版本，`includedDomains=["github.com"]`，输出上限均为 2048，没有 ANY。Sonnet 保留 `thinkingBudget=1024`，Gemini `gemini-3.8-flash-low` 保留 `thinkingLevel=LOW`，都带 `includeThoughts=true`。

| 显式请求模型 | 实际结果 | 可证实范围 |
| --- | --- | --- |
| `claude-sonnet-4-6` | 200／STOP；响应 modelVersion 同名；149 输入、374 输出 token；无 grounding，正文表示不能实时浏览 | 该调用仍未取得原生检索证据；不能将普通文本或模型能力自述作为服务器的明确 capability 错误，也不能据此启用搜索兼容 |
| `gemini-3.8-flash-low` | 200／STOP；响应 modelVersion 为 `gemini-3.8-flash-n`；115 输入、305 输出 token；2 条 webSearchQueries、3 个 groundingChunks、5 个 groundingSupports | 该显式 Gemini Low 请求确实获得上游结构化检索与来源支持信息；这是独立能力探测，不是网关替换了 Sonnet，也不证明其他模型同样可用 |

证据分别是 [`sonnet-latest-release.json`](../tests/fixtures/client-web-tools-20261107/latest-release-batch/sonnet-latest-release.json)、[`gemini-low-latest-release.json`](../tests/fixtures/client-web-tools-20261107/latest-release-batch/gemini-low-latest-release.json) 和[批次汇总](../tests/fixtures/client-web-tools-20261107/latest-release-batch/summary.json)。实际共 2 次生成，无 429；另各进行一次资格检查用的模型目录查询。两条都使用新原生二进制，运行源码集合 SHA 均为 `816eadc36e691bb4aa1936e7a8e78ef7d13a64dd2e522eb7bf2fd7caa2c39146`。每条的正式账号、pool／quota 文件、源码摘要前后不变，临时凭据删除与原生进程停止均通过。

**域名限制仍有明确疑点。** Gemini 请求限定了 github.com，但三个 grounding chunk 的标题分别是 `crystal-method.com`、`note.com`、`note.com`，实际 URI 均为 `vertexaisearch.cloud.google.com/grounding-api-redirect/...`。没有额外访问或展开重定向，不能把这些标题直接当作已核实的目标域名；同样不能因回答正文写出了 GitHub 链接，就声称真实来源都来自 GitHub 或 allowed_domains 已严格生效。grounding 原结构已保留，没有从回答正文虚构来源。

这批当时的结论是 Gemini Low 有原生检索证据、Sonnet 没有；尚不能据此实现完整 typed 契约。该结论不推翻后来明确的独立 helper 转发边界。本批两个生成名额已用完，不继续发散探测。

## Hermes：客户端独立搜索 provider

仅静态读取安装源码，版本为 `0.21.7+11153.g2bd378e`，commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`，没有启动 Hermes 搜索或读取用户配置／密钥。

- `tools/web_tools.py`（`$HOME/.hermes/hermes-agent/tools/web_tools.py:302`） 的 `web_search_tool` 选择搜索 provider；同文件第 350 行开始的 `_memoized_search` 调用 `provider.search(query, limit)`。
- `agent/web_search_provider.py`（`$HOME/.hermes/hermes-agent/agent/web_search_provider.py:1`） 约定由 `web.search_backend`／`web.extract_backend`／`web.backend` 选择独立 provider。
- 例如 `plugins/web/tavily/provider.py`（`$HOME/.hermes/hermes-agent/plugins/web/tavily/provider.py:38`） 使用 `TAVILY_BASE_URL` 或 `https://api.tavily.com` 并自行 HTTP POST；`Brave provider`（`$HOME/.hermes/hermes-agent/plugins/web/brave_free/provider.py:17`） 使用 Brave Search endpoint；Firecrawl 和 Perplexity 还可使用各自服务或 Nous 工具网关。

这些内置后端不因主对话配置为本网关 Responses baseURL 就自动变成本网关的搜索服务。应保留 MCP 外层契约，让 Hermes 依照自己的配置执行并回传结果；本次静态阅读不证明任何真实搜索服务可用，也不涵盖用户安装的任意第三方插件。

## dsh：独立搜索 Messages 或专用 Search API

仅静态读取 dsh `0.2.1-rc.2` 安装包，不读取用户配置／密钥，不执行搜索。

- `dsh-tool-web/lib/index.js`（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js:190`） 将 `web_search(queries)` 分派给 `ctx.web.search`；模型声明层不负责选择供应商或发送网络请求。
- 默认 `dsh-web-search-deepseek/lib/index.js`（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js:16`） 使用独立的 `https://api.deepseek.com/anthropic/v1`，可由 `DEEPSEEK_SEARCH_BASE_URL` 覆盖；其第 107 行开始的 `search()` 同样发送 `web_search_20250305`。源码明确不经过 `ctx.llm`，主对话 baseURL 与这个 endpoint 不联动。
- `dsh-base/cordis.patch.yml`（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:467`） 默认选择 `deepseek-official`，并独立注册搜索 provider；搜索凭据默认来自 `DEEPSEEK_API_KEY`。
- 可选 `dsh-web-deepseek-api/lib/index.js`（`$HOME/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-deepseek-api/lib/index.js:217`） 使用 `https://api.deepseek.com/v1/tools/search`，属于另一独立服务接口。

保留 `web_search` MCP 契约不要求网关代发这些独立服务请求。若另外把 `DEEPSEEK_SEARCH_BASE_URL` 指向本网关，将进入与 Claude 同类的 typed 请求族，并受本文最新独立转发范围及拒绝规则约束；本轮没有做 dsh 搜索完整链路验收，不能据此承诺该独立配置已经可用。

## 既有 grounding 链接的公开来源核验

在上述模型批次结束后，仅对已有 3 个 grounding URI 发起匿名 HEAD 并跟随 HTTPS 重定向，没有新增模型生成、登录、Cookie 或凭据。结果保存在 [`grounding-source-redirects.json`](../tests/fixtures/client-web-tools-20261107/latest-release-batch/grounding-source-redirects.json)，并记录原 Gemini fixture 的 SHA。公开浏览工具无法读取这些重定向 URI，随后使用无配置、无凭据的 curl 核对响应头；没有另行搜索网页。

| grounding chunk | Google 实际 302 Location | 目标响应 |
|---|---|---|
| 0 | `https://crystal-method.com/ja/news/gemini-cli-v0-67-0-sandbox-editor-integration/` | 连接超时；只确认 Google 的 Location，不声称已读取页面或排除后续跳转 |
| 1 | `https://note.com/fair_godwit407/n/nc4fbc66c256f` | HTTP 200 |
| 2 | `https://note.com/kawaidesign/n/n47a03807d37f` | HTTP 200 |

因此，`includedDomains=["github.com"]` 在这次明确的 Gemini Low 请求中**没有形成来源硬限制**，已不只是 chunk 标题引发的疑点。正文里的 GitHub 链接不等于 grounding 的来源；不能把这些正文链接替换成“已验证的搜索来源”，也不能静默丢弃域外引用后声称执行了客户端域名白名单。

对照官方 agy 1.5.2 [搜索请求实抓](../tests/fixtures/official-request-types-20261107/web-search-v2.json)及 [protobuf 字段字典](../tests/fixtures/antigravity-1.5.2-protobuf-rpc-dictionary.json)，转换边界进一步明确如下：

- 官方 `search_web.domain` 的说明是建议优先搜索的域名，实际映射到 `googleSearch.includedDomains`。该官方工具本身的提示语义、上述真实结果，都不足以承诺 Anthropic 硬性 `allowed_domains` 等价。
- `googleSearch.excludeDomains` 存在于编译定义，但本次官方工具没有暴露排除域名参数，也没有捕获或验证排除行为。不能仅因字段名称相似就宣布 `blocked_domains` 可用。
- 官方 `enhancedContent.imageSearch.maxResultCount=5` 是**图片搜索结果数量配置**，不是网页检索次数上限。它不能映射为 `max_uses`。另一方面，`ToolConfig` 确有 `toolTurnLimit` 和 `includeServerSideToolInvocations`；本次均未发送、未验证，不能说“完全没有预算候选字段”，也不能将“工具轮数”未经验证就等同于搜索执行次数。实际返回的 2 个查询、3 个来源和 5 个支持片段也不代表 2/3/5 次服务器工具执行。
- Gemini 的真实 `groundingChunks` 和 `groundingSupports` 提供来源与文本支持关系，可作为将来引用转换的输入；仍须处理 part、区间、Unicode 和多来源关系。它们没有直接提供 Anthropic 的 `encrypted_content` / `encrypted_index`。Claude 当前解析器能消费合成结果，不代表这些伪造值具有完整 API 续接语义；多轮引用不能靠编造上游加密数据完成。

## 客户端选模与响应契约复核

本轮另只读检查了已安装 Claude Code 2.1.318 的 `bin/claude.exe`，SHA-256 为 `677a2ea7bf576cedd20e191d973914ed8a41796f53a63b1923381ddc4d5b5e7d`，没有读取用户配置或密钥。以下定位是该二进制的字节偏移，不是源码行号：

- `276599612` 附近的 WebSearch 选模为内部开关 `tengu_plum_vx3` 决定调用辅助模型函数还是 `mainLoopModel()`；当前默认路径跟随主模型。
- `261329797` 附近辅助函数读取 `ANTHROPIC_SMALL_FAST_MODEL`／`ANTHROPIC_DEFAULT_HAIKU_MODEL`；只有走到该函数才生效。当前发行构建未提供已证实的公开方式打开上述内部开关。官方[模型配置说明](https://code.claude.com/docs/en/model-config)也没有承诺这些变量独立控制 WebSearch，因此不能建议“设置 Haiku 变量即可修好搜索”。
- `276593908` 附近的结果解析提取 `title`、`url` 与文本；此前合成 SSE 被 CLI 接受，只验证这条解析路径，不能代替完整服务器协议。

官方 [Web search 契约](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)要求遵循搜索次数上限、允许／禁止域名、配对的服务器工具调用与结果、错误块及引用结构；[服务器工具约定](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools)还涉及后续轮次的结果续接。Google grounding 可作为转换的真实来源，但不能冒充 Anthropic 返回的原始加密续接数据。

早期复核提出的来源过滤、调用次数和续接约束仍需诚实表达，但不要求将所有 Anthropic 搜索能力一次实现。最新边界对严格域名限制直接拒绝，对可转发的独立请求返回真实链接和上游摘要，并限制一次 helper 调用；不靠事后删来源或改写摘要伪装过滤成功。完整客户端解析及续接状态另行验收。

这些证据不宣称完整 Anthropic typed server search 的所有能力均等价。当前产品只采用本文开头的受限独立转发范围，普通对话模型与思考档位不变，也不增加网关本地搜索执行器；历史来源调查不再追加模型或页面探测。

## 历史证据：网页缓存 metadata 的单次有界验证

后续契约复核区分了两个可由网关实现的约束：`max_uses` 统计对外的逻辑服务器工具调用，不应当直接等同 Google 内部的 query 数量；引用续接的不透明值可以由网关对真实结果自行认证加密并恢复，无需伪装成 Anthropic 签发的数据。因此，这两项不是仅凭上游缺少同名字段就能断言不可解决的障碍。以下原文调查发生在最新范围确定之前；当前只返回真实链接与摘要，不再要求取得来源正文。`groundingSupports.segment.text` 仍只能作为模型回答支持区间，不能伪装成网页原文。

为检查 Google 的既有缓存能否提供正文，本次另获准最多两个只读业务 RPC。独立[探测脚本](../tests/fixtures/official-web-cache-metadata-20261107/probe.cjs)依据官方 1.5.2 的静态 protobuf 和实际 client 调用链构造请求；**这不是未修改官方 CLI 的动态发包证据**。默认工具不暴露旧 `read_url_content`，隔离 mock 尝试显式启用时官方记录该工具已弃用且不生效；该情况不代表缓存 RPC 本身不可达。

固定输入仅为前述 chunk 1 的 Google grounding redirect，目标限于此前已确认的 `https://note.com/fair_godwit407/n/nc4fbc66c256f`。约定先调用 `RewriteUri`，只有它准确返回该目标时，才发送 `FetchFromTrawlerCache {url, liveFetch:false}`；失败、空结果或目标不同即止，不重试、不换 URL、不启用 liveFetch。模型生成、OAuth 刷新、模型目录以及其他业务 RPC 都不在白名单。

2026-11-07 04:01（UTC+8）的[实际记录](../tests/fixtures/official-web-cache-metadata-20261107/real-result.json)显示：仅发送一次 `POST https://daily-cloudcode-pa.googleapis.com/v1internal:rewriteUri`，body 为 `{originalUri:<既有 Google redirect>}`，返回 **HTTP 200、JSON `{}`**，没有 `redirectUri`。脚本按约定立即停止，**没有发送 FetchFromTrawlerCache**，未取得网页缓存或原文。这证明该账号可请求该 endpoint，但不能证明它能解析这类 grounding redirect，也不能据此推断网页缓存为空、拒绝访问或不可用。

执行沿用原 native Go 传输和 CLI 1.5.2 UA。正式账号与完整 pool／quota 状态只读复制到 `0700` 临时根，账号副本 `0600`；保留原 AccountPool 健康、冷却、额度保护和加权选择逻辑，额度管理器只开放读取，未清除保护或刷新状态。1 个账号符合资格且 token 仍有效，5 个因 token 缺失或即将／已经过期被排除。正式账号、pool／quota 文件摘要前后不变，56 个运行时文件的源码集合摘要前后均为 `fa87c5aa21548523287924c9b8886df5df9302dc34de8ed126a88d14f8950b98`；临时凭据已删除，native 进程已停止。

独立[guard 测试](../tests/fixtures/official-web-cache-metadata-20261107/guard.test.cjs)两项通过，覆盖错误顺序、未经确认的目标、其他 URL／主机、附加字段、`liveFetch:true`、模型／OAuth 路径和第三次请求的发送前拒绝。此次业务 RPC 总数 1，模型生成 0，无额外公开页面访问；没有为了补正文证据继续试其他来源。

随后单独授权直接验证**同一个已由匿名 HEAD 核实的目标 URL**，该批次不依赖上述空的 RewriteUri 响应，也不是重试 RewriteUri。独立[cache-only 脚本](../tests/fixtures/official-web-cache-metadata-20261107/cache-only.cjs)和[新结果](../tests/fixtures/official-web-cache-metadata-20261107/cache-only-result.json)保留原批次不变：2026-11-07 04:02（UTC+8）仅发送一次 `POST /v1internal:fetchFromTrawlerCache`，body 为 `{"url":"https://note.com/fair_godwit407/n/nc4fbc66c256f","liveFetch":false}`，Google 返回 **HTTP 404／NOT_FOUND**，message 为 `Requested entity was not found.`。没有正文，立即停止，没有 liveFetch、其他 URL 或重试。

该记录明确关联先前匿名重定向 fixture 及其 SHA，不能将其写成“本次 RewriteUri 已确认”。404 只证明当前账号、端点和该 cache-only URL 组合未取到实体，未细分是缓存未命中还是其他服务条件，不证明全部缓存 RPC 不可用。此批同样保持运行时 SHA `fa87c5aa…8950b98`、正式账号和 pool／quota 文件不变，并完成临时凭据及原生进程清理；模型、OAuth 和目录调用均为零。guard 测试扩为三项并通过，第三项验证这个独立模式只能发送一次，收到 404 也不能再试。两批合计仅 2 个 metadata RPC，仍未取得可用于真实网页摘录的正文。

### 静态补查：网页辅助 RPC 并非固定使用生成请求的主机

随后只读核对同一 SHA 的官方二进制，补充了[端点路由证据](../tests/fixtures/official-web-cache-metadata-20261107/endpoint-routing-static.json)，包括函数范围摘要、字面量偏移和关键调用位置，未发任何新请求。`FetchFromTrawlerCache` 和 `GetWebSearchRedirect` 都调用 `doJetskiRequestAndUnmarshal`，先由 `constructJetskiEndpoint → jetskiServiceEndpointURL` 决定主机；它与普通 `constructCodeAssistEndpoint` 不是无条件相同的路径。

具体为：显式 `JETSKI_SERVICE_ENDPOINT_URL` 优先；没有覆盖时取得原 CCPA 基址。Mendel 开关 `use-aicode-jetski-endpoint` 开启、当前无 AICode scope cooldown，且 `AuthProvider.ResolveAuthMode` 返回 `personal_consumer` 时，官方将 daily／普通 cloudcode 基址映射到 `https://aicode.googleapis.com`，仍按 `/v1internal:<方法>` 构造请求。这里检查的是认证模式，不是账户 tier。对应请求失败后，`shouldFallbackJetskiToCCPA` 还会判断是否允许回到 CCPA，不能把 fallback 分支当成始终采用的首选主机。

该开关由语言服务和 CLI 后端的 Mendel 更新回调设置。当前账号的实际开关值、官方调用这两个 RPC 时实际选择的首个主机均未动态捕获；先前 mock 的 experiments 为空，也不能证明真实账号的值。故本轮的 daily `200 {}`／`404 NOT_FOUND` 仅覆盖**一个静态定义的 CCPA 分支**。404 错误体没有 details／reason，仍无法区分缓存实体缺失、URL 条件或路由条件。没有改用 aicode、其他主机或 liveFetch 散试，也不能据此宣称已否定官方所有缓存路径。

## 目录声明的专用搜索模型：真实 pool／provider 验收

2026-11-07 04:09（UTC+8）另行完成一次有界真实验收，独立[脚本](../tests/fixtures/official-helper-search-20261107/probe.cjs)直接调用新增的 `AccountPool.searchWeb → DirectAntigravityProvider.searchWeb`，并非 HTTP typed server search 全链验收，也不是官方 CLI 动态发包。固定输入为 `query="site:example.com Example Domain"`、`domain="example.com"`、`maxOutputTokens=2048`，没有指定或替换主对话模型。

原账号池正常读取真实模型目录，从所选账号的 `webSearchModelIds=["gemini-3.5-flash-lite"]` 中选择专用 helper，保持账号健康、禁用、冷却、额度保护和加权调度。此次选中账号处于 available、无冷却、未受额度保护；没有更改保护状态。实际仅一次资格目录查询和一次同步 `generateContent`，没有 OAuth 刷新、附加额度查询、生成重试、切账号、第二次 trace 请求或搜索其他 query。

[脱敏完整记录](../tests/fixtures/official-helper-search-20261107/real-result.json)的 `generationResponse.body` 保存 provider 解析前的**完整生成 JSON**，保留真实 thoughtSignature、grounding、searchEntryPoint、traceId、metadata 及未知字段；同时保存原响应字节数和 SHA。结果为 **HTTP 200／STOP**，modelVersion=`gemini-3.5-flash-lite`，输入 71、输出 70、总计 141 token，内部 usage 记录为 1 次成功上游调用。

该 helper 确实返回了结构化搜索结果，但仍未提供真实网页摘录：

- 1 个 `webSearchQueries`，3 个 `groundingChunks.web`；每个 web 对象的全部字段仅为 `uri` 和 `title`，没有 `text`。标题分别为 example.com、quora.com、wikipedia.org，本批没有展开这些新 URI，不能把标题直接当作已核实目标域名。
- 2 个 `groundingSupports`，其中 segment 是模型回答的支持区间；不能将这些 segment 当成网页原文。
- `searchEntryPoint.renderedContent` 含搜索展示用 HTML／CSS；剥离标签和样式后的可见文本只有查询 `site example com Example Domain`，没有网页正文片段。
- 根对象只有 response、traceId 和空 metadata；完整记录中没有遗漏一个未展示的来源正文分支。回答即使与 Example Domain 页面措辞相近，也不能因此声称捕获了原文摘录。

因此，这一批补齐了“真实目录专用 helper 可由新 pool／provider 正常调用”的证据，并提供了当前产品所需的真实链接与上游摘要。没有 `web.text` 不再是功能交付阻碍；网关无需为此抓页面或增加调用。域名参数在本次 envelope 中仍是 Google 的 includedDomains，不能提升成硬过滤，所以带非空严格域名限制的 Messages 请求继续明确拒绝。此项 provider 证据不替代后来分别完成的完整 HTTP 真实请求重放和真实 CLI → 合成 Google 验收；各自范围见本文开头。

正式账号及 pool／quota 文件摘要前后不变；56 个运行时文件摘要前后均为 `2dacba6b6b565bb754eb14278167defedabc02784fa2eafda38a09a61521b8d2`。隔离根目录 `0700`、账号副本 `0600`，使用原 native Go 传输及 CLI 1.5.2 UA；临时凭据已删除、native 已停止。独立[guard 测试](../tests/fixtures/official-helper-search-20261107/guard.test.cjs)三项通过，覆盖完整 JSON 留证、第二次生成拒绝、模型／trace／预算变更拒绝、metadata 429 后停止，以及回答支持区间不冒充来源文本。
