import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FeedbackPressable } from "./feedback-pressable";
import { SpinIcon } from "./task-list-card";
import { MarkdownText } from "./console";
import { canReadClipboardImage, readClipboardImage, type ClipboardImage } from "./web";
import { truncateWorkspaceLabel, workspaceBadgeLabel } from "../shared/project-scope";
import type { DirectoryAgent, ProjectWorkspaceInfo } from "./directory";
import {
  AUTO_COMPACT_TASK_INTERVAL_MAX,
  AUTO_COMPACT_TASK_INTERVAL_MIN,
  AUTO_COMPACT_TOKENS_K_MAX,
  AUTO_COMPACT_TOKENS_K_MIN,
  defaultTaskListEntry,
  moveTask,
  newTaskId,
  TASK_CONTENT_MAX,
  TASK_IMAGE_DATA_MAX,
  TASK_IMAGES_MAX,
  TASK_IMAGE_MIME_TYPES,
  TASK_TITLE_MAX,
  taskDisplayStatus,
  validateTaskListDocument,
  toggleTaskState,
  withTaskList,
  type AutoCompactMode,
  type TaskAutoSendPhase,
  type TaskImage,
  type TaskListEntry,
  type TaskRecord,
} from "../shared/task-list";
import {
  sendTask,
  useTaskListLatestReader,
  type TaskListSettingsState,
} from "./use-task-auto-send";

export type TaskListConsoleView =
  | { kind: "tasks" }
  | { kind: "task-detail"; taskId: string };

export interface TaskListConsoleProps {
  projectId: string;
  settings: TaskListSettingsState;
  tasks: readonly TaskRecord[];
  targetAgentId: string | null;
  targetValid: boolean;
  autoSend: boolean;
  /** 投递成功但 sentAt 落盘失败时登记,与面板共用同一个补写集合 */
  markPendingSent(taskId: string, sentAt: string, attempt: number): void;
  /** 丢弃某任务的乐观 sentAt(重新排队时用,避免旧乐观值盖回重置后的任务) */
  discardPendingSent(taskId: string): void;
  /** 项目内全部 agent(绑定 picker 候选,含已归档用于识别失效目标) */
  agents: readonly DirectoryAgent[];
  workspaces: readonly ProjectWorkspaceInfo[];
  relatedAllIdle: boolean;
  relatedBusyCount: number;
  /** 剔除归档后的有效相关 Agent 数(与卡片"等待空闲 N/M"同源) */
  relatedCount: number;
  autoSendPhase: TaskAutoSendPhase;
  /** 主 Agent 与全部相关 Agent 尚未全部空闲:已发送任务显示"运行中"与旋转图标 */
  targetRunning: boolean;
  /** 运行中语义色(与连线/呼吸一致) */
  runningColor: string;
  view: TaskListConsoleView;
  theme: PluginTheme;
  compact: boolean;
  onClose(): void;
  onOpenTask(taskId: string): void;
  onBackToList(): void;
}

/** 已发送徽标的时间:本地时区 HH:MM;非法时间原样展示,不伪造。 */
function formatSentAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** "等待空闲 N/M"的统一格式(M 已剔除归档);没有忙项时退回普通文案。 */
function waitingProgressText(busyCount: number, relatedCount: number): string {
  return busyCount > 0 ? `等待空闲 ${busyCount}/${relatedCount}` : "等待空闲";
}

/** 任务列表写入器:统一校验 + settings.save,失败 toast;冲突时由用户重试。 */
function useTaskListWriter(settings: TaskListSettingsState, projectId: string) {
  const toast = useToast();
  const save = useCallback(
    async (
      mutate: (list: TaskListEntry) => TaskListEntry,
      successMessage?: string,
    ): Promise<boolean> => {
      if (!projectId) {
        toast.error("项目尚未解析完成,暂不能保存任务");
        return false;
      }
      if (settings.status !== "ready") {
        toast.error("任务列表配置未就绪,请稍后重试");
        return false;
      }
      const base = settings.values.lists[projectId] ?? defaultTaskListEntry();
      const nextDoc = withTaskList(settings.values, projectId, mutate(base));
      const errors = validateTaskListDocument(nextDoc);
      if (errors.length > 0) {
        toast.error(errors[0]!);
        return false;
      }
      const ok = await settings.save(nextDoc, settings.revision);
      if (!ok) {
        toast.error(settings.saveError ?? "保存失败,请重试");
        return false;
      }
      if (successMessage) toast.show(successMessage);
      return true;
    },
    [settings, projectId, toast],
  );
  return { save, toast };
}

/** 复选框:tone 决定视觉(done 绿色完成 / selected 选中 / none 空框)。 */
function TaskCheckbox({
  tone,
  theme,
  compact,
  onPress,
  label,
}: {
  tone: "done" | "selected" | "none";
  theme: PluginTheme;
  compact: boolean;
  onPress(): void;
  label: string;
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        hit: {
          // 设计稿要求 48px 触控区;窄屏按仓库约定不小于 44px
          width: compact ? 44 : 48,
          height: compact ? 44 : 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 8,
        },
        hover: { backgroundColor: theme.colors.surface2 },
        box: {
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: theme.colors.border,
          alignItems: "center",
          justifyContent: "center",
        },
        boxSelected: { borderColor: theme.colors.accent },
        boxDone: {
          borderColor: theme.colors.statusSuccess,
          backgroundColor: theme.colors.statusSuccess,
        },
      }),
    [theme, compact],
  );
  return (
    <FeedbackPressable
      style={styles.hit}
      hoverStyle={styles.hover}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: tone !== "none" }}
      accessibilityLabel={label}
    >
      <View style={[styles.box, tone === "done" ? styles.boxDone : tone === "selected" ? styles.boxSelected : null]}>
        {tone !== "none" ? (
          <Icon
            name="Check"
            size={12}
            color={tone === "done" ? theme.colors.accentForeground : theme.colors.accent}
          />
        ) : null}
      </View>
    </FeedbackPressable>
  );
}

/** 列表行尾图标按钮:窄屏至少 44px 触控区。 */
function RowIconButton({
  icon,
  color,
  disabled,
  label,
  compact,
  theme,
  onPress,
}: {
  icon: string;
  color: string;
  disabled?: boolean;
  label: string;
  compact: boolean;
  theme: PluginTheme;
  onPress(): void;
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        hit: {
          width: compact ? 44 : 30,
          height: compact ? 44 : 30,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        hover: { backgroundColor: theme.colors.surface2 },
      }),
    [theme, compact],
  );
  return (
    <FeedbackPressable
      style={styles.hit}
      hoverStyle={styles.hover}
      disabled={disabled}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={icon} size={14} color={disabled ? theme.colors.border : color} />
    </FeedbackPressable>
  );
}

interface ListViewProps extends TaskListConsoleProps {
  view: { kind: "tasks" };
}

