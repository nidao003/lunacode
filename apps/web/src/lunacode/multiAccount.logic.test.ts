import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  buildClaudeIsolatedLoginCommand,
  buildIsolatedClaudeHomePath,
  maskAccountEmail,
  summarizeAccountInstances,
} from "./multiAccount.logic";

function makeServerProvider(input: {
  id: string;
  driver: string;
  displayName?: string;
  enabled?: boolean;
  authStatus?: "authenticated" | "unauthenticated" | "unknown";
  email?: string;
  authLabel?: string;
  version?: string;
  usageReason?: string;
  usageLimits?: ServerProvider["usageLimits"];
  homePath?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: input.version ?? "1.0.0",
    status: "ready",
    auth: {
      status: input.authStatus ?? "authenticated",
      ...(input.email ? { email: input.email } : {}),
      ...(input.authLabel ? { label: input.authLabel } : {}),
    },
    ...(input.usageLimits
      ? { usageLimits: input.usageLimits }
      : input.usageReason
        ? { usageLimits: { unavailable: { reason: input.usageReason } } }
        : {}),
    ...(input.homePath ? { runtimePaths: { homePath: input.homePath, shadowHomePath: null } } : {}),
    checkedAt: "2026-11-21T10:00:00.000Z" as never,
    models: [],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

describe("multiAccount.logic", () => {
  it("sanitizes instanceId into an isolated Claude homePath and login command", () => {
    const path = buildIsolatedClaudeHomePath("claudeAgent work/01");
    assert.equal(path, "~/.lunacode/accounts/claude/claudeAgent-work-01");
    assert.equal(
      buildClaudeIsolatedLoginCommand(path),
      'CLAUDE_CONFIG_DIR="~/.lunacode/accounts/claude/claudeAgent-work-01" claude login',
    );
  });

  it("flags shared default ~/.claude when >= 2 enabled Claude instances omit homePath", () => {
    const providerInstances: Record<string, ProviderInstanceConfig> = {
      claudeAgent: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
      },
      claude_work: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude Work",
        enabled: true,
      },
      claude_isolated: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude Isolated",
        enabled: true,
        config: { homePath: "~/.lunacode/accounts/claude/claude_isolated" },
      },
    };
    const summaries = summarizeAccountInstances({
      providerInstances,
      serverProviders: [
        makeServerProvider({
          id: "claudeAgent",
          driver: "claudeAgent",
          email: "a@example.com",
        }),
        makeServerProvider({
          id: "claude_work",
          driver: "claudeAgent",
          authStatus: "unauthenticated",
        }),
        makeServerProvider({
          id: "claude_isolated",
          driver: "claudeAgent",
          email: "b@example.com",
        }),
      ],
    });

    const sharedA = summaries.find((s) => String(s.instanceId) === "claudeAgent");
    const sharedB = summaries.find((s) => String(s.instanceId) === "claude_work");
    const isolated = summaries.find((s) => String(s.instanceId) === "claude_isolated");
    assert.equal(sharedA?.isolationKind, "shared-warning");
    assert.equal(sharedB?.isolationKind, "shared-warning");
    assert.equal(isolated?.isolationKind, "isolated");
    assert.equal(isolated?.accountEmail, "b@example.com");
  });

  it("marks Antigravity instances as auto-isolated", () => {
    const summaries = summarizeAccountInstances({
      providerInstances: {
        ag_ultra: {
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "ultra",
          enabled: true,
        },
      },
      serverProviders: [
        makeServerProvider({
          id: "ag_ultra",
          driver: "antigravity",
          displayName: "ultra",
          homePath: "/Users/test/.t3/userdata/providers/antigravity/hash1",
        }),
      ],
    });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.isolationKind, "auto-isolated");
    assert.include(summaries[0]?.isolationDetail ?? "", "antigravity/hash1");
  });

  it("separates real account email from authTypeLabel, infers Antigravity pending/login states, and flags duplicate display names", () => {
    const summaries = summarizeAccountInstances({
      providerInstances: {
        ag_1: {
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "Antigravity",
          enabled: true,
        },
        ag_2: {
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "Antigravity",
          enabled: true,
        },
        claudeAgent: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Claude",
          enabled: true,
        },
      },
      serverProviders: [
        makeServerProvider({
          id: "ag_1",
          driver: "antigravity",
          displayName: "Antigravity",
          authStatus: "unknown",
          email: "alpha@example.com",
          authLabel: "Google account",
          version: "1.5.13",
        }),
        makeServerProvider({
          id: "ag_2",
          driver: "antigravity",
          displayName: "Antigravity",
          authStatus: "unknown",
          usageReason: "unsupported",
        }),
        makeServerProvider({
          id: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude",
          authStatus: "authenticated",
          authLabel: "Custom API endpoint",
        }),
      ],
    });

    const ag1 = summaries.find((s) => String(s.instanceId) === "ag_1");
    const ag2 = summaries.find((s) => String(s.instanceId) === "ag_2");
    const claude = summaries.find((s) => String(s.instanceId) === "claudeAgent");

    assert.equal(ag1?.accountEmail, "alpha@example.com");
    assert.equal(ag1?.authTypeLabel, "Google account");
    assert.equal(ag1?.authStateKind, "saved-pending");
    assert.equal(ag1?.versionLabel, "v1.5.13");
    assert.isTrue(ag1?.hasDuplicateDisplayName);

    assert.isNull(ag2?.accountEmail);
    assert.equal(ag2?.authStateKind, "needs-login");
    assert.isTrue(ag2?.hasDuplicateDisplayName);

    assert.isNull(claude?.accountEmail);
    assert.equal(claude?.authTypeLabel, "Custom API endpoint");
    assert.equal(claude?.authStateKind, "authenticated");
    assert.isFalse(claude?.hasDuplicateDisplayName);

    assert.equal(maskAccountEmail("alpha@example.com"), "alp***@example.com");
    assert.equal(maskAccountEmail("devuser@example.org"), "dev***@example.org");
    // Kimi Code labels accounts by nickname, which has no address to hide.
    assert.equal(maskAccountEmail("test-user"), "test-user");
  });

  it("extracts compact quota badges from provider usageLimits", () => {
    const now = Date.parse("2026-11-21T12:00:00.000Z");
    const summaries = summarizeAccountInstances({
      now,
      serverProviders: [
        makeServerProvider({
          id: "antigravity",
          driver: "antigravity",
          displayName: "Antigravity",
          email: "alpha@example.com",
          usageLimits: {
            checkedAt: "2026-11-21T11:55:00.000Z",
            windows: [
              {
                id: "claude_weekly",
                kind: "weekly",
                label: "Claude & GPT (shared) · Weekly",
                usedPercent: 100,
                resetsAt: "2026-11-26T05:00:00.000Z",
              },
              {
                id: "gemini_5h",
                kind: "session",
                label: "Gemini · 5-hour",
                usedPercent: 20,
                resetsAt: "2026-11-21T12:51:00.000Z",
              },
            ],
          },
        }),
      ],
    });

    assert.deepEqual(summaries[0]?.quotaBadges, [
      {
        id: "gemini_5h",
        label: "Gemini 5h",
        fullLabel: "Gemini · 5-hour",
        remainingPercent: 80,
        tone: "healthy",
        resetsIn: "51m",
      },
      {
        id: "claude_weekly",
        label: "Claude/GPT 周",
        fullLabel: "Claude & GPT (shared) · Weekly",
        remainingPercent: 0,
        tone: "critical",
        resetsIn: "4d 17h",
      },
    ]);
    assert.equal(summaries[0]?.usageCheckedAt, "2026-11-21T11:55:00.000Z");
  });

  it("reports no usageCheckedAt until a quota read lands", () => {
    const summaries = summarizeAccountInstances({
      now: Date.parse("2026-11-21T12:00:00.000Z"),
      serverProviders: [
        makeServerProvider({
          id: "antigravity",
          driver: "antigravity",
          displayName: "Antigravity",
        }),
      ],
    });

    assert.equal(summaries[0]?.usageCheckedAt, null);
  });
});
