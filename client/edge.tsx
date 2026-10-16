import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

interface Endpoint {
  x: number;
  y: number;
}

interface GraphEdgeProps {
  from: Endpoint; // 父卡片底部中心
  to: Endpoint; // 子卡片顶部中心
  active: boolean; // 两端都在 running → 流点动效
  dim: boolean; // 任一端已归档 → 置淡
  runningColor: string;
  theme: PluginTheme;
}

const LINE_WIDTH = 2;
const FLOW_DOT = 5;
// 流点速度约 0.06px/ms,时长按路径总长换算并夹在 900-2000ms
const FLOW_SPEED = 0.06;
// 段长下限:保证 interpolate 的 inputRange 严格递增
const SEG_EPS = 0.001;

/** 父→子的折线(竖-横-竖),交互中时流点沿整条折线从父卡片匀速运动到子卡片。 */
export function GraphEdge({ from, to, active, dim, runningColor, theme }: GraphEdgeProps) {
  const progress = useRef(new Animated.Value(0)).current;

  const midY = from.y + (to.y - from.y) / 2;

  // 路径参数化:竖(L1)-横(L2)-竖(L3) 三段累计长度;几何上可能为 0,夹极小值保证 inputRange 递增
  const path = useMemo(() => {
    const l1 = Math.abs(midY - from.y);
    const l2 = Math.abs(to.x - from.x);
    const l3 = Math.abs(to.y - midY);
    return {
      l1: Math.max(l1, SEG_EPS),
      l2: Math.max(l2, SEG_EPS),
      l3: Math.max(l3, SEG_EPS),
      total: l1 + l2 + l3,
    };
  }, [from.x, from.y, to.x, to.y, midY]);

  const flowDuration = useMemo(
    () => Math.min(2000, Math.max(900, (path.l1 + path.l2 + path.l3) / FLOW_SPEED)),
    [path],
  );

  useEffect(() => {
    if (!active || flowDuration <= 0) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: path.l1 + path.l2 + path.l3,
        duration: flowDuration,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, progress, flowDuration, path]);

  const color = active ? runningColor : theme.colors.border;

  const segments = useMemo(() => {
    const list: { x: number; y: number; w: number; h: number }[] = [];
    if (Math.abs(from.y - midY) > 0.5) {
      list.push({ x: from.x - LINE_WIDTH / 2, y: from.y, w: LINE_WIDTH, h: midY - from.y });
    }
    if (Math.abs(from.x - to.x) > 0.5) {
      list.push({
        x: Math.min(from.x, to.x) - LINE_WIDTH / 2,
        y: midY - LINE_WIDTH / 2,
        w: Math.abs(to.x - from.x) + LINE_WIDTH,
        h: LINE_WIDTH,
      });
    }
    if (Math.abs(to.y - midY) > 0.5) {
      list.push({ x: to.x - LINE_WIDTH / 2, y: midY, w: LINE_WIDTH, h: to.y - midY });
    }
    return list;
  }, [from.x, from.y, to.x, to.y, midY]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {segments.map((seg, index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            left: seg.x,
            top: seg.y,
            width: seg.w,
            height: seg.h,
            borderRadius: LINE_WIDTH / 2,
            backgroundColor: color,
            opacity: dim ? 0.35 : 1,
          }}
        />
      ))}
      {active && path.total > SEG_EPS ? (
        <Animated.View
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
                  inputRange: [0, path.l1, path.l1 + path.l2, path.l1 + path.l2 + path.l3],
                  outputRange: [
                    from.x - FLOW_DOT / 2,
                    from.x - FLOW_DOT / 2,
                    to.x - FLOW_DOT / 2,
                    to.x - FLOW_DOT / 2,
                  ],
                }),
              },
              {
                translateY: progress.interpolate({
                  inputRange: [0, path.l1, path.l1 + path.l2, path.l1 + path.l2 + path.l3],
                  outputRange: [
                    from.y - FLOW_DOT / 2,
                    midY - FLOW_DOT / 2,
                    midY - FLOW_DOT / 2,
                    to.y - FLOW_DOT / 2,
                  ],
                }),
              },
            ],
          }}
        />
      ) : null}
    </View>
  );
}
