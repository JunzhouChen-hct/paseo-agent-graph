import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explicitSpeedSelection,
  pickSpeedFeature,
  speedFeatureValuesForSelection,
  speedSelectionValid,
  type RawFeatureDescriptor,
} from "../shared/provider-speed";

/** Codex 真实目录形态:select id=service_tier,label=Speed,选项 default/priority */
const CODEX_SPEED: RawFeatureDescriptor = {
  type: "select",
  id: "service_tier",
  label: "Speed",
  value: "default",
  options: [
    { id: "default", label: "Normal", isDefault: true },
    { id: "priority", label: "Fast" },
  ],
};

test("pickSpeedFeature:识别 Codex service_tier 与 label 含 speed 的 descriptor", () => {
  const feature = pickSpeedFeature([CODEX_SPEED]);
  assert.ok(feature);
  assert.equal(feature.type, "select");
  assert.equal(feature.id, "service_tier");
  assert.equal(feature.label, "Speed");
  assert.deepEqual(feature.options?.map((option) => option.id), ["default", "priority"]);

  // id 含 speed 的其他形态也能识别
  const byId = pickSpeedFeature([{ type: "toggle", id: "fast_mode_speed", label: "快" }]);
  assert.ok(byId);
  assert.equal(byId.type, "toggle");
});

test("pickSpeedFeature:权限类/无关 descriptor 一律不当作速度", () => {
  assert.equal(pickSpeedFeature([]), null);
  assert.equal(pickSpeedFeature(null), null);
  assert.equal(pickSpeedFeature(undefined), null);
  // dsh 的 auto_accept 权限 toggle 与 plan_mode 均与速度无关
  assert.equal(
    pickSpeedFeature([
      { type: "toggle", id: "auto_accept", label: "Auto accept", value: true },
      { type: "select", id: "plan_mode", label: "Plan", value: null, options: [{ id: "a", label: "A" }] },
    ]),
    null,
  );
  // select 无选项(空目录)视为不支持
  assert.equal(
    pickSpeedFeature([{ type: "select", id: "service_tier", label: "Speed", value: null, options: [] }]),
    null,
  );
  // 未知形态(非 toggle/select)跳过,不抛错
  assert.equal(
    pickSpeedFeature([{ type: "slider", id: "speed", label: "Speed" } as unknown as RawFeatureDescriptor]),
    null,
  );
});

test("speedFeatureValuesForSelection:select 按 option id 组装,toggle 只支持开启", () => {
  const feature = pickSpeedFeature([CODEX_SPEED])!;
  assert.deepEqual(speedFeatureValuesForSelection(feature, "priority"), { service_tier: "priority" });
  assert.deepEqual(speedFeatureValuesForSelection(feature, "default"), { service_tier: "default" });
  // 非法 option id → null(不传)
  assert.equal(speedFeatureValuesForSelection(feature, "turbo"), null);
  assert.equal(speedFeatureValuesForSelection(feature, null), null);
  assert.equal(speedFeatureValuesForSelection(feature, ""), null);

  const toggle = pickSpeedFeature([{ type: "toggle", id: "priority_speed", label: "Speed" }])!;
  assert.deepEqual(speedFeatureValuesForSelection(toggle, "on"), { priority_speed: true });
  assert.equal(speedFeatureValuesForSelection(toggle, "priority"), null);
  assert.equal(speedFeatureValuesForSelection(toggle, null), null);
});

test("explicitSpeedSelection:只采集显式生效值,默认/未选不采集", () => {
  const selected = pickSpeedFeature([{ ...CODEX_SPEED, value: "priority" }])!;
  assert.deepEqual(explicitSpeedSelection(selected), { id: "service_tier", value: "priority" });
  // value 为 null(未选择)不采集
  const unset = pickSpeedFeature([{ ...CODEX_SPEED, value: null }])!;
  assert.equal(explicitSpeedSelection(unset), null);
  // value 不在选项内不采集
  const bogus = pickSpeedFeature([{ ...CODEX_SPEED, value: "ghost" }])!;
  assert.equal(explicitSpeedSelection(bogus), null);
  // toggle true 采集,false/缺省不采集
  const on = pickSpeedFeature([{ type: "toggle", id: "priority_speed", label: "Speed", value: true }])!;
  assert.deepEqual(explicitSpeedSelection(on), { id: "priority_speed", value: true });
  const off = pickSpeedFeature([{ type: "toggle", id: "priority_speed", label: "Speed", value: false }])!;
  assert.equal(explicitSpeedSelection(off), null);
});

test("speedSelectionValid:已选项在新目录仍受支持时保留", () => {
  const feature = pickSpeedFeature([CODEX_SPEED])!;
  assert.equal(speedSelectionValid(feature, "priority"), true);
  assert.equal(speedSelectionValid(feature, ""), true);
  assert.equal(speedSelectionValid(feature, null), true);
  assert.equal(speedSelectionValid(feature, "turbo"), false);
  const toggle = pickSpeedFeature([{ type: "toggle", id: "priority_speed", label: "Speed" }])!;
  assert.equal(speedSelectionValid(toggle, "on"), true);
  assert.equal(speedSelectionValid(toggle, "off"), false);
});
