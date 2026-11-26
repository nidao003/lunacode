import { useAuth } from "@clerk/react";
import { useSyncExternalStore } from "react";

import {
  activateManagedRelayAuthentication,
  cleanUpManagedRelayAccount,
  deactivateManagedRelayAuthentication,
} from "../cloud/managedAuth";
import {
  normalizeLunaServerUrlInput,
  resolveCloudAuthMode,
  resolveDefaultLunaAuthUrl,
  resolveLunaAuthUrl,
  writeLunaAuthUrlOverride,
} from "../cloud/publicConfig";
import type { T3ConnectAccountPageUrl } from "../components/clerk/T3ConnectAccountPages";

export interface LunaUserPermissions {
  readonly managedTunnels: boolean;
  readonly webhooks: boolean;
  readonly mobilePush: boolean;
}

export interface LunaAuthUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role?: "user" | "admin";
  readonly maxTunnels?: number;
  readonly permissions?: LunaUserPermissions;
}

export interface LunaAccountInfo {
  readonly user: LunaAuthUser;
  readonly activeTunnels: number;
  readonly deviceCount: number;
  readonly activeSessionCount: number;
}

interface StoredLunaAuth {
  readonly user: LunaAuthUser;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAtMs: number;
  readonly serverUrl?: string | null;
}

export interface LunaAuthState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly user: LunaAuthUser | null;
  readonly authDialogOpen: boolean;
  readonly accountDialogOpen: boolean;
  readonly accountDialogPage: T3ConnectAccountPageUrl;
  readonly serverUrl: string | null;
  readonly defaultServerUrl: string | null;
  readonly hasCustomServerUrl: boolean;
}

const STORAGE_KEY = "lunacode.connect.auth.v1";

function readInitialStored(): StoredLunaAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredLunaAuth>;
    if (!parsed.user?.id || !parsed.user?.email) return null;
    const activeUrl = resolveLunaAuthUrl();
    if (typeof parsed.serverUrl === "string" && parsed.serverUrl !== activeUrl) {
      return null;
    }
    const role =
      parsed.user.role === "admin" ? "admin" : parsed.user.role === "user" ? "user" : undefined;
    const rawPerms = parsed.user.permissions;
    const permissions =
      rawPerms &&
      typeof rawPerms.managedTunnels === "boolean" &&
      typeof rawPerms.webhooks === "boolean" &&
      typeof rawPerms.mobilePush === "boolean"
        ? rawPerms
        : undefined;
    return {
      user: {
        id: String(parsed.user.id),
        email: String(parsed.user.email),
        displayName: String(parsed.user.displayName ?? parsed.user.email),
        ...(role ? { role } : {}),
        ...(typeof parsed.user.maxTunnels === "number"
          ? { maxTunnels: parsed.user.maxTunnels }
          : {}),
        ...(permissions ? { permissions } : {}),
      },
      accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : null,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      expiresAtMs: typeof parsed.expiresAtMs === "number" ? parsed.expiresAtMs : 0,
      ...(typeof parsed.serverUrl === "string" ? { serverUrl: parsed.serverUrl } : {}),
    };
  } catch {
    return null;
  }
}

function writeStored(value: StoredLunaAuth | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    }
  } catch {}
}

let currentStored: StoredLunaAuth | null = readInitialStored();
let authDialogOpen = false;
let accountDialogOpen = false;
let accountDialogPage: T3ConnectAccountPageUrl = "t3-connect";
let isLoadedState = true;
let activeRefreshPromise: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

let cachedSnapshot: LunaAuthState = computeSnapshot();

function computeSnapshot(): LunaAuthState {
  const serverUrl = resolveLunaAuthUrl();
  const defaultServerUrl = resolveDefaultLunaAuthUrl();
  return {
    isLoaded: isLoadedState,
    isSignedIn: currentStored !== null,
    userId: currentStored?.user.id ?? null,
    user: currentStored?.user ?? null,
    authDialogOpen,
    accountDialogOpen,
    accountDialogPage,
    serverUrl,
    defaultServerUrl,
    hasCustomServerUrl: serverUrl !== null && serverUrl !== defaultServerUrl,
  };
}

