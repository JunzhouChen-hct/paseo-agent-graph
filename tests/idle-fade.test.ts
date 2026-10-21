import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_IDLE_FADE_TIERS,
  IDLE_FADE_TIER_LIMIT,
  idleMsSince,
  resolveIdleTier,
  type IdleFadeTierConfig,
} from "../shared/idle-fade.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function at(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

const TIERS: IdleFadeTierConfig[] = [
  { afterMinutes: 30, opacity: 0.6, autoArchive: false },
  { afterMinutes: 120, opacity: 0.1, autoArchive: true },
];

test("resolveIdleTier 三档边界:阈值整点即命中该档", () => {
  assert.equal(resolveIdleTier(TIERS, 0), null);
  assert.equal(resolveIdleTier(TIERS, 29 * 60_000), null);
  // 30 分钟整即命中短时间档
  assert.equal(resolveIdleTier(TIERS, 30 * 60_000), TIERS[0]);
  assert.equal(resolveIdleTier(TIERS, 119 * 60_000), TIERS[0]);
  // 2 小时整命中长时间档:取"阈值 ≤ 空闲时长"中阈值最大的一档
  assert.equal(resolveIdleTier(TIERS, 120 * 60_000), TIERS[1]);
  assert.equal(resolveIdleTier(TIERS, 24 * 60 * 60_000), TIERS[1]);
});

test("resolveIdleTier 宽进:档位无序成立,非法阈值忽略,空列表不命中", () => {
  const unordered: IdleFadeTierConfig[] = [
    { afterMinutes: 120, opacity: 0.1, autoArchive: false },
    { afterMinutes: 30, opacity: 0.6, autoArchive: false },
  ];
  assert.equal(resolveIdleTier(unordered, 45 * 60_000), unordered[1]);
  assert.equal(
    resolveIdleTier([{ afterMinutes: 0, opacity: 0.5, autoArchive: false }], 60_000),
    null,
  );
  assert.equal(
    resolveIdleTier([{ afterMinutes: Number.NaN, opacity: 0.5, autoArchive: false }], 60_000),
    null,
  );
  assert.equal(resolveIdleTier([], 999 * 60_000), null);
});

test("idleMsSince 宽进:缺失/非法/未来时刻返回 null", () => {
  assert.equal(idleMsSince(null, NOW), null);
  assert.equal(idleMsSince(undefined, NOW), null);
  assert.equal(idleMsSince("", NOW), null);
  assert.equal(idleMsSince("not-a-date", NOW), null);
  // 时钟偏差:活动时刻在未来不产生正空闲时长
  assert.equal(idleMsSince(new Date(NOW + 60_000).toISOString(), NOW), null);
  assert.equal(idleMsSince(at(30), NOW), 30 * 60_000);
});

test("默认档位与上限:与首版内置行为一致", () => {
  assert.deepEqual(DEFAULT_IDLE_FADE_TIERS, [
    { afterMinutes: 30, opacity: 0.6, autoArchive: false },
    { afterMinutes: 120, opacity: 0.1, autoArchive: false },
  ]);
  assert.equal(IDLE_FADE_TIER_LIMIT, 6);
});
