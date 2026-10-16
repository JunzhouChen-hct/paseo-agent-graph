/**
 * 边曲线几何纯逻辑:贝塞尔/折线圆角路径的采样与弧长参数化、
 * 线段视图(供 RN View+rotate 绘制)、折线简化与同父出线点分配。
 * 不依赖 React / React Native,可被 client 与 tests 共用。
 */

export interface Point {
  x: number;
  y: number;
}

/** 采样后的路径:折线点、累计弧长(严格递增)、总弧长 */
export interface SampledPath {
  points: Point[];
  cumulative: number[];
  total: number;
}

/** 三次贝塞尔直连曲线 */
export interface EdgeCurve extends SampledPath {
  /** 曲线起点(父卡片底部出线点) */
  from: Point;
  /** 曲线终点(子卡片顶部中点) */
  to: Point;
  /** 三次贝塞尔控制点 */
  cp1: Point;
  cp2: Point;
}

/** 流点动画插值所需的 inputRange/outputRange(inputRange 严格递增) */
export interface FlowInterpolation {
  inputRange: number[];
  outputX: number[];
  outputY: number[];
}

/** 单个渲染线段:旋转矩形(圆头),锚定在线段中点 */
export interface SegmentView {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 旋转角度(度) */
  rotateDeg: number;
}

/** 弧长小于该值视为退化路径,不渲染流点 */
export const PATH_MIN_LENGTH = 0.5;
/** 累计弧长下限:保证插值 inputRange 严格递增 */
export const CUMULATIVE_EPS = 0.001;

/** 三次贝塞尔取点 */
export function cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function samplePoints(p0: Point, p1: Point, p2: Point, p3: Point, segments: number): Point[] {
  const list: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    list.push(cubicBezierPoint(p0, p1, p2, p3, i / segments));
  }
  return list;
}

function polylineLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return length;
}

/** 折线累计弧长;相邻重合点夹极小步进,保持严格递增 */
function cumulativeLengths(points: Point[]): number[] {
  const list = [0];
  for (let i = 1; i < points.length; i++) {
    const step = Math.max(
      Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y),
      CUMULATIVE_EPS,
    );
    list.push(list[i - 1]! + step);
  }
  return list;
}

/** 点到线段的最短距离(Douglas-Peucker 用) */
function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.min(Math.max(t, 0), 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * Douglas-Peucker 折线简化:在容差内合并共线采样点,
 * 大幅减少渲染线段数(接缝与视图数量同步下降),保留端点。
 */
export function simplifyPolyline(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo]!;
    const b = points[hi]!;
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = lo + 1; i < hi; i++) {
      const dist = pointSegmentDistance(points[i]!, a, b);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance && maxIndex > 0) {
      keep[maxIndex] = true;
      stack.push([lo, maxIndex], [maxIndex, hi]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/**
 * 构建“竖直切出”的三次贝塞尔直连曲线:两端切线均竖直,
 * 控制距离随垂直距离缩放并夹在 [20, 90]。
 * 采样后做 DP 简化(容差 0.4px):相邻简化段共享端点,
 * 配合圆头渲染即成圆角接缝(见 buildSegmentViews)。
 */
export function buildEdgeCurve(from: Point, to: Point): EdgeCurve {
  const dy = to.y - from.y;
  // 两端完全重合时控制距离取 0,曲线收敛为一点(全零长退化路径)
  const control =
    from.x === to.x && dy === 0 ? 0 : Math.min(90, Math.max(20, Math.abs(dy) * 0.45));
  const cp1: Point = { x: from.x, y: from.y + control };
  const cp2: Point = { x: to.x, y: to.y - control };

  // 先粗采样估弧长,再按目标段长(约 10px)决定正式采样数
  const estimate = samplePoints(from, cp1, cp2, to, 12);
  const approx = polylineLength(estimate);
  const segments = Math.min(64, Math.max(8, Math.ceil(approx / 10)));
  const raw = samplePoints(from, cp1, cp2, to, segments);
  const points = simplifyPolyline(raw, 0.4);
  const cumulative = cumulativeLengths(points);
  // 全零弧长(重合点)时夹一个极小值,保证 inputRange 严格递增不产生 NaN
  const total = cumulative[cumulative.length - 1] ?? 0;
  return { from, to, cp1, cp2, points, cumulative, total };
}

/**
 * 把路径航点(折线拐点)转成圆角采样路径:每个内拐角用二次贝塞尔圆角,
 * 直段保持直线。直线与圆角统一进 points/cumulative/total,
 * 渲染层(静态线与流点)消费同一份采样,保证流点严格贴线。
 * filletRadius 会被相邻直段长度收缩,直段过短时退化为尖角。
 */
export function buildPathCurve(waypoints: readonly Point[], filletRadius = 14): SampledPath {
  // 去掉连续重复点
  const pts: Point[] = [];
  for (const point of waypoints) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(point.x - prev.x, point.y - prev.y) > 1e-9) pts.push(point);
  }
  if (pts.length === 0) {
    return { points: [], cumulative: [], total: 0 };
  }
  if (pts.length === 1) {
    return { points: [pts[0]!, { ...pts[0]! }], cumulative: [0, CUMULATIVE_EPS], total: CUMULATIVE_EPS };
  }
  if (pts.length === 2) {
    return {
      points: [pts[0]!, pts[1]!],
      cumulative: cumulativeLengths([pts[0]!, pts[1]!]),
      total: Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y),
    };
  }

  const FILLET_SAMPLES = 8;
  const points: Point[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const corner = pts[i]!;
    const next = pts[i + 1]!;
    const inLeg = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLeg = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(filletRadius, inLeg / 2 - 0.01, outLeg / 2 - 0.01);
    if (radius <= 0.5) {
      points.push(corner); // 直段太短,保留尖角
      continue;
    }
    const inPoint: Point = {
      x: corner.x - ((corner.x - prev.x) / inLeg) * radius,
      y: corner.y - ((corner.y - prev.y) / inLeg) * radius,
    };
    const outPoint: Point = {
      x: corner.x + ((next.x - corner.x) / outLeg) * radius,
      y: corner.y + ((next.y - corner.y) / outLeg) * radius,
    };
    points.push(inPoint);
    const inDir: Point = { x: (corner.x - prev.x) / inLeg, y: (corner.y - prev.y) / inLeg };
    const outDir: Point = { x: (next.x - corner.x) / outLeg, y: (next.y - corner.y) / outLeg };
    const dot = inDir.x * outDir.x + inDir.y * outDir.y;
    if (Math.abs(dot) < 1e-9) {
      // 垂直拐角:采样真实圆弧(圆心 = 切点 + 出方向×半径),
      // 与原生圆角转弯渲染精确一致,流点消费同一弧线
      const center: Point = { x: inPoint.x + outDir.x * radius, y: inPoint.y + outDir.y * radius };
      const angle0 = Math.atan2(inPoint.y - center.y, inPoint.x - center.x);
      let delta = Math.atan2(outPoint.y - center.y, outPoint.x - center.x) - angle0;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      for (let s = 1; s <= FILLET_SAMPLES; s++) {
        const angle = angle0 + (delta * s) / FILLET_SAMPLES;
        points.push({
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        });
      }
    } else {
      // 非垂直拐角:二次贝塞尔圆角(控制点=拐角)
      for (let s = 1; s <= FILLET_SAMPLES; s++) {
        const t = s / FILLET_SAMPLES;
        const u = 1 - t;
        points.push({
          x: u * u * inPoint.x + 2 * u * t * corner.x + t * t * outPoint.x,
          y: u * u * inPoint.y + 2 * u * t * corner.y + t * t * outPoint.y,
        });
      }
    }
  }
  points.push(pts[pts.length - 1]!);

  const cumulative = cumulativeLengths(points);
  const total = cumulative[cumulative.length - 1] ?? 0;
  return { points, cumulative, total };
}

