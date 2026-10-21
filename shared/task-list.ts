import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import type { AgentRunStatus } from "./graph";

/**
 * 任务列表纯数据层:host settings 文档、任务记录、校验与自动发送判定。
 * 不依赖 React / Node API,便于 node:test 直接覆盖;与既有 agent-graph-settings、
 * agent-graph-templates 分离,避免互相影响。
 */

export const TASK_TITLE_MAX = 200;
export const TASK_CONTENT_MAX = 20000;
export const TASK_LIST_MAX = 100;
/** 结算时保存的主 Agent 输出快照上限:host settings 文档不能无限膨胀,超出截断 */
export const TASK_RESULT_MAX = 8000;
/** 单个任务最多附带的图片数(base64 直存 host settings,必须有硬上限) */
export const TASK_IMAGES_MAX = 4;
/** 单张图片 base64 数据上限(约 2MB 二进制);超出在校验层明确拒绝 */
export const TASK_IMAGE_DATA_MAX = 2_800_000;
/** 允许的图片 MIME;清单之外(如 svg)明确拒绝,不静默丢弃 */
export const TASK_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/**
 * 全空闲确认窗:daemon 在回合切换间隙会短暂报 idle,立即发送会把任务插进
 * 错误回合。主 Agent 与全部相关 Agent 必须持续空闲 2 秒才触发。
 * 常量在此暴露,client 与测试共用同一口径。
 */
export const IDLE_CONFIRM_MS = 2000;
/** 自动发送失败后的重试间隔:避免持续失败时每 2 秒刷一次 toast。 */
export const SEND_RETRY_MS = 5000;
/**
 * /compact 投递后主 Agent 状态变 running 存在延迟,此窗口内自动发送引擎不启动
 * 新发送,防止新任务 steer 进压缩回合;窗口过后由主 Agent 忙/闲判定继续把关。
 */
export const COMPACT_BARRIER_MS = 15_000;
/**
 * 普通任务投递后的发送屏障:send resolve 时 daemon 可能尚未把 target 状态翻成
 * running(与 compact 同一竞态),窗口内 allIdle 仍为 true,若立即重评会把下一条
 * 任务 steer 进同一回合,破坏"逐条串行"。窗口过后由实际忙/闲状态决定是否续发。
 * 比 compact 短:普通任务回合通常启动更快,过长的屏障只会平白增加串行延迟。
 */
export const SEND_BARRIER_MS = 5_000;
/** 自动压缩规则档位的上下限(与 schema/UI 共用,避免三处硬编码漂移)。 */
export const AUTO_COMPACT_TASK_INTERVAL_MIN = 1;
export const AUTO_COMPACT_TASK_INTERVAL_MAX = 50;
/** "按上下文"档位的阈值上下限,单位 k token(与 schema/UI 共用,避免三处硬编码漂移)。 */
export const AUTO_COMPACT_TOKENS_K_MIN = 10;
export const AUTO_COMPACT_TOKENS_K_MAX = 10000;

/** 随任务发送的图片:base64 数据 + MIME;结构上限见 TASK_IMAGES_MAX / TASK_IMAGE_DATA_MAX。 */
export const taskImageSchema = z.object({
  data: z.string().min(1),
  mimeType: z.enum(TASK_IMAGE_MIME_TYPES),
});

export type TaskImage = z.output<typeof taskImageSchema>;

/** 单个任务的持久记录;id 创建后不变,稳定 messageId 由它派生。 */
export const taskRecordSchema = z.object({
  id: z.string().min(1),
  /** 展示标题(详情可编辑) */
  title: z.string().min(1).max(TASK_TITLE_MAX),
  /** 实际发送的消息内容 */
  content: z.string().max(TASK_CONTENT_MAX),
  /** 选中 = 参与自动发送队列 */
  selected: z.boolean().default(false),
  /** 完成 = 绿色字体 + 勾选状态 */
  done: z.boolean().default(false),
  /** ISO 时间;null = 未发送 */
  sentAt: z.string().nullable().default(null),
  /** 结算时间:主 Agent 与全部可见传递子孙持续空闲 2 秒后回填;非空 = 待验收 */
  settledAt: z.string().nullable().default(null),
  /** 结算时刻主 Agent 最新 assistant 输出的快照;null = 尚未收集或收集失败 */
  result: z.string().max(TASK_RESULT_MAX).nullable().default(null),
  /** 投递序号:每次(重新)排队递增,messageId 随之变化才能重新投递 */
  attempt: z.number().int().min(0).default(0),
  /** 随消息一起发送的图片(base64);无图片为空数组 */
  images: z.array(taskImageSchema).max(TASK_IMAGES_MAX).default([]),
  /** ISO 时间 */
  createdAt: z.string(),
});

