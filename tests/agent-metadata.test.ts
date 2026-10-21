import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DETACHED_BRANCH_LABEL,
  METADATA_BATCH_SIZE,
  agentMetadataItemSchema,
  extractAgentMetadata,
  mergeBatchResults,
  splitBatches,
} from "../shared/agent-metadata.ts";
import type { AgentMetadataSnapshotLite, AgentNodeMetadata } from "../shared/agent-metadata.ts";
import { handleAgentMetadata, type BranchResolver } from "../server/agent-metadata.ts";

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

/** stub 解析器:记录查询目录,按映射返回结果("detached"→detached,未命中→unavailable) */
function stubResolver(byDir: Record<string, string>): BranchResolver & { dirs: string[] } {
  const dirs: string[] = [];
  const resolver = (async (dir: string) => {
    dirs.push(dir);
    const branch = byDir[dir];
    if (branch === "detached") return { status: "detached" as const };
    if (branch === undefined) return { status: "unavailable" as const };
    return { status: "ok" as const, branch };
  }) as BranchResolver & { dirs: string[] };
  resolver.dirs = dirs;
  return resolver;
}

test("提取:Codex 速度 select 按真实 descriptor value 取当前 label", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [
        { type: "select", id: "service_tier", label: "Speed", value: "priority", options: SPEED_OPTIONS },
      ],
    }),
  );
  assert.deepEqual(metadata.speed, { value: "priority", label: "Fast" });
});

test("提取:label 含 speed 的 select 同样识别", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [{ type: "select", id: "tier", label: "Model speed", value: "default", options: SPEED_OPTIONS }],
    }),
  );
  assert.deepEqual(metadata.speed, { value: "default", label: "Normal" });
});

test("提取:速度 toggle 打开/关闭按实际 value 展示,不用 catalog 默认", () => {
  const on = extractAgentMetadata(
    makeSnapshot({ features: [{ type: "toggle", id: "fast_speed", label: "Fast speed", value: true }] }),
  );
  assert.deepEqual(on.speed, { value: "on", label: "开启" });
  const off = extractAgentMetadata(
    makeSnapshot({ features: [{ type: "toggle", id: "fast_speed", label: "Fast speed", value: false }] }),
  );
  assert.deepEqual(off.speed, { value: "off", label: "关闭" });
});

test("提取:速度 value 无法匹配 options 时回退展示原始 value", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [{ type: "select", id: "service_tier", label: "Speed", value: "turbo", options: SPEED_OPTIONS }],
    }),
  );
  assert.deepEqual(metadata.speed, { value: "turbo", label: "turbo" });
});

test("提取:速度 value 为 null 表示未知 → 不展示", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      features: [
        { type: "select", id: "service_tier", label: "Speed", value: null, options: SPEED_OPTIONS },
        { type: "toggle", id: "fast_speed", label: "Fast speed", value: null },
      ],
    }),
  );
  assert.equal(metadata.speed, null);
});

test("提取:features 为空(Claude 实测)→ 无速度", () => {
  const metadata = extractAgentMetadata(makeSnapshot({ features: [] }));
  assert.equal(metadata.speed, null);
});

test("提取:auto_accept toggle 与 plan_mode select 等权限类 descriptor 不当速度", () => {
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

test("提取:上下文取 lastUsage 的 contextWindow 专用字段", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      lastUsage: {
        inputTokens: 1234,
        outputTokens: 567,
        contextWindowUsedTokens: 40_000,
        contextWindowMaxTokens: 400_000,
      },
    }),
  );
  // 累计 input/output token 不参与,只用 contextWindow 专用字段
  assert.deepEqual(metadata.context, { used: 40_000, max: 400_000 });
});

test("提取:无 lastUsage / 空 usage → context 为 null", () => {
  assert.equal(extractAgentMetadata(makeSnapshot()).context, null);
  assert.equal(extractAgentMetadata(makeSnapshot({ lastUsage: null })).context, null);
  assert.equal(extractAgentMetadata(makeSnapshot({ lastUsage: {} })).context, null);
});

test("提取:上下文负值与非有限值按未知处理", () => {
  const metadata = extractAgentMetadata(
    makeSnapshot({
      lastUsage: { contextWindowUsedTokens: -1, contextWindowMaxTokens: Number.NaN },
    }),
  );
  assert.deepEqual(metadata.context, null);
  const partial = extractAgentMetadata(
    makeSnapshot({
      lastUsage: { contextWindowUsedTokens: Number.POSITIVE_INFINITY, contextWindowMaxTokens: 200_000 },
    }),
  );
  assert.deepEqual(partial.context, { used: null, max: 200_000 });
});

test("提取:上下文 max<=0 视为未知,used 未知时不猜默认窗口", () => {
  const zeroMax = extractAgentMetadata(
    makeSnapshot({ lastUsage: { contextWindowUsedTokens: 100, contextWindowMaxTokens: 0 } }),
  );
  assert.deepEqual(zeroMax.context, { used: 100, max: null });
  const negativeMax = extractAgentMetadata(
    makeSnapshot({ lastUsage: { contextWindowMaxTokens: -5 } }),
  );
  assert.deepEqual(negativeMax.context, null);
});

