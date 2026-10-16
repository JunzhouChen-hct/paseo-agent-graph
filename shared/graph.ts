import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 请求 daemon 取消（中断）一个正在运行的 agent 回合。
 * SDK 的 PaseoApi 未暴露 cancel，因此由 server 端直连 daemon 完成该操作。
 */
export const cancelAgentRpc = defineRpc({
  name: "agent-graph.cancel",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

/**
 * 验收"待验收"通知:打开节点面板内置会话时,把 attentionReason==="finished"
 * 的完成通知清掉转回空闲。SDK PaseoApi 未暴露 clearAgentAttention,由 server
 * 端直连 daemon 完成;server 会对 daemon 最新快照做 fresh 复核,仅 finished
 * 关注会被清,permission/error 关注与真实运行状态一律不动。
 * cleared=false 表示 fresh 检查后无需清(通知已不在/原因不符),并非错误。
 */
export const acceptAgentRpc = defineRpc({
  name: "agent-graph.accept",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    ok: z.boolean(),
    cleared: z.boolean(),
    error: z.string().nullable(),
  }),
});

export type AgentRunStatus = "initializing" | "idle" | "running" | "error" | "closed";

/** 运行中动效的专用色:主题 token 里没有紫色,取暗/亮主题下均可读的柔和紫。 */
export const RUNNING_COLOR = "#a78bfa";

/** 卡片/连线的语义色种别,由面板统一映射到主题 token 或运行紫。 */
export type AgentTone =
  | "running" // 运行中 → 紫
  | "done" // 运行完成/空闲 → 绿
  | "attention" // 需要用户确认 → 黄
  | "failed" // 出错 → 红
  | "muted"; // 启动中/已关闭/已归档 → 灰

export function toneOf(input: {
  archived: boolean;
  status: AgentRunStatus | null;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
}): AgentTone {
  if (input.archived) return "muted";
  if (input.status === "error" || input.attentionReason === "error") return "failed";
  if (input.requiresAttention) {
    // 权限等待与未知原因是真卡住等人,保持 attention;finished 只是上回合的完成通知,
    // 新回合已在跑时让位给 running(用户补发消息继续跑的场景)
    if (input.attentionReason !== "finished") return "attention";
    return input.status === "running" ? "running" : "attention";
  }
  if (input.status === "running") return "running";
  if (input.status === "idle") return "done";
  return "muted";
}

/** 诊断通道:client 端把面板状态回传给 server 日志,便于排查 UI 问题。 */
export const debugReportRpc = defineRpc({
  name: "agent-graph.debug-report",
  input: z.object({ payload: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

/** 配置 agent:模型 / 模式(权限策略)/ 思考强度;字段按需生效。 */
export const configureAgentRpc = defineRpc({
  name: "agent-graph.configure",
  input: z.object({
    agentId: z.string().min(1),
    modelId: z.string().nullable().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().nullable().optional(),
  }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
