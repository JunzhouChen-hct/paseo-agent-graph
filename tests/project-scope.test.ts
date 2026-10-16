import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentsInProject,
  applyAgentRemove,
  applyAgentUpsert,
  applyWorkspaceRemove,
  applyWorkspaceUpsert,
  creationTargetWorkspaceId,
  mergeAgentPage,
  mergeWorkspacePage,
  replaceAgentsFromSnapshot,
  replaceWorkspacesFromSnapshot,
  toDirectoryAgent,
  truncateWorkspaceLabel,
  visibleAgents,
  workspaceBadgeLabel,
  workspaceDisplayName,
  type AgentDirectoryMap,
  type DirectoryAgent,
  type RawDirectoryAgent,
  type RawDirectoryEntry,
  type RawWorkspaceDescriptor,
  type WorkspaceMap,
} from "../shared/project-scope";

/** 构造目录原始条目,字段与 protocol AgentSnapshotPayload 中本插件用到的子集一致 */
function rawAgent(overrides: Partial<RawDirectoryAgent> & { id: string }): RawDirectoryAgent {
  const digits = overrides.id.replace(/\D/g, "").slice(-2).padStart(2, "0") || "00";
  return {
    workspaceId: "ws_main",
    title: overrides.id,
    provider: "codex",
    model: "gpt-5.5",
    status: "idle",
    archivedAt: null,
    requiresAttention: false,
    createdAt: `2026-01-01T00:00:${digits}Z`,
    ...overrides,
  };
}

/** 目录条目:agent + 可选 project placement(与 protocol FetchAgentsEntry 同构) */
function entry(
  overrides: Partial<RawDirectoryAgent> & { id: string },
  project?: { projectKey?: string | null; workspaceName?: string | null } | null,
): RawDirectoryEntry {
  return { agent: rawAgent(overrides), project };
}

function raw(overrides: Partial<DirectoryAgent> & { id: string; workspaceId: string }): DirectoryAgent {
  const digits = overrides.id.replace(/\D/g, "").slice(-2).padStart(2, "0") || "00";
  return {
    projectKey: null,
    placementWorkspaceName: null,
    title: overrides.id,
    provider: "codex",
    model: "gpt-5.5",
    status: "idle",
    archived: false,
    requiresAttention: false,
    createdAt: `2026-01-01T00:00:${digits}Z`,
    ...overrides,
  };
}

test("toDirectoryAgent 规范化字段,归档看 archivedAt,workspaceId 缺失返回 null", () => {
  const normalized = toDirectoryAgent(
    rawAgent({ id: "agt_1", workspaceId: "ws_a", archivedAt: "2026-01-02T00:00:00Z", title: null, requiresAttention: true }),
  );
  assert.deepEqual(normalized, {
    id: "agt_1",
    workspaceId: "ws_a",
    projectKey: null,
    placementWorkspaceName: null,
    title: null,
    provider: "codex",
    model: "gpt-5.5",
    status: "idle",
    archived: true,
    requiresAttention: true,
    createdAt: "2026-01-01T00:00:01Z",
  });
  assert.equal(toDirectoryAgent(rawAgent({ id: "agt_2", workspaceId: null })), null);
  assert.equal(toDirectoryAgent(rawAgent({ id: "agt_3", workspaceId: undefined })), null);
});

