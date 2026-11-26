import { useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppBar } from "../components/ui/AppBar";
import { AppText as Text, AppTextInput } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../components/ui/ScreenScrollView";
import { T3ConnectProfilePage } from "../features/cloud/T3ConnectProfilePage";
import { type LunaMobileUser, useLunaMobileAuthState } from "./cloudAuth";
import {
  changeLunaMobilePassword,
  fetchLunaMobileAccountInfo,
  type LunaMobileAccountInfo,
  registerLunaMobileAccount,
  revokeOtherLunaMobileSessions,
  signInLunaMobileAccount,
  signOutLunaMobileAccount,
  updateLunaMobileProfile,
  updateLunaMobileServerUrl,
} from "./cloudAuthActions";

function LunaMobileServerUrlCard({ onServerChanged }: { readonly onServerChanged?: () => void }) {
  const state = useLunaMobileAuthState();
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
    const res = await updateLunaMobileServerUrl(rawInput);
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.message);
      return;
    }
    setDraftUrl(res.url ?? "");
    setNoticeText(
      res.signedOut
        ? `已切换到 ${res.url ?? "未配置"}，并已退出原服务器登录状态。`
        : `已应用后台地址：${res.url ?? "未配置"}`,
    );
    onServerChanged?.();
  };

  return (
    <View className="gap-2 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-sm font-t3-medium text-foreground">后台登录与中继地址</Text>
        <Text className="text-xs text-foreground-muted">
          {state.hasCustomServerUrl ? "自定义地址" : state.defaultServerUrl ? "内置默认" : "待配置"}
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted">{`当前：${state.serverUrl ?? "未配置"}`}</Text>
      <AppTextInput
        value={draftUrl}
        onChangeText={setDraftUrl}
        placeholder={state.defaultServerUrl ?? "https://connect.example.com:8443"}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={busy ? "应用中..." : "保存并切换"}
          tone="secondary"
          size="compact"
          disabled={busy || !draftUrl.trim()}
          onPress={() => void handleApply(draftUrl)}
        />
        {state.hasCustomServerUrl ? (
          <Button
            label="恢复默认"
            tone="secondary"
            size="compact"
            disabled={busy}
            onPress={() => void handleApply(null)}
          />
        ) : null}
      </View>
      {errorText ? <Text className="text-xs text-danger">{errorText}</Text> : null}
      {noticeText ? <Text className="text-xs text-foreground-muted">{noticeText}</Text> : null}
    </View>
  );
}

