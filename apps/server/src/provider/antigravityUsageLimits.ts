import {
  type AntigravityAuthMethod,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// @effect-diagnostics-next-line nodeBuiltinImport:off - open/read bounded log bytes and create Windows directory junctions without elevation.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - join platform log paths when reading bounded log files outside Effect layers.
import * as NodePath from "node:path";
import { antigravityManagedPath, antigravityProfileRoot } from "./acp/AntigravityProfilePaths.ts";

export const ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS = 5 * 60_000;
const ANTIGRAVITY_CLI_USAGE_TIMEOUT_MS = 30_000;

const ANTIGRAVITY_CLI_USAGE_MAX_STDOUT_BYTES = 512 * 1024;
const ANTIGRAVITY_CLI_USAGE_MAX_STDERR_BYTES = 16 * 1024;
const CLI_TOKEN_FILE = "antigravity-oauth-token";
export const ANTIGRAVITY_USAGE_COOLDOWN_MESSAGE =
  "Antigravity usage refresh is cooling down. Try again in a few minutes.";
const UNSUPPORTED_MESSAGE = "Antigravity CLI quota tracking requires a Google subscription.";
const NOT_INSTALLED_MESSAGE = "Antigravity CLI is not installed.";
const TIMEOUT_MESSAGE = "Checking Antigravity limits timed out.";
const UNREADABLE_OUTPUT_MESSAGE = "Antigravity CLI returned unreadable usage output.";
const SIGN_IN_REQUIRED_MESSAGE = "Sign in with Google to see Antigravity limits.";
const AUTH_EXPIRED_MESSAGE =
  "Antigravity sign-in has expired. Sign in again in Provider settings to check limits.";

const STRIPPED_USAGE_ENV_KEYS = new Set([
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_ADC_AUTH",
  "AGY_CLI_FORCE_FILE_TOKEN_STORAGE",
  "ANTIGRAVITY_API_KEY",
  "BROWSER",
  "CLOUDSDK_CORE_PROJECT",
  "DISPLAY",
  "ELECTRON_RUN_AS_NODE",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GEMINI_CLI_USE_VERTEX_AI",
  "GEMINI_HOME",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "NODE_OPTIONS",
  "SSH_CONNECTION",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
]);

const CliUsageBucket = Schema.Struct({
  id: Schema.optional(Schema.String),
  bucketId: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  remaining_fraction: Schema.optional(Schema.Number),
  remainingFraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
  resetTime: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const CliUsageGroup = Schema.Struct({
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(CliUsageBucket)),
});

const CliUsageOutput = Schema.Struct({
  status: Schema.optional(Schema.String),
  response: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        message: Schema.optional(Schema.String),
      }),
    ]),
  ),
  command: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(
        Schema.Struct({
          description: Schema.optional(Schema.String),
          groups: Schema.optional(Schema.Array(CliUsageGroup)),
        }),
      ),
    }),
  ),
  groups: Schema.optional(Schema.Array(CliUsageGroup)),
});

type CliUsageOutput = typeof CliUsageOutput.Type;

