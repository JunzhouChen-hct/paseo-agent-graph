/**
 * 边避障路由纯逻辑:直连贝塞尔优先;碰撞时先试单拐肘(自由水平通道),
 * 再试绕阻挡簇左侧/右侧的双拐肘;所有候选路径逐段做膨胀矩形碰撞校验,
 * 全部失败退回直连(不比旧基线差)。绕行路径为正交航点 + 原生圆角
 * (buildPathCurve 采样真实圆弧),静态线与流点消费同一份采样。
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
/** 侧向走廊候选上限(局部外沿逐个 + 全局极外侧) */
const MAX_SIDE_CANDIDATES = 6;

export interface PlannedEdgePath {
  /** 路径航点(拐点,首尾为 from/to) */
  waypoints: Point[];
  /** 圆角采样路径;静态线与流点渲染必须消费同一份对象 */
  sampled: SampledPath;
  /** true = 无碰撞直连贝塞尔(含兜底);false = 绕行路径 */
  direct: boolean;
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

/** 从自由带中取通道 y 候选:每带夹取到最接近 desired 的位置,去重限量 */
function channelCandidates(
  bands: ReadonlyArray<[number, number]>,
  desired: number,
): number[] {
  const picked: number[] = [];
  for (const [start, end] of bands) {
    const y = Math.min(Math.max(desired, start + 0.5), end - 0.5);
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
 * bx 候选:阻挡簇逐个外沿 + 全局极外侧(局部外沿外可能还有其他卡片,
 * 不是保证可通的走廊),各候选先检查 bx 竖直走廊,再对 yA/yB 通道
 * 组合整体逐段校验,取总长最短的可行路径。
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
  const corridorYs = [
    Math.min(from.y, to.y) - 1,
    Math.max(from.y, to.y) + 1,
  ];

  // bx 候选:右=各阻挡簇右外沿与全局最右;左=各阻挡簇左外沿与全局最左
  const bxCandidates: number[] = [];
  if (side === "right") {
    const edges = blockers.map((b) => b.x + b.width);
    edges.push(...obstacles.map((b) => b.x + b.width));
    bxCandidates.push(...[...new Set(edges)].sort((a, b) => a - b).map((edge) => edge + margin + CORRIDOR_CLEARANCE));
    bxCandidates.push(Math.max(...obstacles.map((b) => b.x + b.width), from.x, to.x) + margin + CORRIDOR_CLEARANCE);
  } else {
    const edges = blockers.map((b) => b.x);
    edges.push(...obstacles.map((b) => b.x));
    bxCandidates.push(
      ...[...new Set(edges)].sort((a, b) => b - a).map((edge) => edge - margin - CORRIDOR_CLEARANCE),
    );
    bxCandidates.push(Math.min(...obstacles.map((b) => b.x), from.x, to.x) - margin - CORRIDOR_CLEARANCE);
  }
  const seenBx = new Set<number>();
  const uniqueBx = bxCandidates.filter((bx) => {
    const key = Math.round(bx * 100) / 100;
    if (seenBx.has(key) || bx < margin) return false;
    seenBx.add(key);
    return true;
  });

  const yLo = Math.min(from.y, to.y) + MIN_STUB;
  const yHi = Math.max(from.y, to.y) - MIN_STUB;
  if (yHi - yLo < MIN_STUB) return null;

  const downward = to.y >= from.y;
  const yADesired = from.y + (downward ? STUB : -STUB);
  const yBDesired = to.y - (downward ? STUB : -STUB);

  let best: Point[] | null = null;
  let bestLength = Infinity;
  let checked = 0;
  for (const bx of uniqueBx) {
    if (checked >= MAX_SIDE_CANDIDATES) break;
    checked += 1;
    // bx 竖直走廊全程无障碍(端点在膨胀矩形内即算碰撞,向上下各延 1px 保守检查)
    if (
      polylineHitsRects(
        [
          { x: bx, y: corridorYs[0]! },
          { x: bx, y: corridorYs[1]! },
        ],
        obstacles,
        margin,
      ) !== null
    ) {
      continue;
    }
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
        const length = sampled.total;
        if (length < bestLength) {
          bestLength = length;
          best = waypoints;
        }
      }
    }
    if (best) break; // 已找到该侧最短可行(候选按外沿从近到远,首个成功即该侧最短)
  }
  return best;
}

/**
 * 规划一条边的路径:
 * 1) 直连贝塞尔逐段碰撞检查,无碰撞直接用;
 * 2) 碰撞时依次尝试单拐肘、右双拐肘、左双拐肘,取总长最短的可行绕行;
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
    return { waypoints: [from, to], sampled: direct, direct: true };
  }
  const curve = buildEdgeCurve(from, to);
  const blockers = obstacles.filter(
    (rect) => polylineHitsRects(curve.points, [rect], margin) !== null,
  );
  // 候选统一"航点采样 + 圆角路径整体碰撞校验",取采样总长最短者
  const candidates: Point[][] = [];
  const elbow = tryElbow(from, to, obstacles, margin);
  if (elbow) candidates.push(elbow);
  const right = tryDoglegSide("right", from, to, blockers, obstacles, margin);
  if (right) candidates.push(right);
  const left = tryDoglegSide("left", from, to, blockers, obstacles, margin);
  if (left) candidates.push(left);
  if (candidates.length === 0) {
    // 兜底:直连(保持旧行为,不画错不消失;树布局下通道绕行一般总能成功)
    return { waypoints: [from, to], sampled: curve, direct: true };
  }
  let bestWaypoints = candidates[0]!;
  let bestSampled = buildPathCurve(bestWaypoints, filletRadius);
  let bestLength = bestSampled.total;
  for (const waypoints of candidates) {
    const sampled = buildPathCurve(waypoints, filletRadius);
    if (polylineHitsRects(sampled.points, obstacles, margin) !== null) continue;
    if (sampled.total < bestLength) {
      bestLength = sampled.total;
      bestWaypoints = waypoints;
      bestSampled = sampled;
    }
  }
  return { waypoints: bestWaypoints, sampled: bestSampled, direct: false };
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
