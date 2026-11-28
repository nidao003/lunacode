import { extractPrShortLabel, sortBotTasks } from "@t3tools/client-runtime/lunacode/bots";
import {
  type BotId,
  type BotTask,
  EnvironmentId,
  type PersistentBot,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { getBotStarterPrompts } from "@t3tools/shared/lunacodeBotPresets";
import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Card, reportFailure } from "../../features/workflows/WorkflowStepCard";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { LunaMobileBotAvatar } from "./LunaMobileBotAvatar";

export type LunaMobileBotsParams = {
  readonly environmentId?: string;
};

type MobileBotsTab = "bots" | "tasks";

const STATUS_LABEL: Readonly<Record<BotTask["status"], string>> = {
  needs_you: "待你确认",
  in_progress: "进行中",
  backlog: "待办",
  done: "已完成",
  cancelled: "已取消",
};

function MobileBotsBody({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const snapshot = botsQuery.data;

  const canSeed = useAtomValue(serverEnvironment.seedBotPresets.permissionAtom(environmentId));
  const canEnsureHome = useAtomValue(
    serverEnvironment.ensureBotHomeThread.permissionAtom(environmentId),
  );
  const canDispatch = useAtomValue(
    serverEnvironment.dispatchBotWorker.permissionAtom(environmentId),
  );
  const canAnswer = useAtomValue(serverEnvironment.answerBotTask.permissionAtom(environmentId));
  const canComment = useAtomValue(serverEnvironment.commentBotTask.permissionAtom(environmentId));

  const seedPresets = useAtomCommand(serverEnvironment.seedBotPresets, {
    label: "mobile seed bot presets",
    reportFailure: false,
  });
  const ensureHome = useAtomCommand(serverEnvironment.ensureBotHomeThread, {
    label: "mobile ensure bot home",
    reportFailure: false,
  });
  const dispatchWorker = useAtomCommand(serverEnvironment.dispatchBotWorker, {
    label: "mobile dispatch bot worker",
    reportFailure: false,
  });
  const answerTask = useAtomCommand(serverEnvironment.answerBotTask, {
    label: "mobile answer bot task",
    reportFailure: false,
  });
  const commentTask = useAtomCommand(serverEnvironment.commentBotTask, {
    label: "mobile comment bot task",
    reportFailure: false,
  });

  const [tab, setTab] = useState<MobileBotsTab>("bots");
  const [seeding, setSeeding] = useState(false);
  const [dispatchingBotId, setDispatchingBotId] = useState<BotId | null>(null);
  const [dispatchPrompt, setDispatchPrompt] = useState("");
  const [commentByTaskId, setCommentByTaskId] = useState<Readonly<Record<string, string>>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const openThread = (threadId: string) => {
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(environmentId),
        threadId,
      }),
    );
  };

  const handleSeed = async () => {
    if (!canSeed || seeding) return;
    setSeeding(true);
    const result = await seedPresets({ environmentId, input: {} });
    setSeeding(false);
    reportFailure("加载预设失败", result);
  };

  const handleOpenHome = async (bot: PersistentBot) => {
    if (bot.homeThreadId) {
      openThread(String(bot.homeThreadId));
      return;
    }
    if (!canEnsureHome) return;
    setBusyKey(`home:${bot.id}`);
    const result = await ensureHome({
      environmentId,
      input: {
        botId: bot.id,
        ...(bot.defaultProjectId ? { projectId: bot.defaultProjectId } : {}),
      },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      openThread(String(result.value.threadId));
      return;
    }
    reportFailure("打开主对话失败", result);
  };

  const handleDispatch = async (bot: PersistentBot) => {
    const cleanPrompt = dispatchPrompt.trim();
    if (!canDispatch || !cleanPrompt) return;
    setBusyKey(`dispatch:${bot.id}`);
    const result = await dispatchWorker({
      environmentId,
      input: {
        botId: bot.id,
        title: TrimmedNonEmptyString.make(cleanPrompt.slice(0, 48)),
        prompt: TrimmedNonEmptyString.make(cleanPrompt),
        workspaceStrategy: bot.workspaceStrategy,
        ...(bot.defaultProjectId ? { projectId: bot.defaultProjectId } : {}),
      },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      setDispatchPrompt("");
      setDispatchingBotId(null);
      openThread(String(result.value.threadId));
      return;
    }
    reportFailure("派发 Worker 失败", result);
  };

  const handleAnswer = async (task: BotTask, choice: string) => {
    if (!canAnswer) return;
    setBusyKey(`answer:${task.id}`);
    const result = await answerTask({
      environmentId,
      input: {
        taskId: task.id,
        choice: TrimmedNonEmptyString.make(choice),
      },
    });
    setBusyKey(null);
    reportFailure("提交回复失败", result);
  };

  const handleComment = async (task: BotTask) => {
    const text = (commentByTaskId[task.id] ?? "").trim();
    if (!canComment || !text) return;
    setBusyKey(`comment:${task.id}`);
    const result = await commentTask({
      environmentId,
      input: {
        taskId: task.id,
        text: TrimmedNonEmptyString.make(text),
        notifyBot: true,
      },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      setCommentByTaskId((prev) => ({ ...prev, [task.id]: "" }));
      return;
    }
    reportFailure("发送评论失败", result);
  };

  if (snapshot === null) {
    return (
      <EmptyState
        variant="plain"
        title={botsQuery.error ?? "加载 Bot 集群中..."}
        detail="正在同步常驻 Bot 与任务状态"
      />
    );
  }

  const bots = snapshot.bots.filter((bot) => bot.archived !== true);
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  const tasks = sortBotTasks(snapshot.tasks);

  if (bots.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <EmptyState
          variant="plain"
          title="尚未启用常驻 Bot 集群"
          detail="加载 6 位拟人化常驻 Bot（苏探 Scout / 林清 Review / 夏哨 CI / 云舒 Docs / 颜汐 Release / 许晨 Standup）管理长期记忆对话与并行任务。"
          actionLabel={seeding ? "初始化中..." : "加载预设集群"}
          onAction={() => void handleSeed()}
        />
      </View>
    );
  }

  return (
    <ScreenScrollView className="flex-1" contentContainerClassName="gap-3 px-4 py-3 pb-10">
      <SegmentedControl
        variant="standalone"
        options={[
          { value: "bots", label: `Bot 集群 (${bots.length})` },
          { value: "tasks", label: `任务 (${tasks.length})` },
        ]}
        selected={tab}
        onSelect={setTab}
      />

      {tab === "bots" ? (
        <View className="gap-3">
          {bots.map((bot) => {
            const botTasks = tasks.filter((t) => t.botId === bot.id);
            const openCount = botTasks.filter(
              (t) => t.status !== "done" && t.status !== "cancelled",
            ).length;
            const needsCount = botTasks.filter((t) => t.status === "needs_you").length;
            const isDispatching = dispatchingBotId === bot.id;

            return (
              <Card key={bot.id} tone={needsCount > 0 ? "input" : undefined}>
                <View className="flex-row items-center justify-between gap-2">
                  <View className="flex-1 flex-row items-center gap-2.5">
                    <LunaMobileBotAvatar avatar={bot.avatar} accent={bot.accent} size={38} />
                    <View className="min-w-0 flex-1">
                      <Text
                        textRole="body"
                        className="font-t3-semibold text-foreground"
                        numberOfLines={1}
                      >
                        {bot.name}
                      </Text>
                      <Text textRole="caption" className="text-foreground-muted" numberOfLines={1}>
                        @{bot.handle} · {bot.role}
                      </Text>
                    </View>
                  </View>
                  <View className="flex-row gap-1.5">
                    {needsCount > 0 ? <Chip size="small" label={`待拍板 ${needsCount}`} /> : null}
                    <Chip size="small" label={`${openCount} 进行中`} />
                  </View>
                </View>

                {bot.systemPrompt ? (
                  <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
                    {bot.systemPrompt}
                  </Text>
                ) : null}

                <View className="flex-row flex-wrap gap-2 pt-1">
                  <Button
                    tone="secondary"
                    size="compact"
                    label={bot.homeThreadId ? "Home Chat" : "初始化主对话"}
                    loading={busyKey === `home:${bot.id}`}
                    disabled={!canEnsureHome}
                    onPress={() => void handleOpenHome(bot)}
                  />
                  <Button
                    tone="primary"
                    size="compact"
                    label={isDispatching ? "收起派发" : "派发 Worker"}
                    disabled={!canDispatch}
                    onPress={() => setDispatchingBotId(isDispatching ? null : bot.id)}
                  />
                </View>

                {isDispatching ? (
                  <View className="gap-2 border-t border-border pt-2">
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View className="flex-row gap-1.5 pb-1">
                        {getBotStarterPrompts(bot).map((starter) => (
                          <Chip
                            key={starter.label}
                            size="small"
                            label={starter.label}
                            selected={dispatchPrompt === starter.prompt}
                            onPress={() => setDispatchPrompt(starter.prompt)}
                          />
                        ))}
                      </View>
                    </ScrollView>
                    <TextInput
                      multiline
                      value={dispatchPrompt}
                      onChangeText={setDispatchPrompt}
                      placeholder={`向 ${bot.name} 派发独立 Worktree 任务指令...`}
                    />
                    <Button
                      tone="contrast"
                      size="compact"
                      label="确认派发 Worker"
                      loading={busyKey === `dispatch:${bot.id}`}
                      disabled={!dispatchPrompt.trim()}
                      onPress={() => void handleDispatch(bot)}
                    />
                  </View>
                ) : null}
              </Card>
            );
          })}
        </View>
      ) : tasks.length === 0 ? (
        <EmptyState
          variant="plain"
          title="暂无任务卡"
          detail="可在 Bot 集群页点击「派发 Worker」自动创建并追踪 #N 任务卡。"
        />
      ) : (
        <View className="gap-3">
          {tasks.map((task) => {
            const owner = botsById.get(task.botId);
            const draftComment = commentByTaskId[task.id] ?? "";
            return (
              <Card key={task.id} tone={task.pendingQuestion ? "input" : undefined}>
                <View className="flex-row items-start justify-between gap-2">
                  <View className="flex-1 gap-0.5">
                    <Text textRole="body" className="font-t3-semibold text-foreground">
                      #{task.number} {task.title}
                    </Text>
                    <Text textRole="caption" className="text-foreground-muted">
                      {owner ? `${owner.name} (@${owner.handle})` : "未知 Bot"} ·{" "}
                      {STATUS_LABEL[task.status]}
                    </Text>
                  </View>
                  <Chip size="small" label={STATUS_LABEL[task.status]} />
                </View>

                {task.doneMeans ? (
                  <Text textRole="footnote" className="text-foreground-muted">
                    Done means: {task.doneMeans}
                  </Text>
                ) : null}

                {task.workerThreadIds.length > 0 || task.linkedPrUrls.length > 0 ? (
                  <View className="flex-row flex-wrap gap-1.5">
                    {task.workerThreadIds.map((workerId) => (
                      <Chip
                        key={workerId}
                        size="small"
                        label="查看 Worker"
                        onPress={() => openThread(String(workerId))}
                      />
                    ))}
                    {task.linkedPrUrls.map((url) => (
                      <Chip key={url} size="small" label={extractPrShortLabel(url)} />
                    ))}
                  </View>
                ) : null}

                {task.pendingQuestion ? (
                  <View className="gap-2 rounded-xl border border-warning-border bg-background/60 p-2.5">
                    <Text textRole="footnote" className="font-t3-medium text-foreground">
                      待你确认: {task.pendingQuestion.prompt}
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      {task.pendingQuestion.choices.map((choice) => (
                        <Button
                          key={choice}
                          tone="primary"
                          size="compact"
                          label={choice}
                          loading={busyKey === `answer:${task.id}`}
                          disabled={!canAnswer}
                          onPress={() => void handleAnswer(task, choice)}
                        />
                      ))}
                    </View>
                  </View>
                ) : null}

                <View className="flex-row items-center gap-2 pt-1">
                  <TextInput
                    className="flex-1"
                    value={draftComment}
                    onChangeText={(next) =>
                      setCommentByTaskId((prev) => ({ ...prev, [task.id]: next }))
                    }
                    placeholder="+ 添加评论并通知 Bot..."
                  />
                  <Button
                    tone="secondary"
                    size="compact"
                    label="发送"
                    loading={busyKey === `comment:${task.id}`}
                    disabled={!canComment || !draftComment.trim()}
                    onPress={() => void handleComment(task)}
                  />
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </ScreenScrollView>
  );
}

export function LunaMobileBotsScreen({ route }: StaticScreenProps<LunaMobileBotsParams>) {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const requestedEnvId = route.params?.environmentId
    ? EnvironmentId.make(route.params.environmentId)
    : null;
  const environmentId = requestedEnvId ?? environments[0]?.environmentId ?? null;

  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title="常驻 Bot 集群"
        onBack={() => {
          if (navigation.canGoBack()) navigation.goBack();
        }}
      />
      {environmentId === null ? (
        <EmptyState
          variant="plain"
          title="尚未连接运行环境"
          detail="连接桌面或服务器环境后即可查看和管理常驻 Bot 集群。"
        />
      ) : (
        <MobileBotsBody environmentId={environmentId} />
      )}
    </View>
  );
}
