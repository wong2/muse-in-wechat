/**
 * muse-in-wechat — 在微信 Clawbot 中与 Muse 文字对话，无需公网服务器。
 *
 *   bun start   按需完成 Muse 配对与微信扫码绑定，然后启动；Ctrl+C 退出
 *
 * 复用同一 Muse 会话保留上下文；收到第一条微信消息后，
 * 转发所选会话全部新的助手回复；选项按钮转为编号列表，回复数字发送对应选项；
 * 图片随文字发给 Muse，超过客户端限制时自动压缩；Muse 断线自动重连，不自动重发。
 */

import { type ChatEvent, type ImageAttachment, MuseClient, MuseError, transcriptText } from "muse-client";
import { defaultCredentialsDirectory, loadCredentials, saveCredentials } from "muse-client/credentials";
import { type Agent, isLoggedIn, login, start } from "weixin-agent-sdk";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

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
const runFile = promisify(execFile);

// 长回复按 2000 个字素簇分段，不切散 emoji。
function* chunks(text: string, size = 2000) {
  const chars = [...new Intl.Segmenter().segment(text)].map((part) => part.segment);
  for (let i = 0; i < chars.length; i += size) yield chars.slice(i, i + size).join("");
}

// ①–㊿；更多时退回普通编号。回复普通数字同样有效。
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿";
function optionMark(n: number) {
  return CIRCLED[n - 1] ?? `${n}.`;
}
function optionNumber(input: string) {
  const circled = CIRCLED.indexOf(input);
  if (circled >= 0) return circled + 1;
  return /^\d+$/.test(input) ? Number(input) : undefined;
}

// muse-client 把 JSON 请求限制在约 255KB；base64 后图片需小于 190KB。超出时用 sips 压成 JPEG。
const IMAGE_LIMIT = 190 * 1024;
function imageFile(data: Uint8Array): Pick<ImageAttachment, "mimeType" | "filename"> | undefined {
  const ascii = (start: number, length: number) =>
    data.length >= start + length ? String.fromCharCode(...data.subarray(start, start + length)) : "";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mimeType: "image/jpeg", filename: "wechat.jpg" };
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return { mimeType: "image/png", filename: "wechat.png" };
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { mimeType: "image/gif", filename: "wechat.gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { mimeType: "image/webp", filename: "wechat.webp" };
  if (ascii(0, 2) === "BM") return { mimeType: "image/bmp", filename: "wechat.bmp" };
  if ((ascii(0, 2) === "II" && data[2] === 0x2a) || (ascii(0, 2) === "MM" && data[2] === 0 && data[3] === 0x2a))
    return { mimeType: "image/tiff", filename: "wechat.tiff" };
  const brand = ascii(4, 4) === "ftyp" ? ascii(8, 4).toLowerCase() : "";
  if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand))
    return { mimeType: "image/heic", filename: "wechat.heic" };
  if (brand === "avif" || brand === "avis") return { mimeType: "image/avif", filename: "wechat.avif" };
}

