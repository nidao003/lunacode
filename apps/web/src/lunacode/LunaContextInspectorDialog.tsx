import type { ProviderDriverKind } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  type LunaCompositionSegment,
  type LunaContextTelemetry,
  formatCountdownClock,
  formatDurationZh,
  formatPercent2,
  formatTokenCompact,
  formatUsdRange,
} from "./contextTelemetry";
import type { DeterministicHandoffResult } from "./handoffBuilder";
import { DEFAULT_COMPACT_TEMPLATE_TEXT, useLunaPreferences } from "./preferences";

const SEGMENT_COLORS: Readonly<Record<LunaCompositionSegment["key"], string>> = {
  tools: "bg-info",
  assistant: "bg-success",
  user: "bg-primary",
  reasoning: "bg-warning",
  attachments: "bg-destructive",
};

interface LunaContextInspectorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly telemetry: LunaContextTelemetry;
  readonly cacheNowMs: number;
  readonly canCompact: boolean;
  readonly compactDisabledReason?: string | null;
  readonly providerDriver?: ProviderDriverKind | null | undefined;
  readonly onCompactContext: (instructions?: string) => void;
  readonly onBuildHandoff?: (() => DeterministicHandoffResult) | undefined;
  readonly onOpenHandoffThread?: ((markdown: string) => void) | undefined;
}

