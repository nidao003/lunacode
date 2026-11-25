// @effect-diagnostics-next-line nodeBuiltinImport:off -- Reads user PATH / ~/.claude/settings.json and runs explicit user-triggered rtk CLI commands.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Checks executable permission on rtk binary.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Reads ~/.claude/settings.json without Effect FileSystem layer.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure synchronous PATH/candidate resolution helper used in unit tests.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeIpcMethod } from "../ipc/DesktopIpc.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const LUNA_RTK_GET_STATUS_CHANNEL = "luna:rtk-get-status";
const LUNA_RTK_INIT_GLOBAL_CHANNEL = "luna:rtk-init-global";
const RTK_INSTALL_COMMAND = "brew install rtk-ai/tap/rtk";
const RTK_INIT_COMMAND = "rtk init --global";

export const LunaRtkStatusSchema = Schema.Struct({
  installed: Schema.Boolean,
  binaryPath: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  claudeHookConfigured: Schema.Boolean,
  installCommand: Schema.String,
  initCommand: Schema.String,
});
export type LunaRtkStatus = typeof LunaRtkStatusSchema.Type;

export const LunaRtkInitResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  output: Schema.String,
  status: LunaRtkStatusSchema,
});
export type LunaRtkInitResult = typeof LunaRtkInitResultSchema.Type;

class LunaRtkExecutionError extends Schema.TaggedError<
  LunaRtkExecutionError,
  { readonly brand: unique symbol }
>()("LunaRtkExecutionError", {
  cause: Schema.Defect(),
}) {}

export function resolveRtkCandidatePaths(
  envPath: string | undefined,
  homeDir: string,
): ReadonlyArray<string> {
  const candidates = [
    "/opt/homebrew/bin/rtk",
    "/usr/local/bin/rtk",
    NodePath.join(homeDir, ".cargo", "bin", "rtk"),
    NodePath.join(homeDir, ".local", "bin", "rtk"),
  ];

  for (const segment of (envPath ?? "").split(NodePath.delimiter)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    candidates.push(NodePath.join(trimmed, "rtk"));
  }

  return [...new Set(candidates)];
}

function objectContainsRtkString(value: unknown): boolean {
  if (typeof value === "string") {
    return /\brtk\b|rtk-rewrite/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(objectContainsRtkString);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(objectContainsRtkString);
  }
  return false;
}

export function hasRtkClaudeHook(settingsJsonRaw: string | null): boolean {
  if (!settingsJsonRaw) return false;
  try {
    const parsed: unknown = JSON.parse(settingsJsonRaw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const hooks = (parsed as { readonly hooks?: unknown }).hooks;
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
      return false;
    }
    const preToolUse = (hooks as { readonly PreToolUse?: unknown }).PreToolUse;
    return objectContainsRtkString(preToolUse);
  } catch {
    return false;
  }
}

async function findExecutableRtk(candidates: ReadonlyArray<string>): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await NodeFSP.access(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Check next candidate
    }
  }
  return null;
}

async function readRtkVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], { timeout: 3000 });
    const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
    return line || null;
  } catch {
    return null;
  }
}

async function readClaudeSettingsRaw(homeDir: string): Promise<string | null> {
  const settingsPath = NodePath.join(homeDir, ".claude", "settings.json");
  try {
    return await NodeFSP.readFile(settingsPath, "utf8");
  } catch {
    return null;
  }
}

const readLunaRtkStatus = Effect.fn("lunacode.rtk.readStatus")(function* () {
  const envPath = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => ""));
  const homeDir = NodeOS.homedir();
  const candidates = resolveRtkCandidatePaths(envPath, homeDir);

  return yield* Effect.tryPromise({
    try: async (): Promise<LunaRtkStatus> => {
      const binaryPath = await findExecutableRtk(candidates);
      const [version, settingsRaw] = await Promise.all([
        binaryPath ? readRtkVersion(binaryPath) : Promise.resolve(null),
        readClaudeSettingsRaw(homeDir),
      ]);
      return {
        installed: binaryPath !== null,
        binaryPath,
        version,
        claudeHookConfigured: hasRtkClaudeHook(settingsRaw),
        installCommand: RTK_INSTALL_COMMAND,
        initCommand: RTK_INIT_COMMAND,
      };
    },
    catch: (cause) => new LunaRtkExecutionError({ cause }),
  }).pipe(
    Effect.orElseSucceed((): LunaRtkStatus => ({
      installed: false,
      binaryPath: null,
      version: null,
      claudeHookConfigured: false,
      installCommand: RTK_INSTALL_COMMAND,
      initCommand: RTK_INIT_COMMAND,
    })),
  );
});

async function runRtkInitArgs(
  binaryPath: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly ok: boolean; readonly output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [...args], { timeout: 10_000 });
    const combined = `${stdout}\n${stderr}`.trim();
    return { ok: true, output: combined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: message };
  }
}

const runLunaRtkInitGlobal = Effect.fn("lunacode.rtk.initGlobal")(function* () {
  const initialStatus = yield* readLunaRtkStatus();
  if (!initialStatus.installed || !initialStatus.binaryPath) {
    return {
      ok: false,
      output: "未在本机检测到 rtk 可执行文件，请先执行 brew install rtk-ai/tap/rtk。",
      status: initialStatus,
    } satisfies LunaRtkInitResult;
  }

  const binaryPath = initialStatus.binaryPath;
  const execution = yield* Effect.tryPromise({
    try: async () => {
      const firstTry = await runRtkInitArgs(binaryPath, ["init", "--global", "--auto-patch"]);
      if (firstTry.ok) return firstTry;
      return await runRtkInitArgs(binaryPath, ["init", "--global"]);
    },
    catch: (cause) => new LunaRtkExecutionError({ cause }),
  }).pipe(Effect.orElseSucceed(() => ({ ok: false, output: "执行 rtk init 失败" })));

  const latestStatus = yield* readLunaRtkStatus();
  return {
    ok: execution.ok,
    output: execution.output,
    status: latestStatus,
  } satisfies LunaRtkInitResult;
});

export const getLunaRtkStatusIpc = makeIpcMethod({
  channel: LUNA_RTK_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: LunaRtkStatusSchema,
  handler: Effect.fn("desktop.ipc.lunacode.rtkStatus")(function* () {
    return yield* readLunaRtkStatus();
  }),
});

export const initLunaRtkGlobalIpc = makeIpcMethod({
  channel: LUNA_RTK_INIT_GLOBAL_CHANNEL,
  payload: Schema.Void,
  result: LunaRtkInitResultSchema,
  handler: Effect.fn("desktop.ipc.lunacode.rtkInitGlobal")(function* () {
    return yield* runLunaRtkInitGlobal();
  }),
});
