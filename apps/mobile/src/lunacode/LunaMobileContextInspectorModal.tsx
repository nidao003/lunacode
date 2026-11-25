import {
  formatCountdownClock,
  formatDurationZh,
  formatPercent2,
  formatTokenCompact,
  formatUsdRange,
  type LunaContextTelemetry,
} from "@t3tools/client-runtime/lunacode/context-telemetry";
import type { DeterministicHandoffResult } from "@t3tools/client-runtime/lunacode/handoff-builder";
import { DEFAULT_COMPACT_TEMPLATE_TEXT } from "@t3tools/client-runtime/lunacode/preferences";
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { ThemedSwitch } from "../components/ui/ThemedSwitch";
import { compositionSegmentColor } from "./styles";
import { useLunaMobilePreferences } from "./useLunaMobilePreferences";

export function LunaMobileContextInspectorModal(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly telemetry: LunaContextTelemetry;
  readonly cacheNowMs: number;
  readonly canCompact: boolean;
  readonly compactDisabledReason?: string | null;
  readonly providerDriver?: ProviderDriverKind | null | undefined;
  readonly onCompactContext: (instructions?: string) => void;
  readonly onBuildHandoff?: (() => DeterministicHandoffResult) | undefined;
  readonly onOpenHandoffThread?: ((markdown: string) => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const [preferences, updatePreferences] = useLunaMobilePreferences();
  const modelKey = props.telemetry.model ?? "__default__";
  const savedThresholdK = preferences.modelAlertThresholdsK[modelKey] ?? null;

  const [thresholdDraft, setThresholdDraft] = useState<{
    readonly modelKey: string;
    readonly value: string;
  } | null>(null);
  const [pricingExpanded, setPricingExpanded] = useState(false);
  const [handoffPreview, setHandoffPreview] = useState<DeterministicHandoffResult | null>(null);
  const [handoffCopied, setHandoffCopied] = useState(false);

  const inputThresholdValue =
    thresholdDraft?.modelKey === modelKey
      ? thresholdDraft.value
      : savedThresholdK !== null
        ? String(savedThresholdK)
        : "";

  const thresholdTokens = savedThresholdK !== null ? savedThresholdK * 1000 : null;
  const thresholdExceeded =
    thresholdTokens !== null && props.telemetry.usedTokens >= thresholdTokens;

  const usedPct = props.telemetry.usedPercent ?? 0;
  const barColorClass =
    usedPct >= 90
      ? "bg-red-500"
      : usedPct >= 75 || thresholdExceeded
        ? "bg-amber-500"
        : "bg-emerald-500";

  const latestTurn = props.telemetry.recentTurns[0] ?? null;
  const cacheRemainingMs =
    props.telemetry.promptCacheExpiresAtMs !== null
      ? props.telemetry.promptCacheExpiresAtMs - props.cacheNowMs
      : null;

  const supportsStructuredCompact = props.providerDriver === "claudeAgent";

  const handleSaveThreshold = () => {
    const parsed = Number.parseFloat(inputThresholdValue.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      updatePreferences((curr) => {
        const nextMap = { ...curr.modelAlertThresholdsK };
        delete nextMap[modelKey];
        return { ...curr, modelAlertThresholdsK: nextMap };
      });
      setThresholdDraft(null);
      return;
    }
    const rounded = Math.max(1, Math.round(parsed));
    updatePreferences((curr) => ({
      ...curr,
      modelAlertThresholdsK: {
        ...curr.modelAlertThresholdsK,
        [modelKey]: rounded,
      },
    }));
    setThresholdDraft(null);
  };

  const handleClearThreshold = () => {
    updatePreferences((curr) => {
      const nextMap = { ...curr.modelAlertThresholdsK };
      delete nextMap[modelKey];
      return { ...curr, modelAlertThresholdsK: nextMap };
    });
    setThresholdDraft({ modelKey, value: "" });
  };

  const handleCopyHandoff = () => {
    if (!handoffPreview) return;
    void Clipboard.setStringAsync(handoffPreview.markdown).then(
      () => setHandoffCopied(true),
      () => setHandoffCopied(false),
    );
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-screen"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
      >
        <View className="gap-2 border-b border-border-subtle px-5 py-4">
          <View className="flex-row items-start justify-between gap-3">
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-lg font-t3-bold text-foreground">会话缓存与上下文</Text>
              <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={2}>
                {props.telemetry.model ?? "当前模型未知"} · 纯本地只读统计（不消耗额外 Token）
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭上下文透视面板"
              hitSlop={10}
              onPress={props.onClose}
              className="size-8 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              <SymbolView
                name="xmark"
                size={14}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            </Pressable>
          </View>

          {cacheRemainingMs !== null ? (
            <View
              className={
                cacheRemainingMs > 0
                  ? "self-start rounded-full border border-border-subtle bg-adaptive-emerald-500-a12-a16 px-2.5 py-0.5"
                  : "self-start rounded-full border border-border-subtle bg-subtle px-2.5 py-0.5"
              }
            >
              <Text
                className={
                  cacheRemainingMs > 0
                    ? "font-mono text-2xs tabular-nums text-adaptive-emerald-700-300"
                    : "font-mono text-2xs text-foreground-muted"
                }
              >
                {cacheRemainingMs > 0
                  ? `缓存余温 ${formatCountdownClock(cacheRemainingMs)}`
                  : "缓存余温已冷却"}
              </Text>
            </View>
          ) : null}
        </View>

        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) + 20 }}
        >
          {/* 当前上下文占用与提醒线 */}
          <View className="gap-3 rounded-[22px] border border-border-subtle bg-grouped-card p-4">
            <View className="flex-row items-baseline justify-between gap-2">
              <View className="flex-row items-baseline gap-2">
                <Text className="text-sm font-t3-medium text-foreground">当前上下文</Text>
                <Text className="font-mono text-base font-t3-bold tabular-nums text-foreground">
                  {formatTokenCompact(props.telemetry.usedTokens)}
                </Text>
              </View>
              <Text className="font-mono text-2xs tabular-nums text-foreground-muted">
                {props.telemetry.maxTokens !== null
                  ? `${formatTokenCompact(props.telemetry.maxTokens)} · ${formatPercent2(props.telemetry.usedPercent)}`
                  : "容量未知"}
              </Text>
            </View>

            <View className="h-2.5 w-full overflow-hidden rounded-full bg-subtle">
              <View
                className={`h-full rounded-full ${barColorClass}`}
                style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
              />
            </View>

            <View className="gap-1">
              <Text className="text-xs text-foreground-muted">
                {props.telemetry.remainingTokens !== null
                  ? `剩余 ${formatTokenCompact(props.telemetry.remainingTokens)} tokens`
                  : "剩余空间取决于模型上下文上限"}
                {props.telemetry.autoCompactThreshold !== null
                  ? ` · 上游自动压缩线 ${formatTokenCompact(props.telemetry.autoCompactThreshold)}`
                  : ""}
              </Text>
              {thresholdExceeded && thresholdTokens !== null ? (
                <Text className="text-xs font-t3-medium text-warning-foreground">
                  已超过自定义提醒线 ({formatTokenCompact(thresholdTokens)})
                </Text>
              ) : null}
            </View>

            <View className="flex-row flex-wrap items-center gap-2 border-t border-border-subtle pt-2.5">
              <Text className="text-xs text-foreground-muted">此模型提醒线 (K tokens)</Text>
              <TextInput
                accessibilityLabel="模型上下文提醒阈值（千 tokens）"
                keyboardType="number-pad"
                placeholder="关闭"
                placeholderTextColorClassName="accent-foreground-muted"
                value={inputThresholdValue}
                onChangeText={(value) => setThresholdDraft({ modelKey, value })}
                onSubmitEditing={handleSaveThreshold}
                className="w-24 rounded-lg border border-border-subtle bg-input px-2.5 py-1.5 font-mono text-xs tabular-nums text-foreground"
              />
              <Pressable
                accessibilityRole="button"
                onPress={handleSaveThreshold}
                className="rounded-full bg-secondary px-3 py-1.5 active:opacity-70"
              >
                <Text className="text-xs font-t3-medium text-foreground">保存</Text>
              </Pressable>
              {savedThresholdK !== null ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={handleClearThreshold}
                  className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
                >
                  <Text className="text-xs text-foreground-muted">关闭提醒</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* 输入缓存 */}
          <View className="gap-2.5 rounded-[22px] border border-border-subtle bg-grouped-card p-4">
            <Text className="text-sm font-t3-bold text-foreground">输入缓存</Text>
            <View className="gap-2 rounded-2xl border border-border-subtle bg-card p-3">
              <View className="flex-row items-center justify-between gap-2">
                <Text className="text-xs text-foreground-muted">最近一次调用</Text>
                <Text className="font-mono text-xs tabular-nums text-foreground">
                  {props.telemetry.latestCall.totalInputTokens > 0
                    ? `${formatTokenCompact(props.telemetry.latestCall.cachedTokens)} / ${formatTokenCompact(props.telemetry.latestCall.totalInputTokens)} (${formatPercent2(props.telemetry.latestCall.hitRatePercent)})`
                    : "-"}
                </Text>
              </View>
              {latestTurn ? (
                <View className="flex-row items-center justify-between gap-2 border-t border-border-subtle pt-2">
                  <Text className="text-xs text-foreground-muted">
                    第 {latestTurn.turnNumber} 轮合计
                  </Text>
                  <Text className="font-mono text-xs tabular-nums text-foreground">
                    {formatTokenCompact(latestTurn.cachedTokens)} /{" "}
                    {formatTokenCompact(latestTurn.totalInputTokens)} (
                    {formatPercent2(latestTurn.hitRatePercent)})
                  </Text>
                </View>
              ) : null}
            </View>
            {latestTurn ? (
              <Text className="text-xs text-foreground-muted">
                第 {latestTurn.turnNumber} 轮总输出 {formatTokenCompact(latestTurn.outputTokens)}{" "}
                tokens
                {latestTurn.tokensPerSecond !== null
                  ? `，均速 ${latestTurn.tokensPerSecond.toFixed(1)} tok/s`
                  : ""}
                。
              </Text>
            ) : null}
          </View>

          {/* 会话用量与 API 参考费用 */}
          <View className="gap-3 rounded-[22px] border border-border-subtle bg-grouped-card p-4">
            <View className="flex-row flex-wrap items-baseline justify-between gap-2">
              <Text className="text-sm font-t3-bold text-foreground">会话用量与费用</Text>
              <Text className="text-2xs tabular-nums text-foreground-muted">
                完成 {props.telemetry.sessionTotals.completedTurnCount} 轮 · 总命中{" "}
                {formatPercent2(props.telemetry.sessionTotals.hitRatePercent)}
              </Text>
            </View>

            <View className="flex-row flex-wrap gap-2">
              <View className="min-w-[46%] flex-1 gap-1 rounded-2xl border border-border-subtle bg-card p-3">
                <Text className="text-2xs text-foreground-muted">总输入</Text>
                <Text className="font-mono text-base font-t3-bold tabular-nums text-foreground">
                  {formatTokenCompact(props.telemetry.sessionTotals.totalInputTokens)}
                </Text>
              </View>
              <View className="min-w-[46%] flex-1 gap-1 rounded-2xl border border-border-subtle bg-card p-3">
                <Text className="text-2xs text-foreground-muted">缓存读取</Text>
                <Text className="font-mono text-base font-t3-bold tabular-nums text-foreground">
                  {formatTokenCompact(props.telemetry.sessionTotals.totalCachedTokens)}
                </Text>
              </View>
              <View className="min-w-[46%] flex-1 gap-1 rounded-2xl border border-border-subtle bg-card p-3">
                <Text className="text-2xs text-foreground-muted">输出</Text>
                <Text className="font-mono text-base font-t3-bold tabular-nums text-foreground">
                  {formatTokenCompact(props.telemetry.sessionTotals.totalOutputTokens)}
                </Text>
              </View>
              <View className="min-w-[46%] flex-1 gap-1 rounded-2xl border border-border-subtle bg-card p-3">
                <Text className="text-2xs text-foreground-muted">API 参考费用</Text>
                <Text className="font-mono text-base font-t3-bold tabular-nums text-foreground">
                  {formatUsdRange(props.telemetry.estimatedApiCost)}
                </Text>
              </View>
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={() => setPricingExpanded((curr) => !curr)}
              className="flex-row items-center justify-between py-0.5 active:opacity-70"
            >
              <Text className="text-2xs text-foreground-muted">
                参考单价（美元 / 1M tokens，订阅不按此扣费）
              </Text>
              <SymbolView
                name={pricingExpanded ? "chevron.up" : "chevron.down"}
                size={11}
                tintColorClassName="accent-icon-subtle"
                type="monochrome"
              />
            </Pressable>
            {pricingExpanded ? (
              <View className="rounded-xl border border-border-subtle bg-card px-3 py-2">
                <Text className="font-mono text-2xs text-foreground-muted">
                  {props.telemetry.estimatedApiCost.known
                    ? `${props.telemetry.estimatedApiCost.label}：输入 $${props.telemetry.estimatedApiCost.inputPerM.toFixed(2)} / 缓存读取 $${props.telemetry.estimatedApiCost.cachedInputPerM.toFixed(2)} / 输出 $${props.telemetry.estimatedApiCost.outputPerM.toFixed(2)}`
                    : `当前模型 (${props.telemetry.model ?? "未知"}) 暂无内置参考单价。`}
                </Text>
              </View>
            ) : null}
          </View>

          {/* 上下文构成估算 */}
          <View className="gap-2.5 rounded-[22px] border border-border-subtle bg-grouped-card p-4">
            <Text className="text-sm font-t3-bold text-foreground">上下文构成估算</Text>
            <Text className="text-2xs text-foreground-muted">
              按可见消息与工具项长度本地估算（系统提示词未单独拆分）
            </Text>

            <View className="h-3 w-full flex-row overflow-hidden rounded-full bg-subtle">
              {props.telemetry.compositionBreakdown.map((seg) =>
                seg.percent > 0 ? (
                  <View
                    key={seg.key}
                    style={{
                      width: `${seg.percent}%`,
                      backgroundColor: compositionSegmentColor(seg.key),
                    }}
                  />
                ) : null,
              )}
            </View>

            <View className="flex-row flex-wrap gap-x-4 gap-y-1.5">
              {props.telemetry.compositionBreakdown.map((seg) => (
                <View key={seg.key} className="flex-row items-center gap-1.5">
                  <View
                    className="size-2 rounded-full"
                    style={{ backgroundColor: compositionSegmentColor(seg.key) }}
                  />
                  <Text className="text-xs text-foreground-muted">{seg.label}</Text>
                  <Text className="font-mono text-xs tabular-nums text-foreground">
                    {seg.percent.toFixed(1)}%
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* 压缩与合规结构化接力 (LUNA-005) */}
          <View className="gap-3 rounded-[22px] border border-border-subtle bg-grouped-card p-4">
            <View className="gap-2">
              <Text className="text-sm font-t3-bold text-foreground">压缩与结构化接力</Text>
              <View className="flex-row flex-wrap items-center gap-2">
                <Pressable
                  accessibilityRole="button"
                  disabled={!props.canCompact}
                  onPress={() => {
                    props.onClose();
                    props.onCompactContext();
                  }}
                  className="min-h-9 items-center justify-center rounded-full bg-primary px-4 active:opacity-80 disabled:opacity-45"
                >
                  <Text className="text-xs font-t3-medium text-primary-foreground">
                    执行原生 /compact
                  </Text>
                </Pressable>
                {supportsStructuredCompact ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!props.canCompact || !preferences.compactTemplateEnabled}
                    onPress={() => {
                      props.onClose();
                      props.onCompactContext(preferences.compactTemplateText);
                    }}
                    className="min-h-9 items-center justify-center rounded-full border border-border bg-card px-4 active:opacity-75 disabled:opacity-45"
                  >
                    <Text className="text-xs font-t3-medium text-foreground">按模板压缩</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>

            <Text className="text-xs text-foreground-muted">
              {props.telemetry.compactionSavings.count > 0
                ? `已记录 ${props.telemetry.compactionSavings.count} 次压缩，最近释放 ${formatTokenCompact(props.telemetry.compactionSavings.lastSavedTokens)} tokens，累计释放 ${formatTokenCompact(props.telemetry.compactionSavings.totalSavedTokens)} tokens。`
                : props.compactDisabledReason
                  ? `当前记录中暂无已完成压缩（${props.compactDisabledReason}）。`
                  : "当前记录中暂无已完成压缩。"}
            </Text>

            {supportsStructuredCompact ? (
              <View className="gap-2.5 rounded-2xl border border-border-subtle bg-card p-3">
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="min-w-0 flex-1 text-xs font-t3-medium text-foreground">
                    附带自定义保留重点模板（默认关闭以保护原生压缩质量）
                  </Text>
                  <ThemedSwitch
                    accessibilityLabel="附带自定义保留重点模板"
                    value={preferences.compactTemplateEnabled}
                    onValueChange={(enabled) =>
                      updatePreferences((curr) => ({
                        ...curr,
                        compactTemplateEnabled: enabled,
                      }))
                    }
                  />
                </View>
                <TextInput
                  multiline
                  numberOfLines={2}
                  maxLength={300}
                  value={preferences.compactTemplateText}
                  onChangeText={(value) =>
                    updatePreferences((curr) => ({
                      ...curr,
                      compactTemplateText: value.slice(0, 300),
                    }))
                  }
                  textAlignVertical="top"
                  className="min-h-[60px] rounded-xl border border-border-subtle bg-input px-3 py-2 text-xs text-foreground"
                />
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    updatePreferences((curr) => ({
                      ...curr,
                      compactTemplateText: DEFAULT_COMPACT_TEMPLATE_TEXT,
                    }))
                  }
                  className="self-start rounded-full bg-subtle px-3 py-1 active:opacity-70"
                >
                  <Text className="text-2xs font-t3-medium text-foreground-muted">恢复默认</Text>
                </Pressable>
              </View>
            ) : (
              <Text className="text-xs text-foreground-muted">
                当前 Provider 原生压缩接口不接受自定义指令，将直接触发官方原生 /compact。
              </Text>
            )}

            {props.onBuildHandoff ? (
              <View className="gap-2.5 rounded-2xl border border-border-subtle bg-card p-3">
                <View className="flex-row flex-wrap items-center justify-between gap-2">
                  <Text className="text-xs font-t3-bold text-foreground">
                    确定性结构化接力（开新窗 · 0 Token）
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setHandoffCopied(false);
                      setHandoffPreview(props.onBuildHandoff?.() ?? null);
                    }}
                    className="rounded-full bg-secondary px-3 py-1.5 active:opacity-75"
                  >
                    <Text className="text-xs font-t3-medium text-foreground">
                      {handoffPreview ? "重新生成接力包" : "生成接力包"}
                    </Text>
                  </Pressable>
                </View>
                <Text className="text-2xs text-foreground-muted">
                  纯前端提取原始目标、改动文件、失败命令与待办计划（上限 3000 字符），不调用模型。
                </Text>

                {handoffPreview ? (
                  <View className="gap-2.5">
                    <Text className="font-mono text-2xs tabular-nums text-foreground-muted">
                      {handoffPreview.charCount} 字符 · 约 {handoffPreview.estimatedTokens} tokens ·
                      文件 {handoffPreview.stats.filesCount} 个
                    </Text>
                    <View className="flex-row flex-wrap items-center gap-2">
                      <Pressable
                        accessibilityRole="button"
                        onPress={handleCopyHandoff}
                        className="rounded-full border border-border bg-grouped-card px-3.5 py-1.5 active:opacity-75"
                      >
                        <Text className="text-xs font-t3-medium text-foreground">
                          {handoffCopied ? "已复制" : "复制接力包"}
                        </Text>
                      </Pressable>
                      {props.onOpenHandoffThread ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            props.onClose();
                            props.onOpenHandoffThread?.(handoffPreview.markdown);
                          }}
                          className="rounded-full bg-primary px-3.5 py-1.5 active:opacity-80"
                        >
                          <Text className="text-xs font-t3-medium text-primary-foreground">
                            在新会话中继续
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    <ScrollView
                      nestedScrollEnabled
                      className="max-h-48 rounded-xl border border-border-subtle bg-grouped-card p-3"
                    >
                      <Text selectable className="font-mono text-2xs text-foreground">
                        {handoffPreview.markdown}
                      </Text>
                    </ScrollView>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>

          {/* 最近对话轮次 */}
          <View className="gap-2.5 rounded-[22px] border border-border-subtle bg-grouped-card p-4">
            <Text className="text-sm font-t3-bold text-foreground">最近对话轮次</Text>
            {props.telemetry.recentTurns.length === 0 ? (
              <Text className="text-xs text-foreground-muted">暂无已完成轮次的用量记录。</Text>
            ) : (
              <View className="gap-2">
                {props.telemetry.recentTurns.slice(0, 12).map((turn) => (
                  <View
                    key={turn.turnId}
                    className="gap-1 rounded-2xl border border-border-subtle bg-card px-3 py-2.5"
                  >
                    <View className="flex-row items-center justify-between gap-2">
                      <Text className="text-xs font-t3-medium text-foreground">
                        #{turn.turnNumber} 对话
                        {turn.completedAtMs !== null
                          ? ` · ${new Date(turn.completedAtMs).toLocaleTimeString()}`
                          : ""}
                      </Text>
                      <Text className="font-mono text-xs font-t3-bold tabular-nums text-foreground">
                        命中 {formatPercent2(turn.hitRatePercent)}
                      </Text>
                    </View>
                    <View className="flex-row flex-wrap items-center justify-between gap-2">
                      <Text className="font-mono text-2xs tabular-nums text-foreground-muted">
                        缓存 {formatTokenCompact(turn.cachedTokens)} / 输入{" "}
                        {formatTokenCompact(turn.totalInputTokens)}
                      </Text>
                      <Text className="font-mono text-2xs tabular-nums text-foreground-tertiary">
                        {turn.tokensPerSecond !== null
                          ? `${turn.tokensPerSecond.toFixed(1)} tok/s`
                          : "-"}
                        {turn.gapSincePreviousMs !== null
                          ? ` · 间隔 ${formatDurationZh(turn.gapSincePreviousMs)}`
                          : ""}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
