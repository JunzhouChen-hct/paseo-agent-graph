import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { settingsRpc } from "@getpaseo/plugin";
import { useRpc, type SettingsState } from "@getpaseo/plugin/client";
import type { ToastApi } from "@getpaseo/plugin/client/react-native";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentRunStatus } from "../shared/graph";
import type { DirectoryAgent } from "./directory";
import {
  agentGraphTaskListSettings,
  IDLE_CONFIRM_MS,
  parseTaskListDocument,
  pickNextTask,
  relatedAgentIds,
  SEND_BARRIER_MS,
  SEND_RETRY_MS,
  summarizeRelatedIdle,
  taskMessageId,
  withTaskSentAt,
  type PendingSentEntry,
  type TaskAutoSendPhase,
  type TaskListDoc,
  type TaskRecord,
} from "../shared/task-list";

/** useSettings(agentGraphTaskListSettings) 的对外状态类型。 */
export type TaskListSettingsState = SettingsState<typeof agentGraphTaskListSettings["schema"]>;

/** 自动发送判定需要的最小卡片元数据(与 CardMeta 同构,避免反向依赖 UI)。 */
export interface TaskAutoSendAgentMeta {
  parentId: string | null;
  status: AgentRunStatus | null;
  requiresAttention: boolean;
  attentionReason: string | null;
}

export interface TaskAutoSendState {
  phase: TaskAutoSendPhase;
  /** 相关集合(target + 全部传递子孙)当前是否全部空闲;任务结算也复用这一口径 */
  allIdle: boolean;
  /** 剔除已归档后的有效相关 Agent 数(卡片"等待空闲 N/M"的 M) */
  relatedCount: number;
  /** 视为忙的相关 Agent 数(卡片"等待空闲 N/M"的 N) */
  busyCount: number;
}

export interface TaskListSnapshot {
  doc: TaskListDoc;
  revision: string;
}

/**
 * 读取任务列表最新 host settings 文档。冲突恢复必须拿到"当前"文档而不是
 * render 闭包里的旧值;复用宿主既有 settings.* RPC,不新增 server RPC。
 */
export function useTaskListLatestReader(): () => Promise<TaskListSnapshot | null> {
  const read = useRpc(settingsRpc(agentGraphTaskListSettings.id).read);
  return useCallback(async () => {
    try {
      const result = await read({});
      if (result.status !== "ready") return null;
      const doc = parseTaskListDocument(result.values);
      return doc ? { doc, revision: result.revision } : null;
    } catch {
      return null;
    }
  }, [read]);
}

/** sentAt 补写轮询间隔:失败后按此节奏一直重试,直到落盘成功或面板卸载。 */
const BACKFILL_INTERVAL_MS = 2_000;

export interface UseSentAtBackfillOptions {
  settings: TaskListSettingsState;
  projectId: string | null;
  /** 与结算共用同一个最新文档读取器,避免多份 readLatest 口径漂移 */
  readLatest: () => Promise<TaskListSnapshot | null>;
}

export interface SentAtBackfillState {
  /** taskId → 已投递但 sentAt 尚未落盘的乐观值(含投递时 attempt) */
  pendingSent: ReadonlyMap<string, PendingSentEntry>;
  /** 记录一次"已投递但未落盘"的发送,并启动补写循环 */
  markPendingSent(taskId: string, sentAt: string, attempt: number): void;
  /**
   * 丢弃某任务的乐观值:重新排队(sentAt 重置 + attempt 递增)后任务语义已变,
   * 旧的乐观 sentAt 若还在,会把重置后的任务盖回"已发送",导致重新排队失效。
   */
  discardPendingSent(taskId: string): void;
}

/**
 * panel 级 sentAt 补写:投递成功但 persistSentAt 撞车失败时,先把 sentAt
 * 记在内存里供 UI 乐观展示,再按 2 秒一轮持续尝试只 patch 该任务。
 * 不放弃重试——发送目标忙不应该成为补不上 sentAt 的理由;只有面板卸载
 * 或 projectId 切换才停止/清空。
 */
