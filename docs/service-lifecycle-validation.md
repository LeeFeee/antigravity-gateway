# macOS 隔离后台服务生命周期验证

2026-11-07 使用真实 `manageService()` 与系统 `launchctl` 完成 A30 的 macOS 服务实跑。脚本为 [`scripts/verify-service-lifecycle.js`](../scripts/verify-service-lifecycle.js)，完整结果为 [`tests/fixtures/service-lifecycle-20261107.json`](../tests/fixtures/service-lifecycle-20261107.json)。

测试只创建随机 `io.github.leefeee.antigravity-gateway-verify-<随机值>` label，使用临时 HOME、配置目录、日志和端口，账号池为空。正式 `io.github.leefeee.antigravity-gateway` 只读取 PID 与配置／plist 哈希，不执行启动、停止或更新。

| 阶段 | 实际检查与结果 |
| --- | --- |
| 前置条件 | 当前 GUI 用户域存在；测试 label 与 plist 尚不存在 |
| start | 原 service-manager 写入测试 plist／配置并真实 bootstrap；健康 HTTP 200，账号数 0，usage 与模型配置路径位于同一临时目录 |
| status | 返回已配置、运行中；实际 runner 与 gateway 子进程均存在 |
| restart | 真实 kickstart；runner PID 从 34175 变为 34194，gateway PID 从 34176 变为 34196；原进程已退出，健康响应仍指向原测试配置，plist／配置哈希不变 |
| stop | 真实 bootout；服务 target 消失、端口关闭、runner 与 gateway 已退出；plist／配置按原行为保留 |
| uninstall | 删除本次 plist／配置；状态显示未配置、未运行 |
| finally | 再次检查 target 不存在、端口关闭，删除整个临时根目录 |
| 正式服务 | 前后 runner PID 均为 2219、gateway PID 均为 2220；正式 plist 和配置 SHA-256 完全不变 |

报告的 12 项检查全部通过；运行期间主入口、service-manager 和 service-runner 源码哈希未变。对应服务与脚本边界测试 10/10 通过，脚本语法检查通过。

复现命令：

```sh
node scripts/verify-service-lifecycle.js --out /private/tmp/service-lifecycle-report.json
```

脚本中的 launchctl 执行器仅接受本次随机 target 与临时 plist，拒绝正式 label、其他用户域和整域 bootout。只执行健康查询，没有模型请求、账号授权、真实账号读取、全局安装或正式服务重启。

本记录只证明 macOS 上真实服务生命周期；Linux systemd 与 Windows 服务仍按各自模板和已有单元测试验证，不能把本次 macOS 实跑外推成跨平台服务实测。
