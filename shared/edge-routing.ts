/**
 * 边正交避障路由纯逻辑(横向语义,配合层级列布局):连线一律为清晰的
 * 正交折线(无贝塞尔/圆弧),从父卡片右缘流出、子卡片左缘流入。
 * 候选按优先级裁决,首个可行者胜出,不做全局最短比较:
 * 1) 同行直连(父/子 y 对齐);
 * 2) 列间台阶——竖直段走父列与子列之间的列间通道(布局保证通道内无卡片),
 *    竖直段的 x 可由调用方按边分配车道(laneXs),同父多边不共线;
 * 3) 跨列水平通道——仅当列间台阶被障碍(异常布局/挂载物)封死时,穿过
 *    列内卡片行之间的水平空隙(gapRow),按距 from/to 中线近远排序;
 * 4) 外侧绕行——障碍簇上/下极外,仅中间无通道可行时;
 * 全部候选逐段做膨胀矩形碰撞校验,全部失败退回正交直连并标记 degraded。
 * 不依赖 React / React Native,可被 client 与 tests 共用。
 */

import { buildPolylinePath, type Point, type SampledPath } from "./edge-geometry.ts";

/** 障碍矩形(卡片槽位),坐标系与布局画布一致 */
export interface ObstacleRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 避障裕量:呼吸框(3,画在卡片边界外 3px)+ 流点半径(2.5)+ 0.5 残差。
 * 与旧竖向布局一致的取值:列内行距 gapRow=18(窄面板)下水平通道仍有
 * 6px 通行宽度,恰好容纳 2px 线与 5px 流点且不碰呼吸框。
 */
export const ROUTE_MARGIN = 6;

/** 跨列边出/入口在列间通道内的车道偏移(px):贴父/子 12px,留出直连空间 */
const LANE_OFFSET = 12;
/** 水平通道候选上限(按距中线近远排序后截取) */
const MAX_CHANNEL_CANDIDATES = 6;
/**
 * 外侧走廊额外净空(px):走廊放在"膨胀边界再外移"处。
 * segmentIntersectsRect 把边界接触也算碰撞,贴着膨胀边界的走廊会撞障碍簇。
 */
const CORRIDOR_CLEARANCE = 2;

