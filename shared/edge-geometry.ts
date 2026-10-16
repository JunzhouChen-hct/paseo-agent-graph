/**
 * 边曲线几何纯逻辑:三次贝塞尔曲线构建、弧长参数化、采样、
 * 线段视图(供 RN View+rotate 绘制)与同父出线点分配。
 * 不依赖 React / React Native,可被 client 与 tests 共用。
 */

export interface Point {
  x: number;
  y: number;
}

export interface EdgeCurve {
  /** 曲线起点(父卡片底部出线点) */
  from: Point;
  /** 曲线终点(子卡片顶部中点) */
  to: Point;
  /** 三次贝塞尔控制点 */
  cp1: Point;
  cp2: Point;
  /** 采样点(含 from、to 两端) */
  points: Point[];
  /** 每个采样点处的累计弧长,与 points 等长,严格递增 */
  cumulative: number[];
  /** 曲线总弧长 */
  total: number;
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

/**
 * 构建“竖直切出”的三次贝塞尔曲线:两端切线均竖直,
 * 控制距离随垂直距离缩放并夹在 [20, 90],曲线平滑无折角。
 * 垂直距离过小(甚至子卡片在父卡片上方)时控制距离取下限,
 * 保证控制点有限、采样无 NaN。
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
  const segments = Math.min(48, Math.max(8, Math.ceil(approx / 10)));
  const points = samplePoints(from, cp1, cp2, to, segments);
  const cumulative = cumulativeLengths(points);
  // 全零弧长(重合点)时夹一个极小值,保证 inputRange 严格递增不产生 NaN
  const total = cumulative[cumulative.length - 1] ?? 0;
  return { from, to, cp1, cp2, points, cumulative, total };
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

/**
 * 弧长 → 曲线上的点(线性插值,近似匀速)。s 越界时夹在 [0, total]。
 */
export function pointAtLength(curve: EdgeCurve, s: number): Point {
  const total = curve.total;
  const clamped = Math.min(Math.max(s, 0), total);
  // 二分查找所在采样段
  let lo = 0;
  let hi = curve.cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve.cumulative[mid]! <= clamped) lo = mid;
    else hi = mid;
  }
  const s0 = curve.cumulative[lo]!;
  const s1 = curve.cumulative[hi]!;
  const span = Math.max(s1 - s0, CUMULATIVE_EPS);
  const ratio = Math.min(Math.max((clamped - s0) / span, 0), 1);
  const a = curve.points[lo]!;
  const b = curve.points[hi]!;
  return {
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
  };
}

/** 流点插值表:输入为累计弧长,输出为点坐标偏移掉半径后的画布坐标 */
export function buildFlowInterpolation(curve: EdgeCurve, dotSize: number): FlowInterpolation {
  const half = dotSize / 2;
  return {
    inputRange: curve.cumulative,
    outputX: curve.points.map((p) => p.x - half),
    outputY: curve.points.map((p) => p.y - half),
  };
}

/**
 * 把采样折线转成旋转矩形线段列表(圆头、端部各延长半线宽补齐接缝)。
 * 跳过长度 < 0.5 的段,避免零尺寸视图。
 */
export function buildSegmentViews(curve: EdgeCurve, lineWidth: number): SegmentView[] {
  const views: SegmentView[] = [];
  for (let i = 1; i < curve.points.length; i++) {
    const a = curve.points[i - 1]!;
    const b = curve.points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) continue;
    const width = length + lineWidth; // 两端各补半线宽,圆头自然覆盖接缝
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
