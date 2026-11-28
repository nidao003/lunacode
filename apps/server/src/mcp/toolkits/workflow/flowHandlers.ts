import { type FlowSpec, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as WorkflowRuntime from "../../../workflows/WorkflowRuntime.ts";
import * as Workflows from "../../../workflows/Workflows.ts";
import { compileFlowSpec } from "../../../workflows/flow/FlowCompiler.ts";
import { dryRunFlowSpec } from "../../../workflows/flow/FlowDryRun.ts";
import {
  FlowDefinitionLoadError,
  isFlowDefinitionFile,
  parseFlowSpecFromJson,
} from "../../../workflows/flow/FlowLoader.ts";
import { validateFlowSpec } from "../../../workflows/flow/FlowValidator.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FlowToolkit } from "./flowTools.ts";

const isFlowDefinitionLoadError = Schema.is(FlowDefinitionLoadError);

function formatFlowJson(spec: FlowSpec): string {
  // Top-level helper avoids globalJsonInEffect lint inside Effect generators.
  return `${JSON.stringify(spec, null, 2)}\n`;
}

function tryParseFlowSpec(
  source: string,
):
  | { readonly ok: true; readonly spec: FlowSpec }
  | { readonly ok: false; readonly message: string; readonly line: number | null } {
  try {
    return { ok: true, spec: parseFlowSpecFromJson(source) };
  } catch (error) {
    if (isFlowDefinitionLoadError(error)) {
      return { ok: false, message: error.message, line: error.line ?? null };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      line: null,
    };
  }
}

function tryCompileFlowSpec(spec: FlowSpec): string | null {
  try {
    compileFlowSpec(spec);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function normalizeTargetFlowFileName(
  rawFileName: string,
  spec: FlowSpec,
  createNewVersion: boolean,
): { readonly fileName: string; readonly nextVersion: number } | { readonly error: string } {
  const trimmed = rawFileName.trim();
  if (trimmed.length === 0) {
    return { error: "fileName cannot be empty." };
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return { error: "fileName must be a simple file name inside the workflows folder." };
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return { error: "t3_flow_save only writes .flow.json files." };
  }

  let base = trimmed;
  if (base.endsWith(".flow.json")) {
    base = base.slice(0, -".flow.json".length);
  } else if (base.endsWith(".json")) {
    base = base.slice(0, -".json".length);
  } else if (base.includes(".")) {
    return { error: "Flow file names must end with .flow.json (or omit extension)." };
  }

  if (base.length === 0) {
    return { error: "Flow file base name cannot be empty." };
  }

  if (createNewVersion) {
    const nextVersion = spec.version + 1;
    const baseWithoutVersion = base.replace(/\.v\d+$/i, "");
    return {
      fileName: `${baseWithoutVersion}.v${nextVersion}.flow.json`,
      nextVersion,
    };
  }
  return {
    fileName: `${base}.flow.json`,
    nextVersion: spec.version,
  };
}

const make = Effect.gen(function* () {
  const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
  const workflows = yield* Workflows.Workflows;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;

  return {
    t3_flow_list: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const [defFiles, projectSnapshot, serverProviders, runs] = yield* Effect.all([
          definitions.read,
          projects.snapshot.pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: `Failed to read project snapshot: ${String(cause)}`,
                }),
            ),
          ),
          input.includeProviders === false ? Effect.succeed([]) : providers.getProviders,
          input.includeRuns === false
            ? Effect.succeed([])
            : workflows.list().pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: `Failed to list workflow runs: ${String(cause)}`,
                    }),
                ),
              ),
        ]);

        const flowFiles = defFiles.files
          .filter((file) => isFlowDefinitionFile(file.name))
          .map((file) => {
            const parsed = tryParseFlowSpec(file.source);
            if (!parsed.ok) {
              return {
                fileName: file.name,
                workflows: file.workflows,
                problems: file.problems,
              };
            }
            return {
              fileName: file.name,
              workflows: file.workflows,
              problems: file.problems,
              name: parsed.spec.name,
              version: parsed.spec.version,
              ...(parsed.spec.description !== undefined
                ? { description: parsed.spec.description }
                : {}),
              botsCount: Object.keys(parsed.spec.bots).length,
              nodesCount: parsed.spec.nodes.length,
              edgesCount: parsed.spec.edges.length,
            };
          });

        return {
          directory: defFiles.directory,
          flows: flowFiles,
          projects: projectSnapshot.projects.map((project) => ({
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
          providers: serverProviders.map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            displayName: provider.displayName ?? null,
            enabled: provider.enabled,
            status: provider.status,
            models: provider.models.map((model) => ({
              slug: model.slug,
              name: model.name,
            })),
          })),
          recentRuns: runs.slice(0, 20).map((run) => ({
            runId: run.runId,
            workflow: run.workflow,
            version: run.version,
            status: run.status,
            detail: run.detail,
          })),
        };
      }),
    ),

    t3_flow_read: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const defFiles = yield* definitions.read;
        const flowFiles = defFiles.files.filter((file) => isFlowDefinitionFile(file.name));
        const targetName = input.name.trim();

        const matched =
          flowFiles.find((file) => file.name === targetName) ??
          flowFiles.find((file) => file.name === `${targetName}.flow.json`) ??
          flowFiles.find((file) => {
            const parsed = tryParseFlowSpec(file.source);
            return parsed.ok && parsed.spec.name === targetName;
          });

        if (!matched) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `No .flow.json file matched "${targetName}". Call t3_flow_list to see available flows.`,
          });
        }

        const parsed = tryParseFlowSpec(matched.source);
        if (!parsed.ok) {
          return {
            fileName: matched.name,
            source: matched.source,
            workflows: matched.workflows,
            problems: matched.problems,
            spec: null,
            validation: null,
            dryRun: null,
          };
        }

        const validation = validateFlowSpec(parsed.spec);
        const dryRun = dryRunFlowSpec(parsed.spec);
        return {
          fileName: matched.name,
          source: matched.source,
          workflows: matched.workflows,
          problems: matched.problems,
          spec: parsed.spec as unknown as Schema.Json,
          validation: { valid: validation.valid, issues: validation.issues },
          dryRun,
        };
      }),
    ),

    t3_flow_validate: McpToolAccess.reads((input) =>
      Effect.sync(() => {
        const parsed = tryParseFlowSpec(input.source);
        if (!parsed.ok) {
          return {
            valid: false,
            parseError: parsed.message,
            parseErrorLine: parsed.line,
            issues: [],
            dryRun: null,
          };
        }
        const validation = validateFlowSpec(parsed.spec);
        const dryRun = dryRunFlowSpec(parsed.spec);
        return {
          valid: validation.valid,
          parseError: null,
          parseErrorLine: null,
          issues: validation.issues,
          dryRun,
        };
      }),
    ),

    t3_flow_save: McpToolAccess.writesOwnerWork(
      "create or update .flow.json workflow definitions",
      (input) =>
        Effect.gen(function* () {
          const parsed = tryParseFlowSpec(input.source);
          if (!parsed.ok) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                parsed.line !== null ? `${parsed.message} (line ${parsed.line})` : parsed.message,
            });
          }

          const normalized = normalizeTargetFlowFileName(
            input.fileName,
            parsed.spec,
            input.createNewVersion === true,
          );
          if ("error" in normalized) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: normalized.error,
            });
          }

          const finalSpec: FlowSpec =
            normalized.nextVersion !== parsed.spec.version
              ? { ...parsed.spec, version: normalized.nextVersion }
              : parsed.spec;

          const validation = validateFlowSpec(finalSpec);
          if (!validation.valid) {
            const errorSummary = validation.issues
              .filter((issue) => issue.severity === "error")
              .map((issue) => issue.message)
              .join("; ");
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Flow validation failed: ${errorSummary}`,
            });
          }

          const compileError = tryCompileFlowSpec(finalSpec);
          if (compileError !== null) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Flow compilation failed: ${compileError}`,
            });
          }

          const formatted = formatFlowJson(finalSpec);
          const dryRun = dryRunFlowSpec(finalSpec);
          const saveResult = yield* definitions.save(normalized.fileName, formatted);

          return {
            savedFileName: normalized.fileName,
            version: finalSpec.version,
            changed: saveResult.changed,
            problems: saveResult.problems,
            issues: validation.issues,
            dryRun,
          };
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof FlowToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FlowToolkit, make);
