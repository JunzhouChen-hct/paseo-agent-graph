import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FeedbackPressable } from "./feedback-pressable";
import { taskDisplayStatus, type TaskAutoSendPhase, type TaskRecord } from "../shared/task-list";

/** 旋转中的 Loader 图标:任务已被发送且主 Agent 正在执行时替代勾选框(与卡片呼吸同款 Animated 方案)。 */
export function SpinIcon({ size, color }: { size: number; color: string }) {
  const rotate = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotate, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [rotate]);
  const degrees = rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate: degrees }] }}>
      <Icon name="LoaderCircle" size={size} color={color} />
    </Animated.View>
  );
}

export interface AgentTaskCardProps {
  theme: PluginTheme;
  compact?: boolean;
  tasks: readonly TaskRecord[];
  autoSend: boolean;
  phase: TaskAutoSendPhase;
  /** 相关 Agent 计数(已剔除归档),用于"等待空闲 N/M"的可观测进度 */
  relatedCount: number;
  /** 当前视为忙的相关 Agent 数 */
  busyCount: number;
  /** 主 Agent 已归档/消失:卡片仍可打开,但自动发送暂停 */
  targetValid: boolean;
  onOpen(): void;
  /** 点击某条预览 → 直接打开该任务详情 */
  onOpenTask(taskId: string): void;
  /** 折叠成主 Agent 旁的小图标(状态按项目持久化) */
  onCollapse(): void;
  /** 主 Agent 与全部相关 Agent 尚未全部空闲:已发送任务显示"运行中"与旋转图标 */
  targetRunning?: boolean;
  /** 运行中语义色(与连线/呼吸一致);缺省回落主题前景弱色 */
  runningColor?: string;
}

/** 自动发送指示灯微文案:只做状态呈现,不参与发送判定。 */
function phaseText(phase: TaskAutoSendPhase, busyCount: number, relatedCount: number): string | null {
  switch (phase) {
    case "waiting":
      // 有忙项时给出进度,让"为什么还不发"可见(典型:快照重建期状态未知);
      // 0 忙仍处于等待通常是 2 秒确认窗/重试退避,维持原文案避免噪声
      return busyCount > 0 ? `等待空闲 ${busyCount}/${relatedCount}` : "等待空闲";
    case "sending":
      return "发送中";
    case "sent":
      return "已发送";
    default:
      return null;
  }
}

/**
 * 画布上的任务列表挂载卡片:统计 + 前三条预览 + 自动发送指示灯。
 * 布局上作为主 Agent 的伪子节点(panel 的 parentOf 指向 targetAgentId),
 * 由布局引擎自动避让,因此这里只负责内容呈现。
 */
