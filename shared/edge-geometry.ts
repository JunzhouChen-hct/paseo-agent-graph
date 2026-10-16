/**
 * 边几何纯逻辑:正交折线路径的弧长参数化、线段视图(供 RN View+rotate
 * 绘制)、流点插值表与同父出线点分配。路径即航点折线本身,无贝塞尔、
 * 无圆弧采样;静态线与流点消费同一份采样。
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
 * 把路径航点转成采样路径:去掉连续重复点后逐段累计弧长。
 * 正交折线不做任何重采样/简化——渲染折线与航点一一对应,
 * 静态线段视图与流点插值消费同一份 points。
 */
export function buildPolylinePath(waypoints: readonly Point[]): SampledPath {
  const pts: Point[] = [];
  for (const point of waypoints) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(point.x - prev.x, point.y - prev.y) > 1e-9) pts.push(point);
  }
  if (pts.length === 0) {
    return { points: [], cumulative: [], total: 0 };
  }
  if (pts.length === 1) {
    return {
      points: [pts[0]!, { ...pts[0]! }],
      cumulative: [0, CUMULATIVE_EPS],
      total: CUMULATIVE_EPS,
    };
  }
  const cumulative = cumulativeLengths(pts);
  const total = cumulative[cumulative.length - 1] ?? 0;
  return { points: pts, cumulative, total };
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
 * 精确语义,直角拐角外侧无缺口;若不延长(宽=弦长),半圆心内缩 r,
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
