import {
  BotTask,
  BotTaskStatus,
  BotWorkspaceStrategy,
  OrchestratorMcpFailure,
  PersistentBot,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotClusterService from "../../../lunacode/bots/BotClusterService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BotClusterService.BotClusterService,
];

const BotsListTool = Tool.make("t3_bots_list", {
  description: "List persistent Bots and their active or open Tasks.",
  parameters: Schema.Struct({
    bot: Schema.optional(TrimmedNonEmptyString).annotate({
      description: "Optional bot id or @handle filter.",
    }),
    status: Schema.optional(BotTaskStatus).annotate({
      description: "Optional task status filter.",
    }),
  }),
  success: Schema.Struct({
    bots: Schema.Array(PersistentBot),
    tasks: Schema.Array(BotTask),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List persistent Bots and Tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const BotTaskUpsertTool = Tool.make("t3_bot_task_upsert", {
  description:
    "Create or update a persistent Bot Task (#N), Done means, linked PR, comment, or Needs-you question.",
  parameters: Schema.Struct({
    taskId: Schema.optional(TrimmedNonEmptyString),
    bot: TrimmedNonEmptyString.annotate({
      description: "Bot id or @handle (e.g. scout).",
    }),
    title: TrimmedNonEmptyString,
    doneMeans: Schema.optional(Schema.String),
    status: Schema.optional(BotTaskStatus),
    linkedPrUrl: Schema.optional(TrimmedNonEmptyString),
    questionPrompt: Schema.optional(TrimmedNonEmptyString),
    questionChoices: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    comment: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    task: BotTask,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create or update a Bot Task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const BotDispatchTool = Tool.make("t3_bot_dispatch", {
  description: "Spawn an isolated worker under a Bot or send a message to a peer Bot Home Chat.",
  parameters: Schema.Struct({
    targetBot: TrimmedNonEmptyString.annotate({
      description: "Bot id or @handle.",
    }),
    mode: Schema.Literals(["worker", "message"]),
    title: Schema.optional(TrimmedNonEmptyString),
    prompt: TrimmedNonEmptyString,
    taskId: Schema.optional(TrimmedNonEmptyString),
    workspaceStrategy: Schema.optional(BotWorkspaceStrategy),
  }),
  success: Schema.Struct({
    mode: Schema.Literals(["worker", "message"]),
    botId: Schema.String,
    threadId: Schema.String,
    taskId: Schema.optional(Schema.String),
    taskNumber: Schema.optional(Schema.Int),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Dispatch a Bot worker or handoff message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const BotToolkit = Toolkit.make(BotsListTool, BotTaskUpsertTool, BotDispatchTool);
