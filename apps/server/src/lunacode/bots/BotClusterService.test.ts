import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  BotHandle,
  BotId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BotClusterService } from "./BotClusterService.ts";

function makeTestHarness() {
  const launchedCalls: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const sentCalls: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  const existingShells = new Map<string, { deletedAt: string | null }>();
  const projectId = ProjectId.make("project-1");

  const makeLayer = (baseDir: string) => {
    const mocks = Layer.mergeAll(
      ServerConfig.layerTest(baseDir, baseDir),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({
                  id: projectId,
                  title: "Main Repo",
                  workspaceRoot: baseDir,
                  defaultModelSelection: null,
                  scripts: [],
                  repositoryIdentity: null,
                  createdAt: "2026-11-28T00:00:00.000Z",
                  updatedAt: "2026-11-28T00:00:00.000Z",
                } as never)
              : Option.none(),
          ),
        snapshot: Effect.succeed({
          projects: [
            {
              id: projectId,
              title: "Main Repo",
              workspaceRoot: baseDir,
              defaultModelSelection: null,
              scripts: [],
              repositoryIdentity: null,
              createdAt: "2026-11-28T00:00:00.000Z",
              updatedAt: "2026-11-28T00:00:00.000Z",
            },
          ],
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
          launchedCalls.push(input);
          const threadId = ThreadId.make(`thread-${launchedCalls.length}`);
          existingShells.set(threadId, { deletedAt: null });
          return Effect.succeed({
            threadId,
            resumed: false,
            projection: {
              thread: { id: threadId },
              runs: [],
              messages: [],
            } as never,
          });
        },
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => {
          const found = existingShells.get(threadId);
          return Effect.succeed(
            found ? ({ id: threadId, deletedAt: found.deletedAt } as never) : null,
          );
        },
        sendToThread: (input) => {
          sentCalls.push(input);
          return Effect.succeed({ run: { id: "run-1" } } as never);
        },
      }),
    );

    const deps = mocks.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    return BotClusterService.layer.pipe(Layer.provideMerge(deps));
  };

  return { makeLayer, launchedCalls, sentCalls, existingShells, projectId };
}

it.effect(
  "seeds presets idempotently, ensures zero-token Home Chat, dispatches workers, and answers tasks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "lunacode-bots-svc-" });
      const harness = makeTestHarness();
      const serviceLayer = harness.makeLayer(tempDir);

      yield* Effect.gen(function* () {
        const bots = yield* BotClusterService;

        const seeded1 = yield* bots.seedPresets({ projectId: harness.projectId });
        expect(seeded1.createdCount).toBe(4);
        const seeded2 = yield* bots.seedPresets({ projectId: harness.projectId });
        expect(seeded2.createdCount).toBe(0);

        // Opening Home Chat creates thread WITHOUT sending any initialMessage (zero tokens spent).
        const scoutId = BotId.make("bot-scout");
        const home1 = yield* bots.ensureHomeThread({ botId: scoutId });
        expect(harness.launchedCalls).toHaveLength(1);
        expect(harness.launchedCalls[0]?.initialMessage).toBeUndefined();
        expect(harness.launchedCalls[0]?.workspaceStrategy).toEqual({ type: "root" });

        // Calling ensureHomeThread again reuses the live Home Chat thread.
        const home2 = yield* bots.ensureHomeThread({ botId: scoutId });
        expect(home2.threadId).toBe(home1.threadId);
        expect(harness.launchedCalls).toHaveLength(1);

        // Dispatching a worker launches a thread and creates Task #1.
        const dispatched = yield* bots.dispatchWorker({
          botId: scoutId,
          title: "Investigate Safari tap bug",
          prompt: "Reproduce click failure on Safari 18.",
        });
        expect(dispatched.task.number).toBe(1);
        expect(dispatched.task.status).toBe("in_progress");
        expect(dispatched.task.workerThreadIds).toEqual([dispatched.threadId]);
        expect(harness.launchedCalls[1]?.initialMessage?.text).toContain("Scout (@scout)");

        // Asking a question flips status to needs_you, and answering clears it + notifies Home Chat.
        const asked = yield* bots.upsertTask({
          id: dispatched.task.id,
          botId: scoutId,
          title: dispatched.task.title,
          pendingQuestion: {
            prompt: "Ship behind feature flag?",
            choices: ["Behind flag", "Ship globally"],
            askedAt: "2026-11-28T00:00:00.000Z",
          },
        });
        expect(asked.status).toBe("needs_you");

        const answered = yield* bots.answerTaskQuestion({
          taskId: asked.id,
          choice: "Behind flag",
          reason: "Safari only first",
        });
        expect(answered.status).toBe("in_progress");
        expect(answered.pendingQuestion).toBeNull();
        expect(harness.sentCalls.at(-1)?.text).toContain("Behind flag: Safari only first");

        // Stream emits initial snapshot.
        const firstBatch = yield* bots.subscribe().pipe(Stream.take(1), Stream.runCollect);
        expect(firstBatch[0]?.bots).toHaveLength(4);
      }).pipe(Effect.provide(serviceLayer));

      // Reload against the same tempDir and verify persistence survived cleanly.
      const reloadedStateDir = path.join(tempDir, "userdata");
      expect(yield* fs.exists(path.join(reloadedStateDir, "lunacode-bots", "bots.json"))).toBe(
        true,
      );
      expect(yield* fs.exists(path.join(reloadedStateDir, "lunacode-bots", "tasks.json"))).toBe(
        true,
      );

      const harness2 = makeTestHarness();
      yield* Effect.gen(function* () {
        const bots = yield* BotClusterService;
        const snap = yield* bots.snapshot();
        expect(snap.bots).toHaveLength(4);
        expect(snap.tasks).toHaveLength(1);
        expect(snap.tasks[0]?.title).toBe("Investigate Safari tap bug");

        // Custom upsert & delete checks.
        const custom = yield* bots.upsertBot({
          name: "Release Manager",
          handle: BotHandle.make("release-mgr"),
          role: "Publish notes",
        });
        expect(custom.handle).toBe("release-mgr");
        const removed = yield* bots.deleteBot({ botId: custom.id });
        expect(removed.deleted).toBe(true);
      }).pipe(Effect.provide(harness2.makeLayer(tempDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
