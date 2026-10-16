import { test } from "node:test";
import assert from "node:assert/strict";
import { renameAgentRpc, sanitizeRenameTitle } from "../shared/graph";

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
