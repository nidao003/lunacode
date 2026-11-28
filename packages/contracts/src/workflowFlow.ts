import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const FlowIdentifier = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
);
export type FlowIdentifier = typeof FlowIdentifier.Type;

export const FlowWorkspaceStrategy = Schema.Literals(["root", "worktree"]);
export type FlowWorkspaceStrategy = typeof FlowWorkspaceStrategy.Type;

export const FlowBotModelOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
});
export type FlowBotModelOption = typeof FlowBotModelOption.Type;

export const FlowBotRole = Schema.Struct({
  label: TrimmedNonEmptyString,
  providerInstanceId: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  modelOptions: Schema.optional(Schema.Array(FlowBotModelOption)),
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspace: Schema.optional(FlowWorkspaceStrategy),
  workspaceBaseRef: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
  rolePrompt: Schema.optional(Schema.String),
  environmentId: Schema.optional(TrimmedNonEmptyString),
  maxActive: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type FlowBotRole = typeof FlowBotRole.Type;

export const FlowTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("every"),
    interval: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("daily"),
    timeOfDay: TrimmedNonEmptyString,
    weekdays: Schema.optional(
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    name: FlowIdentifier,
    idempotencyPath: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("issues.opened"),
    project: TrimmedNonEmptyString,
    labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    query: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("pullRequests.opened"),
    project: TrimmedNonEmptyString,
    query: Schema.optional(Schema.String),
  }),
]);
export type FlowTrigger = typeof FlowTrigger.Type;

export const FlowPrecheck = Schema.Struct({
  command: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  cwd: TrimmedNonEmptyString,
  timeoutSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300 }))),
  runOnManual: Schema.optional(Schema.Boolean),
});
export type FlowPrecheck = typeof FlowPrecheck.Type;

export const FlowOutputFieldType = Schema.Literals(["string", "number", "boolean", "string[]"]);
export type FlowOutputFieldType = typeof FlowOutputFieldType.Type;

export const FlowOutputField = Schema.Struct({
  name: FlowIdentifier,
  type: FlowOutputFieldType,
  description: Schema.optional(Schema.String),
  optional: Schema.optional(Schema.Boolean),
});
export type FlowOutputField = typeof FlowOutputField.Type;

export const FlowNodeFailurePolicy = Schema.Literals(["pause", "branch"]);
export type FlowNodeFailurePolicy = typeof FlowNodeFailurePolicy.Type;

export const FlowAgentNode = Schema.Struct({
  id: FlowIdentifier,
  kind: Schema.Literal("agent"),
  label: TrimmedNonEmptyString,
  botId: FlowIdentifier,
  project: TrimmedNonEmptyString,
  continueThreadFromNodeId: Schema.optional(FlowIdentifier),
  workspaceOverride: Schema.optional(FlowWorkspaceStrategy),
  workspaceBaseRefOverride: Schema.optional(TrimmedNonEmptyString),
  runtimeModeOverride: Schema.optional(RuntimeMode),
  interactionModeOverride: Schema.optional(ProviderInteractionMode),
  promptTemplate: Schema.String,
  skills: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  returns: Schema.optional(Schema.Array(FlowOutputField)),
  onFailure: Schema.optional(FlowNodeFailurePolicy),
  timeout: Schema.optional(TrimmedNonEmptyString),
  quiet: Schema.optional(TrimmedNonEmptyString),
});
export type FlowAgentNode = typeof FlowAgentNode.Type;

export const FlowGateChoice = Schema.Struct({
  value: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  requireReason: Schema.optional(Schema.Boolean),
});
export type FlowGateChoice = typeof FlowGateChoice.Type;

export const FlowGateNode = Schema.Struct({
  id: FlowIdentifier,
  kind: Schema.Literal("gate"),
  label: TrimmedNonEmptyString,
  gateMode: Schema.Literals(["human", "coordinator_then_human"]),
  askKind: Schema.optional(TrimmedNonEmptyString),
  titleTemplate: TrimmedNonEmptyString,
  choices: Schema.Array(FlowGateChoice).check(Schema.isMinLength(1)),
  timeout: Schema.optional(TrimmedNonEmptyString),
});
export type FlowGateNode = typeof FlowGateNode.Type;