export type TaskRecord = z.output<typeof taskRecordSchema>;

/** 自动压缩模式:关 / 每 N 个任务 / 上下文占用百分比。 */
export const AUTO_COMPACT_MODES = ["off", "tasks", "tokens"] as const;
export type AutoCompactMode = (typeof AUTO_COMPACT_MODES)[number];

/** 单个项目(按真实 projectId 聚合)的任务列表。 */
export const taskListEntrySchema = z.object({
  /** 绑定的主 Agent(任务发送目标);null = 未绑定 */
  targetAgentId: z.string().nullable().default(null),
  /** 自动发送总开关 */
  autoSend: z.boolean().default(false),
  /** 画布挂载卡片折叠成小图标(展开/折叠状态按项目持久化) */
  collapsed: z.boolean().default(false),
  /** 自动压缩模式;默认关闭,不改变既有项目的行为 */
  autoCompactMode: z.enum(AUTO_COMPACT_MODES).default("off"),
  /** "按任务数"档位:每完成 N 个任务压缩一次 */
  autoCompactTaskInterval: z
    .number()
    .int()
    .min(AUTO_COMPACT_TASK_INTERVAL_MIN)
    .max(AUTO_COMPACT_TASK_INTERVAL_MAX)
    .default(5),
  /** "按上下文"档位:上下文占用达到该值(单位 k token)就压缩一次 */
  autoCompactTokensK: z
    .number()
    .int()
    .min(AUTO_COMPACT_TOKENS_K_MIN)
    .max(AUTO_COMPACT_TOKENS_K_MAX)
    .default(300),
  /** 上次压缩以来结算的任务数;每次结算递增,触发压缩后清零 */
  tasksSinceCompact: z.number().int().min(0).default(0),
  /** 上次触发压缩的时间(ISO);仅记录触发时刻,null = 从未压缩 */
  lastCompactAt: z.string().nullable().default(null),
  /** 上次触发压缩时主 Agent 的上下文用量(used,token 数);tokens 模式用它识别『压缩后用量尚未刷新』,防止同一旧用量反复触发 */
  lastCompactUsage: z.number().nullable().default(null),
  /** 数组顺序即展示与发送顺序 */
  tasks: z.array(taskRecordSchema).max(TASK_LIST_MAX).default([]),
});

export type TaskListEntry = z.output<typeof taskListEntrySchema>;

