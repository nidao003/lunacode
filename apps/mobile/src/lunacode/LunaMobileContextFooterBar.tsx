import {
  formatCountdownClock,
  formatPercent2,
  formatTokenCompact,
} from "@t3tools/client-runtime/lunacode/context-telemetry";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { useVisibleSecondClock } from "../features/threads/use-visible-second-clock";
import { useNowMinuteMs } from "../lib/clock";
import { LunaMobileContextInspectorModal } from "./LunaMobileContextInspectorModal";
import { LunaMobileMemoryModal } from "./LunaMobileMemoryModal";
import type { LunaMobileThreadContextProps } from "./styles";
import { useLunaMobilePreferences } from "./useLunaMobilePreferences";

export function LunaMobileContextFooterBar(props: {
  readonly context: LunaMobileThreadContextProps;
  readonly canOperateThread: boolean;
  readonly hasCompactableConversation: boolean;
}) {
  const { context } = props;
  const { telemetry, providerDriver, isCompacting } = context;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [preferences] = useLunaMobilePreferences();

  const expiresAtMs = telemetry.promptCacheExpiresAtMs;
  const baseNowMs = useNowMinuteMs();
  const shouldTickSecond =
    inspectorOpen || (expiresAtMs !== null && baseNowMs < expiresAtMs + 600_000);
  const nowMs = useVisibleSecondClock(shouldTickSecond);

  const modelKey = telemetry.model ?? "__default__";
  const thresholdK = preferences.modelAlertThresholdsK[modelKey] ?? null;
  const thresholdExceeded = thresholdK !== null && telemetry.usedTokens >= thresholdK * 1000;
  const remainingCacheMs = expiresAtMs !== null ? expiresAtMs - nowMs : null;

  const canCompact =
    props.canOperateThread &&
    !isCompacting &&
    props.hasCompactableConversation &&
    (providerDriver === "codex" || providerDriver === "claudeAgent");

  const compactDisabledReason = isCompacting
    ? "正在压缩中"
    : !props.canOperateThread
      ? "当前连接无操作权限"
      : providerDriver !== "codex" && providerDriver !== "claudeAgent"
        ? "当前 Provider 暂不支持 /compact"
        : !props.hasCompactableConversation
          ? "暂无可压缩对话"
          : null;

  const contextLabel =
    telemetry.usedPercent !== null
      ? `上下文 ${formatPercent2(telemetry.usedPercent)}`
      : telemetry.usedTokens > 0
        ? `上下文 ${formatTokenCompact(telemetry.usedTokens)}`
        : "上下文 -";

  const hitLabel =
    telemetry.latestCall.totalInputTokens > 0
      ? `命中 ${formatPercent2(telemetry.latestCall.hitRatePercent)}`
      : "命中 -";

  const handleCompactPress = () => {
    if (!canCompact) return;
    if (providerDriver === "claudeAgent" && preferences.compactTemplateEnabled) {
      context.onCompactContext(preferences.compactTemplateText);
      return;
    }
    context.onCompactContext();
  };

  return (
    <View className="mb-1.5 flex-row items-center gap-1.5 px-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查看上下文与缓存透视详情"
        onPress={() => setInspectorOpen(true)}
        className={
          thresholdExceeded
            ? "min-w-0 flex-1 flex-row items-center gap-1.5 rounded-full border border-warning-border bg-warning px-2.5 py-1 active:opacity-75"
            : "min-w-0 flex-1 flex-row items-center gap-1.5 rounded-full border border-border-subtle bg-grouped-card px-2.5 py-1 active:opacity-75"
        }
      >
        <Text
          numberOfLines={1}
          className={
            thresholdExceeded
              ? "min-w-0 flex-1 font-mono text-3xs tabular-nums text-warning-foreground"
              : "min-w-0 flex-1 font-mono text-3xs tabular-nums text-foreground-muted"
          }
        >
          {contextLabel} · {hitLabel}
        </Text>
        {remainingCacheMs !== null && remainingCacheMs > 0 ? (
          <View className="rounded bg-adaptive-emerald-500-a12-a16 px-1.5 py-0.5">
            <Text className="font-mono text-3xs tabular-nums text-adaptive-emerald-700-300">
              {formatCountdownClock(remainingCacheMs)}
            </Text>
          </View>
        ) : remainingCacheMs !== null && remainingCacheMs > -600_000 ? (
          <View className="rounded bg-subtle px-1.5 py-0.5">
            <Text className="text-3xs text-foreground-muted">已冷却</Text>
          </View>
        ) : null}
        {thresholdExceeded ? (
          <Text className="text-xs font-t3-bold text-warning-foreground">!</Text>
        ) : null}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="压缩当前会话"
        disabled={!canCompact}
        onPress={handleCompactPress}
        className={
          canCompact
            ? "shrink-0 rounded-full border border-border-subtle bg-grouped-card px-2.5 py-1 active:opacity-75"
            : "shrink-0 rounded-full border border-border-subtle bg-subtle px-2.5 py-1 opacity-45"
        }
      >
        <Text className="text-3xs font-t3-medium text-foreground">
          {isCompacting ? "压缩中" : "压缩"}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="打开 OpenViking 云端记忆"
        onPress={() => setMemoryOpen(true)}
        className="shrink-0 rounded-full border border-border-subtle bg-grouped-card px-2.5 py-1 active:opacity-75"
      >
        <Text className="text-3xs font-t3-medium text-foreground">记忆</Text>
      </Pressable>

      <LunaMobileContextInspectorModal
        visible={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        telemetry={telemetry}
        cacheNowMs={nowMs}
        canCompact={canCompact}
        compactDisabledReason={compactDisabledReason}
        providerDriver={providerDriver}
        onCompactContext={context.onCompactContext}
        onBuildHandoff={context.onBuildHandoff}
        onOpenHandoffThread={context.onOpenHandoffThread}
      />

      <LunaMobileMemoryModal
        visible={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        getCurrentPrompt={context.getCurrentPrompt}
        onAppendToPrompt={context.onAppendToPrompt}
        defaultTitle={context.threadTitle}
        latestAssistantText={context.latestAssistantText}
        onBuildHandoff={context.onBuildHandoff}
      />
    </View>
  );
}
