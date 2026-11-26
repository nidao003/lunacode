import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import { describe, expect } from "vite-plus/test";

import {
  ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS,
  buildAntigravityCliUsageEnv,
  extractAntigravityTierFromMeta,
  extractAntigravityTierFromStartResult,
  makeAntigravityUsageProbe,
  normalizeAntigravitySubscriptionPlan,
  parseAntigravityAuthEmailFromLog,
  parseAntigravityCliUsageOutput,
  readAntigravityProfileAccountEmail,
  readAntigravityProfileAccountInfo,
} from "./antigravityUsageLimits.ts";

function makeMockCliHandle(input: {
  readonly exitCode?: number;
  readonly stdout?: string | Uint8Array;
  readonly stderr?: string;
  readonly stall?: boolean;
}) {
  const stdoutBytes =
    input.stdout === undefined
      ? undefined
      : typeof input.stdout === "string"
        ? new TextEncoder().encode(input.stdout)
        : input.stdout;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.stall
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => Effect.void),
    stdin: Sink.drain,
    stdout: stdoutBytes === undefined ? Stream.empty : Stream.make(stdoutBytes),
    stderr:
      input.stderr === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const sampleCliJson = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  command: {
    name: "usage",
    data: {
      description: "Quota summary",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0.848104,
              reset_time: "2026-10-21T13:29:53Z",
            },
            {
              id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.9620177,
              reset_time: "2026-10-28T08:29:53Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-5h",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-10-21T15:16:05Z",
            },
            {
              id: "3p-weekly",
              window: "weekly",
              remaining_fraction: 0.25,
              reset_time: "2026-10-28T10:16:05Z",
            },
          ],
        },
      ],
    },
  },
});

describe("parseAntigravityCliUsageOutput", () => {
  it.effect("parses official agy --print /usage JSON buckets and family labels", () =>
    Effect.sync(() => {
      const limits = parseAntigravityCliUsageOutput(sampleCliJson, "2026-10-21T10:16:04.000Z");
      expect(limits.unavailable).toBeUndefined();
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("3p-5h")).toEqual({
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-10-21T15:16:05.000Z",
      });
      expect(byId.get("3p-weekly")).toEqual({
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 75,
        windowDurationMins: 10080,
        resetsAt: "2026-10-28T10:16:05.000Z",
      });
      expect(byId.get("gemini-5h")?.label).toBe("Gemini · 5-hour");
      expect(byId.get("gemini-5h")?.usedPercent).toBeCloseTo(15.1896, 3);
      expect(byId.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
      expect(byId.get("gemini-weekly")?.resetsAt).toBe("2026-10-28T08:29:53.000Z");
    }),
  );

  it.effect("labels Argon/Carbon quotas, clamps fractions, and omits missing resets", () =>
    Effect.sync(() => {
      const limits = parseAntigravityCliUsageOutput(
        `notice: checking quota\n${JSON.stringify({
          groups: [
            {
              displayName: "Gemini 4 Argon",
              buckets: [
                {
                  bucketId: "gemini-argon-wtu-weekly",
                  window: "weekly",
                  remainingFraction: 0.6,
                },
              ],
            },
            {
              displayName: " ",
              buckets: [
                {
                  bucketId: "gemini-carbon-5h",
                  window: "5h",
                  remainingFraction: 1.05,
                },
              ],
            },
          ],
        })}\n`,
        "2026-10-21T10:16:04.000Z",
      );
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-argon-wtu-weekly")).toEqual({
        id: "gemini-argon-wtu-weekly",
        label: "Gemini 4 Argon · Weekly",
        kind: "weekly",
        usedPercent: 40,
        windowDurationMins: 10080,
      });
      expect(byId.get("gemini-carbon-5h")).toEqual({
        id: "gemini-carbon-5h",
        label: "Gemini Carbon · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      });
    }),
  );

  it.effect("reports probeFailed for ERROR status, empty buckets, or invalid JSON", () =>
    Effect.sync(() => {
      const checkedAt = "2026-10-21T10:16:04.000Z";
      expect(
        parseAntigravityCliUsageOutput(
          JSON.stringify({ status: "ERROR", response: "Not logged in" }),
          checkedAt,
        ),
      ).toEqual({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Not logged in" },
      });
      expect(
        parseAntigravityCliUsageOutput(JSON.stringify({ status: "SUCCESS" }), checkedAt),
      ).toEqual({
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "Antigravity CLI returned no quota windows.",
        },
      });
      expect(parseAntigravityCliUsageOutput("not json at all", checkedAt)).toEqual({
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "Antigravity CLI returned unreadable usage output.",
        },
      });
    }),
  );

  it.effect("skips disabled quota buckets from CLI output", () =>
    Effect.sync(() => {
      const limits = parseAntigravityCliUsageOutput(
        JSON.stringify({
          status: "SUCCESS",
          groups: [
            {
              name: "Claude / GPT",
              buckets: [
                {
                  id: "3p-5h",
                  window: "5h",
                  disabled: true,
                  remaining_fraction: 1,
                },
                {
                  id: "3p-weekly",
                  window: "7d",
                  remaining_fraction: 0,
                  reset_time: "2026-10-28T10:16:04Z",
                },
              ],
            },
          ],
        }),
        "2026-10-21T10:16:04.000Z",
      );
      expect(limits.windows).toEqual([
        {
          id: "3p-weekly",
          label: "Claude & GPT (shared) · Weekly",
          kind: "weekly",
          usedPercent: 100,
          windowDurationMins: 10080,
          resetsAt: "2026-10-28T10:16:04.000Z",
        },
      ]);
    }),
  );
});

