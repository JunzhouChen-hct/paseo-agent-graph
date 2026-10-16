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

/**
 * 重命名会话标题(agent title)。SDK 0.11.2 的 PaseoAgentHandle/PaseoApi 均未
 * 暴露改名接口(唯一 title 写入口 setTitle 属于 workspace),由 server 端经
 * DaemonClient lease 走官方 update_agent_request 完成:name 即会话标题。
 * 输入要求非空;server 侧再经 sanitizeRenameTitle 清洗,空白明确拒绝返回
 * error,不静默兜底。
 */
export const renameAgentRpc = defineRpc({
  name: "agent-graph.rename",
  input: z.object({
    agentId: z.string().min(1),
    title: z.string().min(1),
  }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

/** 重命名标题的统一清洗:trim 后为空白返回 null(明确拒绝,不静默兜底)。 */
export function sanitizeRenameTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface RenameSubmitterDeps {
  renameAgent(input: { agentId: string; title: string }): Promise<{ ok: boolean; error: string | null }>;
  /** 草稿 trim 后为空白:提示且不触达 RPC */
  onBlank(): void;
  /** RPC 失败/抛错:提示,调用方保留草稿 */
  onFailure(message: string): void;
  /** 成功:调用方关闭输入(头部标题由订阅自动更新) */
  onSuccess(): void;
  /** 目标 agent 已不是当前会话:丢弃输入,绝不改错 agent */
  onDiscard(): void;
  isCurrentAgent(agentId: string): boolean;
  /** pending 变化;置位发生在 await 之前,同步可用于 ref/state */
  onPendingChange(pending: boolean): void;
}

/**
 * 创建重命名提交器。防重入用闭包内的同步锁(等价 ref):置位发生在首个
 * await 之前、finally 释放——React state 批处理不及时,"快速确认"或
 * onSubmitEditing+按钮同帧两次调用时 state 尚未更新会并发,同步锁必须
 * 先于任何 await 检查并置位。锁存续期间重复调用被直接丢弃。
 * 纯依赖注入,client 组件与测试共用同一份提交路径。
 */
export function createRenameSubmitter(deps: RenameSubmitterDeps) {
  let pending = false;
  return async (target: { agentId: string; draft: string } | null): Promise<void> => {
    if (!target || pending) return;
    const title = sanitizeRenameTitle(target.draft);
    if (!title) {
      deps.onBlank();
      return;
    }
    if (!deps.isCurrentAgent(target.agentId)) {
      deps.onDiscard();
      return;
    }
    pending = true; // await 前同步置位
    deps.onPendingChange(true);
    try {
      const result = await deps.renameAgent({ agentId: target.agentId, title });
      if (result.ok) deps.onSuccess();
      else deps.onFailure(result.error ?? "重命名失败");
    } catch (error) {
      deps.onFailure(error instanceof Error ? error.message : "重命名失败");
    } finally {
      pending = false; // 任何路径都释放
      deps.onPendingChange(false);
    }
  };
}
