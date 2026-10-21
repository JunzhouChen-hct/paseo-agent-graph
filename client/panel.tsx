import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { usePaseo, useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { cancelAgentRpc, debugReportRpc } from "../shared/graph";
import {
  archivePolicy,
  freshArchiveVerdict,
} from "../shared/archive-policy";
import { PARENT_AGENT_ID_LABEL } from "../shared/template-model";
import { idleMsSince, resolveIdleTier, DEFAULT_IDLE_FADE_TIERS, type IdleFadeTierConfig } from "../shared/idle-fade";
import { agentGraphSettings, resolveColors, type StatusColors } from "../shared/settings";
import {
  agentGraphTaskListSettings,
  applyTaskResults,
  COMPACT_BARRIER_MS,
  defaultTaskListEntry,
  IDLE_CONFIRM_MS,
  mergePendingSent,
  pickDefaultTaskTarget,
  settleReadyIds,
  settleSentTasks,
  shouldAutoCompact,
  truncateTaskResult,
  withTaskList,
  type TaskListDoc,
  type TaskListEntry,
} from "../shared/task-list";
import {
  agentsInWorkspace,
  creationTargetWorkspaceId,
  truncateWorkspaceLabel,
  visibleAgents,
  workspaceBadgeLabel,
} from "../shared/project-scope";
import { useProjectAgentDirectory, type DirectoryAgent } from "./directory";
import { computeLayout, type LayoutPosition, type LayoutResult } from "./layout";
import { AgentCard, type CardMeta } from "./card";
import { FeedbackPressable } from "./feedback-pressable";
import { relatedNodeIds, toneOf } from "../shared/graph";
import { GraphEdgeFlow, GraphEdgeLine } from "./edge";
import {
  assignExitOffsets,
  type Point,
  type SampledPath,
} from "../shared/edge-geometry";
import { planEdgePath, routeBounds, type ObstacleRect } from "../shared/edge-routing";
import { AgentConsole } from "./console";
import { CreateAgentPanel } from "./create-agent";
import { TemplatesView } from "./templates";
import { useAgentMetadata, useModelLabels } from "./agent-metadata";
import { AgentTaskCard, AgentTaskStub } from "./task-list-card";
import { TaskListConsole, type TaskListConsoleView } from "./task-list-console";
import {
  useSentAtBackfill,
  useTaskAutoSend,
  useTaskListLatestReader,
} from "./use-task-auto-send";

const CARD_W = 236;
const CARD_W_COMPACT = 164;
// 原内容 + 一行元数据(分支;思考/速度已并入模型行) + 一行 workspace 标识的预留余量
// + 上下文行(占用环 + used/max + 压缩按钮,约 17);模型行加宽到 236 容纳 label+思考+速度
// + 运行活动行(耗时 · tok/s · progress,仅运行中渲染,高度预算为其预留 16)
const CARD_H = 148;
const CARD_H_COMPACT = 184;
/** 窄屏画布等比缩放下限:低于此值不再缩小,改横向滚动 */
const MIN_CANVAS_SCALE = 0.58;
/** 列间距:父列与子列之间的通道,容纳边的竖直车道(呼吸框+流点+多车道分布) */
const GAP_COL = 52;
/** 列内行距:同列卡片竖直间距,同时是跨列水平通道的通行空间 */
const GAP_ROW = 26;
/** 列头统计带高度(画布顶部预留,布局坐标整体下移该值) */
const COLUMN_HEADER_H = 22;
// 父卡片右缘上下各留的边距:多条边在该范围内分配唯一出线点
const EDGE_EXIT_MARGIN = 24;
/** 任务列表挂载物的避障占位 id:只存在于障碍列表中,不是真实 agent。 */
const TASK_LIST_NODE_ID = "tasklist";
/** 折叠态的小图标尺寸(展开卡片走 cardW/taskCardH)。 */
const TASK_STUB_SIZE = { width: 36, height: 36 };
/** 折叠态小图标与主 Agent 的视觉间距(根目标左挂时贴靠;非根目标占同列槽位)。 */
const TASK_STUB_GAP = 8;

/** 压缩中清扫:提交后已离开 running 仍需等待的宽限(覆盖回合未启动就取消)。 */
const COMPACT_CLEAR_GRACE_MS = 8_000;
/** 压缩中清扫硬上限:任何信号都收不到时最多保留这么久,防橙色框悬挂。 */
const COMPACT_CLEAR_MAX_MS = 300_000;
/** 压缩中清扫周期。 */
const COMPACT_SWEEP_MS = 2_000;

interface RawTimelineItem {
  type: string;
  text?: string;
}

/**
 * 从 timeline 尾部取最新一条非空 assistant 输出。
 * 结算时主 Agent 刚结束回合,最后一条 assistant 文本就是本次任务的反馈;
 * 空文本(纯工具调用等)跳过,避免把空串存成快照。
 * maxTimestamp(settledAt)上限过滤:逐条串行下结算沿后队列可能立即投递下一条,
 * 收集窗口内若已有新回合消息,晚于结算时刻的 assistant 不属于本任务,必须跳过。
 */
function latestAssistantText(
  payload: { entries?: { item: RawTimelineItem; timestamp?: string }[] },
  maxTimestamp?: string,
): string | null {
  const entries = payload.entries ?? [];
  const limitTs = maxTimestamp ? Date.parse(maxTimestamp) : null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const item = entry.item;
    if (item?.type !== "assistant_message") continue;
    if (limitTs !== null && entry.timestamp) {
      const ts = Date.parse(entry.timestamp);
      if (Number.isFinite(ts) && ts > limitTs) continue;
    }
    const text = item.text ?? "";
    if (text.trim()) return text;
  }
  return null;
}

/**
 * 底部单一槽位的视图状态机:原 selected 字符串哨兵迁移为判别联合,
 * 保留"打开任一视图即关闭其他视图"的既有交互。
 */
type BottomView =
  | { kind: "none" }
  | { kind: "agent"; agentId: string }
  | { kind: "create"; parentId: string }
  | { kind: "tasks" }
  | { kind: "task-detail"; taskId: string };