/** 列表视图:头部绑定/自动发送、任务行、快速添加。 */
function TaskListHome(props: ListViewProps) {
  const {
    projectId,
    settings,
    tasks,
    targetAgentId,
    targetValid,
    autoSend,
    agents,
    workspaces,
    relatedAllIdle,
    relatedBusyCount,
    relatedCount,
    autoSendPhase,
    targetRunning,
    runningColor,
    theme,
    compact,
    onClose,
    onOpenTask,
  } = props;
  const { save, toast } = useTaskListWriter(settings, projectId);
  // 自动压缩配置与任务列表同一份 host settings 条目;未就绪时用默认值渲染,
  // 保存仍统一走 useTaskListWriter 的就绪检查,不在 UI 里另造一份状态。
  const listEntry =
    settings.status === "ready"
      ? settings.values.lists[projectId] ?? defaultTaskListEntry()
      : defaultTaskListEntry();
  const autoCompactMode = listEntry.autoCompactMode ?? "off";
  const autoCompactTaskInterval = listEntry.autoCompactTaskInterval ?? 5;
  const autoCompactTokensK = listEntry.autoCompactTokensK ?? 300;
  // 阈值输入的本地草稿:持久化值变化(其他端修改/保存回写)时同步显示
  const [tokensDraft, setTokensDraft] = useState(String(autoCompactTokensK));
  useEffect(() => {
    setTokensDraft(String(autoCompactTokensK));
  }, [autoCompactTokensK]);
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  // 批量编辑模式:行点击/复选框变为多选,底部操作条批量完成/入队/删除
  const [editing, setEditing] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  // 自动压缩策略配置的展开态:头部 chip 只显示当前策略,点开才占位展示配置
  const [compactConfigOpen, setCompactConfigOpen] = useState(false);
  // 快速添加的同步锁:Enter 与发送按钮同帧触发时只新增一条
  const addLockRef = useRef(false);

  const targetAgent = useMemo(
    () => (targetAgentId ? agents.find((agent) => agent.id === targetAgentId) ?? null : null),
    [agents, targetAgentId],
  );
  const wsById = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
  const candidates = useMemo(
    () =>
      [...agents]
        .filter((agent) => !agent.archived)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((agent) => {
          const badge = workspaceBadgeLabel(agent, wsById);
          return {
            id: agent.id,
            label: agent.title?.trim() || "未命名 Agent",
            workspace: badge ? truncateWorkspaceLabel(badge) : null,
          };
        }),
    [agents, wsById],
  );

  // 队列序号:只统计 selected && !done && sentAt==null 的任务,与 pickNextTask 同口径
  const queueIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const task of tasks) {
      if (!task.selected || task.done || task.sentAt !== null) continue;
      map.set(task.id, ++index);
    }
    return map;
  }, [tasks]);

  const patchTasks = useCallback(
    (next: TaskRecord[], successMessage?: string) =>
      save((list) => ({ ...list, tasks: next }), successMessage),
    [save],
  );

  // —— 批量编辑模式 ——
  const toggleChecked = useCallback((taskId: string) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);
  const exitEditing = useCallback(() => {
    setEditing(false);
    setCheckedIds(new Set());
  }, []);
  const enterEditing = useCallback(() => {
    setEditing(true);
    setCheckedIds(new Set());
  }, []);
  // 对勾选任务批量 patch;删除后从选择集中清掉已不存在的 id
  const batchPatch = useCallback(
    (patch: (task: TaskRecord) => TaskRecord, successMessage?: string) => {
      if (checkedIds.size === 0) return;
      void patchTasks(tasks.map((task) => (checkedIds.has(task.id) ? patch(task) : task)), successMessage);
    },
    [checkedIds, tasks, patchTasks],
  );
  const batchDelete = useCallback(() => {
    if (checkedIds.size === 0) return;
    const count = checkedIds.size;
    void patchTasks(tasks.filter((task) => !checkedIds.has(task.id)), `已删除 ${count} 个任务`);
    setCheckedIds(new Set());
  }, [checkedIds, tasks, patchTasks]);
  // 清除已完成:按完成状态清,不依赖勾选(编辑模式下常驻可用)
  const doneCount = tasks.filter((task) => task.done).length;
  const clearDone = useCallback(() => {
    if (doneCount === 0) return;
    void patchTasks(tasks.filter((task) => !task.done), `已清除 ${doneCount} 个已完成任务`);
  }, [doneCount, tasks, patchTasks]);
  const allChecked = tasks.length > 0 && checkedIds.size === tasks.length;
  const toggleAll = useCallback(() => {
    setCheckedIds(allChecked ? new Set() : new Set(tasks.map((task) => task.id)));
  }, [allChecked, tasks]);

  const toggleTask = useCallback(
    (task: TaskRecord) => {
      const next = tasks.map((item) => (item.id !== task.id ? item : toggleTaskState(item)));
      void patchTasks(next);
    },
    [tasks, patchTasks],
  );

  // 批量标记完成:只勾"待验收"任务(taskDisplayStatus === "sent",即已发送且
  // 相关 Agent 已全部空闲/结果已回填);运行中与未发送的不动,避免误标
  const markAllSentDone = useCallback(() => {
    void patchTasks(
      tasks.map((item) =>
        taskDisplayStatus(item, targetRunning) === "sent" ? { ...item, done: true } : item,
      ),
      "待验收任务全部标记完成",
    );
  }, [tasks, patchTasks, targetRunning]);
  const sentNotDoneCount = tasks.filter(
    (task) => taskDisplayStatus(task, targetRunning) === "sent",
  ).length;

  const addTask = useCallback(async () => {
    if (addLockRef.current) return;
    const title = draft.trim();
    if (!title) return;
    addLockRef.current = true;
    try {
      const now = new Date().toISOString();
      const task: TaskRecord = {
        id: newTaskId(),
        title: title.slice(0, TASK_TITLE_MAX),
        content: title.slice(0, TASK_TITLE_MAX),
        selected: false,
        done: false,
        sentAt: null,
        settledAt: null,
        result: null,
        attempt: 0,
        images: [],
        createdAt: now,
      };
      const ok = await patchTasks([...tasks, task], "已添加,点击可补充内容");
      if (ok) {
        // 保存期间用户可能继续输入:只清空仍等于本次提交内容的草稿
        setDraft((current) => (current.trim() === title ? "" : current));
      }
    } finally {
      addLockRef.current = false;
    }
  }, [draft, patchTasks, tasks]);

  const bindTarget = useCallback(
    async (agentId: string) => {
      setPickerOpen(false);
      await save((list) => ({ ...list, targetAgentId: agentId }), "已绑定主 Agent");
    },
    [save],
  );

  const toggleAutoSend = useCallback(async () => {
    await save(
      (list) => ({ ...list, autoSend: !list.autoSend }),
      !autoSend ? "已开启自动发送" : "已关闭自动发送",
    );
  }, [save, autoSend]);

  // 自动压缩配置:点按即持久化,不改变任务数据;保存失败由 writer 统一 toast
  const setAutoCompactMode = useCallback(
    async (mode: AutoCompactMode) => {
      await save((list) => ({ ...list, autoCompactMode: mode }));
    },
    [save],
  );
  const adjustAutoCompactInterval = useCallback(
    async (delta: number) => {
      await save((list) => ({
        ...list,
        autoCompactTaskInterval: Math.min(
          AUTO_COMPACT_TASK_INTERVAL_MAX,
          Math.max(AUTO_COMPACT_TASK_INTERVAL_MIN, list.autoCompactTaskInterval + delta),
        ),
      }));
    },
    [save],
  );
  // 阈值草稿提交(blur/submit):非法输入回落持久化值,不静默写脏数据
  const commitTokensDraft = useCallback(async () => {
    const parsed = Number.parseInt(tokensDraft, 10);
    if (
      !Number.isInteger(parsed) ||
      parsed < AUTO_COMPACT_TOKENS_K_MIN ||
      parsed > AUTO_COMPACT_TOKENS_K_MAX
    ) {
      setTokensDraft(String(autoCompactTokensK));
      return;
    }
    if (parsed === autoCompactTokensK) return;
    await save((list) => ({ ...list, autoCompactTokensK: parsed }));
  }, [save, tokensDraft, autoCompactTokensK]);

  const relatedText = !targetAgentId
    ? "未绑定主 Agent"
    : !targetValid
      ? "主Agent 已失效"
      : relatedAllIdle
        ? "相关 Agent 全部空闲"
        : `${relatedBusyCount} 个运行中`;

  // 自动压缩 chip 的状态微文案:档位与参数一眼可读,无需展开配置
  const compactChipText =
    autoCompactMode === "tasks"
      ? `自动压缩·${autoCompactTaskInterval}任务`
      : autoCompactMode === "tokens"
        ? `自动压缩·${autoCompactTokensK}k`
        : "自动压缩·关";

  // 等待空闲时与画布卡片共用同一进度格式,让底栏也能解释"为什么还没发"
  const waitingText = waitingProgressText(relatedBusyCount, relatedCount);
  const autoSendText = autoSend
    ? autoSendPhase === "sending"
      ? "自动发送 · 发送中"
      : autoSendPhase === "sent"
        ? "自动发送 · 已发送"
        : autoSendPhase === "waiting" && relatedBusyCount > 0
          ? `自动发送 · ${waitingText}`
          : "自动发送 · 开"
    : "自动发送 · 关";

  const styles = useMemo(
    () =>
      StyleSheet.create({
        // 视图填满外层包装(高度/拖拽 grip 由 TaskListConsole 统一管理)
        root: { flex: 1, minHeight: 0 },
        header: {
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          paddingHorizontal: compact ? 10 : 14,
          paddingTop: 6,
          paddingBottom: 4,
        },
        headerTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
        chip: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 3,
          minHeight: compact ? 44 : undefined,
          justifyContent: "center",
          borderRadius: 999,
          backgroundColor: theme.colors.surface2,
        },
        chipActive: { backgroundColor: theme.colors.accent },
        chipText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        chipTextActive: { color: theme.colors.accentForeground, fontSize: 11 },
        spacer: { flex: 1 },
        headerButton: {
          width: compact ? 44 : 28,
          height: compact ? 44 : 28,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        hover: { backgroundColor: theme.colors.surface2 },
        statusText: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 },
        // 自动压缩配置区:与头部相邻但独立成块,窄屏可换行不挤压主 Agent/发送开关
        compactBar: {
          marginHorizontal: compact ? 10 : 14,
          marginBottom: 4,
          paddingHorizontal: 9,
          paddingVertical: 6,
          gap: 4,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        compactLine: {
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        },
        compactSubLabel: { color: theme.colors.foregroundMuted, fontSize: 10 },
        compactValue: {
          minWidth: 18,
          textAlign: "center",
          color: theme.colors.foreground,
          fontSize: 11,
          fontWeight: "600",
        },
        compactStep: {
          width: compact ? 44 : 24,
          height: compact ? 44 : 24,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          backgroundColor: theme.colors.surface2,
        },
        // 阈值数字输入:窄框贴在"上下文占用达到 / k 压缩一次"文案之间
        compactInput: {
          minWidth: 64,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
          color: theme.colors.foreground,
          fontSize: 12,
        },
        compactHint: {
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          lineHeight: 14,
        },
        warnBar: {
          marginHorizontal: compact ? 10 : 14,
          marginBottom: 4,
          borderRadius: 8,
          paddingHorizontal: 9,
          paddingVertical: 6,
          backgroundColor: theme.colors.surface2,
        },
        warnText: { color: theme.colors.statusWarning, fontSize: 11, lineHeight: 15 },
        hintText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
        list: { flex: 1, paddingHorizontal: compact ? 6 : 10 },
        empty: { padding: 20, gap: 4 },
        emptyTitle: { color: theme.colors.foreground, fontSize: 12, lineHeight: 17 },
        emptyHint: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
        row: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          borderRadius: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        rowHover: { backgroundColor: theme.colors.surface2 },
        rowChecked: { backgroundColor: theme.colors.surface2 },
        editCount: { color: theme.colors.foreground, fontSize: 11, fontWeight: "600" },
        rowMain: { flex: 1, paddingVertical: 6, gap: 2 },
        rowTitle: { color: theme.colors.foreground, fontSize: 12, lineHeight: 16 },
        rowTitleDone: { color: theme.colors.statusSuccess },
        rowTitleSent: { color: theme.colors.foregroundMuted },
        badges: { flexDirection: "row", alignItems: "center", gap: 4 },
        badge: {
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          paddingHorizontal: 6,
          paddingVertical: 1,
          borderRadius: 999,
          backgroundColor: theme.colors.surface0,
        },
        badgeText: { color: theme.colors.foregroundMuted, fontSize: 9 },
        badgeSent: { color: theme.colors.statusSuccess },
        badgePending: { color: theme.colors.statusWarning },
        actions: { flexDirection: "row", alignItems: "center" },
        composer: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: compact ? 10 : 14,
          paddingVertical: 8,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
        },
        input: {
          flex: 1,
          minHeight: compact ? 44 : 32,
          maxHeight: 96,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          color: theme.colors.foreground,
          paddingHorizontal: 10,
          paddingVertical: 7,
          fontSize: 12,
        },
        sendButton: {
          width: compact ? 44 : 32,
          height: compact ? 44 : 32,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.accent,
        },
        sendHover: { opacity: 0.85 },
        pickerRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 9,
          paddingHorizontal: 4,
          minHeight: compact ? 44 : undefined,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        pickerTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13 },
        pickerWs: { color: theme.colors.foregroundMuted, fontSize: 10 },
        pickerEmpty: { color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 12 },
      }),
    [theme, compact],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <FeedbackPressable
          style={styles.headerButton}
          hoverStyle={styles.hover}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={compact ? "返回节点图" : "收起任务列表"}
        >
          <Icon
            name={compact ? "ArrowLeft" : "ChevronDown"}
            size={15}
            color={theme.colors.foregroundMuted}
          />
        </FeedbackPressable>
        <Icon name="ListTodo" size={14} color={theme.colors.foregroundMuted} />
        <Text style={styles.headerTitle}>任务列表</Text>
        <FeedbackPressable
          style={styles.chip}
          hoverStyle={styles.hover}
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="选择主 Agent"
        >
          <Icon name="Bot" size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.chipText} numberOfLines={1}>
            {targetAgent?.title?.trim() || (targetAgentId ? "未命名 Agent" : "选择主Agent")}
          </Text>
        </FeedbackPressable>
        <FeedbackPressable
          style={[styles.chip, autoSend ? styles.chipActive : null]}
          hoverStyle={styles.hover}
          onPress={() => void toggleAutoSend()}
          accessibilityRole="switch"
          accessibilityState={{ checked: autoSend }}
          accessibilityLabel="自动发送"
        >
          <Icon
            name="Zap"
            size={12}
            color={autoSend ? theme.colors.accentForeground : theme.colors.foregroundMuted}
          />
          <Text style={autoSend ? styles.chipTextActive : styles.chipText}>{autoSendText}</Text>
        </FeedbackPressable>
        <FeedbackPressable
          style={[styles.chip, autoCompactMode !== "off" ? styles.chipActive : null]}
          hoverStyle={styles.hover}
          onPress={() => setCompactConfigOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: compactConfigOpen }}
          accessibilityLabel={`自动压缩策略:${compactChipText}`}
        >
          <Icon
            name="Minimize2"
            size={12}
            color={autoCompactMode !== "off" ? theme.colors.accentForeground : theme.colors.foregroundMuted}
          />
          <Text style={autoCompactMode !== "off" ? styles.chipTextActive : styles.chipText}>
            {compactChipText}
          </Text>
        </FeedbackPressable>
        {sentNotDoneCount > 0 ? (
          <FeedbackPressable
            style={styles.chip}
            hoverStyle={styles.hover}
            onPress={markAllSentDone}
            accessibilityRole="button"
            accessibilityLabel="全部标记完成"
          >
            <Icon name="CheckCheck" size={12} color={theme.colors.statusSuccess} />
            <Text style={styles.chipText}>{`全部标记完成 ${sentNotDoneCount}`}</Text>
          </FeedbackPressable>
        ) : null}
        <View style={styles.spacer} />
        <Text style={styles.statusText}>{relatedText}</Text>
        <FeedbackPressable
          style={[styles.chip, editing ? styles.chipActive : null]}
          hoverStyle={styles.hover}
          onPress={editing ? exitEditing : enterEditing}
          accessibilityRole="button"
          accessibilityLabel={editing ? "退出批量编辑" : "批量编辑任务"}
        >
          <Icon
            name={editing ? "X" : "SquarePen"}
            size={12}
            color={editing ? theme.colors.accentForeground : theme.colors.foregroundMuted}
          />
          <Text style={editing ? styles.chipTextActive : styles.chipText}>
            {editing ? "退出编辑" : "编辑"}
          </Text>
        </FeedbackPressable>
      </View>

      {/* 自动压缩策略配置:头部 chip 点开才展示;单行 flexWrap,放不下自动换双行。
          关档不触发压缩,但结算计数照常累计,切换档位后即可生效 */}
      {compactConfigOpen ? (
        <View style={styles.compactBar}>
          <View style={styles.compactLine}>
            {(
              [
                ["off", "关"],
                ["tasks", "按任务数"],
                ["tokens", "按上下文"],
              ] as const satisfies readonly (readonly [AutoCompactMode, string])[]
            ).map(([mode, label]) => (
              <FeedbackPressable
                key={mode}
                style={[styles.chip, autoCompactMode === mode ? styles.chipActive : null]}
                hoverStyle={styles.hover}
                onPress={() => void setAutoCompactMode(mode)}
                accessibilityRole="radio"
                accessibilityState={{ selected: autoCompactMode === mode }}
                accessibilityLabel={`自动压缩:${label}`}
              >
                <Text style={autoCompactMode === mode ? styles.chipTextActive : styles.chipText}>
                  {label}
                </Text>
              </FeedbackPressable>
            ))}
            {autoCompactMode === "tasks" ? (
              <>
                <Text style={styles.compactSubLabel}>每完成</Text>
                <FeedbackPressable
                  style={styles.compactStep}
                  hoverStyle={styles.hover}
                  disabled={autoCompactTaskInterval <= AUTO_COMPACT_TASK_INTERVAL_MIN}
                  onPress={() => void adjustAutoCompactInterval(-1)}
                  accessibilityRole="button"
                  accessibilityLabel="减少自动压缩任务间隔"
                >
                  <Icon
                    name="Minus"
                    size={12}
                    color={
                      autoCompactTaskInterval <= AUTO_COMPACT_TASK_INTERVAL_MIN
                        ? theme.colors.border
                        : theme.colors.foregroundMuted
                    }
                  />
                </FeedbackPressable>
                <Text style={styles.compactValue}>{autoCompactTaskInterval}</Text>
                <FeedbackPressable
                  style={styles.compactStep}
                  hoverStyle={styles.hover}
                  disabled={autoCompactTaskInterval >= AUTO_COMPACT_TASK_INTERVAL_MAX}
                  onPress={() => void adjustAutoCompactInterval(1)}
                  accessibilityRole="button"
                  accessibilityLabel="增加自动压缩任务间隔"
                >
                  <Icon
                    name="Plus"
                    size={12}
                    color={
                      autoCompactTaskInterval >= AUTO_COMPACT_TASK_INTERVAL_MAX
                        ? theme.colors.border
                        : theme.colors.foregroundMuted
                    }
                  />
                </FeedbackPressable>
                <Text style={styles.compactSubLabel}>
                  {`个任务压缩一次(${AUTO_COMPACT_TASK_INTERVAL_MIN}–${AUTO_COMPACT_TASK_INTERVAL_MAX})`}
                </Text>
              </>
            ) : null}
            {autoCompactMode === "tokens" ? (
              <>
                <Text style={styles.compactSubLabel}>上下文占用达到</Text>
                <TextInput
                  style={styles.compactInput}
                  value={tokensDraft}
                  onChangeText={setTokensDraft}
                  onSubmitEditing={() => void commitTokensDraft()}
                  onBlur={() => void commitTokensDraft()}
                  keyboardType="number-pad"
                  selectTextOnFocus
                  returnKeyType="done"
                  accessibilityLabel="自动压缩上下文阈值(单位 k token)"
                />
                <Text style={styles.compactSubLabel}>
                  {`k 压缩一次(${AUTO_COMPACT_TOKENS_K_MIN}–${AUTO_COMPACT_TOKENS_K_MAX})`}
                </Text>
              </>
            ) : null}
          </View>
          <Text style={styles.compactHint}>
            任务结算后检查;/compact 由 provider 会话执行,不支持斜杠命令的模型会把它当普通消息(无害),此时请关闭
          </Text>
        </View>
      ) : null}

      {targetAgentId && !targetValid ? (
        <View style={styles.warnBar}>
          <Text style={styles.warnText}>
            主Agent 已归档/不存在,自动发送已暂停,请重新选择发送目标。
          </Text>
        </View>
      ) : !targetAgentId ? (
        <View style={styles.warnBar}>
          <Text style={styles.hintText}>尚未绑定主 Agent:先选择一个发送目标,再勾选任务开启自动发送。</Text>
        </View>
      ) : null}

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {tasks.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>主 Agent 工作时想到的任务先记在这里</Text>
            <Text style={styles.emptyHint}>
              添加后可在这里补全内容;勾选任务并开启自动发送,相关 Agent 全部空闲时会按顺序发送。
            </Text>
          </View>
        ) : (
          tasks.map((task, index) => {
            const queueIndex = queueIndexById.get(task.id);
            // 批量编辑模式:复选框与整行都变为"多选切换",行内排序/删除按钮隐藏
            const checkboxTone = editing
              ? checkedIds.has(task.id)
                ? ("selected" as const)
                : ("none" as const)
              : task.done
                ? ("done" as const)
                : task.selected
                  ? ("selected" as const)
                  : ("none" as const);
            return (
              <FeedbackPressable
                key={task.id}
                style={[styles.row, editing && checkedIds.has(task.id) ? styles.rowChecked : null]}
                hoverStyle={styles.rowHover}
                onPress={() => (editing ? toggleChecked(task.id) : onOpenTask(task.id))}
                accessibilityRole={editing ? "checkbox" : "button"}
                accessibilityState={editing ? { checked: checkedIds.has(task.id) } : undefined}
                accessibilityLabel={
                  editing
                    ? `${checkedIds.has(task.id) ? "取消选择" : "选择"}任务 ${task.title}`
                    : `打开任务 ${task.title}`
                }
              >
                <TaskCheckbox
                  tone={checkboxTone}
                  theme={theme}
                  compact={compact}
                  label={
                    editing
                      ? `${checkedIds.has(task.id) ? "取消选择" : "选择"}任务 ${task.title}`
                      : task.done
                        ? `取消完成 ${task.title}`
                        : task.sentAt !== null
                          ? `标记完成 ${task.title}`
                          : `选中 ${task.title}`
                  }
                  onPress={() => (editing ? toggleChecked(task.id) : toggleTask(task))}
                />
                <View style={styles.rowMain}>
                  <Text
                    style={[
                      styles.rowTitle,
                      task.done ? styles.rowTitleDone : task.sentAt !== null ? styles.rowTitleSent : null,
                    ]}
                    numberOfLines={2}
                  >
                    {task.title}
                  </Text>
                  <View style={styles.badges}>
                    {(task.images?.length ?? 0) > 0 ? (
                      <View style={styles.badge}>
                        <Icon name="Image" size={9} color={theme.colors.foregroundMuted} />
                        <Text style={styles.badgeText}>{`${task.images!.length} 图`}</Text>
                      </View>
                    ) : null}
                    {task.done ? (
                      <View style={styles.badge}>
                        <Icon name="Check" size={9} color={theme.colors.statusSuccess} />
                        <Text style={[styles.badgeText, styles.badgeSent]}>已完成</Text>
                      </View>
                    ) : taskDisplayStatus(task, targetRunning) === "running" ? (
                      <View style={styles.badge}>
                        <SpinIcon size={9} color={runningColor} />
                        <Text style={[styles.badgeText, { color: runningColor }]}>运行中</Text>
                      </View>
                    ) : task.sentAt !== null ? (
                      <View style={styles.badge}>
                        <Text style={[styles.badgeText, { color: theme.colors.statusWarning }]}>
                          {`待验收 ${formatSentAt(task.settledAt ?? task.sentAt)}`}
                        </Text>
                      </View>
                    ) : queueIndex ? (
                      <View style={styles.badge}>
                        <Text style={[styles.badgeText, styles.badgePending]}>
                          {`待发送 ${queueIndex}`}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
                {editing ? null : (
                  <View style={styles.actions}>
                    <RowIconButton
                      icon="ChevronUp"
                      color={theme.colors.foregroundMuted}
                      disabled={index === 0}
                      label={`上移任务 ${task.title}`}
                      compact={compact}
                      theme={theme}
                      onPress={() => void patchTasks(moveTask(tasks, task.id, "up"))}
                    />
                    <RowIconButton
                      icon="ChevronDown"
                      color={theme.colors.foregroundMuted}
                      disabled={index === tasks.length - 1}
                      label={`下移任务 ${task.title}`}
                      compact={compact}
                      theme={theme}
                      onPress={() => void patchTasks(moveTask(tasks, task.id, "down"))}
                    />
                    <RowIconButton
                      icon="Trash2"
                      color={theme.colors.statusDanger}
                      label={`删除任务 ${task.title}`}
                      compact={compact}
                      theme={theme}
                      onPress={() =>
                        void patchTasks(
                          tasks.filter((item) => item.id !== task.id),
                          "已删除任务",
                        )
                      }
                    />
                  </View>
                )}
              </FeedbackPressable>
            );
          })
        )}
      </ScrollView>

      {editing ? (
        // 批量操作条:替代快速添加输入;未勾选时除全选/退出外全部禁用
        <View style={styles.composer}>
          <Text style={styles.editCount}>{`已选 ${checkedIds.size}`}</Text>
          <FeedbackPressable
            style={styles.chip}
            hoverStyle={styles.hover}
            onPress={toggleAll}
            disabled={tasks.length === 0}
            accessibilityRole="button"
            accessibilityLabel={allChecked ? "清空选择" : "全选任务"}
          >
            <Text style={styles.chipText}>{allChecked ? "清空" : "全选"}</Text>
          </FeedbackPressable>
          {(
            [
              { label: "标记完成", disabled: checkedIds.size === 0, accent: true, onPress: () => batchPatch((task) => ({ ...task, done: true }), "已批量标记完成") },
              { label: "标记未完成", disabled: checkedIds.size === 0, accent: false, onPress: () => batchPatch((task) => ({ ...task, done: false }), "已批量标记未完成") },
              { label: "加入队列", disabled: checkedIds.size === 0, accent: false, onPress: () => batchPatch((task) => ({ ...task, selected: true }), "已批量加入队列") },
              { label: "移出队列", disabled: checkedIds.size === 0, accent: false, onPress: () => batchPatch((task) => ({ ...task, selected: false }), "已批量移出队列") },
            ] as const
          ).map((action) => (
            <FeedbackPressable
              key={action.label}
              style={[styles.chip, action.accent && action.disabled === false ? styles.chipActive : null]}
              hoverStyle={styles.hover}
              onPress={action.onPress}
              disabled={action.disabled}
              accessibilityRole="button"
              accessibilityLabel={`批量${action.label}`}
            >
              <Text style={action.accent && !action.disabled ? styles.chipTextActive : styles.chipText}>
                {action.label}
              </Text>
            </FeedbackPressable>
          ))}
          <FeedbackPressable
            style={styles.chip}
            hoverStyle={styles.hover}
            onPress={clearDone}
            disabled={doneCount === 0}
            accessibilityRole="button"
            accessibilityLabel="清除已完成任务"
          >
            <Icon name="CheckCheck" size={12} color={doneCount === 0 ? theme.colors.border : theme.colors.statusSuccess} />
            <Text style={[styles.chipText, doneCount > 0 ? { color: theme.colors.statusSuccess } : null]}>
              {doneCount > 0 ? `清除已完成 ${doneCount}` : "清除已完成"}
            </Text>
          </FeedbackPressable>
          <FeedbackPressable
            style={styles.chip}
            hoverStyle={styles.hover}
            onPress={batchDelete}
            disabled={checkedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel="批量删除任务"
          >
            {/* 禁用态图标用 foregroundMuted(border 与背景同色,视觉上图标"消失") */}
            <Icon
              name="Trash2"
              size={12}
              color={checkedIds.size === 0 ? theme.colors.foregroundMuted : theme.colors.statusDanger}
            />
            <Text style={[styles.chipText, checkedIds.size > 0 ? { color: theme.colors.statusDanger } : null]}>
              删除
            </Text>
          </FeedbackPressable>
          <FeedbackPressable
            style={[styles.chip, styles.chipActive]}
            hoverStyle={styles.hover}
            onPress={exitEditing}
            accessibilityRole="button"
            accessibilityLabel="退出批量编辑"
          >
            <Text style={styles.chipTextActive}>完成</Text>
          </FeedbackPressable>
        </View>
      ) : (
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="想到什么就写下来,Enter 添加"
            placeholderTextColor={theme.colors.foregroundMuted}
            onSubmitEditing={() => void addTask()}
            blurOnSubmit={false}
            returnKeyType="done"
            accessibilityLabel="快速添加任务"
          />
          <FeedbackPressable
            style={styles.sendButton}
            hoverStyle={styles.sendHover}
            onPress={() => void addTask()}
            disabled={draft.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="添加任务"
          >
            <Icon name="Plus" size={15} color={theme.colors.accentForeground} />
          </FeedbackPressable>
        </View>
      )}

      <Modal
        title="选择主 Agent"
        open={pickerOpen}
        onOpenChange={(open) => setPickerOpen(open)}
      >
        <Modal.Content>
          <ScrollView style={{ maxHeight: 360 }}>
            {candidates.length === 0 ? (
              <Text style={styles.pickerEmpty}>项目内没有未归档的 agent,无法绑定发送目标。</Text>
            ) : (
              candidates.map((candidate) => {
                const active = candidate.id === targetAgentId;
                return (
                  <FeedbackPressable
                    key={candidate.id}
                    style={styles.pickerRow}
                    hoverStyle={styles.hover}
                    onPress={() => void bindTarget(candidate.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`绑定主 Agent ${candidate.label}`}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pickerTitle} numberOfLines={1}>
                        {candidate.label}
                      </Text>
                      {candidate.workspace ? (
                        <Text style={styles.pickerWs} numberOfLines={1}>
                          工作区 {candidate.workspace}
                        </Text>
                      ) : null}
                    </View>
                    {active ? (
                      <Icon name="Check" size={15} color={theme.colors.statusSuccess} />
                    ) : null}
                  </FeedbackPressable>
                );
              })
            )}
          </ScrollView>
        </Modal.Content>
      </Modal>
    </View>
  );
}

interface DetailViewProps extends TaskListConsoleProps {
  view: { kind: "task-detail"; taskId: string };
}

/** 详情视图:编辑标题/内容、立即发送、重新排队、标记完成、删除、脏数据确认。 */
function TaskDetail(props: DetailViewProps) {
  const {
    projectId,
    settings,
    tasks,
    targetAgentId,
    targetValid,
    markPendingSent,
    discardPendingSent,
    relatedBusyCount,
    relatedCount,
    autoSendPhase,
    targetRunning,
    runningColor,
    theme,
    compact,
    onBackToList,
    onOpenTask,
    view,
  } = props;
  const task = useMemo(() => tasks.find((item) => item.id === view.taskId) ?? null, [tasks, view.taskId]);
  // 上/下一个任务:按列表顺序(与自动发送顺序一致);列表重排后即时生效
  const currentIndex = tasks.findIndex((item) => item.id === view.taskId);
  const prevTask = currentIndex > 0 ? tasks[currentIndex - 1] ?? null : null;
  const nextTask = currentIndex >= 0 && currentIndex < tasks.length - 1 ? tasks[currentIndex + 1] ?? null : null;
  const { save, toast } = useTaskListWriter(settings, projectId);
  const paseo = usePaseo();
  const readLatest = useTaskListLatestReader();
  const [title, setTitle] = useState(task?.title ?? "");
  const [content, setContent] = useState(task?.content ?? "");
  // 随消息发送的图片(base64);来源为剪贴板(仅 web 可读),点击缩略图移除
  const [images, setImages] = useState<TaskImage[]>(task?.images ?? []);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // 发送防重入权威:await 前置位、finally 释放,state 只驱动按钮文案
  const sendingRef = useRef(false);
  // 确认弹窗:back/delete 之外还支持带切换目标的 nav(脏数据下切任务先确认)
  const [confirm, setConfirm] = useState<"back" | "delete" | { kind: "nav"; taskId: string } | null>(
    null,
  );

  const dirty = Boolean(
    task &&
      (title !== task.title ||
        content !== task.content ||
        JSON.stringify(images) !== JSON.stringify(task.images ?? [])),
  );

  // 结果栏只展示"任务结算时收集"的快照:运行中的新任务绝不显示结果,
  // 无快照也绝不回落读取主 Agent 全局最新输出——那会把别的任务的反馈
  // 错挂到本任务(已实测复现);宁可显示"暂无结果输出"。
  const showResult = Boolean(task?.sentAt) && (task?.settledAt != null || task?.done) && targetValid;
  const resultSnapshot = task?.result && task.result.trim() ? task.result : null;

  const saveTask = useCallback(
    async (patch: Partial<TaskRecord>, successMessage?: string): Promise<boolean> => {
      if (!task) return false;
      return save(
        (list) => ({
          ...list,
          tasks: list.tasks.map((item) => (item.id === task.id ? { ...item, ...patch } : item)),
        }),
        successMessage,
      );
    },
    [save, task],
  );

  const validateDraft = useCallback((): string | null => {
    const trimmed = title.trim();
    if (!trimmed) return "标题不能为空";
    if (trimmed.length > TASK_TITLE_MAX) return `标题不能超过 ${TASK_TITLE_MAX} 字`;
    if (content.length > TASK_CONTENT_MAX) return `内容不能超过 ${TASK_CONTENT_MAX} 字`;
    return null;
  }, [title, content]);

  const handleSave = useCallback(async () => {
    if (!task) return;
    const problem = validateDraft();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    const ok = await saveTask({ title: title.trim(), content, images }, "已保存");
    if (ok) onBackToList();
  }, [task, title, content, images, validateDraft, saveTask, onBackToList]);

  const handleSend = useCallback(async () => {
    if (!task || sendingRef.current) return;
    if (!targetAgentId || !targetValid) {
      toast.error("主 Agent 已失效,请重新选择发送目标");
      return;
    }
    const problem = validateDraft();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    sendingRef.current = true;
    setSending(true);
    try {
      // 有未保存修改时先落盘再发送,保证实际发出去的内容(含图片)与输入框一致
      let taskToSend = task;
      if (dirty) {
        const saved = await saveTask({ title: title.trim(), content, images });
        if (!saved) return;
        taskToSend = { ...task, title: title.trim(), content, images };
      }
      const result = await sendTask({
        projectId,
        targetAgentId,
        task: taskToSend,
        paseo,
        settings,
        toast,
        readLatest,
      });
      if (result.delivered && !result.ok && result.sentAt != null) {
        // 已投递但 sentAt 没落盘:交给面板级补写持续重试,并先乐观显示已发送
        markPendingSent(taskToSend.id, result.sentAt, taskToSend.attempt);
      }
      if (result.ok) toast.show("已发送");
      else toast.error(result.error ?? "发送失败");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发送失败");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [
    task,
    dirty,
    title,
    content,
    images,
    validateDraft,
    saveTask,
    targetAgentId,
    targetValid,
    markPendingSent,
    projectId,
    paseo,
    settings,
    toast,
    readLatest,
  ]);

  // 从剪贴板添加图片(仅 web;与控制台附件同一来源与形态)。
  // 格式/大小/数量在添加时立即校验,不等到保存才报错
  const handleAttach = useCallback(async () => {
    if (images.length >= TASK_IMAGES_MAX) {
      toast.error(`最多 ${TASK_IMAGES_MAX} 张图片`);
      return;
    }
    const image = await readClipboardImage();
    if (!image) {
      toast.show("剪贴板里没有图片(先截图再点此按钮)");
      return;
    }
    if (!(TASK_IMAGE_MIME_TYPES as readonly string[]).includes(image.mimeType)) {
      toast.error(`不支持的图片格式:${image.mimeType}`);
      return;
    }
    if (image.data.length > TASK_IMAGE_DATA_MAX) {
      toast.error("图片过大(超过约 2MB 上限),请压缩后再试");
      return;
    }
    setImages((current) =>
      current.length >= TASK_IMAGES_MAX
        ? current
        : [...current, { ...image, mimeType: image.mimeType as TaskImage["mimeType"] }],
    );
  }, [images.length, toast]);

  const handleDelete = useCallback(async () => {
    if (!task) return;
    const ok = await save(
      (list) => ({ ...list, tasks: list.tasks.filter((item) => item.id !== task.id) }),
      "已删除任务",
    );
    if (ok) onBackToList();
  }, [task, save, onBackToList]);

  const requestBack = useCallback(() => {
    if (dirty) setConfirm("back");
    else onBackToList();
  }, [dirty, onBackToList]);

  const requestDelete = useCallback(() => {
    if (dirty) setConfirm("delete");
    else void handleDelete();
  }, [dirty, handleDelete]);

  // 上/下一个任务切换:脏数据先确认,避免静默丢失编辑
  const requestNav = useCallback(
    (taskId: string) => {
      if (dirty) setConfirm({ kind: "nav", taskId });
      else onOpenTask(taskId);
    },
    [dirty, onOpenTask],
  );

  const confirmAction = useCallback(async () => {
    const action = confirm;
    setConfirm(null);
    if (action === "delete") await handleDelete();
    else if (action === "back") onBackToList();
    else if (action && typeof action === "object") onOpenTask(action.taskId);
  }, [confirm, handleDelete, onBackToList, onOpenTask]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        // 视图填满外层包装(高度/拖拽 grip 由 TaskListConsole 统一管理)
        root: { flex: 1, minHeight: 0 },
        header: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: compact ? 10 : 14,
          paddingVertical: 6,
        },
        headerButton: {
          width: compact ? 44 : 30,
          height: compact ? 44 : 30,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        hover: { backgroundColor: theme.colors.surface2 },
        headerTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
        badge: {
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          paddingHorizontal: 7,
          paddingVertical: 2,
          borderRadius: 999,
          backgroundColor: theme.colors.surface2,
        },
        badgeText: { color: theme.colors.foregroundMuted, fontSize: 10 },
        badgeDone: { color: theme.colors.statusSuccess },
        body: { paddingHorizontal: compact ? 10 : 14, paddingBottom: 12, gap: 8 },
        label: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" },
        input: {
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          color: theme.colors.foreground,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: 13,
        },
        contentInput: {
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          color: theme.colors.foreground,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: 12,
          minHeight: 84,
          maxHeight: 220,
          textAlignVertical: "top" as const,
        },
        errorText: { color: theme.colors.statusDanger, fontSize: 11 },
        // 结果栏:只读展示主 Agent 最新输出,高度封顶内部滚动
        resultBox: {
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
          paddingHorizontal: 10,
          paddingVertical: 8,
        },
        resultScroll: { maxHeight: 200 },
        resultEmptyText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
        attachRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
        attachment: { width: 40, height: 40, borderRadius: 6, overflow: "hidden" },
        attachButton: {
          width: 40,
          height: 40,
          borderRadius: 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface2,
        },
        hoverDim: { opacity: 0.8 },
        warnBar: {
          borderRadius: 8,
          paddingHorizontal: 9,
          paddingVertical: 6,
          backgroundColor: theme.colors.surface2,
        },
        warnText: { color: theme.colors.statusWarning, fontSize: 11, lineHeight: 15 },
        hint: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 },
        actions: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
        // 上/下一个任务导航:宽度随内容自适应(与其他操作按钮同高同款),不占满整行
        navButton: { paddingHorizontal: 8 },
        navDisabledText: { color: theme.colors.border },
        navPos: { color: theme.colors.foregroundMuted, fontSize: 10, marginHorizontal: 2 },
        button: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 10,
          paddingVertical: 8,
          minHeight: compact ? 44 : 32,
          justifyContent: "center",
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        buttonPrimary: { backgroundColor: theme.colors.accent },
        buttonHover: { opacity: 0.8 },
        buttonText: { color: theme.colors.foreground, fontSize: 12 },
        buttonPrimaryText: { color: theme.colors.accentForeground, fontSize: 12 },
        buttonDangerText: { color: theme.colors.statusDanger, fontSize: 12 },
        placeholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 20 },
        placeholderText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        confirmText: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        confirmActions: {
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 14,
        },
        confirmButton: {
          paddingHorizontal: 12,
          paddingVertical: 7,
          minHeight: compact ? 44 : undefined,
          justifyContent: "center",
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        confirmPrimary: { backgroundColor: theme.colors.accent },
        confirmButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        confirmPrimaryText: { color: theme.colors.accentForeground, fontSize: 12 },
      }),
    [theme, compact],
  );

  if (!task) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <FeedbackPressable
            style={styles.headerButton}
            hoverStyle={styles.hover}
            onPress={onBackToList}
            accessibilityRole="button"
            accessibilityLabel="返回任务列表"
          >
            <Icon name="ArrowLeft" size={15} color={theme.colors.foregroundMuted} />
          </FeedbackPressable>
          <Text style={styles.headerTitle}>任务详情</Text>
        </View>
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>任务不存在或已被删除。</Text>
          <FeedbackPressable
            style={styles.button}
            hoverStyle={styles.hover}
            onPress={onBackToList}
            accessibilityRole="button"
            accessibilityLabel="返回任务列表"
          >
            <Text style={styles.buttonText}>返回列表</Text>
          </FeedbackPressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <FeedbackPressable
          style={styles.headerButton}
          hoverStyle={styles.hover}
          onPress={requestBack}
          accessibilityRole="button"
          accessibilityLabel="返回任务列表"
        >
          <Icon name="ArrowLeft" size={15} color={theme.colors.foregroundMuted} />
        </FeedbackPressable>
        <Text style={styles.headerTitle}>任务详情</Text>
        <View style={styles.badge}>
          {taskDisplayStatus(task, targetRunning) === "running" ? (
            <SpinIcon size={10} color={runningColor} />
          ) : null}
          <Text
            style={[
              styles.badgeText,
              task.done
                ? styles.badgeDone
                : taskDisplayStatus(task, targetRunning) === "running"
                  ? { color: runningColor }
                  : task.sentAt !== null
                    ? { color: theme.colors.statusWarning }
                    : null,
            ]}
          >
            {task.done
              ? "已完成"
              : taskDisplayStatus(task, targetRunning) === "running"
                ? "运行中"
                : task.sentAt !== null
                  ? `待验收 ${formatSentAt(task.settledAt ?? task.sentAt)}`
                  : task.selected
                    ? "待发送"
                    : "草稿"}
          </Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {!targetValid ? (
          <View style={styles.warnBar}>
            <Text style={styles.warnText}>
              主Agent 已归档/不存在,自动发送与立即发送都不可用;请先在列表头部重新选择。
            </Text>
          </View>
        ) : null}
        <Text style={styles.label}>标题</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={(text) => {
            setTitle(text);
            setError(null);
          }}
          maxLength={TASK_TITLE_MAX}
          placeholder="任务标题"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="任务标题"
        />
        <Text style={styles.label}>内容(发送给主 Agent 的消息)</Text>
        <TextInput
          style={styles.contentInput}
          value={content}
          onChangeText={(text) => {
            setContent(text);
            setError(null);
          }}
          multiline
          maxLength={TASK_CONTENT_MAX}
          placeholder="发送给主 Agent 的具体任务内容"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="任务内容"
        />
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {/* 图片附件:随消息一起发送;web 从剪贴板添加,点击缩略图移除 */}
        {images.length > 0 || canReadClipboardImage ? (
          <View style={styles.attachRow}>
            {images.map((image, index) => (
              <FeedbackPressable
                key={`${index}-${image.mimeType}`}
                style={styles.attachment}
                hoverStyle={styles.hoverDim}
                onPress={() => setImages((current) => current.filter((_, i) => i !== index))}
                accessibilityLabel={`移除第 ${index + 1} 张图片`}
              >
                <Image
                  source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
                  style={{ flex: 1 }}
                  resizeMode="cover"
                />
              </FeedbackPressable>
            ))}
            {canReadClipboardImage ? (
              <FeedbackPressable
                style={styles.attachButton}
                hoverStyle={styles.hoverDim}
                onPress={() => void handleAttach()}
                disabled={images.length >= TASK_IMAGES_MAX}
                accessibilityRole="button"
                accessibilityLabel="从剪贴板添加图片"
              >
                <Icon name="ImagePlus" size={16} color={theme.colors.foregroundMuted} />
              </FeedbackPressable>
            ) : null}
          </View>
        ) : null}
        {canReadClipboardImage ? (
          <Text style={styles.hint}>
            {`图片随消息一起发送:点 + 从剪贴板添加(先截图),点击缩略图移除,最多 ${TASK_IMAGES_MAX} 张。`}
          </Text>
        ) : null}
        {/* 结果栏:结算时落盘的主 Agent 输出快照,只读;运行中不显示,无快照不回落 */}
        {showResult ? (
          <>
            <Text style={styles.label}>结果(任务结束时收集,只读)</Text>
            <View style={styles.resultBox}>
              {resultSnapshot ? (
                <ScrollView style={styles.resultScroll} nestedScrollEnabled>
                  <MarkdownText
                    text={resultSnapshot}
                    theme={theme}
                    baseStyle={{ color: theme.colors.foreground, fontSize: 11, lineHeight: 16 }}
                  />
                </ScrollView>
              ) : (
                <Text style={styles.resultEmptyText}>暂无结果输出</Text>
              )}
            </View>
          </>
        ) : null}
        <Text style={styles.hint}>
          立即发送与自动发送共用同一条发送路径:发送目标始终是列表绑定的主 Agent,
          稳定 messageId 保证重试不会重复投递。
          结果反馈在主 Agent 回合结束(待验收)时收集。
          {autoSendPhase === "waiting"
            ? relatedBusyCount > 0
              ? ` 自动发送正在等待相关 Agent 全部空闲(${waitingProgressText(relatedBusyCount, relatedCount)})。`
              : " 自动发送正在等待相关 Agent 全部空闲。"
            : ""}
        </Text>

        <View style={styles.actions}>
          <FeedbackPressable
            style={[styles.button, styles.buttonPrimary]}
            hoverStyle={styles.buttonHover}
            onPress={() => void handleSave()}
            accessibilityRole="button"
            accessibilityLabel="保存任务"
          >
            <Icon name="Save" size={13} color={theme.colors.accentForeground} />
            <Text style={styles.buttonPrimaryText}>保存</Text>
          </FeedbackPressable>
          <FeedbackPressable
            style={styles.button}
            hoverStyle={styles.hover}
            onPress={() => void handleSend()}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="立即发送"
          >
            <Icon name="Send" size={13} color={theme.colors.foregroundMuted} />
            <Text style={styles.buttonText}>{sending ? "发送中…" : "立即发送"}</Text>
          </FeedbackPressable>
          {task.sentAt !== null ? (
            <FeedbackPressable
              style={styles.button}
              hoverStyle={styles.hover}
              // attempt 递增产生新 messageId:否则 daemon 按旧 messageId 去重,任务永远无法重新投递;
              // 同时清空 settledAt 与旧结果快照,回到"执行中/待验收"之前的队列语义;
              // 先丢弃乐观 sentAt:否则 mergePendingSent 会把旧值盖回重置后的任务,重新排队失效
              onPress={() => {
                discardPendingSent(task.id);
                void saveTask(
                  { sentAt: null, selected: true, attempt: task.attempt + 1, settledAt: null, result: null },
                  "已重新排队",
                );
              }}
              accessibilityRole="button"
              accessibilityLabel="重新排队"
            >
              <Icon name="RotateCw" size={13} color={theme.colors.foregroundMuted} />
              <Text style={styles.buttonText}>重新排队</Text>
            </FeedbackPressable>
          ) : null}
          <FeedbackPressable
            style={styles.button}
            hoverStyle={styles.hover}
            onPress={() => void saveTask({ done: !task.done })}
            accessibilityRole="button"
            accessibilityLabel={task.done ? "取消完成" : "标记完成"}
          >
            <Icon
              name={task.done ? "X" : "Check"}
              size={13}
              color={task.done ? theme.colors.foregroundMuted : theme.colors.statusSuccess}
            />
            <Text style={styles.buttonText}>{task.done ? "取消完成" : "标记完成"}</Text>
          </FeedbackPressable>
          <FeedbackPressable
            style={styles.button}
            hoverStyle={styles.hover}
            onPress={requestDelete}
            accessibilityRole="button"
            accessibilityLabel="删除任务"
          >
            <Icon name="Trash2" size={13} color={theme.colors.statusDanger} />
            <Text style={styles.buttonDangerText}>删除</Text>
          </FeedbackPressable>

          {/* 上/下一个任务:按列表顺序快速切换查看;编号指示当前进度,与操作按钮同一行 */}
          <FeedbackPressable
            style={[styles.button, styles.navButton]}
            hoverStyle={styles.hover}
            disabled={!prevTask}
            onPress={() => prevTask && requestNav(prevTask.id)}
            accessibilityRole="button"
            accessibilityLabel="上一个任务"
          >
            <Icon name="ChevronUp" size={13} color={prevTask ? theme.colors.foregroundMuted : theme.colors.border} />
            <Text style={[styles.buttonText, !prevTask ? styles.navDisabledText : null]}>上一个</Text>
          </FeedbackPressable>
          {tasks.length > 0 ? (
            <Text style={styles.navPos}>{`${Math.max(currentIndex + 1, 1)} / ${tasks.length}`}</Text>
          ) : null}
          <FeedbackPressable
            style={[styles.button, styles.navButton]}
            hoverStyle={styles.hover}
            disabled={!nextTask}
            onPress={() => nextTask && requestNav(nextTask.id)}
            accessibilityRole="button"
            accessibilityLabel="下一个任务"
          >
            <Text style={[styles.buttonText, !nextTask ? styles.navDisabledText : null]}>下一个</Text>
            <Icon name="ChevronDown" size={13} color={nextTask ? theme.colors.foregroundMuted : theme.colors.border} />
          </FeedbackPressable>
        </View>
      </ScrollView>

      <Modal
        title="有未保存的修改"
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <Modal.Content>
          <Text style={styles.confirmText}>
            {confirm === "delete"
              ? "当前标题或内容尚未保存,确认删除该任务?"
              : confirm !== null && typeof confirm === "object"
                ? "当前标题或内容尚未保存,确认切换到其他任务?修改将丢失。"
                : "当前标题或内容尚未保存,确认返回列表?修改将丢失。"}
          </Text>
          <View style={styles.confirmActions}>
            <FeedbackPressable
              style={styles.confirmButton}
              hoverStyle={styles.hover}
              onPress={() => setConfirm(null)}
              accessibilityRole="button"
              accessibilityLabel="继续编辑"
            >
              <Text style={styles.confirmButtonText}>继续编辑</Text>
            </FeedbackPressable>
            <FeedbackPressable
              style={[styles.confirmButton, styles.confirmPrimary]}
              hoverStyle={styles.buttonHover}
              onPress={() => void confirmAction()}
              accessibilityRole="button"
              accessibilityLabel={confirm === "delete" ? "确认删除" : "确认离开"}
            >
              <Text style={styles.confirmPrimaryText}>
                {confirm === "delete" ? "确认删除" : "确认离开"}
              </Text>
            </FeedbackPressable>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

