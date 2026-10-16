import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "../client/layout";
import {
  buildFlowInterpolation,
  buildPathCurve,
  buildSegmentViews,
  pointAtLength,
  type Point,
} from "../shared/edge-geometry";
import {
  BYPASS_FILLET_RADIUS,
  freeYBands,
  planEdgePath,
  polylineHitsRects,
  ROUTE_MARGIN,
  routeBounds,
  segmentIntersectsRect,
  type ObstacleRect,
} from "../shared/edge-routing";

function strictlyIncreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i]! > values[i - 1]!)) return false;
  }
  return true;
}

/** 主 Agent baseline fixture:root+12child,真实布局,画布 866x734,三行各 4 卡 */
function baselineFixture() {
  const ids = ["root", ...Array.from({ length: 12 }, (_, i) => `c${i}`)];
  const parentOf = new Map<string, string | null>(ids.map((id) => [id, id === "root" ? null : "root"]));
  return computeLayout(ids, parentOf, 200, 140, 22, 58, 900);
}

/** 真实 compact 尺寸 fixture:CARD_W164 GAP_X18 CARD_H140 GAP_Y58 */
function compactFixture() {
  const ids = ["root", ...Array.from({ length: 12 }, (_, i) => `c${i}`)];
  const parentOf = new Map<string, string | null>(ids.map((id) => [id, id === "root" ? null : "root"]));
  return computeLayout(ids, parentOf, 164, 140, 18, 58, 700);
}

/** 用面板同款逻辑生成边规划(障碍=除两端外的全部卡片) */
function planFixtureEdges(
  layout: ReturnType<typeof computeLayout>,
  cardW: number,
  cardH: number,
  exitOffsetsFor: (childX: number) => number,
) {
  const rects: ObstacleRect[] = [];
  for (const [id, pos] of layout.positions) {
    rects.push({ id, x: pos.x, y: pos.y, width: cardW, height: cardH });
  }
  const root = layout.positions.get("root")!;
  const edges = ["root", ...Array.from({ length: 12 }, (_, i) => `c${i}`)]
    .filter((id) => id !== "root")
    .map((childId) => {
      const child = layout.positions.get(childId)!;
      const from = { x: root.x + exitOffsetsFor(child.x), y: root.y + cardH };
      const to = { x: child.x + cardW / 2, y: child.y };
      const obstacles = rects.filter((rect) => rect.id !== "root" && rect.id !== childId);
      return { childId, from, to, obstacles, planned: planEdgePath(from, to, obstacles) };
    });
  return { edges, rects };
}

test("fixture:baseline 布局 866x734,三行各 4 卡(与实测一致)", () => {
  const layout = baselineFixture();
  assert.equal(layout.width, 866);
  assert.equal(layout.height, 734);
  const root = layout.positions.get("root")!;
  assert.deepEqual(root, { x: 333, y: 0 });
  const rowYs = [...layout.positions.values()].map((p) => p.y);
  for (const y of [198, 396, 594]) {
    assert.equal(rowYs.filter((value) => value === y).length, 4);
  }
});

test("routing:baseline 全部 12 条边逐段无碰撞,跨行边必须绕行", () => {
  const layout = baselineFixture();
  // 出线点在父卡片宽度内按边距分配(与面板一致)
  const { edges } = planFixtureEdges(layout, 200, 140, () => 100);
  assert.equal(edges.length, 12);
  for (const edge of edges) {
    const hit = polylineHitsRects(edge.planned.sampled.points, edge.obstacles, ROUTE_MARGIN);
    assert.equal(hit, null, `边 ${edge.childId} 撞到 ${hit}`);
  }
  // 同行(第 1 行)子节点直连可达;第 2/3 行被前排卡片挡住,必须绕行
  for (const edge of edges) {
    const row = layout.positions.get(edge.childId)!.y;
    if (row === 198) assert.equal(edge.planned.direct, true, "第 1 行应直连");
    if (row === 396 || row === 594) {
      assert.equal(edge.planned.direct, false, `第 2/3 行边 ${edge.childId} 必须绕行`);
      // 绕行是正交路径:相邻航点至少一轴对齐
      const wp = edge.planned.waypoints;
      for (let i = 1; i < wp.length; i++) {
        const axisAligned = wp[i]!.x === wp[i - 1]!.x || wp[i]!.y === wp[i - 1]!.y;
        assert.ok(axisAligned, "绕行航点必须正交");
      }
    }
  }
});