const CooldownState = Schema.Struct({
  version: Schema.Literal(1),
  lastAttemptAtMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeCooldownState = Schema.decodeUnknownOption(Schema.fromJsonString(CooldownState));
const encodeCooldownState = Schema.encodeEffect(Schema.fromJsonString(CooldownState));
const CLI_USAGE_SETTINGS_JSON = JSON.stringify({ auth: { type: "oauth-personal" } });

class AntigravityCliJunctionError extends Schema.TaggedError<AntigravityCliJunctionError>()(
  "AntigravityCliJunctionError",
  { cause: Schema.Defect() },
) {}

const decodeCliUsageOutput = Schema.decodeUnknownOption(Schema.fromJsonString(CliUsageOutput));

export function buildAntigravityCliUsageEnv(input: {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly geminiHome: string;
  readonly cliHome?: string;
  readonly noBrowserBinDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly tempDirectory?: string;
}): NodeJS.ProcessEnv {
  const isWindows = input.platform === "win32";
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value !== undefined && !STRIPPED_USAGE_ENV_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  if (input.noBrowserBinDir) {
    const delimiter = isWindows ? ";" : ":";
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const currentPath = environment[pathKey];
    environment[pathKey] = currentPath
      ? `${input.noBrowserBinDir}${delimiter}${currentPath}`
      : input.noBrowserBinDir;
  }
  return {
    ...environment,
    GEMINI_HOME: input.geminiHome,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
    ...(input.cliHome
      ? isWindows
        ? { HOME: input.cliHome, USERPROFILE: input.cliHome }
        : { HOME: input.cliHome }
      : {}),
    ...(input.tempDirectory
      ? {
          TMPDIR: input.tempDirectory,
          TEMP: input.tempDirectory,
          TMP: input.tempDirectory,
        }
      : {}),
  };
}

function tryDecodeCliUsageJson(stdoutText: string): CliUsageOutput | undefined {
  const trimmed = stdoutText.trim();
  if (!trimmed) return undefined;
  const direct = decodeCliUsageOutput(trimmed);
  if (Option.isSome(direct)) return direct.value;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = decodeCliUsageOutput(trimmed.slice(firstBrace, lastBrace + 1));
    if (Option.isSome(sliced)) return sliced.value;
  }
  return undefined;
}

function summarizeCliTextError(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 200 ? `${normalized.slice(0, 197)}...` : normalized;
}

function bucketFamilyLabel(id: string, groupLabel: string | undefined): string {
  if (id.startsWith("3p-")) return "Claude & GPT (shared)";
  if (id === "gemini-5h" || id === "gemini-weekly") return "Gemini";
  if (groupLabel && groupLabel !== "Gemini Models" && groupLabel !== "Claude and GPT models") {
    return groupLabel;
  }
  if (id.startsWith("gemini-argon-")) return "Gemini Argon";
  if (id.startsWith("gemini-carbon-")) return "Gemini Carbon";
  if (id.startsWith("gemini-")) return "Gemini";
  return groupLabel || id;
}

function bucketWindowSpec(
  id: string,
  rawWindow: string | undefined,
): {
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly windowDurationMins?: number;
} {
  const normalized = rawWindow?.trim().toLowerCase();
  if (normalized === "5h" || id.endsWith("-5h")) {
    return { kind: "session", label: "5-hour", windowDurationMins: 300 };
  }
  if (normalized === "weekly" || id.endsWith("-weekly")) {
    return { kind: "weekly", label: "Weekly", windowDurationMins: 10080 };
  }
  if (normalized === "monthly" || id.endsWith("-monthly")) {
    return { kind: "monthly", label: "Monthly", windowDurationMins: 43200 };
  }
  return {
    kind: "other",
    label: rawWindow?.trim() || "Limit",
  };
}

/** Parse JSON emitted by `agy --print /usage --output-format json`. */
export function parseAntigravityCliUsageOutput(
  stdoutText: string,
  checkedAt: string,
): ServerProviderUsageLimits {
  const parsed = tryDecodeCliUsageJson(stdoutText);
  if (!parsed) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: UNREADABLE_OUTPUT_MESSAGE,
    });
  }

  if (parsed.status !== undefined && parsed.status.trim().toUpperCase() !== "SUCCESS") {
    const rawError =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error?.message || parsed.response || "";
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: summarizeCliTextError(rawError, "Antigravity CLI failed to report limits."),
    });
  }

  const groups = parsed.command?.data?.groups ?? parsed.groups ?? [];
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const group of groups) {
    const groupLabel = (group.displayName ?? group.name)?.trim() || undefined;
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled === true) {
        continue;
      }
      const id = bucket.id?.trim() || bucket.bucketId?.trim();
      const remainingFraction = bucket.remaining_fraction ?? bucket.remainingFraction;
      if (!id || remainingFraction === undefined || !Number.isFinite(remainingFraction)) {
        continue;
      }
      const family = bucketFamilyLabel(id, groupLabel);
      const spec = bucketWindowSpec(id, bucket.window);
      const rawReset = bucket.reset_time?.trim() || bucket.resetTime?.trim();
      const parsedReset = rawReset ? DateTime.make(rawReset) : Option.none();
      const window: ServerProviderUsageWindow = {
        id,
        label: `${family} · ${spec.label}`,
        kind: spec.kind,
        usedPercent: clampPercent((1 - remainingFraction) * 100),
        ...(spec.windowDurationMins !== undefined
          ? { windowDurationMins: spec.windowDurationMins }
          : {}),
        ...(Option.isSome(parsedReset) ? { resetsAt: DateTime.formatIso(parsedReset.value) } : {}),
      };
      if (!windows.has(id)) {
        windows.set(id, window);
      }
    }
  }

  if (windows.size === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Antigravity CLI returned no quota windows.",
    });
  }

  return makeUsageLimits({ checkedAt, windows: windows.values() });
}

