import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const BotId = TrimmedNonEmptyString.pipe(Schema.brand<"BotId">("BotId"));
export type BotId = typeof BotId.Type;

export const BotTaskId = TrimmedNonEmptyString.pipe(Schema.brand<"BotTaskId">("BotTaskId"));
export type BotTaskId = typeof BotTaskId.Type;

export const BotHandle = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,47}$/i),
);
export type BotHandle = typeof BotHandle.Type;

export const BotAvatarPreset = Schema.Literals([
  "scout",
  "sentinel",
  "reviewer",
  "builder",
  "scribe",
  "coordinator",
  "ops",
  "spark",
]);
export type BotAvatarPreset = typeof BotAvatarPreset.Type;

export const BotAccent = Schema.Literals([
  "info",
  "success",
  "warning",
  "primary",
  "destructive",
  "neutral",
]);
export type BotAccent = typeof BotAccent.Type;

export const BotWorkspaceStrategy = Schema.Literals(["root", "worktree"]);
export type BotWorkspaceStrategy = typeof BotWorkspaceStrategy.Type;

export const PersistentBot = Schema.Struct({
  id: BotId,
  name: TrimmedNonEmptyString,
  handle: BotHandle,
  role: TrimmedNonEmptyString,
  avatar: BotAvatarPreset,
  accent: BotAccent,
  systemPrompt: Schema.String,
  defaultProjectId: Schema.NullOr(ProjectId),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: BotWorkspaceStrategy,
  homeThreadId: Schema.NullOr(ThreadId),
  linkedWorkflowNames: Schema.Array(Schema.String),
  linkedScheduledTaskIds: Schema.Array(Schema.String),
  archived: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PersistentBot = typeof PersistentBot.Type;

export const BotTaskStatus = Schema.Literals([
  "backlog",
  "in_progress",
  "needs_you",
  "done",
  "cancelled",
]);
export type BotTaskStatus = typeof BotTaskStatus.Type;

export const BotTaskActivityKind = Schema.Literals([
  "created",
  "status_changed",
  "worker_started",
  "worker_finished",
  "workflow_started",
  "pr_linked",
  "comment",
  "question",
  "answered",
]);
export type BotTaskActivityKind = typeof BotTaskActivityKind.Type;

export const BotTaskActivityEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  at: IsoDateTime,
  actor: Schema.Literals(["user", "bot", "system"]),
  actorLabel: TrimmedNonEmptyString,
  kind: BotTaskActivityKind,
  text: Schema.String,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workflowRunId: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BotTaskActivityEntry = typeof BotTaskActivityEntry.Type;

export const BotTaskQuestion = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  choices: Schema.Array(TrimmedNonEmptyString),
  askedAt: IsoDateTime,
});
export type BotTaskQuestion = typeof BotTaskQuestion.Type;

