# 任务列表(Task List)设计文档

> 状态:设计定稿,待实现。实现时以本文档为准;与本仓库现有代码风格/OVERVIEW.md 约定冲突时,先保持一致再动笔。

## 1. 需求与目标

用户在主 Agent 忙于上一步任务时,随时把新想到的开发任务记到一个任务列表里;列表挂载在主 Agent 旁边(节点图画布上)。开启"自动发送"后,当主 Agent 及其所有相关 Agent(子孙树)都空闲时,按顺序自动把选中的任务发送给主 Agent。任务支持:编辑、上下移动、删除、复选框(选中/完成)、点击弹出详情(编辑标题与内容)。已完成的任务绿色字体并显示勾选状态。

## 2. 数据模型

新增 host settings 文档(与既有 `agent-graph-settings`、`agent-graph-templates` 分离):`shared/task-list.ts` 中

```ts
export const agentGraphTaskListSettings = defineSettings({
  id: "agent-graph-tasks",
  scope: "host",
  version: 1,
  schema: z.object({
    /** 键 = 真实 projectId(与面板聚合键一致) */
    lists: z.record(
      z.string(),
      z.object({
        /** 绑定的主 Agent(任务发送目标);null = 未绑定 */
        targetAgentId: z.string().nullable().default(null),
        /** 自动发送总开关 */
        autoSend: z.boolean().default(false),
        /** 数组顺序即展示与发送顺序 */
        tasks: z.array(taskRecordSchema).max(100).default([]),
      }),
    ).default({}),
  }),
});
```

`taskRecordSchema`:

```ts
{
  id: z.string().min(1),          // "task_" + 12位随机,创建后不变(幂等 messageId 派生自它)
  title: z.string().min(1).max(200),   // 展示标题(详情可编辑)
  content: z.string().max(20000),      // 实际发送的消息内容
  selected: z.boolean().default(false),// 选中 = 参与自动发送队列
  done: z.boolean().default(false),    // 完成 = 绿色字体 + 勾选状态
  sentAt: z.string().nullable().default(null), // ISO 时间;null = 未发送
  createdAt: z.string(),               // ISO 时间
}
```

校验(`superRefine`):同一 list 内 task id 唯一;title trim 非空。文档级校验函数 `validateTaskListDocument` 供客户端保存前共用(仿 `validateTemplateDocument`)。

### 任务状态机(单个复选框统一表达,详见 §6)

| selected | sentAt | done | 视觉 |
|---|---|---|---|
| false | null | false | 草稿:空框,普通字体 |
| true | null | false | 已选中/排队中:勾选框,徽标"待发送"(队列序号) |
| 任意 | 非 null | false | 已发送:徽标"已发送 HH:MM",等待执行结果 |
| 任意 | 任意 | true | **已完成:绿色字体 + 绿色打勾**(复选框呈完成态) |

- 完成的任务字体变绿并显示勾选状态 —— `done=true` 直接驱动。
- "自动发送选中的任务" —— `selected=true && !done && sentAt==null` 的任务按数组顺序进入自动发送队列。
- 已发送任务的勾选框保持选中态但不再重复发送(`sentAt` 屏蔽)。

## 3. 主 Agent 的绑定

- `lists[projectId].targetAgentId` 指定发送目标(即"主 Agent")。
- **默认绑定**:用户首次打开任务列表时,若画布有选中卡片则绑定该 agent;否则取当前 workspace 内唯一根 agent(无父、未归档);再不行取项目内最早的未归档 agent;都没有则 null(空态引导选择)。
- **换绑**:列表头部"主Agent"chip 打开 Modal picker(仿 console 的模型选择器),候选 = 项目内全部未归档 agent,按 createdAt 升序,显示标题 + 工作区标识。
- **目标失效**(归档/从目录消失):列表仍可编辑,顶部显示警示条"主Agent 已归档/不存在,自动发送已暂停,请重新选择";自动发送引擎暂停。

## 4. 画布挂载卡片(挂载主 Agent 右侧,可折叠)

在 `panel.tsx` 中手动定位(实现时已从"伪子节点"方案改为右侧挂载):

- 位置由纯函数 `placeTaskCard` 决定(实现时定稿):优先主 Agent **右侧同行**,该槽位被其他卡片占用则尝试左侧,再退到主 Agent 下方;全部被占时仍返回右侧(宁可重叠不让入口消失)。挂载卡片矩形同时作为其他连线的避障障碍。
- 连线:主 Agent 侧边中点 → 卡片侧边中点,画**灰色虚线**(同行水平直连,回落下方时正交拐),无流光、无呼吸,不参与 `planEdgePath` 避障统计(degraded 计数不含它)。折叠成小图标时不画线。
- **折叠**:卡片头部有折叠按钮(`PanelRightClose`),折叠后收成 36×36 小图标(同样走 `placeTaskCard` 定位,显示待发数角标),点击展开;折叠状态按项目持久化在 `collapsed` 字段。
- 目标 agent 不在 `visible` 列表(如已归档且被隐藏)时不渲染挂载物;头部入口按钮仍在。

