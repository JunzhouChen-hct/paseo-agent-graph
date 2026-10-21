import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import {
  TEMPLATE_MAX_NODES,
  templateNodeSchema,
  validateTemplateNodes,
} from "./template-model.ts";

/**
 * 节点模板专用 host settings 文档(与面板显示设置分离,避免互相影响)。
 * templates:模板列表;defaults:项目默认模板映射(键为 "project:<projectId>" 或 "cwd:<规范路径>")。
 */
export const agentGraphTemplatesSettings = defineSettings({
  id: "agent-graph-templates",
  scope: "host",
  version: 1,
  schema: z
    .object({
      templates: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1, "模板名称不能为空").max(120),
            nodes: z.array(templateNodeSchema).min(1).max(TEMPLATE_MAX_NODES),
          }),
        )
        .max(50)
        .default([]),
      defaults: z.record(z.string(), z.string()).default({}),
    })
    .superRefine((doc, ctx) => {
      // 写入侧结构校验:非法文档直接拒绝,不落盘
      const ids = new Set<string>();
      for (const template of doc.templates) {
        if (ids.has(template.id)) {
          ctx.addIssue({ code: "custom", message: `模板 id 重复:${template.id}`, path: ["templates"] });
        }
        ids.add(template.id);
        if (!template.name.trim()) {
          ctx.addIssue({ code: "custom", message: `模板 ${template.id} 名称不能为空`, path: ["templates"] });
        }
        const result = validateTemplateNodes(template.nodes);
        for (const error of result.errors) {
          ctx.addIssue({ code: "custom", message: `模板「${template.name}」:${error}`, path: ["templates"] });
        }
      }
      // defaults 必须指向存在的模板 id,防止悬挂引用
      for (const [key, templateId] of Object.entries(doc.defaults)) {
        if (!templateId) {
          ctx.addIssue({ code: "custom", message: `默认模板引用为空:${key}`, path: ["defaults"] });
        } else if (!ids.has(templateId)) {
          ctx.addIssue({ code: "custom", message: `默认模板引用不存在:${key} → ${templateId}`, path: ["defaults"] });
        }
      }
    }),
});

export type TemplateRecord = {
  id: string;
  name: string;
  nodes: z.output<typeof templateNodeSchema>[];
};

export type TemplatesDoc = z.output<typeof agentGraphTemplatesSettings["schema"]>;

/** 对整份文档做校验,返回错误列表(客户端保存前共用,与服务端 schema 校验同源)。 */
export function validateTemplateDocument(doc: {
  templates: TemplateRecord[];
  defaults: Record<string, string>;
}): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const template of doc.templates) {
    if (ids.has(template.id)) errors.push(`模板 id 重复:${template.id}`);
    ids.add(template.id);
    if (!template.name.trim()) errors.push(`模板 ${template.id} 名称不能为空`);
    const result = validateTemplateNodes(template.nodes);
    for (const error of result.errors) errors.push(`模板「${template.name}」:${error}`);
  }
  for (const [key, templateId] of Object.entries(doc.defaults)) {
    if (!templateId) errors.push(`默认模板引用为空:${key}`);
    else if (!ids.has(templateId)) errors.push(`默认模板引用不存在:${key} → ${templateId}`);
  }
  return errors;
}

/**
 * 冲突恢复用合并:以最新文档为底,用当前草稿覆盖同 id 模板(其余模板与 defaults 取最新)。
 * 纯函数,返回新对象不改入参。
 */
export function mergeDraftIntoDoc(
  latest: { templates: readonly TemplateRecord[]; defaults: Readonly<Record<string, string>> },
  draft: TemplateRecord,
): { templates: TemplateRecord[]; defaults: Record<string, string> } {
  return {
    templates: [...latest.templates.filter((template) => template.id !== draft.id), draft],
    defaults: { ...latest.defaults },
  };
}

/** 建树任务的输入节点(与服务端 RPC 契约一致) */
export const createTaskNodesSchema = z.array(templateNodeSchema).min(1).max(TEMPLATE_MAX_NODES);

/** 从当前 workspace 未归档节点生成模板草稿 */
export const importTemplateRpc = defineRpc({
  name: "agent-graph.templates.import",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    name: z.string(),
    nodes: z.array(templateNodeSchema),
    notes: z.array(z.string()),
    virtualRoot: z.boolean(),
    skippedArchived: z.number().int(),
    /** true 表示结果不完整:刷新预算耗尽、刷新失败或节点数被截断 */
    truncated: z.boolean(),
  }),
});

/** 按模板新建任务:先完整预检 provider/model/thinking,再按拓扑序建树,最后逐节点发送启动指令并给主节点发任务 prompt/名册 */
export const createTaskFromTemplateRpc = defineRpc({
  name: "agent-graph.templates.create-task",
  input: z.object({
    workspaceId: z.string().min(1),
    /** 任务标题,用作主节点标题 */
    title: z.string().min(1).max(200),
    /** 首条 prompt;整树创建成功后发给主节点,并自动追加子 Agent 名册 */
    prompt: z.string(),
    /** 重试复用的稳定运行 id,与节点 key 一起派生幂等 key,避免重复创建/重复发送 */
    runId: z.string().min(1),
    nodes: createTaskNodesSchema,
  }),
  output: z.object({
    ok: z.boolean(),
    /** 主节点 agent id;建树未开始时为 null */
    rootAgentId: z.string().nullable(),
    /** 已成功创建的节点(部分失败时用于避免盲重试) */
    createdAgentIds: z.array(z.object({ key: z.string(), agentId: z.string() })),
    /** provider/model/thinking/mode 预检或树校验失败详情 */
    validationErrors: z.array(z.string()),
    error: z.string().nullable(),
    /** 发送阶段逐条失败(树已创建,不回滚;messageId 幂等,可安全重试) */
    sendErrors: z.array(
      z.object({
        key: z.string(),
        agentId: z.string(),
        error: z.string(),
      }),
    ),
  }),
});
