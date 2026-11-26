import { useClerk } from "@clerk/react";

import { resolveCloudAuthMode } from "../../cloud/publicConfig";
import { getLunaAccessToken, useLunaAuthState } from "../../lunacode/cloudAuth";

function useLunaClerkLoadFailed() {
  useLunaAuthState();
  return false;
}

function useRealClerkLoadFailed() {
  return useClerk().status === "error";
}

export const useClerkLoadFailed =
  resolveCloudAuthMode() === "lunacode" ? useLunaClerkLoadFailed : useRealClerkLoadFailed;

export function retryClerkLoad() {
  if (resolveCloudAuthMode() === "lunacode") {
    void getLunaAccessToken();
    return;
  }
  // Clerk caches its failed script load for the life of the page and never
  // retries, so a reload is the only recovery.
  window.location.reload();
}
