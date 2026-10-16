import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FeedbackPressable } from "./feedback-pressable";
import {
  pickSpeedFeature,
  speedFeatureValuesForSelection,
  speedSelectionValid,
  type SpeedFeatureDescriptor,
} from "../shared/provider-speed";

/** 下拉选项的统一形状 */
interface PickerRow {
  id: string;
  label: string;
}

interface ModelOption {
  id: string;
  label?: string;
  isDefault?: boolean;
  thinkingOptions?: { id: string; label: string; isDefault?: boolean }[] | null;
  defaultThinkingOptionId?: string | null;
}

/** 面板底部的新建子代理表单:选提供方/模型/思考强度/权限模式/速度,可选标题与首条消息。 */
export function CreateAgentPanel({
  parentAgentId,
  parentProvider,
  parentModel,
  workspaceId,
  theme,
  compact,
  onDone,
  onCancel,
}: {
  parentAgentId: string;
  /** 父 agent 的提供方/模型,作为表单默认值;取不到时表单自行拉列表兜底 */
  parentProvider?: string;
  parentModel?: string;
  workspaceId: string;
  theme: PluginTheme;
  compact: boolean;
  onDone(newAgentId: string): void;
  onCancel(): void;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  // workspace 目录是 listFeatures 草稿配置的必填项;未加载/缺失时隐藏速度选项
  const cwd = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<PickerRow[] | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [thinkingId, setThinkingId] = useState("");
  // 权限模式:null 加载中,[] 无模式(整行隐藏),"" 表示默认(不传 modeId,不自动选 bypass)
  const [modes, setModes] = useState<PickerRow[] | null>(null);
  const [modeId, setModeId] = useState("");
  // 速度 descriptor:最后确认到的能力;null 表示当前组合未确认到速度
  const [speed, setSpeed] = useState<SpeedFeatureDescriptor | null>(null);
  // 速度选择:"" 未指定,select 为 option id,toggle 为 on/off
  const [speedSelection, setSpeedSelection] = useState("");
  // 速度确认状态:pending=目录确认中;error≠null=确认失败(保留已选,阻止提交,可重试)
  const [speedPending, setSpeedPending] = useState(false);
  const [speedError, setSpeedError] = useState<string | null>(null);
  // 速度目录重试计数:自增触发 listFeatures 重新拉取
  const [speedRetryTick, setSpeedRetryTick] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 同步 inflight guard:创建期间锁全部输入,防止 form 卸载重开/连点造成重复创建
  const creatingRef = useRef(false);

  /** 同步清空 mode/速度选择:provider/model 显式切换时立即调用,不等异步目录 */
  const resetModeAndSpeed = useCallback(() => {
    setModeId("");
    setSpeed(null);
    setSpeedSelection("");
    setSpeedError(null);
  }, []);

  // mount 时拉取可用提供方,默认选父 agent 的 provider(在列表中时)
  useEffect(() => {
    let cancelled = false;
    paseo.providers
      .listAvailable()
      .then((result) => {
        if (cancelled) return;
        const options = (result.providers ?? [])
          .filter((entry) => entry.available !== false)
          .map((entry) => ({ id: entry.provider, label: entry.provider }));
        setProviders(options);
        setProviderId(
          (prev) =>
            prev ?? (parentProvider && options.some((option) => option.id === parentProvider)
              ? parentProvider
              : options[0]?.id ?? null),
        );
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, parentProvider]);

  // 提供方变化 → 拉模型列表,默认父 model(在列表中),否则 isDefault,再否则第一个
  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setModelId(null);
    setThinkingId("");
    // 切 provider 清除旧 mode/速度选择,避免把不适配的配置带过去
    resetModeAndSpeed();
    if (!providerId) return;
    paseo.providers
      .listModels(providerId)
      .then((result) => {
        if (cancelled) return;
        const selectable = (result.models ?? []).filter((model) => model.isSelectable !== false);
        setModels(selectable);
        const preferred =
          (parentModel && selectable.some((model) => model.id === parentModel)
            ? parentModel
            : undefined) ??
          selectable.find((model) => model.isDefault)?.id ??
          selectable[0]?.id ??
          null;
        setModelId(preferred);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, providerId, parentModel, resetModeAndSpeed]);

  // 提供方变化 → 拉真实模式列表(listModes);含默认选项(不传 modeId),失败时按无模式隐藏
  useEffect(() => {
    let cancelled = false;
    setModes(null);
    setModeId("");
    if (!providerId) {
      setModes([]);
      return;
    }
    paseo.providers
      .listModes(providerId)
      .then((result) => {
        if (cancelled) return;
        setModes((result.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label || mode.id })));
      })
      .catch(() => {
        if (!cancelled) setModes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, providerId]);

  const currentModel = useMemo(
    () => models?.find((model) => model.id === modelId) ?? null,
    [models, modelId],
  );

  // 思考强度选项来自所选 model;无 thinkingOptions 时整行隐藏(thinkingId 置空)
  const thinkingRows = useMemo<PickerRow[] | null>(() => {
    const options = currentModel?.thinkingOptions ?? null;
    if (!options || options.length === 0) return null;
    const rows: PickerRow[] = [{ id: "", label: "默认" }];
    for (const option of options) rows.push({ id: option.id, label: option.label || option.id });
    return rows;
  }, [currentModel]);

  useEffect(() => {
    const options = currentModel?.thinkingOptions ?? [];
    if (options.length === 0) {
      setThinkingId("");
      return;
    }
    const defaultId =
      currentModel?.defaultThinkingOptionId &&
      options.some((option) => option.id === currentModel.defaultThinkingOptionId)
        ? currentModel.defaultThinkingOptionId
        : options.find((option) => option.isDefault)?.id;
    setThinkingId(defaultId ?? "");
  }, [currentModel]);

  // provider/model/mode/思考强度变化 → 拉真实特性目录(listFeatures 需 provider/model 组合串与 cwd);
  // 只挑速度 descriptor。已选速度在确认期间保留;确认失败不算"无能力",保留选择并阻止提交。
  // 新请求发出时旧响应由 cancelled 丢弃,descriptor/选择只归属当前目录组合。
  useEffect(() => {
    let cancelled = false;
    if (!providerId || !modelId || !cwd) {
      // 组合不完整:没有可归属的速度目录,清空 descriptor 与选择
      setSpeed(null);
      setSpeedSelection("");
      setSpeedPending(false);
      setSpeedError(null);
      return;
    }
    setSpeedPending(true);
    setSpeedError(null);
    paseo.providers
      .listFeatures({
        provider: `${providerId}/${modelId}`,
        cwd,
        ...(modeId ? { modeId } : {}),
        ...(thinkingId ? { thinkingOptionId: thinkingId } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        const found = pickSpeedFeature(result.features ?? []);
        setSpeed(found);
        setSpeedPending(false);
        // 权威目录结果:已选项不再受支持时清除,受支持则保留
        setSpeedSelection((prev) => (found && speedSelectionValid(found, prev) ? prev : ""));
      })
      .catch((err) => {
        if (cancelled) return;
        // 拉取失败 ≠ 无能力:descriptor 与已选速度保留,标记错误,提交被阻止直到重试成功或用户重置
        setSpeedPending(false);
        setSpeedError(err instanceof Error ? err.message : "速度特性目录拉取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, providerId, modelId, modeId, thinkingId, cwd, speedRetryTick]);

  // 已选速度未确认(确认中/确认失败)期间阻止创建,避免静默丢 featureValues
  const speedBlocked = speedSelection !== "" && (speedPending || speedError !== null);

  // 速度选择 → featureValues(仅显式选择且 descriptor 已确认时组装)
  const speedValues = useMemo(
    () => (speed && speedSelection ? speedFeatureValuesForSelection(speed, speedSelection) : null),
    [speed, speedSelection],
  );

  const handleCreate = useCallback(async () => {
    if (!providerId || !modelId || creatingRef.current || speedBlocked) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const handle = await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: `${providerId}/${modelId}`,
          ...(thinkingId ? { thinkingOptionId: thinkingId } : {}),
          // 权限模式:仅显式选择时传 modeId(默认不传,由 daemon/提供方按默认行为处理)
          ...(modeId ? { modeId } : {}),
          ...(speedValues ? { featureValues: speedValues } : {}),
        },
        parent: parentAgentId,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      toast.show("已创建子代理");
      onDone(handle.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [
    paseo,
    workspaceId,
    providerId,
    modelId,
    thinkingId,
    modeId,
    speedValues,
    speedBlocked,
    parentAgentId,
    title,
    prompt,
    toast,
    onDone,
  ]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          paddingHorizontal: compact ? 10 : 14,
          paddingVertical: 8,
          gap: 6,
        },
        header: { flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 2 },
        headerTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 },
        fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", marginBottom: 3 },
        input: {
          backgroundColor: theme.colors.surface2,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          color: theme.colors.foreground,
          fontSize: 12,
        },
        promptInput: {
          backgroundColor: theme.colors.surface2,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          color: theme.colors.foreground,
          fontSize: 12,
          minHeight: 56,
          maxHeight: 120,
          textAlignVertical: "top",
        },
        pickerTrigger: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: theme.colors.surface2,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
        },
        pickerValue: { flex: 1, color: theme.colors.foreground, fontSize: 12 },
        pickerPlaceholder: { color: theme.colors.foregroundMuted },
        optionList: {
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
          marginTop: 2,
          overflow: "hidden",
        },
        optionScroll: { maxHeight: 180 },
        optionRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        optionText: { flex: 1, color: theme.colors.foreground, fontSize: 12 },
        optionTextActive: { fontWeight: "700" },
        blockText: { color: theme.colors.statusWarning, fontSize: 11, lineHeight: 15 },
        retryButton: {
          alignSelf: "flex-start",
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        retryButtonText: { color: theme.colors.foreground, fontSize: 11 },
        buttons: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
        createButton: {
          flex: 1,
          backgroundColor: theme.colors.accent,
          borderRadius: 8,
          alignItems: "center",
          paddingVertical: 9,
        },
        createButtonText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" },
        cancelButton: {
          paddingHorizontal: 14,
          paddingVertical: 9,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          alignItems: "center",
        },
        cancelButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        // 悬停/按下统一反馈:透明度下压,对各类底色成立
        buttonHover: { opacity: 0.8 },
      }),
    [theme, compact],
  );

  // 下拉字段:点行展开(单开),点选项收起;选项列表限高滚动;创建期间整体锁定
  const renderPicker = (
    key: string,
    label: string,
    rows: PickerRow[] | null,
    currentId: string | null,
    onPick: (id: string) => void,
  ) => {
    const open = openKey === key;
    const current = rows?.find((row) => row.id === currentId);
    return (
      <View key={key}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <FeedbackPressable
          style={styles.pickerTrigger}
          hoverStyle={styles.buttonHover}
          onPress={() => setOpenKey(open ? null : key)}
          disabled={creating || !rows || rows.length === 0}
          accessibilityLabel={`选择${label}`}
        >
          <Text
            style={[styles.pickerValue, !current ? styles.pickerPlaceholder : null]}
            numberOfLines={1}
          >
            {current?.label ?? "加载中…"}
          </Text>
          <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} />
        </FeedbackPressable>
        {open && rows && rows.length > 0 ? (
          <View style={styles.optionList}>
            <ScrollView style={styles.optionScroll}>
              {rows.map((row) => {
                const active = row.id === currentId;
                return (
                  <FeedbackPressable
                    key={row.id}
                    style={styles.optionRow}
                    hoverStyle={styles.buttonHover}
                    onPress={() => {
                      setOpenKey(null);
                      onPick(row.id);
                    }}
                  >
                    <Text
                      style={[styles.optionText, active ? styles.optionTextActive : null]}
                      numberOfLines={1}
                    >
                      {row.label}
                    </Text>
                    {active ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
                  </FeedbackPressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>
    );
  };

  // 速度行选项:select 列出真实 options,toggle 为 默认/开启/关闭 三态(false 是显式值)
  const speedRows: PickerRow[] | null = speed
    ? speed.type === "toggle"
      ? [
          { id: "", label: "默认(不指定)" },
          { id: "on", label: "开启" },
          { id: "off", label: "关闭" },
        ]
      : [
          { id: "", label: "默认(不指定)" },
          ...(speed.options ?? []).map((option) => ({ id: option.id, label: option.label })),
        ]
    : null;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Icon name="Plus" size={13} color={theme.colors.foregroundMuted} />
        <Text style={styles.headerTitle}>新建子代理</Text>
      </View>
      <View>
        <Text style={styles.fieldLabel}>标题</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          editable={!creating}
          placeholder="留空自动生成"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
      </View>
      {renderPicker(
        "provider",
        "提供方",
        providers,
        providerId,
        (id) => {
          if (id === providerId) return;
          // 显式切 provider:同步清空旧 model/mode/速度,杜绝 providerB+modelA 混搭提交
          setProviderId(id);
          setModels(null);
          setModelId(null);
          setThinkingId("");
          resetModeAndSpeed();
        },
      )}
      {renderPicker(
        "model",
        "模型",
        models?.map((model) => ({ id: model.id, label: model.label || model.id })) ?? null,
        modelId,
        (id) => {
          if (id === modelId) return;
          // 显式切模型:同步清除旧 mode/速度选择,防止异步目录返回前误用旧值
          setModelId(id);
          resetModeAndSpeed();
        },
      )}
      {modes && modes.length > 0
        ? renderPicker(
            "mode",
            "权限模式",
            [{ id: "", label: "默认(不指定)" }, ...modes],
            modeId,
            (id) => setModeId(id),
          )
        : null}
      {thinkingRows
        ? renderPicker("thinking", "思考强度", thinkingRows, thinkingId, (id) => setThinkingId(id))
        : null}
      {speed
        ? renderPicker(
            "speed",
            speed.label || "速度",
            speedRows,
            speedSelection,
            (id) => setSpeedSelection(id),
          )
        : null}
      {speedBlocked ? (
        <Text style={styles.blockText}>
          {speedPending
            ? "速度特性确认中,已选速度将保留;确认完成前暂不能创建"
            : `速度特性目录拉取失败(${speedError ?? "未知错误"});已选速度已保留,可重试,或改选"默认(不指定)"后创建`}
        </Text>
      ) : null}
      {speedError && speedSelection !== "" ? (
        <FeedbackPressable
          style={styles.retryButton}
          hoverStyle={styles.buttonHover}
          onPress={() => setSpeedRetryTick((tick) => tick + 1)}
          accessibilityLabel="重试速度确认"
        >
          <Text style={styles.retryButtonText}>重试速度确认</Text>
        </FeedbackPressable>
      ) : null}
      <View>
        <Text style={styles.fieldLabel}>首条消息</Text>
        <TextInput
          style={styles.promptInput}
          value={prompt}
          onChangeText={setPrompt}
          editable={!creating}
          multiline
          placeholder="留空则创建后手动发送"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
      </View>
      <View style={styles.buttons}>
        <FeedbackPressable
          style={styles.createButton}
          hoverStyle={styles.buttonHover}
          onPress={() => void handleCreate()}
          disabled={creating || speedBlocked || !providerId || !modelId}
          accessibilityLabel="创建子代理"
        >
          <Text style={styles.createButtonText}>{creating ? "创建中…" : "创建子代理"}</Text>
        </FeedbackPressable>
        <FeedbackPressable
          style={styles.cancelButton}
          hoverStyle={styles.buttonHover}
          onPress={onCancel}
          disabled={creating}
          accessibilityLabel="取消新建"
        >
          <Text style={styles.cancelButtonText}>{creating ? "创建中…" : "取消"}</Text>
        </FeedbackPressable>
      </View>
    </View>
  );
}
