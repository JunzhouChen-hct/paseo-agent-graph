import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAgent, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { configureAgentRpc } from "../shared/graph";
import { agentGraphSettings } from "../shared/settings";
import { useAgentTimeline, type AgentExtras, type TimelineView } from "./timeline";
import { canReadClipboardImage, readClipboardImage, type ClipboardImage } from "./web";

interface PickerRequest {
  title: string;
  options: { id: string; label: string }[];
  currentId: string | null;
  onPick(id: string): void;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** 发送行为的说明保留在此:优先读用户配置(shared/settings),缺省 steer 与原生一致。
 *  daemon 配置目前未暴露该行为字段;若未来版本加入,可改为读取 daemon config。 */

/** 本地排队的消息:steer 后在回合结束前不会进入 timeline,先以"排队中"样式显示;
 *  queue 模式下攒在本地(sent:false)等回合结束补发。 */
interface PendingMessage {
  mid: string;
  text: string;
  /** 是否已发送到 daemon(queue 模式攒在本地待补发时为 false) */
  sent: boolean;
  images?: { data: string; mimeType: string }[];
}

// —— 轻量 Markdown 渲染:粗体 / 行内码 / 代码块 / 标题 / 列表 ——

interface InlineSegment {
  text: string;
  bold?: boolean;
  code?: boolean;
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: text.slice(last, index) });
    const token = match[0];
    if (token.startsWith("**")) segments.push({ text: token.slice(2, -2), bold: true });
    else segments.push({ text: token.slice(1, -1), code: true });
    last = index + token.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

function InlineRuns({ text }: { text: string }) {
  const segments = useMemo(() => parseInline(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.bold ? (
          <Text key={index} style={{ fontWeight: "700" }}>
            {segment.text}
          </Text>
        ) : segment.code ? (
          <Text key={index} style={{ fontFamily: "monospace" }}>
            {segment.text}
          </Text>
        ) : (
          <Text key={index}>{segment.text}</Text>
        ),
      )}
    </>
  );
}

function MarkdownText({
  text,
  theme,
  baseStyle,
}: {
  text: string;
  theme: PluginTheme;
  baseStyle: { color: string; fontSize: number; lineHeight: number };
}) {
  const nodes = useMemo(() => {
    const lines = text.split("\n");
    const output: ReactNode[] = [];
    let codeBuffer: string[] | null = null;
    const flushCode = (key: string) => {
      if (codeBuffer && codeBuffer.length > 0) {
        output.push(
          <View
            key={key}
            style={{
              backgroundColor: theme.colors.surface0,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 5,
              marginVertical: 2,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: "monospace", lineHeight: 15 }}>
              {codeBuffer.join("\n")}
            </Text>
          </View>,
        );
      }
      codeBuffer = null;
    };
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith("```")) {
        if (codeBuffer) flushCode(`c${index}`);
        else codeBuffer = [];
        return;
      }
      if (codeBuffer) {
        codeBuffer.push(line);
        return;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        output.push(
          <Text
            key={`h${index}`}
            style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700", lineHeight: 18, marginTop: 2 }}
          >
            {heading[2]}
          </Text>,
        );
        return;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        output.push(
          <Text key={`l${index}`} style={baseStyle}>
            {"• "}
            <InlineRuns text={line.replace(/^\s*[-*]\s+/, "")} />
          </Text>,
        );
        return;
      }
      if (line.trim().length === 0) {
        output.push(<View key={`s${index}`} style={{ height: 4 }} />);
        return;
      }
      output.push(
        <Text key={`p${index}`} style={baseStyle}>
          <InlineRuns text={line} />
        </Text>,
      );
    });
    flushCode("cEnd");
    return output;
  }, [text, theme, baseStyle]);
  return <View>{nodes}</View>;
}

// —— 步骤折叠:连续的工具调用与推理折叠成一行摘要(仿原生会话) ——

type Block =
  | { kind: "single"; key: string; item: TimelineView }
  | { kind: "group"; key: string; steps: TimelineView[]; toolCount: number; reasoningCount: number };

