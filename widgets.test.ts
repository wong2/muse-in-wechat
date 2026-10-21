import { expect, test } from "bun:test";
import type { ChatEvent } from "muse-client";
import { OptionWidgets } from "./widgets";

// 与抓取到的 option widget 结构一致；不包含账户信息或聊天日志。
const options = ["太长太绕，删减成短版", "太像法律文书，改成大白话", "重点不对，我来说要改哪"];
const incoming = (id = "widget-example", choices: unknown = options): ChatEvent => ({
  type: "event", event: "delta.text_append", raw: {},
  payload: {
    message_id: "assistant-example",
    text: `[[hatch_widget:${id}]]`,
    widgets: [{
      widget_id: id, kind: "option",
      data: { button_style: "dotted_lines", options: choices },
      display_text: options.join(" / "),
      state: { data: {}, version: 0 },
    }],
  },
});

test("renders observed button data and maps a delivered selection to its exact text once", () => {
  const widgets = new OptionWidgets();
  widgets.observe(incoming());
  const rendered = widgets.render("点这里选：\n\n[[hatch_widget:widget-example]]");
  expect(rendered.text).toBe(`点这里选：\n\n${options.map((text, i) => `${i + 1}. ${text}`).join("\n")}`);
  expect(widgets.resolve("2")).toEqual({ text: "2" }); // 尚未送达。
  widgets.activate(rendered);
  expect(widgets.resolve("0")).toHaveProperty("error");
  expect(widgets.resolve("4")).toHaveProperty("error");
  expect(widgets.resolve(" 2 ")).toEqual({ text: options[1] });
  expect(widgets.resolve("2")).toEqual({ text: "2" });
});

test("free text, subsequent ordinary replies and reconnects discard old selections", () => {
  const widgets = new OptionWidgets();
  widgets.observe(incoming());
  const rendered = widgets.render("[[hatch_widget:widget-example]]");
  widgets.activate(rendered);
  expect(widgets.resolve("我有别的意见")).toEqual({ text: "我有别的意见" });
  expect(widgets.resolve("1")).toEqual({ text: "1" });
  widgets.activate(rendered);
  widgets.activate(widgets.render("普通回复"));
  expect(widgets.resolve("1")).toEqual({ text: "1" });
  widgets.activate(rendered);
  widgets.reset();
  expect(widgets.resolve("1")).toEqual({ text: "1" });
});

test("unknown or malformed widgets fall back without guessing choices from display text", () => {
  const widgets = new OptionWidgets();
  widgets.observe(incoming("malformed", [{ label: "not the observed protocol" }]));
  const rendered = widgets.render("请选择：[[hatch_widget:missing]] [[hatch_widget:malformed]]");
  expect(rendered.options).toEqual([]);
  expect(rendered.text).not.toContain("hatch_widget");
  expect(rendered.text).toContain("Muse App");
});

test("multiple widgets use consistent numbering and repeated markers reuse those numbers", () => {
  const widgets = new OptionWidgets();
  widgets.observe(incoming("one", ["A", "B"]));
  widgets.observe(incoming("two", ["C"]));
  const rendered = widgets.render("[[hatch_widget:one]]\n[[hatch_widget:two]]\n[[hatch_widget:one]]");
  expect(rendered.options).toEqual(["A", "B", "C"]);
  expect(rendered.text).toContain("3. C");
  expect(rendered.text).not.toContain("4.");
  widgets.activate(rendered);
  expect(widgets.resolve("3")).toEqual({ text: "C" });
});
