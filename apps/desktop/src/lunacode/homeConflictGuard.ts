import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopHomeOwner from "../backend/DesktopHomeOwner.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { OFFICIAL_T3_MAC_APP_NAMES, type OfficialT3MacAppName } from "./branding.ts";

const INSPECT_COMMAND_TIMEOUT = Duration.millis(1_500);
const GENTLE_QUIT_TIMEOUT = Duration.millis(3_000);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function detectOfficialDesktopAppName(
  commandLine: string | null | undefined,
): OfficialT3MacAppName | null {
  if (!commandLine) return null;
  if (commandLine.includes("LunaCode.app")) return null;

  for (const appName of OFFICIAL_T3_MAC_APP_NAMES) {
    const pattern = new RegExp(`(?:^|[\\\\/])${escapeRegExp(appName)}\\.app(?=[\\\\/\\s]|$)`);
    if (pattern.test(commandLine)) {
      return appName;
    }
  }
  return null;
}

export interface HomeConflictGuardDeps {
  readonly platform: NodeJS.Platform;
  readonly stateDir: string;
  readonly isLocked: Effect.Effect<boolean>;
  readonly awaitRelease: Effect.Effect<boolean>;
  readonly readOwner: Effect.Effect<Option.Option<DesktopHomeOwner.HomeOwner>>;
  readonly inspectProcessCommand: (pid: number) => Effect.Effect<string | null>;
  readonly requestGentleQuitOfficialApp: (appName: OfficialT3MacAppName) => Effect.Effect<boolean>;
  readonly showMessageBox: (
    options: Electron.MessageBoxOptions,
  ) => Effect.Effect<Electron.MessageBoxReturnValue>;
}

const probeProcessCommand = Effect.fn("lunacode.homeConflictGuard.probeProcessCommand")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  pid: number,
) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const command = ChildProcess.make("ps", ["-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          Stream.runDrain(handle.stderr).pipe(Effect.andThen(handle.exitCode)),
        ],
        { concurrency: "unbounded" },
      );
      if ((exitCode as unknown as number) !== 0) return null;
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    }),
  ).pipe(
    Effect.timeoutOption(INSPECT_COMMAND_TIMEOUT),
    Effect.map(Option.getOrElse((): string | null => null)),
    Effect.orElseSucceed((): string | null => null),
  );
});

const sendGentleQuitAppleScript = Effect.fn("lunacode.homeConflictGuard.sendGentleQuitAppleScript")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    appName: OfficialT3MacAppName,
  ) {
    const command = ChildProcess.make(
      "osascript",
      ["-e", `tell application "${appName}" to quit`],
      { stdout: "pipe", stderr: "pipe" },
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command);
        const [, , exitCode] = yield* Effect.all(
          [Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return (exitCode as unknown as number) === 0;
      }),
    ).pipe(
      Effect.timeoutOption(GENTLE_QUIT_TIMEOUT),
      Effect.map(Option.getOrElse(() => false)),
      Effect.orElseSucceed(() => false),
    );
  },
);

