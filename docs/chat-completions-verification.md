# Chat Completions 验收记录

日期：2026-11-17。本文记录 2.2.0 的发布前隔离验收；开发基线为已发布的 `a817bf9`（2.1.3）。

## 安装与测试环境

使用 `npm pack` 产生候选包，再 `npm install --global --prefix <独立目录>` 安装，从安装目录启动网关 HTTP 服务，保持原生 Google TLS 和真实账号请求。没有 mock 上游、合成模型响应或修改原客户端的提示、工具、默认模型、权限规则。测试入口只通过一次性连接参数／独立配置副本指向候选服务；Pi 的 Chat 测试在副本中选择相应传输格式。

本机客户端的正式配置哈希逐一核对保持一致：Claude settings、Hermes config、Pi models/settings、dsh headless/web 配置。在隔离验收阶段，正式本地和服务器服务未参与测试安装替换，端口、密码、密钥和账号池保持原状。服务器不创建原数据备份的部署规则不变。

## 真实验收

| 场景 | 证据与结果 |
| --- | --- |
| Hermes → Chat → Antigravity | 默认 Flash High，完整 19 个工具；实际执行 `pwd`，回传工具结果后获得最终答复；两次 SSE 分别以 `tool_calls`、`stop` 和 `[DONE]` 结束，上游 200，用量有实际值；最终安装包再次完成同一流程 |
| Hermes → Chat → Gemini | Hydrogen `-g`，完整 19 个工具，实际完成同一 `pwd` 流程；Gemini Task 没有可靠用量时明确返回 `usage_known: false`，没有伪造数值 |
| Chat 非流式 | 保留真实 Hermes 的完整历史、19 个工具、客户端身份头和模型，仅改变 stream 参数；返回 `chat.completion`、`stop` 和实际用量 |
| 结构化输出 | 完整真实 Hermes 请求附加 `response_format` 和明确的 `tool_choice: none`，分别验证 JSON Schema 流式结果及 JSON object 非流式结果；本地校验、结束事件和用量通过。JSON object 只要求合法对象，不代表内容一定满足额外业务 Schema |
| 旧式 functions | 将真实 Hermes 的全部函数声明转换为旧式字段，保留完整上下文和模型；Antigravity 与 Gemini 分别验证 `function_call` → 原工具执行结果回传 → `stop`，没有丢失调用 ID |
| Pi → Chat 图片输入 | 默认 Flash High，完整客户端上下文和 4 个工具，正确识别测试图为红色；有实际用量和正常结束 |
| Chat 图片生成 | Hermes 实际请求生成图片；产出 JPEG，文件接口 HTTP 200、284,761 字节；客户端保存文件与网关文件 SHA-256 一致。测试生成的桌面文件移入私有验收目录 |
| Claude Messages 回归 | 完整 12 个工具，实际执行 `pwd`、回传结果、完成答复；没有审批拒绝 |
| Claude Auto 回归 | 真实 Auto 会话在受控目录写文件并回读；捕获 `safeguards`，两次 Google Flash Low 审批请求，返回 `available/not_flagged`；文件实际存在且内容正确，没有修改 Claude Auto 模型配置 |
| Pi Responses 回归 | 默认 Flash High，完整 4 个工具，实际执行 `pwd` 并返回结果；两次 Responses 完整结束，实际用量 12,138 与 12,266 tokens |
| HTTP 边界 | 直接访问安装后的候选入口，缺失鉴权返回 401，空 messages／错误 stream 类型／不支持的 n 返回明确的 400 |

## 失败样本及修复

1. 最初的完整请求复放器遗漏 SDK 身份头，造成与真实客户端不同的缓存身份，Google 拒绝无签名历史工具调用。补齐原始身份头后，同一模型和完整请求通过；早期失败单独保留，未计入成功。
2. 旧式 functions 本身没有客户端调用 ID。首轮通过后，实际回传暴露了该 ID 丢失问题。新增仅保存哈希与已签发 ID 的有限映射，不保存或补写对话，不绑定账号；两类上游均重新验证完整往返。该映射为进程内状态，边界见接入说明。
3. Hermes 当前网关 CLI 明确拒绝 `--image`，没有发出模型请求。此样本未计作图片验收；图片输入由实际支持附件的 Pi 客户端验证。

Google 实际拒绝历史签名的失败样本也验证了 JSON 错误及已开始的 SSE 错误传播：SSE 不伪造成功 finish 或 `[DONE]`。

## 回归范围与边界

- `npm run check`：108 个运行时和脚本文件通过语法检查。
- `npm test`：1,206 项通过，0 失败；包括原有账号路由、额度、媒体、搜索、错误、取消、工具契约、Auto 与动态模型发现用例，以及新 Chat 转换／旧式 ID 隔离用例。这些离线测试不替代上表的真实验收。
- 原有账号池、上游传输、配额、媒体、搜索、Messages／Responses 归一化及动态模型发现模块没有逻辑改动。新增旧式 ID 转换只在 Chat HTTP 入口使用。
- 本次没有新做 Codex、dsh、视频、音频、自定义 grammar 工具、图片编辑的真实外部调用，也没有强行制造 Google 429／OAuth 失效／网络中断；这些不冒充本次实时通过。原有回归覆盖保持通过。
- 不承诺实现 OpenAI 全部托管服务能力；不支持的 Chat 参数明确拒绝，详见 [接入说明](chat-completions.md)。Gemini Task 多模态限制保持原状。

原始完整请求、客户端输出、原生请求记录、失败样本、安装校验和配置哈希均位于仓库外的权限受限验收目录；仓库只保存本脱敏摘要和可复用验证脚本。
