import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const secureStore = new Map<string, string>();
const activateCloudRelayAccountMock = vi.fn();
const deactivateCloudRelayAccountMock = vi.fn();

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        lunacode: {
          authUrl: null,
          selfHostedEnabled: true,
        },
        relay: { url: null },
        clerk: { publishableKey: null, jwtTemplate: null },
      },
    },
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => secureStore.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStore.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStore.delete(key);
  }),
}));

vi.mock("@clerk/expo", () => ({
  useAuth: vi.fn(),
  useUser: vi.fn(),
}));

vi.mock("../features/agent-awareness/remoteRegistration", () => ({
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

vi.mock("../features/cloud/cloud-drafts", () => ({
  removeCloudEnvironments: {},
}));

vi.mock("../features/cloud/cloudAccountService", () => ({
  activateCloudRelayAccount: activateCloudRelayAccountMock,
  deactivateCloudRelayAccount: deactivateCloudRelayAccountMock,
}));

vi.mock("../features/cloud/connectOnboarding", () => ({
  requestConnectOnboarding: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(async () => undefined),
  },
}));

vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: {},
}));

vi.mock("../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
}));

vi.mock("@t3tools/client-runtime/relay", () => ({
  ManagedRelay: {
    ManagedRelayClient: {},
  },
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: vi.fn(async () => undefined),
  settleAsyncResult: vi.fn(async () => undefined),
}));

const FIXED_NOW_MS = 1_800_000_000_000;
const VALID_EXPIRES_AT_MS = FIXED_NOW_MS + 300_000;

describe("cloudAuthActions.hydrateLunaMobileAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    secureStore.clear();
    activateCloudRelayAccountMock.mockClear();
    deactivateCloudRelayAccountMock.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    const publicConfig = await import("../features/cloud/publicConfig");
    publicConfig.setLunaAuthUrlOverride(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("recovers serverUrl and preserves signed-in session when upgrading to a build without a default URL", async () => {
    secureStore.set(
      "lunacode.connect.mobile.auth.v1",
      JSON.stringify({
        user: {
          id: "user_1",
          email: "user@example.com",
          displayName: "Demo User",
        },
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAtMs: VALID_EXPIRES_AT_MS,
        serverUrl: "https://connect.example.test:8443",
      }),
    );

    const cloudAuthModule = await import("./cloudAuth");
    const { hydrateLunaMobileAuth } = await import("./cloudAuthActions");

    await hydrateLunaMobileAuth();

    expect(cloudAuthModule.readLunaMobileAuthUrl()).toBe("https://connect.example.test:8443");
    expect(activateCloudRelayAccountMock).toHaveBeenCalledTimes(1);
    expect(activateCloudRelayAccountMock).toHaveBeenCalledWith("user_1", expect.any(Function));
    const tokenProvider = activateCloudRelayAccountMock.mock.calls[0]?.[1] as
      | (() => Promise<string | null>)
      | undefined;
    expect(tokenProvider).toBeTypeOf("function");
    await expect(tokenProvider?.()).resolves.toBe("valid-token");
  });

  it("drops old session when an explicit custom serverUrl points to a different server", async () => {
    secureStore.set("lunacode.connect.mobile.serverUrl.v1", "https://new.example.test:8443");
    secureStore.set(
      "lunacode.connect.mobile.auth.v1",
      JSON.stringify({
        user: {
          id: "user_1",
          email: "user@example.com",
          displayName: "Demo User",
        },
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAtMs: VALID_EXPIRES_AT_MS,
        serverUrl: "https://old.example.test:8443",
      }),
    );

    const { readLunaMobileAuthUrl } = await import("./cloudAuth");
    const { hydrateLunaMobileAuth } = await import("./cloudAuthActions");

    await hydrateLunaMobileAuth();

    expect(readLunaMobileAuthUrl()).toBe("https://new.example.test:8443");
    expect(activateCloudRelayAccountMock).not.toHaveBeenCalled();
  });
});
