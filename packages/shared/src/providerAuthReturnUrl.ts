import { isLoopbackHost } from "./preview.ts";

function optionalConfiguredOrigin(rawUrl: string | undefined): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

function configuredHostedOrigins(): readonly string[] {
  const env = (
    globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }
  ).process?.env;
  if (!env) return [];
  return [env.T3CODE_HOSTED_APP_URL, env.LUNACODE_AUTH_URL, env.LUNACODE_CONNECT_URL].flatMap(
    (candidate) => {
      const origin = optionalConfiguredOrigin(candidate);
      return origin ? [origin] : [];
    },
  );
}

export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) ||
        url.origin === "https://app.t3.codes" ||
        configuredHostedOrigins().includes(url.origin));
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
