import { expect, test } from "bun:test";
import { startWithBindings } from "./startup";

function fixture(museBound: boolean, wechatBound: boolean) {
  const calls: string[] = [];
  const messages: string[] = [];
  const controller = new AbortController();
  const options = {
    async loadMuseCredentials() {
      if (!museBound) throw Object.assign(new Error("Missing credentials"), { code: "ENOENT" });
      return {};
    },
    async pairMuse() { calls.push("muse"); museBound = true; },
    isWechatBound: () => wechatBound,
    async bindWechat() { calls.push("wechat"); wechatBound = true; },
    async run() { calls.push("run"); },
    signal: controller.signal,
    log: (message: string) => { messages.push(message); },
  };
  return { calls, messages, controller, options };
}

test.each([
  [false, false, ["muse", "wechat", "run"]],
  [true, false, ["wechat", "run"]],
  [false, true, ["muse", "run"]],
  [true, true, ["run"]],
] as const)("startup completes missing bindings (Muse=%s, WeChat=%s)", async (muse, wechat, expected) => {
  const { options, calls, messages } = fixture(muse, wechat);
  options.run = async () => {
    expect(messages).toEqual([
      ...(muse ? ["Muse：已绑定。"] : ["Muse：未绑定，开始配对。", "Muse：绑定成功。"]),
      ...(wechat ? ["微信：已绑定。"] : ["微信：未绑定，请扫描接下来显示的二维码。", "微信：绑定成功。"]),
      "正在启动 Muse 微信桥接…",
    ]);
    calls.push("run");
  };
  await startWithBindings(options);
  expect(calls).toEqual([...expected]);
});

test.each(["EACCES", "invalid JSON"])("unreadable Muse credentials stop startup: %s", async (code) => {
  const { options, calls } = fixture(false, false);
  const failure = Object.assign(new Error("Cannot read credentials"), { code });
  options.loadMuseCredentials = async () => { throw failure; };
  await expect(startWithBindings(options)).rejects.toBe(failure);
  expect(calls).toEqual([]);
});

test.each(["muse", "wechat"])("failed %s binding prevents subsequent steps", async (stage) => {
  const { options, calls } = fixture(false, false);
  const fail = async () => { throw new Error("Binding failed"); };
  if (stage === "muse") options.pairMuse = fail;
  else options.bindWechat = fail;
  await expect(startWithBindings(options)).rejects.toThrow("Binding failed");
  expect(calls).toEqual(stage === "muse" ? [] : ["muse"]);
});

test.each(["muse", "wechat"])("binding must persist %s credentials before starting", async (stage) => {
  const { options, calls } = fixture(false, false);
  if (stage === "muse") options.pairMuse = async () => {};
  else options.bindWechat = async () => {};
  await expect(startWithBindings(options)).rejects.toThrow();
  expect(calls).not.toContain("run");
  if (stage === "muse") expect(calls).not.toContain("wechat");
});

test.each(["before", "muse", "wechat"])("cancellation during %s prevents startup", async (stage) => {
  const { options, calls, controller } = fixture(false, false);
  if (stage === "before") controller.abort();
  else if (stage === "muse") options.pairMuse = async () => { controller.abort(); };
  else options.bindWechat = async () => { controller.abort(); };
  await expect(startWithBindings(options)).rejects.toThrow();
  expect(calls).not.toContain("run");
  expect(calls).not.toContain("wechat");
});
