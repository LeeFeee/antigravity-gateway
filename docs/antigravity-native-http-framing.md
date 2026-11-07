# Google Antigravity API 1.5.2 原生 HTTP 正文传输

2026-11-07，依据未修改的官方 agy 1.5.2 向本地全 mock 上游实际发出的请求，补齐同步生成的传输差异。本轮不向真实 Google 发请求，不读取账号，也不修改正式服务。

## 官方证据与修复

| 官方场景 | 请求 | 实际 HTTP 布局 | 原始记录 |
|---|---|---|---|
| 网页搜索 | `POST /v1internal:generateContent`，`requestType=web_search` | HTTP/1.1；`Content-Length: 720`；无 Transfer-Encoding | [web-search-v2.json](../tests/fixtures/official-request-types-20261107/web-search-v2.json) |
| 生图 | 同步 `generateContent`，`requestType=image_gen` | HTTP/1.1；`Content-Length: 373`；无 Transfer-Encoding | [image-tool-v1.json](../tests/fixtures/official-request-types-20261107/image-tool-v1.json) |
| 图片编辑 | 同步 `generateContent`，`requestType=image_gen` | HTTP/1.1；`Content-Length: 517`；无 Transfer-Encoding | [image-edit-v1.json](../tests/fixtures/official-request-types-20261107/image-edit-v1.json) |
| 同批普通生成 | `POST /v1internal:streamGenerateContent?alt=sse` | HTTP/1.1；`Transfer-Encoding: chunked`；无 Content-Length | 同上三份记录中的流式生成请求 |

这些长度是官方抓包值，不能复制成固定请求头；脱敏后的 JSON 再序列化也不保证与原捕获长度相同。实际网关应根据本次请求的完整 UTF-8 字节计算长度。

此前 [native/main.go](../native/main.go) 只对已捕获的元数据与 onboard POST 使用已知长度 Reader，同步生成落入通用 chunked 分支。现在 `capturedFixedLengthPath` 纳入精确路径 `/v1internal:generateContent`，交由 Go `net/http` 自动生成 Content-Length 和头部顺序；带查询参数仍按 pathname 判断。没有把未知路径统统改成固定长度，也没有改变 JSON 内容。

Node 桥继续删除调用方的 `content-length`、`transfer-encoding` 等自动传输头。修复在原生 Reader 选择处生效，不依靠 JS 注入会被过滤的 header。

## 保留的协议边界

- 元数据与 onboard POST 继续使用 Content-Length。
- `streamGenerateContent` 继续使用 chunked，包括普通 agent 和视频摘要；未知路径保持原处理。
- 模型 RPC 继续使用原 HTTP/1.1 连接池和无 ALPN 的 TLS 配置。
- OAuth 使用独立 HTTP/2 连接池，token 表单按实际字节发送，不受同步生成路径变更影响。

## 验证与平台产物

[Go 传输测试](../native/main_test.go) 通过真实 loopback HTTP 验证：搜索、生图、带查询参数的同步生成使用完整 UTF-8 长度；流式生成、视频摘要、相似但未知的路径保持 chunked。原 OAuth 本地 TLS 测试继续验证实际 HTTP/2 协商与模型连接池分离。

[Node → 打包 Go 测试](../tests/agy-native-transport.test.js) 从上述三份官方记录取得请求与头部布局，经真实原生子进程发送到 loopback，核对正文、长度、HTTP 版本与头部顺序；同时故意传入错误 Content-Length 与 chunked 头，验证最终由 Go 正确生成。新增用例在旧产物上首先复现失败：同步生成没有 Content-Length；重建后通过。

Go 测试全过；原生传输、OAuth 配置及官方认证证据三组 Node 测试合计 **25/25** 通过，包括原模型 ClientHello 稳定字段及两个 OAuth endpoint 的 HTTP/2 ALPN。没有以这些本地测试声称本轮完成真实 Google 同步生成验收。

使用固定 Go **1.27.2** 重建 darwin-arm64、darwin-x64、linux-arm64、linux-x64、win32-arm64、win32-x64 全部六个产物。逐项验证 gzip SHA、解压后二进制 SHA、字节数及源码摘要与 [manifest.json](../native/bin/manifest.json) 相符。本轮 `go.mod + main.go` 源码摘要为：

```text
47e34ff9c729c93109f673028e3e2435e7960b373e60b369dab9fa7e1be5f5dc
```

其他架构完成交叉构建与完整性校验；本机实际执行测试的是 darwin-arm64 产物，未据此声称其他平台已运行。
