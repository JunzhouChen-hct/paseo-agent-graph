import { useEffect, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import type { AgentRunStatus } from "../shared/graph";

/** 目录层数据：来自 agents.list 订阅,含归档状态,但没有 parentAgentId。 */
export interface DirectoryAgent {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: AgentRunStatus;
  archived: boolean;
  requiresAttention: boolean;
  createdAt: string;
}

interface RawAgent {
  id: string;
  title?: string | null;
  provider: string;
  model?: string | null;
  status: AgentRunStatus;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  createdAt: string;
  workspaceId?: string;
}

function toDirectoryAgent(agent: RawAgent): DirectoryAgent {
  return {
    id: agent.id,
    title: agent.title ?? null,
    provider: agent.provider,
    model: agent.model ?? null,
    status: agent.status,
    archived: Boolean(agent.archivedAt),
    requiresAttention: Boolean(agent.requiresAttention),
    createdAt: agent.createdAt,
  };
}

/**
 * 订阅全量 agent 目录(含已归档),在客户端按 workspaceId 过滤。
 * daemon 的目录查询不支持按 workspace 过滤,且目录条目里没有 parentAgentId
 * ——后者由卡片层的 useAgent 补齐。
 */
export function useAgentDirectory(workspaceId: string): {
  agents: DirectoryAgent[];
  ready: boolean;
  error: string | null;
} {
  const paseo = usePaseo();
  const [map, setMap] = useState<Map<string, DirectoryAgent>>(new Map());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    const next = new Map<string, DirectoryAgent>();
    const commit = () => setMap(new Map(next));

    void paseo.agents
      .list({ filter: { includeArchived: true }, subscribe: {} })
      .then(({ subscription }) => {
        if (cancelled) {
          void subscription.release();
          return;
        }
        const unsubscribe = subscription.subscribe({
          snapshot({ entries }) {
            if (cancelled) return;
            for (const { agent } of entries) {
              if (agent.workspaceId !== workspaceId) continue;
              next.set(agent.id, toDirectoryAgent(agent as RawAgent));
            }
            commit();
            setReady(true);
          },
          update(message) {
            if (cancelled || message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") {
              const agent = update.agent as RawAgent;
              const known = next.has(agent.id);
              if (agent.workspaceId !== undefined && agent.workspaceId !== workspaceId) {
                if (known) {
                  next.delete(agent.id);
                  commit();
                }
                return;
              }
              if (!known && agent.workspaceId === undefined) return;
              next.set(agent.id, toDirectoryAgent(agent));
              commit();
            } else if (update.kind === "remove") {
              if (next.delete(update.agentId)) commit();
            }
          },
          error(err) {
            if (!cancelled) setError(String(err));
          },
        });
        release = unsubscribe;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      release?.();
    };
  }, [paseo, workspaceId]);

  const agents = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { agents, ready, error };
}
