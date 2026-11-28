import {
  BotClusterRequestError,
  type BotClusterSnapshot,
  type BotDeleteInput,
  type BotDeleteResult,
  type BotDispatchWorkerInput,
  type BotDispatchWorkerResult,
  type BotEnsureHomeThreadInput,
  type BotEnsureHomeThreadResult,
  BotHandle,
  BotId,
  type BotSendMessageInput,
  type BotSendMessageResult,
  type BotsSeedPresetsInput,
  type BotsSeedPresetsResult,
  BotTask as BotTaskSchema,
  type BotTask,
  type BotTaskActivityEntry,
  type BotTaskActivityKind,
  type BotTaskAnswerInput,
  type BotTaskCommentInput,
  type BotTaskDeleteInput,
  BotTaskId,
  type BotTaskStatus,
  type BotTaskUpsertInput,
  type BotUpsertInput,
  CommandId,
  MessageId,
  type ModelSelection,
  PersistentBot,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";

const BOTS_DIR_NAME = "lunacode-bots";
const BOTS_FILE_NAME = "bots.json";
const TASKS_FILE_NAME = "tasks.json";

const PersistedBotsFile = Schema.Struct({
  version: Schema.Literal(1),
  bots: Schema.Array(PersistentBot),
});
type PersistedBotsFile = typeof PersistedBotsFile.Type;

const PersistedTasksStrictFile = Schema.Struct({
  version: Schema.Literal(1),
  nextNumber: Schema.Int,
  tasks: Schema.Array(BotTaskSchema),
});
type PersistedTasksStrictFile = typeof PersistedTasksStrictFile.Type;

const decodeBotsFileExit = Schema.decodeUnknownExit(Schema.fromJsonString(PersistedBotsFile));
const encodeBotsFileJson = (value: PersistedBotsFile) => `${JSON.stringify(value, null, 2)}\n`;
const decodeTasksFileExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(PersistedTasksStrictFile),
);
const encodeTasksFileJson = (value: PersistedTasksStrictFile) =>
  `${JSON.stringify(value, null, 2)}\n`;

interface ClusterStoreState {
  readonly bots: ReadonlyArray<PersistentBot>;
  readonly tasks: ReadonlyArray<BotTask>;
  readonly nextNumber: number;
  readonly updatedAt: string;
}

const PRESET_BOTS: ReadonlyArray<
  Omit<
    PersistentBot,
    "defaultProjectId" | "providerInstanceId" | "model" | "homeThreadId" | "createdAt" | "updatedAt"
  >
> = [
  {
    id: BotId.make("bot-scout"),
    name: "Scout",
    handle: BotHandle.make("scout"),
    role: "Bug 猎手 & 功能并行主控",
    avatar: "scout",
    accent: "info",
    systemPrompt:
      "你是团队主控 Bot Scout。收到需求后先拆解边界：复杂实现与复现测试拆给隔离 Worktree Worker，并在完成后同步 Task 状态或汇报关键风险。",
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: "worktree",
    linkedWorkflowNames: [],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-review-buddy"),
    name: "Review Buddy",
    handle: BotHandle.make("review-buddy"),
    role: "代码评审 & 回归守门",
    avatar: "reviewer",
    accent: "success",
    systemPrompt:
      "你是严谨的代码评审 Bot Review Buddy。重点核查回归风险、类型安全、边界条件及测试覆盖率，有问题直接标出文件与行号。",
    runtimeMode: "approval-required",
    interactionMode: "plan",
    workspaceStrategy: "root",
    linkedWorkflowNames: [],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-ci-watch"),
    name: "CI Watch",
    handle: BotHandle.make("ci-watch"),
    role: "构建 / 失败定位监控",
    avatar: "sentinel",
    accent: "warning",
    systemPrompt:
      "你是稳定性监控 Bot CI Watch。定位测试、Lint 或构建失败的根本原因，并向对应负责人总结最小修复步骤。",
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: "root",
    linkedWorkflowNames: [],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-docs-helper"),
    name: "Docs Helper",
    handle: BotHandle.make("docs-helper"),
    role: "文档、变更总结 & PR 说明",
    avatar: "scribe",
    accent: "primary",
    systemPrompt:
      "你是文档与交付说明 Bot Docs Helper。负责把代码改动整理为清晰准确的中文变更摘要、操作文档与发布说明。",
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: "root",
    linkedWorkflowNames: [],
    linkedScheduledTaskIds: [],
  },
];

function dedupeStrings<T extends string>(items: ReadonlyArray<T>): Array<T> {
  return [...new Set(items)];
}

function toSnapshot(state: ClusterStoreState): BotClusterSnapshot {
  return {
    bots: state.bots,
    tasks: state.tasks,
    updatedAt: state.updatedAt,
  };
}