/** 校验整份文档,返回错误列表(客户端保存前共用,与服务端 schema 同源)。 */
export function validateTaskListDocument(doc: {
  lists: Record<string, {
    /** 自动压缩档位;宽结构,旧文档可能缺省 */
    autoCompactTaskInterval?: number | null;
    autoCompactTokensK?: number | null;
    tasks: readonly {
      id: string;
      title: string;
      content: string;
      result?: string | null;
      images?: readonly { data: string; mimeType: string }[];
    }[];
  }>;
}): string[] {
  const errors: string[] = [];
  for (const [projectId, list] of Object.entries(doc.lists)) {
    // 两个档位参数由 schema 把关,这里给出保存前可读的中文错误;非整数同样拒绝,
    // 与 z.number().int() 保持同一口径
    const interval = list.autoCompactTaskInterval;
    if (
      interval !== undefined &&
      interval !== null &&
      (!Number.isInteger(interval) ||
        interval < AUTO_COMPACT_TASK_INTERVAL_MIN ||
        interval > AUTO_COMPACT_TASK_INTERVAL_MAX)
    ) {
      errors.push(
        `列表 ${projectId} 自动压缩任务间隔需为 ${AUTO_COMPACT_TASK_INTERVAL_MIN}–${AUTO_COMPACT_TASK_INTERVAL_MAX} 的整数`,
      );
    }
    const tokensK = list.autoCompactTokensK;
    if (
      tokensK !== undefined &&
      tokensK !== null &&
      (!Number.isInteger(tokensK) ||
        tokensK < AUTO_COMPACT_TOKENS_K_MIN ||
        tokensK > AUTO_COMPACT_TOKENS_K_MAX)
    ) {
      errors.push(
        `列表 ${projectId} 自动压缩上下文阈值需为 ${AUTO_COMPACT_TOKENS_K_MIN}–${AUTO_COMPACT_TOKENS_K_MAX} k 的整数`,
      );
    }
    if (list.tasks.length > TASK_LIST_MAX) {
      errors.push(`列表 ${projectId} 任务数超过上限 ${TASK_LIST_MAX}`);
    }
    const ids = new Set<string>();
    for (const task of list.tasks) {
      if (ids.has(task.id)) errors.push(`列表 ${projectId} 任务 id 重复:${task.id}`);
      ids.add(task.id);
      if (!task.id.trim()) errors.push(`列表 ${projectId} 存在空任务 id`);
      if (!task.title.trim()) errors.push(`列表 ${projectId} 任务 ${task.id} 标题不能为空`);
      if (task.title.length > TASK_TITLE_MAX) {
        errors.push(`列表 ${projectId} 任务 ${task.id} 标题超过 ${TASK_TITLE_MAX} 字`);
      }
      if (task.content.length > TASK_CONTENT_MAX) {
        errors.push(`列表 ${projectId} 任务 ${task.id} 内容超过 ${TASK_CONTENT_MAX} 字`);
      }
      if ((task.result ?? "").length > TASK_RESULT_MAX) {
        errors.push(`列表 ${projectId} 任务 ${task.id} 结果超过 ${TASK_RESULT_MAX} 字`);
      }
      // 图片:数量/格式由 schema 把关,这里校验 MIME 白名单与单张 base64 上限,
      // 让客户端在保存前拿到与服务端同源、可读的中文错误
      const images = task.images ?? [];
      if (images.length > TASK_IMAGES_MAX) {
        errors.push(`列表 ${projectId} 任务 ${task.id} 图片超过 ${TASK_IMAGES_MAX} 张`);
      }
      images.forEach((image, index) => {
        if (!(TASK_IMAGE_MIME_TYPES as readonly string[]).includes(image.mimeType)) {
          errors.push(`列表 ${projectId} 任务 ${task.id} 第 ${index + 1} 张图片格式不支持:${image.mimeType}`);
        }
        if (image.data.length > TASK_IMAGE_DATA_MAX) {
          errors.push(`列表 ${projectId} 任务 ${task.id} 第 ${index + 1} 张图片超过大小上限`);
        }
        if (!image.data.trim()) {
          errors.push(`列表 ${projectId} 任务 ${task.id} 第 ${index + 1} 张图片数据为空`);
        }
      });
    }
  }
  return errors;
}

export const agentGraphTaskListSettings = defineSettings({
  id: "agent-graph-tasks",
  scope: "host",
  version: 1,
  schema: z
    .object({
      /** 键 = 真实 projectId(与面板聚合键一致) */
      lists: z.record(z.string(), taskListEntrySchema).default({}),
    })
    .superRefine((doc, ctx) => {
      // 写入侧结构校验:非法文档直接拒绝,不落盘
      for (const error of validateTaskListDocument(doc)) {
        ctx.addIssue({ code: "custom", message: error, path: ["lists"] });
      }
    }),
});

export type TaskListDoc = z.output<typeof agentGraphTaskListSettings["schema"]>;

/** 解析 settings 读回值;结构不合法时返回 null,由调用方决定报错方式。 */
export function parseTaskListDocument(values: unknown): TaskListDoc | null {
  const result = agentGraphTaskListSettings.schema.safeParse(values);
  return result.success ? result.data : null;
}

/** 新建项目列表的默认空态(首次打开时先落盘一个空列表,避免每次重复猜绑定)。 */
export function defaultTaskListEntry(): TaskListEntry {
  return {
    targetAgentId: null,
    autoSend: false,
    collapsed: false,
    autoCompactMode: "off",
    autoCompactTaskInterval: 5,
    autoCompactTokensK: 300,
    tasksSinceCompact: 0,
    lastCompactAt: null,
    lastCompactUsage: null,
    tasks: [],
  };
}

