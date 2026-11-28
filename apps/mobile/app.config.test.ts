import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    ...(process.env.T3CODE_MOBILE_VERSION
      ? { T3CODE_MOBILE_VERSION: process.env.T3CODE_MOBILE_VERSION }
      : {}),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.nidao003.lunacode.mobile"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.nidao003.lunacode.mobile"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.ios?.associatedDomains).toContain("applinks:connect.example.com");
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host: "connect.example.com", pathPrefix: "/threads/" },
  ]);
});

it("aligns default mobile version and derived iOS/Android build numbers with LunaCode releases", async () => {
  const defaultConfig = await loadConfig(undefined);
  expect(defaultConfig.version).toBe("0.1.13");
  expect(defaultConfig.ios?.buildNumber).toBe("113");
  expect(defaultConfig.android?.versionCode).toBe(113);

  vi.stubEnv("T3CODE_MOBILE_VERSION", "0.2.5");
  const overriddenConfig = await loadConfig("production");
  expect(overriddenConfig.version).toBe("0.2.5");
  expect(overriddenConfig.ios?.buildNumber).toBe("205");
  expect(overriddenConfig.android?.versionCode).toBe(205);
});