test("routing:绕行路径全部落点在扩展后画布内,画布随之扩展", () => {
  const layout = baselineFixture();
  const { edges, rects } = planFixtureEdges(layout, 200, 140, () => 100);
  const extent = routeBounds(edges.map((edge) => edge.planned.sampled));
  const canvasWidth = Math.max(layout.width, extent.maxX + 4);
  const canvasHeight = Math.max(layout.height, extent.maxY + 4);
  // 绕行到右侧最远障碍外:866 + 12
  assert.ok(extent.maxX >= 866 + ROUTE_MARGIN - 0.5, "绕行 x 必须越过右边界");
  assert.ok(canvasWidth > layout.width, "画布必须因绕行扩展");
  // 所有路线点(含圆角采样)都在扩展画布内且不为负
  for (const edge of edges) {
    for (const point of edge.planned.sampled.points) {
      assert.ok(point.x >= 0 && point.x <= canvasWidth, `x=${point.x} 越界`);
      assert.ok(point.y >= 0 && point.y <= canvasHeight, `y=${point.y} 越界`);
    }
  }
  // 卡片槽位仍在画布内(扩展只增不减)
  assert.ok(canvasWidth >= layout.width && canvasHeight >= layout.height);
  void rects;
});

test("routing:真实 compact 尺寸(164/18/140/58)同样全边无碰撞", () => {
  const layout = compactFixture();
  const { edges } = planFixtureEdges(layout, 164, 140, () => 82);
  assert.equal(edges.length, 12);
  for (const edge of edges) {
    const hit = polylineHitsRects(edge.planned.sampled.points, edge.obstacles, ROUTE_MARGIN);
    assert.equal(hit, null, `compact 边 ${edge.childId} 撞到 ${hit}`);
  }
  // 18px 间隙在 margin 12 膨胀后完全闭合 → 跨行必须绕行
  const row2Count = edges.filter(
    (edge) => layout.positions.get(edge.childId)!.y > 198 && edge.planned.direct === false,
  ).length;
  assert.ok(row2Count >= 4, "跨行边至少 4 条绕行");
});

test("routing:裕量覆盖流点半径与呼吸框", () => {
  // flow 半径 2.5 + ring 3 = 5.5,ROUTE_MARGIN 必须更大
  assert.ok(ROUTE_MARGIN >= 5.5 + 4);
  // 校验路径到卡片的真实距离 ≥ ROUTE_MARGIN:用 0 膨胀重查,点到矩形距离
  const layout = baselineFixture();
  const { edges, rects } = planFixtureEdges(layout, 200, 140, () => 100);
  const distanceToRect = (p: Point, rect: ObstacleRect): number => {
    const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width));
    const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height));
    return Math.hypot(dx, dy);
  };
  for (const edge of edges) {
    for (const point of edge.planned.sampled.points) {
      for (const rect of edge.obstacles) {
        assert.ok(
          distanceToRect(point, rect) >= ROUTE_MARGIN - 0.5,
          `点 (${point.x},${point.y}) 距 ${rect.id} 不足 ROUTE_MARGIN`,
        );
      }
    }
  }
});

test("segmentIntersectsRect:相交/相切/内部/共线重叠", () => {
  const rect: ObstacleRect = { id: "r", x: 10, y: 10, width: 20, height: 20 };
  assert.equal(segmentIntersectsRect({ x: 0, y: 20 }, { x: 40, y: 20 }, rect), true); // 横穿
  assert.equal(segmentIntersectsRect({ x: 0, y: 0 }, { x: 5, y: 5 }, rect), false); // 外部
  assert.equal(segmentIntersectsRect({ x: 15, y: 15 }, { x: 18, y: 18 }, rect), true); // 全在内部
  assert.equal(segmentIntersectsRect({ x: 5, y: 10 }, { x: 15, y: 10 }, rect), true); // 触边切入
  assert.equal(segmentIntersectsRect({ x: 5, y: 35 }, { x: 15, y: 35 }, rect), false); // 边界外
  assert.equal(segmentIntersectsRect({ x: 0, y: 10 }, { x: 10, y: 10 }, rect), true); // 端点在边界上
  assert.equal(segmentIntersectsRect({ x: 31, y: 20 }, { x: 40, y: 20 }, rect), false); // 恰好在外
});

