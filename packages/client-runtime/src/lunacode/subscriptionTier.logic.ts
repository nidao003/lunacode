export type SubscriptionTierTone = "ultra" | "pro" | "team" | "free" | "api" | "neutral";

export interface SubscriptionTierBadge {
  readonly shortLabel: string;
  readonly fullLabel: string;
  readonly tone: SubscriptionTierTone;
  readonly isGenericAuth: boolean;
}

const GENERIC_AUTH_LABELS = new Set([
  "google account",
  "cursor account",
  "chatgpt subscription",
  "claude subscription",
  "oauth",
  "browser",
  "github account",
]);

const KNOWN_PLAN_LABELS: Readonly<
  Record<string, { shortLabel: string; tone: SubscriptionTierTone }>
> = {
  "chatgpt free subscription": { shortLabel: "Free", tone: "free" },
  "chatgpt go subscription": { shortLabel: "Go", tone: "pro" },
  "chatgpt plus subscription": { shortLabel: "Plus", tone: "pro" },
  "chatgpt pro 100 subscription": { shortLabel: "Pro 100", tone: "pro" },
  "chatgpt pro 200 subscription": { shortLabel: "Pro 200", tone: "ultra" },
  "chatgpt pro 500 subscription": { shortLabel: "Pro 500", tone: "ultra" },
  "chatgpt business subscription": { shortLabel: "Business", tone: "team" },
  "chatgpt business premium subscription": {
    shortLabel: "Business+",
    tone: "team",
  },
  "chatgpt enterprise subscription": { shortLabel: "Enterprise", tone: "team" },
  "chatgpt edu subscription": { shortLabel: "Edu", tone: "team" },
  "chatgpt edu plus subscription": { shortLabel: "Edu Plus", tone: "team" },
  "chatgpt edu pro subscription": { shortLabel: "Edu Pro", tone: "team" },

  "claude free subscription": { shortLabel: "Free", tone: "free" },
  "claude pro subscription": { shortLabel: "Pro", tone: "pro" },
  "claude max subscription": { shortLabel: "Max", tone: "pro" },
  "claude max 5x subscription": { shortLabel: "Max 5x", tone: "pro" },
  "claude max 20x subscription": { shortLabel: "Max 20x", tone: "ultra" },
  "claude ultra subscription": { shortLabel: "Ultra", tone: "ultra" },
  "claude team subscription": { shortLabel: "Team", tone: "team" },
  "claude enterprise subscription": { shortLabel: "Enterprise", tone: "team" },

  free: { shortLabel: "Free", tone: "free" },
  paid: { shortLabel: "Paid", tone: "pro" },
  "ai plus": { shortLabel: "AI Plus", tone: "pro" },
  "ai pro": { shortLabel: "AI Pro", tone: "pro" },
  "ai ultra": { shortLabel: "AI Ultra", tone: "ultra" },
  "ai ultra 5x": { shortLabel: "AI Ultra 5x", tone: "ultra" },
  "ai ultra 20x": { shortLabel: "AI Ultra 20x", tone: "ultra" },

  "cursor free": { shortLabel: "Free", tone: "free" },
  "cursor pro": { shortLabel: "Pro", tone: "pro" },
  "cursor pro+": { shortLabel: "Pro+", tone: "pro" },
  "cursor ultra": { shortLabel: "Ultra", tone: "ultra" },
  "cursor teams": { shortLabel: "Teams", tone: "team" },
  "cursor enterprise": { shortLabel: "Enterprise", tone: "team" },

  "opencode go": { shortLabel: "Go", tone: "pro" },

  supergrok: { shortLabel: "SuperGrok", tone: "pro" },
  "supergrok heavy": { shortLabel: "SuperGrok Heavy", tone: "ultra" },
};

function inferTierTone(label: string): SubscriptionTierTone {
  const lower = label.toLowerCase();
  if (
    lower.includes("ultra") ||
    lower.includes("heavy") ||
    lower.includes("20x") ||
    lower.includes("200") ||
    lower.includes("500")
  ) {
    return "ultra";
  }
  if (
    lower.includes("team") ||
    lower.includes("business") ||
    lower.includes("enterprise") ||
    lower.includes("edu")
  ) {
    return "team";
  }
  if (
    lower.includes("pro") ||
    lower.includes("max") ||
    lower.includes("plus") ||
    lower.includes("paid") ||
    /\bgo\b/i.test(lower) ||
    lower.includes("allegretto") ||
    lower.includes("moderato") ||
    lower.includes("vivace")
  ) {
    return "pro";
  }
  if (lower.includes("free") || lower.includes("hobby")) {
    return "free";
  }
  return "neutral";
}

function stripBrandAffixes(label: string): string {
  return label
    .replace(/^(?:chatgpt|claude|cursor|opencode|google|gemini|kimi)\s+/i, "")
    .replace(/\s+subscription$/i, "")
    .trim();
}

/**
 * Normalizes raw upstream `auth.label` / `account.plan` strings into a compact card badge
 * with consistent tone styling while preserving the complete string as tooltip context.
 */
export function formatSubscriptionTierBadge(
  rawLabel: string | null | undefined,
): SubscriptionTierBadge | null {
  const trimmed = rawLabel?.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (GENERIC_AUTH_LABELS.has(lower)) {
    return {
      shortLabel: trimmed,
      fullLabel: trimmed,
      tone: "neutral",
      isGenericAuth: true,
    };
  }

  if (
    lower === "claude api key" ||
    lower.startsWith("cursor api key") ||
    lower === "gemini api key" ||
    lower === "custom api endpoint" ||
    lower === "amazon bedrock" ||
    lower === "agent platform"
  ) {
    const shortLabel =
      lower === "custom api endpoint"
        ? "Custom API"
        : lower === "amazon bedrock"
          ? "Bedrock"
          : lower.startsWith("cursor api key")
            ? trimmed.replace(/^cursor\s+/i, "")
            : lower === "agent platform"
              ? "Platform"
              : "API Key";
    return {
      shortLabel,
      fullLabel: trimmed,
      tone: "api",
      isGenericAuth: false,
    };
  }

  const known = KNOWN_PLAN_LABELS[lower];
  if (known) {
    return {
      shortLabel: known.shortLabel,
      fullLabel: trimmed,
      tone: known.tone,
      isGenericAuth: false,
    };
  }

  const stripped = stripBrandAffixes(trimmed) || trimmed;
  return {
    shortLabel: stripped,
    fullLabel: trimmed,
    tone: inferTierTone(trimmed),
    isGenericAuth: false,
  };
}

export function subscriptionTierBadgeClassName(tone: SubscriptionTierTone): string {
  switch (tone) {
    case "ultra":
      return "border-violet-500/35 bg-violet-500/12 text-violet-700 dark:text-violet-300";
    case "pro":
      return "border-sky-500/35 bg-sky-500/12 text-sky-700 dark:text-sky-300";
    case "team":
      return "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
    case "free":
      return "border-border/80 bg-muted/60 text-muted-foreground";
    case "api":
      return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "neutral":
      return "border-border/70 bg-muted/50 text-muted-foreground";
  }
}
