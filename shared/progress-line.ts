/**
 * 运行中卡片的实时 progress line 纯逻辑(借鉴 pase-omo 工作流画板的
 * detailLine):从 timeline 尾部条目合成一行"正在做什么"。
 * - 最新条目优先:tool_call → "[工具] 摘要";assistant_message/error → 首行文本;
 * - 全部清洗 ANSI 转义序列与 bidi override 控制符,防止会话内容注入 UI;
 * - 终态(空闲)卡片不展示:调用方只对运行中的卡片请求该行,过期进度不误导。
 * 不依赖 React / React Native / SDK,可被 client 与 tests 共用。
 */

export interface ProgressTimelineItem {
  kind: "user" | "assistant" | "reasoning" | "tool" | "error" | "notice";
  text: string;
  meta?: string | null;
  /** tool_call 条目的原始 detail(协议 ToolCallDetail 形状),用于合成摘要 */
  toolDetail?: unknown;
}

/** 剥 ANSI 转义序列与 bidi override/isolate 控制符 */
export function cleanStreamText(text: string): string {
  return text
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "");
}

/** 首个非空行(trim 后),无则返回空串 */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** 路径取文件名(兼容 / 与 \ 分隔) */
function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 从工具名 + 协议 detail 合成 "[标签] 摘要";detail 缺失或未知形态回落
 * "[工具名]",不猜内容。
 */
export function toolProgressText(name: string, detail: unknown): string {
  // 统一取首个非空行:命令/URL/文本里的换行不进入单行进度
  const clean = (value: string): string => {
    const stripped = cleanStreamText(value).trim();
    return stripped ? firstMeaningfulLine(stripped) : "";
  };
  const d = asRecord(detail);
  const type = str(d?.type);
  let label = clean(name) || "tool";
  let rest = "";
  if (type === "shell") {
    label = "bash";
    rest = clean(str(d?.command) ?? "");
  } else if (type === "read" || type === "write" || type === "edit") {
    label = type;
    rest = clean(str(d?.filePath) ?? "");
    rest = rest ? baseName(rest) : "";
  } else if (type === "search") {
    rest = clean(str(d?.query) ?? "");
  } else if (type === "fetch") {
    rest = clean(str(d?.url) ?? "");
  } else if (type === "worktree_setup") {
    rest = clean(str(d?.branchName) ?? "");
  } else if (type === "sub_agent") {
    rest = clean(str(d?.description) ?? str(d?.subAgentType) ?? "");
  } else if (type === "plain_text") {
    rest = clean(str(d?.label) ?? str(d?.text) ?? "");
  } else if (type === "plan") {
    rest = clean(str(d?.text) ?? "");
  }
  return rest ? `[${label}] ${rest}` : `[${label}]`;
}

/** progress line 最大长度(超出截断,渲染层另有 numberOfLines 兜底) */
const MAX_LINE_LENGTH = 120;

/**
 * 从 timeline 尾部条目合成一行:自最新往回找第一条 tool/assistant/error;
 * reason/tool(user 消息、notice 等)跳过。无可用条目返回 null。
 */
export function progressLineOf(
  items: readonly ProgressTimelineItem[],
  maxLen = MAX_LINE_LENGTH,
): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "tool") {
      const line = toolProgressText(item.text || "tool", item.toolDetail);
      if (line) return truncate(line, maxLen);
      continue;
    }
    if (item.kind === "assistant" || item.kind === "error") {
      const line = cleanStreamText(item.text ?? "").trim();
      const first = firstMeaningfulLine(line);
      if (first) return truncate(first, maxLen);
    }
  }
  return null;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, Math.max(maxLen - 1, 1))}…` : text;
}

/** 运行耗时格式化:42s / 12m 34s / 1h 02m(与 pase-omo 画板同风格) */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** 吞吐格式化:≥10 取整,否则 1 位小数;非有限值返回 null(不显示) */
export function formatTokensPerSecond(tps: number | null): string | null {
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return null;
  return `${tps >= 10 ? Math.round(tps).toString() : tps.toFixed(1)} tok/s`;
}