export interface PlannedEdgePath {
  /** 路径航点(拐点,首尾为 from/to) */
  waypoints: Point[];
  /** 采样路径(即航点折线本身);静态线与流点渲染必须消费同一份对象 */
  sampled: SampledPath;
  /** true = 无绕行(直连或列间台阶);false = 经过通道/外侧绕行 */
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

/**
 * 计算水平跨度 (xLo,xHi) 上、y 区间 [yLo,yHi] 内无障碍遮挡的自由 y 带
 * (膨胀后):收集 x 范围与该水平跨度相交的障碍 y 区间,排序合并后取补集。
 * 用于寻找穿过中间列卡片行之间的水平通道(卡片之间的行间空隙)。
 */
export function freeYBands(
  yLo: number,
  yHi: number,
  xA: number,
  xB: number,
  obstacles: readonly ObstacleRect[],
  margin: number,
): Array<[number, number]> {
  const xLo = Math.min(xA, xB);
  const xHi = Math.max(xA, xB);
  const intervals: Array<[number, number]> = [];
  for (const rect of obstacles) {
    const box = inflate(rect, margin);
    if (box.x + box.width <= xLo || box.x >= xHi) continue;
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
function channelYs(bands: ReadonlyArray<[number, number]>, desired: number): number[] {
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

/** 跨列绕行的统一形态:出口车道 → 水平走廊 → 入口车道 → 目标 */
function viaHorizontalCorridor(from: Point, to: Point, cy: number, xA: number, xB: number): Point[] {
  return [from, { x: xA, y: from.y }, { x: xA, y: cy }, { x: xB, y: cy }, { x: xB, y: to.y }, to];
}

/**
 * 规划一条边的正交路径(候选按优先级,首个可行者胜出):
 * 1) 同行直连;2) 列间台阶(竖直段走父/子列之间的通道,车道 x 由
 * opts.laneXs 指定,未指定时取中点);3) 跨列水平通道(卡片行间空隙,
 * 近中线优先);4) 外侧极外绕行(仅必要时);5) 全部失败退回正交直连,
 * 标记 degraded 供上层诊断。
 * obstacles 必须不含该边两端各自的卡片(端点在卡片边界上,膨胀后必相交)。
 */
export function planEdgePath(
  from: Point,
  to: Point,
  obstacles: readonly ObstacleRect[],
  opts?: { margin?: number; laneXs?: readonly number[] },
): PlannedEdgePath {
  const margin = opts?.margin ?? ROUTE_MARGIN;
  const feasible = (waypoints: readonly Point[]): SampledPath | null =>
    polylineHitsRects(waypoints, obstacles, margin) === null ? buildPolylinePath(waypoints) : null;

  // 兜底形状(degraded 时同样保持正交形态,不画错不消失)
  const aligned = Math.abs(from.y - to.y) < 0.5;
  const midX = (from.x + to.x) / 2;
  const fallbackWaypoints: Point[] = aligned
    ? [from, to]
    : [
        from,
        { x: midX, y: from.y },
        { x: midX, y: to.y },
        to,
      ];

  // 1) 同行直连 / 2) 列间台阶(竖直段走列间通道,车道 x 逐个尝试)
  const laneCandidates: number[] = [];
  for (const lane of opts?.laneXs ?? []) {
    if (!laneCandidates.some((value) => Math.abs(value - lane) < 0.5)) laneCandidates.push(lane);
  }
  if (!laneCandidates.some((value) => Math.abs(value - midX) < 0.5)) laneCandidates.push(midX);
  for (const lane of laneCandidates) {
    const waypoints: Point[] = aligned
      ? [from, to]
      : [
          from,
          { x: lane, y: from.y },
          { x: lane, y: to.y },
          to,
        ];
    const sampled = feasible(waypoints);
    if (sampled) {
      return { waypoints, sampled, direct: true, degraded: false };
    }
  }

  // 跨列:在列间带内取车道,穿水平通道或绕外侧
  if (Math.abs(to.x - from.x) >= LANE_OFFSET * 2 + 1) {
    const xA = from.x < to.x ? from.x + LANE_OFFSET : from.x - LANE_OFFSET;
    const xB = from.x < to.x ? to.x - LANE_OFFSET : to.x + LANE_OFFSET;
    const desired = (from.y + to.y) / 2;

    // 3) 水平通道:穿过中间列卡片行之间的空隙(gapRow),近中线优先。
    //    搜索范围限定为与水平跨度相交的障碍簇 y 跨度 → 候选全是卡片之间的
    //    内部空隙,不混入簇外区域(外侧绕行只走第 4 步)。
    const crossing = obstacles.filter((rect) => {
      const box = inflate(rect, margin);
      return box.x + box.width > Math.min(xA, xB) && box.x < Math.max(xA, xB);
    });
    if (crossing.length > 0) {
      const cLo = Math.min(...crossing.map((rect) => rect.y));
      const cHi = Math.max(...crossing.map((rect) => rect.y + rect.height));
      const bands = freeYBands(cLo, cHi, xA, xB, obstacles, margin);
      for (const cy of channelYs(bands, desired)) {
        const waypoints = viaHorizontalCorridor(from, to, cy, xA, xB);
        const sampled = feasible(waypoints);
        if (sampled) return { waypoints, sampled, direct: false, degraded: false };
      }
    }

    // 4) 外侧:仅当中间无通道可行;上/下都能走时取总长更短的一侧
    let byTop = Math.min(from.y, to.y);
    let byBottom = Math.max(from.y, to.y);
    for (const rect of obstacles) {
      byTop = Math.min(byTop, rect.y);
      byBottom = Math.max(byBottom, rect.y + rect.height);
    }
    byTop -= margin + CORRIDOR_CLEARANCE;
    byBottom += margin + CORRIDOR_CLEARANCE;
    let best: { waypoints: Point[]; sampled: SampledPath } | null = null;
    for (const by of [byTop, byBottom]) {
      if (by < 1) continue; // 画布上界保护:y<0 的走廊会被裁掉
      const waypoints = viaHorizontalCorridor(from, to, by, xA, xB);
      const sampled = feasible(waypoints);
      if (!sampled) continue;
      if (!best || pathLength(waypoints) < pathLength(best.waypoints)) {
        best = { waypoints, sampled };
      }
    }
    if (best) return { waypoints: best.waypoints, sampled: best.sampled, direct: false, degraded: false };
  }

  return {
    waypoints: fallbackWaypoints,
    sampled: buildPolylinePath(fallbackWaypoints),
    direct: true,
    degraded: true,
  };
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