async function compressForMuse(filePath: string): Promise<Buffer | { error: string }> {
  const failed = { error: "无法压缩这张图片，请换一张较小的 JPEG 或 PNG。" };
  let width = 0;
  let height = 0;
  try {
    const { stdout } = await runFile("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], { timeout: 20_000 });
    width = Number(stdout.match(/pixelWidth: (\d+)/)?.[1]);
    height = Number(stdout.match(/pixelHeight: (\d+)/)?.[1]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { error: "这张图片超过 190KB，当前系统没有 sips，无法自动压缩。" };
    return failed;
  }
  if (!width || !height) return failed;

  const dir = await mkdtemp(join(tmpdir(), "muse-wechat-"));
  const out = join(dir, "wechat.jpg");
  try {
    // 先缩到长边 1600、质量 72，仍超限再逐步缩小。不放大原图。
    for (const [edge, quality] of [[1600, 72], [1280, 60], [1024, 50], [800, 40], [640, 30], [480, 22]] as const) {
      const args = ["-s", "format", "jpeg", "-s", "formatOptions", String(quality)];
      if (Math.max(width, height) > edge)
        args.push(width >= height ? "--resampleWidth" : "--resampleHeight", String(edge));
      args.push(filePath, "--out", out);
      await runFile("sips", args, { timeout: 20_000 });
      const data = await readFile(out);
      if (data.byteLength <= IMAGE_LIMIT && imageFile(data)) return data;
    }
    return { error: "图片压缩后仍然超过 Muse 的大小限制，这次没有发出去。" };
  } catch {
    return failed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadWechatImage(filePath: string): Promise<ImageAttachment | { error: string }> {
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    return { error: "未能读取这张图片，请重新发送。" };
  }
  if (!data.byteLength) return { error: "这张图片是空的，请重新发送。" };
  const file = imageFile(data);
  if (file && data.byteLength <= IMAGE_LIMIT) return { data, ...file };
  const compressed = await compressForMuse(filePath);
  if (Buffer.isBuffer(compressed)) {
    console.log(`图片 ${data.byteLength} 字节，压缩为 ${compressed.byteLength} 字节后发送。`);
    return { data: compressed, mimeType: "image/jpeg", filename: "wechat.jpg" };
  }
  return compressed;
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

// 会话订阅中的回复不一定带 parent_message_id，不能按请求关联过滤。
class SessionReplies {
  private pending = new Map<string, string>();
  private sent = new Set<string>();

  resetStream() {
    this.pending.clear();
  }

  take(event: ChatEvent): string | undefined {
    const p = event.payload;
    const id = p.message_id ?? event.raw.message_id ?? p.id;
    if (typeof id !== "string" || !id || this.sent.has(id) || p.role === "user") return;
    if (typeof p.event_name === "string" && p.event_name !== "message.assistant") return;
    if (event.event === "delta.text_append" && typeof p.text === "string") {
      this.pending.set(id, (this.pending.get(id) ?? "") + p.text);
      return;
    }
    if (event.event !== "delta.message_done" && event.event !== "message.assistant") return;
    if (p.display_text_ready === false) return;
    const text = (typeof p.display_text === "string" ? p.display_text : "")
      || transcriptText(p.transcript, id)
      || (typeof p.content === "string" ? p.content : "")
      || this.pending.get(id) || "";
    this.pending.delete(id);
    if (!text.trim()) return;
    this.sent.add(id);
    if (this.sent.size > 2000) this.sent.delete(this.sent.values().next().value!);
    return text;
  }
}

interface RenderedReply {
  text: string;
  options: string[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const textValue = (value: unknown) => typeof value === "string" ? value.trim() : "";

function webUrl(value: unknown): string | undefined {
  const candidate = textValue(value);
  if (!/^https?:\/\//i.test(candidate) || /\s/.test(candidate)) return;
  try {
    new URL(candidate);
    return candidate;
  } catch { return; }
}

// 卡片是独立的 presentation 事件；未知类型提示去 Muse 查看，不静默丢弃。
class PresentationReplies {
  private sent = new Set<string>();

  take(event: ChatEvent): string | undefined {
    if (event.event !== "delta.presentation" || event.payload.role === "user") return;
    const p = event.payload;
    const id = textValue(p.id) || textValue(p.message_id);
    if (!id || this.sent.has(id)) return;

    const data = record(p.data);
    const file = record(data?.file);
    const url = p.kind === "external_link"
      ? webUrl(data?.url) || webUrl(p.fallback_text) || webUrl(data?.fallback_text)
      : p.kind === "file"
        ? webUrl(record(file?.variants)?.original) || webUrl(file?.path)
        : undefined;
    const label = textValue(p.display_text) || textValue(file?.label);
    const contentType = p.kind === "file" ? "文件" : p.kind === "external_link" ? "链接" : "内容";
    const reply = url
      ? (label && label !== url ? `${label}\n${url}` : url)
      : `${label ? `${label}\n` : ""}【此${contentType}请在 Muse App 中查看】`;

    this.sent.add(id);
    if (this.sent.size > 2000) this.sent.delete(this.sent.values().next().value!);
    return reply;
  }
}

// 按实际事件中的 kind=option / data.options 解析；不推测原生按钮提交协议。
class OptionWidgets {
  private widgets = new Map<string, string[]>();
  private selection: string[] = [];

  observe(event: ChatEvent) {
    if (!Array.isArray(event.payload.widgets)) return;
    for (const value of event.payload.widgets) {
      const widget = record(value);
      if (widget?.kind !== "option" || typeof widget.widget_id !== "string") continue;
      const options = record(widget.data)?.options;
      if (!Array.isArray(options) || !options.length || options.length > 100
        || !options.every((option): option is string => typeof option === "string" && !!option.trim())) continue;
      this.widgets.set(widget.widget_id, [...options]);
      if (this.widgets.size > 256) this.widgets.delete(this.widgets.keys().next().value!);
    }
  }

  render(text: string): RenderedReply {
    const options: string[] = [];
    const rendered = new Map<string, string>();
    const result = text.replace(/\[\[hatch_widget:([^\]\s]+)\]\]/g, (_, id: string) => {
      if (rendered.has(id)) return rendered.get(id)!;
      const choices = this.widgets.get(id);
      if (!choices) return "【此交互内容请在 Muse App 中查看】";
      const list = choices.map((choice) => {
        options.push(choice);
        return `${optionMark(options.length)} ${choice.replace(/\s*\n\s*/g, " ")}`;
      }).join("\n");
      rendered.set(id, list);
      return list;
    });
    return {
      text: result,
      options,
    };
  }

  // 完整发送到微信后才启用，避免用户选择尚未成功送达的选项。
  activate(reply: RenderedReply) {
    this.selection = [...reply.options];
  }

  clearSelection() {
    this.selection = [];
  }

  resolve(text: string): { text: string } | { error: string } {
    const input = text.trim();
    const number = this.selection.length ? optionNumber(input) : undefined;
    if (number !== undefined) {
      const choice = this.selection[number - 1];
      if (choice === undefined) return { error: `请回复 1–${this.selection.length} 选择，或直接输入文字。` };
      this.clearSelection();
      return { text: choice };
    }
    // 输入自由文本或消费一次选择后，不再将之后的普通数字当作旧选项。
    this.clearSelection();
    return { text };
  }

  reset() {
    this.widgets.clear();
    this.clearSelection();
  }
}

async function run() {
  let eventLog: string | undefined;
  if (process.env.MUSE_DEBUG === "1") {
    const dir = join(import.meta.dir, "logs");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    eventLog = join(dir, `muse-events-${Date.now()}-${process.pid}.jsonl`);
    await writeFile(eventLog, "", { flag: "wx", mode: 0o600 });
    console.log(`Muse 原始事件日志：${eventLog}`);
  }
  let client: MuseClient | undefined;
  let subscription: Awaited<ReturnType<MuseClient["subscribe"]>> | undefined;
  const replies = new SessionReplies();
  const presentations = new PresentationReplies();
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
      const media = request.media;
      if (media && media.type !== "image") return { text: "Muse 暂只支持文字和图片，请将其他附件转成文字后发送。" };
      if (!media && !text) return { text: "请发送文字或图片。" };
      if (wechatId && wechatId !== request.conversationId)
        return { text: "此桥接仅支持一个微信会话。" };
      wechatId = request.conversationId;
      if (!media && text === "/help") return { text:
        "直接发送文字或图片即可和 Muse 对话，可附带说明；过大的图片会自动压缩。选项列表可回复数字选择，会发送对应选项文字。收到消息后，同步所选 Muse 会话中的全部新回复（包括其他客户端触发的回复）。重启会保留 Muse 的会话上下文。" };
      if (shutdown.signal.aborted) return {};
      const c = client;
      if (!c) return { text: "Muse 正在重新连接，消息尚未发送，请稍后再试。" };
      let message = text;
      let images: ImageAttachment[] | undefined;
      if (media) {
        const image = await loadWechatImage(media.filePath);
        if ("error" in image) return { text: image.error };
        images = [image];
      } else {
        const input = widgets.resolve(request.text);
        if ("error" in input) return { text: input.error };
        message = input.text;
      }
      active = true; // 回复可能先于发送确认到达。
      try {
        await c.sendMessage(message, { images, sessionId, signal: shutdown.signal });
        return {}; // 回复由长驻订阅独立转发，不等待请求关联或整轮完成。
      } catch (error) {
        if (shutdown.signal.aborted) return {};
        console.error("Muse 消息发送失败：", errorMessage(error));
        if (error instanceof MuseError && error.message.includes("too large"))
          return { text: "图片压缩后仍然超过 Muse 的大小限制，这次没有发出去。" };
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
          // 在任何正文/卡片过滤之前记录完整事件，包含 payload 和 raw。
          if (eventLog) {
            try {
              await appendFile(eventLog, JSON.stringify({ receivedAt: new Date().toISOString(), event }) + "\n");
            } catch (error) {
              console.error("Muse 事件日志写入失败，已停止记录：", errorMessage(error));
              eventLog = undefined;
            }
          }
          widgets.observe(event);
          const text = presentations.take(event) ?? replies.take(event);
          if (!text || !active) continue;
          const isPresentation = event.event === "delta.presentation";
          const reply = isPresentation ? { text, options: [] } : widgets.render(text);
          // 独立链接卡片不覆盖正文中的选项，用户仍可回复数字选择。
          if (!isPresentation) widgets.clearSelection();
          try {
            for (const part of chunks(reply.text)) {
              if (shutdown.signal.aborted) return;
              await bot.sendMessage(part);
            }
            if (!shutdown.signal.aborted && !isPresentation) widgets.activate(reply);
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
