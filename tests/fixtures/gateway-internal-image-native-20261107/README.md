# 官方内部生图声明修复后的真实验收

本次仅发送一个隔离 Messages 请求，最多允许三次物理生成。使用 v6 同一核心快照 `6ff6487b7558aba133f0d8fac0ca50e062b91b0d4f1b357f29b60ae2a20bfc92`；正式安装、账号和服务未替换。

实际仅发出两次生成：

1. `gemini-3.8-flash-low` 返回 200，真实调用 `generate_image`，带上游真实思考签名。实际声明与未修改官方 agy 1.5.2 的 `image-tool-v1.json` 逐字段相等。
2. 同账号、同 trajectory 的 `gemini-3.1-flash-image` 请求返回 429、`QUOTA_EXHAUSTED`。服务器给出恢复时刻 `2026-11-06T23:11:30Z`（UTC+8 为 11 月 7 日 07:11:30），当时约剩 2 小时 24 分钟。

没有图片输出，也没有第三步回执续答，**完整内部生图验收未通过**。不能把第一步的官方声明和工具调用成功扩大为图片服务成功。

单次验收保护拒绝了 provider 随后的同账号重试尝试，因此客户端最终 500 来自保护器，不是实际 Google 返回的 500；真实上游状态只有 `[200,429]`。此现象同时暴露旧版继承的行为：明确额度耗尽后 provider 仍尝试更换主机并重试，后续最小修复与本份原始失败证据分开记录。

只读核对当时正式池的四个托管账号：四个启用，三个已有持久认证异常，仅一个健康。没有解除额度或健康保护，没有为本次验收恢复异常账号，也没有追加图片生成请求。

`internal-image.json`、`summary.json` 是原始脱敏报告；`assessment-review.json` 是不增加真实请求的补充核对。源码摘要、正式账号、pool/quota 状态前后相同；临时凭据已删除，受控网关已停止。

本次执行命令仅作证据记录，输出目录禁止覆盖：

```sh
node scripts/verify-gateway-media.js --scenarios internal-image --generation-budget 3 \
  --out tests/fixtures/gateway-internal-image-native-20261107 --run
```
