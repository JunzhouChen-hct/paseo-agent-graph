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
import { agentGraphSettings, resolveColors, type StatusColors } from "../shared/settings";
import {
  creationTargetWorkspaceId,
  truncateWorkspaceLabel,
  visibleAgents,
  workspaceBadgeLabel,
} from "../shared/project-scope";
import { useProjectAgentDirectory, type DirectoryAgent } from "./directory";
import { computeLayout, type LayoutResult } from "./layout";
import { AgentCard, type CardMeta } from "./card";
import { FeedbackPressable } from "./feedback-pressable";
import { GraphEdgeFlow, GraphEdgeLine } from "./edge";
import { assignExitOffsets, type Point, type SampledPath } from "../shared/edge-geometry";
import { planEdgePath, routeBounds, type ObstacleRect } from "../shared/edge-routing";
import { AgentConsole } from "./console";
import { CreateAgentPanel } from "./create-agent";
import { TemplatesView } from "./templates";
import { useAgentMetadata } from "./agent-metadata";

const CARD_W = 196;
const CARD_W_COMPACT = 164;
// 原内容 + 两行元数据(思考/速度、分支) + 一行 workspace 标识的预留余量
// + 上下文行(占用环 + used/max + 压缩按钮,约 17)
const CARD_H = 148;
const CARD_H_COMPACT = 184;
const GAP_X = 26;
const GAP_Y = 58;
// 父卡片底部两侧各留的边距:多条边在该范围内分配唯一出线点
const EDGE_EXIT_MARGIN = 24;

