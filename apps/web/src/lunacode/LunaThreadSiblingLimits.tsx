import { useState } from "react";
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { extractCompactQuotaBadges, summarizeAccountQuotaHealth } from "./usageLimitsView.logic";

function badgeToneClass(tone: "healthy" | "caution" | "critical"): string {
  switch (tone) {
    case "critical":
      return "text-destructive";
    case "caution":
      return "text-warning-foreground";
    case "healthy":
      return "text-foreground/85";
  }
}

export function LunaThreadSiblingLimits({
  activeInstanceId,
  providers,
  now,
}: {
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly now: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const activeProvider = activeInstanceId
    ? providers.find((provider) => provider.instanceId === activeInstanceId)
    : undefined;
  if (!activeProvider) return null;

  const siblings = providers
    .filter(
      (provider) =>
        provider.enabled &&
        provider.driver === activeProvider.driver &&
        (provider.usageLimits?.windows?.length ?? 0) > 0,
    )
    .toSorted((left, right) => {
      if (left.instanceId === activeInstanceId) return -1;
      if (right.instanceId === activeInstanceId) return 1;
      const leftName = left.displayName ?? String(left.instanceId);
      const rightName = right.displayName ?? String(right.instanceId);
      return leftName.localeCompare(rightName, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

  if (siblings.length < 2) return null;

  return (
    <div className="mt-2.5 border-t border-border/60 pt-2">
      <div className="flex items-center justify-between gap-2 text-2xs">
        <span className="font-medium text-muted-foreground">
          同类账号余量对比（{siblings.length}）
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="cursor-pointer rounded px-1 py-px text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {expanded ? "收起" : "展开对比"}
        </button>
      </div>

      {expanded ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {siblings.map((provider) => {
            const isActive = provider.instanceId === activeInstanceId;
            const title = provider.displayName ?? String(provider.instanceId);
            const badges = extractCompactQuotaBadges(provider.usageLimits, now);
            const health = summarizeAccountQuotaHealth(
              provider.usageLimits?.windows ?? [],
              provider.usageLimits?.unavailable,
            );
            const lowestPercent = health.minRemainingPercent;

            return (
              <Tooltip key={String(provider.instanceId)}>
                <TooltipTrigger
                  render={
                    <div
                      className={
                        isActive
                          ? "flex flex-col gap-1 rounded border border-primary/40 bg-primary/8 px-2 py-1.5 text-2xs"
                          : "flex flex-col gap-1 rounded border border-border/50 bg-background/50 px-2 py-1.5 text-2xs"
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <ProviderInstanceIcon
                            driverKind={provider.driver}
                            displayName={title}
                            accentColor={provider.accentColor}
                            showBadge={true}
                            size="compact"
                            className="size-3.5 shrink-0"
                          />
                          <span className="min-w-0 truncate font-medium text-foreground">
                            {title}
                          </span>
                          {isActive ? (
                            <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-3xs font-medium text-primary">
                              当前
                            </span>
                          ) : null}
                        </div>

                        {lowestPercent !== null ? (
                          <span
                            className={`shrink-0 font-semibold tabular-nums ${
                              lowestPercent <= 0
                                ? "text-destructive"
                                : lowestPercent <= 20
                                  ? "text-warning-foreground"
                                  : "text-success"
                            }`}
                          >
                            最低 {lowestPercent}%
                          </span>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-3xs tabular-nums">
                        {badges.map((badge) => (
                          <span key={badge.id} className="inline-flex items-center gap-1">
                            <span className="text-muted-foreground">{badge.label}</span>
                            <span className={`font-medium ${badgeToneClass(badge.tone)}`}>
                              {badge.remainingPercent}%
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                  }
                />
                <TooltipPopup side="left">
                  <div className="flex flex-col gap-0.5 text-xs">
                    <div className="font-medium text-foreground">
                      {title}
                      {provider.auth.email ? `（${provider.auth.email}）` : ""}
                    </div>
                    {badges.map((badge) => (
                      <div key={badge.id} className="tabular-nums text-muted-foreground">
                        {badge.fullLabel}：剩余 {badge.remainingPercent}%
                        {badge.resetsIn ? ` · ↻ ${badge.resetsIn}` : ""}
                      </div>
                    ))}
                  </div>
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
