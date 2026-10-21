import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout, type LayoutResult } from "../client/layout.ts";
import {
  freeYBands,
  planEdgePath,
  polylineHitsRects,
  ROUTE_MARGIN,
  routeBounds,
  segmentIntersectsRect,
  type ObstacleRect,
  type PlannedEdgePath,
} from "../shared/edge-routing.ts";
import { assignExitOffsets, type Point } from "../shared/edge-geometry.ts";

interface PlannedEdge extends PlannedEdgePath {
  fromId: string;
  toId: string;
  from: Point;
  to: Point;
}

interface GraphPlan {
  layout: LayoutResult;
  rects: ObstacleRect[];
  edges: PlannedEdge[];
}

/** 面板同款规划(横向语义):右缘出线分配 → 车道分配 → 逐边 planEdgePath */
function planGraph(
  ids: string[],
  parentOf: ReadonlyMap<string, string | null>,
  cardW: number,
  cardH: number,
  gapCol: number,
  gapRow: number,
  withLanes = true,
): GraphPlan {
  const layout = computeLayout(ids, parentOf, cardW, cardH, gapCol, gapRow);
  const rects: ObstacleRect[] = [];
  for (const id of ids) {
    const position = layout.positions.get(id)!;
    rects.push({ id, x: position.x, y: position.y, width: cardW, height: cardH });
  }
  const byParent = new Map<string, { id: string; y: number }[]>();
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    if (!parent) continue;
    const childPos = layout.positions.get(id)!;
    const list = byParent.get(parent);
    if (list) list.push({ id, y: childPos.y });
    else byParent.set(parent, [{ id, y: childPos.y }]);
  }
  const edges: PlannedEdge[] = [];
  for (const [parentId, children] of byParent) {
    const parentPos = layout.positions.get(parentId)!;
    children.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    const exitOffsets = assignExitOffsets(cardH, children.length, 24);
    const laneUsable = Math.max(gapCol - 8, 8);
    const laneOffsets = assignExitOffsets(laneUsable, children.length, 4);
    const parentRight = parentPos.x + cardW;
    children.forEach((child, index) => {
      const childPos = layout.positions.get(child.id)!;
      const from = { x: parentRight, y: parentPos.y + (exitOffsets[index] ?? cardH / 2) };
      const to = { x: childPos.x, y: childPos.y + cardH / 2 };
      const laneX = withLanes ? parentRight + 4 + (laneOffsets[index] ?? laneUsable / 2) : undefined;
      const obstacles = rects.filter((rect) => rect.id !== parentId && rect.id !== child.id);
      edges.push({
        fromId: parentId,
        toId: child.id,
        from,
        to,
        ...planEdgePath(from, to, obstacles, laneX === undefined ? undefined : { laneXs: [laneX] }),
      });
    });
  }
  return { layout, rects, edges };
}

function assertOrthogonal(edge: PlannedEdge): void {
  for (let i = 1; i < edge.sampled.points.length; i++) {
    const a = edge.sampled.points[i - 1]!;
    const b = edge.sampled.points[i]!;
    assert.ok(
      Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9,
      `边必须轴对齐:${JSON.stringify(a)}→${JSON.stringify(b)}`,
    );
  }
}

/** 双断言:真实裕量与零膨胀下,除两端卡片外均不与任何卡片相交 */
function assertClear(edge: PlannedEdge, plan: GraphPlan, margin: number): void {
  const obstacles = plan.rects.filter(
    (rect) => rect.id !== edge.fromId && rect.id !== edge.toId,
  );
  const hit = polylineHitsRects(edge.sampled.points, obstacles, margin);
  assert.equal(hit, null, `margin ${margin} 下边被障碍 ${hit} 阻挡`);
}

