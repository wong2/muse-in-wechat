/**
 * muse-in-wechat — 在微信 Clawbot 中与 Muse 文字对话，无需公网服务器。
 *
 *   bun start   按需完成 Muse 配对与微信扫码绑定，然后启动；Ctrl+C 退出
 *
 * 复用同一 Muse 会话保留上下文（不支持 /clear）；收到第一条微信消息后，
 * 转发所选会话全部新的助手回复；选项按钮转为编号列表，回复数字发送对应选项；
 * Muse 断线自动重连，不自动重发。
 */

import { MuseClient } from "muse-client";
import { defaultCredentialsDirectory, loadCredentials, saveCredentials } from "muse-client/credentials";
import { type Agent, isLoggedIn, login, start } from "weixin-agent-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { SessionReplies } from "./replies";
import { OptionWidgets } from "./widgets";

const sessionId = process.env.MUSE_SESSION_ID || undefined;

const shutdown = new AbortController();
let loggingIntoWechat = false;
for (const name of ["SIGINT", "SIGTERM"] as const)
  process.once(name, () => {
    shutdown.abort();
    // 微信 SDK 的扫码登录不支持 AbortSignal，退出进程以终止其轮询。
    if (loggingIntoWechat) process.exit(name === "SIGINT" ? 130 : 143);
  });

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "未知错误";

// 长回复按 2000 个 Unicode 码点分段，不切散 emoji。
function* chunks(text: string, size = 2000) {
  const chars = [...text];
  for (let i = 0; i < chars.length; i += size) yield chars.slice(i, i + size).join("");
}

async function isMuseBound() {
  try {
    await loadCredentials();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return false;
  }
}

