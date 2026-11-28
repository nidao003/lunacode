import { sortBotTasks } from "@t3tools/client-runtime/lunacode/bots";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function LunaMobileBotsEntryRow({
  environmentId,
  onPress,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly onPress: (environmentId: EnvironmentId) => void;
}) {
  const botsQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.botsLive({ environmentId, input: {} }) : null,
  );
  if (!environmentId) return null;

  const snapshot = botsQuery.data;
  const bots = snapshot?.bots.filter((bot) => bot.archived !== true) ?? [];
  const tasks = snapshot ? sortBotTasks(snapshot.tasks) : [];
  const needsYouCount = tasks.filter(
    (task) => task.status === "needs_you" || task.pendingQuestion !== null,
  ).length;
  const subtitle =
    bots.length > 0
      ? `${bots.length} 个常驻 Bot · ${tasks.length} 项任务`
      : "点击初始化常驻 Bot 集群与并行任务";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="常驻 Bot 集群"
      onPress={() => onPress(environmentId)}
      className="mx-4 mb-2.5 flex-row items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-80"
    >
      <View className="flex-1 flex-row items-center gap-3">
        <View className="size-9 items-center justify-center rounded-xl bg-subtle">
          <SymbolView name="robot" size={18} tintColorClassName="accent-primary-text" />
        </View>
        <View className="flex-1 gap-0.5">
          <Text textRole="body" className="font-t3-semibold text-foreground">
            常驻 Bot 集群
          </Text>
          <Text textRole="caption" className="text-foreground-muted" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>

      <View className="flex-row items-center gap-2">
        {needsYouCount > 0 ? (
          <View className="rounded-full border border-warning-border bg-warning px-2 py-0.5">
            <Text textRole="caption" className="font-t3-medium text-foreground">
              待拍板 {needsYouCount}
            </Text>
          </View>
        ) : null}
        <SymbolView name="chevron.right" size={14} tintColorClassName="accent-icon-muted" />
      </View>
    </Pressable>
  );
}