export function useSentAtBackfill(options: UseSentAtBackfillOptions): SentAtBackfillState {
  const { settings, projectId, readLatest } = options;
  const [pendingSent, setPendingSent] = useState<ReadonlyMap<string, PendingSentEntry>>(
    () => new Map(),
  );
  // 定时器/异步轮次读 ref 中的最新集合,避免闭包拿到旧 Map
  const pendingSentRef = useRef(pendingSent);
  pendingSentRef.current = pendingSent;

  const markPendingSent = useCallback((taskId: string, sentAt: string, attempt: number) => {
    setPendingSent((current) => {
      const previous = current.get(taskId);
      if (previous?.sentAt === sentAt && previous.attempt === attempt) return current;
      const next = new Map(current);
      next.set(taskId, { sentAt, attempt });
      return next;
    });
  }, []);

  const discardPendingSent = useCallback((taskId: string) => {
    setPendingSent((current) => {
      if (!current.has(taskId)) return current;
      const next = new Map(current);
      next.delete(taskId);
      return next;
    });
  }, []);

  // settings/readLatest 的身份由宿主订阅决定:放进 ref,避免轮询被频繁重建
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const readLatestRef = useRef(readLatest);
  readLatestRef.current = readLatest;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // projectId 切换时清空待补写集合:旧项目的任务不能写进新项目
  useEffect(() => {
    setPendingSent(new Map());
  }, [projectId]);

  const hasPending = pendingSent.size > 0;
  useEffect(() => {
    if (!hasPending) return; // 集合为空时不保留任何定时器
    let cancelled = false;
    // 单轮内串行处理,且避免上一轮未结束就叠加下一轮
    let running = false;
    const backfillOnce = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        const entries = [...pendingSentRef.current.entries()];
        for (const [taskId, entry] of entries) {
          if (cancelled) return;
          const targetProjectId = projectIdRef.current;
          if (!targetProjectId) continue;
          const latest = await readLatestRef.current();
          if (cancelled) return;
          if (!latest) continue; // 读取失败:保留,下一轮再试
          // attempt 校验:await readLatest 期间任务可能被"重新排队"(sentAt 重置 +
          // attempt 递增),把旧 sentAt 盖回去会让任务静默卡死,必须放弃
          const patched = withTaskSentAt(latest.doc, targetProjectId, taskId, entry.sentAt, entry.attempt);
          if (!patched) {
            // 任务已被删除或已被重新排队:无需再补,直接从集合移除
            setPendingSent((current) => {
              if (!current.has(taskId)) return current;
              const next = new Map(current);
              next.delete(taskId);
              return next;
            });
            continue;
          }
          let saved = false;
          try {
            saved = await settingsRef.current.save(patched, latest.revision);
          } catch {
            saved = false;
          }
          if (cancelled || !saved) continue; // 冲突/异常:保留,下一轮再试
          setPendingSent((current) => {
            // 期间又被标记了更新的时间戳时保留新值,不误删
            if (current.get(taskId)?.sentAt !== entry.sentAt) return current;
            const next = new Map(current);
            next.delete(taskId);
            return next;
          });
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      void backfillOnce();
    }, BACKFILL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasPending, projectId]);

  return { pendingSent, markPendingSent, discardPendingSent };
}

export interface SendTaskInput {
  projectId: string;
  /** 必须来自列表持久化的绑定,绝不在这里回落/猜测目标 */
  targetAgentId: string;
  task: TaskRecord;
  paseo: PaseoApi;
  settings: TaskListSettingsState;
  toast: Pick<ToastApi, "show" | "error">;
  /** 冲突时读取最新文档(见 useTaskListLatestReader) */
  readLatest: () => Promise<TaskListSnapshot | null>;
}

export interface SendTaskResult {
  /** 消息已投递且 sentAt 已持久化 */
  ok: boolean;
  /** daemon 是否已接受消息;false 时任务应保持未发送等待重试 */
  delivered: boolean;
  sentAt: string | null;
  error: string | null;
}

