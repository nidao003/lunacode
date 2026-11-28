import {
  BotClusterRequestError,
  BotTaskId,
  OrchestratorMcpFailure,
  type PersistentBot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BotClusterService from "../../../lunacode/bots/BotClusterService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotToolkit } from "./botTools.ts";

const isBotClusterRequestError = Schema.is(BotClusterRequestError);

function mapBotFailure(error: unknown): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: isBotClusterRequestError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error),
  });
}

function findBot(bots: ReadonlyArray<PersistentBot>, query: string): PersistentBot | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/^@/, "").toLowerCase();
  const slugified = normalized.replace(/\s+/g, "-");
  return (
    bots.find(
      (bot) =>
        bot.id === trimmed ||
        bot.handle.toLowerCase() === normalized ||
        bot.handle.toLowerCase() === slugified ||
        bot.name.toLowerCase() === normalized,
    ) ??
    (() => {
      const partialMatches = bots.filter((bot) => bot.name.toLowerCase().includes(normalized));
      return partialMatches.length === 1 ? partialMatches[0] : undefined;
    })()
  );
}

const make = Effect.gen(function* () {
  const botCluster = yield* BotClusterService.BotClusterService;

  return {
    t3_bots_list: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const snap = yield* botCluster.snapshot();
        const targetBot = input.bot !== undefined ? findBot(snap.bots, input.bot) : undefined;
        if (input.bot !== undefined && !targetBot) {
          return { bots: [], tasks: [] };
        }
        const tasks = snap.tasks.filter((task) => {
          if (targetBot && task.botId !== targetBot.id) return false;
          if (input.status !== undefined && task.status !== input.status) return false;
          return true;
        });
        return {
          bots: targetBot ? [targetBot] : snap.bots,
          tasks: tasks.slice(0, 40),
        };
      }),
    ),

    t3_bot_task_upsert: McpToolAccess.writesOwnerWork(
      "create or update a persistent Bot task",
      (input) =>
        Effect.gen(function* () {
          const snap = yield* botCluster.snapshot();
          const bot = findBot(snap.bots, input.bot);
          if (!bot) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Unknown Bot "${input.bot}". Call t3_bots_list to inspect available Bots.`,
            });
          }
          const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
          const callerThreadId = scope._tag === "Some" ? scope.value.thread?.threadId : undefined;
          const nowIso = yield* Effect.map(DateTime.now, DateTime.formatIso);
          const pendingQuestion =
            input.questionPrompt !== undefined
              ? {
                  prompt: input.questionPrompt,
                  choices:
                    input.questionChoices && input.questionChoices.length > 0
                      ? input.questionChoices
                      : ["继续执行", "暂停等待"],
                  askedAt: nowIso,
                }
              : undefined;

          const task = yield* botCluster
            .upsertTask({
              ...(input.taskId !== undefined ? { id: BotTaskId.make(input.taskId) } : {}),
              botId: bot.id,
              title: input.title,
              ...(input.doneMeans !== undefined ? { doneMeans: input.doneMeans } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              ...(callerThreadId !== undefined && callerThreadId !== bot.homeThreadId
                ? { addWorkerThreadId: callerThreadId }
                : {}),
              ...(input.linkedPrUrl !== undefined ? { addPrUrl: input.linkedPrUrl } : {}),
              ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
              ...(input.comment !== undefined ? { comment: input.comment } : {}),
              actorLabel: bot.name,
            })
            .pipe(Effect.mapError(mapBotFailure));

          return { task };
        }),
    ),

    t3_bot_dispatch: McpToolAccess.writesOwnerWork(
      "spawn a Bot worker or send a message to a peer Bot Home Chat",
      (input) =>
        Effect.gen(function* () {
          const snap = yield* botCluster.snapshot();
          const bot = findBot(snap.bots, input.targetBot);
          if (!bot) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Unknown Bot "${input.targetBot}". Call t3_bots_list to inspect available Bots.`,
            });
          }

          if (input.mode === "message") {
            const sent = yield* botCluster
              .sendMessage({
                botId: bot.id,
                message: input.prompt,
                ...(input.taskId !== undefined ? { taskId: BotTaskId.make(input.taskId) } : {}),
              })
              .pipe(Effect.mapError(mapBotFailure));
            return {
              mode: "message" as const,
              botId: bot.id,
              threadId: sent.threadId,
            };
          }

          const title = input.title ?? input.prompt.slice(0, 64);
          const dispatched = yield* botCluster
            .dispatchWorker({
              botId: bot.id,
              ...(input.taskId !== undefined ? { taskId: BotTaskId.make(input.taskId) } : {}),
              title,
              prompt: input.prompt,
              ...(input.workspaceStrategy !== undefined
                ? { workspaceStrategy: input.workspaceStrategy }
                : {}),
            })
            .pipe(Effect.mapError(mapBotFailure));

          return {
            mode: "worker" as const,
            botId: bot.id,
            threadId: dispatched.threadId,
            taskId: dispatched.task.id,
            taskNumber: dispatched.task.number,
          };
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof BotToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(BotToolkit, make);
