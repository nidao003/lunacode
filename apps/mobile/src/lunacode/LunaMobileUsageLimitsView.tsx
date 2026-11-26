import { useNavigation } from "@react-navigation/native";
import { maskAccountEmail } from "@t3tools/client-runtime/lunacode/multi-account";
import { formatSubscriptionTierBadge } from "@t3tools/client-runtime/lunacode/subscription-tier";
import {
  type AccountQuotaHealth,
  formatCheckedAtAgo,
  formatCompactResetCountdown,
  orderAccountWindows,
  shortenQuotaWindowLabel,
  sortLimitAccountsForCards,
  summarizeAccountQuotaHealth,
} from "@t3tools/client-runtime/lunacode/usage-limits-view";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import type { ServerProviderUsageWindow, UsageProviderKind } from "@t3tools/contracts";
import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../components/ProviderIcon";
import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { ResetCredits } from "../features/usage/UsageLimitsSection";
import { usageProviderKind } from "../features/usage/usageProviders";
import { quotaHealthClasses, subscriptionTierBadgeClasses } from "./styles";

export type LunaMobileUsageLimitsViewMode = "accounts" | "pooled";

function healthBadgeLabel(
  status: AccountQuotaHealth,
  minRemaining: number | null,
  exhaustedCount: number,
): string {
  switch (status) {
    case "critical":
      return exhaustedCount > 1 ? `已耗尽 ${exhaustedCount} 项` : "存在 0% 耗尽";
    case "caution":
      return minRemaining !== null ? `最低余量 ${minRemaining}%` : "余量偏低";
    case "healthy":
      return minRemaining === 100 ? "全部充裕" : `最低余量 ${minRemaining ?? 100}%`;
    case "unavailable":
      return "暂不可读";
  }
}

