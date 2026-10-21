import { expect, mock, test } from "bun:test";
import { MuseClient, transcriptText, type ChatEvent, type SendOptions } from "muse-client";
import type { Agent } from "weixin-agent-sdk";
import { SessionReplies } from "./replies";

const event = (name: string, payload: Record<string, unknown>): ChatEvent =>
  ({ type: "event", event: name, payload, raw: {} });
const reply = (id: string, text: string) => event("message.assistant", {
  message_id: id, display_text: text, display_text_ready: true,
});

// Exercise the real SDK, rather than mocking its already-filtered chat output.
test("SDK chat filters parentless replies, while session forwarding accepts them", async () => {
  const incoming = reply("assistant-1", "reply arrived");
  const transport = {
    async subscribe({ signal }: { signal: AbortSignal }) {
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          yield incoming;
          if (!signal.aborted) await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      };
    },
    async sendMessage() { return { messageId: "user-1", raw: {} }; },
  };
  const received = [];
  let failure: unknown;
  try {
    for await (const update of MuseClient.prototype.chat.call(
      transport as unknown as MuseClient, "hello", { timeoutMs: 50 },
    )) received.push(update);
  } catch (error) { failure = error; }
  expect(received).toEqual([]);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Muse reply timed out");
  expect(new SessionReplies().take(incoming)).toBe("reply arrived");
});