/** 自动压缩判定需要的最小列表字段(纯函数入参,便于测试直接构造)。 */
export type AutoCompactRule = Pick<
  TaskListEntry,
  | "autoCompactMode"
  | "autoCompactTaskInterval"
  | "autoCompactTokensK"
  | "tasksSinceCompact"
  | "lastCompactAt"
  | "lastCompactUsage"
>;

/**
 * 结算后是否应触发自动压缩(纯函数)。
 *
 * 固定冷却已移除:每次任务结算都按规则评估。tasks 模式压缩后计数清零,
 * 天然不会在同一计数上重复触发;tokens 模式以"用量已刷新"防重复——仅当
 * used 与上次压缩时记录的 lastCompactUsage 不同才触发,相同说明 metadata
 * 还没刷新出压缩后的新值,等下一回合。
 * 阈值是绝对用量(单位 k token):used 已知即可判定,不依赖 max(部分 provider
 * 不报告窗口上限,百分比模式会因此永远不触发,绝对阈值没有这个盲区)。
 * 用量未知保守不压:宁可少压一次也不误压。
 */
export function shouldAutoCompact(
  list: AutoCompactRule,
  usage: { used: number | null },
): boolean {
  if (list.autoCompactMode === "off") return false;
  if (list.autoCompactMode === "tasks") {
    return list.tasksSinceCompact >= list.autoCompactTaskInterval;
  }
  // 未知模式(旧文档未经过 schema 默认值)按关闭处理,绝不掉进 tokens 分支误压
  if (list.autoCompactMode !== "tokens") return false;
  const { used } = usage;
  if (used === null || !Number.isFinite(used)) return false;
  if (used < list.autoCompactTokensK * 1000) return false;
  // 用量与上次压缩时相同 = metadata 尚未刷新出压缩后的新值,不压,等下一回合
  return used !== list.lastCompactUsage;
}

/** 把某个项目的列表写回文档;返回新对象,不改入参。 */
export function withTaskList(
  doc: TaskListDoc,
  projectId: string,
  list: TaskListEntry,
): TaskListDoc {
  return { ...doc, lists: { ...doc.lists, [projectId]: list } };
}

/** "已投递但 sentAt 尚未落盘"的乐观值:附带投递时的 attempt,补写前校验防错位。 */
export interface PendingSentEntry {
  sentAt: string;
  /** 投递时任务的 attempt;重新排队会递增,校验不一致即放弃补写 */
  attempt: number;
}

/**
 * 只 patch 指定任务的 sentAt,其余字段与其他项目/任务保持最新文档原样。
 * 发送成功后的冲突重试使用该函数,避免整份草稿覆盖其他端的修改。
 * 传入 expectedAttempt 时额外校验任务 attempt:期间被"重新排队"(attempt 递增)
 * 的任务返回 null,调用方不得把旧 sentAt 盖回重置后的任务。
 */
export function withTaskSentAt(
  doc: TaskListDoc,
  projectId: string,
  taskId: string,
  sentAt: string | null,
  expectedAttempt?: number,
): TaskListDoc | null {
  const list = doc.lists[projectId];
  if (!list) return null;
  const target = list.tasks.find((task) => task.id === taskId);
  if (!target) return null;
  // attempt 不一致:任务已被重新排队,拒绝写入,调用方据此放弃补写
  if (expectedAttempt !== undefined && target.attempt !== expectedAttempt) return null;
  const tasks = list.tasks.map((task) => (task.id === taskId ? { ...task, sentAt } : task));
  return withTaskList(doc, projectId, { ...list, tasks });
}

/**
 * 把"已投递但 sentAt 尚未落盘"的乐观值合并进展示任务列表。
 * 只覆盖 sentAt===null、attempt 与乐观值一致且 pendingSent 中存在的任务;其余任务
 * 保持原引用,便于 UI 在落盘失败期间先显示真实的"运行中/待验收"状态。
 * attempt 不一致说明任务已被重新排队,旧乐观值不能盖回。
 * pendingSent 为空或无命中时直接返回入参数组,保持引用稳定。
 */
