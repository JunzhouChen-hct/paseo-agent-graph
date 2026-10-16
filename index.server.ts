import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentGraphSettings } from "./shared/settings";
import { agentGraphTemplatesSettings } from "./shared/templates";
import { acceptAgentRpc, cancelAgentRpc, configureAgentRpc, debugReportRpc, renameAgentRpc } from "./shared/graph";
import { agentMetadataRpc } from "./shared/agent-metadata";
import { importTemplateRpc, createTaskFromTemplateRpc } from "./shared/templates";
import { closeDaemon, handleAccept, handleCancel, handleConfigure, handleDebugReport, handleRename } from "./server/cancel";
import { handleAgentMetadata } from "./server/agent-metadata";
import { handleCreateTaskFromTemplate, handleImportTemplate } from "./server/templates";

export default function contribute(server: PluginServerContext) {
  // 注册 settings 存储:宿主据此接管 settings.* RPC(read/write/reset)
  server.registerSettings(agentGraphSettings);
  server.registerSettings(agentGraphTemplatesSettings);
  server.handle(cancelAgentRpc, handleCancel);
  server.handle(configureAgentRpc, handleConfigure);
  server.handle(acceptAgentRpc, handleAccept);
  server.handle(renameAgentRpc, handleRename);
  server.handle(debugReportRpc, handleDebugReport);
  server.handle(agentMetadataRpc, handleAgentMetadata);
  server.handle(importTemplateRpc, handleImportTemplate);
  server.handle(createTaskFromTemplateRpc, handleCreateTaskFromTemplate);
  return () => {
    void closeDaemon();
  };
}
