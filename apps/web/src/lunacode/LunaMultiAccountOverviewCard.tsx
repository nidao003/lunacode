import { useState } from "react";
import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  maskAccountEmail,
  summarizeAccountInstances,
  type LunaAccountAuthStateKind,
} from "./multiAccount.logic";
import {
  formatSubscriptionTierBadge,
  subscriptionTierBadgeClassName,
} from "./subscriptionTier.logic";
import { formatCheckedAtAgo } from "./usageLimitsView.logic";

interface LunaMultiAccountOverviewCardProps {
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly selectedInstanceId: ProviderInstanceId | null;
  readonly onSelectInstance: (instanceId: ProviderInstanceId) => void;
  readonly canAddProvider?: boolean;
  readonly onAddProvider?: () => void;
}

function authStatusTextClass(kind: LunaAccountAuthStateKind): string {
  switch (kind) {
    case "authenticated":
      return "text-success";
    case "saved-pending":
      return "text-info";
    case "needs-login":
    case "unauthenticated":
      return "text-warning";
    case "checking":
    case "disabled":
      return "text-muted-foreground";
  }
}

export function LunaMultiAccountOverviewCard({
  providerInstances,
  serverProviders,
  selectedInstanceId,
  onSelectInstance,
  canAddProvider = false,
  onAddProvider,
}: LunaMultiAccountOverviewCardProps) {
  const [showDisabled, setShowDisabled] = useState(false);
  const [maskEmails, setMaskEmails] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);

  const summaries = summarizeAccountInstances({
    providerInstances,
    serverProviders,
    now,
  });

  if (summaries.length === 0) {
    return null;
  }

  const enabledSummaries = summaries.filter((item) => item.enabled);
  const disabledCount = summaries.length - enabledSummaries.length;
  const visibleSummaries = showDisabled ? summaries : enabledSummaries;
  const hasSelectedDisabled =
    !showDisabled &&
    selectedInstanceId !== null &&
    summaries.some((item) => item.instanceId === selectedInstanceId && !item.enabled);

  const sharedWarningCount = summaries.filter(
    (item) => item.isolationKind === "shared-warning",
  ).length;
  const duplicateNameCount = summaries.filter((item) => item.hasDuplicateDisplayName).length;

  const driverCounts = new Map<string, number>();
  for (const item of summaries) {
    driverCounts.set(String(item.driver), (driverCounts.get(String(item.driver)) ?? 0) + 1);
  }

  return (
    <div className="mb-3 space-y-2.5 rounded-lg border border-border/70 bg-muted/20 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">多账号与隔离目录总览</span>
          <span className="rounded bg-muted/70 px-1.5 py-0.5 text-3xs text-muted-foreground">
            已启用 {enabledSummaries.length} / 共 {summaries.length}
          </span>
          {hasSelectedDisabled ? (
            <button
              type="button"
              onClick={() => setShowDisabled(true)}
              className="cursor-pointer rounded border border-border/70 bg-background/70 px-1.5 py-0.5 text-3xs text-muted-foreground hover:text-foreground"
            >
              当前选中已停用实例，点击展开
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {disabledCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowDisabled((current) => !current)}
              className="cursor-pointer rounded border border-border/70 bg-background/70 px-2 py-0.5 text-3xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              {showDisabled ? "隐藏已停用" : `显示已停用 (${disabledCount})`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMaskEmails((current) => !current)}
            className="cursor-pointer rounded border border-border/70 bg-background/70 px-2 py-0.5 text-3xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {maskEmails ? "显示邮箱" : "遮罩邮箱"}
          </button>
          {canAddProvider && onAddProvider ? (
            <button
              type="button"
              onClick={onAddProvider}
              className="cursor-pointer rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-3xs font-medium text-primary transition-colors hover:bg-primary/15"
            >
              + 添加账号
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            className="cursor-pointer rounded border border-border/70 bg-background/70 px-2 py-0.5 text-3xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {collapsed ? "展开" : "收起"}
          </button>
        </div>
      </div>

      {sharedWarningCount > 0 || duplicateNameCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {sharedWarningCount > 0 ? (
            <span className="rounded border border-warning/40 bg-warning-surface px-2 py-0.5 text-2xs font-medium text-warning-foreground">
              检测到 {sharedWarningCount} 个 Claude 实例共用默认目录
            </span>
          ) : null}
          {duplicateNameCount > 0 ? (
            <span className="rounded border border-info/40 bg-info/10 px-2 py-0.5 text-2xs text-info">
              检测到 {duplicateNameCount} 个同名启用实例，建议在右侧修改 Display name（如 ultra /
              pro1）便于模型栏区分
            </span>
          ) : null}
        </div>
      ) : null}

      {collapsed ? null : visibleSummaries.length === 0 ? (
        <div className="rounded border border-dashed border-border/70 bg-background/40 px-3 py-2 text-2xs text-muted-foreground">
          当前没有已启用的账号实例，可点击右上角「显示已停用」或「+ 添加账号」。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visibleSummaries.map((item) => {
            const isSelected = selectedInstanceId === item.instanceId;
            const hasMultipleOfDriver = (driverCounts.get(String(item.driver)) ?? 0) > 1;
            const badgeClass =
              item.isolationKind === "shared-warning"
                ? "border-warning/40 bg-warning-surface text-warning-foreground"
                : item.isolationKind === "auto-isolated"
                  ? "border-info/40 bg-info/10 text-info"
                  : item.isolationKind === "isolated"
                    ? "border-success/35 bg-success/10 text-success"
                    : "border-border bg-muted/50 text-muted-foreground";
            const isolationLabel =
              item.isolationKind === "shared-warning"
                ? "共用默认目录"
                : item.isolationKind === "auto-isolated"
                  ? "自动隔离"
                  : item.isolationKind === "isolated"
                    ? "独立目录"
                    : "默认目录";
            const displayEmail = item.accountEmail
              ? maskEmails
                ? maskAccountEmail(item.accountEmail)
                : item.accountEmail
              : null;
            const tierBadge = formatSubscriptionTierBadge(item.authTypeLabel);

            return (
              <Tooltip key={String(item.instanceId)}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => onSelectInstance(item.instanceId)}
                      className={
                        isSelected
                          ? "flex cursor-pointer flex-col gap-1 rounded-md border border-primary/60 bg-primary/8 p-2 text-left transition-colors"
                          : "flex cursor-pointer flex-col gap-1 rounded-md border border-border/60 bg-background/60 p-2 text-left transition-colors hover:border-border hover:bg-accent/40"
                      }
                    >
                      <div className="flex items-center gap-1.5">
                        <ProviderInstanceIcon
                          driverKind={item.driver}
                          displayName={item.displayName}
                          accentColor={item.accentColor ?? undefined}
                          showBadge={hasMultipleOfDriver}
                          className="size-4 shrink-0"
                          iconClassName="size-3.5"
                          badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-2.5 min-w-2.5 px-0.5 text-5xs"
                        />
                        <span className="min-w-0 truncate font-medium text-foreground">
                          {item.displayName}
                        </span>
                        {tierBadge && !tierBadge.isGenericAuth ? (
                          <span
                            className={`shrink-0 rounded border px-1 py-px text-4xs font-medium ${subscriptionTierBadgeClassName(tierBadge.tone)}`}
                          >
                            {tierBadge.shortLabel}
                          </span>
                        ) : null}
                        {item.versionLabel ? (
                          <code className="shrink-0 text-3xs text-muted-foreground">
                            {item.versionLabel}
                          </code>
                        ) : null}
                        <span
                          className={`ml-auto shrink-0 rounded border px-1.5 py-px text-3xs ${badgeClass}`}
                        >
                          {isolationLabel}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2 text-2xs">
                        {displayEmail ? (
                          <span className="min-w-0 truncate font-medium text-foreground">
                            {displayEmail}
                          </span>
                        ) : item.authTypeLabel ? (
                          <span className="min-w-0 truncate text-muted-foreground">
                            {item.authTypeLabel}
                          </span>
                        ) : item.authStateKind === "needs-login" ||
                          item.authStateKind === "unauthenticated" ? (
                          <span className="min-w-0 truncate text-warning">
                            尚未登录账号（点击前往授权）
                          </span>
                        ) : (
                          <span className="min-w-0 truncate text-muted-foreground/80">
                            未读取到账号名
                          </span>
                        )}
                        <span
                          className={`shrink-0 font-medium ${authStatusTextClass(item.authStateKind)}`}
                        >
                          {item.authLabel}
                        </span>
                      </div>

                      <div className="truncate font-mono text-3xs text-muted-foreground">
                        {String(item.instanceId)}
                        {displayEmail &&
                        item.authTypeLabel &&
                        (!tierBadge || tierBadge.isGenericAuth)
                          ? ` · ${item.authTypeLabel}`
                          : null}
                      </div>

                      {item.quotaBadges.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1 pt-0.5 tabular-nums">
                          {item.quotaBadges.map((badge) => {
                            const badgeTone =
                              badge.tone === "critical"
                                ? "border-destructive/40 bg-destructive/10 text-destructive"
                                : badge.tone === "caution"
                                  ? "border-warning/40 bg-warning-surface text-warning-foreground"
                                  : "border-border/70 bg-muted/45 text-foreground/85";
                            return (
                              <span
                                key={badge.id}
                                className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-3xs ${badgeTone}`}
                              >
                                <span className="text-muted-foreground">{badge.label}</span>
                                <span className="font-semibold">{badge.remainingPercent}%</span>
                              </span>
                            );
                          })}
                        </div>
                      ) : null}

                      {item.usageCheckedAt && item.quotaBadges.length > 0 ? (
                        <div className="text-3xs text-muted-foreground/90 tabular-nums">
                          额度更新于 {formatCheckedAtAgo(item.usageCheckedAt, now)}
                        </div>
                      ) : null}

                      {item.isolationKind === "shared-warning" ||
                      item.isolationKind === "isolated" ? (
                        <div
                          className={
                            item.isolationKind === "shared-warning"
                              ? "truncate text-3xs text-warning-foreground"
                              : "truncate text-3xs text-muted-foreground"
                          }
                        >
                          {item.isolationDetail}
                        </div>
                      ) : null}
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  <div className="flex flex-col gap-1 text-xs">
                    <div>{item.isolationDetail}</div>
                    {tierBadge && !tierBadge.isGenericAuth ? (
                      <div className="text-2xs text-muted-foreground">
                        订阅档位：{tierBadge.fullLabel}
                      </div>
                    ) : null}
                    {item.quotaBadges.length > 0 ? (
                      <div className="flex flex-col gap-0.5 border-t border-border/50 pt-1 text-2xs tabular-nums text-muted-foreground">
                        {item.quotaBadges.map((badge) => (
                          <div key={badge.id}>
                            {badge.fullLabel}：剩余 {badge.remainingPercent}%
                            {badge.resetsIn ? ` · ↻ ${badge.resetsIn}` : ""}
                          </div>
                        ))}
                        {item.usageCheckedAt ? (
                          <div>更新于 {formatCheckedAtAgo(item.usageCheckedAt, now)}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      )}
    </div>
  );
}