export function mergePendingSent(
  tasks: readonly TaskRecord[],
  pendingSent: ReadonlyMap<string, PendingSentEntry>,
): TaskRecord[] {
  if (pendingSent.size === 0) return tasks as TaskRecord[];
  let changed = false;
  const merged = tasks.map((task) => {
    if (task.sentAt !== null) return task;
    const pending = pendingSent.get(task.id);
    if (pending === undefined || pending.attempt !== task.attempt) return task;
    changed = true;
    return { ...task, sentAt: pending.sentAt };
  });
  return changed ? merged : (tasks as TaskRecord[]);
}

/** 任务 id:"task_" + 12 位随机字符,创建后不再变化(幂等 messageId 派生自它)。 */
export function newTaskId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 12; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return `task_${suffix}`;
}

/**
 * 主 Agent + 全部传递子孙(基于 parentOf)。parentOf 应传全量关系(含归档中间
 * 节点),这样遍历可以穿透归档节点覆盖其未归档子孙;归档节点自身的剔除交给
 * summarizeRelatedIdle,本函数只负责关系闭包。target 自身始终包含在集合内。
 */
export function relatedAgentIds(
  targetId: string,
  parentOf: ReadonlyMap<string, string | null>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const [id, parent] of parentOf) {
    if (!parent) continue;
    const list = children.get(parent);
    if (list) list.push(id);
    else children.set(parent, [id]);
  }
  const related = new Set<string>([targetId]);
  const stack = [targetId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of children.get(id) ?? []) {
      if (related.has(child)) continue;
      related.add(child);
      stack.push(child);
    }
  }
  return related;
}

export type AgentIdleInput = {
  archived: boolean;
  status: AgentRunStatus | null;
  requiresAttention: boolean;
  attentionReason: string | null;
};

/**
 * 结算的纯 status 部分:任一相关 Agent 不是 idle 就阻塞。
 * 无输入也阻塞——没有可确认状态的 Agent 时保守不结算,避免"零个 agent 全空闲"
 * 这种字面成立但语义错误的判定。null/undefined 视为快照未就绪,同样阻塞。
 *
 * 注意与 isIdleForSend 的分工:permission/error 的关注态需要 metas,属于客户端
 * 判定;此函数只统一 status 口径,供结算与自动发送共用。
 */
export function isSettleBlocked(statuses: Iterable<string | null | undefined>): boolean {
  let seen = false;
  for (const status of statuses) {
    seen = true;
    if (status !== "idle") return true;
  }
  return !seen;
}

/**
 * 空闲 = 未归档 && status==="idle" && 关注不是"真卡住"。
 * finished 只是上一回合的完成通知,发送会开启新回合,因此视为空闲;
 * permission/error/未知关注都视为忙。status 判定复用 isSettleBlocked,
 * 保证自动发送与任务结算不会出现两套口径。
 */
export function isIdleForSend(agent: AgentIdleInput): boolean {
  if (agent.archived) return false;
  if (isSettleBlocked([agent.status])) return false;
  if (agent.requiresAttention && agent.attentionReason !== "finished") return false;
  return true;
}

/** 相关集合空闲统计:供自动发送/结算与卡片进度文案共用。 */
export interface RelatedIdleSummary {
  /** 有效相关计数 >0 且没有忙项;空集合不算"全空闲" */
  allIdle: boolean;
  /** 剔除已归档后的有效相关 Agent 数(不含已归档中间/叶子节点) */
  relatedCount: number;
  /** 视为忙的相关 Agent 数 */
  busyCount: number;
}

/**
 * 统计 target + 传递子孙的空闲状态(纯函数,自动发送与结算复用同一口径)。
 *
 * 规则刻意区分三类:
 * - 已归档 Agent 直接跳过:归档 = 退出管理,既不阻塞发送/结算,也不出现在 M 里;
 *   否则"显示已归档"开关会通过归档节点永久污染 busyCount。
 * - lookup 返回 null(不在项目目录)或 status === null(live 快照未就绪,典型是
 *   daemon 压缩上下文后的重建期)一律保守视为忙:状态未知时宁可不发也不错发。
 * - 其余走 isIdleForSend(finished 关注不算忙,permission/error 算忙)。
 *
 * relatedIds 为空时 allIdle 必须为 false,不能把"零个相关 Agent"当成"全部空闲":
 * 这与 isSettleBlocked 空输入阻塞的既有语义一致,避免无目标时误触发发送/结算。
 */
