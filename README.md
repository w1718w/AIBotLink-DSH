# AIBotLink DSH Host 桥接插件

实现 AIBotLink 网关 DSH Host 桥接接口的 Cordis 插件：在 DSH Host 内复用原生会话、模型目录、权限和交互，不连接 QQ，不创建第二个 Agent Host，也不代理模型 API。网关只依赖接口契约，不依赖本插件的具体实现；本插件也不假设网关的安装位置或进程结构。

入口为 [index.mjs](index.mjs)，包元数据及 bundle 声明见 [package.json](package.json) 和 [cordis.patch.yml](cordis.patch.yml)。中文提示资源位于 [locales/zh-CN.json](locales/zh-CN.json)。

## 安装与连接

需要 Node.js >=22.19，以及提供 `typertGateway`、`connection`、`sessionController` 的 DSH Host。已做接口探测的版本为 DSH 0.2.1-rc.2；其他版本需核验原生契约。

在本仓库目录使用 DSH 原生插件 CLI 注册：

```powershell
dsh plugin --profile desktop add --save-exact .
```

确认目标 Profile 启用 `aibotlink-dsh-companion` bundle，再重启该 Host。注册成功不等于插件已加载；网关应完成握手后再逐项验证能力。安装时保留 Profile 备份，本机路径、连接记录和凭据必须在源仓库外。

插件仅监听 `127.0.0.1` 动态端口，默认将连接地址与随机 Token 写入 `%LOCALAPPDATA%\AIBotLink\dsh-bridge.json`。可通过 Host 插件配置的 `dataHome` 或进程 `BOTLINK_HOME` 指定其他仓库外目录，该目录不能位于 Git 仓库内；网关的 `dshBridge` 应指向同一记录。不要提交、共享或在问题报告中粘贴该文件。

## 实现范围

本插件按网关的 DSH Host 桥接接口实现：初始化、会话创建/恢复/列表、历史、分支、模型与推理选项、权限目录与执行、文本任务提交/停止/Steer/压缩，以及审批与提问交互。不支持的方法按接口约定返回错误，不伪造成功。连接记录、认证、单客户端事件流和错误语义遵循网关侧的接口契约。

插件只复用原生 Host 会话与交互，不新增公网监听、不启停 Host、不自动批准审批。默认模型和提供方来自原生 catalog/summary；更改模型或推理选项可能保存原生默认值，不保证只影响当前会话。网关断开时仅撤销 IM 客户端路径，不停止 Host，也不自动取消已经进入原生 Host 的任务；未知任务结果应在原生端核验，不能自动重放。

## 独立测试

需要 Node.js >=22.19。`npm run check` 先做语法检查，再运行 [bridge.test.mjs](bridge.test.mjs) 的 8 项本地测试：

```powershell
$env:AILINKBRIDGE_GATEWAY = '<gateway 目录>'
npm run check
```

测试默认从同级 `..\gateway` 加载已构建的网关 Host 客户端与适配器；也可用 `AILINKBRIDGE_GATEWAY` 指向其他网关目录。集成用例要求网关已完成 `npm run build`，未找到构建产物时该用例跳过，其余用例使用仓库内假客户端运行。所有用例只使用假 Host 与回环服务，不连接真实 QQ、不调用模型；跳过或本地通过不等于真实 Host 集成验收。

真实 Host 握手、会话创建/列表、模型与权限目录、历史查询已有探测证据；完整模型任务终态及 QQ 回复尚未完成验收。持续事件流版本需要在最终发布目录重新加载验证。不能将本地测试或元数据接口通过写成模型 E2E 通过。

## 许可证

本仓库采用 MIT 许可，见 [LICENSE](LICENSE)。插件参考 MIT 许可的 [dsh-im](https://github.com/xmanrui/dsh-im) 5.4.0 Host gateway/peer 与交互模式，复用了 [prompt-failure-tracker.mjs](prompt-failure-tracker.mjs)，对应版权和许可保留在 [LICENSE.dsh-im](LICENSE.dsh-im)。

插件不是 dsh-im 的 QQ 接收端，不能据此认为已复用其真实 IM 验收结果。
