import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleCreateTaskFromTemplate,
  handleImportTemplate,
  prevalidateConfigs,
} from "../server/templates.ts";
import type { TemplateNodeConfig } from "../shared/template-model.ts";

/** server handler 的最小 mock PaseoApi:覆盖 handleImportTemplate/handleCreateTaskFromTemplate 用到的面 */
function makePaseo(opts: {
  workspace?: Record<string, unknown> | null;
  directory?: { agent: Record<string, unknown> }[];
  snapshots?: Record<string, Record<string, unknown>>;
  available?: { provider: string; available: boolean; error?: string | null }[];
  models?: Record<string, Record<string, unknown>[]>;
  modes?: Record<string, { id: string }[]>;
  /** listFeatures 返回目录,key 为 "provider/model" 组合串 */
  features?: Record<string, unknown[]>;
  /** 设置后 listFeatures 抛错,消息即该值 */
  failFeatures?: string;
  /** 设置后 listModes 抛错,消息即该值 */
  failModes?: string;
  /** 返回错误消息则该次 create 抛错 */
  failCreateAt?: (input: Record<string, unknown>, index: number) => string | null;
  /** 返回错误消息则该次 send 抛错(仍记录调用,便于断言) */
  failSendAt?: (agentId: string, text: string, messageId: string | undefined, index: number) => string | null;
}) {
  const createCalls: Record<string, unknown>[] = [];
  const sendCalls: {
    agentId: string;
    text: string;
    messageId?: string;
    activeTurnBehavior?: string;
  }[] = [];
  const refreshCalls: string[] = [];
  let createIndex = 0;
  let sendIndex = 0;
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
        send: async (text: string, sendOpts?: { messageId?: string; activeTurnBehavior?: string }) => {
          const index = sendIndex;
          sendIndex += 1;
          sendCalls.push({
            agentId: id,
            text,
            messageId: sendOpts?.messageId,
            activeTurnBehavior: sendOpts?.activeTurnBehavior,
          });
          const error = opts.failSendAt?.(id, text, sendOpts?.messageId, index);
          if (error) throw new Error(error);
        },
      }),
    },
    providers: {
      listAvailable: async () => {
        if (!opts.available) throw new Error("provider 目录不可用");
        return { providers: opts.available };
      },
      listModels: async (provider: string) => ({ models: opts.models?.[provider] ?? [] }),
      listModes: async (provider: string) => {
        if (opts.failModes) throw new Error(opts.failModes);
        return { modes: opts.modes?.[provider] ?? [] };
      },
      listFeatures: async (draft: { provider: string; cwd: string }) => {
        if (opts.failFeatures) throw new Error(opts.failFeatures);
        return { features: opts.features?.[draft.provider] ?? [] };
      },
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

test("handler 建树:拓扑序创建、父子正确、prompt 最后只发主节点并附名册", async () => {
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
  assert.deepEqual(result.sendErrors, []);
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
  // prompt 只发主节点,末尾自动附子 Agent 名册;带稳定 messageId 与 steer
  assert.equal(mock.sendCalls.length, 1);
  const [sent] = mock.sendCalls;
  assert.equal(sent.agentId, "agent-1");
  assert.equal(sent.messageId, "agent-graph-templates:r1:prompt");
  assert.equal(sent.activeTurnBehavior, "steer");
  assert.ok(sent.text.startsWith("hello\n\n---\n[子 Agent 名册]"));
  assert.ok(sent.text.includes("agent-2:a(模板节点「a」,待你派发)"));
  assert.ok(sent.text.includes("agent-3:b(模板节点「b」,待你派发)"));
  // 主节点自己不进名册
  assert.ok(!sent.text.includes("agent-1:"));
});

test("handler 建树:同 runId 重试产生相同创建与发送幂等 key", async () => {
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
  // 主节点无启动指令/任务 prompt,但存在子 Agent → 兜底名册通知;重试 messageId 相同
  assert.deepEqual(
    first.sendCalls.map((call) => call.messageId),
    second.sendCalls.map((call) => call.messageId),
  );
  assert.deepEqual(first.sendCalls.map((call) => call.messageId), ["agent-graph-templates:r9:roster"]);
});

test("handler 建树:逐节点启动指令按拓扑序发送,主节点任务 prompt 末尾带名册标注", async () => {
  const mock = makePaseo({ workspace: { id: "ws1", title: "WS" }, ...OK_PROBE });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "总任务",
      runId: "r1",
      nodes: [
        node({ key: "root", prompt: "  root-start  " }),
        node({ key: "a", parentKey: "root", title: "编码", prompt: "a-start" }),
        node({ key: "b", parentKey: "root", title: "Review", prompt: "   " }),
      ],
    },
    mock,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.sendErrors, []);
  // 拓扑序:先 root 启动指令,再子节点启动指令,最后主节点任务 prompt
  assert.deepEqual(
    mock.sendCalls.map((call) => ({ agentId: call.agentId, messageId: call.messageId })),
    [
      { agentId: "agent-1", messageId: "agent-graph-templates:r1:prompt:root" },
      { agentId: "agent-2", messageId: "agent-graph-templates:r1:prompt:a" },
      { agentId: "agent-1", messageId: "agent-graph-templates:r1:prompt" },
    ],
  );
  // 启动指令 trim 后发送,且全部显式 steer,避免后发消息打断先发指令;
  // 主节点的启动指令同样搭载名册(此时任务 prompt 也带,双保险不丢)
  assert.ok(mock.sendCalls[0].text.startsWith("root-start\n\n---\n[子 Agent 名册]"));
  assert.equal(mock.sendCalls[1].text, "a-start");
  assert.ok(mock.sendCalls.every((call) => call.activeTurnBehavior === "steer"));
  // 主节点任务 prompt 带名册:a 已带启动指令(空白 prompt 的 b 视为待派发)
  const mainText = mock.sendCalls[2].text;
  assert.ok(mainText.startsWith("总任务\n\n---\n[子 Agent 名册]"));
  assert.ok(mainText.includes("agent-2:编码(模板节点「a」,已带启动指令)"));
  assert.ok(mainText.includes("agent-3:Review(模板节点「b」,待你派发)"));
});

