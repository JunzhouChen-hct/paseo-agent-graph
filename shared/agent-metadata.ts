import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 节点卡片元数据:模型思考强度 / 速度模式 / 对应开发分支。
 *
 * 数据来源约定:
 * - 思考强度:完整快照的 effectiveThinkingOptionId 优先,其次 thinkingOptionId,
 *   最后 runtimeInfo.thinkingOptionId;三者皆无表示 provider 未报告,展示为空。
 * - 速度模式:快照自带的 features descriptor(Codex 速度 select 的 id 为
 *   service_tier,value 即当前速度)。不调用 listFeatures,也不用默认
 *   catalog value 冒充实际速度;descriptor 缺失或 value 为 null 表示不支持/未知。
 * - 开发分支:由 server 端从 worktree 提示 label 或 agent.cwd 的真实 git 查询得出,
 *   提取函数先占位为 null,server 覆盖。
 */

/** Codex 在 features 里报告速度模式的真实 select descriptor id(实测确认)。 */
export const SPEED_FEATURE_ID = "service_tier";

/** 完整快照中与节点元数据相关的最小结构:宽进,缺失字段按未知处理。 */
export interface AgentFeatureLite {
  type: string;
  id: string;
  label?: string;
  value?: boolean | string | null;
  options?: { id: string; label: string; isDefault?: boolean }[];
}

export interface AgentMetadataSnapshotLite {
  id: string;
  cwd?: string;
  labels?: Readonly<Record<string, string>>;
  features?: AgentFeatureLite[] | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
  runtimeInfo?: { thinkingOptionId?: string | null } | null;
}

/** 思考强度的来源标记:effective 为会话生效值,优先级最高。 */
export type ThinkingSource = "effective" | "configured" | "runtime";

export interface AgentNodeMetadata {
  thinking: { value: string; source: ThinkingSource } | null;
  speed: { value: string; label: string } | null;
  branch: string | null;
}

export const agentMetadataItemSchema = z.object({
  thinking: z
    .object({
      value: z.string().min(1),
      source: z.enum(["effective", "configured", "runtime"]),
    })
    .nullable(),
  speed: z
    .object({
      value: z.string().min(1),
      label: z.string().min(1),
    })
    .nullable(),
  branch: z.string().nullable(),
});

export const agentMetadataRpc = defineRpc({
  name: "agent-graph.metadata",
  input: z.object({ agentIds: z.array(z.string().min(1)).max(200) }),
  output: z.object({ items: z.record(z.string(), agentMetadataItemSchema.nullable()) }),
});

function firstThinking(
  snapshot: AgentMetadataSnapshotLite,
): { value: string; source: ThinkingSource } | null {
  // 有效思考值优先;空字符串等同未报告
  if (snapshot.effectiveThinkingOptionId) {
    return { value: snapshot.effectiveThinkingOptionId, source: "effective" };
  }
  if (snapshot.thinkingOptionId) {
    return { value: snapshot.thinkingOptionId, source: "configured" };
  }
  if (snapshot.runtimeInfo?.thinkingOptionId) {
    return { value: snapshot.runtimeInfo.thinkingOptionId, source: "runtime" };
  }
  return null;
}

/**
 * 从完整 agent 快照提取卡片元数据(不含分支,分支由 server 端 git 查询得出)。
 * 纯函数,不发起任何 RPC。
 */
export function extractAgentMetadata(snapshot: AgentMetadataSnapshotLite): AgentNodeMetadata {
  const thinking = firstThinking(snapshot);

  // 速度模式只认真实 descriptor;toggle 与未知 id 的 select 一律不当速度,
  // 避免 plan_mode 之类的无关开关被误展示。
  const speedFeature = (snapshot.features ?? []).find(
    (feature) => feature.type === "select" && feature.id === SPEED_FEATURE_ID,
  );
  const speedValue =
    speedFeature && typeof speedFeature.value === "string" && speedFeature.value
      ? speedFeature.value
      : null;
  // value 无法匹配 options 时退回展示原始 value,明确可见而不是静默丢弃
  const speedOption = speedValue
    ? (speedFeature?.options ?? []).find((option) => option.id === speedValue)
    : undefined;
  const speed = speedValue
    ? { value: speedValue, label: speedOption?.label ?? speedValue }
    : null;

  return { thinking, speed, branch: null };
}
