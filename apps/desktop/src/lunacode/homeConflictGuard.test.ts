import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import {
  detectOfficialDesktopAppName,
  resolveHomeOwnershipConflict,
  type HomeConflictGuardDeps,
} from "./homeConflictGuard.ts";
import type { HomeOwner } from "../backend/DesktopHomeOwner.ts";
import type { OfficialT3MacAppName } from "./branding.ts";

describe("detectOfficialDesktopAppName", () => {
  it("detects whitelisted official macOS T3 Code app paths", () => {
    assert.equal(
      detectOfficialDesktopAppName(
        "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
      ),
      "T3 Code (Beta)",
    );
    assert.equal(
      detectOfficialDesktopAppName(
        "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)",
      ),
      "T3 Code (Nightly)",
    );
    assert.equal(
      detectOfficialDesktopAppName("/Applications/T3 Code.app/Contents/MacOS/T3 Code"),
      "T3 Code",
    );
  });

  it("ignores LunaCode, CLI services, and empty command lines", () => {
    assert.isNull(
      detectOfficialDesktopAppName("/Applications/LunaCode.app/Contents/MacOS/LunaCode"),
    );
    assert.isNull(detectOfficialDesktopAppName("node /usr/local/bin/t3 serve"));
    assert.isNull(detectOfficialDesktopAppName(null));
    assert.isNull(detectOfficialDesktopAppName(undefined));
  });
});

const makeDeps = (overrides: {
  readonly platform?: NodeJS.Platform;
  readonly isLocked: () => boolean;
  readonly awaitRelease?: () => boolean;
  readonly owner?: Option.Option<HomeOwner>;
  readonly commandLine?: string | null;
  readonly requestGentleQuitOfficialApp?: (appName: OfficialT3MacAppName) => boolean;
  readonly showMessageBox: (options: Electron.MessageBoxOptions) => Electron.MessageBoxReturnValue;
}): HomeConflictGuardDeps => ({
  platform: overrides.platform ?? "darwin",
  stateDir: "/Users/alice/.t3/userdata",
  isLocked: Effect.sync(overrides.isLocked),
  awaitRelease: Effect.sync(overrides.awaitRelease ?? (() => !overrides.isLocked())),
  readOwner: Effect.succeed(
    overrides.owner ?? Option.some({ pid: 4321, port: 3773, serviceManaged: false }),
  ),
  inspectProcessCommand: () => Effect.succeed(overrides.commandLine ?? null),
  requestGentleQuitOfficialApp: (appName) =>
    Effect.sync(() => overrides.requestGentleQuitOfficialApp?.(appName) ?? true),
  showMessageBox: (options) => Effect.sync(() => overrides.showMessageBox(options)),
});

describe("resolveHomeOwnershipConflict", () => {
  it.effect("proceeds immediately when userdata is not locked", () =>
    Effect.gen(function* () {
      let dialogShown = false;
      const result = yield* resolveHomeOwnershipConflict(
        makeDeps({
          isLocked: () => false,
          showMessageBox: () => {
            dialogShown = true;
            return { response: 2, checkboxChecked: false };
          },
        }),
      );
      assert.equal(result, "proceed");
      assert.isFalse(dialogShown);
    }),
  );

  it.effect("skips long wait and gently quits official macOS app when user chooses continue", () =>
    Effect.gen(function* () {
      let locked = true;
      let awaitCalls = 0;
      const quitTargets: OfficialT3MacAppName[] = [];
      const prompts: Electron.MessageBoxOptions[] = [];

      const result = yield* resolveHomeOwnershipConflict(
        makeDeps({
          isLocked: () => locked,
          awaitRelease: () => {
            awaitCalls += 1;
            return !locked;
          },
          commandLine: "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
          requestGentleQuitOfficialApp: (appName) => {
            quitTargets.push(appName);
            locked = false;
            return true;
          },
          showMessageBox: (options) => {
            prompts.push(options);
            return { response: 0, checkboxChecked: false };
          },
        }),
      );

      assert.equal(result, "proceed");
      assert.deepStrictEqual(quitTargets, ["T3 Code (Beta)"]);
      assert.equal(awaitCalls, 1);
      assert.equal(prompts.length, 1);
      assert.include(prompts[0]?.message ?? "", "T3 Code (Beta)");
      assert.deepStrictEqual(prompts[0]?.buttons, [
        "温和退出官方版并继续",
        "我已关闭，重新启动",
        "退出 LunaCode",
      ]);
    }),
  );

  it.effect("warns and re-prompts when gentle quit times out, then quits if user cancels", () =>
    Effect.gen(function* () {
      const prompts: Electron.MessageBoxOptions[] = [];
      let call = 0;

      const result = yield* resolveHomeOwnershipConflict(
        makeDeps({
          isLocked: () => true,
          awaitRelease: () => false,
          commandLine: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
          requestGentleQuitOfficialApp: () => true,
          showMessageBox: (options) => {
            prompts.push(options);
            const response = call === 0 ? 0 : 2;
            call += 1;
            return { response, checkboxChecked: false };
          },
        }),
      );

      assert.equal(result, "quit");
      assert.equal(prompts.length, 2);
      assert.include(prompts[1]?.detail ?? "", "尚未完全退出");
    }),
  );

  it.effect("re-checks lock when user closes official app manually and clicks retry", () =>
    Effect.gen(function* () {
      let locked = true;
      let call = 0;

      const result = yield* resolveHomeOwnershipConflict(
        makeDeps({
          isLocked: () => locked,
          commandLine: "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
          showMessageBox: () => {
            call += 1;
            if (call === 2) {
              locked = false;
            }
            return { response: 1, checkboxChecked: false };
          },
        }),
      );

      assert.equal(result, "proceed");
      assert.equal(call, 2);
    }),
  );

  it.effect("shows generic service conflict prompt for non-desktop server owners", () =>
    Effect.gen(function* () {
      let locked = true;
      const prompts: Electron.MessageBoxOptions[] = [];

      const result = yield* resolveHomeOwnershipConflict(
        makeDeps({
          isLocked: () => locked,
          awaitRelease: () => false,
          owner: Option.some({
            pid: 9999,
            port: 3773,
            serviceManaged: true,
            serverVersion: "0.1.11",
          }),
          commandLine: "/usr/local/bin/node /usr/local/bin/t3 serve",
          showMessageBox: (options) => {
            prompts.push(options);
            locked = false;
            return { response: 0, checkboxChecked: false };
          },
        }),
      );

      assert.equal(result, "proceed");
      assert.equal(prompts.length, 1);
      assert.deepStrictEqual(prompts[0]?.buttons, ["我已关闭，重新启动", "退出 LunaCode"]);
      assert.include(prompts[0]?.detail ?? "", "后台服务");
      assert.include(prompts[0]?.detail ?? "", "PID 9999");
    }),
  );
});
