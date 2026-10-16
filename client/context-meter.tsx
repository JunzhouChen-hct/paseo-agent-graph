import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * 纯 RN 样式环形进度条(宿主禁止 DOM/SVG/canvas):
 * 底层 track 圆环,上层用左右两个 overflow:hidden 半区裁剪容器各放一个
 * "上+右着色、下+左透明"的半圆环并旋转,露出指定比例的弧段;
 * 裁剪边界过整环圆心,半圆环 absolute 定位使圆心与整环同心。
 * 旋转角推导:着色弧段为 [-45°,135°](从 12 点顺时针 180°),
 * 右半区 rotate = min(sweep,180) - 135 时恰好显示 [0, min(sweep,180)];
 * 左半区仅在 sweep > 180 时渲染,rotate = sweep - 135 显示 [180, sweep]。
 */
export function ContextMeter({
  ratio,
  size = 14,
  thickness = 2.5,
  trackColor,
  progressColor,
}: {
  ratio: number;
  size?: number;
  thickness?: number;
  trackColor: string;
  progressColor: string;
}): ReactNode {
  const clamped = Math.min(1, Math.max(0, ratio));
  const sweep = clamped * 360;
  const halfClip = {
    position: "absolute" as const,
    top: 0,
    width: size / 2,
    height: size,
    overflow: "hidden" as const,
  };
  // 半圆环:absolute 定位,右半容器内 left=-size/2 使其圆心对齐整环圆心(同心),
  // 上+右象限着色(弧段 [-45°,135°]),下+左透明
  const halfRing = {
    position: "absolute" as const,
    top: 0,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: thickness,
    borderTopColor: progressColor,
    borderRightColor: progressColor,
    borderBottomColor: "transparent",
    borderLeftColor: "transparent",
  };
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: thickness,
          borderColor: trackColor,
        }}
      />
      {sweep > 0.5 ? (
        <View style={{ ...halfClip, left: size / 2 }}>
          <View
            style={[
              halfRing,
              { left: -size / 2, transform: [{ rotate: `${Math.min(sweep, 180) - 135}deg` }] },
            ]}
          />
        </View>
      ) : null}
      {sweep > 180.5 ? (
        <View style={{ ...halfClip, left: 0 }}>
          <View
            style={[halfRing, { left: 0, transform: [{ rotate: `${sweep - 135}deg` }] }]}
          />
        </View>
      ) : null}
    </View>
  );
}
