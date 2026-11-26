import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_LUNACODE_AUTH_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;
declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function normalizeConnectOrigin(value: string, allowLoopbackHttp: boolean): string | null {
  const secure = normalizeSecureRelayUrl(value);
  if (secure !== null) {
    return secure;
  }
  if (!allowLoopbackHttp) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      isLoopbackHttpUrl(value) &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    ) {
      return url.origin;
    }
    return null;
  } catch {
    return null;
  }
}

function validateRelayUrl(value: string, allowLoopbackHttp = false) {
  const relayUrl = normalizeConnectOrigin(value, allowLoopbackHttp);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const buildTimeLunaAuthUrl = readBuildTimeValue(
  typeof __T3CODE_BUILD_LUNACODE_AUTH_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_LUNACODE_AUTH_URL__,
);
const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeConnectOrigin(
        __T3CODE_BUILD_RELAY_URL__,
        isLoopbackHttpUrl(buildTimeLunaAuthUrl),
      ) ?? "");
const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);
const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  if (!isRelayTracingEnabled(env)) {
    return null;
  }

  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

const lunaAuthUrlConfig = Config.all({
  auth: Config.option(Config.NonEmptyString("LUNACODE_AUTH_URL")),
  connect: Config.option(Config.NonEmptyString("LUNACODE_CONNECT_URL")),
}).pipe(
  Config.mapEffect(
    ({ auth, connect }): Effect.Effect<Option.Option<string>, Config.ConfigError> => {
      const candidate = Option.getOrElse(
        Option.map(auth.pipe(Option.orElse(() => connect)), (v) => v.trim()),
        () => buildTimeLunaAuthUrl,
      );
      return candidate
        ? Effect.asSome(validateHostedAppUrl(candidate))
        : Effect.succeed(Option.none<string>());
    },
  ),
);

export const isLunaCloudAuthConfiguredConfig = lunaAuthUrlConfig.pipe(Config.map(Option.isSome));

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  return Config.all({
    relay: Config.option(Config.NonEmptyString("T3CODE_RELAY_URL")),
    connect: Config.option(Config.NonEmptyString("LUNACODE_CONNECT_URL")),
    lunaAuth: lunaAuthUrlConfig,
  }).pipe(
    Config.mapEffect(({ relay, connect, lunaAuth }) => {
      const candidate = Option.getOrElse(
        relay.pipe(Option.orElse(() => connect)),
        () => fallback || (Option.isSome(lunaAuth) ? lunaAuth.value : ""),
      ).trim();
      if (!candidate) {
        return Effect.fail(
          new Config.ConfigError(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue({
                message: "Missing T3CODE_RELAY_URL or LUNACODE_CONNECT_URL.",
              }),
            ),
          ),
        );
      }
      const allowLoopbackHttp = Option.isSome(lunaAuth) && isLoopbackHttpUrl(lunaAuth.value);
      return validateRelayUrl(candidate, allowLoopbackHttp);
    }),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

export const hostedAppUrlConfig = Config.all({
  explicit: Config.option(Config.NonEmptyString("T3CODE_HOSTED_APP_URL")),
  lunaAuth: lunaAuthUrlConfig,
}).pipe(
  Config.mapEffect(({ explicit, lunaAuth }) => {
    const raw = Option.isSome(explicit)
      ? explicit.value.trim()
      : Option.isSome(lunaAuth)
        ? lunaAuth.value
        : DEFAULT_HOSTED_APP_URL;
    return validateHostedAppUrl(raw);
  }),
);

const NIGHTLY_HOSTED_APP_URL = DEFAULT_HOSTED_APP_URL;

/**
 * Where agent sign-ins on the T3 Connect address are approved. A nightly build defaults to the
 * nightly hosted app, which ships the same approval page; app.t3.codes serves stable.
 */
export const agentApprovalAppUrlConfig = Config.all({
  explicit: Config.option(Config.NonEmptyString("T3CODE_HOSTED_APP_URL")),
  lunaAuth: lunaAuthUrlConfig,
}).pipe(
  Config.mapEffect(({ explicit, lunaAuth }) => {
    const defaultUrl =
      typeof __T3CODE_BUILD_CHANNEL__ !== "undefined" && __T3CODE_BUILD_CHANNEL__ === "nightly"
        ? NIGHTLY_HOSTED_APP_URL
        : DEFAULT_HOSTED_APP_URL;
    const raw = Option.isSome(explicit)
      ? explicit.value.trim()
      : Option.isSome(lunaAuth)
        ? lunaAuth.value
        : defaultUrl;
    return validateHostedAppUrl(raw);
  }),
);

function validateHostedAppUrl(value: string): Effect.Effect<string, Config.ConfigError> {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
} = {}) {
  return Config.all({
    lunaAuth: lunaAuthUrlConfig,
    explicitClerkKey: Config.option(Config.NonEmptyString("T3CODE_CLERK_PUBLISHABLE_KEY")),
    explicitClientId: Config.option(Config.NonEmptyString("T3CODE_CLERK_CLI_OAUTH_CLIENT_ID")),
  }).pipe(
    Config.mapEffect(({ lunaAuth, explicitClerkKey, explicitClientId }) => {
      if (Option.isSome(lunaAuth) && Option.isNone(explicitClerkKey)) {
        const issuer = lunaAuth.value.replace(/\/+$/u, "");
        return Effect.succeed({
          tokenEndpoint: `${issuer}/oauth/token`,
          deviceAuthorizationEndpoint: `${issuer}/oauth/device/code`,
          clientId: "lunacode-cli",
          loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
          redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
          scopes: CLOUD_CLI_OAUTH_SCOPES,
        } satisfies CloudCliOAuthConfig);
      }
      const clerkPublishableKey = Option.getOrElse(
        explicitClerkKey,
        () => clerkPublishableKeyFallback,
      ).trim();
      const clientId = Option.getOrElse(
        explicitClientId,
        () => clerkCliOAuthClientIdFallback,
      ).trim();
      if (!clerkPublishableKey || !clientId) {
        return Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Missing Clerk publishable key or CLI OAuth client ID.",
              cause: undefined,
            }),
          ),
        );
      }
      return Effect.try({
        try: () => clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey),
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Failed to derive Clerk Frontend API URL from the publishable key.",
              cause,
            }),
          ),
      }).pipe(
        Effect.map(
          (clerkFrontendApiUrl) =>
            ({
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              deviceAuthorizationEndpoint: `${clerkFrontendApiUrl}/oauth/device_authorization`,
              clientId,
              loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
              redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
              scopes: CLOUD_CLI_OAUTH_SCOPES,
            }) satisfies CloudCliOAuthConfig,
        ),
      );
    }),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

const runtimeLunaAuth =
  process.env.LUNACODE_AUTH_URL?.trim() ||
  process.env.LUNACODE_CONNECT_URL?.trim() ||
  buildTimeLunaAuthUrl;
const runtimeRelayUrl =
  normalizeConnectOrigin(
    process.env.T3CODE_RELAY_URL?.trim() || process.env.LUNACODE_CONNECT_URL?.trim() || "",
    isLoopbackHttpUrl(runtimeLunaAuth),
  ) ??
  (buildTimeRelayUrl || normalizeConnectOrigin(runtimeLunaAuth, true) || "");

export const hasCloudPublicConfig = Boolean(
  runtimeRelayUrl &&
  (runtimeLunaAuth ||
    ((process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey) &&
      (process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeClerkCliOAuthClientId))),
);