test("handler 建树:主节点无启动指令也无任务 prompt → 兜底名册通知", async () => {
  const mock = makePaseo({ workspace: { id: "ws1", title: "WS" }, ...OK_PROBE });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "   ",
      runId: "r1",
      nodes: [node({ key: "root" }), node({ key: "a", parentKey: "root", title: "编码" })],
    },
    mock,
  );
  assert.equal(result.ok, true);
  assert.equal(mock.sendCalls.length, 1);
  const [sent] = mock.sendCalls;
  assert.equal(sent.agentId, "agent-1");
  assert.equal(sent.messageId, "agent-graph-templates:r1:roster");
  assert.equal(sent.activeTurnBehavior, "steer");
  assert.ok(sent.text.startsWith("你的子 Agent 已创建并就绪,等待你的安排:"));
  assert.ok(sent.text.includes("[子 Agent 名册]"));
  assert.ok(sent.text.includes("agent-2:编码(模板节点「a」,待你派发)"));
});

test("handler 建树:主节点有启动指令时不再重复发兜底名册", async () => {
  const mock = makePaseo({ workspace: { id: "ws1", title: "WS" }, ...OK_PROBE });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", prompt: "root-start" }), node({ key: "a", parentKey: "root" })],
    },
    mock,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    mock.sendCalls.map((call) => call.messageId),
    ["agent-graph-templates:r1:prompt:root"],
  );
  // 任务 prompt 为空时,名册搭载在主节点的启动指令上(唯一搭载机会,不能丢)
  assert.ok(mock.sendCalls[0]!.text.startsWith("root-start\n\n---\n[子 Agent 名册]"));
  assert.ok(mock.sendCalls[0]!.text.includes("待你派发"));
});

test("handler 建树:单条发送失败收集 sendErrors、不回滚、任务 prompt 继续发送", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    ...OK_PROBE,
    failSendAt: (_agentId, text) => (text === "a-start" ? "send boom" : null),
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "总任务",
      runId: "r1",
      nodes: [
        node({ key: "root" }),
        node({ key: "a", parentKey: "root", prompt: "a-start" }),
        node({ key: "b", parentKey: "root" }),
      ],
    },
    mock,
  );
  // 树创建成功即 ok;发送失败只通过 sendErrors 暴露
  assert.equal(result.ok, true);
  assert.equal(result.createdAgentIds.length, 3);
  assert.deepEqual(result.sendErrors, [
    { key: "a", agentId: "agent-2", error: "启动指令发送失败:send boom" },
  ]);
  // 失败不回滚,后续主节点任务 prompt(含名册)仍发送
  assert.equal(mock.sendCalls.length, 2);
  assert.equal(mock.sendCalls[1].agentId, "agent-1");
  assert.equal(mock.sendCalls[1].messageId, "agent-graph-templates:r1:prompt");
  assert.ok(mock.sendCalls[1].text.startsWith("总任务\n\n---\n"));
});

