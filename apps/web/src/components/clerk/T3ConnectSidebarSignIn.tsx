import { UserButton } from "@clerk/react";
import { LUNACODE_CONNECT_NAME } from "@t3tools/client-runtime/lunacode/brand-display";
import { T, useLocale, useMessages } from "gt-react";
import { LogInIcon, RotateCwIcon, UserIcon } from "lucide-react";

import { DEFAULT_LOCALE } from "../../i18n/locales";
import { hasCloudPublicConfig, resolveCloudAuthMode } from "../../cloud/publicConfig";
import { openLunaAccountDialog, useCloudAuth, useLunaAuthState } from "../../lunacode/cloudAuth";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { retryClerkLoad, useClerkLoadFailed } from "./clerkLoadFailure";
import { T3_CONNECT_ACCOUNT_PAGES } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return resolveCloudAuthMode() === "lunacode" ? (
    <LunaT3ConnectSidebarAvatar />
  ) : (
    <ConfiguredT3ConnectSidebarAvatar />
  );
}

function LunaT3ConnectSidebarAvatar() {
  const state = useLunaAuthState();
  if (!state.isLoaded || !state.isSignedIn || !state.user) return null;

  const initial = state.user.displayName.trim()[0]?.toUpperCase();
  return (
    <Button
      size="icon-sm-pill"
      variant="ghost"
      aria-label={state.user.email}
      title={state.user.email}
      onClick={() => openLunaAccountDialog("t3-connect")}
    >
      {initial ? (
        <span className="text-xs font-medium text-foreground">{initial}</span>
      ) : (
        <UserIcon className="size-4" />
      )}
    </Button>
  );
}

function ConfiguredT3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useCloudAuth();
  const m = useMessages();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          // Clerk's unlayered trigger reset (padding, radius, background) beats layered utilities.
          userButtonTrigger: "mb-1! rounded-lg! p-1! hover:bg-sidebar-row-hover!",
        },
      }}
    >
      {T3_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={m(page.label)}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useCloudAuth();
  const loadFailed = useClerkLoadFailed();
  const locale = useLocale();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  if (loadFailed) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={retryClerkLoad}>
            <RotateCwIcon />
            <span>
              {locale === DEFAULT_LOCALE ? (
                // oxlint-disable-next-line t3code/no-untranslated-copy -- LunaCode English brand override matching <T> sibling
                `Retry ${LUNACODE_CONNECT_NAME}`
              ) : (
                <T>Retry T3 Connect</T>
              )}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  if (!isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={openAuthPrompt}>
          <LogInIcon />
          <span>
            {locale === DEFAULT_LOCALE ? (
              // oxlint-disable-next-line t3code/no-untranslated-copy -- LunaCode English brand override matching <T> sibling
              `Sign in to ${LUNACODE_CONNECT_NAME}`
            ) : (
              <T>Sign in to T3 Connect</T>
            )}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
