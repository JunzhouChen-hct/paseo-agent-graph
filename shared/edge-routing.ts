/**
 * 边避障路由纯逻辑:直连贝塞尔优先;碰撞时依次尝试单拐肘、
 * 双拐肘(阻挡簇外沿候选 + 全局极外侧)、局部正交 visibility 网格搜索;
 * 全部路径逐段做膨胀矩形碰撞校验(含圆角采样后整体复验),
 * 全部失败退回直连(不比旧基线差)。绕行路径为正交航点 + 原生圆弧圆角,
 * 静态线与流点消费同一份采样。
 * 不依赖 React / React Native,可被 client 与 tests 共用。
 */

import { buildEdgeCurve, buildPathCurve, type Point, type SampledPath } from "./edge-geometry";

/** 障碍矩形(卡片槽位),坐标系与布局画布一致 */
export interface ObstacleRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 避障裕量:流点半径(2.5) + 呼吸框(3) + 视觉与采样残差余量。
 * 呼吸框绘制在卡片边界外侧 3px,裕量必须覆盖它。
 */
export const ROUTE_MARGIN = 12;

/** 绕行路径拐角圆角半径(px);直段不足时自动收缩 */
export const BYPASS_FILLET_RADIUS = 14;

/** 出/入口处的竖直小段长度(px),保持出线/入线切线竖直 */
const STUB = 16;
/** 每侧最多尝试的通道候选数 */
const MAX_CHANNEL_CANDIDATES = 6;
/** 航点最小间隔(px):比它短的出/入竖直段不设 */
const MIN_STUB = 4;
/**
 * 走廊额外净空(px):绕行竖直走廊放在"膨胀边界再外移"处。
 * segmentIntersectsRect 把边界接触也算碰撞,bx 恰在膨胀矩形边界上
 * 会撞自身阻挡簇,因此必须再留一份净空。
 */
const CORRIDOR_CLEARANCE = 2;
/** 侧向走廊候选上限(约束过滤后的外沿 + 全局极外侧) */
const MAX_SIDE_CANDIDATES = 6;
/** visibility 网格节点数上限,超出放弃(退回直连) */
const VISIBILITY_MAX_NODES = 6000;
/** visibility 局部障碍集的 x 向外扩(px,约一张卡宽 + 裕量) */
const VISIBILITY_PAD = 260;

export interface PlannedEdgePath {
  /** 路径航点(拐点,首尾为 from/to) */
  waypoints: Point[];
  /** 圆角采样路径;静态线与流点渲染必须消费同一份对象 */
  sampled: SampledPath;
  /** true = 直连贝塞尔;false = 绕行路径 */
  direct: boolean;
  /**
   * true = 直连但已知与障碍碰撞(所有绕行策略全部失败后的兜底)。
   * 正常布局下必须为 0;非 0 说明该边会穿过卡片,需要通过 debug
   * payload 暴露出来诊断,而不是静默画错。
   */
  degraded: boolean;
}

function inflate(rect: ObstacleRect, margin: number): ObstacleRect {
  return {
    id: rect.id,
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

/**
 * 线段与矩形是否相交(Liang-Barsky 参数裁剪 + 端点在内部判定)。
 * 端点恰在矩形边界上视为相交(路径贴边穿行不允许)。
 */
export function segmentIntersectsRect(a: Point, b: Point, rect: ObstacleRect): boolean {
  const inside = (p: Point) =>
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
  if (inside(a) || inside(b)) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x - rect.x) &&
    clip(dx, rect.x + rect.width - a.x) &&
    clip(-dy, a.y - rect.y) &&
    clip(dy, rect.y + rect.height - a.y)
  );
}

/** 折线逐段碰撞检查;返回第一个被撞的障碍 id,无碰撞返回 null */
export function polylineHitsRects(
  points: readonly Point[],
  rects: readonly ObstacleRect[],
  margin: number,
): string | null {
  for (const rect of rects) {
    const box = inflate(rect, margin);
    for (let i = 1; i < points.length; i++) {
      if (segmentIntersectsRect(points[i - 1]!, points[i]!, box)) return rect.id;
    }
  }
  return null;
}

function pathLength(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return length;
}