/** 发送成功后的 sentAt 持久化:先按当前 revision 写,冲突时读最新文档只 patch 该任务再重试一次。 */
async function persistSentAt(
  input: SendTaskInput,
  sentAt: string,
): Promise<boolean> {
  const { settings, projectId, task, readLatest } = input;
  if (settings.status !== "ready") return false;
  // 带 attempt 校验:若期间任务被重新排队(attempt 递增),不得把旧 sentAt 盖回
  const first = withTaskSentAt(settings.values, projectId, task.id, sentAt, task.attempt);
  if (!first) return false;
  if (await settings.save(first, settings.revision)) return true;
  // 冲突恢复:失败后用最新文档为底,仅 patch 目标任务的 sentAt,不覆盖其他端修改
  const latest = await readLatest();
  if (!latest) return false;
  const patched = withTaskSentAt(latest.doc, projectId, task.id, sentAt, task.attempt);
  if (!patched) return false;
  return settings.save(patched, latest.revision);
}

/**
 * 任务发送的唯一路径(自动发送与详情"立即发送"共用):
 * - 稳定 messageId "tasklist:{taskId}:{attempt}",daemon 去重保证同一次投递
 *   的重试/多端并发不重复投递;"重新排队"递增 attempt 后可再次送达;
 * - activeTurnBehavior 显式 "steer":协议只有 steer/interrupt,queue 是本插件
 *   的纯客户端编排,不能交给 daemon;
 * - 发送失败不改任务,sentAt 持久化失败也保持未发送,由调用方重试。
 */
