import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import {
  agentMetadataRpc,
  extractAgentMetadata,
  type AgentMetadataSnapshotLite,
  type AgentNodeMetadata,
} from "../shared/agent-metadata";

/** 单个 git 查询的进程超时,防止挂死的仓库拖垮整个 RPC。 */
const GIT_TIMEOUT_MS = 1500;

/** 分支查询结果的短缓存时长:同目录批量去重后仍避免频繁开进程。 */
const BRANCH_TTL_MS = 5000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** execFile 固定 argv 与 cwd,不经 shell,避免分支名等输入进入命令行解释。 */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export interface BranchResolverOptions {
  /** 缓存 TTL;测试传 0 以便断言切分支后的最新值。 */
  ttlMs?: number;
  now?: () => number;
}

export type BranchResolver = (dir: string) => Promise<string | null>;

/**
 * 创建带短缓存的分支解析器:同目录并发查询去重,结果按 TTL 复用,
 * 切分支后在下一个 TTL 周期内自然刷新。
 */
export function createBranchResolver(options: BranchResolverOptions = {}): BranchResolver {
  const ttlMs = options.ttlMs ?? BRANCH_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { branch: string | null; expiresAt: number }>();
  const pending = new Map<string, Promise<string | null>>();

  return async (dir: string): Promise<string | null> => {
    const cached = cache.get(dir);
    if (cached && cached.expiresAt > now()) return cached.branch;

    // 并发去重:同一目录的排队查询共享同一次 git 进程
    const inflight = pending.get(dir);
    if (inflight) return inflight;

    const promise = (async () => {
      let branch: string | null = null;
      try {
        // --abbrev-ref HEAD 在 detached HEAD 时返回 "HEAD",明确视为无分支而非猜一个
        const ref = (await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        branch = ref && ref !== "HEAD" ? ref : null;
      } catch {
        // 非 git 目录 / git 不可用 → 明确未知
        branch = null;
      }
      cache.set(dir, { branch, expiresAt: now() + ttlMs });
      return branch;
    })();

    pending.set(dir, promise);
    try {
      return await promise;
    } finally {
      pending.delete(dir);
    }
  };
}

/** 提示 label 的约定键:与面板创建子 Agent 时写入的 labels 保持一致。 */
export const WORKTREE_CWD_LABEL_KEY = "agent-graph.worktree-cwd";

/**
 * 解析 agent 的开发分支:
 * 1. 优先使用本插件创建子 Agent 时写入的分配 worktree 提示 label
 *    ('agent-graph.worktree-cwd'),但 label 只当路径提示,分支必须由
 *    对应目录的真实 git 查询得出,不允许直接把 label 内容冒充分支;
 * 2. 提示缺失、非绝对路径、目录已失效或查不到分支时回退 agent.cwd;
 * 3. cwd 也非 git 目录时返回 null(卡片明确不展示)。
 */
export async function resolveAgentBranch(
  cwd: string,
  worktreeCwdLabel: string | null | undefined,
  resolveBranch: BranchResolver,
): Promise<string | null> {
  if (worktreeCwdLabel) {
    const hint = worktreeCwdLabel.trim();
    if (isAbsolute(hint) && isDirectory(hint)) {
      const branch = await resolveBranch(hint);
      if (branch) return branch;
    }
  }
  if (cwd && isDirectory(cwd)) {
    return resolveBranch(cwd);
  }
  return null;
}

/**
 * 批量查询节点元数据。快照走官方 agents.ref(id).refresh() 的完整响应
 * (含 features/effectiveThinkingOptionId),分支用带短缓存的 git 查询。
 */
export async function handleAgentMetadata(
  { agentIds }: RpcInput<typeof agentMetadataRpc>,
  { paseo }: { paseo: PaseoApi },
  options: { branchResolver?: BranchResolver } = {},
): Promise<{ items: Record<string, AgentNodeMetadata | null> }> {
  const resolveBranch = options.branchResolver ?? createBranchResolver();

  const settled = await Promise.allSettled(
    agentIds.map(async (agentId) => {
      const refetch = await paseo.agents.ref(agentId).refresh();
      // agent 已归档/关闭或刷新失败 → 该 agent 无数据
      if (!refetch?.agent) return null;
      const snapshot = refetch.agent as AgentMetadataSnapshotLite & {
        labels?: Readonly<Record<string, string>>;
      };
      const metadata = extractAgentMetadata(snapshot);
      metadata.branch = await resolveAgentBranch(
        snapshot.cwd ?? "",
        snapshot.labels?.[WORKTREE_CWD_LABEL_KEY] ?? null,
        resolveBranch,
      );
      return metadata;
    }),
  );

  const items: Record<string, AgentNodeMetadata | null> = {};
  agentIds.forEach((agentId, index) => {
    const result = settled[index];
    if (result.status === "fulfilled" && result.value) {
      items[agentId] = result.value;
    } else {
      if (result.status === "rejected") {
        console.error(`[agent-graph] metadata 刷新失败 ${agentId}: ${errorText(result.reason)}`);
      }
      // 查询不到的 agent 显式给 null,卡片按未知处理
      items[agentId] = null;
    }
  });
  return { items };
}
