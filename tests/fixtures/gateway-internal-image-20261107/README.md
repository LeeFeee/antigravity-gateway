# 内部生图单次真实验收：未完成

2026-11-07（Asia/Kuala_Lumpur），只运行一个隔离 Messages 请求；主模型明确为 `gemini-3.8-flash-low`，显式启用既有网关内部图片扩展。实际最多允许 3 次物理生成，阶段、账号凭据、模型、思考档位与轨迹均由观察层发送前检查；没有替换原生 Go 传输，没有修改核心代码。

```sh
node scripts/verify-gateway-media.js --scenarios internal-image --generation-budget 3 --out tests/fixtures/gateway-internal-image-20261107 --run
```

本目录已经保存结果，脚本拒绝覆盖；该命令仅说明这次的复现方式，不代表授权重跑。

实际结果：

- 只有 2 次物理生成，均 HTTP 200，无 429、无重试、无切换模型或账号。
- 第 1 步由 Gemini Low 返回真实工具调用和思考签名。当前内部 `generate_image` 在上游声明为唯一 MCP 兼容工具 `mcp_gateway_tool_ad362ad9adcc3685`；网关成功还原并进入图片服务。
- 第 2 步向 `gemini-3.1-flash-image` 发出 `image_gen` 请求。与第 1 步使用同一账号凭据、同一 trajectory，步骤依次为 1、2。
- 图片响应为 `content: {}`，上游 `finishMessage` 表示无法生成图片。两包 HTTP 200 仅证明请求获得 HTTP 成功响应，不能证明图片生成成功或 1/2/3 完整闭环。
- 网关返回 HTTP 502、`image_response_missing`。没有图片文件，也没有第 3 步回执续答。没有因为尚余一次预算而重试。

`internal-image.json` 与 `summary.json` 保留当次原始脱敏报告。原评估器只识别官方工具名称，未识别本次唯一 MCP 兼容名称；`assessment-review.json` 是后续离线重算，记录原始证据 SHA 和评估器 SHA，并正确确认真实工具调用/签名及图片子请求已出现。完整验收结果仍为失败；离线复核没有追加真实请求。

清理结果：正式 accounts、pool/quota 状态摘要前后相同；53 个核心源码文件摘要前后均为 `816eadc36e691bb4aa1936e7a8e78ef7d13a64dd2e522eb7bf2fd7caa2c39146`；临时凭据已删除，受控网关已退出。没有操作正式安装或服务。
