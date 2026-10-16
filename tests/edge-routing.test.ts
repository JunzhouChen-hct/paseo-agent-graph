import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout, type LayoutResult } from "../client/layout";
import {
  freeXBands,
  planEdgePath,
  polylineHitsRects,
  ROUTE_MARGIN,
  routeBounds,
  segmentIntersectsRect,
  type ObstacleRect,
  type PlannedEdgePath,
} from "../shared/edge-routing";
import { assignExitOffsets, type Point } from "../shared/edge-geometry";

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

/** 面板同款规划:exit 分配 → 逐边 planEdgePath(障碍排除两端卡片) */
function planGraph(
  ids: string[],
  parentOf: ReadonlyMap<string, string | null>,
  cardW: number,
  cardH: number,
  gapX: number,
  gapY: number,
  maxRowWidth: number,
): GraphPlan {
  const layout = computeLayout(ids, parentOf, cardW, cardH, gapX, gapY, maxRowWidth);
  const rects: ObstacleRect[] = [];
  for (const id of ids) {
    const position = layout.positions.get(id)!;
    rects.push({ id, x: position.x, y: position.y, width: cardW, height: cardH });
  }
  const byParent = new Map<string, { id: string; x: number }[]>();
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    if (!parent) continue;
    const childPos = layout.positions.get(id)!;
    const list = byParent.get(parent);
    if (list) list.push({ id, x: childPos.x });
    else byParent.set(parent, [{ id, x: childPos.x }]);
  }
  const edges: PlannedEdge[] = [];
  for (const [parentId, children] of byParent) {
    const parentPos = layout.positions.get(parentId)!;
    children.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
    const offsets = assignExitOffsets(cardW, children.length, 24);
    children.forEach((child, index) => {
      const childPos = layout.positions.get(child.id)!;
      const from = { x: parentPos.x + (offsets[index] ?? cardW / 2), y: parentPos.y + cardH };
      const to = { x: childPos.x + cardW / 2, y: childPos.y };
      const obstacles = rects.filter((rect) => rect.id !== parentId && rect.id !== child.id);
      edges.push({ fromId: parentId, toId: child.id, from, to, ...planEdgePath(from, to, obstacles) });
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

/** 竖直走廊 x 是否落在横跨行的卡片簇内部(而非簇外大绕) */
function corridorInsideCluster(edge: PlannedEdge, rects: ObstacleRect[]): boolean {
  const corridorX = edge.waypoints[2]?.x;
  if (corridorX === undefined) return true;
  const yLo = Math.min(edge.waypoints[1]!.y, edge.waypoints[3]!.y);
  const yHi = Math.max(edge.waypoints[1]!.y, edge.waypoints[3]!.y);
  const crossing = rects.filter(
    (rect) => rect.id !== edge.fromId && rect.id !== edge.toId && rect.y + rect.height > yLo && rect.y < yHi,
  );
  if (crossing.length === 0) return true;
  const left = Math.min(...crossing.map((rect) => rect.x));
  const right = Math.max(...crossing.map((rect) => rect.x + rect.width));
  return corridorX >= left && corridorX <= right;
}

test("冒烟:窄面板(compact,gapX=18)root+12 子 2/列换行——零碰撞零退化,跨行走中间空隙", () => {
  const ids = ["root", ...Array.from({ length: 12 }, (_, i) => `c${i}`)];
  const parentOf = new Map<string, string | null>(ids.map((id) => [id, id === "root" ? null : "root"]));
  const plan = planGraph(ids, parentOf, 164, 148, 18, 58, 346);
  assert.equal(plan.edges.length, 12);
  let direct = 0;
  let routed = 0;
  for (const edge of plan.edges) {
    assert.equal(edge.degraded, false, "窄面板不允许退化穿卡");
    assertOrthogonal(edge);
    assertClear(edge, plan, ROUTE_MARGIN);
    assertClear(edge, plan, 0);
    if (edge.direct) direct++;
    else {
      routed++;
      assert.ok(corridorInsideCluster(edge, plan.rects), "跨行边走廊必须在卡片簇内部,不允许外侧大绕");
      // 走廊零膨胀下不得落在任何横跨行卡片内部
      const corridorX = edge.waypoints[2]!.x;
      const yLo = Math.min(edge.waypoints[1]!.y, edge.waypoints[3]!.y);
      const yHi = Math.max(edge.waypoints[1]!.y, edge.waypoints[3]!.y);
      for (const rect of plan.rects) {
        if (rect.id === edge.fromId || rect.id === edge.toId) continue;
        const crosses = rect.y + rect.height > yLo && rect.y < yHi;
        if (!crosses) continue;
        assert.ok(
          corridorX < rect.x || corridorX > rect.x + rect.width,
          `走廊 x=${corridorX} 穿过卡片 ${rect.id}`,
        );
      }
    }
  }
  assert.ok(direct > 0, "第一行子节点应能带内台阶直连");
  assert.ok(routed > 0, "12 子 2/列必有跨行边");
});

test("冒烟:宽面板(desktop,gapX=26)单行 3 子——全部带内台阶直连", () => {
  const ids = ["root", "c0", "c1", "c2"];
  const parentOf = new Map<string, string | null>(ids.map((id) => [id, id === "root" ? null : "root"]));
  const plan = planGraph(ids, parentOf, 196, 148, 26, 58, 1200);
  assert.equal(plan.edges.length, 3);
  for (const edge of plan.edges) {
    assert.equal(edge.degraded, false);
    assert.equal(edge.direct, true, "单行相邻边应直连");
    const aligned = Math.abs(edge.from.x - edge.to.x) < 0.5;
    assert.equal(edge.waypoints.length, aligned ? 2 : 4);
    if (!aligned) {
      const midY = (edge.from.y + edge.to.y) / 2;
      assert.equal(edge.waypoints[1]!.y, midY);
      assert.equal(edge.waypoints[2]!.y, midY);
    }
    assertOrthogonal(edge);
    assertClear(edge, plan, ROUTE_MARGIN);
  }
});

test("冒烟:多行(2/列)跨行边优先两卡之间的中间空隙,不走外侧", () => {
  const ids = ["root", "c0", "c1", "c2", "c3"];
  const parentOf = new Map<string, string | null>(ids.map((id) => [id, id === "root" ? null : "root"]));
  // 196*2+26 = 418 → 每行 2 张,共 2 行子节点
  const plan = planGraph(ids, parentOf, 196, 148, 26, 58, 418);
  const row2 = plan.edges.filter((edge) => !edge.direct);
  assert.equal(row2.length, 2, "第二行的 2 个子节点需要跨行绕行");
  const c0Y = plan.layout.positions.get("c0")!.y;
  const row1 = plan.rects.filter((rect) => rect.id !== "root" && rect.y === c0Y).sort((a, b) => a.x - b.x);
  assert.equal(row1.length, 2);
  const gapLo = row1[0]!.x + row1[0]!.width;
  const gapHi = row1[1]!.x;
  assert.ok(gapHi > gapLo, "第一行两卡之间应存在空隙");
  for (const edge of row2) {
    assert.equal(edge.degraded, false);
    const corridorX = edge.waypoints[2]!.x;
    assert.ok(
      corridorX > gapLo && corridorX < gapHi,
      `走廊 x=${corridorX} 必须在第一行两卡之间 (${gapLo},${gapHi})`,
    );
    assertOrthogonal(edge);
    assertClear(edge, plan, ROUTE_MARGIN);
  }
});

test("freeXBands:返回障碍之间的自由 x 带,竖直跨度外不遮挡", () => {
  const rects: ObstacleRect[] = [
    { id: "a", x: 0, y: 0, width: 100, height: 100 },
    { id: "b", x: 120, y: 0, width: 100, height: 100 },
  ];
  const bands = freeXBands(0, 220, -50, 150, rects, 6);
  assert.equal(bands.length, 1);
  assert.equal(bands[0]![0], 106);
  assert.equal(bands[0]![1], 114);
  const clear = freeXBands(0, 220, 200, 300, rects, 6);
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
