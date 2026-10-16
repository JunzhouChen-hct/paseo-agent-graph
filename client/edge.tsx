import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import {
  buildEdgeCurve,
  buildFlowInterpolation,
  buildSegmentViews,
  PATH_MIN_LENGTH,
  type Point,
} from "../shared/edge-geometry";

const LINE_WIDTH = 2;
const FLOW_DOT = 5;
// 流点速度约 0.06px/ms,时长按路径总长换算并夹在 900-2000ms
const FLOW_SPEED = 0.06;

export interface GraphEdgeLineProps {
  from: Point; // 父卡片底部出线点(同父多边时各自独立)
  to: Point; // 子卡片顶部中点
  color: string; // 静态线颜色(运行色或主题边框色)
  dim: boolean; // 任一端已归档 → 置淡
}

export interface GraphEdgeFlowProps {
  from: Point;
  to: Point;
  runningColor: string;
}

/**
 * 静态曲线层:三次贝塞尔采样为短线段,用 RN View + rotate + 圆头绘制平滑曲线。
 * 不运行动画;与 GraphEdgeFlow 用同一几何函数,保证流点严格落在可见线上。
 */
export function GraphEdgeLine({ from, to, color, dim }: GraphEdgeLineProps) {
  const segments = useMemo(
    () => buildSegmentViews(buildEdgeCurve(from, to), LINE_WIDTH),
    [from, to],
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
 * 流点层:沿同一采样曲线做弧长线性插值,匀速从父卡片流到子卡片。
 * 与静态线分层渲染:所有静态线先绘,所有流点后绘,避免静态线覆盖流点;
 * 本组件只在 active 时由面板挂载,自身仅跑一个流点动画。
 */
export function GraphEdgeFlow({ from, to, runningColor }: GraphEdgeFlowProps) {
  const progress = useRef(new Animated.Value(0)).current;

  const curve = useMemo(() => buildEdgeCurve(from, to), [from, to]);
  const interpolation = useMemo(() => buildFlowInterpolation(curve, FLOW_DOT), [curve]);

  const flowDuration = useMemo(
    () => Math.min(2000, Math.max(900, curve.total / FLOW_SPEED)),
    [curve],
  );

  useEffect(() => {
    // 退化路径(两端重合)不启动动画
    if (curve.total <= PATH_MIN_LENGTH || flowDuration <= 0) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: curve.total,
        duration: flowDuration,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, flowDuration, curve]);

  // 退化路径(两端重合)不渲染流点
  if (curve.total <= PATH_MIN_LENGTH || interpolation.inputRange.length < 2) return null;

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
