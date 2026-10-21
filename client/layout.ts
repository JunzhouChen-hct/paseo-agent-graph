/**
 * 分层流式树布局:每层子节点按 maxRowWidth 装箱换行,
 * 父卡片水平居中于其子树包围盒上方。
 * 兄弟行之间做垂直压实 + 水平滑动:每行在父盒(根层为画布)内尝试若干候选 x
 * (左对齐/右对齐/居中/与已放卡片对齐),碰撞依据是实际已放卡片而非测量子树盒,
 * 取"最小 y、同高最接近居中"的落位——窄行能滑进深链旁边的空档,
 * 不再被无关子树的全宽包围盒顶到画布底部,消除大片空白。
 * 支持每节点独立尺寸(sizes):未指定的节点用统一 cardWidth/cardHeight;
 * 行高/子树盒按实际尺寸计算,高节点会把所在行撑高(其余节点让位)。
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

interface Rect {
  x: number;
  y: number;
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

  // 宽高探测:回溯式递归栈防环,返回子树包围盒尺寸(按每节点实际尺寸)
  const measure = (id: string, stack: Set<string>): SubtreeSize => {
    if (stack.has(id)) return { width: widthOf(id), height: heightOf(id) };
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return { width: widthOf(id), height: heightOf(id) };
    stack.add(id);
    const rows = packRows(children, (child) => measure(child, stack));
    let height = heightOf(id);
    let width = widthOf(id);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      height += row.height + gapY;
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
  // 实际已放卡片(非测量子树盒):行间压实的碰撞依据。用测量盒会把整棵宽子树
  // 的包围盒当成实心障碍,换行的窄行/根被顶到画布最底部,中间留出大片空白
  const placedCards: Rect[] = [];
  let maxBottom = 0;
  let maxRight = 0;

  const mark = (id: string, x: number, y: number) => {
    positions.set(id, { x, y });
    placedCards.push({ x, y, width: widthOf(id), height: heightOf(id) });
    maxBottom = Math.max(maxBottom, y + heightOf(id));
    maxRight = Math.max(maxRight, x + widthOf(id));
  };

  // 与 rect 水平间隙不足 gapX 的已放卡片,必须垂直错开 gapY;
  // 横向已拉开的不约束(同水平带瀑布式复用空间)。baseY 是最早允许的 y
  const minFreeY = (rect: { x: number; width: number; height: number }, baseY: number): number => {
    let y = baseY;
    for (const p of placedCards) {
      if (rect.x < p.x + p.width + gapX && p.x < rect.x + rect.width + gapX) {
        y = Math.max(y, p.y + p.height + gapY);
      }
    }
    return y;
  };

  // 放置:把子树盒放在 (boxX, boxY),父卡片居中于盒顶
  const place = (id: string, boxX: number, boxY: number): void => {
    if (placed.has(id)) return;
    placed.add(id);
    const size = measure(id, new Set());
    mark(id, boxX + (size.width - widthOf(id)) / 2, boxY);

    const children = (childrenOf.get(id) ?? []).filter((child) => !placed.has(child));
    if (children.length === 0) return;
    const rows = packRows(children, (child) => measure(child, new Set()));
    const baseY = boxY + heightOf(id) + gapY;
    for (const row of rows) {
      const entries = row.ids.map((child) => ({ id: child, size: measure(child, new Set()) }));
      placeRow(entries, boxX, boxX + size.width, baseY);
    }
  };

  // 把一行子树在 [minX, maxX] 内水平滑动 + 垂直压实:候选 x 取左对齐/右对齐/
  // 居中/与每张已放卡片左右对齐(留 gapX),逐个估最小不冲突 y,
  // 取"最小 y、同高最接近居中"的落位后整行放置。行必须整体留在盒内,
  // 因此不会与兄弟子树(按测量盒互斥)的内容相撞
  const placeRow = (
    entries: { id: string; size: SubtreeSize }[],
    minX: number,
    maxX: number,
    baseY: number,
  ): number => {
    const rowWidth = entries.reduce((sum, e, i) => (i === 0 ? e.size.width : sum + gapX + e.size.width), 0);
    const limitX = Math.max(minX, maxX - rowWidth);
    const centered = minX + (limitX - minX) / 2;
    const candidates = new Set<number>([minX, limitX, centered]);
    for (const p of placedCards) {
      candidates.add(p.x - gapX - rowWidth);
      candidates.add(p.x + p.width + gapX);
    }
    let bestX = centered;
    let bestY = Infinity;
    for (const raw of candidates) {
      const x = Math.min(Math.max(raw, minX), limitX);
      let y = baseY;
      let cursor = x;
      for (const entry of entries) {
        y = Math.max(y, minFreeY({ x: cursor, width: entry.size.width, height: entry.size.height }, baseY));
        cursor += entry.size.width + gapX;
      }
      const offCenter = Math.abs(x - centered);
      if (y < bestY || (y === bestY && offCenter < Math.abs(bestX - centered))) {
        bestX = x;
        bestY = y;
      }
    }
    let cursor = bestX;
    for (const entry of entries) {
      place(entry.id, cursor, bestY);
      cursor += entry.size.width + gapX;
    }
    return bestY;
  };

  // 根层装箱换行;每行在画布内滑动 + 压实落位
  const rootRows = packRows(roots, (root) => measure(root, new Set()));
  let canvasWidth = cardWidth;
  for (const row of rootRows) canvasWidth = Math.max(canvasWidth, row.width);
  for (const row of rootRows) {
    const entries = row.ids.map((root) => ({ id: root, size: measure(root, new Set()) }));
    placeRow(entries, 0, canvasWidth, 0);
  }

  return {
    positions,
    width: Math.max(maxRight, canvasWidth),
    height: Math.max(maxBottom, cardHeight),
  };
}
