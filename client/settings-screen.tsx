import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsGroup,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { agentGraphSettings } from "../shared/settings";

type Values = {
  hideArchivedByDefault: boolean;
  sendBehavior: "steer" | "queue";
  consoleHeight: number;
  runningColor: string;
  doneColor: string;
  attentionColor: string;
  failedColor: string;
  timelineLimit: number;
};

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 状态颜色预设色板(8 色) */
const STATUS_PALETTE = [
  "#a78bfa",
  "#60a5fa",
  "#4ade80",
  "#facc15",
  "#fb923c",
  "#f87171",
  "#f472b6",
  "#22d3ee",
];

/** 可展开的紧凑色板:8 固定色 + 行尾"跟随主题"空心圆。 */
function ColorPaletteRow({
  value,
  theme,
  onPick,
  onFollowTheme,
}: {
  value: string;
  theme: PluginTheme;
  onPick(hex: string): void;
  onFollowTheme(): void;
}) {
  const normalized = value.trim().toLowerCase();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
      {STATUS_PALETTE.map((hex) => {
        const selected = normalized === hex;
        return (
          <Pressable
            key={hex}
            accessibilityLabel={`预设颜色 ${hex}`}
            onPress={() => onPick(hex)}
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: hex,
              // 未选中时透明描边占位,选中切换不跳动
              borderWidth: 2,
              borderColor: selected ? theme.colors.foreground : "transparent",
            }}
          />
        );
      })}
      <Pressable
        accessibilityLabel="跟随主题颜色"
        onPress={onFollowTheme}
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: "transparent",
          borderWidth: normalized === "" ? 2 : 1.5,
          borderColor:
            normalized === "" ? theme.colors.foreground : theme.colors.foregroundMuted,
        }}
      />
    </View>
  );
}

