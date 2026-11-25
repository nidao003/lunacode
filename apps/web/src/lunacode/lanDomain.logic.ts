import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { createAdvertisedEndpoint, normalizeHttpBaseUrl } from "@t3tools/shared/advertisedEndpoint";

export type CustomLanEndpointNormalization =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

const DEFAULT_DESKTOP_PORT = 3773;

/** Extracts the active listening port from desktop advertised endpoints, falling back to `3773`. */
export function extractPortFromEndpoints(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  fallbackPort = DEFAULT_DESKTOP_PORT,
): number {
  const ordered = [
    ...endpoints.filter((endpoint) => endpoint.id.startsWith("desktop-lan:")),
    ...endpoints.filter((endpoint) => endpoint.id.startsWith("desktop-lan-mdns:")),
    ...endpoints.filter((endpoint) => endpoint.id.startsWith("desktop-loopback:")),
    ...endpoints,
  ];
  for (const endpoint of ordered) {
    try {
      const parsed = new URL(endpoint.httpBaseUrl);
      const port = Number(parsed.port);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        return port;
      }
    } catch {
      // Ignore malformed endpoints.
    }
  }
  return fallbackPort;
}

function hasExplicitUrlPort(rawInput: string, parsedHostHeader: string): boolean {
  if (/^https?:\/\//i.test(rawInput)) {
    const afterScheme = rawInput.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
    return /:\d+$/u.test(afterScheme);
  }
  return /:\d+$/u.test(parsedHostHeader);
}

/**
 * Normalizes a custom LAN domain or URL (such as `daodao-2.local:8000` or `http://daodao-2.local/`)
 * into a canonical origin URL with trailing slash. Rejects paths, queries, fragments, and credentials.
 */
export function normalizeCustomLanEndpointUrl(
  rawInput: string,
  defaultPort: number,
): CustomLanEndpointNormalization {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: "请输入局域网域名或完整 URL。" };
  }
  if (/\s/u.test(trimmed)) {
    return { ok: false, error: "地址中不能包含空格。" };
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: "仅支持 http:// 或 https:// 协议。" };
  }

  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "域名或 URL 格式无效。" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "仅支持 http:// 或 https:// 协议。" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "地址中不能包含用户名或密码。" };
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    return { ok: false, error: "仅支持填写主机根地址（不支持子路径）。" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "地址中不能包含查询参数或锚点。" };
  }

  const host = parsed.hostname.trim();
  if (!host || host.includes("..") || host.startsWith(".") || host.endsWith(".")) {
    return { ok: false, error: "请输入有效的域名或局域网地址。" };
  }

  if (parsed.protocol === "http:" && !parsed.port && !hasExplicitUrlPort(trimmed, parsed.host)) {
    parsed.port = String(defaultPort);
  }

  return { ok: true, url: normalizeHttpBaseUrl(parsed.toString()) };
}

export function buildCustomLanAdvertisedEndpoint(
  rawInput: string,
  defaultPort: number,
): AdvertisedEndpoint | null {
  const normalized = normalizeCustomLanEndpointUrl(rawInput, defaultPort);
  if (!normalized.ok) return null;
  return createAdvertisedEndpoint({
    id: `desktop-lan-custom:${normalized.url}`,
    label: "Custom LAN domain",
    provider: {
      id: "desktop-core",
      label: "Desktop",
      kind: "core",
      isAddon: false,
    },
    source: "user",
    httpBaseUrl: normalized.url,
    reachability: "lan",
    status: "available",
    description: "Custom LAN domain or reverse-proxy URL configured for same-network pairing.",
  });
}

export function mergeCustomLanAdvertisedEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  customLanHost: string,
): ReadonlyArray<AdvertisedEndpoint> {
  if (!customLanHost.trim()) return endpoints;
  const defaultPort = extractPortFromEndpoints(endpoints);
  const customEndpoint = buildCustomLanAdvertisedEndpoint(customLanHost, defaultPort);
  if (!customEndpoint) return endpoints;
  const normalizedUrl = customEndpoint.httpBaseUrl.toLowerCase();
  if (endpoints.some((endpoint) => endpoint.httpBaseUrl.toLowerCase() === normalizedUrl)) {
    return endpoints;
  }
  return [...endpoints, customEndpoint];
}
