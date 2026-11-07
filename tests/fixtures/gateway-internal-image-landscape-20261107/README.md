# 原生风景图：真实 HTTP 三步闭环通过

2026-11-07 05:10（UTC+8），一个隔离 Messages HTTP 请求经过完整网关、正常账号池和原生 Go 传输，完成三次真实 Google 生成：

1. `gemini-3.8-flash-low` 返回 200，调用官方 `generate_image`，带真实上游签名。
2. 同账号／同 trajectory 的 `gemini-3.1-flash-image` 返回 200，生成湖泊、青山、晨光及木屋的水彩风景图。请求比例为 16:9。
3. 图片结果按官方回执格式送回原模型，步骤从 1／2 延续至 3；`gemini-3.8-flash-low` 返回 200，正常完成图片描述和产物交付。

这是实际 **HTTP → 网关 → 原生 Go → Google → 图片保存／回读 → 原模型续答**，不是合成上游。三次生成使用同一账号凭据，原工具 ID／名称／参数及真实签名保留，无额外生成重试或切号。

## 图片与隔离结果

[internal-image.jpg](internal-image.jpg)为 **1376×768 JPEG，965271 字节**，SHA-256：

```text
62551af9562ba44258102841b4e78178f00b9c26680258a531b17d04d6b853fc
```

HTTP 文件回读、网关磁盘和上游图片哈希一致，图片可解码。最终网关 HTTP 200，回答正常完成。57 个运行时文件的前后 SHA-256 均为 `fd34ebe97ea3e8ce6b5a0c9688f1098c74fc3d8621fc404e9c0abf08c24105e8`；正式账号、pool／quota 状态前后不变，临时凭据已删除、受控网关已退出。未替换正式安装或操作正式服务。

## 原报告与离线复核

[internal-image.json](internal-image.json)和[summary.json](summary.json)保留原始报告，不覆盖。其中唯一失败判据 `originalToolCallRetained` 来自验收器的 `JSON.stringify` 比较：原工具调用与续接对象的键顺序不同，实际 ID、名称和参数类型／值相同。

比较改为 `node:util.isDeepStrictEqual` 后，[assessment-review.json](assessment-review.json)对原证据重新判断，**19 项全部通过**；它同时记录原报告、原摘要及前后验收器 SHA。`realRequestsAddedByReview=0`：没有为了获得通过判定而再次发送风景图请求。新增[键顺序正例／参数、ID、签名篡改反例](../../../tests/internal-image-evidence-assessment.test.js)2 项，连同原轨迹测试 **3/3**，保证修正不放宽真实内容校验。

## 与旧批次的关系

03:49 的[旧空图](../gateway-internal-image-20261107/README.md)和 04:47 的[硬额度 429](../gateway-internal-image-native-20261107/README.md)发生在账号重新认证之前。3 个账号于 04:56:32—04:56:45 保存新凭据，04:56:48 正式池已清空旧健康异常。之后继续沿用“仅 1 个健康账号”的说法，是主代理把文件 hash 对新基线一致误当成旧健康结论仍有效，属于核对错误；不能据此声称用户没有恢复账号或旧系统没有清除认证异常。

05:08 的[重新认证后蓝圆空图](../gateway-internal-image-reauth-20261107/README.md)仍独立保留：该批真实上游为 [200,200]，没有 429，也没有图片。当前风景图是另一个合成提示和 16:9 比例的真实场景；离线重判没有改写旧失败，也不证明所有提示、比例和账号都能成功。此前独立生图／编辑成功仍对应[各自旧快照](../../../docs/gateway-media-integration.md)。