/**
 * 弧长 → 曲线上的点(线性插值,近似匀速)。s 越界时夹在 [0, total]。
 */
export function pointAtLength(path: SampledPath, s: number): Point {
  const total = path.total;
  const clamped = Math.min(Math.max(s, 0), total);
  // 二分查找所在采样段
  let lo = 0;
  let hi = path.cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path.cumulative[mid]! <= clamped) lo = mid;
    else hi = mid;
  }
  const s0 = path.cumulative[lo]!;
  const s1 = path.cumulative[hi]!;
  const span = Math.max(s1 - s0, CUMULATIVE_EPS);
  const ratio = Math.min(Math.max((clamped - s0) / span, 0), 1);
  const a = path.points[lo]!;
  const b = path.points[hi]!;
  return {
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
  };
}

/** 流点插值表:输入为累计弧长,输出为点坐标偏移掉半径后的画布坐标 */
export function buildFlowInterpolation(path: SampledPath, dotSize: number): FlowInterpolation {
  const half = dotSize / 2;
  return {
    inputRange: path.cumulative,
    outputX: path.points.map((p) => p.x - half),
    outputY: path.points.map((p) => p.y - half),
  };
}

/**
 * 把采样折线转成旋转矩形线段列表。
 * 两端各延长半线宽:圆头端盖的半圆心恰落在线段端点上——相邻段共享端点时,
 * 两个半圆合成以该端点为心的完整圆盘,即 SVG stroke-linejoin="round" 的
 * 精确语义,拐角外侧无缺口;若不延长(宽=弦长),半圆心内缩 r,
 * 直角拐角外侧会出现约 0.4r 的缺口。
 * 路径首尾由端盖自然收口;跳过近零长段(残差被相邻圆头覆盖)。
 */
export function buildSegmentViews(path: SampledPath, lineWidth: number): SegmentView[] {
  const views: SegmentView[] = [];
  for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1]!;
    const b = path.points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.25) continue;
    const width = length + lineWidth; // 两端各补半线宽,端盖半圆心落在端点上
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    views.push({
      left: (a.x + b.x) / 2 - width / 2,
      top: (a.y + b.y) / 2 - lineWidth / 2,
      width,
      height: lineWidth,
      rotateDeg: angle,
    });
  }
  return views;
}

/**
 * 同父节点多条边在父卡片底部的唯一出线点分配(自左向右,单位:卡片内偏移)。
 * - 单 child 居中;
 * - 多 child 在 [margin, width-margin] 内均匀分布;
 * - 边距过宽(卡片太窄)时收缩边距,保证区间非空。
 */
export function assignExitOffsets(parentWidth: number, childCount: number, margin: number): number[] {
  if (!Number.isFinite(parentWidth) || parentWidth <= 0 || childCount <= 0) return [];
  if (childCount === 1) return [parentWidth / 2];
  const usableMargin = Math.min(margin, (parentWidth - CUMULATIVE_EPS) / 2);
  const inner = parentWidth - usableMargin * 2;
  const offsets: number[] = [];
  for (let i = 0; i < childCount; i++) {
    offsets.push(usableMargin + (inner * i) / (childCount - 1));
  }
  return offsets;
}
