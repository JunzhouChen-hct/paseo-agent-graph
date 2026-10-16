import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleCreateTaskFromTemplate,
  handleImportTemplate,
  prevalidateConfigs,
} from "../server/templates";
import type { TemplateNodeConfig } from "../shared/template-model";

/** server handler 的最小 mock PaseoApi:覆盖 handleImportTemplate/handleCreateTaskFromTemplate 用到的面 */
function makePaseo(opts: {
  workspace?: Record<string, unknown> | null;
  directory?: { agent: Record<string, unknown> }[];
  snapshots?: Record<string, Record<string, unknown>>;
  available?: { provider: string; available: boolean; error?: string | null }[];
  models?: Record<string, Record<string, unknown>[]>;
  modes?: Record<string, { id: string }[]>;
  /** 返回错误消息则该次 create 抛错 */
  failCreateAt?: (input: Record<string, unknown>, index: number) => string | null;
}) {
  const createCalls: Record<string, unknown>[] = [];
  const sendCalls: { agentId: string; text: string; messageId?: string }[] = [];
  const refreshCalls: string[] = [];
  let createIndex = 0;
  const paseo = {
    workspaces: {
      ref: () => ({
        refresh: async () => (opts.workspace === undefined ? null : (opts.workspace ?? null)),
        agents: {
          create: async (input: Record<string, unknown>) => {
            const error = opts.failCreateAt?.(input, createIndex);
            createIndex += 1;
            if (error) throw new Error(error);
            createCalls.push(input);
            return { id: `agent-${createCalls.length}` };
          },
        },
      }),
    },
    agents: {
      list: async () => ({ entries: opts.directory ?? [], pageInfo: { nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => {
          refreshCalls.push(id);
          const snapshot = opts.snapshots?.[id];
          return snapshot ? { agent: snapshot, project: null } : null;
        },
        send: async (text: string, sendOpts?: { messageId?: string }) => {
          sendCalls.push({ agentId: id, text, messageId: sendOpts?.messageId });
        },
      }),
    },
    providers: {
      listAvailable: async () => {
        if (!opts.available) throw new Error("provider 目录不可用");
        return { providers: opts.available };
      },
      listModels: async (provider: string) => ({ models: opts.models?.[provider] ?? [] }),
      listModes: async (provider: string) => ({ modes: opts.modes?.[provider] ?? [] }),
    },
  };
  return {
    paseo: paseo as unknown as import("@getpaseo/client").PaseoApi,
    createCalls,
    sendCalls,
    refreshCalls,
  };
}

function node(overrides: Partial<TemplateNodeConfig> & { key: string }): TemplateNodeConfig {
  return {
    parentKey: null,
    title: overrides.key,
    provider: "codex",
    model: "gpt-5.5",
    thinkingOptionId: null,
    ...overrides,
  };
}

const OK_PROBE = {
  available: [{ provider: "codex", available: true }],
  models: { codex: [{ id: "gpt-5.5", thinkingOptions: [{ id: "high" }] }] },
};

test("handler 建树:拓扑序创建、父子正确、prompt 最后只发主节点", async () => {
  const mock = makePaseo({ workspace: { id: "ws1", title: "WS" }, ...OK_PROBE });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "hello",
      runId: "r1",
      nodes: [node({ key: "root" }), node({ key: "a", parentKey: "root" }), node({ key: "b", parentKey: "a" })],
    },
    mock,
  );
  assert.equal(result.ok, true);
  assert.equal(result.rootAgentId, "agent-1");
  assert.equal(result.createdAgentIds.length, 3);
  // 顺序:root → a → b;主节点标题=任务标题,子节点标题=模板标题;均无 prompt
  assert.deepEqual(
    mock.createCalls.map((call) => ({
      provider: (call.config as { provider: string }).provider,
      parent: call.parent ?? null,
      title: call.title,
      idempotencyKey: call.idempotencyKey,
    })),
    [
      { provider: "codex/gpt-5.5", parent: null, title: "任务", idempotencyKey: "agent-graph-templates:r1:root" },
      { provider: "codex/gpt-5.5", parent: "agent-1", title: "a", idempotencyKey: "agent-graph-templates:r1:a" },
      { provider: "codex/gpt-5.5", parent: "agent-2", title: "b", idempotencyKey: "agent-graph-templates:r1:b" },
    ],
  );
  // prompt 只发主节点,且带稳定 messageId
  assert.deepEqual(mock.sendCalls, [
    { agentId: "agent-1", text: "hello", messageId: "agent-graph-templates:r1:prompt" },
  ]);
});

