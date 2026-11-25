// @effect-diagnostics globalDate:off - Pure presentation helper outside an Effect runtime; clock-bound callers pass explicit `now`.
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { extractCompactQuotaBadges, type LunaCompactQuotaBadge } from "./usageLimitsView.logic.ts";

export type AccountIsolationKind = "isolated" | "auto-isolated" | "default" | "shared-warning";

export type LunaAccountAuthStateKind =
  | "authenticated"
  | "saved-pending"
  | "needs-login"
  | "unauthenticated"
  | "checking"
  | "disabled";

export interface LunaAccountInstanceSummary {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly authStatus: "authenticated" | "unauthenticated" | "unknown";
  readonly authStateKind: LunaAccountAuthStateKind;
  readonly authLabel: string;
  readonly accountEmail: string | null;
  readonly authTypeLabel: string | null;
  readonly versionLabel: string | null;
  readonly accentColor: string | null;
  readonly hasDuplicateDisplayName: boolean;
  readonly isolationKind: AccountIsolationKind;
  readonly isolationDetail: string;
  readonly quotaBadges: ReadonlyArray<LunaCompactQuotaBadge>;
  /** When the reported quota was last read, for "updated N min ago" labels. */
  readonly usageCheckedAt: string | null;
}

export function buildIsolatedClaudeHomePath(instanceId: string): string {
  const safeId =
    instanceId
      .trim()
      .replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "account";
  return `~/.lunacode/accounts/claude/${safeId}`;
}

export function buildClaudeIsolatedLoginCommand(homePath: string): string {
  const trimmed = homePath.trim() || "~/.lunacode/accounts/claude/account";
  const escaped = trimmed.replaceAll('"', '\\"');
  return `CLAUDE_CONFIG_DIR="${escaped}" claude login`;
}

export function maskAccountEmail(email: string): string {
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf("@");
  // A nickname (Kimi Code) carries no address to hide; masking it would only garble the label.
  if (atIndex <= 0) return trimmed;
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const prefix = local.slice(0, Math.min(3, local.length));
  return `${prefix}***@${domain}`;
}

