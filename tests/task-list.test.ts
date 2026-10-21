import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentGraphTaskListSettings,
  applyTaskResults,
  defaultTaskListEntry,
  IDLE_CONFIRM_MS,
  isIdleForSend,
  isSettleBlocked,
  mergePendingSent,
  moveTask,
  moveTaskDown,
  moveTaskUp,
  newTaskId,
  parseTaskListDocument,
  pickDefaultTaskTarget,
  pickNextTask,
  relatedAgentIds,
  SEND_RETRY_MS,
  shouldAutoCompact,
  TASK_CONTENT_MAX,
  TASK_LIST_MAX,
  TASK_RESULT_MAX,
  TASK_TITLE_MAX,
  taskMessageId,
  taskDisplayStatus,
  settleReadyIds,
  settleSentTasks,
  summarizeRelatedIdle,
  toggleTaskState,
  truncateTaskResult,
  validateTaskListDocument,
  withTaskList,
  withTaskSentAt,
  type AgentIdleInput,
  type AutoCompactMode,
  type AutoCompactRule,
  type TaskListDoc,
  type TaskListEntry,
  type TaskRecord,
} from "../shared/task-list.ts";

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    title: overrides.id,
    content: overrides.id,
    selected: false,
    done: false,
    sentAt: null,
    settledAt: null,
    result: null,
    attempt: 0,
    images: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function entry(tasks: TaskRecord[], overrides: Partial<TaskListEntry> = {}): TaskListEntry {
  return { ...defaultTaskListEntry(), tasks, ...overrides };
}

function doc(lists: Record<string, TaskListEntry> = {}): TaskListDoc {
  return { lists };
}

test("task settings:host scope/version 1,空文档解析为 lists {}", () => {
  assert.equal(agentGraphTaskListSettings.id, "agent-graph-tasks");
  assert.equal(agentGraphTaskListSettings.scope, "host");
  assert.equal(agentGraphTaskListSettings.version, 1);
  assert.deepEqual(agentGraphTaskListSettings.schema.parse({}), { lists: {} });
});

test("taskRecordSchema 默认值:selected/done=false,sentAt=null;列表可省略可选字段", () => {
  const parsed = agentGraphTaskListSettings.schema.parse({
    lists: {
      prj_1: {
        tasks: [{ id: "task_1", title: "标题", content: "内容", createdAt: "2026-01-01T00:00:00Z" }],
      },
    },
  });
  const list = parsed.lists.prj_1!;
  assert.equal(list.targetAgentId, null);
  assert.equal(list.autoSend, false);
  const parsedTask = list.tasks[0]!;
  assert.equal(parsedTask.selected, false);
  assert.equal(parsedTask.done, false);
  assert.equal(parsedTask.sentAt, null);
  assert.equal(parsedTask.settledAt, null);
  assert.equal(parsedTask.result, null);
  assert.equal(parsedTask.attempt, 0);
});

test("schema superRefine:同列表 task id 唯一、title trim 非空", () => {
  const duplicate = {
    lists: {
      prj_1: entry([
        task({ id: "task_a" }),
        task({ id: "task_a", title: "另一个标题" }),
      ]),
    },
  };
  assert.equal(agentGraphTaskListSettings.schema.safeParse(duplicate).success, false);

  const blank = {
    lists: { prj_1: entry([task({ id: "task_a", title: "   " })]) },
  };
  assert.equal(agentGraphTaskListSettings.schema.safeParse(blank).success, false);

  // 不同列表允许相同 task id(隔离键是 projectId)
  const separate = {
    lists: {
      prj_1: entry([task({ id: "task_a" })]),
      prj_2: entry([task({ id: "task_a" })]),
    },
  };
  assert.equal(agentGraphTaskListSettings.schema.safeParse(separate).success, true);
});

test("validateTaskListDocument 与服务端 schema 同源:重复/空标题/超长/超量", () => {
  const valid = doc({
    prj_1: entry([task({ id: "task_a", title: " 合法 " })]),
  });
  assert.deepEqual(validateTaskListDocument(valid), []);

  const duplicate = doc({
    prj_1: entry([task({ id: "task_a" }), task({ id: "task_a", title: "重复" })]),
  });
  assert.ok(validateTaskListDocument(duplicate).some((error) => error.includes("id 重复")));

  const blank = doc({ prj_1: entry([task({ id: "task_a", title: "  " })]) });
  assert.ok(validateTaskListDocument(blank).some((error) => error.includes("标题不能为空")));

  const tooLongTitle = doc({
    prj_1: entry([task({ id: "task_a", title: "x".repeat(TASK_TITLE_MAX + 1) })]),
  });
  assert.ok(validateTaskListDocument(tooLongTitle).some((error) => error.includes("标题超过")));

  const tooLongContent = doc({
    prj_1: entry([task({ id: "task_a", content: "x".repeat(TASK_CONTENT_MAX + 1) })]),
  });
  assert.ok(validateTaskListDocument(tooLongContent).some((error) => error.includes("内容超过")));

  const tooMany = doc({
    prj_1: entry(
      Array.from({ length: TASK_LIST_MAX + 1 }, (_, index) => task({ id: `task_${index}` })),
    ),
  });
  assert.ok(validateTaskListDocument(tooMany).some((error) => error.includes("任务数超过上限")));
});