export function AgentTaskCard({
  theme,
  compact = false,
  tasks,
  autoSend,
  phase,
  relatedCount,
  busyCount,
  targetValid,
  onOpen,
  onOpenTask,
  onCollapse,
  targetRunning = false,
  runningColor,
}: AgentTaskCardProps) {
  const stats = useMemo(() => {
    let pending = 0;
    let sent = 0;
    let done = 0;
    for (const task of tasks) {
      if (task.done) done++;
      if (task.sentAt !== null && !task.done) sent++;
      if (task.selected && !task.done && task.sentAt === null) pending++;
    }
    return { pending, sent, done };
  }, [tasks]);

  // 预览只显示未完成任务(已完成自动隐藏;底部控制台仍是全量列表)
  const preview = useMemo(() => tasks.filter((task) => !task.done), [tasks]);
  const doneCount = tasks.length - preview.length;
  const microcopy = targetValid ? phaseText(phase, busyCount, relatedCount) : "已暂停";

  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          flex: 1,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          overflow: "hidden",
          cursor: "pointer",
        },
        hover: { backgroundColor: theme.colors.surface2 },
        body: {
          flex: 1,
          paddingHorizontal: 10,
          paddingTop: 8,
          paddingBottom: 6,
          gap: 3,
        },
        // 预览区可上下滚动:任务多于可视行数时在卡片内滑动查看,不截断
        previewScroll: { flex: 1, minHeight: 0 },
        previewContent: { gap: 3 },
        header: { flexDirection: "row", alignItems: "center", gap: 5 },
        title: {
          flex: 1,
          color: theme.colors.foreground,
          fontSize: 13,
          fontWeight: "600",
          lineHeight: 17,
        },
        collapseButton: {
          width: compact ? 44 : 22,
          height: compact ? 44 : 22,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        collapseHover: { backgroundColor: theme.colors.surface2 },
        zap: { flexDirection: "row", alignItems: "center", gap: 3 },
        micro: { color: theme.colors.foregroundMuted, fontSize: 9, lineHeight: 12 },
        stats: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 14 },
        previewRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          minHeight: compact ? 28 : 18,
          borderRadius: 4,
        },
        previewHover: { backgroundColor: theme.colors.surface2 },
        box: {
          width: 11,
          height: 11,
          borderRadius: 3,
          borderWidth: 1,
          borderColor: theme.colors.border,
          alignItems: "center",
          justifyContent: "center",
        },
        boxDone: {
          borderColor: theme.colors.statusSuccess,
          backgroundColor: theme.colors.statusSuccess,
        },
        boxSelected: { borderColor: theme.colors.accent },
        previewText: {
          flex: 1,
          color: theme.colors.foreground,
          fontSize: 10,
          lineHeight: 13,
        },
        previewDone: { color: theme.colors.statusSuccess },
        previewMuted: { color: theme.colors.foregroundMuted },
        empty: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 },
        warn: { color: theme.colors.statusWarning, fontSize: 10, lineHeight: 13 },
      }),
    [theme, compact],
  );

  return (
    <FeedbackPressable
      style={styles.card}
      hoverStyle={styles.hover}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel="打开任务列表"
    >
      <View style={styles.body}>
        <View style={styles.header}>
          <Icon name="ListTodo" size={13} color={theme.colors.foregroundMuted} />
          <Text style={styles.title} numberOfLines={1}>
            任务列表
          </Text>
          <FeedbackPressable
            style={styles.collapseButton}
            hoverStyle={styles.collapseHover}
            onPress={(event) => {
              // 阻断冒泡:折叠不触发卡片本身的"打开列表"
              event.stopPropagation();
              onCollapse();
            }}
            accessibilityRole="button"
            accessibilityLabel="折叠任务列表"
          >
            <Icon name="PanelRightClose" size={12} color={theme.colors.foregroundMuted} />
          </FeedbackPressable>
          <View style={styles.zap}>
            <Icon
              name="Zap"
              size={12}
              color={autoSend && targetValid ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
            />
            {microcopy ? (
              <Text style={styles.micro} numberOfLines={1}>
                {microcopy}
              </Text>
            ) : null}
          </View>
        </View>
        <Text style={styles.stats} numberOfLines={1}>
          {`待发 ${stats.pending} · 已发送 ${stats.sent} · 完成 ${stats.done}`}
        </Text>
        {targetValid ? null : <Text style={styles.warn}>主Agent 已失效,自动发送暂停</Text>}
        {preview.length === 0 ? (
          <Text style={styles.empty}>
            {tasks.length === 0 ? "主 Agent 工作时想到的任务先记在这里" : "全部完成,已隐藏"}
          </Text>
        ) : (
          <ScrollView
            style={styles.previewScroll}
            contentContainerStyle={styles.previewContent}
            nestedScrollEnabled
          >
            {preview.map((task) => (
              <FeedbackPressable
                key={task.id}
                style={styles.previewRow}
                hoverStyle={styles.previewHover}
                // 预览行本体高度受卡片高度限制,用 hitSlop 把窄屏有效触控区补到 44px
                hitSlop={compact ? { top: 8, bottom: 8, left: 2, right: 2 } : undefined}
                onPress={(event) => {
                  // 阻断冒泡:点预览直接进详情,不再叠加一次"打开列表"
                  event.stopPropagation();
                  onOpenTask(task.id);
                }}
                accessibilityRole="button"
                accessibilityLabel={`打开任务 ${task.title}`}
              >
                {/* 状态化图标:运行中=旋转执行;待验收=提醒铃;其余=勾选框 */}
                {taskDisplayStatus(task, targetRunning) === "running" ? (
                  <SpinIcon size={11} color={runningColor ?? theme.colors.foregroundMuted} />
                ) : taskDisplayStatus(task, targetRunning) === "sent" ? (
                  <Icon name="Bell" size={11} color={theme.colors.statusWarning} />
                ) : (
                  <View
                    style={[
                      styles.box,
                      task.done ? styles.boxDone : task.selected ? styles.boxSelected : null,
                    ]}
                  >
                    {task.done || task.selected ? (
                      <Icon
                        name="Check"
                        size={8}
                        color={task.done ? theme.colors.accentForeground : theme.colors.accent}
                      />
                    ) : null}
                  </View>
                )}
                <Text
                  style={[
                    styles.previewText,
                    task.done ? styles.previewDone : task.sentAt !== null ? styles.previewMuted : null,
                  ]}
                  numberOfLines={1}
                >
                  {task.title}
                </Text>
              </FeedbackPressable>
            ))}
          </ScrollView>
        )}
      </View>
    </FeedbackPressable>
  );
}

/**
 * 折叠态的任务列表挂载图标:点击展开回完整卡片;待发任务数>0 时角标提示。
 * 位置仍由 placeTaskCard 决定(小尺寸),紧贴主 Agent 右侧。
 */
export function AgentTaskStub({
  theme,
  pendingCount,
  onExpand,
}: {
  theme: PluginTheme;
  pendingCount: number;
  onExpand(): void;
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        stub: {
          width: 36,
          height: 36,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        },
        stubHover: { backgroundColor: theme.colors.surface2 },
        badge: {
          position: "absolute",
          top: -5,
          right: -5,
          minWidth: 15,
          height: 15,
          paddingHorizontal: 3,
          borderRadius: 8,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        },
        badgeText: { color: theme.colors.accentForeground, fontSize: 9, fontWeight: "700" },
      }),
    [theme],
  );
  return (
    <FeedbackPressable
      style={styles.stub}
      hoverStyle={styles.stubHover}
      onPress={onExpand}
      accessibilityRole="button"
      accessibilityLabel={`展开任务列表${pendingCount > 0 ? `,${pendingCount} 个待发送` : ""}`}
    >
      <Icon name="ListTodo" size={16} color={theme.colors.foregroundMuted} />
      {pendingCount > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{pendingCount > 99 ? "99+" : String(pendingCount)}</Text>
        </View>
      ) : null}
    </FeedbackPressable>
  );
}
