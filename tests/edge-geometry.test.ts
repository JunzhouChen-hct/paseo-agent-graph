import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignExitOffsets,
  buildEdgeCurve,
  buildFlowInterpolation,
  buildPathCurve,
  buildSegmentViews,
  cubicBezierPoint,
  CURVE_TOLERANCE,
  pointAtLength,
  simplifyPolyline,
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
  // (宽度=弦长+线宽,端盖半圆心恰在端点;弦长=width-2)
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

/** 胶囊(圆头线段视图)覆盖判定:视图 = 距弦段 ≤ 线宽/2 的点集 */
function capsuleCovers(
  view: { left: number; top: number; width: number; height: number; rotateDeg: number },
  p: Point,
  lineWidth: number,
): boolean {
  const rad = (view.rotateDeg * Math.PI) / 180;
  const center = { x: view.left + view.width / 2, y: view.top + view.height / 2 };
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const halfChord = (view.width - lineWidth) / 2;
  const a = { x: center.x - dir.x * halfChord, y: center.y - dir.y * halfChord };
  const b = { x: center.x + dir.x * halfChord, y: center.y + dir.y * halfChord };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.min(Math.max(t, 0), 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) <= lineWidth / 2 + 1e-9;
}

function sharpPolyline(points: Point[]) {
  // filletRadius 0.4 → 半径不足 0.5,拐角原样保留,points 与输入一致
  return buildPathCurve(points, 0.4);
}

test("接缝几何:共线两段在共享端点处保持完整线宽(无串珠收缩)", () => {
  const A: Point = { x: 0, y: 0 };
  const J: Point = { x: 50, y: 0 };
  const B: Point = { x: 100, y: 0 };
  const views = buildSegmentViews(sharpPolyline([A, J, B]), 2);
  assert.equal(views.length, 2);
  // 共享端点近旁 ±0.9px(接近半宽 1)必须被覆盖;若宽度=弦长(端盖心内缩),
  // (50,±0.9) 会落在两胶囊之外形成收缩缺口
  for (const probe of [
    { x: 50, y: 0.9 },
    { x: 50, y: -0.9 },
    { x: 50, y: 0 },
  ]) {
    assert.ok(
      views.some((view) => capsuleCovers(view, probe, 2)),
      `点 (${probe.x},${probe.y}) 在接缝处未被覆盖`,
    );
  }
  // 不应超宽:(50,±1.1) 在线外
  for (const probe of [
    { x: 50, y: 1.1 },
    { x: 50, y: -1.1 },
  ]) {
    assert.ok(
      !views.some((view) => capsuleCovers(view, probe, 2)),
      `点 (${probe.x},${probe.y}) 不应被覆盖`,
    );
  }
});

test("接缝几何:90° 拐角共享点处全向覆盖(round join),外侧无缺口", () => {
  const A: Point = { x: 0, y: 0 };
  const J: Point = { x: 50, y: 0 };
  const B: Point = { x: 50, y: 50 };
  const views = buildSegmentViews(sharpPolyline([A, J, B]), 2);
  assert.equal(views.length, 2);
  // 拐角外侧对角(距 J ≈ 0.99 < r)必须被覆盖;端盖心内缩时该点为缺口
  const probesCovered = [
    { x: 50.7, y: -0.7 }, // 外侧对角
    { x: 50, y: -0.9 }, // 入线外侧
    { x: 50.9, y: 0 }, // 出线外侧
    { x: 50, y: 0 },
  ];
  for (const probe of probesCovered) {
    assert.ok(
      views.some((view) => capsuleCovers(view, probe, 2)),
      `点 (${probe.x},${probe.y}) 在拐角处未被覆盖`,
    );
  }
  // 内凹侧同样覆盖(圆盘语义)
  assert.ok(views.some((view) => capsuleCovers(view, { x: 49.3, y: 0.7 }, 2)));
});

