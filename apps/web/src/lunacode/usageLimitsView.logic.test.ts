import {
  EnvironmentId,
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  extractCompactQuotaBadges,
  formatCheckedAtAgo,
  formatCompactResetCountdown,
  orderAccountWindows,
  shortenQuotaWindowLabel,
  sortLimitAccountsForCards,
  summarizeAccountQuotaHealth,
} from "./usageLimitsView.logic.ts";

const now = Date.parse("2026-11-21T12:00:00.000Z");

function makeWindow(
  overrides: Partial<ServerProviderUsageWindow> &
    Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "usedPercent">,
): ServerProviderUsageWindow {
  return {
    ...overrides,
  };
}

function makeAccount(overrides: Partial<LimitAccount>): LimitAccount {
  return {
    key: "antigravity:test",
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "agy-pro1",
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [{ environmentId: EnvironmentId.make("local"), label: "Desk" }],
    sourceLabel: null,
    redeem: null,
    limits: {
      checkedAt: "2026-11-21T11:55:00.000Z",
      windows: [],
    },
    ...overrides,
  };
}

describe("shortenQuotaWindowLabel", () => {
  it("shortens Antigravity and generic window labels concisely", () => {
    expect(shortenQuotaWindowLabel("Gemini · 5-hour", "session", "gemini_five_hour")).toBe(
      "Gemini 5h",
    );
    expect(shortenQuotaWindowLabel("Gemini · Weekly", "weekly", "gemini_weekly")).toBe("Gemini 周");
    expect(
      shortenQuotaWindowLabel("Claude & GPT (shared) · 5-hour", "session", "claude_gpt_5h"),
    ).toBe("Claude/GPT 5h");
    expect(
      shortenQuotaWindowLabel("Claude & GPT (shared) · Weekly", "weekly", "claude_gpt_weekly"),
    ).toBe("Claude/GPT 周");
    expect(shortenQuotaWindowLabel("Session", "session")).toBe("5h");
    expect(shortenQuotaWindowLabel("Weekly", "weekly")).toBe("周配额");
    expect(shortenQuotaWindowLabel("Monthly", "monthly")).toBe("月配额");
  });
});

describe("orderAccountWindows", () => {
  it("orders Gemini windows before Claude/GPT and session before weekly", () => {
    const unordered: ServerProviderUsageWindow[] = [
      makeWindow({
        id: "claude_weekly",
        kind: "weekly",
        label: "Claude & GPT (shared) · Weekly",
        usedPercent: 100,
      }),
      makeWindow({
        id: "gemini_weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 5,
      }),
      makeWindow({
        id: "claude_session",
        kind: "session",
        label: "Claude & GPT (shared) · 5-hour",
        usedPercent: 0,
      }),
      makeWindow({
        id: "gemini_session",
        kind: "session",
        label: "Gemini · 5-hour",
        usedPercent: 20,
      }),
    ];

    expect(orderAccountWindows(unordered).map((w) => w.id)).toEqual([
      "gemini_session",
      "gemini_weekly",
      "claude_session",
      "claude_weekly",
    ]);
  });
});

describe("summarizeAccountQuotaHealth", () => {
  it("flags critical when any window reaches 0% remaining and caution <= 20%", () => {
    expect(
      summarizeAccountQuotaHealth([
        makeWindow({
          id: "g5",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 20,
        }),
        makeWindow({
          id: "cw",
          kind: "weekly",
          label: "Claude & GPT (shared) · Weekly",
          usedPercent: 100,
        }),
      ]),
    ).toEqual({
      status: "critical",
      minRemainingPercent: 0,
      hasExhaustedWindow: true,
      exhaustedCount: 1,
      windowCount: 2,
    });

    expect(
      summarizeAccountQuotaHealth([
        makeWindow({
          id: "g5",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 85,
        }),
      ]),
    ).toEqual({
      status: "caution",
      minRemainingPercent: 15,
      hasExhaustedWindow: false,
      exhaustedCount: 0,
      windowCount: 1,
    });

    expect(summarizeAccountQuotaHealth([], { reason: "probeFailed" })).toEqual({
      status: "unavailable",
      minRemainingPercent: null,
      hasExhaustedWindow: false,
      exhaustedCount: 0,
      windowCount: 0,
    });
  });
});

