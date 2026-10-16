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
  // 请求序号:agentId 切换时旧 fetch 可能晚于新 fetch 返回,过期响应直接丢弃,
  // 避免把上个会话的 items/extras(含上下文占用)误显示给新会话
  const reloadSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    if (!agentId) {
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
      const views: TimelineView[] = [];
      (payload.entries ?? []).forEach((entry, index) => {
        const view = viewOfItem(entry.item, index, entry.timestamp);
        if (view) views.push(view);
      });
      setItems(views);
      setExtras(extractExtras(payload));
    } catch (err) {
      if (seq !== reloadSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) setLoading(false);
    }
  }, [paseo, agentId, limit]);

  useEffect(() => {
    // 切换 agent 时先清掉上个会话的数据,避免新会话短暂显示旧占用
    setItems([]);
    setExtras(null);
    void reload();
  }, [reload]);

  return { items, extras, loading, error, reload };
}