describe("buildAntigravityCliUsageEnv", () => {
  it.effect(
    "strips spoofed/key/display/home env vars, sets cliHome, and prepends noBrowserBinDir",
    () =>
      Effect.sync(() => {
        const env = buildAntigravityCliUsageEnv({
          baseEnv: {
            PATH: "/usr/bin",
            HOME: "/home/dev",
            USERPROFILE: "C:\\Users\\dev",
            HOMEDRIVE: "C:",
            HOMEPATH: "\\Users\\dev",
            DISPLAY: ":0",
            WAYLAND_DISPLAY: "wayland-0",
            SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22",
            AGY_ACP_FORCE_FILE_STORAGE: "1",
            GEMINI_API_KEY: "secret-gemini",
            GOOGLE_API_KEY: "secret-google",
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: "--max-old-space-size=4096",
          },
          geminiHome: "/profiles/agy-1",
          cliHome: "/tmp/t3-agy-1/home",
          noBrowserBinDir: "/tmp/t3-agy-1/no-browser-bin",
          platform: "darwin",
          tempDirectory: "/tmp/t3-agy-1",
        });
        expect(env).toEqual({
          PATH: "/tmp/t3-agy-1/no-browser-bin:/usr/bin",
          HOME: "/tmp/t3-agy-1/home",
          GEMINI_HOME: "/profiles/agy-1",
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
          AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
          TMPDIR: "/tmp/t3-agy-1",
          TEMP: "/tmp/t3-agy-1",
          TMP: "/tmp/t3-agy-1",
        });
        expect(env.SSH_CONNECTION).toBeUndefined();
        expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
        expect(env.DISPLAY).toBeUndefined();
        expect(env.WAYLAND_DISPLAY).toBeUndefined();
        expect(env.USERPROFILE).toBeUndefined();
        expect(env.HOMEDRIVE).toBeUndefined();
        expect(env.HOMEPATH).toBeUndefined();

        const winEnv = buildAntigravityCliUsageEnv({
          baseEnv: { Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\dev" },
          geminiHome: "C:\\profiles\\agy-1",
          cliHome: "C:\\tmp\\home",
          noBrowserBinDir: "C:\\tmp\\no-browser",
          platform: "win32",
        });
        expect(winEnv.Path).toBe("C:\\tmp\\no-browser;C:\\Windows\\System32");
        expect(winEnv.HOME).toBe("C:\\tmp\\home");
        expect(winEnv.USERPROFILE).toBe("C:\\tmp\\home");
      }),
  );
});

it.layer(NodeServices.layer)("makeAntigravityUsageProbe", (it) => {
  const writeCliToken = Effect.fn("antigravityUsageLimits.test.writeCliToken")(function* (
    profileDirectory: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(profileDirectory, "antigravity-acp");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(path.join(directory, "antigravity-oauth-token"), "{}");
  });

  it.effect(
    "spawns official agy CLI, caches 5 minutes, refreshes after cooldown, and clears cleanly",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_761_041_764_000);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "agy-probe-test-" });
        yield* writeCliToken(profileDirectory);
        const calls: Array<{
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly stagedTokenTarget: string | undefined;
          readonly settingsText: string | undefined;
          readonly env: Record<string, string | undefined>;
        }> = [];
        const currentExit = yield* Ref.make({
          exitCode: 0,
          stdout: sampleCliJson,
          stderr: "",
          usageLogText: "OAuth: authenticated successfully as usage@example.com\n",
        });
        const discoveredEmails = yield* Ref.make<ReadonlyArray<string>>([]);

        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected StandardCommand");
            }
            const args = command.args.map(String);
            const cliHome = command.options.env?.HOME as string | undefined;
            const stagedTokenPath = cliHome
              ? path.join(cliHome, ".gemini", "antigravity-cli", "antigravity-oauth-token")
              : undefined;
            const stagedSettingsPath = cliHome
              ? path.join(cliHome, ".gemini", "settings.json")
              : undefined;
            const stagedTokenTarget = stagedTokenPath
              ? yield* fs.readLink(stagedTokenPath).pipe(Effect.orElseSucceed(() => undefined))
              : undefined;
            const settingsText = stagedSettingsPath
              ? yield* fs
                  .readFileString(stagedSettingsPath)
                  .pipe(Effect.orElseSucceed(() => undefined))
              : undefined;
            const next = yield* Ref.get(currentExit);
            if (args[0] === "--log-file" && args[1] && next.usageLogText) {
              yield* fs.writeFileString(args[1], next.usageLogText);
            }
            calls.push({
              command: command.command,
              args,
              stagedTokenTarget,
              settingsText,
              env: {
                HOME: cliHome,
                PATH: command.options.env?.PATH as string | undefined,
                GEMINI_HOME: command.options.env?.GEMINI_HOME as string | undefined,
                SSH_CONNECTION: command.options.env?.SSH_CONNECTION as string | undefined,
                AGY_ACP_FORCE_FILE_STORAGE: command.options.env?.AGY_ACP_FORCE_FILE_STORAGE as
                  | string
                  | undefined,
                AGY_CLI_FORCE_FILE_TOKEN_STORAGE: command.options.env
                  ?.AGY_CLI_FORCE_FILE_TOKEN_STORAGE as string | undefined,
                AGY_CLI_DISABLE_AUTO_UPDATE: command.options.env?.AGY_CLI_DISABLE_AUTO_UPDATE as
                  | string
                  | undefined,
              },
            });
            return makeMockCliHandle(next);
          }),
        );

        const probeHandle = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          platform: "darwin",
          resolveExecutable: Effect.succeed("/usr/local/bin/agy"),
          baseEnv: { PATH: "/usr/bin", HOME: "/Users/real", AGY_ACP_FORCE_FILE_STORAGE: "1" },
          onAccountEmail: (email) => Ref.update(discoveredEmails, (items) => [...items, email]),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        const first = yield* probeHandle.probe;
        expect(first.unavailable).toBeUndefined();
        expect(first.windows).toHaveLength(4);
        const expectedTokenTarget = yield* fs.realPath(
          path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token"),
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.command).toBe("/usr/local/bin/agy");
        expect(calls[0]?.args[0]).toBe("--log-file");
        expect(calls[0]?.args[1]).toContain("usage.log");
        expect(calls[0]?.args.slice(2)).toEqual(["--print", "/usage", "--output-format", "json"]);
        expect(calls[0]?.stagedTokenTarget).toBe(expectedTokenTarget);
        expect(calls[0]?.settingsText).toBe(JSON.stringify({ auth: { type: "oauth-personal" } }));
        expect(calls[0]?.env.HOME).not.toBe("/Users/real");
        expect(calls[0]?.env.PATH).toMatch(/no-browser-bin:\/usr\/bin$/);
        expect(calls[0]?.env.GEMINI_HOME).toBe(path.resolve(profileDirectory));
        expect(calls[0]?.env.SSH_CONNECTION).toBeUndefined();
        expect(calls[0]?.env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
        expect(calls[0]?.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
        expect(calls[0]?.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
        expect(yield* Ref.get(discoveredEmails)).toEqual(["usage@example.com"]);

        // Within 5-minute cooldown, reuse cached result without spawning again.
        yield* TestClock.adjust("2 minutes");
        const second = yield* probeHandle.probe;
        expect(second).toEqual(first);
        expect(calls).toHaveLength(1);

        // Once cooldown elapses, probe invokes the CLI again.
        yield* TestClock.adjust(`${ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS} millis`);
        const third = yield* probeHandle.probe;
        expect(third.unavailable).toBeUndefined();
        expect(calls).toHaveLength(2);

        // clear() resets the persisted attempt; a failed launch starts a new cooldown.
        yield* probeHandle.clear;
        yield* Ref.set(currentExit, {
          exitCode: 1,
          stdout: "",
          stderr: "Sign in required",
          usageLogText: "",
        });
        const failed = yield* probeHandle.probe;
        expect(failed.unavailable).toEqual({
          reason: "probeFailed",
          message: "Sign in required",
        });
        expect(calls).toHaveLength(3);

        // Immediate retry stays inside the failure cooldown and does not spawn agy again.
        const coolingDown = yield* probeHandle.probe;
        expect(coolingDown.unavailable?.message).toBe(
          "Antigravity usage refresh is cooling down. Try again in a few minutes.",
        );
        expect(calls).toHaveLength(3);

        yield* TestClock.adjust(`${ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS} millis`);
        yield* Ref.set(currentExit, {
          exitCode: 0,
          stdout: sampleCliJson,
          stderr: "",
          usageLogText: "",
        });
        const recovered = yield* probeHandle.probe;
        expect(recovered.unavailable).toBeUndefined();
        expect(calls).toHaveLength(4);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "returns unsupported for API-key auth and probeFailed when CLI is missing, oversized, or times out",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "agy-probe-err-" });
        yield* writeCliToken(profileDirectory);
        const calls: Array<string> = [];

        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected StandardCommand");
            }
            calls.push(command.command);
            if (command.command === "/bin/oversized-agy") {
              return makeMockCliHandle({
                exitCode: 0,
                stdout: new Uint8Array(600 * 1024).fill(0x78),
              });
            }
            return makeMockCliHandle({ stall: true });
          }),
        );

        const nonPersonal = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "gemini-api-key",
          resolveExecutable: Effect.succeed("/bin/agy"),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        expect((yield* nonPersonal.probe).unavailable?.reason).toBe("unsupported");
        expect(calls).toEqual([]);

        const missingExe = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          resolveExecutable: Effect.undefined,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        expect((yield* missingExe.probe).unavailable).toEqual({
          reason: "probeFailed",
          message: "Antigravity CLI is not installed.",
        });

        const oversized = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          resolveExecutable: Effect.succeed("/bin/oversized-agy"),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        expect((yield* oversized.probe).unavailable).toEqual({
          reason: "probeFailed",
          message: "Antigravity CLI returned unreadable usage output.",
        });

        const timedOut = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          resolveExecutable: Effect.succeed("/bin/slow-agy"),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const fiber = yield* timedOut.probe.pipe(Effect.forkChild);
        yield* TestClock.adjust("31 seconds");
        const timeoutResult = yield* Fiber.join(fiber);
        expect(timeoutResult.unavailable).toEqual({
          reason: "probeFailed",
          message: "Checking Antigravity limits timed out.",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("refuses to launch agy without the instance's own CLI token", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "agy-probe-no-token-" });
      const calls: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected StandardCommand");
          calls.push(command.command);
          return makeMockCliHandle({ stdout: sampleCliJson });
        }),
      );
      const probe = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        resolveExecutable: Effect.succeed("/bin/agy"),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      expect((yield* probe.probe).unavailable).toEqual({
        reason: "unsupported",
        message: "Sign in with Google to see Antigravity limits.",
      });
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a failed cooldown across probe instances through the state file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "agy-probe-cooldown-" });
      yield* writeCliToken(profileDirectory);
      const cooldownStatePath = path.join(profileDirectory, "cooldown.json");
      const calls: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected StandardCommand");
          calls.push(command.command);
          return makeMockCliHandle({ exitCode: 1, stderr: "temporary failure" });
        }),
      );
      const first = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        resolveExecutable: Effect.succeed("/bin/agy"),
        cooldownStatePath,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      expect((yield* first.probe).unavailable?.message).toBe("temporary failure");
      expect(calls).toEqual(["/bin/agy"]);

      const second = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        resolveExecutable: Effect.succeed("/bin/agy"),
        cooldownStatePath,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      expect((yield* second.probe).unavailable?.message).toBe(
        "Antigravity usage refresh is cooling down. Try again in a few minutes.",
      );
      expect(calls).toEqual(["/bin/agy"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "kills CLI immediately and reports expired auth when stderr prints an OAuth login prompt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "agy-probe-oauth-" });
        yield* writeCliToken(profileDirectory);
        const killed = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make(() =>
          Effect.sync(() =>
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Deferred.await(killed).pipe(Effect.as(ChildProcessSpawner.ExitCode(143))),
              isRunning: Effect.succeed(true),
              kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
              unref: Effect.sync(() => Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.make(
                new TextEncoder().encode(
                  "Authentication required. Opening https://accounts.google.com/o/oauth2/auth?client_id=123",
                ),
              ),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );
        const probe = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          platform: "darwin",
          resolveExecutable: Effect.succeed("/bin/agy"),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const result = yield* probe.probe;
        expect(result.unavailable).toEqual({
          reason: "probeFailed",
          message:
            "Antigravity sign-in has expired. Sign in again in Provider settings to check limits.",
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reads signed-in email from isolated ACP logs only when token exists and skips symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        expect(
          parseAntigravityAuthEmailFromLog(
            [
              "INFO other@example.com mentioned in text",
              "INFO applyAuthResult: email=first@example.com, ok=true",
              "INFO OAuth: authenticated successfully as latest@example.com",
            ].join("\n"),
          ),
        ).toBe("latest@example.com");

        const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "agy-email-log-" });
        const logDir = path.join(profileDirectory, "antigravity-acp", "log");
        yield* fs.makeDirectory(logDir, { recursive: true });
        const logFile = path.join(logDir, "acp-login-2026.log");
        yield* fs.writeFileString(
          logFile,
          "INFO applyAuthResult: email=alice@example.com, tier=1\n",
        );

        // Without antigravity-oauth-token on disk, do not surface stale log emails.
        expect(
          yield* Effect.promise(() =>
            readAntigravityProfileAccountInfo({
              profileDirectory,
              authMethod: "oauth-personal",
            }),
          ),
        ).toEqual({ hasToken: false });

        yield* writeCliToken(profileDirectory);
        expect(
          yield* Effect.promise(() =>
            readAntigravityProfileAccountEmail({
              profileDirectory,
              authMethod: "oauth-personal",
            }),
          ),
        ).toBe("alice@example.com");

        // Symlinked newer logs must be ignored in favor of regular files inside the profile.
        const outside = path.join(profileDirectory, "outside.log");
        yield* fs.writeFileString(
          outside,
          "OAuth: authenticated successfully as attacker@example.com\n",
        );
        const symlinkLog = path.join(logDir, "acp-server-9999.log");
        yield* fs.symlink(outside, symlinkLog);
        expect(
          yield* Effect.promise(() =>
            readAntigravityProfileAccountEmail({
              profileDirectory,
              authMethod: "oauth-personal",
            }),
          ),
        ).toBe("alice@example.com");
      }).pipe(Effect.scoped),
  );
});