test("冒烟:compact(gapCol=36) root+12 子单列——零碰撞零退化,同父车道互不重合", () => {
  const ids = ["root", ...Array.from({ length: 12 }, (_, i) => `c${i}`)];
  const parentOf = new Map<string, string | null>(ids.map((id) => [id, id === "root" ? null : "root"]));
  const plan = planGraph(ids, parentOf, 164, 148, 36, 18);
  assert.equal(plan.edges.length, 12);
  const laneXs = new Set<number>();
  for (const edge of plan.edges) {
    assert.equal(edge.degraded, false, "列布局下不允许退化穿卡");
    assert.equal(edge.direct, true, "列间通道内无卡片,全部应为列间台阶直连");
    assertOrthogonal(edge);
    assertClear(edge, plan, ROUTE_MARGIN);
    assertClear(edge, plan, 0);
    // 竖直段车道必须落在列间通道内
    const laneX = edge.waypoints[1]!.x;
    const parentRight = edge.from.x;
    assert.ok(
      laneX > parentRight && laneX < parentRight + 36,
      `车道 x=${laneX} 必须在列间通道 (${parentRight},${parentRight + 36}) 内`,
    );
    laneXs.add(laneX);
  }
  assert.equal(laneXs.size, 12, "同父 12 条边的车道 x 必须两两不同");
});

test("冒烟:三代树(根→3子→各2孙)——全部相邻列台阶直连,列 x 逐列右移", () => {
  const ids = ["root", "c0", "c1", "c2", "g0a", "g0b", "g1a", "g1b", "g2a", "g2b"];
  const parentOf = new Map<string, string | null>([
    ["root", null], ["c0", "root"], ["c1", "root"], ["c2", "root"],
    ["g0a", "c0"], ["g0b", "c0"], ["g1a", "c1"], ["g1b", "c1"], ["g2a", "c2"], ["g2b", "c2"],
  ]);
  const plan = planGraph(ids, parentOf, 196, 148, 52, 26);
  assert.equal(plan.edges.length, 9);
  for (const edge of plan.edges) {
    assert.equal(edge.degraded, false);
    assertOrthogonal(edge);
    assertClear(edge, plan, ROUTE_MARGIN);
  }
  const root = plan.layout.positions.get("root")!;
  const c0 = plan.layout.positions.get("c0")!;
  const g0a = plan.layout.positions.get("g0a")!;
  assert.equal(c0.x, root.x + 196 + 52, "子列 x = 根列 x + 卡宽 + 列距");
  assert.equal(g0a.x, c0.x + 196 + 52, "孙列紧随子列");
  // 子块向父收拢:c0/c1/c2 的块中心对齐 root 中心(block 高 3*148+2*26=496,
  // 期望中心 74 → 期望 y = 74-248 < 0,夹到 0,即保持顶部装箱)
  assert.equal(c0.y, 0);
  // g0a/g0b 向 c0 收拢:块高 2*148+26=322,c0 中心 74 → 期望 y=74-161<0 → 夹 0
  assert.equal(g0a.y, c0.y);
  assert.equal(plan.layout.positions.get("g0b")!.y, c0.y + 148 + 26);
});

