import { Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeMobileEntry, createWorkspaceGraphPanels, graphPanelTarget } from "./client/mobile-entry";
import { GraphPanel } from "./client/panel";
import { AgentGraphSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const target = graphPanelTarget(Platform.OS);
  const stopPanel = client.addWorkspacePanel({
    id: target.id,
    locations: [target.location],
    title: "Agent Graph",
    icon: "Workflow",
    context: "workspace",
    Component: GraphPanel,
  });
  const workspacePanels = createWorkspaceGraphPanels(client, target.id, GraphPanel);
  const stopCommand = client.addCommandCenterItem({
    id: "open-agent-graph",
    title: "Open Agent Graph",
    icon: "Workflow",
    keywords: ["agents", "graph", "节点图", "关系图"],
    context: "workspace",
    onSelect({ workspace }) {
      workspacePanels.open(workspace.id);
    },
  });
  const stopSettings = client.addSettingsScreen({
    id: "agent-graph-settings",
    title: "Agent Graph 设置",
    icon: "Settings2",
    Component: AgentGraphSettingsScreen,
  });
  const stopMobileEntry = contributeMobileEntry(client, (workspaceId) => workspacePanels.open(workspaceId));
  return () => {
    stopMobileEntry();
    workspacePanels.dispose();
    void stopPanel();
    void stopCommand();
    void stopSettings();
  };
}