export const resolveHomeOwnershipConflict = Effect.fn("lunacode.homeConflictGuard.resolve")(
  function* (deps: HomeConflictGuardDeps): Effect.fn.Return<"proceed" | "quit"> {
    if (!(yield* deps.isLocked)) {
      return "proceed";
    }

    const probeCurrentConflict = Effect.gen(function* () {
      const owner = yield* deps.readOwner;
      let officialAppName: OfficialT3MacAppName | null = null;
      if (deps.platform === "darwin" && Option.isSome(owner)) {
        const commandLine = yield* deps.inspectProcessCommand(owner.value.pid);
        officialAppName = detectOfficialDesktopAppName(commandLine);
      }
      return { owner, officialAppName };
    });

    let { owner, officialAppName } = yield* probeCurrentConflict;

    if (officialAppName === null) {
      if (yield* deps.awaitRelease) {
        return "proceed";
      }
      if (!(yield* deps.isLocked)) {
        return "proceed";
      }
      ({ owner, officialAppName } = yield* probeCurrentConflict);
    }

    let gentleQuitTimedOut = false;

    while (true) {
      if (officialAppName !== null) {
        const detailLines = [
          `LunaCode 与官方 ${officialAppName} 共用数据目录 ${deps.stateDir}，两者不能同时运行。`,
          Option.isSome(owner)
            ? `当前占用进程：PID ${owner.value.pid}（端口 ${owner.value.port}）`
            : undefined,
          gentleQuitTimedOut
            ? "官方应用尚未完全退出（可能存在未关闭的弹窗或确认框），请切换检查或手动关闭后重试。"
            : "建议点击「温和退出官方版并继续」，等待官方版保存退出后自动启动 LunaCode。",
        ].filter((line): line is string => line !== undefined);

        const result = yield* deps.showMessageBox({
          type: "warning",
          title: "LunaCode 启动冲突",
          message: `检测到官方 ${officialAppName} 正在运行`,
          detail: detailLines.join("\n\n"),
          buttons: ["温和退出官方版并继续", "我已关闭，重新启动", "退出 LunaCode"],
          defaultId: 0,
          cancelId: 2,
        });

        if (result.response === 0) {
          const quitRequested = yield* deps.requestGentleQuitOfficialApp(officialAppName);
          if (quitRequested && (yield* deps.awaitRelease)) {
            return "proceed";
          }
          if (!(yield* deps.isLocked)) {
            return "proceed";
          }
          gentleQuitTimedOut = true;
          ({ owner, officialAppName } = yield* probeCurrentConflict);
          continue;
        }

        if (result.response === 1) {
          if (!(yield* deps.isLocked)) {
            return "proceed";
          }
          gentleQuitTimedOut = false;
          ({ owner, officialAppName } = yield* probeCurrentConflict);
          continue;
        }

        return "quit";
      }

      const detailLines = [
        `数据目录 ${deps.stateDir} 正被其他进程占用，不能同时写入。`,
        Option.match(owner, {
          onNone: () => "请关闭正在运行的 `t3 serve`、后台服务或另一个 T3 Code 实例后重试。",
          onSome: (current) =>
            `${current.serviceManaged ? "后台服务" : "外部进程"}正在使用该目录（PID ${current.pid}，端口 ${current.port}${current.serverVersion ? `，版本 ${current.serverVersion}` : ""}）。${
              current.serviceManaged
                ? "可先执行 `t3 service uninstall` 停止服务。"
                : "请先关闭对应进程后重试。"
            }`,
        }),
      ];

      const result = yield* deps.showMessageBox({
        type: "warning",
        title: "数据目录已被占用",
        message: "检测到另一个 T3 Code 服务正在使用当前数据目录",
        detail: detailLines.join("\n\n"),
        buttons: ["我已关闭，重新启动", "退出 LunaCode"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        if (!(yield* deps.isLocked)) {
          return "proceed";
        }
        gentleQuitTimedOut = false;
        ({ owner, officialAppName } = yield* probeCurrentConflict);
        continue;
      }

      return "quit";
    }
  },
);

export const ensureHomeOwnershipAvailable = Effect.fn(
  "lunacode.homeConflictGuard.ensureHomeOwnershipAvailable",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ownerContext = yield* Effect.context<
    DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | Path.Path
  >();

  return yield* resolveHomeOwnershipConflict({
    platform: environment.platform,
    stateDir: environment.stateDir,
    isLocked: DesktopHomeOwner.isHomeOwnershipLocked().pipe(Effect.provide(ownerContext)),
    awaitRelease: DesktopHomeOwner.awaitHomeOwnershipRelease().pipe(Effect.provide(ownerContext)),
    readOwner: DesktopHomeOwner.readLiveHomeOwner().pipe(Effect.provide(ownerContext)),
    inspectProcessCommand: (pid) => probeProcessCommand(spawner, pid),
    requestGentleQuitOfficialApp: (appName) => sendGentleQuitAppleScript(spawner, appName),
    showMessageBox: (options) =>
      dialog.showMessageBox(options).pipe(
        Effect.orElseSucceed((): Electron.MessageBoxReturnValue => ({
          response: options.cancelId ?? 1,
          checkboxChecked: false,
        })),
      ),
  });
});