export const BotTask = Schema.Struct({
  id: BotTaskId,
  number: PositiveInt,
  botId: BotId,
  title: TrimmedNonEmptyString,
  doneMeans: Schema.NullOr(Schema.String),
  status: BotTaskStatus,
  projectId: Schema.NullOr(ProjectId),
  homeThreadId: Schema.NullOr(ThreadId),
  workerThreadIds: Schema.Array(ThreadId),
  workflowRunIds: Schema.Array(Schema.String),
  linkedPrUrls: Schema.Array(Schema.String),
  pendingQuestion: Schema.NullOr(BotTaskQuestion),
  activity: Schema.Array(BotTaskActivityEntry),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotTask = typeof BotTask.Type;

export const BotClusterSnapshot = Schema.Struct({
  bots: Schema.Array(PersistentBot),
  tasks: Schema.Array(BotTask),
  updatedAt: IsoDateTime,
});
export type BotClusterSnapshot = typeof BotClusterSnapshot.Type;

export const BotsSubscribeInput = Schema.Struct({});
export type BotsSubscribeInput = typeof BotsSubscribeInput.Type;

export const BotUpsertInput = Schema.Struct({
  id: Schema.optional(BotId),
  name: TrimmedNonEmptyString,
  handle: BotHandle,
  role: TrimmedNonEmptyString,
  avatar: Schema.optional(BotAvatarPreset),
  accent: Schema.optional(BotAccent),
  systemPrompt: Schema.optional(Schema.String),
  defaultProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  providerInstanceId: Schema.optional(Schema.NullOr(ProviderInstanceId)),
  model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspaceStrategy: Schema.optional(BotWorkspaceStrategy),
  linkedWorkflowNames: Schema.optional(Schema.Array(Schema.String)),
  linkedScheduledTaskIds: Schema.optional(Schema.Array(Schema.String)),
  archived: Schema.optional(Schema.Boolean),
});
export type BotUpsertInput = typeof BotUpsertInput.Type;

export const BotDeleteInput = Schema.Struct({
  botId: BotId,
});
export type BotDeleteInput = typeof BotDeleteInput.Type;

export const BotDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type BotDeleteResult = typeof BotDeleteResult.Type;

export const BotEnsureHomeThreadInput = Schema.Struct({
  botId: BotId,
  projectId: Schema.optional(ProjectId),
});
export type BotEnsureHomeThreadInput = typeof BotEnsureHomeThreadInput.Type;

export const BotEnsureHomeThreadResult = Schema.Struct({
  bot: PersistentBot,
  threadId: ThreadId,
});
export type BotEnsureHomeThreadResult = typeof BotEnsureHomeThreadResult.Type;

export const BotDispatchWorkerInput = Schema.Struct({
  botId: BotId,
  taskId: Schema.optional(BotTaskId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  workspaceStrategy: Schema.optional(BotWorkspaceStrategy),
  baseRef: Schema.optional(TrimmedNonEmptyString),
});
export type BotDispatchWorkerInput = typeof BotDispatchWorkerInput.Type;

export const BotDispatchWorkerResult = Schema.Struct({
  threadId: ThreadId,
  task: BotTask,
});
export type BotDispatchWorkerResult = typeof BotDispatchWorkerResult.Type;

export const BotSendMessageInput = Schema.Struct({
  botId: BotId,
  message: TrimmedNonEmptyString,
  taskId: Schema.optional(BotTaskId),
  projectId: Schema.optional(ProjectId),
});
export type BotSendMessageInput = typeof BotSendMessageInput.Type;

export const BotSendMessageResult = Schema.Struct({
  threadId: ThreadId,
});
export type BotSendMessageResult = typeof BotSendMessageResult.Type;

export const BotsSeedPresetsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type BotsSeedPresetsInput = typeof BotsSeedPresetsInput.Type;

export const BotsSeedPresetsResult = Schema.Struct({
  createdCount: Schema.Int,
  snapshot: BotClusterSnapshot,
});
export type BotsSeedPresetsResult = typeof BotsSeedPresetsResult.Type;

export const BotTaskUpsertInput = Schema.Struct({
  id: Schema.optional(BotTaskId),
  botId: BotId,
  title: TrimmedNonEmptyString,
  doneMeans: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(BotTaskStatus),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  homeThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  addWorkerThreadId: Schema.optional(ThreadId),
  addWorkflowRunId: Schema.optional(TrimmedNonEmptyString),
  addPrUrl: Schema.optional(TrimmedNonEmptyString),
  pendingQuestion: Schema.optional(Schema.NullOr(BotTaskQuestion)),
  actorLabel: Schema.optional(TrimmedNonEmptyString),
  comment: Schema.optional(TrimmedNonEmptyString),
});
export type BotTaskUpsertInput = typeof BotTaskUpsertInput.Type;

export const BotTaskCommentInput = Schema.Struct({
  taskId: BotTaskId,
  text: TrimmedNonEmptyString,
  notifyBot: Schema.optional(Schema.Boolean),
});
export type BotTaskCommentInput = typeof BotTaskCommentInput.Type;

export const BotTaskAnswerInput = Schema.Struct({
  taskId: BotTaskId,
  choice: TrimmedNonEmptyString,
  reason: Schema.optional(Schema.String),
});
export type BotTaskAnswerInput = typeof BotTaskAnswerInput.Type;

export const BotTaskDeleteInput = Schema.Struct({
  taskId: BotTaskId,
});
export type BotTaskDeleteInput = typeof BotTaskDeleteInput.Type;

export class BotClusterRequestError extends Schema.TaggedError<BotClusterRequestError>()(
  "BotClusterRequestError",
  {
    message: Schema.String,
  },
) {}
