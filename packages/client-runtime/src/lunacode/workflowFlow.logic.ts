import {
  type FlowAgentNode,
  type FlowDryRunLayer,
  type FlowDryRunReport,
  type FlowEdge,
  type FlowNode,
  FlowSpec,
  type FlowValidationIssue,
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowStep,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type FlowStarterTemplateId = "parallel-review" | "human-gate" | "single-agent";

export interface FlowStarterTemplateMeta {
  readonly id: FlowStarterTemplateId;
  readonly label: string;
  readonly description: string;
}

export const FLOW_TEMPLATES: ReadonlyArray<FlowStarterTemplateMeta> = [
  {
    id: "parallel-review",
    label: "并行多 Bot 评审流",
    description: "双 Worktree 并行实现/测试 -> 评审闭环（含熔断） -> 人工批准发布",
  },
  {
    id: "human-gate",
    label: "人工审批门流程",
    description: "规划 Bot 输出方案 -> 人工确认网关 -> 执行 Bot 落地实施",
  },
  {
    id: "single-agent",
    label: "单 Agent 自动任务",
    description: "单节点快速执行与结果收口，适合定时巡检或轻量自动化",
  },
];

const decodeStrictFlowSpec = Schema.decodeUnknownSync(FlowSpec, { onExcessProperty: "error" });

export function isFlowDefinitionFile(nameOrPath: string): boolean {
  return nameOrPath.endsWith(".flow.json");
}

function lineFromJsonSyntaxError(source: string, error: unknown): number | null {
  if (!(error instanceof SyntaxError)) return null;
  const lineMatch = /line\s+(\d+)/i.exec(error.message);
  if (lineMatch?.[1]) {
    const parsed = Number(lineMatch[1]);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  const posMatch = /position\s+(\d+)/i.exec(error.message);
  if (posMatch?.[1]) {
    const pos = Number(posMatch[1]);
    if (Number.isInteger(pos) && pos >= 0) {
      let line = 1;
      for (let i = 0; i < pos && i < source.length; i++) {
        if (source[i] === "\n") line++;
      }
      return line;
    }
  }
  return null;
}

export type ParseFlowSpecResult =
  | { readonly ok: true; readonly spec: FlowSpec }
  | { readonly ok: false; readonly error: string; readonly line: number | null };

export function parseFlowSpecSafe(source: string): ParseFlowSpecResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      line: lineFromJsonSyntaxError(source, error),
    };
  }
  try {
    return { ok: true, spec: decodeStrictFlowSpec(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      line: null,
    };
  }
}

