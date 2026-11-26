import { useState, type FormEvent } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { updateLunaServerUrl, useLunaAuthState } from "./cloudAuth";

export function LunaServerUrlConfigCard({
  compact = false,
  onServerChanged,
}: {
  readonly compact?: boolean;
  readonly onServerChanged?: () => void;
}) {
  const state = useLunaAuthState();
  const [draftUrl, setDraftUrl] = useState(state.serverUrl ?? state.defaultServerUrl ?? "");
  const [prevSyncedUrl, setPrevSyncedUrl] = useState(state.serverUrl);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);

  if (state.serverUrl !== prevSyncedUrl) {
    setPrevSyncedUrl(state.serverUrl);
    setDraftUrl(state.serverUrl ?? state.defaultServerUrl ?? "");
  }

  const handleApply = async (rawInput: string | null) => {
    if (busy) return;
    setErrorText(null);
    setNoticeText(null);
    setBusy(true);
    const res = await updateLunaServerUrl(rawInput);
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.message);
      return;
    }
    setDraftUrl(res.url ?? "");
    setNoticeText(
      res.signedOut
        ? `已切换到 ${res.url ?? "未配置"}，并已退出原服务器登录状态，请重新登录。`
        : `已应用后台地址：${res.url ?? "未配置"}`,
    );
    onServerChanged?.();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void handleApply(draftUrl);
  };

  return (
    <div
      className={
        compact
          ? "mb-4 rounded-lg border border-border/80 bg-muted/25 p-3 space-y-2 text-xs"
          : "space-y-3 p-4 text-xs"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div
            className={
              compact ? "font-medium text-foreground" : "text-sm font-medium text-foreground"
            }
          >
            后台登录与中继服务地址
          </div>
          {!compact ? (
            <p className="mt-0.5 text-muted-foreground">
              用于账号登录、环境注册与公网隧道连接（修改后立即持久化并自动同步桌面端跨域白名单）。
            </p>
          ) : null}
        </div>
        <span className="rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-muted-foreground">
          {state.hasCustomServerUrl ? "自定义地址" : state.defaultServerUrl ? "内置默认" : "待配置"}
        </span>
      </div>

      <div className="rounded-md border border-border/70 bg-background/80 px-2.5 py-1.5 font-mono text-2xs text-foreground break-all">
        当前：{state.serverUrl ?? "未配置"}
      </div>

      <form className="space-y-2" onSubmit={handleSubmit}>
        {!compact ? <Label htmlFor="luna-server-url-input">切换后台地址（HTTPS）</Label> : null}
        <div className="flex flex-wrap gap-2">
          <Input
            id={compact ? "luna-server-url-compact-input" : "luna-server-url-input"}
            className="min-w-0 flex-1"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            placeholder={state.defaultServerUrl ?? "https://connect.example.com:8443"}
            aria-label="后台服务地址"
          />
          <Button size="sm" variant="outline" type="submit" disabled={busy || !draftUrl.trim()}>
            {busy ? "应用中..." : "保存并切换"}
          </Button>
          {state.hasCustomServerUrl ? (
            <Button
              size="sm"
              variant="ghost-muted"
              type="button"
              disabled={busy}
              onClick={() => void handleApply(null)}
            >
              恢复默认
            </Button>
          ) : null}
        </div>
      </form>

      {state.defaultServerUrl && state.hasCustomServerUrl ? (
        <p className="text-2xs text-muted-foreground">
          内置默认地址：<span className="font-mono">{state.defaultServerUrl}</span>
        </p>
      ) : null}
      {errorText ? <p className="text-xs text-destructive">{errorText}</p> : null}
      {noticeText ? <p className="text-xs text-success">{noticeText}</p> : null}
    </div>
  );
}
