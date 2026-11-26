import { useAuth, useUser } from "@clerk/expo";
import { useSyncExternalStore } from "react";

import * as PublicConfig from "../features/cloud/publicConfig";

export interface LunaMobileUserPermissions {
  readonly managedTunnels: boolean;
  readonly webhooks: boolean;
  readonly mobilePush: boolean;
}

export interface LunaMobileUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role?: "user" | "admin";
  readonly maxTunnels?: number;
  readonly permissions?: LunaMobileUserPermissions;
}

export interface LunaMobileAuthState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly user: LunaMobileUser | null;
  readonly serverUrl: string | null;
  readonly defaultServerUrl: string | null;
  readonly hasCustomServerUrl: boolean;
}

function initialServerState(): Pick<
  LunaMobileAuthState,
  "serverUrl" | "defaultServerUrl" | "hasCustomServerUrl"
> {
  const serverUrl =
    typeof PublicConfig.resolveLunaAuthUrl === "function"
      ? PublicConfig.resolveLunaAuthUrl()
      : null;
  const defaultServerUrl =
    typeof PublicConfig.resolveDefaultLunaAuthUrl === "function"
      ? PublicConfig.resolveDefaultLunaAuthUrl()
      : serverUrl;
  return {
    serverUrl,
    defaultServerUrl,
    hasCustomServerUrl: serverUrl !== null && serverUrl !== defaultServerUrl,
  };
}

let cachedSnapshot: LunaMobileAuthState = {
  isLoaded: false,
  isSignedIn: false,
  userId: null,
  user: null,
  ...initialServerState(),
};

let activeTokenProvider: (() => Promise<string | null>) | null = null;
const listeners = new Set<() => void>();

export function readLunaMobileAuthMode(): "lunacode" | "clerk" | null {
  return typeof PublicConfig.resolveCloudAuthMode === "function"
    ? PublicConfig.resolveCloudAuthMode()
    : null;
}

export function readLunaMobileAuthUrl(): string | null {
  return typeof PublicConfig.resolveLunaAuthUrl === "function"
    ? PublicConfig.resolveLunaAuthUrl()
    : null;
}

export function readLunaMobileDefaultAuthUrl(): string | null {
  return typeof PublicConfig.resolveDefaultLunaAuthUrl === "function"
    ? PublicConfig.resolveDefaultLunaAuthUrl()
    : readLunaMobileAuthUrl();
}

export function setLunaMobileAuthViewState(
  next: Omit<LunaMobileAuthState, "serverUrl" | "defaultServerUrl" | "hasCustomServerUrl"> &
    Partial<Pick<LunaMobileAuthState, "serverUrl" | "defaultServerUrl" | "hasCustomServerUrl">>,
): void {
  const fallback = initialServerState();
  cachedSnapshot = {
    ...next,
    serverUrl: next.serverUrl ?? fallback.serverUrl,
    defaultServerUrl: next.defaultServerUrl ?? fallback.defaultServerUrl,
    hasCustomServerUrl: next.hasCustomServerUrl ?? fallback.hasCustomServerUrl,
  };
  for (const listener of listeners) {
    listener();
  }
}

export function registerLunaMobileTokenProvider(
  provider: (() => Promise<string | null>) | null,
): void {
  activeTokenProvider = provider;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LunaMobileAuthState {
  return cachedSnapshot;
}

export function useLunaMobileAuthState(): LunaMobileAuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useLunaMobileCloudAuth(_options?: { readonly treatPendingAsSignedOut?: boolean }) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    isLoaded: state.isLoaded,
    isSignedIn: state.isSignedIn,
    userId: state.userId,
    getToken: async (_opts?: unknown) => (activeTokenProvider ? activeTokenProvider() : null),
  };
}

function useClerkMobileCloudAuth(options?: { readonly treatPendingAsSignedOut?: boolean }) {
  return useAuth(options);
}

export const useMobileCloudAuth =
  readLunaMobileAuthMode() === "lunacode" ? useLunaMobileCloudAuth : useClerkMobileCloudAuth;

function useLunaMobileCloudUser() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    user: state.user
      ? {
          fullName: state.user.displayName,
          primaryEmailAddress: { emailAddress: state.user.email },
        }
      : null,
  };
}

function useClerkMobileCloudUser() {
  return useUser();
}

export const useMobileCloudUser =
  readLunaMobileAuthMode() === "lunacode" ? useLunaMobileCloudUser : useClerkMobileCloudUser;