export function formatFlowSpecJson(spec: FlowSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

function sanitizeFlowIdentifier(input: string, fallback = "custom-flow"): string {
  const cleaned = input
    .trim()
    .replace(/\.flow\.json$/i, "")
    .replace(/\.json$/i, "")
    .replace(/[^A-Za-z0-9_@-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

export function normalizeFlowFileName(input: string, fallbackBase = "custom-flow"): string {
  let trimmed = input.trim();
  if (trimmed.length === 0) return `${fallbackBase}.flow.json`;
  trimmed = trimmed.replace(/[\\/]/g, "-").replace(/\.\.+/g, ".");
  if (trimmed.endsWith(".flow.json")) return trimmed;
  if (trimmed.endsWith(".json")) return `${trimmed.slice(0, -".json".length)}.flow.json`;
  return `${trimmed}.flow.json`;
}

export function nextFlowVersionTarget(
  currentFileName: string,
  spec: FlowSpec,
): { readonly fileName: string; readonly spec: FlowSpec } {
  const nextVersion = spec.version + 1;
  let base = currentFileName.trim();
  if (base.endsWith(".flow.json")) {
    base = base.slice(0, -".flow.json".length);
  } else if (base.endsWith(".json")) {
    base = base.slice(0, -".json".length);
  }
  const cleanBase = sanitizeFlowIdentifier(base.replace(/\.v\d+$/i, ""), spec.name);
  return {
    fileName: `${cleanBase}.v${nextVersion}.flow.json`,
    spec: {
      ...spec,
      version: nextVersion,
    },
  };
}

export function createStarterFlowSpec(opts: {
  readonly name: string;
  readonly template?: FlowStarterTemplateId;
  readonly project?: string;
  readonly providerInstanceId?: string;
  readonly model?: string;
}): FlowSpec {
  const safeName = sanitizeFlowIdentifier(opts.name, "team-flow");
  const project =
    opts.project && opts.project.trim().length > 0 ? opts.project.trim() : "default-project";
  const providerMeta =
    opts.providerInstanceId && opts.model
      ? { providerInstanceId: opts.providerInstanceId, model: opts.model }
      : {};
  const template = opts.template ?? "parallel-review";

  if (template === "single-agent") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "单 Bot 自动任务",
      description: "由单个智能体独立完成任务并在结束时输出总结。",
      maxHops: 2,
      bots: {
        worker: {
          label: "执行 Bot",
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspace: "root",
          rolePrompt: "仔细分析需求并交付可验证的结果。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "run_task",
          kind: "agent",
          label: "执行核心任务",
          botId: "worker",
          project,
          promptTemplate: "请完成以下任务：\n{{payload.task}}",
        },
        {
          id: "done",
          kind: "end",
          label: "完成结束",
          outcome: "complete",
          reasonTemplate: "任务已完成",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "run_task" },
        { id: "e2", from: "run_task", to: "done" },
      ],
    };
  }

  if (template === "human-gate") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "方案评审与执行流",
      description: "先出方案与排查，再经人类拍板后执行修改。",
      maxHops: 2,
      bots: {
        planner: {
          label: "架构 Planner",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "先调研代码库现状与影响面，给出清晰的修改方案。",
          ...providerMeta,
        },
        executor: {
          label: "工程 Executor",
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt: "按已批准的方案实现代码改动并运行相关测试。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "plan",
          kind: "agent",
          label: "制定方案",
          botId: "planner",
          project,
          promptTemplate: "请针对以下需求制定方案：\n{{payload.task}}",
          returns: [{ name: "summary", type: "string", description: "方案摘要" }],
        },
        {
          id: "approve_plan",
          kind: "gate",
          label: "方案人工确认",
          gateMode: "human",
          askKind: "plan_approval",
          titleTemplate: "是否按以下方案继续执行？",
          choices: [
            { value: "批准执行", description: "进入执行节点落地代码" },
            { value: "打回重做", description: "返回 Planner 重新调整", requireReason: true },
            { value: "取消中止", description: "结束本次工作流" },
          ],
        },
        {
          id: "execute",
          kind: "agent",
          label: "落地实现",
          botId: "executor",
          project,
          promptTemplate:
            "已获人工批准，请实现方案：\n摘要：{{nodes.plan.value.summary}}\n补充意见：{{nodes.approve_plan.reason}}",
        },
        {
          id: "done",
          kind: "end",
          label: "交付完成",
          outcome: "complete",
        },
        {
          id: "aborted",
          kind: "end",
          label: "已取消",
          outcome: "stop",
          reasonTemplate: "人工取消：{{nodes.approve_plan.reason}}",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "plan" },
        { id: "e2", from: "plan", to: "approve_plan" },
        {
          id: "e3",
          from: "approve_plan",
          to: "execute",
          when: "nodes.approve_plan.choice == '批准执行'",
        },
        {
          id: "e4",
          from: "approve_plan",
          to: "plan",
          when: "nodes.approve_plan.choice == '打回重做'",
          isLoop: true,
        },
        {
          id: "e5",
          from: "approve_plan",
          to: "aborted",
          when: "nodes.approve_plan.choice == '取消中止'",
        },
        { id: "e6", from: "execute", to: "done" },
      ],
    };
  }

  // Default: "parallel-review"
  return {
    schemaVersion: 1,
    name: safeName,
    version: 1,
    title: "并行多 Bot 协作与评审流",
    description:
      "两个独立 Worktree Bot 并行研发与验证，汇总给 Reviewer 评审，未通过可有限回流修复，最后人工确认。",
    maxHops: 2,
    bots: {
      coder: {
        label: "研发 Bot",
        runtimeMode: "full-access",
        interactionMode: "default",
        workspace: "worktree",
        workspaceBaseRef: "HEAD",
        rolePrompt: "专注实现改动并确保局部可构建。",
        ...providerMeta,
      },
      tester: {
        label: "测试 Bot",
        runtimeMode: "full-access",
        interactionMode: "default",
        workspace: "worktree",
        workspaceBaseRef: "HEAD",
        rolePrompt: "编写覆盖边界条件的自动化测试并验证回归。",
        ...providerMeta,
      },
      reviewer: {
        label: "评审 Bot",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspace: "root",
        rolePrompt: "严格审查改动正确性与测试覆盖率，并输出结构化结论。",
        ...providerMeta,
      },
    },
    triggers: [{ kind: "manual" }],
    nodes: [
      {
        id: "implement",
        kind: "agent",
        label: "并行功能实现",
        botId: "coder",
        project,
        promptTemplate: "请在隔离 worktree 中完成任务：{{payload.task}}",
        returns: [{ name: "summary", type: "string", description: "实现说明" }],
      },
      {
        id: "write_tests",
        kind: "agent",
        label: "并行补充测试",
        botId: "tester",
        project,
        promptTemplate: "请为以下任务设计并编写测试：{{payload.task}}",
        returns: [{ name: "checks", type: "string", description: "测试运行结论" }],
      },
      {
        id: "review",
        kind: "agent",
        label: "联合代码评审",
        botId: "reviewer",
        project,
        promptTemplate:
          "请评审研发与测试产出：\n实现：{{nodes.implement.value.summary}}\n测试：{{nodes.write_tests.value.checks}}",
        returns: [
          { name: "approved", type: "boolean", description: "是否通过评审" },
          { name: "notes", type: "string", description: "评审意见" },
        ],
      },
      {
        id: "approve_ship",
        kind: "gate",
        label: "人工发布审批",
        gateMode: "coordinator_then_human",
        askKind: "ship_approval",
        titleTemplate: "所有检查已通过，是否合并并发布？",
        choices: [
          { value: "批准发布", description: "完成本次工作流" },
          { value: "继续打磨", description: "打回给研发节点微调", requireReason: true },
        ],
      },
      {
        id: "done",
        kind: "end",
        label: "流程完成",
        outcome: "complete",
        reasonTemplate: "评审与人工确认均已通过",
      },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "implement" },
      { id: "e2", from: "trigger", to: "write_tests" },
      { id: "e3", from: "implement", to: "review" },
      { id: "e4", from: "write_tests", to: "review" },
      { id: "e5", from: "review", to: "approve_ship", when: "nodes.review.value.approved == true" },
      {
        id: "e6",
        from: "review",
        to: "implement",
        when: "!nodes.review.value.approved",
        isLoop: true,
      },
      {
        id: "e7",
        from: "approve_ship",
        to: "done",
        when: "nodes.approve_ship.choice == '批准发布'",
      },
      {
        id: "e8",
        from: "approve_ship",
        to: "implement",
        when: "nodes.approve_ship.choice == '继续打磨'",
        isLoop: true,
      },
    ],
  };
}

