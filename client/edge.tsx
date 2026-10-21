import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import {
  buildFlowInterpolation,
  buildSegmentViews,
  PATH_MIN_LENGTH,
  type SampledPath,
} from "../shared/edge-geometry";

const LINE_WIDTH = 2;
const FLOW_DOT = 5;
// 流点速度约 0.06px/ms,时长按路径总长换算并夹在 900-2000ms
const FLOW_SPEED = 0.06;

export interface GraphEdgeLineProps {
  /** 已规划路径的统一采样(正交折线,直落或避障绕行);与 GraphEdgeFlow 消费同一对象 */
  sampled: SampledPath;
  color: string; // 静态线颜色(运行色或主题边框色)
  dim: boolean; // 任一端已归档 → 置淡
  /** 灰色虚线(主 Agent → 任务列表的挂载连线);不改变路径,只改线段切分 */
  dashed?: boolean;
}

const DASH_LENGTH = 6;
const DASH_GAP = 4;
const DASH_MIN_LENGTH = 1;

/**
 * 把正交折线切成虚线短段。仍复用"旋转矩形"渲染方式,不依赖平台对
 * borderStyle:"dashed" 的支持差异;虚线只用于静态挂载边,不参与流点。
 */
function buildDashedSegmentViews(path: SampledPath, lineWidth: number) {
  const views: {
    left: number;
    top: number;
    width: number;
    height: number;
    rotateDeg: number;
  }[] = [];
  for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1]!;
    const b = path.points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.25) continue;
    const ux = dx / length;
    const uy = dy / length;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    let offset = 0;
    while (offset < length) {
      const end = Math.min(offset + DASH_LENGTH, length);
      const dash = end - offset;
      if (dash >= DASH_MIN_LENGTH) {
        const mid = offset + dash / 2;
        views.push({
          left: a.x + ux * mid - dash / 2,
          top: a.y + uy * mid - lineWidth / 2,
          width: dash,
          height: lineWidth,
          rotateDeg: angle,
        });
      }
      offset += DASH_LENGTH + DASH_GAP;
    }
  }
  return views;
}

export interface GraphEdgeFlowProps {
  /** 与 GraphEdgeLine 同源采样,保证流点严格贴线 */
  sampled: SampledPath;
  runningColor: string;
}

/**
 * 静态折线层:正交折线渲染为短线段 View + rotate,圆头端盖中心恰落在
 * 相邻段共享端点上(等价 SVG round join),直角拐角接缝无隆起、无缺口。
 * 不运行动画;与 GraphEdgeFlow 消费同一份采样。
 */
export function GraphEdgeLine({ sampled, color, dim, dashed = false }: GraphEdgeLineProps) {
  const segments = useMemo(
    () =>
      dashed
        ? buildDashedSegmentViews(sampled, LINE_WIDTH)
        : buildSegmentViews(sampled, LINE_WIDTH),
    [sampled, dashed],
  );
  return (
    <>
      {segments.map((seg, index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            left: seg.left,
            top: seg.top,
            width: seg.width,
            height: seg.height,
            borderRadius: LINE_WIDTH / 2,
            backgroundColor: color,
            opacity: dim ? 0.35 : 1,
            transform: [{ rotate: `${seg.rotateDeg}deg` }],
          }}
        />
      ))}
    </>
  );
}

/**
 * 流点层:沿同一采样路径做弧长线性插值,匀速从父卡片流到子卡片。
 * 与静态线分层渲染:所有静态线先绘,所有流点后绘,避免静态线覆盖流点;
 * 本组件只在 active 时由面板挂载,自身仅跑一个流点动画。
 */
export function GraphEdgeFlow({ sampled, runningColor }: GraphEdgeFlowProps) {
  const progress = useRef(new Animated.Value(0)).current;

  const interpolation = useMemo(
    () => buildFlowInterpolation(sampled, FLOW_DOT),
    [sampled],
  );

  const flowDuration = useMemo(
    () => Math.min(2000, Math.max(900, sampled.total / FLOW_SPEED)),
    [sampled],
  );

  useEffect(() => {
    // 退化路径(两端重合)不启动动画
    if (sampled.total <= PATH_MIN_LENGTH || flowDuration <= 0) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: sampled.total,
        duration: flowDuration,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, flowDuration, sampled]);

  // 退化路径(两端重合)不渲染流点
  if (sampled.total <= PATH_MIN_LENGTH || interpolation.inputRange.length < 2) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: FLOW_DOT,
        height: FLOW_DOT,
        borderRadius: FLOW_DOT / 2,
        backgroundColor: runningColor,
        transform: [
          {
            translateX: progress.interpolate({
              inputRange: interpolation.inputRange,
              outputRange: interpolation.outputX,
            }),
          },
          {
            translateY: progress.interpolate({
              inputRange: interpolation.inputRange,
              outputRange: interpolation.outputY,
            }),
          },
        ],
      }}
    />
  );
}
