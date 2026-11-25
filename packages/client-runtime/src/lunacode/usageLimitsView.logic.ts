import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { type LimitAccount, remainingPercent, resetCountdown } from "@t3tools/shared/usageLimits";

const WINDOW_KIND_RANK: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export type AccountQuotaHealth = "healthy" | "caution" | "critical" | "unavailable";

export interface AccountQuotaHealthSummary {
  readonly status: AccountQuotaHealth;
  readonly minRemainingPercent: number | null;
  readonly hasExhaustedWindow: boolean;
  readonly exhaustedCount: number;
  readonly windowCount: number;
}

export interface LunaCompactQuotaBadge {
  readonly id: string;
  readonly label: string;
  readonly fullLabel: string;
  readonly remainingPercent: number;
  readonly tone: Exclude<AccountQuotaHealth, "unavailable">;
  readonly resetsIn: string | null;
}

function windowFamilyRank(window: ServerProviderUsageWindow): number {
  const haystack = `${window.id} ${window.label}`.toLowerCase();
  if (haystack.includes("gemini")) return 0;
  if (haystack.includes("claude") || haystack.includes("gpt") || haystack.includes("sonnet")) {
    return 1;
  }
  return 2;
}

function periodShortLabel(
  kind: ServerProviderUsageWindow["kind"],
  haystack: string,
): string | null {
  if (
    kind === "session" ||
    haystack.includes("5-hour") ||
    haystack.includes("5 hour") ||
    haystack.includes("5h")
  ) {
    return "5h";
  }
  if (kind === "weekly" || haystack.includes("week")) {
    return "周";
  }
  if (kind === "monthly" || haystack.includes("month")) {
    return "月";
  }
  return null;
}

/**
 * Shorten verbose quota window labels (such as "Claude & GPT (shared) · Weekly")
 * into compact labels suitable for per-account cards, settings badges, and sidebar rows.
 */
export function shortenQuotaWindowLabel(
  label: string,
  kind: ServerProviderUsageWindow["kind"],
  id?: string,
): string {
  const cleaned = label
    .replace(/\(shared\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const haystack = `${id ?? ""} ${cleaned}`.toLowerCase();
  const period = periodShortLabel(kind, haystack);

  if (haystack.includes("gemini")) {
    return period ? `Gemini ${period}` : "Gemini";
  }
  if (haystack.includes("claude") && haystack.includes("gpt")) {
    return period ? `Claude/GPT ${period}` : "Claude/GPT";
  }
  if (haystack.includes("claude")) {
    return period ? `Claude ${period}` : "Claude";
  }
  if (haystack.includes("gpt")) {
    return period ? `GPT ${period}` : "GPT";
  }

  if (kind === "session") {
    return haystack.includes("session") || haystack.includes("5-hour") || haystack.includes("5h")
      ? "5h"
      : cleaned.replace(/·\s*5-hour/gi, "5h").trim();
  }
  if (kind === "weekly") {
    return haystack === "weekly" || cleaned.toLowerCase() === "weekly"
      ? "周配额"
      : cleaned
          .replace(/·?\s*weekly/gi, " 周")
          .replace(/\s+/g, " ")
          .trim();
  }
  if (kind === "monthly") {
    return haystack === "monthly" || cleaned.toLowerCase() === "monthly"
      ? "月配额"
      : cleaned
          .replace(/·?\s*monthly/gi, " 月")
          .replace(/\s+/g, " ")
          .trim();
  }
  return cleaned || label;
}

/**
 * Order an account's windows deterministically by model family (Gemini -> Claude/GPT -> others)
 * and reset period (5h -> weekly -> monthly -> other) so 2-column grids align cleanly.
 */
export function orderAccountWindows(
  windows: readonly ServerProviderUsageWindow[],
): readonly ServerProviderUsageWindow[] {
  return windows
    .map((window, index) => ({ window, index }))
    .sort((left, right) => {
      const familyDiff = windowFamilyRank(left.window) - windowFamilyRank(right.window);
      if (familyDiff !== 0) return familyDiff;
      const kindDiff = WINDOW_KIND_RANK[left.window.kind] - WINDOW_KIND_RANK[right.window.kind];
      if (kindDiff !== 0) return kindDiff;
      return left.index - right.index;
    })
    .map((entry) => entry.window);
}

/** Compute compact remaining quota health summary for an account's reported windows. */
export function summarizeAccountQuotaHealth(
  windows: readonly ServerProviderUsageWindow[],
  unavailable?: ServerProviderUsageLimits["unavailable"],
): AccountQuotaHealthSummary {
  if (windows.length === 0) {
    return {
      status: unavailable ? "unavailable" : "unavailable",
      minRemainingPercent: null,
      hasExhaustedWindow: false,
      exhaustedCount: 0,
      windowCount: 0,
    };
  }

  let minRemaining = 100;
  let exhaustedCount = 0;
  for (const window of windows) {
    const left = remainingPercent(window);
    if (left < minRemaining) minRemaining = left;
    if (left <= 0) exhaustedCount += 1;
  }

  const status: AccountQuotaHealth =
    minRemaining <= 0 ? "critical" : minRemaining <= 20 ? "caution" : "healthy";

  return {
    status,
    minRemainingPercent: minRemaining,
    hasExhaustedWindow: exhaustedCount > 0,
    exhaustedCount,
    windowCount: windows.length,
  };
}

/** Format a deterministic compact reset countdown without UI localization dependencies. */
export function formatCompactResetCountdown(
  window: ServerProviderUsageWindow,
  now: number,
): string | null {
  const countdown = resetCountdown(window, now);
  if (!countdown) return null;
  if (countdown.kind === "now") return "已到期";
  if (countdown.kind === "momentarily") return "<1m";

  const totalMinutes = Math.max(1, Math.round(countdown.ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** Format a deterministic "quota updated N ago" label without UI localization dependencies. */
export function formatCheckedAtAgo(checkedAt: string, now: number): string | null {
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * Extract compact quota pill badges from an account's `usageLimits`, keeping cards readable
 * at dense overview widths while preserving full labels and reset countdowns.
 */
export function extractCompactQuotaBadges(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
  maxBadges = 4,
): ReadonlyArray<LunaCompactQuotaBadge> {
  const windows = limits?.windows;
  if (!windows || windows.length === 0) {
    return [];
  }

  return orderAccountWindows(windows)
    .slice(0, Math.max(1, maxBadges))
    .map((window) => {
      const left = remainingPercent(window);
      const tone: LunaCompactQuotaBadge["tone"] =
        left <= 0 ? "critical" : left <= 20 ? "caution" : "healthy";
      return {
        id: window.id,
        label: shortenQuotaWindowLabel(window.label, window.kind, window.id),
        fullLabel: window.label,
        remainingPercent: left,
        tone,
        resetsIn: formatCompactResetCountdown(window, now),
      };
    });
}

function accountSortTitle(account: LimitAccount): string {
  return account.displayName ?? account.email ?? account.sourceLabel ?? account.key;
}

/** Sort limit accounts deterministically by availability and natural display label. */
export function sortLimitAccountsForCards(
  accounts: readonly LimitAccount[],
): readonly LimitAccount[] {
  return [...accounts].sort((left, right) => {
    const leftHasWindows = (left.limits.windows?.length ?? 0) > 0 ? 0 : 1;
    const rightHasWindows = (right.limits.windows?.length ?? 0) > 0 ? 0 : 1;
    if (leftHasWindows !== rightHasWindows) return leftHasWindows - rightHasWindows;
    return accountSortTitle(left).localeCompare(accountSortTitle(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}