function effectiveWorkspace(spec: FlowSpec, node: FlowAgentNode): "root" | "worktree" {
  if (node.workspaceOverride) return node.workspaceOverride;
  return spec.bots[node.botId]?.workspace ?? "root";
}

function effectiveRuntimeMode(spec: FlowSpec, node: FlowAgentNode): string {
  if (node.runtimeModeOverride) return node.runtimeModeOverride;
  return spec.bots[node.botId]?.runtimeMode ?? "approval-required";
}

function computeForwardLayersClient(
  nodes: ReadonlyArray<FlowNode>,
  forwardEdges: ReadonlyArray<FlowEdge>,
): { readonly layers: ReadonlyArray<FlowDryRunLayer>; readonly cycleNodes: ReadonlyArray<string> } {
  const nodeIds = nodes.map((n) => n.id);
  const nodeSet = new Set(nodeIds);
  const inDegree = new Map<string, number>();
  const outAdj = new Map<string, Array<string>>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    outAdj.set(id, []);
  }
  for (const edge of forwardEdges) {
    if (edge.from === "trigger") continue;
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    outAdj.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const layers: Array<FlowDryRunLayer> = [];
  const placed = new Set<string>();
  let frontier = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);

  while (frontier.length > 0) {
    layers.push({
      index: layers.length,
      nodeIds: frontier,
      parallel: frontier.length > 1,
    });
    const nextFrontier: Array<string> = [];
    for (const id of frontier) {
      placed.add(id);
    }
    for (const id of frontier) {
      for (const target of outAdj.get(id) ?? []) {
        const nextDeg = (inDegree.get(target) ?? 0) - 1;
        inDegree.set(target, nextDeg);
        if (nextDeg === 0 && !placed.has(target) && !nextFrontier.includes(target)) {
          nextFrontier.push(target);
        }
      }
    }
    frontier = nextFrontier;
  }

  const cycleNodes = nodeIds.filter((id) => !placed.has(id));
  return { layers, cycleNodes };
}

function extractPayloadPathsFromTemplate(text: string, into: Set<string>): void {
  const re = /\{\{([^{}]+)\}\}/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw === "payload" || raw.startsWith("payload.")) {
      into.add(raw);
    }
    match = re.exec(text);
  }
}

