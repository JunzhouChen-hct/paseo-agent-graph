import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import {
  buildTemplateFromSnapshots,
  makeIdempotencyKey,
  topoOrder,
  validateTemplateNodes,
  type ImportableAgentSnapshot,
  type TemplateNodeConfig,
} from "../shared/template-model";
import { createTaskFromTemplateRpc, importTemplateRpc } from "../shared/templates";
import { pickSpeedFeature, speedSelectionValid, type RawFeatureDescriptor } from "../shared/provider-speed";

const PAGE_LIMIT = 200;
/** 单次 RPC 内最多逐个刷新的快照数,防止超大盘 workspace 拖垮导入 */
const REFRESH_BUDGET = 120;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ModelEntry {
  id: string;
  isSelectable?: boolean;
  thinkingOptions?: { id: string }[] | null;
}

/**
 * 创建前预检:显式指定的 model/thinking/mode/速度必须能在真实目录里确认支持,
 * 列表为空/拉取失败时同样拒绝,绝不静默跳过或替换配置。
 * cwd 用于 listFeatures 草稿配置(workspace 缺目录时速度无法确认,按失败拒绝)。
 */
export async function prevalidateConfigs(
  paseo: PaseoApi,
  nodes: readonly TemplateNodeConfig[],
  cwd?: string | null,
): Promise<string[]> {
  const errors: string[] = [];

  let availability: Map<string, boolean> | null = null;
  try {
    const result = await paseo.providers.listAvailable();
    availability = new Map(
      (result.providers ?? []).map((entry) => [entry.provider, entry.available !== false] as const),
    );
  } catch (error) {
    // 目录拉取失败时,所有显式 provider 都无法确认 → 全部拒绝
    for (const node of nodes) {
      errors.push(`节点 ${node.key}:提供方目录拉取失败,无法确认 ${node.provider} 可用:${errorText(error)}`);
    }
    return errors;
  }

  const modelsCache = new Map<string, ModelEntry[] | null>();
  const modesCache = new Map<string, string[] | null>();
  /** key = provider/model + mode + thinking,缓存 listFeatures 结果(null 表示拉取失败) */
  const featuresCache = new Map<string, RawFeatureDescriptor[] | null>();

  const loadFeatures = async (
    provider: string,
    model: string,
    modeId: string | undefined,
    thinkingId: string | null,
  ): Promise<RawFeatureDescriptor[] | null> => {
    const cacheKey = `${provider}/${model}|${modeId ?? ""}|${thinkingId ?? ""}`;
    let features = featuresCache.get(cacheKey);
    if (features === undefined) {
      try {
        const result = await paseo.providers.listFeatures({
          provider: `${provider}/${model}`,
          cwd: cwd ?? "",
          ...(modeId ? { modeId } : {}),
          ...(thinkingId ? { thinkingOptionId: thinkingId } : {}),
        });
        features = result.features ?? [];
      } catch {
        features = null;
      }
      featuresCache.set(cacheKey, features);
    }
    return features;
  };

  for (const node of nodes) {
    const label = `节点 ${node.key}`;
    if (!node.provider) {
      errors.push(`${label}:未指定提供方`);
      continue;
    }
    const available = availability.get(node.provider);
    if (available === undefined) {
      errors.push(`${label}:提供方 ${node.provider} 不在可用列表中`);
    } else if (!available) {
      errors.push(`${label}:提供方 ${node.provider} 当前不可用`);
    }
    if (!node.model) {
      errors.push(`${label}:未指定模型`);
      continue;
    }

    let models = modelsCache.get(node.provider);
    if (models === undefined) {
      try {
        const result = await paseo.providers.listModels(node.provider);
        models = (result.models ?? []).filter((model) => model.isSelectable !== false);
      } catch (error) {
        errors.push(`${label}:模型目录拉取失败,无法确认 ${node.model}:${errorText(error)}`);
        models = null;
      }
      modelsCache.set(node.provider, models);
    }
    if (!models) continue; // 拉取失败已在上面报错
    if (models.length === 0) {
      // 目录为空 ≠ 放行:显式 model 无法被确认支持
      errors.push(`${label}:提供方 ${node.provider} 模型目录为空,无法确认 ${node.model} 受支持`);
      continue;
    }
    const model = models.find((entry) => entry.id === node.model);
    if (!model) {
      errors.push(`${label}:模型 ${node.model} 不在提供方 ${node.provider} 的可用模型中`);
      continue;
    }

    const thinkingId = node.thinkingOptionId;
    if (thinkingId) {
      const options = model.thinkingOptions ?? [];
      const hit = options.some((option) => option.id === thinkingId);
      if (!hit) {
        errors.push(
          options.length === 0
            ? `${label}:模型 ${node.model} 无思考强度选项,不支持 ${thinkingId}`
            : `${label}:思考强度 ${thinkingId} 不受模型 ${node.model} 支持`,
        );
      }
    }

    if (node.modeId) {
      let modes = modesCache.get(node.provider);
      if (modes === undefined) {
        try {
          const result = await paseo.providers.listModes(node.provider);
          modes = (result.modes ?? []).map((mode) => mode.id);
        } catch (error) {
          errors.push(`${label}:模式目录拉取失败,无法确认 ${node.modeId}:${errorText(error)}`);
          modes = null;
        }
        modesCache.set(node.provider, modes);
      }
      if (modes && modes.length === 0) {
        // 目录为空 ≠ 放行:显式 modeId 无法被确认支持,与 model/速度预检口径一致
        errors.push(`${label}:提供方 ${node.provider} 模式目录为空,不支持 ${node.modeId}`);
        continue;
      }
      if (modes && !modes.includes(node.modeId)) {
        errors.push(`${label}:模式 ${node.modeId} 不在提供方 ${node.provider} 的可用模式中`);
      }
    }

    // 速度预检:显式配置的速度 feature/取值必须被真实 descriptor 确认支持
    if (node.speedFeatureId) {
      if (!cwd) {
        errors.push(`${label}:workspace 缺少目录信息,无法确认速度 ${node.speedFeatureId}`);
        continue;
      }
      const features = await loadFeatures(node.provider, node.model, node.modeId, node.thinkingOptionId);
      if (!features) {
        errors.push(`${label}:速度特性目录拉取失败,无法确认 ${node.speedFeatureId}`);
        continue;
      }
      const feature = pickSpeedFeature(features);
      if (!feature || feature.id !== node.speedFeatureId) {
        errors.push(
          feature
            ? `${label}:速度特性 ${node.speedFeatureId} 与当前目录不符(实际为 ${feature.id})`
            : `${label}:提供方 ${node.provider} 未提供速度特性,不支持 ${node.speedFeatureId}`,
        );
        continue;
      }
      const value = node.speedFeatureValue;
      if (feature.type === "toggle") {
        // 开关三态:true/false 都是显式值;非布尔取值(如误存 option id)拒绝
        if (typeof value !== "boolean") {
          errors.push(`${label}:速度 ${feature.label} 为开关形态,取值只支持布尔(true/false)`);
        }
        continue;
      }
      const selection = typeof value === "string" ? value : null;
      if (!speedSelectionValid(feature, selection)) {
        const optionIds = (feature.options ?? []).map((option) => option.id).join(", ");
        errors.push(
          `${label}:速度选项 ${String(value)} 不在 ${feature.label} 的可选列表中(${optionIds || "无选项"})`,
        );
      }
    }
  }

  // 去重(同一 provider 失败会按节点重复报),保留原始顺序
  return [...new Set(errors)];
}

