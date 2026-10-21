type StartupOptions = {
  loadMuseCredentials: () => Promise<unknown>;
  pairMuse: () => Promise<void>;
  isWechatBound: () => boolean;
  bindWechat: () => Promise<unknown>;
  run: () => Promise<void>;
  signal: AbortSignal;
  log: (message: string) => void;
};

/** Complete each binding before moving on; never replace unreadable credentials. */
export async function startWithBindings(options: StartupOptions) {
  const { signal, log } = options;
  signal.throwIfAborted();
  let museBound = false;
  try {
    await options.loadMuseCredentials();
    museBound = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  signal.throwIfAborted();
  if (museBound) {
    log("Muse：已绑定。");
  } else {
    log("Muse：未绑定，开始配对。");
    await options.pairMuse();
    signal.throwIfAborted();
    await options.loadMuseCredentials();
    log("Muse：绑定成功。");
  }

  signal.throwIfAborted();
  if (options.isWechatBound()) {
    log("微信：已绑定。");
  } else {
    log("微信：未绑定，请扫描接下来显示的二维码。");
    await options.bindWechat();
    signal.throwIfAborted();
    if (!options.isWechatBound()) throw new Error("微信绑定未完成，请重新运行 bun start。");
    log("微信：绑定成功。");
  }
  signal.throwIfAborted();
  log("正在启动 Muse 微信桥接…");
  await options.run();
}
