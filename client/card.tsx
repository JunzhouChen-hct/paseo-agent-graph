import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { toneOf, type AgentRunStatus, type AgentTone } from "../shared/graph";
import { archivePolicy } from "../shared/archive-policy";
import type { StatusColors } from "../shared/settings";
import { DEFAULT_RUNNING_COLOR } from "../shared/settings";
import type { AgentNodeMetadata } from "../shared/agent-metadata";
import { ContextMeter } from "./context-meter";
import { FeedbackPressable } from "./feedback-pressable";

export interface CardMeta {
  parentId: string | null;
  status: AgentRunStatus | null;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
}

/**
 * 上下文占用的局部兼容类型(shared/agent-metadata.ts 归 T01 owner,其正式类型
 * 含同构 context 字段后此交集仍兼容)。undefined/null 均按未知处理,不猜测默认窗口。
 */
export interface AgentContextUsage {
  used: number | null;
  max: number | null;
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
  /** 节点元数据(思考强度/速度模式/开发分支),面板层批量拉取;无数据为 null。 */
  metadata: (AgentNodeMetadata & { context?: AgentContextUsage | null }) | null;
  /** 该 agent 所属 workspace 的显示标识(项目总览下用于区分跨工作区节点);null 不显示。 */
  workspaceLabel?: string | null;
  selected: boolean;
  canOpenAgent: boolean;
  /** 移动端长按补充复制;web 桌面用右键 */
  enableLongPressCopy: boolean;
  statusColors: StatusColors;
  theme: PluginTheme;
  onPress(): void;
  /** 右键/长按:复制 Agent ID(反馈由面板统一 toast) */
  onCopyId(): void;
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

/** 常见思考选项 id 的中文标签;未知 id 原样展示,不冒充默认值。 */
const THINKING_LABEL: Record<string, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
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

/** token 数缩写(k/M),与 console 上下文展示同一口径。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export const AgentCard = memo(function AgentCard({
  agentId,
  fallbackTitle,
  fallbackProvider,
  fallbackModel,
  archived,
  directoryStatus,
  directoryAttention,
  metadata,
  workspaceLabel,
  selected,
  canOpenAgent,
  enableLongPressCopy,
  statusColors,
  theme,
  onPress,
  onCopyId,
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
  // 归档策略(shared/archive-policy):主Agent仅完全空闲可归档;
  // 子Agent额外放开"待验收"(须弹窗确认,由面板负责)。父关系未知保守按主Agent。
  const archive = archivePolicy({
    archived,
    status,
    requiresAttention: meta.requiresAttention,
    attentionReason: meta.attentionReason,
    parentAgentId: meta.parentId,
  });
  const canArchive = archive.canArchive;
  const tone = toneOf({
    archived,
    status: meta.status ?? directoryStatus,
    requiresAttention: meta.requiresAttention,
    attentionReason: meta.attentionReason,
  });
  const toneHex = toneColor(tone, theme, statusColors);
  // 运行/待处理/出错三种状态呼吸;done/muted 静默,归档走 muted 无动效
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

  const paseo = usePaseo();
  const toast = useToast();
  const [compactPending, setCompactPending] = useState(false);
  // 提交期间的同步防连点 guard:setState 异步,连点窗口内靠 ref 拦截重复提交
  const compactInFlightRef = useRef(false);
  // 归档 agent 不可发送压缩
  const canCompact = !archived;

  /**
   * 卡片压缩按钮:仅向本卡 agent 发送 /compact(activeTurnBehavior 显式 "steer",
   * 缺省时 daemon 会打断当前回合;send resolve 即 daemon 已受理)。普通消息队列、
   * 其他会话草稿、finished 关注 ack 均不触碰;归档卡片不渲染该按钮。
   */
  const handleCompact = useCallback(() => {
    if (!canCompact || compactInFlightRef.current) return;
    compactInFlightRef.current = true;
    setCompactPending(true);
    const mid = `compact_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    void paseo.agents
      .ref(agentId)
      .send("/compact", { activeTurnBehavior: "steer", messageId: mid })
      .then(() => {
        // 只报告"已提交",不声称压缩已完成(由 provider 会话异步完成)
        toast.show("压缩命令已提交");
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "压缩命令发送失败");
      })
      .finally(() => {
        compactInFlightRef.current = false;
        setCompactPending(false);
      });
  }, [agentId, canCompact, paseo, toast]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          flex: 1,
          borderRadius: 12,
          borderWidth: selected ? 2 : 1,
          // 呼吸时本体边框透明:可见边框只有呼吸 ring 一条,选中/运行态都不再叠固定框
          borderColor: animated
            ? "transparent"
            : selected
              ? theme.colors.accent
              : theme.colors.border,
          backgroundColor: theme.colors.surface1,
          overflow: "hidden",
          // 整卡可点击(打开/收起会话),光标 pointer 仅施加在卡片本体上
          cursor: "pointer",
        },
        // 唯一的呼吸边框:3px 单环,半径按边框宽度内缩保持同心(12-3=9),
        // 内容与本体不动,只有环的透明度呼吸;归档(muted)不挂环
        pulseRing: {
          ...StyleSheet.absoluteFillObject,
          borderRadius: 9,
          borderWidth: 3,
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
        // 元数据行固定高度,内容缺失时保留占位,卡片高度不随数据抖动
        metaRow: { flexDirection: "row", alignItems: "center", gap: 4, height: 13 },
        metaText: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 13 },
        // 上下文行:环形占用 + used/max + 右端压缩按钮;文本可压缩,按钮不缩
        contextRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          height: 13,
          marginTop: 1,
        },
        contextText: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 13, flexShrink: 1 },
        compactText: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 13 },
        // 压缩按钮悬停/按下反馈
        compactHover: { backgroundColor: theme.colors.surface2, borderRadius: 4 },
        wsText: {
          flex: 1,
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          lineHeight: 13,
        },
        actions: {
          flexDirection: "row",
          // 分割线整体内缩 3px(呼吸环线宽):横线两端、竖线下端与环相接但不再叠压,
          // 底部同时让出环的走线位置,避免操作区分割线盖住呼吸框
          marginHorizontal: 3,
          marginBottom: 3,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
        },
        action: {
          flex: 1,
          alignItems: "center",
          paddingVertical: 5,
          borderRadius: 6,
        },
        // 操作按钮悬停/按下反馈:底色微抬(与卡片 surface1 同系)
        actionHover: { backgroundColor: theme.colors.surface2 },
        actionDivider: { width: 1, backgroundColor: theme.colors.border },
      }),
    [theme, selected, toneHex, animated],
  );

  const title = live?.title ?? fallbackTitle ?? "未命名 Agent";
  const model = live?.model ?? fallbackModel;
  // 元数据:思考强度(有效值优先,未知 id 原样展示)与速度模式(descriptor label)同行
  const thinkingLabel = metadata?.thinking
    ? (THINKING_LABEL[metadata.thinking.value] ?? metadata.thinking.value)
    : null;
  const speedLabel = metadata?.speed?.label ?? null;
  const metaTopText = [thinkingLabel ? `思考 ${thinkingLabel}` : null, speedLabel]
    .filter(Boolean)
    .join(" · ");
  // 上下文占用:T01 的 metadata.context;字段缺失/整体 null/两端皆未知 → 展示"上下文 —"
  const context = metadata?.context ?? null;
  const contextRatio =
    context && context.used !== null && context.max !== null && context.max > 0
      ? context.used / context.max
      : null;
  const contextText = !context
    ? "上下文 —"
    : context.used === null && context.max === null
      ? "上下文 —"
      : `${context.used !== null ? formatTokens(context.used) : "—"} / ${
          context.max !== null ? formatTokens(context.max) : "—"
        }`;
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
    <Pressable
      onPress={onPress}
      onLongPress={enableLongPressCopy ? onCopyId : undefined}
      // 桌面右键:RN PointerEvent 继承 MouseEvent.button,2=右键;
      // 阻断冒泡避免触发选中/打开;右键不产生 click,onPress 不会被触发
      onPointerDown={(event) => {
        if (event.nativeEvent.button === 2) {
          event.stopPropagation();
          onCopyId();
        }
      }}
      style={[styles.card, { opacity }]}
      accessibilityRole="button"
    >
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
          {workspaceLabel ? (
            <Text style={styles.wsText} numberOfLines={1} ellipsizeMode="tail">
              · {workspaceLabel}
            </Text>
          ) : null}
        </View>
        <View style={styles.metaRow}>
          {metaTopText ? (
            <Text style={styles.metaText} numberOfLines={1}>
              {metaTopText}
            </Text>
          ) : null}
        </View>
        <View style={styles.metaRow}>
          {metadata?.branch ? (
            <>
              <Icon name="GitBranch" size={11} color={theme.colors.foregroundMuted} />
              <Text style={styles.metaText} numberOfLines={1}>
                {metadata.branch}
              </Text>
            </>
          ) : null}
        </View>
        <View style={styles.contextRow}>
          {contextRatio !== null ? (
            <ContextMeter
              ratio={contextRatio}
              trackColor={theme.colors.border}
              progressColor={contextRatio > 0.85 ? theme.colors.statusDanger : theme.colors.accent}
              size={11}
              thickness={2}
            />
          ) : null}
          <Text style={styles.contextText} numberOfLines={1} ellipsizeMode="tail">
            {contextText}
          </Text>
          {/* 归档不可发送压缩;onPress 阻断冒泡,避免触发卡片选中/收起内置会话,
              也不顺带 ack finished 关注;提交期间禁用,连点由 ref guard 同步拦截 */}
          {canCompact ? (
            <FeedbackPressable
              hoverStyle={styles.compactHover}
              onPress={(event) => {
                event.stopPropagation();
                handleCompact();
              }}
              disabled={compactPending}
              hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
              accessibilityRole="button"
              accessibilityLabel="压缩上下文"
            >
              <Text style={styles.compactText}>{compactPending ? "提交中" : "压缩"}</Text>
            </FeedbackPressable>
          ) : null}
        </View>
      </View>
      <View style={styles.actions}>
        {!archived ? (
          <>
            <FeedbackPressable style={styles.action} hoverStyle={styles.actionHover} onPress={onCreateChild} accessibilityLabel="新建子代理">
              <Icon name="Plus" size={14} color={theme.colors.foregroundMuted} />
            </FeedbackPressable>
            <View style={styles.actionDivider} />
          </>
        ) : null}
        {canOpenAgent ? (
          <>
            <FeedbackPressable style={styles.action} hoverStyle={styles.actionHover} onPress={onOpenAgent} accessibilityLabel="打开原 Agent 会话">
              <Icon name="ExternalLink" size={14} color={theme.colors.foregroundMuted} />
            </FeedbackPressable>
            <View style={styles.actionDivider} />
          </>
        ) : null}
        <FeedbackPressable
          style={styles.action}
          hoverStyle={styles.actionHover}
          onPress={onStop}
          disabled={tone !== "running"}
          accessibilityLabel="停止"
        >
          <Icon name="Square" size={14} color={tone === "running" ? statusColors.running : theme.colors.border} />
        </FeedbackPressable>
        <View style={styles.actionDivider} />
        <FeedbackPressable
          style={styles.action}
          hoverStyle={styles.actionHover}
          onPress={(event) => {
            // 阻断冒泡:避免触发卡片 onPress 打开内置会话——打开会话会 ack 掉
            // finished 关注,可能赶在归档确认之前把待验收清掉
            event.stopPropagation();
            onArchive();
          }}
          disabled={!canArchive}
          accessibilityLabel="归档"
        >
          <Icon name="Archive" size={14} color={canArchive ? theme.colors.foregroundMuted : theme.colors.border} />
        </FeedbackPressable>
      </View>
      {/* 呼吸环最后渲染置于内容之上:分割线/内容不会盖住环;pointerEvents none 不拦截点击 */}
      {animated && !archived ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.pulseRing, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }]}
        />
      ) : null}
    </Pressable>
  );
});