test("handler 建树:同 runId 重试产生相同幂等 key", async () => {
  const nodes = [node({ key: "root" }), node({ key: "a", parentKey: "root" })];
  const first = makePaseo({ workspace: { id: "ws1" }, ...OK_PROBE });
  const second = makePaseo({ workspace: { id: "ws1" }, ...OK_PROBE });
  const input = { workspaceId: "ws1", title: "任务", prompt: "", runId: "r9", nodes };
  await handleCreateTaskFromTemplate(input as never, first);
  await handleCreateTaskFromTemplate(input as never, second);
  assert.deepEqual(
    first.createCalls.map((call) => call.idempotencyKey),
    second.createCalls.map((call) => call.idempotencyKey),
  );
});

test("handler 建树:模型不在目录 → 预检拒绝,零创建", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1" },
    available: [{ provider: "codex", available: true }],
    models: { codex: [{ id: "gpt-5.5" }] },
  });
  const result = await handleCreateTaskFromTemplate(
    { workspaceId: "ws1", title: "任务", prompt: "", runId: "r1", nodes: [node({ key: "root", model: "ghost" })] } as never,
    mock,
  );
  assert.equal(result.ok, false);
  assert.equal(result.createdAgentIds.length, 0);
  assert.equal(mock.createCalls.length, 0);
  assert.ok(result.validationErrors.some((e) => e.includes("ghost")));
});

test("handler 建树:模型目录为空 → 显式 model 拒绝而非跳过", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1" },
    available: [{ provider: "codex", available: true }],
    models: { codex: [] },
  });
  const result = await handleCreateTaskFromTemplate(
    { workspaceId: "ws1", title: "任务", prompt: "", runId: "r1", nodes: [node({ key: "root" })] } as never,
    mock,
  );
  assert.equal(result.ok, false);
  assert.equal(mock.createCalls.length, 0);
  assert.ok(result.validationErrors.some((e) => e.includes("模型目录为空")));
});

test("handler 建树:思考强度不受模型支持 → 拒绝", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1" },
    available: [{ provider: "codex", available: true }],
    models: { codex: [{ id: "gpt-5.5", thinkingOptions: [{ id: "high" }] }] },
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", thinkingOptionId: "ultra" })],
    } as never,
    mock,
  );
  assert.equal(result.ok, false);
  assert.equal(mock.createCalls.length, 0);
  assert.ok(result.validationErrors.some((e) => e.includes("ultra")));
  // 模型无任何思考强度选项时同样拒绝
  const mock2 = makePaseo({
    workspace: { id: "ws1" },
    available: [{ provider: "codex", available: true }],
    models: { codex: [{ id: "gpt-5.5" }] },
  });
  const result2 = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", thinkingOptionId: "high" })],
    } as never,
    mock2,
  );
  assert.ok(result2.validationErrors.some((e) => e.includes("无思考强度选项")));
});

test("handler 建树:provider 目录拉取失败 → 全部拒绝", async () => {
  const mock = makePaseo({ workspace: { id: "ws1" } });
  const result = await handleCreateTaskFromTemplate(
    { workspaceId: "ws1", title: "任务", prompt: "", runId: "r1", nodes: [node({ key: "root" })] } as never,
    mock,
  );
  assert.equal(result.ok, false);
  assert.equal(mock.createCalls.length, 0);
  assert.ok(result.validationErrors.some((e) => e.includes("提供方目录拉取失败")));
});

test("handler 建树:部分失败 → 返回已创建前缀与主节点 id,不回滚", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    ...OK_PROBE,
    failCreateAt: (_input, index) => (index === 1 ? "boom" : null),
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "hello",
      runId: "r1",
      nodes: [node({ key: "root" }), node({ key: "a", parentKey: "root" })],
    },
    mock,
  );
  assert.equal(result.ok, false);
  assert.equal(result.rootAgentId, "agent-1");
  assert.deepEqual(result.createdAgentIds, [{ key: "root", agentId: "agent-1" }]);
  assert.ok((result.error ?? "").includes("boom"));
  assert.ok((result.error ?? "").includes("1 个节点"));
  // prompt 不应发送(整树未成功)
  assert.equal(mock.sendCalls.length, 0);
});

