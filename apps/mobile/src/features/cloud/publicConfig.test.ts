import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolveCloudAuthMode,
  resolveCloudPublicConfig,
  resolveDefaultLunaAuthUrl,
  resolveLunaAuthUrl,
  setLunaAuthUrlOverride,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  afterEach(() => {
    setLunaAuthUrlOverride(null);
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("enables lunacode auth mode when lunacode.authUrl is set without Clerk keys", () => {
    expect(
      resolveCloudAuthMode({
        lunacode: { authUrl: "https://connect.example.test" },
        relay: { url: "https://connect.example.test" },
      }),
    ).toBe("lunacode");
  });

  it("enables lunacode auth mode without a default URL when selfHostedEnabled=true", () => {
    expect(
      resolveCloudAuthMode({
        lunacode: { selfHostedEnabled: true },
      }),
    ).toBe("lunacode");
  });

  it("applies runtime luna auth URL override over built-in defaults and rejects insecure URLs", () => {
    const extra = {
      lunacode: { authUrl: "https://default.example.test:8443" },
      relay: { url: "https://default.example.test:8443" },
    };

    expect(resolveDefaultLunaAuthUrl(extra)).toBe("https://default.example.test:8443");
    expect(setLunaAuthUrlOverride("http://insecure.example.test", extra)).toBeNull();
    expect(resolveLunaAuthUrl(extra)).toBe("https://default.example.test:8443");

    expect(setLunaAuthUrlOverride("https://custom.example.test:9443/", extra)).toBe(
      "https://custom.example.test:9443",
    );
    expect(resolveLunaAuthUrl(extra)).toBe("https://custom.example.test:9443");
    expect(resolveCloudPublicConfig(extra).relay.url).toBe("https://custom.example.test:9443");

    expect(setLunaAuthUrlOverride(null, extra)).toBe("https://default.example.test:8443");
    expect(resolveLunaAuthUrl(extra)).toBe("https://default.example.test:8443");
  });
});
