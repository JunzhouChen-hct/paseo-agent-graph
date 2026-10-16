import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentGraphSettings } from "./shared/settings";
import { cancelAgentRpc, configureAgentRpc, debugReportRpc } from "./shared/graph";
import { closeDaemon, handleCancel, handleConfigure, handleDebugReport } from "./server/cancel";

export default function contribute(server: PluginServerContext) {
  // 注册 settings 存储:宿主据此接管 settings.* RPC(read/write/reset)
  server.registerSettings(agentGraphSettings);
  server.handle(cancelAgentRpc, handleCancel);
  server.handle(configureAgentRpc, handleConfigure);
  server.handle(debugReportRpc, handleDebugReport);
  return () => {
    void closeDaemon();
  };
}