export const FlowScriptNode = Schema.Struct({
  id: FlowIdentifier,
  kind: Schema.Literal("script"),
  label: TrimmedNonEmptyString,
  command: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  cwd: TrimmedNonEmptyString,
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1800 })),
  ),
  onFailure: Schema.optional(FlowNodeFailurePolicy),
});
export type FlowScriptNode = typeof FlowScriptNode.Type;

export const FlowEndOutcome = Schema.Literals(["complete", "stop", "skip"]);
export type FlowEndOutcome = typeof FlowEndOutcome.Type;

export const FlowEndNode = Schema.Struct({
  id: FlowIdentifier,
  kind: Schema.Literal("end"),
  label: TrimmedNonEmptyString,
  outcome: FlowEndOutcome,
  reasonTemplate: Schema.optional(Schema.String),
});
export type FlowEndNode = typeof FlowEndNode.Type;

export const FlowNode = Schema.Union([FlowAgentNode, FlowGateNode, FlowScriptNode, FlowEndNode]);
export type FlowNode = typeof FlowNode.Type;

export const FlowEdge = Schema.Struct({
  id: FlowIdentifier,
  from: FlowIdentifier,
  to: FlowIdentifier,
  when: Schema.optional(Schema.String),
  isLoop: Schema.optional(Schema.Boolean),
});
export type FlowEdge = typeof FlowEdge.Type;

export const FlowNodeLayout = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
});
export type FlowNodeLayout = typeof FlowNodeLayout.Type;

export const FlowSpec = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: FlowIdentifier,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  maxHops: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  askFirst: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  bots: Schema.Record(FlowIdentifier, FlowBotRole),
  triggers: Schema.Array(FlowTrigger),
  precheck: Schema.optional(FlowPrecheck),
  nodes: Schema.Array(FlowNode),
  edges: Schema.Array(FlowEdge),
  layout: Schema.optional(Schema.Record(Schema.String, FlowNodeLayout)),
});
export type FlowSpec = typeof FlowSpec.Type;

export const FlowValidationSeverity = Schema.Literals(["error", "warning"]);
export type FlowValidationSeverity = typeof FlowValidationSeverity.Type;

export const FlowValidationIssue = Schema.Struct({
  code: TrimmedNonEmptyString,
  severity: FlowValidationSeverity,
  message: TrimmedNonEmptyString,
  nodeId: Schema.optional(Schema.String),
  edgeId: Schema.optional(Schema.String),
  botId: Schema.optional(Schema.String),
});
export type FlowValidationIssue = typeof FlowValidationIssue.Type;

export const FlowDryRunLayer = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nodeIds: Schema.Array(Schema.String),
  parallel: Schema.Boolean,
});
export type FlowDryRunLayer = typeof FlowDryRunLayer.Type;

export const FlowDryRunReport = Schema.Struct({
  valid: Schema.Boolean,
  workflowName: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxHops: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  layers: Schema.Array(FlowDryRunLayer),
  loopEdges: Schema.Array(
    Schema.Struct({
      edgeId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      when: Schema.optional(Schema.String),
    }),
  ),
  parallelWriteRisks: Schema.Array(
    Schema.Struct({
      project: Schema.String,
      nodeIds: Schema.Array(Schema.String),
      reason: Schema.String,
    }),
  ),
  highRiskNodes: Schema.Array(
    Schema.Struct({
      nodeId: Schema.String,
      label: Schema.String,
      reason: Schema.String,
    }),
  ),
  untrustedDataFields: Schema.Array(Schema.String),
  issues: Schema.Array(FlowValidationIssue),
});
export type FlowDryRunReport = typeof FlowDryRunReport.Type;
