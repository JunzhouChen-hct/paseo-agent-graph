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
const GAP_COL = 52;
const GAP_ROW = 26;

test("布局:根在第 1 列,子在第 2 列,孙在第 3 列,整树向右延伸", () => {
  const ids = ["main", "child", "grand"];
  const parentOf = new Map<string, string | null>([
    ["main", null],
    ["child", "main"],
    ["grand", "child"],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_COL, GAP_ROW);
  const main = result.positions.get("main")!;
  const child = result.positions.get("child")!;
  const grand = result.positions.get("grand")!;
  assert.equal(child.x, main.x + W + GAP_COL);
  assert.equal(grand.x, child.x + W + GAP_COL);
  // 单子向父收拢:垂直中心对齐
  assert.equal(child.y, main.y);
  assert.equal(grand.y, child.y);
  assert.equal(result.width, 3 * W + 2 * GAP_COL);
});

test("布局:多个根竖直堆叠在第 1 列,行距 = gapRow", () => {
  const ids = ["r1", "r2", "r3"];
  const parentOf = new Map<string, string | null>([
    ["r1", null],
    ["r2", null],
    ["r3", null],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_COL, GAP_ROW);
  const r1 = result.positions.get("r1")!;
  const r2 = result.positions.get("r2")!;
  const r3 = result.positions.get("r3")!;
  assert.equal(r1.x, 0);
  assert.equal(r2.x, 0);
  assert.equal(r3.x, 0);
  assert.equal(r2.y, r1.y + H + GAP_ROW);
  assert.equal(r3.y, r2.y + H + GAP_ROW);
  assert.equal(result.height, 3 * H + 2 * GAP_ROW);
});

test("布局:兄弟块向父收拢(列内无冲突时与父垂直中心对齐)", () => {
  // 列0: r1, r2, r3;列1: 仅 r2 有两个子 → 子块收拢到 r2 中心
  const ids = ["r1", "r2", "r3", "k1", "k2"];
  const parentOf = new Map<string, string | null>([
    ["r1", null],
    ["r2", null],
    ["r3", null],
    ["k1", "r2"],
    ["k2", "r2"],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_COL, GAP_ROW);
  const r2 = result.positions.get("r2")!;
  const k1 = result.positions.get("k1")!;
  const k2 = result.positions.get("k2")!;
  // 块高 2H+gapRow,期望起点 = r2 中心 - 块高/2 = r2.y + H/2 - (2H+GAP_ROW)/2
  const desired = r2.y + H / 2 - (2 * H + GAP_ROW) / 2;
  // 上方无卡片 → minAllowed = 0;期望起点若 < 0 则夹到 0
  const expected = Math.max(desired, 0);
  assert.equal(k1.y, expected);
  assert.equal(k2.y, expected + H + GAP_ROW);
  assert.equal(overlap({ ...k1, width: W, height: H }, { ...k2, width: W, height: H }), false);
});

test("布局:收拢被上方卡片阻挡时不越界、保持零重叠", () => {
  // 列0: r1, r2;列1: c_a(r1 子)、k1/k2(r2 子):k 块想收拢到 r2 中心,
  // 但 c_a 在上方占据空间 → 只能停在 c_a 之下
  const ids = ["r1", "r2", "c_a", "k1", "k2"];
  const parentOf = new Map<string, string | null>([
    ["r1", null],
    ["r2", null],
    ["c_a", "r1"],
    ["k1", "r2"],
    ["k2", "r2"],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_COL, GAP_ROW);
  const cA = result.positions.get("c_a")!;
  const k1 = result.positions.get("k1")!;
  const k2 = result.positions.get("k2")!;
  assert.equal(k1.y, Math.max(cA.y + H + GAP_ROW, k1.y), "收拢不得越过上方卡片");
  assert.equal(overlap({ ...cA, width: W, height: H }, { ...k1, width: W, height: H }), false);
  assert.equal(overlap({ ...k1, width: W, height: H }, { ...k2, width: W, height: H }), false);
});

test("布局:任务列表伪节点作为兄弟槽位与目标同列竖直相邻,不重叠", () => {
  // 非根目标形态:伪节点插在目标之前 → 同列内位于目标上方
  const ids = ["root", "tasklist", "main", "child"];
  const parentOf = new Map<string, string | null>([
    ["root", null],
    ["main", "root"],
    ["tasklist", "root"],
    ["child", "main"],
  ]);
  const sizes = new Map<string, { width: number; height: number }>([
    ["tasklist", { width: 36, height: 36 }],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_COL, GAP_ROW, sizes);
  const main = result.positions.get("main")!;
  const task = result.positions.get("tasklist")!;
  const child = result.positions.get("child")!;
  // root 在第 1 列;main/tasklist(其子)同列,按 ids 顺序堆叠
  assert.equal(main.x, W + GAP_COL);
  assert.equal(task.x, main.x);
  assert.equal(task.y, main.y - 36 - GAP_ROW, "伪节点在目标正上方,间距 = gapRow");
  assert.equal(child.x, main.x + W + GAP_COL, "子节点在下一列");
  assert.equal(overlap({ ...main, width: W, height: H }, { ...task, width: 36, height: 36 }), false);
  assert.equal(overlap({ ...child, width: W, height: H }, { ...task, width: 36, height: 36 }), false);
  // 窄伪节点不撑宽列:列宽仍由主 Agent 决定
  assert.equal(result.width, 3 * W + 2 * GAP_COL);
});

test("布局:孤儿(父不在图中)提升为根,落在第 1 列;纯环提升一个代表,其余挂其下", () => {
  const ids = ["main", "orphan", "cyc_a", "cyc_b"];
  const parentOf = new Map<string, string | null>([
    ["main", null],
    ["orphan", "ghost"],
    ["cyc_a", "cyc_b"],
    ["cyc_b", "cyc_a"],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_COL, GAP_ROW);
  const main = result.positions.get("main")!;
  const orphan = result.positions.get("orphan")!;
  const cycA = result.positions.get("cyc_a")!;
  const cycB = result.positions.get("cyc_b")!;
  // main / orphan / cyc_a 均被提升为根,竖直堆叠在第 1 列
  assert.equal(orphan.y, main.y + H + GAP_ROW);
  assert.equal(cycA.y, orphan.y + H + GAP_ROW);
  // 环的另一个成员作为 cyc_a 的子挂在下一列(与旧版环兜底语义一致)
  assert.equal(cycB.x, cycA.x + W + GAP_COL);
});

test("布局:无 sizes 时全部节点统一尺寸(回归)", () => {
  const ids = ["r1", "c1", "c2"];
  const parentOf = new Map<string, string | null>([
    ["r1", null],
    ["c1", "r1"],
    ["c2", "r1"],
  ]);
  const result = computeLayout(ids, parentOf, W, H, GAP_COL, GAP_ROW);
  const r1 = result.positions.get("r1")!;
  const c1 = result.positions.get("c1")!;
  const c2 = result.positions.get("c2")!;
  // 两个子收拢到父中心:块高 2H+gapRow,期望起点 < 0 → 夹 0
  assert.equal(c1.y, 0);
  assert.equal(c2.y, H + GAP_ROW);
  assert.equal(r1.x, 0);
  assert.equal(c1.x, W + GAP_COL);
  assert.equal(result.width, 2 * W + GAP_COL);
});
