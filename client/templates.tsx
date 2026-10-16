import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { usePaseo, useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FeedbackPressable } from "./feedback-pressable";
import {
  pickSpeedFeature,
  speedSelectionValid,
  type SpeedFeatureDescriptor,
} from "../shared/provider-speed";
import {
  TEMPLATE_MAX_NODES,
  matchProjectDefault,
  newTemplateId,
  nextNodeKey,
  parentOptionsFor,
  projectDefaultKeys,
  validateTemplateNodes,
  type TemplateNodeConfig,
} from "../shared/template-model";
import {
  agentGraphTemplatesSettings,
  createTaskFromTemplateRpc,
  importTemplateRpc,
  mergeDraftIntoDoc,
  validateTemplateDocument,
  type TemplateRecord,
  type TemplatesDoc,
} from "../shared/templates";

/** 下拉选项统一形状 */
interface PickerRow {
  id: string;
  label: string;
}

interface ModelOption {
  id: string;
  label?: string;
  isSelectable?: boolean;
  isDefault?: boolean;
  thinkingOptions?: { id: string; label: string; isDefault?: boolean }[] | null;
  defaultThinkingOptionId?: string | null;
}

interface TemplatesBaseDoc {
  templates: TemplateRecord[];
  defaults: Record<string, string>;
}

interface EditorState {
  draft: TemplateRecord;
  baseDoc: TemplatesBaseDoc;
  baseRevision: string;
  notes: string[];
}

/** 一次"按模板新建任务"提交的完整输入快照;重试必须复用快照而非实时值 */
interface TaskAttempt {
  runId: string;
  title: string;
  prompt: string;
  nodes: TemplateNodeConfig[];
}

type TaskState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; rootAgentId: string; createdCount: number }
  | {
      kind: "failed";
      error: string | null;
      validationErrors: string[];
      createdAgentIds: { key: string; agentId: string }[];
      rootAgentId: string | null;
      attempt: TaskAttempt;
  };

/** 历史尝试记录:失败/成功都保留已创建节点 id,输入修改后仍可见,避免静默遗失 */
interface AttemptHistory {
  runId: string;
  ok: boolean;
  rootAgentId: string | null;
  createdAgentIds: { key: string; agentId: string }[];
}

