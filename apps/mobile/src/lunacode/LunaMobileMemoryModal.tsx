import type { DeterministicHandoffResult } from "@t3tools/client-runtime/lunacode/handoff-builder";
import {
  checkOpenVikingHealth,
  formatMemoryTailInjection,
  type OpenVikingMemoryHit,
  saveOpenVikingMemory,
  searchOpenVikingMemories,
} from "@t3tools/client-runtime/lunacode/open-viking";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { useLunaMobilePreferences } from "./useLunaMobilePreferences";

export function LunaMobileMemoryModal(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly getCurrentPrompt?: (() => string) | undefined;
  readonly onAppendToPrompt?: ((tailMarkdown: string) => void) | undefined;
  readonly defaultTitle?: string | null | undefined;
  readonly latestAssistantText?: string | null | undefined;
  readonly onBuildHandoff?: (() => DeterministicHandoffResult) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const [preferences, updatePreferences] = useLunaMobilePreferences();
  const [tab, setTab] = useState<"recall" | "save">("recall");
  const [configExpanded, setConfigExpanded] = useState(false);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hits, setHits] = useState<ReadonlyArray<OpenVikingMemoryHit>>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [hasSearched, setHasSearched] = useState(false);

  const [saveTitleDraft, setSaveTitleDraft] = useState<string | null>(null);
  const [saveContent, setSaveContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);

  const [healthStatus, setHealthStatus] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);

  const effectiveSaveTitle =
    saveTitleDraft ??
    (props.defaultTitle?.trim() ? props.defaultTitle.trim() : "LunaCode 会话结论");

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
    if (!previewInjection || !props.onAppendToPrompt) return;
    props.onAppendToPrompt(previewInjection);
    props.onClose();
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
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-screen"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
      >
        <View className="flex-row items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-lg font-t3-bold text-foreground">OpenViking 云端记忆</Text>
            <Text className="text-xs text-foreground-muted">
              仅显式触发请求，结果附加到消息尾部保护 Prefix Cache
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭记忆面板"
            hitSlop={10}
            onPress={props.onClose}
            className="size-8 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <SymbolView
              name="xmark"
              size={14}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
          </Pressable>
        </View>

        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) + 16 }}
        >
          <View className="flex-row items-center justify-between gap-2">
            <View className="flex-row rounded-full border border-border-subtle bg-grouped-card p-0.5">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: tab === "recall" }}
                onPress={() => setTab("recall")}
                className={
                  tab === "recall"
                    ? "rounded-full bg-primary px-3.5 py-1.5"
                    : "rounded-full px-3.5 py-1.5"
                }
              >
                <Text
                  className={
                    tab === "recall"
                      ? "text-xs font-t3-medium text-primary-foreground"
                      : "text-xs text-foreground-muted"
                  }
                >
                  按需召回
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: tab === "save" }}
                onPress={() => setTab("save")}
                className={
                  tab === "save"
                    ? "rounded-full bg-primary px-3.5 py-1.5"
                    : "rounded-full px-3.5 py-1.5"
                }
              >
                <Text
                  className={
                    tab === "save"
                      ? "text-xs font-t3-medium text-primary-foreground"
                      : "text-xs text-foreground-muted"
                  }
                >
                  沉淀结论
                </Text>
              </Pressable>
            </View>

            <Text className="shrink font-mono text-2xs text-foreground-tertiary" numberOfLines={1}>
              {preferences.openViking.baseUrl}
            </Text>
          </View>

          {tab === "recall" ? (
            <View className="gap-3">
              <TextInput
                accessibilityLabel="OpenViking 检索关键词"
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={() => void handleSearch()}
                returnKeyType="search"
                placeholder="输入检索关键词，例如：多账号 隔离 / OpenViking 鉴权"
                placeholderTextColorClassName="accent-foreground-muted"
                className="rounded-xl border border-border-subtle bg-input px-3.5 py-2.5 text-sm text-foreground"
              />

              <View className="flex-row flex-wrap items-center gap-2">
                {props.getCurrentPrompt ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      const draft = props.getCurrentPrompt?.().trim() ?? "";
                      if (draft) setQuery(draft.slice(0, 160));
                    }}
                    className="rounded-full border border-border-subtle bg-grouped-card px-3 py-1.5 active:opacity-70"
                  >
                    <Text className="text-xs font-t3-medium text-foreground-muted">
                      填入当前草稿
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={searching}
                  onPress={() => void handleSearch()}
                  className="rounded-full bg-primary px-4 py-1.5 active:opacity-80 disabled:opacity-50"
                >
                  <Text className="text-xs font-t3-medium text-primary-foreground">
                    {searching ? "检索中..." : "检索记忆"}
                  </Text>
                </Pressable>
              </View>

              {searchError ? (
                <View className="rounded-xl border border-danger-border bg-danger px-3 py-2">
                  <Text className="text-xs text-danger-foreground">{searchError}</Text>
                </View>
              ) : null}

              {hits.length > 0 ? (
                <View className="gap-2.5">
                  {hits.map((hit) => {
                    const checked = selectedIds.has(hit.id);
                    return (
                      <Pressable
                        key={hit.id}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked }}
                        onPress={() => toggleHit(hit.id)}
                        className={
                          checked
                            ? "gap-1.5 rounded-2xl border border-primary bg-adaptive-blue-50-blue-400-a14 p-3"
                            : "gap-1.5 rounded-2xl border border-border-subtle bg-grouped-card p-3"
                        }
                      >
                        <View className="flex-row items-center justify-between gap-2">
                          <View className="min-w-0 flex-1 flex-row items-center gap-2">
                            <SymbolView
                              name={checked ? "checkmark.circle.fill" : "circle"}
                              size={16}
                              tintColorClassName={
                                checked ? "accent-primary-text" : "accent-icon-muted"
                              }
                              type="monochrome"
                            />
                            <Text
                              className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
                              numberOfLines={1}
                            >
                              {hit.title}
                            </Text>
                          </View>
                          <View className="rounded-md bg-update px-1.5 py-0.5">
                            <Text className="font-mono text-3xs tabular-nums text-update-foreground">
                              相关度 {hit.score.toFixed(2)}
                            </Text>
                          </View>
                        </View>
                        <Text
                          className="font-mono text-3xs text-foreground-tertiary"
                          numberOfLines={1}
                        >
                          {hit.uri}
                        </Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={3}>
                          {hit.snippet}
                        </Text>
                      </Pressable>
                    );
                  })}

                  <View className="gap-2 rounded-2xl border border-border-subtle bg-grouped-card p-3">
                    <Text className="font-mono text-2xs tabular-nums text-foreground-muted">
                      已选 {selectedHits.length} 条 · 注入 {previewInjection.length} /{" "}
                      {preferences.openViking.maxChars} 字符
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={!previewInjection || !props.onAppendToPrompt}
                      onPress={handleInject}
                      className="min-h-10 items-center justify-center rounded-full bg-primary px-4 active:opacity-80 disabled:opacity-45"
                    >
                      <Text className="text-xs font-t3-medium text-primary-foreground">
                        追加到消息尾部（保护前缀缓存）
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : hasSearched && !searching && !searchError ? (
                <Text className="text-xs text-foreground-muted">
                  未检索到满足阈值（score &gt;= {preferences.openViking.minScore}）的相关记忆。
                </Text>
              ) : (
                <Text className="text-xs text-foreground-muted">
                  仅在你点击「检索记忆」时发起一次 HTTP 查询，不自动注入任何上下文。
                </Text>
              )}
            </View>
          ) : (
            <View className="gap-3">
              <View className="gap-1.5">
                <Text className="text-xs font-t3-medium text-foreground-muted">记忆标题</Text>
                <TextInput
                  accessibilityLabel="记忆标题"
                  value={effectiveSaveTitle}
                  onChangeText={setSaveTitleDraft}
                  className="rounded-xl border border-border-subtle bg-input px-3.5 py-2 text-sm text-foreground"
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  沉淀正文（不消耗模型 Token，由你按需编辑写入）
                </Text>
                <View className="flex-row flex-wrap items-center gap-2">
                  {props.latestAssistantText?.trim() ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        setSaveContent(props.latestAssistantText?.trim().slice(0, 4000) ?? "")
                      }
                      className="rounded-full border border-border-subtle bg-grouped-card px-3 py-1 active:opacity-70"
                    >
                      <Text className="text-xs font-t3-medium text-foreground-muted">
                        填入最近回复
                      </Text>
                    </Pressable>
                  ) : null}
                  {props.onBuildHandoff ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        const result = props.onBuildHandoff?.();
                        if (result) setSaveContent(result.markdown);
                      }}
                      className="rounded-full border border-border-subtle bg-grouped-card px-3 py-1 active:opacity-70"
                    >
                      <Text className="text-xs font-t3-medium text-foreground-muted">
                        填入结构化摘要
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                <TextInput
                  accessibilityLabel="沉淀正文"
                  multiline
                  numberOfLines={7}
                  value={saveContent}
                  onChangeText={setSaveContent}
                  placeholder="填写需要跨会话沉淀的架构结论、命令或排查结果..."
                  placeholderTextColorClassName="accent-foreground-muted"
                  textAlignVertical="top"
                  className="min-h-[140px] rounded-xl border border-border-subtle bg-input p-3 font-mono text-xs text-foreground"
                />
              </View>

              {saveMessage ? (
                <View
                  className={
                    saveMessage.ok
                      ? "rounded-xl border border-border-subtle bg-adaptive-emerald-500-a12-a16 px-3 py-2"
                      : "rounded-xl border border-danger-border bg-danger px-3 py-2"
                  }
                >
                  <Text
                    selectable
                    className={
                      saveMessage.ok
                        ? "text-xs text-adaptive-emerald-700-300"
                        : "text-xs text-danger-foreground"
                    }
                  >
                    {saveMessage.text}
                  </Text>
                </View>
              ) : null}

              <Pressable
                accessibilityRole="button"
                disabled={saving || !saveContent.trim()}
                onPress={() => void handleSave()}
                className="min-h-11 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-45"
              >
                <Text className="text-sm font-t3-medium text-primary-foreground">
                  {saving ? "写入中..." : "写入 OpenViking"}
                </Text>
              </Pressable>
            </View>
          )}

          <View className="border-t border-border-subtle pt-3">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: configExpanded }}
              onPress={() => setConfigExpanded((curr) => !curr)}
              className="flex-row items-center justify-between py-1 active:opacity-70"
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                连接与注入上限配置（可在 Settings → Labs 修改）
              </Text>
              <SymbolView
                name={configExpanded ? "chevron.up" : "chevron.down"}
                size={12}
                tintColorClassName="accent-icon-subtle"
                type="monochrome"
              />
            </Pressable>

            {configExpanded ? (
              <View className="mt-3 gap-3 rounded-2xl border border-border-subtle bg-grouped-card p-3.5">
                <View className="gap-1">
                  <Text className="text-2xs text-foreground-muted">服务地址</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={preferences.openViking.baseUrl}
                    onChangeText={(value) =>
                      updatePreferences((curr) => ({
                        ...curr,
                        openViking: { ...curr.openViking, baseUrl: value },
                      }))
                    }
                    className="rounded-xl border border-border-subtle bg-input px-3 py-2 font-mono text-xs text-foreground"
                  />
                </View>
                <View className="gap-1">
                  <Text className="text-2xs text-foreground-muted">X-API-Key（可选）</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    placeholder="若开启 auth_mode 鉴权请填写"
                    placeholderTextColorClassName="accent-foreground-muted"
                    value={preferences.openViking.apiKey}
                    onChangeText={(value) =>
                      updatePreferences((curr) => ({
                        ...curr,
                        openViking: { ...curr.openViking, apiKey: value },
                      }))
                    }
                    className="rounded-xl border border-border-subtle bg-input px-3 py-2 font-mono text-xs text-foreground"
                  />
                </View>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void handleTestConnection()}
                    className="rounded-full border border-border bg-card px-3.5 py-1.5 active:opacity-70"
                  >
                    <Text className="text-xs font-t3-medium text-foreground">测试连接</Text>
                  </Pressable>
                  {healthStatus ? (
                    <Text
                      className={
                        healthStatus.ok
                          ? "flex-1 text-xs text-adaptive-emerald-700-300"
                          : "flex-1 text-xs text-danger-foreground"
                      }
                    >
                      {healthStatus.text}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
