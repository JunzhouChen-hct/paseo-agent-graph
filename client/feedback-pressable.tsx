import { useState } from "react";
import { Pressable } from "react-native";
import type { PressableProps, StyleProp, ViewStyle } from "react-native";

/** Pressable 的 style 形态:静态样式或 ({pressed}) => 样式 的函数形态。 */
type PressableStyle = PressableProps["style"];

export interface FeedbackPressableProps extends PressableProps {
  /** 常规样式;函数形态时仍可拿到 pressed(透传给 Pressable) */
  style?: PressableStyle;
  /** 悬停时叠加的样式(如背景色);缺省则只提供光标反馈 */
  hoverStyle?: StyleProp<ViewStyle> | null;
  /** 按下时叠加的样式;缺省回退到 hoverStyle */
  pressStyle?: StyleProp<ViewStyle> | null;
}

/**
 * 可点击元素的统一光标/悬停/按下反馈:
 * - cursor "pointer" 只施加在本组件渲染的元素上,不外溢给父容器;
 * - 悬停用 RN 原生 onHoverIn/onHoverOut(web 生效,0.81 TS 类型已含),
 *   用真实 state 而非伪造 hovered;按下用 Pressable 的 pressed state;
 * - disabled 时不出悬停/按下反馈;
 * - 面板空白等不可交互区域不要使用本组件:画布清空层显式 cursor "auto" 保持默认光标。
 */
export function FeedbackPressable({ style, hoverStyle, pressStyle, ...rest }: FeedbackPressableProps) {
  const [hovered, setHovered] = useState(false);
  const disabled = rest.disabled === true;
  const showHover = hovered && !disabled;
  return (
    <Pressable
      {...rest}
      onHoverIn={(event) => {
        setHovered(true);
        rest.onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        setHovered(false);
        rest.onHoverOut?.(event);
      }}
      style={(state) => {
        const base = typeof style === "function" ? style(state) : style;
        const hover = showHover ? hoverStyle : null;
        const press = state.pressed && !disabled ? (pressStyle ?? hoverStyle) : null;
        // 光标在 base 之后合成:disabled 显式 auto(不可点击处不出手指,
        // 并遮盖可 pointer 父容器继承下来的 pointer),base 自带的 cursor 也不会覆盖它
        return [base, { cursor: disabled ? "auto" : "pointer" }, hover, press];
      }}
    />
  );
}