export function LunaMobileUsageLimitsToolbar(props: {
  readonly multiAccountPoolCount: number;
  readonly totalAccounts: number;
  readonly viewMode: LunaMobileUsageLimitsViewMode;
  readonly onViewModeChange: (mode: LunaMobileUsageLimitsViewMode) => void;
  readonly maskEmails: boolean;
  readonly onMaskEmailsChange: (masked: boolean) => void;
}) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-border-subtle bg-grouped-card px-3.5 py-3">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="text-sm font-t3-medium text-foreground">多账号配额视图</Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {props.multiAccountPoolCount} 个多账号驱动 · {props.totalAccounts} 个账号
        </Text>
      </View>

      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-row rounded-full border border-border-subtle bg-card p-0.5">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.viewMode === "accounts" }}
            onPress={() => props.onViewModeChange("accounts")}
            className={
              props.viewMode === "accounts"
                ? "rounded-full bg-primary px-3 py-1"
                : "rounded-full px-3 py-1"
            }
          >
            <Text
              className={
                props.viewMode === "accounts"
                  ? "text-xs font-t3-medium text-primary-foreground"
                  : "text-xs text-foreground-muted"
              }
            >
              按账号卡片
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.viewMode === "pooled" }}
            onPress={() => props.onViewModeChange("pooled")}
            className={
              props.viewMode === "pooled"
                ? "rounded-full bg-primary px-3 py-1"
                : "rounded-full px-3 py-1"
            }
          >
            <Text
              className={
                props.viewMode === "pooled"
                  ? "text-xs font-t3-medium text-primary-foreground"
                  : "text-xs text-foreground-muted"
              }
            >
              合并池视图
            </Text>
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => props.onMaskEmailsChange(!props.maskEmails)}
          className="rounded-full border border-border-subtle bg-card px-3 py-1 active:opacity-70"
        >
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {props.maskEmails ? "显示邮箱" : "隐藏邮箱"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function AggregateWindowPill(props: { readonly poolWindow: LimitPoolWindow }) {
  const pct = props.poolWindow.remainingPercent;
  const tone = quotaHealthClasses(pct <= 0 ? "critical" : pct <= 20 ? "caution" : "healthy");
  return (
    <View className="flex-row items-center gap-1 rounded-lg border border-border-subtle bg-grouped-card px-2 py-1">
      <Text className="text-2xs text-foreground-muted">
        {shortenQuotaWindowLabel(
          props.poolWindow.label,
          props.poolWindow.kind,
          props.poolWindow.id,
        )}
      </Text>
      <Text
        className={`text-2xs font-t3-bold tabular-nums ${
          pct > 20 ? "text-foreground" : tone.badgeText
        }`}
      >
        {pct}%
      </Text>
    </View>
  );
}

function AccountWindowRow(props: {
  readonly window: ServerProviderUsageWindow;
  readonly accentColor: string | null;
  readonly now: number;
}) {
  const left = remainingPercent(props.window);
  const used = Math.round(props.window.usedPercent);
  const timeLeft = paceRemainingPercent(props.window, props.now);
  const pace = paceOf(props.window, props.now);
  const compactReset = formatCompactResetCountdown(props.window, props.now);
  const fillColorClass = left <= 10 ? "bg-red-500" : left <= 30 ? "bg-amber-500" : "bg-foreground";
  const paceText =
    pace === "ahead"
      ? "快于节奏"
      : pace === "under"
        ? "慢于节奏"
        : pace === "on"
          ? "节奏一致"
          : null;

  return (
    <View className="gap-1.5 rounded-2xl border border-border-subtle bg-card px-3 py-2.5">
      <View className="flex-row items-baseline justify-between gap-2">
        <Text className="min-w-0 flex-1 text-xs font-t3-medium text-foreground" numberOfLines={1}>
          {shortenQuotaWindowLabel(props.window.label, props.window.kind, props.window.id)}
        </Text>
        <Text
          className={`text-xs font-t3-bold tabular-nums ${
            left <= 0
              ? "text-danger-foreground"
              : left <= 20
                ? "text-warning-foreground"
                : "text-foreground"
          }`}
        >
          剩余 {left}%
        </Text>
      </View>

      <View className="relative h-2 w-full overflow-hidden rounded-full bg-subtle">
        <View
          className={`h-full rounded-full ${fillColorClass}`}
          style={{
            width: `${left}%`,
            ...(left > 30 && props.accentColor ? { backgroundColor: props.accentColor } : {}),
          }}
        />
        {timeLeft !== null ? (
          <View
            pointerEvents="none"
            className="absolute top-0 bottom-0 w-0.5 rounded-full bg-foreground"
            style={{ left: `${timeLeft}%` }}
          />
        ) : null}
      </View>

      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-3xs tabular-nums text-foreground-muted">
          {compactReset ? `↻ ${compactReset}` : "无重置倒计时"}
          {paceText ? ` · ${paceText}` : ""}
        </Text>
        <Text className="text-3xs tabular-nums text-foreground-tertiary">已用 {used}%</Text>
      </View>
    </View>
  );
}

function AccountQuotaCard(props: {
  readonly pool: LimitPool;
  readonly account: LimitAccount;
  readonly driverLabel: string;
  readonly fallbackColor: string | null;
  readonly maskEmails: boolean;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  const navigation = useNavigation();
  const orderedWindows = orderAccountWindows(props.account.limits.windows ?? []);
  const health = summarizeAccountQuotaHealth(orderedWindows, props.account.limits.unavailable);
  const healthTone = quotaHealthClasses(health.status);
  const accentColor =
    normalizeProviderAccentColor(props.account.accentColor) ?? props.fallbackColor;

  const visibleEmail = props.account.email
    ? props.maskEmails
      ? maskAccountEmail(props.account.email)
      : props.account.email
    : null;
  const primaryTitle =
    props.account.displayName ??
    props.account.sourceLabel ??
    visibleEmail ??
    `${props.driverLabel} 账号`;
  const secondaryParts = [
    visibleEmail && visibleEmail !== primaryTitle ? visibleEmail : null,
    props.account.sourceLabel && props.account.sourceLabel !== primaryTitle
      ? props.account.sourceLabel
      : null,
    props.account.environments.length > 0
      ? props.account.environments.map((env) => env.label).join(", ")
      : null,
  ].filter(Boolean);

  const tierBadge = formatSubscriptionTierBadge(props.account.plan);
  const updatedAgo = props.account.limits.checkedAt
    ? formatCheckedAtAgo(props.account.limits.checkedAt, props.now)
    : null;

  const firstWindow = orderedWindows[0];
  const openAccountDetail = firstWindow
    ? () =>
        navigation.navigate("SettingsUsageAccount", {
          accountKey: props.account.key,
          windowId: firstWindow.id,
          windowKind: firstWindow.kind,
          environmentIds: props.environmentIds,
        })
    : undefined;

  return (
    <View
      className={
        health.status === "critical"
          ? "gap-2.5 rounded-[22px] border border-danger-border bg-grouped-card p-3.5"
          : "gap-2.5 rounded-[22px] border border-border-subtle bg-grouped-card p-3.5"
      }
    >
      <Pressable
        accessibilityRole={openAccountDetail ? "button" : undefined}
        disabled={!openAccountDetail}
        onPress={openAccountDetail}
        className="flex-row items-start justify-between gap-2 active:opacity-75"
      >
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <ProviderIcon provider={props.pool.driver} size={18} />
          <View className="min-w-0 flex-1 gap-0.5">
            <View className="flex-row flex-wrap items-center gap-1.5">
              <Text className="shrink text-sm font-t3-bold text-foreground" numberOfLines={1}>
                {primaryTitle}
              </Text>
              {tierBadge ? (
                <View
                  className={`rounded-md px-1.5 py-0.5 ${subscriptionTierBadgeClasses(tierBadge.tone).container}`}
                >
                  <Text
                    className={`text-3xs font-t3-medium ${subscriptionTierBadgeClasses(tierBadge.tone).text}`}
                  >
                    {tierBadge.shortLabel}
                  </Text>
                </View>
              ) : null}
            </View>
            {secondaryParts.length > 0 ? (
              <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                {secondaryParts.join(" · ")}
              </Text>
            ) : null}
          </View>
        </View>

        <View className="flex-row items-center gap-1.5">
          <View className={`rounded-md px-1.5 py-0.5 ${healthTone.badgeContainer}`}>
            <Text className={`text-3xs font-t3-medium ${healthTone.badgeText}`}>
              {healthBadgeLabel(health.status, health.minRemainingPercent, health.exhaustedCount)}
            </Text>
          </View>
          {openAccountDetail ? (
            <SymbolView
              name="chevron.right"
              size={12}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          ) : null}
        </View>
      </Pressable>

      {orderedWindows.length === 0 ? (
        <View className="rounded-xl border border-dashed border-border bg-card px-3 py-2.5">
          <Text className="text-xs text-foreground-muted">
            {props.account.limits.unavailable?.message ?? "暂未读取到该账号的配额窗口数据。"}
          </Text>
        </View>
      ) : (
        <View className="gap-2">
          {orderedWindows.map((window) => (
            <AccountWindowRow
              key={window.id}
              window={window}
              accentColor={accentColor}
              now={props.now}
            />
          ))}
        </View>
      )}

      {props.account.limits.unavailable?.message && orderedWindows.length > 0 ? (
        <Text className="text-2xs text-warning-foreground">
          最近一次探测失败，当前展示为缓存配额：{props.account.limits.unavailable.message}
        </Text>
      ) : null}

      {updatedAgo ? (
        <View className="flex-row items-center justify-between gap-2 border-t border-border-subtle pt-2">
          <Text className="text-3xs tabular-nums text-foreground-tertiary">
            额度更新于 {updatedAgo}
          </Text>
          {props.account.limits.unavailable?.reason === "probeFailed" ? (
            <Text className="text-3xs text-warning-foreground">刷新失败·展示缓存</Text>
          ) : null}
        </View>
      ) : null}

      {props.account.redeem &&
      props.account.limits.resetCredits &&
      props.account.limits.resetCredits.availableCount > 0 ? (
        <View className="border-t border-border-subtle pt-2">
          <ResetCredits
            environmentId={props.account.redeem.environmentId}
            input={props.account.redeem.input}
            credits={props.account.limits.resetCredits}
            now={props.now}
          />
        </View>
      ) : null}
    </View>
  );
}

export function LunaMobileUsageLimitsView(props: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
  readonly maskEmails: boolean;
  readonly environmentIds: readonly string[] | null;
  readonly colors: Readonly<Record<UsageProviderKind, string>>;
}) {
  return (
    <View className="gap-6">
      {props.pools.map((pool) => {
        const driverLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
        const aggregateWindows = displayLimitWindows(pool);
        const sortedAccounts = sortLimitAccountsForCards(pool.accounts);
        const kind = usageProviderKind(pool.driver);
        const fallbackColor = kind ? props.colors[kind] : null;

        return (
          <View key={pool.driver} className="gap-3">
            <View className="gap-2 px-1">
              <View className="flex-row items-center justify-between gap-2">
                <View className="flex-row items-center gap-2">
                  <ProviderIcon provider={pool.driver} size={18} />
                  <Text className="text-base font-t3-medium text-foreground">{driverLabel}</Text>
                </View>
                <View className="rounded-md border border-border-subtle bg-grouped-card px-2 py-0.5">
                  <Text className="text-3xs tabular-nums text-foreground-muted">
                    {pool.accounts.length} 个账号
                  </Text>
                </View>
              </View>

              {aggregateWindows.length > 0 ? (
                <View className="flex-row flex-wrap items-center gap-1.5">
                  {aggregateWindows.map((poolWindow) => (
                    <AggregateWindowPill
                      key={`${poolWindow.kind}:${poolWindow.id}`}
                      poolWindow={poolWindow}
                    />
                  ))}
                </View>
              ) : null}
            </View>

            <View className="gap-3">
              {sortedAccounts.map((account) => (
                <AccountQuotaCard
                  key={account.key}
                  pool={pool}
                  account={account}
                  driverLabel={driverLabel}
                  fallbackColor={fallbackColor}
                  maskEmails={props.maskEmails}
                  now={props.now}
                  environmentIds={props.environmentIds}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}
