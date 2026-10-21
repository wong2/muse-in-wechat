import type { ChatEvent } from "muse-client";

export interface RenderedReply {
  text: string;
  options: string[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

// 按实际事件中的 kind=option / data.options 解析；不推测原生按钮提交协议。
export class OptionWidgets {
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
        return `${options.length}. ${choice.replace(/\s*\n\s*/g, " ")}`;
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
    if (this.selection.length && /^\d+$/.test(input)) {
      const choice = this.selection[Number(input) - 1];
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