export function GraphPanel({ theme, layout, workspaceId, navigation, host }: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const cancelAgent = useRpc(cancelAgentRpc);
  // 展示范围 = 当前 project 的全部 workspace;project 未知前两路订阅都不启动
  const { projectId, agents, workspaces, projectName, ready, error, retry } =
    useProjectAgentDirectory(workspaceId);

  const [metas, setMetas] = useState<Map<string, CardMeta>>(new Map());
  const [bottomView, setBottomView] = useState<BottomView>({ kind: "none" });
  // 聚焦预览:悬停的卡片(临时);无悬停时回落到点选的卡片(持续)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [archivedOverride, setArchivedOverride] = useState<boolean | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  // "graph" 为节点图;"templates" 为节点模板管理视图
  const [view, setView] = useState<"graph" | "templates">("graph");
  // 部分宿主上根 View 的 onLayout 不回调(诊断日志显示恒为 0),用窗口尺寸兜底扣除页面边距
  const windowDims = useWindowDimensions();
  const measuredWidth =
    panelWidth > 0 ? panelWidth : windowDims.width > 0 ? Math.max(windowDims.width - 28, 0) : 0;
  const metasRef = useRef(metas);
  metasRef.current = metas;

  const settings = useSettings(agentGraphSettings);
  const taskSettings = useSettings(agentGraphTaskListSettings);
  const settingsValues = settings.status === "ready" ? settings.values : null;
  // 配置的"默认隐藏归档"作为初始值;用户在面板里手动切换后以面板开关为准
  const showArchived = archivedOverride ?? !(settingsValues?.hideArchivedByDefault ?? true);
  const statusColors: StatusColors = resolveColors(
    settingsValues ?? { runningColor: "", doneColor: "", attentionColor: "", failedColor: "" },
    theme.colors,
  );
  // 空闲淡出档位(设置持久化);设置未就绪时回落默认档,保证行为与旧版一致
  const idleTiers: readonly IdleFadeTierConfig[] =
    settingsValues?.idleFadeTiers ?? DEFAULT_IDLE_FADE_TIERS;

  const handleMeta = useCallback((agentId: string, meta: CardMeta) => {
    const prev = metasRef.current.get(agentId);
    if (
      prev &&
      prev.parentId === meta.parentId &&
      prev.status === meta.status &&
      prev.requiresAttention === meta.requiresAttention &&
      // 关注原因必须参与比较:finished→permission 可能 status/requiresAttention
      // 都不变,漏掉会让结算/自动发送误以为仍是"可空闲"的 finished 态
      prev.attentionReason === meta.attentionReason &&
      // 活动时刻参与比较:空闲档位自动归档按它计算空闲时长
      prev.lastActivityAt === meta.lastActivityAt
    ) {
      return;
    }
    const next = new Map(metasRef.current);
    next.set(agentId, meta);
    metasRef.current = next;
    setMetas(next);
  }, []);

  const visible = useMemo(() => visibleAgents(agents, showArchived), [agents, showArchived]);

  // 显示范围切换:project=项目全部工作区,workspace=仅当前工作区。
  // 只影响画布展示;自动发送引擎、换绑候选、默认绑定仍用项目级目录(visible),
  // 避免切到工作区视图后相关集合缺节点导致自动发送误判或绑定丢失。
  const [scopeOverride, setScopeOverride] = useState<"project" | "workspace" | null>(null);
  const displayScope = scopeOverride ?? settingsValues?.displayScope ?? "project";
  const displayAgents = useMemo(
    () =>
      displayScope === "workspace"
        ? agentsInWorkspace(visible, workspaceId)
        : visible,
    [displayScope, visible, workspaceId],
  );

  // 卡片工作区标识:活跃工作区用最新显示名;已归档工作区回落到目录 placement
  const wsById = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
  const badgeFor = useCallback(
    (agent: DirectoryAgent) => {
      const label = workspaceBadgeLabel(agent, wsById);
      return label ? truncateWorkspaceLabel(label) : null;
    },
    [wsById],
  );

  // 节点元数据(思考强度/速度模式/开发分支):批量 RPC + 定期轮询(只查画布上显示的)
  // 模型行展示 label(而非原始 id):按显示中卡片的提供方集合拉取映射
  const rawModelLabels = useModelLabels(displayAgents.map((agent) => agent.provider));
  // 预转成每提供方一个稳定 Map 引用,避免逐卡片新建对象击穿卡片 memo
  const modelLabelsByProvider = useMemo(() => {
    const map = new Map<string, ReadonlyMap<string, string>>();
    for (const [provider, entries] of Object.entries(rawModelLabels)) {
      map.set(provider, new Map(Object.entries(entries)));
    }
    return map;
  }, [rawModelLabels]);

  const parentOf = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const agent of visible) map.set(agent.id, metas.get(agent.id)?.parentId ?? null);
    return map;
  }, [visible, metas]);

  // 自动发送/结算专用的全量父子关系:基于全部 agents(含归档)构建,才能从主
  // Agent 穿透已归档的中间节点,继续覆盖其未归档子孙。画布布局/连线仍用上面的
  // visible 版(显示范围与布局语义不能被引擎需求污染)。
  const parentOfAll = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const agent of agents) map.set(agent.id, metas.get(agent.id)?.parentId ?? null);
    return map;
  }, [agents, metas]);

  const statusOf = useCallback(
    (agent: DirectoryAgent): string =>
      metas.get(agent.id)?.status ?? (agent.archived ? "closed" : agent.status),
    [metas],
  );

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  // 选中聚焦:悬停即预览(移开恢复),点选后保持;相关集合 = 聚焦节点
  // + 其父(在显示集内)+ 全部传递子孙,其余卡片压暗到 10% 透明度
  // 悬停置空只清自己的悬停(不覆盖紧邻卡片已上报的悬停)
  const handleCardHover = useCallback((agentId: string, hovered: boolean) => {
    setHoveredNodeId((current) => (hovered ? agentId : current === agentId ? null : current));
  }, []);
  const focusNodeId = hoveredNodeId ?? (bottomView.kind === "agent" ? bottomView.agentId : null);
  const relatedNodes = useMemo(
    () =>
      focusNodeId
        ? relatedNodeIds(
            displayAgents.map((agent) => agent.id),
            parentOf,
            focusNodeId,
          )
        : null,
    [focusNodeId, displayAgents, parentOf],
  );

  // —— 任务列表:按真实 projectId 隔离,目标只认持久化的 targetAgentId ——
  const taskDoc = taskSettings.status === "ready" ? taskSettings.values : null;
  const taskList: TaskListEntry | null =
    taskDoc && projectId ? taskDoc.lists[projectId] ?? null : null;
  const taskTargetAgentId = taskList?.targetAgentId ?? null;
  const taskTargetAgent = taskTargetAgentId ? agentById.get(taskTargetAgentId) ?? null : null;
  const taskTargetValid = Boolean(taskTargetAgent && !taskTargetAgent.archived);
  const taskTargetVisible = Boolean(
    taskTargetAgent && displayAgents.some((agent) => agent.id === taskTargetAgent.id),
  );
  // 目标不在可见列表(归档且被隐藏)时不渲染伪节点与卡片;头部入口仍在
  const showTaskCard = Boolean(taskList && taskTargetVisible);
  const taskTasks = taskList?.tasks ?? [];
  const taskAutoSendEnabled = taskList?.autoSend ?? false;
  // sentAt 乐观补写与结算共用同一个最新文档读取器:补写成功后 settings 订阅
  // 会推来权威数据,这里只在落盘失败期间临时把任务显示成"已发送"。
  const readLatest = useTaskListLatestReader();
  const { pendingSent, markPendingSent, discardPendingSent } = useSentAtBackfill({
    settings: taskSettings,
    projectId,
    readLatest,
  });
  // 引擎与 UI 统一用乐观列表:pickNextTask 会跳过已投递任务,避免重复发送;
  // 结算仍基于 taskTasks(权威文档),乐观值不能触发结算落盘。
  const displayTasks = useMemo(
    () => mergePendingSent(taskTasks, pendingSent),
    [taskTasks, pendingSent],
  );
  // 压缩发送屏障:send resolve 后主 Agent 可能尚未转 running,窗口内暂停自动发送,
  // 防止队列中的新任务 steer 进压缩回合;到期后由引擎自行恢复评估。
  const [compactHoldUntil, setCompactHoldUntil] = useState<number | null>(null);

  // —— 压缩中跟踪:agentId → /compact 提交时刻(ms)——
  // 卡片按钮与自动压缩共用;驱动卡片的橙色呼吸框/"压缩中"/占用环旋转,
  // 以及压缩期间到子 Agent 连线不挂流点。
  const [compactSince, setCompactSince] = useState<Record<string, number>>({});
  const compactSinceRef = useRef(compactSince);
  compactSinceRef.current = compactSince;
  // 提交时刻记录的上下文占用:压缩完成后用量会降到该值之下,是"已完成"的主信号
  const preCompactUsageRef = useRef<Map<string, number | null>>(new Map());

  const markCompactSubmitted = useCallback((agentId: string, preUsed: number | null) => {
    preCompactUsageRef.current.set(agentId, preUsed);
    setCompactSince((current) =>
      agentId in current ? current : { ...current, [agentId]: Date.now() },
    );
  }, []);

  const hasCompacting = Object.keys(compactSince).length > 0;

  // 元数据查询集合 = 显示中卡片 ∪ 任务主 Agent:显示范围切到 workspace 时,
  // 主 Agent 可能不在画布上,但自动压缩仍必须读到它的上下文用量。
  // 用 memo 保证集合内容不变时数组引用稳定(useAgentMetadata 按序列化键去重)。
  const metadataAgentIds = useMemo(() => {
    const ids = displayAgents.map((agent) => agent.id);
    if (taskTargetAgentId && !ids.includes(taskTargetAgentId)) ids.push(taskTargetAgentId);
    return ids;
  }, [displayAgents, taskTargetAgentId]);
  // 有压缩中标记时切 3 秒快轮询:压缩完成的检测延迟从 30s 降到秒级
  const metadataItems = useAgentMetadata(metadataAgentIds, hasCompacting);
  // 结算回调是异步的:运行时要读最新一次轮询结果,不能闭包在启动计时器那次 render
  const metadataRef = useRef(metadataItems);
  metadataRef.current = metadataItems;

  // 压缩中清扫:用量降到提交前之下(压缩真正收缩了上下文)、或已离开 running
  // 超过宽限(回合未启动就取消/压缩回合正常结束),或超硬上限,都撤销标记;
  // 快轮询(3s)期间清扫跟着秒级节奏走,撤销延迟控制在几秒内
  useEffect(() => {
    if (!hasCompacting) return;
    const timer = setInterval(() => {
      const now = Date.now();
      const next = { ...compactSinceRef.current };
      let changed = false;
      for (const [agentId, since] of Object.entries(next)) {
        const elapsed = now - since;
        const status = metasRef.current.get(agentId)?.status ?? null;
        const preUsed = preCompactUsageRef.current.get(agentId);
        const used = metadataRef.current[agentId]?.context?.used ?? null;
        const usageDropped = preUsed != null && used != null && used < preUsed;
        const leftRunning = status !== "running" && elapsed > COMPACT_CLEAR_GRACE_MS;
        if (usageDropped || leftRunning || elapsed > COMPACT_CLEAR_MAX_MS) {
          delete next[agentId];
          preCompactUsageRef.current.delete(agentId);
          changed = true;
        }
      }
      if (changed) setCompactSince(next);
    }, COMPACT_SWEEP_MS);
    return () => clearInterval(timer);
  }, [hasCompacting]);

  // 手机不强制两列；卡片略宽，底部操作按钮保留足够的触控面积。
  const cardW = layout.compact
    ? Math.min(240, Math.max(CARD_W_COMPACT, (measuredWidth || 360) - 40))
    : CARD_W;
  const gapCol = layout.compact ? 36 : GAP_COL;
  const gapRow = layout.compact ? 18 : GAP_ROW;
  const taskCardH = layout.compact ? CARD_H_COMPACT : CARD_H;
  const taskCollapsed = taskList?.collapsed ?? false;
  // 挂载卡片与 Agent 卡片统一高度,不再随任务数变化:约容纳 3 条任务,其余在预览区内滚动
  const taskListCardH = taskCardH;
  // 任务列表伪节点进布局引擎的两种形态:
  // - 主 Agent 绑定目标是根:伪节点不进布局树——列布局下整树向右延伸,
  //   挂载卡片锚定画布最左侧(根列左侧的预留带,见 taskLeftPad),不占布局槽位;
  // - 目标非根:左侧被父列占据,伪节点作为兄弟槽位进布局树(同列,插在
  //   目标之前 → 目标正上方),挂载卡片消费伪节点的布局位置。
  // 折叠时挂载物换 36×36 小图标尺寸。
  const taskTargetIsRoot = useMemo(() => {
    if (!taskTargetAgentId) return false;
    const targetParent = parentOf.get(taskTargetAgentId) ?? null;
    return !targetParent || !displayAgents.some((agent) => agent.id === targetParent);
  }, [taskTargetAgentId, parentOf, displayAgents]);
  const layoutIds = useMemo(() => {
    const ids = displayAgents.map((a) => a.id);
    if (!showTaskCard || !taskTargetAgentId) return ids;
    const targetParent = parentOf.get(taskTargetAgentId) ?? null;
    if (!targetParent || !ids.includes(targetParent)) return ids;
    const index = ids.indexOf(taskTargetAgentId);
    if (index < 0) return ids;
    ids.splice(index, 0, TASK_LIST_NODE_ID);
    return ids;
  }, [displayAgents, showTaskCard, taskTargetAgentId, parentOf]);
  const layoutParentOf = useMemo(() => {
    if (!showTaskCard || !taskTargetAgentId) return parentOf;
    const map = new Map(parentOf);
    map.set(TASK_LIST_NODE_ID, parentOf.get(taskTargetAgentId) ?? null);
    return map;
  }, [parentOf, showTaskCard, taskTargetAgentId]);
  const layoutSizes = useMemo(() => {
    if (!showTaskCard) return undefined;
    return new Map([
      [
        TASK_LIST_NODE_ID,
        taskCollapsed ? { ...TASK_STUB_SIZE } : { width: cardW, height: taskListCardH },
      ],
    ]);
  }, [showTaskCard, taskCollapsed, cardW, taskListCardH]);
  // 列内置顶排序:运行中的节点排到本列最上方,完成的节点保持相对顺序不动。
  // 任务列表伪节点跟随目标节点的 rank(同 rank + 稳定排序 ⇒ 始终紧贴目标
  // 上方),不会在目标运行中被顶到列顶脱钩
  const layoutRank = useMemo(() => {
    const map = new Map<string, number>();
    for (const agent of displayAgents) {
      map.set(agent.id, statusOf(agent) === "running" ? 0 : 1);
    }
    if (showTaskCard && taskTargetAgentId && map.has(taskTargetAgentId)) {
      map.set(TASK_LIST_NODE_ID, map.get(taskTargetAgentId)!);
    }
    return map;
  }, [displayAgents, statusOf, showTaskCard, taskTargetAgentId]);
  const layoutResult: LayoutResult = useMemo(
    () =>
      computeLayout(layoutIds, layoutParentOf, cardW, taskCardH, gapCol, gapRow, layoutSizes, layoutRank),
    [layoutIds, layoutParentOf, layoutSizes, layoutRank, cardW, taskCardH, gapCol, gapRow],
  );
  // 根目标挂载带:全部布局坐标右移 taskLeftPad,挂载物恰好从 x=0 开始、
  // 右缘与主 Agent 左缘间距恒定(展开=列距,折叠=8px 视觉粘连)。
  // 挂载带内不放任何其他卡片(第 1 列左侧永远为空),无需避障。
  const taskLeftPad = useMemo(() => {
    if (!showTaskCard || !taskTargetAgentId || !taskTargetIsRoot) return 0;
    return taskCollapsed ? TASK_STUB_SIZE.width + TASK_STUB_GAP : cardW + gapCol;
  }, [showTaskCard, taskTargetAgentId, taskTargetIsRoot, taskCollapsed, cardW, gapCol]);
  // 列头带:画布顶部预留一行高度,所有布局坐标下移,列头统计(运行中 n/m)
  // 画在 y=0 的带内,不与任何卡片重叠
  const canvas: LayoutResult = useMemo(() => {
    // padX = 根目标挂载带(可为 0);padY = 列头带(恒定,画布顶行)
    const padX = taskLeftPad;
    const padY = COLUMN_HEADER_H;
    const positions = new Map<string, LayoutPosition>();
    for (const [id, p] of layoutResult.positions) positions.set(id, { x: p.x + padX, y: p.y + padY });
    const columns = layoutResult.columns.map((column) => ({ ...column, x: column.x + padX }));
    return {
      positions,
      columns,
      width: layoutResult.width + padX,
      height: layoutResult.height + padY,
    };
  }, [layoutResult, taskLeftPad]);
  // 任务列表挂载槽位:根目标锚定画布最左侧(预留带右缘与主 Agent 左缘间距
  // 恒定:展开 gapCol、折叠 TASK_STUB_GAP,不随其他卡片位置漂移;整树坐标
  // 已右移 taskLeftPad,挂载物 x 恒为 0);非根目标消费伪节点布局槽位
  // (同列、目标正上方,布局保证无重叠)。null = 不显示
  const taskMountRect = useMemo(() => {
    if (!showTaskCard || !taskTargetAgentId) return null;
    const plan = canvas.positions.get(taskTargetAgentId);
    if (!plan) return null;
    if (taskTargetIsRoot) {
      if (taskCollapsed) {
        // 折叠态:贴主 Agent 左缘 8px,垂直居中于主 Agent 卡片
        return {
          x: plan.x - TASK_STUB_GAP - TASK_STUB_SIZE.width,
          y: plan.y + (taskCardH - TASK_STUB_SIZE.height) / 2,
          ...TASK_STUB_SIZE,
        };
      }
      return { x: plan.x - gapCol - cardW, y: plan.y, width: cardW, height: taskListCardH };
    }
    const slot = canvas.positions.get(TASK_LIST_NODE_ID);
    if (!slot) return null;
    return {
      x: slot.x,
      y: slot.y,
      width: taskCollapsed ? TASK_STUB_SIZE.width : cardW,
      height: taskCollapsed ? TASK_STUB_SIZE.height : taskListCardH,
    };
  }, [showTaskCard, taskTargetAgentId, taskTargetIsRoot, canvas, taskCollapsed, cardW, taskListCardH, gapCol, taskCardH]);

  // 同父多条边:子卡片按 y(再按 id)稳定排序,在父卡片右缘高度内留边距
  // 分配唯一出线点(单 child 居中),各边从右缘不同高度独立发出不重叠;
  // 竖直段在列间通道内按边分配车道(laneXs),同父的扇形边不共线。
  // 每条边做避障规划(障碍=除两端卡片外的全部卡片),直连碰撞时绕行。
  const edges = useMemo(() => {
    const cardH = layout.compact ? CARD_H_COMPACT : CARD_H;
    const rects: ObstacleRect[] = [];
    for (const agent of displayAgents) {
      const position = canvas.positions.get(agent.id);
      if (position) rects.push({ id: agent.id, x: position.x, y: position.y, width: cardW, height: cardH });
    }
    if (taskMountRect) {
      // 任务列表卡片参与其他连线的避障,但自己的虚线单独绘制、不计入 degraded
      rects.push({
        id: TASK_LIST_NODE_ID,
        x: taskMountRect.x,
        y: taskMountRect.y,
        width: taskMountRect.width,
        height: taskMountRect.height,
      });
    }
    const byParent = new Map<string, { id: string; y: number }[]>();
    for (const agent of displayAgents) {
      const parent = metas.get(agent.id)?.parentId;
      if (!parent) continue;
      const parentPos = canvas.positions.get(parent);
      const childPos = canvas.positions.get(agent.id);
      if (!parentPos || !childPos) continue;
      const list = byParent.get(parent);
      if (list) list.push({ id: agent.id, y: childPos.y });
      else byParent.set(parent, [{ id: agent.id, y: childPos.y }]);
    }
    const list: { fromId: string; toId: string; sampled: SampledPath; direct: boolean; degraded: boolean }[] = [];
    for (const [parentId, children] of byParent) {
      const parentPos = canvas.positions.get(parentId);
      if (!parentPos) continue;
      children.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
      const exitOffsets = assignExitOffsets(cardH, children.length, EDGE_EXIT_MARGIN);
      // 车道分配:列间通道宽度内均匀分布(左右各收 4px),单 child 居中
      const laneUsable = Math.max(gapCol - 8, 8);
      const laneOffsets = assignExitOffsets(laneUsable, children.length, 4);
      const parentRight = parentPos.x + cardW;
      children.forEach((child, index) => {
        const childPos = canvas.positions.get(child.id);
        if (!childPos) return;
        const from = { x: parentRight, y: parentPos.y + (exitOffsets[index] ?? cardH / 2) };
        const to = { x: childPos.x, y: childPos.y + cardH / 2 };
        const laneX = parentRight + 4 + (laneOffsets[index] ?? laneUsable / 2);
        // 两端卡片必须排除:端点位于卡片边界上,膨胀后必相交
        const obstacles = rects.filter((rect) => rect.id !== parentId && rect.id !== child.id);
        const planned = planEdgePath(from, to, obstacles, { laneXs: [laneX] });
        list.push({
          fromId: parentId,
          toId: child.id,
          sampled: planned.sampled,
          direct: planned.direct,
          degraded: planned.degraded,
        });
      });
    }
    return list;
  }, [displayAgents, metas, canvas, cardW, layout.compact, taskMountRect, gapCol]);

  // 主 Agent → 任务列表:灰色虚线;无流光,走 planEdgePath 避障绕行但
  // 不计入 degraded 统计(挂载线允许 degraded 直连兜底)。折叠成图标后不画线。
  // 根目标:挂载卡片在左,虚线水平进入目标左缘(预留带内无卡片,恒为直连);
  // 非根目标:挂载卡片在目标正上方,虚线从挂载卡片底缘中点进入目标顶缘
  const taskEdge = useMemo(() => {
    if (!showTaskCard || taskCollapsed || !taskTargetAgentId) return null;
    if (!taskMountRect) return null;
    const targetPos = canvas.positions.get(taskTargetAgentId);
    if (!targetPos) return null;
    const from: Point = taskTargetIsRoot
      ? {
          x: taskMountRect.x + taskMountRect.width,
          y: taskMountRect.y + taskMountRect.height / 2,
        }
      : {
          x: taskMountRect.x + taskMountRect.width / 2,
          y: taskMountRect.y + taskMountRect.height,
        };
    const to: Point = taskTargetIsRoot
      ? { x: targetPos.x, y: targetPos.y + taskCardH / 2 }
      : { x: targetPos.x + cardW / 2, y: targetPos.y };
    // 障碍 = 除 target 外全部显示卡片;两端卡片天然不在列表
    const obstacles: ObstacleRect[] = [];
    for (const agent of displayAgents) {
      const position = canvas.positions.get(agent.id);
      if (!position || agent.id === taskTargetAgentId) continue;
      obstacles.push({ id: agent.id, x: position.x, y: position.y, width: cardW, height: taskCardH });
    }
    return { sampled: planEdgePath(from, to, obstacles).sampled };
  }, [showTaskCard, taskCollapsed, taskTargetAgentId, taskTargetIsRoot, taskMountRect, canvas, cardW, taskCardH, displayAgents]);

  // 绕行路径可能越出布局包围盒:画布随之扩展,避免被 ScrollView 裁掉
  // (根目标挂载带已计入 canvas.width)
  const routeExtent = useMemo(
    () =>
      routeBounds([
        ...edges.map((edge) => edge.sampled),
        ...(taskEdge ? [taskEdge.sampled] : []),
      ]),
    [edges, taskEdge],
  );
  const canvasWidth = Math.max(canvas.width, routeExtent.maxX + 4);
  const canvasHeight = Math.max(canvas.height, routeExtent.maxY + 4);
  // 窄屏缩放(借鉴 pase-omo):内容宽超出可视宽度时整体等比缩小到恰好放下
  // (下限 MIN_CANVAS_SCALE),仍放不下再横向滚动。上下树改左右列后横向变长,
  // 缩放让浅层树在窄面板上仍一屏可见
  const canvasScale = useMemo(() => {
    const available = Math.max(measuredWidth - 24, 120);
    if (canvasWidth <= 0 || canvasWidth <= available) return 1;
    return Math.max(MIN_CANVAS_SCALE, available / canvasWidth);
  }, [canvasWidth, measuredWidth]);

  // 统计跟随显示范围:工作区视图下显示当前工作区的计数
  const stats = useMemo(() => {
    let running = 0;
    let attention = 0;
    let errors = 0;
    let archived = 0;
    for (const agent of displayAgents) {
      if (agent.archived) archived++;
      const status = statusOf(agent);
      if (!agent.archived) {
        if (status === "running") running++;
        if (status === "error") errors++;
        if (metas.get(agent.id)?.requiresAttention || agent.requiresAttention) attention++;
      }
    }
    return { running, attention, errors, archived };
  }, [displayAgents, metas, statusOf]);

  // 自动发送引擎:纯客户端编排,输入列表/目录/live 快照,发送目标只认绑定值。
  // 必须传项目级全量 agents + 全量 parentOfAll:已归档子孙会在纯函数里被剔除,
  // 但不能因为"显示已归档"开关或中间节点归档而从相关集合中消失。
  const taskAutoSendState = useTaskAutoSend({
    projectId,
    targetAgentId: taskTargetAgentId,
    targetValid: taskTargetValid,
    autoSend: taskAutoSendEnabled,
    tasks: displayTasks,
    agents,
    parentOf: parentOfAll,
    metas,
    settings: taskSettings,
    paseo,
    toast,
    markPendingSent,
    compactHoldUntil,
  });

  // 已发送任务是否仍在执行:主 Agent 与全部传递子孙(归档节点剔除后)都空闲才算
  // 回合结束。主 Agent 派发后自己先 idle、子 Agent 还在编码时任务仍显示"运行中";
  // 确认窗内任一 Agent 转 running/等权限/出错也会回到运行中。
  const taskTargetRunning = Boolean(taskTargetValid && !taskAutoSendState.allIdle);

  // —— 结算引擎:主 Agent 与全部相关 Agent 都空闲且持续 IDLE_CONFIRM_MS 才结算 ——
  // 旧实现只看主 Agent 的 running→idle 沿;主 Agent 把任务派给子 Agent 后自己先
  // 结束回合会误触发,这里改为条件判定式:只要相关集合里还有 Agent 在运行/等权限/
  // 出错或快照未就绪,确认窗就被清除;最后一个相关 Agent 结束后才重新计时。
  // 空闲判定直接复用 useTaskAutoSend 的 allIdle(同一全量 agents/parentOfAll/metas
  // 输入与 summarizeRelatedIdle 口径),避免自动发送与结算各维护一套相关集合逻辑而漂移。
  const settleReady = useMemo(() => settleReadyIds(taskTasks), [taskTasks]);
  const canSettle = Boolean(
    taskTargetValid &&
      taskTargetAgentId &&
      projectId &&
      taskSettings.status === "ready" &&
      settleReady.size > 0 &&
      taskAutoSendState.allIdle,
  );
  // 到期执行时读取最新上下文:settings/paseo/toast 变化不应重置 2 秒确认窗,
  // 但真正落盘时必须用当下文档,而不是启动计时器那次 render 的旧闭包。
  const settleContextRef = useRef({
    projectId,
    targetAgentId: taskTargetAgentId,
    settings: taskSettings,
    paseo,
    toast,
  });
  settleContextRef.current = {
    projectId,
    targetAgentId: taskTargetAgentId,
    settings: taskSettings,
    paseo,
    toast,
  };
  const canSettleRef = useRef(canSettle);
  canSettleRef.current = canSettle;
  // useRpc 返回的函数身份由宿主决定:放进 ref,避免它变化时重置确认计时器
  const readLatestRef = useRef(readLatest);
  readLatestRef.current = readLatest;

  // 异步回调校验发起时的 project/目标仍是当前值,防止切换后把旧快照写进新列表
  const resultProjectRef = useRef(projectId);
  resultProjectRef.current = projectId;
  const resultTargetRef = useRef(taskTargetAgentId);
  resultTargetRef.current = taskTargetAgentId;
  // 快照收集不并发:同一时间只允许一次在途收集
  const resultCollectRef = useRef(false);
  // 结算落盘全部重试失败时 bump:canSettle/allIdle 等依赖都没变,effect 不会自己
  // 重跑;把它纳入确认定时器 effect 依赖,强制重排定时器,下一窗重新结算
  const [settleRetryTick, setSettleRetryTick] = useState(0);

  const runSettlement = useCallback(() => {
    // 定时器到期后再确认一次:目录/任务可能在计时期间变化,cleanup 通常已清掉
    // 定时器,这里是防御性兜底,避免条件已破坏仍落盘。
    if (!canSettleRef.current) return;
    const current = settleContextRef.current;
    const {
      projectId: settleProjectId,
      targetAgentId: settleTargetAgentId,
      settings,
      paseo: settlePaseo,
      toast: settleToast,
    } = current;
    if (!settleProjectId || !settleTargetAgentId || settings.status !== "ready") return;
    const list = settings.values.lists[settleProjectId];
    if (!list) return;
    // 以最新文档重新取待结算集合:等待期间任务可能被删除/完成/重新排队
    const settledIds = settleReadyIds(list.tasks);
    if (settledIds.size === 0) return;
    const settledAtText = new Date().toISOString();
    // 待结算集合与落盘值都由 saveSettled 以"当下文档"重新推导(旧闭包值只用于
    // 结果快照的 id 范围与压缩计数估计),不再在闭包里预计算 settled 任务数组
    if (!settleSentTasks(list.tasks, settledAtText)) return;
    // 任务数档位靠这个累计值推进:必须随 settledAt 一起落盘,否则每次结算都从
    // 旧值重算,永远到不了阈值。本次结算的 id 数就是"本次完成的任务数"。
    const tasksSinceCompact = (list.tasksSinceCompact ?? 0) + settledIds.size;
    const stillCurrent = () =>
      resultProjectRef.current === settleProjectId &&
      resultTargetRef.current === settleTargetAgentId;

    // 先落盘 settledAt + 累计计数:状态机不依赖后续网络拉取,拉取失败也不影响"待验收"。
    // 保存处于"保存风暴"高发窗口(自动发送 sentAt/压缩状态/用户编辑可能同秒写同一文档),
    // 而结算定时器是一次性的:冲突后 effect 不会重排,失败即永久丢结算。
    // 因此以最新文档为底重读重试:每次都以当下文档重取待结算集合(等待期间任务
    // 可能被删除/完成/重新排队),全部失败时 bump settleRetryTick 强制重排确认定时器。
    const saveSettled = async (doc: TaskListDoc, revision: string): Promise<boolean> => {
      const targetList = doc.lists[settleProjectId];
      if (!targetList) return false;
      const retryIds = settleReadyIds(targetList.tasks);
      if (retryIds.size === 0) return true; // 已无待结算任务(等待期间被删/完成),视为成功
      const retrySettled = settleSentTasks(targetList.tasks, settledAtText);
      if (!retrySettled) return false;
      return settings.save(
        withTaskList(doc, settleProjectId, {
          ...targetList,
          tasks: retrySettled,
          tasksSinceCompact: (targetList.tasksSinceCompact ?? 0) + retryIds.size,
        }),
        revision,
      );
    };
    const settledSave = (async () => {
      for (let retry = 0; retry < 2; retry++) {
        const latest =
          retry === 0 ? { doc: settings.values, revision: settings.revision } : await readLatestRef.current();
        if (!latest || !stillCurrent()) return false;
        if (await saveSettled(latest.doc, latest.revision)) return true;
      }
      return false;
    })().then((ok) => {
      if (!ok) {
        settleToast.error(settings.saveError ?? "标记待验收失败");
        // 重排确认定时器:canSettle/allIdle 都没变,effect 不会自己重跑,不补拍就永久丢结算
        setSettleRetryTick((value) => value + 1);
      }
      return ok;
    });

    // —— 自动压缩评估:只依赖结算落盘与当前用量,与 result 快照收集互不依赖 ——
    // 放在 resultCollectRef 互斥之外,避免"快照收集在途"长期饿死压缩评估。
    // 结算沿驱动,runSettlement 本身不并发;这里不再加新锁。
    void settledSave.then((ok) => {
      // 结算没落盘时不评估:任务仍是待结算,下次结算会重新计数,避免重复累计
      if (!ok || !stillCurrent()) return;
      const metadata = metadataRef.current[settleTargetAgentId];
      // 绝对阈值只依赖 used;metadata.context 的 max 与判定无关(结构多余字段,传入无碍)
      const usage = metadata?.context ?? { used: null };
      const compactAt = Date.now();
      // 固定冷却已移除:每次结算都按规则评估;tokens 模式靠 lastCompactUsage 防重复
      if (!shouldAutoCompact({ ...list, tasksSinceCompact }, usage)) return;
      // 语义与卡片压缩按钮一致:send resolve 仅代表 daemon 受理,压缩由 provider
      // 会话异步完成。压缩指令会让主 Agent 转入 running,队列后续任务的自动发送
      // 会等它空闲后自然继续——这正是期望行为,无需额外编排。
      settlePaseo.agents
        .ref(settleTargetAgentId)
        .send("/compact", {
          activeTurnBehavior: "steer",
          messageId: `agentgraph:compact:${settleProjectId}:${compactAt}`,
        })
        .then(async () => {
          settleToast.show("已自动触发上下文压缩");
          // send resolve 只代表 daemon 受理,主 Agent 状态可能还没转 running;
          // 先立起发送屏障,避免队列任务在这段竞态窗口里被 steer 进压缩回合
          setCompactHoldUntil(Date.now() + COMPACT_BARRIER_MS);
          // 标记压缩中:主 Agent 卡片转橙色动效框,队列/连线表现与手动压缩一致
          markCompactSubmitted(settleTargetAgentId, usage.used);
          if (!stillCurrent()) return;
          const lastCompactAt = new Date(compactAt).toISOString();
          const saveCompact = async (doc: TaskListDoc, revision: string): Promise<boolean> => {
            const targetList = doc.lists[settleProjectId];
            if (!targetList) return false;
            // 两种模式触发后都清零:任务计数统一表示"上次压缩以来结算的任务数",
            // 切换档位时不会继承一个看似达到阈值的旧计数
            return settings.save(
              withTaskList(doc, settleProjectId, {
                ...targetList,
                tasksSinceCompact: 0,
                lastCompactAt,
                // 记录评估时的用量(可能为 null):tokens 模式据此识别用量未刷新的旧值
                lastCompactUsage: usage.used,
              }),
              revision,
            );
          };
          // 以最新文档为底,避免用结算前的旧 revision 回写而覆盖 settledAt
          let latest = await readLatestRef.current();
          if (!latest || !stillCurrent()) return;
          if (await saveCompact(latest.doc, latest.revision)) return;
          // 冲突恢复与 result 保存同一模式:重读最新文档,只 patch 压缩状态后重试一次
          latest = await readLatestRef.current();
          if (!latest || !stillCurrent()) return;
          await saveCompact(latest.doc, latest.revision);
        })
        .catch((error: unknown) => {
          // 失败不清计数、不写 lastCompactAt/lastCompactUsage:下一次结算会再次评估并重试。
          // 消息已受理但状态保存失败也走这里,由一次额外的重试兜底。
          settleToast.error(
            error instanceof Error ? error.message : "自动压缩触发失败",
          );
        });
    });

    // 收集进行中若又满足结算条件:允许 settledAt 先落盘,但快照收集仍不并发
    if (resultCollectRef.current) return;
    resultCollectRef.current = true;
    void (async () => {
      try {
        const payload = await settlePaseo.agents.ref(settleTargetAgentId).timeline.refetch({
          direction: "tail",
          limit: 16,
          projection: "projected",
        });
        // 过期回调:项目/目标已切换,丢弃结果(任务被删除时 applyTaskResults 返回 null)
        if (!stillCurrent()) return;
        // settledAt 上限过滤:只认结算时刻之前的 assistant 消息,新回合的不算
        const text = latestAssistantText(payload, settledAtText);
        if (!text) return;
        const result = truncateTaskResult(text);
        // 先等 settledAt 落盘,避免结果保存与结算保存争用同一个 revision
        await settledSave;
        if (!stillCurrent()) return;
        const saveResult = async (doc: TaskListDoc, revision: string): Promise<boolean> => {
          const targetList = doc.lists[settleProjectId];
          if (!targetList) return false;
          const patched = applyTaskResults(targetList.tasks, settledIds, result);
          if (!patched) return false;
          return settings.save(
            withTaskList(doc, settleProjectId, { ...targetList, tasks: patched }),
            revision,
          );
        };
        // 快照保存处于"保存风暴"高发窗口(结算/sentAt/压缩状态同秒并发,实测
        // 单次重试会撞车导致快照永久丢失):一律以最新文档为底,冲突重读重试,
        // 共两次机会。仍失败则放弃,result 留 null——详情栏显示"暂无结果输出",
        // 绝不回落读取全局最新输出,那会把别的任务的反馈错挂到本任务。
        for (let retry = 0; retry < 2; retry++) {
          if (!stillCurrent()) return;
          const latest = await readLatestRef.current();
          if (!latest) return;
          if (await saveResult(latest.doc, latest.revision)) return;
        }
      } catch {
        // 拉取失败/无输出:不保存,result 留 null,详情栏显示"暂无结果输出"
      } finally {
        resultCollectRef.current = false;
      }
    })();
  }, []);

  // 条件成立才启动 2 秒确认定时器;任一依赖变化都会先执行 cleanup,
  // 因此 agent 转 running/等权限/出错、待结算集合清空或目标失效都会立即取消。
  // 计时器只在"连续满足条件"期间存在:重渲染不会重置确认窗,条件破坏才重建。
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!canSettle) {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      return;
    }
    // 条件持续成立期间不重建计时器,保证确认窗是"连续 2 秒"
    if (settleTimerRef.current) return;
    const timer = setTimeout(() => {
      if (settleTimerRef.current !== timer) return;
      settleTimerRef.current = null;
      runSettlement();
    }, IDLE_CONFIRM_MS);
    settleTimerRef.current = timer;
    return () => {
      if (settleTimerRef.current === timer) {
        clearTimeout(timer);
        settleTimerRef.current = null;
      }
    };
  }, [canSettle, projectId, taskTargetAgentId, runSettlement, settleRetryTick]);

  // 画布挂载卡片的折叠/展开:按项目持久化到任务列表文档
  const setTaskCollapsed = useCallback(
    (collapsed: boolean) => {
      if (taskSettings.status !== "ready" || !projectId) return;
      const list = taskSettings.values.lists[projectId] ?? defaultTaskListEntry();
      void taskSettings
        .save(withTaskList(taskSettings.values, projectId, { ...list, collapsed }), taskSettings.revision)
        .then((ok) => {
          if (!ok) toast.error(taskSettings.saveError ?? "保存折叠状态失败");
        });
    },
    [taskSettings, projectId, toast],
  );

  // 显示范围切换:立即生效(override),并尽力持久化为默认值;持久化失败不阻断本次切换
  const toggleDisplayScope = useCallback(() => {
    const next = displayScope === "project" ? "workspace" : "project";
    setScopeOverride(next);
    if (settings.status === "ready") {
      void settings
        .save({ ...settings.values, displayScope: next }, settings.revision)
        .then((ok) => {
          if (!ok) toast.error(settings.saveError ?? "保存显示范围失败(本次会话内仍生效)");
        });
    }
  }, [displayScope, settings, toast]);

  // 记住最近一次画布选中的 agent:首次打开任务列表时优先绑定它
  const lastFocusedAgentRef = useRef<string | null>(null);
  useEffect(() => {
    if (bottomView.kind === "agent") lastFocusedAgentRef.current = bottomView.agentId;
  }, [bottomView]);

  // 首次打开任务列表:按设计默认绑定主 Agent(选中卡片 → workspace 唯一根 → 最早未归档)
  const taskBindLockRef = useRef(false);
  const taskBindTriedRef = useRef(false);
  const taskBindProjectRef = useRef<string | null>(null);
  const openingTaskList = bottomView.kind === "tasks" || bottomView.kind === "task-detail";
  useEffect(() => {
    if (!openingTaskList) {
      // 关闭列表后重置:下次打开允许重新尝试默认绑定
      taskBindTriedRef.current = false;
      taskBindProjectRef.current = null;
      return;
    }
    if (!projectId || taskSettings.status !== "ready") return;
    if (taskBindProjectRef.current !== projectId) {
      taskBindProjectRef.current = projectId;
      taskBindTriedRef.current = false;
    }
    if (taskSettings.values.lists[projectId]) return;
    if (taskBindTriedRef.current || taskBindLockRef.current) return;
    taskBindTriedRef.current = true;
    taskBindLockRef.current = true;
    const targetAgentId = pickDefaultTaskTarget({
      agents,
      parentOf,
      workspaceId,
      preferredAgentId: lastFocusedAgentRef.current,
    });
    const nextDoc = withTaskList(taskSettings.values, projectId, {
      ...defaultTaskListEntry(),
      targetAgentId,
    });
    void taskSettings.save(nextDoc, taskSettings.revision).then((ok) => {
      taskBindLockRef.current = false;
      if (!ok) toast.error(taskSettings.saveError ?? "初始化任务列表失败,请重试");
    });
  }, [
    openingTaskList,
    projectId,
    taskSettings,
    agents,
    parentOf,
    workspaceId,
    toast,
  ]);

  // 诊断:把面板内部状态回传到 server 日志,便于远程排查
  const reportRef = useRef(useRpc(debugReportRpc));
  reportRef.current = useRpc(debugReportRpc);
  useEffect(() => {
    const payload = JSON.stringify({
      entryVersion: "workspace-factory-v3",
      workspaceId,
      platform: layout.platform,
      compact: layout.compact,
      panelWidth: measuredWidth,
      panelWidthReported: panelWidth,
      windowWidth: windowDims.width,
      rowWidth: canvas.width,
      ready,
      error,
      projectId,
      projectName,
      workspaces: workspaces.length,
      agents: agents.length,
      visible: visible.length,
      metas: metas.size,
      canvasW: canvas.width,
      canvasH: canvas.height,
      positions: canvas.positions.size,
      edges: edges.length,
      edgesRouted: edges.filter((edge) => !edge.direct).length,
      // 非零即异常:该边穿卡,必须排查(所有绕行策略失败的兜底直连)
      edgesDegraded: edges.filter((edge) => edge.degraded).length,
      parents: Object.fromEntries(visible.map((agent) => [agent.title ?? agent.id.slice(0, 8), parentOf.get(agent.id) ?? null])),
      coords: Object.fromEntries(visible.map((agent) => {
        const p = canvas.positions.get(agent.id);
        return [agent.title ?? agent.id.slice(0, 8), p ? `${Math.round(p.x)},${Math.round(p.y)}` : "none"];
      })),
    });
    const timer = setTimeout(() => void reportRef.current({ payload }), 1500);
    return () => clearTimeout(timer);
  }, [workspaceId, layout.platform, layout.compact, measuredWidth, panelWidth, windowDims.width, ready, error, projectId, projectName, workspaces.length, agents.length, visible.length, metas, canvas, edges.length]);

  const openAgent = useCallback(
    (agentId: string) => {
      navigation?.openAgent({ agentId, serverId: host.id });
    },
    [navigation, host.id],
  );

  // 创建模式:底部渲染新建表单而非会话控制台。
  // 创建目标必须是父 agent 所属 workspace,绝不回落到面板当前 workspace
  const createParentId = bottomView.kind === "create" ? bottomView.parentId : null;
  const createParent = createParentId
    ? agents.find((agent) => agent.id === createParentId)
    : undefined;
  const createWorkspaceId = creationTargetWorkspaceId(createParent);

  const handleStop = useCallback(
    async (agentId: string) => {
      try {
        const result = await cancelAgent({ agentId });
        if (result.ok) toast.show("已请求停止");
        else toast.error(result.error ?? "停止失败");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "停止失败");
      }
    },
    [cancelAgent, toast],
  );

  // 归档确认弹窗:点击卡片归档先弹窗(统一确认);确认时取 fresh snapshot 复查,
  // 防止弹窗期间状态变化;取消零操作,确认期间锁定按钮与弹窗
  const [archiveTarget, setArchiveTarget] = useState<{
    agentId: string;
    title: string;
    childFinished: boolean;
  } | null>(null);
  const [archiving, setArchiving] = useState(false);
  // 归档同步锁:await 前置位、finally 释放;同帧双击/并行触发在此拦截
  // (archiving state 有渲染延迟,不能作唯一防线),requestArchive 与取消/关闭同样尊重
  const archivingLockRef = useRef(false);

  const requestArchive = useCallback(
    (agentId: string) => {
      if (archiving || archivingLockRef.current) return;
      const dirAgent = agents.find((candidate) => candidate.id === agentId);
      if (!dirAgent || dirAgent.archived) return;
      const meta = metas.get(agentId) ?? null;
      const policy = archivePolicy({
        archived: dirAgent.archived,
        status: meta?.status ?? dirAgent.status,
        requiresAttention: meta?.requiresAttention ?? dirAgent.requiresAttention,
        attentionReason: meta?.attentionReason ?? null,
        // meta 缺 parentId(卡片的 live 快照未就绪)时为 null,保守按主Agent
        parentAgentId: meta?.parentId ?? null,
      });
      // 卡片按钮本应禁用;兜底零操作
      if (!policy.canArchive) return;
      setArchiveTarget({
        agentId,
        title: dirAgent.title ?? "未命名 Agent",
        childFinished: policy.requiresConfirm,
      });
    },
    [archiving, agents, metas],
  );

  const confirmArchive = useCallback(async () => {
    const target = archiveTarget;
    if (!target || archivingLockRef.current) return;
    archivingLockRef.current = true;
    setArchiving(true);
    try {
      // fresh snapshot 复查:弹窗期间可能开始运行/进入权限等待/被归档
      const refetched = await paseo.agents.ref(target.agentId).refresh();
      const fresh = refetched?.agent ?? null;
      const verdict = freshArchiveVerdict(
        fresh
          ? {
              archivedAt: fresh.archivedAt,
              status: fresh.status,
              requiresAttention: fresh.requiresAttention,
              attentionReason: fresh.attentionReason,
              // 协议快照无官方 parentAgentId 字段,可靠 label 兜底
              parentLabel: fresh.labels[PARENT_AGENT_ID_LABEL] ?? null,
            }
          : null,
      );
      if (verdict !== "allow") {
        toast.error("状态已变化,已取消归档");
        setArchiveTarget(null);
        return;
      }
      await paseo.agents.ref(target.agentId).archive();
      toast.show("已归档(归档后不能从面板恢复)");
      setArchiveTarget(null);
    } catch (err) {
      // 失败可恢复:弹窗保留,可直接重试或取消
      toast.error(err instanceof Error ? `归档失败:${err.message}` : "归档失败");
    } finally {
      archivingLockRef.current = false;
      setArchiving(false);
    }
  }, [archiveTarget, paseo, toast]);

  // 取消/关闭:零副作用;同步锁持有期间不允许关闭,避免归档请求在途时弹窗被拆
  const cancelArchive = useCallback(() => {
    if (archivingLockRef.current) return;
    setArchiveTarget(null);
  }, []);

  // —— 空闲档位自动归档(shared/idle-fade)——
  // 设置中开启 autoArchive 的档位生效后,空闲时长命中该档且归档策略允许的
  // 画布 agent 会被自动归档(与手动归档同一套 fresh 复查路径)。
  // 已尝试过的 agent 不再重试(归档失败/状态变化都静默放弃),避免每分钟 RPC 骚扰。
  const autoArchiveTriedRef = useRef<Set<string>>(new Set());
  const autoArchiveCheck = useCallback(() => {
    const tiers = settingsValues?.idleFadeTiers;
    if (!tiers?.some((tier) => tier.autoArchive)) return;
    const now = Date.now();
    for (const agent of displayAgents) {
      if (agent.archived || autoArchiveTriedRef.current.has(agent.id)) continue;
      // 任务列表主 Agent 承担自动发送与结算,被自动归档会打断流程,明确豁免
      if (agent.id === taskTargetAgentId) continue;
      const meta = metas.get(agent.id) ?? null;
      const idleMs = idleMsSince(meta?.lastActivityAt, now);
      if (idleMs === null) continue;
      const tier = resolveIdleTier(tiers, idleMs);
      if (!tier?.autoArchive) continue;
      const policy = archivePolicy({
        archived: agent.archived,
        status: meta?.status ?? agent.status,
        requiresAttention: meta?.requiresAttention ?? agent.requiresAttention,
        attentionReason: meta?.attentionReason ?? null,
        // meta 缺 parentId(快照未就绪)时为 null,保守按主Agent
        parentAgentId: meta?.parentId ?? null,
      });
      if (!policy.canArchive) continue;
      autoArchiveTriedRef.current.add(agent.id);
      void (async () => {
        try {
          // fresh snapshot 复查:评估与执行之间状态可能变化(开始运行/进入权限等待)
          const refetched = await paseo.agents.ref(agent.id).refresh();
          const fresh = refetched?.agent ?? null;
          const verdict = freshArchiveVerdict(
            fresh
              ? {
                  archivedAt: fresh.archivedAt,
                  status: fresh.status,
                  requiresAttention: fresh.requiresAttention,
                  attentionReason: fresh.attentionReason,
                  parentLabel: fresh.labels[PARENT_AGENT_ID_LABEL] ?? null,
                }
              : null,
          );
          if (verdict !== "allow") {
            // 状态变化不算失败:从已尝试集合移除,agent 再次满足条件时可重新评估
            autoArchiveTriedRef.current.delete(agent.id);
            return;
          }
          await paseo.agents.ref(agent.id).archive();
          toast.show(
            `已自动归档「${agent.title ?? "未命名 Agent"}」(空闲超过 ${tier.afterMinutes} 分钟)`,
          );
        } catch {
          // 自动归档失败保持静默且不再重试(tried 集合已登记),避免每分钟重试
        }
      })();
    }
  }, [displayAgents, metas, paseo, settingsValues, taskTargetAgentId, toast]);

  useEffect(() => {
    // 设置/画布变化时立即评估一次,之后每分钟 tick(档位边界最长 1 分钟内生效)
    autoArchiveCheck();
    const timer = setInterval(autoArchiveCheck, 60_000);
    return () => clearInterval(timer);
  }, [autoArchiveCheck]);

  // 右键/长按卡片复制 Agent ID:copyText 为宿主官方 API,失败明确报错
  const handleCopyId = useCallback(
    async (agentId: string) => {
      try {
        await copyText(agentId);
        toast.show(`已复制 Agent ID:${agentId}`);
      } catch (error) {
        toast.error(error instanceof Error ? `复制失败:${error.message}` : "复制失败");
      }
    },
    [toast],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.surface0,
        },
        header: {
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          paddingHorizontal: layout.compact ? 10 : 14,
          paddingTop: 10,
          paddingBottom: 6,
        },
        chip: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 999,
          backgroundColor: theme.colors.surface1,
        },
        chipText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        chipDot: { width: 6, height: 6, borderRadius: 3 },
        spacer: { flex: 1 },
        archivedToggle: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: layout.compact ? 10 : 3,
          minHeight: layout.compact ? 44 : undefined,
          borderRadius: 999,
          backgroundColor: showArchived ? theme.colors.surface2 : theme.colors.surface1,
        },
        archivedToggleText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        scrollOuter: { flex: 1 },
        scrollInner: { flex: 1 },
        canvasInner: { position: "relative" },
        edgeLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
        cardLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
        cardSlot: { position: "absolute" },
        columnHeader: {
          position: "absolute",
          top: 0,
          height: COLUMN_HEADER_H,
          fontSize: 10,
          lineHeight: 13,
        },
        placeholder: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 10,
        },
        placeholderText: { color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" },
        retryButton: {
          paddingHorizontal: 16,
          paddingVertical: 7,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        retryText: { color: theme.colors.foreground, fontSize: 12 },
        // header 是 flexWrap 行,占满一整行落到第二行显示
        scopeHint: {
          flexBasis: "100%",
          color: theme.colors.foregroundMuted,
          fontSize: 10,
        },
        confirmText: {
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 18,
        },
        confirmActions: {
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 14,
        },
        confirmButton: {
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        // 顶栏/弹窗按钮统一的悬停/按下反馈:透明度下压,对静态/选中/主色底都成立
        buttonHover: { opacity: 0.8 },
        confirmButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        confirmPrimary: { backgroundColor: theme.colors.accent },
        confirmPrimaryText: { color: theme.colors.accentForeground, fontSize: 12 },
      }),
    [theme, layout.compact, showArchived],
  );

  const renderTaskConsole = (taskView: TaskListConsoleView) => (
    <TaskListConsole
      projectId={projectId ?? ""}
      settings={taskSettings}
      tasks={displayTasks}
      targetAgentId={taskTargetAgentId}
      targetValid={taskTargetValid}
      autoSend={taskAutoSendEnabled}
      markPendingSent={markPendingSent}
      discardPendingSent={discardPendingSent}
      agents={agents}
      workspaces={workspaces}
      relatedAllIdle={taskAutoSendState.allIdle}
      relatedBusyCount={taskAutoSendState.busyCount}
      relatedCount={taskAutoSendState.relatedCount}
      autoSendPhase={taskAutoSendState.phase}
      targetRunning={taskTargetRunning}
      runningColor={statusColors.running}
      view={taskView}
      theme={theme}
      compact={layout.compact}
      onClose={() => setBottomView({ kind: "none" })}
      onOpenTask={(taskId) => setBottomView({ kind: "task-detail", taskId })}
      onBackToList={() => setBottomView({ kind: "tasks" })}
    />
  );

  if (view === "templates") {
    return (
      <TemplatesView
        workspaceId={workspaceId}
        theme={theme}
        compact={layout.compact}
        onBack={() => setView("graph")}
        openAgent={openAgent}
      />
    );
  }

  // 窄屏进入会话/创建/任务视图后使用整块可用区域，返回时目录与图布局仍保留。
  if (layout.compact && bottomView.kind !== "none") {
    return (
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {bottomView.kind === "create" ? (
          createParent && createWorkspaceId ? (
            <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
              <CreateAgentPanel
                parentAgentId={createParent.id}
                parentProvider={createParent.provider}
                parentModel={createParent.model ?? undefined}
                workspaceId={createWorkspaceId}
                theme={theme}
                compact
                onDone={(newAgentId) => setBottomView({ kind: "agent", agentId: newAgentId })}
                onCancel={() => setBottomView({ kind: "none" })}
              />
            </ScrollView>
          ) : (
            <View style={styles.placeholder}>
              <Text style={styles.placeholderText}>父 Agent 已不存在,无法创建子 Agent。</Text>
              <FeedbackPressable
                style={styles.retryButton}
                hoverStyle={styles.buttonHover}
                onPress={() => setBottomView({ kind: "none" })}
                accessibilityRole="button"
                accessibilityLabel="返回节点图"
              >
                <Text style={styles.retryText}>返回</Text>
              </FeedbackPressable>
            </View>
          )
        ) : bottomView.kind === "agent" ? (
          <AgentConsole
            agentId={bottomView.agentId}
            theme={theme}
            compact
            onCollapse={() => setBottomView({ kind: "none" })}
          />
        ) : bottomView.kind === "tasks" ? (
          renderTaskConsole({ kind: "tasks" })
        ) : (
          renderTaskConsole({ kind: "task-detail", taskId: bottomView.taskId })
        )}
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        {projectName ? (
          <View style={styles.chip}>
            <View style={[styles.chipDot, { backgroundColor: theme.colors.accent }]} />
            <Text style={styles.chipText} numberOfLines={1}>
              项目 {truncateWorkspaceLabel(projectName, 24)}
            </Text>
          </View>
        ) : null}
        <View style={styles.chip}>
          <View style={[styles.chipDot, { backgroundColor: theme.colors.statusSuccess }]} />
          <Text style={styles.chipText}>运行 {stats.running}</Text>
        </View>
        {stats.attention > 0 ? (
          <View style={styles.chip}>
            <View style={[styles.chipDot, { backgroundColor: theme.colors.statusDanger }]} />
            <Text style={styles.chipText}>关注 {stats.attention}</Text>
          </View>
        ) : null}
        {stats.errors > 0 ? (
          <View style={styles.chip}>
            <View style={[styles.chipDot, { backgroundColor: theme.colors.statusWarning }]} />
            <Text style={styles.chipText}>出错 {stats.errors}</Text>
          </View>
        ) : null}
        <View style={styles.chip}>
          <View style={[styles.chipDot, { backgroundColor: theme.colors.foregroundMuted }]} />
          <Text style={styles.chipText}>归档 {stats.archived}</Text>
        </View>
        <View style={styles.spacer} />
        <FeedbackPressable
          style={styles.archivedToggle}
          hoverStyle={styles.buttonHover}
          onPress={toggleDisplayScope}
          accessibilityRole="button"
          accessibilityLabel={`切换显示范围(当前${displayScope === "project" ? "项目" : "工作区"})`}
        >
          <Icon
            name={displayScope === "project" ? "Network" : "Boxes"}
            size={12}
            color={theme.colors.foregroundMuted}
          />
          <Text style={styles.archivedToggleText}>
            {displayScope === "project" ? "范围:项目" : "范围:工作区"}
          </Text>
        </FeedbackPressable>
        <FeedbackPressable
          style={styles.archivedToggle}
          hoverStyle={styles.buttonHover}
          onPress={() => {
            if (!projectId) {
              toast.error("项目尚未解析完成,暂不能打开任务列表");
              return;
            }
            setBottomView({ kind: "tasks" });
          }}
          accessibilityRole="button"
          accessibilityLabel="打开任务列表"
        >
          <Icon name="ListTodo" size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.archivedToggleText}>任务列表</Text>
        </FeedbackPressable>
        <FeedbackPressable
          style={styles.archivedToggle}
          hoverStyle={styles.buttonHover}
          onPress={() => setView("templates")}
          accessibilityRole="button"
          accessibilityLabel="打开节点模板"
        >
          <Icon name="LayoutTemplate" size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.archivedToggleText}>节点模板</Text>
        </FeedbackPressable>
        <FeedbackPressable
          style={styles.archivedToggle}
          hoverStyle={styles.buttonHover}
          onPress={() => setArchivedOverride(!showArchived)}
          accessibilityRole="switch"
          accessibilityState={{ checked: showArchived }}
        >
          <Icon name={showArchived ? "Eye" : "EyeOff"} size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.archivedToggleText}>已归档</Text>
        </FeedbackPressable>
        {projectName ? (
          <Text style={styles.scopeHint}>
            {displayScope === "project"
              ? "项目总览:展示项目内全部工作区的 agent;节点模板与导入仍只针对当前工作区。"
              : "工作区视图:仅显示当前工作区的 agent;自动发送与换绑候选仍覆盖整个项目。"}
          </Text>
        ) : null}
      </View>

      {error ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>订阅 agent 目录失败:{error}</Text>
          <FeedbackPressable
            style={styles.retryButton}
            hoverStyle={styles.buttonHover}
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="重试订阅"
          >
            <Text style={styles.retryText}>重试</Text>
          </FeedbackPressable>
        </View>
      ) : !ready ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>正在加载项目 agent 目录…</Text>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>当前项目还没有 agent</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollOuter}
          contentContainerStyle={{ flexGrow: 1 }}
          onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
        >
          <ScrollView
            horizontal
            style={styles.scrollInner}
            contentContainerStyle={{ flexGrow: 1, minHeight: "100%" }}
          >
            <View
              style={{
                // 缩放容器:外壳按缩放后尺寸占位(ScrollView 按它滚动/居中),
                // 内层画布保持原始尺寸,transform 缩放围绕中心进行后用平移
                // 补偿回左上角(p' = s·p,平移量 = -中心 × (1-s))
                width: Math.max(canvasWidth * canvasScale, 1),
                height: Math.max(canvasHeight * canvasScale, 1),
                marginHorizontal: "auto",
                marginVertical: "auto",
              }}
            >
            <View
              style={[
                styles.canvasInner,
                {
                  width: Math.max(canvasWidth, 1),
                  height: Math.max(canvasHeight, 1),
                  transform: [
                    { translateX: (-canvasWidth * (1 - canvasScale)) / 2 },
                    { translateY: (-canvasHeight * (1 - canvasScale)) / 2 },
                    { scale: canvasScale },
                  ],
                },
              ]}
            >
              {/* 画布空白层:点击清空选中;光标显式 auto(默认箭头,RN CursorValue 无
                  "default",auto 即未指定时的浏览器默认),避免 Pressable 让全面板继承 pointer */}
              <Pressable
                style={[StyleSheet.absoluteFill, { cursor: "auto" }]}
                onPress={() => setBottomView({ kind: "none" })}
                accessibilityLabel="取消选中"
              />
              {/* 列头统计:每列顶部显示"运行中 n/m"(n=该列运行中,m=该列全部节点) */}
              {canvas.columns.map((column, index) => {
                let running = 0;
                let total = 0;
                for (const id of column.ids) {
                  const agent = agentById.get(id);
                  if (!agent) continue;
                  total++;
                  if (statusOf(agent) === "running") running++;
                }
                if (total === 0) return null;
                return (
                  <Text
                    key={`col-head:${index}`}
                    style={[
                      styles.columnHeader,
                      {
                        left: column.x,
                        width: column.width,
                        color: running > 0 ? statusColors.running : theme.colors.foregroundMuted,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {`运行中 ${running}/${total}`}
                  </Text>
                );
              })}
              <View style={styles.edgeLayer} pointerEvents="none">
                {/* 主 Agent → 任务列表:灰色虚线,无流光,不进入 edges 避障统计 */}
                {taskEdge ? (
                  <GraphEdgeLine
                    sampled={taskEdge.sampled}
                    color={theme.colors.border}
                    dim={Boolean(taskTargetAgent?.archived)}
                    dashed
                  />
                ) : null}
                {edges.map((edge) => {
                  const fromAgent = agentById.get(edge.fromId);
                  const toAgent = agentById.get(edge.toId);
                  if (!fromAgent || !toAgent) return null;
                  // 边色跟随子 Agent 状态(依赖由源完成而满足,语义与 pase-omo 一致):
                  // 子运行中 → 运行色;子出错 → 错误色;子已跑过且空闲 → 完成色;
                  // 其余(未开工/初始化)→ 主题边框色
                  const toStatus = statusOf(toAgent);
                  const hasRun = metas.get(edge.toId)?.lastActivityAt != null;
                  const color =
                    toStatus === "running"
                      ? statusColors.running
                      : toStatus === "error"
                        ? statusColors.failed
                        : toStatus === "idle" && hasRun
                          ? statusColors.done
                          : theme.colors.border;
                  const dim = fromAgent.archived || toAgent.archived;
                  return (
                    <GraphEdgeLine
                      key={`line:${edge.fromId}->${edge.toId}`}
                      sampled={edge.sampled}
                      color={color}
                      dim={dim}
                    />
                  );
                })}
                {/* 第二遍:流点后绘,避免被其他静态线覆盖 */}
                {edges.map((edge) => {
                  const fromAgent = agentById.get(edge.fromId);
                  const toAgent = agentById.get(edge.toId);
                  if (!fromAgent || !toAgent) return null;
                  // 子 Agent 运行中即挂流点(父派发后自身先结束回合,工作仍在向右流动)
                  if (statusOf(toAgent) !== "running") {
                    return null;
                  }
                  // 压缩中的连线不挂流点:压缩是上下文维护,不是流向子 Agent 的新工作
                  if (compactSince[edge.fromId] !== undefined || compactSince[edge.toId] !== undefined) {
                    return null;
                  }
                  return (
                    <GraphEdgeFlow
                      key={`flow:${edge.fromId}->${edge.toId}`}
                      sampled={edge.sampled}
                      runningColor={statusColors.running}
                    />
                  );
                })}
              </View>
            <View style={styles.cardLayer} pointerEvents="box-none">
              {displayAgents.map((agent) => {
                const position = canvas.positions.get(agent.id);
                if (!position) return null;
                return (
                  <View
                    key={agent.id}
                    style={[
                      styles.cardSlot,
                      {
                        left: position.x,
                        top: position.y,
                        width: cardW,
                        height: layout.compact ? CARD_H_COMPACT : CARD_H,
                      },
                    ]}
                  >
                    <AgentCard
                      agentId={agent.id}
                      compact={layout.compact}
                      fallbackTitle={agent.title}
                      fallbackProvider={agent.provider}
                      fallbackModel={agent.model}
                      archived={agent.archived}
                      directoryStatus={agent.status}
                      directoryAttention={agent.requiresAttention}
                      metadata={metadataItems[agent.id] ?? null}
                      modelLabels={modelLabelsByProvider.get(agent.provider) ?? null}
                      idleTiers={idleTiers}
                      workspaceLabel={badgeFor(agent)}
                      selected={bottomView.kind === "agent" && bottomView.agentId === agent.id}
                      dimmed={relatedNodes !== null && !relatedNodes.has(agent.id)}
                      onHoverChange={handleCardHover}
                      canOpenAgent={Boolean(navigation)}
                      enableLongPressCopy={layout.platform !== "web"}
                      statusColors={statusColors}
                      theme={theme}
                      compacting={compactSince[agent.id] !== undefined}
                      onCompactSubmitted={markCompactSubmitted}
                      onPress={() =>
                        setBottomView((current) =>
                          current.kind === "agent" && current.agentId === agent.id
                            ? { kind: "none" }
                            : { kind: "agent", agentId: agent.id },
                        )
                      }
                      onCopyId={() => void handleCopyId(agent.id)}
                      onMeta={handleMeta}
                      onOpenAgent={() => openAgent(agent.id)}
                      onCreateChild={() => setBottomView({ kind: "create", parentId: agent.id })}
                      onStop={() => void handleStop(agent.id)}
                      onArchive={() => requestArchive(agent.id)}
                    />
                  </View>
                );
              })}
              {showTaskCard && taskList && taskMountRect ? (
                <View
                  style={[
                    styles.cardSlot,
                    {
                      left: taskMountRect.x,
                      top: taskMountRect.y,
                      width: taskMountRect.width,
                      height: taskMountRect.height,
                    },
                  ]}
                >
                  {taskCollapsed ? (
                    <AgentTaskStub
                      theme={theme}
                      pendingCount={displayTasks.filter(
                        (task) => task.selected && !task.done && task.sentAt === null,
                      ).length}
                      onExpand={() => setTaskCollapsed(false)}
                    />
                  ) : (
                    <AgentTaskCard
                      theme={theme}
                      compact={layout.compact}
                      tasks={displayTasks}
                      autoSend={taskAutoSendEnabled}
                      phase={taskAutoSendState.phase}
                      relatedCount={taskAutoSendState.relatedCount}
                      busyCount={taskAutoSendState.busyCount}
                      targetValid={taskTargetValid}
                      targetRunning={taskTargetRunning}
                      runningColor={statusColors.running}
                      onOpen={() => setBottomView({ kind: "tasks" })}
                      onOpenTask={(taskId) => setBottomView({ kind: "task-detail", taskId })}
                      onCollapse={() => setTaskCollapsed(true)}
                    />
                  )}
                </View>
              ) : null}
            </View>
            </View>
            </View>
          </ScrollView>
        </ScrollView>
      )}

      {bottomView.kind === "create" ? (
        createParent && createWorkspaceId ? (
          <CreateAgentPanel
            parentAgentId={createParent.id}
            parentProvider={createParent.provider}
            parentModel={createParent.model ?? undefined}
            workspaceId={createWorkspaceId}
            theme={theme}
            compact={layout.compact}
            onDone={(newAgentId) => setBottomView({ kind: "agent", agentId: newAgentId })}
            onCancel={() => setBottomView({ kind: "none" })}
          />
        ) : null
      ) : bottomView.kind === "agent" ? (
        <AgentConsole
          agentId={bottomView.agentId}
          theme={theme}
          compact={layout.compact}
          onCollapse={() => setBottomView({ kind: "none" })}
        />
      ) : bottomView.kind === "tasks" ? (
        renderTaskConsole({ kind: "tasks" })
      ) : bottomView.kind === "task-detail" ? (
        renderTaskConsole({ kind: "task-detail", taskId: bottomView.taskId })
      ) : null}

      <Modal
        title="确认归档"
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) cancelArchive();
        }}
      >
        <Modal.Content>
          <Text style={styles.confirmText}>
            {archiveTarget?.childFinished
              ? `子 Agent「${archiveTarget?.title ?? ""}」处于待验收状态,确认归档?归档后将从面板移除且不能在此恢复。`
              : `确认归档「${archiveTarget?.title ?? ""}」?归档后将从面板移除且不能在此恢复。`}
          </Text>
          <View style={styles.confirmActions}>
            <FeedbackPressable
              style={styles.confirmButton}
              hoverStyle={styles.buttonHover}
              onPress={cancelArchive}
              disabled={archiving}
              accessibilityRole="button"
              accessibilityLabel="取消归档"
            >
              <Text style={styles.confirmButtonText}>取消</Text>
            </FeedbackPressable>
            <FeedbackPressable
              style={[styles.confirmButton, styles.confirmPrimary]}
              hoverStyle={styles.buttonHover}
              onPress={() => void confirmArchive()}
              disabled={archiving}
              accessibilityRole="button"
              accessibilityLabel="确认归档"
            >
              <Text style={styles.confirmPrimaryText}>{archiving ? "归档中…" : "确认归档"}</Text>
            </FeedbackPressable>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
