import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignExitOffsets,
  buildEdgeCurve,
  buildFlowInterpolation,
  buildSegmentViews,
  cubicBezierPoint,
  pointAtLength,
  type Point,
} from "../shared/edge-geometry";

const FROM: Point = { x: 100, y: 92 };
const TO: Point = { x: 180, y: 150 };

function strictlyIncreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i]! > values[i - 1]!)) return false;
  }
  return true;
}

function allFinite(values: number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

test("assignExitOffsets:单 child 居中", () => {
  assert.deepEqual(assignExitOffsets(196, 1, 24), [98]);
});

test("assignExitOffsets:多 child 唯一、递增、稳定且在边距范围内", () => {
  const offsets = assignExitOffsets(196, 4, 24);
  assert.equal(offsets.length, 4);
  assert.ok(strictlyIncreasing(offsets));
  assert.ok(offsets.every((o) => o >= 24 && o <= 196 - 24));
  // 唯一性
  assert.equal(new Set(offsets).size, 4);
  // 稳定性:重复调用结果一致
  assert.deepEqual(assignExitOffsets(196, 4, 24), offsets);
  // 边距留出后均匀分布:首点等于边距,末点等于宽-边距
  assert.equal(offsets[0], 24);
  assert.equal(offsets[3], 172);
});

test("assignExitOffsets:边界输入(childCount=0 / 宽度非法 / 边距过宽收缩)", () => {
  assert.deepEqual(assignExitOffsets(196, 0, 24), []);
  assert.deepEqual(assignExitOffsets(0, 3, 24), []);
  assert.deepEqual(assignExitOffsets(-5, 2, 24), []);
  assert.deepEqual(assignExitOffsets(NaN, 2, 24), []);
  // 卡片窄到边距放不下:边距收缩,区间仍非空且点唯一
  const narrow = assignExitOffsets(10, 2, 24);
  assert.equal(narrow.length, 2);
  assert.ok(strictlyIncreasing(narrow));
  assert.ok(narrow.every((o) => o >= 0 && o <= 10));
});

test("buildEdgeCurve:采样覆盖两端且累计弧长严格递增", () => {
  const curve = buildEdgeCurve(FROM, TO);
  assert.equal(curve.points.length, curve.cumulative.length);
  const first = curve.points[0]!;
  const last = curve.points[curve.points.length - 1]!;
  assert.ok(Math.hypot(first.x - FROM.x, first.y - FROM.y) < 1e-6);
  assert.ok(Math.hypot(last.x - TO.x, last.y - TO.y) < 1e-6);
  assert.ok(strictlyIncreasing(curve.cumulative));
  assert.ok(curve.total > 0);
});

test("buildEdgeCurve:退化路径(重合点/子在上/水平重合)无 NaN", () => {
  for (const to of [FROM, { x: 100, y: 40 }, { x: 300, y: 92 }, { x: 100, y: 92.01 }]) {
    const curve = buildEdgeCurve(FROM, to);
    assert.ok(allFinite(curve.points.flatMap((p) => [p.x, p.y])));
    assert.ok(allFinite(curve.cumulative));
    assert.ok(strictlyIncreasing(curve.cumulative));
    assert.ok(Number.isFinite(curve.total));
    // 流点插值表合法(inputRange 严格递增,长度一致)
    const flow = buildFlowInterpolation(curve, 5);
    assert.equal(flow.inputRange.length, flow.outputX.length);
    assert.equal(flow.inputRange.length, flow.outputY.length);
    assert.ok(strictlyIncreasing(flow.inputRange));
  }
});

test("cubicBezierPoint:t=0 与 t=1 精确命中端点", () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 10, y: 40 };
  const p2 = { x: 60, y: 40 };
  const p3 = { x: 50, y: 90 };
  const start = cubicBezierPoint(p0, p1, p2, p3, 0);
  const end = cubicBezierPoint(p0, p1, p2, p3, 1);
  assert.deepEqual(start, p0);
  assert.deepEqual(end, p3);
});