export function summarizeRelatedIdle(
  relatedIds: ReadonlySet<string>,
  lookup: (id: string) => AgentIdleInput | null,
): RelatedIdleSummary {
  let relatedCount = 0;
  let busyCount = 0;
  for (const id of relatedIds) {
    const agent = lookup(id);
    if (!agent) {
      // 目录里找不到:无法确认状态,保守计入忙
      relatedCount++;
      busyCount++;
      continue;
    }
    // 归档先于 status/关注判定:归档节点即使残留 running/permission 也不参与
    if (agent.archived) continue;
    relatedCount++;
    if (!isIdleForSend(agent)) busyCount++;
  }
  return { allIdle: relatedCount > 0 && busyCount === 0, relatedCount, busyCount };
}

/**
 * 下一个待发送任务:数组顺序首个 selected && !done && sentAt==null &&
 * (内容非空 或 带图片)。纯文字与纯图片任务都可入队。
 */
export function pickNextTask(tasks: readonly TaskRecord[]): TaskRecord | null {
  for (const task of tasks) {
    if (!task.selected || task.done || task.sentAt !== null) continue;
    if (task.content.trim().length === 0 && (task.images ?? []).length === 0) continue;
    return task;
  }
  return null;
}

/**
 * 复选框点击的状态迁移(与 UI 同源的纯函数):
 * 已完成 → 取消完成;已发送未完成 → 标记完成(绿色勾选,发送结果已验收);
 * 其余(草稿/待发送)→ 切换选中(是否进入自动发送队列)。
 */
export function toggleTaskState(task: TaskRecord): TaskRecord {
  if (task.done) return { ...task, done: false };
  if (task.sentAt !== null) return { ...task, done: true };
  return { ...task, selected: !task.selected };
}

/** 任务展示状态:done=已完成;queued=已选中待发送;draft=草稿;running=执行中;sent=待验收。 */
export type TaskDisplayStatus = "done" | "queued" | "draft" | "running" | "sent";

/**
 * 单个任务的展示状态(纯函数,面板/控制台共用):
 * - 已发送 && 相关 Agent 尚未全部空闲(仍有执行中/等权限/出错)&& 本任务尚未结算 → running;
 * - 已发送其余情况(相关 Agent 已全部空闲)→ sent(待验收)。
 * targetRunning 由面板按"主 Agent + 全部可见传递子孙"的整体空闲态传入,
 * 主 Agent 派发后先 idle、子 Agent 还在跑时任务仍保持运行中。
 * settledAt 让先发送、已执行完的任务在后继任务运行期间保持待验收,
 * 不再跟着整体"运行中"一起变成执行态。
 */
export function taskDisplayStatus(task: TaskRecord, targetRunning: boolean): TaskDisplayStatus {
  if (task.done) return "done";
  if (task.sentAt === null) return task.selected ? "queued" : "draft";
  if (targetRunning && task.settledAt === null) return "running";
  return "sent";
}

/**
 * 当前待结算的任务 id:已发送 && 未结算 && 未完成。
 * 结算引擎用它在"全部相关 Agent 空闲"时判断是否还有事情要做;空集表示
 * 无事可做,不应启动 2 秒确认窗(也不能把空集误判为"全空闲")。
 */
export function settleReadyIds(tasks: readonly TaskRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    // 旧文档可能没有这些可选字段(默认值未参与构造):undefined 按 null 处理,
    // 即"未发送/未结算",避免把已发送任务漏出待结算集合。
    if ((task.sentAt ?? null) !== null && (task.settledAt ?? null) === null && !task.done) {
      ids.add(task.id);
    }
  }
  return ids;
}

/**
 * 批量结算:把所有待结算任务回填 settledAt;没有需要结算的任务时返回 null
 * (调用方跳过保存)。待结算集合与 settleReadyIds 同源,避免两处条件漂移。
 */
