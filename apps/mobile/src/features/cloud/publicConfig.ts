import Constants from "expo-constants";
import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | ({
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    } & {
      readonly lunacode?: {
        readonly authUrl?: unknown;
        readonly selfHostedEnabled?: unknown;
      };
    })
  | undefined;

let runtimeLunaAuthUrlOverride: string | null = null;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function normalizeConnectRelayUrl(value: unknown, allowLoopbackHttp: boolean): string | null {
  const raw = trimNonEmpty(value) ?? "";
  const secure = normalizeSecureRelayUrl(raw);
  if (secure !== null) return secure;
  if (!allowLoopbackHttp) return null;
  try {
    const url = new URL(raw);
    return isLoopbackHttpUrl(raw) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function normalizeLunaMobileServerUrlInput(raw: string): string | null {
  return normalizeConnectRelayUrl(raw, true);
}

export function resolveDefaultLunaAuthUrl(
  extra: ExpoExtra = Constants.expoConfig?.extra,
): string | null {
  return normalizeLunaMobileServerUrlInput(trimNonEmpty(extra?.lunacode?.authUrl) ?? "");
}

export function isLunaSelfHostedAuthEnabled(
  extra: ExpoExtra = Constants.expoConfig?.extra,
): boolean {
  const configured = extra?.lunacode?.selfHostedEnabled;
  if (typeof configured === "boolean") return configured;
  return resolveLunaAuthUrl(extra) !== null;
}

export function getLunaAuthUrlOverride(): string | null {
  return runtimeLunaAuthUrlOverride;
}

export function setLunaAuthUrlOverride(
  raw: string | null,
  extra: ExpoExtra = Constants.expoConfig?.extra,
): string | null {
  const defaultUrl = resolveDefaultLunaAuthUrl(extra);
  if (raw === null) {
    runtimeLunaAuthUrlOverride = null;
    return defaultUrl;
  }
  const normalized = normalizeLunaMobileServerUrlInput(raw);
  if (normalized === null) {
    return null;
  }
  runtimeLunaAuthUrlOverride = normalized === defaultUrl ? null : normalized;
  return normalized;
}

export function resolveLunaAuthUrl(extra: ExpoExtra = Constants.expoConfig?.extra): string | null {
  return runtimeLunaAuthUrlOverride ?? resolveDefaultLunaAuthUrl(extra);
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  const overrideUrl = runtimeLunaAuthUrlOverride;
  const lunaAuthUrl = overrideUrl ?? resolveDefaultLunaAuthUrl(extra);
  const allowLoopbackHttp = lunaAuthUrl !== null && isLoopbackHttpUrl(lunaAuthUrl);
  return {
    clerk: {
      publishableKey: trimNonEmpty(extra?.clerk?.publishableKey),
      jwtTemplate: trimNonEmpty(extra?.clerk?.jwtTemplate),
    },
    relay: {
      url: normalizeConnectRelayUrl(
        overrideUrl ?? extra?.relay?.url ?? lunaAuthUrl,
        allowLoopbackHttp,
      ),
    },
    observability: {
      tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
      tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
      tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
    },
  } satisfies CloudPublicConfig;
}

export type MobileCloudAuthMode = "lunacode" | "clerk";

export function resolveCloudAuthMode(
  extra: ExpoExtra = Constants.expoConfig?.extra,
): MobileCloudAuthMode | null {
  const config = resolveCloudPublicConfig(extra);
  const lunaAuthUrl = resolveLunaAuthUrl(extra);
  if (
    !config.clerk.publishableKey &&
    (isLunaSelfHostedAuthEnabled(extra) || (lunaAuthUrl !== null && config.relay.url !== null))
  ) {
    return "lunacode";
  }
  return config.clerk.publishableKey && config.clerk.jwtTemplate && config.relay.url
    ? "clerk"
    : null;
}

export function hasCloudPublicConfig(): boolean {
  return resolveCloudAuthMode() !== null;
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is TracingPublicConfig {
  return Boolean(
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}

export function resolveRelayClerkTokenOptions() {
  if (resolveCloudAuthMode() === "lunacode") {
    return {};
  }
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  if (!jwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(jwtTemplate);
}