test("parseTaskListDocument:非法结构返回 null,合法值返回带默认值的文档", () => {
  assert.equal(parseTaskListDocument(null), null);
  assert.equal(parseTaskListDocument({ lists: { prj: { tasks: [{ id: "x" }] } } }), null);
  const parsed = parseTaskListDocument({
    lists: {
      prj: {
        targetAgentId: "agt_main",
        autoSend: true,
        tasks: [{ id: "task_1", title: "标题", content: "内容", createdAt: "2026-01-01T00:00:00Z" }],
      },
    },
  });
  assert.equal(parsed?.lists.prj?.targetAgentId, "agt_main");
  assert.equal(parsed?.lists.prj?.autoSend, true);
  assert.equal(parsed?.lists.prj?.tasks[0]?.selected, false);
});

test("relatedAgentIds:包含 target 与全部传递子孙,忽略不存在的父和环", () => {
  const parentOf = new Map<string, string | null>([
    ["root", null],
    ["child_a", "root"],
    ["child_b", "root"],
    ["grand", "child_a"],
    ["other_root", null],
    // 环防护:两个节点互为父子时不应死循环
    ["cycle_a", "cycle_b"],
    ["cycle_b", "cycle_a"],
  ]);
  assert.deepEqual([...relatedAgentIds("root", parentOf)].sort(), [
    "child_a",
    "child_b",
    "grand",
    "root",
  ]);
  assert.deepEqual([...relatedAgentIds("other_root", parentOf)], ["other_root"]);
  assert.deepEqual([...relatedAgentIds("cycle_a", parentOf)].sort(), ["cycle_a", "cycle_b"]);
  // target 不在 parentOf(目录尚未就绪)时仍返回自身,由调用方结合可见性判定忙
  assert.deepEqual([...relatedAgentIds("ghost", parentOf)], ["ghost"]);
});

test("isIdleForSend:未归档 + idle + 关注不是 permission/error/未知", () => {
  const base = {
    archived: false,
    status: "idle" as const,
    requiresAttention: false,
    attentionReason: null,
  };
  assert.equal(isIdleForSend(base), true);
  // finished 只是上一回合完成通知,发送会开启新回合
  assert.equal(isIdleForSend({ ...base, requiresAttention: true, attentionReason: "finished" }), true);
  assert.equal(isIdleForSend({ ...base, requiresAttention: true, attentionReason: "permission" }), false);
  assert.equal(isIdleForSend({ ...base, requiresAttention: true, attentionReason: "error" }), false);
  assert.equal(isIdleForSend({ ...base, requiresAttention: true, attentionReason: null }), false);
  assert.equal(isIdleForSend({ ...base, status: "running" }), false);
  assert.equal(isIdleForSend({ ...base, status: "closed" }), false);
  assert.equal(isIdleForSend({ ...base, status: null }), false);
  assert.equal(isIdleForSend({ ...base, archived: true }), false);
});

test("isSettleBlocked:全部 idle 才不阻塞,任一非 idle/未就绪/空输入都阻塞", () => {
  assert.equal(isSettleBlocked(["idle", "idle", "idle"]), false);
  assert.equal(isSettleBlocked(["idle"]), false);
  // 任一相关 Agent 仍在运行/等权限/出错都阻塞
  assert.equal(isSettleBlocked(["idle", "running"]), true);
  assert.equal(isSettleBlocked(["permission"]), true);
  assert.equal(isSettleBlocked(["error"]), true);
  assert.equal(isSettleBlocked(["closed"]), true);
  // 快照未就绪:null/undefined 视为阻塞,不结算
  assert.equal(isSettleBlocked(["idle", null]), true);
  assert.equal(isSettleBlocked([undefined]), true);
  assert.equal(isSettleBlocked(["idle", undefined, "idle"]), true);
  // 没有任何 Agent 可确认时不结算(空集不能字面地"全部空闲")
  assert.equal(isSettleBlocked([]), true);
});

