import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import {
  agentsInProject,
  applyAgentRemove,
  applyAgentUpsert,
  applyWorkspaceRemove,
  applyWorkspaceUpsert,
  mergeAgentPage,
  mergeWorkspacePage,
  replaceAgentsFromSnapshot,
  replaceWorkspacesFromSnapshot,
  type AgentDirectoryMap,
  type DirectoryAgent,
  type ProjectWorkspaceInfo,
  type WorkspaceMap,
} from "../shared/project-scope";
import type { PaseoAgentListResult, PaseoWorkspaceListResult } from "@getpaseo/client";

export type { DirectoryAgent, ProjectWorkspaceInfo } from "../shared/project-scope";

/** 目录分页上限:协议单页最大 200,超过部分用 cursor 续拉。 */
const PAGE_LIMIT = 200;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 目录订阅的对外状态:项目内全部 agent(含归档、含其他工作区)。 */
export interface ProjectAgentDirectory {
  /** 当前 workspace 所属的真实 projectId;未知时为 null(此时绝不订阅/展示)。 */
  projectId: string | null;
  agents: DirectoryAgent[];
  /** 项目内活跃工作区列表(卡片工作区标识与诊断用)。 */
  workspaces: ProjectWorkspaceInfo[];
  projectName: string | null;
  /** project 已知、projectKey 已解析且两路订阅的首个 snapshot 都已提交。 */
  ready: boolean;
  error: string | null;
  /** 订阅/分页失败后的手动重试;不自动无限重拉。 */
  retry(): void;
}

/**
 * project 级 agent 目录:以当前 workspace 的真实 projectId 聚合该项目
 * 全部 workspace 的 agent(含已归档)。
 *
 * 归属判定只用真实来源:
 * - projectKey 从 projects.list 按 projectId 精确解析(不假设 projectId === projectKey),
 *   工作区描述符的 project.projectKey 作为第二来源;
 * - agent 条目的 project.projectKey 精确匹配(覆盖已归档工作区的节点),
 *   或 workspaceId 在活跃工作区集合内;两者都靠不上的一律不显示;
 * - project 未就绪前不订阅、不展示,绝不把全 host 的 agent 当作当前项目。
 */
