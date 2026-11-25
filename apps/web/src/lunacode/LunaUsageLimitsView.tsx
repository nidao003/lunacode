import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  displayLimitWindows,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useMessages } from "gt-react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { providerClients } from "../components/settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { PaceIcon, ResetCredits, barColor, usePaceMark } from "../components/usage/UsageLimits";
import { usePrimarySettings } from "../hooks/useSettings";
import { formatUpcomingTimestamp } from "../timestampFormat";
import { maskAccountEmail } from "./multiAccount.logic";
import {
  formatSubscriptionTierBadge,
  subscriptionTierBadgeClassName,
} from "./subscriptionTier.logic";
import {
  type AccountQuotaHealth,
  formatCheckedAtAgo,
  formatCompactResetCountdown,
  orderAccountWindows,
  shortenQuotaWindowLabel,
  sortLimitAccountsForCards,
  summarizeAccountQuotaHealth,
} from "./usageLimitsView.logic";

export type LunaUsageLimitsViewMode = "accounts" | "pooled";

export function LunaUsageLimitsToolbar({
  multiAccountPoolCount,
  totalAccounts,
  viewMode,
  onViewModeChange,
  maskEmails,
  onMaskEmailsChange,
}: {
  readonly multiAccountPoolCount: number;
  readonly totalAccounts: number;
  readonly viewMode: LunaUsageLimitsViewMode;
  readonly onViewModeChange: (mode: LunaUsageLimitsViewMode) => void;
  readonly maskEmails: boolean;
  readonly onMaskEmailsChange: (masked: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span className="font-medium text-foreground">多账号配额视图</span>
        <span>·</span>
        <span className="tabular-nums">
          {multiAccountPoolCount} 个多账号驱动 · 共 {totalAccounts} 个已聚合账号
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="切换配额视图模式"
          className="inline-flex items-center rounded-md border border-border/70 bg-background/70 p-0.5"
        >
          <button
            type="button"
            onClick={() => onViewModeChange("accounts")}
            className={
              viewMode === "accounts"
                ? "cursor-pointer rounded px-2 py-0.5 font-medium text-foreground bg-accent"
                : "cursor-pointer rounded px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            按账号卡片
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange("pooled")}
            className={
              viewMode === "pooled"
                ? "cursor-pointer rounded px-2 py-0.5 font-medium text-foreground bg-accent"
                : "cursor-pointer rounded px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            合并池视图
          </button>
        </div>

        <button
          type="button"
          onClick={() => onMaskEmailsChange(!maskEmails)}
          className="cursor-pointer rounded border border-border/70 bg-background/70 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {maskEmails ? "显示邮箱" : "隐藏邮箱"}
        </button>
      </div>
    </div>
  );
}

function percentTextClass(left: number): string {
  if (left <= 0) return "text-destructive";
  if (left <= 20) return "text-warning-foreground";
  return "text-foreground";
}

function healthBadgeMeta(
  status: AccountQuotaHealth,
  minRemaining: number | null,
  exhaustedCount: number,
): { readonly label: string; readonly className: string } {
  switch (status) {
    case "critical":
      return {
        label: exhaustedCount > 1 ? `已耗尽 ${exhaustedCount} 项` : "存在 0% 耗尽",
        className: "border-destructive/40 bg-destructive/10 text-destructive",
      };
    case "caution":
      return {
        label: minRemaining !== null ? `最低余量 ${minRemaining}%` : "余量偏低",
        className: "border-warning/40 bg-warning-surface text-warning-foreground",
      };
    case "healthy":
      return {
        label: minRemaining === 100 ? "全部充裕" : `最低余量 ${minRemaining ?? 100}%`,
        className: "border-success/35 bg-success/10 text-success",
      };
    case "unavailable":
      return {
        label: "暂不可读",
        className: "border-border bg-muted/50 text-muted-foreground",
      };
  }
}

function paceHintLabel(pace: ReturnType<typeof paceOf>): string | null {
  if (pace === "ahead") return "当前消耗快于时间进度";
  if (pace === "under") return "当前消耗慢于时间进度";
  if (pace === "on") return "消耗节奏与时间进度基本一致";
  return null;
}

function AccountWindowCell({
  window,
  accentColor,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly accentColor: string;
  readonly now: number;
}) {
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const used = Math.round(window.usedPercent);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const [barRef, paceMark] = usePaceMark(timeLeft);
  const compactReset = formatCompactResetCountdown(window, now);
  const upcomingReset = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)
    : null;
  const paceHint = paceHintLabel(pace);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex cursor-default flex-col gap-1.5 rounded-md border border-border/60 bg-background/55 px-2.5 py-2 transition-colors hover:border-border">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground/90">
                {shortenQuotaWindowLabel(window.label, window.kind, window.id)}
              </span>
              <span className="flex shrink-0 items-center gap-1 tabular-nums">
                <span className={`font-semibold ${percentTextClass(left)}`}>{left}%</span>
                {pace ? <PaceIcon pace={pace} /> : null}
              </span>
            </div>

            <div
              ref={barRef}
              className="relative h-2 w-full overflow-hidden rounded-full bg-muted/75"
            >
              <div
                className="h-full rounded-full transition-[width] duration-200"
                style={{
                  width: `${left}%`,
                  backgroundColor: left <= 0 ? "var(--destructive)" : accentColor,
                }}
              />
              {paceMark ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground/85"
                  style={paceMark.tick}
                />
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-2 text-3xs text-muted-foreground tabular-nums">
              <span>{compactReset ? `↻ ${compactReset}` : "无重置倒计时"}</span>
              <span>已用 {used}%</span>
            </div>
          </div>
        }
      />
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 text-xs">
          <div className="font-medium text-foreground">{window.label}</div>
          <div className="tabular-nums text-muted-foreground">
            剩余 {left}%（已使用 {used}%）
          </div>
          {upcomingReset ? (
            <div className="tabular-nums text-muted-foreground">
              预计重置：{upcomingReset}
              {compactReset ? `（${compactReset}）` : ""}
            </div>
          ) : null}
          {timeLeft !== null ? (
            <div className="tabular-nums text-muted-foreground">
              当前周期理想剩余参考约 {timeLeft}%{paceHint ? ` · ${paceHint}` : ""}
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function AccountQuotaCard({
  pool,
  account,
  driverLabel,
  maskEmails,
  now,
}: {
  readonly pool: LimitPool;
  readonly account: LimitAccount;
  readonly driverLabel: string;
  readonly maskEmails: boolean;
  readonly now: number;
}) {
  const orderedWindows = orderAccountWindows(account.limits.windows ?? []);
  const health = summarizeAccountQuotaHealth(orderedWindows, account.limits.unavailable);
  const badge = healthBadgeMeta(health.status, health.minRemainingPercent, health.exhaustedCount);
  const accentColor = normalizeProviderAccentColor(account.accentColor) ?? barColor(pool.driver);

  const visibleEmail = account.email
    ? maskEmails
      ? maskAccountEmail(account.email)
      : account.email
    : null;
  const primaryTitle =
    account.displayName ?? account.sourceLabel ?? visibleEmail ?? `${driverLabel} 账号`;
  const secondaryEmail = visibleEmail && visibleEmail !== primaryTitle ? visibleEmail : null;
  const envLabel =
    account.environments.length > 0
      ? account.environments.map((env) => env.label).join(", ")
      : null;

  const tierBadge = formatSubscriptionTierBadge(account.plan);

  return (
    <section
      className={
        health.status === "critical"
          ? "flex flex-col gap-2.5 rounded-lg border border-destructive/35 bg-card/85 p-3 shadow-xs"
          : "flex flex-col gap-2.5 rounded-lg border border-border/75 bg-card/85 p-3 shadow-xs"
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={pool.driver}
            displayName={primaryTitle}
            accentColor={account.accentColor}
            showBadge={pool.accounts.length > 1}
            size="compact"
            className="size-5 shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{primaryTitle}</span>
              {tierBadge ? (
                tierBadge.shortLabel !== tierBadge.fullLabel ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={`shrink-0 rounded border px-1.5 py-px text-3xs font-medium ${subscriptionTierBadgeClassName(tierBadge.tone)}`}
                        >
                          {tierBadge.shortLabel}
                        </span>
                      }
                    />
                    <TooltipPopup side="top">{tierBadge.fullLabel}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span
                    className={`shrink-0 rounded border px-1.5 py-px text-3xs font-medium ${subscriptionTierBadgeClassName(tierBadge.tone)}`}
                  >
                    {tierBadge.shortLabel}
                  </span>
                )
              ) : null}
            </div>
            {secondaryEmail || envLabel || account.sourceLabel ? (
              <div className="truncate text-2xs text-muted-foreground">
                {[
                  secondaryEmail,
                  account.sourceLabel && account.sourceLabel !== primaryTitle
                    ? account.sourceLabel
                    : null,
                  envLabel,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            ) : null}
          </div>
        </div>

        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-3xs font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      {orderedWindows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 bg-background/40 px-2.5 py-2 text-xs text-muted-foreground">
          {account.limits.unavailable?.message ?? "暂未读取到该账号的配额窗口数据。"}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {orderedWindows.map((window) => (
            <AccountWindowCell
              key={window.id}
              window={window}
              accentColor={accentColor}
              now={now}
            />
          ))}
        </div>
      )}

      {account.limits.unavailable?.message && orderedWindows.length > 0 ? (
        <p className="text-2xs text-warning-foreground">
          最近一次探测失败，当前展示为缓存配额：
          {account.limits.unavailable.message}
        </p>
      ) : null}

      {account.limits.checkedAt ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-3xs text-muted-foreground tabular-nums">
          <span>额度更新于 {formatCheckedAtAgo(account.limits.checkedAt, now)}</span>
          {account.limits.unavailable?.reason === "probeFailed" ? (
            <span className="text-warning-foreground">刷新失败·展示缓存</span>
          ) : null}
        </div>
      ) : null}

      {account.redeem &&
      account.limits.resetCredits &&
      account.limits.resetCredits.availableCount > 0 ? (
        <div className="border-t border-border/60 pt-2">
          <ResetCredits
            environmentId={account.redeem.environmentId}
            input={account.redeem.input}
            credits={account.limits.resetCredits}
            now={now}
          />
        </div>
      ) : null}
    </section>
  );
}

function AggregateWindowPill({
  poolWindow,
  now,
}: {
  readonly poolWindow: LimitPoolWindow;
  readonly now: number;
}) {
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const nextReset = poolWindow.resets[0];
  const nextResetLabel = nextReset
    ? formatUpcomingTimestamp(
        new Date(nextReset.at).toISOString(),
        timestampFormat,
        now,
        undefined,
        m,
      )
    : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex cursor-default items-center gap-1.5 rounded-md border border-border/70 bg-background/70 px-2 py-0.5 text-2xs tabular-nums">
            <span className="text-muted-foreground">
              {shortenQuotaWindowLabel(poolWindow.label, poolWindow.kind, poolWindow.id)}
            </span>
            <span className={`font-semibold ${percentTextClass(poolWindow.remainingPercent)}`}>
              {poolWindow.remainingPercent}%
            </span>
            {poolWindow.pace ? <PaceIcon pace={poolWindow.pace} /> : null}
          </span>
        }
      />
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 text-xs">
          <div className="font-medium text-foreground">{poolWindow.label}（合并池均值）</div>
          <div className="tabular-nums text-muted-foreground">
            池整体剩余 {poolWindow.remainingPercent}% · 覆盖 {poolWindow.members.length} 个账号
          </div>
          {nextReset && nextResetLabel ? (
            <div className="tabular-nums text-muted-foreground">
              最早回充：{nextResetLabel}（+{nextReset.restoresPercent}%）
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function LunaUsageLimitsView({
  pools,
  now,
  maskEmails,
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
  readonly maskEmails: boolean;
}) {
  return (
    <div className="flex flex-col gap-7">
      {pools.map((pool) => {
        const driverLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
        const aggregateWindows = displayLimitWindows(pool);
        const sortedAccounts = sortLimitAccountsForCards(pool.accounts);
        const gridClass =
          sortedAccounts.length <= 1
            ? "grid grid-cols-1 gap-3"
            : "grid grid-cols-1 gap-3 lg:grid-cols-2";

        return (
          <div key={pool.driver} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ProviderInstanceIcon
                  driverKind={pool.driver}
                  displayName={driverLabel}
                  size="compact"
                  className="size-4 shrink-0"
                />
                <h3 className="text-sm font-medium text-foreground">{driverLabel}</h3>
                <span className="rounded border border-border/70 bg-muted/50 px-1.5 py-px text-3xs text-muted-foreground tabular-nums">
                  {pool.accounts.length} 个账号
                </span>
              </div>

              {aggregateWindows.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {aggregateWindows.map((poolWindow) => (
                    <AggregateWindowPill key={poolWindow.id} poolWindow={poolWindow} now={now} />
                  ))}
                </div>
              ) : null}
            </div>

            <div className={gridClass}>
              {sortedAccounts.map((account) => (
                <AccountQuotaCard
                  key={account.key}
                  pool={pool}
                  account={account}
                  driverLabel={driverLabel}
                  maskEmails={maskEmails}
                  now={now}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