test("summarizeRelatedIdle:全空闲/归档剔除/未知与缺失保守忙/关注态", () => {
  const idle: AgentIdleInput = {
    archived: false,
    status: "idle",
    requiresAttention: false,
    attentionReason: null,
  };
  const summarize = (ids: string[], entries: Record<string, AgentIdleInput | null>) =>
    summarizeRelatedIdle(new Set(ids), (id) => entries[id] ?? null);

  // 1. 全部空闲:relatedCount 覆盖 target 与子孙
  assert.deepEqual(
    summarize(["main", "child"], {
      main: idle,
      child: { ...idle, status: "idle" },
    }),
    { allIdle: true, relatedCount: 2, busyCount: 0 },
  );

  // 2. 归档节点直接退出:即使残留 running/permission/未知状态也不阻塞、不计数;
  //    中间节点归档后,其未归档孙 Agent 仍由相关集合覆盖并参与判定
  assert.deepEqual(
    summarize(["main", "archived_mid", "grandchild", "archived_leaf"], {
      main: idle,
      archived_mid: {
        ...idle,
        archived: true,
        status: "running",
        requiresAttention: true,
        attentionReason: "permission",
      },
      grandchild: idle,
      archived_leaf: { ...idle, archived: true, status: null },
    }),
    { allIdle: true, relatedCount: 2, busyCount: 0 },
  );

  // 3. status=null(live 快照重建期)保守视为忙,计入 M 与 N
  assert.deepEqual(
    summarize(["main", "rebuilding"], {
      main: idle,
      rebuilding: { ...idle, status: null },
    }),
    { allIdle: false, relatedCount: 2, busyCount: 1 },
  );

  // 4. lookup 返回 null(不在项目目录)同样保守视为忙
  assert.deepEqual(summarize(["main", "missing"], { main: idle }), {
    allIdle: false,
    relatedCount: 2,
    busyCount: 1,
  });

  // 5. permission/error 忙;finished 只表示上一回合完成,视为空闲
  assert.deepEqual(
    summarize(["permission", "error", "finished"], {
      permission: { ...idle, requiresAttention: true, attentionReason: "permission" },
      error: { ...idle, requiresAttention: true, attentionReason: "error" },
      finished: { ...idle, requiresAttention: true, attentionReason: "finished" },
    }),
    { allIdle: false, relatedCount: 3, busyCount: 2 },
  );

  // 6. 空相关集合不算"全空闲":不能因没有可确认的 Agent 就发送/结算
  assert.deepEqual(summarize([], {}), { allIdle: false, relatedCount: 0, busyCount: 0 });
  // 相关集合全部归档也退化为空集,同样不发送
  assert.deepEqual(
    summarize(["archived"], { archived: { ...idle, archived: true } }),
    { allIdle: false, relatedCount: 0, busyCount: 0 },
  );
});

test("pickNextTask:数组顺序首个 selected && !done && sentAt==null && 内容非空", () => {
  const tasks = [
    task({ id: "task_unselected" }),
    task({ id: "task_done", selected: true, done: true }),
    task({ id: "task_sent", selected: true, sentAt: "2026-01-02T00:00:00Z" }),
    task({ id: "task_empty", selected: true, content: "   " }),
    task({ id: "task_first", selected: true }),
    task({ id: "task_second", selected: true }),
  ];
  assert.equal(pickNextTask(tasks)?.id, "task_first");
  assert.equal(pickNextTask([]), null);
  assert.equal(pickNextTask([task({ id: "task_none" })]), null);
});

test("上下移帮助函数:越界返回同序副本,合法移动不改入参", () => {
  const tasks = [task({ id: "task_a" }), task({ id: "task_b" }), task({ id: "task_c" })];
  const original = tasks.map((item) => item.id);
  assert.deepEqual(moveTaskUp(tasks, "task_b").map((item) => item.id), [
    "task_b",
    "task_a",
    "task_c",
  ]);
  assert.deepEqual(moveTaskDown(tasks, "task_b").map((item) => item.id), [
    "task_a",
    "task_c",
    "task_b",
  ]);
  assert.deepEqual(moveTask(tasks, "task_a", "up").map((item) => item.id), original);
  assert.deepEqual(moveTask(tasks, "task_c", "down").map((item) => item.id), original);
  assert.deepEqual(moveTask(tasks, "task_missing", "down").map((item) => item.id), original);
  assert.deepEqual(tasks.map((item) => item.id), original, "入参不被修改");
});