export function settleSentTasks(
  tasks: readonly TaskRecord[],
  settledAt: string,
): TaskRecord[] | null {
  const ready = settleReadyIds(tasks);
  if (ready.size === 0) return null;
  return tasks.map((task) =>
    ready.has(task.id) ? { ...task, settledAt } : task,
  );
}

/** 统一的结果快照截断:写入侧与校验侧共用同一上限,避免各处硬编码。 */
export function truncateTaskResult(text: string): string {
  return text.slice(0, TASK_RESULT_MAX);
}

/**
 * 把结算时收集到的 result 只写到 ids 中的任务;其余任务与字段保持原样。
 * 没有任务命中或值没有变化时返回 null(与 settleSentTasks 的约定一致),
 * 调用方据此跳过无意义的保存与 revision 冲突。
 */
export function applyTaskResults(
  tasks: readonly TaskRecord[],
  ids: ReadonlySet<string>,
  result: string | null,
): TaskRecord[] | null {
  if (ids.size === 0) return null;
  // 旧文档里的任务可能没有该字段(默认值未参与构造):按 null 比较,避免误判有变化
  const nextResult = result === null ? null : truncateTaskResult(result);
  let changed = false;
  const next = tasks.map((task) => {
    if (!ids.has(task.id)) return task;
    if ((task.result ?? null) === nextResult) return task;
    changed = true;
    return { ...task, result: nextResult };
  });
  return changed ? next : null;
}

export type TaskMoveDirection = "up" | "down";

/**
 * 上移/下移一个任务;越界或 id 不存在时原样返回(不改入参)。
 * 数组顺序即展示与发送顺序,移动会同时影响自动发送队列。
 */
export function moveTask(
  tasks: readonly TaskRecord[],
  taskId: string,
  direction: TaskMoveDirection,
): TaskRecord[] {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return [...tasks];
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= tasks.length) return [...tasks];
  const next = [...tasks];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export function moveTaskUp(tasks: readonly TaskRecord[], taskId: string): TaskRecord[] {
  return moveTask(tasks, taskId, "up");
}

export function moveTaskDown(tasks: readonly TaskRecord[], taskId: string): TaskRecord[] {
  return moveTask(tasks, taskId, "down");
}

/**
 * 首次打开任务列表时的默认主 Agent:
 * 1. 画布上选中的卡片(调用方传入 preferredAgentId);
 * 2. 当前 workspace 内唯一根 Agent(无父、未归档);
 * 3. 项目内最早的未归档 Agent;
 * 4. 都没有 → null(空态引导手动选择)。
 * 全部候选都来自真实目录,不按 cwd/名称猜测。
 */
export function pickDefaultTaskTarget(input: {
  agents: readonly {
    id: string;
    workspaceId: string;
    archived: boolean;
    createdAt: string;
  }[];
  parentOf: ReadonlyMap<string, string | null>;
  workspaceId: string;
  preferredAgentId?: string | null;
}): string | null {
  const candidates = input.agents.filter((agent) => !agent.archived);
  if (candidates.length === 0) return null;
  const preferred = input.preferredAgentId
    ? candidates.find((agent) => agent.id === input.preferredAgentId)
    : undefined;
  if (preferred) return preferred.id;
  const roots = candidates.filter(
    (agent) => agent.workspaceId === input.workspaceId && (input.parentOf.get(agent.id) ?? null) === null,
  );
  if (roots.length === 1) return roots[0]!.id;
  return [...candidates].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )[0]!.id;
}

/** 自动发送指示灯/微文案的客户端呈现状态(仅 UI,不落盘)。 */
export type TaskAutoSendPhase = "off" | "idle" | "waiting" | "sending" | "sent";

/**
 * 任务消息的稳定幂等 id:`tasklist:{taskId}:{attempt}`。
 * 同一次投递的重试(发送失败、sentAt 落盘失败)attempt 不变,daemon 去重防止
 * 重复投递;"重新排队"递增 attempt,产生新 messageId,任务才能再次送达。
 */
export function taskMessageId(task: Pick<TaskRecord, "id" | "attempt">): string {
  return `tasklist:${task.id}:${task.attempt}`;
}
