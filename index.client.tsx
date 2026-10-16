import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GraphPanel } from "./client/panel";
import { AgentGraphSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const stopPanel = client.addWorkspacePanel({
    id: "agent-graph",
    title: "Agent Graph",
    icon: "Workflow",
    context: "workspace",
    Component: GraphPanel,
  });
  const stopCommand = client.addCommandCenterItem({
    id: "open-agent-graph",
    title: "Open Agent Graph",
    icon: "Workflow",
    keywords: ["agents", "graph", "节点图", "关系图"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("agent-graph");
    },
  });
  const stopSettings = client.addSettingsScreen({
    id: "agent-graph-settings",
    title: "Agent Graph 设置",
    icon: "Settings2",
    Component: AgentGraphSettingsScreen,
  });
  return () => {
    void stopPanel();
    void stopCommand();
    void stopSettings();
  };
}