const MAX_LOG_EMAIL_READ_BYTES = 64 * 1024;
const ACP_AUTH_LOG_NAME_PATTERN = /^acp-(?:login|server)-.*\.log$/;
const CLI_LOG_NAME_PATTERN = /^cli-.*\.log$/;
const EMAIL_PATTERN = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const LOG_AUTH_EMAIL_REGEX = new RegExp(
  `(?:\\bapplyAuthResult:\\s*email=|\\bOAuth:\\s*authenticated successfully as\\s+)(${EMAIL_PATTERN.source})`,
  "gi",
);

export function parseAntigravityAuthEmailFromLog(logText: string): string | undefined {
  let match: RegExpExecArray | null;
  let latest: string | undefined;
  LOG_AUTH_EMAIL_REGEX.lastIndex = 0;
  while ((match = LOG_AUTH_EMAIL_REGEX.exec(logText)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      latest = candidate;
    }
  }
  return latest;
}

async function readHeadUtf8IfRegularFile(filePath: string): Promise<string | undefined> {
  const info = await NodeFSP.lstat(filePath).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile()) return undefined;
  const handle = await NodeFSP.open(filePath, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const length = Math.min(info.size, MAX_LOG_EMAIL_READ_BYTES);
    if (length <= 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function findLatestEmailInLogDir(
  logDirPath: string,
  namePattern: RegExp,
  maxFiles = 5,
): Promise<string | undefined> {
  const entries = await NodeFSP.readdir(logDirPath, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{
    readonly path: string;
    readonly name: string;
    readonly mtimeMs: number;
  }> = [];
  for (const entry of entries) {
    if (!namePattern.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      continue;
    }
    const candidatePath = NodePath.join(logDirPath, entry.name);
    const info = await NodeFSP.lstat(candidatePath).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isFile()) {
      continue;
    }
    candidates.push({ path: candidatePath, name: entry.name, mtimeMs: info.mtimeMs });
  }
  candidates.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
  );
  for (const candidate of candidates.slice(0, maxFiles)) {
    const content = await readHeadUtf8IfRegularFile(candidate.path);
    if (!content) continue;
    const email = parseAntigravityAuthEmailFromLog(content);
    if (email) {
      return email;
    }
  }
  return undefined;
}

export interface AntigravityProfileAccountInfo {
  readonly hasToken: boolean;
  readonly email?: string | undefined;
}

/**
 * Inspects an isolated Antigravity profile for an active credential file and reads only the
 * signed-in display email emitted by official `agy` ACP logs inside `<profile>/antigravity-acp/log`.
 */
export async function readAntigravityProfileAccountInfo(input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravityAuthMethod;
}): Promise<AntigravityProfileAccountInfo> {
  if (input.authMethod !== "oauth-personal") {
    return { hasToken: false };
  }
  const profileRoot = await antigravityProfileRoot(input.profileDirectory);
  if (!profileRoot) {
    return { hasToken: false };
  }
  const tokenEntry = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", CLI_TOKEN_FILE],
    "file",
  );
  if (!tokenEntry) {
    return { hasToken: false };
  }
  const logDir = await antigravityManagedPath(profileRoot, ["antigravity-acp", "log"], "directory");
  const email = logDir
    ? await findLatestEmailInLogDir(logDir.path, ACP_AUTH_LOG_NAME_PATTERN)
    : undefined;
  return {
    hasToken: true,
    ...(email ? { email } : {}),
  };
}

export async function readAntigravityProfileAccountEmail(input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravityAuthMethod;
}): Promise<string | undefined> {
  const info = await readAntigravityProfileAccountInfo(input);
  return info.email;
}

async function readEmailFromUsageLogs(input: {
  readonly usageLogPath: string;
  readonly cliLogDirPath: string;
}): Promise<string | undefined> {
  const directText = await readHeadUtf8IfRegularFile(input.usageLogPath);
  const directEmail = directText ? parseAntigravityAuthEmailFromLog(directText) : undefined;
  if (directEmail) {
    return directEmail;
  }
  return findLatestEmailInLogDir(input.cliLogDirPath, CLI_LOG_NAME_PATTERN);
}

export interface AntigravityUsageProbeOptions {
  readonly profileDirectory: string;
  readonly authMethod: AntigravityAuthMethod;
  readonly resolveExecutable: Effect.Effect<string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly tempRoot?: string;
  readonly cooldownMs?: number;
  /** Persisted per-instance attempt timestamp; failures and restarts stay inside the cooldown. */
  readonly cooldownStatePath?: string;
  /** Invoked when official `agy --print /usage` logs identify the signed-in Google account email. */
  readonly onAccountEmail?: (email: string) => Effect.Effect<void>;
}