test("withTaskSentAt 只 patch 目标任务,保留其他项目/任务字段", () => {
  const base = doc({
    prj_1: entry(
      [
        task({ id: "task_a", selected: true }),
        task({ id: "task_b", title: "B", content: "B 内容" }),
      ],
      { targetAgentId: "agt_main", autoSend: true },
    ),
    prj_2: entry([task({ id: "task_other" })], { autoSend: true }),
  });
  const patched = withTaskSentAt(base, "prj_1", "task_a", "2026-02-01T10:00:00Z");
  assert.ok(patched);
  assert.equal(patched?.lists.prj_1?.tasks[0]?.sentAt, "2026-02-01T10:00:00Z");
  assert.equal(patched?.lists.prj_1?.tasks[0]?.selected, true);
  assert.equal(patched?.lists.prj_1?.tasks[1]?.sentAt, null);
  assert.equal(patched?.lists.prj_1?.autoSend, true);
  assert.equal(patched?.lists.prj_2?.autoSend, true);
  assert.equal(base.lists.prj_1?.tasks[0]?.sentAt, null, "不改入参");

  assert.equal(withTaskSentAt(base, "prj_missing", "task_a", "now"), null);
  assert.equal(withTaskSentAt(base, "prj_1", "task_missing", "now"), null);

  // attempt 校验:任务被重新排队(attempt 递增)后拒绝写入,防止旧 sentAt 盖回
  const requeued = doc({
    prj_1: entry([task({ id: "task_a", selected: true, attempt: 1 })], { targetAgentId: "agt_main" }),
  });
  assert.equal(withTaskSentAt(requeued, "prj_1", "task_a", "2026-02-01T10:00:00Z", 0), null);
  const attemptMatch = withTaskSentAt(requeued, "prj_1", "task_a", "2026-02-01T10:00:00Z", 1);
  assert.equal(attemptMatch?.lists.prj_1?.tasks[0]?.sentAt, "2026-02-01T10:00:00Z");
  // 不传 attempt 时保持旧行为:不校验
  assert.equal(withTaskSentAt(requeued, "prj_1", "task_a", "now")?.lists.prj_1?.tasks[0]?.sentAt, "now");
});

test("mergePendingSent:空 map 引用不变,乐观回填不覆盖已有 sentAt", () => {
  const tasks = [
    task({ id: "task_pending", selected: true, title: "待发送" }),
    task({ id: "task_sent", sentAt: "2026-01-02T00:00:00Z" }),
    task({ id: "task_untouched" }),
  ];
  // 空 map:直接返回原数组,不产生新引用
  assert.equal(mergePendingSent(tasks, new Map()), tasks);

  // 乐观回填:只改 sentAt===null 且命中的任务,其余任务引用不变
  const at = "2026-02-01T10:00:00Z";
  const merged = mergePendingSent(tasks, new Map([["task_pending", { sentAt: at, attempt: 0 }]]));
  assert.notEqual(merged, tasks);
  assert.equal(merged.find((item) => item.id === "task_pending")?.sentAt, at);
  assert.equal(merged.find((item) => item.id === "task_pending")?.title, "待发送");
  assert.equal(merged.find((item) => item.id === "task_sent"), tasks[1]);
  assert.equal(merged.find((item) => item.id === "task_untouched"), tasks[2]);
  // 不改入参
  assert.equal(tasks[0]?.sentAt, null);

  // 已有 sentAt 的任务不被 pendingSent 覆盖;全部无变化时仍返回原数组
  const overwrite = new Map([["task_sent", { sentAt: "2026-03-01T00:00:00Z", attempt: 0 }]]);
  assert.equal(mergePendingSent(tasks, overwrite), tasks);
  assert.equal(mergePendingSent(tasks, overwrite)[1]?.sentAt, "2026-01-02T00:00:00Z");
});

test("mergePendingSent:attempt 不一致(已被重新排队)的乐观值不合并", () => {
  // 重新排队后权威文档 attempt 已递增、sentAt 已重置
  const tasks = [task({ id: "task_x", selected: true, attempt: 1 })];
  const pending = new Map([["task_x", { sentAt: "2026-02-01T10:00:00Z", attempt: 0 }]]);
  // 旧投递的乐观值不能把重置后的任务盖回"已发送",否则任务静默卡死
  assert.equal(mergePendingSent(tasks, pending), tasks);
  const match = mergePendingSent(tasks, new Map([["task_x", { sentAt: "2026-02-01T10:00:00Z", attempt: 1 }]]));
  assert.equal(match.find((item) => item.id === "task_x")?.sentAt, "2026-02-01T10:00:00Z");
});

test("withTaskList 按 projectId 隔离写入,其他项目保持不变", () => {
  const base = doc({ prj_1: entry([task({ id: "task_a" })]) });
  const next = withTaskList(base, "prj_2", entry([task({ id: "task_b" })], { targetAgentId: "agt_2" }));
  assert.equal(next.lists.prj_2?.targetAgentId, "agt_2");
  assert.equal(next.lists.prj_1?.tasks[0]?.id, "task_a");
  assert.equal(base.lists.prj_2, undefined, "不改入参");
});

