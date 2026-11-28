import {
  FlowSpec,
  type FlowAgentNode,
  type FlowDryRunLayer,
  type FlowEdge,
  type FlowNode,
  type FlowValidationIssue,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

import { durationOf } from "../options.ts";
import { checkTriggers } from "../triggers.ts";
import {
  containsTemplateSyntax,
  extractTemplatePaths,
  parseFlowExpression,
  validateTemplatePaths,
} from "./FlowExpression.ts";

const decodeStrictFlowSpec = Schema.decodeUnknownSync(FlowSpec, { onExcessProperty: "error" });

export function decodeStrictFlowSpecSync(raw: unknown): FlowSpec {
  return decodeStrictFlowSpec(raw);
}

export interface FlowValidationResult {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<FlowValidationIssue>;
  readonly layers: ReadonlyArray<FlowDryRunLayer>;
  readonly loopEdges: ReadonlyArray<{
    readonly edgeId: string;
    readonly from: string;
    readonly to: string;
    readonly when?: string;
  }>;
  readonly parallelWriteRisks: ReadonlyArray<{
    readonly project: string;
    readonly nodeIds: ReadonlyArray<string>;
    readonly reason: string;
  }>;
  readonly highRiskNodes: ReadonlyArray<{
    readonly nodeId: string;
    readonly label: string;
    readonly reason: string;
  }>;
  readonly untrustedDataFields: ReadonlyArray<string>;
}

const RESERVED_STEP_NAMES = new Set(["trigger", "onEnd"]);
const WRITABLE_RUNTIME_MODES = new Set(["auto-accept-edits", "auto", "full-access"]);

function normalizeProjectKey(project: string): string {
  return project.trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

function isWritableAgentNode(node: FlowAgentNode, spec: FlowSpec): boolean {
  const bot = spec.bots[node.botId];
  const runtimeMode = node.runtimeModeOverride ?? bot?.runtimeMode ?? "approval-required";
  const interactionMode = node.interactionModeOverride ?? bot?.interactionMode ?? "default";
  return interactionMode !== "plan" && WRITABLE_RUNTIME_MODES.has(runtimeMode);
}

function effectiveWorkspace(node: FlowAgentNode, spec: FlowSpec): "root" | "worktree" {
  const bot = spec.bots[node.botId];
  return node.workspaceOverride ?? bot?.workspace ?? "root";
}

function computeForwardReachability(
  nodeIds: ReadonlyArray<string>,
  forwardEdges: ReadonlyArray<FlowEdge>,
): Map<string, Set<string>> {
  const adj = new Map<string, Array<string>>();
  for (const id of nodeIds) adj.set(id, []);
  for (const edge of forwardEdges) {
    if (edge.from !== "trigger") {
      adj.get(edge.from)?.push(edge.to);
    }
  }
  const reachable = new Map<string, Set<string>>();
  for (const start of nodeIds) {
    const visited = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adj.get(current) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    reachable.set(start, visited);
  }
  return reachable;
}

function computeLayers(
  nodes: ReadonlyArray<FlowNode>,
  forwardEdges: ReadonlyArray<FlowEdge>,
): {
  readonly layers: ReadonlyArray<FlowDryRunLayer>;
  readonly cycleNodes: ReadonlyArray<string>;
} {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, Array<string>>();
  const depth = new Map<string, number>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
    depth.set(node.id, 0);
  }
  for (const edge of forwardEdges) {
    if (edge.from === "trigger") continue;
    if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue;
    adj.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: Array<string> = [];
  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) queue.push(node.id);
  }

  const sorted: Array<string> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    const currentDepth = depth.get(current) ?? 0;
    for (const next of adj.get(current) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 0, currentDepth + 1);
      depth.set(next, nextDepth);
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  const cycleNodes = nodes.map((node) => node.id).filter((id) => !sorted.includes(id));

  const byDepth = new Map<number, Array<string>>();
  for (const id of sorted) {
    const d = depth.get(id) ?? 0;
    const list = byDepth.get(d);
    if (list) list.push(id);
    else byDepth.set(d, [id]);
  }

  const layers: Array<FlowDryRunLayer> = [...byDepth.keys()]
    .sort((a, b) => a - b)
    .map((layerIndex) => {
      const nodeIds = byDepth.get(layerIndex) ?? [];
      return { index: layerIndex, nodeIds, parallel: nodeIds.length > 1 };
    });

  return { layers, cycleNodes };
}

