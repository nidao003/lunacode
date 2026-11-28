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
  "auto-seeds 6 presets, supports idempotent re-seed, ensures zero-token Home Chat, injects role once, dispatches workers, and answers tasks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "lunacode-bots-svc-" });
      const harness = makeTestHarness();
      const serviceLayer = harness.makeLayer(tempDir);

      yield* Effect.gen(function* () {
        const bots = yield* BotClusterService;

        // Fresh cluster auto-seeds 6 curated realistic-persona Bots on boot.
        const initialSnap = yield* bots.snapshot();
        expect(initialSnap.bots).toHaveLength(6);
        expect(initialSnap.bots[0]?.name).toContain("苏探");

        // seedPresets is idempotent when all 6 presets exist.
        const seeded1 = yield* bots.seedPresets({ projectId: harness.projectId });
        expect(seeded1.createdCount).toBe(0);

        // Removing a default bot lets seedPresets restore the missing team member.
        yield* bots.deleteBot({ botId: BotId.make("bot-standup") });
        const restored = yield* bots.seedPresets({ projectId: harness.projectId });
        expect(restored.createdCount).toBe(1);

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

        // On another bot with no Home Chat yet, first sendMessage injects [Bot 角色档案 ...] once only.
        const docsId = BotId.make("bot-docs-helper");
        yield* bots.sendMessage({ botId: docsId, message: "检查文档漂移" });
        expect(harness.sentCalls.at(-1)?.text).toContain("[Bot 角色档案");
        expect(harness.sentCalls.at(-1)?.text).toContain("检查文档漂移");
        yield* bots.sendMessage({ botId: docsId, message: "继续第二条对话" });
        expect(harness.sentCalls.at(-1)?.text).toBe("继续第二条对话");

        // Dispatching a worker launches a thread and creates Task #1.
        const dispatched = yield* bots.dispatchWorker({
          botId: scoutId,
          title: "Investigate Safari tap bug",
          prompt: "Reproduce click failure on Safari 18.",
        });
        expect(dispatched.task.number).toBe(1);
        expect(dispatched.task.status).toBe("in_progress");
        expect(dispatched.task.workerThreadIds).toEqual([dispatched.threadId]);
        expect(harness.launchedCalls[2]?.initialMessage?.text).toContain("@scout");

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
        expect(firstBatch[0]?.bots).toHaveLength(6);
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
        expect(snap.bots).toHaveLength(6);
        expect(snap.tasks).toHaveLength(1);
        expect(snap.tasks[0]?.title).toBe("Investigate Safari tap bug");

        // Custom upsert & delete checks.
        const custom = yield* bots.upsertBot({
          name: "Custom Auditor",
          handle: BotHandle.make("custom-auditor"),
          role: "Security audit",
        });
        expect(custom.handle).toBe("custom-auditor");
        const removed = yield* bots.deleteBot({ botId: custom.id });
        expect(removed.deleted).toBe(true);
      }).pipe(Effect.provide(harness2.makeLayer(tempDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "migrates legacy v1 untouched preset bots to v2 while preserving customized bots and empty lists",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "lunacode-bots-mig-" });
      const botsDir = path.join(tempDir, "userdata", "lunacode-bots");
      yield* fs.makeDirectory(botsDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(botsDir, "bots.json"),
        JSON.stringify(
          {
            version: 1,
            bots: [
              {
                id: "bot-scout",
                name: "Scout",
                handle: "scout",
                role: "Old role",
                avatar: "scout",
                accent: "info",
                systemPrompt: "你是团队主控 Bot Scout。旧版职责",
                defaultProjectId: null,
                providerInstanceId: null,
                model: null,
                runtimeMode: "full-access",
                interactionMode: "default",
                workspaceStrategy: "root",
                homeThreadId: null,
                linkedWorkflowNames: [],
                linkedScheduledTaskIds: [],
                createdAt: "2026-11-28T00:00:00.000Z",
                updatedAt: "2026-11-28T00:00:00.000Z",
              },
              {
                id: "bot-review-buddy",
                name: "我的专属评审官",
                handle: "review-buddy",
                role: "Custom Review",
                avatar: "reviewer",
                accent: "success",
                systemPrompt: "用户的自定义评审规范，不要覆盖",
                defaultProjectId: null,
                providerInstanceId: null,
                model: null,
                runtimeMode: "approval-required",
                interactionMode: "plan",
                workspaceStrategy: "root",
                homeThreadId: null,
                linkedWorkflowNames: ["my-custom-flow"],
                linkedScheduledTaskIds: [],
                createdAt: "2026-11-28T00:00:00.000Z",
                updatedAt: "2026-11-28T00:00:00.000Z",
              },
            ],
          },
          null,
          2,
        ),
      );

      const harness = makeTestHarness();
      yield* Effect.gen(function* () {
        const bots = yield* BotClusterService;
        const snap = yield* bots.snapshot();
        expect(snap.bots).toHaveLength(6);
        const scout = snap.bots.find((b) => b.id === "bot-scout")!;
        expect(scout.name).toBe("苏探 · Scout");
        expect(scout.workspaceStrategy).toBe("worktree");
        expect(scout.linkedWorkflowNames).toContain("bug-repro-fix");

        const customReview = snap.bots.find((b) => b.id === "bot-review-buddy")!;
        expect(customReview.name).toBe("我的专属评审官");
        expect(customReview.systemPrompt).toBe("用户的自定义评审规范，不要覆盖");
        expect(customReview.linkedWorkflowNames).toEqual(["my-custom-flow"]);
      }).pipe(Effect.provide(harness.makeLayer(tempDir)));

      // Intentionally empty v1 list must remain empty on migration.
      const emptyDir = yield* fs.makeTempDirectoryScoped({ prefix: "lunacode-bots-empty-" });
      const emptyBotsDir = path.join(emptyDir, "userdata", "lunacode-bots");
      yield* fs.makeDirectory(emptyBotsDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(emptyBotsDir, "bots.json"),
        JSON.stringify({ version: 1, bots: [] }),
      );
      const emptyHarness = makeTestHarness();
      yield* Effect.gen(function* () {
        const bots = yield* BotClusterService;
        const snap = yield* bots.snapshot();
        expect(snap.bots).toHaveLength(0);
      }).pipe(Effect.provide(emptyHarness.makeLayer(emptyDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
