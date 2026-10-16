import type { PluginClientContext } from "@getpaseo/plugin/client";

/** 原生手机使用独立标签 ID，避免复用到历史上不可见的面板位置。
 * 桌面及手机浏览器保留原来的工作区标签；窄屏布局由 compact 决定。 */
export function graphPanelTarget(platform: string) {
  return { id: platform === "web" ? "agent-graph" : "agent-graph-mobile", location: "workspace" as const };
}

/** 给手机的每个工作区提供快捷入口；只观察目录，不创建工作区或会话。 */
export function contributeMobileEntry(client: PluginClientContext, panelId: string) {
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
      buttons.set(id, client.addHeaderButton({
        id: "open-agent-graph", workspaceId: id,
        button: {
          title: "打开节点图", icon: "Workflow", label: "节点图",
          behavior: { kind: "action", onPress: () => client.openPanel(panelId, { workspaceId: id, location: "workspace" }) },
        },
      }));
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