/** 底部任务列表控制台:列表 / 详情两个视图(与 AgentConsole 同槽位互斥)。 */
export function TaskListConsole(props: TaskListConsoleProps) {
  const { theme, compact } = props;
  // 可拖拽高度(与 AgentConsole 的 grip 同一交互;列表/详情共享,切换视图不重置)。
  // 默认 560:保证任务详情的全部操作按钮与导航无需滚动即可见
  const DEFAULT_HEIGHT = 560;
  const MAX_HEIGHT = 680;
  const MIN_HEIGHT = 200;
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const heightRef = useRef(height);
  heightRef.current = height;
  const dragRef = useRef<{ startY: number; base: number } | null>(null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          borderTopWidth: compact ? 0 : 1,
          borderTopColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          height: compact ? undefined : height,
          flex: compact ? 1 : undefined,
          minHeight: 0,
        },
        grip: {
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 5,
          cursor: "pointer",
        },
        gripBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: theme.colors.border },
      }),
    [theme, compact, height],
  );

  return (
    <View style={styles.root}>
      {!compact ? (
        <View
          style={styles.grip}
          accessibilityLabel="拖动调整任务列表高度"
          onStartShouldSetResponder={() => true}
          onResponderGrant={(event) => {
            dragRef.current = { startY: event.nativeEvent.pageY, base: heightRef.current };
          }}
          onResponderMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const next = drag.base + (drag.startY - event.nativeEvent.pageY);
            setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, next)));
          }}
          onResponderEnd={() => {
            dragRef.current = null;
          }}
          onResponderRelease={() => {
            dragRef.current = null;
          }}
        >
          <View style={styles.gripBar} />
        </View>
      ) : null}
      {props.view.kind === "task-detail" ? (
        // key 让切换任务时本地编辑状态重新初始化,避免串内容
        <TaskDetail
          key={`${props.projectId}:${props.view.taskId}`}
          {...props}
          view={props.view}
        />
      ) : (
        <TaskListHome {...props} view={props.view} />
      )}
    </View>
  );
}
