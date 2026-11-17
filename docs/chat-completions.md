# OpenAI Chat Completions

`POST /v1/chat/completions` 与 Messages、Responses 并行提供服务。客户端的 OpenAI 基址仍是 `http://127.0.0.1:9897/v1`，远程部署沿用原域名和 Key。无需开关，也不需要迁移账号池或修改已有客户端。

接口复用公共推理流程，直接转发至 Google Antigravity API 或 Google Gemini API。带 `-g` 的公开模型使用 Gemini 账号池，其他模型使用 Antigravity 账号池；不跨上游降级。带档位模型名仍唯一决定思考配置，客户端的冲突思考参数不会改变上游档位。

## 请求与返回

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:9897/v1",
    api_key=os.environ["GATEWAY_API_KEY"],
)
response = client.chat.completions.create(
    model="gemini-3.8-flash-high",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
```

使用流式响应时设置 `stream=True`；需要用量时增加 `stream_options={"include_usage": True}`。数据以 `chat.completion.chunk` 返回，正常结束包含 `finish_reason` 和 `data: [DONE]`。请求工具时返回带索引的 `delta.tool_calls`；工具由客户端执行，再以 `role: "tool"` 和原 `tool_call_id` 回传。网关不会代替客户端执行 shell、文件或浏览器工具。

网关会缓冲需要校验的工具和结构化结果，确认完整后发送；纯文本请求可转发上游增量。SSE 已开始后发生错误，会发送 OpenAI 风格的 `error` 对象并关闭流，不伪造成功结束。HTTP 200 本身不能证明生成成功。

| 能力 | 行为 |
| --- | --- |
| 对话 | 保留 system、developer、user、assistant、tool 历史；SOUL 和自定义规则沿用原有来源识别规则 |
| 函数工具 | `tools[].function`、`tool_choice`、`parallel_tool_calls`；名称、参数、调用 ID 往返保持对应 |
| 自定义工具 | `tools[].custom`、原始文本输入及声明的 grammar，复用已有自定义工具契约 |
| 旧式函数 | `functions`、`function_call`、`role: function`；返回旧式 `message.function_call` 和 `finish_reason: function_call` |
| 输出长度 | `max_completion_tokens` 优先于 `max_tokens` |
| 采样与停止 | `temperature`、`top_p`、字符串或数组形式的 `stop`，沿用目标上游能力 |
| JSON | `response_format: json_object`、`json_schema`；使用公共结构化输出转换和本地 Schema 校验 |
| 思考展示 | 可用 `include_reasoning: true` 接收 `reasoning_content` 扩展字段；模型档位独立于展示开关 |
| 用量 | prompt/completion/total tokens，以及 cached/reasoning tokens 明细；隐藏思考计入 completion tokens |
| 多模态 | Antigravity 复用已有图片、音频、文件和视频输入处理；图片生成结果沿用 `images`、`artifacts` 扩展字段 |

Gemini Task 的多模态限制维持原状，新入口不会自动增加上游能力。没有可靠用量时沿用 `usage_known: false`，不伪造计费数字。

## 明确边界

当前每次请求返回一个候选。多候选 `n > 1`、logprobs、非空 logit_bias、输出音频、prediction、非零频率/存在惩罚、seed、verbosity、moderation、非默认 service_tier、`store: true` 和 Chat 专用 `web_search_options` 暂不支持，会明确返回 400。客户端自己的搜索函数仍按普通工具转发；已有 Messages／Responses 内置服务器搜索路径不受影响。

此入口不提供 OpenAI 托管的完成记录存储、列表、修改或删除 API。客户端负责提交完整历史；网关不重建客户端会话、不执行工具，也不更改默认模型和权限模式。

旧式 `functions` 在线路中没有调用 ID，因此网关仅缓存“完整请求前缀与函数调用的哈希 → 已签发的 ID”，用于同一调用方回传工具结果；不绑定账号、不补写历史。映射随进程结束清空，最多保存 2,000 条、24 小时。需要跨网关重启提交工具结果的客户端应使用携带 ID 的 `tools/tool_calls`。

## 验收方式

使用真实客户端产生的完整请求，经安装后的网关入口连接真实 Google 服务。可用 `scripts/verify-chat-completions.js` 保存并检查请求、JSON/SSE、结束事件与真实用量：

```sh
node scripts/verify-chat-completions.js \
  --request /private/evidence/full-client-request.json \
  --base-url http://127.0.0.1:9897/v1 \
  --mode stream \
  --output /private/evidence/chat-stream
```

Key 从 `GATEWAY_API_KEY` 环境变量读取。原始请求和响应应放在仓库外的受限目录；不能用删工具、改 SOUL、缩短上下文或替换模型的请求证明兼容。

协议字段依据 [OpenAI Chat Completions 官方文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。这是一层兼容接口，上游能力以实际模型和已验证的 Google 请求格式为准。
