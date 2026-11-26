import { ClerkProvider, getClerkInstance } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { useEffect, type ReactNode } from "react";

import { hydrateLunaMobileAuth } from "../../lunacode/cloudAuthActions";
import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { resolveCloudAuthMode, resolveCloudPublicConfig } from "./publicConfig";

const cloudConfig = resolveCloudPublicConfig();
// Build-time constant: null when this build has no cloud config.
const publishableKey = cloudConfig.relay.url ? cloudConfig.clerk.publishableKey : null;
const isLunaSelfHostedMode = resolveCloudAuthMode() === "lunacode";

if (publishableKey) {
  // The same native singleton ClerkProvider renders with, so the service
  // observes it for the app's lifetime without a React subscription.
  cloudAccountService.attach(getClerkInstance({ publishableKey }));
} else if (!isLunaSelfHostedMode) {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

function LunaMobileAuthHydrator({ children }: { readonly children: ReactNode }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hydrates self-hosted mobile auth session once when CloudAuthProvider mounts
  useEffect(() => {
    void hydrateLunaMobileAuth();
  }, []);
  return children;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (isLunaSelfHostedMode) {
    return <LunaMobileAuthHydrator>{props.children}</LunaMobileAuthHydrator>;
  }
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      {props.children}
    </ClerkProvider>
  );
}