export function GraphPanel({ theme, layout, workspaceId, navigation, host }: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const cancelAgent = useRpc(cancelAgentRpc);
  // 展示范围 = 当前 project 的全部 workspace;project 未知前两路订阅都不启动
  const { projectId, agents, workspaces, projectName, ready, error, retry } =
    useProjectAgentDirectory(workspaceId);

  const [metas, setMetas] = useState<Map<string, CardMeta>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
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
  const settingsValues = settings.status === "ready" ? settings.values : null;
  // 配置的"默认隐藏归档"作为初始值;用户在面板里手动切换后以面板开关为准
  const showArchived = archivedOverride ?? !(settingsValues?.hideArchivedByDefault ?? true);
  const statusColors: StatusColors = resolveColors(
    settingsValues ?? { runningColor: "", doneColor: "", attentionColor: "", failedColor: "" },
    theme.colors,
  );

  const handleMeta = useCallback((agentId: string, meta: CardMeta) => {
    const prev = metasRef.current.get(agentId);
    if (
      prev &&
      prev.parentId === meta.parentId &&
      prev.status === meta.status &&
      prev.requiresAttention === meta.requiresAttention
    ) {
      return;
    }
    const next = new Map(metasRef.current);
    next.set(agentId, meta);
    metasRef.current = next;
    setMetas(next);
  }, []);

  const visible = useMemo(() => visibleAgents(agents, showArchived), [agents, showArchived]);

  // 卡片工作区标识:活跃工作区用最新显示名;已归档工作区回落到目录 placement
  const wsById = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
  const badgeFor = useCallback(
    (agent: DirectoryAgent) => {
      const label = workspaceBadgeLabel(agent, wsById);
      return label ? truncateWorkspaceLabel(label) : null;
    },
    [wsById],
  );

  // 节点元数据(思考强度/速度模式/开发分支):批量 RPC + 定期轮询
  const metadataItems = useAgentMetadata(visible.map((agent) => agent.id));

  const parentOf = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const agent of visible) map.set(agent.id, metas.get(agent.id)?.parentId ?? null);
    return map;
  }, [visible, metas]);

  // 手机不强制两列；卡片略宽，底部操作按钮保留足够的触控面积。
  const cardW = layout.compact
    ? Math.min(240, Math.max(CARD_W_COMPACT, (measuredWidth || 360) - 40))
    : CARD_W;
  const gapX = layout.compact ? 18 : GAP_X;
  const maxRowWidth = Math.max((measuredWidth || 1200) - 24, layout.compact ? cardW : cardW * 2 + gapX);
  const layoutResult: LayoutResult = useMemo(
    () =>
      computeLayout(
        visible.map((a) => a.id),
        parentOf,
        cardW,
        layout.compact ? CARD_H_COMPACT : CARD_H,
        gapX,
        GAP_Y,
        maxRowWidth,
      ),
    [visible, parentOf, cardW, gapX, layout.compact, maxRowWidth],
  );

  const statusOf = useCallback(
    (agent: DirectoryAgent): string =>
      metas.get(agent.id)?.status ?? (agent.archived ? "closed" : agent.status),
    [metas],
  );

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  // 同父多条边:子卡片按 x(再按 id)稳定排序,在父卡片底部宽度内留边距
  // 分配唯一出线点(单 child 居中),各边从底部不同位置独立发出不重叠
  // 同父多条边:子卡片按 x(再按 id)稳定排序,在父卡片底部宽度内留边距
  // 分配唯一出线点(单 child 居中),各边从底部不同位置独立发出不重叠。
  // 每条边做避障规划(障碍=除两端卡片外的全部卡片),直连碰撞时绕行。
  const edges = useMemo(() => {
    const cardH = layout.compact ? CARD_H_COMPACT : CARD_H;
    const rects: ObstacleRect[] = [];
    for (const agent of visible) {
      const position = layoutResult.positions.get(agent.id);
      if (position) rects.push({ id: agent.id, x: position.x, y: position.y, width: cardW, height: cardH });
    }
    const byParent = new Map<string, { id: string; x: number }[]>();
    for (const agent of visible) {
      const parent = metas.get(agent.id)?.parentId;
      if (!parent) continue;
      const parentPos = layoutResult.positions.get(parent);
      const childPos = layoutResult.positions.get(agent.id);
      if (!parentPos || !childPos) continue;
      const list = byParent.get(parent);
      if (list) list.push({ id: agent.id, x: childPos.x });
      else byParent.set(parent, [{ id: agent.id, x: childPos.x }]);
    }
    const list: { fromId: string; toId: string; sampled: SampledPath; direct: boolean; degraded: boolean }[] = [];
    for (const [parentId, children] of byParent) {
      const parentPos = layoutResult.positions.get(parentId);
      if (!parentPos) continue;
      children.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
      const offsets = assignExitOffsets(cardW, children.length, EDGE_EXIT_MARGIN);
      const parentBottom = parentPos.y + cardH;
      children.forEach((child, index) => {
        const childPos = layoutResult.positions.get(child.id);
        if (!childPos) return;
        const from = { x: parentPos.x + (offsets[index] ?? cardW / 2), y: parentBottom };
        const to = { x: childPos.x + cardW / 2, y: childPos.y };
        // 两端卡片必须排除:端点位于卡片边界上,膨胀后必相交
        const obstacles = rects.filter((rect) => rect.id !== parentId && rect.id !== child.id);
        const planned = planEdgePath(from, to, obstacles);
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
  }, [visible, metas, layoutResult, cardW, layout.compact]);

  // 绕行路径可能越出布局包围盒:画布随之扩展,避免被 ScrollView 裁掉
  const routeExtent = useMemo(
    () => routeBounds(edges.map((edge) => edge.sampled)),
    [edges],
  );
  const canvasWidth = Math.max(layoutResult.width, routeExtent.maxX + 4);
  const canvasHeight = Math.max(layoutResult.height, routeExtent.maxY + 4);

  const stats = useMemo(() => {
    let running = 0;
    let attention = 0;
    let errors = 0;
    let archived = 0;
    for (const agent of agents) {
      if (agent.archived) archived++;
      const status = statusOf(agent);
      if (!agent.archived) {
        if (status === "running") running++;
        if (status === "error") errors++;
        if (metas.get(agent.id)?.requiresAttention || agent.requiresAttention) attention++;
      }
    }
    return { running, attention, errors, archived };
  }, [agents, metas, statusOf]);

  // 诊断:把面板内部状态回传到 server 日志,便于远程排查
  const reportRef = useRef(useRpc(debugReportRpc));
  reportRef.current = useRpc(debugReportRpc);
  useEffect(() => {
    const payload = JSON.stringify({
      compact: layout.compact,
      panelWidth: measuredWidth,
      panelWidthReported: panelWidth,
      windowWidth: windowDims.width,
      rowWidth: maxRowWidth,
      ready,
      error,
      projectId,
      projectName,
      workspaces: workspaces.length,
      agents: agents.length,
      visible: visible.length,
      metas: metas.size,
      canvasW: layoutResult.width,
      canvasH: layoutResult.height,
      positions: layoutResult.positions.size,
      edges: edges.length,
      edgesRouted: edges.filter((edge) => !edge.direct).length,
      // 非零即异常:该边穿卡,必须排查(所有绕行策略失败的兜底直连)
      edgesDegraded: edges.filter((edge) => edge.degraded).length,
      parents: Object.fromEntries(visible.map((agent) => [agent.title ?? agent.id.slice(0, 8), parentOf.get(agent.id) ?? null])),
      coords: Object.fromEntries(visible.map((agent) => {
        const p = layoutResult.positions.get(agent.id);
        return [agent.title ?? agent.id.slice(0, 8), p ? `${Math.round(p.x)},${Math.round(p.y)}` : "none"];
      })),
    });
    const timer = setTimeout(() => void reportRef.current({ payload }), 1500);
    return () => clearTimeout(timer);
  }, [layout.compact, measuredWidth, panelWidth, windowDims.width, maxRowWidth, ready, error, projectId, projectName, workspaces.length, agents.length, visible.length, metas, layoutResult, edges.length]);

  const openAgent = useCallback(
    (agentId: string) => {
      navigation?.openAgent({ agentId, serverId: host.id });
    },
    [navigation, host.id],
  );

  // "create:<父agentId>" 哨兵表示创建模式,底部渲染新建表单而非会话控制台。
  // 创建目标必须是父 agent 所属 workspace,绝不回落到面板当前 workspace
  const createParentId = selected?.startsWith("create:") ? selected.slice("create:".length) : null;
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

  // 窄屏进入会话/创建表单后使用整块可用区域，返回时目录与图布局仍保留。
  if (layout.compact && selected) {
    return (
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {createParent && createWorkspaceId ? (
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            <CreateAgentPanel
              parentAgentId={createParent.id}
              parentProvider={createParent.provider}
              parentModel={createParent.model ?? undefined}
              workspaceId={createWorkspaceId}
              theme={theme}
              compact
              onDone={(newAgentId) => setSelected(newAgentId)}
              onCancel={() => setSelected(null)}
            />
          </ScrollView>
        ) : (
          <AgentConsole agentId={selected} theme={theme} compact onCollapse={() => setSelected(null)} />
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
            项目总览:展示项目内全部工作区的 agent;节点模板与导入仍只针对当前工作区。
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
              style={[
                styles.canvasInner,
                { marginHorizontal: "auto", marginVertical: "auto" },
                { width: Math.max(canvasWidth, 1), height: Math.max(canvasHeight, 1) },
              ]}
            >
              {/* 画布空白层:点击清空选中;光标显式 auto(默认箭头,RN CursorValue 无
                  "default",auto 即未指定时的浏览器默认),避免 Pressable 让全面板继承 pointer */}
              <Pressable
                style={[StyleSheet.absoluteFill, { cursor: "auto" }]}
                onPress={() => setSelected(null)}
                accessibilityLabel="取消选中"
              />
              <View style={styles.edgeLayer} pointerEvents="none">
                {edges.map((edge) => {
                  const fromAgent = agentById.get(edge.fromId);
                  const toAgent = agentById.get(edge.toId);
                  if (!fromAgent || !toAgent) return null;
                  const active =
                    statusOf(fromAgent) === "running" && statusOf(toAgent) === "running";
                  const dim = fromAgent.archived || toAgent.archived;
                  return (
                    <GraphEdgeLine
                      key={`line:${edge.fromId}->${edge.toId}`}
                      sampled={edge.sampled}
                      color={active ? statusColors.running : theme.colors.border}
                      dim={dim}
                    />
                  );
                })}
                {/* 第二遍:流点后绘,避免被其他静态线覆盖 */}
                {edges.map((edge) => {
                  const fromAgent = agentById.get(edge.fromId);
                  const toAgent = agentById.get(edge.toId);
                  if (!fromAgent || !toAgent) return null;
                  if (statusOf(fromAgent) !== "running" || statusOf(toAgent) !== "running") {
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
              {visible.map((agent) => {
                const position = layoutResult.positions.get(agent.id);
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
                      workspaceLabel={badgeFor(agent)}
                      selected={selected === agent.id}
                      canOpenAgent={Boolean(navigation)}
                      enableLongPressCopy={layout.platform !== "web"}
                      statusColors={statusColors}
                      theme={theme}
                      onPress={() => setSelected((current) => (current === agent.id ? null : agent.id))}
                      onCopyId={() => void handleCopyId(agent.id)}
                      onMeta={handleMeta}
                      onOpenAgent={() => openAgent(agent.id)}
                      onCreateChild={() => setSelected(`create:${agent.id}`)}
                      onStop={() => void handleStop(agent.id)}
                      onArchive={() => requestArchive(agent.id)}
                    />
                  </View>
                );
              })}
            </View>
            </View>
          </ScrollView>
        </ScrollView>
      )}

      {createParent && createWorkspaceId ? (
        <CreateAgentPanel
          parentAgentId={createParent.id}
          parentProvider={createParent.provider}
          parentModel={createParent.model ?? undefined}
          workspaceId={createWorkspaceId}
          theme={theme}
          compact={layout.compact}
          onDone={(newAgentId) => setSelected(newAgentId)}
          onCancel={() => setSelected(null)}
        />
      ) : selected ? (
        <AgentConsole
          agentId={selected}
          theme={theme}
          compact={layout.compact}
          onCollapse={() => setSelected(null)}
        />
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