test("polylineHitsRects:命中返回障碍 id,无碰撞返回 null", () => {
  const rects: ObstacleRect[] = [
    { id: "a", x: 0, y: 0, width: 10, height: 10 },
    { id: "b", x: 20, y: 20, width: 10, height: 10 },
  ];
  assert.equal(polylineHitsRects([{ x: 5, y: 5 }, { x: 30, y: 30 }], rects, 0), "a");
  assert.equal(polylineHitsRects([{ x: -5, y: 25 }, { x: 25, y: 25 }], rects, 2), "b");
  assert.equal(polylineHitsRects([{ x: -5, y: 5 }, { x: -1, y: 5 }], rects, 0), null);
  // margin 生效:贴近但不接触的线段在膨胀后命中
  assert.equal(polylineHitsRects([{ x: 12, y: 5 }, { x: 14, y: 5 }], rects, 3), "a");
});

test("freeYBands:区间合并与补集", () => {
  const rects: ObstacleRect[] = [
    { id: "a", x: 0, y: 100, width: 50, height: 40 }, // 膨胀后 y [88,152]
    { id: "b", x: 10, y: 160, width: 50, height: 40 }, // 膨胀后 y [148,212],与 a 合并 [88,212]
  ];
  // x 区间覆盖两个障碍 → 合并带之间只有一条自由带
  assert.deepEqual(freeYBands(0, 60, 0, 400, rects, 12), [
    [0, 88],
    [212, 400],
  ]);
  // x 区间覆盖两个障碍(0..8 也在 b 膨胀范围 [-2,72] 内)→ 同样合并
  assert.deepEqual(freeYBands(0, 8, 0, 400, rects, 12), [
    [0, 88],
    [212, 400],
  ]);
  // 无障碍 → 单带
  assert.deepEqual(freeYBands(0, 10, 0, 100, [], 12), [[0, 100]]);
});

test("planEdgePath:无障碍直连贝塞尔", () => {
  const planned = planEdgePath({ x: 100, y: 0 }, { x: 180, y: 120 }, []);
  assert.equal(planned.direct, true);
  assert.equal(planned.sampled.points[0]!.x, 100);
  const last = planned.sampled.points[planned.sampled.points.length - 1]!;
  assert.equal(last.x, 180);
  assert.equal(last.y, 120);
});

test("planEdgePath:完全被封死的路径退回直连(不画错不消失)", () => {
  // 障碍墙覆盖 from..to 的左右全部出路与所有 y 通道
  const wall: ObstacleRect[] = [
    { id: "left", x: -200, y: -200, width: 400, height: 800 },
    { id: "right", x: 200, y: -200, width: 400, height: 800 },
    { id: "mid", x: -200, y: 30, width: 800, height: 40 },
  ];
  const planned = planEdgePath({ x: 0, y: 0 }, { x: 0, y: 100 }, wall);
  assert.equal(planned.direct, true);
});

test("planEdgePath:确定性(同输入同航点),直连与绕行均稳定", () => {
  const layout = baselineFixture();
  const { edges } = planFixtureEdges(layout, 200, 140, () => 100);
  for (const edge of edges) {
    const again = planEdgePath(edge.from, edge.to, edge.obstacles);
    assert.deepEqual(again.waypoints, edge.planned.waypoints);
    assert.deepEqual(again.sampled.points, edge.planned.sampled.points);
  }
});

test("绕行路径:流点插值表与静态线同源,首尾命中端点", () => {
  const layout = baselineFixture();
  const { edges } = planFixtureEdges(layout, 200, 140, () => 100);
  const routed = edges.find((edge) => edge.planned.direct === false);
  assert.ok(routed, "fixture 应存在绕行边");
  const flow = buildFlowInterpolation(routed!.planned.sampled, 5);
  assert.equal(flow.inputRange.length, flow.outputX.length);
  assert.ok(strictlyIncreasing(flow.inputRange));
  assert.equal(flow.inputRange[0], 0);
  const last = flow.inputRange.length - 1;
  assert.ok(Math.abs(flow.inputRange[last]! - routed!.planned.sampled.total) < 1e-6);
  const from = routed!.planned.sampled.points[0]!;
  assert.equal(flow.outputX[0], from.x - 2.5);
  assert.equal(flow.outputY[0], from.y - 2.5);
  // 弧长中点在路径上(与端点/航点一致)
  const mid = pointAtLength(routed!.planned.sampled, routed!.planned.sampled.total / 2);
  assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.y));
});