function readConfigString(config: unknown, key: string): string | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return null;
  }
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function summarizeAccountInstances(input: {
  readonly providerInstances?: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly now?: number | undefined;
}): ReadonlyArray<LunaAccountInstanceSummary> {
  const now = input.now ?? Date.now();
  const liveById = new Map<string, ServerProvider>();
  for (const sp of input.serverProviders) {
    liveById.set(String(sp.instanceId), sp);
  }

  const allIds = new Set<string>([
    ...Object.keys(input.providerInstances ?? {}),
    ...input.serverProviders.map((sp) => String(sp.instanceId)),
  ]);

  // Count how many enabled claudeAgent instances still point to the shared default ~/.claude dir,
  // and how many enabled instances per driver share identical display names.
  let enabledDefaultClaudeCount = 0;
  const enabledDisplayNameCounts = new Map<string, number>();

  for (const id of allIds) {
    const config = input.providerInstances?.[id];
    const live = liveById.get(id);
    const driver = config?.driver ?? live?.driver;
    if (!driver) continue;
    const enabled = config ? resolveProviderInstanceEnabled(config) : (live?.enabled ?? true);
    if (!enabled) continue;

    const driverLabel = PROVIDER_DISPLAY_NAMES[driver] ?? String(driver);
    const displayName = config?.displayName?.trim() || live?.displayName?.trim() || driverLabel;
    const nameKey = `${String(driver)}\0${displayName}`;
    enabledDisplayNameCounts.set(nameKey, (enabledDisplayNameCounts.get(nameKey) ?? 0) + 1);

    if (driver === "claudeAgent") {
      const homePath = readConfigString(config?.config, "homePath");
      if (!homePath) {
        enabledDefaultClaudeCount += 1;
      }
    }
  }

  const summaries: LunaAccountInstanceSummary[] = [];

  for (const id of allIds) {
    const config = input.providerInstances?.[id];
    const live = liveById.get(id);
    const driver = config?.driver ?? live?.driver;
    if (!driver) continue;

    const instanceId = (live?.instanceId ?? id) as ProviderInstanceId;
    const enabled = config ? resolveProviderInstanceEnabled(config) : (live?.enabled ?? true);
    const driverLabel = PROVIDER_DISPLAY_NAMES[driver] ?? String(driver);
    const displayName = config?.displayName?.trim() || live?.displayName?.trim() || driverLabel;

    const authStatus = live?.auth.status ?? "unknown";
    const accountEmail = live?.auth.email?.trim() || null;
    const authTypeLabel = live?.auth.label?.trim() || null;
    const rawVersion = live?.version?.trim();
    const versionLabel = rawVersion ? `v${rawVersion}` : null;
    const accentColor = config?.accentColor?.trim() || live?.accentColor?.trim() || null;

    let authStateKind: LunaAccountAuthStateKind;
    let authLabel: string;
    if (!enabled) {
      authStateKind = "disabled";
      authLabel = "已停用";
    } else if (authStatus === "authenticated") {
      authStateKind = "authenticated";
      authLabel = "已认证";
    } else if (authStatus === "unauthenticated") {
      authStateKind = "unauthenticated";
      authLabel = "未认证";
    } else if (accountEmail !== null) {
      authStateKind = "saved-pending";
      authLabel = "已登录·待唤醒";
    } else if (
      driver === "antigravity" &&
      live?.usageLimits?.unavailable?.reason === "unsupported"
    ) {
      authStateKind = "needs-login";
      authLabel = "待登录";
    } else {
      authStateKind = "checking";
      authLabel = "状态待检测";
    }

    const configuredHome = readConfigString(config?.config, "homePath");
    const liveHome = live?.runtimePaths?.homePath ?? null;
    const setupMode = readConfigString(config?.config, "setupMode");

    let isolationKind: AccountIsolationKind;
    let isolationDetail: string;

    if (driver === "antigravity") {
      isolationKind = "auto-isolated";
      isolationDetail = liveHome ?? "自动按 Instance ID 隔离认证目录";
    } else if (driver === "claudeAgent") {
      if (configuredHome) {
        isolationKind = "isolated";
        isolationDetail = `独立目录：${configuredHome}`;
      } else if (enabled && enabledDefaultClaudeCount >= 2) {
        isolationKind = "shared-warning";
        isolationDetail = "多个启用的 Claude 实例共用默认 ~/.claude，建议设置独立目录";
      } else {
        isolationKind = "default";
        isolationDetail = liveHome ?? "系统默认 ~/.claude 目录";
      }
    } else if (configuredHome || setupMode === "managed" || liveHome) {
      isolationKind = configuredHome || setupMode === "managed" ? "isolated" : "default";
      isolationDetail = configuredHome
        ? `独立目录：${configuredHome}`
        : setupMode === "managed"
          ? "T3 托管独立账号目录"
          : (liveHome ?? "默认配置目录");
    } else {
      isolationKind = "default";
      isolationDetail = "默认配置目录";
    }

    const hasDuplicateDisplayName =
      enabled && (enabledDisplayNameCounts.get(`${String(driver)}\0${displayName}`) ?? 0) >= 2;

    summaries.push({
      instanceId,
      driver,
      displayName,
      enabled,
      authStatus,
      authStateKind,
      authLabel,
      accountEmail,
      authTypeLabel,
      versionLabel,
      accentColor,
      hasDuplicateDisplayName,
      isolationKind,
      isolationDetail,
      quotaBadges: extractCompactQuotaBadges(live?.usageLimits, now),
      usageCheckedAt: live?.usageLimits?.checkedAt ?? null,
    });
  }

  return [...summaries].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return (
      String(left.driver).localeCompare(String(right.driver)) ||
      left.displayName.localeCompare(right.displayName)
    );
  });
}
