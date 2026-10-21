# 模板节点 prompt + 子 Agent 自动名册 设计文档

> 状态:设计定稿,待实现。实现必须与 `docs/task-list-design.md`(已实现)与本仓库现有风格一致。

## 1. 背景与目标

模板建树(`新建任务`)目前只有主节点收到首条 prompt,子节点全部静默待命;且 **主 Agent 不会自动知道子 Agent 的存在**(父子关系只是目录元数据,daemon 不通知),它要调度子 Agent 只能通过 Paseo MCP 工具,前提是它的指令里写明了子 Agent 的 id 与分工。本设计解决两件事:

1. **每个模板节点可配置"启动指令"(prompt)**:建树成功后立即发送,子 Agent 带着角色/任务开跑(固定分工并行场景)。
2. **主节点自动收到子 Agent 名册**:追加在其收到的消息后,明确告知有哪些子 Agent、各自角色、如何派发——保证主 Agent"知道"。

## 2. 数据模型

`shared/template-model.ts` 的 `templateNodeSchema` 增加可选字段:

```ts
/** 启动指令:建树成功后立即发送给该节点(可选;子 Agent 配置后立即开跑) */
prompt: z.string().max(20000).optional(),
```

- 可选字段,旧文档解析不受影响,`agentGraphTemplatesSettings` version 保持 1。
- `validateTemplateNodes` 不因 prompt 增加新约束(空串视同未配置)。
- "从当前节点生成"导入:**不提取** prompt(live agent 的会话内容不是配置),导入的节点 prompt 恒为空,编辑器提示用户补填。

## 3. 名册构建(纯函数,放 `shared/template-model.ts`)

```ts
/**
 * 子 Agent 名册:追加到主节点首条消息末尾,让主 Agent 知道有哪些子 Agent、
 * 如何通过 Paseo MCP 工具调度。nodes 为模板节点,keyToAgent 为建树结果。
 */
export function buildChildRoster(
  nodes: readonly TemplateNodeConfig[],
  keyToAgent: ReadonlyMap<string, string>,
): string | null;
```

- 只有非根节点且 `keyToAgent` 中存在其 agentId 的节点进入名册;没有子 Agent 时返回 null。
- 格式(追加到主节点消息末尾,前置 `\n\n---\n`):

```
---
[子 Agent 名册](随任务模板自动创建;通过 Paseo MCP 工具调度:send_agent_prompt 发送任务、get_agent_status 查询状态、cancel_agent 请求停止):
- agt_xxx:编码实现(模板节点「编码」, provider/model)
- agt_yyy:代码 Review(模板节点「Review」, provider/model)
```

- 行内容:`{agentId}:{node.title || "子 Agent"}(模板节点「{node.key}」{node.prompt ? ",已带启动指令" : ",待你派发"})`——注明该子 Agent 是"已带启动指令自行开跑"还是"待派发",主 Agent 才能正确决策。
- key 已脱敏不需要;node.key 仅作标识。

## 4. 建树与发送流程(`server/templates.ts` handleCreateTaskFromTemplate)

建树部分不变(拓扑序 + 幂等 key)。创建完成后的发送阶段改为:

1. **逐节点发送启动指令**:按拓扑序遍历,`node.prompt?.trim()` 非空的节点(含主节点)在创建后发送其指令,
   `messageId = makeIdempotencyKey(runId, \`prompt:\${node.key}\`)`,`activeTurnBehavior: "steer"`。
   注意:发送会使该节点**立即开始运行**——这正是"固定分工"语义;UI 需说明。
2. **主节点任务 prompt**:最后发送表单里的 `prompt`(若非空),messageId 沿用现有 `makeIdempotencyKey(runId, "prompt")`,内容 = `prompt + 名册`(名册存在时追加)。主节点自己的启动指令同样搭载名册(review 定稿:否则"主节点有指令 + 任务 prompt 为空"时名册无处可搭,会丢失)。
3. **兜底名册通知**:主节点既无启动指令也无任务 prompt、但存在子 Agent 时,发送一条最小名册通知
   (内容 = "你的子 Agent 已创建并就绪,等待你的安排:\n" + 名册),messageId `makeIdempotencyKey(runId, "roster")`——保证"主 Agent 知道"不依赖用户是否填了任务描述。
4. **失败语义**:单条发送失败不回滚树;收集为 `sendErrors: { key, agentId, error }[]` 返回,UI 显式列出
   ("节点「编码」的启动指令发送失败:xxx"),不静默吞掉。输出 schema 增加 `sendErrors` 数组。

## 5. UI(`client/templates.tsx`)

- **节点编辑器**:每个节点增加"启动指令(可选)"多行输入(placeholder 说明:"建树成功后立即发送,该 Agent 会立刻开始执行;留空则待命,由主 Agent 派发"),上限 20000 字,显示字数。
- **节点列表**:配置了启动指令的节点显示小标记(如 `Zap` 图标)。
- **新建任务表单**:任务 prompt 的说明补充"发送给主 Agent 时会自动附上子 Agent 名册"。
- **创建结果**:已有"部分失败列出节点 id"的基础上,追加列出 sendErrors。

## 6. 测试

- `tests/template-model.test.ts`:schema 接受/拒绝非法 prompt(>20000);旧文档(无 prompt 字段)解析不破;`buildChildRoster` 各分支(无子节点 → null;部分节点无 agentId 跳过;带/不带启动指令的标注文案)。
- 既有测试全绿;`npm run typecheck` 通过。

## 7. 文档

- `OVERVIEW.md` 节点模板章节:补充节点启动指令、名册自动追加、失败语义与"导入不提取 prompt"的限制。

## 8. 验收标准

1. 模板节点可填写启动指令并随模板保存(旧模板不受影响)。
2. 按模板新建任务:配置了指令的节点建树后立即收到指令开跑;主节点消息末尾自动带名册(含"已带启动指令/待派发"标注);主节点无任何消息但存在子节点时收到兜底名册通知。
3. 发送失败逐条列出,不回滚已创建的树;重试(同 runId)不重复发送(messageId 幂等)。
4. typecheck + 全部测试通过;OVERVIEW 同步更新。