test("buildPathCurve:90° 拐角走真实圆弧,端点命中,弧长≈直段+四分之一圆周", () => {
  // L 形:(0,0) → (100,0) → (100,100),圆角 r=14
  const path = buildPathCurve(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ],
    14,
  );
  const first = path.points[0]!;
  const last = path.points[path.points.length - 1]!;
  assert.ok(Math.hypot(first.x, first.y) < 1e-6);
  assert.ok(Math.hypot(last.x - 100, last.y - 100) < 1e-6);
  assert.ok(strictlyIncreasing(path.cumulative));
  // 圆弧圆心 (86,14),半径 14:拐角区(x∈[86,100], y∈[0,14])内的采样点距圆心 ≈ 14
  const center = { x: 86, y: 14 };
  const arcPoints = path.points.filter(
    (p) => p.x >= 86 - 0.01 && p.x <= 100 + 0.01 && p.y >= -0.01 && p.y <= 14 + 0.01,
  );
  assert.ok(arcPoints.length >= 8, "圆弧应有足够采样点");
  for (const p of arcPoints) {
    const dist = Math.hypot(p.x - center.x, p.y - center.y);
    assert.ok(Math.abs(dist - 14) < 0.6, `弧点 (${p.x},${p.y}) 距圆心 ${dist} 偏离半径`);
  }
  // 总长 = 86(直段) + 86(直段) + 四分之一圆周(≈21.99)
  const expected = 86 + 86 + (Math.PI * 14) / 2;
  assert.ok(Math.abs(path.total - expected) < 1.5, `总长 ${path.total} vs ${expected}`);
});

test("buildPathCurve:圆角只向拐角内侧切,不越出直角路径外侧", () => {
  const waypoints: Point[] = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 80 },
  ];
  const path = buildPathCurve(waypoints, BYPASS_FILLET_RADIUS);
  const center = { x: 36, y: 14 }; // 拐角圆弧圆心
  for (const p of path.points) {
    // 不越出直角路径外侧(圆角只向内切)
    assert.ok(p.y >= -0.01 && p.x <= 50.01, `点 (${p.x},${p.y}) 越出拐角外侧`);
    // 每个点要么在水平直段上、要么在竖直直段上、要么在圆弧上
    const onTopLeg = Math.abs(p.y) <= 0.01;
    const onRightLeg = Math.abs(p.x - 50) <= 0.01;
    const onArc = Math.abs(Math.hypot(p.x - center.x, p.y - center.y) - 14) <= 0.6;
    assert.ok(onTopLeg || onRightLeg || onArc, `点 (${p.x},${p.y}) 不在任何路径段上`);
  }
});

test("渲染视图数上界:直连 ≤ 24,绕行 ≤ 40(采样+圆弧,远低于数百)", () => {
  // 直连:长边(900px)
  const longCurve = planEdgePath({ x: 0, y: 0 }, { x: 900, y: 700 }, []);
  assert.ok(buildSegmentViews(longCurve.sampled, 2).length <= 24);
  // 绕行:5 直段 + 4 圆角(每角 ≤8 采样)
  const layout = baselineFixture();
  const { edges } = planFixtureEdges(layout, 200, 140, () => 100);
  const routed = edges.filter((edge) => edge.planned.direct === false);
  assert.ok(routed.length > 0);
  for (const edge of routed) {
    assert.ok(buildSegmentViews(edge.planned.sampled, 2).length <= 40);
  }
});

test("routeBounds:空路径与负坐标", () => {
  assert.deepEqual(routeBounds([]), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const bounds = routeBounds([
    buildPathCurve([
      { x: -10, y: 5 },
      { x: 30, y: 5 },
    ]),
  ]);
  assert.equal(bounds.minX, -10);
  assert.equal(bounds.maxX, 30);
});
