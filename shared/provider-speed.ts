/**
 * 速度(speed)feature 的纯逻辑识别与取值构建:不依赖 zod / SDK / node / react,
 * 供新建子代理表单、模板编辑器、服务端预检与导入采集共用。
 *
 * 识别规则基于真实 provider 目录 descriptor:
 * - Codex 的速度能力是 select:id=service_tier,label=Speed,选项 default(Normal)/priority(Fast);
 * - 其余按 id 或 label 含 "speed"(大小写不敏感)识别,兼容未来 toggle 形态;
 * - auto_accept / plan_mode 等权限类 descriptor 与速度无关,一律不当作速度。
 */

/** 速度 select 的选项(descriptor options 的子集) */
export interface SpeedFeatureOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

/** 速度 feature descriptor 的最小形状(toggle / select 两种) */
export interface SpeedFeatureDescriptor {
  type: "toggle" | "select";
  id: string;
  label: string;
  /** 当前生效值:select 为已选 option id 或 null;toggle 为布尔 */
  value?: boolean | string | null;
  options?: SpeedFeatureOption[];
}

/** listFeatures 响应里 features 数组元素的最小形状(与协议 descriptor 同构,宽松接收) */
export type RawFeatureDescriptor = {
  type?: string;
  id?: string;
  label?: string;
  value?: boolean | string | null;
  options?: { id: string; label?: string; isDefault?: boolean }[] | null;
};

/** 已知真实速度 feature id(Codex service_tier);其余靠 id/label 含 "speed" 识别 */
const KNOWN_SPEED_IDS = new Set(["service_tier"]);

/**
 * 从 features 列表识别速度 descriptor;没有或形态未知返回 null。
 * 只认 toggle / select 两种形态,其余(未知新形态)一律视为不支持。
 */
export function pickSpeedFeature(features: readonly RawFeatureDescriptor[] | null | undefined): SpeedFeatureDescriptor | null {
  for (const raw of features ?? []) {
    if (!raw || (raw.type !== "toggle" && raw.type !== "select")) continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!id) continue;
    const label = typeof raw.label === "string" ? raw.label : id;
    const hit =
      KNOWN_SPEED_IDS.has(id) ||
      id.toLowerCase().includes("speed") ||
      label.toLowerCase().includes("speed");
    if (!hit) continue;
    const descriptor: SpeedFeatureDescriptor = {
      type: raw.type,
      id,
      label,
      value: raw.value ?? null,
      ...(raw.type === "select"
        ? {
            options: (raw.options ?? [])
              .filter((option) => option && typeof option.id === "string" && option.id)
              .map((option) => ({
                id: option.id,
                label: option.label || option.id,
                ...(option.isDefault ? { isDefault: true } : {}),
              })),
          }
        : {}),
    };
    // select 形态必须有可选选项才算可用速度能力,否则视为不支持
    if (descriptor.type === "select" && (!descriptor.options || descriptor.options.length === 0)) {
      continue;
    }
    return descriptor;
  }
  return null;
}

/** UI 选择值 → config.featureValues;非法/未选择(null 或 "")返回 null(不传该 feature) */
export function speedFeatureValuesForSelection(
  feature: SpeedFeatureDescriptor,
  selection: string | null,
): Record<string, unknown> | null {
  if (!selection) return null;
  if (feature.type === "toggle") {
    return selection === "on" ? { [feature.id]: true } : null;
  }
  const hit = (feature.options ?? []).some((option) => option.id === selection);
  return hit ? { [feature.id]: selection } : null;
}

/**
 * 从 descriptor 当前生效值提取"可复制的显式选择"(模板导入采集用):
 * select 取已选 option 且需在选项内;toggle 仅 value === true 时保留(等效默认的不存)。
 */
export function explicitSpeedSelection(
  feature: SpeedFeatureDescriptor,
): { id: string; value: string | boolean } | null {
  if (feature.type === "toggle") {
    return feature.value === true ? { id: feature.id, value: true } : null;
  }
  const value = feature.value;
  if (typeof value !== "string" || !value) return null;
  const hit = (feature.options ?? []).some((option) => option.id === value);
  return hit ? { id: feature.id, value } : null;
}

/** 选择值是否仍被 descriptor 支持(refetch 后保住用户已选项;"" 表示未选择,恒合法) */
export function speedSelectionValid(feature: SpeedFeatureDescriptor, selection: string | null): boolean {
  if (!selection) return true;
  if (feature.type === "toggle") return selection === "on";
  return (feature.options ?? []).some((option) => option.id === selection);
}