/** 从当前 workspace 未归档节点提取模板草稿(fresh snapshots,过滤归档,不复制消息历史/密钥) */
export async function handleImportTemplate(
  { workspaceId }: RpcInput<typeof importTemplateRpc>,
  { paseo }: { paseo: PaseoApi },
) {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) {
    throw new Error("workspace 不存在或已归档");
  }

  const notes: string[] = [];
  // 目录分页拉全量(升序,保证截断时保留最早的节点)。
  // 目录条目内嵌完整快照,含 archivedAt:归档节点在此先排除,不占用刷新预算。
  const liveIds: string[] = [];
  let skippedArchived = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await paseo.agents.list({
      filter: { includeArchived: true },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of page.entries) {
      if (entry.agent.workspaceId !== workspaceId) continue;
      if (entry.agent.archivedAt) {
        skippedArchived += 1;
        continue;
      }
      liveIds.push(entry.agent.id);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (!cursor) break;
  }
  if (skippedArchived > 0) notes.push(`已跳过 ${skippedArchived} 个已归档节点`);

  let budgetExceeded = false;
  if (liveIds.length > REFRESH_BUDGET) {
    budgetExceeded = true;
    notes.push(
      `未归档节点 ${liveIds.length} 个,超过单次导入上限 ${REFRESH_BUDGET},仅处理最早创建的 ${REFRESH_BUDGET} 个,结果不完整`,
    );
    liveIds.length = REFRESH_BUDGET;
  }

  // 逐个拉 fresh snapshot(目录快照可能是缓存值,创建模板要求最新配置)
  const snapshots: ImportableAgentSnapshot[] = [];
  let failedRefresh = 0;
  for (const agentId of liveIds) {
    try {
      const result = await paseo.agents.ref(agentId).refresh();
      const agent = result?.agent;
      if (!agent) {
        failedRefresh += 1;
        continue;
      }
      if (agent.archivedAt) {
        // 目录里未归档、刷新后已归档:仍排除
        skippedArchived += 1;
        continue;
      }
      snapshots.push({
        id: agent.id,
        title: agent.title,
        provider: agent.provider,
        model: agent.model,
        thinkingOptionId: agent.thinkingOptionId ?? null,
        modeId: agent.currentModeId ?? null,
        features: (agent.features ?? []) as RawFeatureDescriptor[],
        archivedAt: null,
        createdAt: agent.createdAt,
        labels: agent.labels,
      });
    } catch (error) {
      failedRefresh += 1;
      console.error(`[agent-graph] 导入模板:刷新 agent ${agentId} 失败,已跳过:`, errorText(error));
    }
  }
  if (failedRefresh > 0) notes.push(`${failedRefresh} 个节点快照刷新失败,已跳过,结果不完整`);

  const draft = buildTemplateFromSnapshots(snapshots, {
    suggestedName: workspace.title || workspace.name || "当前节点模板",
  });
  const truncated = budgetExceeded || failedRefresh > 0 || draft.nodes.length < snapshots.length;
  // handler 层 notes(归档排除/预算/刷新失败)与构建器 notes(虚拟主节点/截断)合并返回
  return { ...draft, notes: [...notes, ...draft.notes], skippedArchived, truncated };
}

