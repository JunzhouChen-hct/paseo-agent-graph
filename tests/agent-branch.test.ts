import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranchResolver, resolveAgentBranch } from "../server/agent-metadata";

/** 临时 git fixture 根目录,用例结束统一清理 */
let fixtureRoot: string | null = null;

function newFixtureRoot(): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), "paseo-agent-graph-branch-"));
  return fixtureRoot;
}

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

/** 在指定目录执行 git 命令,固定 argv,不带用户全局配置之外的 shell 参与 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

/** 建一个带一次提交的仓库,返回初始分支名(不猜测 main/master) */
function initRepo(dir: string): string {
  execFileSync("git", ["init", dir], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  // 全局配置被隔离到 /dev/null,提交身份用 -c 内联提供
  git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init");
  return git(dir, "rev-parse", "--abbrev-ref", "HEAD");
}

test("分支:普通仓库返回当前分支名", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-a");
  const initial = initRepo(repo);
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  assert.deepEqual(await resolveBranch(repo), { status: "ok", branch: initial });
});

test("分支:切分支后(短 TTL)返回新分支", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-b");
  initRepo(repo);
  git(repo, "checkout", "-b", "feature/req2");
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  assert.deepEqual(await resolveBranch(repo), { status: "ok", branch: "feature/req2" });
});

test("分支:detached HEAD 明确返回 detached,不猜分支", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-c");
  initRepo(repo);
  git(repo, "checkout", "--detach", "HEAD");
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  assert.deepEqual(await resolveBranch(repo), { status: "detached" });
});

test("分支:非 git 目录返回 unavailable", async () => {
  const root = newFixtureRoot();
  const plain = join(root, "not-a-repo");
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  assert.deepEqual(await resolveBranch(plain), { status: "unavailable" });
});

test("分支:缓存生效 —— TTL 内切分支仍返回旧值,TTL 过后刷新", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-d");
  const initial = initRepo(repo);
  let nowMs = 1000;
  const resolveBranch = createBranchResolver({ ttlMs: 5000, now: () => nowMs });
  assert.deepEqual(await resolveBranch(repo), { status: "ok", branch: initial });

  git(repo, "checkout", "-b", "feature/next");
  // TTL 内:命中缓存,仍是切分支前的旧值
  assert.deepEqual(await resolveBranch(repo), { status: "ok", branch: initial });

  // TTL 过后:拿到新分支
  nowMs += 6000;
  assert.deepEqual(await resolveBranch(repo), { status: "ok", branch: "feature/next" });
});

test("分支:并发去重 —— 同目录并发查询结果一致且全部成功", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-e");
  const initial = initRepo(repo);
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  // 并发多次调用经 pending 去重共享同一次查询,结果必须一致且正确
  const results = await Promise.all([
    resolveBranch(repo),
    resolveBranch(repo),
    resolveBranch(repo),
  ]);
  for (const result of results) {
    assert.deepEqual(result, { status: "ok", branch: initial });
  }
});

test("分支:缓存条目数受 maxEntries 约束且淘汰后仍可重新解析", async () => {
  const root = newFixtureRoot();
  const repoA = join(root, "repo-lru-a");
  const repoB = join(root, "repo-lru-b");
  const repoC = join(root, "repo-lru-c");
  initRepo(repoA);
  initRepo(repoB);
  initRepo(repoC);
  // 各仓库建唯一分支名,避免默认初始分支同名导致断言失效
  git(repoA, "checkout", "-b", "branch-a");
  git(repoB, "checkout", "-b", "branch-b");
  git(repoC, "checkout", "-b", "branch-c");
  let nowMs = 1000;
  const resolveBranch = createBranchResolver({ ttlMs: 10_000, maxEntries: 2, now: () => nowMs });
  assert.deepEqual(await resolveBranch(repoA), { status: "ok", branch: "branch-a" });
  assert.deepEqual(await resolveBranch(repoB), { status: "ok", branch: "branch-b" });
  // 第三次写入触发淘汰,缓存里最旧的 repo-a 被移除
  assert.deepEqual(await resolveBranch(repoC), { status: "ok", branch: "branch-c" });
  // repo-a 被淘汰后重新查询仍正确(重新走 git 查询)
  assert.deepEqual(await resolveBranch(repoA), { status: "ok", branch: "branch-a" });
});

test("resolveAgentBranch:提示 label 优先于 cwd 的 git 查询", async () => {
  const root = newFixtureRoot();
  const cwdRepo = join(root, "repo-main");
  const hintRepo = join(root, "wt-assigned");
  initRepo(cwdRepo);
  initRepo(hintRepo);
  git(hintRepo, "checkout", "-b", "feature/assigned");

  const result = await resolveAgentBranch(cwdRepo, hintRepo, createBranchResolver({ ttlMs: 0 }));
  assert.deepEqual(result, { status: "ok", branch: "feature/assigned" });
});

test("resolveAgentBranch:提示目录 detached → 明确 detached,不回退 cwd 主分支", async () => {
  const root = newFixtureRoot();
  const cwdRepo = join(root, "repo-cwd");
  const hintRepo = join(root, "wt-detached");
  const cwdInitial = initRepo(cwdRepo);
  initRepo(hintRepo);
  git(hintRepo, "checkout", "--detach", "HEAD");

  const result = await resolveAgentBranch(cwdRepo, hintRepo, createBranchResolver({ ttlMs: 0 }));
  assert.deepEqual(result, { status: "detached" });
  assert.notEqual(result.status === "ok" ? result.branch : null, cwdInitial, "不得用 cwd 的主分支冒充");
});

test("resolveAgentBranch:相对路径提示无效 → 回退 cwd", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-f");
  const initial = initRepo(repo);
  const result = await resolveAgentBranch(repo, "relative/wt", createBranchResolver({ ttlMs: 0 }));
  assert.deepEqual(result, { status: "ok", branch: initial });
});

test("resolveAgentBranch:提示目录已失效 → 回退 cwd", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-g");
  const initial = initRepo(repo);
  const result = await resolveAgentBranch(
    repo,
    join(root, "gone-worktree"),
    createBranchResolver({ ttlMs: 0 }),
  );
  assert.deepEqual(result, { status: "ok", branch: initial });
});

test("resolveAgentBranch:提示目录非 git → 回退 cwd", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-h");
  const plain = join(root, "plain-dir");
  const initial = initRepo(repo);
  const result = await resolveAgentBranch(repo, plain, createBranchResolver({ ttlMs: 0 }));
  assert.deepEqual(result, { status: "ok", branch: initial });
});

test("resolveAgentBranch:cwd detached → 明确 detached 而非猜分支", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-i");
  initRepo(repo);
  git(repo, "checkout", "--detach", "HEAD");
  const result = await resolveAgentBranch(repo, null, createBranchResolver({ ttlMs: 0 }));
  assert.deepEqual(result, { status: "detached" });
});

test("resolveAgentBranch:无提示且 cwd 非 git → unavailable", async () => {
  const root = newFixtureRoot();
  const plain = join(root, "plain-2");
  const result = await resolveAgentBranch(plain, null, createBranchResolver({ ttlMs: 0 }));
  assert.deepEqual(result, { status: "unavailable" });
});
