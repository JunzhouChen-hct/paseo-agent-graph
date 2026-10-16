import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { acceptAgentRpc, cancelAgentRpc, configureAgentRpc, debugReportRpc } from "../shared/graph";

interface DaemonLease {
  client: DaemonClient;
  ready: Promise<DaemonClient>;
}

// SDK 的 PaseoApi 没有暴露 cancelAgent；这里借 internal/daemon-client 建一条
// 独立的本地连接来发 cancel。鉴权读取 ~/.paseo/local-credential（与 CLI 同源）。
let lease: DaemonLease | null = null;

function daemonListen(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  try {
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      daemon?: { listen?: string };
    };
    if (typeof config.daemon?.listen === "string" && config.daemon.listen.includes(":")) {
      return config.daemon.listen;
    }
  } catch {
    // 读不到就用默认值
  }
  return "127.0.0.1:6767";
}

function acquireDaemon(): Promise<DaemonClient> {
  if (lease) return lease.ready;
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const credentialPath = join(home, "local-credential");
  const [host, port] = daemonListen().split(":");
  const client = new DaemonClient({
    url: `ws://${host}:${port}/ws`,
    clientId: `paseo-agent-graph-${randomUUID()}`,
    clientType: "cli",
    localCredential: () => readFileSync(credentialPath, "utf8").trim(),
    reconnect: { enabled: false },
    connectTimeoutMs: 4000,
  });
  const ready = client
    .connect()
    .then(() => client)
    .catch((error: unknown) => {
      lease = null;
      throw error;
    });
  lease = { client, ready };
  return ready;
}

export async function closeDaemon(): Promise<void> {
  const current = lease;
  lease = null;
  if (!current) return;
  try {
    await current.client.close();
  } catch {
    // 清理阶段的关闭失败无需上报
  }
}

export async function handleCancel({ agentId }: RpcInput<typeof cancelAgentRpc>) {
  try {
    const daemon = await acquireDaemon();
    await daemon.cancelAgent(agentId);
    return { ok: true, error: null };
  } catch (error) {
    lease = null;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function handleDebugReport({ payload }: RpcInput<typeof debugReportRpc>) {
  console.log("[agent-graph:client]", payload);
  return { ok: true };
}

/** 验收"待验收":先取 daemon 最新快照 fresh 复核,仅 idle + finished 关注才 clear。
 *  daemon 的 clear_agent_attention 本身不区分原因,误调会连 permission/error
 *  一起清掉,因此该检查必须在这里做,不能只信客户端传入时机。
 *  status 必须 idle:真实运行中可携带上一轮的 finished 关注(见 shared/graph.ts
 *  toneOf 特判),此刻回合还在跑,验收会吞掉回合一结束就出现的通知。 */
export async function handleAccept({ agentId }: RpcInput<typeof acceptAgentRpc>) {
  try {
    const daemon = await acquireDaemon();
    const result = await daemon.fetchAgent(agentId);
    const agent = result?.agent;
    if (agent?.status !== "idle" || !agent.requiresAttention || agent.attentionReason !== "finished") {
      return { ok: true, cleared: false, error: null };
    }
    await daemon.clearAgentAttention(agentId);
    return { ok: true, cleared: true, error: null };
  } catch (error) {
    lease = null;
    return { ok: false, cleared: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleConfigure({
  agentId,
  modelId,
  modeId,
  thinkingOptionId,
}: RpcInput<typeof configureAgentRpc>) {
  try {
    const daemon = await acquireDaemon();
    const errors: string[] = [];
    if (modelId !== undefined) {
      try {
        await daemon.setAgentModel(agentId, modelId);
      } catch (error) {
        errors.push(`模型:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (modeId !== undefined) {
      try {
        await daemon.setAgentMode(agentId, modeId);
      } catch (error) {
        errors.push(`模式:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (thinkingOptionId !== undefined) {
      try {
        await daemon.setAgentThinkingOption(agentId, thinkingOptionId);
      } catch (error) {
        errors.push(`思考强度:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length > 0) return { ok: false, error: errors.join("; ") };
    return { ok: true, error: null };
  } catch (error) {
    lease = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