test("applyAgentUpsert 新增/整体替换;placement 缺失不误清 projectKey,部分更新不错移", () => {
  const map: AgentDirectoryMap = new Map();
  applyAgentUpsert(map, entry({ id: "agt_1", workspaceId: "ws_a", status: "running" }, { projectKey: "prj1:main", workspaceName: "main-ws" }));
  assert.equal(map.get("agt_1")?.projectKey, "prj1:main");
  assert.equal(map.get("agt_1")?.placementWorkspaceName, "main-ws");

  // 完整快照 + 新 placement:整体替换(项目迁移场景)
  applyAgentUpsert(map, entry({ id: "agt_1", workspaceId: "ws_b", status: "idle" }, { projectKey: "prj2:feat" }));
  assert.equal(map.get("agt_1")?.workspaceId, "ws_b");
  assert.equal(map.get("agt_1")?.projectKey, "prj2:feat");
  assert.equal(map.get("agt_1")?.placementWorkspaceName, null, "新 placement 覆盖旧值");

  // 协议 upsert 的 project 可缺失:已知节点保留 projectKey/placement,安全字段允许刷新
  applyAgentUpsert(map, { agent: { ...rawAgent({ id: "agt_1" }), workspaceId: undefined, title: "改名" } });
  assert.equal(map.get("agt_1")?.workspaceId, "ws_b", "缺 workspaceId 不得错移已知节点");
  assert.equal(map.get("agt_1")?.projectKey, "prj2:feat", "缺 placement 不得误清 projectKey");
  assert.equal(map.get("agt_1")?.title, "改名");

  const before = map.size;
  applyAgentUpsert(map, { agent: { ...rawAgent({ id: "agt_ghost" }), workspaceId: undefined } });
  assert.equal(map.size, before, "未知且缺 workspaceId 的条目不进入目录");
});

test("applyAgentRemove 只删除指定 agent", () => {
  const map: AgentDirectoryMap = new Map();
  applyAgentUpsert(map, entry({ id: "agt_1" }));
  applyAgentUpsert(map, entry({ id: "agt_2" }));
  applyAgentRemove(map, "agt_1");
  assert.equal(map.has("agt_1"), false);
  assert.equal(map.has("agt_2"), true);
  applyAgentRemove(map, "agt_missing");
  assert.equal(map.size, 1);
});

test("重连 snapshot 整体替换旧缓存,分页 merge 累积不丢第 201+ 个节点", () => {
  const map: AgentDirectoryMap = new Map();
  const pages: RawDirectoryEntry[] = [];
  for (let i = 1; i <= 250; i++) {
    pages.push(entry({ id: `agt_${String(i).padStart(3, "0")}`, workspaceId: "ws_a" }, { projectKey: "prj1:main" }));
  }
  const firstPage = pages.slice(0, 200);
  const secondPage = pages.slice(200);
  mergeAgentPage(map, firstPage);
  assert.equal(map.size, 200);
  mergeAgentPage(map, secondPage);
  assert.equal(map.size, 250, "第 201+ 个节点不丢");

  // 重连后 snapshot 只返回 3 个:陈旧的 247 个必须被清掉
  replaceAgentsFromSnapshot(
    map,
    [entry({ id: "agt_001", workspaceId: "ws_a" }), entry({ id: "agt_002", workspaceId: "ws_a" }), entry({ id: "agt_003", workspaceId: "ws_a" })],
  );
  assert.deepEqual([...map.keys()].sort(), ["agt_001", "agt_002", "agt_003"]);

  // 第 2 页 merge:累积而不是替换
  mergeAgentPage(map, [entry({ id: "agt_004", workspaceId: "ws_a" })]);
  assert.equal(map.size, 4);
});

