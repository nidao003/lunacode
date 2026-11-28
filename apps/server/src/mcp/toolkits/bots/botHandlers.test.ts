import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { type Tool } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as BotClusterService from "../../../lunacode/bots/BotClusterService.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as BotHandlers from "./botHandlers.ts";
import { BotToolkit } from "./botTools.ts";

function invocationScope(options?: {
  readonly readOnlyClient?: boolean;
}): McpInvocationContext.McpInvocationScope {
  return {
    environmentId: EnvironmentId.make("env-1"),
    requestNamespace: "session-1",
    thread: options?.readOnlyClient
      ? undefined
      : {
          threadId: ThreadId.make("thread-caller"),
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
    client: options?.readOnlyClient
      ? {
          sessionId: "client-ro",
          label: "Read-only client",
          access: "read-only" as const,
          linked: false,
        }
      : undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
}

describe("Bot MCP toolkit", () => {
  it.effect("lists, upserts tasks, dispatches workers, and gates writes cleanly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "lunacode-bot-mcp-" });
      const projectId = ProjectId.make("proj-1");
      const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];

      // Single combined ThreadManagementService mock including getThreadShell + sendToThread.
      const cleanDeps = Layer.mergeAll(
        ServerConfig.layerTest(tempDir, tempDir),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedNone,
          snapshot: Effect.succeed({
            projects: [{ id: projectId, title: "Repo", workspaceRoot: tempDir } as never],
            snapshotSequence: 1,
          } as never),
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
              models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true }],
              slashCommands: [],
              skills: [],
            } as never,
          ]),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          isNonGitProject: () => Effect.succeed(true),
          launch: (input) => {
            launched.push(input);
            return Effect.succeed({
              threadId: ThreadId.make(`thread-${launched.length}`),
              resumed: false,
              projection: { thread: {}, runs: [], messages: [] } as never,
            });
          },
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id) as never),
          sendToThread: () => Effect.succeed({ run: { id: "run-1" } } as never),
        }),
      ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      const botLayer = BotClusterService.BotClusterService.layer.pipe(
        Layer.provideMerge(cleanDeps),
      );
      const fullLayer = Layer.mergeAll(
        botLayer,
        McpToolAccess.HandlersLayer.layer(BotHandlers.layer).pipe(Layer.provideMerge(botLayer)),
      );

      yield* Effect.gen(function* () {
        const botCluster = yield* BotClusterService.BotClusterService;
        yield* botCluster.seedPresets({ projectId });

        const toolkit = yield* BotToolkit;
        const call = <Name extends keyof typeof BotToolkit.tools>(
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
                result: last.result as Tool.Success<(typeof BotToolkit.tools)[Name]>,
              };
            }),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          );

        const listed = yield* call("t3_bots_list", { bot: "@scout" });
        expect(listed.isFailure).toBe(false);
        expect(listed.result.bots[0]?.handle).toBe("scout");

        const upserted = yield* call("t3_bot_task_upsert", {
          bot: "@scout",
          title: "Fix Safari click",
          doneMeans: "Tap pays cleanly",
          questionPrompt: "Ship behind flag?",
        });
        expect(upserted.isFailure).toBe(false);
        expect(upserted.result.task.status).toBe("needs_you");

        const dispatched = yield* call("t3_bot_dispatch", {
          targetBot: "@review-buddy",
          mode: "worker",
          title: "Audit Safari PR",
          prompt: "Review Safari tap fix PR.",
        });
        expect(dispatched.isFailure).toBe(false);
        expect(dispatched.result.taskNumber).toBe(2);

        // Read-only external client cannot mutate Bot tasks.
        const blocked = yield* call(
          "t3_bot_task_upsert",
          { bot: "@scout", title: "Blocked edit" },
          invocationScope({ readOnlyClient: true }),
        );
        expect(blocked.isFailure).toBe(true);
        expect((blocked.result as { code?: string }).code).toBe("capability_denied");
        expect((blocked.result as { message?: string }).message).toContain("read-only");
      }).pipe(Effect.provide(fullLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
