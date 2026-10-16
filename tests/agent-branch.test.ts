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
  assert.equal(await resolveBranch(repo), initial);
});

test("分支:切分支后(短 TTL)返回新分支", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-b");
  initRepo(repo);
  git(repo, "checkout", "-b", "feature/req2");
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  assert.equal(await resolveBranch(repo), "feature/req2");
});

test("分支:detached HEAD 明确返回 null,不猜分支", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-c");
  initRepo(repo);
  git(repo, "checkout", "--detach", "HEAD");
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  assert.equal(await resolveBranch(repo), null);
});

test("分支:非 git 目录返回 null", async () => {
  const root = newFixtureRoot();
  const plain = join(root, "not-a-repo");
  const resolveBranch = createBranchResolver({ ttlMs: 0 });
  assert.equal(await resolveBranch(plain), null);
});

test("分支:缓存生效 —— TTL 内切分支仍返回旧值,TTL 过后刷新", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-d");
  const initial = initRepo(repo);
  let nowMs = 1000;
  const resolveBranch = createBranchResolver({ ttlMs: 5000, now: () => nowMs });
  assert.equal(await resolveBranch(repo), initial);

  git(repo, "checkout", "-b", "feature/next");
  // TTL 内:命中缓存,仍是切分支前的旧值
  assert.equal(await resolveBranch(repo), initial);

  // TTL 过后:拿到新分支
  nowMs += 6000;
  assert.equal(await resolveBranch(repo), "feature/next");
});

test("resolveAgentBranch:提示 label 优先于 cwd 的 git 查询", async () => {
  const root = newFixtureRoot();
  const cwdRepo = join(root, "repo-main");
  const hintRepo = join(root, "wt-assigned");
  initRepo(cwdRepo);
  initRepo(hintRepo);
  git(hintRepo, "checkout", "-b", "feature/assigned");

  const branch = await resolveAgentBranch(cwdRepo, hintRepo, createBranchResolver({ ttlMs: 0 }));
  assert.equal(branch, "feature/assigned");
});

test("resolveAgentBranch:相对路径提示无效 → 回退 cwd", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-e");
  const initial = initRepo(repo);
  const branch = await resolveAgentBranch(repo, "relative/wt", createBranchResolver({ ttlMs: 0 }));
  assert.equal(branch, initial);
});

test("resolveAgentBranch:提示目录已失效 → 回退 cwd", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-f");
  const initial = initRepo(repo);
  const branch = await resolveAgentBranch(
    repo,
    join(root, "gone-worktree"),
    createBranchResolver({ ttlMs: 0 }),
  );
  assert.equal(branch, initial);
});

test("resolveAgentBranch:提示目录非 git → 回退 cwd", async () => {
  const root = newFixtureRoot();
  const repo = join(root, "repo-g");
  const plain = join(root, "plain-dir");
  const initial = initRepo(repo);
  const branch = await resolveAgentBranch(repo, plain, createBranchResolver({ ttlMs: 0 }));
  assert.equal(branch, initial);
});

test("resolveAgentBranch:无提示且 cwd 非 git → null", async () => {
  const root = newFixtureRoot();
  const plain = join(root, "plain-2");
  const branch = await resolveAgentBranch(plain, null, createBranchResolver({ ttlMs: 0 }));
  assert.equal(branch, null);
});