test("handler 导入:120 归档 + 1 活跃 → 只刷新活跃节点,导入 1 个", async () => {
  const directory: { agent: Record<string, unknown> }[] = [];
  for (let i = 0; i < 120; i += 1) {
    directory.push({
      agent: {
        id: `archived-${i}`,
        workspaceId: "ws1",
        archivedAt: "2026-01-01",
        createdAt: String(i).padStart(4, "0"),
        labels: {},
      },
    });
  }
  directory.push({
    agent: { id: "live-1", workspaceId: "ws1", archivedAt: null, createdAt: "9999", labels: {} },
  });
  const mock = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    directory,
    snapshots: {
      "live-1": {
        id: "live-1",
        title: "唯一活跃",
        provider: "codex",
        model: "gpt-5.5",
        thinkingOptionId: "high",
        currentModeId: null,
        archivedAt: null,
        createdAt: "9999",
        labels: {},
      },
    },
  });
  const result = await handleImportTemplate({ workspaceId: "ws1" }, mock);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.skippedArchived, 120);
  assert.equal(result.truncated, false);
  assert.deepEqual(mock.refreshCalls, ["live-1"]);
});

test("handler 导入:刷新后才发现归档 → 仍排除", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    directory: [{ agent: { id: "a1", workspaceId: "ws1", archivedAt: null, createdAt: "1", labels: {} } }],
    snapshots: {
      a1: {
        id: "a1",
        provider: "codex",
        model: "gpt-5.5",
        archivedAt: "2026-02-01",
        createdAt: "1",
        labels: {},
      },
    },
  });
  const result = await handleImportTemplate({ workspaceId: "ws1" }, mock);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.skippedArchived, 1);
});

test("handler 导入:活跃超刷新预算 → truncated 且有明确 notes", async () => {
  const directory = Array.from({ length: 125 }, (_, i) => ({
    agent: { id: `a${i}`, workspaceId: "ws1", archivedAt: null, createdAt: String(i).padStart(4, "0"), labels: {} },
  }));
  const snapshots: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 125; i += 1) {
    snapshots[`a${i}`] = {
      id: `a${i}`,
      title: `节点${i}`,
      provider: "codex",
      model: "gpt-5.5",
      thinkingOptionId: null,
      currentModeId: null,
      archivedAt: null,
      createdAt: String(i).padStart(4, "0"),
      labels: {},
    };
  }
  const mock = makePaseo({ workspace: { id: "ws1", title: "WS" }, directory, snapshots });
  const result = await handleImportTemplate({ workspaceId: "ws1" }, mock);
  assert.equal(result.truncated, true);
  assert.ok(result.notes.some((note) => note.includes("不完整") || note.includes("上限")));
  // 125 活跃:预算 120 → 快照 120 个;超过 30 上限后构建器截断并预留虚拟主节点
  assert.ok(result.nodes.length <= 31);
});

test("handler 导入:刷新失败 → 计入 truncated 与 notes,不静默丢节点", async () => {
  const snapshots: Record<string, Record<string, unknown>> = {
    a1: { id: "a1", provider: "codex", model: "gpt-5.5", archivedAt: null, createdAt: "1", labels: {} },
  };
  const mock = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    directory: [
      { agent: { id: "a1", workspaceId: "ws1", archivedAt: null, createdAt: "1", labels: {} } },
      { agent: { id: "a2", workspaceId: "ws1", archivedAt: null, createdAt: "2", labels: {} } },
    ],
    snapshots,
  });
  // a2 的 refresh 抛错:mock 用缺 snapshot 返回 null 视作失败
  const result = await handleImportTemplate({ workspaceId: "ws1" }, mock);
  assert.equal(result.truncated, true);
  assert.ok(result.notes.some((note) => note.includes("刷新失败")));
  assert.equal(result.nodes.length, 1);
});

test("prevalidateConfigs:modeId 不在目录 → 拒绝;目录缺该 provider → 拒绝", async () => {
  const mock = makePaseo({
    available: [{ provider: "codex", available: true }],
    models: { codex: [{ id: "gpt-5.5" }] },
    modes: { codex: [{ id: "default" }] },
  });
  const errors = await prevalidateConfigs(
    mock.paseo,
    [node({ key: "n1", modeId: "acceptEdits" })],
  );
  assert.ok(errors.some((e) => e.includes("acceptEdits")));
  const errors2 = await prevalidateConfigs(
    mock.paseo,
    [node({ key: "n1", provider: "ghost-provider" })],
  );
  assert.ok(errors2.some((e) => e.includes("ghost-provider")));
});
