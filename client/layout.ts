/**
 * 层级列布局(从左到右):第 1 列为主 Agent(根),第 2 列为子 Agent,
 * 第 3 列为孙 Agent,整棵树向右延伸。借鉴 pase-omo 工作流画板的波次列:
 * 每代一列,列内竖直装箱;子块跟随父(按父列顺序重建列内顺序),再整体
 * 向父卡片垂直中心收拢(不与列内其他卡片冲突时)。列间通道(列间距
 * gapCol)留给连线的竖直车道;列内行距 gapRow 与旧版卡片水平间距同节奏。
 * 孤儿提升为根(父不在图中或纯环节点)的语义与旧版一致:根 = 第 1 列。
 * 支持每节点独立尺寸(sizes):未指定的节点用统一 cardWidth/cardHeight;
 * 列宽取列内最宽节点,窄节点(如任务列表折叠小图标)与同列卡片左对齐。
 */

export interface LayoutPosition {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, LayoutPosition>;
  width: number;
  height: number;
}

export function computeLayout(
  ids: string[],
  parentOf: ReadonlyMap<string, string | null>,
  cardWidth: number,
  cardHeight: number,
  gapCol: number,
  gapRow: number,
  sizes?: ReadonlyMap<string, { width: number; height: number }>,
): LayoutResult {
  const widthOf = (id: string): number => sizes?.get(id)?.width ?? cardWidth;
  const heightOf = (id: string): number => sizes?.get(id)?.height ?? cardHeight;
  const idSet = new Set(ids);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];

  // 按输入顺序把每个节点挂到父节点(父不在图中或父即自己的视为根)
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null;
    if (parent && idSet.has(parent) && parent !== id) {
      const list = childrenOf.get(parent);
      if (list) list.push(id);
      else childrenOf.set(parent, [id]);
    } else {
      roots.push(id);
    }
  }

  // 环防护:从根可达的节点标记,剩下未标记的(纯环)也当根
  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  for (const id of ids) {
    if (!reachable.has(id)) {
      roots.push(id);
      walk(id);
    }
  }

  // 分列:col = 到根的距离(树:每节点单父)。环兜底的根也落在第 1 列
  const colOf = new Map<string, number>();
  const columns: string[][] = [];
  for (const root of roots) {
    colOf.set(root, 0);
    (columns[0] ??= []).push(root);
  }
  for (let c = 0; c < columns.length; c++) {
    for (const id of columns[c] ?? []) {
      for (const child of childrenOf.get(id) ?? []) {
        if (colOf.has(child)) continue;
        colOf.set(child, c + 1);
        (columns[c + 1] ??= []).push(child);
      }
    }
  }

  const positions = new Map<string, LayoutPosition>();
  let maxBottom = 0;
  let maxRight = 0;
  const mark = (id: string, x: number, y: number) => {
    positions.set(id, { x, y });
    maxBottom = Math.max(maxBottom, y + heightOf(id));
    maxRight = Math.max(maxRight, x + widthOf(id));
  };

  // 向父收拢:列内同一父节点的连续兄弟块,整体平移到父卡片垂直中心
  // (不与列内其他卡片冲突时)。自上而下逐块处理;可用区间由上方卡片
  // (已收拢定型)之下与下方卡片当前位置之上夹出——初始装箱保证了
  // 区间必含当前位置,夹取后的落位不会引入任何重叠
  const pullTowardParents = (column: string[], columnIndex: number) => {
    if (columnIndex === 0) return;
    let index = 0;
    while (index < column.length) {
      const parent = parentOf.get(column[index]!) ?? null;
      let end = index;
      while (end + 1 < column.length && (parentOf.get(column[end + 1]!) ?? null) === parent) {
        end++;
      }
      const run = column.slice(index, end + 1);
      index = end + 1;
      if (!parent) continue;
      const parentPos = positions.get(parent);
      if (!parentPos) continue;
      const blockHeight =
        run.reduce((sum, id) => sum + heightOf(id), 0) + gapRow * (run.length - 1);
      const parentCenter = parentPos.y + heightOf(parent) / 2;
      const desired = parentCenter - blockHeight / 2;
      const current = positions.get(run[0]!)!.y;
      let minAllowed = 0;
      let maxAllowed = Infinity;
      for (const id of column) {
        if (run.includes(id)) continue;
        const otherY = positions.get(id)!.y;
        if (otherY < current) {
          minAllowed = Math.max(minAllowed, otherY + heightOf(id) + gapRow);
        } else {
          maxAllowed = Math.min(maxAllowed, otherY - gapRow - blockHeight);
        }
      }
      const next = Math.min(Math.max(desired, minAllowed), Math.max(minAllowed, maxAllowed));
      if (Math.abs(next - current) < 0.5) continue;
      let y = next;
      for (const id of run) {
        mark(id, positions.get(id)!.x, y);
        y += heightOf(id) + gapRow;
      }
    }
  };

  // 逐列放置:x = 前列最宽节点 + gapCol;列内按最终顺序竖直装箱后向父收拢;
  // 下一列的成员顺序按本列最终顺序重建(子块跟随父,减少交叉)
  let cursorX = 0;
  for (let c = 0; c < columns.length; c++) {
    let column = columns[c] ?? [];
    if (c > 0) {
      const previous = columns[c - 1] ?? [];
      const ordered: string[] = [];
      for (const parent of previous) {
        for (const child of childrenOf.get(parent) ?? []) {
          if (colOf.get(child) === c) ordered.push(child);
        }
      }
      // 防御:重建遗漏的成员(理论上不存在)保持在内,不丢节点
      for (const id of column) {
        if (!ordered.includes(id)) ordered.push(id);
      }
      columns[c] = ordered;
      column = ordered;
    }
    let y = 0;
    for (const id of column) {
      mark(id, cursorX, y);
      y += heightOf(id) + gapRow;
    }
    pullTowardParents(column, c);
    const columnWidth = column.reduce((max, id) => Math.max(max, widthOf(id)), 0);
    cursorX += columnWidth + gapCol;
  }

  return {
    positions,
    width: Math.max(maxRight, cardWidth),
    height: Math.max(maxBottom, cardHeight),
  };
}
