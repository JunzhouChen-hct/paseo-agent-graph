import { test } from "node:test";
import assert from "node:assert/strict";
import { relatedNodeIds } from "../shared/graph.ts";

test("聚焦:选中子 Agent = 自身 + 全部传递祖先 + 全部传递子孙,兄弟不相关", () => {
  const ids = ["root", "a", "b", "a1", "a2", "a1x"];
  const parentOf = new Map<string, string | null>([
    ["root", null],
    ["a", "root"],
    ["b", "root"],
    ["a1", "a"],
    ["a2", "a"],
    ["a1x", "a1"],
  ]);
  const related = relatedNodeIds(ids, parentOf, "a1");
  assert.deepEqual(
    [...related].sort(),
    ["a1", "a", "root", "a1x"].sort(),
    "选中 a1:父 a、祖父 root 与孙 a1x 相关,兄弟 a2/叔 b 不相关",
  );
});

test("聚焦:选中主 Agent(根)= 全部传递子孙", () => {
  const ids = ["root", "a", "b", "a1"];
  const parentOf = new Map<string, string | null>([
    ["root", null],
    ["a", "root"],
    ["b", "root"],
    ["a1", "a"],
  ]);
  const related = relatedNodeIds(ids, parentOf, "root");
  assert.deepEqual([...related].sort(), ["root", "a", "b", "a1"].sort());
});

test("聚焦:父不在显示集内时不算相关(工作区范围下父被切掉)", () => {
  const ids = ["a1", "a1x"];
  const parentOf = new Map<string, string | null>([
    ["a", "root"],
    ["a1", "a"],
    ["a1x", "a1"],
  ]);
  const related = relatedNodeIds(ids, parentOf, "a1");
  assert.deepEqual([...related].sort(), ["a1", "a1x"].sort());
});

test("聚焦:环不死循环,孤儿(父不在集中)按无父处理,选中者不在集中返回空", () => {
  const ids = ["x", "y"];
  const parentOf = new Map<string, string | null>([
    ["x", "y"],
    ["y", "x"],
  ]);
  // 纯环:x 与 y 互为父子,BFS visited 保证终止
  const related = relatedNodeIds(ids, parentOf, "x");
  assert.ok(related.has("x"));
  assert.ok(related.has("y"));
  // 父不在显示集:视为无父
  const lone = relatedNodeIds(["a"], new Map([["a", "ghost"]]), "a");
  assert.deepEqual([...lone], ["a"]);
  // 选中者不在显示集:空集合(面板侧不会发生,防御)
  assert.equal(relatedNodeIds(["a"], new Map([["a", null]]), "zz").size, 0);
});