test("projectKey 精确 join:覆盖已归档工作区节点,异 project 排除,不假设 projectId==projectKey", () => {
  const map: AgentDirectoryMap = new Map();
  // projectId 是 prj_xxx 形态,projectKey 是完全不同的真实键
  applyAgentUpsert(map, entry({ id: "agt_a1", workspaceId: "ws_a" }, { projectKey: "prj1:main" }));
  applyAgentUpsert(map, entry({ id: "agt_a2", workspaceId: "ws_b" }, { projectKey: "prj1:main" }));
  // 归档工作区的节点:workspaceId 不在活跃集合,仅靠 projectKey 命中
  applyAgentUpsert(
    map,
    entry({ id: "agt_arch", workspaceId: "ws_archived", archivedAt: "2026-01-02T00:00:00Z" }, { projectKey: "prj1:main", workspaceName: "old-branch" }),
  );
  applyAgentUpsert(map, entry({ id: "agt_other", workspaceId: "ws_z" }, { projectKey: "prj2:feat" }));
  applyAgentUpsert(map, entry({ id: "agt_unknown", workspaceId: "ws_z" }));

  const inProject = agentsInProject(map, "prj1:main", new Set(["ws_a", "ws_b"]));
  assert.deepEqual(
    inProject.map((agent) => agent.id).sort(),
    ["agt_a1", "agt_a2", "agt_arch"],
    "同 project 跨 workspace 均含,归档工作区节点靠 projectKey 保留,异 project/无来源排除",
  );

  // projectKey 未知(解析中):仅活跃 workspace join,归档工作区节点暂不出现但不报错
  const duringResolve = agentsInProject(map, null, new Set(["ws_a", "ws_b"]));
  assert.deepEqual(duringResolve.map((agent) => agent.id).sort(), ["agt_a1", "agt_a2"]);
});

test("动态工作区新增/删除:join 集合变化即时反映,孤儿跨工作区父随后出现", () => {
  const map: AgentDirectoryMap = new Map();
  applyAgentUpsert(map, entry({ id: "agt_child", workspaceId: "ws_a" }, { projectKey: "prj1:main" }));
  // 父节点在另一 workspace,其工作区尚未进入列表
  applyAgentUpsert(map, entry({ id: "wks_parent_agent", workspaceId: "wks_2nd" }, { projectKey: "prj1:main" }));

  const workspaces: WorkspaceMap = new Map();
  replaceWorkspacesFromSnapshot(
    workspaces,
    [{ id: "ws_a", projectId: "prj_abc", name: "main-ws", title: null, project: { projectKey: "prj1:main" } }],
    "prj_abc",
  );

  const beforeParent = agentsInProject(map, "prj1:main", new Set(workspaces.keys()));
  assert.deepEqual(
    beforeParent.map((agent) => agent.id).sort(),
    ["agt_child", "wks_parent_agent"],
    "projectKey 已知时,父节点工作区未入活跃列表也通过 key 命中",
  );

  // 动态新增工作区(活跃 join 补充)后两者仍在
  applyWorkspaceUpsert(
    workspaces,
    { id: "wks_2nd", projectId: "prj_abc", name: "feature-branch", title: null },
    "prj_abc",
  );
  assert.deepEqual(
    agentsInProject(map, "prj1:main", new Set(workspaces.keys())).map((agent) => agent.id).sort(),
    ["agt_child", "wks_parent_agent"],
  );

  // 工作区删除:仅靠活跃 join 的节点(无 projectKey)随即排除
  applyAgentUpsert(map, entry({ id: "agt_nokey", workspaceId: "wks_2nd" }));
  applyWorkspaceRemove(workspaces, "wks_2nd");
  const after = agentsInProject(map, "prj1:main", new Set(workspaces.keys()));
  assert.equal(after.some((agent) => agent.id === "agt_nokey"), false);
  assert.equal(after.some((agent) => agent.id === "wks_parent_agent"), true, "有 projectKey 的节点不受活跃列表删除影响");
});

test("工作区 snapshot 只收真实 projectId 匹配项;项目迁移/异项 upsert 被移除防泄漏", () => {
  const workspaces: WorkspaceMap = new Map();
  replaceWorkspacesFromSnapshot(
    workspaces,
    [
      { id: "ws_keep", projectId: "prj_1", name: "keep", title: "标题A", project: { projectKey: "prj1:main" } },
      { id: "ws_drop", projectId: "prj_2", name: "drop", title: null },
      { id: "ws_nopid", name: "nopid", title: null },
    ] satisfies RawWorkspaceDescriptor[],
    "prj_1",
  );
  assert.deepEqual([...workspaces.keys()], ["ws_keep"]);
  assert.equal(workspaces.get("ws_keep")?.projectKey, "prj1:main");

  // 现有工作区被迁移到其他 project:upsert 匹配失败 → 从总览移除
  applyWorkspaceUpsert(workspaces, { id: "ws_keep", projectId: "prj_9", name: "keep", title: null }, "prj_1");
  assert.equal(workspaces.has("ws_keep"), false);

  // 动态新增 + 分页 merge 同样按 projectId 校验
  applyWorkspaceUpsert(workspaces, { id: "ws_new", projectId: "prj_1", name: "new", title: null }, "prj_1");
  mergeWorkspacePage(
    workspaces,
    [
      { id: "ws_page", projectId: "prj_1", name: "page", title: null },
      { id: "ws_bad", projectId: "prj_x", name: "bad", title: null },
    ],
    "prj_1",
  );
  assert.deepEqual([...workspaces.keys()].sort(), ["ws_new", "ws_page"]);
});

