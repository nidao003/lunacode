import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  normalizeLunaServerUrlInput,
  readLunaAuthUrlOverride,
  resolveCloudAuthMode,
  resolveCloudPublicConfig,
  resolveDefaultLunaAuthUrl,
  resolveLunaAuthUrl,
  writeLunaAuthUrlOverride,
} from "./publicConfig";

describe("web cloud publicConfig", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("normalizes HTTPS and loopback HTTP backend URLs and rejects invalid paths or plain remote HTTP", () => {
    expect(normalizeLunaServerUrlInput(" https://connect.example.com:8443/ ")).toBe(
      "https://connect.example.com:8443",
    );
    expect(normalizeLunaServerUrlInput("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeLunaServerUrlInput("http://remote.example.com:8787")).toBeNull();
    expect(normalizeLunaServerUrlInput("https://connect.example.com:8443/api")).toBeNull();
    expect(normalizeLunaServerUrlInput("https://connect.example.com:8443/?foo=bar")).toBeNull();
  });

  it("enables lunacode auth mode without a default URL when VITE_LUNACODE_SELF_HOSTED_AUTH=1", () => {
    vi.stubEnv("VITE_LUNACODE_SELF_HOSTED_AUTH", "1");
    vi.stubEnv("VITE_LUNACODE_AUTH_URL", "");
    vi.stubEnv("VITE_LUNACODE_CONNECT_URL", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");

    expect(resolveDefaultLunaAuthUrl()).toBeNull();
    expect(resolveLunaAuthUrl()).toBeNull();
    expect(resolveCloudAuthMode()).toBe("lunacode");
  });

  it("overrides build-time auth and relay URLs in localStorage and resets cleanly to default", () => {
    vi.stubEnv("VITE_LUNACODE_AUTH_URL", "https://default.example.test:8443");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://default.example.test:8443");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");

    expect(resolveDefaultLunaAuthUrl()).toBe("https://default.example.test:8443");
    expect(resolveLunaAuthUrl()).toBe("https://default.example.test:8443");
    expect(readLunaAuthUrlOverride()).toBeNull();

    expect(writeLunaAuthUrlOverride("https://custom.example.test:9443/")).toBe(
      "https://custom.example.test:9443",
    );
    expect(readLunaAuthUrlOverride()).toBe("https://custom.example.test:9443");
    expect(resolveLunaAuthUrl()).toBe("https://custom.example.test:9443");
    expect(resolveCloudPublicConfig().relayUrl).toBe("https://custom.example.test:9443");

    expect(writeLunaAuthUrlOverride(null)).toBe("https://default.example.test:8443");
    expect(readLunaAuthUrlOverride()).toBeNull();
    expect(resolveCloudPublicConfig().relayUrl).toBe("https://default.example.test:8443");
  });
});
