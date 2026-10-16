/**
 * project 级展示范围的纯数据层:目录条目规范化、projectKey/workspaceId 双重 join、
 * 订阅增量与分页合并、卡片工作区标识、跨 workspace 创建目标。
 * 不依赖 React 与 Node API,便于 node:test 直接覆盖。
 *
 * 项目归属只用真实来源:agent 条目的 project.projectKey 与真实 workspaceId join,
 * 绝不按 cwd 前缀猜测,也不假设 projectId === projectKey。
 */
import type { AgentRunStatus } from "./graph";

/** daemon 目录条目里的 project placement(本插件用到的子集)。 */
export interface RawProjectPlacement {
  projectKey?: string | null;
  workspaceName?: string | null;
}

/** 目录层的 agent 条目:由 daemon 目录快照规范化而来。 */
export interface DirectoryAgent {
  id: string;
  workspaceId: string;
  /** 目录 placement 里的真实 projectKey;部分更新可能缺失,缺失时保留旧值。 */
  projectKey: string | null;
  /** 目录 placement 里的 workspaceName:工作区归档后(不在活跃列表)仍可显示标识。 */
  placementWorkspaceName: string | null;
  title: string | null;
  provider: string;
  model: string | null;
  status: AgentRunStatus;
  archived: boolean;
  requiresAttention: boolean;
  createdAt: string;
}

/** 卡片工作区标识与诊断需要的最小工作区信息。 */
export interface ProjectWorkspaceInfo {
  id: string;
  name: string;
  title: string | null;
  /** 真实 projectKey(来自工作区描述符的 project 字段);缺失为 null。 */
  projectKey: string | null;
}

/** daemon 目录 agent 快照里本插件用到的字段;协议中 workspaceId/requiresAttention 可选。 */
export interface RawDirectoryAgent {
  id: string;
  workspaceId?: string | null;
  title?: string | null;
  provider: string;
  model?: string | null;
  status: AgentRunStatus;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  createdAt: string;
}

/** daemon 目录条目:agent 快照 + 可缺失的 project placement(upsert 中 project 可为 null)。 */
export interface RawDirectoryEntry {
  agent: RawDirectoryAgent;
  project?: RawProjectPlacement | null;
}

/** daemon 工作区描述符里本插件用到的字段。 */
export interface RawWorkspaceDescriptor {
  id: string;
  projectId?: string | null;
  name: string;
  title?: string | null;
  project?: { projectKey?: string | null } | null;
}

/**
 * 规范化目录条目。workspaceId 缺失的条目无法参与任何 join,返回 null 由调用方决定去留。
 * project placement 允许缺失(协议 upsert 中可 null):此时 projectKey/placement 保持 null,
 * 由 join 逻辑与"保留已知条目"策略兜底。
 */
export function toDirectoryAgent(raw: RawDirectoryAgent): DirectoryAgent | null {
  if (!raw.workspaceId) return null;
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    projectKey: null,
    placementWorkspaceName: null,
    title: raw.title ?? null,
    provider: raw.provider,
    model: raw.model ?? null,
    status: raw.status,
    archived: Boolean(raw.archivedAt),
    requiresAttention: Boolean(raw.requiresAttention),
    createdAt: raw.createdAt,
  };
}

/** 把真实 placement 合入条目:projectKey/workspaceName 都来自 daemon,不是推断值。 */
export function applyPlacement(
  agent: DirectoryAgent,
  project: RawProjectPlacement | null | undefined,
): void {
  if (!project) return;
  if (typeof project.projectKey === "string") agent.projectKey = project.projectKey;
  if (typeof project.workspaceName !== "undefined") {
    agent.placementWorkspaceName = project.workspaceName ?? null;
  }
}

export type AgentDirectoryMap = Map<string, DirectoryAgent>;
export type WorkspaceMap = Map<string, ProjectWorkspaceInfo>;

/**
 * 目录 upsert:agent 快照完整,project placement 可缺失。
 * 缺 workspaceId 的部分更新不能覆盖已知条目——避免把已正确 join 的节点错移出项目;
 * 缺 placement 的更新保留旧 placement,避免归档工作区节点被误清除。
 */
export function applyAgentUpsert(map: AgentDirectoryMap, entry: RawDirectoryEntry): void {
  const agent = toDirectoryAgent(entry.agent);
  if (agent) {
    applyPlacement(agent, entry.project);
    map.set(agent.id, agent);
    return;
  }
  if (!map.has(entry.agent.id)) return;
  // 已知条目 + 不完整更新:保留 workspaceId/projectKey,只刷新确定的安全字段
  const known = map.get(entry.agent.id)!;
  if (typeof entry.agent.title !== "undefined") known.title = entry.agent.title ?? null;
  if (typeof entry.agent.model !== "undefined") known.model = entry.agent.model ?? null;
  if (typeof entry.agent.requiresAttention !== "undefined") {
    known.requiresAttention = Boolean(entry.agent.requiresAttention);
  }
  applyPlacement(known, entry.project);
}

