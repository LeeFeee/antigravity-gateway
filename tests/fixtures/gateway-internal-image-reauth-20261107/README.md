# 重新认证后的原生生图：独立空图失败

2026-11-07 05:08（UTC+8），使用重新认证后的正常账号池隔离副本执行一个 Messages 请求，真实 Google 生成状态为 **[200,200]，没有 429**。

- 第 1 步 `gemini-3.8-flash-low` 返回官方 `generate_image` 调用及真实签名。
- 第 2 步同账号、同 trajectory 的 `gemini-3.1-flash-image` 收到蓝圆／白底提示，比例 1:1。HTTP 200 的候选为 `content:{}`，没有图片或 `finishReason`；`finishMessage` 表示无法显示生成图片、不会计费并建议改写提示。用量仅输入 34、总计 34 token，没有图片输出 token。
- 没有图片产物，第 3 步回执续答未发生。provider 识别缺少图片后，后续切换尝试被本次单次／顺序保护器阻止；客户端最终 500 不能写成 Google 返回 500。

本次 image_gen 与官方 agy 1.5.2 发包、旧真实成功独立生图相比，去掉 prompt、项目及 requestId 变量后请求体相同：`generationConfig={candidateCount:1,imageConfig:{aspectRatio:"1:1"}}`。官方与旧成功样本也没有 `responseModalities`／`imageSize`／`modelConfig`，因此没有字段缺失的证据。这里只确认上游接受请求但没有交付图片，不从提示文案推断具体内部原因。

## 账号时间线与隔离

3 个账号已于 **04:56:32—04:56:45** 保存新凭据，正式池于 **04:56:48** 清空旧健康异常；本批前核对为 4 个启用、4 个健康、无认证异常。03:49 的旧空图和 04:47 的硬额度测试均早于此恢复。后来仍称“仅 1 个健康账号”，是主代理将 hash 与新基线一致误解为旧健康结论仍有效的核对错误；本次不能再归因为用户未重新认证、旧系统未恢复或前一批 429。

[account-state-before.json](account-state-before.json)保存本批开始前的脱敏状态核对；[internal-image.json](internal-image.json)和[summary.json](summary.json)保留原失败报告。57 个运行时文件摘要前后均为 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`，正式账号及 pool／quota 状态前后不变；临时凭据已删除，受控网关已退出。未解除健康或额度保护，也未因剩余预算继续发包。

随后[风景图场景](../gateway-internal-image-landscape-20261107/README.md)取得三次真实 200 并生成图片，属于另一份提示／比例的独立证据，不覆盖或改写本目录的空图失败。
