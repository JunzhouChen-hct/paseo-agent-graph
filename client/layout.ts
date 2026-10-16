/**
 * 分层流式树布局:每层子节点按 maxRowWidth 装箱换行,
 * 父卡片水平居中于其子树包围盒上方,行内同样居中。
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

interface SubtreeSize {
  width: number;
  height: number;
}

interface Row {
  ids: string[];
  width: number;
  height: number;
}

export function computeLayout(
  ids: string[],
  parentOf: ReadonlyMap<string, string | null>,
  cardWidth: number,
  cardHeight: number,
  gapX: number,
  gapY: number,
  maxRowWidth: number,
): LayoutResult {
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

  // 宽高探测:回溯式递归栈防环,返回子树包围盒尺寸
  const measure = (id: string, stack: Set<string>): SubtreeSize => {
    if (stack.has(id)) return { width: cardWidth, height: cardHeight };
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return { width: cardWidth, height: cardHeight };
    stack.add(id);
    const rows = packRows(children, (child) => measure(child, stack));
    let height = cardHeight;
    let width = cardWidth;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      height += row.height + (i === 0 ? gapY : gapY);
      width = Math.max(width, row.width);
    }
    stack.delete(id);
    return { width, height };
  };

  // 把一列兄弟节点按子树宽高装箱成行(行高 = 行内孩子子树高的最大值)
  function packRows(children: string[], sizeOf: (id: string) => SubtreeSize): Row[] {
    const rows: Row[] = [];
    let current: Row = { ids: [], width: 0, height: 0 };
    for (const child of children) {
      const childSize = sizeOf(child);
      const projected =
        current.ids.length === 0
          ? childSize.width
          : current.width + gapX + childSize.width;
      if (current.ids.length > 0 && projected > maxRowWidth) {
        rows.push(current);
        current = { ids: [], width: 0, height: 0 };
      }
      current.ids.push(child);
      current.width =
        current.ids.length === 1 ? childSize.width : current.width + gapX + childSize.width;
      current.height =
        current.ids.length === 1 ? childSize.height : Math.max(current.height, childSize.height);
    }
    if (current.ids.length > 0) rows.push(current);
    return rows;
  }

  const positions = new Map<string, LayoutPosition>();
  const placed = new Set<string>();
  let maxBottom = 0;
  let maxRight = 0;

  const mark = (id: string, x: number, y: number) => {
    positions.set(id, { x, y });
    maxBottom = Math.max(maxBottom, y + cardHeight);
    maxRight = Math.max(maxRight, x + cardWidth);
  };

  // 放置:把子树盒放在 (boxX, boxY),父卡片居中于盒顶
  const place = (id: string, boxX: number, boxY: number): void => {
    if (placed.has(id)) return;
    placed.add(id);
    const size = measure(id, new Set());
    mark(id, boxX + (size.width - cardWidth) / 2, boxY);

    const children = (childrenOf.get(id) ?? []).filter((child) => !placed.has(child));
    if (children.length === 0) return;
    const rows = packRows(children, (child) => measure(child, new Set()));
    let rowY = boxY + cardHeight + gapY;
    for (const row of rows) {
      let cursor = boxX + (size.width - row.width) / 2;
      for (const child of row.ids) {
        place(child, cursor, rowY);
        cursor += measure(child, new Set()).width + gapX;
      }
      rowY += row.height + gapY;
    }
  };

  // 根层同样装箱换行;先按行装箱算出画布总宽,再把每行在画布内水平居中回填
  const rootRows = packRows(roots, (root) => measure(root, new Set()));
  let canvasWidth = cardWidth;
  for (const row of rootRows) canvasWidth = Math.max(canvasWidth, row.width);
  let rowY = 0;
  for (const row of rootRows) {
    const rowHeight = Math.max(
      ...row.ids.map((root) => measure(root, new Set()).height),
      cardHeight,
    );
    let cursor = (canvasWidth - row.width) / 2;
    for (const root of row.ids) {
      place(root, cursor, rowY);
      cursor += measure(root, new Set()).width + gapX;
    }
    rowY += rowHeight + gapY;
  }

  return {
    positions,
    width: Math.max(maxRight, canvasWidth),
    height: Math.max(maxBottom, cardHeight),
  };
}
