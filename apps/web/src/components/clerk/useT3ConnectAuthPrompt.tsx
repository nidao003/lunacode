import { useClerk } from "@clerk/react";

import { resolveCloudAuthMode } from "../../cloud/publicConfig";
import { isElectron } from "../../env";
import { openLunaAuthDialog, useLunaAuthState } from "../../lunacode/cloudAuth";
import { resolveClerkSignInProps } from "./authRedirect";
import { retryClerkLoad } from "./clerkLoadFailure";

function useLunaT3ConnectAuthPrompt() {
  useLunaAuthState();
  return { openAuthPrompt: openLunaAuthDialog };
}

function useClerkT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    if (clerk.status === "error") {
      retryClerkLoad();
      return;
    }
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  return { openAuthPrompt };
}

export const useT3ConnectAuthPrompt =
  resolveCloudAuthMode() === "lunacode" ? useLunaT3ConnectAuthPrompt : useClerkT3ConnectAuthPrompt;