describe("extractCompactQuotaBadges & formatCompactResetCountdown", () => {
  it("produces compact ordered badges with tones and reset countdowns", () => {
    const limits: ServerProviderUsageLimits = {
      checkedAt: "2026-11-21T11:55:00.000Z",
      windows: [
        makeWindow({
          id: "cw",
          kind: "weekly",
          label: "Claude & GPT (shared) · Weekly",
          usedPercent: 100,
          resetsAt: "2026-11-26T05:00:00.000Z",
        }),
        makeWindow({
          id: "g5",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 20,
          resetsAt: "2026-11-21T12:51:00.000Z",
        }),
      ],
    };

    expect(extractCompactQuotaBadges(limits, now)).toEqual([
      {
        id: "g5",
        label: "Gemini 5h",
        fullLabel: "Gemini · 5-hour",
        remainingPercent: 80,
        tone: "healthy",
        resetsIn: "51m",
      },
      {
        id: "cw",
        label: "Claude/GPT 周",
        fullLabel: "Claude & GPT (shared) · Weekly",
        remainingPercent: 0,
        tone: "critical",
        resetsIn: "4d 17h",
      },
    ]);

    expect(
      formatCompactResetCountdown(
        makeWindow({
          id: "past",
          kind: "session",
          label: "Session",
          usedPercent: 50,
          resetsAt: "2026-11-21T11:59:00.000Z",
        }),
        now,
      ),
    ).toBe("已到期");
  });
});

describe("formatCheckedAtAgo", () => {
  it("renders just-now, minutes, hours, and days without localization deps", () => {
    const at = Date.parse("2026-11-21T12:00:00.000Z");
    expect(formatCheckedAtAgo("2026-11-21T12:00:00.000Z", at)).toBe("刚刚");
    expect(formatCheckedAtAgo("2026-11-21T11:59:59.000Z", at)).toBe("刚刚");
    expect(formatCheckedAtAgo("2026-11-21T11:55:30.000Z", at)).toBe("4 分钟前");
    expect(formatCheckedAtAgo("2026-11-21T11:55:00.000Z", at)).toBe("5 分钟前");
    expect(formatCheckedAtAgo("2026-11-21T11:00:00.000Z", at)).toBe("1 小时前");
    expect(formatCheckedAtAgo("2026-11-20T12:00:00.000Z", at)).toBe("1 天前");
    expect(formatCheckedAtAgo("2026-11-19T12:00:00.000Z", at)).toBe("2 天前");
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatCheckedAtAgo("not-a-date", now)).toBeNull();
  });
});

describe("sortLimitAccountsForCards", () => {
  it("sorts readable accounts naturally with numeric collation", () => {
    const sorted = sortLimitAccountsForCards([
      makeAccount({
        key: "a10",
        displayName: "agy-pro10",
        limits: {
          checkedAt: "",
          windows: [
            makeWindow({
              id: "1",
              kind: "session",
              label: "S",
              usedPercent: 0,
            }),
          ],
        },
      }),
      makeAccount({
        key: "a2",
        displayName: "agy-pro2",
        limits: {
          checkedAt: "",
          windows: [
            makeWindow({
              id: "1",
              kind: "session",
              label: "S",
              usedPercent: 0,
            }),
          ],
        },
      }),
      makeAccount({
        key: "empty",
        displayName: "agy-empty",
        limits: { checkedAt: "", windows: [] },
      }),
      makeAccount({
        key: "a1",
        displayName: "agy-pro1",
        limits: {
          checkedAt: "",
          windows: [
            makeWindow({
              id: "1",
              kind: "session",
              label: "S",
              usedPercent: 0,
            }),
          ],
        },
      }),
    ]);

    expect(sorted.map((a) => a.displayName)).toEqual([
      "agy-pro1",
      "agy-pro2",
      "agy-pro10",
      "agy-empty",
    ]);
  });
});