test("pointAtLength:端点命中、单调插值与越界 clamp", () => {
  const curve = buildEdgeCurve(FROM, TO);
  const atZero = pointAtLength(curve, 0);
  const atEnd = pointAtLength(curve, curve.total);
  assert.ok(Math.hypot(atZero.x - FROM.x, atZero.y - FROM.y) < 1e-6);
  assert.ok(Math.hypot(atEnd.x - TO.x, atEnd.y - TO.y) < 1e-6);
  // 弧长单调 → 点坐标随 s 单调(这里 to 在右下方,单调增)
  const a = pointAtLength(curve, curve.total * 0.25);
  const b = pointAtLength(curve, curve.total * 0.5);
  const c = pointAtLength(curve, curve.total * 0.75);
  assert.ok(a.x <= b.x && b.x <= c.x);
  assert.ok(a.y <= b.y && b.y <= c.y);
  // 越界 clamp:不产生 NaN,不越出端点
  const before = pointAtLength(curve, -100);
  const after = pointAtLength(curve, curve.total + 100);
  assert.ok(Math.hypot(before.x - FROM.x, before.y - FROM.y) < 1e-6);
  assert.ok(Math.hypot(after.x - TO.x, after.y - TO.y) < 1e-6);
});

test("pointAtLength:退化路径(重合点)返回合法点不 NaN", () => {
  const curve = buildEdgeCurve(FROM, FROM);
  const p = pointAtLength(curve, curve.total / 2);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test("buildSegmentViews:首尾段贴合端点,角度有限,零长段被跳过", () => {
  const curve = buildEdgeCurve(FROM, TO);
  const views = buildSegmentViews(curve, 2);
  assert.ok(views.length >= 8); // 采样段数下限 8
  const first = views[0]!;
  const last = views[views.length - 1]!;
  // 用角度+长度重建首段弦起点/末段弦终点,应精确命中曲线两端
  const firstDir = {
    x: Math.cos((first.rotateDeg * Math.PI) / 180),
    y: Math.sin((first.rotateDeg * Math.PI) / 180),
  };
  const lastDir = {
    x: Math.cos((last.rotateDeg * Math.PI) / 180),
    y: Math.sin((last.rotateDeg * Math.PI) / 180),
  };
  const firstStart = {
    x: first.left + first.width / 2 - (firstDir.x * (first.width - 2)) / 2,
    y: first.top + first.height / 2 - (firstDir.y * (first.width - 2)) / 2,
  };
  const lastEnd = {
    x: last.left + last.width / 2 + (lastDir.x * (last.width - 2)) / 2,
    y: last.top + last.height / 2 + (lastDir.y * (last.width - 2)) / 2,
  };
  assert.ok(Math.hypot(firstStart.x - FROM.x, firstStart.y - FROM.y) < 1e-6);
  assert.ok(Math.hypot(lastEnd.x - TO.x, lastEnd.y - TO.y) < 1e-6);
  assert.ok(views.every((v) => Number.isFinite(v.rotateDeg)));
  assert.ok(views.every((v) => v.width > 0 && v.height > 0));
  // 重合点曲线:所有采样段长为 0 → 全部跳过
  const degenerate = buildEdgeCurve(FROM, FROM);
  assert.deepEqual(buildSegmentViews(degenerate, 2), []);
});

test("流点插值表覆盖 [0, total]:首尾对应 from/to 偏移", () => {
  const curve = buildEdgeCurve(FROM, TO);
  const flow = buildFlowInterpolation(curve, 5);
  assert.equal(flow.inputRange[0], 0);
  assert.ok(Math.abs(flow.inputRange[flow.inputRange.length - 1]! - curve.total) < 1e-6);
  // 输出首尾为端点坐标减去半径
  assert.equal(flow.outputX[0], FROM.x - 2.5);
  assert.equal(flow.outputY[0], FROM.y - 2.5);
  const last = flow.outputX.length - 1;
  assert.equal(flow.outputX[last], TO.x - 2.5);
  assert.equal(flow.outputY[last], TO.y - 2.5);
});
