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
