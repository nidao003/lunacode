import {
  FlowDryRunReport,
  FlowValidationIssue,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
  WorkflowDefinitionProblem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as WorkflowRuntime from "../../../workflows/WorkflowRuntime.ts";
import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorkflowRuntime.WorkflowDefinitions,
  Workflows.Workflows,
  ProjectService.ProjectService,
  ProviderRegistry.ProviderRegistry,
];

export const FlowValidationSummary = Schema.Struct({
  valid: Schema.Boolean,
  issues: Schema.Array(FlowValidationIssue),
});

const FlowListTool = Tool.make("t3_flow_list", {
  description:
    "List .flow.json workflows, projects, enabled providers/models, and recent runs so you can inspect or design flows.",
  parameters: Schema.Struct({
    includeRuns: Schema.optional(Schema.Boolean),
    includeProviders: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    directory: Schema.String,
    flows: Schema.Array(
      Schema.Struct({
        fileName: Schema.String,
        workflows: Schema.Array(Schema.String),
        problems: Schema.Array(WorkflowDefinitionProblem),
        name: Schema.optional(Schema.String),
        version: Schema.optional(Schema.Number),
        description: Schema.optional(Schema.String),
        botsCount: Schema.optional(Schema.Number),
        nodesCount: Schema.optional(Schema.Number),
        edgesCount: Schema.optional(Schema.Number),
      }),
    ),
    projects: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        workspaceRoot: Schema.String,
      }),
    ),
    providers: Schema.Array(
      Schema.Struct({
        instanceId: Schema.String,
        driver: Schema.String,
        displayName: Schema.NullOr(Schema.String),
        enabled: Schema.Boolean,
        status: Schema.String,
        models: Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            name: Schema.String,
          }),
        ),
      }),
    ),
    recentRuns: Schema.Array(
      Schema.Struct({
        runId: Schema.String,
        workflow: Schema.String,
        version: Schema.Number,
        status: Schema.String,
        detail: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List visual workflows and capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const FlowReadTool = Tool.make("t3_flow_read", {
  description:
    "Read a .flow.json file along with its parsed FlowSpec, validation issues, and dry-run topology report.",
  parameters: Schema.Struct({
    name: TrimmedNonEmptyString.annotate({
      description: "Flow file name (e.g. bugfix.flow.json) or workflow name.",
    }),
  }),
  success: Schema.Struct({
    fileName: Schema.String,
    source: Schema.String,
    workflows: Schema.Array(Schema.String),
    problems: Schema.Array(WorkflowDefinitionProblem),
    spec: Schema.NullOr(Schema.Json),
    validation: Schema.NullOr(FlowValidationSummary),
    dryRun: Schema.NullOr(FlowDryRunReport),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a visual workflow")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const FlowValidateTool = Tool.make("t3_flow_validate", {
  description:
    "Validate candidate FlowSpec v1 JSON without writing to disk; returns schema/graph errors and a dry-run report.",
  parameters: Schema.Struct({
    source: TrimmedNonEmptyString.annotate({
      description: "Candidate .flow.json JSON string.",
    }),
  }),
  success: Schema.Struct({
    valid: Schema.Boolean,
    parseError: Schema.NullOr(Schema.String),
    parseErrorLine: Schema.NullOr(Schema.Number),
    issues: Schema.Array(FlowValidationIssue),
    dryRun: Schema.NullOr(FlowDryRunReport),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Validate a visual workflow")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const FlowSaveTool = Tool.make("t3_flow_save", {
  description:
    "Validate, compile-check, format, and save a .flow.json workflow. Set createNewVersion=true to save <base>.v<N+1>.flow.json.",
  parameters: Schema.Struct({
    fileName: TrimmedNonEmptyString.annotate({
      description: "Target .flow.json file name (or base name).",
    }),
    source: TrimmedNonEmptyString.annotate({
      description: "Valid FlowSpec v1 JSON string.",
    }),
    createNewVersion: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    savedFileName: Schema.String,
    version: Schema.Number,
    changed: Schema.Boolean,
    problems: Schema.Array(WorkflowDefinitionProblem),
    issues: Schema.Array(FlowValidationIssue),
    dryRun: FlowDryRunReport,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Save a visual workflow")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const FlowToolkit = Toolkit.make(FlowListTool, FlowReadTool, FlowValidateTool, FlowSaveTool);
