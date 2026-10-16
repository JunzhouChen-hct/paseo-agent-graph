import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATE_MAX_NODES,
  buildTemplateFromSnapshots,
  makeIdempotencyKey,
  matchProjectDefault,
  nextNodeKey,
  normalizeCwd,
  parentOptionsFor,
  projectDefaultKeys,
  topoOrder,
  validateTemplateNodes,
  type ImportableAgentSnapshot,
  type TemplateNodeConfig,
} from "../shared/template-model";

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

function snap(overrides: Partial<ImportableAgentSnapshot> & { id: string }): ImportableAgentSnapshot {
  return {
    title: overrides.id,
    provider: "codex",
    model: "gpt-5.5",
    thinkingOptionId: null,
    modeId: null,
    archivedAt: null,
    createdAt: overrides.id,
    labels: {},
    ...overrides,
  };
}

test("树校验:合法单根树通过", () => {
  const nodes = [
    node({ key: "n1" }),
    node({ key: "n2", parentKey: "n1" }),
    node({ key: "n3", parentKey: "n1" }),
    node({ key: "n4", parentKey: "n2" }),
  ];
  assert.deepEqual(validateTemplateNodes(nodes), { ok: true, errors: [] });
});

test("树校验:重复 key / 缺失父引用 / 多根 / key 格式", () => {
  assert.ok(!validateTemplateNodes([node({ key: "n1" }), node({ key: "n1" })]).ok);
  const missing = validateTemplateNodes([node({ key: "n1" }), node({ key: "n2", parentKey: "ghost" })]);
  assert.ok(missing.errors.some((e) => e.includes("ghost")));
  const twoRoots = validateTemplateNodes([node({ key: "n1" }), node({ key: "n2" })]);
  assert.ok(twoRoots.errors.some((e) => e.includes("2 个")));
  assert.ok(!validateTemplateNodes([node({ key: "bad key" })]).ok);
});

test("树校验:环检测", () => {
  const cycle = validateTemplateNodes([
    node({ key: "n1", parentKey: "n2" }),
    node({ key: "n2", parentKey: "n1" }),
  ]);
  assert.ok(!cycle.ok);
  assert.ok(cycle.errors.some((e) => e.includes("环")));
  // 自环
  assert.ok(!validateTemplateNodes([node({ key: "n1", parentKey: "n1" })]).ok);
});

test("树校验:空树与超上限", () => {
  assert.ok(!validateTemplateNodes([]).ok);
  const tooMany = Array.from({ length: TEMPLATE_MAX_NODES + 1 }, (_, i) => {
    const cfg = node({ key: `n${i}` });
    return i === 0 ? cfg : { ...cfg, parentKey: "n0" };
  });
  assert.ok(!validateTemplateNodes(tooMany).ok);
  const exactMax = Array.from({ length: TEMPLATE_MAX_NODES }, (_, i) => {
    const cfg = node({ key: `n${i}` });
    return i === 0 ? cfg : { ...cfg, parentKey: "n0" };
  });
  assert.ok(validateTemplateNodes(exactMax).ok);
});

test("拓扑排序:父先于子;环不可排", () => {
  const nodes = [
    node({ key: "root" }),
    node({ key: "a", parentKey: "root" }),
    node({ key: "b", parentKey: "a" }),
    node({ key: "c", parentKey: "root" }),
  ];
  const order = topoOrder(nodes);
  assert.ok(order.ok);
  const position = new Map(order.order.map((n, i) => [n.key, i] as const));
  assert.ok(position.get("root")! < position.get("a")!);
  assert.ok(position.get("a")! < position.get("b")!);
  assert.ok(position.get("root")! < position.get("c")!);
  assert.ok(!topoOrder([node({ key: "x", parentKey: "y" })]).ok);
});

test("拓扑序前缀性质:部分失败时已创建集合满足父先于子", () => {
  const nodes = [
    node({ key: "root" }),
    node({ key: "a", parentKey: "root" }),
    node({ key: "b", parentKey: "a" }),
    node({ key: "c", parentKey: "root" }),
  ];
  const order = topoOrder(nodes);
  assert.ok(order.ok);
  // 模拟第 3 个节点失败:created 为前缀;每个已创建节点的父都已创建
  const created = order.order.slice(0, 2);
  const keys = new Set(created.map((n) => n.key));
  for (const item of created) {
    if (item.parentKey) assert.ok(keys.has(item.parentKey));
  }
});

test("幂等 key:同 runId 稳定,不同 runId 隔离", () => {
  assert.equal(makeIdempotencyKey("r1", "n1"), makeIdempotencyKey("r1", "n1"));
  assert.notEqual(makeIdempotencyKey("r1", "n1"), makeIdempotencyKey("r2", "n1"));
  assert.notEqual(makeIdempotencyKey("r1", "n1"), makeIdempotencyKey("r1", "n2"));
});

test("nextNodeKey 避让已占用 key", () => {
  assert.equal(nextNodeKey([node({ key: "n1" })]), "n2");
  assert.equal(nextNodeKey([node({ key: "n1" }), node({ key: "n2" })]), "n3");
  assert.equal(nextNodeKey([]), "n1");
});

test("parentOptionsFor:排除自身与后代;主节点不可改父", () => {
  const nodes = [
    node({ key: "root" }),
    node({ key: "a", parentKey: "root" }),
    node({ key: "b", parentKey: "a" }),
    node({ key: "c", parentKey: "root" }),
  ];
  const choices = parentOptionsFor(nodes, "a").map((n) => n.key);
  assert.deepEqual(choices, ["root", "c"]);
  assert.deepEqual(parentOptionsFor(nodes, "root"), []);
});

