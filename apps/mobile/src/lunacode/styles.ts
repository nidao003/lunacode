import type {
  LunaCompositionSegment,
  LunaContextTelemetry,
} from "@t3tools/client-runtime/lunacode/context-telemetry";
import type { DeterministicHandoffResult } from "@t3tools/client-runtime/lunacode/handoff-builder";
import type { SubscriptionTierTone } from "@t3tools/client-runtime/lunacode/subscription-tier";
import type { AccountQuotaHealth } from "@t3tools/client-runtime/lunacode/usage-limits-view";
import type { ProviderDriverKind } from "@t3tools/contracts";

export interface LunaMobileThreadContextProps {
  readonly telemetry: LunaContextTelemetry;
  readonly providerDriver: ProviderDriverKind | null;
  readonly isCompacting: boolean;
  readonly onCompactContext: (instructions?: string) => void;
  readonly onBuildHandoff: () => DeterministicHandoffResult;
  readonly onOpenHandoffThread: (markdown: string) => void;
}

export function subscriptionTierBadgeClasses(tone: SubscriptionTierTone): {
  readonly container: string;
  readonly text: string;
} {
  switch (tone) {
    case "ultra":
      return {
        container: "border border-border-subtle bg-adaptive-violet-500-a12-a16",
        text: "text-adaptive-violet-700-300",
      };
    case "pro":
      return {
        container: "border border-border-subtle bg-adaptive-sky-500-a12-a16",
        text: "text-adaptive-sky-700-300",
      };
    case "team":
      return {
        container: "border border-border-subtle bg-adaptive-emerald-500-a12-a16",
        text: "text-adaptive-emerald-700-300",
      };
    case "free":
      return {
        container: "border border-border-subtle bg-subtle",
        text: "text-foreground-muted",
      };
    case "api":
      return {
        container: "border border-warning-border bg-adaptive-amber-500-a12-a16",
        text: "text-adaptive-amber-700-300",
      };
    case "neutral":
      return {
        container: "border border-border-subtle bg-subtle",
        text: "text-foreground-muted",
      };
  }
}

export function quotaHealthClasses(health: AccountQuotaHealth): {
  readonly badgeContainer: string;
  readonly badgeText: string;
  readonly barColorClass: string;
} {
  switch (health) {
    case "critical":
      return {
        badgeContainer: "border border-danger-border bg-danger",
        badgeText: "text-danger-foreground",
        barColorClass: "bg-red-500",
      };
    case "caution":
      return {
        badgeContainer: "border border-warning-border bg-warning",
        badgeText: "text-warning-foreground",
        barColorClass: "bg-amber-500",
      };
    case "healthy":
      return {
        badgeContainer: "border border-border-subtle bg-adaptive-emerald-500-a12-a16",
        badgeText: "text-adaptive-emerald-700-300",
        barColorClass: "bg-emerald-500",
      };
    case "unavailable":
      return {
        badgeContainer: "border border-border-subtle bg-subtle",
        badgeText: "text-foreground-muted",
        barColorClass: "bg-foreground-muted",
      };
  }
}

export function compositionSegmentColor(key: LunaCompositionSegment["key"]): string {
  switch (key) {
    case "tools":
      return "#3b82f6";
    case "assistant":
      return "#10b981";
    case "user":
      return "#6366f1";
    case "reasoning":
      return "#f59e0b";
    case "attachments":
      return "#ef4444";
  }
}
