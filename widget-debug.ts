import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatEvent } from "muse-client";

// 只用于确认真实协议结构，不从 widget ID 猜测按钮内容或提交方式。
export function createWidgetRecorder(enabled: boolean, directory = "logs") {
  let file: string | undefined;
  let bytes = 0;
  return (event: ChatEvent) => {
    if (!enabled) return;
    try {
      // 普通文本事件也带 widgets: []；空数组不应触发整段聊天的记录。
      const serialized = JSON.stringify(event, (key, value) =>
        key === "widgets" && Array.isArray(value) && value.length === 0 ? undefined : value);
      if (!/widget/i.test(serialized)) return;
      const line = JSON.stringify({ receivedAt: new Date().toISOString(), event }) + "\n";
      const size = Buffer.byteLength(line);
      if (bytes + size > 8 * 1024 * 1024) {
        enabled = false;
        console.warn("Widget 诊断已达到 8 MiB 上限，停止记录。");
        return;
      }
      if (!file) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = resolve(directory, `muse-widgets-${Date.now()}-${process.pid}.jsonl`);
        writeFileSync(path, line, { flag: "wx", mode: 0o600 });
        file = path;
        console.log(`Widget 事件已记录到 ${file}（包含相关消息内容，仅用于本地诊断）。`);
      } else {
        appendFileSync(file, line);
      }
      bytes += size;
    } catch {
      enabled = false;
      console.warn("Widget 诊断写入失败，已停止记录；聊天继续。");
    }
  };
}