test("session replies handle deltas, final snapshots, transcripts and replays", () => {
  const replies = new SessionReplies();
  expect(replies.take(event("delta.text_append", { message_id: "a", text: "partial" }))).toBeUndefined();
  expect(replies.take(reply("a", "final snapshot"))).toBe("final snapshot");
  replies.resetStream();
  expect(replies.take(reply("a", "duplicate"))).toBeUndefined();
  replies.take(event("delta.text_append", { message_id: "b", text: "hello " }));
  replies.take(event("delta.text_append", { message_id: "b", text: "world" }));
  expect(replies.take(event("delta.message_done", { message_id: "b" }))).toBe("hello world");
  expect(replies.take(event("message.assistant", { message_id: "c", transcript: {
    messages: [
      { id: "user", role: "user", content: [{ type: "text", text: "private input" }] },
      { id: "c", role: "assistant", content: [{ type: "text", text: "transcript reply" }] },
    ],
  } }))).toBe("transcript reply");
  expect(replies.take(event("message.assistant", { message_id: "d", display_text: "draft", display_text_ready: false }))).toBeUndefined();
  expect(replies.take(reply("d", "ready"))).toBe("ready");
  expect(replies.take(event("delta.message_done", { message_id: "user", role: "user", content: "input" }))).toBeUndefined();
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for bridge");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("bridge subscribes before sending, forwards unlinked replies, and reconnects without resending", async () => {
  let agent!: Agent;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  let nextEvents: ChatEvent[] = [];
  let sendError = false;
  let wechatError = false;
  let wechatFailures = 0;
  const sent: string[] = [];
  const calls: string[] = [];
  const streams: ReadableStreamDefaultController<ChatEvent>[] = [];
  const clients: { close: ReturnType<typeof mock> }[] = [];
  const requests: { text: string; options: SendOptions }[] = [];
  mock.module("muse-client", () => ({
    transcriptText,
    MuseClient: {
      async connect() {
        let controller!: ReadableStreamDefaultController<ChatEvent>;
        const stream = new ReadableStream<ChatEvent>({ start(value) { controller = value; } });
        const client = {
          close: mock(() => {}),
          async subscribe() {
            calls.push("subscribe");
            streams.push(controller);
            return {
              [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
              close() { try { controller.close(); } catch {} },
            };
          },
          async sendMessage(text: string, options: SendOptions) {
            calls.push("send");
            requests.push({ text, options });
            for (const incoming of nextEvents) controller.enqueue(incoming);
            if (sendError) throw new Error("acknowledgement failed");
            return { messageId: `user-${requests.length}`, raw: {} };
          },
        };
        clients.push(client);
        return client;
      },
    },
  }));
  mock.module("muse-client/credentials", () => ({
    loadCredentials: async () => ({}), saveCredentials: async () => {},
    defaultCredentialsDirectory: () => "/unused",
  }));
  mock.module("weixin-agent-sdk", () => ({
    isLoggedIn: () => true, login: async () => {},
    start(value: Agent) {
      agent = value;
      return { wait: () => stopped, async sendMessage(text: string) {
        if (wechatError) {
          wechatFailures++;
          throw new Error("WeChat unavailable");
        }
        sent.push(text);
      } };
    },
  }));

  const previousCommand = process.argv[2];
  process.argv[2] = "start";
  const running = import("./index");
  try {
    await until(() => !!agent);
    streams[0]!.enqueue(reply("before", "before first WeChat message"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([]);
    const chat = (text = "Hello") => agent.chat({ text, conversationId: "wechat-user" });
    nextEvents = [reply("one", "final snapshot"), reply("one", "duplicate"), reply("two", "🙂".repeat(2001))];
    expect(await chat()).toEqual({});
    await until(() => sent.length === 3);
    expect(calls).toEqual(["subscribe", "send"]);
    expect(sent).toEqual(["final snapshot", "🙂".repeat(2000), "🙂"]);
    expect(requests[0]!.options.signal).toBeInstanceOf(AbortSignal);

    // A later reply must still arrive after the send acknowledgement completes.
    streams[0]!.enqueue(reply("later", "late reply"));
    await until(() => sent.length === 4);
    streams[0]!.error(new Error("disconnected"));
    await until(() => streams.length === 2);
    expect(requests).toHaveLength(1);
    streams[1]!.enqueue(reply("one", "replayed after reconnect"));
    streams[1]!.enqueue(reply("new", "after reconnect"));
    await until(() => sent.length === 5);
    expect(sent.at(-1)).toBe("after reconnect");

    nextEvents = [];
    sendError = true;
    expect((await chat()).text).toContain("没有自动重发");
    expect(requests).toHaveLength(2);
    expect((await chat("/help")).text).toContain("全部新回复");
    expect((await chat(" ")).text).toContain("请发送文字");
    expect((await agent.chat({ text: "hello", conversationId: "other" })).text).toContain("仅支持一个微信会话");
    expect(() => agent.clearSession?.("wechat-user")).toThrow("不支持清除会话");

    sendError = false;
    // 选项元数据只出现在增量事件时，也必须保留到最终 transcript 渲染。
    const marker = "[[hatch_widget:widget-example]]";
    streams[1]!.enqueue(event("delta.text_append", {
      message_id: "options-message", text: marker,
      widgets: [{
        widget_id: "widget-example", kind: "option",
        data: { button_style: "dotted_lines", options: ["短版", "大白话", "改重点"] },
        state: { data: {}, version: 0 },
      }],
    }));
    streams[1]!.enqueue(event("delta.message_done", {
      message_id: "options-message",
      transcript: { messages: [{
        id: "options-message", role: "assistant",
        content: [{ type: "text", text: `请选择：\n${marker}` }],
      }] },
      widgets: [],
    }));
    await until(() => sent.length === 6);
    expect(sent.at(-1)).toContain("1. 短版\n2. 大白话\n3. 改重点");
    expect(sent.at(-1)).not.toContain("hatch_widget");
    expect((await chat("9")).text).toContain("1–3");
    expect(requests).toHaveLength(2); // 无效选择不发送。
    expect(await chat("2")).toEqual({});
    expect(requests.at(-1)!.text).toBe("大白话");
    expect(await chat("2")).toEqual({});
    expect(requests.at(-1)!.text).toBe("2"); // 已消费的列表不再劫持普通数字。

    wechatError = true;
    streams[1]!.enqueue(reply("failed-options-message", marker));
    await until(() => wechatFailures === 1);
    wechatError = false;
    expect(await chat("1")).toEqual({});
    expect(requests.at(-1)!.text).toBe("1"); // 未送达的选项不启用。
  } finally {
    stop();
    await running;
    if (previousCommand === undefined) delete process.argv[2];
    else process.argv[2] = previousCommand;
  }
  for (const client of clients) expect(client.close).toHaveBeenCalledTimes(1);
});