test("归档开关:隐藏时过滤归档节点,开启时全量保留(含跨 workspace)", () => {
  const agents = [
    raw({ id: "agt_live", workspaceId: "ws_a", archived: false }),
    raw({ id: "agt_dead_a", workspaceId: "ws_a", archived: true }),
    raw({ id: "agt_dead_b", workspaceId: "ws_b", archived: true }),
  ];
  assert.deepEqual(
    visibleAgents(agents, false).map((agent) => agent.id),
    ["agt_live"],
  );
  assert.deepEqual(
    visibleAgents(agents, true).map((agent) => agent.id),
    ["agt_live", "agt_dead_a", "agt_dead_b"],
  );
});

test("工作区显示名与标识截断", () => {
  assert.equal(workspaceDisplayName({ id: "w1", name: "ws-name", title: "  ", projectKey: null }), "ws-name");
  assert.equal(workspaceDisplayName({ id: "w1", name: "ws-name", title: "我的工作区", projectKey: null }), "我的工作区");
  assert.equal(truncateWorkspaceLabel("abcdefghijklmnopqrstuvwxyz", 16), "abcdefghijklmno…");
  assert.equal(truncateWorkspaceLabel("短名字", 16), "短名字");
  assert.equal(truncateWorkspaceLabel("任何", 0), "");
  // 中文按码点截断,不出半个字符
  const long = "工作区".repeat(10);
  const cut = truncateWorkspaceLabel(long, 16);
  assert.ok([...cut].length <= 16);
  assert.ok(cut.endsWith("…"));
});

test("卡片工作区标识:活跃工作区优先,归档工作区回落 placement 的 workspaceName", () => {
  const byId = new Map([
    ["ws_a", { id: "ws_a", name: "main-ws", title: "主线", projectKey: "prj1:main" }],
  ]);
  const activeAgent = raw({ id: "agt_a", workspaceId: "ws_a" });
  assert.equal(workspaceBadgeLabel(activeAgent, byId), "主线");

  // 工作区已归档:不在活跃列表,回落目录 placement 的 workspaceName
  const archivedWsAgent = raw({ id: "agt_b", workspaceId: "ws_old", placementWorkspaceName: "old-branch" });
  assert.equal(workspaceBadgeLabel(archivedWsAgent, byId), "old-branch");

  // 两者皆缺:不显示标识
  assert.equal(workspaceBadgeLabel(raw({ id: "agt_c", workspaceId: "ws_x" }), byId), null);
});

test("创建目标 workspace 必须跟随父 agent,缺失时拒绝而不是回落", () => {
  const panelWorkspaceId = "ws_panel";
  // 父 agent 属于另一 workspace:创建必须落在那里
  assert.equal(
    creationTargetWorkspaceId({ workspaceId: "wks_5b87fb2d1d41ba07" }),
    "wks_5b87fb2d1d41ba07",
  );
  assert.notEqual(
    creationTargetWorkspaceId({ workspaceId: "wks_other" }),
    panelWorkspaceId,
    "绝不回落到面板当前 workspace",
  );
  assert.equal(creationTargetWorkspaceId(undefined), null);
  assert.equal(creationTargetWorkspaceId(null), null);
});
