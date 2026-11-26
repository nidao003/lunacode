import { useState, useSyncExternalStore } from "react";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { resolveCloudAuthMode } from "~/cloud/publicConfig";
import { LunaServerUrlConfigCard } from "./LunaServerUrlConfigCard";
import { DEFAULT_COMPACT_TEMPLATE_TEXT, useLunaPreferences } from "./preferences";

export interface LunaRtkStatus {
  readonly installed: boolean;
  readonly binaryPath: string | null;
  readonly version: string | null;
  readonly claudeHookConfigured: boolean;
  readonly installCommand: string;
  readonly initCommand: string;
}

export interface LunaRtkInitResult {
  readonly ok: boolean;
  readonly output: string;
  readonly status: LunaRtkStatus;
}

interface LunaDesktopBridge {
  readonly getRtkStatus: () => Promise<LunaRtkStatus>;
  readonly initRtkGlobal: () => Promise<LunaRtkInitResult>;
}

function getLunaDesktopBridge(): LunaDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as { readonly lunaDesktopBridge?: unknown }).lunaDesktopBridge;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "getRtkStatus" in candidate &&
    typeof candidate.getRtkStatus === "function" &&
    "initRtkGlobal" in candidate &&
    typeof candidate.initRtkGlobal === "function"
  ) {
    return candidate as LunaDesktopBridge;
  }
  return null;
}

interface RtkStoreSnapshot {
  readonly state: "idle" | "loading" | "ready" | "error" | "unavailable";
  readonly status: LunaRtkStatus | null;
  readonly error: string | null;
}

let rtkSnapshot: RtkStoreSnapshot = {
  state: "idle",
  status: null,
  error: null,
};
const rtkListeners = new Set<() => void>();

function notifyRtkListeners() {
  for (const listener of rtkListeners) listener();
}

async function refreshRtkSnapshot(): Promise<void> {
  const bridge = getLunaDesktopBridge();
  if (!bridge) {
    rtkSnapshot = { state: "unavailable", status: null, error: null };
    notifyRtkListeners();
    return;
  }
  rtkSnapshot = { ...rtkSnapshot, state: "loading", error: null };
  notifyRtkListeners();
  try {
    const status = await bridge.getRtkStatus();
    rtkSnapshot = { state: "ready", status, error: null };
  } catch (error) {
    rtkSnapshot = {
      state: "error",
      status: rtkSnapshot.status,
      error: error instanceof Error ? error.message : "检测 rtk 状态失败",
    };
  }
  notifyRtkListeners();
}

function subscribeRtkStore(onChange: () => void): () => void {
  rtkListeners.add(onChange);
  if (rtkSnapshot.state === "idle") {
    void refreshRtkSnapshot();
  }
  return () => {
    rtkListeners.delete(onChange);
  };
}

function useRtkStatus(): RtkStoreSnapshot {
  return useSyncExternalStore(
    subscribeRtkStore,
    () => rtkSnapshot,
    () => rtkSnapshot,
  );
}

