import type { AgentRunStatus } from "./graph";

/** 归档策略输入。父关系来源:官方 parentAgentId 或可靠 label(paseo.parent-agent-id);
 *  未知传 null,保守按主Agent处理。 */
export interface ArchivePolicyInput {
  archived: boolean;
  status: AgentRunStatus | null;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  parentAgentId: string | null;
}

export interface ArchivePolicy {
  /** 归档按钮可用性 */
  canArchive: boolean;
  /** 归档前必须弹窗确认(子Agent待验收归档);面板对全部归档统一弹窗,此标记用于文案与兜底 */
  requiresConfirm: boolean;
  /** 不可归档的原因;可归档为 null */
  blockedReason: "running" | "attention" | "archived" | "not_idle" | null;
}

/**
 * 归档策略(纯函数,卡片可用性与面板确认复查共用):
 * - 主Agent(父关系未知保守按主Agent):仅完全空闲(未归档、非运行、无任何关注)可归档;
 *   运行中/待验收/权限等待/出错关注一律不可归档
 * - 子Agent:空闲无关注可归档(保留原有行为);额外放开"待验收"
 *   (requiresAttention 且 attentionReason=finished),但必须弹窗确认;
 *   不把其它 requiresAttention(权限/出错/未知原因)当 finished
 */
export function archivePolicy(input: ArchivePolicyInput): ArchivePolicy {
  if (input.archived) {
    return { canArchive: false, requiresConfirm: false, blockedReason: "archived" };
  }
  // 运行与启动中都不放开;出错/已关闭等非空闲状态同样不放开
  if (input.status === "running" || input.status === "initializing") {
    return { canArchive: false, requiresConfirm: false, blockedReason: "running" };
  }
  const finishedAttention = input.requiresAttention && input.attentionReason === "finished";
  if (input.requiresAttention && !finishedAttention) {
    // 权限等待/出错/未知原因的关注:一律不放开
    return { canArchive: false, requiresConfirm: false, blockedReason: "attention" };
  }
  if (finishedAttention) {
    if (input.parentAgentId !== null) {
      // 仅子Agent的待验收可归档,且必须确认
      return { canArchive: true, requiresConfirm: true, blockedReason: null };
    }
    // 主Agent待验收:不可归档
    return { canArchive: false, requiresConfirm: false, blockedReason: "attention" };
  }
  if (input.status === "idle" && !input.requiresAttention) {
    return { canArchive: true, requiresConfirm: false, blockedReason: null };
  }
  return { canArchive: false, requiresConfirm: false, blockedReason: "not_idle" };
}

/** 弹窗确认后的 fresh 快照复查输入(与协议快照字段对齐;快照缺失传 null)。 */
export interface FreshArchiveCheck {
  archivedAt: string | null | undefined;
  status: AgentRunStatus | null;
  requiresAttention: boolean | null | undefined;
  attentionReason: "finished" | "error" | "permission" | null | undefined;
  /** fresh 快照里的可靠父关系 label(paseo.parent-agent-id);缺失为 null */
  parentLabel: string | null | undefined;
}

export type FreshArchiveVerdict = "allow" | "state_changed";

/**
 * 弹窗确认后的 fresh snapshot 复查决策(纯函数):
 * 快照取不到或策略不再允许(期间开始运行/进入权限等待/被归档等)→ "state_changed",
 * 调用方必须取消归档(零副作用);仍允许 → "allow"。
 */
export function freshArchiveVerdict(snapshot: FreshArchiveCheck | null): FreshArchiveVerdict {
  if (!snapshot) return "state_changed";
  const policy = archivePolicy({
    archived: Boolean(snapshot.archivedAt),
    status: snapshot.status,
    requiresAttention: Boolean(snapshot.requiresAttention),
    attentionReason: snapshot.attentionReason ?? null,
    parentAgentId: snapshot.parentLabel ?? null,
  });
  return policy.canArchive ? "allow" : "state_changed";
}
