import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { usePaseo, useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { cancelAgentRpc, debugReportRpc } from "../shared/graph";
import { agentGraphSettings, resolveColors, type StatusColors } from "../shared/settings";
import { useAgentDirectory, type DirectoryAgent } from "./directory";
import { computeLayout, type LayoutResult } from "./layout";
import { AgentCard, type CardMeta } from "./card";
import { GraphEdge } from "./edge";
import { AgentConsole } from "./console";
import { CreateAgentPanel } from "./create-agent";
import { TemplatesView } from "./templates";

const CARD_W = 196;
const CARD_W_COMPACT = 164;
const CARD_H = 92;
const CARD_H_COMPACT = 92;
const GAP_X = 26;
const GAP_Y = 58;

export function GraphPanel({ theme, layout, workspaceId, navigation, host }: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const cancelAgent = useRpc(cancelAgentRpc);
  const { agents, ready, error } = useAgentDirectory(workspaceId);

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

  const visible = useMemo(
    () => agents.filter((agent) => showArchived || !agent.archived),
    [agents, showArchived],
  );

  const parentOf = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const agent of visible) map.set(agent.id, metas.get(agent.id)?.parentId ?? null);
    return map;
  }, [visible, metas]);

  const cardW = layout.compact ? CARD_W_COMPACT : CARD_W;
  const gapX = layout.compact ? 18 : GAP_X;
  const maxRowWidth = Math.max((measuredWidth || 1200) - 24, cardW * 2 + gapX);
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

  const edges = useMemo(() => {
    const list: { fromId: string; toId: string }[] = [];
    for (const agent of visible) {
      const parent = metas.get(agent.id)?.parentId;
      if (parent && layoutResult.positions.has(parent) && layoutResult.positions.has(agent.id)) {
        list.push({ fromId: parent, toId: agent.id });
      }
    }
    return list;
  }, [visible, metas, layoutResult]);

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
      agents: agents.length,
      visible: visible.length,
      metas: metas.size,
      canvasW: layoutResult.width,
      canvasH: layoutResult.height,
      positions: layoutResult.positions.size,
      edges: edges.length,
      parents: Object.fromEntries(visible.map((agent) => [agent.title ?? agent.id.slice(0, 8), parentOf.get(agent.id) ?? null])),
      coords: Object.fromEntries(visible.map((agent) => {
        const p = layoutResult.positions.get(agent.id);
        return [agent.title ?? agent.id.slice(0, 8), p ? `${Math.round(p.x)},${Math.round(p.y)}` : "none"];
      })),
    });
    const timer = setTimeout(() => void reportRef.current({ payload }), 1500);
    return () => clearTimeout(timer);
  }, [layout.compact, measuredWidth, panelWidth, windowDims.width, maxRowWidth, ready, error, agents.length, visible.length, metas, layoutResult, edges.length]);

  const openAgent = useCallback(
    (agentId: string) => {
      navigation?.openAgent({ agentId, serverId: host.id });
    },
    [navigation, host.id],
  );

  // "create:<父agentId>" 哨兵表示创建模式,底部渲染新建表单而非会话控制台
  const createParentId = selected?.startsWith("create:") ? selected.slice("create:".length) : null;
  const createParent = createParentId
    ? agents.find((agent) => agent.id === createParentId)
    : undefined;

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

  const handleArchive = useCallback(
    async (agentId: string) => {
      try {
        await paseo.agents.ref(agentId).archive();
        toast.show("已归档(归档后不能从面板恢复)");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "归档失败");
      }
    },
    [paseo, toast],
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
          paddingVertical: 3,
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
        },
        placeholderText: { color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" },
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

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
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
        <Pressable
          style={styles.archivedToggle}
          onPress={() => setView("templates")}
          accessibilityRole="button"
          accessibilityLabel="打开节点模板"
        >
          <Icon name="LayoutTemplate" size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.archivedToggleText}>节点模板</Text>
        </Pressable>
        <Pressable
          style={styles.archivedToggle}
          onPress={() => setArchivedOverride(!showArchived)}
          accessibilityRole="switch"
          accessibilityState={{ checked: showArchived }}
        >
          <Icon name={showArchived ? "Eye" : "EyeOff"} size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.archivedToggleText}>已归档</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>订阅 agent 目录失败:{error}</Text>
        </View>
      ) : !ready ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>正在加载 agent 目录…</Text>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>当前 workspace 还没有 agent</Text>
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
                { width: Math.max(layoutResult.width, 1), height: Math.max(layoutResult.height, 1) },
              ]}
            >
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => setSelected(null)}
                accessibilityLabel="取消选中"
              />
              <View style={styles.edgeLayer} pointerEvents="none">
              {edges.map((edge) => {
                const from = layoutResult.positions.get(edge.fromId);
                const to = layoutResult.positions.get(edge.toId);
                if (!from || !to) return null;
                const fromAgent = agents.find((a) => a.id === edge.fromId);
                const toAgent = agents.find((a) => a.id === edge.toId);
                if (!fromAgent || !toAgent) return null;
                const active =
                  statusOf(fromAgent) === "running" && statusOf(toAgent) === "running";
                const dim = fromAgent.archived || toAgent.archived;
                return (
                  <GraphEdge
                    key={`${edge.fromId}->${edge.toId}`}
                    from={{ x: from.x + cardW / 2, y: from.y + (layout.compact ? CARD_H_COMPACT : CARD_H) }}
                    to={{ x: to.x + cardW / 2, y: to.y }}
                    active={active}
                    dim={dim}
                    runningColor={statusColors.running}
                    theme={theme}
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
                      fallbackTitle={agent.title}
                      fallbackProvider={agent.provider}
                      fallbackModel={agent.model}
                      archived={agent.archived}
                      directoryStatus={agent.status}
                      directoryAttention={agent.requiresAttention}
                      selected={selected === agent.id}
                      canOpenAgent={Boolean(navigation)}
                      statusColors={statusColors}
                      theme={theme}
                      onPress={() => setSelected((current) => (current === agent.id ? null : agent.id))}
                      onMeta={handleMeta}
                      onOpenAgent={() => openAgent(agent.id)}
                      onCreateChild={() => setSelected(`create:${agent.id}`)}
                      onStop={() => void handleStop(agent.id)}
                      onArchive={() => void handleArchive(agent.id)}
                    />
                  </View>
                );
              })}
            </View>
            </View>
          </ScrollView>
        </ScrollView>
      )}

      {createParentId ? (
        <CreateAgentPanel
          parentAgentId={createParentId}
          parentProvider={createParent?.provider}
          parentModel={createParent?.model ?? undefined}
          workspaceId={workspaceId}
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
    </View>
  );
}