export function applyAgentRemove(map: AgentDirectoryMap, agentId: string): void {
  map.delete(agentId);
}

/** 重连/首轮 snapshot:整体替换,清掉不在快照里的旧条目,防泄漏。 */
export function replaceAgentsFromSnapshot(
  map: AgentDirectoryMap,
  entries: ReadonlyArray<RawDirectoryEntry>,
): void {
  map.clear();
  mergeAgentPage(map, entries);
}

/** 分页 merge:跨页累积,第 201+ 个节点不丢。 */
export function mergeAgentPage(
  map: AgentDirectoryMap,
  entries: ReadonlyArray<RawDirectoryEntry>,
): void {
  for (const entry of entries) applyAgentUpsert(map, entry);
}

/** 首轮/重连工作区 snapshot:整体替换,且只保留真实属于该 project 的工作区。 */
export function replaceWorkspacesFromSnapshot(
  map: WorkspaceMap,
  entries: ReadonlyArray<RawWorkspaceDescriptor>,
  projectId: string,
): void {
  map.clear();
  for (const workspace of entries) applyWorkspaceUpsert(map, workspace, projectId);
}

/**
 * 工作区 upsert:projectId 精确匹配才收下;匹配不上(含项目迁移)一律移除,
 * 防止其他 project 的工作区泄漏进当前总览。
 */
export function applyWorkspaceUpsert(
  map: WorkspaceMap,
  workspace: RawWorkspaceDescriptor,
  projectId: string,
): void {
  if (workspace.projectId !== projectId) {
    map.delete(workspace.id);
    return;
  }
  map.set(workspace.id, {
    id: workspace.id,
    name: workspace.name,
    title: workspace.title ?? null,
    projectKey: workspace.project?.projectKey ?? null,
  });
}

export function applyWorkspaceRemove(map: WorkspaceMap, workspaceId: string): void {
  map.delete(workspaceId);
}

/** 分页 merge 工作区条目。 */
export function mergeWorkspacePage(
  map: WorkspaceMap,
  entries: ReadonlyArray<RawWorkspaceDescriptor>,
  projectId: string,
): void {
  for (const workspace of entries) applyWorkspaceUpsert(map, workspace, projectId);
}

/**
 * 项目内 agent:真实 projectKey 精确匹配 或 workspaceId 在活跃工作区集合内。
 * - projectKey 命中可覆盖已归档工作区的节点(其 workspaceId 不在活跃列表)——
 *   归档开关不因工作区归档而静默回归;
 * - 只在活跃集合内、placement 缺 projectKey 的更新节点也能正确纳入;
 * - 两者都靠不上的条目(未知来源/其他 project)严格排除。
 */
export function agentsInProject(
  map: AgentDirectoryMap,
  projectKey: string | null,
  activeWorkspaceIds: ReadonlySet<string>,
): DirectoryAgent[] {
  const list: DirectoryAgent[] = [];
  for (const agent of map.values()) {
    const byKey = projectKey !== null && agent.projectKey !== null && agent.projectKey === projectKey;
    const byWorkspace = activeWorkspaceIds.has(agent.workspaceId);
    if (byKey || byWorkspace) list.push(agent);
  }
  return list.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** 面板"显示已归档"开关:关闭时过滤归档节点,开启时全量保留。 */
export function visibleAgents(agents: DirectoryAgent[], showArchived: boolean): DirectoryAgent[] {
  return showArchived ? [...agents] : agents.filter((agent) => !agent.archived);
}

/** 工作区显示名:标题优先(去空白),名称兜底。 */
export function workspaceDisplayName(workspace: ProjectWorkspaceInfo): string {
  return workspace.title?.trim() || workspace.name;
}

/**
 * 卡片工作区标识:活跃工作区用最新显示名;工作区已归档(不在活跃列表)时
 * 回落到目录 placement 里的 workspaceName;两者皆缺则不显示。
 */
export function workspaceBadgeLabel(
  agent: DirectoryAgent,
  workspacesById: ReadonlyMap<string, ProjectWorkspaceInfo>,
): string | null {
  const active = workspacesById.get(agent.workspaceId);
  if (active) return workspaceDisplayName(active);
  return agent.placementWorkspaceName ?? null;
}

/** 标识统一截断(按码点),超长以省略号收尾。 */
export function truncateWorkspaceLabel(label: string, max = 16): string {
  if (max < 1) return "";
  const chars = [...label];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : label;
}

/**
 * "新建子 Agent" 的目标 workspace:必须跟随父 agent 所属 workspace,
 * 绝不允许回落到面板当前 workspace(项目总览下两者可能不同)。
 * 父节点缺失(已删除/尚未进入目录)时返回 null,由调用方拒绝创建而不是猜一个。
 */
export function creationTargetWorkspaceId(
  parent: { workspaceId: string } | undefined | null,
): string | null {
  return parent?.workspaceId ?? null;
}
