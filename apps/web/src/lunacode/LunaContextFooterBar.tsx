import type { ProviderDriverKind } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { LunaContextInspectorDialog } from "./LunaContextInspectorDialog";
import {
  type LunaContextTelemetry,
  formatCountdownClock,
  formatPercent2,
  formatTokenCompact,
} from "./contextTelemetry";
import type { DeterministicHandoffResult } from "./handoffBuilder";
import { useLunaPreferences } from "./preferences";

function readCacheClockSnapshot(expiresAtMs: number | null, forceTick: boolean): number {
  if (expiresAtMs === null) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = Math.floor((expiresAtMs + 600_000) / 1000);
  if (!forceTick && nowSec >= cutoffSec) {
    return cutoffSec * 1000;
  }
  return nowSec * 1000;
}

function useLunaCacheClock(expiresAtMs: number | null, forceTick: boolean): number {
  const subscribe = (onChange: () => void) => {
    if (expiresAtMs === null) return () => {};
    if (!forceTick && Date.now() >= expiresAtMs + 600_000) return () => {};
    const timer = window.setInterval(() => {
      onChange();
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  };
  const getSnapshot = () => readCacheClockSnapshot(expiresAtMs, forceTick);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface LunaContextFooterBarProps {
  readonly telemetry: LunaContextTelemetry;
  readonly canCompact: boolean;
  readonly providerDriver?: ProviderDriverKind | null | undefined;
  readonly onCompactContext: (instructions?: string) => void;
  readonly onBuildHandoff?: (() => DeterministicHandoffResult) | undefined;
  readonly onOpenHandoffThread?: ((markdown: string) => void) | undefined;
}

export function LunaContextFooterBar({
  telemetry,
  canCompact,
  providerDriver,
  onCompactContext,
  onBuildHandoff,
  onOpenHandoffThread,
}: LunaContextFooterBarProps) {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [preferences] = useLunaPreferences();
  const expiresAtMs = telemetry.promptCacheExpiresAtMs;
  const nowMs = useLunaCacheClock(expiresAtMs, inspectorOpen);

  const modelKey = telemetry.model ?? "__default__";
  const thresholdK = preferences.modelAlertThresholdsK[modelKey] ?? null;
  const thresholdExceeded = thresholdK !== null && telemetry.usedTokens >= thresholdK * 1000;

  const remainingCacheMs = expiresAtMs !== null ? expiresAtMs - nowMs : null;

  const contextLabel =
    telemetry.usedPercent !== null
      ? `上下文 ${formatPercent2(telemetry.usedPercent)}`
      : telemetry.usedTokens > 0
        ? `上下文 ${formatTokenCompact(telemetry.usedTokens)}`
        : "上下文 -";

  const hitLabel =
    telemetry.latestCall.totalInputTokens > 0
      ? `命中 ${formatPercent2(telemetry.latestCall.hitRatePercent)}`
      : "命中 -";

  const compactTooltip = canCompact
    ? providerDriver === "claudeAgent" && preferences.compactTemplateEnabled
      ? "按保留重点模板执行原生 /compact"
      : "使用原生 /compact 压缩会话上下文"
    : "当前会话流式输出中、暂无可压缩内容，或当前 Provider 不支持";

  const handleFooterCompact = () => {
    if (!canCompact) return;
    if (providerDriver === "claudeAgent" && preferences.compactTemplateEnabled) {
      onCompactContext(preferences.compactTemplateText);
      return;
    }
    onCompactContext();
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setInspectorOpen(true)}
              className={
                thresholdExceeded
                  ? "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1.5 truncate rounded-md border border-warning/40 bg-warning-surface px-2 font-mono text-2xs text-warning-foreground transition-colors hover:bg-warning/20 tabular-nums"
                  : "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1.5 truncate rounded-md border border-transparent px-1.5 font-mono text-2xs text-muted-foreground transition-colors hover:border-border/60 hover:bg-accent/50 hover:text-foreground tabular-nums"
              }
            />
          }
        >
          <span className="truncate">
            {contextLabel} · {hitLabel}
          </span>
          {remainingCacheMs !== null && remainingCacheMs > 0 ? (
            <span className="shrink-0 rounded bg-success/15 px-1 py-px text-3xs text-success">
              {formatCountdownClock(remainingCacheMs)}
            </span>
          ) : remainingCacheMs !== null && remainingCacheMs > -600_000 ? (
            <span className="shrink-0 rounded bg-muted/60 px-1 py-px text-3xs text-muted-foreground">
              已冷却
            </span>
          ) : null}
          {thresholdExceeded ? <span className="shrink-0 font-bold">!</span> : null}
        </TooltipTrigger>
        <TooltipPopup>
          查看上下文、缓存与结构化接力详情（纯本地统计，不消耗额外 Token）
        </TooltipPopup>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-disabled={!canCompact}
              onClick={handleFooterCompact}
              className={
                canCompact
                  ? "inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md border border-border/70 bg-background/60 px-2 text-2xs font-medium text-foreground transition-colors hover:bg-accent"
                  : "inline-flex h-6 shrink-0 cursor-not-allowed items-center rounded-md border border-border/50 bg-background/40 px-2 text-2xs font-medium text-muted-foreground opacity-50"
              }
            />
          }
        >
          压缩会话
        </TooltipTrigger>
        <TooltipPopup>{compactTooltip}</TooltipPopup>
      </Tooltip>

      <LunaContextInspectorDialog
        open={inspectorOpen}
        onOpenChange={setInspectorOpen}
        telemetry={telemetry}
        cacheNowMs={nowMs}
        canCompact={canCompact}
        compactDisabledReason={canCompact ? null : compactTooltip}
        providerDriver={providerDriver}
        onCompactContext={onCompactContext}
        onBuildHandoff={onBuildHandoff}
        onOpenHandoffThread={onOpenHandoffThread}
      />
    </div>
  );
}
