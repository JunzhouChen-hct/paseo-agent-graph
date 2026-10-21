import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_IDLE_FADE_TIERS, IDLE_FADE_TIER_LIMIT } from "./idle-fade.ts";

export const agentGraphSettings = defineSettings({
  id: "agent-graph-settings",
  scope: "host",
  version: 3,
  schema: z.object({
    /** 打开面板时是否默认隐藏已归档 agent */
    hideArchivedByDefault: z.boolean().default(true),
    /** 画布显示范围:project=项目全部工作区(默认),workspace=仅当前工作区 */
    displayScope: z.enum(["project", "workspace"]).default("project"),
    /** agent 运行中收到新消息的行为:steer=引导当前回合(与原生一致),queue=回合结束后自动发送(纯客户端编排) */
    sendBehavior: z.enum(["steer", "queue"]).default("steer"),
    /** 会话控制台默认高度(px) */
    consoleHeight: z.number().int().min(200).max(680).default(320),
    /** 状态色:留空跟随主题 token,填 #RRGGBB 覆盖 */
    runningColor: z.string().default(""),
    doneColor: z.string().default(""),
    attentionColor: z.string().default(""),
    failedColor: z.string().default(""),
    /** 对话流拉取的条数上限 */
    timelineLimit: z.number().int().min(10).max(400).default(60),
    /**
     * 空闲淡出档位:空闲超过 afterMinutes 分钟进入该档,应用整卡透明度;
     * autoArchive 为 true 时面板在空闲进入该档后自动归档(仍受归档策略兜底)。
     * 非法条目会被 zod 拒绝并整体回落默认,档位数上限与 UI 添加入口一致。
     */
    idleFadeTiers: z
      .array(
        z.object({
          afterMinutes: z.number().int().min(1).max(60 * 24 * 30),
          opacity: z.number().min(0).max(1),
          autoArchive: z.boolean(),
        }),
      )
      .max(IDLE_FADE_TIER_LIMIT)
      .default(DEFAULT_IDLE_FADE_TIERS.map((tier) => ({ ...tier }))),
  }),
  // v1 存量值映射:interrupt(打断回合,已移除)→ steer,steer 保持;
  // v3 新增 idleFadeTiers,存量缺省由 schema default 补默认档位
  migrate(values: unknown, fromVersion: number): unknown {
    if (fromVersion >= 3 || !values || typeof values !== "object") return values;
    const next = { ...(values as Record<string, unknown>) };
    if (fromVersion < 2 && next.sendBehavior === "interrupt") next.sendBehavior = "steer";
    return next;
  },
});

/** 四种状态的生效颜色(设置值为空时回退主题 token,运行中回退固定紫)。 */
export interface StatusColors {
  running: string;
  done: string;
  attention: string;
  failed: string;
}

export const DEFAULT_RUNNING_COLOR = "#a78bfa";

export function resolveColors(
  values: {
    runningColor: string;
    doneColor: string;
    attentionColor: string;
    failedColor: string;
  },
  themeColors: { statusSuccess: string; statusWarning: string; statusDanger: string },
): StatusColors {
  const pick = (value: string, fallback: string) =>
    /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : fallback;
  return {
    running: pick(values.runningColor, DEFAULT_RUNNING_COLOR),
    done: pick(values.doneColor, themeColors.statusSuccess),
    attention: pick(values.attentionColor, themeColors.statusWarning),
    failed: pick(values.failedColor, themeColors.statusDanger),
  };
}