/** 按模板新建任务:树校验 → 配置预检 → 拓扑序建树(幂等) → 给主节点发首条 prompt */
export async function handleCreateTaskFromTemplate(
  input: RpcInput<typeof createTaskFromTemplateRpc>,
  { paseo }: { paseo: PaseoApi },
) {
  const { workspaceId, title, prompt, runId, nodes } = input;

  const tree = validateTemplateNodes(nodes);
  if (!tree.ok) {
    return { ok: false, rootAgentId: null, createdAgentIds: [], validationErrors: tree.errors, error: null };
  }
  const rootKey = nodes.find((node) => !node.parentKey)?.key ?? null;

  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) {
    return {
      ok: false,
      rootAgentId: null,
      createdAgentIds: [],
      validationErrors: [],
      error: "workspace 不存在或已归档",
    };
  }

  const validationErrors = await prevalidateConfigs(paseo, nodes, workspace.workspaceDirectory ?? null);
  if (validationErrors.length > 0) {
    return { ok: false, rootAgentId: null, createdAgentIds: [], validationErrors, error: null };
  }

  const order = topoOrder(nodes);
  if (!order.ok) {
    return {
      ok: false,
      rootAgentId: null,
      createdAgentIds: [],
      validationErrors: ["节点拓扑排序失败(存在环或缺失父引用)"],
      error: null,
    };
  }

  // 拓扑序逐节点创建;同一次运行的 runId + 节点 key 派生幂等 key,重试不重复建
  const createdAgentIds: { key: string; agentId: string }[] = [];
  const keyToAgent = new Map<string, string>();
  try {
    for (const node of order.order) {
      const parentAgentId = node.parentKey ? keyToAgent.get(node.parentKey) : null;
      if (node.parentKey && !parentAgentId) {
        throw new Error(`节点 ${node.key} 的父节点尚未创建,无法继续`);
      }
      const handle = await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: `${node.provider}/${node.model}`,
          ...(node.thinkingOptionId ? { thinkingOptionId: node.thinkingOptionId } : {}),
          ...(node.modeId ? { modeId: node.modeId } : {}),
          // 速度:仅在显式配置时传入 featureValues(预检已确认 id/取值合法)
          ...(node.speedFeatureId
            ? { featureValues: { [node.speedFeatureId]: node.speedFeatureValue } }
            : {}),
        },
        // 主节点用任务标题,后代用模板标题;空标题交给 daemon 自动生成
        title: parentAgentId ? node.title || undefined : title,
        ...(parentAgentId ? { parent: parentAgentId } : {}),
        idempotencyKey: makeIdempotencyKey(runId, node.key),
      });
      keyToAgent.set(node.key, handle.id);
      createdAgentIds.push({ key: node.key, agentId: handle.id });
    }
  } catch (error) {
    const message = errorText(error);
    const rootAgentId = rootKey ? (keyToAgent.get(rootKey) ?? null) : null;
    console.error(`[agent-graph] 按模板建树部分失败(已创建 ${createdAgentIds.length} 个):`, message);
    return {
      ok: false,
      rootAgentId,
      createdAgentIds,
      validationErrors: [],
      error: `创建中断(已创建 ${createdAgentIds.length} 个节点):${message}`,
    };
  }

  const rootAgentId = rootKey ? (keyToAgent.get(rootKey) ?? null) : null;
  if (!rootAgentId) {
    return {
      ok: false,
      rootAgentId: null,
      createdAgentIds,
      validationErrors: [],
      error: "建树完成但未定位到主节点",
    };
  }

  // 整树成功后才把首条 prompt 发给主节点;子节点无 prompt 待命
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt) {
    try {
      // 稳定 messageId:同 runId 重试不会重复发送
      await paseo.agents.ref(rootAgentId).send(trimmedPrompt, {
        messageId: makeIdempotencyKey(runId, "prompt"),
      });
    } catch (error) {
      return {
        ok: false,
        rootAgentId,
        createdAgentIds,
        validationErrors: [],
        error: `树已创建,但首条 prompt 发送失败:${errorText(error)}`,
      };
    }
  }

  return { ok: true, rootAgentId, createdAgentIds, validationErrors: [], error: null };
}
