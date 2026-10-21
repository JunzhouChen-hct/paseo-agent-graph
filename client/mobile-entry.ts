import { createElement, type ComponentType } from "react";
import { debugReportRpc } from "../shared/graph.ts";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";

/** 原生手机使用独立标签 ID，避免复用到历史上不可见的面板位置。
 * 桌面及手机浏览器保留原来的工作区标签；窄屏布局由 compact 决定。 */
export function graphPanelTarget(platform: string) {
  return { id: platform === "web" ? "agent-graph" : "agent-graph-mobile", location: "workspace" as const };
}

/** 面板标签的宿主身份只包含插件和面板 ID；为每个工作区分配独立身份。
 * 编码不依赖随机数或字符替换，避免不同工作区被归一为同一个 ID。 */
export function workspaceGraphPanelId(baseId: string, workspaceId: string): string {
  return `${baseId}-ws-${Array.from(workspaceId, (char) => char.codePointAt(0)!.toString(16)).join("-")}`;
}

/** 只在首次打开时注册工作区专属面板，入口和命令中心共用。
 * 渲染也绑定目标工作区，不能从旧标签的 props 继承到其他项目。 */
export function createWorkspaceGraphPanels(
  client: PluginClientContext,
  baseId: string,
  Component: ComponentType<PluginWorkspacePanelProps>,
) {
  const panels = new Map<string, ReturnType<PluginClientContext["addWorkspacePanel"]>>();
  let stopped = false;
  return {
    open(workspaceId: string) {
      if (stopped) return;
      const targetWorkspaceId = workspaceId.trim();
      if (!targetWorkspaceId) throw new Error("无法确定节点图所属工作区");
      const id = workspaceGraphPanelId(baseId, targetWorkspaceId);
      if (!panels.has(id)) {
        panels.set(id, client.addWorkspacePanel({
          id, title: "Agent Graph", icon: "Workflow", context: "workspace", locations: ["workspace"],
          Component: (props) => createElement(Component, { ...props, workspaceId: targetWorkspaceId }),
        }));
      }
      client.openPanel(id, { workspaceId: targetWorkspaceId, location: "workspace" });
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      for (const cleanup of panels.values()) void cleanup();
      panels.clear();
    },
  };
}

function openWorkspaceGraphFromHeader(
  client: PluginClientContext,
  workspaceId: string,
  openWorkspaceGraph: (workspaceId: string) => void,
) {
  void client.rpc(debugReportRpc, { payload: JSON.stringify({
    event: "graph-header-open", entryVersion: "workspace-factory-v3", workspaceId,
  }) }).catch(() => undefined);
  openWorkspaceGraph(workspaceId);
}

/** 每次调用创建独立的参数作用域，按钮动作不捕获目录遍历变量。
 * 手机真实日志曾出现所有动作指向目录末项；这里沿用 progress 的工厂绑定方式。 */
export function registerWorkspaceGraphButton(
  client: PluginClientContext,
  workspaceId: string,
  openWorkspaceGraph: (workspaceId: string) => void,
) {
  return client.addHeaderButton({
    id: workspaceGraphPanelId("open-agent-graph", workspaceId),
    workspaceId,
    button: {
      title: "打开节点图", icon: "Workflow", label: "节点图",
      // bind 将目标保存到函数绑定参数，不依赖移动端运行时的循环闭包捕获。
      behavior: { kind: "action", onPress: openWorkspaceGraphFromHeader.bind(null, client, workspaceId, openWorkspaceGraph) },
    },
  });
}

/** 给手机的每个工作区提供快捷入口；只观察目录，不创建工作区或会话。 */
export function contributeMobileEntry(client: PluginClientContext, openWorkspaceGraph: (workspaceId: string) => void) {
  const buttons = new Map<string, ReturnType<PluginClientContext["addHeaderButton"]>>();
  let stopped = false;
  let generation = 0;
  let unsubscribe: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  const ids = new Set<string>();
  let pending: Array<{ id: string; remove: boolean }> | null = null;

  const sync = () => {
    if (stopped) return;
    for (const id of ids) {
      if (buttons.has(id)) continue;
      buttons.set(id, registerWorkspaceGraphButton(client, id, openWorkspaceGraph));
    }
    for (const [id, button] of buttons) {
      if (!ids.has(id)) { button.remove(); buttons.delete(id); }
    }
  };
  const apply = ({ id, remove }: { id: string; remove: boolean }) => {
    if (remove) ids.delete(id); else ids.add(id);
  };

  void client.paseo.workspaces.list({ page: { limit: 200 }, subscribe: {} }).then(({ subscription }) => {
    release = () => subscription.release();
    if (stopped) { void release().catch(() => undefined); return; }
    unsubscribe = subscription.subscribe({
      snapshot(first) {
        const current = ++generation;
        pending = [];
        void (async () => {
          const collected = new Set(first.entries.map((workspace) => workspace.id));
          let info = first.pageInfo;
          while (info.hasMore && info.nextCursor) {
            const page = await client.paseo.workspaces.list({ page: { limit: 200, cursor: info.nextCursor } });
            info = page.pageInfo;
            if (stopped || current !== generation) return;
            for (const workspace of page.entries) collected.add(workspace.id);
          }
          if (stopped || current !== generation) return;
          ids.clear();
          for (const id of collected) ids.add(id);
          for (const change of pending ?? []) apply(change);
          pending = null;
          sync();
        })().catch((error: unknown) => {
          if (stopped || current !== generation) return;
          // 分页失败仍保留首批入口及实时更新；命令中心入口始终可用。
          for (const workspace of first.entries) ids.add(workspace.id);
          for (const change of pending ?? []) apply(change);
          pending = null;
          sync();
          console.warn("[agent-graph] 手机入口目录分页失败", error);
        });
      },
      update(message) {
        if (stopped || message.type !== "workspace_update") return;
        const update = message.payload;
        const change = update.kind === "upsert"
          ? { id: update.workspace.id, remove: false }
          : { id: update.id, remove: true };
        if (pending) pending.push(change);
        else { apply(change); sync(); }
      },
      error(error) { if (!stopped) console.warn("[agent-graph] 手机入口目录订阅失败", error); },
    });
  }).catch((error: unknown) => {
    if (!stopped) console.warn("[agent-graph] 手机入口加载失败，可从命令中心打开", error);
  });

  return () => {
    stopped = true;
    generation++;
    pending = null;
    unsubscribe?.();
    void release?.().catch(() => undefined);
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };
}
