/**
 * 会话空闲淡出分档(纯函数,卡片/面板/设置/测试共用)。
 *
 * "多久没有运行"以 agent 快照的 lastActivityAt(最后一次活动时刻)为准。
 * 档位由用户在设置中增删:每档包含空闲阈值(分钟)与行为——
 * 整卡透明度(面板背景与其中文字一并淡出)与可选的自动归档。
 *
 * 档位只按时间计算;透明度是否适用(运行中/待处理/出错不淡出)由卡片侧
 * 结合状态决定,自动归档由面板执行且仍受归档策略约束,本模块不掺入状态语义。
 */

/** 单个空闲档位:空闲超过 afterMinutes 分钟后进入该档并应用其行为。 */
export interface IdleFadeTierConfig {
  /** 空闲阈值(分钟),≥1 */
  afterMinutes: number;
  /** 该档整卡透明度,0~1 */
  opacity: number;
  /** 空闲进入该档时自动归档(归档不可从面板恢复,执行时仍受归档策略兜底) */
  autoArchive: boolean;
}

/** 默认档位:与首版内置行为一致(短时间未用 60%、长时间未用 10%)。 */
export const DEFAULT_IDLE_FADE_TIERS: readonly IdleFadeTierConfig[] = [
  { afterMinutes: 30, opacity: 0.6, autoArchive: false },
  { afterMinutes: 120, opacity: 0.1, autoArchive: false },
];

/** 设置里允许的最大档位数:档位过多没有辨识度,UI 添加入口同步封顶。 */
export const IDLE_FADE_TIER_LIMIT = 6;

/**
 * 解析当前空闲时长命中的档位:不要求 tiers 有序,取"阈值 ≤ 空闲时长"中
 * 阈值最大的那一档(后档覆盖先档);非法阈值(非有限/<1)的档位忽略。
 */
export function resolveIdleTier(
  tiers: readonly IdleFadeTierConfig[],
  idleMs: number,
): IdleFadeTierConfig | null {
  let match: IdleFadeTierConfig | null = null;
  for (const tier of tiers) {
    if (!Number.isFinite(tier.afterMinutes) || tier.afterMinutes < 1) continue;
    if (idleMs >= tier.afterMinutes * 60_000) {
      if (!match || tier.afterMinutes > match.afterMinutes) match = tier;
    }
  }
  return match;
}

/**
 * 宽进:由 lastActivityAt 计算空闲时长。缺失/无法解析/时刻在未来(时钟偏差)
 * 一律返回 null,由调用方按"正常、不淡出"处理,不猜测。
 */
export function idleMsSince(
  lastActivityAt: string | null | undefined,
  now: number,
): number | null {
  const last = typeof lastActivityAt === "string" ? Date.parse(lastActivityAt) : NaN;
  if (!Number.isFinite(last)) return null;
  const idleMs = now - last;
  return Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : null;
}