function LunaMobileSignedInPanel({ user }: { readonly user: LunaMobileUser }) {
  const [info, setInfo] = useState<LunaMobileAccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"profile" | "password" | "sessions" | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads live server quota, permissions, and active sessions when opening signed-in account view
  useEffect(() => {
    let cancelled = false;
    void fetchLunaMobileAccountInfo().then((res) => {
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

  const currentUser = info?.user ?? user;
  const maxTunnels = currentUser.maxTunnels ?? 3;
  const activeTunnels = info?.activeTunnels ?? 0;
  const permissions = currentUser.permissions ?? {
    managedTunnels: true,
    webhooks: true,
    mobilePush: true,
  };

  const handleSaveProfile = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) return;
    setNotice(null);
    setErrorText(null);
    setBusyAction("profile");
    const res = await updateLunaMobileProfile(trimmed);
    setBusyAction(null);
    if (!res.ok) {
      setErrorText(res.message);
      return;
    }
    setInfo((prev) => (prev ? { ...prev, user: res.user } : prev));
    setDisplayName(res.user.displayName);
    setNotice("昵称已更新。");
  };

  const handleChangePassword = async () => {
    if (!currentPassword || newPassword.length < 8) return;
    setNotice(null);
    setErrorText(null);
    setBusyAction("password");
    const res = await changeLunaMobilePassword({ currentPassword, newPassword });
    setBusyAction(null);
    if (!res.ok) {
      setErrorText(res.message);
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setNotice("登录密码已修改。");
  };

  const handleRevokeOthers = async () => {
    setNotice(null);
    setErrorText(null);
    setBusyAction("sessions");
    const res = await revokeOtherLunaMobileSessions();
    if (!res.ok) {
      setBusyAction(null);
      setErrorText(res.message);
      return;
    }
    const refreshed = await fetchLunaMobileAccountInfo();
    setBusyAction(null);
    if (refreshed.ok) {
      setInfo(refreshed.info);
    }
    setNotice("已注销除当前设备外的其他会话。");
  };

  return (
    <View className="gap-4">
      <View className="gap-2 rounded-2xl border border-border bg-card p-4">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-base font-t3-medium text-foreground">
            {currentUser.displayName}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {currentUser.role === "admin" ? "超级管理员" : "普通用户"}
          </Text>
        </View>
        <Text className="text-sm text-foreground-muted">{currentUser.email}</Text>
        <Text className="text-xs text-foreground-muted">
          {loading
            ? "正在同步配额与会话状态..."
            : `已用 ${activeTunnels} / 上限 ${maxTunnels} 条隧道 · 移动设备 ${info?.deviceCount ?? 0} 台 · 活跃会话 ${info?.activeSessionCount ?? 1} 个`}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {`权限：隧道(${permissions.managedTunnels ? "开" : "关"}) · Webhook(${permissions.webhooks ? "开" : "关"}) · 推送(${permissions.mobilePush ? "开" : "关"})`}
        </Text>
        <Text className="text-xs text-foreground-muted">
          外网时走公网 HTTPS 中继，回到同一局域网时将自动切回直连。
        </Text>
        <View className="mt-2">
          <Button
            label="退出登录"
            tone="danger"
            size="compact"
            onPress={() => void signOutLunaMobileAccount()}
          />
        </View>
      </View>

      <View className="gap-3 rounded-2xl border border-border bg-card p-4">
        <Text className="text-sm font-t3-medium text-foreground">账号安全与资料</Text>
        <View className="gap-1">
          <Text className="text-xs text-foreground-muted">修改昵称</Text>
          <AppTextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="输入新昵称"
            autoCapitalize="none"
          />
        </View>
        <Button
          label="保存昵称"
          tone="secondary"
          size="compact"
          loading={busyAction === "profile"}
          disabled={busyAction !== null || !displayName.trim()}
          onPress={() => void handleSaveProfile()}
        />

        <View className="gap-1 pt-2">
          <Text className="text-xs text-foreground-muted">修改密码</Text>
          <AppTextInput
            value={currentPassword}
            onChangeText={setCurrentPassword}
            placeholder="当前密码"
            secureTextEntry
            autoCapitalize="none"
          />
          <AppTextInput
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder="新密码（至少 8 位）"
            secureTextEntry
            autoCapitalize="none"
          />
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="更新密码"
            tone="primary"
            size="compact"
            loading={busyAction === "password"}
            disabled={busyAction !== null || !currentPassword || newPassword.length < 8}
            onPress={() => void handleChangePassword()}
          />
          <Button
            label="注销其他设备会话"
            tone="secondary"
            size="compact"
            loading={busyAction === "sessions"}
            disabled={busyAction !== null}
            onPress={() => void handleRevokeOthers()}
          />
        </View>

        {errorText ? <Text className="text-xs text-danger">{errorText}</Text> : null}
        {notice ? <Text className="text-xs text-foreground-muted">{notice}</Text> : null}
      </View>

      <LunaMobileServerUrlCard />

      <T3ConnectProfilePage />
    </View>
  );
}

export function LunaMobileAuthScreen() {
  const navigation = useNavigation();
  const state = useLunaMobileAuthState();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setErrorText(null);
    setSubmitting(true);
    const res =
      mode === "login"
        ? await signInLunaMobileAccount({ email: email.trim(), password })
        : await registerLunaMobileAccount({
            email: email.trim(),
            password,
            displayName: displayName.trim(),
          });
    setSubmitting(false);
    if (!res.ok) {
      setErrorText(res.message);
    } else {
      setPassword("");
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title={state.isSignedIn ? "LunaCode 账号" : "登录 LunaCode"}
        onClose={() => navigation.goBack()}
      />
      <ScrollView
        nestedScrollEnabled
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-4 py-4"
      >
        {state.isSignedIn && state.user ? (
          <LunaMobileSignedInPanel user={state.user} />
        ) : (
          <>
            <LunaMobileServerUrlCard onServerChanged={() => setErrorText(null)} />
            {!state.serverUrl ? (
              <Text className="px-1 text-xs text-foreground-muted">
                请先在上方保存自建 lunacode-connect 服务端 HTTPS 地址，再登录或注册。
              </Text>
            ) : null}
            <View className="gap-3 rounded-2xl border border-border bg-card p-4">
              <View className="flex-row gap-2">
                <Button
                  label="登录"
                  tone={mode === "login" ? "primary" : "secondary"}
                  size="compact"
                  onPress={() => {
                    setErrorText(null);
                    setMode("login");
                  }}
                />
                <Button
                  label="注册"
                  tone={mode === "register" ? "primary" : "secondary"}
                  size="compact"
                  onPress={() => {
                    setErrorText(null);
                    setMode("register");
                  }}
                />
              </View>

              {mode === "register" ? (
                <View className="gap-1">
                  <Text className="text-xs text-foreground-muted">昵称</Text>
                  <AppTextInput
                    value={displayName}
                    onChangeText={setDisplayName}
                    placeholder="可选"
                    autoCapitalize="none"
                  />
                </View>
              ) : null}

              <View className="gap-1">
                <Text className="text-xs text-foreground-muted">邮箱</Text>
                <AppTextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View className="gap-1">
                <Text className="text-xs text-foreground-muted">密码</Text>
                <AppTextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="至少 8 位"
                  secureTextEntry
                  autoCapitalize="none"
                />
              </View>

              {errorText ? <Text className="text-xs text-danger">{errorText}</Text> : null}

              <Button
                label={mode === "login" ? "登录并启用远程访问" : "创建账号并登录"}
                tone="primary"
                fullWidth
                loading={submitting}
                onPress={() => void handleSubmit()}
              />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
