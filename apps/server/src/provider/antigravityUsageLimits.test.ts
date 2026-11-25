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
import { describe, expect } from "vite-plus/test";

import {
  ANTIGRAVITY_CLI_USAGE_COOLDOWN_MS,
  buildAntigravityCliUsageEnv,
  makeAntigravityUsageProbe,
  parseAntigravityCliUsageOutput,
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
});

describe("buildAntigravityCliUsageEnv", () => {
  it.effect(
    "strips spoofed/key env vars without forging SSH_CONNECTION or file-storage flags",
    () =>
      Effect.sync(() => {
        const env = buildAntigravityCliUsageEnv({
          baseEnv: {
            PATH: "/usr/bin",
            HOME: "/home/dev",
            AGY_ACP_FORCE_FILE_STORAGE: "1",
            GEMINI_API_KEY: "secret-gemini",
            GOOGLE_API_KEY: "secret-google",
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: "--max-old-space-size=4096",
          },
          geminiHome: "/profiles/agy-1",
          tempDirectory: "/tmp/t3-agy-1",
        });
        expect(env).toEqual({
          PATH: "/usr/bin",
          HOME: "/home/dev",
          GEMINI_HOME: "/profiles/agy-1",
          AGY_CLI_DISABLE_AUTO_UPDATE: "1",
          TMPDIR: "/tmp/t3-agy-1",
          TEMP: "/tmp/t3-agy-1",
          TMP: "/tmp/t3-agy-1",
        });
        expect(env.SSH_CONNECTION).toBeUndefined();
        expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
      }),
  );
});

it.layer(NodeServices.layer)("makeAntigravityUsageProbe", (it) => {
  it.effect(
    "spawns official agy CLI, caches 5 minutes, refreshes after cooldown, and clears cleanly",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_761_041_764_000);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "agy-probe-test-" });
        const calls: Array<{
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly env: Record<string, string | undefined>;
        }> = [];
        const currentExit = yield* Ref.make({ exitCode: 0, stdout: sampleCliJson, stderr: "" });

        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected StandardCommand");
            }
            calls.push({
              command: command.command,
              args: command.args.map(String),
              env: {
                GEMINI_HOME: command.options.env?.GEMINI_HOME as string | undefined,
                SSH_CONNECTION: command.options.env?.SSH_CONNECTION as string | undefined,
                AGY_ACP_FORCE_FILE_STORAGE: command.options.env?.AGY_ACP_FORCE_FILE_STORAGE as
                  | string
                  | undefined,
              },
            });
            const next = yield* Ref.get(currentExit);
            return makeMockCliHandle(next);
          }),
        );

        const probeHandle = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          resolveExecutable: Effect.succeed("/usr/local/bin/agy"),
          baseEnv: { PATH: "/usr/bin", AGY_ACP_FORCE_FILE_STORAGE: "1" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        const first = yield* probeHandle.probe;
        expect(first.unavailable).toBeUndefined();
        expect(first.windows).toHaveLength(4);
        expect(calls).toEqual([
          {
            command: "/usr/local/bin/agy",
            args: ["--print", "/usage", "--output-format", "json"],
            env: {
              GEMINI_HOME: path.resolve(profileDirectory),
              SSH_CONNECTION: undefined,
              AGY_ACP_FORCE_FILE_STORAGE: undefined,
            },
          },
        ]);

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

        // clear() resets cooldown immediately; failures do not cache.
        yield* probeHandle.clear;
        yield* Ref.set(currentExit, { exitCode: 1, stdout: "", stderr: "Sign in required" });
        const failed = yield* probeHandle.probe;
        expect(failed.unavailable).toEqual({
          reason: "probeFailed",
          message: "Sign in required",
        });
        expect(calls).toHaveLength(3);

        // Immediate retry after a failed probe runs right away (failures are never cooled down).
        yield* Ref.set(currentExit, { exitCode: 0, stdout: sampleCliJson, stderr: "" });
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
});
