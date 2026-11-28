import {
  EnvironmentId,
  type FlowSpec,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, type Tool } from "effect/ai";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as WorkflowRuntime from "../../../workflows/WorkflowRuntime.ts";
import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as FlowHandlers from "./flowHandlers.ts";
import { FlowToolkit } from "./flowTools.ts";

const PROJECT_ID = ProjectId.make("project-1");

const VALID_FLOW: FlowSpec = {
  schemaVersion: 1,
  name: "bugfix-flow",
  version: 1,
  description: "Inspect then fix",
  triggers: [{ kind: "manual" }],
  bots: {
    fixer: {
      label: "Fixer Bot",
      runtimeMode: "full-access",
      workspace: "root",
      rolePrompt: "Fix cleanly.",
    },
  },
  nodes: [
    {
      kind: "agent",
      id: "fix",
      label: "Run Fix",
      botId: "fixer",
      project: "project-1",
      promptTemplate: "Fix {{payload.issue}}",
    },
    {
      kind: "end",
      id: "done",
      label: "Done",
      outcome: "complete",
    },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "fix" },
    { id: "e2", from: "fix", to: "done" },
  ],
};

function invocationScope(options?: {
  readonly clientSessionId?: string;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
}): McpInvocationContext.McpInvocationScope {
  return {
    environmentId: EnvironmentId.make("env-1"),
    requestNamespace: "session-1",
    thread: options?.clientSessionId
      ? undefined
      : {
          threadId: ThreadId.make("thread-1"),
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
    client: options?.clientSessionId
      ? {
          sessionId: options.clientSessionId,
          label: "Outside client",
          access: "read-only" as const,
          linked: false,
        }
      : undefined,
    capabilities: new Set(options?.capabilities ?? ["orchestration"]),
    issuedAt: 1,
  };
}

const makeHarness = Effect.fn("makeFlowToolkitHarness")(function* () {
  const filesRef = yield* Ref.make<ReadonlyArray<{ name: string; source: string }>>([
    { name: "bugfix.flow.json", source: JSON.stringify(VALID_FLOW, null, 2) },
  ]);

  const layerDependencies = Layer.mergeAll(
    Layer.mock(WorkflowRuntime.WorkflowDefinitions)({
      read: Ref.get(filesRef).pipe(
        Effect.map((entries) => ({
          directory: "/tmp/workflows",
          single: false,
          revision: 1,
          problem: null,
          problems: [],
          files: entries.map((entry) => ({
            name: entry.name,
            source: entry.source,
            workflows: ["bugfix-flow@1"],
            problems: [],
          })),
        })),
      ),
      save: (name, source) =>
        Ref.update(filesRef, (entries) => [
          ...entries.filter((entry) => entry.name !== name),
          { name, source },
        ]).pipe(Effect.as({ changed: true, problems: [] })),
    }),
    Layer.mock(Workflows.Workflows)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.succeed({
        projects: [
          {
            id: PROJECT_ID,
            title: "Main Repo",
            workspaceRoot: "/workspace/main",
          } as never,
        ],
        threads: [],
        deletedThreadIds: [],
        snapshotSequence: 1,
        updatedAt: "2026-11-28T00:00:00.000Z",
      }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-11-28T00:00:00.000Z",
          models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false }],
          slashCommands: [],
          skills: [],
        } as never,
      ]),
    }),
    McpToolAccessTestkit.liveThreadsLayer,
  );

  const toolkit = yield* FlowToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(FlowHandlers.layer).pipe(Layer.provide(layerDependencies)),
    ),
  );

  const call = <Name extends keyof typeof FlowToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope = invocationScope(),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => {
        const last = chunk.at(-1)!;
        return {
          isFailure: last.isFailure,
          result: last.result as Tool.Success<(typeof FlowToolkit.tools)[Name]>,
        };
      }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layerDependencies),
    );

  return { filesRef, call };
});

describe("flow toolkit handlers", () => {
  it("keeps t3_flow_* visible in normal chat threads", () => {
    for (const tool of Object.values(FlowToolkit.tools)) {
      const enabledWhen = Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
      expect(enabledWhen).toBeUndefined();
    }
  });

  it.effect(
    "t3_flow_list returns flows, projects, and providers; t3_flow_read returns dry-run report",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const listed = yield* harness.call("t3_flow_list", {});
        expect(listed.isFailure).toBe(false);
        expect(listed.result.flows).toHaveLength(1);
        expect(listed.result.flows[0]?.name).toBe("bugfix-flow");
        expect(listed.result.projects[0]?.id).toBe("project-1");
        expect(listed.result.providers[0]?.instanceId).toBe("codex");

        const read = yield* harness.call("t3_flow_read", { name: "bugfix-flow" });
        expect(read.isFailure).toBe(false);
        expect(read.result.fileName).toBe("bugfix.flow.json");
        expect(read.result.validation?.valid).toBe(true);
        expect(read.result.dryRun?.layers).toHaveLength(2);
      }),
  );

  it.effect(
    "t3_flow_validate catches JSON syntax errors and validation errors without disk writes",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const broken = yield* harness.call("t3_flow_validate", {
          source: '{\n  "schemaVersion": 1,\n  bad\n}',
        });
        expect(broken.isFailure).toBe(false);
        expect(broken.result.valid).toBe(false);
        expect(broken.result.parseError).toContain("JSON");

        const invalidDag: FlowSpec = {
          ...VALID_FLOW,
          edges: [
            { id: "e1", from: "trigger", to: "fix" },
            { id: "e2", from: "fix", to: "fix" },
          ],
        };
        const cyclic = yield* harness.call("t3_flow_validate", {
          source: JSON.stringify(invalidDag),
        });
        expect(cyclic.isFailure).toBe(false);
        expect(cyclic.result.valid).toBe(false);
        expect(cyclic.result.issues.some((i) => i.code === "dag_cycle_detected")).toBe(true);
      }),
  );

  it.effect("t3_flow_save enforces writesOwnerWork and supports createNewVersion", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      // External non-owner client must be rejected from writing .flow.json files.
      const denied = yield* harness.call(
        "t3_flow_save",
        {
          fileName: "bugfix.flow.json",
          source: JSON.stringify(VALID_FLOW),
        },
        invocationScope({
          clientSessionId: "outside-session",
          capabilities: ["orchestration"],
        }),
      );
      expect(denied.isFailure).toBe(true);

      // Owner chat thread can save vN+1 into <base>.v<N+1>.flow.json.
      const saved = yield* harness.call("t3_flow_save", {
        fileName: "bugfix.flow.json",
        source: JSON.stringify(VALID_FLOW),
        createNewVersion: true,
      });
      expect(saved.isFailure).toBe(false);
      expect(saved.result.savedFileName).toBe("bugfix.v2.flow.json");
      expect(saved.result.version).toBe(2);

      const files = yield* Ref.get(harness.filesRef);
      expect(files.some((f) => f.name === "bugfix.v2.flow.json")).toBe(true);
    }),
  );
});