const isBotClusterRequestError = Schema.is(BotClusterRequestError);

function formatBotError(cause: unknown, fallback: string): BotClusterRequestError {
  if (isBotClusterRequestError(cause)) return cause;
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new BotClusterRequestError({ message: msg || fallback });
}

export class BotClusterService extends Context.Service<
  BotClusterService,
  {
    readonly snapshot: () => Effect.Effect<BotClusterSnapshot>;
    readonly subscribe: () => Stream.Stream<BotClusterSnapshot>;
    readonly upsertBot: (
      input: BotUpsertInput,
    ) => Effect.Effect<PersistentBot, BotClusterRequestError>;
    readonly deleteBot: (
      input: BotDeleteInput,
    ) => Effect.Effect<BotDeleteResult, BotClusterRequestError>;
    readonly ensureHomeThread: (
      input: BotEnsureHomeThreadInput,
    ) => Effect.Effect<BotEnsureHomeThreadResult, BotClusterRequestError>;
    readonly dispatchWorker: (
      input: BotDispatchWorkerInput,
    ) => Effect.Effect<BotDispatchWorkerResult, BotClusterRequestError>;
    readonly sendMessage: (
      input: BotSendMessageInput,
    ) => Effect.Effect<BotSendMessageResult, BotClusterRequestError>;
    readonly seedPresets: (
      input: BotsSeedPresetsInput,
    ) => Effect.Effect<BotsSeedPresetsResult, BotClusterRequestError>;
    readonly upsertTask: (
      input: BotTaskUpsertInput,
    ) => Effect.Effect<BotTask, BotClusterRequestError>;
    readonly addTaskComment: (
      input: BotTaskCommentInput,
    ) => Effect.Effect<BotTask, BotClusterRequestError>;
    readonly answerTaskQuestion: (
      input: BotTaskAnswerInput,
    ) => Effect.Effect<BotTask, BotClusterRequestError>;
    readonly deleteTask: (
      input: BotTaskDeleteInput,
    ) => Effect.Effect<BotDeleteResult, BotClusterRequestError>;
  }
