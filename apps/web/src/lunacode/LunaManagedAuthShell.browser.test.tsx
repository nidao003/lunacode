import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";

const STORAGE_KEY = "lunacode.connect.auth.v1";
const FUTURE_EXP_SECONDS = Math.floor(Date.UTC(2035, 0, 1) / 1_000);

function createLunaJwt(sub: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({
    sub,
    exp: FUTURE_EXP_SECONDS,
  })}.sig`;
}

describe("LunaManagedAuthShell", () => {
  it("loads environments and mobile devices via appAtomRegistry and applies zh translations inside dialogs", async () => {
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        const [{ closeLunaAccountDialog }, { deactivateManagedRelayAuthentication }, i18nRuntime] =
          await Promise.all([
            import("./cloudAuth"),
            import("../cloud/managedAuth"),
            import("../i18n/runtime"),
          ]);
        closeLunaAccountDialog();
        deactivateManagedRelayAuthentication();
        window.localStorage.removeItem(STORAGE_KEY);
        i18nRuntime.persistGTLocale("en");
        await i18nRuntime.whenLocaleReady();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      },
    };

    vi.stubEnv("VITE_LUNACODE_AUTH_URL", "https://relay.example.test");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");

    const token = createLunaJwt("user-1");
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        user: {
          id: "user-1",
          email: "nidao003@example.com",
          displayName: "nidao003",
        },
        accessToken: token,
        refreshToken: "refresh-token",
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/environments") {
        return Response.json({
          environments: [
            {
              environmentId: "env-1",
              label: "My Mac Studio",
              endpoint: {
                httpBaseUrl: "https://env-1.example.test",
                wsBaseUrl: "wss://env-1.example.test",
                providerKind: "t3_relay",
              },
              linkedAt: "2026-11-26T00:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/v2/client/devices") {
        return Response.json({
          devices: [
            {
              deviceId: "dev-1",
              label: "Demo iPhone",
              platform: "ios",
              iosMajorVersion: 18,
              appVersion: "2.3.0",
              notifications: {
                enabled: true,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: false,
                notifyOnFailure: true,
              },
              liveActivities: { enabled: true },
              updatedAt: "2026-11-26T00:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/v1/client/t3chat-link") {
        return Response.json({
          available: false,
          link: null,
          maxTunnelsOverride: 3,
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [{ default: LunaManagedAuthShell }, { openLunaAccountDialog }, i18nRuntime] =
      await Promise.all([
        import("./LunaManagedAuthShell"),
        import("./cloudAuth"),
        import("../i18n/runtime"),
      ]);

    i18nRuntime.startI18n();
    i18nRuntime.persistGTLocale("zh");
    await i18nRuntime.whenLocaleReady();

    await using screen = await render(
      <LunaManagedAuthShell>
        <div />
      </LunaManagedAuthShell>,
      { router: false },
    );
    expect(screen.container).toBeTruthy();

    openLunaAccountDialog("t3-connect");

    await expect.element(page.getByText("My Mac Studio")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "刷新", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "移动端设备", exact: true }).click();

    await expect.element(page.getByText("Demo iPhone")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "移动客户端" })).toBeVisible();
  });

  it("displays and switches backend login server URL inside auth dialog before signing in", async () => {
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        const { closeLunaAuthDialog, updateLunaServerUrl } = await import("./cloudAuth");
        closeLunaAuthDialog();
        await updateLunaServerUrl(null);
        window.localStorage.clear();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      },
    };

    vi.stubEnv("VITE_LUNACODE_AUTH_URL", "https://default.example.test:8443");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://default.example.test:8443");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");

    const loginUrls: Array<string> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/auth/login")) {
        loginUrls.push(url);
        return Response.json({
          user: {
            id: "user-2",
            email: "switch@example.com",
            displayName: "Switch User",
          },
          accessToken: createLunaJwt("user-2"),
          refreshToken: "refresh-token-2",
          expiresIn: 900,
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [{ default: LunaManagedAuthShell }, { openLunaAuthDialog }] = await Promise.all([
      import("./LunaManagedAuthShell"),
      import("./cloudAuth"),
    ]);

    await using screen = await render(
      <LunaManagedAuthShell>
        <div />
      </LunaManagedAuthShell>,
      { router: false },
    );
    expect(screen.container).toBeTruthy();

    openLunaAuthDialog();

    await expect.element(page.getByText("当前：https://default.example.test:8443")).toBeVisible();

    await page.getByLabelText("后台服务地址").fill("https://custom.example.test:9443/");
    await page.getByRole("button", { name: "保存并切换", exact: true }).click();

    await expect.element(page.getByText("当前：https://custom.example.test:9443")).toBeVisible();

    await page.getByLabelText("邮箱").fill("switch@example.com");
    await page.getByLabelText("密码").fill("password-123");
    await page.getByRole("button", { name: "登录", exact: true }).nth(1).click();

    await vi.waitFor(() => {
      expect(loginUrls).toEqual(["https://custom.example.test:9443/api/auth/login"]);
    });
  });
});
