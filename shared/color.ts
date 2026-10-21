/**
 * 颜色混合工具(纯函数,卡片顶层背景着色等 UI 派生色共用)。
 *
 * 主题 token 类型上是 string,实际可能是 rgba() 等非 hex 格式;
 * 因此任一输入不是 #RRGGBB 时原样返回 base,调用方无需预校验,
 * 退化行为就是"不调色",不会渲染出非法样式值。
 */

function parseHex(value: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  const int = parseInt(value.slice(1), 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/** 把 overlay 以 weight(0~1,越界截断)权重混入 base,返回不透明 #RRGGBB。 */
export function blendHex(base: string, overlay: string, weight: number): string {
  const from = parseHex(base);
  const to = parseHex(overlay);
  if (!from || !to) return base;
  const clamped = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
  const mixed = from.map((channel, index) =>
    Math.round(channel * (1 - clamped) + to[index] * clamped),
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