test("导入:过滤归档节点并计数", () => {
  const result = buildTemplateFromSnapshots(
    [
      snap({ id: "a", createdAt: "1" }),
      snap({ id: "b", createdAt: "2", archivedAt: "2026-01-01" }),
      snap({ id: "c", createdAt: "3" }),
    ],
    { suggestedName: "草稿" },
  );
  assert.equal(result.skippedArchived, 1);
  // 两个未归档节点互为独立根 → 生成虚拟主节点,共 3 个节点
  assert.equal(result.nodes.length, 3);
  assert.equal(result.virtualRoot, true);
  assert.ok(result.notes.some((note) => note.includes("1 个已归档")));
});

test("导入:父被归档的节点成为根,保持配置完整", () => {
  const result = buildTemplateFromSnapshots(
    [
      snap({ id: "parent", createdAt: "1", archivedAt: "2026-01-01" }),
      snap({
        id: "child",
        createdAt: "2",
        provider: "claude",
        model: "claude-opus-4-5",
        thinkingOptionId: "high",
        modeId: "acceptEdits",
        labels: { "paseo.parent-agent-id": "parent" },
      }),
    ],
    { suggestedName: "草稿" },
  );
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].parentKey, null);
  assert.equal(result.nodes[0].provider, "claude");
  assert.equal(result.nodes[0].model, "claude-opus-4-5");
  assert.equal(result.nodes[0].thinkingOptionId, "high");
  assert.equal(result.nodes[0].modeId, "acceptEdits");
  assert.ok(result.notes.some((note) => note.includes("父节点已归档")));
});

test("导入:多根生成虚拟主节点并挂接", () => {
  const result = buildTemplateFromSnapshots(
    [
      snap({ id: "r1", createdAt: "1", provider: "codex", model: "m1" }),
      snap({ id: "r2", createdAt: "2", provider: "codex", model: "m2" }),
      snap({ id: "c1", createdAt: "3", labels: { "paseo.parent-agent-id": "r2" } }),
    ],
    { suggestedName: "草稿" },
  );
  assert.equal(result.virtualRoot, true);
  const main = result.nodes.find((n) => n.key === "main");
  assert.ok(main);
  assert.equal(main!.parentKey, null);
  const r1 = result.nodes.find((n) => n.title === "r1");
  const r2 = result.nodes.find((n) => n.title === "r2");
  assert.equal(r1!.parentKey, "main");
  assert.equal(r2!.parentKey, "main");
  // 原有森林关系保留:c1 仍挂在 r2 下
  assert.equal(result.nodes.find((n) => n.title === "c1")!.parentKey, r2!.key);
  // 虚拟主节点配置取第一个根
  assert.equal(main!.model, "m1");
  assert.ok(result.notes.some((note) => note.includes("虚拟主节点")));
});

test("导入:单根不生成虚拟主节点", () => {
  const result = buildTemplateFromSnapshots(
    [
      snap({ id: "r", createdAt: "1" }),
      snap({ id: "c", createdAt: "2", labels: { "paseo.parent-agent-id": "r" } }),
    ],
    { suggestedName: "草稿" },
  );
  assert.equal(result.virtualRoot, false);
  assert.equal(result.nodes.length, 2);
});

test("导入:超过上限截断并给出提示", () => {
  const snaps = Array.from({ length: TEMPLATE_MAX_NODES + 5 }, (_, i) => snap({ id: `a${i}`, createdAt: String(i) }));
  const result = buildTemplateFromSnapshots(snaps, { suggestedName: "草稿" });
  assert.ok(result.nodes.length <= TEMPLATE_MAX_NODES);
  assert.ok(result.notes.some((note) => note.includes("截断")));
});

test("导入:不复制任何消息历史或密钥字段", () => {
  const result = buildTemplateFromSnapshots(
    [snap({ id: "a", createdAt: "1", title: "带历史的节点" })],
    { suggestedName: "草稿" },
  );
  const serialized = JSON.stringify(result.nodes);
  assert.ok(!serialized.includes("timeline"));
  assert.ok(!serialized.includes("apiKey"));
  assert.ok(!serialized.includes("credential"));
});

test("项目默认匹配:projectId 优先,cwd 规范化兜底,未设置为 null", () => {
  const defaults = {
    "project:prj-1": "tpl-a",
    "cwd:/home/u/repo": "tpl-b",
  };
  assert.equal(matchProjectDefault(defaults, { projectId: "prj-1", cwd: "/home/u/repo" }), "tpl-a");
  assert.equal(matchProjectDefault(defaults, { projectId: "prj-2", cwd: "/home/u/repo/" }), "tpl-b");
  assert.equal(matchProjectDefault(defaults, { projectId: "prj-2", cwd: null }), null);
  assert.equal(matchProjectDefault({}, { projectId: null, cwd: null }), null);
});

test("projectDefaultKeys 同时给出 projectId 与规范 cwd 两种键", () => {
  assert.deepEqual(projectDefaultKeys({ projectId: "p1", cwd: "/repo/x/" }), [
    "project:p1",
    "cwd:/repo/x",
  ]);
  assert.deepEqual(projectDefaultKeys({ projectId: null, cwd: null }), []);
});

test("normalizeCwd:去尾斜杠但保留根路径", () => {
  assert.equal(normalizeCwd("/repo/x/"), "/repo/x");
  assert.equal(normalizeCwd("/repo/x//"), "/repo/x");
  assert.equal(normalizeCwd("/"), "/");
  assert.equal(normalizeCwd("  /repo  "), "/repo");
  assert.equal(normalizeCwd(""), "");
});
