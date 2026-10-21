import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanStreamText,
  formatElapsed,
  formatTokensPerSecond,
  progressLineOf,
  toolProgressText,
} from "../shared/progress-line.ts";

test("cleanStreamText:剥 ANSI 转义与 bidi 控制符", () => {
  assert.equal(cleanStreamText("\u001B[31m错误\u001B[0m"), "错误");
  assert.equal(cleanStreamText("\u202Ereversed\u202C文本"), "reversed文本");
  assert.equal(cleanStreamText("正常文本"), "正常文本");
});

test("toolProgressText:按 detail 类型合成 [标签] 摘要,未知形态回落 [工具名]", () => {
  assert.equal(toolProgressText("Bash", { type: "shell", command: "npm run build\nexit 0" }), "[bash] npm run build");
  assert.equal(toolProgressText("Read", { type: "read", filePath: "/a/b/c.ts" }), "[read] c.ts");
  assert.equal(toolProgressText("Edit", { type: "edit", filePath: "C:\\x\\y.py" }), "[edit] y.py");
  assert.equal(toolProgressText("Write", { type: "write", filePath: "/d.md" }), "[write] d.md");
  assert.equal(toolProgressText("Grep", { type: "search", query: "todo" }), "[Grep] todo");
  assert.equal(toolProgressText("Fetch", { type: "fetch", url: "https://example.com/x" }), "[Fetch] https://example.com/x");
  assert.equal(toolProgressText("Task", { type: "sub_agent", description: "探索目录" }), "[Task] 探索目录");
  assert.equal(toolProgressText("Task", { type: "sub_agent", subAgentType: "Explore" }), "[Task] Explore");
  assert.equal(toolProgressText("Note", { type: "plain_text", label: "备注" }), "[Note] 备注");
  assert.equal(toolProgressText("Plan", { type: "plan", text: "第一行\n第二行" }), "[Plan] 第一行");
  assert.equal(toolProgressText("Bash", { type: "shell", command: "" }), "[bash]");
  assert.equal(toolProgressText("Mystery", { type: "mystery", x: 1 }), "[Mystery]");
  assert.equal(toolProgressText("Mystery", null), "[Mystery]");
});

test("progressLineOf:最新条目优先,tool/assistant/error 之外跳过", () => {
  const items = [
    { kind: "user" as const, text: "帮我跑测试" },
    { kind: "assistant" as const, text: "好的,先跑单测" },
    { kind: "tool" as const, text: "Bash", meta: "running", toolDetail: { type: "shell", command: "npm test" } },
  ];
  assert.equal(progressLineOf(items), "[bash] npm test");
  // 最新是 assistant:取首行
  assert.equal(
    progressLineOf([...items, { kind: "assistant" as const, text: "\n结论如下\n第二行" }]),
    "结论如下",
  );
  // error 也算活动
  assert.equal(
    progressLineOf([{ kind: "error" as const, text: "\u001B[31mboom\u001B[0m" }]),
    "boom",
  );
  // 只有 user/notice → null
  assert.equal(progressLineOf([{ kind: "user" as const, text: "hi" }]), null);
  assert.equal(progressLineOf([]), null);
});

test("progressLineOf:超长截断,清洗控制符", () => {
  const long = "x".repeat(200);
  const line = progressLineOf([{ kind: "assistant" as const, text: long }]);
  assert.equal(line!.length, 120);
  assert.ok(line!.endsWith("…"));
  const injected = progressLineOf([
    { kind: "assistant" as const, text: "\u202Eabc\u2066def" },
  ]);
  assert.equal(injected, "abcdef");
});

test("formatElapsed:秒/分/时三档", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(42_000), "42s");
  assert.equal(formatElapsed(754_000), "12m 34s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(formatElapsed(Number.NaN), "0s");
});

test("formatTokensPerSecond:≥10 取整,否则 1 位小数;非有限/非正不显示", () => {
  assert.equal(formatTokensPerSecond(84.96), "85 tok/s");
  assert.equal(formatTokensPerSecond(9.54), "9.5 tok/s");
  assert.equal(formatTokensPerSecond(0), null);
  assert.equal(formatTokensPerSecond(null), null);
  assert.equal(formatTokensPerSecond(Number.NaN), null);
});