interface CachedCliProbe {
  readonly checkedAtMs: number;
  readonly limits: ServerProviderUsageLimits;
}

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (
  options: AntigravityUsageProbeOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gate = yield* Semaphore.make(1);
  const lastSuccessRef = yield* Ref.make<CachedCliProbe | undefined>(undefined);
  const lastAttemptRef = yield* Ref.make<number | undefined>(undefined);
  const geminiHome = path.resolve(options.profileDirectory);
  const cliTokenPath = path.join(geminiHome, "antigravity-acp", CLI_TOKEN_FILE);
  const cooldownMs = options.cooldownMs ?? ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS;
  const platform = options.platform ?? (yield* HostProcess.Platform);

  const readPersistedAttempt = Effect.fn("AntigravityUsageProbe.readPersistedAttempt")(
    function* () {
      if (options.cooldownStatePath === undefined) return undefined;
      const text = yield* fs
        .readFileString(options.cooldownStatePath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (text === undefined) return undefined;
      const decoded = decodeCooldownState(text);
      return Option.isSome(decoded) ? decoded.value.lastAttemptAtMs : undefined;
    },
  );

  const recordAttempt = Effect.fn("AntigravityUsageProbe.recordAttempt")(function* (
    attemptAtMs: number,
  ) {
    yield* Ref.set(lastAttemptRef, attemptAtMs);
    if (options.cooldownStatePath === undefined) return;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(options.cooldownStatePath!), { recursive: true });
      const stagingPath = `${options.cooldownStatePath!}.tmp`;
      const encoded = yield* encodeCooldownState({ version: 1, lastAttemptAtMs: attemptAtMs });
      yield* fs.writeFileString(stagingPath, encoded, { mode: 0o600 });
      yield* fs.rename(stagingPath, options.cooldownStatePath!);
    }).pipe(Effect.ignore({ log: true }));
  });

  const probeOnce = Effect.fn("AntigravityUsageProbe.probe")(function* () {
    const now = yield* DateTime.now;
    const nowMs = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(now);
    if (options.authMethod !== "oauth-personal") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: UNSUPPORTED_MESSAGE,
      });
    }

    // A personal instance must own a CLI token file. Otherwise agy falls back to the shared OS
    // keyring and one account can be reported for another provider instance.
    if (!(yield* fs.exists(cliTokenPath).pipe(Effect.orElseSucceed(() => false)))) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: SIGN_IN_REQUIRED_MESSAGE,
      });
    }

    const persistedAttempt = yield* readPersistedAttempt();
    const lastAttempt = Math.max((yield* Ref.get(lastAttemptRef)) ?? 0, persistedAttempt ?? 0);
    if (lastAttempt > 0 && cooldownMs > 0 && nowMs - lastAttempt < cooldownMs) {
      const last = yield* Ref.get(lastSuccessRef);
      return (
        last?.limits ??
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: ANTIGRAVITY_USAGE_COOLDOWN_MESSAGE,
        })
      );
    }

    const executablePath = yield* options.resolveExecutable.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (!executablePath) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: NOT_INSTALLED_MESSAGE,
      });
    }

    // Record the attempt before launch so a timeout, non-zero exit, crash, or restart cannot
    // immediately spawn another CLI process.
    yield* recordAttempt(nowMs);

    const outcome = yield* Effect.gen(function* () {
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        ...(options.tempRoot ? { directory: options.tempRoot } : {}),
        prefix: "t3-agy-usage-",
      });
      const cliHome = path.join(tempDirectory, "home");
      const cliGeminiDir = path.join(cliHome, ".gemini");
      const cliAppDataDir = path.join(cliGeminiDir, "antigravity-cli");
      const noBrowserBinDir =
        platform !== "win32" ? path.join(tempDirectory, "no-browser-bin") : undefined;
      const usageLogPath = path.join(tempDirectory, "usage.log");
      const cliTokenTarget = yield* fs
        .realPath(cliTokenPath)
        .pipe(Effect.orElseSucceed(() => cliTokenPath));

      // `agy --print /usage` reads `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` instead
      // of `GEMINI_HOME`, so stage a disposable HOME that points back to this instance's token.
      const staged = yield* Effect.gen(function* () {
        if (platform === "win32") {
          yield* fs.makeDirectory(cliGeminiDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(cliGeminiDir, "settings.json"),
            CLI_USAGE_SETTINGS_JSON,
          );
          yield* Effect.tryPromise({
            try: () => NodeFSP.symlink(path.dirname(cliTokenTarget), cliAppDataDir, "junction"),
            catch: (cause) => new AntigravityCliJunctionError({ cause }),
          });
        } else {
          yield* fs.makeDirectory(cliAppDataDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(cliGeminiDir, "settings.json"),
            CLI_USAGE_SETTINGS_JSON,
            { mode: 0o600 },
          );
          yield* fs.symlink(cliTokenTarget, path.join(cliAppDataDir, CLI_TOKEN_FILE));
          yield* fs.makeDirectory(noBrowserBinDir!, { recursive: true });
          yield* fs.writeFileString(path.join(noBrowserBinDir!, "open"), "#!/bin/sh\nexit 1\n", {
            mode: 0o755,
          });
          yield* fs.writeFileString(
            path.join(noBrowserBinDir!, "xdg-open"),
            "#!/bin/sh\nexit 1\n",
            { mode: 0o755 },
          );
        }
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

      if (!staged) {
        return { timedOut: false as const, stagingFailed: true as const };
      }

      const env = buildAntigravityCliUsageEnv({
        baseEnv: options.baseEnv ?? process.env,
        geminiHome,
        cliHome,
        ...(noBrowserBinDir ? { noBrowserBinDir } : {}),
        platform,
        tempDirectory,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(
          executablePath,
          ["--log-file", usageLogPath, "--print", "/usage", "--output-format", "json"],
          {
            cwd: tempDirectory,
            env,
            extendEnv: false,
            shell: false,
            stdin: "ignore",
          },
        ),
      );

      let stderrTail = "";
      let authPromptDetected = false;
      const stderrStream = child.stderr.pipe(
        Stream.tap((chunk) => {
          if (authPromptDetected) return Effect.void;
          stderrTail = (stderrTail + Buffer.from(chunk).toString("utf8")).slice(-2048);
          if (
            !stderrTail.includes("Authentication required.") &&
            !stderrTail.includes("https://accounts.google.com/o/oauth2/")
          ) {
            return Effect.void;
          }
          authPromptDetected = true;
          return child.kill().pipe(Effect.ignore);
        }),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: ANTIGRAVITY_CLI_USAGE_MAX_STDOUT_BYTES,
          }),
          collectUint8StreamText({
            stream: stderrStream,
            maxBytes: ANTIGRAVITY_CLI_USAGE_MAX_STDERR_BYTES,
          }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      const accountEmail =
        !authPromptDetected && Number(exitCode) === 0 && !stdout.truncated
          ? yield* Effect.promise(() =>
              readEmailFromUsageLogs({
                usageLogPath,
                cliLogDirPath: path.join(cliAppDataDir, "log"),
              }),
            )
          : undefined;

      return {
        timedOut: false as const,
        authPromptDetected,
        stdout,
        stderr,
        exitCode,
        accountEmail,
      };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: ANTIGRAVITY_CLI_USAGE_TIMEOUT_MS,
        orElse: () => Effect.succeed({ timedOut: true as const }),
      }),
      Effect.catch((cause) =>
        Effect.succeed({
          timedOut: false as const,
          spawnFailed: true as const,
          cause,
        }),
      ),
    );

    if (outcome.timedOut) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: TIMEOUT_MESSAGE,
      });
    }
    if ("stagingFailed" in outcome) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not prepare an isolated environment for the Antigravity CLI.",
      });
    }
    if ("spawnFailed" in outcome) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not start the Antigravity CLI to check limits.",
      });
    }
    if (outcome.authPromptDetected) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: AUTH_EXPIRED_MESSAGE,
      });
    }
    if (outcome.stdout.truncated) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: UNREADABLE_OUTPUT_MESSAGE,
      });
    }
    if (Number(outcome.exitCode) !== 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: summarizeCliTextError(
          outcome.stderr.text || outcome.stdout.text,
          "Antigravity CLI failed to check limits.",
        ),
      });
    }

    if (outcome.accountEmail && options.onAccountEmail) {
      yield* options.onAccountEmail(outcome.accountEmail).pipe(Effect.ignore({ log: true }));
    }

    const parsed = parseAntigravityCliUsageOutput(outcome.stdout.text, checkedAt);
    if (!parsed.unavailable && parsed.windows.length > 0) {
      yield* Ref.set(lastSuccessRef, { checkedAtMs: nowMs, limits: parsed });
    }
    return parsed;
  });

  const withServices = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const clear = Effect.gen(function* () {
    yield* Ref.set(lastSuccessRef, undefined);
    yield* Ref.set(lastAttemptRef, undefined);
    if (options.cooldownStatePath !== undefined) {
      yield* fs
        .remove(options.cooldownStatePath, { force: true })
        .pipe(Effect.ignore({ log: true }));
    }
  });

  return {
    probe: gate.withPermits(1)(withServices(probeOnce())),
    clear: withServices(clear),
  };
});