test("pickDefaultTaskTarget:选中卡片 → workspace 唯一根 → 最早未归档 → null", () => {
  const agents = [
    { id: "agt_root", workspaceId: "ws_main", archived: false, createdAt: "2026-01-03T00:00:00Z" },
    { id: "agt_child", workspaceId: "ws_main", archived: false, createdAt: "2026-01-04T00:00:00Z" },
    { id: "agt_other_root", workspaceId: "ws_other", archived: false, createdAt: "2026-01-01T00:00:00Z" },
    { id: "agt_archived", workspaceId: "ws_main", archived: true, createdAt: "2026-01-00T00:00:00Z" },
  ];
  const parentOf = new Map<string, string | null>([
    ["agt_root", null],
    ["agt_child", "agt_root"],
    ["agt_other_root", null],
  ]);
  // 1. 画布选中的卡片优先(即使不是根)
  assert.equal(
    pickDefaultTaskTarget({
      agents,
      parentOf,
      workspaceId: "ws_main",
      preferredAgentId: "agt_child",
    }),
    "agt_child",
  );
  // 2. 当前 workspace 唯一根
  assert.equal(
    pickDefaultTaskTarget({ agents, parentOf, workspaceId: "ws_main" }),
    "agt_root",
  );
  // 3. 没有唯一根时取项目内最早未归档(archived 不参与)
  assert.equal(
    pickDefaultTaskTarget({ agents, parentOf, workspaceId: "ws_missing" }),
    "agt_other_root",
  );
  // 4. 空项目 / 全归档 → null
  assert.equal(
    pickDefaultTaskTarget({ agents: [], parentOf, workspaceId: "ws_main" }),
    null,
  );
  assert.equal(
    pickDefaultTaskTarget({
      agents: [agents[3]!],
      parentOf,
      workspaceId: "ws_main",
    }),
    null,
  );
});

test("newTaskId:\"task_\" + 12 位随机字符且不重复", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const id = newTaskId();
    assert.match(id, /^task_[a-z0-9]{12}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 50);
});

test("确认窗常量:2 秒空闲确认 + 失败退避,供 UI 与测试共用", () => {
  assert.equal(IDLE_CONFIRM_MS, 2000);
  assert.ok(SEND_RETRY_MS >= IDLE_CONFIRM_MS);
});

test("图片校验:MIME 白名单、单张 base64 上限、数量上限", () => {
  const image = { data: "aGVsbG8=", mimeType: "image/png" } as const;
  // 合法:4 张以内、白名单格式
  const valid = doc({ prj_1: entry([task({ id: "task_a", images: [image, { ...image, mimeType: "image/jpeg" }] })]) });
  assert.deepEqual(validateTaskListDocument(valid), []);

  // 数量超限
  const tooMany = doc({
    prj_1: entry([
      task({ id: "task_a", images: Array.from({ length: 5 }, () => image) }),
    ]),
  });
  assert.ok(validateTaskListDocument(tooMany).some((error) => error.includes("图片超过 4 张")));

  // MIME 不在白名单:校验函数入参是宽结构,直接构造非法 MIME 验证拒绝
  const badMime = {
    lists: {
      prj_1: {
        targetAgentId: null,
        autoSend: false,
        collapsed: false,
        tasks: [{ id: "task_a", title: "标题", content: "", images: [{ data: "x", mimeType: "image/svg+xml" }] }],
      },
    },
  };
  assert.ok(validateTaskListDocument(badMime).some((error) => error.includes("格式不支持")));

  // 单张 base64 超上限
  const tooLarge = doc({
    prj_1: entry([task({ id: "task_a", images: [{ data: "x".repeat(2_800_001), mimeType: "image/png" }] })]),
  });
  assert.ok(validateTaskListDocument(tooLarge).some((error) => error.includes("超过大小上限")));
});

test("pickNextTask:纯图片任务(内容空白)也可入队", () => {
  const image = { data: "aGVsbG8=", mimeType: "image/png" } as const;
  const tasks = [
    task({ id: "task_text_only" }),
    task({ id: "task_image_only", selected: true, content: "   ", images: [image] }),
  ];
  assert.equal(pickNextTask(tasks)?.id, "task_image_only");
  // 无文字也无图片:仍跳过
  const none = [task({ id: "task_empty", selected: true, content: "  ", images: [] })];
  assert.equal(pickNextTask(none), null);
});

