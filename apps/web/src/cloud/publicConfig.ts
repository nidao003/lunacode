import {
  clerkFrontendApiHostnameFromPublishableKey,
  relayClerkTokenOptions,
} from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

import { isHostedStaticApp } from "../hostedPairing";

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
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

const LUNA_AUTH_URL_OVERRIDE_STORAGE_KEY = "lunacode.connect.serverUrl.v1";

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
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

function normalizeConnectRelayUrl(raw: string, allowLoopbackHttp: boolean): string | null {
  const secure = normalizeSecureRelayUrl(raw);
  if (secure !== null) return secure;
  if (!allowLoopbackHttp) return null;
  try {
    const url = new URL(raw.trim());
    return isLoopbackHttpUrl(raw.trim()) &&
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

export function normalizeLunaServerUrlInput(raw: string): string | null {
  return normalizeConnectRelayUrl(raw, true);
}

export function resolveDefaultLunaAuthUrl(): string | null {
  const raw =
    trimNonEmpty(import.meta.env.VITE_LUNACODE_AUTH_URL as string | undefined) ??
    trimNonEmpty(import.meta.env.VITE_LUNACODE_CONNECT_URL as string | undefined);
  return raw ? normalizeLunaServerUrlInput(raw) : null;
}

export function isLunaSelfHostedAuthEnabled(): boolean {
  const flag = trimNonEmpty(import.meta.env.VITE_LUNACODE_SELF_HOSTED_AUTH as string | undefined);
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return resolveLunaAuthUrl() !== null;
}

export function readLunaAuthUrlOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LUNA_AUTH_URL_OVERRIDE_STORAGE_KEY);
    return raw ? normalizeLunaServerUrlInput(raw) : null;
  } catch {
    return null;
  }
}

export function writeLunaAuthUrlOverride(raw: string | null): string | null {
  if (raw === null) {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(LUNA_AUTH_URL_OVERRIDE_STORAGE_KEY);
      } catch {}
    }
    return resolveDefaultLunaAuthUrl();
  }
  const normalized = normalizeLunaServerUrlInput(raw);
  if (!normalized) return null;
  const defaultUrl = resolveDefaultLunaAuthUrl();
  if (typeof window !== "undefined") {
    try {
      if (normalized === defaultUrl) {
        window.localStorage.removeItem(LUNA_AUTH_URL_OVERRIDE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(LUNA_AUTH_URL_OVERRIDE_STORAGE_KEY, normalized);
      }
    } catch {}
  }
  return normalized;
}

export function resolveLunaAuthUrl(): string | null {
  return readLunaAuthUrlOverride() ?? resolveDefaultLunaAuthUrl();
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  const overrideUrl = readLunaAuthUrlOverride();
  const lunaAuthUrl = overrideUrl ?? resolveDefaultLunaAuthUrl();
  const allowLoopbackHttp = lunaAuthUrl !== null && isLoopbackHttpUrl(lunaAuthUrl);
  const rawRelay =
    overrideUrl ??
    (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ??
    lunaAuthUrl ??
    "";
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    relayUrl: normalizeConnectRelayUrl(rawRelay, allowLoopbackHttp),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

let desktopRelayTelemetry: boolean | null = null;
let serverRelayTelemetry: boolean | null = null;

export function setServerRelayTelemetry(allowed: boolean | null): void {
  serverRelayTelemetry = allowed;
}

export function relayTelemetryEnabled(): boolean | null {
  if (typeof window === "undefined") return true;
  if (window.desktopBridge) {
    desktopRelayTelemetry ??= window.desktopBridge.getRelayTelemetryEnabled();
    return desktopRelayTelemetry;
  }
  return serverRelayTelemetry ?? (isHostedStaticApp() ? true : null);
}

export function resolveRelayTracingConfig() {
  // The relay exporter is created during module initialization, so this must be synchronous.
  if (relayTelemetryEnabled() === false) {
    return null;
  }
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export type CloudAuthMode = "lunacode" | "clerk";

export function resolveCloudAuthMode(): CloudAuthMode | null {
  const config = resolveCloudPublicConfig();
  const lunaAuthUrl = resolveLunaAuthUrl();
  if (
    !config.clerkPublishableKey &&
    (isLunaSelfHostedAuthEnabled() || (lunaAuthUrl !== null && config.relayUrl !== null))
  ) {
    return "lunacode";
  }

  if (!config.clerkPublishableKey || !config.clerkJwtTemplate || !config.relayUrl) {
    return null;
  }

  // Electron has its own auth runtime; development keys also support private browser origins.
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !config.clerkPublishableKey.startsWith("pk_live_")
  ) {
    return "clerk";
  }

  try {
    // Custom Frontend API hosts use clerk.<production domain>.
    const domain = clerkFrontendApiHostnameFromPublishableKey(config.clerkPublishableKey).replace(
      /^clerk\./u,
      "",
    );
    const { hostname, protocol, port } = window.location;
    return protocol === "https:" &&
      port === "" &&
      (hostname === domain || hostname.endsWith(`.${domain}`))
      ? "clerk"
      : null;
  } catch {
    return null;
  }
}

export function hasCloudPublicConfig(): boolean {
  return resolveCloudAuthMode() !== null;
}

export function resolveRelayClerkTokenOptions() {
  if (resolveCloudAuthMode() === "lunacode") {
    return {};
  }
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}
