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
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS = 5 * 60_000;
const ANTIGRAVITY_CLI_USAGE_TIMEOUT_MS = 30_000;

const ANTIGRAVITY_CLI_USAGE_MAX_STDOUT_BYTES = 512 * 1024;
const ANTIGRAVITY_CLI_USAGE_MAX_STDERR_BYTES = 16 * 1024;
const UNSUPPORTED_MESSAGE = "Antigravity CLI quota tracking requires a Google subscription.";
const NOT_INSTALLED_MESSAGE = "Antigravity CLI is not installed.";
const TIMEOUT_MESSAGE = "Checking Antigravity limits timed out.";
const UNREADABLE_OUTPUT_MESSAGE = "Antigravity CLI returned unreadable usage output.";

const STRIPPED_USAGE_ENV_KEYS = new Set([
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_API_KEY",
  "ELECTRON_RUN_AS_NODE",
  "GEMINI_API_KEY",
  "GEMINI_CLI_USE_VERTEX_AI",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "NODE_OPTIONS",
]);

const CliUsageBucket = Schema.Struct({
  id: Schema.optional(Schema.String),
  bucketId: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
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

const decodeCliUsageOutput = Schema.decodeUnknownOption(Schema.fromJsonString(CliUsageOutput));

export function buildAntigravityCliUsageEnv(input: {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly geminiHome: string;
  readonly tempDirectory?: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value !== undefined && !STRIPPED_USAGE_ENV_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    GEMINI_HOME: input.geminiHome,
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
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

export interface AntigravityUsageProbeOptions {
  readonly profileDirectory: string;
  readonly authMethod: AntigravityAuthMethod;
  readonly resolveExecutable: Effect.Effect<string | undefined>;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly tempRoot?: string;
  readonly cooldownMs?: number;
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
  const geminiHome = path.resolve(options.profileDirectory);
  const cooldownMs = options.cooldownMs ?? ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS;

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

    const last = yield* Ref.get(lastSuccessRef);
    if (last !== undefined && cooldownMs > 0 && nowMs - last.checkedAtMs < cooldownMs) {
      return last.limits;
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

    const outcome = yield* Effect.gen(function* () {
      const tempDirectory = yield* fs
        .makeTempDirectoryScoped({
          ...(options.tempRoot ? { directory: options.tempRoot } : {}),
          prefix: "t3-agy-usage-",
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      const env = buildAntigravityCliUsageEnv({
        baseEnv: options.baseEnv ?? process.env,
        geminiHome,
        ...(tempDirectory ? { tempDirectory } : {}),
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(executablePath, ["--print", "/usage", "--output-format", "json"], {
          ...(tempDirectory ? { cwd: tempDirectory } : {}),
          env,
          extendEnv: false,
          shell: false,
          stdin: "ignore",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: ANTIGRAVITY_CLI_USAGE_MAX_STDOUT_BYTES,
          }),
          collectUint8StreamText({
            stream: child.stderr,
            maxBytes: ANTIGRAVITY_CLI_USAGE_MAX_STDERR_BYTES,
          }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { timedOut: false as const, stdout, stderr, exitCode };
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
    if ("spawnFailed" in outcome) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not start the Antigravity CLI to check limits.",
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

  return {
    probe: gate.withPermits(1)(withServices(probeOnce())),
    clear: Ref.set(lastSuccessRef, undefined),
  };
});
