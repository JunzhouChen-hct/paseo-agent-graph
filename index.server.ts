import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentGraphSettings } from "./shared/settings";
import { agentGraphTemplatesSettings } from "./shared/templates";
import { cancelAgentRpc, configureAgentRpc, debugReportRpc } from "./shared/graph";
import { importTemplateRpc, createTaskFromTemplateRpc } from "./shared/templates";
import { closeDaemon, handleCancel, handleConfigure, handleDebugReport } from "./server/cancel";
import { handleCreateTaskFromTemplate, handleImportTemplate } from "./server/templates";

export default function contribute(server: PluginServerContext) {
  // 注册 settings 存储:宿主据此接管 settings.* RPC(read/write/reset)
  server.registerSettings(agentGraphSettings);
  server.registerSettings(agentGraphTemplatesSettings);
  server.handle(cancelAgentRpc, handleCancel);
  server.handle(configureAgentRpc, handleConfigure);
  server.handle(debugReportRpc, handleDebugReport);
  server.handle(importTemplateRpc, handleImportTemplate);
  server.handle(createTaskFromTemplateRpc, handleCreateTaskFromTemplate);
  return () => {
    void closeDaemon();
  };
}
