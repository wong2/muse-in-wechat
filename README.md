# muse-in-wechat

在微信 Clawbot 中与 Muse 文字或图片对话，无需公网服务器。

## 使用

安装 [Bun](https://bun.sh) 后：

```sh
bun install
bun start
```

`bun start` 会依次检查 Muse 和微信的绑定，未绑定时引导完成，然后启动。按 `Ctrl+C` 退出。

首次 Muse 配对需要 macOS、蓝牙权限和 Xcode Command Line Tools：

1. 在 https://gadgets.muse.ai/settings/sdk-tokens 获取 SDK Token，按提示粘贴（或通过 `MUSE_SDK_TOKEN` 环境变量提供）。
2. 在 Muse 手机 App 的 **Settings > Devices** 中开启 **Developer mode**，选择 **Add Device**。
3. 选择终端显示的 `MuseGadgetXXXXXX` 设备并确认；Wi-Fi 选择 **Use current connection**。

微信绑定时在终端扫描二维码即可。可通过 `MUSE_SESSION_ID` 指定已有的 Muse 侧会话，默认主会话。

支持文字、图片（可附带说明；超过约 190KB 时自动压缩成 JPEG）和一个微信会话。视频和文件会提示不支持。选项按钮转为圆圈编号，回复数字选择。

Muse 返回的网页链接和文件卡片会转为标题与 HTTP(S) 地址发送；链接、文件没有可用地址或遇到不支持的卡片、交互组件时，提示在 Muse App 查看，并在提示前显示其 `kind`（缺失时使用 `type`），例如 `【browser_task - 此内容请在 Muse App 中查看】`；没有类型信息时保留原提示。状态、心跳等后台事件不转发。普通 Markdown 链接也会保留地址。项目通过 Bun 补丁修正微信 SDK 的链接转换，`bun install` 会自动应用。

调试时，用 `MUSE_DEBUG=1 bun start` 启动。所有 Muse 订阅事件的完整 `payload` 和 `raw`（包括正文、卡片、资源及未知事件类型）会在任何过滤和转换之前逐条写入终端显示的 `logs/muse-events-*.jsonl`，每条附带接收时间，无需先收到微信消息。每次启动生成独立日志文件。日志包含会话内容，`logs/` 已被 Git 忽略；普通启动不记录。