async function readSdkToken() {
  const token = process.env.MUSE_SDK_TOKEN?.trim();
  if (token) return token;
  try {
    return (await readFile(join(defaultCredentialsDirectory(), "sdk_token"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.log("请在 https://gadgets.muse.ai/settings/sdk-tokens 获取 Muse SDK Token。");
  if (!process.stdin.isTTY) throw new Error("请在交互式终端运行 bun start，或通过 MUSE_SDK_TOKEN 环境变量提供 Token。");
  process.stdout.write("粘贴 Muse SDK Token（输入不显示），然后按回车：");
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  input.on("SIGINT", () => shutdown.abort());
  try {
    return await input.question("", { signal: shutdown.signal });
  } finally {
    input.close();
    muted.end();
    process.stdout.write("\n");
  }
}

async function pairMuse() {
  if (process.platform !== "darwin") throw new Error("首次 Muse 配对需要在 macOS 上完成。");
  const { pairMacOS } = await import("muse-client/pairing");
  const sdkToken = await readSdkToken();
  console.log("请允许蓝牙访问，在 Muse 手机 App 的 Settings > Devices 中开启 Developer mode，再选择 Add Device。");
  console.log("选择接下来显示的 MuseGadget 设备并确认；Wi-Fi 选择 Use current connection。");
  await pairMacOS({ sdkToken, signal: shutdown.signal, onProgress: console.log });
}

async function bindWechat() {
  loggingIntoWechat = true;
  try { await login(); }
  finally { loggingIntoWechat = false; }
  if (!isLoggedIn()) throw new Error("微信绑定未完成，请重新运行 bun start。");
}

async function run() {
  let client: MuseClient | undefined;
  let subscription: Awaited<ReturnType<MuseClient["subscribe"]>> | undefined;
  const replies = new SessionReplies();
  const widgets = new OptionWidgets();
  let active = false;
  let wechatId: string | undefined;   // 仅支持一个微信会话
  let bot!: ReturnType<typeof start>;

  const connect = async () => {
    const c = await MuseClient.connect({
      credentials: await loadCredentials(),
      onCredentials: (credentials) => saveCredentials(credentials),
      onWarning: console.warn,
    });
    try {
      const events = await c.subscribe({ sessionId, signal: shutdown.signal });
      if (shutdown.signal.aborted) {
        events.close();
        c.close();
        return;
      }
      subscription = events;
      client = c;
    } catch (error) {
      c.close();
      throw error;
    }
  };
  const disconnect = () => {
    widgets.reset();
    subscription?.close();
    client?.close();
    subscription = undefined;
    client = undefined;
  };

  const agent: Agent = {
    async chat(request) {
      const text = request.text.trim();
      if (request.media) return { text: "Muse 暂只支持文字聊天，请将内容转成文字后发送。" };
      if (!text) return { text: "请发送文字消息。" };
      if (wechatId && wechatId !== request.conversationId)
        return { text: "此桥接仅支持一个微信会话。" };
      wechatId = request.conversationId;
      if (text === "/help") return { text:
        "直接发送文字即可和 Muse 对话。选项列表可回复数字选择，会发送对应选项文字。收到消息后，同步所选 Muse 会话中的全部新回复（包括其他客户端触发的回复）。不支持 /clear；重启会保留 Muse 的会话上下文。" };
      if (shutdown.signal.aborted) return {};
      const c = client;
      if (!c) return { text: "Muse 正在重新连接，消息尚未发送，请稍后再试。" };
      const input = widgets.resolve(request.text);
      if ("error" in input) return { text: input.error };
      active = true; // 回复可能先于发送确认到达。
      try {
        await c.sendMessage(input.text, { sessionId, signal: shutdown.signal });
        return {}; // 回复由长驻订阅独立转发，不等待请求关联或整轮完成。
      } catch (error) {
        if (shutdown.signal.aborted) return {};
        console.error("Muse 消息发送失败：", errorMessage(error));
        return { text: "未能确认 Muse 是否收到消息，请在 Muse 查看本次请求。为避免重复执行，没有自动重发。" };
      }
    },
    clearSession() {
      // 微信 SDK 会拦截 /clear；不能假装清除了 Muse 历史。
      throw new Error("Muse SDK 不支持清除会话；请在 Muse 中管理会话。");
    },
  };

  await connect();
  if (shutdown.signal.aborted) return;
  const watching = (async () => {
    while (!shutdown.signal.aborted) {
      try {
        for await (const event of subscription!) {
          if (shutdown.signal.aborted) return;
          widgets.observe(event);
          const text = replies.take(event);
          if (!text || !active) continue;
          const reply = widgets.render(text);
          widgets.clearSelection();
          try {
            for (const part of chunks(reply.text)) {
              if (shutdown.signal.aborted) return;
              await bot.sendMessage(part);
            }
            if (!shutdown.signal.aborted) widgets.activate(reply);
          } catch (error) {
            console.error("微信回复发送失败，请在 Muse 查看原回复：", errorMessage(error));
          }
        }
      } catch (error) {
        if (shutdown.signal.aborted) return;
        console.error("Muse 订阅中断：", errorMessage(error));
      }
      if (shutdown.signal.aborted) return;
      disconnect();
      replies.resetStream();
      console.log("Muse 连接中断，正在重连；中断期间的回复可能需要在 Muse 查看。");
      for (let attempt = 0; !shutdown.signal.aborted; attempt++) {
        try {
          await delay(Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000), undefined,
            { signal: shutdown.signal });
          await connect();
          break;
        } catch (error) {
          if (shutdown.signal.aborted) return;
          console.error("Muse 重连失败：", errorMessage(error));
        }
      }
    }
  })();
  watching.catch(() => {}); // 立即处理拒绝；退出时仍会等待订阅结束。
  shutdown.signal.addEventListener("abort", disconnect, { once: true });
  try {
    bot = start(agent, { abortSignal: shutdown.signal });
    console.log("已启动。请在微信 Clawbot 发送文字；Ctrl+C 退出。");
    await bot.wait();
  } finally {
    shutdown.abort();
    disconnect();
    await watching;
  }
}

try {
  if (await isMuseBound()) console.log("Muse：已绑定。");
  else {
    console.log("Muse：未绑定，开始配对。");
    await pairMuse();
    shutdown.signal.throwIfAborted();
    await loadCredentials();
    console.log("Muse：绑定成功。");
  }
  shutdown.signal.throwIfAborted();
  if (isLoggedIn()) console.log("微信：已绑定。");
  else {
    console.log("微信：未绑定，请扫描接下来显示的二维码。");
    await bindWechat();
    console.log("微信：绑定成功。");
  }
  shutdown.signal.throwIfAborted();
  await run();
} catch (error) {
  if (!shutdown.signal.aborted) {
    console.error(error instanceof Error ? error.message : "启动失败");
    process.exitCode = 1;
  }
}
