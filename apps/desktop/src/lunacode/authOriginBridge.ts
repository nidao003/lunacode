import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopClerk from "../app/DesktopClerk.ts";
import { makeIpcMethod } from "../ipc/DesktopIpc.ts";

const LUNA_SET_AUTH_URL_CHANNEL = "luna:set-auth-url";

let runtimeLunaAuthHostname: string | undefined = DesktopClerk.desktopLunaAuthHostname;

function parseAllowedAuthHostname(raw: string | null): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return DesktopClerk.desktopLunaAuthHostname;
  const parsed = URL.parse(trimmed);
  if (!parsed) return DesktopClerk.desktopLunaAuthHostname;
  const isLoopback =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]");
  if (parsed.protocol === "https:" || isLoopback) {
    return parsed.hostname || undefined;
  }
  return DesktopClerk.desktopLunaAuthHostname;
}

export function getEffectiveDesktopLunaAuthHostname(): string | undefined {
  return runtimeLunaAuthHostname;
}

export const setLunaAuthUrlIpc = makeIpcMethod({
  channel: LUNA_SET_AUTH_URL_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.lunacode.setAuthUrl")(function* (url: string | null) {
    yield* Effect.sync(() => {
      runtimeLunaAuthHostname = parseAllowedAuthHostname(url);
    });
  }),
});
