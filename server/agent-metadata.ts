import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import {
  DETACHED_BRANCH_LABEL,
  agentMetadataRpc,
  extractAgentMetadata,
  type AgentMetadataSnapshotLite,
  type AgentNodeMetadata,
} from "../shared/agent-metadata.ts";

/** 单个 git 查询的进程超时,防止挂死的仓库拖垮整个 RPC。 */
const GIT_TIMEOUT_MS = 1500;

/** 分支查询结果的短缓存时长:同目录批量去重后仍避免频繁开进程。 */
const BRANCH_TTL_MS = 5000;

/** 模块级共享缓存的目录条目上限,防止 workspace/agent 众多时无限增长。 */
const BRANCH_CACHE_MAX_ENTRIES = 256;

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

/** 单个目录的分支查询结果:ok=有名分支,detached=仓库存在但无分支名,unavailable=非 git/目录失效/查询失败。 */
export type BranchResult =
  | { status: "ok"; branch: string }
  | { status: "detached" }
  | { status: "unavailable" };

export interface BranchResolverOptions {
  /** 缓存 TTL;测试传 0 以便断言切分支后的最新值。 */
  ttlMs?: number;
  /** 缓存目录条目上限;超过后淘汰最旧条目,不引入无限缓存。 */
  maxEntries?: number;
  now?: () => number;
}

export type BranchResolver = (dir: string) => Promise<BranchResult>;

/**
 * 创建带短缓存的分支解析器:同目录并发查询去重(一次真实 git 进程),
 * 结果按 TTL 复用,条目数受 maxEntries 约束,过期依赖读取时 TTL 判断。
 */
export function createBranchResolver(options: BranchResolverOptions = {}): BranchResolver {
  const ttlMs = options.ttlMs ?? BRANCH_TTL_MS;
  const maxEntries = options.maxEntries ?? BRANCH_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { result: BranchResult; expiresAt: number }>();
  const pending = new Map<string, Promise<BranchResult>>();

  return async (dir: string): Promise<BranchResult> => {
    const cached = cache.get(dir);
    if (cached && cached.expiresAt > now()) return cached.result;

    // 并发去重:同一目录的排队查询共享同一次 git 进程
    const inflight = pending.get(dir);
    if (inflight) return inflight;

    const promise = (async (): Promise<BranchResult> => {
      try {
        // --abbrev-ref HEAD 在 detached HEAD 时返回 "HEAD",明确按 detached 处理,不猜分支
        const ref = (await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        if (ref && ref !== "HEAD") return { status: "ok", branch: ref };
        return { status: "detached" };
      } catch {
        // 非 git 目录 / git 不可用 → unavailable
        return { status: "unavailable" };
      }
    })();

    pending.set(dir, promise);
    try {
      const result = await promise;
      // 写入缓存并淘汰最旧条目,保证条目数有上限
      cache.set(dir, { result, expiresAt: now() + ttlMs });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return result;
    } finally {
      pending.delete(dir);
    }
  };
}

/**
 * 模块级共享解析器:同一 daemon 子进程内的所有 RPC 调用共享缓存与
 * 并发去重,同 cwd 的多个 agent 只会触发一次真实 git 查询。
 */
const sharedBranchResolver: BranchResolver = createBranchResolver();

/** 提示 label 的约定键:与面板创建子 Agent 时写入的 labels 保持一致。 */
export const WORKTREE_CWD_LABEL_KEY = "agent-graph.worktree-cwd";

/**
 * 解析 agent 的开发分支:
 * 1. 优先使用本插件创建子 Agent 时写入的分配 worktree 提示 label
 *    ('agent-graph.worktree-cwd'),但 label 只当路径提示,分支必须由
 *    对应目录的真实 git 查询得出,不允许直接把 label 内容冒充分支;
 * 2. 提示目录是有效 git 仓库但 detached HEAD 时,明确返回 detached,
 *    绝不回退 cwd 用主仓库分支冒充该 agent 的开发分支;
 * 3. 仅当提示缺失、非绝对路径、目录不存在/非 git(unavailable)时,
 *    才回退 agent.cwd;cwd 同样 detached 时也返回 detached,非 git 返回 unavailable。
 */
export async function resolveAgentBranch(
  cwd: string,
  worktreeCwdLabel: string | null | undefined,
  resolveBranch: BranchResolver,
): Promise<BranchResult> {
  if (worktreeCwdLabel) {
    const hint = worktreeCwdLabel.trim();
    if (isAbsolute(hint) && isDirectory(hint)) {
      const result = await resolveBranch(hint);
      if (result.status !== "unavailable") return result;
      // 提示目录查不到分支(已删除仓库等)→ 继续回退 cwd
    }
  }
  if (cwd && isDirectory(cwd)) {
    return resolveBranch(cwd);
  }
  return { status: "unavailable" };
}

/** BranchResult → 卡片展示的 branch 字符串;unavailable 为 null(明确不展示)。 */
function branchDisplay(result: BranchResult): string | null {
  if (result.status === "ok") return result.branch;
  if (result.status === "detached") return DETACHED_BRANCH_LABEL;
  return null;
}

/**
 * 批量查询节点元数据。快照走官方 agents.ref(id).refresh() 的完整响应
 * (含 features/effectiveThinkingOptionId/lastUsage),分支用模块级共享解析器
 * (可经 options.branchResolver 注入,测试用),带短缓存与并发去重。
 */
export async function handleAgentMetadata(
  { agentIds }: RpcInput<typeof agentMetadataRpc>,
  { paseo }: { paseo: PaseoApi },
  options: { branchResolver?: BranchResolver } = {},
): Promise<{ items: Record<string, AgentNodeMetadata | null> }> {
  const resolveBranch = options.branchResolver ?? sharedBranchResolver;

  const settled = await Promise.allSettled(
    agentIds.map(async (agentId) => {
      const refetch = await paseo.agents.ref(agentId).refresh();
      // agent 已归档/关闭或刷新失败 → 该 agent 无数据
      if (!refetch?.agent) return null;
      const snapshot = refetch.agent as AgentMetadataSnapshotLite & {
        labels?: Readonly<Record<string, string>>;
      };
      const metadata = extractAgentMetadata(snapshot);
      metadata.branch = branchDisplay(
        await resolveAgentBranch(
          snapshot.cwd ?? "",
          snapshot.labels?.[WORKTREE_CWD_LABEL_KEY] ?? null,
          resolveBranch,
        ),
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