export function computeFlowDryRunClient(spec: FlowSpec): FlowDryRunReport {
  const issues: Array<FlowValidationIssue> = [];
  const nodeMap = new Map<string, FlowNode>();

  for (const node of spec.nodes) {
    if (nodeMap.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        severity: "error",
        nodeId: node.id,
        message: `存在重复的节点 ID "${node.id}"。`,
      });
    } else {
      nodeMap.set(node.id, node);
    }
  }

  if (spec.nodes.length === 0) {
    issues.push({
      code: "empty_nodes",
      severity: "error",
      message: "流程至少需要包含 1 个节点。",
    });
  }

  const edgeIds = new Set<string>();
  for (const edge of spec.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "duplicate_edge_id",
        severity: "error",
        edgeId: edge.id,
        message: `存在重复的连线 ID "${edge.id}"。`,
      });
    }
    edgeIds.add(edge.id);

    if (edge.from !== "trigger" && !nodeMap.has(edge.from)) {
      issues.push({
        code: "missing_edge_source",
        severity: "error",
        edgeId: edge.id,
        message: `连线 "${edge.id}" 的起点 "${edge.from}" 不存在。`,
      });
    }
    if (edge.to === "trigger" || !nodeMap.has(edge.to)) {
      issues.push({
        code: "missing_edge_target",
        severity: "error",
        edgeId: edge.id,
        message: `连线 "${edge.id}" 的终点 "${edge.to}" 不合法或不存在。`,
      });
    }
    if (edge.isLoop && edge.from === "trigger") {
      issues.push({
        code: "trigger_edge_cannot_loop",
        severity: "error",
        edgeId: edge.id,
        message: `连线 "${edge.id}" 起点为 trigger，不能设为 isLoop 回流边。`,
      });
    }
  }

  const triggerOut = spec.edges.filter((e) => e.from === "trigger");
  if (spec.nodes.length > 0 && triggerOut.length === 0) {
    issues.push({
      code: "missing_trigger_edge",
      severity: "error",
      message: "缺少从 trigger 出发的入口连线。",
    });
  }

  const untrustedSet = new Set<string>();
  const highRiskNodes: Array<{
    readonly nodeId: string;
    readonly label: string;
    readonly reason: string;
  }> = [];

  for (const node of spec.nodes) {
    if (node.kind === "agent") {
      if (!Object.hasOwn(spec.bots, node.botId)) {
        issues.push({
          code: "unknown_bot_id",
          severity: "error",
          nodeId: node.id,
          botId: node.botId,
          message: `Agent 节点 "${node.label}" 引用的 Bot "${node.botId}" 未定义。`,
        });
      }
      if (node.promptTemplate.trim().length === 0) {
        issues.push({
          code: "empty_prompt_template",
          severity: "error",
          nodeId: node.id,
          message: `Agent 节点 "${node.label}" 的提示词模板不能为空。`,
        });
      }
      if (node.project.trim().length === 0) {
        issues.push({
          code: "empty_project",
          severity: "error",
          nodeId: node.id,
          message: `Agent 节点 "${node.label}" 必须指定所属项目。`,
        });
      }
      extractPayloadPathsFromTemplate(node.promptTemplate, untrustedSet);
      const rt = effectiveRuntimeMode(spec, node);
      if (rt === "full-access") {
        const reason = `权限模式为 full-access（工作区: ${effectiveWorkspace(spec, node)}）`;
        highRiskNodes.push({ nodeId: node.id, label: node.label, reason });
        issues.push({
          code: "high_risk_full_access",
          severity: "warning",
          nodeId: node.id,
          message: `提示：节点 "${node.label}" 使用 ${reason}。`,
        });
      }
    } else if (node.kind === "gate") {
      extractPayloadPathsFromTemplate(node.titleTemplate, untrustedSet);
    } else if (node.kind === "script") {
      if (node.command.some((part) => /\{\{/.test(part)) || /\{\{/.test(node.cwd)) {
        issues.push({
          code: "untrusted_template_in_static_field",
          severity: "error",
          nodeId: node.id,
          message: `脚本节点 "${node.label}" 的 command 与 cwd 必须为静态字面量，不允许模板插值。`,
        });
      }
      highRiskNodes.push({
        nodeId: node.id,
        label: node.label,
        reason: `执行本地无壳命令 ${node.command[0] ?? ""}`,
      });
    }
  }

  const forwardEdges = spec.edges.filter((edge) => !edge.isLoop);
  const { layers, cycleNodes } = computeForwardLayersClient(spec.nodes, forwardEdges);
  if (cycleNodes.length > 0) {
    issues.push({
      code: "dag_cycle_detected",
      severity: "error",
      message: `检测到未标记 isLoop 的环路（涉及节点: ${cycleNodes.join(", ")}）。`,
    });
  }

  // Parallel write safety check: within the same layer, at most one non-worktree writer per project.
  const parallelWriteRisks: Array<{
    readonly project: string;
    readonly nodeIds: ReadonlyArray<string>;
    readonly reason: string;
  }> = [];

  for (const layer of layers) {
    const byProject = new Map<string, Array<FlowAgentNode>>();
    for (const nodeId of layer.nodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node || node.kind !== "agent") continue;
      const ws = effectiveWorkspace(spec, node);
      const rt = effectiveRuntimeMode(spec, node);
      const bot = spec.bots[node.botId];
      const interaction = node.interactionModeOverride ?? bot?.interactionMode ?? "default";
      const canWrite =
        interaction !== "plan" &&
        (rt === "auto-accept-edits" || rt === "auto" || rt === "full-access");
      if (ws === "root" && canWrite) {
        const bucket = byProject.get(node.project) ?? [];
        bucket.push(node);
        byProject.set(node.project, bucket);
      }
    }
    for (const [project, writers] of byProject.entries()) {
      if (writers.length > 1) {
        const ids = writers.map((w) => w.id);
        const reason = `同层节点 [${ids.join(", ")}] 在项目 "${project}" 上并发以 root 写入模式运行，需改为 worktree 隔离或设为只读/串行。`;
        parallelWriteRisks.push({ project, nodeIds: ids, reason });
        issues.push({
          code: "parallel_root_write_conflict",
          severity: "error",
          message: reason,
        });
      }
    }
  }

  // Reachability from trigger
  if (spec.nodes.length > 0) {
    const visited = new Set<string>();
    const queue = triggerOut.map((e) => e.to).filter((id) => nodeMap.has(id));
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const e of spec.edges) {
        if (e.from === id && nodeMap.has(e.to) && !visited.has(e.to)) {
          queue.push(e.to);
        }
      }
    }
    for (const node of spec.nodes) {
      if (!visited.has(node.id)) {
        issues.push({
          code: "unreachable_node",
          severity: "error",
          nodeId: node.id,
          message: `节点 "${node.label}" (${node.id}) 无法从 trigger 到达。`,
        });
      }
    }
  }

  const loopEdges = spec.edges
    .filter((edge) => edge.isLoop === true)
    .map((edge) => ({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.when !== undefined ? { when: edge.when } : {}),
    }));

  return {
    valid: issues.every((i) => i.severity !== "error"),
    workflowName: spec.name,
    version: spec.version,
    maxHops: spec.maxHops ?? 2,
    layers,
    loopEdges,
    parallelWriteRisks,
    highRiskNodes,
    untrustedDataFields: Array.from(untrustedSet),
    issues,
  };
}

