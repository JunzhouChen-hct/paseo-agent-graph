import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentGraphTemplatesSettings,
  mergeDraftIntoDoc,
  validateTemplateDocument,
} from "../shared/templates";
import type { TemplateRecord } from "../shared/templates";
import type { TemplateNodeConfig } from "../shared/template-model";

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

function doc(templates: TemplateRecord[], defaults: Record<string, string> = {}) {
  return { templates, defaults };
}

test("文档校验:合法文档通过", () => {
  const value = doc(
    [
      { id: "t1", name: "评审", nodes: [node({ key: "n1" }), node({ key: "n2", parentKey: "n1" })] },
      { id: "t2", name: "构建", nodes: [node({ key: "root" })] },
    ],
    { "project:p1": "t1" },
  );
  assert.deepEqual(validateTemplateDocument(value), []);
});

test("文档校验:模板 id 重复", () => {
  const value = doc([
    { id: "t1", name: "a", nodes: [node({ key: "n1" })] },
    { id: "t1", name: "b", nodes: [node({ key: "n1" })] },
  ]);
  assert.ok(validateTemplateDocument(value).some((e) => e.includes("id 重复")));
});

test("文档校验:空名称与非法树", () => {
  const value = doc([
    { id: "t1", name: "  ", nodes: [node({ key: "n1" })] },
    { id: "t2", name: "坏树", nodes: [node({ key: "n1" }), node({ key: "n1", parentKey: "n1" })] },
  ]);
  const errors = validateTemplateDocument(value);
  assert.ok(errors.some((e) => e.includes("名称不能为空")));
  assert.ok(errors.some((e) => e.includes("坏树")));
});

test("文档校验:defaults 悬挂引用与空引用", () => {
  const value = doc([{ id: "t1", name: "a", nodes: [node({ key: "n1" })] }], {
    "project:p1": "t1",
    "project:p2": "ghost",
    "cwd:/x": "",
  });
  const errors = validateTemplateDocument(value);
  assert.ok(errors.some((e) => e.includes("ghost")));
  assert.ok(errors.some((e) => e.includes("引用为空")));
});

test("settings schema:空文档解析为默认值", () => {
  const parsed = agentGraphTemplatesSettings.schema.safeParse({});
  assert.ok(parsed.success);
  if (parsed.success) {
    assert.deepEqual(parsed.data.templates, []);
    assert.deepEqual(parsed.data.defaults, {});
  }
});

test("settings schema:重复模板 id 被拒绝", () => {
  const parsed = agentGraphTemplatesSettings.schema.safeParse({
    templates: [
      { id: "t1", name: "a", nodes: [node({ key: "n1" })] },
      { id: "t1", name: "b", nodes: [node({ key: "n1" })] },
    ],
  });
  assert.ok(!parsed.success);
  assert.ok(JSON.stringify(parsed.error.issues).includes("id 重复"));
});

test("settings schema:defaults 悬挂引用被拒绝", () => {
  const parsed = agentGraphTemplatesSettings.schema.safeParse({
    templates: [{ id: "t1", name: "a", nodes: [node({ key: "n1" })] }],
    defaults: { "project:p1": "ghost" },
  });
  assert.ok(!parsed.success);
  assert.ok(JSON.stringify(parsed.error.issues).includes("默认模板引用不存在"));
});

test("settings schema:非法树(环)被拒绝", () => {
  const parsed = agentGraphTemplatesSettings.schema.safeParse({
    templates: [
      {
        id: "t1",
        name: "a",
        nodes: [node({ key: "n1", parentKey: "n2" }), node({ key: "n2", parentKey: "n1" })],
      },
    ],
  });
  assert.ok(!parsed.success);
});

test("settings schema:旧文档(无 modeId 之外的采集字段)解析不受新字段影响", () => {
  // 旧版本落盘的节点只有基础字段;新字段全部 optional,必须原样解析通过
  const parsed = agentGraphTemplatesSettings.schema.safeParse({
    templates: [
      { id: "t1", name: "旧模板", nodes: [{ key: "n1", parentKey: null, title: "", provider: "codex", model: "gpt-5.5", thinkingOptionId: null }] },
    ],
    defaults: {},
  });
  assert.ok(parsed.success);
  if (parsed.success) {
    const old = parsed.data.templates[0].nodes[0];
    assert.equal(old.modeId, undefined);
    assert.equal(old.speedFeatureId, undefined);
    assert.equal(old.speedFeatureValue, undefined);
  }
});

test("settings schema:新速度字段成对写入可通过,半配置被拒绝", () => {
  const good = agentGraphTemplatesSettings.schema.safeParse({
    templates: [
      {
        id: "t1",
        name: "新模板",
        nodes: [node({ key: "n1", modeId: "acceptEdits", speedFeatureId: "service_tier", speedFeatureValue: "priority" })],
      },
    ],
  });
  assert.ok(good.success);
  // 缺取值 → superRefine 拒绝
  const half = agentGraphTemplatesSettings.schema.safeParse({
    templates: [{ id: "t1", name: "新模板", nodes: [node({ key: "n1", speedFeatureId: "service_tier" })] }],
  });
  assert.ok(!half.success);
  // 缺 id → 拒绝
  const orphan = agentGraphTemplatesSettings.schema.safeParse({
    templates: [{ id: "t1", name: "新模板", nodes: [node({ key: "n1", speedFeatureValue: true })] }],
  });
  assert.ok(!orphan.success);
});

test("mergeDraftIntoDoc:以最新文档为底,草稿覆盖同 id,defaults 取最新", () => {
  const latest = doc(
    [
      { id: "t1", name: "旧a", nodes: [node({ key: "n1" })] },
      { id: "t2", name: "b", nodes: [node({ key: "root" })] },
    ],
    { "project:p1": "t2" },
  );
  const draft: TemplateRecord = { id: "t1", name: "我的草稿", nodes: [node({ key: "n9" })] };
  const merged = mergeDraftIntoDoc(latest, draft);
  assert.equal(merged.templates.length, 2);
  assert.equal(merged.templates.find((t) => t.id === "t1")?.name, "我的草稿");
  assert.equal(merged.templates.find((t) => t.id === "t2")?.name, "b");
  assert.deepEqual(merged.defaults, { "project:p1": "t2" });
  // 入参未被修改
  assert.equal(latest.templates[0].name, "旧a");
  assert.equal(latest.templates.length, 2);
});

test("mergeDraftIntoDoc:草稿 id 不在最新文档时追加", () => {
  const latest = doc([{ id: "t2", name: "b", nodes: [node({ key: "root" })] }], {});
  const draft: TemplateRecord = { id: "t3", name: "新增", nodes: [node({ key: "n1" })] };
  const merged = mergeDraftIntoDoc(latest, draft);
  assert.equal(merged.templates.length, 2);
  assert.ok(merged.templates.some((t) => t.id === "t3"));
});
