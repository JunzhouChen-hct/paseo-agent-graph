import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAgentMetadata, SPEED_FEATURE_ID } from "../shared/agent-metadata";
import { handleAgentMetadata } from "../server/agent-metadata";
import type { AgentMetadataSnapshotLite } from "../shared/agent-metadata";

/** 便捷构造完整快照的默认字段 */
function makeSnapshot(overrides: Partial<AgentMetadataSnapshotLite> = {}): AgentMetadataSnapshotLite {
  return {
    id: "agent-1",
    cwd: "/tmp/repo",
    labels: {},
    features: [],
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    runtimeInfo: null,
    ...overrides,
  };
}

const SPEED_OPTIONS = [
  { id: "default", label: "Normal" },
  { id: "priority", label: "Fast" },
];

test("提取:Codex 速度 select 按真实 descriptor value 取当前 label", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [
        {
          type: "select",
          id: SPEED_FEATURE_ID,
          label: "Speed",
          value: "priority",
          options: SPEED_OPTIONS,
        },
      ],
    }),
  );
  assert.deepEqual(metadata.speed, { value: "priority", label: "Fast" });
});

test("提取:速度 value 无法匹配 options 时回退展示原始 value", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [{ type: "select", id: SPEED_FEATURE_ID, label: "Speed", value: "turbo", options: SPEED_OPTIONS }],
    }),
  );
  assert.deepEqual(metadata.speed, { value: "turbo", label: "turbo" });
});

test("提取:速度 value 为 null 表示未知 → 不展示", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [{ type: "select", id: SPEED_FEATURE_ID, label: "Speed", value: null, options: SPEED_OPTIONS }],
    }),
  );
  assert.equal(metadata.speed, null);
});

test("提取:features 为空(Claude 实测)→ 无速度", () => {
  const metadata = extractAgentMetadata(makeSnapshot({ features: [] }));
  assert.equal(metadata.speed, null);
});

test("提取:toggle 与无关 select 不当速度(plan_mode 不是速度)", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [
        { type: "toggle", id: "auto_accept", label: "Auto accept", value: true },
        { type: "select", id: "plan_mode", label: "Plan mode", value: "off", options: [{ id: "off", label: "Off" }] },
      ],
    }),
  );
  assert.equal(metadata.speed, null);
});

test("提取:思考强度 effective 优先于 configured", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({ thinkingOptionId: "high", effectiveThinkingOptionId: "xhigh" }),
  );
  assert.deepEqual(metadata.thinking, { value: "xhigh", source: "effective" });
});

test("提取:无 effective 时用 configured thinkingOptionId", () => {
  const metadata = extractAgentMetadata(makeSnapshot({ thinkingOptionId: "high" }));
  assert.deepEqual(metadata.thinking, { value: "high", source: "configured" });
});

test("提取:runtimeInfo.thinkingOptionId 是最后回退", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({ runtimeInfo: { thinkingOptionId: "medium" } }),
  );
  assert.deepEqual(metadata.thinking, { value: "medium", source: "runtime" });
});

test("提取:全为空 → 思考与速度都不展示,不冒充默认值", () => {
  const metadata = extractAgentMetadata(makeSnapshot());
  assert.equal(metadata.thinking, null);
  assert.equal(metadata.speed, null);
});

test("提取:空字符串视为未报告", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({ thinkingOptionId: "", effectiveThinkingOptionId: "", runtimeInfo: { thinkingOptionId: "" } }),
  );
  assert.equal(metadata.thinking, null);
});

function makePaseo(snapshots: Record<string, object | null>) {
  const refreshCalls: string[] = [];
  return {
    refreshCalls,
    paseo: {
      agents: {
        ref: (id: string) => ({
          refresh: async () => {
            refreshCalls.push(id);
            const snapshot = snapshots[id];
            if (snapshot === undefined) throw new Error("daemon 不可达");
            return snapshot === null ? null : { agent: snapshot, project: null };
          },
        }),
      },
    } as never,
  };
}

test("handler:组装思考/速度/分支,分支取自提示 label 指向目录", async () => {
  // resolveAgentBranch 只对真实存在的绝对路径生效,用临时目录充当分配的 worktree
  const hintDir = mkdtempSync(join(tmpdir(), "paseo-agent-graph-hint-"));
  try {
    const { paseo } = makePaseo({
      "agent-a": makeSnapshot({
        id: "agent-a",
        thinkingOptionId: "high",
        effectiveThinkingOptionId: "xhigh",
        features: [{ type: "select", id: SPEED_FEATURE_ID, label: "Speed", value: "priority", options: SPEED_OPTIONS }],
        labels: { "agent-graph.worktree-cwd": hintDir },
      }),
    });
    const resolvedDirs: string[] = [];
    const result = await handleAgentMetadata(
      { agentIds: ["agent-a"] },
      { paseo },
      {
        branchResolver: async (dir) => {
          resolvedDirs.push(dir);
          return dir === hintDir ? "feature/agent-node-metadata" : "main";
        },
      },
    );
    assert.deepEqual(resolvedDirs, [hintDir], "优先用提示 label 路径,而不是 cwd");
    assert.deepEqual(result.items["agent-a"], {
      thinking: { value: "xhigh", source: "effective" },
      speed: { value: "priority", label: "Fast" },
      branch: "feature/agent-node-metadata",
    });
  } finally {
    rmSync(hintDir, { recursive: true, force: true });
  }
});

test("handler:刷新失败/无快照 → 该 agent 显式 null,不影响其余", async () => {
  const { paseo } = makePaseo({
    "agent-bad": null,
    "agent-ok": makeSnapshot({ id: "agent-ok", thinkingOptionId: "low" }),
  });
  const result = await handleAgentMetadata(
    { agentIds: ["agent-bad", "agent-ok"] },
    { paseo },
    { branchResolver: async () => null },
  );
  assert.equal(result.items["agent-bad"], null);
  assert.deepEqual(result.items["agent-ok"]?.thinking, { value: "low", source: "configured" });
});