export function validateFlowClient(spec: FlowSpec): ReadonlyArray<FlowValidationIssue> {
  return computeFlowDryRunClient(spec).issues;
}

export interface PositionedFlowNode {
  readonly node: FlowNode;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PositionedFlowEdge {
  readonly edge: FlowEdge;
  readonly d: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly isLoop: boolean;
}

export interface FlowGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly triggerAnchor: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly nodes: ReadonlyArray<PositionedFlowNode>;
  readonly nodeById: Readonly<Record<string, PositionedFlowNode>>;
  readonly edges: ReadonlyArray<PositionedFlowEdge>;
  readonly layers: ReadonlyArray<FlowDryRunLayer>;
}

export function computeFlowLayout(
  spec: FlowSpec,
  opts?: {
    readonly nodeWidth?: number;
    readonly nodeHeight?: number;
    readonly colGap?: number;
    readonly rowGap?: number;
    readonly padX?: number;
    readonly padY?: number;
  },
): FlowGraphLayout {
  const nodeWidth = opts?.nodeWidth ?? 196;
  const nodeHeight = opts?.nodeHeight ?? 84;
  const colGap = opts?.colGap ?? 58;
  const rowGap = opts?.rowGap ?? 26;
  const padX = opts?.padX ?? 20;
  const padY = opts?.padY ?? 28;

  const forwardEdges = spec.edges.filter((edge) => !edge.isLoop);
  const { layers: rawLayers, cycleNodes } = computeForwardLayersClient(spec.nodes, forwardEdges);

  // If a partial cycle remains during editing, append remaining nodes to a fallback final column so canvas still renders cleanly.
  const allLayers: Array<FlowDryRunLayer> = [...rawLayers];
  if (cycleNodes.length > 0) {
    allLayers.push({
      index: allLayers.length,
      nodeIds: cycleNodes,
      parallel: cycleNodes.length > 1,
    });
  }

  const maxRows = allLayers.reduce((acc, layer) => Math.max(acc, layer.nodeIds.length), 1);
  const contentHeight = maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap;
  const globalBottomY = padY + contentHeight;

  const triggerWidth = 110;
  const triggerHeight = 46;
  const triggerX = padX;
  const triggerY = padY + (contentHeight - triggerHeight) / 2;

  const firstNodeColX = padX + triggerWidth + colGap;
  const nodeMap = new Map<string, FlowNode>();
  for (const node of spec.nodes) nodeMap.set(node.id, node);

  const positionedNodes: Array<PositionedFlowNode> = [];
  const nodeById: Record<string, PositionedFlowNode> = {};

  for (let colIdx = 0; colIdx < allLayers.length; colIdx++) {
    const layer = allLayers[colIdx]!;
    const layerHeight =
      layer.nodeIds.length * nodeHeight + Math.max(0, layer.nodeIds.length - 1) * rowGap;
    const startY = padY + (contentHeight - layerHeight) / 2;
    const x = firstNodeColX + colIdx * (nodeWidth + colGap);

    for (let rowIdx = 0; rowIdx < layer.nodeIds.length; rowIdx++) {
      const nodeId = layer.nodeIds[rowIdx]!;
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      const y = startY + rowIdx * (nodeHeight + rowGap);
      const item: PositionedFlowNode = {
        node,
        layer: colIdx,
        row: rowIdx,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
      };
      positionedNodes.push(item);
      nodeById[nodeId] = item;
    }
  }

  let loopCurveCount = 0;
  const positionedEdges: Array<PositionedFlowEdge> = [];

  for (const edge of spec.edges) {
    const toNode = nodeById[edge.to];
    if (!toNode) continue;

    if (edge.from === "trigger") {
      const x1 = triggerX + triggerWidth;
      const y1 = triggerY + triggerHeight / 2;
      const x2 = toNode.x;
      const y2 = toNode.y + toNode.height / 2;
      const dx = Math.max(24, (x2 - x1) * 0.5);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      positionedEdges.push({
        edge,
        d,
        labelX: (x1 + x2) / 2,
        labelY: (y1 + y2) / 2 - 8,
        isLoop: false,
      });
      continue;
    }

    const fromNode = nodeById[edge.from];
    if (!fromNode) continue;

    if (edge.isLoop || fromNode.x >= toNode.x) {
      loopCurveCount += 1;
      const x1 = fromNode.x + fromNode.width / 2;
      const y1 = fromNode.y + fromNode.height;
      const x2 = toNode.x + toNode.width / 2;
      const y2 = toNode.y + toNode.height;
      const laneY = Math.max(y1, y2, globalBottomY) + 32 + (loopCurveCount - 1) * 32;
      const dipY = Math.round((laneY - 0.125 * (y1 + y2)) / 0.75);
      const d = `M ${x1} ${y1} C ${x1} ${dipY}, ${x2} ${dipY}, ${x2} ${y2}`;
      positionedEdges.push({
        edge,
        d,
        labelX: (x1 + x2) / 2,
        labelY: laneY,
        isLoop: true,
      });
      continue;
    }

    const x1 = fromNode.x + fromNode.width;
    const y1 = fromNode.y + fromNode.height / 2;
    const x2 = toNode.x;
    const y2 = toNode.y + toNode.height / 2;
    const dx = Math.max(28, (x2 - x1) * 0.5);
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    positionedEdges.push({
      edge,
      d,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 10,
      isLoop: false,
    });
  }

  const colsWidth =
    allLayers.length > 0
      ? firstNodeColX + allLayers.length * nodeWidth + Math.max(0, allLayers.length - 1) * colGap
      : padX + triggerWidth;
  const loopExtraHeight = loopCurveCount > 0 ? 44 + loopCurveCount * 32 : 0;

  return {
    width: Math.max(460, colsWidth + padX),
    height: Math.max(220, padY + contentHeight + loopExtraHeight + padY),
    triggerAnchor: {
      x: triggerX,
      y: triggerY,
      width: triggerWidth,
      height: triggerHeight,
    },
    nodes: positionedNodes,
    nodeById,
    edges: positionedEdges,
    layers: allLayers,
  };
}

