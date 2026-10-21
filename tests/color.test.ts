import { test } from "node:test";
import assert from "node:assert/strict";
import { blendHex } from "../shared/color.ts";

test("blendHex 按 weight 线性混合两个 #RRGGBB 颜色", () => {
  // 黑白各半 → 中灰
  assert.equal(blendHex("#000000", "#ffffff", 0.5), "#808080");
  // weight=0 → 纯 base;weight=1 → 纯 overlay
  assert.equal(blendHex("#112233", "#aabbcc", 0), "#112233");
  assert.equal(blendHex("#112233", "#aabbcc", 1), "#aabbcc");
  // 通道级四舍五入:surface1 上叠 12% accent 的具体值
  assert.equal(blendHex("#1e1e22", "#a78bfa", 0.12), "#2e2b3c");
});

test("blendHex 越界 weight 截断到 0~1", () => {
  assert.equal(blendHex("#336699", "#ff0000", -2), "#336699");
  assert.equal(blendHex("#336699", "#ff0000", 3), "#ff0000");
  assert.equal(blendHex("#336699", "#ff0000", Number.NaN), "#336699");
});

test("blendHex 输入非 #RRGGBB 时原样返回 base(不产出非法样式值)", () => {
  assert.equal(blendHex("rgb(1,2,3)", "#ffffff", 0.5), "rgb(1,2,3)");
  assert.equal(blendHex("#fff", "#ffffff", 0.5), "#fff");
  assert.equal(blendHex("#112233", "rgba(0,0,0,0.5)", 0.5), "#112233");
  assert.equal(blendHex("", "", 0.5), "");
});