export function AgentGraphSettingsScreen({ theme }: PluginSurfaceProps) {
  const state = useSettings(agentGraphSettings);
  const stateRef = useRef(state);
  stateRef.current = state;
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 当前展开色板的颜色项 key,同一时间只展开一行(null = 全部收起)
  const [openColorKey, setOpenColorKey] = useState<string | null>(null);

  const save = useCallback((patch: Partial<Values>) => {
    const current = stateRef.current;
    if (current.status !== "ready") return;
    void current.save({ ...current.values, ...patch }, current.revision);
  }, []);

  // 文本输入连续变化时防抖保存,避免 revision 冲突
  const debouncedSave = useCallback(
    (key: string, value: string) => {
      const timersMap = timers.current;
      const existing = timersMap.get(key);
      if (existing) clearTimeout(existing);
      timersMap.set(
        key,
        setTimeout(() => {
          timersMap.delete(key);
          if (HEX_PATTERN.test(value) || value.trim() === "") save({ [key]: value } as Partial<Values>);
        }, 450),
      );
    },
    [save],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.colors.surface0 },
        body: { padding: 14, gap: 14 },
        swatch: {
          width: 16,
          height: 16,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        colorRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        },
        colorLabel: { color: theme.colors.foreground, fontSize: 13 },
        colorHint: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
        colorTrigger: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          padding: 6,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        colorInput: {
          backgroundColor: theme.colors.surface2,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          color: theme.colors.foreground,
          fontSize: 12,
        },
        hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 14, paddingTop: 8 },
        errorText: { color: theme.colors.statusDanger, fontSize: 13 },
      }),
    [theme],
  );

  if (state.status === "loading") {
    return (
      <View style={styles.root}>
        <Text style={styles.hint}>正在加载配置…</Text>
      </View>
    );
  }
  if (state.status !== "ready") {
    return (
      <View style={styles.root}>
        <Text style={styles.errorText}>配置读取失败:{state.error}</Text>
      </View>
    );
  }

  const values = state.values;
  const colorRows: { key: keyof Pick<Values, "runningColor" | "doneColor" | "attentionColor" | "failedColor">; label: string; hint: string; fallback: string; placeholder: string }[] = [
    {
      key: "runningColor",
      label: "运行中",
      hint: "呼吸动效、连线流点、停止按钮",
      fallback: "#a78bfa",
      placeholder: "#a78bfa",
    },
    {
      key: "doneColor",
      label: "空闲(已完成)",
      hint: "运行完成后的状态点与徽章",
      fallback: theme.colors.statusSuccess,
      placeholder: "留空跟随主题绿色",
    },
    {
      key: "attentionColor",
      label: "需要确认",
      hint: "权限请求等需要用户介入的状态",
      fallback: theme.colors.statusWarning,
      placeholder: "留空跟随主题黄色",
    },
    {
      key: "failedColor",
      label: "出错",
      hint: "agent 报错时的状态点",
      fallback: theme.colors.statusDanger,
      placeholder: "留空跟随主题红色",
    },
  ];

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.body}>
        <SettingsGroup title="显示">
          <SettingsSwitch
            label="默认隐藏已归档"
            hint="打开面板时收起已归档的 agent,可随时在面板右上角展开"
            value={values.hideArchivedByDefault}
            onValueChange={(value) => save({ hideArchivedByDefault: value })}
          />
          <SettingsSelect
            label="会话区默认高度"
            hint="选中卡片后的会话控制台高度;面板内仍可拖拽调整"
            value={String(values.consoleHeight)}
            options={[
              { label: "紧凑 (240)", value: "240" },
              { label: "默认 (320)", value: "320" },
              { label: "大 (420)", value: "420" },
              { label: "更大 (520)", value: "520" },
              { label: "最大 (680)", value: "680" },
            ]}
            onValueChange={(value) => save({ consoleHeight: Number(value) })}
          />
          <SettingsSelect
            label="对话流拉取条数"
            hint="选中 agent 时加载最近多少条时间线条目"
            value={String(values.timelineLimit)}
            options={[
              { label: "30 条", value: "30" },
              { label: "60 条(默认)", value: "60" },
              { label: "120 条", value: "120" },
              { label: "200 条", value: "200" },
            ]}
            onValueChange={(value) => save({ timelineLimit: Number(value) })}
          />
        </SettingsGroup>

        <SettingsGroup title="发送行为">
          <SettingsSelect
            label="运行中收到新消息"
            hint="改变后仅对新发送的消息生效"
            value={values.sendBehavior}
            options={[
              { label: "引导(立即注入当前回合)", value: "steer" },
              { label: "排队(当前回合结束后自动发送)", value: "queue" },
            ]}
            onValueChange={(value) => save({ sendBehavior: value as Values["sendBehavior"] })}
          />
        </SettingsGroup>

        <SettingsGroup title="状态颜色">
          <View style={{ gap: 14 }}>
            {colorRows.map((row) => {
              const current = values[row.key];
              const effective = HEX_PATTERN.test(current) ? current : row.fallback;
              return (
                <View key={row.key} style={{ gap: 6 }}>
                  <View style={styles.colorRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.colorLabel}>{row.label}</Text>
                      <Text style={styles.colorHint}>{row.hint}</Text>
                    </View>
                    <Pressable
                      style={styles.colorTrigger}
                      onPress={() => setOpenColorKey(openColorKey === row.key ? null : row.key)}
                      accessibilityLabel={`展开${row.label}预设色板`}
                    >
                      <View style={[styles.swatch, { backgroundColor: effective }]} />
                      <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />
                    </Pressable>
                  </View>
                  <TextInput
                    key={`${row.key}-${state.revision}`}
                    style={styles.colorInput}
                    defaultValue={current}
                    onChangeText={(text) => debouncedSave(row.key, text)}
                    placeholder={row.placeholder}
                    placeholderTextColor={theme.colors.foregroundMuted}
                  />
                  {openColorKey === row.key ? (
                    <ColorPaletteRow
                      value={current}
                      theme={theme}
                      onPick={(hex) => {
                        save({ [row.key]: hex } as Partial<Values>);
                        setOpenColorKey(null);
                      }}
                      onFollowTheme={() => {
                        save({ [row.key]: "" } as Partial<Values>);
                        setOpenColorKey(null);
                      }}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        </SettingsGroup>

        <SettingsAction
          label="重置全部配置"
          hint="恢复所有默认值"
          actionLabel="重置"
          onPress={() => void state.reset()}
        />
        {state.saving ? <Text style={styles.hint}>保存中…</Text> : null}
        {state.saveError ? <Text style={styles.errorText}>保存失败:{state.saveError}</Text> : null}
      </ScrollView>
    </View>
  );
}