test("schema:context 为 optional,旧格式条目仍通过校验", () => {
  agentMetadataItemSchema.parse({
    thinking: { value: "high", source: "effective" },
    speed: null,
    branch: null,
  });
  agentMetadataItemSchema.parse({
    thinking: null,
    speed: null,
    branch: "main",
    context: { used: null, max: 400_000 },
  });
  agentMetadataItemSchema.parse({
    thinking: null,
    speed: null,
    branch: null,
    context: null,
  });
});

test("分片:201 与 450 条按 200 上限切片", () => {
  const ids201 = Array.from({ length: 201 }, (_, index) => `agent-${index}`);
  assert.deepEqual(
    splitBatches(ids201).map((batch) => batch.length),
    [200, 1],
  );
  const ids450 = Array.from({ length: 450 }, (_, index) => `agent-${index}`);
  assert.deepEqual(
    splitBatches(ids450).map((batch) => batch.length),
    [200, 200, 50],
  );
  assert.equal(splitBatches([], METADATA_BATCH_SIZE).length, 0);
});

/** 构造一批 RPC 结果页 */
function page(ids: string[]): { items: Record<string, AgentNodeMetadata | null> } {
  const items: Record<string, AgentNodeMetadata | null> = {};
  for (const id of ids) {
    items[id] = { thinking: { value: id, source: "effective" }, speed: null, branch: null };
  }
  return { items };
}

test("合并:450 条三批结果全部合并", () => {
  const ids = Array.from({ length: 450 }, (_, index) => `agent-${index}`);
  const batches = splitBatches(ids);
  const settled = batches.map((batch) => ({ status: "fulfilled" as const, value: page(batch) }));
  const { items, failedBatches } = mergeBatchResults(batches, settled);
  assert.equal(failedBatches, 0);
  assert.equal(Object.keys(items).length, 450);
});

test("合并:单批失败不影响其他批,失败批数可见", () => {
  const ids = Array.from({ length: 201 }, (_, index) => `agent-${index}`);
  const batches = splitBatches(ids);
  const settled = [
    { status: "fulfilled" as const, value: page(batches[0]) },
    { status: "rejected" as const, reason: new Error("daemon 不可达") },
  ];
  const { items, failedBatches } = mergeBatchResults(batches, settled);
  assert.equal(failedBatches, 1);
  assert.equal(Object.keys(items).length, 200);
  assert.equal(items["agent-199"]?.thinking?.value, "agent-199");
  assert.equal(items["agent-200"], undefined);
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
        features: [{ type: "select", id: "service_tier", label: "Speed", value: "priority", options: SPEED_OPTIONS }],
        labels: { "agent-graph.worktree-cwd": hintDir },
      }),
    });
    const resolver = stubResolver({ [hintDir]: "feature/agent-node-metadata", ["/tmp/repo"]: "main" });
    const result = await handleAgentMetadata({ agentIds: ["agent-a"] }, { paseo }, { branchResolver: resolver });
    assert.deepEqual(resolver.dirs, [hintDir], "优先用提示 label 路径,而不是 cwd");
    assert.deepEqual(result.items["agent-a"], {
      thinking: { value: "xhigh", source: "effective" },
      speed: { value: "priority", label: "Fast" },
      branch: "feature/agent-node-metadata",
      context: null,
    });
  } finally {
    rmSync(hintDir, { recursive: true, force: true });
  }
});

test("handler:提示目录 detached → 明确 detached,不回退 cwd 主仓库分支", async () => {
  const hintDir = mkdtempSync(join(tmpdir(), "paseo-agent-graph-detached-"));
  try {
    const { paseo } = makePaseo({
      "agent-b": makeSnapshot({
        id: "agent-b",
        cwd: "/tmp/main-repo",
        labels: { "agent-graph.worktree-cwd": hintDir },
      }),
    });
    const resolver = stubResolver({ [hintDir]: "detached", ["/tmp/main-repo"]: "main" });
    const result = await handleAgentMetadata({ agentIds: ["agent-b"] }, { paseo }, { branchResolver: resolver });
    assert.deepEqual(resolver.dirs, [hintDir], "detached 时不得再查 cwd");
    assert.equal(result.items["agent-b"]?.branch, DETACHED_BRANCH_LABEL);
    assert.notEqual(result.items["agent-b"]?.branch, "main");
  } finally {
    rmSync(hintDir, { recursive: true, force: true });
  }
});

test("handler:提示失效回退 cwd,刷新失败/无快照 → 显式 null", async () => {
  const { paseo } = makePaseo({
    "agent-bad": null,
    "agent-ok": makeSnapshot({ id: "agent-ok", thinkingOptionId: "low" }),
  });
  const result = await handleAgentMetadata(
    { agentIds: ["agent-bad", "agent-ok"] },
    { paseo },
    { branchResolver: stubResolver({}) },
  );
  assert.equal(result.items["agent-bad"], null);
  assert.deepEqual(result.items["agent-ok"]?.thinking, { value: "low", source: "configured" });
});
