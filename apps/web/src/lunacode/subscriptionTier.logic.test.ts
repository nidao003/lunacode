import { describe, expect, it } from "vite-plus/test";
import {
  formatSubscriptionTierBadge,
  subscriptionTierBadgeClassName,
} from "./subscriptionTier.logic";

describe("formatSubscriptionTierBadge", () => {
  it("returns null for empty inputs", () => {
    expect(formatSubscriptionTierBadge(undefined)).toBeNull();
    expect(formatSubscriptionTierBadge(null)).toBeNull();
    expect(formatSubscriptionTierBadge("   ")).toBeNull();
  });

  it("marks generic auth labels cleanly", () => {
    expect(formatSubscriptionTierBadge("Google account")).toEqual({
      shortLabel: "Google account",
      fullLabel: "Google account",
      tone: "neutral",
      isGenericAuth: true,
    });
    expect(formatSubscriptionTierBadge("Claude Subscription")?.isGenericAuth).toBe(true);
  });

  it("formats known provider subscription plans into concise tone-coded badges", () => {
    expect(formatSubscriptionTierBadge("ChatGPT Free Subscription")).toEqual({
      shortLabel: "Free",
      fullLabel: "ChatGPT Free Subscription",
      tone: "free",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("Claude Max 20x Subscription")).toEqual({
      shortLabel: "Max 20x",
      fullLabel: "Claude Max 20x Subscription",
      tone: "ultra",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("AI Pro")).toEqual({
      shortLabel: "AI Pro",
      fullLabel: "AI Pro",
      tone: "pro",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("AI Ultra 20x")).toEqual({
      shortLabel: "AI Ultra 20x",
      fullLabel: "AI Ultra 20x",
      tone: "ultra",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("Cursor Pro+")).toEqual({
      shortLabel: "Pro+",
      fullLabel: "Cursor Pro+",
      tone: "pro",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("OpenCode Go")).toEqual({
      shortLabel: "Go",
      fullLabel: "OpenCode Go",
      tone: "pro",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("SuperGrok")).toEqual({
      shortLabel: "SuperGrok",
      fullLabel: "SuperGrok",
      tone: "pro",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("SuperGrok Heavy")).toEqual({
      shortLabel: "SuperGrok Heavy",
      fullLabel: "SuperGrok Heavy",
      tone: "ultra",
      isGenericAuth: false,
    });
  });

  it("handles API key labels and custom unknown plans gracefully", () => {
    expect(formatSubscriptionTierBadge("Claude API Key")).toEqual({
      shortLabel: "API Key",
      fullLabel: "Claude API Key",
      tone: "api",
      isGenericAuth: false,
    });
    expect(formatSubscriptionTierBadge("Kimi Allegretto")).toEqual({
      shortLabel: "Allegretto",
      fullLabel: "Kimi Allegretto",
      tone: "pro",
      isGenericAuth: false,
    });
    expect(subscriptionTierBadgeClassName("ultra")).toContain("violet");
  });
});