export type LiveNodeStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";

export interface LiveNodeState {
  readonly nodeId: string;
  readonly label: string;
  readonly status: LiveNodeStatus;
  readonly visitCount: number;
  readonly latestStepName: string | null;
  readonly threadId: string | null;
  readonly environmentId: string | null;
  readonly pendingQuestion: WorkflowQuestion | null;
  readonly detail: string | null;
  readonly summary: string | null;
  readonly durationMs: number | null;
}

export interface LiveCrewMember {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly botId: string;
  readonly botLabel: string;
  readonly stepName: string;
  readonly status: LiveNodeStatus;
  readonly visitCount: number;
  readonly threadId: string | null;
  readonly environmentId: string | null;
  readonly modelLabel: string | null;
  readonly runtimeMode: string;
  readonly workspace: "root" | "worktree";
  readonly project: string;
  readonly summary: string | null;
  readonly durationMs: number | null;
}

export interface LiveFlowOverlay {
  readonly nodeStates: Readonly<Record<string, LiveNodeState>>;
  readonly crew: ReadonlyArray<LiveCrewMember>;
  readonly fallbackSpec: FlowSpec | null;
  readonly totalLoopHops: number;
  readonly circuitBreakerCount: number;
}

function stripVisitSuffix(stepName: string): { readonly baseId: string; readonly visit: number } {
  const match = /^(.*)#(\d+)$/.exec(stepName);
  if (!match || !match[1] || !match[2]) {
    return { baseId: stepName, visit: 1 };
  }
  const visit = Number(match[2]);
  return {
    baseId: match[1],
    visit: Number.isInteger(visit) && visit >= 1 ? visit : 1,
  };
}

