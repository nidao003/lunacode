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
import type { DeterministicHandoffResult } from "./handoffBuilder";
import {
  checkOpenVikingHealth,
  formatMemoryTailInjection,
  type OpenVikingMemoryHit,
  saveOpenVikingMemory,
  searchOpenVikingMemories,
} from "./openVikingClient";
import { useLunaPreferences } from "./preferences";

interface LunaMemoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly getCurrentPrompt?: (() => string) | undefined;
  readonly onAppendToPrompt?: ((tailMarkdown: string) => void) | undefined;
  readonly defaultTitle?: string | null | undefined;
  readonly latestAssistantText?: string | null | undefined;
  readonly onBuildHandoff?: (() => DeterministicHandoffResult) | undefined;
}

export function LunaMemoryDialog({
  open,
  onOpenChange,
  getCurrentPrompt,
  onAppendToPrompt,
  defaultTitle,
  latestAssistantText,
  onBuildHandoff,
}: LunaMemoryDialogProps) {
  const [preferences, updatePreferences] = useLunaPreferences();
  const [tab, setTab] = useState<"recall" | "save">("recall");

  // Recall state
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hits, setHits] = useState<ReadonlyArray<OpenVikingMemoryHit>>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [hasSearched, setHasSearched] = useState(false);

  // Save state
  const [saveTitleDraft, setSaveTitleDraft] = useState<string | null>(null);
  const [saveContent, setSaveContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);

  // Inline health check state
  const [healthStatus, setHealthStatus] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);

  const effectiveSaveTitle =
    saveTitleDraft ?? (defaultTitle?.trim() ? defaultTitle.trim() : "LunaCode 会话结论");

  const selectedHits = hits.filter((hit) => selectedIds.has(hit.id));
  const previewInjection = formatMemoryTailInjection(selectedHits, preferences.openViking.maxChars);

  const handleTestConnection = async () => {
    setHealthStatus({ ok: true, text: "正在检测 OpenViking..." });
    const res = await checkOpenVikingHealth(preferences.openViking);
    setHealthStatus({ ok: res.ok, text: res.detail });
  };

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchError("请输入检索关键词后再发起搜索（不自动触发额外请求）。");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setHasSearched(true);
    try {
      const results = await searchOpenVikingMemories(preferences.openViking, trimmed, 6);
      setHits(results);
      setSelectedIds(new Set(results.slice(0, 2).map((item) => item.id)));
      setSearching(false);
    } catch (error) {
      setHits([]);
      setSelectedIds(new Set());
      setSearchError(error instanceof Error ? error.message : "检索 OpenViking 失败");
      setSearching(false);
    }
  };

  const toggleHit = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleInject = () => {
    if (!previewInjection || !onAppendToPrompt) return;
    onAppendToPrompt(previewInjection);
    onOpenChange(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await saveOpenVikingMemory(preferences.openViking, {
        title: effectiveSaveTitle,
        content: saveContent,
      });
      setSaveMessage({ ok: true, text: `已写入 OpenViking：${result.uri}` });
      setSaving(false);
    } catch (error) {
      setSaveMessage({
        ok: false,
        text: error instanceof Error ? error.message : "写入 OpenViking 失败",
      });
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>OpenViking 云端记忆（按需检索与沉淀）</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">
              仅显式触发请求，检索结果仅附加到用户消息尾部以保护 Prefix Cache 命中率
            </span>
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-4 text-sm">
            {/* Tab 切换与服务地址 */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant={tab === "recall" ? "default" : "outline"}
                  onClick={() => setTab("recall")}
                >
                  按需召回
                </Button>
                <Button
                  size="xs"
                  variant={tab === "save" ? "default" : "outline"}
                  onClick={() => setTab("save")}
                >
                  沉淀结论
                </Button>
              </div>
              <span className="font-mono text-2xs text-muted-foreground">
                {preferences.openViking.baseUrl}
              </span>
            </div>

            {tab === "recall" ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    placeholder="输入检索关键词，例如：多账号 隔离 / OpenViking 鉴权"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleSearch();
                      }
                    }}
                    className="h-8 min-w-48 flex-1 rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-ring"
                  />
                  {getCurrentPrompt ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => {
                        const draft = getCurrentPrompt().trim();
                        if (draft) setQuery(draft.slice(0, 160));
                      }}
                    >
                      填入当前草稿
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={searching}
                    onClick={() => void handleSearch()}
                  >
                    {searching ? "检索中..." : "检索记忆"}
                  </Button>
                </div>

                {searchError ? (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                    {searchError}
                  </p>
                ) : null}

                {hits.length > 0 ? (
                  <div className="space-y-2">
                    <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                      {hits.map((hit) => {
                        const checked = selectedIds.has(hit.id);
                        return (
                          <label
                            key={hit.id}
                            className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 bg-muted/20 p-2.5 text-xs hover:bg-muted/35"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleHit(hit.id)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-medium text-foreground">
                                  {hit.title}
                                </span>
                                <span className="shrink-0 rounded bg-info/15 px-1.5 py-px font-mono text-3xs text-info tabular-nums">
                                  相关度 {hit.score.toFixed(2)}
                                </span>
                              </div>
                              <div className="truncate font-mono text-3xs text-muted-foreground">
                                {hit.uri}
                              </div>
                              <p className="line-clamp-3 text-muted-foreground">{hit.snippet}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                        已选 {selectedHits.length} 条 · 注入 {previewInjection.length} /{" "}
                        {preferences.openViking.maxChars} 字符
                      </span>
                      <Button
                        size="xs"
                        variant="default"
                        disabled={!previewInjection || !onAppendToPrompt}
                        onClick={handleInject}
                      >
                        追加到消息尾部（保护前缀缓存）
                      </Button>
                    </div>
                  </div>
                ) : hasSearched && !searching && !searchError ? (
                  <p className="text-xs text-muted-foreground">
                    未检索到满足阈值（score &gt;= {preferences.openViking.minScore}）的相关记忆。
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    仅在你点击“检索记忆”时发起一次 HTTP 查询，不自动注入任何上下文。
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="luna-ov-save-title"
                    className="text-xs font-medium text-foreground"
                  >
                    记忆标题
                  </label>
                  <input
                    id="luna-ov-save-title"
                    type="text"
                    value={effectiveSaveTitle}
                    onChange={(event) => setSaveTitleDraft(event.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-ring"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor="luna-ov-save-body"
                      className="text-xs font-medium text-foreground"
                    >
                      沉淀正文（不消耗模型 Token，由你按需编辑写入）
                    </label>
                    <div className="flex items-center gap-1.5">
                      {latestAssistantText?.trim() ? (
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          onClick={() => setSaveContent(latestAssistantText.trim().slice(0, 4000))}
                        >
                          填入最近回复
                        </Button>
                      ) : null}
                      {onBuildHandoff ? (
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          onClick={() => setSaveContent(onBuildHandoff().markdown)}
                        >
                          填入结构化摘要
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <textarea
                    id="luna-ov-save-body"
                    rows={7}
                    placeholder="填写需要跨会话沉淀的架构结论、命令或排查结果..."
                    value={saveContent}
                    onChange={(event) => setSaveContent(event.target.value)}
                    className="w-full rounded-md border border-border bg-background p-2.5 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                </div>

                {saveMessage ? (
                  <p
                    className={
                      saveMessage.ok
                        ? "rounded-md border border-success/35 bg-success/10 px-2.5 py-1.5 text-xs text-success"
                        : "rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
                    }
                  >
                    {saveMessage.text}
                  </p>
                ) : null}

                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="default"
                    disabled={saving || !saveContent.trim()}
                    onClick={() => void handleSave()}
                  >
                    {saving ? "写入中..." : "写入 OpenViking"}
                  </Button>
                </div>
              </div>
            )}

            {/* 折叠连接配置 */}
            <details className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">
                连接与注入上限配置（本地保存，也可在 Settings -&gt; Labs 修改）
              </summary>
              <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span>服务地址</span>
                  <input
                    type="text"
                    value={preferences.openViking.baseUrl}
                    onChange={(event) =>
                      updatePreferences((curr) => ({
                        ...curr,
                        openViking: {
                          ...curr.openViking,
                          baseUrl: event.target.value,
                        },
                      }))
                    }
                    className="h-7 w-full rounded border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                </label>
                <label className="space-y-1">
                  <span>X-API-Key（可选）</span>
                  <input
                    type="password"
                    placeholder="若开启 auth_mode 鉴权请填写"
                    value={preferences.openViking.apiKey}
                    onChange={(event) =>
                      updatePreferences((curr) => ({
                        ...curr,
                        openViking: {
                          ...curr.openViking,
                          apiKey: event.target.value,
                        },
                      }))
                    }
                    className="h-7 w-full rounded border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="xs" variant="outline" onClick={() => void handleTestConnection()}>
                  测试连接
                </Button>
                {healthStatus ? (
                  <span className={healthStatus.ok ? "text-success" : "text-destructive"}>
                    {healthStatus.text}
                  </span>
                ) : null}
              </div>
            </details>
          </div>
        </DialogPanel>

        <DialogFooter variant="bare">
          <DialogClose render={<Button size="sm" variant="outline" />}>关闭</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