// ---------------------------------------------------------------------------
// 减锯齿的精度验证:渲染折线相对解析贝塞尔的真实几何误差。
// 不只断言"段数更少"——用密集解析取点(4096 个)到折线的最小距离的
// 最大值作为误差度量,并与旧基线(均匀 t 采样 ~10px/段 + DP 0.4 简化,
// 即 106f9f0 直连的实现)对比,新实现必须误差更小。
// ---------------------------------------------------------------------------

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.min(Math.max(t, 0), 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** 解析贝塞尔密集取点到渲染折线的最大几何偏差(px) */
function maxDeviationToPolyline(
  from: Point,
  cp1: Point,
  cp2: Point,
  to: Point,
  polyline: readonly Point[],
): number {
  const DENSE = 4096;
  let max = 0;
  for (let i = 0; i <= DENSE; i++) {
    const p = cubicBezierPoint(from, cp1, cp2, to, i / DENSE);
    let min = Infinity;
    for (let s = 1; s < polyline.length; s++) {
      min = Math.min(min, pointSegmentDistance(p, polyline[s - 1]!, polyline[s]!));
    }
    max = Math.max(max, min);
  }
  return max;
}

/** 旧基线折线(106f9f0 直连实现):均匀 t 采样 ~10px/段 + DP 0.4 简化 */
function oldBaselinePolyline(from: Point, cp1: Point, cp2: Point, to: Point): Point[] {
  const estimate: Point[] = [];
  for (let i = 0; i <= 12; i++) estimate.push(cubicBezierPoint(from, cp1, cp2, to, i / 12));
  let approx = 0;
  for (let i = 1; i < estimate.length; i++) {
    approx += Math.hypot(estimate[i]!.x - estimate[i - 1]!.x, estimate[i]!.y - estimate[i - 1]!.y);
  }
  const segments = Math.min(64, Math.max(8, Math.ceil(approx / 10)));
  const raw: Point[] = [];
  for (let i = 0; i <= segments; i++) raw.push(cubicBezierPoint(from, cp1, cp2, to, i / segments));
  return simplifyPolyline(raw, 0.4);
}

test("减锯齿:直连曲线渲染折线对解析贝塞尔的最大偏差 ≤ 0.2px 且优于旧基线", () => {
  // 主 Agent 实测场景:dy=58(单行间距),dx = 37/100/400/1000
  for (const dx of [37, 100, 400, 1000]) {
    const from: Point = { x: 0, y: 0 };
    const to: Point = { x: dx, y: 58 };
    const control = Math.min(90, Math.max(20, Math.abs(58) * 0.45));
    const cp1 = { x: from.x, y: from.y + control };
    const cp2 = { x: to.x, y: to.y - control };
    const curve = buildEdgeCurve(from, to);
    const deviation = maxDeviationToPolyline(from, cp1, cp2, to, curve.points);
    const oldDeviation = maxDeviationToPolyline(
      from,
      cp1,
      cp2,
      to,
      oldBaselinePolyline(from, cp1, cp2, to),
    );
    console.log(
      `dx=${dx}: 自适应细分 ${curve.points.length - 1} 段 偏差 ${deviation.toFixed(3)}px | 旧基线 ${
        oldBaselinePolyline(from, cp1, cp2, to).length - 1
      } 段 偏差 ${oldDeviation.toFixed(3)}px`,
    );
    assert.ok(
      deviation <= 0.2,
      `dx=${dx} 偏差 ${deviation.toFixed(3)}px 超过 0.2px`,
    );
    assert.ok(
      deviation <= oldDeviation,
      `dx=${dx} 自适应偏差 ${deviation.toFixed(3)}px 未优于旧基线 ${oldDeviation.toFixed(3)}px`,
    );
    // 视图数不爆炸:偏差收紧后段数增加是预期的,但不得数量级增长
    assert.ok(curve.points.length - 1 <= 64, `dx=${dx} 段数 ${curve.points.length - 1} 超上界`);
  }
  assert.equal(CURVE_TOLERANCE, 0.15);
});