>()("t3/lunacode/bots/BotClusterService") {
  static readonly layer = Layer.effect(
    BotClusterService,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const projectService = yield* ProjectService.ProjectService;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;

      const storeDir = path.join(config.stateDir, BOTS_DIR_NAME);
      const botsFilePath = path.join(storeDir, BOTS_FILE_NAME);
      const tasksFilePath = path.join(storeDir, TASKS_FILE_NAME);
      const writeSemaphore = yield* Semaphore.make(1);
      const changesPubSub = yield* PubSub.sliding<BotClusterSnapshot>(64);

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      const nextUuid = () => random.uuidV4();

      const writeFileAtomic = Effect.fn("BotClusterService.writeFileAtomic")(function* (
        targetPath: string,
        contents: string,
      ) {
        yield* fs.makeDirectory(storeDir, { recursive: true });
        const token = yield* nextUuid();
        const tempPath = `${targetPath}.tmp-${token}`;
        yield* fs.writeFileString(tempPath, contents);
        yield* fs.rename(tempPath, targetPath);
      });

      const readStoredBots = fs.readFileString(botsFilePath).pipe(
        Effect.flatMap((raw) => {
          const decoded = decodeBotsFileExit(raw);
          if (decoded._tag === "Success") return Effect.succeed(decoded.value.bots);
          return Effect.logWarning("Ignoring invalid lunacode bots.json", {
            path: botsFilePath,
            cause: Cause.pretty(decoded.cause),
          }).pipe(Effect.as<ReadonlyArray<PersistentBot>>([]));
        }),
        Effect.orElseSucceed((): ReadonlyArray<PersistentBot> => []),
      );

      const readStoredTasks = fs.readFileString(tasksFilePath).pipe(
        Effect.flatMap((raw) => {
          const decoded = decodeTasksFileExit(raw);
          if (decoded._tag === "Success") {
            return Effect.succeed({
              nextNumber: Math.max(1, decoded.value.nextNumber),
              tasks: decoded.value.tasks,
            });
          }
          return Effect.logWarning("Ignoring invalid lunacode tasks.json", {
            path: tasksFilePath,
            cause: Cause.pretty(decoded.cause),
          }).pipe(Effect.as({ nextNumber: 1, tasks: [] as ReadonlyArray<BotTask> }));
        }),
        Effect.orElseSucceed(() => ({ nextNumber: 1, tasks: [] as ReadonlyArray<BotTask> })),
      );

      const initialBots = yield* readStoredBots;
      const initialTasksData = yield* readStoredTasks;
      const initialTimestamp = yield* nowIso;

      const stateRef = yield* Ref.make<ClusterStoreState>({
        bots: initialBots,
        tasks: initialTasksData.tasks,
        nextNumber: initialTasksData.nextNumber,
        updatedAt: initialTimestamp,
      });

      const persistAndPublish = Effect.fn("BotClusterService.persistAndPublish")(function* (
        next: ClusterStoreState,
        opts: { readonly writeBots?: boolean; readonly writeTasks?: boolean },
      ) {
        if (opts.writeBots) {
          yield* writeFileAtomic(botsFilePath, encodeBotsFileJson({ version: 1, bots: next.bots }));
        }
        if (opts.writeTasks) {
          yield* writeFileAtomic(
            tasksFilePath,
            encodeTasksFileJson({
              version: 1,
              nextNumber: next.nextNumber,
              tasks: next.tasks,
            }),
          );
        }
        yield* Ref.set(stateRef, next);
        yield* PubSub.publish(changesPubSub, toSnapshot(next));
      });

      const resolveTargetProjectId = Effect.fn("BotClusterService.resolveTargetProjectId")(
        function* (preferredProjectId: ProjectId | null | undefined) {
          if (preferredProjectId != null) {
            const found = yield* projectService
              .getById(preferredProjectId)
              .pipe(Effect.orElseSucceed(() => Option.none()));
            if (Option.isSome(found)) return found.value.id;
          }
          const snap = yield* projectService.snapshot.pipe(
            Effect.mapError((cause) => formatBotError(cause, "读取工作区项目列表失败。")),
          );
          const first = snap.projects[0];
          if (!first) {
            return yield* new BotClusterRequestError({
              message: "当前环境暂无可用项目，请先在工作区中添加至少一个项目再启动 Bot。",
            });
          }
          return first.id;
        },
      );

      const resolveBotModelSelection = Effect.fn("BotClusterService.resolveBotModelSelection")(
        function* (
          bot: PersistentBot,
          projectId: ProjectId,
        ): Effect.fn.Return<ModelSelection, BotClusterRequestError> {
          const providers = yield* providerRegistry.getProviders;
          if (bot.providerInstanceId !== null && bot.model !== null) {
            return {
              instanceId: bot.providerInstanceId,
              model: bot.model,
            };
          }
          if (bot.providerInstanceId !== null) {
            const matched = providers.find(
              (provider) => provider.instanceId === bot.providerInstanceId && provider.enabled,
            );
            const matchedModel = matched?.models.find((m) => m.isDefault) ?? matched?.models[0];
            if (matched && matchedModel) {
              return {
                instanceId: matched.instanceId,
                model: matchedModel.slug,
              };
            }
          }
          const [allSettings, projectOption] = yield* Effect.all([
            serverSettings.getSettings.pipe(
              Effect.mapError((cause) => formatBotError(cause, "读取服务设置失败。")),
            ),
            projectService.getById(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
          ]);
          const projSettings = resolveProjectSettings(
            allSettings,
            projectId,
            Option.getOrUndefined(projectOption),
          ).settings;
          const nowMs = yield* Clock.currentTimeMillis;
          const resolved = resolveNewThreadModelSelection({
            defaultSelection: projSettings.defaultModelSelection,
            fallbackSelection: projSettings.fallbackModelSelection,
            providers,
            settings: allSettings,
            projectId,
            now: nowMs,
          }).selection;
          if (resolved !== null) return resolved;

          const firstReady =
            providers.find((p) => p.enabled && p.status === "ready" && p.models.length > 0) ??
            providers.find((p) => p.enabled && p.models.length > 0);
          const firstModel = firstReady?.models.find((m) => m.isDefault) ?? firstReady?.models[0];
          if (firstReady && firstModel) {
            return {
              instanceId: firstReady.instanceId,
              model: firstModel.slug,
            };
          }
          return yield* new BotClusterRequestError({
            message: "暂无已启用的可用模型 Provider，请先在 Settings → Providers 中完成配置。",
          });
        },
      );

      const ensureHomeThreadUnlocked = Effect.fn("BotClusterService.ensureHomeThreadUnlocked")(
        function* (
          botId: BotId,
          preferredProjectId?: ProjectId,
        ): Effect.fn.Return<BotEnsureHomeThreadResult, BotClusterRequestError> {
          const current = yield* Ref.get(stateRef);
          const existingBot = current.bots.find((b) => b.id === botId);
          if (!existingBot) {
            return yield* new BotClusterRequestError({ message: `Bot "${botId}" 不存在。` });
          }
          if (existingBot.homeThreadId !== null) {
            const shell = yield* threadManagement
              .getThreadShell(existingBot.homeThreadId)
              .pipe(Effect.orElseSucceed(() => null));
            if (shell !== null && shell.deletedAt === null) {
              return { bot: existingBot, threadId: existingBot.homeThreadId };
            }
          }

          const projectId = yield* resolveTargetProjectId(
            preferredProjectId ?? existingBot.defaultProjectId,
          );
          const modelSelection = yield* resolveBotModelSelection(existingBot, projectId);
          const uuid = yield* nextUuid();
          // Launch Home Chat with NO initialMessage so opening the chat consumes zero tokens.
          const launched = yield* threadLaunch
            .launch({
              commandId: CommandId.make(`bot-home:${existingBot.id}:${uuid}`),
              projectId,
              title: `${existingBot.name} · Home Chat`,
              titleRenamed: true,
              modelSelection,
              runtimeMode: existingBot.runtimeMode,
              interactionMode: existingBot.interactionMode,
              workspaceStrategy: { type: "root" },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.mapError((cause) => formatBotError(cause, "创建 Bot Home Chat 失败。")));

          const updatedAt = yield* nowIso;
          const updatedBot: PersistentBot = {
            ...existingBot,
            homeThreadId: launched.threadId,
            ...(existingBot.defaultProjectId === null ? { defaultProjectId: projectId } : {}),
            updatedAt,
          };
          const latest = yield* Ref.get(stateRef);
          const nextState: ClusterStoreState = {
            ...latest,
            bots: latest.bots.map((b) => (b.id === updatedBot.id ? updatedBot : b)),
            updatedAt,
          };
          yield* persistAndPublish(nextState, { writeBots: true }).pipe(
            Effect.mapError((cause) => formatBotError(cause, "保存 Bot 状态失败。")),
          );
          return { bot: updatedBot, threadId: launched.threadId };
        },
      );

      const snapshot = () => Ref.get(stateRef).pipe(Effect.map(toSnapshot));

      const subscribe = (): Stream.Stream<BotClusterSnapshot> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changesPubSub);
            return Stream.concat(
              Stream.fromEffect(snapshot()),
              Stream.fromSubscription(subscription),
            );
          }),
        );

      const upsertBot = (
        input: BotUpsertInput,
      ): Effect.Effect<PersistentBot, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const updatedAt = yield* nowIso;
            const handleLower = input.handle.toLowerCase();
            const existing =
              input.id !== undefined ? current.bots.find((b) => b.id === input.id) : undefined;
            const handleConflict = current.bots.find(
              (b) => b.handle.toLowerCase() === handleLower && b.id !== existing?.id,
            );
            if (handleConflict) {
              return yield* new BotClusterRequestError({
                message: `Handle "@${input.handle}" 已被 Bot "${handleConflict.name}" 使用。`,
              });
            }

            const botId = existing?.id ?? input.id ?? BotId.make(`bot-${yield* nextUuid()}`);
            const nextBot: PersistentBot = {
              id: botId,
              name: input.name,
              handle: BotHandle.make(handleLower),
              role: input.role,
              avatar: input.avatar ?? existing?.avatar ?? "scout",
              accent: input.accent ?? existing?.accent ?? "info",
              systemPrompt: input.systemPrompt ?? existing?.systemPrompt ?? "",
              defaultProjectId:
                input.defaultProjectId !== undefined
                  ? input.defaultProjectId
                  : (existing?.defaultProjectId ?? null),
              providerInstanceId:
                input.providerInstanceId !== undefined
                  ? input.providerInstanceId
                  : (existing?.providerInstanceId ?? null),
              model: input.model !== undefined ? input.model : (existing?.model ?? null),
              runtimeMode: input.runtimeMode ?? existing?.runtimeMode ?? "approval-required",
              interactionMode: input.interactionMode ?? existing?.interactionMode ?? "default",
              workspaceStrategy:
                input.workspaceStrategy ?? existing?.workspaceStrategy ?? "worktree",
              homeThreadId: existing?.homeThreadId ?? null,
              linkedWorkflowNames: dedupeStrings(
                input.linkedWorkflowNames ?? existing?.linkedWorkflowNames ?? [],
              ),
              linkedScheduledTaskIds: dedupeStrings(
                input.linkedScheduledTaskIds ?? existing?.linkedScheduledTaskIds ?? [],
              ),
              ...(input.archived !== undefined
                ? { archived: input.archived }
                : existing?.archived !== undefined
                  ? { archived: existing.archived }
                  : {}),
              createdAt: existing?.createdAt ?? updatedAt,
              updatedAt,
            };

            const nextBots = existing
              ? current.bots.map((b) => (b.id === nextBot.id ? nextBot : b))
              : [...current.bots, nextBot];

            yield* persistAndPublish(
              { ...current, bots: nextBots, updatedAt },
              { writeBots: true },
            ).pipe(Effect.mapError((cause) => formatBotError(cause, "保存 Bot 配置失败。")));
            return nextBot;
          }),
        );

      const deleteBot = (
        input: BotDeleteInput,
      ): Effect.Effect<BotDeleteResult, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const existed = current.bots.some((b) => b.id === input.botId);
            if (!existed) return { deleted: false };
            const updatedAt = yield* nowIso;
            const nextBots = current.bots.filter((b) => b.id !== input.botId);
            const nextTasks = current.tasks.filter((t) => t.botId !== input.botId);
            yield* persistAndPublish(
              { ...current, bots: nextBots, tasks: nextTasks, updatedAt },
              { writeBots: true, writeTasks: nextTasks.length !== current.tasks.length },
            ).pipe(Effect.mapError((cause) => formatBotError(cause, "删除 Bot 失败。")));
            return { deleted: true };
          }),
        );

      const ensureHomeThread = (
        input: BotEnsureHomeThreadInput,
      ): Effect.Effect<BotEnsureHomeThreadResult, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(ensureHomeThreadUnlocked(input.botId, input.projectId));

      const dispatchWorker = (
        input: BotDispatchWorkerInput,
      ): Effect.Effect<BotDispatchWorkerResult, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const bot = current.bots.find((b) => b.id === input.botId);
            if (!bot) {
              return yield* new BotClusterRequestError({
                message: `Bot "${input.botId}" 不存在。`,
              });
            }
            const existingTask =
              input.taskId !== undefined
                ? current.tasks.find((t) => t.id === input.taskId)
                : undefined;
            if (input.taskId !== undefined && !existingTask) {
              return yield* new BotClusterRequestError({
                message: `Task "${input.taskId}" 不存在。`,
              });
            }

            const projectId = yield* resolveTargetProjectId(
              input.projectId ?? existingTask?.projectId ?? bot.defaultProjectId,
            );
            const modelSelection = yield* resolveBotModelSelection(bot, projectId);
            const desiredStrategy = input.workspaceStrategy ?? bot.workspaceStrategy;
            const isNonGit = yield* threadLaunch.isNonGitProject(projectId);
            const workspaceStrategy =
              desiredStrategy === "worktree" && !isNonGit
                ? ({
                    type: "worktree" as const,
                    baseRef: input.baseRef ?? "HEAD",
                  } as const)
                : ({ type: "root" as const } as const);

            const roleLines = [
              `[Bot Worker · ${bot.name} (@${bot.handle}) · ${bot.role}]`,
              bot.systemPrompt.trim(),
              existingTask
                ? `[关联任务 #${existingTask.number}: ${existingTask.title}]${
                    existingTask.doneMeans
                      ? `\n验收标准 (Done means): ${existingTask.doneMeans}`
                      : ""
                  }`
                : "",
            ].filter((line) => line.length > 0);
            const fullPrompt = `${roleLines.join("\n")}\n\n${input.prompt}`;

            const cmdUuid = yield* nextUuid();
            const msgUuid = yield* nextUuid();
            const launched = yield* threadLaunch
              .launch({
                commandId: CommandId.make(`bot-worker:${bot.id}:${cmdUuid}`),
                projectId,
                title: input.title,
                titleRenamed: true,
                modelSelection,
                runtimeMode: bot.runtimeMode,
                interactionMode: bot.interactionMode,
                workspaceStrategy,
                initialMessage: {
                  messageId: MessageId.make(msgUuid),
                  text: fullPrompt,
                  attachments: [],
                  ...(bot.homeThreadId !== null ? { senderThreadId: bot.homeThreadId } : {}),
                },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.mapError((cause) => formatBotError(cause, "启动 Worker 线程失败。")));

            const updatedAt = yield* nowIso;
            const actUuid = yield* nextUuid();
            const workerEntry: BotTaskActivityEntry = {
              id: `act-${actUuid}`,
              at: updatedAt,
              actor: "user",
              actorLabel: bot.name,
              kind: "worker_started",
              text: `已启动并行 Worker「${input.title}」(${workspaceStrategy.type})`,
              threadId: launched.threadId,
            };

            const latest = yield* Ref.get(stateRef);
            let nextNumber = latest.nextNumber;
            let savedTask: BotTask;
            if (existingTask) {
              const latestTask = latest.tasks.find((t) => t.id === existingTask.id) ?? existingTask;
              savedTask = {
                ...latestTask,
                status: latestTask.status === "backlog" ? "in_progress" : latestTask.status,
                projectId: latestTask.projectId ?? projectId,
                workerThreadIds: dedupeStrings([...latestTask.workerThreadIds, launched.threadId]),
                activity: [...latestTask.activity, workerEntry],
                updatedAt,
              };
            } else {
              const taskUuid = yield* nextUuid();
              savedTask = {
                id: BotTaskId.make(`task-${taskUuid}`),
                number: nextNumber,
                botId: bot.id,
                title: input.title,
                doneMeans: null,
                status: "in_progress",
                projectId,
                homeThreadId: bot.homeThreadId,
                workerThreadIds: [launched.threadId],
                workflowRunIds: [],
                linkedPrUrls: [],
                pendingQuestion: null,
                activity: [workerEntry],
                createdAt: updatedAt,
                updatedAt,
              };
              nextNumber += 1;
            }

            const nextTasks = existingTask
              ? latest.tasks.map((t) => (t.id === savedTask.id ? savedTask : t))
              : [savedTask, ...latest.tasks];
            yield* persistAndPublish(
              { ...latest, tasks: nextTasks, nextNumber, updatedAt },
              { writeTasks: true },
            ).pipe(Effect.mapError((cause) => formatBotError(cause, "保存 Worker 任务记录失败。")));

            return { threadId: launched.threadId, task: savedTask };
          }),
        );

      const sendMessage = (
        input: BotSendMessageInput,
      ): Effect.Effect<BotSendMessageResult, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const { bot, threadId } = yield* ensureHomeThreadUnlocked(input.botId, input.projectId);
            const projectId = yield* resolveTargetProjectId(
              input.projectId ?? bot.defaultProjectId,
            );
            const cmdUuid = yield* nextUuid();
            const msgUuid = yield* nextUuid();
            yield* threadManagement
              .sendToThread({
                projectId,
                commandId: CommandId.make(`bot-send:${bot.id}:${cmdUuid}`),
                threadId,
                messageId: MessageId.make(msgUuid),
                text: input.message,
                attachments: [],
                mode: "auto",
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.mapError((cause) => formatBotError(cause, "发送消息给 Bot 失败。")));

            if (input.taskId !== undefined) {
              const current = yield* Ref.get(stateRef);
              const existingTask = current.tasks.find((t) => t.id === input.taskId);
              if (existingTask) {
                const updatedAt = yield* nowIso;
                const actUuid = yield* nextUuid();
                const entry: BotTaskActivityEntry = {
                  id: `act-${actUuid}`,
                  at: updatedAt,
                  actor: "user",
                  actorLabel: "You",
                  kind: "comment",
                  text: `已向 @${bot.handle} 发送指令：${input.message}`,
                  threadId,
                };
                const nextTask: BotTask = {
                  ...existingTask,
                  homeThreadId: threadId,
                  activity: [...existingTask.activity, entry],
                  updatedAt,
                };
                yield* persistAndPublish(
                  {
                    ...current,
                    tasks: current.tasks.map((t) => (t.id === nextTask.id ? nextTask : t)),
                    updatedAt,
                  },
                  { writeTasks: true },
                ).pipe(Effect.mapError((cause) => formatBotError(cause, "记录评论失败。")));
              }
            }
            return { threadId };
          }),
        );

      const seedPresets = (
        input: BotsSeedPresetsInput,
      ): Effect.Effect<BotsSeedPresetsResult, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const existingHandles = new Set(current.bots.map((b) => b.handle.toLowerCase()));
            const existingIds = new Set(current.bots.map((b) => b.id));
            const updatedAt = yield* nowIso;
            const added: Array<PersistentBot> = [];
            for (const preset of PRESET_BOTS) {
              if (existingIds.has(preset.id) || existingHandles.has(preset.handle.toLowerCase())) {
                continue;
              }
              added.push({
                ...preset,
                defaultProjectId: input.projectId ?? null,
                providerInstanceId: null,
                model: null,
                homeThreadId: null,
                createdAt: updatedAt,
                updatedAt,
              });
            }
            if (added.length === 0) {
              return { createdCount: 0, snapshot: toSnapshot(current) };
            }
            const nextState: ClusterStoreState = {
              ...current,
              bots: [...current.bots, ...added],
              updatedAt,
            };
            yield* persistAndPublish(nextState, { writeBots: true }).pipe(
              Effect.mapError((cause) => formatBotError(cause, "初始化推荐 Bot 集群失败。")),
            );
            return { createdCount: added.length, snapshot: toSnapshot(nextState) };
          }),
        );

      const upsertTask = (
        input: BotTaskUpsertInput,
      ): Effect.Effect<BotTask, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const bot = current.bots.find((b) => b.id === input.botId);
            if (!bot) {
              return yield* new BotClusterRequestError({
                message: `Bot "${input.botId}" 不存在。`,
              });
            }
            const existing =
              input.id !== undefined ? current.tasks.find((t) => t.id === input.id) : undefined;
            const updatedAt = yield* nowIso;
            const activities: Array<BotTaskActivityEntry> = [...(existing?.activity ?? [])];
            const actorLabel = input.actorLabel ?? (existing ? bot.name : "You");
            const appendActivity = Effect.fn("BotClusterService.appendActivity")(function* (
              kind: BotTaskActivityKind,
              text: string,
              extra?: {
                readonly actor?: "user" | "bot" | "system";
                readonly threadId?: ThreadId | null;
                readonly workflowRunId?: string | null;
                readonly url?: string | null;
              },
            ) {
              const id = yield* nextUuid();
              activities.push({
                id: `act-${id}`,
                at: updatedAt,
                actor: extra?.actor ?? "system",
                actorLabel,
                kind,
                text,
                ...(extra?.threadId !== undefined ? { threadId: extra.threadId } : {}),
                ...(extra?.workflowRunId !== undefined
                  ? { workflowRunId: extra.workflowRunId }
                  : {}),
                ...(extra?.url !== undefined ? { url: extra.url } : {}),
              });
            });

            if (!existing) {
              yield* appendActivity("created", `创建任务：${input.title}`, { actor: "user" });
            }

            const nextPendingQuestion =
              input.pendingQuestion !== undefined
                ? input.pendingQuestion
                : (existing?.pendingQuestion ?? null);

            let nextStatus: BotTaskStatus = input.status ?? existing?.status ?? "in_progress";
            if (input.pendingQuestion && input.status === undefined) {
              nextStatus = "needs_you";
            } else if (
              input.pendingQuestion === null &&
              existing?.status === "needs_you" &&
              input.status === undefined
            ) {
              nextStatus = "in_progress";
            }

            if (existing && nextStatus !== existing.status) {
              yield* appendActivity("status_changed", `状态变更为 ${nextStatus}`);
            }
            if (input.pendingQuestion) {
              yield* appendActivity("question", input.pendingQuestion.prompt, { actor: "bot" });
            }
            if (input.addPrUrl !== undefined) {
              yield* appendActivity("pr_linked", `关联 PR: ${input.addPrUrl}`, {
                actor: "bot",
                url: input.addPrUrl,
              });
            }
            if (input.addWorkerThreadId !== undefined) {
              yield* appendActivity("worker_started", "关联 Worker 线程", {
                actor: "bot",
                threadId: input.addWorkerThreadId,
              });
            }
            if (input.addWorkflowRunId !== undefined) {
              yield* appendActivity(
                "workflow_started",
                `关联工作流运行 ${input.addWorkflowRunId}`,
                {
                  actor: "bot",
                  workflowRunId: input.addWorkflowRunId,
                },
              );
            }
            if (input.comment !== undefined) {
              yield* appendActivity("comment", input.comment, { actor: "bot" });
            }

            const taskId = existing?.id ?? input.id ?? BotTaskId.make(`task-${yield* nextUuid()}`);
            const number = existing?.number ?? current.nextNumber;
            const nextTask: BotTask = {
              id: taskId,
              number,
              botId: bot.id,
              title: input.title,
              doneMeans:
                input.doneMeans !== undefined ? input.doneMeans : (existing?.doneMeans ?? null),
              status: nextStatus,
              projectId:
                input.projectId !== undefined
                  ? input.projectId
                  : (existing?.projectId ?? bot.defaultProjectId),
              homeThreadId:
                input.homeThreadId !== undefined
                  ? input.homeThreadId
                  : (existing?.homeThreadId ?? bot.homeThreadId),
              workerThreadIds: dedupeStrings([
                ...(existing?.workerThreadIds ?? []),
                ...(input.addWorkerThreadId !== undefined ? [input.addWorkerThreadId] : []),
              ]),
              workflowRunIds: dedupeStrings([
                ...(existing?.workflowRunIds ?? []),
                ...(input.addWorkflowRunId !== undefined ? [input.addWorkflowRunId] : []),
              ]),
              linkedPrUrls: dedupeStrings([
                ...(existing?.linkedPrUrls ?? []),
                ...(input.addPrUrl !== undefined ? [input.addPrUrl] : []),
              ]),
              pendingQuestion: nextPendingQuestion,
              activity: activities,
              createdAt: existing?.createdAt ?? updatedAt,
              updatedAt,
            };

            const nextTasks = existing
              ? current.tasks.map((t) => (t.id === nextTask.id ? nextTask : t))
              : [nextTask, ...current.tasks];
            const nextNumber = existing ? current.nextNumber : current.nextNumber + 1;
            yield* persistAndPublish(
              { ...current, tasks: nextTasks, nextNumber, updatedAt },
              { writeTasks: true },
            ).pipe(Effect.mapError((cause) => formatBotError(cause, "保存 Task 失败。")));
            return nextTask;
          }),
        );

      const addTaskComment = (
        input: BotTaskCommentInput,
      ): Effect.Effect<BotTask, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const task = current.tasks.find((t) => t.id === input.taskId);
            if (!task) {
              return yield* new BotClusterRequestError({
                message: `Task "${input.taskId}" 不存在。`,
              });
            }
            const bot = current.bots.find((b) => b.id === task.botId);
            const updatedAt = yield* nowIso;
            const actUuid = yield* nextUuid();
            const nextTask: BotTask = {
              ...task,
              activity: [
                ...task.activity,
                {
                  id: `act-${actUuid}`,
                  at: updatedAt,
                  actor: "user",
                  actorLabel: "You",
                  kind: "comment",
                  text: input.text,
                },
              ],
              updatedAt,
            };
            yield* persistAndPublish(
              {
                ...current,
                tasks: current.tasks.map((t) => (t.id === nextTask.id ? nextTask : t)),
                updatedAt,
              },
              { writeTasks: true },
            ).pipe(Effect.mapError((cause) => formatBotError(cause, "保存评论失败。")));

            if (input.notifyBot === true && bot?.homeThreadId != null) {
              const projectId = yield* resolveTargetProjectId(
                task.projectId ?? bot.defaultProjectId,
              ).pipe(Effect.orElseSucceed(() => null));
              if (projectId !== null) {
                const cmdUuid = yield* nextUuid();
                const msgUuid = yield* nextUuid();
                yield* threadManagement
                  .sendToThread({
                    projectId,
                    commandId: CommandId.make(`bot-comment:${task.id}:${cmdUuid}`),
                    threadId: bot.homeThreadId,
                    messageId: MessageId.make(msgUuid),
                    text: `[Task #${task.number}: ${task.title} 评论]\n${input.text}`,
                    attachments: [],
                    mode: "auto",
                    createdBy: "user",
                    creationSource: "web",
                  })
                  .pipe(Effect.ignoreCause({ log: true }));
              }
            }
            return nextTask;
          }),
        );

      const answerTaskQuestion = (
        input: BotTaskAnswerInput,
      ): Effect.Effect<BotTask, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const task = current.tasks.find((t) => t.id === input.taskId);
            if (!task) {
              return yield* new BotClusterRequestError({
                message: `Task "${input.taskId}" 不存在。`,
              });
            }
            const bot = current.bots.find((b) => b.id === task.botId);
            const updatedAt = yield* nowIso;
            const actUuid = yield* nextUuid();
            const answerText = input.reason?.trim()
              ? `${input.choice}: ${input.reason.trim()}`
              : input.choice;
            const nextTask: BotTask = {
              ...task,
              status: task.status === "needs_you" ? "in_progress" : task.status,
              pendingQuestion: null,
              activity: [
                ...task.activity,
                {
                  id: `act-${actUuid}`,
                  at: updatedAt,
                  actor: "user",
                  actorLabel: "You",
                  kind: "answered",
                  text: `已拍板：${answerText}`,
                },
              ],
              updatedAt,
            };
            yield* persistAndPublish(
              {
                ...current,
                tasks: current.tasks.map((t) => (t.id === nextTask.id ? nextTask : t)),
                updatedAt,
              },
              { writeTasks: true },
            ).pipe(Effect.mapError((cause) => formatBotError(cause, "保存审批决策失败。")));

            if (bot?.homeThreadId != null) {
              const projectId = yield* resolveTargetProjectId(
                task.projectId ?? bot.defaultProjectId,
              ).pipe(Effect.orElseSucceed(() => null));
              if (projectId !== null) {
                const cmdUuid = yield* nextUuid();
                const msgUuid = yield* nextUuid();
                yield* threadManagement
                  .sendToThread({
                    projectId,
                    commandId: CommandId.make(`bot-answer:${task.id}:${cmdUuid}`),
                    threadId: bot.homeThreadId,
                    messageId: MessageId.make(msgUuid),
                    text: `[Task #${task.number} · 决策回复] ${answerText}`,
                    attachments: [],
                    mode: "auto",
                    createdBy: "user",
                    creationSource: "web",
                  })
                  .pipe(Effect.ignoreCause({ log: true }));
              }
            }
            return nextTask;
          }),
        );

      const deleteTask = (
        input: BotTaskDeleteInput,
      ): Effect.Effect<BotDeleteResult, BotClusterRequestError> =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const existed = current.tasks.some((t) => t.id === input.taskId);
            if (!existed) return { deleted: false };
            const updatedAt = yield* nowIso;
            const nextTasks = current.tasks.filter((t) => t.id !== input.taskId);
            yield* persistAndPublish(
              { ...current, tasks: nextTasks, updatedAt },
              { writeTasks: true },
            ).pipe(Effect.mapError((cause) => formatBotError(cause, "删除 Task 失败。")));
            return { deleted: true };
          }),
        );

      return {
        snapshot,
        subscribe,
        upsertBot,
        deleteBot,
        ensureHomeThread,
        dispatchWorker,
        sendMessage,
        seedPresets,
        upsertTask,
        addTaskComment,
        answerTaskQuestion,
        deleteTask,
      };
    }),
  );
}
