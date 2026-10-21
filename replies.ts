import { type ChatEvent, transcriptText } from "muse-client";

// 会话订阅中的回复不一定带 parent_message_id，不能按请求关联过滤。
export class SessionReplies {
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
