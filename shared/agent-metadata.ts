import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pickSpeedFeature } from "./provider-speed.ts";

/**
 * 节点卡片元数据:模型思考强度 / 速度模式 / 对应开发分支。
 *
 * 数据来源约定:
 * - 思考强度:完整快照的 effectiveThinkingOptionId 优先,其次 thinkingOptionId,
 *   最后 runtimeInfo.thinkingOptionId;三者皆无表示 provider 未报告,展示为空。
 * - 速度模式:复用 shared/provider-speed.ts 的 pickSpeedFeature 统一识别
 *   (service_tier select 及 id/label 含 "speed" 的 toggle/select),
 *   展示快照 descriptor 的实际 value:toggle true→开启 / false→关闭,
 *   select 取已选 option label;value 为 null 表示未知,不展示,
 *   不调用 listFeatures 也不用 catalog 默认值冒充实际速度。
 * - 开发分支:由 server 端从 worktree 提示 label 或 agent.cwd 的真实 git 查询得出,
 *   提取函数先占位为 null,server 覆盖。
 * - 上下文窗口:取完整快照 lastUsage.contextWindowUsedTokens / contextWindowMaxTokens,
 *   只用这两个专用字段,不用 inputTokens/outputTokens 等累计值冒充上下文;
 *   来源缺失、非有限、负值按未知(null)处理,max<=0 视为未知,
 *   不猜默认窗口;两侧都未知时整体为 null。
 */

/** 完整快照中与节点元数据相关的最小结构:宽进,缺失字段按未知处理。 */
export interface AgentFeatureLite {
  type: string;
  id: string;
  label?: string;
  value?: boolean | string | null;
  options?: { id: string; label: string; isDefault?: boolean }[];
}

/** 完整快照 lastUsage 中与上下文窗口相关的最小结构:宽进,缺失字段按未知处理。
 *  累计类 inputTokens/outputTokens 仅为完整快照兼容而保留,提取时不使用。 */
export interface AgentUsageLite {
  inputTokens?: number;
  outputTokens?: number;
  contextWindowUsedTokens?: number;
  contextWindowMaxTokens?: number;
}

export interface AgentMetadataSnapshotLite {
  id: string;
  cwd?: string;
  labels?: Readonly<Record<string, string>>;
  features?: AgentFeatureLite[] | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
  runtimeInfo?: { thinkingOptionId?: string | null } | null;
  lastUsage?: AgentUsageLite | null;
}

/** 思考强度的来源标记:effective 为会话生效值,优先级最高。 */
export type ThinkingSource = "effective" | "configured" | "runtime";

/** 上下文窗口占用:used/max 未知侧为 null;两侧都未知时整体为 null。 */
export interface AgentMetadataContext {
  used: number | null;
  max: number | null;
}

export interface AgentNodeMetadata {
  thinking: { value: string; source: ThinkingSource } | null;
  speed: { value: string; label: string } | null;
  branch: string | null;
  /** 上下文窗口占用;快照无可用 usage 时为 null,字段缺省(undefined)兼容旧 schema。 */
  context?: AgentMetadataContext | null;
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
  context: z
    .object({
      used: z.number().nullable(),
      max: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

/** 单次 RPC 允许的最大 agent 数(daemon 侧 input 校验同款上限),客户端按此分片。 */
export const METADATA_BATCH_SIZE = 200;

export const agentMetadataRpc = defineRpc({
  name: "agent-graph.metadata",
  input: z.object({ agentIds: z.array(z.string().min(1)).max(METADATA_BATCH_SIZE) }),
  output: z.object({ items: z.record(z.string(), agentMetadataItemSchema.nullable()) }),
});

/** detached HEAD 的明确展示值:hint/cwd 是 git 仓库但当前无分支名可报。 */
export const DETACHED_BRANCH_LABEL = "detached HEAD";

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

/** 速度 descriptor 实际 value → 展示值;未报告(null/空)返回 null,不冒充默认。 */
function speedDisplay(feature: ReturnType<typeof pickSpeedFeature>): { value: string; label: string } | null {
  if (!feature) return null;
  if (feature.type === "toggle") {
    if (feature.value === true) return { value: "on", label: "开启" };
    if (feature.value === false) return { value: "off", label: "关闭" };
    return null; // toggle value 未知(null)→ 不展示
  }
  const value = feature.value;
  if (typeof value !== "string" || !value) return null;
  // value 无法匹配 options 时退回展示原始 value,明确可见而不是静默丢弃
  const option = (feature.options ?? []).find((candidate) => candidate.id === value);
  return { value, label: option?.label ?? value };
}

/** usage 数字的宽进校验:非有限 / 负值按未知(null)处理。 */
function usageNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 提取上下文窗口占用:只用 lastUsage 的 contextWindow 专用字段,
 * 不猜默认窗口,不用 inputTokens/outputTokens 等累计值冒充;
 * max<=0 视为未知,两侧都未知时整体为 null。
 */
function extractContextUsage(usage: AgentUsageLite | null | undefined): AgentMetadataContext | null {
  const max = usageNumber(usage?.contextWindowMaxTokens);
  const maxKnown = max !== null && max > 0 ? max : null;
  const used = usageNumber(usage?.contextWindowUsedTokens);
  if (used === null && maxKnown === null) return null;
  return { used, max: maxKnown };
}

/**
 * 从完整 agent 快照提取卡片元数据(不含分支,分支由 server 端 git 查询得出)。
 * 纯函数,不发起任何 RPC。
 */
export function extractAgentMetadata(snapshot: AgentMetadataSnapshotLite): AgentNodeMetadata {
  const thinking = firstThinking(snapshot);
  // 速度识别统一走 pickSpeedFeature(基于真实 descriptor,含 toggle 形态);
  // auto_accept / plan_mode 等权限类 descriptor 不会被误判为速度。
  const speed = speedDisplay(pickSpeedFeature(snapshot.features ?? []));
  return { thinking, speed, branch: null, context: extractContextUsage(snapshot.lastUsage) };
}

/** 按 RPC 单次上限把 agentIds 切成若干批,空数组返回空批列表。 */
export function splitBatches(ids: readonly string[], size: number = METADATA_BATCH_SIZE): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    batches.push(ids.slice(index, index + size));
  }
  return batches;
}

export type MetadataBatchPage = { items: Record<string, AgentNodeMetadata | null> };
export type MetadataBatchResult = PromiseSettledResult<MetadataBatchPage>;

/**
 * 合并多批 RPC 结果:仅成功批次的条目参与合并,失败批次的 agent 不出现在
 * 返回值里(由调用方沿用上次结果),同时给出失败批次数供限频上报。
 * 纯函数,供 client hook 与测试共用。
 */
export function mergeBatchResults(
  batches: readonly (readonly string[])[],
  settled: readonly MetadataBatchResult[],
): { items: Record<string, AgentNodeMetadata>; failedBatches: number } {
  const items: Record<string, AgentNodeMetadata> = {};
  let failedBatches = 0;
  batches.forEach((batch, index) => {
    const result = settled[index];
    if (!result || result.status !== "fulfilled") {
      failedBatches += 1;
      return;
    }
    for (const [agentId, value] of Object.entries(result.value.items ?? {})) {
      const metadata = value ?? null;
      if (metadata) items[agentId] = metadata;
    }
  });
  return { items, failedBatches };
}
