import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { useAgent } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { toneOf, type AgentRunStatus, type AgentTone } from "../shared/graph";
import type { StatusColors } from "../shared/settings";
import { DEFAULT_RUNNING_COLOR } from "../shared/settings";

export interface CardMeta {
  parentId: string | null;
  status: AgentRunStatus | null;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
}

export interface AgentCardProps {
  agentId: string;
  /** 目录层数据,useAgent 不可用时的兜底显示。 */
  fallbackTitle: string | null;
  fallbackProvider: string;
  fallbackModel: string | null;
  archived: boolean;
  directoryStatus: AgentRunStatus;
  directoryAttention: boolean;
  selected: boolean;
  canOpenAgent: boolean;
  statusColors: StatusColors;
  theme: PluginTheme;
  onPress(): void;
  onMeta(agentId: string, meta: CardMeta): void;
  onOpenAgent(): void;
  onCreateChild(): void;
  onStop(): void;
  onArchive(): void;
}

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  initializing: "启动中",
  idle: "空闲",
  running: "运行中",
  error: "出错",
  closed: "已关闭",
};

function toneColor(tone: AgentTone, theme: PluginTheme, colors: StatusColors): string {
  switch (tone) {
    case "running":
      return colors.running;
    case "done":
      return colors.done;
    case "attention":
      return colors.attention;
    case "failed":
      return colors.failed;
    default:
      return theme.colors.foregroundMuted;
  }
}

export const AgentCard = memo(function AgentCard({
  agentId,
  fallbackTitle,
  fallbackProvider,
  fallbackModel,
  archived,
  directoryStatus,
  directoryAttention,
  selected,
  canOpenAgent,
  statusColors,
  theme,
  onPress,
  onMeta,
  onOpenAgent,
  onCreateChild,
  onStop,
  onArchive,
}: AgentCardProps) {
  // 目录条目里没有 parentAgentId,只有完整快照(useAgent)里有。
  const live = useAgent(agentId, (agent) => ({
    parentId: agent.parentAgentId,
    status: agent.status,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
    title: agent.title,
    model: agent.model,
  }));

  const meta: CardMeta = {
    parentId: live?.parentId ?? null,
    status: live?.status ?? null,
    requiresAttention: live?.requiresAttention ?? directoryAttention,
    attentionReason: live?.attentionReason ?? null,
  };

  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;
  const metaKey = `${meta.parentId ?? ""}|${meta.status ?? ""}|${meta.requiresAttention ? 1 : 0}|${meta.attentionReason ?? ""}`;
  useEffect(() => {
    onMetaRef.current(agentId, meta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, metaKey]);

  const status: AgentRunStatus = meta.status ?? directoryStatus;
  // 归档不可逆,仅在完全空闲(非归档、无关注事项)时允许
  const canArchive = !archived && status === "idle" && !meta.requiresAttention;
  const tone = toneOf({
    archived,
    status: meta.status ?? directoryStatus,
    requiresAttention: meta.requiresAttention,
    attentionReason: meta.attentionReason,
  });
  const toneHex = toneColor(tone, theme, statusColors);
  // 运行/待处理/出错三种状态显示状态色边框并呼吸;done/muted 静默,归档走 muted 无动效
  const animated = tone === "running" || tone === "attention" || tone === "failed";

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!animated) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1000,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, pulse]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          flex: 1,
          borderRadius: 12,
          borderWidth: selected ? 2 : 1,
          borderColor: animated
            ? toneHex
            : selected
              ? theme.colors.accent
              : theme.colors.border,
          backgroundColor: theme.colors.surface1,
          overflow: "hidden",
        },
        pulseRing: {
          ...StyleSheet.absoluteFillObject,
          borderRadius: 12,
          borderWidth: 2,
          borderColor: toneHex,
        },
        body: {
          paddingHorizontal: 10,
          paddingTop: 8,
          paddingBottom: 6,
          gap: 3,
        },
        title: {
          color: theme.colors.foreground,
          fontSize: 13,
          fontWeight: "600",
          lineHeight: 17,
        },
        subtitle: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 14,
        },
        statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
        statusDot: { width: 7, height: 7, borderRadius: 4 },
        statusText: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 13 },
        actions: {
          flexDirection: "row",
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
        },
        action: {
          flex: 1,
          alignItems: "center",
          paddingVertical: 5,
        },
        actionDivider: { width: 1, backgroundColor: theme.colors.border },
      }),
    [theme, selected, toneHex, animated],
  );

  const title = live?.title ?? fallbackTitle ?? "未命名 Agent";
  const model = live?.model ?? fallbackModel;
  const opacity = archived ? 0.4 : 1;
  const statusLabel = archived
    ? "已归档"
    : tone === "attention"
      ? meta.attentionReason === "permission"
        ? "待确认"
        : meta.attentionReason === "finished"
          ? "待验收"
          : "待处理"
      : STATUS_LABEL[status] ?? status;

  return (
    <Pressable onPress={onPress} style={[styles.card, { opacity }]} accessibilityRole="button">
      {animated && !archived ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.pulseRing, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.75] }) }]}
        />
      ) : null}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {fallbackProvider}
          {model ? ` · ${model}` : ""}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: toneHex }]} />
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        {!archived ? (
          <>
            <Pressable style={styles.action} onPress={onCreateChild} accessibilityLabel="新建子代理">
              <Icon name="Plus" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
            <View style={styles.actionDivider} />
          </>
        ) : null}
        {canOpenAgent ? (
          <>
            <Pressable style={styles.action} onPress={onOpenAgent} accessibilityLabel="打开原 Agent 会话">
              <Icon name="ExternalLink" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
            <View style={styles.actionDivider} />
          </>
        ) : null}
        <Pressable style={styles.action} onPress={onStop} disabled={tone !== "running"} accessibilityLabel="停止">
          <Icon name="Square" size={14} color={tone === "running" ? statusColors.running : theme.colors.border} />
        </Pressable>
        <View style={styles.actionDivider} />
        <Pressable style={styles.action} onPress={onArchive} disabled={!canArchive} accessibilityLabel="归档">
          <Icon name="Archive" size={14} color={canArchive ? theme.colors.foregroundMuted : theme.colors.border} />
        </Pressable>
      </View>
    </Pressable>
  );
});
