import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeMobileEntry, graphPanelTarget } from "../client/mobile-entry";

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
  const stop = contributeMobileEntry(h.client, "agent-graph-mobile");
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
  const stop = contributeMobileEntry(h.client, "agent-graph-mobile");
  stop();
  h.bootstrap();
  await tick();
  assert.equal(h.buttons.size, 0);
  assert.equal(h.released, 1);
});