export function LunaCodeSettingsSection() {
  const [preferences, updatePreferences] = useLunaPreferences();
  const rtk = useRtkStatus();
  const [rtkBusy, setRtkBusy] = useState(false);
  const [rtkFeedback, setRtkFeedback] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleInitRtk = async () => {
    const bridge = getLunaDesktopBridge();
    if (!bridge || rtkBusy) return;
    setRtkBusy(true);
    setRtkFeedback(null);
    try {
      const result = await bridge.initRtkGlobal();
      rtkSnapshot = { state: "ready", status: result.status, error: null };
      notifyRtkListeners();
      setRtkFeedback(
        result.ok
          ? "已完成 rtk Claude 官方 Hook 初始化（仅作用于命令行输出降噪）。"
          : `执行未完全成功：${result.output || "请查看本机终端输出"}`,
      );
      setRtkBusy(false);
    } catch (error) {
      setRtkFeedback(error instanceof Error ? error.message : "配置 rtk Hook 失败");
      setRtkBusy(false);
    }
  };

  const copyText = (key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => setCopiedKey(key),
      () => setCopiedKey(null),
    );
  };

  return (
    <SettingsSection id="lunacode" title="LunaCode 定制能力">
      {resolveCloudAuthMode() !== "clerk" ? (
        <SettingsGroup>
          <LunaServerUrlConfigCard />
        </SettingsGroup>
      ) : null}

      {/* OpenViking 云端记忆：由 Agent 原生插件提供，LunaCode 不再自带客户端 */}
      <SettingsGroup>
        <div className="space-y-2 p-4 text-xs">
          <div className="text-sm font-medium text-foreground">OpenViking 云端记忆</div>
          <p className="text-muted-foreground">
            记忆由各 Agent CLI 的 OpenViking 插件提供（自动召回与沉淀），LunaCode
            不再内置独立客户端，避免同一服务上的参数漂移与重复注入。
          </p>
          <p className="text-muted-foreground">
            连接地址、API Key 与召回阈值统一在{" "}
            <span className="font-mono text-foreground">~/.openviking/ovcli.conf</span> 中维护。
          </p>
        </div>
      </SettingsGroup>

      {/* rtk 终端输出源头降噪 */}
      <SettingsGroup>
        <div className="space-y-3 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-foreground">
                终端输出源头降噪（rtk 官方 Hook）
              </div>
              <p className="mt-0.5 text-muted-foreground">
                通过本机 Rust Token Killer (rtk) 与 Claude Code 官方 PreToolUse Hook
                裁剪冗余测试/构建日志。
              </p>
            </div>
            {rtk.state !== "unavailable" ? (
              <div className="flex items-center gap-1.5">
                <Button size="xs" variant="outline" onClick={() => void refreshRtkSnapshot()}>
                  {rtk.state === "loading" ? "检测中..." : "重新检测"}
                </Button>
                {rtk.status?.installed && !rtk.status.claudeHookConfigured ? (
                  <Button
                    size="xs"
                    variant="default"
                    disabled={rtkBusy}
                    onClick={() => void handleInitRtk()}
                  >
                    {rtkBusy ? "配置中..." : "配置 Claude 官方 Hook"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {rtk.state === "unavailable" ? (
            <p className="text-muted-foreground">
              当前在纯浏览器模式运行，无法读取桌面端二进制状态。请在 LunaCode.app
              桌面端打开此页面，或在本机终端执行以下命令：
            </p>
          ) : rtk.status ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  rtk.status.installed
                    ? "rounded border border-success/35 bg-success/10 px-2 py-0.5 text-2xs text-success"
                    : "rounded border border-warning/40 bg-warning-surface px-2 py-0.5 text-2xs text-warning-foreground"
                }
              >
                {rtk.status.installed
                  ? `已安装 ${rtk.status.version ?? ""}`.trim()
                  : "本机未检测到 rtk"}
              </span>
              <span
                className={
                  rtk.status.claudeHookConfigured
                    ? "rounded border border-success/35 bg-success/10 px-2 py-0.5 text-2xs text-success"
                    : "rounded border border-border bg-muted/50 px-2 py-0.5 text-2xs text-muted-foreground"
                }
              >
                {rtk.status.claudeHookConfigured
                  ? "Claude ~/.claude/settings.json Hook 已启用"
                  : "Claude PreToolUse Hook 未配置"}
              </span>
              {rtk.status.binaryPath ? (
                <span className="font-mono text-2xs text-muted-foreground">
                  {rtk.status.binaryPath}
                </span>
              ) : null}
            </div>
          ) : rtk.error ? (
            <p className="text-destructive">{rtk.error}</p>
          ) : null}

          {rtkFeedback ? <p className="text-foreground">{rtkFeedback}</p> : null}

          <p className="rounded-md border border-warning/40 bg-warning-surface px-2.5 py-1.5 text-warning-foreground">
            智商保护提示：rtk
            会对命令行标准输出做有损重写/精简，复杂排障时可能隐藏关键报错堆栈细节。默认不自动安装或注入
            Hook，请确认不影响排查判断后再按需启用。
          </p>

          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-2xs text-foreground">
                brew install rtk-ai/tap/rtk
              </code>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => copyText("install", "brew install rtk-ai/tap/rtk")}
              >
                {copiedKey === "install" ? "已复制" : "复制安装命令"}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-2xs text-foreground">rtk init --global</code>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => copyText("init", "rtk init --global")}
              >
                {copiedKey === "init" ? "已复制" : "复制初始化命令"}
              </Button>
            </div>
          </div>
        </div>
      </SettingsGroup>

      {/* /compact 保留重点模板与合规准则 */}
      <SettingsGroup>
        <div className="space-y-3 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-foreground">
                结构化 /compact 默认保留模板
              </div>
              <p className="mt-0.5 text-muted-foreground">
                仅用于支持自定义指令的 Claude Code 原生 /compact；Codex 会直接走官方原生压缩协议。
              </p>
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                updatePreferences((curr) => ({
                  ...curr,
                  compactTemplateText: DEFAULT_COMPACT_TEMPLATE_TEXT,
                }))
              }
            >
              恢复默认模板
            </Button>
          </div>

          <label className="flex cursor-pointer items-center gap-2 font-medium text-foreground">
            <input
              type="checkbox"
              checked={preferences.compactTemplateEnabled}
              onChange={(event) =>
                updatePreferences((curr) => ({
                  ...curr,
                  compactTemplateEnabled: event.target.checked,
                }))
              }
            />
            <span>点击底栏「压缩会话」时附带以下保留要点（限 Claude）</span>
          </label>

          <textarea
            rows={2}
            value={preferences.compactTemplateText}
            onChange={(event) =>
              updatePreferences((curr) => ({
                ...curr,
                compactTemplateText: event.target.value.slice(0, 300),
              }))
            }
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none focus:border-ring"
          />

          <p className="text-2xs text-muted-foreground">
            LunaCode 三条核心红线：1) 官方合规与协议纯净（无代理劫持/保活探针/自动轮询切号）；2)
            零额外 Token 浪费（纯本地只读统计与手动按需触发）；3) 禁止影响 Agent
            智商（默认保持原生压缩与完整工具输出，不静默有损截断或自动注入低相关上下文）。
          </p>
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
