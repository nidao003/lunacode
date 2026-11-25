import { useAtomValue } from "@effect/atom-react";
import { formatSubscriptionTierBadge } from "@t3tools/client-runtime/lunacode/subscription-tier";
import {
  extractCompactQuotaBadges,
  formatCheckedAtAgo,
  summarizeAccountQuotaHealth,
} from "@t3tools/client-runtime/lunacode/usage-limits-view";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../components/ProviderIcon";
import { AppText as Text } from "../components/ui/AppText";
import { useNowMinuteMs } from "../lib/clock";
import { environmentServerConfigsAtom } from "../state/server";
import { quotaHealthClasses, subscriptionTierBadgeClasses } from "./styles";

export function formatMobileAccountPlanDetail(
  plan: string | undefined,
  checkedAt: string | undefined,
  now: number,
): string | undefined {
  const tierBadge = formatSubscriptionTierBadge(plan);
  const planLabel =
    tierBadge && !tierBadge.isGenericAuth ? tierBadge.shortLabel : plan?.trim() || undefined;
  const ago = checkedAt ? formatCheckedAtAgo(checkedAt, now) : null;
  if (planLabel && ago) return `${planLabel} · ${ago}`;
  if (planLabel) return planLabel;
  if (ago) return `更新于 ${ago}`;
  return undefined;
}

export function LunaMobileProviderHeaderBadge(props: {
  readonly environmentId: EnvironmentId | null;
  readonly providerKey: string;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const now = useNowMinuteMs();
  const provider = props.environmentId
    ? configs
        .get(props.environmentId)
        ?.providers.find((entry) => String(entry.instanceId) === props.providerKey)
    : undefined;
  if (!provider) return null;
  return <LunaMobileProviderQuotaPills provider={provider} now={now} />;
}

function siblingTitle(provider: ServerProvider): string {
  return provider.displayName?.trim() || String(provider.instanceId);
}

export function LunaMobileProviderQuotaPills(props: {
  readonly provider: ServerProvider;
  readonly now: number;
}) {
  const tierBadge = formatSubscriptionTierBadge(props.provider.auth.label);
  const badges = extractCompactQuotaBadges(props.provider.usageLimits, props.now, 2);

  if ((!tierBadge || tierBadge.isGenericAuth) && badges.length === 0) {
    return null;
  }

  return (
    <View className="flex-row flex-wrap items-center gap-1">
      {tierBadge && !tierBadge.isGenericAuth ? (
        <View
          className={`rounded-md px-1.5 py-0.5 ${subscriptionTierBadgeClasses(tierBadge.tone).container}`}
        >
          <Text
            className={`text-2xs font-t3-medium ${subscriptionTierBadgeClasses(tierBadge.tone).text}`}
          >
            {tierBadge.shortLabel}
          </Text>
        </View>
      ) : null}
      {badges.map((badge) => {
        const tone = quotaHealthClasses(badge.tone);
        return (
          <View
            key={badge.id}
            className="flex-row items-center gap-1 rounded-md border border-border-subtle bg-subtle px-1.5 py-0.5"
          >
            <Text className="text-2xs text-foreground-muted">{badge.label}</Text>
            <Text
              className={`text-2xs font-t3-bold tabular-nums ${
                badge.tone === "healthy" ? "text-foreground" : tone.badgeText
              }`}
            >
              {badge.remainingPercent}%
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function LunaMobileThreadSiblingLimits(props: {
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly currentDriver?: ProviderDriverKind | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const activeProvider = props.activeInstanceId
    ? props.providers.find((provider) => provider.instanceId === props.activeInstanceId)
    : undefined;
  const driver = activeProvider?.driver ?? props.currentDriver;
  if (!driver) return null;

  const eligible = props.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.driver === driver &&
      (provider.usageLimits?.windows?.length ?? 0) > 0,
  );
  const siblings = [...eligible].sort((left, right) => {
    if (left.instanceId === props.activeInstanceId) return -1;
    if (right.instanceId === props.activeInstanceId) return 1;
    return siblingTitle(left).localeCompare(siblingTitle(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });

  if (siblings.length < 2) return null;

  return (
    <View className="border-t border-border-subtle px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center justify-between gap-2 active:opacity-70"
      >
        <Text className="text-xs font-t3-medium text-foreground-muted">
          同类账号余量对比（{siblings.length}）
        </Text>
        <Text className="text-xs font-t3-medium text-primary-text">
          {expanded ? "收起" : "展开对比"}
        </Text>
      </Pressable>

      {expanded ? (
        <View className="mt-2.5 gap-2">
          {siblings.map((provider) => {
            const isActive = provider.instanceId === props.activeInstanceId;
            const title = siblingTitle(provider);
            const tierBadge = formatSubscriptionTierBadge(provider.auth.label);
            const badges = extractCompactQuotaBadges(provider.usageLimits, props.now);
            const health = summarizeAccountQuotaHealth(
              provider.usageLimits?.windows ?? [],
              provider.usageLimits?.unavailable,
            );
            const healthTone = quotaHealthClasses(health.status);
            const updatedAgo = provider.usageLimits?.checkedAt
              ? formatCheckedAtAgo(provider.usageLimits.checkedAt, props.now)
              : null;

            return (
              <View
                key={String(provider.instanceId)}
                className={
                  isActive
                    ? "gap-1.5 rounded-xl border border-primary bg-adaptive-blue-50-blue-400-a14 px-3 py-2"
                    : "gap-1.5 rounded-xl border border-border-subtle bg-subtle px-3 py-2"
                }
              >
                <View className="flex-row items-center justify-between gap-2">
                  <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
                    <ProviderIcon provider={provider.driver} size={14} />
                    <Text
                      className="shrink text-xs font-t3-medium text-foreground"
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                    {tierBadge && !tierBadge.isGenericAuth ? (
                      <View
                        className={`rounded px-1.5 py-0.5 ${subscriptionTierBadgeClasses(tierBadge.tone).container}`}
                      >
                        <Text
                          className={`text-3xs font-t3-medium ${subscriptionTierBadgeClasses(tierBadge.tone).text}`}
                        >
                          {tierBadge.shortLabel}
                        </Text>
                      </View>
                    ) : null}
                    {isActive ? (
                      <View className="rounded bg-primary px-1.5 py-0.5">
                        <Text className="text-3xs font-t3-medium text-primary-foreground">
                          当前
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  {health.minRemainingPercent !== null ? (
                    <Text className={`text-xs font-t3-bold tabular-nums ${healthTone.badgeText}`}>
                      最低 {health.minRemainingPercent}%
                    </Text>
                  ) : null}
                </View>

                <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
                  {badges.map((badge) => {
                    const tone = quotaHealthClasses(badge.tone);
                    return (
                      <View key={badge.id} className="flex-row items-center gap-1">
                        <Text className="text-2xs text-foreground-muted">{badge.label}</Text>
                        <Text
                          className={`text-2xs font-t3-medium tabular-nums ${
                            badge.tone === "healthy" ? "text-foreground" : tone.badgeText
                          }`}
                        >
                          {badge.remainingPercent}%
                        </Text>
                      </View>
                    );
                  })}
                  {updatedAgo ? (
                    <Text className="text-3xs tabular-nums text-foreground-tertiary">
                      {updatedAgo}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
