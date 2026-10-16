import { z } from "zod";
import {
  explicitSpeedSelection,
  pickSpeedFeature,
  type RawFeatureDescriptor,
} from "./provider-speed";

/**
 * 节点模板的纯数据模型:Zod 契约、树校验、导入归一化、拓扑排序、默认模板匹配。
 * 本模块只依赖 zod 与 provider-speed 纯逻辑,不 import @getpaseo/plugin / node / react,
 * 便于单元测试与双端复用。
 */

/** 单个模板节点的配置;key 是模板内唯一标识,parentKey 为 null 表示主节点(根)。 */
export const templateNodeSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "key 只能包含字母/数字/下划线/连字符"),
  parentKey: z.string().nullable(),
  title: z.string().max(200),
  /** 裸 provider id(如 "codex"),不带 "/model" 后缀 */
  provider: z.string(),
  /** 裸 model id;空串表示未采集/未选择,创建前会被预检拒绝 */
  model: z.string(),
  thinkingOptionId: z.string().nullable(),
  /** 仅在"从当前节点生成"采集原 agent 时保留;编辑器切换 provider 时清除 */
  modeId: z.string().optional(),
  /** 速度 feature id(如 codex 的 service_tier);未采集/未选择时不设,旧 settings 文档天然兼容 */
  speedFeatureId: z.string().optional(),
  /** 速度选择值:select 为 option id,toggle 为 true;与 speedFeatureId 成对出现 */
  speedFeatureValue: z.union([z.string(), z.boolean()]).optional(),
});

export type TemplateNodeConfig = z.output<typeof templateNodeSchema>;

/** 模板树的最大节点数(含主节点) */
export const TEMPLATE_MAX_NODES = 30;

