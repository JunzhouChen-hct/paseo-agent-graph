import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  METADATA_BATCH_SIZE,
  agentMetadataRpc,
  mergeBatchResults,
  splitBatches,
  type MetadataBatchResult,
} from "../shared/agent-metadata";
import type { AgentNodeMetadata } from "../shared/agent-metadata";

/** 轮询间隔:分支缓存 TTL(服务端 5s)之上的低成本刷新节奏。 */
const POLL_INTERVAL_MS = 30_000;

/** 批次失败的上报间隔:同一轮多批失败只记一条,且两次记录至少间隔该时长。 */
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * 批量拉取节点元数据(思考强度/速度模式/开发分支)。
 * 元数据不进目录订阅(directory 层),由本 hook 走插件 RPC 定期刷新。
 * agentIds 超过 RPC 单次上限时自动分片,单批失败不影响其他批:
 * 失败批次的节点沿用上次结果,批次数经限频后写入 console 便于排查。
 */
export function useAgentMetadata(agentIds: string[]): Record<string, AgentNodeMetadata> {
  const fetchMetadata = useRpc(agentMetadataRpc);
  const [items, setItems] = useState<Record<string, AgentNodeMetadata>>({});
  // 以稳定字符串为依赖,避免数组引用变化造成反复请求
  const idsKey = useMemo(() => agentIds.join("\u0000"), [agentIds]);
  // 引用稳定缓存:内容未变的项保持旧对象引用,让 memo 的卡片跳过无效重渲染
  const stableRef = useRef<Record<string, AgentNodeMetadata>>({});
  // 在途/时序保护:同一时刻最多一次请求;晚到的旧响应按 epoch 丢弃
  const inFlightRef = useRef(false);
  const epochRef = useRef(0);
  // 限频错误上报
  const lastErrorLogRef = useRef(0);

  useEffect(() => {
    const ids = idsKey ? idsKey.split("\u0000") : [];
    let cancelled = false;

    if (ids.length === 0) {
      stableRef.current = {};
      setItems({});
      return;
    }

    const run = () => {
      // 上一轮仍在途则跳过本轮,避免并行请求与乱序覆盖
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const epoch = ++epochRef.current;

      const batches = splitBatches(ids, METADATA_BATCH_SIZE);
      const pending = Promise.allSettled(
        batches.map((batch) => fetchMetadata({ agentIds: batch })),
      ) as Promise<MetadataBatchResult[]>;

      void pending.then((settled) => {
        inFlightRef.current = false;
        // 已取消或期间开启了新一轮 → 丢弃这次晚到的旧结果
        if (cancelled || epoch !== epochRef.current) return;
        const { items: merged, failedBatches } = mergeBatchResults(batches, settled);
        // 失败批次沿用上次结果,避免已显示的元数据闪烁消失
        const next: Record<string, AgentNodeMetadata> = {};
        for (const id of ids) {
          const value = merged[id];
          const prev: AgentNodeMetadata | undefined = stableRef.current[id];
          const kept =
            value && prev && JSON.stringify(value) === JSON.stringify(prev) ? prev : (value ?? prev);
          if (kept) next[id] = kept;
        }
        stableRef.current = next;
        setItems(next);

        if (failedBatches > 0) {
          const now = Date.now();
          if (now - lastErrorLogRef.current >= ERROR_LOG_INTERVAL_MS) {
            lastErrorLogRef.current = now;
            console.error(
              `[agent-graph] 元数据查询 ${failedBatches}/${batches.length} 批失败,部分节点显示上次结果`,
            );
          }
        }
      });
    };

    run();
    const timer = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      // 清理后允许立即开始下一轮;在途响应会因 cancelled/epoch 丢弃
      inFlightRef.current = false;
      epochRef.current += 1;
    };
  }, [idsKey, fetchMetadata]);

  return items;
}