test("冒烟:向父收拢被上方卡片约束时,不下移越界、保持零重叠", () => {
  // 列0: r1, r2;列1: c_a(r1 子)、k1、k2(r2 子)。c_a 收拢到 r1 中心;
  // k1/k2 块想收拢到 r2 中心,但 c_a 占据上方空间 → 只能停在可用区间内
  const H = 148;
  const gapRow = 26;
  const ids = ["r1", "r2", "c_a", "k1", "k2"];
  const parentOf = new Map<string, string | null>([
    ["r1", null], ["r2", null], ["c_a", "r1"], ["k1", "r2"], ["k2", "r2"],
  ]);
  const plan = planGraph(ids, parentOf, 196, H, 52, gapRow);
  const r1 = plan.layout.positions.get("r1")!;
  const r2 = plan.layout.positions.get("r2")!;
  const cA = plan.layout.positions.get("c_a")!;
  const k1 = plan.layout.positions.get("k1")!;
  const k2 = plan.layout.positions.get("k2")!;
  // c_a 向 r1 收拢:单块,中心对齐 → y 与 r1 一致
  assert.equal(cA.y, r1.y);
  // r2 在第 1 列的 y = H + gapRow(根列装箱);k1/k2 块高 2H+gapRow,
  // 期望中心 = r2 中心 → 期望起点 = r2.y;上方受 c_a(底 = r1.y+H+gapRow)约束
  const minAllowed = r1.y + H + gapRow;
  const expected = Math.max(r2.y, minAllowed);
  assert.equal(k1.y, expected);
  assert.equal(k2.y, expected + H + gapRow);
  // 无论收拢结果如何,列 1 内部零重叠
  const rects = [
    { id: "c_a", ...cA }, { id: "k1", ...k1 }, { id: "k2", ...k2 },
  ].map((r) => ({ x: r.x, y: r.y, width: 196, height: H }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      assert.ok(
        a.y + H + gapRow <= b.y || b.y + H + gapRow <= a.y,
        "同列卡片必须保持行距不重叠",
      );
    }
  }
});

test("单子节点 y 对齐时同行直连:两点路径", () => {
  const ids = ["root", "c0"];
  const parentOf = new Map<string, string | null>([["root", null], ["c0", "root"]]);
  const plan = planGraph(ids, parentOf, 196, 148, 52, 26);
  const edge = plan.edges[0]!;
  // 单子被收拢到与父垂直居中对齐 → 同行直连
  assert.equal(edge.degraded, false);
  assert.equal(edge.waypoints.length, 2);
  assert.equal(edge.waypoints[0]!.y, edge.waypoints[1]!.y);
  assertOrthogonal(edge);
  assertClear(edge, plan, ROUTE_MARGIN);
});

test("无车道候选时退回中点车道,仍直连不退化", () => {
  const plan = planEdgePath(
    { x: 100, y: 0 },
    { x: 152, y: 80 },
    [],
  );
  assert.equal(plan.degraded, false);
  assert.equal(plan.direct, true);
  const midX = (100 + 152) / 2;
  assert.equal(plan.waypoints[1]!.x, midX);
  assert.equal(plan.waypoints[2]!.x, midX);
});

test("freeYBands:返回障碍之间的自由 y 带,水平跨度外不遮挡", () => {
  const rects: ObstacleRect[] = [
    { id: "a", x: 0, y: 0, width: 100, height: 100 },
    { id: "b", x: 0, y: 120, width: 100, height: 100 },
  ];
  const bands = freeYBands(0, 220, -50, 150, rects, 6);
  assert.equal(bands.length, 1);
  assert.equal(bands[0]![0], 106);
  assert.equal(bands[0]![1], 114);
  const clear = freeYBands(0, 220, 200, 300, rects, 6);
  assert.equal(clear.length, 1);
  assert.equal(clear[0]![0], 0);
  assert.equal(clear[0]![1], 220);
});

test("segmentIntersectsRect:端点在边界上视为相交", () => {
  const rect: ObstacleRect = { id: "r", x: 0, y: 0, width: 10, height: 10 };
  assert.equal(segmentIntersectsRect({ x: 5, y: 5 }, { x: 20, y: 5 }, rect), true);
  assert.equal(segmentIntersectsRect({ x: 0, y: 20 }, { x: 10, y: 20 }, rect), false);
  assert.equal(segmentIntersectsRect({ x: 5, y: 10 }, { x: 5, y: 20 }, rect), true);
});

test("routeBounds:空路径返回零盒,非空取包围盒", () => {
  assert.deepEqual(routeBounds([]), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const path = planEdgePath({ x: 0, y: 0 }, { x: 50, y: 58 }, []).sampled;
  const bounds = routeBounds([path]);
  assert.equal(bounds.minX, 0);
  assert.equal(bounds.maxX, 50);
});
