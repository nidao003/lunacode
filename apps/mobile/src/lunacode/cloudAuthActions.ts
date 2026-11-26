import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { runAtomCommand, settleAsyncResult } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as SecureStore from "expo-secure-store";

import { unregisterAgentAwarenessDeviceForCurrentUser } from "../features/agent-awareness/remoteRegistration";
import { removeCloudEnvironments } from "../features/cloud/cloud-drafts";
import {
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
} from "../features/cloud/cloudAccountService";
import { requestConnectOnboarding } from "../features/cloud/connectOnboarding";
import {
  normalizeLunaMobileServerUrlInput,
  setLunaAuthUrlOverride,
} from "../features/cloud/publicConfig";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../state/use-composer-drafts";
import {
  type LunaMobileUser,
  readLunaMobileAuthMode,
  readLunaMobileAuthUrl,
  readLunaMobileDefaultAuthUrl,
  registerLunaMobileTokenProvider,
  setLunaMobileAuthViewState,
} from "./cloudAuth";

interface StoredMobileSession {
  readonly user: LunaMobileUser;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAtMs: number;
  readonly serverUrl?: string | null;
}

const STORAGE_KEY = "lunacode.connect.mobile.auth.v1";
const SERVER_URL_STORAGE_KEY = "lunacode.connect.mobile.serverUrl.v1";

let currentStored: StoredMobileSession | null = null;
let isLoadedState = false;
let activeRefresh: Promise<string | null> | null = null;

function publishAuthState(): void {
  setLunaMobileAuthViewState({
    isLoaded: isLoadedState,
    isSignedIn: currentStored !== null,
    userId: currentStored?.user.id ?? null,
    user: currentStored?.user ?? null,
  });
}