function summarizeStep(step: WorkflowStep): string | null {
  if (step.said && step.said.trim().length > 0) return step.said.trim();
  if (step.detail && step.detail.trim().length > 0) return step.detail.trim();
  if (step.result !== null && step.result !== undefined) {
    if (typeof step.result === "string") return step.result;
    try {
      return JSON.stringify(step.result);
    } catch {
      return null;
    }
  }
  return null;
}

function stepDurationMs(step: WorkflowStep, nowMs?: number): number | null {
  const start = Date.parse(step.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = step.endedAt ? Date.parse(step.endedAt) : nowMs;
  return end !== undefined && Number.isFinite(end) && end >= start ? end - start : null;
}

export function buildLiveRunGraphOverlay(
  spec: FlowSpec | null,
  run: WorkflowRun,
  steps: ReadonlyArray<WorkflowStep>,
  questions: ReadonlyArray<WorkflowQuestion>,
  nowMs?: number,
): LiveFlowOverlay {
  const grouped = new Map<string, Array<{ readonly step: WorkflowStep; readonly visit: number }>>();
  let circuitBreakerCount = 0;
  let maxStepVisit = 1;

  for (const step of steps) {
    if (step.name.startsWith("@circuit-breaker")) {
      circuitBreakerCount += 1;
      continue;
    }
    const { baseId, visit } = stripVisitSuffix(step.name);
    if (visit > maxStepVisit) maxStepVisit = visit;
    const list = grouped.get(baseId) ?? [];
    list.push({ step, visit });
    grouped.set(baseId, list);
  }

  const questionByNodeId = new Map<string, WorkflowQuestion>();
  for (const question of questions) {
    const { baseId } = stripVisitSuffix(question.name);
    questionByNodeId.set(baseId, question);
  }

  const nodeStates: Record<string, LiveNodeState> = {};

  const computeStateFor = (nodeId: string, label: string): LiveNodeState => {
    const entries = grouped.get(nodeId) ?? [];
    const pendingQuestion = questionByNodeId.get(nodeId) ?? null;
    if (entries.length === 0) {
      if (pendingQuestion) {
        return {
          nodeId,
          label,
          status: "waiting",
          visitCount: 1,
          latestStepName: pendingQuestion.name,
          threadId: pendingQuestion.thread?.threadId ?? null,
          environmentId: pendingQuestion.thread?.environmentId ?? null,
          pendingQuestion,
          detail: null,
          summary: null,
          durationMs: null,
        };
      }
      return {
        nodeId,
        label,
        status: run.endedAt !== null ? "skipped" : "pending",
        visitCount: 0,
        latestStepName: null,
        threadId: null,
        environmentId: null,
        pendingQuestion: null,
        detail: null,
        summary: null,
        durationMs: null,
      };
    }

    // Hermès-safe: avoid `.at(-1)` edge cases or `.toSorted()` by copying or indexing directly.
    const latestEntry = entries[entries.length - 1]!;
    const latest = latestEntry.step;
    let threadId: string | null = latest.threadId;
    let environmentId: string | null = latest.environmentId;
    if (!threadId) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.step.threadId) {
          threadId = entries[i]!.step.threadId;
          environmentId = entries[i]!.step.environmentId;
          break;
        }
      }
    }

    const status: LiveNodeStatus =
      pendingQuestion !== null
        ? "waiting"
        : latest.status === "running"
          ? "running"
          : latest.status === "failed"
            ? "failed"
            : "completed";

    return {
      nodeId,
      label,
      status,
      visitCount: entries.length,
      latestStepName: latest.name,
      threadId: pendingQuestion?.thread?.threadId ?? threadId,
      environmentId: pendingQuestion?.thread?.environmentId ?? environmentId,
      pendingQuestion,
      detail: latest.detail,
      summary: summarizeStep(latest),
      durationMs: stepDurationMs(latest, nowMs),
    };
  };

  const crew: Array<LiveCrewMember> = [];
  let fallbackSpec: FlowSpec | null = null;

  if (spec !== null) {
    for (const node of spec.nodes) {
      const state = computeStateFor(node.id, node.label);
      nodeStates[node.id] = state;
      if (node.kind === "agent") {
        const bot = spec.bots[node.botId];
        const modelLabel =
          bot?.providerInstanceId && bot?.model
            ? `${bot.providerInstanceId} · ${bot.model}`
            : (bot?.model ?? null);
        crew.push({
          nodeId: node.id,
          nodeLabel: node.label,
          botId: node.botId,
          botLabel: bot?.label ?? node.botId,
          stepName: state.latestStepName ?? node.id,
          status: state.status,
          visitCount: state.visitCount,
          threadId: state.threadId,
          environmentId: state.environmentId,
          modelLabel,
          runtimeMode: node.runtimeModeOverride ?? bot?.runtimeMode ?? "approval-required",
          workspace: node.workspaceOverride ?? bot?.workspace ?? "root",
          project: node.project,
          summary: state.summary,
          durationMs: state.durationMs,
        });
      }
    }
  } else {
    // Fallback linear topology directly synthesized from live run steps (works for TS workflows too).
    const orderedBaseIds: Array<string> = [];
    const seenBase = new Set<string>();
    const kindByBase = new Map<string, WorkflowStep["kind"]>();
    for (const step of steps) {
      if (step.name.startsWith("@") || step.name === "precheck") continue;
      const { baseId } = stripVisitSuffix(step.name);
      if (!seenBase.has(baseId)) {
        seenBase.add(baseId);
        orderedBaseIds.push(baseId);
        kindByBase.set(baseId, step.kind);
      }
    }
    for (const q of questions) {
      const { baseId } = stripVisitSuffix(q.name);
      if (!seenBase.has(baseId)) {
        seenBase.add(baseId);
        orderedBaseIds.push(baseId);
        kindByBase.set(baseId, "ask");
      }
    }

    const fallbackNodes: Array<FlowNode> = [];
    const fallbackEdges: Array<FlowEdge> = [];
    const fallbackBots: Record<string, FlowSpec["bots"][string]> = {
      agent: {
        label: "Workflow Bot",
        runtimeMode: "approval-required",
        workspace: "root",
      },
    };

    for (let i = 0; i < orderedBaseIds.length; i++) {
      const baseId = orderedBaseIds[i]!;
      const stepKind = kindByBase.get(baseId) ?? "step";
      const safeId = sanitizeFlowIdentifier(baseId, `step-${i + 1}`);
      const state = computeStateFor(baseId, baseId);
      nodeStates[safeId] = state;

      if (stepKind === "agent") {
        fallbackNodes.push({
          id: safeId,
          kind: "agent",
          label: baseId,
          botId: "agent",
          project: "workspace",
          promptTemplate: "{{payload}}",
        });
        crew.push({
          nodeId: safeId,
          nodeLabel: baseId,
          botId: "agent",
          botLabel: baseId,
          stepName: state.latestStepName ?? baseId,
          status: state.status,
          visitCount: state.visitCount,
          threadId: state.threadId,
          environmentId: state.environmentId,
          modelLabel: null,
          runtimeMode: "approval-required",
          workspace: "root",
          project: "workspace",
          summary: state.summary,
          durationMs: state.durationMs,
        });
      } else if (stepKind === "ask") {
        fallbackNodes.push({
          id: safeId,
          kind: "gate",
          label: baseId,
          gateMode: "human",
          titleTemplate: baseId,
          choices: [{ value: "Continue" }],
        });
      } else {
        fallbackNodes.push({
          id: safeId,
          kind: "script",
          label: baseId,
          command: [baseId],
          cwd: ".",
        });
      }

      fallbackEdges.push({
        id: `fe-${i}`,
        from: i === 0 ? "trigger" : fallbackNodes[i - 1]!.id,
        to: safeId,
      });
    }

    fallbackSpec = {
      schemaVersion: 1,
      name: sanitizeFlowIdentifier(run.workflow, "workflow"),
      version: Math.max(1, run.version),
      bots: fallbackBots,
      triggers: [{ kind: "manual" }],
      nodes: fallbackNodes,
      edges: fallbackEdges,
    };
  }

  return {
    nodeStates,
    crew,
    fallbackSpec,
    totalLoopHops: Math.max(0, maxStepVisit - 1),
    circuitBreakerCount,
  };
}

export function buildChatEditPrompt(fileName: string, spec: FlowSpec, userGoal?: string): string {
  const goalLine =
    userGoal && userGoal.trim().length > 0
      ? `修改目标：${userGoal.trim()}\n`
      : "请结合当前节点与 Bot 角色，按我的需求帮我优化此多 Bot 工作流（修改节点/分支条件/Worktree 配置/人工审批门）。\n";
  return [
    `请使用 workflow MCP 工具调整可视化工作流 \`${fileName}\`（${spec.name}@v${spec.version}）。`,
    goalLine.trimEnd(),
    "操作要求：先调用 `t3_flow_read` 与 `t3_flow_list` 获取当前完整定义与可用项目/模型，修改后用 `t3_flow_validate` 严格校验，通过后再用 `t3_flow_save` 保存（若已有运行中实例请设 `createNewVersion: true`）。",
  ].join("\n\n");
}