function groupItems(items: TimelineView[]): Block[] {
  const blocks: Block[] = [];
  let current: { key: string; steps: TimelineView[]; toolCount: number; reasoningCount: number } | null = null;
  const flush = () => {
    if (!current || current.steps.length === 0) {
      current = null;
      return;
    }
    blocks.push({
      kind: "group",
      key: current.key,
      steps: current.steps,
      toolCount: current.toolCount,
      reasoningCount: current.reasoningCount,
    });
    current = null;
  };
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "reasoning") {
      if (!current) current = { key: item.key, steps: [], toolCount: 0, reasoningCount: 0 };
      current.steps.push(item);
      if (item.kind === "tool") current.toolCount++;
      else current.reasoningCount++;
    } else {
      flush();
      blocks.push({ kind: "single", key: item.key, item });
    }
  }
  flush();
  return blocks;
}

export function AgentConsole({
  agentId,
  theme,
  compact,
  onCollapse,
}: {
  agentId: string;
  theme: PluginTheme;
  compact: boolean;
  onCollapse(): void;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const configure = useRpc(configureAgentRpc);
  const settings = useSettings(agentGraphSettings);
  const settingsValues = settings.status === "ready" ? settings.values : null;
  const sendBehavior = settingsValues?.sendBehavior ?? "steer";
  const { items, extras, loading, error, reload } = useAgentTimeline(
    agentId,
    settingsValues?.timelineLimit ?? 60,
  );
  const agentLive = useAgent(agentId, (agent) => ({
    provider: agent.provider,
    status: agent.status,
    title: agent.title,
  }));
  const provider = agentLive?.provider;

  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ClipboardImage[]>([]);
  const [models, setModels] = useState<{ id: string; label: string }[] | null>(null);
  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingQueue, setPendingQueue] = useState<PendingMessage[]>([]);
  const logRef = useRef<ScrollView>(null);

  // 会话区高度:配置默认值即最小值,可向上拉大
  const DEFAULT_HEIGHT = Math.min(680, Math.max(200, settingsValues?.consoleHeight ?? 320));
  const MAX_HEIGHT = 680;
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const heightRef = useRef(height);
  heightRef.current = height;
  const dragRef = useRef<{ startY: number; base: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModels(null);
    if (!provider) return;
    void paseo.providers
      .listModels(provider)
      .then((result) => {
        if (cancelled) return;
        const selectable = (result.models ?? [])
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({ id: model.id, label: model.label || model.id }));
        setModels(selectable);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, provider]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => void logRef.current?.scrollToEnd({ animated: false }));
  }, []);
  useEffect(() => {
    scrollToEnd();
  }, [items.length, scrollToEnd]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text && images.length === 0) return;
    setSending(true);
    try {
      const mid = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const imagesPayload =
        images.length > 0
          ? images.map((image) => ({ data: image.data, mimeType: image.mimeType }))
          : undefined;
      const running = agentLive?.status === "running";
      // queue 模式 + 运行中:不调 send,消息连图片攒在本地,回合结束后补发
      if (running && sendBehavior === "queue") {
        setPendingQueue((current) => [
          ...current,
          { mid, text, sent: false, images: imagesPayload },
        ]);
        setDraft("");
        setImages([]);
        toast.show("已排队,回合结束后自动发送");
        return;
      }
      // 协议限制:activeTurnBehavior 只有 "steer"|"interrupt";queue 是纯客户端编排,不发给 daemon
      const options: {
        activeTurnBehavior: "steer";
        messageId: string;
        images?: { data: string; mimeType: string }[];
      } = { activeTurnBehavior: "steer", messageId: mid };
      if (imagesPayload) options.images = imagesPayload;
      await paseo.agents.ref(agentId).send(text, options);
      setDraft("");
      setImages([]);
      // steer 模式 + 运行中:消息已注入当前回合,留在本地排队展示直到 timeline 摘除
      if (sendBehavior === "steer" && running) {
        setPendingQueue((current) => [
          ...current,
          { mid, text, sent: true, images: imagesPayload },
        ]);
      }
      toast.show(sendBehavior === "steer" && running ? "已加入队列(引导当前回合)" : "已发送");
      void reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "发送失败");
    } finally {
      setSending(false);
    }
  }, [draft, images, agentId, paseo, toast, reload, agentLive?.status, sendBehavior]);

  const handleAttach = useCallback(async () => {
    const image = await readClipboardImage();
    if (!image) {
      toast.show("剪贴板里没有图片(先截图再点此按钮)");
      return;
    }
    setImages((current) => [...current, image]);
  }, [toast]);

  const applyConfig = useCallback(
    async (patch: { modelId?: string | null; modeId?: string; thinkingOptionId?: string | null }) => {
      try {
        const result = await configure({ agentId, ...patch });
        if (result.ok) toast.show("已更新");
        else toast.error(result.error ?? "设置失败");
        setTimeout(() => void reload(), 400);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "设置失败");
      }
    },
    [configure, agentId, toast, reload],
  );

  const toggleExpand = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 排队消息出现在 timeline 后(回合开始处理)摘掉本地排队标记
  useEffect(() => {
    if (pendingQueue.length === 0) return;
    const arrived = new Set(
      items.filter((item) => item.kind === "user" && item.messageId).map((item) => item.messageId),
    );
    const remaining = pendingQueue.filter((pending) => !arrived.has(pending.mid));
    if (remaining.length !== pendingQueue.length) setPendingQueue(remaining);
  }, [items, pendingQueue]);

  // daemon 会把 steer 消息立即写入 timeline,本地 pending 被摘除后消息看起来已"送达"。
  // 这里从 timeline 反推仍在排队的消息:agent 运行中时,最后一条带 messageId 的 user 消息
  // 之后(含倒数若干条连续 user 消息)没有任何处理痕迹(assistant/tool/error/reasoning)
  // 即视为排队中,复用 pendingBubble 视觉;出现处理痕迹或 agent 停止运行后恢复普通气泡。
  const queuedIds = useMemo(() => {
    const ids = new Set<string>();
    if (agentLive?.status !== "running") return ids;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "assistant" || item.kind === "tool" || item.kind === "error" || item.kind === "reasoning") {
        break;
      }
      if (item.kind === "user" && item.messageId) ids.add(item.messageId);
    }
    return ids;
  }, [items, agentLive?.status]);

  // 头部队列角标:本地 pending(未写入 timeline)+ timeline 中仍在排队的消息去重计数
  const queueCount = useMemo(() => {
    const ids = new Set(queuedIds);
    for (const pending of pendingQueue) ids.add(pending.mid);
    return ids.size;
  }, [queuedIds, pendingQueue]);

  // 回合结束(运行 → 非运行):先把 queue 模式攒下的未发送消息逐条补发,再刷新拉取对话
  const prevStatusRef = useRef(agentLive?.status);
  const flushingRef = useRef(false);
  const pendingQueueRef = useRef(pendingQueue);
  pendingQueueRef.current = pendingQueue;
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = agentLive?.status;
    if (prev !== "running" || agentLive?.status === "running") return;

    const flush = async () => {
      // 防重入:status 快速抖动时可能多次触发,补发进行中直接跳过(进行中的补发收尾会 reload)
      if (flushingRef.current) return;
      flushingRef.current = true;
      try {
        const queued = pendingQueueRef.current.filter((pending) => !pending.sent);
        for (const pending of queued) {
          try {
            await paseo.agents.ref(agentId).send(pending.text, {
              // daemon 对连续多条 steer 自己排队注入,无需客户端再编排
              activeTurnBehavior: "steer",
              messageId: pending.mid,
              images: pending.images,
            });
            setPendingQueue((current) =>
              current.map((item) => (item.mid === pending.mid ? { ...item, sent: true } : item)),
            );
          } catch (err) {
            // 补发失败保持 sent:false,等下个回合结束重试
            toast.error(err instanceof Error ? err.message : "排队消息补发失败");
          }
        }
      } finally {
        flushingRef.current = false;
      }
      void reload();
    };
    void flush();
  }, [agentLive?.status, agentId, paseo, toast, reload]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          height,
        },
        grip: {
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 5,
          cursor: "pointer",
        },
        gripBar: {
          width: 36,
          height: 4,
          borderRadius: 2,
          backgroundColor: theme.colors.border,
        },
        header: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: compact ? 10 : 14,
          paddingTop: 2,
          paddingBottom: 2,
        },
        headerTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 },
        headerButton: { padding: 4 },
        log: { flex: 1, paddingHorizontal: compact ? 10 : 14, paddingVertical: 6 },
        row: { marginBottom: 8 },
        rowUser: { alignItems: "flex-end" },
        bubble: {
          maxWidth: "88%",
          borderRadius: 10,
          paddingHorizontal: 9,
          paddingVertical: 6,
          backgroundColor: theme.colors.surface2,
        },
        text: { color: theme.colors.foreground, fontSize: 12, lineHeight: 17 },
        meta: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 },
        textError: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
        textNotice: { color: theme.colors.statusWarning, fontSize: 12, lineHeight: 17 },
        groupRow: { marginBottom: 6 },
        groupHeader: {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingVertical: 4,
        },
        groupText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
        groupBody: {
          borderLeftWidth: 2,
          borderLeftColor: theme.colors.border,
          paddingLeft: 8,
          marginBottom: 6,
          gap: 2,
        },
        queueBadge: {
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          paddingHorizontal: 7,
          paddingVertical: 2,
          borderRadius: 999,
          backgroundColor: theme.colors.surface2,
        },
        queueBadgeText: { color: theme.colors.statusWarning, fontSize: 10, fontWeight: "600" },
        pendingBubble: {
          maxWidth: "88%",
          borderRadius: 10,
          paddingHorizontal: 9,
          paddingVertical: 6,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: theme.colors.statusWarning,
          opacity: 0.85,
        },
        pendingLabel: { color: theme.colors.statusWarning, fontSize: 10, fontWeight: "600", marginBottom: 2 },
        controls: {
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          paddingHorizontal: compact ? 10 : 14,
          paddingVertical: 4,
        },
        chip: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 999,
          backgroundColor: theme.colors.surface2,
        },
        chipText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        ctxTrack: {
          width: 64,
          height: 4,
          borderRadius: 2,
          backgroundColor: theme.colors.surface0,
          overflow: "hidden",
        },
        ctxFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.accent },
        attachments: {
          flexDirection: "row",
          gap: 6,
          paddingHorizontal: compact ? 10 : 14,
          paddingBottom: 4,
        },
        attachment: { width: 40, height: 40, borderRadius: 6, overflow: "hidden" },
        composer: {
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 8,
          paddingHorizontal: compact ? 10 : 14,
          paddingVertical: 8,
        },
        input: {
          flex: 1,
          minHeight: 32,
          maxHeight: 96,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          color: theme.colors.foreground,
          paddingHorizontal: 10,
          paddingTop: 7,
          paddingBottom: 7,
          fontSize: 12,
        },
        iconButton: {
          width: 32,
          height: 32,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface2,
        },
        sendButton: {
          width: 32,
          height: 32,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.accent,
        },
        pickerRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: 9,
          paddingHorizontal: 4,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        pickerRowText: { color: theme.colors.foreground, fontSize: 13, flex: 1 },
      }),
    [theme, compact, height],
  );

  const currentThinking = extras?.thinkingOptions?.options.find(
    (option) => option.id === extras.thinkingOptionId,
  );
  const currentMode = extras?.modes.find((mode) => mode.id === extras.currentModeId);
  const contextRatio =
    extras && extras.contextUsed !== null && extras.contextMax
      ? Math.min(1, extras.contextUsed / extras.contextMax)
      : null;

  const blocks = useMemo(() => groupItems(items), [items]);

  const renderRow = (item: TimelineView) => {
    if (item.kind === "user") {
      const queued = item.messageId !== null && queuedIds.has(item.messageId);
      return (
        <View key={item.key} style={[styles.row, styles.rowUser]}>
          <View style={queued ? styles.pendingBubble : styles.bubble}>
            {queued ? <Text style={styles.pendingLabel}>排队中</Text> : null}
            <MarkdownText text={item.text} theme={theme} baseStyle={styles.text} />
          </View>
        </View>
      );
    }
    if (item.kind === "tool") {
      return (
        <Text key={item.key} style={styles.meta}>
          {`· ${item.text}${item.meta && item.meta !== "completed" ? ` (${item.meta})` : ""}`}
        </Text>
      );
    }
    if (item.kind === "reasoning") {
      return (
        <Text key={item.key} style={styles.meta}>
          {item.text}
        </Text>
      );
    }
    if (item.kind === "error") {
      return (
        <Text key={item.key} style={styles.textError}>
          {item.text}
        </Text>
      );
    }
    if (item.kind === "notice") {
      return (
        <Text key={item.key} style={styles.textNotice}>
          {item.text}
        </Text>
      );
    }
    return (
      <View key={item.key} style={styles.row}>
        <View style={styles.bubble}>
          <MarkdownText text={item.text} theme={theme} baseStyle={styles.text} />
        </View>
      </View>
    );
  };

  const renderBlock = (block: Block) => {
    if (block.kind === "single") return renderRow(block.item);
    const open = expanded.has(block.key);
    return (
      <View key={block.key} style={styles.groupRow}>
        <Pressable
          style={styles.groupHeader}
          onPress={() => toggleExpand(block.key)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.groupText}>
            {`${block.steps.length} 步`}
            {block.reasoningCount > 0 ? ` · ${block.reasoningCount} 推理` : ""}
            {block.toolCount > 0 ? ` · ${block.toolCount} 操作` : ""}
          </Text>
        </Pressable>
        {open ? <View style={styles.groupBody}>{block.steps.map(renderRow)}</View> : null}
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View
        style={styles.grip}
        accessibilityLabel="拖动调整会话区高度"
        onStartShouldSetResponder={() => true}
        onResponderGrant={(event) => {
          dragRef.current = { startY: event.nativeEvent.pageY, base: heightRef.current };
        }}
        onResponderMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const next = drag.base + (drag.startY - event.nativeEvent.pageY);
          setHeight(Math.min(MAX_HEIGHT, Math.max(DEFAULT_HEIGHT, next)));
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
      <View style={styles.header}>
        <Icon name="MessagesSquare" size={13} color={theme.colors.foregroundMuted} />
        <Text style={styles.headerTitle} numberOfLines={1}>
          {agentLive?.title || "会话"}
        </Text>
        {queueCount > 0 ? (
          <View style={styles.queueBadge}>
            <Icon name="Clock" size={11} color={theme.colors.statusWarning} />
            <Text style={styles.queueBadgeText}>{`队列 ${queueCount}`}</Text>
          </View>
        ) : null}
        <Pressable style={styles.headerButton} onPress={() => void reload()} accessibilityLabel="刷新">
          <Icon name="RotateCw" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable style={styles.headerButton} onPress={onCollapse} accessibilityLabel="收起">
          <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      <ScrollView ref={logRef} style={styles.log}>
        {loading && items.length === 0 ? (
          <Text style={styles.meta}>正在加载对话…</Text>
        ) : error ? (
          <Text style={styles.textError}>{`加载对话失败:${error}`}</Text>
        ) : blocks.length === 0 && pendingQueue.length === 0 ? (
          <Text style={styles.meta}>暂无对话记录</Text>
        ) : (
          <>
            {blocks.map(renderBlock)}
            {pendingQueue.map((pending) => (
              <View key={pending.mid} style={[styles.row, styles.rowUser]}>
                <View style={styles.pendingBubble}>
                  <Text style={styles.pendingLabel}>排队中</Text>
                  <Text style={styles.text}>{pending.text}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      <View style={styles.controls}>
        <Pressable
          style={styles.chip}
          onPress={() =>
            models && models.length > 0
              ? setPicker({
                  title: "选择模型",
                  options: models,
                  currentId: extras?.model ?? null,
                  onPick: (id) => void applyConfig({ modelId: id }),
                })
              : toast.show("模型列表不可用")
          }
        >
          <Icon name="Cpu" size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.chipText} numberOfLines={1}>
            {extras?.model ?? "模型"}
          </Text>
        </Pressable>
        {extras && extras.modes.length > 0 ? (
          <Pressable
            style={styles.chip}
            onPress={() =>
              setPicker({
                title: "权限策略 / 模式",
                options: extras.modes,
                currentId: extras.currentModeId ?? null,
                onPick: (id) => void applyConfig({ modeId: id }),
              })
            }
          >
            <Icon name="Shield" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.chipText} numberOfLines={1}>
              {currentMode?.label ?? extras.currentModeId ?? "模式"}
            </Text>
          </Pressable>
        ) : null}
        {extras?.thinkingOptions ? (
          <Pressable
            style={styles.chip}
            onPress={() =>
              setPicker({
                title: "思考强度",
                options: extras.thinkingOptions!.options,
                currentId: extras.thinkingOptionId ?? null,
                onPick: (id) => void applyConfig({ thinkingOptionId: id }),
              })
            }
          >
            <Icon name="Brain" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.chipText} numberOfLines={1}>
              {currentThinking?.label ?? "思考"}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.chip}>
          <View style={styles.ctxTrack}>
            <View style={[styles.ctxFill, { width: `${Math.round((contextRatio ?? 0) * 100)}%` }]} />
          </View>
          <Text style={styles.chipText}>
            {extras && extras.contextUsed !== null
              ? `${formatTokens(extras.contextUsed)}${extras.contextMax ? ` / ${formatTokens(extras.contextMax)}` : ""}`
              : "上下文 —"}
          </Text>
        </View>
      </View>

      {images.length > 0 ? (
        <View style={styles.attachments}>
          {images.map((image, index) => (
            <Pressable
              key={`${index}-${image.mimeType}`}
              style={styles.attachment}
              onPress={() => setImages((current) => current.filter((_, i) => i !== index))}
              accessibilityLabel="移除图片"
            >
              <Image
                source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
                style={{ flex: 1 }}
                resizeMode="cover"
              />
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.composer}>
        {canReadClipboardImage ? (
          <Pressable style={styles.iconButton} onPress={() => void handleAttach()} accessibilityLabel="插入剪贴板图片">
            <Icon name="ImagePlus" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder="发送 prompt(Enter 发送,Shift+Enter 换行)"
          placeholderTextColor={theme.colors.foregroundMuted}
          onSubmitEditing={(event) => {
            if (!(event.nativeEvent instanceof Object && (event.nativeEvent as { shiftKey?: boolean }).shiftKey)) {
              void handleSend();
            }
          }}
          blurOnSubmit={false}
        />
        <Pressable
          style={styles.sendButton}
          onPress={() => void handleSend()}
          disabled={sending}
          accessibilityLabel="发送"
        >
          <Icon name="Send" size={14} color={theme.colors.accentForeground} />
        </Pressable>
      </View>

      <Modal
        title={picker?.title ?? ""}
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
      >
        <Modal.Content>
          <ScrollView style={{ maxHeight: 340 }}>
            {(picker?.options ?? []).map((option) => {
              const active = picker?.currentId === option.id;
              return (
                <Pressable
                  key={option.id}
                  style={styles.pickerRow}
                  onPress={() => {
                    const pick = picker?.onPick;
                    setPicker(null);
                    pick?.(option.id);
                  }}
                >
                  <Text style={styles.pickerRowText}>{option.label}</Text>
                  {active ? (
                    <Icon name="Check" size={15} color={theme.colors.statusSuccess} />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Modal.Content>
      </Modal>
    </View>
  );
}
