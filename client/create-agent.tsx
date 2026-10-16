import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";

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

/** 面板底部的新建子代理表单:选提供方/模型/思考强度,可选标题与首条消息。 */
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
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<PickerRow[] | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [thinkingId, setThinkingId] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
  }, [paseo, providerId, parentModel]);

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

  const handleCreate = useCallback(async () => {
    if (!providerId || !modelId || creating) return;
    setCreating(true);
    try {
      const handle = await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider: `${providerId}/${modelId}`,
          ...(thinkingId ? { thinkingOptionId: thinkingId } : {}),
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
      setCreating(false);
    }
  }, [
    paseo,
    workspaceId,
    providerId,
    modelId,
    thinkingId,
    parentAgentId,
    title,
    prompt,
    creating,
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
      }),
    [theme, compact],
  );

  // 下拉字段:点行展开(单开),点选项收起;选项列表限高滚动
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
        <Pressable
          style={styles.pickerTrigger}
          onPress={() => setOpenKey(open ? null : key)}
          disabled={!rows || rows.length === 0}
          accessibilityLabel={`选择${label}`}
        >
          <Text
            style={[styles.pickerValue, !current ? styles.pickerPlaceholder : null]}
            numberOfLines={1}
          >
            {current?.label ?? "加载中…"}
          </Text>
          <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
        {open && rows && rows.length > 0 ? (
          <View style={styles.optionList}>
            <ScrollView style={styles.optionScroll}>
              {rows.map((row) => {
                const active = row.id === currentId;
                return (
                  <Pressable
                    key={row.id}
                    style={styles.optionRow}
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
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>
    );
  };

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
          placeholder="留空自动生成"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
      </View>
      {renderPicker(
        "provider",
        "提供方",
        providers,
        providerId,
        (id) => setProviderId(id),
      )}
      {renderPicker(
        "model",
        "模型",
        models?.map((model) => ({ id: model.id, label: model.label || model.id })) ?? null,
        modelId,
        (id) => setModelId(id),
      )}
      {thinkingRows
        ? renderPicker("thinking", "思考强度", thinkingRows, thinkingId, (id) => setThinkingId(id))
        : null}
      <View>
        <Text style={styles.fieldLabel}>首条消息</Text>
        <TextInput
          style={styles.promptInput}
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder="留空则创建后手动发送"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
      </View>
      <View style={styles.buttons}>
        <Pressable
          style={styles.createButton}
          onPress={() => void handleCreate()}
          disabled={creating || !providerId || !modelId}
          accessibilityLabel="创建子代理"
        >
          <Text style={styles.createButtonText}>{creating ? "创建中…" : "创建子代理"}</Text>
        </Pressable>
        <Pressable style={styles.cancelButton} onPress={onCancel} accessibilityLabel="取消新建">
          <Text style={styles.cancelButtonText}>取消</Text>
        </Pressable>
      </View>
    </View>
  );
}