test("taskMessageId:同一次投递重试幂等,重新排队(attempt 递增)产生新 id", () => {
  const first = task({ id: "task_a" });
  const retry = task({ id: "task_a" });
  assert.equal(taskMessageId(first), "tasklist:task_a:0");
  // 同一 attempt 的重试(发送失败后重试/多端并发):同一 messageId,daemon 去重防重复投递
  assert.equal(taskMessageId(first), taskMessageId(retry));
  // 重新排队:sentAt 清空 + attempt 递增 → 新 messageId,才能再次送达
  const requeued = task({ id: "task_a", sentAt: null, attempt: 1 });
  assert.equal(taskMessageId(requeued), "tasklist:task_a:1");
  assert.notEqual(taskMessageId(first), taskMessageId(requeued));
});

test("toggleTaskState:完成→取消;已发送→标记完成;其余→切换选中", () => {
  // 已发送未完成:点击 = 标记完成(绿色勾选),sentAt/selected 保持
  const sent = task({ id: "task_a", selected: true, sentAt: "2026-01-02T00:00:00Z" });
  assert.deepEqual(toggleTaskState(sent), { ...sent, done: true });
  // 已完成:点击 = 取消完成,回"已发送"态
  const done = task({ id: "task_b", sentAt: "2026-01-02T00:00:00Z", done: true });
  assert.equal(toggleTaskState(done).done, false);
  // 草稿/待发送:点击 = 切换选中
  const draft = task({ id: "task_c" });
  assert.equal(toggleTaskState(draft).selected, true);
  assert.equal(toggleTaskState(task({ id: "task_d", selected: true })).selected, false);
});

test("taskDisplayStatus:运行中/待验收按 settledAt 与相关 Agent 整体状态区分", () => {
  // 草稿与待发送
  assert.equal(taskDisplayStatus(task({ id: "t1" }), false), "draft");
  assert.equal(taskDisplayStatus(task({ id: "t2", selected: true }), false), "queued");
  // 已发送 + 相关 Agent 仍在执行(主 Agent 或任一子孙)+ 未结算 → 运行中
  const running = task({ id: "t3", selected: true, sentAt: "2026-01-02T00:00:00Z" });
  assert.equal(taskDisplayStatus(running, true), "running");
  // 已发送 + 相关 Agent 全部空闲 → 待验收(即使未结算)
  assert.equal(taskDisplayStatus(running, false), "sent");
  // 已结算的任务在后继任务运行期间保持待验收(核心诉求)
  const settled = task({
    id: "t4",
    selected: true,
    sentAt: "2026-01-02T00:00:00Z",
    settledAt: "2026-01-02T00:10:00Z",
  });
  assert.equal(taskDisplayStatus(settled, true), "sent");
  assert.equal(taskDisplayStatus(settled, false), "sent");
  // 完成/重新排队(未发送)互不干扰
  assert.equal(taskDisplayStatus(task({ id: "t5", done: true }), true), "done");
});

test("settleReadyIds:只含已发送、未结算、未完成的任务;空/无命中返回空集", () => {
  const tasks = [
    task({ id: "ready_a", sentAt: "2026-01-02T00:00:00Z" }),
    task({ id: "ready_b", sentAt: "2026-01-03T00:00:00Z", selected: true }),
    task({ id: "settled", sentAt: "2026-01-02T00:00:00Z", settledAt: "2026-01-02T00:05:00Z" }),
    task({ id: "done", sentAt: "2026-01-02T00:00:00Z", done: true }),
    task({ id: "draft", selected: true }),
  ];
  assert.deepEqual([...settleReadyIds(tasks)].sort(), ["ready_a", "ready_b"]);
  assert.deepEqual([...settleReadyIds([])], []);
  assert.deepEqual(
    [...settleReadyIds([task({ id: "draft" }), task({ id: "done", done: true })])],
    [],
  );
});

test("settleSentTasks:只结算已发送未完成未结算的任务,无变化返回 null", () => {
  const tasks = [
    task({ id: "a", sentAt: "2026-01-02T00:00:00Z" }),
    task({ id: "b", sentAt: "2026-01-02T00:00:00Z", settledAt: "2026-01-02T00:05:00Z" }),
    task({ id: "c", sentAt: "2026-01-02T00:00:00Z", done: true }),
    task({ id: "d" }),
  ];
  const settled = settleSentTasks(tasks, "2026-01-02T00:10:00Z");
  assert.ok(settled);
  assert.equal(settled.find((item) => item.id === "a")?.settledAt, "2026-01-02T00:10:00Z");
  assert.equal(settled.find((item) => item.id === "b")?.settledAt, "2026-01-02T00:05:00Z", "已结算不动");
  assert.equal(settled.find((item) => item.id === "c")?.settledAt, null, "已完成不回填");
  assert.equal(settled.find((item) => item.id === "d")?.settledAt, null, "未发送不回填");
  assert.equal(settleSentTasks(tasks.filter((item) => item.id !== "a"), "x"), null);
});

