# muse-in-wechat

在微信 Clawbot 中与 Muse 文字对话，无需公网服务器。

## 使用

安装 [Bun](https://bun.sh)，在项目目录安装依赖后启动：

```sh
bun install
bun start
```

`start` 会按 **Muse → 微信** 的顺序检查绑定：

- 未绑定 Muse：引导输入 SDK Token 并在 Muse 手机 App 中完成蓝牙配对。
- 未绑定微信：在终端显示二维码，用微信扫码完成绑定。
- 已绑定的部分：显示「已绑定」并跳过配对。

两边绑定完成后自动启动，无需再运行其他命令。以后只需 `bun start`。
按 `Ctrl+C` 退出。如果绑定中断，重新运行 `bun start` 会继续处理尚未绑定的部分。

### 首次 Muse 配对

Muse SDK 目前使用蓝牙配对，不提供扫码绑定。首次配对需要 macOS、蓝牙权限和 Xcode Command Line Tools（可运行 `xcode-select --install` 安装）。

1. 在 https://gadgets.muse.ai/settings/sdk-tokens 获取个人 SDK Token，按终端提示粘贴（输入不显示）。也可以通过 `MUSE_SDK_TOKEN` 环境变量或项目 `.env` 文件提供。
2. 在 Muse 手机 App 的 **Settings > Devices** 中开启 **Developer mode**，选择 **Add Device**。
3. 选择终端显示的 `MuseGadgetXXXXXX` 设备并确认；Wi-Fi 选择 **Use current connection**。
4. 等待绑定成功，程序会继续检查微信绑定。

Muse 凭据和 Token 由 SDK 保存在 `~/Library/Application Support/MuseGadgetPair/`；微信凭据保存在 `~/.openclaw/`。已有的 SDK 绑定会直接复用。「已绑定」表示检测到本地凭据，实际连接会在启动时建立。

## 可选设置

| 环境变量 | 用途 |
| --- | --- |
| `MUSE_SDK_TOKEN` | 首次 Muse 配对使用的 SDK Token |
| `MUSE_CREDENTIALS_DIR` | 自定义 Muse 凭据目录 |
| `MUSE_VM_ID` | 指定 Muse VM，默认使用默认 VM |
| `MUSE_SESSION_ID` | 指定已有侧会话，默认主会话 |
| `MUSE_DEBUG_WIDGETS` | 设为 `1`，将含 widget 的原始事件写入 `logs/`（含消息内容） |

如需单独绑定，仍可运行 `bun run muse` 或 `bun run wechat`。

仅支持文字聊天（含微信已转写的语音）和一个微信会话。选项按钮转换为编号列表，可回复数字选择。重启保留 Muse 会话上下文，不支持 `/clear`。收到第一条微信消息后，会转发所选 Muse 会话的全部新助手回复，包括其他客户端触发的回复。

## 开发检查

```sh
bun test
bun run typecheck
```
