import { Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeMobileEntry, createWorkspaceGraphPanels, graphPanelTarget } from "./client/mobile-entry";
import { GraphPanel } from "./client/panel";
import { AgentGraphSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const target = graphPanelTarget(Platform.OS);
  // 桌面/web:单一静态面板——"+"菜单只出现一个 Agent Graph 入口,命令中心/标题栏
  // 打开时显式携带当前 workspaceId,由宿主把标签绑定到对应工作区。
  // 原生手机:保留按工作区懒注册的专属面板(原生标签身份曾出现跨项目复用,见
  // createWorkspaceGraphPanels),两条路径都经 workspacePanels.open。
  const isNative = target.id === "agent-graph-mobile";
  const stopPanel = isNative
    ? undefined
    : client.addWorkspacePanel({
        id: target.id,
        locations: [target.location],
        title: "Agent Graph",
        icon: "Workflow",
        context: "workspace",
        Component: GraphPanel,
      });
  const openInWorkspace = (workspaceId: string) => {
    if (isNative) workspacePanels.open(workspaceId);
    else client.openPanel(target.id, { workspaceId, location: target.location });
  };
  const workspacePanels = createWorkspaceGraphPanels(client, target.id, GraphPanel);
  const stopCommand = client.addCommandCenterItem({
    id: "open-agent-graph",
    title: "Open Agent Graph",
    icon: "Workflow",
    keywords: ["agents", "graph", "节点图", "关系图"],
    context: "workspace",
    onSelect({ workspace }) {
      openInWorkspace(workspace.id);
    },
  });
  const stopSettings = client.addSettingsScreen({
    id: "agent-graph-settings",
    title: "Agent Graph 设置",
    icon: "Settings2",
    Component: AgentGraphSettingsScreen,
  });
  const stopMobileEntry = contributeMobileEntry(client, openInWorkspace);
  return () => {
    stopMobileEntry();
    workspacePanels.dispose();
    if (stopPanel) void stopPanel();
    void stopCommand();
    void stopSettings();
  };
}
