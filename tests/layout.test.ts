import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "../client/layout.ts";

/** 两个矩形是否相交(布局保证不重叠的断言辅助)。 */
function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const W = 196;
const H = 148;
const GAP_X = 26;
const GAP_Y = 58;

test("布局:任务列表伪节点作为兄弟槽位紧邻主 Agent 右侧,同排不重叠", () => {
  // 主 Agent(root) + 伪节点(兄弟,插在其后) + 一个普通子节点
  const ids = ["main", "tasklist", "child"];
  const parentOf = new Map<string, string | null>([
    ["main", null],
    ["tasklist", null],
    ["child", "main"],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_X, GAP_Y, 1200);
  const main = result.positions.get("main")!;
  const task = result.positions.get("tasklist")!;
  const child = result.positions.get("child")!;
  // 伪节点紧贴主 Agent 右侧:同一行,间距 = gapX
  assert.equal(task.y, main.y);
  assert.equal(task.x, main.x + W + GAP_X);
  // 不与任何卡片相交
  assert.equal(overlap({ ...main, width: W, height: H }, { ...task, width: W, height: H }), false);
  assert.equal(overlap({ ...child, width: W, height: H }, { ...task, width: W, height: H }), false);
});

test("布局:高任务槽位撑高所在行,其他节点让位(下一行不与其重叠)", () => {
  const taskH = 232;
  const ids = ["main", "tasklist", "child_a", "child_b"];
  const parentOf = new Map<string, string | null>([
    ["main", null],
    ["tasklist", null],
    ["child_a", "main"],
    ["child_b", "main"],
  ]);
  const sizes = new Map([["tasklist", { width: W, height: taskH }]]);
  const result = computeLayout(ids, parentOf, W, H, GAP_X, GAP_Y, 1200, sizes);
  const task = { ...result.positions.get("tasklist")!, width: W, height: taskH };
  const childA = { ...result.positions.get("child_a")!, width: W, height: H };
  const childB = { ...result.positions.get("child_b")!, width: W, height: H };
  // 槽位在主 Agent 右侧同行,高 232:子节点行被撑到其下方,绝不重叠
  assert.equal(overlap(task, childA), false);
  assert.equal(overlap(task, childB), false);
  // 主 Agent 仍在槽位左侧同行
  const main = result.positions.get("main")!;
  assert.equal(result.positions.get("tasklist")!.y, main.y);
});

test("布局:折叠小图标尺寸(36×36)占独立小槽位,不影响行高", () => {
  const ids = ["main", "tasklist"];
  const parentOf = new Map<string, string | null>([
    ["main", null],
    ["tasklist", null],
  ]);
  const sizes = new Map([["tasklist", { width: 36, height: 36 }]]);
  const result = computeLayout(ids, parentOf, W, H, GAP_X, GAP_Y, 1200, sizes);
  const main = result.positions.get("main")!;
  const stub = result.positions.get("tasklist")!;
  assert.equal(stub.x, main.x + W + GAP_X);
  // 小图标垂直居中于行盒?布局以顶部对齐放置:y 与主 Agent 一致,不撑高画布
  assert.equal(stub.y, main.y);
  assert.equal(result.height, H);
});

test("布局:无 sizes 时行为与旧版完全一致(回归)", () => {
  const ids = ["r1", "r2", "c1"];
  const parentOf = new Map<string, string | null>([
    ["r1", null],
    ["r2", null],
    ["c1", "r1"],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_X, GAP_Y, 1200);
  const r1 = result.positions.get("r1")!;
  const c1 = result.positions.get("c1")!;
  // 子节点在父节点下一行,行距 = gapY
  assert.equal(c1.y, r1.y + H + GAP_Y);
  // 两个根同行排列
  assert.equal(result.positions.get("r2")!.y, r1.y);
});
