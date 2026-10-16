import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenameSubmitter, renameAgentRpc, sanitizeRenameTitle } from "../shared/graph";

test("rename 契约:空标题被 input schema 拒绝,正常标题通过", () => {
  assert.throws(() => renameAgentRpc.input.parse({ agentId: "agent-1", title: "" }));
  const parsed = renameAgentRpc.input.parse({ agentId: "agent-1", title: "新话题" });
  assert.deepEqual(parsed, { agentId: "agent-1", title: "新话题" });
});

test("rename 清洗:空白标题(纯空格/制表符)明确拒绝,正常值 trim 后保留", () => {
  assert.equal(sanitizeRenameTitle("   "), null);
  assert.equal(sanitizeRenameTitle("\t \n"), null);
  assert.equal(sanitizeRenameTitle("  新话题  "), "新话题");
});

test("rename 输出契约:ok/error 形状与 cancel 一致,错误可空", () => {
  const output = renameAgentRpc.output.parse({ ok: false, error: "Workspace not found" });
  assert.equal(output.ok, false);
  assert.equal(renameAgentRpc.output.parse({ ok: true, error: null }).ok, true);
});

/** 受控延迟的 RPC stub:resolve 由测试手动放行 */
function deferredRenameAgent() {
  const calls: { agentId: string; title: string }[] = [];
  let release: (result: { ok: boolean; error: string | null }) => void = () => {};
  const renameAgent = (input: { agentId: string; title: string }) => {
    calls.push(input);
    return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
      release = resolve;
    });
  };
  return { renameAgent, calls, release: (result: { ok: boolean; error: string | null }) => release(result) };
}

test("提交器:同帧并发调用被同步锁丢弃,仅一次 RPC 与一次成功回调", async () => {
  const stub = deferredRenameAgent();
  let successes = 0;
  let pendingTicks = 0;
  const submitter = createRenameSubmitter({
    renameAgent: stub.renameAgent,
    onBlank: () => assert.fail("不应走空白分支"),
    onFailure: () => assert.fail("不应走失败分支"),
    onSuccess: () => {
      successes += 1;
    },
    onDiscard: () => assert.fail("不应丢弃"),
    isCurrentAgent: (id) => id === "agent-1",
    onPendingChange: (pending) => {
      if (pending) pendingTicks += 1;
    },
  });
  const target = { agentId: "agent-1", draft: "  新话题  " };
  // 同帧两次(快速确认/onSubmitEditing+按钮):第二次必须被同步锁丢弃
  const first = submitter(target);
  const second = submitter(target);
  stub.release({ ok: true, error: null });
  await first;
  await second;
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0], { agentId: "agent-1", title: "新话题" });
  assert.equal(successes, 1);
  assert.equal(pendingTicks, 1, "锁置位只发生一次(第二个调用未进入)");
});

test("提交器:失败走 onFailure 保留草稿,锁释放后可再次提交", async () => {
  const failures: string[] = [];
  let successes = 0;
  let calls = 0;
  const submitter = createRenameSubmitter({
    renameAgent: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: "daemon 拒绝" } : { ok: true, error: null };
    },
    onBlank: () => assert.fail("不应走空白分支"),
    onFailure: (message) => failures.push(message),
    onSuccess: () => {
      successes += 1;
    },
    onDiscard: () => assert.fail("不应丢弃"),
    isCurrentAgent: () => true,
    onPendingChange: () => {},
  });
  await submitter({ agentId: "agent-1", draft: "话题A" });
  assert.deepEqual(failures, ["daemon 拒绝"]);
  assert.equal(successes, 0, "失败不关闭输入(草稿保留)");
  await submitter({ agentId: "agent-1", draft: "话题B" });
  assert.equal(successes, 1, "锁已释放,重试成功");
  assert.equal(calls, 2);
});

test("提交器:RPC 抛错同样走 onFailure 且锁释放,空白/换 agent 不触达 RPC", async () => {
  const failures: string[] = [];
  let blanked = 0;
  let discarded = 0;
  let calls = 0;
  const submitter = createRenameSubmitter({
    renameAgent: async () => {
      calls += 1;
      throw new Error("连接断开");
    },
    onBlank: () => {
      blanked += 1;
    },
    onFailure: (message) => failures.push(message),
    onSuccess: () => assert.fail("不应成功"),
    onDiscard: () => {
      discarded += 1;
    },
    isCurrentAgent: (id) => id === "agent-1",
    onPendingChange: () => {},
  });
  await submitter({ agentId: "agent-1", draft: "话题" });
  assert.deepEqual(failures, ["连接断开"]);
  await submitter({ agentId: "agent-1", draft: "   " });
  await submitter({ agentId: "agent-2", draft: "别改错" });
  assert.equal(blanked, 1);
  assert.equal(discarded, 1);
  assert.equal(calls, 1, "空白与切换会话分支均不触达 RPC");
});