export function useProjectAgentDirectory(workspaceId: string): ProjectAgentDirectory {
  const paseo = usePaseo();
  const project = useWorkspace(workspaceId, (workspace) => ({
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
  }));
  const projectId = project?.projectId ?? null;
  const projectName = project?.projectDisplayName ?? null;

  const [agentMap, setAgentMap] = useState<AgentDirectoryMap>(() => new Map());
  const [workspaceMap, setWorkspaceMap] = useState<WorkspaceMap>(() => new Map());
  const [agentsReady, setAgentsReady] = useState(false);
  const [workspacesReady, setWorkspacesReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 当前数据归属的 projectId:effect 重置发生在渲染之后,渲染层用它把
  // project 切换的首帧旧数据同步屏蔽掉(agents=[]/ready=false)
  const [dataProjectId, setDataProjectId] = useState<string | null>(null);
  // 当前项目的真实 projectKey(projects.list 解析;工作区描述符兜底)
  const [resolvedProjectKey, setResolvedProjectKey] = useState<string | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!projectId) {
      // project 未知:立刻清空并保持未就绪
      setAgentMap(new Map());
      setWorkspaceMap(new Map());
      setAgentsReady(false);
      setWorkspacesReady(false);
      setError(null);
      setDataProjectId(null);
      setResolvedProjectKey(null);
      return;
    }

    let cancelled = false;
    const releases: Array<() => void> = [];

    // workspace/project 切换或重试:立刻 reset,避免上一个 project 的数据闪现
    setAgentMap(new Map());
    setWorkspaceMap(new Map());
    setAgentsReady(false);
    setWorkspacesReady(false);
    setError(null);
    setResolvedProjectKey(null);
    setDataProjectId(projectId);

    // ---- projectKey 解析:projects.list 按 projectId 精确匹配 ----
    void paseo.projects
      .list()
      .then((result) => {
        if (cancelled) return;
        const match = (result.projects ?? []).find((entry) => entry.projectId === projectId);
        if (match?.projectKey) setResolvedProjectKey(match.projectKey);
        // 缺 projectKey 时不报错:工作区描述符的 project.projectKey 是第二来源
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });

    // ---- 工作区目录:真实 projectId 过滤 + 分页 + 订阅动态增删 ----
    const workspaces: WorkspaceMap = new Map();
    let workspacePageGeneration = 0;
    const commitWorkspaces = () => {
      if (!cancelled) setWorkspaceMap(new Map(workspaces));
    };

    const fetchWorkspacePages = async (cursor: string): Promise<void> => {
      const generation = ++workspacePageGeneration;
      let next: string | undefined = cursor;
      try {
        while (next && !cancelled) {
          const page: PaseoWorkspaceListResult = await paseo.workspaces.list({
            filter: { projectId },
            page: { limit: PAGE_LIMIT, cursor: next },
          });
          if (cancelled || generation !== workspacePageGeneration) return;
          mergeWorkspacePage(workspaces, page.entries ?? [], projectId);
          commitWorkspaces();
          next = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
        }
      } catch (err) {
        // 保留已加载的部分数据;错误可见、由用户手动 retry,不做自动无限重拉
        if (!cancelled && generation === workspacePageGeneration) setError(errorText(err));
      }
    };

    void paseo.workspaces
      .list({ filter: { projectId }, page: { limit: PAGE_LIMIT }, subscribe: {} })
      .then(({ subscription }) => {
        if (cancelled) {
          void subscription.release();
          return;
        }
        releases.push(() => {
          void subscription.release();
        });
        const unsubscribe = subscription.subscribe({
          snapshot(result) {
            if (cancelled) return;
            replaceWorkspacesFromSnapshot(workspaces, result.entries ?? [], projectId);
            commitWorkspaces();
            setWorkspacesReady(true);
            // 新 snapshot 作废仍在途的旧分页,然后从下一页续拉
            workspacePageGeneration += 1;
            const info = result.pageInfo;
            if (info?.hasMore && info.nextCursor) void fetchWorkspacePages(info.nextCursor);
          },
          update(message) {
            if (cancelled || message.type !== "workspace_update") return;
            const payload = message.payload;
            if (payload.kind === "upsert") {
              applyWorkspaceUpsert(workspaces, payload.workspace, projectId);
            } else {
              applyWorkspaceRemove(workspaces, payload.id);
            }
            commitWorkspaces();
          },
          error(err) {
            if (!cancelled) setError(errorText(err));
          },
        });
        releases.push(unsubscribe);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });

    // ---- agent 目录:全 host 订阅(含归档),展示时按 projectKey/活跃工作区 join ----
    const agents: AgentDirectoryMap = new Map();
    let agentPageGeneration = 0;
    const commitAgents = () => {
      if (!cancelled) setAgentMap(new Map(agents));
    };

    const fetchAgentPages = async (cursor: string): Promise<void> => {
      const generation = ++agentPageGeneration;
      let next: string | undefined = cursor;
      try {
        while (next && !cancelled) {
          const page: PaseoAgentListResult = await paseo.agents.list({
            filter: { includeArchived: true },
            page: { limit: PAGE_LIMIT, cursor: next },
          });
          if (cancelled || generation !== agentPageGeneration) return;
          mergeAgentPage(agents, page.entries ?? []);
          commitAgents();
          next = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
        }
      } catch (err) {
        if (!cancelled && generation === agentPageGeneration) setError(errorText(err));
      }
    };

    void paseo.agents
      .list({ filter: { includeArchived: true }, page: { limit: PAGE_LIMIT }, subscribe: {} })
      .then(({ subscription }) => {
        if (cancelled) {
          void subscription.release();
          return;
        }
        releases.push(() => {
          void subscription.release();
        });
        const unsubscribe = subscription.subscribe({
          snapshot(result) {
            if (cancelled) return;
            // 重连 snapshot:整体替换旧缓存,防止已移除/已迁移节点泄漏
            replaceAgentsFromSnapshot(agents, result.entries ?? []);
            commitAgents();
            setAgentsReady(true);
            agentPageGeneration += 1;
            const info = result.pageInfo;
            if (info?.hasMore && info.nextCursor) void fetchAgentPages(info.nextCursor);
          },
          update(message) {
            if (cancelled || message.type !== "agent_update") return;
            const payload = message.payload;
            if (payload.kind === "upsert") {
              applyAgentUpsert(agents, payload);
            } else {
              applyAgentRemove(agents, payload.agentId);
            }
            commitAgents();
          },
          error(err) {
            if (!cancelled) setError(errorText(err));
          },
        });
        releases.push(unsubscribe);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });

    return () => {
      cancelled = true;
      for (const release of releases.splice(0)) {
        try {
          release();
        } catch {
          // 释放失败不影响卸载
        }
      }
    };
  }, [paseo, projectId, attempt]);

  // 渲染层 scope gate:projectId 切换后的首帧(effect 尚未重置)也绝不显示旧 project 数据
  const scopeActive = projectId !== null && dataProjectId === projectId;

  const workspaceIds = useMemo(
    () => (scopeActive ? new Set(workspaceMap.keys()) : new Set<string>()),
    [scopeActive, workspaceMap],
  );
  const workspaces = useMemo(
    () =>
      scopeActive
        ? [...workspaceMap.values()].sort(
            (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
          )
        : [],
    [scopeActive, workspaceMap],
  );

  // projectKey 第二来源:项目内工作区描述符携带的 project.projectKey
  const fallbackProjectKey = useMemo(() => {
    if (!scopeActive) return null;
    for (const workspace of workspaceMap.values()) {
      if (workspace.projectKey) return workspace.projectKey;
    }
    return null;
  }, [scopeActive, workspaceMap]);
  const projectKey = resolvedProjectKey ?? fallbackProjectKey;

  const agents = useMemo(
    () => (scopeActive ? agentsInProject(agentMap, projectKey, workspaceIds) : []),
    [scopeActive, agentMap, projectKey, workspaceIds],
  );

  const projectKeyMissing =
    scopeActive && agentsReady && workspacesReady && projectKey === null;
  const shownError =
    error ??
    (projectKeyMissing
      ? "无法确定当前项目的 projectKey,不能安全聚合项目范围,请重试"
      : null);

  return {
    projectId,
    agents,
    workspaces,
    projectName,
    ready: scopeActive && agentsReady && workspacesReady && projectKey !== null,
    error: shownError,
    retry,
  };
}
