import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { agentMetadataRpc, type AgentNodeMetadata } from "../shared/agent-metadata";

/** 轮询间隔:分支缓存 TTL(服务端 5s)之上的低成本刷新节奏。 */
const POLL_INTERVAL_MS = 30_000;

/**
 * 批量拉取节点元数据(思考强度/速度模式/开发分支)。
 * 元数据不进目录订阅(directory 层),由本 hook 走插件 RPC 定期刷新;
 * 单个 agent 查询失败按未知处理,不影响其余节点。
 */
export function useAgentMetadata(agentIds: string[]): Record<string, AgentNodeMetadata> {
  const fetchMetadata = useRpc(agentMetadataRpc);
  const [items, setItems] = useState<Record<string, AgentNodeMetadata>>({});
  // 以稳定字符串为依赖,避免数组引用变化造成反复请求
  const idsKey = useMemo(() => agentIds.join("\u0000"), [agentIds]);
  // 引用稳定缓存:内容未变的项保持旧对象引用,让 memo 的卡片跳过无效重渲染
  const stableRef = useRef<Record<string, AgentNodeMetadata>>({});

  useEffect(() => {
    const ids = idsKey ? idsKey.split("\u0000") : [];
    let cancelled = false;

    if (ids.length === 0) {
      stableRef.current = {};
      setItems({});
      return;
    }

    const run = () => {
      void fetchMetadata({ agentIds: ids })
        .then(({ items: next }) => {
          if (cancelled) return;
          // 查询失败的 agent(null)沿用上次结果,避免已显示的元数据闪烁消失;
          // 内容未变的项保持旧引用,让 memo 的卡片跳过整图重渲染
          const merged: Record<string, AgentNodeMetadata> = {};
          for (const id of ids) {
            const value = next[id] ?? null;
            const prev: AgentNodeMetadata | undefined = stableRef.current[id];
            const kept =
              value && prev && JSON.stringify(value) === JSON.stringify(prev) ? prev : (value ?? prev);
            if (kept) merged[id] = kept;
          }
          stableRef.current = merged;
          setItems(merged);
        })
        .catch(() => {
          // 拉取失败保留上一次结果,等下一轮重试
        });
    };

    run();
    const timer = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [idsKey, fetchMetadata]);

  return items;
}
