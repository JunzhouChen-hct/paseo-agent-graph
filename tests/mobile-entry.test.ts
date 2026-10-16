import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeMobileEntry, createWorkspaceGraphPanels, graphPanelTarget, workspaceGraphPanelId } from "../client/mobile-entry";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  let observer: any;
  const buttons = new Map<string, any>();
  const opened: unknown[] = [];
  let released = 0;
  let unsubscribed = 0;
  let resolveBootstrap!: (value: unknown) => void;
  const bootstrap = new Promise((resolve) => { resolveBootstrap = resolve; });
  const subscription = {
    subscribe(value: any) { observer = value; return () => { unsubscribed++; }; },
    async release() { released++; },
  };
  const client = {
    paseo: { workspaces: { list: () => bootstrap } },
    addHeaderButton(value: any) {
      buttons.set(value.workspaceId, value);
      return { remove: () => buttons.delete(value.workspaceId) };
    },
    openPanel: (...args: unknown[]) => opened.push(args),
    rpc: async () => ({ ok: true }),
  } as unknown as PluginClientContext;
  return { client, buttons, opened, subscription,
    bootstrap: () => resolveBootstrap({ subscription }),
    get observer() { return observer; },
    get released() { return released; },
    get unsubscribed() { return unsubscribed; },
  };
}

test("手机使用独立工作区标签，浏览器保持原ID", () => {
  assert.equal(graphPanelTarget("ios").id, "agent-graph-mobile");
  assert.equal(graphPanelTarget("android").location, "workspace");
  assert.equal(graphPanelTarget("web").id, "agent-graph");
});

test("手机入口跟随工作区目录、打开正确目标并完整释放", async () => {
  const h = harness();
  const stop = contributeMobileEntry(h.client, (id) => h.client.openPanel("agent-graph-mobile", { workspaceId: id, location: "workspace" }));
  h.bootstrap();
  await tick();
  h.observer.snapshot({ entries: [{ id: "w1" }], pageInfo: { hasMore: false } });
  await tick();
  h.buttons.get("w1").button.behavior.onPress();
  assert.deepEqual(h.opened, [["agent-graph-mobile", { workspaceId: "w1", location: "workspace" }]]);
  h.observer.update({ type: "workspace_update", payload: { kind: "upsert", workspace: { id: "w2" } } });
  h.observer.update({ type: "workspace_update", payload: { kind: "remove", id: "w1" } });
  assert.deepEqual([...h.buttons.keys()], ["w2"]);
  stop();
  assert.equal(h.buttons.size, 0);
  assert.equal(h.released, 1);
  assert.equal(h.unsubscribed, 1);
});

test("卸载早于目录响应时，不创建入口且释放迟到订阅", async () => {
  const h = harness();
  const stop = contributeMobileEntry(h.client, (id) => h.client.openPanel("agent-graph-mobile", { workspaceId: id, location: "workspace" }));
  stop();
  h.bootstrap();
  await tick();
  assert.equal(h.buttons.size, 0);
  assert.equal(h.released, 1);
});


test("两个项目分别打开、来回切换时，不复用其他工作区的图", () => {
  const panels = new Map<string, any>();
  // 模拟宿主按面板 ID 复用标签；相同 ID 会保留首次打开的工作区。
  const tabs = new Map<string, string>();
  const opened: string[] = [];
  let disposed = 0;
  const client = {
    addWorkspacePanel(panel: any) {
      panels.set(panel.id, panel);
      return () => { disposed++; panels.delete(panel.id); };
    },
    openPanel(id: string, options: { workspaceId: string }) {
      if (!tabs.has(id)) tabs.set(id, options.workspaceId);
      opened.push(tabs.get(id)!);
    },
  } as unknown as PluginClientContext;
  const Component = () => null;
  const registry = createWorkspaceGraphPanels(client, "agent-graph-mobile", Component);
  registry.open("project-a-workspace");
  registry.open("project-b-workspace");
  registry.open("project-a-workspace");
  assert.deepEqual(opened, ["project-a-workspace", "project-b-workspace", "project-a-workspace"]);
  assert.equal(panels.size, 2);
  const id = workspaceGraphPanelId("agent-graph-mobile", "project-b-workspace");
  const rendered = panels.get(id).Component({ workspaceId: "project-a-workspace" });
  assert.equal(rendered.props.workspaceId, "project-b-workspace");
  assert.notEqual(workspaceGraphPanelId("agent-graph", "w_a"), workspaceGraphPanelId("agent-graph", "w-a"));
  registry.dispose();
  registry.dispose();
  assert.equal(disposed, 2);
  registry.open("project-c-workspace");
  assert.equal(panels.size, 0);
});


test("跨工作区的快捷按钮身份不同，按按钮 ID 分发也不会命中其他项目", async () => {
  const h = harness();
  const actions = new Map<string, () => void>();
  const opened: string[] = [];
  h.client.addHeaderButton = (value: any) => {
    // 覆盖旧实现遗漏的按钮层：相同按钮 ID 会覆盖动作，而非按工作区二次索引。
    actions.set(value.id, value.button.behavior.onPress);
    return { update() {}, remove: () => { actions.delete(value.id); } };
  };
  const stop = contributeMobileEntry(h.client, (id) => opened.push(id));
  h.bootstrap();
  await tick();
  h.observer.snapshot({ entries: [{ id: "paseo-project" }, { id: "gitkrab-project" }], pageInfo: { hasMore: false } });
  await tick();
  assert.equal(actions.size, 2);
  actions.get(workspaceGraphPanelId("open-agent-graph", "paseo-project"))!();
  actions.get(workspaceGraphPanelId("open-agent-graph", "gitkrab-project"))!();
  actions.get(workspaceGraphPanelId("open-agent-graph", "paseo-project"))!();
  assert.deepEqual(opened, ["paseo-project", "gitkrab-project", "paseo-project"]);
  stop();
  assert.equal(actions.size, 0);
});