async function persistSession(next: StoredMobileSession | null): Promise<void> {
  try {
    if (next === null) {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    } else {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {}
}

async function applySignedInSession(next: StoredMobileSession): Promise<void> {
  const prevUserId = currentStored?.user.id ?? null;
  const savedDraftAccountId = await getComposerCloudAccountId().catch(() => null);
  currentStored = next;
  isLoadedState = true;
  await persistSession(next);
  if (prevUserId && prevUserId !== next.user.id) {
    await runAtomCommand(appAtomRegistry, removeCloudEnvironments, next.user.id, {
      reportFailure: false,
      reportDefect: false,
    }).catch(() => undefined);
  }
  activateCloudRelayAccount(next.user.id, getLunaMobileAccessToken);
  if (savedDraftAccountId !== next.user.id) {
    await restoreCloudComposerDrafts(next.user.id).catch(() => undefined);
  }
  if (!prevUserId) {
    requestConnectOnboarding(next.user.id);
  }
  publishAuthState();
}

async function getLunaMobileAccessToken(): Promise<string | null> {
  if (!currentStored) return null;
  if (currentStored.accessToken && currentStored.expiresAtMs - 30_000 > Date.now()) {
    return currentStored.accessToken;
  }
  if (activeRefresh) return activeRefresh;

  const authUrl = readLunaMobileAuthUrl();
  if (!authUrl || !currentStored.refreshToken) return null;

  activeRefresh = (async () => {
    try {
      const response = await fetch(`${authUrl}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: currentStored?.refreshToken }),
      });
      if (!response.ok) {
        if (response.status === 401) {
          currentStored = null;
          await persistSession(null);
          deactivateCloudRelayAccount();
          publishAuthState();
        }
        return null;
      }
      const data = (await response.json()) as {
        user?: LunaMobileUser;
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
      };
      if (!data.user?.id || !data.accessToken) return null;
      const updated: StoredMobileSession = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? currentStored?.refreshToken ?? null,
        expiresAtMs: Date.now() + (data.expiresIn ?? 900) * 1_000,
        serverUrl: authUrl,
      };
      currentStored = updated;
      await persistSession(updated);
      return updated.accessToken;
    } catch {
      return null;
    } finally {
      activeRefresh = null;
    }
  })();

  return activeRefresh;
}

registerLunaMobileTokenProvider(getLunaMobileAccessToken);

export async function hydrateLunaMobileAuth(): Promise<void> {
  try {
    const savedServerUrl = await SecureStore.getItemAsync(SERVER_URL_STORAGE_KEY);
    if (savedServerUrl) {
      setLunaAuthUrlOverride(savedServerUrl);
    }
  } catch {}
  if (readLunaMobileAuthMode() !== "lunacode") {
    isLoadedState = true;
    publishAuthState();
    return;
  }
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredMobileSession>;
      const activeUrl = readLunaMobileAuthUrl();
      if (
        parsed.user?.id &&
        parsed.user?.email &&
        !(typeof parsed.serverUrl === "string" && parsed.serverUrl !== activeUrl)
      ) {
        const storedPermissions = parsed.user.permissions;
        currentStored = {
          user: {
            id: String(parsed.user.id),
            email: String(parsed.user.email),
            displayName: String(parsed.user.displayName ?? parsed.user.email),
            ...(parsed.user.role === "admin" || parsed.user.role === "user"
              ? { role: parsed.user.role }
              : {}),
            ...(typeof parsed.user.maxTunnels === "number"
              ? { maxTunnels: parsed.user.maxTunnels }
              : {}),
            ...(storedPermissions && typeof storedPermissions === "object"
              ? {
                  permissions: {
                    managedTunnels: storedPermissions.managedTunnels !== false,
                    webhooks: storedPermissions.webhooks !== false,
                    mobilePush: storedPermissions.mobilePush !== false,
                  },
                }
              : {}),
          },
          accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : null,
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
          expiresAtMs: typeof parsed.expiresAtMs === "number" ? parsed.expiresAtMs : 0,
          ...(typeof parsed.serverUrl === "string" ? { serverUrl: parsed.serverUrl } : {}),
        };
        activateCloudRelayAccount(currentStored.user.id, getLunaMobileAccessToken);
        await getLunaMobileAccessToken();
      }
    }
  } catch {}
  isLoadedState = true;
  publishAuthState();
}

export async function updateLunaMobileServerUrl(
  rawInput: string | null,
): Promise<
  | { readonly ok: true; readonly url: string | null; readonly signedOut: boolean }
  | { readonly ok: false; readonly message: string }
> {
  const prevUrl = readLunaMobileAuthUrl();
  const trimmed = rawInput?.trim() ?? "";
  const candidate =
    rawInput === null || trimmed === ""
      ? readLunaMobileDefaultAuthUrl()
      : normalizeLunaMobileServerUrlInput(trimmed);
  if (rawInput !== null && trimmed !== "" && candidate === null) {
    return {
      ok: false,
      message:
        "请输入有效的 HTTPS 后台地址（例如 https://connect.example.com:8443），不要包含路径或查询参数。",
    };
  }
  const changed = prevUrl !== (candidate ?? null);
  let signedOut = false;
  if (changed && currentStored !== null) {
    signedOut = true;
    await signOutLunaMobileAccount();
  }
  const nextUrl =
    rawInput === null || trimmed === ""
      ? setLunaAuthUrlOverride(null)
      : setLunaAuthUrlOverride(trimmed);
  try {
    const defaultUrl = readLunaMobileDefaultAuthUrl();
    if (nextUrl === null || nextUrl === defaultUrl) {
      await SecureStore.deleteItemAsync(SERVER_URL_STORAGE_KEY);
    } else {
      await SecureStore.setItemAsync(SERVER_URL_STORAGE_KEY, nextUrl);
    }
  } catch {}
  publishAuthState();
  return { ok: true, url: nextUrl ?? null, signedOut };
}

export async function signInLunaMobileAccount(input: {
  readonly email: string;
  readonly password: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const authUrl = readLunaMobileAuthUrl();
  if (!authUrl) return { ok: false, message: "未配置自建登录服务器地址。" };
  const res = await fetch(`${authUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: input.email, password: input.password }),
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接登录服务器，请检查网络。" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    user?: LunaMobileUser;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    message?: string;
    error?: string;
  };
  if (!res.ok || !data.user || !data.accessToken) {
    return { ok: false, message: data.message || data.error || "邮箱或密码错误。" };
  }
  await applySignedInSession({
    user: data.user,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAtMs: Date.now() + (data.expiresIn ?? 900) * 1_000,
    serverUrl: authUrl,
  });
  return { ok: true };
}

export async function registerLunaMobileAccount(input: {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const authUrl = readLunaMobileAuthUrl();
  if (!authUrl) return { ok: false, message: "未配置自建登录服务器地址。" };
  const res = await fetch(`${authUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      displayName: input.displayName,
    }),
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接登录服务器，请检查网络。" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    user?: LunaMobileUser;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    message?: string;
    error?: string;
  };
  if (!res.ok || !data.user || !data.accessToken) {
    return { ok: false, message: data.message || data.error || "注册失败。" };
  }
  await applySignedInSession({
    user: data.user,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAtMs: Date.now() + (data.expiresIn ?? 900) * 1_000,
    serverUrl: authUrl,
  });
  return { ok: true };
}

export async function signOutLunaMobileAccount(): Promise<void> {
  const prevToken = currentStored?.accessToken;
  const refreshToken = currentStored?.refreshToken;
  const authUrl = readLunaMobileAuthUrl();
  if (prevToken) {
    await settleAsyncResult(() =>
      runtime.runPromiseExit(unregisterAgentAwarenessDeviceForCurrentUser(async () => prevToken)),
    ).catch(() => undefined);
  }
  currentStored = null;
  isLoadedState = true;
  await persistSession(null);
  deactivateCloudRelayAccount();
  await runAtomCommand(appAtomRegistry, removeCloudEnvironments, null, {
    reportFailure: false,
    reportDefect: false,
  }).catch(() => undefined);
  await settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  ).catch(() => undefined);
  if (authUrl) {
    await fetch(`${authUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    }).catch(() => undefined);
  }
  publishAuthState();
}

export interface LunaMobileAccountInfo {
  readonly user: LunaMobileUser;
  readonly activeTunnels: number;
  readonly deviceCount: number;
  readonly activeSessionCount: number;
}

async function callMobileAccountApi<T>(input: {
  readonly path: string;
  readonly method: "GET" | "PATCH" | "POST";
  readonly body?: Record<string, unknown>;
  readonly fallbackError: string;
}): Promise<
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string }
> {
  const authUrl = readLunaMobileAuthUrl();
  const token = await getLunaMobileAccessToken();
  if (!authUrl || !token) {
    return { ok: false, message: "登录状态已失效，请重新登录。" };
  }
  const res = await fetch(`${authUrl}${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(input.body ? { "content-type": "application/json" } : {}),
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接账号服务器，请检查网络。" };
  }
  const data = (await res.json().catch(() => ({}))) as T & {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    return { ok: false, message: data.message || data.error || input.fallbackError };
  }
  return { ok: true, data };
}

export async function fetchLunaMobileAccountInfo(): Promise<
  | { readonly ok: true; readonly info: LunaMobileAccountInfo }
  | { readonly ok: false; readonly message: string }
> {
  const res = await callMobileAccountApi<Partial<LunaMobileAccountInfo>>({
    path: "/api/auth/account",
    method: "GET",
    fallbackError: "读取账号信息失败。",
  });
  if (!res.ok || !res.data.user) {
    return res.ok ? { ok: false, message: "读取账号信息失败。" } : res;
  }
  if (currentStored) {
    currentStored = { ...currentStored, user: res.data.user };
    await persistSession(currentStored);
    publishAuthState();
  }
  return {
    ok: true,
    info: {
      user: res.data.user,
      activeTunnels: typeof res.data.activeTunnels === "number" ? res.data.activeTunnels : 0,
      deviceCount: typeof res.data.deviceCount === "number" ? res.data.deviceCount : 0,
      activeSessionCount:
        typeof res.data.activeSessionCount === "number" ? res.data.activeSessionCount : 1,
    },
  };
}

export async function updateLunaMobileProfile(
  displayName: string,
): Promise<
  | { readonly ok: true; readonly user: LunaMobileUser }
  | { readonly ok: false; readonly message: string }
> {
  const res = await callMobileAccountApi<{ user?: LunaMobileUser }>({
    path: "/api/auth/profile",
    method: "PATCH",
    body: { displayName },
    fallbackError: "更新昵称失败。",
  });
  if (!res.ok || !res.data.user) {
    return res.ok ? { ok: false, message: "更新昵称失败。" } : res;
  }
  if (currentStored) {
    currentStored = { ...currentStored, user: res.data.user };
    await persistSession(currentStored);
    publishAuthState();
  }
  return { ok: true, user: res.data.user };
}

export async function changeLunaMobilePassword(input: {
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const res = await callMobileAccountApi<Record<string, unknown>>({
    path: "/api/auth/change-password",
    method: "POST",
    body: input,
    fallbackError: "修改密码失败。",
  });
  return res.ok ? { ok: true } : res;
}

export async function revokeOtherLunaMobileSessions(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  const res = await callMobileAccountApi<Record<string, unknown>>({
    path: "/api/auth/revoke-other-sessions",
    method: "POST",
    fallbackError: "注销其他设备会话失败。",
  });
  return res.ok ? { ok: true } : res;
}
