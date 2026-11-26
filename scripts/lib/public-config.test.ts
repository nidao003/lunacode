// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("maps LUNACODE_CONNECT_URL to both auth and relay URLs when relay URL is unset", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "LUNACODE_CONNECT_URL=https://connect.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toMatchObject({
      LUNACODE_CONNECT_URL: "https://connect.example.test",
      LUNACODE_AUTH_URL: "https://connect.example.test",
      VITE_LUNACODE_AUTH_URL: "https://connect.example.test",
      EXPO_PUBLIC_LUNACODE_AUTH_URL: "https://connect.example.test",
      T3CODE_RELAY_URL: "https://connect.example.test",
      VITE_T3CODE_RELAY_URL: "https://connect.example.test",
      T3CODE_HOSTED_APP_URL: "https://connect.example.test",
      VITE_HOSTED_APP_URL: "https://connect.example.test",
    });
  });

  it("enables self-hosted auth mode without injecting any hardcoded private domain by default", () => {
    const repoRoot = makeTemporaryDirectory();
    const resolved = loadRepoEnv({ baseEnv: {}, repoRoot });
    expect(resolved).toMatchObject({
      LUNACODE_SELF_HOSTED_AUTH: "1",
      VITE_LUNACODE_SELF_HOSTED_AUTH: "1",
      EXPO_PUBLIC_LUNACODE_SELF_HOSTED_AUTH: "1",
    });
    expect(resolved.LUNACODE_CONNECT_URL).toBeUndefined();
    expect(resolved.LUNACODE_AUTH_URL).toBeUndefined();
    expect(resolved.VITE_LUNACODE_AUTH_URL).toBeUndefined();
    expect(resolved.EXPO_PUBLIC_LUNACODE_AUTH_URL).toBeUndefined();
    expect(resolved.T3CODE_RELAY_URL).toBeUndefined();
    expect(resolved.VITE_T3CODE_RELAY_URL).toBeUndefined();
    expect(resolved.T3CODE_HOSTED_APP_URL).toBeUndefined();
    expect(resolved.VITE_HOSTED_APP_URL).toBeUndefined();
  });

  it("allows disabling self-hosted LunaCode auth with LUNACODE_CONNECT_URL=off", () => {
    const repoRoot = makeTemporaryDirectory();
    const resolved = loadRepoEnv({ baseEnv: { LUNACODE_CONNECT_URL: "off" }, repoRoot });
    expect(resolved.LUNACODE_AUTH_URL).toBeUndefined();
    expect(resolved.T3CODE_RELAY_URL).toBeUndefined();
    expect(resolved.LUNACODE_SELF_HOSTED_AUTH).toBeUndefined();
    expect(resolved.VITE_LUNACODE_SELF_HOSTED_AUTH).toBeUndefined();
    expect(resolved.EXPO_PUBLIC_LUNACODE_SELF_HOSTED_AUTH).toBeUndefined();
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