function notify(): void {
  cachedSnapshot = computeSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LunaAuthState {
  return cachedSnapshot;
}

async function syncDesktopLunaAuthUrl(url: string | null): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const bridge = (
      window as {
        readonly lunaDesktopBridge?: {
          readonly setLunaAuthUrl?: (value: string | null) => Promise<void>;
        };
      }
    ).lunaDesktopBridge;
    if (typeof bridge?.setLunaAuthUrl === "function") {
      await bridge.setLunaAuthUrl(url);
    }
  } catch {}
}

function setStoredSession(next: StoredLunaAuth | null): void {
  const prevUserId = currentStored?.user.id ?? null;
  const nextUserId = next?.user.id ?? null;
  currentStored = next;
  writeStored(next);
  if (prevUserId && prevUserId !== nextUserId) {
    void cleanUpManagedRelayAccount().catch(() => undefined);
  }
  if (next) {
    activateManagedRelayAuthentication(next.user.id, getLunaAccessToken);
  } else {
    deactivateManagedRelayAuthentication();
  }
  notify();
}

export async function getLunaAccessToken(): Promise<string | null> {
  if (!currentStored) return null;
  if (currentStored.accessToken && currentStored.expiresAtMs - 30_000 > Date.now()) {
    return currentStored.accessToken;
  }
  if (activeRefreshPromise) return activeRefreshPromise;

  const authUrl = resolveLunaAuthUrl();
  if (!authUrl) return null;

  activeRefreshPromise = (async () => {
    try {
      const response = await fetch(`${authUrl}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          currentStored?.refreshToken ? { refreshToken: currentStored.refreshToken } : {},
        ),
      });
      if (!response.ok) {
        if (response.status === 401) {
          setStoredSession(null);
        }
        return null;
      }
      const data = (await response.json()) as {
        user?: LunaAuthUser;
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
      };
      if (!data.user?.id || !data.accessToken) return null;
      const updated: StoredLunaAuth = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? currentStored?.refreshToken ?? null,
        expiresAtMs: Date.now() + (data.expiresIn ?? 900) * 1_000,
        serverUrl: authUrl,
      };
      currentStored = updated;
      writeStored(updated);
      return updated.accessToken;
    } catch {
      return null;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

async function hydrateFromCookieSession(): Promise<void> {
  if (currentStored !== null || typeof window === "undefined") return;
  const authUrl = resolveLunaAuthUrl();
  if (!authUrl || window.location.origin !== authUrl) return;
  try {
    const res = await fetch(`${authUrl}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: "{}",
    });
    if (!res.ok || currentStored !== null) return;
    const data = (await res.json()) as {
      user?: LunaAuthUser;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
    };
    if (!data.user?.id || !data.accessToken) return;
    setStoredSession({
      user: data.user,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? null,
      expiresAtMs: Date.now() + (data.expiresIn ?? 900) * 1_000,
      serverUrl: authUrl,
    });
  } catch {
    // ignore background cookie hydration errors
  }
}

export function attachLunaAuthService(): () => void {
  void syncDesktopLunaAuthUrl(resolveLunaAuthUrl());
  if (currentStored) {
    activateManagedRelayAuthentication(currentStored.user.id, getLunaAccessToken);
    void getLunaAccessToken();
  } else {
    deactivateManagedRelayAuthentication();
    void hydrateFromCookieSession();
  }
  return () => {
    deactivateManagedRelayAuthentication();
  };
}

export async function updateLunaServerUrl(
  rawInput: string | null,
): Promise<
  | { readonly ok: true; readonly url: string | null; readonly signedOut: boolean }
  | { readonly ok: false; readonly message: string }
> {
  const prevUrl = resolveLunaAuthUrl();
  const trimmed = rawInput?.trim() ?? "";
  if (rawInput !== null && trimmed !== "" && normalizeLunaServerUrlInput(trimmed) === null) {
    return {
      ok: false,
      message:
        "请输入有效的 HTTPS 后台地址（例如 https://connect.example.com:8443），不要包含路径或查询参数。",
    };
  }
  const nextUrl =
    rawInput === null || trimmed === ""
      ? writeLunaAuthUrlOverride(null)
      : writeLunaAuthUrlOverride(trimmed);
  const changed = prevUrl !== nextUrl;
  let signedOut = false;
  if (changed && currentStored !== null) {
    signedOut = true;
    accountDialogOpen = false;
    setStoredSession(null);
    await cleanUpManagedRelayAccount().catch(() => undefined);
  }
  await syncDesktopLunaAuthUrl(nextUrl ?? null);
  notify();
  return { ok: true, url: nextUrl ?? null, signedOut };
}

export async function signInLunaAccount(input: {
  readonly email: string;
  readonly password: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const authUrl = resolveLunaAuthUrl();
  if (!authUrl) return { ok: false, message: "未配置自建登录服务器地址。" };
  await syncDesktopLunaAuthUrl(authUrl);
  const res = await fetch(`${authUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email: input.email, password: input.password }),
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接登录服务器，请检查网络。" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    user?: LunaAuthUser;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    message?: string;
    error?: string;
  };
  if (!res.ok || !data.user || !data.accessToken) {
    return { ok: false, message: data.message || data.error || "邮箱或密码错误。" };
  }
  setStoredSession({
    user: data.user,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAtMs: Date.now() + (data.expiresIn ?? 900) * 1_000,
    serverUrl: authUrl,
  });
  authDialogOpen = false;
  notify();
  return { ok: true };
}

export async function registerLunaAccount(input: {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const authUrl = resolveLunaAuthUrl();
  if (!authUrl) return { ok: false, message: "未配置自建登录服务器地址。" };
  await syncDesktopLunaAuthUrl(authUrl);
  const res = await fetch(`${authUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
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
    user?: LunaAuthUser;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    message?: string;
    error?: string;
  };
  if (!res.ok || !data.user || !data.accessToken) {
    return { ok: false, message: data.message || data.error || "注册失败。" };
  }
  setStoredSession({
    user: data.user,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAtMs: Date.now() + (data.expiresIn ?? 900) * 1_000,
    serverUrl: authUrl,
  });
  authDialogOpen = false;
  notify();
  return { ok: true };
}

export async function signOutLunaAccount(): Promise<void> {
  const authUrl = resolveLunaAuthUrl();
  const refreshToken = currentStored?.refreshToken;
  accountDialogOpen = false;
  setStoredSession(null);
  await cleanUpManagedRelayAccount().catch(() => undefined);
  if (authUrl) {
    await fetch(`${authUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    }).catch(() => undefined);
  }
}

export async function fetchLunaAccountInfo(): Promise<
  | { readonly ok: true; readonly info: LunaAccountInfo }
  | { readonly ok: false; readonly message: string }
> {
  const authUrl = resolveLunaAuthUrl();
  const token = await getLunaAccessToken();
  if (!authUrl || !token) {
    return { ok: false, message: "尚未登录或登录已失效。" };
  }
  const res = await fetch(`${authUrl}/api/auth/account`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    credentials: "include",
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接账号服务器。" };
  }
  const data = (await res.json().catch(() => ({}))) as Partial<LunaAccountInfo> & {
    message?: string;
    error?: string;
  };
  if (!res.ok || !data.user) {
    return { ok: false, message: data.message || data.error || "加载账号信息失败。" };
  }
  if (currentStored) {
    currentStored = { ...currentStored, user: data.user };
    writeStored(currentStored);
    notify();
  }
  return {
    ok: true,
    info: {
      user: data.user,
      activeTunnels: typeof data.activeTunnels === "number" ? data.activeTunnels : 0,
      deviceCount: typeof data.deviceCount === "number" ? data.deviceCount : 0,
      activeSessionCount: typeof data.activeSessionCount === "number" ? data.activeSessionCount : 1,
    },
  };
}

export async function updateLunaProfile(
  displayName: string,
): Promise<
  | { readonly ok: true; readonly user: LunaAuthUser }
  | { readonly ok: false; readonly message: string }
> {
  const authUrl = resolveLunaAuthUrl();
  const token = await getLunaAccessToken();
  if (!authUrl || !token) {
    return { ok: false, message: "尚未登录或登录已失效。" };
  }
  const res = await fetch(`${authUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    credentials: "include",
    body: JSON.stringify({ displayName }),
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接账号服务器。" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    user?: LunaAuthUser;
    message?: string;
    error?: string;
  };
  if (!res.ok || !data.user) {
    return { ok: false, message: data.message || data.error || "更新昵称失败。" };
  }
  if (currentStored) {
    currentStored = { ...currentStored, user: data.user };
    writeStored(currentStored);
    notify();
  }
  return { ok: true, user: data.user };
}

export async function changeLunaPassword(input: {
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const authUrl = resolveLunaAuthUrl();
  const token = await getLunaAccessToken();
  if (!authUrl || !token) {
    return { ok: false, message: "尚未登录或登录已失效。" };
  }
  const res = await fetch(`${authUrl}/api/auth/change-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    credentials: "include",
    body: JSON.stringify(input),
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接账号服务器。" };
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) {
    return { ok: false, message: data.message || data.error || "修改密码失败。" };
  }
  return { ok: true };
}

export async function revokeOtherLunaSessions(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  const authUrl = resolveLunaAuthUrl();
  const token = await getLunaAccessToken();
  if (!authUrl || !token) {
    return { ok: false, message: "尚未登录或登录已失效。" };
  }
  const res = await fetch(`${authUrl}/api/auth/revoke-other-sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    credentials: "include",
  }).catch(() => null);
  if (!res) {
    return { ok: false, message: "无法连接账号服务器。" };
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) {
    return { ok: false, message: data.message || data.error || "注销其他会话失败。" };
  }
  return { ok: true };
}

export function openLunaAuthDialog(): void {
  authDialogOpen = true;
  notify();
}

export function closeLunaAuthDialog(): void {
  authDialogOpen = false;
  notify();
}

export function openLunaAccountDialog(page: T3ConnectAccountPageUrl = "t3-connect"): void {
  accountDialogPage = page;
  accountDialogOpen = true;
  notify();
}

export function closeLunaAccountDialog(): void {
  accountDialogOpen = false;
  notify();
}

export function useLunaAuthState(): LunaAuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useLunaCloudAuth(_options?: { readonly treatPendingAsSignedOut?: boolean }) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    isLoaded: state.isLoaded,
    isSignedIn: state.isSignedIn,
    userId: state.userId,
    getToken: async (_opts?: unknown) => getLunaAccessToken(),
  };
}

function useClerkCloudAuth(options?: { readonly treatPendingAsSignedOut?: boolean }) {
  return useAuth(options as Parameters<typeof useAuth>[0]);
}

export const useCloudAuth =
  resolveCloudAuthMode() === "lunacode" ? useLunaCloudAuth : useClerkCloudAuth;

export async function authorizeCliWithLunaAccount(input: {
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort: number;
}): Promise<string | null> {
  const authUrl = resolveLunaAuthUrl();
  const token = await getLunaAccessToken();
  if (!authUrl || !token) return null;
  const res = await fetch(`${authUrl}/api/auth/cli/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { redirectTo?: string };
  return typeof data.redirectTo === "string" ? data.redirectTo : null;
}
