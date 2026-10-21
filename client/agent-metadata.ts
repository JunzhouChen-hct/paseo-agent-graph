import { useEffect, useMemo, useRef, useState } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { debugReportRpc } from "../shared/graph";
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

/** 快轮询间隔:有压缩中标记时启用,压缩完成的检测延迟从 30s 降到秒级。 */
const POLL_FAST_INTERVAL_MS = 3_000;

/** 批次失败的上报间隔:同一轮多批失败只记一条,且两次记录至少间隔该时长。 */
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * 批量拉取节点元数据(思考强度/速度模式/开发分支)。
 * 元数据不进目录订阅(directory 层),由本 hook 走插件 RPC 定期刷新。
 * agentIds 超过 RPC 单次上限时自动分片,单批失败不影响其他批:
 * 失败批次的节点沿用上次结果,批次数经限频后写入 console 便于排查。
 */
export function useAgentMetadata(
  agentIds: string[],
  fast = false,
): Record<string, AgentNodeMetadata> {
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
    const timer = setInterval(run, fast ? POLL_FAST_INTERVAL_MS : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      // 清理后允许立即开始下一轮;在途响应会因 cancelled/epoch 丢弃
      inFlightRef.current = false;
      epochRef.current += 1;
    };
  }, [idsKey, fetchMetadata, fast]);

  return items;
}

/** 自定义 provider 的模型发现冷启动可达数十秒,单次失败后按此节奏重试。 */
const MODEL_LABELS_RETRY_MS = 5_000;
const MODEL_LABELS_MAX_ATTEMPTS = 3;

/**
 * 按提供方拉取模型 id → 展示 label 的映射(卡片模型行显示 label 而非原始 id)。
 * 模型目录相对静态:每个提供方只拉一次,不轮询;提供方集合变化时增量补充。
 * 拉取失败按空映射处理,卡片回落显示原始 model id,不冒充 label;
 * 失败的提供方自动重试(冷启动/瞬时错误),避免一次失败就永久显示原始 id。
 */
export function useModelLabels(
  providers: readonly string[],
): Record<string, Record<string, string>> {
  const paseo = usePaseo();
  const report = useRpc(debugReportRpc);
  const [labels, setLabels] = useState<Record<string, Record<string, string>>>({});
  // 重试只补缺失的提供方,需要一个不触发重渲染的当前值镜像
  const labelsRef = useRef<Record<string, Record<string, string>>>({});
  labelsRef.current = labels;
  // 以稳定字符串为依赖,避免数组引用变化造成反复请求
  const providersKey = useMemo(
    () => [...new Set(providers)].sort().join("\u0000"),
    [providers],
  );

  useEffect(() => {
    const list = providersKey ? providersKey.split("\u0000") : [];
    if (list.length === 0) {
      setLabels({});
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // 失败重试只补缺:已成功的提供方结果保留在 labels,不被重试轮次覆盖
    let attempt = 0;
    const run = async () => {
      attempt++;
      const pending = list.filter((provider) => !(provider in labelsRef.current));
      const entries = await Promise.all(
        pending.map(async (provider) => {
          try {
            const result = await paseo.providers.listModels(provider);
            const map: Record<string, string> = {};
            for (const model of result.models ?? []) {
              // 无 label 或 label 与 id 相同:不进映射,卡片直接显示 id
              if (model.label && model.label !== model.id) map[model.id] = model.label;
            }
            return [provider, map] as const;
          } catch (error) {
            void report({
              payload: `[diag] listModels ${provider} 失败(第 ${attempt} 次): ${error instanceof Error ? error.message : String(error)}`,
            });
            return [provider, null] as const;
          }
        }),
      );
      if (cancelled) return;
      const failed: string[] = [];
      for (const [provider, map] of entries) {
        if (map === null) failed.push(provider);
      }
      if (entries.length > 0) {
        const merged = { ...labelsRef.current };
        for (const [provider, map] of entries) {
          if (map !== null) merged[provider] = map;
        }
        labelsRef.current = merged;
        setLabels(merged);
      }
      if (failed.length > 0 && attempt < MODEL_LABELS_MAX_ATTEMPTS && !cancelled) {
        retryTimer = setTimeout(() => void run(), MODEL_LABELS_RETRY_MS);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [paseo, providersKey]);

  return labels;
}