test("handler 建树:主节点任务 prompt 发送失败同样收集 sendErrors,不改变建树成功", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    ...OK_PROBE,
    failSendAt: (_agentId, _text, messageId) => (messageId?.endsWith(":prompt") ? "prompt boom" : null),
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "总任务",
      runId: "r1",
      nodes: [node({ key: "root" }), node({ key: "a", parentKey: "root" })],
    },
    mock,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.sendErrors, [
    { key: "root", agentId: "agent-1", error: "任务 prompt 发送失败:prompt boom" },
  ]);
  assert.equal(result.createdAgentIds.length, 2);
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

/** Codex 真实速度 descriptor(select service_tier) */
const SPEED_FEATURE = {
  type: "select",
  id: "service_tier",
  label: "Speed",
  value: "default",
  options: [
    { id: "default", label: "Normal", isDefault: true },
    { id: "priority", label: "Fast" },
  ],
};

const SPEED_WORKSPACE = { id: "ws1", title: "WS", workspaceDirectory: "/repo" };

test("handler 建树:有效速度 select → config.featureValues 传入(不是 features 键)", async () => {
  const mock = makePaseo({
    workspace: SPEED_WORKSPACE,
    ...OK_PROBE,
    features: { "codex/gpt-5.5": [SPEED_FEATURE] },
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", speedFeatureId: "service_tier", speedFeatureValue: "priority" })],
    } as never,
    mock,
  );
  assert.equal(result.ok, true);
  const config = mock.createCalls[0].config as Record<string, unknown>;
  assert.deepEqual(config.featureValues, { service_tier: "priority" });
  assert.equal(config.modeId, undefined);
});

test("handler 建树:有效 modeId → config.modeId 传入;速度 toggle → featureValues 布尔", async () => {
  const mock = makePaseo({
    workspace: SPEED_WORKSPACE,
    available: [{ provider: "codex", available: true }],
    models: { codex: [{ id: "gpt-5.5" }] },
    modes: { codex: [{ id: "acceptEdits" }, { id: "bypassPermissions" }] },
    features: { "codex/gpt-5.5": [{ type: "toggle", id: "priority_speed", label: "Speed", value: false }] },
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [
        node({ key: "root", modeId: "acceptEdits", speedFeatureId: "priority_speed", speedFeatureValue: true }),
      ],
    } as never,
    mock,
  );
  assert.equal(result.ok, true);
  const config = mock.createCalls[0].config as Record<string, unknown>;
  assert.equal(config.modeId, "acceptEdits");
  assert.deepEqual(config.featureValues, { priority_speed: true });
});

test("handler 建树:速度 toggle 显式关闭(false)→ featureValues 保留 false", async () => {
  const mock = makePaseo({
    workspace: SPEED_WORKSPACE,
    ...OK_PROBE,
    features: { "codex/gpt-5.5": [{ type: "toggle", id: "priority_speed", label: "Speed", value: true }] },
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [
        node({ key: "root", speedFeatureId: "priority_speed", speedFeatureValue: false }),
      ],
    } as never,
    mock,
  );
  assert.equal(result.ok, true);
  const config = mock.createCalls[0].config as Record<string, unknown>;
  assert.deepEqual(config.featureValues, { priority_speed: false });
});

test("handler 建树:modeId 预检 fail-closed(目录空/拉取失败/未知模式)→ 均零创建", async () => {
  const input = (
    modeId: string,
  ) => ({
    workspaceId: "ws1",
    title: "任务",
    prompt: "",
    runId: "r1",
    nodes: [node({ key: "root", modeId })],
  });
  const base = {
    workspace: { id: "ws1", title: "WS" },
    available: [{ provider: "codex", available: true }],
    models: { codex: [{ id: "gpt-5.5" }] },
  };
  // 模式目录成功但为空 []:显式 modeId 无法确认 → 拒绝
  const emptyDir = makePaseo({ ...base, modes: { codex: [] } });
  const r1 = await handleCreateTaskFromTemplate(input("acceptEdits") as never, emptyDir);
  assert.equal(r1.ok, false);
  assert.equal(emptyDir.createCalls.length, 0);
  assert.ok(r1.validationErrors.some((e) => e.includes("模式目录为空")));
  // 模式目录拉取失败 → 拒绝
  const failed = makePaseo({ ...base, failModes: "boom" });
  const r2 = await handleCreateTaskFromTemplate(input("acceptEdits") as never, failed);
  assert.equal(r2.ok, false);
  assert.equal(failed.createCalls.length, 0);
  assert.ok(r2.validationErrors.some((e) => e.includes("模式目录拉取失败")));
  // 未知模式 → 拒绝
  const unknown = makePaseo({ ...base, modes: { codex: [{ id: "default" }] } });
  const r3 = await handleCreateTaskFromTemplate(input("acceptEdits") as never, unknown);
  assert.equal(r3.ok, false);
  assert.equal(unknown.createCalls.length, 0);
  assert.ok(r3.validationErrors.some((e) => e.includes("acceptEdits")));
});