`client/task-list-card.tsx` 的 `AgentTaskCard`:

- 头部:`ListTodo` 图标 + "任务列表" + 自动发送指示(`Zap` 图标,开启时 accent/绿色,关闭时灰)。
- 统计行:`待发 N · 已发送 M · 完成 K`。
- 预览:最多 3 条(数组顺序),每条 = 迷你复选框 + 标题(超长截断;done 的绿色)。
- 点击卡片 → 底部打开任务列表控制台(见 §5);点击某条预览任务 → 底部直接打开该任务的详情视图。
- 自动发送触发中(引擎正在等待/刚发送)时头部指示灯可显示"等待空闲"/"已发送"微文案。

## 5. 底部控制台 TaskListConsole(client/task-list-console.tsx)

与 `AgentConsole` 同槽位互斥。`panel.tsx` 的选中状态从 `selected: string | null` 扩展为:

```ts
type BottomView =
  | { kind: "none" }
  | { kind: "agent"; agentId: string }     // 原 selected(排除 create: 哨兵后)
  | { kind: "create"; parentId: string }   // 原 "create:" 哨兵
  | { kind: "tasks" }                      // 任务列表
  | { kind: "task-detail"; taskId: string }; // 任务详情
```

- 打开任一视图时关闭其他视图(单一槽位,与现状一致)。卡片选中高亮只在 `kind === "agent"` 时生效。
- 窄屏(compact)行为与 console 相同:进入后占满全部可用区域,`KeyboardAvoidingView` 包裹;详情在窄屏是独立整屏视图,带返回按钮。

### 5.1 列表视图

- **头部**:标题"任务列表" + 主Agent chip(点击换绑)+ 自动发送开关 chip(`Zap`,开启时高亮,点击切换并 toast 提示)+ 相关状态文案("相关 Agent 全部空闲" / "N 个运行中")。
- **警示条**:主Agent 失效时显示(见 §3)。
- **任务行**(每行):
  - 行首复选框(48px 触控区):语义见 §2 状态机。done 时点击 = 取消完成;未 done 时点击 = 切换 selected。
  - 标题(done → `statusSuccess` 绿色;已发送未完成 → 前缀"已发送 HH:MM"小徽标;待发送 → 队列序号徽标)。
  - 行尾操作:上移/下移(`ChevronUp`/`ChevronDown`,端点禁用)、删除(`Trash2`,直接删除 + toast,不做确认弹窗——任务成本低、误删可重写)。
  - 点击行主体 → 详情视图。
- **快速添加**:底部输入框 placeholder"想到什么就写下来,Enter 添加",Enter 或发送按钮新增任务:`title = 输入内容(trim,上限 200)`,`content = 同 title`,`selected = false, done = false`。新增后 toast"已添加,点击可补充内容"。
- 空态:引导文案"主 Agent 工作时想到的任务先记在这里"。

### 5.2 详情视图

- 返回按钮 → 回列表视图。
- 标题输入(单行);内容输入(多行,placeholder"发送给主 Agent 的具体任务内容",高度可增长)。
- 操作按钮:
  - **保存**:校验(标题非空、≤200;内容 ≤20000)后 `settings.save`;成功 toast + 返回列表。
  - **立即发送**:任何状态下可用(发送目标 = 绑定的主 Agent,必须有效);发送成功后该任务 `sentAt = now`。与自动发送共用同一条发送路径(stable messageId,见 §7),发送中禁用按钮。
  - **重新排队**:仅 `sentAt != null` 时显示;清空 `sentAt` 并置 `selected = true`,回到待发送队列。
  - **标记完成 / 取消完成**:切换 `done`。
  - **删除**:删除并返回列表。
- 脏数据保护:有未保存修改时返回/删除先弹确认(仿归档确认 Modal)。

## 6. 复选框交互细则(澄清需求歧义后的定稿)

用户原话同时出现"自动发送**选中的**任务"与"**完成的**任务显示勾选状态"。定稿:**一个复选框、两层语义**,与用户描述逐条对齐:

- 未完成任务时,勾选 = 选中(进入自动发送队列);
- 任务完成后(手动"标记完成"或详情按钮),勾选框呈绿色打勾完成态、标题变绿;
- 已发送(`sentAt != null`)的任务不会因保持勾选而被重复发送;
- 想撤回一个已发送任务重新发送 → 详情里"重新排队"。

## 7. 自动发送引擎(client/use-task-auto-send.ts + shared/task-list.ts 纯函数)

**纯客户端编排**(与 console queue 模式同一先例与边界),不新增 server RPC。纯逻辑放 `shared/task-list.ts` 便于 node:test 覆盖:

```ts
/** 主 Agent + 全部传递子孙(基于 parentOf;目录里不可见/归档节点不计入) */
export function relatedAgentIds(targetId: string, parentOf: ReadonlyMap<string, string | null>): Set<string>;

/** 空闲 = 未归档 && status==="idle" && !(requiresAttention && attentionReason !== "finished") */
export type AgentIdleInput = { archived: boolean; status: AgentRunStatus | null; requiresAttention: boolean; attentionReason: string | null };
export function isIdleForSend(agent: AgentIdleInput): boolean;

/** 下一个待发送任务:数组顺序首个 selected && !done && sentAt==null && content.trim() 非空 */
export function pickNextTask(tasks: readonly TaskRecord[]): TaskRecord | null;
```

### Hook 行为(`useTaskAutoSend`)

输入:projectId、目录 `agents`、`metas`(parentOf 与实时 status)、当前 list(autoSend/targetAgentId/tasks)、paseo、toast。

- **相关集合**:target + 子孙(子代来自卡片 live 快照的 `parentId`;所有可见 agent 都有卡片,metas 未就绪时保守视为"忙",不发送)。
- **全空闲判定**:相关集合内每个 agent 用 `isIdleForSend`;集合以"可见 + metas 就绪"为准。target 本身 `finished` 关注视为空闲(发送会开启新回合;参考 `toneOf` 对 finished 的特判)。
- **触发**:autoSend 为开 && target 有效 && `pickNextTask` 非空 && 全空闲**持续 `IDLE_CONFIRM_MS = 2000`**。计时器在条件破坏时清除(回合间隙的瞬时 idle 不误发;2 秒由常量暴露并注释原因)。
- **发送**(与 §5.2 立即发送共用 `sendTask` 函数):
  - 稳定 messageId:`tasklist:${task.id}` —— daemon 按 messageId 去重,重试/多端并发不会重复投递;
  - `activeTurnBehavior: "steer"`(协议限制,queue 是纯客户端编排,见 console.tsx 同注释);
  - `paseo.agents.ref(targetAgentId).send(content.trim(), { activeTurnBehavior: "steer", messageId })`;
  - 成功后持久化 `sentAt`:`settings.save({...doc, 该任务 sentAt}, settings.revision)`;revision 冲突时重读最新文档、只 patch 该任务字段后重试一次(仿模板冲突恢复);仍失败 → toast,任务保持未发送;
  - 失败 → toast.error,任务保持未发送,引擎去抖后自然重试;
  - 发送中用组件级 ref 锁防重入(参照 `createRenameSubmitter` 的 pendingRef 模式:await 前置位、finally 释放,锁权威在 ref 不在 state)。
- **时序**:发送成功后目标转 running(订阅自动更新)→ 条件破坏 → 计时器清除 → 下一轮全空闲再发下一条。即任务逐条串行执行。
- **边界**:
  - 面板关闭/宿主页面后台时引擎不运行(客户端编排的固有限制,OVERVIEW 中如实说明);
  - 多端同时开面板:稳定 messageId 保证不重复投递;
  - 自动发送开启但未绑定主 Agent:开关仍可开,引擎空转并在列表显示引导。

## 8. 文件与改动清单

| 文件 | 动作 |
|---|---|
| `shared/task-list.ts` | 新增:settings 文档、类型、纯函数(relatedAgentIds / isIdleForSend / pickNextTask / 文档校验 / 重排帮助函数) |
| `index.server.ts` | 注册 `server.registerSettings(agentGraphTaskListSettings)`(无新 RPC) |
| `client/task-list-card.tsx` | 新增:画布挂载卡片 |
| `client/task-list-console.tsx` | 新增:底部列表 + 详情视图 |
| `client/use-task-auto-send.ts` | 新增:自动发送 hook(含 sendTask 共用路径) |
| `client/panel.tsx` | 集成:BottomView 状态机、伪节点布局与虚线、header"任务列表"入口按钮、compact 全屏分支 |
| `tests/task-list.test.ts` | 新增:纯函数与文档校验测试(node:test + assert/strict,仿 project-scope.test.ts) |
| `OVERVIEW.md` | 新增"任务列表"章节:功能、状态机、自动发送语义与边界(面板需打开、messageId 幂等、2 秒确认窗) |

## 9. 验收标准

1. 画布主 Agent 下方(子节点位)出现"任务列表"卡片,虚线连线,展示统计与前三条预览;无重叠、随布局自动扩展。
2. 点卡片 → 底部弹出列表;点预览任务或列表行 → 详情;窄屏下均为整屏 + 返回。
3. 快速添加 / 编辑标题内容 / 上下移 / 删除 / 勾选 全部可用且持久(重启面板后仍在,按 projectId 隔离)。
4. 勾选若干任务、开启自动发送:主 Agent 与其子孙全部空闲持续 2 秒后,第一条被发送并标"已发送";回合结束后依次发送剩余;有 agent 运行/等待权限/出错时不发送。
5. done 任务绿色字体 + 绿色打勾;"立即发送""重新排队""标记完成"行为符合 §5.2。
6. 主Agent 归档/消失:警示条 + 引擎暂停,列表可编辑。
7. `npm run typecheck` 通过;`node --test tests/task-list.test.ts` 通过。
