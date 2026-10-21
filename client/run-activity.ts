import { useEffect, useRef, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import {
  formatElapsed,
  formatTokensPerSecond,
  progressLineOf,
} from "../shared/progress-line";
import { viewOfItem, type TimelineView } from "./timeline";

/**
 * 运行中卡片的活动行(借鉴 pase-omo 画板):一行内依次给出
 * 耗时 · tok/s · progress line,例如 "12m 34s · 45.2 tok/s · [bash] npm run build"。
 * - 数据来源:timeline tail(仅运行中卡片轮询,默认 3s;空闲即停,零开销);
 * - 耗时:客户端记录 running 起沿(server 快照没有回合开始时刻,不猜);
 * - tok/s:lastUsage.outputTokens 两次采样的增量/墙钟,EMA 平滑;
 *   提供方不报 outputTokens 时不显示,不用上下文占用冒充;
 * - progress:tool_call 取 [工具] 摘要,assistant/error 取首行,含控制符清洗。
 */

const USAGE_SAMPLE_MIN_GAP_MS = 500;
const EMA_NEW_WEIGHT = 0.3;

export interface RunActivity {
  /** 活动行全文;非运行状态或没有任何数据时为 null(渲染层不占行) */
  line: string | null;
}

export function useRunActivity(agentId: string | null, active: boolean, pollMs = 3000): RunActivity {
  const paseo = usePaseo();
  const [line, setLine] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const lastSampleRef = useRef<{ tokens: number; at: number } | null>(null);
  const emaRef = useRef<number | null>(null);
  // 请求序号(每实例):agentId 切换/重挂载后旧响应直接丢弃
  const seqRef = useRef(0);

  // 运行起沿:重置计时与采样(回合边界,不是 agent 生命周期)
  useEffect(() => {
    if (!agentId || !active) {
      startedAtRef.current = null;
      lastSampleRef.current = null;
      emaRef.current = null;
      setElapsedMs(null);
      setTps(null);
      setLine(null);
      return;
    }
    startedAtRef.current = Date.now();
    setElapsedMs(0);
  }, [agentId, active]);

  // 秒级 tick:仅运行中挂载,驱动耗时刷新
  useEffect(() => {
    if (!active || !agentId) return;
    const timer = setInterval(() => {
      if (startedAtRef.current !== null) setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, agentId]);

  // timeline tail 轮询:仅运行中挂载;失败静默(活动行拿不到就少显示,
  // 不影响卡片其他信息),过期响应按序号丢弃
  useEffect(() => {
    if (!active || !agentId) return;
    let cancelled = false;
    const fetchOnce = async () => {
      const mySeq = ++seqRef.current;
      try {
        const payload: TimelinePayloadShape = await paseo.agents
          .ref(agentId)
          .timeline.refetch({ direction: "tail", limit: 6, projection: "projected" });
        if (cancelled || mySeq !== seqRef.current) return;
        const views: TimelineView[] = [];
        (payload.entries ?? []).forEach((entry, index) => {
          const view = viewOfItem(entry.item, index, entry.timestamp ?? "");
          if (view) views.push(view);
        });
        setLine(progressLineOf(views));
        const tokens = payload.agent?.lastUsage?.outputTokens;
        if (typeof tokens === "number" && Number.isFinite(tokens)) {
          const prev = lastSampleRef.current;
          const nowMs = Date.now();
          if (prev && tokens > prev.tokens && nowMs - prev.at > USAGE_SAMPLE_MIN_GAP_MS) {
            const instant = ((tokens - prev.tokens) / (nowMs - prev.at)) * 1000;
            const ema = emaRef.current === null ? instant : emaRef.current * (1 - EMA_NEW_WEIGHT) + instant * EMA_NEW_WEIGHT;
            emaRef.current = ema;
            setTps(ema);
          }
          lastSampleRef.current = { tokens, at: nowMs };
        }
      } catch {
        // 静默:轮询失败保留上一次结果,下次 tick 再试
      }
    };
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, agentId, paseo, pollMs]);

  const parts: string[] = [];
  if (elapsedMs !== null) parts.push(formatElapsed(elapsedMs));
  const tpsText = formatTokensPerSecond(tps);
  if (tpsText) parts.push(tpsText);
  const stats = parts.join(" · ");
  if (!stats && !line) return { line: null };
  if (!stats) return { line };
  if (!line) return { line: stats };
  return { line: `${stats} · ${line}` };
}

interface TimelinePayloadShape {
  entries?: Array<{ item: Parameters<typeof viewOfItem>[0]; timestamp?: string }>;
  agent?: { lastUsage?: { outputTokens?: number | null } | null } | null;
}