test("handler 建树:速度选项非法/目录为空/拉取失败/缺 cwd → 均拒绝且零创建", async () => {
  const base = {
    workspace: SPEED_WORKSPACE,
    ...OK_PROBE,
  };
  // 选项不在 descriptor 内
  const badOption = makePaseo({
    ...base,
    features: { "codex/gpt-5.5": [SPEED_FEATURE] },
  });
  const r1 = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", speedFeatureId: "service_tier", speedFeatureValue: "turbo" })],
    } as never,
    badOption,
  );
  assert.equal(r1.ok, false);
  assert.equal(badOption.createCalls.length, 0);
  assert.ok(r1.validationErrors.some((e) => e.includes("turbo")));

  // 提供方目录为空(无速度特性)→ 显式速度拒绝
  const noSpeed = makePaseo({ ...base, features: { "codex/gpt-5.5": [] } });
  const r2 = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", speedFeatureId: "service_tier", speedFeatureValue: "priority" })],
    } as never,
    noSpeed,
  );
  assert.equal(r2.ok, false);
  assert.equal(noSpeed.createCalls.length, 0);
  assert.ok(r2.validationErrors.some((e) => e.includes("未提供速度特性")));

  // 目录拉取失败 → 拒绝
  const failed = makePaseo({ ...base, failFeatures: "boom" });
  const r3 = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", speedFeatureId: "service_tier", speedFeatureValue: "priority" })],
    } as never,
    failed,
  );
  assert.equal(r3.ok, false);
  assert.equal(failed.createCalls.length, 0);
  assert.ok(r3.validationErrors.some((e) => e.includes("速度特性目录拉取失败")));

  // workspace 缺目录信息 → 无法确认,拒绝
  const noCwd = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    ...OK_PROBE,
    features: { "codex/gpt-5.5": [SPEED_FEATURE] },
  });
  const r4 = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", speedFeatureId: "service_tier", speedFeatureValue: "priority" })],
    } as never,
    noCwd,
  );
  assert.equal(r4.ok, false);
  assert.equal(noCwd.createCalls.length, 0);
  assert.ok(r4.validationErrors.some((e) => e.includes("缺少目录信息")));

  // 无速度配置的节点不受影响(缺 cwd 也能创建)
  const plain = makePaseo({ workspace: { id: "ws1", title: "WS" }, ...OK_PROBE });
  const r5 = await handleCreateTaskFromTemplate(
    { workspaceId: "ws1", title: "任务", prompt: "", runId: "r1", nodes: [node({ key: "root" })] } as never,
    plain,
  );
  assert.equal(r5.ok, true);
});

test("handler 建树:成对校验(速度缺取值)→ 树校验拒绝", async () => {
  const mock = makePaseo({
    workspace: SPEED_WORKSPACE,
    ...OK_PROBE,
    features: { "codex/gpt-5.5": [SPEED_FEATURE] },
  });
  const result = await handleCreateTaskFromTemplate(
    {
      workspaceId: "ws1",
      title: "任务",
      prompt: "",
      runId: "r1",
      nodes: [node({ key: "root", speedFeatureId: "service_tier" })],
    } as never,
    mock,
  );
  assert.equal(result.ok, false);
  assert.equal(mock.createCalls.length, 0);
  assert.ok(result.validationErrors.some((e) => e.includes("缺少取值")));
});

test("handler 导入:快照 features 采集速度节点字段", async () => {
  const mock = makePaseo({
    workspace: { id: "ws1", title: "WS" },
    directory: [{ agent: { id: "a1", workspaceId: "ws1", archivedAt: null, createdAt: "1", labels: {} } }],
    snapshots: {
      a1: {
        id: "a1",
        title: "带速度",
        provider: "codex",
        model: "gpt-6.1-sol",
        thinkingOptionId: null,
        currentModeId: null,
        features: [
          {
            type: "select",
            id: "service_tier",
            label: "Speed",
            value: "priority",
            options: [{ id: "default", label: "Normal" }, { id: "priority", label: "Fast" }],
          },
        ],
        archivedAt: null,
        createdAt: "1",
        labels: {},
      },
    },
  });
  const result = await handleImportTemplate({ workspaceId: "ws1" }, mock);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].speedFeatureId, "service_tier");
  assert.equal(result.nodes[0].speedFeatureValue, "priority");
});