export function LunaContextInspectorDialog({
  open,
  onOpenChange,
  telemetry,
  cacheNowMs,
  canCompact,
  compactDisabledReason,
  providerDriver,
  onCompactContext,
  onBuildHandoff,
  onOpenHandoffThread,
}: LunaContextInspectorDialogProps) {
  const [preferences, updatePreferences] = useLunaPreferences();
  const modelKey = telemetry.model ?? "__default__";
  const savedThresholdK = preferences.modelAlertThresholdsK[modelKey] ?? null;
  const [thresholdDraft, setThresholdDraft] = useState<{
    readonly modelKey: string;
    readonly value: string;
  } | null>(null);
  const [handoffPreview, setHandoffPreview] = useState<DeterministicHandoffResult | null>(null);
  const [handoffCopied, setHandoffCopied] = useState(false);

  const inputThresholdValue =
    thresholdDraft?.modelKey === modelKey
      ? thresholdDraft.value
      : savedThresholdK !== null
        ? String(savedThresholdK)
        : "";

  const thresholdTokens = savedThresholdK !== null ? savedThresholdK * 1000 : null;
  const thresholdExceeded = thresholdTokens !== null && telemetry.usedTokens >= thresholdTokens;

  const usedPct = telemetry.usedPercent ?? 0;
  const barTone =
    usedPct >= 90
      ? "bg-destructive"
      : usedPct >= 75 || thresholdExceeded
        ? "bg-warning"
        : "bg-success";

  const latestTurn = telemetry.recentTurns[0] ?? null;
  const cacheRemainingMs =
    telemetry.promptCacheExpiresAtMs !== null
      ? telemetry.promptCacheExpiresAtMs - cacheNowMs
      : null;

  const supportsStructuredCompact = providerDriver === "claudeAgent";

  const handleSaveThreshold = () => {
    const parsed = Number.parseFloat(inputThresholdValue.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      updatePreferences((curr) => {
        const nextMap = { ...curr.modelAlertThresholdsK };
        delete nextMap[modelKey];
        return { ...curr, modelAlertThresholdsK: nextMap };
      });
      setThresholdDraft(null);
      return;
    }
    const rounded = Math.max(1, Math.round(parsed));
    updatePreferences((curr) => ({
      ...curr,
      modelAlertThresholdsK: {
        ...curr.modelAlertThresholdsK,
        [modelKey]: rounded,
      },
    }));
    setThresholdDraft(null);
  };

  const handleClearThreshold = () => {
    updatePreferences((curr) => {
      const nextMap = { ...curr.modelAlertThresholdsK };
      delete nextMap[modelKey];
      return { ...curr, modelAlertThresholdsK: nextMap };
    });
    setThresholdDraft({ modelKey, value: "" });
  };

  const handleCopyHandoff = () => {
    if (!handoffPreview) return;
    void navigator.clipboard.writeText(handoffPreview.markdown).then(
      () => setHandoffCopied(true),
      () => setHandoffCopied(false),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-0.5">
              <DialogTitle>会话缓存与上下文</DialogTitle>
              <DialogDescription>
                <span className="font-mono text-xs">
                  {telemetry.model ?? "当前模型未知"} · 纯本地只读统计（不消耗额外 Token）
                </span>
              </DialogDescription>
            </div>
            {cacheRemainingMs !== null ? (
              <span
                className={
                  cacheRemainingMs > 0
                    ? "rounded-full border border-success/35 bg-success/10 px-2.5 py-0.5 font-mono text-2xs text-success tabular-nums"
                    : "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 font-mono text-2xs text-muted-foreground"
                }
              >
                {cacheRemainingMs > 0
                  ? `缓存余温 ${formatCountdownClock(cacheRemainingMs)}`
                  : "缓存余温已冷却"}
              </span>
            ) : null}
          </div>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-5 text-sm">
            {/* 当前上下文占用与提醒线 */}
            <section className="space-y-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2.5">
                  <span className="font-medium text-foreground">当前上下文</span>
                  <span className="font-mono text-base font-semibold text-foreground tabular-nums">
                    {formatTokenCompact(telemetry.usedTokens)} tokens
                  </span>
                </div>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {telemetry.maxTokens !== null
                    ? `窗口容量 ${formatTokenCompact(telemetry.maxTokens)} · ${formatPercent2(telemetry.usedPercent)}`
                    : "窗口容量未知"}
                </span>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-muted/70">
                <div
                  className={`h-full transition-[width] duration-300 ${barTone}`}
                  style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {telemetry.remainingTokens !== null
                    ? `剩余 ${formatTokenCompact(telemetry.remainingTokens)} tokens`
                    : "剩余空间取决于模型上下文上限"}
                  {telemetry.autoCompactThreshold !== null
                    ? ` · 上游自动压缩线 ${formatTokenCompact(telemetry.autoCompactThreshold)}`
                    : ""}
                </span>
                {thresholdExceeded && thresholdTokens !== null ? (
                  <span className="font-medium text-warning">
                    已超过提醒线 ({formatTokenCompact(thresholdTokens)})
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
                <label
                  htmlFor="luna-model-threshold-input"
                  className="shrink-0 text-muted-foreground"
                >
                  此模型提醒线 (千 tokens)
                </label>
                <input
                  id="luna-model-threshold-input"
                  type="number"
                  min={1}
                  step={10}
                  placeholder="关闭"
                  value={inputThresholdValue}
                  onChange={(event) => setThresholdDraft({ modelKey, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleSaveThreshold();
                    }
                  }}
                  className="h-7 w-28 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-ring tabular-nums"
                />
                <Button size="xs" variant="secondary" onClick={handleSaveThreshold}>
                  保存
                </Button>
                {savedThresholdK !== null ? (
                  <Button size="xs" variant="ghost-muted" onClick={handleClearThreshold}>
                    关闭提醒
                  </Button>
                ) : null}
              </div>
            </section>

            {/* 输入缓存 */}
            <section className="space-y-2 border-t border-border/60 pt-4">
              <h3 className="text-sm font-medium text-foreground">输入缓存</h3>
              <div className="overflow-hidden rounded-lg border border-border/60">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-muted/35 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">统计范围</th>
                      <th className="px-3 py-2 text-left font-medium">缓存读取 / 总输入</th>
                      <th className="px-3 py-2 text-right font-medium">命中率</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50 font-mono tabular-nums">
                    <tr>
                      <td className="px-3 py-2 font-sans text-foreground">最近一次模型调用</td>
                      <td className="px-3 py-2 text-foreground">
                        {telemetry.latestCall.totalInputTokens > 0
                          ? `${formatTokenCompact(telemetry.latestCall.cachedTokens)} / ${formatTokenCompact(telemetry.latestCall.totalInputTokens)}`
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-right text-foreground">
                        {formatPercent2(telemetry.latestCall.hitRatePercent)}
                      </td>
                    </tr>
                    {latestTurn ? (
                      <tr>
                        <td className="px-3 py-2 font-sans text-foreground">
                          第 {latestTurn.turnNumber} 轮合计
                        </td>
                        <td className="px-3 py-2 text-foreground">
                          {`${formatTokenCompact(latestTurn.cachedTokens)} / ${formatTokenCompact(latestTurn.totalInputTokens)}`}
                        </td>
                        <td className="px-3 py-2 text-right text-foreground">
                          {formatPercent2(latestTurn.hitRatePercent)}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {latestTurn ? (
                <p className="text-xs text-muted-foreground">
                  第 {latestTurn.turnNumber} 轮总输出 {formatTokenCompact(latestTurn.outputTokens)}{" "}
                  tokens
                  {latestTurn.tokensPerSecond !== null
                    ? `，均速 ${latestTurn.tokensPerSecond.toFixed(1)} tok/s`
                    : ""}
                  。
                </p>
              ) : null}
            </section>

            {/* 会话用量与 API 参考费用 */}
            <section className="space-y-2.5 border-t border-border/60 pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">会话用量与费用</h3>
                <span className="text-xs text-muted-foreground">
                  已载入 {telemetry.sessionTotals.completedTurnCount} 个完成轮次 · 总命中{" "}
                  {formatPercent2(telemetry.sessionTotals.hitRatePercent)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                  <div className="text-2xs text-muted-foreground">总输入</div>
                  <div className="mt-1 font-mono text-base font-semibold text-foreground tabular-nums">
                    {formatTokenCompact(telemetry.sessionTotals.totalInputTokens)}
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                  <div className="text-2xs text-muted-foreground">缓存读取</div>
                  <div className="mt-1 font-mono text-base font-semibold text-foreground tabular-nums">
                    {formatTokenCompact(telemetry.sessionTotals.totalCachedTokens)}
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                  <div className="text-2xs text-muted-foreground">输出</div>
                  <div className="mt-1 font-mono text-base font-semibold text-foreground tabular-nums">
                    {formatTokenCompact(telemetry.sessionTotals.totalOutputTokens)}
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                  <div className="text-2xs text-muted-foreground">API 参考费用</div>
                  <div className="mt-1 font-mono text-base font-semibold text-foreground tabular-nums">
                    {formatUsdRange(telemetry.estimatedApiCost)}
                  </div>
                </div>
              </div>

              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">
                  查看当前参考单价 · 美元 / 1M tokens（订阅额度另计，不代表实际扣费）
                </summary>
                <div className="mt-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 font-mono text-2xs">
                  {telemetry.estimatedApiCost.known
                    ? `${telemetry.estimatedApiCost.label}：输入 $${telemetry.estimatedApiCost.inputPerM.toFixed(2)} / 缓存读取 $${telemetry.estimatedApiCost.cachedInputPerM.toFixed(2)} / 输出 $${telemetry.estimatedApiCost.outputPerM.toFixed(2)}`
                    : `当前模型 (${telemetry.model ?? "未知"}) 暂无内置参考单价。`}
                </div>
              </details>
            </section>

            {/* 上下文构成估算 */}
            <section className="space-y-2 border-t border-border/60 pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">上下文构成估算</h3>
                <span className="text-xs text-muted-foreground">
                  按可见消息与工具项长度本地估算（系统提示词未单独拆分）
                </span>
              </div>

              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/60">
                {telemetry.compositionBreakdown.map((seg) =>
                  seg.percent > 0 ? (
                    <div
                      key={seg.key}
                      className={SEGMENT_COLORS[seg.key]}
                      style={{ width: `${seg.percent}%` }}
                      aria-label={`${seg.label}: 约 ${formatTokenCompact(seg.estimatedTokens)} tokens (${seg.percent.toFixed(1)}%)`}
                    />
                  ) : null,
                )}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                {telemetry.compositionBreakdown.map((seg) => (
                  <div key={seg.key} className="flex items-center gap-1.5">
                    <span
                      className={`inline-block size-2 rounded-full ${SEGMENT_COLORS[seg.key]}`}
                    />
                    <span>{seg.label}</span>
                    <span className="font-mono text-foreground tabular-nums">
                      {seg.percent.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* 压缩节省与合规结构化接力 (LUNA-005) */}
            <section className="space-y-3 border-t border-border/60 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">压缩与结构化接力</h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  {supportsStructuredCompact ? (
                    <>
                      <Button
                        size="xs"
                        variant="default"
                        disabled={!canCompact}
                        onClick={() => {
                          onOpenChange(false);
                          onCompactContext();
                        }}
                      >
                        执行原生 /compact
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canCompact || !preferences.compactTemplateEnabled}
                        onClick={() => {
                          onOpenChange(false);
                          onCompactContext(preferences.compactTemplateText);
                        }}
                      >
                        按模板压缩
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canCompact}
                      onClick={() => {
                        onOpenChange(false);
                        onCompactContext();
                      }}
                    >
                      执行原生 /compact
                    </Button>
                  )}
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {telemetry.compactionSavings.count > 0
                  ? `已记录 ${telemetry.compactionSavings.count} 次压缩，最近一次释放 ${formatTokenCompact(telemetry.compactionSavings.lastSavedTokens)} tokens，累计释放 ${formatTokenCompact(telemetry.compactionSavings.totalSavedTokens)} tokens。`
                  : compactDisabledReason
                    ? `当前记录中暂无已完成的压缩（${compactDisabledReason}）。`
                    : "当前记录中暂无已完成的压缩。按同一次压缩前后的上下文差值统计，可用来判断腾出了多少窗口空间。"}
              </p>

              {supportsStructuredCompact ? (
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
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
                      <span>
                        附带自定义重点模板执行 /compact（默认关闭以保持 Claude 原生压缩质量）
                      </span>
                    </label>
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
                      恢复默认
                    </Button>
                  </div>
                  <textarea
                    rows={2}
                    value={preferences.compactTemplateText}
                    onChange={(event) =>
                      updatePreferences((curr) => ({
                        ...curr,
                        compactTemplateText: event.target.value.slice(0, 300),
                      }))
                    }
                    className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-ring"
                  />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  当前 Provider 原生压缩接口不接受自定义指令，将直接触发官方原生 /compact。
                </p>
              )}

              {onBuildHandoff ? (
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      确定性结构化接力（开新窗 · 零额外 Token）
                    </span>
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        setHandoffCopied(false);
                        setHandoffPreview(onBuildHandoff());
                      }}
                    >
                      {handoffPreview ? "重新生成接力包" : "生成接力包"}
                    </Button>
                  </div>
                  <p className="text-muted-foreground">
                    纯前端提取原始目标、改动文件、失败命令与待办计划（上限 3000 字符），不调用模型。
                  </p>
                  {handoffPreview ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-2xs text-muted-foreground">
                        <span>
                          {handoffPreview.charCount} 字符 · 约 {handoffPreview.estimatedTokens}{" "}
                          tokens · 文件 {handoffPreview.stats.filesCount} 个
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button size="xs" variant="outline" onClick={handleCopyHandoff}>
                            {handoffCopied ? "已复制" : "复制接力包"}
                          </Button>
                          {onOpenHandoffThread ? (
                            <Button
                              size="xs"
                              variant="default"
                              onClick={() => {
                                onOpenChange(false);
                                onOpenHandoffThread(handoffPreview.markdown);
                              }}
                            >
                              在新会话中继续
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-background/80 p-2 font-mono text-2xs text-foreground">
                        {handoffPreview.markdown}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            {/* 最近对话轮次 */}
            <section className="space-y-2 border-t border-border/60 pt-4">
              <h3 className="text-sm font-medium text-foreground">最近对话轮次</h3>
              {telemetry.recentTurns.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无已完成轮次的用量记录。</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border/60">
                  <table className="w-full border-collapse text-xs">
                    <thead className="bg-muted/35 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">请求</th>
                        <th className="px-3 py-2 text-left font-medium">距上轮结束</th>
                        <th className="px-3 py-2 text-left font-medium">均速</th>
                        <th className="px-3 py-2 text-left font-medium">缓存 / 总输入</th>
                        <th className="px-3 py-2 text-right font-medium">命中率</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50 font-mono tabular-nums">
                      {telemetry.recentTurns.slice(0, 12).map((turn) => (
                        <tr key={turn.turnId}>
                          <td className="px-3 py-2">
                            <div className="font-sans text-foreground">#{turn.turnNumber} 对话</div>
                            {turn.completedAtMs !== null ? (
                              <div className="text-2xs text-muted-foreground">
                                {new Date(turn.completedAtMs).toLocaleTimeString()}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 font-sans text-muted-foreground">
                            {formatDurationZh(turn.gapSincePreviousMs)}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {turn.tokensPerSecond !== null
                              ? `${turn.tokensPerSecond.toFixed(1)} tok/s`
                              : "-"}
                          </td>
                          <td className="px-3 py-2 text-foreground">
                            {`${formatTokenCompact(turn.cachedTokens)} / ${formatTokenCompact(turn.totalInputTokens)}`}
                          </td>
                          <td className="px-3 py-2 text-right text-foreground">
                            {formatPercent2(turn.hitRatePercent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </DialogPanel>

        <DialogFooter variant="bare">
          <DialogClose render={<Button size="sm" variant="outline" />}>关闭</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