/** 随机 runId(创建一次,失败重试复用;改动输入后重置) */
function newRunId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 单选下拉字段;选项限高滚动,单开交互。valueOverride 用于展示保留的原值(可标失效)。 */
function PickerField({
  label,
  rows,
  currentId,
  disabled,
  valueOverride,
  theme,
  onPick,
}: {
  label: string;
  rows: PickerRow[] | null;
  currentId: string | null;
  disabled?: boolean;
  valueOverride?: { label: string; invalid?: boolean } | null;
  theme: PluginTheme;
  onPick(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        label: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", marginBottom: 3 },
        // 悬停/按下统一反馈:透明度下压,对各类底色成立
        buttonHover: { opacity: 0.8 },
        trigger: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          backgroundColor: theme.colors.surface2,
        },
        value: { flex: 1, color: theme.colors.foreground, fontSize: 12 },
        placeholder: { color: theme.colors.foregroundMuted },
        invalid: { color: theme.colors.statusDanger },
        list: {
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
          marginTop: 2,
          overflow: "hidden",
        },
        scroll: { maxHeight: 180 },
        row: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
        rowText: { flex: 1, color: theme.colors.foreground, fontSize: 12 },
        rowTextActive: { fontWeight: "700" },
      }),
    [theme],
  );
  const current = rows?.find((row) => row.id === currentId);
  const display = valueOverride
    ? { label: valueOverride.label, invalid: valueOverride.invalid ?? false }
    : current
      ? { label: current.label, invalid: false }
      : rows
        ? { label: "未选择", invalid: false }
        : { label: "加载中…", invalid: false };
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <FeedbackPressable
        style={styles.trigger}
        hoverStyle={styles.buttonHover}
        onPress={() => setOpen(!open)}
        disabled={disabled || !rows || rows.length === 0}
        accessibilityLabel={`选择${label}`}
      >
        <Text
          style={[styles.value, display.invalid ? styles.invalid : !current && !valueOverride ? styles.placeholder : null]}
          numberOfLines={1}
        >
          {display.label}
        </Text>
        <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} />
      </FeedbackPressable>
      {open && rows && rows.length > 0 ? (
        <View style={styles.list}>
          <ScrollView style={styles.scroll}>
            {rows.map((row) => {
              const active = row.id === currentId;
              return (
                <FeedbackPressable
                  key={row.id}
                  style={styles.row}
                  hoverStyle={styles.buttonHover}
                  onPress={() => {
                    setOpen(false);
                    onPick(row.id);
                  }}
                >
                  <Text style={[styles.rowText, active ? styles.rowTextActive : null]} numberOfLines={1}>
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
}

/** 深拷贝节点数组(草稿编辑互不影响) */
function cloneNodes(nodes: readonly TemplateNodeConfig[]): TemplateNodeConfig[] {
  return nodes.map((node) => ({ ...node }));
}

function cloneDoc(doc: TemplatesBaseDoc): TemplatesBaseDoc {
  return {
    templates: doc.templates.map((template) => ({ ...template, nodes: cloneNodes(template.nodes) })),
    defaults: { ...doc.defaults },
  };
}

/**
 * 节点配置选择区:提供方/模型/思考强度/权限模式/速度,选项全部来自真实
 * providers.listAvailable/listModels/listModes/listFeatures。
 * 不做任何自动替换:目录失效时原值保留并显示失效警告,只有用户显式选择才重置相关值;
 * null 思考强度与空 modeId/速度都表示"默认"(创建时不传)。切换提供方/模型属于用户显式操作,
 * 会清除下游 mode/速度选择。速度仅在真实 descriptor 存在时显示(未知/不支持隐藏)。
 */
function NodeConfigPickers({
  node,
  workspaceId,
  onPatch,
  theme,
}: {
  node: TemplateNodeConfig;
  workspaceId: string;
  onPatch(patch: Partial<TemplateNodeConfig>): void;
  theme: PluginTheme;
}) {
  const paseo = usePaseo();
  // workspace 目录是 listFeatures 必填项;缺失时隐藏速度行
  const cwd = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [providers, setProviders] = useState<PickerRow[] | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modes, setModes] = useState<PickerRow[] | null>(null);
  // 速度:undefined 目录加载中,null 当前组合不支持(隐藏),否则 descriptor
  const [speed, setSpeed] = useState<SpeedFeatureDescriptor | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    paseo.providers
      .listAvailable()
      .then((result) => {
        if (cancelled) return;
        const rows = (result.providers ?? [])
          .filter((entry) => entry.available !== false)
          .map((entry) => ({ id: entry.provider, label: entry.provider }));
        setProviders(rows);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  // 提供方变化 → 拉模型目录;仅加载,不改动 node
  useEffect(() => {
    let cancelled = false;
    setModels(null);
    if (!node.provider) {
      setModels([]);
      return;
    }
    paseo.providers
      .listModels(node.provider)
      .then((result) => {
        if (cancelled) return;
        const selectable = (result.models ?? []).filter((model) => model.isSelectable !== false);
        setModels(selectable);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, node.provider]);

  // 提供方变化 → 拉真实模式目录(listModes);仅加载,不改动 node
  useEffect(() => {
    let cancelled = false;
    setModes(null);
    if (!node.provider) {
      setModes([]);
      return;
    }
    paseo.providers
      .listModes(node.provider)
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
  }, [paseo, node.provider]);

  // provider/model/mode 确定后 → 拉真实特性目录,只保留速度 descriptor;缺失/失败按不支持隐藏
  useEffect(() => {
    let cancelled = false;
    setSpeed(undefined);
    if (!node.provider || !node.model || !cwd) {
      setSpeed(null);
      return;
    }
    paseo.providers
      .listFeatures({
        provider: `${node.provider}/${node.model}`,
        cwd,
        ...(node.modeId ? { modeId: node.modeId } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        setSpeed(pickSpeedFeature(result.features ?? []));
      })
      .catch(() => {
        if (!cancelled) setSpeed(null);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, node.provider, node.model, node.modeId, cwd]);

  const currentModel = useMemo(
    () => models?.find((model) => model.id === node.model) ?? null,
    [models, node.model],
  );

  const thinkingOptions = currentModel?.thinkingOptions ?? null;
  const thinkingRows = useMemo<PickerRow[] | null>(() => {
    if (!thinkingOptions || thinkingOptions.length === 0) return null;
    const rows: PickerRow[] = [{ id: "", label: "默认" }];
    for (const option of thinkingOptions) rows.push({ id: option.id, label: option.label || option.id });
    return rows;
  }, [thinkingOptions]);

  // 节点已保存的速度选择 → UI 选择串(仅 descriptor 确认为同一 id 时可展示)
  const speedCurrentSelection = useMemo<string>(() => {
    if (!node.speedFeatureId || !speed || speed.id !== node.speedFeatureId) return "";
    if (speed.type === "toggle") {
      // false 是显式关闭,不是默认
      return node.speedFeatureValue === true ? "on" : node.speedFeatureValue === false ? "off" : "";
    }
    return typeof node.speedFeatureValue === "string" ? node.speedFeatureValue : "";
  }, [node.speedFeatureId, node.speedFeatureValue, speed]);

  const speedRows = useMemo<PickerRow[] | null>(() => {
    if (!speed) return null;
    return speed.type === "toggle"
      ? [
          { id: "", label: "默认(不指定)" },
          { id: "on", label: "开启" },
          { id: "off", label: "关闭" },
        ]
      : [
          { id: "", label: "默认(不指定)" },
          ...(speed.options ?? []).map((option) => ({ id: option.id, label: option.label })),
        ];
  }, [speed]);

  // 失效警告:目录就绪后原值不在目录 → 原样展示 + 红色提示,不做替换
  const providerInvalid = Boolean(providers && node.provider && !providers.some((row) => row.id === node.provider));
  const modelInvalid = Boolean(
    models && node.model && models.length > 0 && !models.some((model) => model.id === node.model),
  );
  const thinkingInvalid = Boolean(
    node.thinkingOptionId &&
      (thinkingOptions === null || thinkingOptions.length === 0 || !thinkingOptions.some((option) => option.id === node.thinkingOptionId)),
  );
  const modeInvalid = Boolean(
    node.modeId && modes && modes.length > 0 && !modes.some((mode) => mode.id === node.modeId),
  );
  // 速度失效:descriptor 未确认到相同 id,或已选值不再受支持
  const speedInvalid = Boolean(
    node.speedFeatureId &&
      (!speed || speed.id !== node.speedFeatureId || !speedSelectionValid(speed, speedCurrentSelection)),
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        warn: { color: theme.colors.statusDanger, fontSize: 11, marginTop: 2 },
      }),
    [theme],
  );

  return (
    <View style={{ gap: 6 }}>
      <PickerField
        label="提供方"
        rows={providers}
        currentId={node.provider || null}
        valueOverride={providerInvalid ? { label: node.provider, invalid: true } : null}
        theme={theme}
        onPick={(id) => {
          if (id === node.provider) return;
          // 用户显式切换:重置模型/思考强度,清除采集来的 modeId 与速度配置
          onPatch({
            provider: id,
            model: "",
            thinkingOptionId: null,
            ...(node.modeId ? { modeId: undefined } : {}),
            ...(node.speedFeatureId ? { speedFeatureId: undefined, speedFeatureValue: undefined } : {}),
          });
        }}
      />
      {providerInvalid ? <Text style={styles.warn}>提供方 {node.provider} 不在当前目录,原值保留;创建时会真实预检</Text> : null}
      <PickerField
        label="模型"
        rows={models?.map((model) => ({ id: model.id, label: model.label || model.id })) ?? null}
        currentId={node.model || null}
        valueOverride={
          node.model && (models === null || modelInvalid) ? { label: node.model, invalid: modelInvalid } : null
        }
        theme={theme}
        onPick={(id) =>
          onPatch({
            model: id,
            thinkingOptionId: null,
            // 速度依赖具体 model:显式切模型清除速度配置,mode 保留(仍属同一提供方)
            ...(node.speedFeatureId ? { speedFeatureId: undefined, speedFeatureValue: undefined } : {}),
          })
        }
      />
      {modelInvalid ? <Text style={styles.warn}>模型 {node.model} 不在当前目录,原值保留;创建时会真实预检</Text> : null}
      <PickerField
        label="权限模式"
        rows={modes && modes.length > 0 ? [{ id: "", label: "默认(不指定)" }, ...modes] : modes}
        currentId={node.modeId ?? ""}
        valueOverride={modeInvalid ? { label: `${node.modeId}(原值保留)`, invalid: true } : null}
        theme={theme}
        onPick={(id) => onPatch({ ...(id ? { modeId: id } : { modeId: undefined }) })}
      />
      {modeInvalid ? (
        <Text style={styles.warn}>
          权限模式 {node.modeId} 未能从当前目录确认(提供方无该模式或目录未确认),原值保留;创建时会真实预检
        </Text>
      ) : null}
      <PickerField
        label="思考强度"
        rows={thinkingRows}
        currentId={node.thinkingOptionId ?? ""}
        valueOverride={
          node.thinkingOptionId && thinkingInvalid
            ? { label: `${node.thinkingOptionId}(原值保留)`, invalid: true }
            : null
        }
        theme={theme}
        onPick={(id) => onPatch({ thinkingOptionId: id || null })}
      />
      {thinkingInvalid ? (
        <Text style={styles.warn}>
          思考强度 {node.thinkingOptionId} 未能从当前目录确认(模型无该选项或模型未确认),原值保留;创建时会真实预检
        </Text>
      ) : null}
      {speed ? (
        <PickerField
          label={speed.label || "速度"}
          rows={speedRows}
          currentId={speedCurrentSelection}
          valueOverride={
            node.speedFeatureId && speedInvalid
              ? {
                  label: `${node.speedFeatureId}=${String(node.speedFeatureValue)}(原值保留)`,
                  invalid: true,
                }
              : null
          }
          theme={theme}
          onPick={(id) =>
            // ""=不指定;toggle on/off=显式 true/false(false 同样保留);select 为 option id
            onPatch(
              id
                ? {
                    speedFeatureId: speed.id,
                    speedFeatureValue: speed.type === "toggle" ? id === "on" : id,
                  }
                : { speedFeatureId: undefined, speedFeatureValue: undefined },
            )
          }
        />
      ) : null}
      {node.speedFeatureId && speedInvalid ? (
        <Text style={styles.warn}>
          速度 {node.speedFeatureId}={String(node.speedFeatureValue)} 未能从当前目录确认(该组合不支持或目录未确认),原值保留;创建时会真实预检
        </Text>
      ) : null}
    </View>
  );
}

/** 模板编辑器:节点增删/父子调整/配置选择;保存固定 base revision,冲突后显式"载入最新并保留草稿" */
function TemplateEditor({
  editor,
  workspaceId,
  theme,
  compact,
  onSaved,
  onCancel,
}: {
  editor: EditorState;
  /** 当前 workspace id,供节点配置区拉取 features(listFeatures 需要 cwd) */
  workspaceId: string;
  theme: PluginTheme;
  compact: boolean;
  onSaved(): void;
  onCancel(): void;
}) {
  const settings = useSettings(agentGraphTemplatesSettings);
  const toast = useToast();
  const [name, setName] = useState(editor.draft.name);
  const [nodes, setNodes] = useState<TemplateNodeConfig[]>(() => cloneNodes(editor.draft.nodes));
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);

  const patchNode = useCallback((key: string, patch: Partial<TemplateNodeConfig>) => {
    setNodes((current) => current.map((node) => (node.key === key ? { ...node, ...patch } : node)));
  }, []);

  const addNode = useCallback(() => {
    setNodes((current) => {
      if (current.length >= TEMPLATE_MAX_NODES) return current;
      const root = current.find((node) => !node.parentKey);
      return [
        ...current,
        {
          key: nextNodeKey(current),
          parentKey: root?.key ?? null,
          title: "",
          provider: root?.provider ?? "",
          model: root?.model ?? "",
          thinkingOptionId: root?.thinkingOptionId ?? null,
          ...(root?.modeId ? { modeId: root.modeId } : {}),
          ...(root?.speedFeatureId !== undefined ? { speedFeatureId: root.speedFeatureId } : {}),
          ...(root?.speedFeatureValue !== undefined ? { speedFeatureValue: root.speedFeatureValue } : {}),
        },
      ];
    });
  }, []);

  const removeNode = useCallback((key: string) => {
    setNodes((current) => {
      const hasChildren = current.some((node) => node.parentKey === key);
      const isRoot = !current.find((node) => node.key === key)?.parentKey;
      if (hasChildren || isRoot) return current;
      return current.filter((node) => node.key !== key);
    });
  }, []);

  const treeValidation = useMemo(() => validateTemplateNodes(nodes), [nodes]);
  const configErrors = useMemo(() => {
    const errors: string[] = [];
    if (!name.trim()) errors.push("模板名称不能为空");
    for (const node of nodes) {
      if (!node.provider.trim()) errors.push(`节点 ${node.key}:未选择提供方`);
      if (!node.model.trim()) errors.push(`节点 ${node.key}:未选择模型`);
    }
    return errors;
  }, [name, nodes]);
  const allErrors = useMemo(
    () => [...configErrors, ...(treeValidation.ok ? [] : treeValidation.errors)],
    [configErrors, treeValidation],
  );
  const canSave = allErrors.length === 0 && !saving;

  // 首次保存:草稿合并进打开编辑器时的 base 文档,用 base revision → 他端修改会冲突
  const handleSave = useCallback(async () => {
    if (settings.status !== "ready" || !canSave) return;
    setSaving(true);
    setSaveFailed(null);
    const draft: TemplateRecord = { id: editor.draft.id, name: name.trim(), nodes };
    const doc = mergeDraftIntoDoc(editor.baseDoc, draft);
    const docErrors = validateTemplateDocument(doc);
    if (docErrors.length > 0) {
      setSaveFailed(docErrors.join("; "));
      setSaving(false);
      return;
    }
    const ok = await settings.save(doc, editor.baseRevision);
    setSaving(false);
    if (ok) {
      toast.show("模板已保存");
      onSaved();
    } else {
      setSaveFailed(settings.saveError ?? "保存冲突:配置已被其他端修改,草稿未丢失");
    }
  }, [settings, canSave, editor, name, nodes, toast, onSaved]);

  // 冲突恢复:显式动作——以最新文档为底保留我的草稿,用刷新后的 revision;不自动执行
  const handleMergeLatestAndSave = useCallback(async () => {
    if (settings.status !== "ready" || !canSave) return;
    setSaving(true);
    const draft: TemplateRecord = { id: editor.draft.id, name: name.trim(), nodes };
    const doc = mergeDraftIntoDoc(settings.values, draft);
    const docErrors = validateTemplateDocument(doc);
    if (docErrors.length > 0) {
      setSaveFailed(docErrors.join("; "));
      setSaving(false);
      return;
    }
    const ok = await settings.save(doc, settings.revision);
    setSaving(false);
    if (ok) {
      toast.show("已以最新文档为底保存草稿");
      onSaved();
    } else {
      setSaveFailed(settings.saveError ?? "仍然冲突,请再次重试");
    }
  }, [settings, canSave, editor.draft.id, name, nodes, toast, onSaved]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.colors.surface0 },
        scroll: { flex: 1 },
        body: { padding: compact ? 10 : 14, gap: 10 },
        headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
        headerTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700", flex: 1 },
        iconButton: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 5,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
        },
        iconButtonText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        notes: {
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
          padding: 8,
          gap: 3,
        },
        noteText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        nameInput: {
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: theme.colors.foreground,
          fontSize: 13,
        },
        nodeCard: {
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          padding: 10,
          gap: 6,
        },
        nodeHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
        nodeBadge: {
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: 6,
          backgroundColor: theme.colors.accent ?? theme.colors.surface2,
        },
        nodeBadgeText: { color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700" },
        nodeKeyText: { color: theme.colors.foregroundMuted, fontSize: 10, flex: 1 },
        fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", marginBottom: 3 },
        titleInput: {
          backgroundColor: theme.colors.surface2,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          color: theme.colors.foreground,
          fontSize: 12,
        },
        removeButton: {
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        removeButtonText: { color: theme.colors.statusDanger, fontSize: 11 },
        errorText: { color: theme.colors.statusDanger, fontSize: 11 },
        conflictBox: {
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
          padding: 8,
          gap: 6,
        },
        conflictText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
        addButton: {
          alignItems: "center",
          paddingVertical: 9,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        addButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        buttonHover: { opacity: 0.8 },
        footerButtons: { flexDirection: "row", gap: 8, marginTop: 4 },
        primaryButton: {
          flex: 1,
          backgroundColor: theme.colors.accent,
          borderRadius: 8,
          alignItems: "center",
          paddingVertical: 10,
        },
        primaryButtonText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" },
        secondaryButton: {
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
          alignItems: "center",
        },
        secondaryButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      }),
    [theme, compact],
  );

  return (
    <View style={styles.root}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>编辑模板</Text>
          <FeedbackPressable style={styles.iconButton} hoverStyle={styles.buttonHover} onPress={onCancel} accessibilityLabel="放弃编辑模板">
            <Text style={styles.iconButtonText}>取消</Text>
          </FeedbackPressable>
        </View>

        {editor.notes.length > 0 ? (
          <View style={styles.notes}>
            {editor.notes.map((note, index) => (
              <Text key={index} style={styles.noteText}>
                • {note}
              </Text>
            ))}
          </View>
        ) : null}

        <View>
          <Text style={styles.fieldLabel}>模板名称</Text>
          <TextInput
            style={styles.nameInput}
            value={name}
            onChangeText={setName}
            placeholder="例如:代码评审流水线"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>

        {nodes.map((node, index) => {
          const isRoot = !node.parentKey;
          const hasChildren = nodes.some((other) => other.parentKey === node.key);
          const parentChoices = parentOptionsFor(nodes, node.key);
          return (
            <View key={node.key} style={styles.nodeCard}>
              <View style={styles.nodeHeader}>
                {isRoot ? (
                  <View style={styles.nodeBadge}>
                    <Text style={styles.nodeBadgeText}>主节点</Text>
                  </View>
                ) : null}
                <Text style={styles.nodeKeyText}>#{index + 1} · key {node.key}</Text>
                {isRoot ? (
                  <Text style={styles.noteText}>主节点不可删除</Text>
                ) : (
                  <FeedbackPressable
                    style={[styles.removeButton, hasChildren ? { opacity: 0.4 } : null]}
                    hoverStyle={styles.buttonHover}
                    onPress={() => removeNode(node.key)}
                    disabled={hasChildren}
                    accessibilityLabel={`删除节点 ${node.key}`}
                  >
                    <Text style={styles.removeButtonText}>
                      {hasChildren ? "先移除子节点" : "删除"}
                    </Text>
                  </FeedbackPressable>
                )}
              </View>
              <View>
                <Text style={styles.fieldLabel}>标题(留空自动生成)</Text>
                <TextInput
                  style={styles.titleInput}
                  value={node.title}
                  onChangeText={(text) => patchNode(node.key, { title: text })}
                  placeholder="节点标题"
                  placeholderTextColor={theme.colors.foregroundMuted}
                />
              </View>
              {isRoot ? null : (
                <PickerField
                  label="父节点"
                  rows={[
                    { id: "", label: "无(设为主节点)" },
                    ...parentChoices.map((choice) => ({
                      id: choice.key,
                      label: choice.title || choice.key,
                    })),
                  ]}
                  currentId={node.parentKey ?? ""}
                  theme={theme}
                  onPick={(id) => patchNode(node.key, { parentKey: id || null })}
                />
              )}
              <NodeConfigPickers
                node={node}
                workspaceId={workspaceId}
                onPatch={(patch) => patchNode(node.key, patch)}
                theme={theme}
              />
            </View>
          );
        })}

        {nodes.length < TEMPLATE_MAX_NODES ? (
          <FeedbackPressable style={styles.addButton} hoverStyle={styles.buttonHover} onPress={addNode} accessibilityLabel="添加节点">
            <Text style={styles.addButtonText}>+ 添加节点(最多 {TEMPLATE_MAX_NODES} 个)</Text>
          </FeedbackPressable>
        ) : null}

        {allErrors.map((error, index) => (
          <Text key={index} style={styles.errorText}>
            {error}
          </Text>
        ))}

        {saveFailed ? (
          <View style={styles.conflictBox}>
            <Text style={styles.errorText}>{saveFailed}</Text>
            <Text style={styles.conflictText}>
              可以显式载入最新文档并保留当前草稿:其他模板与默认设置取最新版本,本模板将以你当前的草稿内容覆盖其最新版本。
            </Text>
            <FeedbackPressable
              style={styles.secondaryButton}
              hoverStyle={styles.buttonHover}
              onPress={() => void handleMergeLatestAndSave()}
              disabled={!canSave}
              accessibilityLabel="载入最新版本并保留我的草稿"
            >
              <Text style={styles.secondaryButtonText}>载入最新并保留我的草稿</Text>
            </FeedbackPressable>
          </View>
        ) : null}

        <View style={styles.footerButtons}>
          <FeedbackPressable
            style={[styles.primaryButton, !canSave ? { opacity: 0.5 } : null]}
            hoverStyle={styles.buttonHover}
            onPress={() => void handleSave()}
            disabled={!canSave}
            accessibilityLabel="保存模板"
          >
            <Text style={styles.primaryButtonText}>{saving ? "保存中…" : "保存模板"}</Text>
          </FeedbackPressable>
        </View>
      </ScrollView>
    </View>
  );
}

/** 按模板新建任务:创建期间全量禁用输入与导航;失败重试复用首次输入快照与幂等 key */
function TaskLauncher({
  templates,
  defaultTemplateId,
  workspaceId,
  theme,
  compact,
  onOpenAgent,
  onBack,
}: {
  templates: TemplateRecord[];
  defaultTemplateId: string | null;
  workspaceId: string;
  theme: PluginTheme;
  compact: boolean;
  onOpenAgent(agentId: string): void;
  onBack(): void;
}) {
  const toast = useToast();
  const createTask = useRpc(createTaskFromTemplateRpc);
  const [templateId, setTemplateId] = useState<string | null>(defaultTemplateId ?? templates[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<TaskState>({ kind: "idle" });
  const [attempts, setAttempts] = useState<AttemptHistory[]>([]);
  // 同步锁:inflight 期间 resetRun/再次启动一律拒绝,杜绝并行两棵树
  const inflightRef = useRef(false);

  const template = templates.find((entry) => entry.id === templateId) ?? null;
  const running = state.kind === "running";

  // 输入修改:inflight 时拒绝;否则作废旧 runId 回到 idle(历史尝试保留展示)
  const resetRun = useCallback(() => {
    if (inflightRef.current) return;
    setRunId(null);
    setState({ kind: "idle" });
  }, []);

  const handleLaunch = useCallback(
    async (attempt?: TaskAttempt) => {
      if (inflightRef.current) return;
      const selected: TaskAttempt | null = attempt ?? null;
      let next: TaskAttempt;
      if (selected) {
        next = selected;
      } else {
        if (!template) return;
        next = { runId: runId ?? newRunId(), title: title.trim(), prompt, nodes: cloneNodes(template.nodes) };
      }
      inflightRef.current = true;
      setRunId(next.runId);
      setState({ kind: "running" });
      try {
        const result = await createTask({
          workspaceId,
          title: next.title,
          prompt: next.prompt,
          runId: next.runId,
          nodes: next.nodes,
        });
        setAttempts((current) => [
          ...current,
          {
            runId: next.runId,
            ok: result.ok,
            rootAgentId: result.rootAgentId,
            createdAgentIds: result.createdAgentIds,
          },
        ]);
        if (result.ok && result.rootAgentId) {
          setState({ kind: "done", rootAgentId: result.rootAgentId, createdCount: result.createdAgentIds.length });
          toast.show("任务树已创建");
        } else {
          setState({
            kind: "failed",
            error: result.error,
            validationErrors: result.validationErrors,
            createdAgentIds: result.createdAgentIds,
            rootAgentId: result.rootAgentId,
            attempt: next,
          });
        }
      } catch (error) {
        setAttempts((current) => [
          ...current,
          { runId: next.runId, ok: false, rootAgentId: null, createdAgentIds: [] },
        ]);
        setState({
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
          validationErrors: [],
          createdAgentIds: [],
          rootAgentId: null,
          attempt: next,
        });
      } finally {
        inflightRef.current = false;
      }
    },
    [createTask, workspaceId, template, runId, title, prompt, toast],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.colors.surface0 },
        scroll: { flex: 1 },
        body: { padding: compact ? 10 : 14, gap: 10 },
        headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
        headerTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700", flex: 1 },
        iconButton: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 5,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
        },
        iconButtonText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", marginBottom: 3 },
        input: {
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: theme.colors.foreground,
          fontSize: 12,
        },
        promptInput: {
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: theme.colors.foreground,
          fontSize: 12,
          minHeight: 64,
          maxHeight: 140,
          textAlignVertical: "top" as const,
        },
        hint: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
        errorText: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 16 },
        successText: { color: theme.colors.statusSuccess, fontSize: 12 },
        historyBox: { borderRadius: 8, backgroundColor: theme.colors.surface1, padding: 8, gap: 2 },
        historyText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        footerButtons: { flexDirection: "row", gap: 8, marginTop: 4 },
        primaryButton: {
          flex: 1,
          backgroundColor: theme.colors.accent,
          borderRadius: 8,
          alignItems: "center",
          paddingVertical: 10,
        },
        primaryButtonText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" },
        secondaryButton: {
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
          alignItems: "center",
        },
        secondaryButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        disabled: { opacity: 0.4 },
        buttonHover: { opacity: 0.8 },
      }),
    [theme, compact],
  );

  const canLaunch = Boolean(template) && title.trim().length > 0 && !running;

  return (
    <View style={styles.root}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>按模板新建任务</Text>
          <FeedbackPressable
            style={[styles.iconButton, running ? styles.disabled : null]}
            hoverStyle={styles.buttonHover}
            onPress={onBack}
            disabled={running}
            accessibilityLabel="返回模板列表"
          >
            <Text style={styles.iconButtonText}>返回</Text>
          </FeedbackPressable>
        </View>

        <PickerField
          label="模板"
          rows={templates.map((entry) => ({ id: entry.id, label: `${entry.name}(${entry.nodes.length} 节点)` }))}
          currentId={templateId}
          disabled={running}
          theme={theme}
          onPick={(id) => {
            setTemplateId(id);
            resetRun();
          }}
        />
        <View>
          <Text style={styles.fieldLabel}>任务标题</Text>
          <TextInput
            style={styles.input}
            value={title}
            editable={!running}
            onChangeText={(text) => {
              setTitle(text);
              resetRun();
            }}
            placeholder="用作主节点标题"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>
        <View>
          <Text style={styles.fieldLabel}>首条 prompt(可选)</Text>
          <TextInput
            style={styles.promptInput}
            value={prompt}
            editable={!running}
            onChangeText={(text) => {
              setPrompt(text);
              resetRun();
            }}
            multiline
            placeholder="整树创建成功后发送给主节点;子节点保持待命"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>
        <Text style={styles.hint}>
          按模板在当前 workspace 创建整棵 agent 树;所有节点的提供方/模型/思考强度/权限模式/速度会先做真实预检,不支持时明确报错,不会替换配置。
        </Text>

        {running ? <Text style={styles.hint}>创建进行中,输入与导航已锁定;请勿关闭面板</Text> : null}

        {attempts.length > 0 ? (
          <View style={styles.historyBox}>
            <Text style={styles.historyText}>本次已发起的创建(节点不会重复创建,勿盲重试):</Text>
            {attempts.map((entry, index) => (
              <Text key={index} style={styles.historyText}>
                • [{entry.ok ? "成功" : "部分失败"}] runId {entry.runId} · 主节点 {entry.rootAgentId ?? "未创建"} ·{" "}
                {entry.createdAgentIds.length} 个节点
              </Text>
            ))}
            <Text style={styles.historyText}>
              修改标题/prompt/模板会开始新任务;已创建的节点不会自动删除,请先对照上方 id。
            </Text>
          </View>
        ) : null}

        {state.kind === "done" ? (
          <>
            <Text style={styles.successText}>
              已创建 {state.createdCount} 个节点,主节点 {state.rootAgentId}
            </Text>
            <FeedbackPressable
              style={styles.secondaryButton}
              hoverStyle={styles.buttonHover}
              onPress={() => onOpenAgent(state.rootAgentId)}
              accessibilityLabel="打开主节点"
            >
              <Text style={styles.secondaryButtonText}>打开主节点</Text>
            </FeedbackPressable>
          </>
        ) : null}
        {state.kind === "failed" ? (
          <>
            {state.error ? <Text style={styles.errorText}>{state.error}</Text> : null}
            {state.rootAgentId ? (
              <Text style={styles.historyText}>主节点已创建:{state.rootAgentId}(重试幂等,不会重复)</Text>
            ) : null}
            {state.validationErrors.map((error, index) => (
              <Text key={index} style={styles.errorText}>
                {error}
              </Text>
            ))}
            {state.createdAgentIds.length > 0 ? (
              <View style={styles.historyBox}>
                <Text style={styles.historyText}>本次已创建 {state.createdAgentIds.length} 个节点:</Text>
                {state.createdAgentIds.map((entry) => (
                  <Text key={entry.key} style={styles.historyText}>
                    • {entry.key} → {entry.agentId}
                  </Text>
                ))}
              </View>
            ) : null}
            <Text style={styles.hint}>
              重试复用首次提交的标题/prompt/模板节点快照与幂等 key,与当前输入无关;如需更改内容请修改输入开始新任务。
            </Text>
          </>
        ) : null}

        <View style={styles.footerButtons}>
          <FeedbackPressable
            style={[styles.primaryButton, !canLaunch ? styles.disabled : null]}
            hoverStyle={styles.buttonHover}
            onPress={() =>
              void handleLaunch(state.kind === "failed" ? state.attempt : undefined)
            }
            disabled={!canLaunch}
            accessibilityLabel="按模板创建任务"
          >
            <Text style={styles.primaryButtonText}>
              {running ? "创建中…" : state.kind === "failed" ? "重试(复用首次输入与幂等 key)" : "创建任务"}
            </Text>
          </FeedbackPressable>
        </View>
      </ScrollView>
    </View>
  );
}

/** 面板"节点模板"主视图:列表 / 编辑 / 建任务三分支 */
export function TemplatesView({
  workspaceId,
  theme,
  compact,
  onBack,
  openAgent,
}: {
  workspaceId: string;
  theme: PluginTheme;
  compact: boolean;
  onBack(): void;
  openAgent(agentId: string): void;
}) {
  const toast = useToast();
  const importTemplate = useRpc(importTemplateRpc);
  const settings = useSettings(agentGraphTemplatesSettings);
  const workspace = useWorkspace(workspaceId, (value) => ({
    projectId: value.projectId,
    directory: value.directory,
    title: value.title,
    name: value.name,
  }));

  const [mode, setMode] = useState<{ kind: "list" } | { kind: "edit" } | { kind: "task" }>({ kind: "list" });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const values = settings.status === "ready" ? settings.values : null;
  const templates: TemplateRecord[] = useMemo(() => values?.templates ?? [], [values]);

  const defaultTemplateId = useMemo(() => {
    if (!values) return null;
    return matchProjectDefault(values.defaults, {
      projectId: workspace?.projectId ?? null,
      cwd: workspace?.directory ?? null,
    });
  }, [values, workspace]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const baseDocFrom = useCallback((doc: TemplatesDoc): TemplatesBaseDoc => cloneDoc(doc), []);

  const setDefault = useCallback(
    (templateId: string | null) => {
      if (settings.status !== "ready") return;
      const defaults = { ...settings.values.defaults };
      const keys = projectDefaultKeys({
        projectId: workspace?.projectId ?? null,
        cwd: workspace?.directory ?? null,
      });
      for (const key of keys) {
        if (templateId) defaults[key] = templateId;
        else delete defaults[key];
      }
      void settings
        .save({ templates: settings.values.templates, defaults }, settings.revision)
        .then((ok) => {
          if (ok) toast.show(templateId ? "已设为本项目默认模板" : "已关闭本项目默认模板");
          else toast.error(settings.saveError ?? "保存失败,请重试");
        });
    },
    [settings, workspace, toast],
  );

  const deleteTemplate = useCallback(
    (templateId: string) => {
      if (settings.status !== "ready") return;
      const defaults = { ...settings.values.defaults };
      for (const [key, value] of Object.entries(defaults)) {
        if (value === templateId) delete defaults[key];
      }
      const next = settings.values.templates.filter((template) => template.id !== templateId);
      void settings.save({ templates: next, defaults }, settings.revision).then((ok) => {
        if (ok) toast.show("模板已删除");
        else toast.error(settings.saveError ?? "删除失败,请重试");
      });
    },
    [settings, toast],
  );

  const startNewTemplate = useCallback(() => {
    if (settings.status !== "ready") return;
    const root: TemplateNodeConfig = {
      key: "n1",
      parentKey: null,
      title: "",
      provider: "",
      model: "",
      thinkingOptionId: null,
    };
    setEditor({
      draft: { id: newTemplateId(), name: "", nodes: [root] },
      baseDoc: baseDocFrom(settings.values),
      baseRevision: settings.revision,
      notes: [],
    });
    setMode({ kind: "edit" });
  }, [settings, baseDocFrom]);

  const startImport = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const draft = await importTemplate({ workspaceId });
      if (draft.nodes.length === 0) {
        toast.error(
          draft.truncated
            ? `导入结果不完整:${draft.notes.join("；")}`
            : "当前 workspace 没有可导入的未归档节点",
        );
        return;
      }
      if (settings.status !== "ready") {
        toast.error("模板配置未就绪,无法进入编辑");
        return;
      }
      setEditor({
        draft: { id: newTemplateId(), name: draft.name, nodes: draft.nodes },
        baseDoc: baseDocFrom(settings.values),
        baseRevision: settings.revision,
        notes: draft.truncated ? [...draft.notes, "导入结果不完整,请核对后再保存"] : draft.notes,
      });
      setMode({ kind: "edit" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }, [importing, importTemplate, workspaceId, settings, toast, baseDocFrom]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.colors.surface0 },
        scroll: { flex: 1 },
        body: { padding: compact ? 10 : 14, gap: 10 },
        headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
        headerTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700", flex: 1 },
        iconButton: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 5,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
        },
        iconButtonText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        defaultHint: { color: theme.colors.foregroundMuted, fontSize: 11 },
        card: {
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          padding: 10,
          gap: 6,
        },
        cardHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
        cardName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 },
        defaultBadge: {
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: 6,
          backgroundColor: theme.colors.surface2,
        },
        defaultBadgeText: { color: theme.colors.foregroundMuted, fontSize: 10 },
        metaText: { color: theme.colors.foregroundMuted, fontSize: 11 },
        actions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
        chip: {
          paddingHorizontal: 8,
          paddingVertical: 5,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        chipText: { color: theme.colors.foreground, fontSize: 11 },
        chipDanger: { backgroundColor: theme.colors.surface2 },
        chipDangerText: { color: theme.colors.statusDanger, fontSize: 11 },
        placeholder: { padding: 20, alignItems: "center", gap: 6 },
        placeholderText: { color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center", lineHeight: 17 },
        errorText: { color: theme.colors.statusDanger, fontSize: 12 },
        buttonHover: { opacity: 0.8 },
      }),
    [theme, compact],
  );

  if (mode.kind === "edit" && editor) {
    return (
      <TemplateEditor
        editor={editor}
        workspaceId={workspaceId}
        theme={theme}
        compact={compact}
        onSaved={() => {
          setEditor(null);
          setMode({ kind: "list" });
        }}
        onCancel={() => {
          setEditor(null);
          setMode({ kind: "list" });
        }}
      />
    );
  }

  if (mode.kind === "task") {
    return (
      <TaskLauncher
        templates={templates}
        defaultTemplateId={defaultTemplateId}
        workspaceId={workspaceId}
        theme={theme}
        compact={compact}
        onOpenAgent={openAgent}
        onBack={() => setMode({ kind: "list" })}
      />
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        <View style={styles.headerRow}>
          <FeedbackPressable style={styles.iconButton} hoverStyle={styles.buttonHover} onPress={onBack} accessibilityLabel="返回节点图">
            <Icon name="ArrowLeft" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.iconButtonText}>返回</Text>
          </FeedbackPressable>
          <Text style={styles.headerTitle}>节点模板</Text>
          <FeedbackPressable style={styles.iconButton} hoverStyle={styles.buttonHover} onPress={startNewTemplate} accessibilityLabel="新建模板">
            <Icon name="Plus" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.iconButtonText}>新建</Text>
          </FeedbackPressable>
          <FeedbackPressable
            style={[styles.iconButton, importing ? { opacity: 0.5 } : null]}
            hoverStyle={styles.buttonHover}
            onPress={() => void startImport()}
            disabled={importing}
            accessibilityLabel="从当前未归档节点生成模板"
          >
            <Icon name="Import" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.iconButtonText}>{importing ? "生成中…" : "从当前节点生成"}</Text>
          </FeedbackPressable>
        </View>

        <Text style={styles.defaultHint}>
          {defaultTemplateId
            ? `本项目默认模板:${templates.find((template) => template.id === defaultTemplateId)?.name ?? defaultTemplateId}`
            : "未设置本项目默认模板"}
        </Text>

        {settings.status === "loading" ? <Text style={styles.placeholderText}>正在加载模板…</Text> : null}
        {settings.status === "invalid" ? (
          <Text style={styles.errorText}>模板配置数据无效:{settings.error}</Text>
        ) : null}
        {settings.status === "error" ? (
          <Text style={styles.errorText}>模板配置读取失败:{settings.error}</Text>
        ) : null}
        {settings.status === "ready" && templates.length === 0 ? (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>
              还没有模板。新建一个,或从当前 workspace 的未归档节点一键生成。
            </Text>
          </View>
        ) : null}

        {templates.map((template) => {
          const isDefault = defaultTemplateId === template.id;
          return (
            <View key={template.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardName}>{template.name}</Text>
                {isDefault ? (
                  <View style={styles.defaultBadge}>
                    <Text style={styles.defaultBadgeText}>本项目默认</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.metaText}>
                {template.nodes.length} 个节点 · 主节点 {template.nodes.find((node) => !node.parentKey)?.provider || "?"}/
                {template.nodes.find((node) => !node.parentKey)?.model || "?"}
              </Text>
              <View style={styles.actions}>
                <FeedbackPressable
                  style={styles.chip}
                  hoverStyle={styles.buttonHover}
                  onPress={() => setMode({ kind: "task" })}
                  accessibilityLabel={`按模板 ${template.name} 新建任务`}
                >
                  <Text style={styles.chipText}>新建任务</Text>
                </FeedbackPressable>
                <FeedbackPressable
                  style={styles.chip}
                  hoverStyle={styles.buttonHover}
                  onPress={() => {
                    if (settings.status !== "ready") return;
                    setEditor({
                      draft: { id: template.id, name: template.name, nodes: cloneNodes(template.nodes) },
                      baseDoc: baseDocFrom(settings.values),
                      baseRevision: settings.revision,
                      notes: [],
                    });
                    setMode({ kind: "edit" });
                  }}
                  accessibilityLabel={`编辑模板 ${template.name}`}
                >
                  <Text style={styles.chipText}>编辑</Text>
                </FeedbackPressable>
                <FeedbackPressable
                  style={styles.chip}
                  hoverStyle={styles.buttonHover}
                  onPress={() => setDefault(isDefault ? null : template.id)}
                  accessibilityLabel={isDefault ? `关闭 ${template.name} 的项目默认` : `设 ${template.name} 为项目默认`}
                >
                  <Text style={styles.chipText}>{isDefault ? "关闭默认" : "设为默认"}</Text>
                </FeedbackPressable>
                <FeedbackPressable
                  style={[styles.chip, confirmDeleteId === template.id ? styles.chipDanger : null]}
                  hoverStyle={styles.buttonHover}
                  onPress={() => {
                    if (confirmDeleteId === template.id) {
                      if (confirmTimer.current) clearTimeout(confirmTimer.current);
                      setConfirmDeleteId(null);
                      deleteTemplate(template.id);
                      return;
                    }
                    setConfirmDeleteId(template.id);
                    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
                  }}
                  accessibilityLabel={`删除模板 ${template.name}`}
                >
                  <Text style={confirmDeleteId === template.id ? styles.chipDangerText : styles.chipText}>
                    {confirmDeleteId === template.id ? "确认删除?" : "删除"}
                  </Text>
                </FeedbackPressable>
              </View>
            </View>
          );
        })}

        <Text style={styles.defaultHint}>
          模板保存到 host 设置;按模板新建任务会先校验全部配置,再按父子拓扑创建,主节点收到首条 prompt 后整树待命。
        </Text>
      </ScrollView>
    </View>
  );
}
