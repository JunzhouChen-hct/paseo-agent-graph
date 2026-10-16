import { useCallback, useEffect, useRef, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";

/** mini 交互界面里的一条对话行。 */
export interface TimelineView {
  key: string;
  kind: "user" | "assistant" | "reasoning" | "tool" | "error" | "notice";
  text: string;
  meta: string | null;
  messageId: string | null;
}

/** 从 timeline 响应的 agent 快照里提取配置与用量信息。 */
export interface AgentExtras {
  model: string | null;
  currentModeId: string | null;
  modes: { id: string; label: string }[];
  thinkingOptionId: string | null;
  thinkingOptions: { featureId: string; options: { id: string; label: string }[] } | null;
  contextUsed: number | null;
  contextMax: number | null;
}

interface RawItemShape {
  type: string;
  text?: string;
  message?: string;
  name?: string;
  status?: string;
  messageId?: string;
}

interface AgentSnapshotLike {
  model?: string | null;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  availableModes?: { id: string; label: string }[];
  features?: Array<{
    type: string;
    id: string;
    label?: string;
    options?: { id: string; label: string }[];
  }>;
  lastUsage?: {
    contextWindowUsedTokens?: number;
    contextWindowMaxTokens?: number;
  } | null;
}

interface TimelinePayloadLike {
  entries?: Array<{ item: RawItemShape; timestamp: string }>;
  agent?: AgentSnapshotLike | null;
}

function viewOfItem(item: RawItemShape, index: number, timestamp: string): TimelineView | null {
  const key = `${timestamp}-${index}`;
  const messageId = item.messageId ?? null;
  switch (item.type) {
    case "user_message":
      return { key, kind: "user", text: item.text ?? "", meta: null, messageId };
    case "assistant_message":
      return { key, kind: "assistant", text: item.text ?? "", meta: null, messageId };
    case "reasoning":
      return { key, kind: "reasoning", text: item.text ?? "", meta: null, messageId };
    case "tool_call":
      return {
        key,
        kind: "tool",
        text: item.name ?? "tool",
        meta: item.status ?? null,
        messageId,
      };
    case "error":
      return { key, kind: "error", text: item.message ?? "发生错误", meta: null, messageId };
    case "notification":
      return { key, kind: "notice", text: item.message ?? "", meta: item.status ?? null, messageId };
    default:
      return null;
  }
}

function extractExtras(payload: TimelinePayloadLike): AgentExtras | null {
  const agent = payload.agent;
  if (!agent) return null;
  const selectFeatures = (agent.features ?? []).filter((feature) => feature.type === "select");
  const thinkingId = agent.thinkingOptionId ?? null;
  let thinkingOptions: AgentExtras["thinkingOptions"] = null;
  for (const feature of selectFeatures) {
    const options = (feature.options ?? []).map((option) => ({ id: option.id, label: option.label }));
    if (options.length === 0) continue;
    if (thinkingId && options.some((option) => option.id === thinkingId)) {
      thinkingOptions = { featureId: feature.id, options };
      break;
    }
  }
  if (!thinkingOptions && thinkingId) {
    const guessed = selectFeatures.find((feature) => /think/i.test(feature.id));
    if (guessed) {
      thinkingOptions = {
        featureId: guessed.id,
        options: (guessed.options ?? []).map((option) => ({ id: option.id, label: option.label })),
      };
    }
  }
  const usage = agent.lastUsage ?? null;
  return {
    model: agent.model ?? null,
    currentModeId: agent.currentModeId ?? null,
    modes: (agent.availableModes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
    thinkingOptionId: thinkingId,
    thinkingOptions,
    contextUsed: usage?.contextWindowUsedTokens ?? null,
    contextMax: usage?.contextWindowMaxTokens ?? null,
  };
}

/**
 * 拉取 agent 最近一段对话(tail)与配置快照。
 * 选中变化或主动 reload 时刷新;模式/模型的即时变化在下次 reload 时反映。
 */
export function useAgentTimeline(
  agentId: string | null,
  limit = 60,
): {
  items: TimelineView[];
  extras: AgentExtras | null;
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
} {
  const paseo = usePaseo();
  const [items, setItems] = useState<TimelineView[]>([]);
  const [extras, setExtras] = useState<AgentExtras | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求序号:agentId 切换时旧 fetch 可能晚于新 fetch 返回,过期响应直接丢弃
  const reloadSeqRef = useRef(0);
  // 数据归属 scope:记录最后一次成功 fetch 的 agentId。AgentConsole 切换会话不重挂载,
  // useState 清空要等 effect(commit 后)才生效,首帧仍会渲染上个会话的 items/extras
  // (含上下文占用);这里在 render 输出处做 gate,只暴露属于当前 agentId 的数据。
  const scopeRef = useRef<string | null>(null);
  // 错误归属:fetch 失败时不更新 scopeRef(数据 gate 仍拦截旧会话数据),
  // 错误单独记录归属;否则初次加载失败也查无 scope,错误被 gate 吞掉,
  // 面板误显示"暂无对话记录"而不是真实失败原因
  const errorScopeRef = useRef<string | null>(null);
  // 当前 agentId 镜像:reload 可能以旧闭包被调用(如切换会话前发出的异步回调持有了
  // 旧会话的 reload),此时请求所属会话已不是当前会话,直接忽略,
  // 避免旧会话响应递增全局序号挤掉新会话请求、并覆盖新会话数据
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;

  const reload = useCallback(async () => {
    if (agentId !== agentIdRef.current) return;
    const seq = ++reloadSeqRef.current;
    if (!agentId) {
      scopeRef.current = null;
      setItems([]);
      setExtras(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload: TimelinePayloadLike = await paseo.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", limit, projection: "projected" });
      if (seq !== reloadSeqRef.current) return;
      scopeRef.current = agentId;
      const views: TimelineView[] = [];
      (payload.entries ?? []).forEach((entry, index) => {
        const view = viewOfItem(entry.item, index, entry.timestamp);
        if (view) views.push(view);
      });
      setItems(views);
      setExtras(extractExtras(payload));
    } catch (err) {
      if (seq !== reloadSeqRef.current) return;
      errorScopeRef.current = agentId;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) setLoading(false);
    }
  }, [paseo, agentId, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const scoped = scopeRef.current === agentId;
  return {
    items: scoped ? items : [],
    extras: scoped ? extras : null,
    loading,
    error: errorScopeRef.current === agentId ? error : null,
    reload,
  };
}