test("truncateTaskResult:短文本原样,超长截断到 TASK_RESULT_MAX", () => {
  assert.equal(truncateTaskResult("简短结果"), "简短结果");
  assert.equal(truncateTaskResult(""), "");
  const long = "x".repeat(TASK_RESULT_MAX + 100);
  const truncated = truncateTaskResult(long);
  assert.equal(truncated.length, TASK_RESULT_MAX);
  assert.equal(truncated, long.slice(0, TASK_RESULT_MAX));
});

test("applyTaskResults:只写命中任务,空 ids/无变化返回 null,result=null 清空", () => {
  const tasks = [
    task({ id: "task_a" }),
    task({ id: "task_b" }),
    task({ id: "task_c", result: "旧结果" }),
  ];
  const patched = applyTaskResults(tasks, new Set(["task_a", "task_c"]), "新结果");
  assert.ok(patched);
  assert.equal(patched.find((item) => item.id === "task_a")?.result, "新结果");
  assert.equal(patched.find((item) => item.id === "task_b")?.result, null, "未命中不改");
  assert.equal(patched.find((item) => item.id === "task_c")?.result, "新结果");
  assert.equal(tasks.find((item) => item.id === "task_a")?.result, null, "不改入参");

  // ids 为空 / 没有任何任务命中 → null(调用方跳过保存)
  assert.equal(applyTaskResults(tasks, new Set(), "新结果"), null);
  assert.equal(applyTaskResults(tasks, new Set(["task_missing"]), "新结果"), null);
  // 值无变化 → null
  assert.equal(applyTaskResults(patched, new Set(["task_a"]), "新结果"), null);

  // result=null 清空;已为 null 的任务不算变化
  const cleared = applyTaskResults(patched, new Set(["task_c"]), null);
  assert.ok(cleared);
  assert.equal(cleared.find((item) => item.id === "task_c")?.result, null);
  assert.equal(cleared.find((item) => item.id === "task_a")?.result, "新结果");
  assert.equal(applyTaskResults(cleared, new Set(["task_c"]), null), null);

  // 旧文档可能没有该字段:按 null 比较,清空不产生写入
  const legacy = [
    { ...task({ id: "task_legacy" }), result: undefined } as unknown as TaskRecord,
  ];
  assert.equal(applyTaskResults(legacy, new Set(["task_legacy"]), null), null);
  assert.equal(
    applyTaskResults(legacy, new Set(["task_legacy"]), "旧数据补快照")?.[0]?.result,
    "旧数据补快照",
  );

  // 写入侧统一截断,避免绕过 truncateTaskResult 的超长值落盘
  const long = applyTaskResults(
    [task({ id: "task_long" })],
    new Set(["task_long"]),
    "y".repeat(TASK_RESULT_MAX + 5),
  );
  assert.equal(long?.[0]?.result?.length, TASK_RESULT_MAX);
});

test("validateTaskListDocument 与 schema:result 超 8000 拒绝,上限内通过", () => {
  // 直接构造宽结构(勿用 task() helper,参照 badMime 写法)
  const withResult = (result: string) => ({
    lists: {
      prj_1: {
        targetAgentId: null,
        autoSend: false,
        collapsed: false,
        tasks: [{ id: "task_a", title: "标题", content: "", result, createdAt: "2026-01-01T00:00:00Z" }],
      },
    },
  });
  assert.deepEqual(validateTaskListDocument(withResult("x".repeat(TASK_RESULT_MAX))), []);
  assert.ok(
    validateTaskListDocument(withResult("x".repeat(TASK_RESULT_MAX + 1))).some((error) =>
      error.includes("结果超过"),
    ),
  );
  // 服务端 schema 与服务端校验同源:超限直接拒绝
  assert.equal(
    agentGraphTaskListSettings.schema.safeParse(withResult("x".repeat(TASK_RESULT_MAX + 1))).success,
    false,
  );
  assert.equal(
    agentGraphTaskListSettings.schema.safeParse(withResult("x".repeat(TASK_RESULT_MAX))).success,
    true,
  );
});

function compactRule(overrides: Partial<AutoCompactRule> = {}): AutoCompactRule {
  return {
    autoCompactMode: "off",
    autoCompactTaskInterval: 5,
    autoCompactTokensK: 300,
    tasksSinceCompact: 0,
    lastCompactAt: null,
    lastCompactUsage: null,
    ...overrides,
  };
}