/** 直连贝塞尔与障碍无碰撞时返回其采样路径,否则 null */
function tryDirect(
  from: Point,
  to: Point,
  obstacles: readonly ObstacleRect[],
  margin: number,
): SampledPath | null {
  const curve = buildEdgeCurve(from, to);
  if (polylineHitsRects(curve.points, obstacles, margin) === null) return curve;
  return null;
}

/**
 * 计算 x 区间 [xa,xb] 内无障碍遮挡的自由 y 带宽(膨胀后):
 * 收集与该 x 区间相交的障碍 y 区间,排序合并后取 [yLo,yHi] 内的补集。
 */
export function freeYBands(
  xa: number,
  xb: number,
  yLo: number,
  yHi: number,
  obstacles: readonly ObstacleRect[],
  margin: number,
): Array<[number, number]> {
  const lo = Math.min(xa, xb);
  const hi = Math.max(xa, xb);
  const intervals: Array<[number, number]> = [];
  for (const rect of obstacles) {
    const box = inflate(rect, margin);
    if (box.x + box.width <= lo || box.x >= hi) continue;
    intervals.push([box.y, box.y + box.height]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const bands: Array<[number, number]> = [];
  let cursor = yLo;
  for (const [start, end] of merged) {
    if (start > cursor) bands.push([cursor, Math.min(start, yHi)]);
    cursor = Math.max(cursor, end);
    if (cursor >= yHi) break;
  }
  if (cursor < yHi) bands.push([cursor, yHi]);
  return bands.filter(([start, end]) => end - start > 0.5);
}

/** 从自由带中取通道 y 候选:每带夹取到最接近 desired 的位置,按距 desired 近远排序限量 */
function channelCandidates(bands: ReadonlyArray<[number, number]>, desired: number): number[] {
  const all: number[] = [];
  for (const [start, end] of bands) {
    all.push(Math.min(Math.max(desired, start + 0.5), end - 0.5));
  }
  all.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
  const picked: number[] = [];
  for (const y of all) {
    if (!picked.some((value) => Math.abs(value - y) < 0.5)) picked.push(y);
    if (picked.length >= MAX_CHANNEL_CANDIDATES) break;
  }
  return picked;
}

/** 单拐肘:from → (from.x, y) → (to.x, y) → to,水平通道横穿 from.x..to.x */
function tryElbow(
  from: Point,
  to: Point,
  obstacles: readonly ObstacleRect[],
  margin: number,
): Point[] | null {
  const yLo = Math.min(from.y, to.y) + MIN_STUB;
  const yHi = Math.max(from.y, to.y) - MIN_STUB;
  if (yHi - yLo < MIN_STUB) return null;
  const xa = Math.min(from.x, to.x);
  const xb = Math.max(from.x, to.x);
  const desired = (from.y + to.y) / 2;
  let best: Point[] | null = null;
  let bestLength = Infinity;
  for (const y of channelCandidates(freeYBands(xa, xb, yLo, yHi, obstacles, margin), desired)) {
    const waypoints: Point[] = [from, { x: from.x, y }, { x: to.x, y }, to];
    if (polylineHitsRects(waypoints, obstacles, margin) !== null) continue;
    const length = pathLength(waypoints);
    if (length < bestLength) {
      bestLength = length;
      best = waypoints;
    }
  }
  return best;
}

/**
 * 双拐肘绕行:from → (from.x, yA) → (bx, yA) → (bx, yB) → (to.x, yB) → to。
 * bx 候选按"阻挡簇约束外沿(就近优先)+ 全局极外侧"生成;全局极外候选
 * 不受候选数上限影响,始终被尝试。走廊与通道不预剪枝(全跨度检查会
 * 误杀 yA/yB 实际跨度内可行的情况),全部交由 per 组合的整体校验裁决。
 * 首个产出可行路径的 bx 即该侧最短(走廊越近路径越短)。
 */
function tryDoglegSide(
  side: "left" | "right",
  from: Point,
  to: Point,
  blockers: readonly ObstacleRect[],
  obstacles: readonly ObstacleRect[],
  margin: number,
): Point[] | null {
  if (blockers.length === 0) return null;
  const constraint =
    side === "right"
      ? Math.max(...blockers.map((b) => b.x + b.width), from.x, to.x) + margin + CORRIDOR_CLEARANCE
      : Math.min(...blockers.map((b) => b.x), from.x, to.x) - margin - CORRIDOR_CLEARANCE;

  // 候选 bx:约束之外的外沿,按远离阻挡簇方向排序;全局极外侧恒在末尾
  const raw =
    side === "right"
      ? [...blockers, ...obstacles].map((b) => b.x + b.width + margin + CORRIDOR_CLEARANCE)
      : [...blockers, ...obstacles].map((b) => b.x - margin - CORRIDOR_CLEARANCE);
  const sorted = [...new Set(raw)].sort((a, b) => (side === "right" ? a - b : b - a));
  const globalBx =
    side === "right"
      ? Math.max(...obstacles.map((b) => b.x + b.width), from.x, to.x) + margin + CORRIDOR_CLEARANCE
      : Math.min(...obstacles.map((b) => b.x), from.x, to.x) - margin - CORRIDOR_CLEARANCE;
  // 画布左界保护:x < margin 的走廊会被画布裁掉,左绕只在界内有效
  const near = sorted.filter((bx) =>
    side === "right" ? bx >= constraint && bx >= margin : bx <= constraint && bx >= margin,
  );
  const ordered = globalBx >= margin ? [...near, globalBx] : near;

  const yLo = Math.min(from.y, to.y) + MIN_STUB;
  const yHi = Math.max(from.y, to.y) - MIN_STUB;
  if (yHi - yLo < MIN_STUB) return null;

  const downward = to.y >= from.y;
  const yADesired = from.y + (downward ? STUB : -STUB);
  const yBDesired = to.y - (downward ? STUB : -STUB);

  let best: Point[] | null = null;
  let checked = 0;
  for (const bx of ordered) {
    // 上限只约束就近候选;末尾的全局极外候选恒被尝试
    if (bx !== globalBx && checked >= MAX_SIDE_CANDIDATES) break;
    checked += 1;
    const yAs = channelCandidates(
      freeYBands(Math.min(from.x, bx), Math.max(from.x, bx), yLo, yHi, obstacles, margin),
      yADesired,
    );
    const yBs = channelCandidates(
      freeYBands(Math.min(to.x, bx), Math.max(to.x, bx), yLo, yHi, obstacles, margin),
      yBDesired,
    );
    for (const yA of yAs) {
      for (const yB of yBs) {
        const waypoints: Point[] = [
          from,
          { x: from.x, y: yA },
          { x: bx, y: yA },
          { x: bx, y: yB },
          { x: to.x, y: yB },
          to,
        ];
        // 先验航点,再验圆角采样(圆角会向拐角内侧切入,必须整体验证)
        if (polylineHitsRects(waypoints, obstacles, margin) !== null) continue;
        const sampled = buildPathCurve(waypoints, BYPASS_FILLET_RADIUS);
        if (polylineHitsRects(sampled.points, obstacles, margin) !== null) continue;
        if (best === null || sampled.total < pathLength(best)) {
          best = waypoints;
        }
      }
    }
    if (best) break; // 该侧已得最短可行路径(候选就近优先)
  }
  return best;
}

/**
 * 局部正交 visibility 网格搜索:在边的影响范围内,以障碍外沿 ±(裕量+0.5)
 * 与两端点坐标为候选走廊线,自由格点构图(相邻格点线段无碰撞才连边),
 * Dijkstra 找最短正交路径;起点只向下出发、终点只从上方进入,
 * 保证出/入口切线竖直。行带不对齐、简单绕行全部失败时的可靠兜底。
 */
function tryVisibilityRoute(
  from: Point,
  to: Point,
  obstacles: readonly ObstacleRect[],
  margin: number,
): Point[] | null {
  const downward = to.y >= from.y;
  const loX = Math.min(from.x, to.x) - VISIBILITY_PAD;
  const hiX = Math.max(from.x, to.x) + VISIBILITY_PAD;
  const loY = Math.min(from.y, to.y);
  const hiY = Math.max(from.y, to.y);
  const local = obstacles.filter(
    (rect) => rect.x + rect.width >= loX && rect.x <= hiX && rect.y + rect.height >= loY && rect.y <= hiY,
  );

  // 候选走廊:障碍外沿 ±(margin+0.5)(保证 0.5px 在膨胀边界外)与两端点
  const xs = new Set<number>([from.x, to.x]);
  const ys = new Set<number>([from.y, to.y]);
  for (const rect of local) {
    const leftX = rect.x - margin - 0.5;
    const rightX = rect.x + rect.width + margin + 0.5;
    if (leftX >= 0 && leftX >= loX - 50 && leftX <= hiX + 50) xs.add(leftX);
    if (rightX >= loX - 50 && rightX <= hiX + 50) xs.add(rightX);
    const topY = rect.y - margin - 0.5;
    const bottomY = rect.y + rect.height + margin + 0.5;
    if (topY > loY && topY < hiY) ys.add(topY);
    if (bottomY > loY && bottomY < hiY) ys.add(bottomY);
  }
  const xList = [...xs].sort((a, b) => a - b);
  const yList = [...ys].sort((a, b) => a - b);
  if (xList.length * yList.length > VISIBILITY_MAX_NODES) return null;

  const free = (x: number, y: number): boolean =>
    !local.some(
      (rect) =>
        x >= rect.x - margin &&
        x <= rect.x + rect.width + margin &&
        y >= rect.y - margin &&
        y <= rect.y + rect.height + margin,
    );

  const nx = xList.length;
  const ny = yList.length;
  const nodeId = (ix: number, iy: number): number => ix * ny + iy;
  const indexOf = (list: number[], value: number): number => {
    const found = list.findIndex((v) => Math.abs(v - value) < 1e-6);
    return found;
  };

  const segFree = (a: Point, b: Point): boolean => polylineHitsRects([a, b], local, margin) === null;

  // Dijkstra(小图,简单数组堆即可)
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  const push = (id: number, d: number) => {
    const current = dist.get(id);
    if (current === undefined || d < current) dist.set(id, d);
  };

  // 种子:from 竖直向下到最近的可行格点(可传递,只连最近一个)
  const startIx = indexOf(xList, from.x);
  if (startIx < 0) return null;
  {
    const dirY = downward ? 1 : -1;
    for (let iy = 0; iy < ny; iy++) {
      const y = yList[iy]!;
      if ((downward && y <= from.y + MIN_STUB) || (!downward && y >= from.y - MIN_STUB)) continue;
      if (!free(from.x, y)) continue;
      if (!segFree(from, { x: from.x, y })) continue;
      push(nodeId(startIx, iy), Math.abs(y - from.y));
      break; // 最近即可,更远的经它可达
    }
  }

  const heuristic = (ix: number, iy: number): number =>
    Math.abs(xList[ix]! - to.x) + Math.abs(yList[iy]! - to.y);

  let goalId = -1;
  while (visited.size < nx * ny) {
    // 取未访问最小 dist + heuristic(A* 风格)
    let bestId = -1;
    let bestKey = Infinity;
    for (const [id, d] of dist) {
      if (visited.has(id)) continue;
      const key = d + heuristic(Math.floor(id / ny), id % ny);
      if (key < bestKey) {
        bestKey = key;
        bestId = id;
      }
    }
    if (bestId < 0) break;
    visited.add(bestId);
    const ix = Math.floor(bestId / ny);
    const iy = bestId % ny;
    const point: Point = { x: xList[ix]!, y: yList[iy]! };

    // 终点检查:to.x 列上,可从当前点竖直到达 to
    if (point.x === to.x) {
      if (segFree(point, to)) {
        goalId = bestId;
        break;
      }
    }

    // 四方向相邻格点
    for (const [dIx, dIy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const jx = ix + dIx;
      const jy = iy + dIy;
      if (jx < 0 || jx >= nx || jy < 0 || jy >= ny) continue;
      const nextId = nodeId(jx, jy);
      if (visited.has(nextId)) continue;
      const nextPoint: Point = { x: xList[jx]!, y: yList[jy]! };
      if (!free(nextPoint.x, nextPoint.y)) continue;
      if (!segFree(point, nextPoint)) continue;
      const step = Math.abs(nextPoint.x - point.x) + Math.abs(nextPoint.y - point.y);
      const candidate = (dist.get(bestId) ?? 0) + step;
      const existing = dist.get(nextId);
      if (existing === undefined || candidate < existing) {
        dist.set(nextId, candidate);
        prev.set(nextId, bestId);
      }
    }
  }

  if (goalId < 0) return null;
  // 回溯 + 压缩共线航点
  const gridPoints: Point[] = [];
  let cursor = goalId;
  while (cursor >= 0) {
    gridPoints.unshift({ x: xList[Math.floor(cursor / ny)]!, y: yList[cursor % ny]! });
    const up = prev.get(cursor);
    cursor = up === undefined ? -1 : up;
  }
  const waypoints: Point[] = [from, ...gridPoints, to];
  const compressed: Point[] = [];
  for (const point of waypoints) {
    const a = compressed[compressed.length - 2];
    const b = compressed[compressed.length - 1];
    if (a && b && (a.x === b.x || a.y === b.y) && (b.x === point.x || b.y === point.y) && (a.x === b.x) === (b.x === point.x) && (a.y === b.y) === (b.y === point.y)) {
      // a→b→point 同轴共线:丢弃中间点 b
      compressed[compressed.length - 1] = point;
      continue;
    }
    compressed.push(point);
  }
  return compressed.length >= 2 ? compressed : null;
}

/**
 * 规划一条边的路径:
 * 1) 直连贝塞尔逐段碰撞检查,无碰撞直接用;
 * 2) 碰撞时依次尝试单拐肘、左/右双拐肘、局部 visibility 网格搜索,
 *    取采样总长最短的可行绕行;
 * 3) 全部失败退回直连贝塞尔(与旧基线一致,不让边消失或画错)。
 * obstacles 必须不含该边两端各自的卡片(端点在卡片边界上,膨胀后必相交)。
 */
export function planEdgePath(
  from: Point,
  to: Point,
  obstacles: readonly ObstacleRect[],
  opts?: { margin?: number; filletRadius?: number },
): PlannedEdgePath {
  const margin = opts?.margin ?? ROUTE_MARGIN;
  const filletRadius = opts?.filletRadius ?? BYPASS_FILLET_RADIUS;
  const direct = tryDirect(from, to, obstacles, margin);
  if (direct) {
    return { waypoints: [from, to], sampled: direct, direct: true, degraded: false };
  }
  const curve = buildEdgeCurve(from, to);
  const blockers = obstacles.filter(
    (rect) => polylineHitsRects(curve.points, [rect], margin) !== null,
  );
  // 圆角会向拐角内侧切入,每个候选都以"圆角采样后整体无碰撞"为准
  const validate = (waypoints: readonly Point[]): SampledPath | null => {
    const sampled = buildPathCurve(waypoints, filletRadius);
    return polylineHitsRects(sampled.points, obstacles, margin) === null ? sampled : null;
  };

  let bestWaypoints: Point[] | null = null;
  let bestSampled: SampledPath | null = null;
  const consider = (waypoints: Point[] | null): void => {
    if (!waypoints) return;
    const sampled = validate(waypoints);
    if (!sampled) return;
    if (!bestSampled || sampled.total < bestSampled.total) {
      bestSampled = sampled;
      bestWaypoints = waypoints;
    }
  };

  consider(tryElbow(from, to, obstacles, margin));
  consider(tryDoglegSide("right", from, to, blockers, obstacles, margin));
  consider(tryDoglegSide("left", from, to, blockers, obstacles, margin));
  if (!bestWaypoints) {
    consider(tryVisibilityRoute(from, to, obstacles, margin));
  }
  if (!bestWaypoints || !bestSampled) {
    // 兜底:直连(与旧基线一致,不画错不消失)。标记 degraded 供上层诊断,
    // 正常布局下不应出现;非 0 的 degraded 计数必须从 debug payload 暴露。
    return { waypoints: [from, to], sampled: curve, direct: true, degraded: true };
  }
  return { waypoints: bestWaypoints, sampled: bestSampled, direct: false, degraded: false };
}

/** 多条规划路径的包围盒(用于扩展画布,防止绕行路径被 ScrollView 裁掉) */
export function routeBounds(paths: ReadonlyArray<SampledPath>): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const point of path.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