describe("Antigravity subscription tier extraction", () => {
  it("normalizes official agy UserTier IDs and display names into LunaCode plan labels", () => {
    expect(normalizeAntigravitySubscriptionPlan({ id: "g1-pro-tier", name: "Google AI Pro" })).toBe(
      "AI Pro",
    );
    expect(
      normalizeAntigravitySubscriptionPlan({ id: "G1_ULTRA_TIER", name: "Google AI Ultra" }),
    ).toBe("AI Ultra");
    expect(
      normalizeAntigravitySubscriptionPlan({ id: "g1-ultra-tier", name: "Google AI Ultra 20x" }),
    ).toBe("AI Ultra 20x");
    expect(
      normalizeAntigravitySubscriptionPlan({ id: "G1_PLUS_TIER", name: "Google AI Plus" }),
    ).toBe("AI Plus");
    expect(normalizeAntigravitySubscriptionPlan({ id: "free-tier", name: "Free" })).toBe("Free");
    expect(normalizeAntigravitySubscriptionPlan({ id: "FREE_TIER" })).toBe("Free");
    expect(normalizeAntigravitySubscriptionPlan({ id: "standard-tier" })).toBe("Standard");
    expect(normalizeAntigravitySubscriptionPlan({ id: "enterprise-agent-tier" })).toBe(
      "Enterprise",
    );
    expect(normalizeAntigravitySubscriptionPlan({ name: "Google account" })).toBeUndefined();
  });

  it("extracts subscription tier from ACP sessionSetupResult and authenticateResult metadata", () => {
    expect(
      extractAntigravityTierFromMeta({
        antigravity: {
          tier: { id: "g1-pro-tier", name: "Google AI Pro", upgradeUri: "https://example.test" },
        },
      }),
    ).toBe("AI Pro");
    expect(
      extractAntigravityTierFromStartResult({
        authenticateResult: {
          _meta: { antigravity: { tier: { id: "g1-ultra-tier", name: "Google AI Ultra" } } },
        },
        sessionSetupResult: {},
      }),
    ).toBe("AI Ultra");
    expect(
      extractAntigravityTierFromStartResult({
        authenticateResult: {
          _meta: { antigravity: { tier: { id: "free-tier", name: "Free" } } },
        },
        sessionSetupResult: {
          _meta: { antigravity: { tier: { id: "g1-pro-tier", name: "Google AI Pro" } } },
        },
      }),
    ).toBe("AI Pro");
    expect(extractAntigravityTierFromMeta({ antigravity: {} })).toBeUndefined();
  });
});
