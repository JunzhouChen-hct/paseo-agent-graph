import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignExitOffsets,
  buildFlowInterpolation,
  buildPolylinePath,
  buildSegmentViews,
  PATH_MIN_LENGTH,
  type Point,
} from "../shared/edge-geometry.ts";

function strictlyIncreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i]! > values[i - 1]!)) return false;
  }
  return true;
}

test("buildPolylinePath:路径即航点折线本身,不重采样不简化", () => {
  const waypoints: Point[] = [
    { x: 100, y: 148 },
    { x: 100, y: 177 },
    { x: 264, y: 177 },
    { x: 264, y: 206 },
  ];
  const path = buildPolylinePath(waypoints);
  assert.deepEqual(path.points, waypoints);
  assert.equal(path.total, 29 + 164 + 29);
  assert.ok(strictlyIncreasing(path.cumulative));
  assert.equal(path.cumulative.length, path.points.length);
});

test("buildPolylinePath:去掉连续重复点,退化路径弧长夹极小值", () => {
  const path = buildPolylinePath([
    { x: 5, y: 5 },
    { x: 5, y: 5 },
    { x: 9, y: 5 },
  ]);
  assert.equal(path.points.length, 2);
  assert.equal(path.total, 4);
  const degenerate = buildPolylinePath([{ x: 1, y: 1 }]);
  assert.equal(degenerate.points.length, 2);
  assert.ok(degenerate.total > 0);
  assert.ok(strictlyIncreasing(degenerate.cumulative));
});

test("buildSegmentViews:每非零段一个视图,宽=段长+线宽,正交段角度 0/90", () => {
  const path = buildPolylinePath([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 58 },
  ]);
  const views = buildSegmentViews(path, 2);
  assert.equal(views.length, 2);
  assert.equal(views[0]!.rotateDeg, 0);
  assert.equal(views[1]!.rotateDeg, 90);
  assert.equal(views[0]!.width, 102); // 100 + 2
  assert.equal(views[0]!.height, 2);
});

test("buildFlowInterpolation:输入=累计弧长,输出=点坐标偏移半径", () => {
  const path = buildPolylinePath([
    { x: 10, y: 10 },
    { x: 30, y: 10 },
  ]);
  const interp = buildFlowInterpolation(path, 5);
  assert.deepEqual(interp.inputRange, path.cumulative);
  assert.deepEqual(interp.outputX, [7.5, 27.5]);
  assert.deepEqual(interp.outputY, [7.5, 7.5]);
});

test("assignExitOffsets:单 child 居中,多 child 有序且唯一", () => {
  assert.deepEqual(assignExitOffsets(196, 1, 24), [98]);
  const offsets = assignExitOffsets(196, 4, 24);
  assert.equal(offsets.length, 4);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i]! > offsets[i - 1]!);
  }
  assert.ok(new Set(offsets).size === offsets.length);
  assert.equal(assignExitOffsets(0, 2, 24).length, 0);
});

test("导出常量存在(渲染层依赖)", () => {
  assert.equal(typeof PATH_MIN_LENGTH, "number");
});

