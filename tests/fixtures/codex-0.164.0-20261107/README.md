# Codex 0.164.0 原始客户端请求采样

脚本：`scripts/probe-codex-requests.js`。原签名实际 CLI 连接唯一 loopback 捕获端点，端点合成 Responses 回复，不请求真实供应商。当前完整网关的最终验收见 [后续 9 场景目录](../codex-gateway-0.164.0-20261107/README.md)，本目录不代表最终产品能力上限。

成功采样：

- `text-installation-metadata.json`：无远程 catalog 的未知模型 fallback 模板；首次真实请求成功。该旧文件的 `installationIdContentUnchanged` 被过宽脱敏误写为字符串，前后 SHA 可独立核验相等；后续脚本已修复并有反例测试，原档不覆盖。
- `text-gateway-catalog.json`：明确设置 model_catalog_url；两次 GET models 后 POST Responses，实际 developer 文本等于网关中性 base_instructions，新增真实 custom apply_patch 语法，证明目录被采用。
- `read-external-sandbox.json`、`patch-external-sandbox.json`、`error-external-sandbox.json`：真实固定命令读取、补丁落盘、错误结果回传。
- `compact-external-sandbox.json`：实际自动压缩，第二请求 tools=[] 且仍带旧结构化调用/结果；第三请求替换为摘要历史，继续完成。

实际请求包含 `originator: codex_exec`、版本 UA、`session-id`、`x-codex-turn-metadata`、`prompt_cache_key`；本配置为 HTTP Responses SSE，没有 websocket upgrade。模型提示在 input developer 消息中，没有顶层 instructions。工具包含 function、custom apply_patch 以及 multi_agent_v1 namespace。临时 AGENTS 规则是独立 user 内容，不属于待删除框架身份。

失败尝试保留如下，不声称发过请求或执行成功：

- `text-initial.json`：Seatbelt localhost 表达式错误，0 请求。
- `text-second.json`、`text-ephemeral-auth.json`、`text-directory-read.json`、`text-canonical-temp.json`、`text-io-diagnostic.json`、`text-io-diagnostic-injected.json`：隔离初始化失败，0 请求；不存在成功的替代或重签二进制，后续使用原二进制。
- `read.json`：移除 --ignore-rules 后正式 rules 目录拒读，0 请求。该开关并不隐藏 AGENTS；后续成功请求已经真实包含临时 AGENTS。
- `patch.json`、`read-isolated-rules.json`：CLI 收到工具调用，但嵌套 Seatbelt 执行失败；后续统一由外层限制实际权限。
- `image-external-sandbox.json`：独立空池 catalog 只声明 text，CLI 因此拒绝 view_image。完整网关发现合成支持图片的模型后已成功，非生产图片缺陷。
- `image-input-external-sandbox.json`：多值 --image 选项吞掉位置 prompt，0 请求；后续完整验收添加 -- 分隔并成功。

脚本不重设 HOME/CODEX_HOME，不读取正式 auth/config 或会话。仅既有非凭据 installation_id 允许正常 RW 打开并记录前后 SHA/mtime；原值在所有字符串中脱敏。若其内容变化会判失败，不自动回写。工具文件、日志和 SQLite 状态均在临时目录。