export function validateFlowSpec(spec: FlowSpec): FlowValidationResult {
  const issues: Array<FlowValidationIssue> = [];
  const nodeMap = new Map<string, FlowNode>();
  const edgeMap = new Map<string, FlowEdge>();

  if (spec.nodes.length === 0) {
    issues.push({
      code: "empty_nodes",
      severity: "error",
      message: "工作流至少需要 1 个节点。",
    });
  }

  // 1. Triggers validation
  const engineTriggers: Array<Parameters<typeof checkTriggers>[1][number]> = [];
  const seenManual = { count: 0 };
  for (const trigger of spec.triggers) {
    if (trigger.kind === "manual") {
      seenManual.count++;
      if (seenManual.count > 1) {
        issues.push({
          code: "duplicate_trigger",
          severity: "error",
          message: "manual 触发器最多声明一次。",
        });
      }
      continue;
    }
    if (trigger.kind === "every") {
      try {
        const parsed = durationOf(
          `trigger.every("${trigger.interval}")`,
          trigger.interval as Duration.Input,
        );
        const everyMs = Duration.toMillis(parsed);
        if (everyMs < 60_000) {
          issues.push({
            code: "trigger_interval_too_short",
            severity: "error",
            message: `every 触发间隔 "${trigger.interval}" 不能短于 1 分钟。`,
          });
        }
        engineTriggers.push({
          kind: "schedule",
          id: `every:${everyMs}`,
          schedule: { type: "interval", everyMs },
        });
      } catch (err) {
        issues.push({
          code: "invalid_trigger_interval",
          severity: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (trigger.kind === "daily") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.timeOfDay)) {
        issues.push({
          code: "invalid_daily_time",
          severity: "error",
          message: `daily 时间 "${trigger.timeOfDay}" 必须是 24 小时制 HH:mm（例如 "09:00"）。`,
        });
      }
      const weekdays = trigger.weekdays;
      engineTriggers.push({
        kind: "schedule",
        id: `daily:${trigger.timeOfDay}:${weekdays ? [...weekdays].sort().join(",") : "all"}`,
        schedule: {
          type: "fixed_time",
          timeOfDay: trigger.timeOfDay,
          ...(weekdays ? { weekdays } : {}),
        },
      });
      continue;
    }
    if (trigger.kind === "webhook") {
      engineTriggers.push({ kind: "webhook", name: trigger.name, key: undefined });
      continue;
    }
    if (trigger.kind === "issues.opened") {
      if (containsTemplateSyntax(trigger.project)) {
        issues.push({
          code: "untrusted_template_in_static_field",
          severity: "error",
          message: "issues.opened 触发器的 project 禁止模板插值。",
        });
      }
      engineTriggers.push({
        kind: "issues",
        id: JSON.stringify(["issues", trigger.project, trigger.labels ?? [], trigger.query ?? ""]),
        project: trigger.project,
        labels: trigger.labels,
        query: trigger.query,
      });
      continue;
    }
    if (trigger.kind === "pullRequests.opened") {
      if (containsTemplateSyntax(trigger.project)) {
        issues.push({
          code: "untrusted_template_in_static_field",
          severity: "error",
          message: "pullRequests.opened 触发器的 project 禁止模板插值。",
        });
      }
      engineTriggers.push({
        kind: "pullRequests",
        id: JSON.stringify(["pullRequests", trigger.project, [], trigger.query ?? ""]),
        project: trigger.project,
        query: trigger.query,
      });
    }
  }
  try {
    checkTriggers(spec.name, engineTriggers);
  } catch (err) {
    issues.push({
      code: "duplicate_trigger",
      severity: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Bots validation (no template interpolation in static configuration)
  for (const [botId, bot] of Object.entries(spec.bots)) {
    if (
      (bot.providerInstanceId !== undefined && containsTemplateSyntax(bot.providerInstanceId)) ||
      (bot.model !== undefined && containsTemplateSyntax(bot.model)) ||
      (bot.environmentId !== undefined && containsTemplateSyntax(bot.environmentId)) ||
      (bot.workspaceBaseRef !== undefined && containsTemplateSyntax(bot.workspaceBaseRef))
    ) {
      issues.push({
        code: "untrusted_template_in_bot",
        severity: "error",
        botId,
        message: `Bot "${botId}" 的模型、环境或分支配置不允许模板插值 {{...}}。`,
      });
    }
  }

  // 3. Precheck static validation
  if (spec.precheck) {
    if (
      containsTemplateSyntax(spec.precheck.cwd) ||
      spec.precheck.command.some(containsTemplateSyntax)
    ) {
      issues.push({
        code: "untrusted_template_in_precheck",
        severity: "error",
        message: "precheck 的 command 和 cwd 必须为静态字面量，禁止模板插值。",
      });
    }
  }

  // 4. Nodes validation
  const untrustedFieldSet = new Set<string>();
  for (const node of spec.nodes) {
    if (
      RESERVED_STEP_NAMES.has(node.id) ||
      node.id.startsWith("@pool:") ||
      node.id.startsWith("@circuit-breaker") ||
      node.id === "precheck"
    ) {
      issues.push({
        code: "reserved_node_id",
        severity: "error",
        nodeId: node.id,
        message: `节点 ID "${node.id}" 为系统保留名，请更换其他 ID。`,
      });
    }
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

    if (node.kind === "agent") {
      if (!Object.hasOwn(spec.bots, node.botId)) {
        issues.push({
          code: "unknown_bot",
          severity: "error",
          nodeId: node.id,
          botId: node.botId,
          message: `节点 "${node.id}" 引用了未定义的 Bot "${node.botId}"。`,
        });
      }
      if (
        containsTemplateSyntax(node.project) ||
        containsTemplateSyntax(node.botId) ||
        (node.workspaceBaseRefOverride !== undefined &&
          containsTemplateSyntax(node.workspaceBaseRefOverride))
      ) {
        issues.push({
          code: "untrusted_template_in_static_field",
          severity: "error",
          nodeId: node.id,
          message: `Agent 节点 "${node.id}" 的 project、botId 与分支基线禁止使用模板插值。`,
        });
      }
      try {
        validateTemplatePaths(node.promptTemplate);
        for (const p of extractTemplatePaths(node.promptTemplate)) {
          if (p === "payload" || p.startsWith("payload.")) untrustedFieldSet.add(p);
        }
      } catch (err) {
        issues.push({
          code: "invalid_template_path",
          severity: "error",
          nodeId: node.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (node.returns) {
        const seenField = new Set<string>();
        for (const field of node.returns) {
          if (seenField.has(field.name)) {
            issues.push({
              code: "duplicate_output_field",
              severity: "error",
              nodeId: node.id,
              message: `节点 "${node.id}" 的结构化输出字段 "${field.name}" 重复。`,
            });
          }
          seenField.add(field.name);
        }
      }
      for (const [label, dur] of [
        ["timeout", node.timeout],
        ["quiet", node.quiet],
      ] as const) {
        if (dur !== undefined) {
          try {
            durationOf(`agent("${node.id}").${label}`, dur as Duration.Input);
          } catch (err) {
            issues.push({
              code: "invalid_duration",
              severity: "error",
              nodeId: node.id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } else if (node.kind === "gate") {
      try {
        validateTemplatePaths(node.titleTemplate);
        for (const p of extractTemplatePaths(node.titleTemplate)) {
          if (p === "payload" || p.startsWith("payload.")) untrustedFieldSet.add(p);
        }
      } catch (err) {
        issues.push({
          code: "invalid_template_path",
          severity: "error",
          nodeId: node.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (node.timeout !== undefined) {
        try {
          durationOf(`gate("${node.id}").timeout`, node.timeout as Duration.Input);
        } catch (err) {
          issues.push({
            code: "invalid_duration",
            severity: "error",
            nodeId: node.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (node.kind === "script") {
      if (containsTemplateSyntax(node.cwd) || node.command.some(containsTemplateSyntax)) {
        issues.push({
          code: "untrusted_template_in_static_field",
          severity: "error",
          nodeId: node.id,
          message: `Script 节点 "${node.id}" 的 command 和 cwd 必须为静态字面量。`,
        });
      }
    } else if (node.kind === "end" && node.reasonTemplate !== undefined) {
      try {
        validateTemplatePaths(node.reasonTemplate);
      } catch (err) {
        issues.push({
          code: "invalid_template_path",
          severity: "error",
          nodeId: node.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Validate continueThreadFromNodeId references after all nodes are indexed
  for (const node of spec.nodes) {
    if (node.kind !== "agent" || node.continueThreadFromNodeId === undefined) continue;
    if (node.continueThreadFromNodeId === node.id) {
      issues.push({
        code: "self_continue_thread",
        severity: "error",
        nodeId: node.id,
        message: `节点 "${node.id}" 不能延续自身的会话。`,
      });
      continue;
    }
    const target = nodeMap.get(node.continueThreadFromNodeId);
    if (!target || target.kind !== "agent") {
      issues.push({
        code: "invalid_continue_thread",
        severity: "error",
        nodeId: node.id,
        message: `节点 "${node.id}" 延续的会话来源 "${node.continueThreadFromNodeId}" 不存在或不是 Agent 节点。`,
      });
    }
  }

  // 5. Edges validation
  const forwardEdges: Array<FlowEdge> = [];
  const loopEdges: Array<{
    readonly edgeId: string;
    readonly from: string;
    readonly to: string;
    readonly when?: string;
  }> = [];

  for (const edge of spec.edges) {
    if (edgeMap.has(edge.id)) {
      issues.push({
        code: "duplicate_edge_id",
        severity: "error",
        edgeId: edge.id,
        message: `存在重复的连线 ID "${edge.id}"。`,
      });
    } else {
      edgeMap.set(edge.id, edge);
    }

    if (edge.from !== "trigger" && !nodeMap.has(edge.from)) {
      issues.push({
        code: "unknown_edge_source",
        severity: "error",
        edgeId: edge.id,
        message: `连线 "${edge.id}" 的起点 "${edge.from}" 不存在。`,
      });
    }
    if (edge.to === "trigger" || !nodeMap.has(edge.to)) {
      issues.push({
        code: "unknown_edge_target",
        severity: "error",
        edgeId: edge.id,
        message: `连线 "${edge.id}" 的终点 "${edge.to}" 不存在或为 trigger。`,
      });
    }
    if (edge.when !== undefined && edge.when.trim().length > 0) {
      try {
        parseFlowExpression(edge.when);
      } catch (err) {
        issues.push({
          code: "invalid_edge_condition",
          severity: "error",
          edgeId: edge.id,
          message: `连线 "${edge.id}" 条件表达式非法: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (edge.isLoop === true) {
      if (edge.from === "trigger") {
        issues.push({
          code: "trigger_cannot_be_loop",
          severity: "error",
          edgeId: edge.id,
          message: `连线 "${edge.id}" 从 trigger 出发，不能标记为 isLoop。`,
        });
      } else {
        loopEdges.push({
          edgeId: edge.id,
          from: edge.from,
          to: edge.to,
          ...(edge.when === undefined ? {} : { when: edge.when }),
        });
        if (edge.when === undefined || edge.when.trim().length === 0) {
          issues.push({
            code: "unconditional_loop_edge",
            severity: "warning",
            edgeId: edge.id,
            message: `回流边 "${edge.id}" 未设置 when 退出条件，运行时将依赖 maxHops 熔断停止。`,
          });
        }
      }
    } else {
      forwardEdges.push(edge);
    }
  }

  // 6. Forward DAG acyclicity & layering
  const { layers, cycleNodes } = computeLayers(spec.nodes, forwardEdges);
  if (cycleNodes.length > 0) {
    issues.push({
      code: "dag_cycle_detected",
      severity: "error",
      message: `检测到未标记 isLoop: true 的环路（涉及节点: ${cycleNodes.join(", ")}）。请将回流边显式标记为 isLoop: true 并配置 maxHops。`,
    });
  }

  // 7. Reachability from trigger
  if (spec.nodes.length > 0 && cycleNodes.length === 0) {
    const startNodes = new Set(
      forwardEdges.filter((edge) => edge.from === "trigger").map((edge) => edge.to),
    );
    if (startNodes.size === 0) {
      issues.push({
        code: "missing_trigger_edge",
        severity: "error",
        message: '工作流缺少从 "trigger" 出发的连线，运行时将没有任何起始节点。',
      });
    } else {
      const reachable = new Set<string>(startNodes);
      const stack = [...startNodes];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const edge of forwardEdges) {
          if (edge.from === cur && !reachable.has(edge.to)) {
            reachable.add(edge.to);
            stack.push(edge.to);
          }
        }
      }
      for (const node of spec.nodes) {
        if (!reachable.has(node.id)) {
          issues.push({
            code: "unreachable_node",
            severity: "error",
            nodeId: node.id,
            message: `节点 "${node.id}" 无法从 trigger 到达，请补全上游连线。`,
          });
        }
      }
    }
  }

  // 8. Parallel write-conflict check (Worktree isolation)
  const forwardReachable = computeForwardReachability(
    spec.nodes.map((node) => node.id),
    forwardEdges,
  );
  const parallelWriteRisks: Array<{
    readonly project: string;
    readonly nodeIds: ReadonlyArray<string>;
    readonly reason: string;
  }> = [];

  const writableAgents = spec.nodes.filter(
    (node): node is FlowAgentNode => node.kind === "agent" && isWritableAgentNode(node, spec),
  );
  for (let i = 0; i < writableAgents.length; i++) {
    for (let j = i + 1; j < writableAgents.length; j++) {
      const left = writableAgents[i]!;
      const right = writableAgents[j]!;
      if (normalizeProjectKey(left.project) !== normalizeProjectKey(right.project)) continue;
      if (
        left.continueThreadFromNodeId === right.id ||
        right.continueThreadFromNodeId === left.id
      ) {
        continue;
      }
      const leftToRight = forwardReachable.get(left.id)?.has(right.id) ?? false;
      const rightToLeft = forwardReachable.get(right.id)?.has(left.id) ?? false;
      if (leftToRight || rightToLeft) continue;

      // Neither strictly precedes the other in the forward DAG => can execute concurrently.
      const leftWs = effectiveWorkspace(left, spec);
      const rightWs = effectiveWorkspace(right, spec);
      if (leftWs !== "worktree" || rightWs !== "worktree") {
        const reason = `并行修改同一仓库 (${left.project}) 的可写节点 "${left.id}" 与 "${right.id}" 必须启用独立 worktree 隔离。`;
        parallelWriteRisks.push({
          project: left.project,
          nodeIds: [left.id, right.id],
          reason,
        });
        issues.push({
          code: "parallel_worktree_required",
          severity: "error",
          nodeId: leftWs !== "worktree" ? left.id : right.id,
          message: reason,
        });
      }
    }
  }

  // 9. High-risk / askFirst audit warnings
  const gateNodeIds = new Set(
    spec.nodes.filter((node) => node.kind === "gate").map((node) => node.id),
  );
  const hasPrecedingGate = (targetId: string) => {
    for (const gateId of gateNodeIds) {
      if (forwardReachable.get(gateId)?.has(targetId)) return true;
    }
    return false;
  };

  const highRiskNodes: Array<{
    readonly nodeId: string;
    readonly label: string;
    readonly reason: string;
  }> = [];

  for (const node of spec.nodes) {
    if (node.kind === "agent") {
      const bot = spec.bots[node.botId];
      const runtimeMode = node.runtimeModeOverride ?? bot?.runtimeMode;
      if (runtimeMode === "full-access" && !hasPrecedingGate(node.id)) {
        const reason = "以 full-access 权限运行且前方无人工 Gate 审批节点";
        highRiskNodes.push({ nodeId: node.id, label: node.label, reason });
        issues.push({
          code: "high_risk_without_gate",
          severity: "warning",
          nodeId: node.id,
          message: `建议在 full-access 节点 "${node.label}" 前置人工 Gate 节点。`,
        });
      }
    } else if (node.kind === "script" && !hasPrecedingGate(node.id)) {
      const reason = `执行本地命令 "${node.command.join(" ")}" 且前方无人工 Gate`;
      highRiskNodes.push({ nodeId: node.id, label: node.label, reason });
    }
  }

  if (spec.askFirst && spec.askFirst.length > 0 && gateNodeIds.size === 0) {
    issues.push({
      code: "ask_first_without_gate",
      severity: "warning",
      message: `工作流声明了高危动作清单 (${spec.askFirst.join(", ")})，但当前拓扑中没有 Gate 人工审批节点。`,
    });
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    layers,
    loopEdges,
    parallelWriteRisks,
    highRiskNodes,
    untrustedDataFields: [...untrustedFieldSet],
  };
}