/** 单棵模板树的完整校验:唯一 key、合法父引用、单主节点、无环、数量上限。 */
export function validateTemplateNodes(nodes: readonly TemplateNodeConfig[]): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (nodes.length === 0) {
    errors.push("模板至少需要一个节点");
    return { ok: false, errors };
  }
  if (nodes.length > TEMPLATE_MAX_NODES) {
    errors.push(`模板节点数超过上限 ${TEMPLATE_MAX_NODES}`);
  }
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(node.key)) {
      errors.push(`节点 key 格式非法(限字母/数字/下划线/连字符,≤64 位):${node.key}`);
    }
    if (seen.has(node.key)) errors.push(`节点 key 重复:${node.key}`);
    seen.add(node.key);
    // 速度配置必须成对出现:id 与取值缺一不可,避免半配置状态流入创建
    if (node.speedFeatureId && node.speedFeatureValue === undefined) {
      errors.push(`节点 ${node.key} 配置了速度 ${node.speedFeatureId} 但缺少取值`);
    }
    if (!node.speedFeatureId && node.speedFeatureValue !== undefined) {
      errors.push(`节点 ${node.key} 配置了速度取值但缺少速度 feature id`);
    }
  }
  for (const node of nodes) {
    if (!node.parentKey) continue;
    if (!seen.has(node.parentKey)) {
      errors.push(`节点 ${node.key} 的父节点 ${node.parentKey} 不存在`);
    }
  }
  const roots = nodes.filter((node) => !node.parentKey);
  if (roots.length === 0) errors.push("模板缺少主节点");
  if (roots.length > 1) {
    errors.push(`模板只能有一个主节点,当前有 ${roots.length} 个:${roots.map((r) => r.key).join(", ")}`);
  }
  // 环检测:从每个节点沿 parent 链上溯,重复经过即有环(父引用已保证存在,不会越界)
  const byKey = new Map(nodes.map((node) => [node.key, node] as const));
  for (const node of nodes) {
    const visited = new Set<string>();
    let cursor: string | null = node.key;
    while (cursor) {
      if (visited.has(cursor)) {
        errors.push(`节点 ${node.key} 处于父子环中`);
        break;
      }
      visited.add(cursor);
      const current: TemplateNodeConfig | undefined = byKey.get(cursor);
      const parent: string | null = current ? current.parentKey : null;
      if (parent && !byKey.has(parent)) break; // 缺失父引用已单独报错
      cursor = parent;
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 拓扑排序(父先于子);已 validateTemplateNodes 通过的输入必成功,这里独立兜底。 */
export function topoOrder(nodes: readonly TemplateNodeConfig[]): {
  ok: boolean;
  order: TemplateNodeConfig[];
} {
  const byKey = new Map(nodes.map((node) => [node.key, node] as const));
  const order: TemplateNodeConfig[] = [];
  const done = new Set<string>();
  // 迭代剥洋葱:每轮放入所有父已就绪的节点;有环/缺引用时终止
  let remaining = [...nodes];
  while (remaining.length > 0) {
    const ready = remaining.filter((node) => !node.parentKey || done.has(node.parentKey));
    if (ready.length === 0) return { ok: false, order: [] };
    for (const node of ready) {
      order.push(node);
      done.add(node.key);
    }
    remaining = remaining.filter((node) => !done.has(node.key));
  }
  return { ok: true, order };
}

/** 创建/重试共用的幂等 key:同一次"按模板新建任务"内每个节点稳定,重试不重复建。 */
export function makeIdempotencyKey(runId: string, nodeKey: string): string {
  return `agent-graph-templates:${runId}:${nodeKey}`;
}

/** 生成一个未占用的节点 key(编辑器"添加节点"用)。 */
export function nextNodeKey(nodes: readonly TemplateNodeConfig[]): string {
  let index = nodes.length + 1;
  const taken = new Set(nodes.map((node) => node.key));
  while (taken.has(`n${index}`)) index += 1;
  return `n${index}`;
}

/** 编辑器可用的随机 id(模板 id / 建树 runId);不依赖 node:crypto,双端可用。 */
export function newTemplateId(): string {
  return `agt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 某节点可选择的父节点:排除自身与全部后代,按构造避免成环。
 * 主节点(根)不可改父,返回空数组。
 */
export function parentOptionsFor(
  nodes: readonly TemplateNodeConfig[],
  key: string,
): TemplateNodeConfig[] {
  const isRoot = !nodes.find((node) => node.key === key)?.parentKey;
  if (isRoot) return [];
  const excluded = new Set<string>([key]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (excluded.has(node.key)) continue;
      if (node.parentKey && excluded.has(node.parentKey)) {
        excluded.add(node.key);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => !excluded.has(node.key));
}

/** 规范化 cwd 用于精确匹配:去首尾空白与结尾斜杠(根路径除外)。不依赖 node:path,双端可用。 */
export function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return "";
  if (trimmed.length > 1 && trimmed.endsWith("/")) return trimmed.replace(/\/+$/, "");
  return trimmed;
}

export const PROJECT_KEY_PREFIX = "project:";
export const CWD_KEY_PREFIX = "cwd:";

/**
 * 在 defaults 映射里找当前项目的默认模板 id:
 * 先按真实 projectId 精确匹配,再按规范 cwd 匹配;都没有返回 null(默认关闭)。
 */
export function matchProjectDefault(
  defaults: Readonly<Record<string, string>>,
  project: { projectId: string | null; cwd: string | null },
): string | null {
  if (project.projectId) {
    const byProject = defaults[`${PROJECT_KEY_PREFIX}${project.projectId}`];
    if (typeof byProject === "string" && byProject) return byProject;
  }
  if (project.cwd) {
    const byCwd = defaults[`${CWD_KEY_PREFIX}${normalizeCwd(project.cwd)}`];
    if (typeof byCwd === "string" && byCwd) return byCwd;
  }
  return null;
}

/** 供 defaults 映射写入的键(项目 id 与规范 cwd 同时写,提高可恢复性)。 */
export function projectDefaultKeys(project: { projectId: string | null; cwd: string | null }): string[] {
  const keys: string[] = [];
  if (project.projectId) keys.push(`${PROJECT_KEY_PREFIX}${project.projectId}`);
  if (project.cwd) {
    const normalized = normalizeCwd(project.cwd);
    if (normalized) keys.push(`${CWD_KEY_PREFIX}${normalized}`);
  }
  return keys;
}

/** 导入用的最小 agent 快照形状(服务端 refresh() 的结果子集,纯数据便于测试)。 */
export interface ImportableAgentSnapshot {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  thinkingOptionId: string | null;
  modeId: string | null;
  /** agent 快照自带 features descriptor 列表(与 listFeatures 同构),用于采集速度 */
  features?: RawFeatureDescriptor[];
  archivedAt: string | null;
  createdAt: string;
  labels: Readonly<Record<string, string>>;
}

/** Paseo 原生父子关系 label(与 @getpaseo/protocol agent-labels.js 一致) */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export interface ImportTemplateResult {
  name: string;
  nodes: TemplateNodeConfig[];
  notes: string[];
  /** true 表示多根/孤儿挂到了自动生成的虚拟主节点下 */
  virtualRoot: boolean;
  skippedArchived: number;
}

/**
 * 从 agent 快照构建模板草稿(纯逻辑):
 * - 过滤已归档(无论面板是否隐藏归档,范围始终为"当前未归档节点")
 * - 父已归档/父缺失/多根时,把根重新挂到自动生成的虚拟主节点下,保持森林关系
 * - 只复制配置字段(provider/model/thinking/mode/标题),不复制消息历史与密钥
 */
export function buildTemplateFromSnapshots(
  snapshots: readonly ImportableAgentSnapshot[],
  options: { suggestedName: string },
): ImportTemplateResult {
  const notes: string[] = [];
  const live = snapshots.filter((snap) => !snap.archivedAt);
  const skippedArchived = snapshots.length - live.length;

  // 按 createdAt 升序,数量超上限时截断(保留最早的节点)
  const ordered = [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let kept = ordered;
  if (ordered.length > TEMPLATE_MAX_NODES) {
    kept = ordered.slice(0, TEMPLATE_MAX_NODES);
    notes.push(`未归档节点超过 ${TEMPLATE_MAX_NODES} 个,已截断为最早创建的 ${kept.length} 个`);
  }

  const liveIds = new Set(kept.map((snap) => snap.id));
  let orphanCount = 0;
  const parentByKey = new Map<string, string | null>();
  for (const snap of kept) {
    const rawParent = snap.labels[PARENT_AGENT_ID_LABEL] ?? null;
    if (rawParent && liveIds.has(rawParent)) {
      parentByKey.set(snap.id, rawParent);
    } else {
      // 根节点、父已归档、父被截断 → 都视为根
      if (rawParent) orphanCount += 1;
      parentByKey.set(snap.id, null);
    }
  }
  if (skippedArchived > 0) notes.push(`已跳过 ${skippedArchived} 个已归档节点`);
  if (orphanCount > 0) notes.push(`${orphanCount} 个节点的父节点已归档或不在保留范围内,已作为根节点处理`);

  if (kept.length === 0) {
    return { name: options.suggestedName, nodes: [], notes: [...notes, "没有可导入的未归档节点"], virtualRoot: false, skippedArchived };
  }

  const agentIdToKey = new Map<string, string>();
  kept.forEach((snap, index) => agentIdToKey.set(snap.id, `n${index + 1}`));

  /** 从快照 features 采集显式速度选择(等效默认/不支持的都不存,保持模板精简) */
  const speedFromSnapshot = (snap: ImportableAgentSnapshot) => {
    const feature = pickSpeedFeature(snap.features);
    return feature ? explicitSpeedSelection(feature) : null;
  };

  const buildNodes = (source: readonly ImportableAgentSnapshot[]): TemplateNodeConfig[] =>
    source.map((snap) => {
      const speed = speedFromSnapshot(snap);
      return {
        key: agentIdToKey.get(snap.id) as string,
        parentKey: parentByKey.get(snap.id) ? (agentIdToKey.get(parentByKey.get(snap.id) as string) ?? null) : null,
        title: snap.title ?? "",
        provider: snap.provider,
        model: snap.model ?? "",
        thinkingOptionId: snap.thinkingOptionId,
        ...(snap.modeId ? { modeId: snap.modeId } : {}),
        ...(speed ? { speedFeatureId: speed.id, speedFeatureValue: speed.value } : {}),
      };
    });

  // 预留虚拟主节点的位置:多根时最终节点数 = 保留数 + 1,超出上限就继续收缩
  let keptCurrent = kept;
  let nodes = buildNodes(keptCurrent);
  let rootCount = nodes.filter((node) => !node.parentKey).length;
  while (rootCount > 1 && nodes.length + 1 > TEMPLATE_MAX_NODES && keptCurrent.length > 1) {
    keptCurrent = keptCurrent.slice(0, -1);
    for (const removed of kept.slice(keptCurrent.length)) agentIdToKey.delete(removed.id);
    nodes = buildNodes(keptCurrent);
    rootCount = nodes.filter((node) => !node.parentKey).length;
  }
  if (keptCurrent.length < kept.length) {
    notes.push(`为满足 ${TEMPLATE_MAX_NODES} 节点上限,已收缩至 ${keptCurrent.length} 个节点`);
    const removedCount = live.length - keptCurrent.length;
    if (removedCount > 0) notes.push(`另有 ${removedCount} 个未归档节点未纳入模板`);
  }

  let virtualRoot = false;
  const roots = nodes.filter((node) => !node.parentKey);
  if (roots.length > 1) {
    // 生成虚拟主节点,原根全部挂其下,保持森林关系;配置取第一个根,需用户在编辑器确认
    virtualRoot = true;
    const seed = roots[0];
    const virtualNode: TemplateNodeConfig = {
      key: "main",
      parentKey: null,
      title: "主节点(自动生成)",
      provider: seed.provider,
      model: seed.model,
      thinkingOptionId: seed.thinkingOptionId,
      ...(seed.modeId ? { modeId: seed.modeId } : {}),
      ...(seed.speedFeatureId !== undefined ? { speedFeatureId: seed.speedFeatureId } : {}),
      ...(seed.speedFeatureValue !== undefined ? { speedFeatureValue: seed.speedFeatureValue } : {}),
    };
    nodes.forEach((node) => {
      if (!node.parentKey) node.parentKey = virtualNode.key;
    });
    nodes.unshift(virtualNode);
    if (nodes.length > TEMPLATE_MAX_NODES) {
      notes.push(`加入虚拟主节点后超过 ${TEMPLATE_MAX_NODES} 个上限,需在编辑器中删除多余节点`);
    }
    notes.push(`检测到 ${roots.length} 个根节点,已生成虚拟主节点并挂接全部根节点`);
    notes.push("虚拟主节点的提供方/模型取自第一个根节点,请在保存前确认");
  }
  return { name: options.suggestedName, nodes, notes, virtualRoot, skippedArchived };
}
