import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { resolveLunaAuthUrl } from "../cloud/publicConfig";
import { I18nProvider } from "../i18n/I18nProvider";
import { MobileClientsUserProfilePage } from "../components/clerk/MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "../components/clerk/T3ConnectUserProfilePage";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { LunaServerUrlConfigCard } from "./LunaServerUrlConfigCard";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  attachLunaAuthService,
  changeLunaPassword,
  closeLunaAccountDialog,
  closeLunaAuthDialog,
  fetchLunaAccountInfo,
  openLunaAccountDialog,
  registerLunaAccount,
  revokeOtherLunaSessions,
  signInLunaAccount,
  signOutLunaAccount,
  updateLunaProfile,
  useLunaAuthState,
  type LunaAccountInfo,
  type LunaAuthUser,
} from "./cloudAuth";

function LunaAccountProfilePanel({ fallbackUser }: { readonly fallbackUser: LunaAuthUser | null }) {
  const [info, setInfo] = useState<LunaAccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState(fallbackUser?.displayName ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"profile" | "password" | "sessions" | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads live server quota, permissions, and session counts when opening the account tab
  useEffect(() => {
    let cancelled = false;
    void fetchLunaAccountInfo().then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setInfo(res.info);
        setDisplayName(res.info.user.displayName);
        setErrorText(null);
      } else {
        setErrorText(res.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentUser = info?.user ?? fallbackUser;
  const authUrl = resolveLunaAuthUrl();
  const maxTunnels = currentUser?.maxTunnels ?? 3;
  const activeTunnels = info?.activeTunnels ?? 0;
  const permissions = currentUser?.permissions ?? {
    managedTunnels: true,
    webhooks: true,
    mobilePush: true,
  };

  const handleProfileSave = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setErrorText(null);
    setBusyAction("profile");
    const res = await updateLunaProfile(displayName.trim());
    setBusyAction(null);
    if (!res.ok) {
      setErrorText(res.message);
      return;
    }
    setInfo((prev) => (prev ? { ...prev, user: res.user } : prev));
    setDisplayName(res.user.displayName);
    setNotice("昵称已更新。");
  };

  const handlePasswordSave = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setErrorText(null);
    setBusyAction("password");
    const res = await changeLunaPassword({ currentPassword, newPassword });
    setBusyAction(null);
    if (!res.ok) {
      setErrorText(res.message);
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setNotice("密码已更新。");
  };

  const handleRevokeOthers = async () => {
    setNotice(null);
    setErrorText(null);
    setBusyAction("sessions");
    const res = await revokeOtherLunaSessions();
    if (!res.ok) {
      setBusyAction(null);
      setErrorText(res.message);
      return;
    }
    const refreshed = await fetchLunaAccountInfo();
    setBusyAction(null);
    if (refreshed.ok) {
      setInfo(refreshed.info);
    }
    setNotice("已注销除当前设备外的其他会话。");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-foreground">身份与隧道配额</div>
          <span className="rounded-md border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
            {currentUser?.role === "admin" ? "超级管理员" : "普通用户"}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {loading
            ? "正在同步配额与会话状态..."
            : `已用隧道 ${activeTunnels} / 上限 ${maxTunnels} 条 · 已登记移动设备 ${info?.deviceCount ?? 0} 台 · 活跃会话 ${info?.activeSessionCount ?? 1} 个`}
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className="rounded-md border border-border bg-background px-2 py-0.5 text-foreground">
            远程隧道：{permissions.managedTunnels ? "已授权" : "已禁用"}
          </span>
          <span className="rounded-md border border-border bg-background px-2 py-0.5 text-foreground">
            Webhook 唤醒：{permissions.webhooks ? "已授权" : "已禁用"}
          </span>
          <span className="rounded-md border border-border bg-background px-2 py-0.5 text-foreground">
            移动推送：{permissions.mobilePush ? "已授权" : "已禁用"}
          </span>
        </div>
        {currentUser?.role === "admin" && authUrl ? (
          <div className="pt-1">
            <a
              className="text-xs font-medium text-primary underline underline-offset-2"
              href={`${authUrl}/admin`}
              rel="noreferrer"
              target="_blank"
            >
              打开超管控制台 (/admin)
            </a>
          </div>
        ) : null}
      </div>

      <form className="space-y-2" onSubmit={handleProfileSave}>
        <Label htmlFor="luna-profile-name">显示昵称</Label>
        <div className="flex gap-2">
          <Input
            id="luna-profile-name"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="输入新昵称"
          />
          <Button disabled={busyAction !== null || !displayName.trim()} size="sm" type="submit">
            {busyAction === "profile" ? "保存中..." : "保存昵称"}
          </Button>
        </div>
      </form>

      <form className="space-y-2 border-t border-border pt-3" onSubmit={handlePasswordSave}>
        <div className="text-xs font-medium text-foreground">修改登录密码</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            placeholder="当前密码"
          />
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="新密码（至少 8 位）"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button
            disabled={busyAction !== null || !currentPassword || newPassword.length < 8}
            size="sm"
            type="submit"
          >
            {busyAction === "password" ? "提交中..." : "更新密码"}
          </Button>
          <Button
            disabled={busyAction !== null}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void handleRevokeOthers()}
          >
            {busyAction === "sessions" ? "处理中..." : "注销其他设备会话"}
          </Button>
        </div>
      </form>

      <div className="rounded-lg border border-border bg-muted/30">
        <LunaServerUrlConfigCard />
      </div>

      {errorText ? <div className="text-xs text-destructive">{errorText}</div> : null}
      {notice ? <div className="text-xs text-success">{notice}</div> : null}
    </div>
  );
}

export default function LunaManagedAuthShell({
  children,
}: {
  readonly publishableKey?: string;
  readonly children: ReactNode;
}) {
  const state = useLunaAuthState();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the self-hosted auth token session to the relay client runtime for the app lifetime
  useEffect(() => attachLunaAuthService(), []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setErrorText(null);
    setSubmitting(true);
    const result =
      mode === "login"
        ? await signInLunaAccount({ email, password })
        : await registerLunaAccount({ email, password, displayName });
    setSubmitting(false);
    if (!result.ok) {
      setErrorText(result.message);
    } else {
      setPassword("");
    }
  };

  return (
    <>
      {children}

      <I18nProvider>
        <AppAtomRegistryProvider>
          <Dialog
            open={state.authDialogOpen}
            onOpenChange={(open) => {
              if (!open) {
                setErrorText(null);
                closeLunaAuthDialog();
              }
            }}
          >
            <DialogPopup className="max-w-sm">
              <DialogHeader>
                <DialogTitle>
                  {mode === "login" ? "登录 LunaCode 账号" : "注册 LunaCode 账号"}
                </DialogTitle>
                <DialogDescription>
                  登录后可开启公网远程访问；回到同一局域网时将自动切回局域网直连。
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <LunaServerUrlConfigCard compact onServerChanged={() => setErrorText(null)} />
                {!state.serverUrl ? (
                  <p className="mb-3 text-xs text-muted-foreground">
                    请先在上方保存你自建的 lunacode-connect 服务端 HTTPS 地址，再登录或注册。
                  </p>
                ) : null}
                <div className="mb-4 flex gap-2">
                  <Button
                    size="sm"
                    variant={mode === "login" ? "default" : "outline"}
                    className="flex-1"
                    type="button"
                    onClick={() => {
                      setErrorText(null);
                      setMode("login");
                    }}
                  >
                    登录
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === "register" ? "default" : "outline"}
                    className="flex-1"
                    type="button"
                    onClick={() => {
                      setErrorText(null);
                      setMode("register");
                    }}
                  >
                    注册
                  </Button>
                </div>
                <form className="space-y-3" onSubmit={handleSubmit}>
                  {mode === "register" ? (
                    <div className="space-y-1">
                      <Label htmlFor="luna-auth-name">昵称</Label>
                      <Input
                        id="luna-auth-name"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        placeholder="可选"
                      />
                    </div>
                  ) : null}
                  <div className="space-y-1">
                    <Label htmlFor="luna-auth-email">邮箱</Label>
                    <Input
                      id="luna-auth-email"
                      type="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="luna-auth-password">密码</Label>
                    <Input
                      id="luna-auth-password"
                      type="password"
                      required
                      minLength={8}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="至少 8 位密码"
                    />
                  </div>
                  {errorText ? <p className="text-xs text-destructive">{errorText}</p> : null}
                  <Button className="w-full" type="submit" disabled={submitting}>
                    {submitting ? "提交中..." : mode === "login" ? "登录" : "创建账号并登录"}
                  </Button>
                </form>
              </DialogPanel>
            </DialogPopup>
          </Dialog>

          <Dialog
            open={state.accountDialogOpen}
            onOpenChange={(open) => {
              if (!open) closeLunaAccountDialog();
            }}
          >
            <DialogPopup className="max-w-xl">
              <DialogHeader>
                <DialogTitle>LunaCode 账号与远程设备</DialogTitle>
                <DialogDescription>
                  {state.user ? `当前账号: ${state.user.displayName} (${state.user.email})` : ""}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={state.accountDialogPage === "t3-connect" ? "default" : "outline"}
                        type="button"
                        onClick={() => openLunaAccountDialog("t3-connect")}
                      >
                        已绑定设备
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          state.accountDialogPage === "mobile-clients" ? "default" : "outline"
                        }
                        type="button"
                        onClick={() => openLunaAccountDialog("mobile-clients")}
                      >
                        移动端设备
                      </Button>
                      <Button
                        size="sm"
                        variant={state.accountDialogPage === "t3-chat" ? "default" : "outline"}
                        type="button"
                        onClick={() => openLunaAccountDialog("t3-chat")}
                      >
                        账号与配额
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      type="button"
                      onClick={() => void signOutLunaAccount()}
                    >
                      退出登录
                    </Button>
                  </div>
                  {state.accountDialogPage === "mobile-clients" ? (
                    <MobileClientsUserProfilePage />
                  ) : state.accountDialogPage === "t3-chat" ? (
                    <LunaAccountProfilePanel fallbackUser={state.user} />
                  ) : (
                    <T3ConnectUserProfilePage />
                  )}
                </div>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        </AppAtomRegistryProvider>
      </I18nProvider>
    </>
  );
}
