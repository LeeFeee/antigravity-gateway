# Google Antigravity API 1.5.2：官方 MCP 请求取证

日期：2026-11-07，Asia/Kuala_Lumpur。平台：macOS arm64。官方程序：本机未修改的 `agy 1.5.2`。实际生成模型：`gemini-3.8-flash-low`。

这份记录说明已观察到的协议行为和兼容边界，不表示所有 MCP 服务、模型、媒体或 Schema 已通过验证。

## 取证入口与隔离

`agy --settings '{"mcpServers":{}}'` 在本地解析阶段返回 `unknown setting "mcpServers"`，因此没有采用该设置增加 MCP。

实际采用官方 `agy acp`，通过 JSON-RPC `session/new` 请求中的 `mcpServers` 配置当前会话的本地 stdio 测试服务。官方文档确认 ACP 复用 CLI 的登录与设置；此处使用已有官方登录态，没有向 Gateway 导入凭据。[官方 ACP 文档](https://antigravity.google/docs/cli/acp/)

测试服务只有回显与受控错误，不读取文件、不执行命令、不访问网络。测试会话的工具权限请求只允许这些测试工具，其他请求拒绝。代理证书通过该进程的 `SSL_CERT_FILE` 使用，未修改系统信任。抓包器在写文件前移除认证头及凭据字段，并替换签名；不保存 TLS 明文凭据。

每次探测结束均比较以下文件的前后摘要，成功及失败样本均确认未变：

- `~/.gemini/antigravity-cli/settings.json`
- `~/.gemini/config/mcp_config.json`

ACP 的 `--app-data-dir` 不接受此次传入的绝对路径；最终复用官方应用数据目录，产生了正常的官方测试会话记录。测试 MCP 配置只存在于 ACP 会话中，没有写入全局 MCP 文件。临时代理和服务进程已结束。

本机完整脱敏取证目录：

```text
/Users/leefee/Claude/antigravity-gateway-refactor-20261107-fwwdixn4/official-mcp/
```

其中 `probe_acp.py`、`controlled_mcp.py`、`capture_redacted.py` 保存探测过程，`basic/` 保存成功往返，`schema/` 保存真实上游拒绝样本。`metadata*/` 是无用户推理的入口检查。`shape/` 是未取得主生成声明的进一步调查，不作为 Schema 成功证据。

仓库内保留可供转换测试使用的[精简 fixture](../tests/fixtures/antigravity-1.5.2-mcp.json)。它不包含账号头、完整 system、真实用户任务或可回放签名。

## 基础声明与命名

本地服务名为 `audit-mcp`，原工具名为 `echo_record` 和 `fail_record`。官方请求实际声明为：

```text
mcp_audit-mcp_echo_record
mcp_audit-mcp_fail_record
```

这证明该样本使用 `mcp_`、服务名和工具名组合，并保留服务名中的连字符。不能据此承诺任意标点、Unicode、长度或名称冲突的处理规则。

声明结构是 `tools[].functionDeclarations[]`，每个外层工具块包含一个函数声明，参数使用 `parameters`，类型名称为 `OBJECT`、`STRING`、`INTEGER`、`BOOLEAN`、`ARRAY` 等大写值。服务说明前增加了标明 MCP 来源的描述。

**官方为这两个 MCP 工具增加了必填 `toolSummary: STRING`。** 模型的 `functionCall.args` 包含该字段，实际传给本地 MCP `tools/call` 的 `arguments` 不包含它。这个行为来自本次官方 MCP 实抓，不应套用到所有内置工具、结构化输出终结工具或客户端业务工具。

网关若采用该元数据形式，必须明确标记其来源并只移除自己新增的字段。客户端原本拥有的同名业务参数必须保留；名称冲突需要可逆封装或另一种声明方式，不能把业务参数覆盖成字符串。

官方还声明了 `list_resources`、`read_resource`。本次没有实际调用它们；不能因为官方存在这些工具，就给没有对应执行能力的客户端自动添加声明。

## 实际调用与结果

基础测试进行了三次主生成请求，均返回 HTTP 200：生成 echo 调用、接收 echo 结果并生成 error 调用、接收 error 结果并完成最终回答。测试服务确认两次工具调用真实执行，最终文本为 `MCP_AUDIT_DONE`。

工具调用保留上游函数名、调用 ID 和 `thoughtSignature`。官方 CLI 将调用恢复为 MCP 的原始工具名与业务参数，再交给本地服务执行；布尔值 `false`、整数、数组、嵌套对象及字符串枚举保持正确。

成功结果的上游结构为：

```json
{
  "role": "model",
  "parts": [{
    "functionResponse": {
      "id": "call_echo",
      "name": "mcp_audit-mcp_echo_record",
      "response": {"output": "<实际工具结果文本>"}
    }
  }]
}
```

当 MCP 返回 `isError: true` 时，官方使用 **`response.error`**，不是 `response.output`：

```json
{
  "role": "model",
  "parts": [{
    "functionResponse": {
      "id": "call_fail",
      "name": "mcp_audit-mcp_fail_record",
      "response": {"error": "<实际工具错误文本>"}
    }
  }]
}
```

这两个字符串都包含官方执行器记录的 `Created At`、`Completed At`；错误还包含 `Encountered error in tool execution:` 前缀。网关没有客户端执行时刻的证据时，不能自行编造这些时间。错误与成功字段的区别必须保留。

测试服务同时返回了 `content.text` 和 `structuredContent`，本次上游表现为单一结果字符串。两者包含相同的回显内容，因此不能用这个样本判定官方在两者不一致、仅有结构化结果或包含媒体时的选择规则。

## Schema 转换的实际边界

以下结论比较了 MCP `tools/list` 原始声明、官方发出的声明以及真实上游响应：

| 原始 Schema | 官方实际发出的内容 | 验证结论 |
| --- | --- | --- |
| 对象、required、嵌套 properties、数组 items | 对应大写类型及结构 | 基础工具实际调用成功 |
| 字符串 enum | 保留字符串枚举 | 基础工具实际调用成功 |
| `maximum: 3` | 保留数字 3 | 基础工具实际调用成功 |
| `minimum: 0` | 未出现 | 不能据此推断非零 minimum 的支持情况 |
| `additionalProperties: false` | 未出现 | 原约束未被完整表达 |
| `type: ["string", "null"]` | 空 Schema 对象 | 不能视为保留联合类型 |
| `oneOf` | 空 Schema 对象 | 未保留组合约束 |
| `const` | 空 Schema 对象 | 未保留常量约束 |
| `additionalProperties: {type: integer}` | 只剩 OBJECT | 未保留映射值约束 |
| 数字 enum `[0, 1.5]` | `["", ""]` | 真实上游以空 enum 拒绝 |
| `prefixItems` 与 `items: false` 元组 | ARRAY 无 items | 真实上游以缺失 items 拒绝 |
| minLength/maxLength/pattern、minItems/maxItems | 前四个长度／数量值以字符串承载，pattern 保留 | 本次所在请求整体 400，不能记为独立成功 |

复杂 Schema 场景只发出一次主生成请求，返回 HTTP 400 `INVALID_ARGUMENT`，没有实际工具调用。上游错误明确指出数字枚举为空及数组缺少 `items`。

因此，“官方 CLI 会这样转换”不等于“转换保持了客户端契约”，更不等于“上游支持完整 JSON Schema”。网关应保留原始 Schema，直接转换经验证可表达的部分；不能保持语义时使用已验证的可逆字符串／JSON 封装，并按原契约校验，不能静默删掉约束。

## 尚未验证的范围

- 任意名称长度、特殊字符及冲突消解；双服务样本中带点服务名的参数声明出现异常，不据此定义通用命名规则。
- `toolSummary` 与真实业务同名字段的官方处理行为。
- 独立的 anyOf、allOf、`$ref` 成功语义及完整 JSON Schema 关键字矩阵。
- MCP JSON-RPC 级错误、取消、进度、资源读取、图片／音频／资源块结果和动态工具变化。
- Claude、GPT-OSS 上的相同 MCP 声明与结果行为。

以上是后续有明确需求时继续补齐的证据项，不应把本次成功扩写为所有 MCP 场景均已覆盖。
