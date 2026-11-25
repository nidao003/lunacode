import {
  maskAccountEmail,
  summarizeAccountInstances,
  type LunaAccountAuthStateKind,
} from "@t3tools/client-runtime/lunacode/multi-account";
import { formatSubscriptionTierBadge } from "@t3tools/client-runtime/lunacode/subscription-tier";
import { formatCheckedAtAgo } from "@t3tools/client-runtime/lunacode/usage-limits-view";
import type { ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../components/ProviderIcon";
import { AppText as Text } from "../components/ui/AppText";
import { quotaHealthClasses, subscriptionTierBadgeClasses } from "./styles";

function authStatusTextClass(kind: LunaAccountAuthStateKind): string {
  switch (kind) {
    case "authenticated":
      return "text-adaptive-emerald-700-300";
    case "saved-pending":
      return "text-adaptive-sky-700-300";
    case "needs-login":
    case "unauthenticated":
      return "text-warning-foreground";
    case "checking":
    case "disabled":
      return "text-foreground-muted";
  }
}

export function LunaMobileMultiAccountOverviewCard(props: {
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly now: number;
}) {
  const [showDisabled, setShowDisabled] = useState(false);
  const [maskEmails, setMaskEmails] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  const summaries = summarizeAccountInstances({
    providerInstances: props.providerInstances,
    serverProviders: props.serverProviders,
    now: props.now,
  });

  if (summaries.length === 0) {
    return null;
  }

  const enabledSummaries = summaries.filter((item) => item.enabled);
  const disabledCount = summaries.length - enabledSummaries.length;
  const visibleSummaries = showDisabled ? summaries : enabledSummaries;
  const sharedWarningCount = summaries.filter(
    (item) => item.isolationKind === "shared-warning",
  ).length;
  const duplicateNameCount = summaries.filter((item) => item.hasDuplicateDisplayName).length;

  return (
    <View className="border-b border-border-subtle p-4 gap-3">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-t3-bold text-foreground">多账号与隔离目录总览</Text>
          <View className="rounded-md bg-subtle px-2 py-0.5">
            <Text className="text-3xs tabular-nums text-foreground-muted">
              已启用 {enabledSummaries.length} / {summaries.length}
            </Text>
          </View>
        </View>

        <View className="flex-row flex-wrap items-center gap-1.5">
          {disabledCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowDisabled((current) => !current)}
              className="rounded-full border border-border-subtle bg-subtle px-2.5 py-1 active:opacity-70"
            >
              <Text className="text-3xs font-t3-medium text-foreground-muted">
                {showDisabled ? "隐藏已停用" : `显示已停用 (${disabledCount})`}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setMaskEmails((current) => !current)}
            className="rounded-full border border-border-subtle bg-subtle px-2.5 py-1 active:opacity-70"
          >
            <Text className="text-3xs font-t3-medium text-foreground-muted">
              {maskEmails ? "显示邮箱" : "遮罩邮箱"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setCollapsed((current) => !current)}
            className="rounded-full border border-border-subtle bg-subtle px-2.5 py-1 active:opacity-70"
          >
            <Text className="text-3xs font-t3-medium text-foreground-muted">
              {collapsed ? "展开" : "收起"}
            </Text>
          </Pressable>
        </View>
      </View>

      {sharedWarningCount > 0 ? (
        <View className="rounded-xl border border-warning-border bg-warning px-3 py-2">
          <Text className="text-xs font-t3-medium text-warning-foreground">
            检测到 {sharedWarningCount} 个 Claude 实例共用默认 ~/.claude 目录，建议设置独立目录。
          </Text>
        </View>
      ) : null}

      {duplicateNameCount > 0 ? (
        <View className="rounded-xl border border-border-subtle bg-update px-3 py-2">
          <Text className="text-xs text-update-foreground">
            检测到 {duplicateNameCount} 个同名启用实例，建议修改 Display name 便于模型栏区分。
          </Text>
        </View>
      ) : null}

      {collapsed ? null : visibleSummaries.length === 0 ? (
        <Text className="py-2 text-xs text-foreground-muted">
          当前没有已启用的账号实例，可点击右上角「显示已停用」。
        </Text>
      ) : (
        <View className="gap-2.5">
          {visibleSummaries.map((item) => {
            const tierBadge = formatSubscriptionTierBadge(item.authTypeLabel);
            const displayEmail = item.accountEmail
              ? maskEmails
                ? maskAccountEmail(item.accountEmail)
                : item.accountEmail
              : null;
            const isolationLabel =
              item.isolationKind === "shared-warning"
                ? "共用默认目录"
                : item.isolationKind === "auto-isolated"
                  ? "自动隔离"
                  : item.isolationKind === "isolated"
                    ? "独立目录"
                    : "默认目录";
            const isolationContainerClass =
              item.isolationKind === "shared-warning"
                ? "border border-warning-border bg-warning"
                : item.isolationKind === "auto-isolated"
                  ? "border border-border-subtle bg-adaptive-sky-500-a12-a16"
                  : item.isolationKind === "isolated"
                    ? "border border-border-subtle bg-adaptive-emerald-500-a12-a16"
                    : "border border-border-subtle bg-subtle";
            const isolationTextClass =
              item.isolationKind === "shared-warning"
                ? "text-warning-foreground"
                : item.isolationKind === "auto-isolated"
                  ? "text-adaptive-sky-700-300"
                  : item.isolationKind === "isolated"
                    ? "text-adaptive-emerald-700-300"
                    : "text-foreground-muted";
            const updatedAgo =
              item.usageCheckedAt && item.quotaBadges.length > 0
                ? formatCheckedAtAgo(item.usageCheckedAt, props.now)
                : null;

            return (
              <View
                key={String(item.instanceId)}
                className="gap-1.5 rounded-2xl border border-border-subtle bg-card p-3"
              >
                <View className="flex-row items-center justify-between gap-2">
                  <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">
                    <ProviderIcon provider={item.driver} size={16} />
                    <Text
                      className="shrink text-sm font-t3-medium text-foreground"
                      numberOfLines={1}
                    >
                      {item.displayName}
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
                    {item.versionLabel ? (
                      <Text className="font-mono text-3xs text-foreground-tertiary">
                        {item.versionLabel}
                      </Text>
                    ) : null}
                  </View>

                  <View className={`rounded px-1.5 py-0.5 ${isolationContainerClass}`}>
                    <Text className={`text-3xs font-t3-medium ${isolationTextClass}`}>
                      {isolationLabel}
                    </Text>
                  </View>
                </View>

                <View className="flex-row items-center justify-between gap-2">
                  <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                    {displayEmail ??
                      item.authTypeLabel ??
                      (item.authStateKind === "needs-login" ||
                      item.authStateKind === "unauthenticated"
                        ? "尚未登录账号"
                        : "未读取到账号名")}
                  </Text>
                  <Text
                    className={`text-xs font-t3-medium ${authStatusTextClass(item.authStateKind)}`}
                  >
                    {item.authLabel}
                  </Text>
                </View>

                <Text className="font-mono text-3xs text-foreground-tertiary" numberOfLines={1}>
                  {String(item.instanceId)}
                  {item.isolationKind === "shared-warning" || item.isolationKind === "isolated"
                    ? ` · ${item.isolationDetail}`
                    : ""}
                </Text>

                {item.quotaBadges.length > 0 ? (
                  <View className="flex-row flex-wrap items-center gap-1.5 pt-0.5">
                    {item.quotaBadges.map((badge) => {
                      const tone = quotaHealthClasses(badge.tone);
                      return (
                        <View
                          key={badge.id}
                          className={`flex-row items-center gap-1 rounded-md px-1.5 py-0.5 ${
                            badge.tone === "healthy"
                              ? "border border-border-subtle bg-subtle"
                              : tone.badgeContainer
                          }`}
                        >
                          <Text className="text-3xs text-foreground-muted">{badge.label}</Text>
                          <Text
                            className={`text-3xs font-t3-bold tabular-nums ${
                              badge.tone === "healthy" ? "text-foreground" : tone.badgeText
                            }`}
                          >
                            {badge.remainingPercent}%
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                {updatedAgo ? (
                  <Text className="text-3xs tabular-nums text-foreground-tertiary">
                    额度更新于 {updatedAgo}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