test("shouldAutoCompact:off 一律不压,tasks 按累计任务数达到阈值", () => {
  const usage = { used: 99_000 };
  // off:即使任务数与用量都远超阈值也不触发
  assert.equal(shouldAutoCompact(compactRule({ tasksSinceCompact: 50 }), usage), false);
  // tasks:未达阈值不压,达到/超过才压
  const tasks = compactRule({ autoCompactMode: "tasks", autoCompactTaskInterval: 5 });
  assert.equal(shouldAutoCompact({ ...tasks, tasksSinceCompact: 4 }, usage), false);
  assert.equal(shouldAutoCompact({ ...tasks, tasksSinceCompact: 5 }, usage), true);
  assert.equal(shouldAutoCompact({ ...tasks, tasksSinceCompact: 9 }, usage), true);
  // 压缩后计数清零:天然防重复,不会在同一计数上再次触发
  assert.equal(shouldAutoCompact({ ...tasks, tasksSinceCompact: 0 }, usage), false);
});

test("shouldAutoCompact:tokens 绝对阈值与用量刷新防重复", () => {
  const tokens = compactRule({ autoCompactMode: "tokens", autoCompactTokensK: 300 });
  // 绝对阈值:300k = 300_000;未达不压,恰好达到/超过则压
  assert.equal(shouldAutoCompact(tokens, { used: 299_999 }), false);
  assert.equal(shouldAutoCompact(tokens, { used: 300_000 }), true);
  assert.equal(shouldAutoCompact({ ...tokens, lastCompactUsage: null }, { used: 341_000 }), true);
  // 与上次压缩用量不同 = 压缩后用量已刷新,仍超阈值则继续触发
  assert.equal(
    shouldAutoCompact({ ...tokens, lastCompactUsage: 280_000 }, { used: 341_000 }),
    true,
  );
  // 与上次压缩用量相同 = metadata 还没刷新出压缩后的新值,即使仍超阈值也不压
  assert.equal(
    shouldAutoCompact({ ...tokens, lastCompactUsage: 341_000 }, { used: 341_000 }),
    false,
  );
});

test("shouldAutoCompact:用量未知/模式未知一律 false", () => {
  const tokens = compactRule({ autoCompactMode: "tokens", autoCompactTokensK: 300 });
  // 用量未知:保守不压,不猜默认窗口
  assert.equal(shouldAutoCompact(tokens, { used: null }), false);
  // 非有限值同样按未知处理
  assert.equal(shouldAutoCompact(tokens, { used: Number.NaN }), false);
  assert.equal(shouldAutoCompact(tokens, { used: Number.POSITIVE_INFINITY }), false);
  // 旧文档未经过 schema 默认值:未知模式按关闭处理,绝不误压
  const unknown = compactRule({
    autoCompactMode: "bogus" as AutoCompactMode,
    tasksSinceCompact: 50,
  });
  assert.equal(shouldAutoCompact(unknown, { used: 999_000 }), false);
});

test("validateTaskListDocument 与 schema:自动压缩阈值(k)/interval 越界拒绝", () => {
  // 宽结构直接构造,不经过 defaultTaskListEntry 的默认合法值
  const withCompact = (autoCompactTokensK: number, autoCompactTaskInterval: number) => ({
    lists: {
      prj_1: {
        targetAgentId: null,
        autoSend: false,
        collapsed: false,
        autoCompactTokensK,
        autoCompactTaskInterval,
        tasks: [],
      },
    },
  });

  for (const tokensK of [9, 10001]) {
    assert.ok(
      validateTaskListDocument(withCompact(tokensK, 5)).some((error) =>
        error.includes("上下文阈值"),
      ),
      `tokensK ${tokensK} 应被拒绝`,
    );
    assert.equal(
      agentGraphTaskListSettings.schema.safeParse(withCompact(tokensK, 5)).success,
      false,
    );
  }
  for (const interval of [0, 51]) {
    assert.ok(
      validateTaskListDocument(withCompact(300, interval)).some((error) =>
        error.includes("任务间隔"),
      ),
      `interval ${interval} 应被拒绝`,
    );
    assert.equal(
      agentGraphTaskListSettings.schema.safeParse(withCompact(300, interval)).success,
      false,
    );
  }
  // 边界值合法
  assert.deepEqual(validateTaskListDocument(withCompact(10, 1)), []);
  assert.deepEqual(validateTaskListDocument(withCompact(10000, 50)), []);
  assert.equal(agentGraphTaskListSettings.schema.safeParse(withCompact(10, 1)).success, true);
  assert.equal(agentGraphTaskListSettings.schema.safeParse(withCompact(10000, 50)).success, true);
});