export async function sendTask(input: SendTaskInput): Promise<SendTaskResult> {
  const content = input.task.content.trim();
  // 图片随消息一起投递(与控制台发送通道同参数);纯图片任务允许空文字
  const images = (input.task.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType }));
  if (!content && images.length === 0) {
    return { ok: false, delivered: false, sentAt: null, error: "任务内容为空,未发送" };
  }
  if (!input.targetAgentId) {
    return { ok: false, delivered: false, sentAt: null, error: "未绑定主 Agent,自动发送已暂停" };
  }
  if (!input.projectId) {
    return { ok: false, delivered: false, sentAt: null, error: "项目尚未解析完成,暂不发送" };
  }
  if (input.settings.status !== "ready") {
    // 配置未就绪时先不发送:否则消息已投递但 sentAt 无法落盘,UI 会一直显示未发送
    return { ok: false, delivered: false, sentAt: null, error: "任务列表配置未就绪,暂不发送" };
  }
  const messageId = taskMessageId(input.task);
  try {
    await input.paseo.agents.ref(input.targetAgentId).send(content, {
      activeTurnBehavior: "steer",
      messageId,
      ...(images.length > 0 ? { images } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      delivered: false,
      sentAt: null,
      error: error instanceof Error ? error.message : "发送失败",
    };
  }
  const sentAt = new Date().toISOString();
  const saved = await persistSentAt(input, sentAt);
  if (!saved) {
    return {
      ok: false,
      delivered: true,
      sentAt,
      error: "消息已发送,但保存发送状态失败;重试会复用同一 messageId,不会重复投递",
    };
  }
  return { ok: true, delivered: true, sentAt, error: null };
}

export interface UseTaskAutoSendOptions {
  projectId: string | null;
  targetAgentId: string | null;
  /** 目标存在且未归档;false 时引擎暂停,不会回落猜测其他 agent */
  targetValid: boolean;
  autoSend: boolean;
  tasks: readonly TaskRecord[];
  /**
   * 项目级全量 agent 目录(含归档,不受面板"显示已归档"开关影响)。
   * 归档剔除由 summarizeRelatedIdle 统一负责:引擎判定必须与显示开关解耦,
   * 否则隐藏/显示归档会让相关集合与空闲结论随 UI 变化。
   */
  agents: readonly DirectoryAgent[];
  /**
   * 全量父子关系(含归档中间节点),由面板基于全部 agents + metas 构建;
   * 这样才能从主 Agent 穿透已归档的中间节点,覆盖仍在运行的未归档孙 Agent。
   */
  parentOf: ReadonlyMap<string, string | null>;
  metas: ReadonlyMap<string, TaskAutoSendAgentMeta>;
  settings: TaskListSettingsState;
  paseo: PaseoApi;
  toast: Pick<ToastApi, "show" | "error">;
  /** 投递成功但 sentAt 落盘失败时登记,由面板级补写循环持续重试 */
  markPendingSent: (taskId: string, sentAt: string, attempt: number) => void;
  /** 压缩发送后的屏障截止时间戳(ms);屏障内不启动新发送,null/过期 = 无屏障 */
  compactHoldUntil: number | null;
}

/**
 * 纯客户端自动发送编排:autoSend 开 && 目标有效 && 有下一条任务 &&
 * 相关集合全部空闲持续 IDLE_CONFIRM_MS 才发送。发送后目标转 running,
 * 条件破坏、计时器清除,下一轮空闲再发下一条(逐条串行)。
 *
 * 面板关闭 / 宿主页面后台时 React 不运行,引擎自然暂停——这是客户端编排
 * 的固有限制,已在 OVERVIEW 中如实说明。
 */
export function useTaskAutoSend(options: UseTaskAutoSendOptions): TaskAutoSendState {
  const { projectId, targetAgentId, targetValid, autoSend, tasks, agents, parentOf, metas, compactHoldUntil } = options;
  const [phase, setPhase] = useState<TaskAutoSendPhase>("off");
  // 失败后的重试计数:0 = 正常 2 秒确认窗;>0 = 失败退避,避免 toast 刷屏
  const [retryTick, setRetryTick] = useState(0);
  // 每次发送结束递增,强制 effect 重新评估:设置更新可能先于 pending 释放到达,
  // 那次 effect 会被锁挡掉,不补一次就会漏掉下一条任务
  const [settleTick, setSettleTick] = useState(0);
  // 防重入权威是 ref 而非 state:await 前置位、finally 释放(参照 createRenameSubmitter)
  const pendingRef = useRef(false);
  // 普通任务投递后的屏障截止时间戳:attemptSend 的 guard 读 ref,effect 重评读 state
  const [sendHoldUntil, setSendHoldUntil] = useState<number | null>(null);
  const sendHoldUntilRef = useRef<number | null>(null);
  sendHoldUntilRef.current = sendHoldUntil;
  const readLatest = useTaskListLatestReader();
  // useRpc 返回的函数身份由宿主决定:放进 ref,避免它变化时重置 2 秒确认计时器
  const readLatestRef = useRef(readLatest);
  readLatestRef.current = readLatest;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const idleInfo = useMemo(() => {
    if (!targetAgentId) return { allIdle: false, relatedCount: 0, busyCount: 0 };
    const related = relatedAgentIds(targetAgentId, parentOf);
    // 合成视图:目录条目(含归档)+ live meta。agent 缺失或 meta/status 未就绪
    // 都返回保守忙;归档不再在这里特殊处理,由 summarizeRelatedIdle 统一剔除,
    // 避免判定口径散落在组件里。
    return summarizeRelatedIdle(related, (id) => {
      const agent = agentById.get(id);
      if (!agent) return null;
      const meta = metas.get(id);
      return {
        archived: agent.archived,
        status: meta?.status ?? null,
        requiresAttention: meta?.requiresAttention ?? false,
        attentionReason: meta?.attentionReason ?? null,
      };
    });
  }, [targetAgentId, parentOf, agentById, metas]);

  const nextTaskId = useMemo(() => pickNextTask(tasks)?.id ?? null, [tasks]);
  // 计时器触发瞬间再确认一次空闲:cleanup 通常已清除计时器,这里是防御性兜底
  const idleRef = useRef(idleInfo.allIdle);
  idleRef.current = idleInfo.allIdle;

  const attemptSend = useCallback(async () => {
    if (pendingRef.current) return;
    const current = optionsRef.current;
    // 屏障期内绝不发送(compact 屏障 + 普通任务发送屏障):phase 由 effect 维持 waiting,到期后自动重估
    if (Date.now() < Math.max(current.compactHoldUntil ?? 0, sendHoldUntilRef.current ?? 0)) return;
    if (!current.projectId || !current.targetAgentId) return;
    if (!current.autoSend || !current.targetValid || !idleRef.current) return;
    // 计时器触发时重读最新队列,避免使用等待期间已被删除/重排的旧任务对象
    const task = pickNextTask(current.tasks);
    if (!task) return;
    pendingRef.current = true; // await 前同步置位
    setPhase("sending");
    try {
      const result = await sendTask({
        projectId: current.projectId,
        targetAgentId: current.targetAgentId,
        task,
        paseo: current.paseo,
        settings: current.settings,
        toast: current.toast,
        readLatest: readLatestRef.current,
      });
      if (result.delivered && !result.ok && result.sentAt != null) {
        // 已投递但 sentAt 没落盘:交给面板级补写,不要重新走 sendTask
        current.markPendingSent(task.id, result.sentAt, task.attempt);
      }
      if (result.delivered) {
        // 投递成功即立发送屏障:send resolve 时 daemon 可能尚未把 target 翻成
        // running,2 秒确认窗内 allIdle 仍为 true,若立即重评会把下一条任务
        // steer 进同一回合;到期后由实际忙/闲状态决定是否续发
        const hold = Date.now() + SEND_BARRIER_MS;
        sendHoldUntilRef.current = hold;
        setSendHoldUntil(hold);
      }
      if (result.ok) {
        setRetryTick(0);
        setPhase("sent");
        current.toast.show(`已自动发送「${task.title}」`);
      } else {
        // 发送失败或 sentAt 持久化失败:任务保持未发送,退避后自动重试;
        // 若 daemon 已受理,稳定 messageId 会阻止重复投递
        setPhase("idle");
        current.toast.error(result.error ?? "自动发送失败");
        setRetryTick((value) => value + 1);
      }
    } catch (error) {
      setPhase("idle");
      current.toast.error(error instanceof Error ? error.message : "自动发送失败");
      setRetryTick((value) => value + 1);
    } finally {
      pendingRef.current = false; // 任何路径都释放
      setSettleTick((value) => value + 1);
    }
  }, []);

  useEffect(() => {
    if (!autoSend) {
      setPhase("off");
      return;
    }
    if (!targetValid || !targetAgentId || !nextTaskId) {
      setPhase("idle");
      return;
    }
    // 发送屏障(compact 屏障与普通任务发送屏障取更晚者):窗口内不启动新发送,
    // 并安排一次到期重估——不依赖外部事件,屏障结束后引擎自动恢复;定时器若提前
    // 触发,剩余时间会再排一轮。
    const now = Date.now();
    const holdUntil = Math.max(compactHoldUntil ?? 0, sendHoldUntil ?? 0);
    if (now < holdUntil) {
      setPhase("waiting");
      const timer = setTimeout(
        () => setSettleTick((value) => value + 1),
        holdUntil - now,
      );
      return () => clearTimeout(timer);
    }
    if (!idleInfo.allIdle) {
      setPhase("waiting");
      return;
    }
    if (pendingRef.current) return;
    setPhase("waiting");
    const delay = retryTick > 0 ? SEND_RETRY_MS : IDLE_CONFIRM_MS;
    const timer = setTimeout(() => {
      // 屏障兜底:状态更新与计时器之间存在极短竞态,窗口内一律不发
      if (Date.now() < Math.max(optionsRef.current.compactHoldUntil ?? 0, sendHoldUntilRef.current ?? 0)) return;
      if (!idleRef.current) return;
      void attemptSend();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    autoSend,
    targetValid,
    targetAgentId,
    nextTaskId,
    idleInfo.allIdle,
    retryTick,
    settleTick,
    compactHoldUntil,
    sendHoldUntil,
    attemptSend,
  ]);

  // projectId 切换时清空重试退避,避免新项目继承旧项目的失败节奏
  useEffect(() => {
    setRetryTick(0);
  }, [projectId]);

  return {
    phase,
    allIdle: idleInfo.allIdle,
    relatedCount: idleInfo.relatedCount,
    busyCount: idleInfo.busyCount,
  };
}
