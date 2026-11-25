import {
  DEFAULT_COMPACT_TEMPLATE_TEXT,
  DEFAULT_LUNA_PREFERENCES,
} from "@t3tools/client-runtime/lunacode/preferences";
import { checkOpenVikingHealth } from "@t3tools/client-runtime/lunacode/open-viking";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { ThemedSwitch } from "../components/ui/ThemedSwitch";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { useLunaMobilePreferences } from "./useLunaMobilePreferences";

export function LunaMobileSettingsSection() {
  const [preferences, updatePreferences] = useLunaMobilePreferences();
  const [healthState, setHealthState] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);
  const [testingHealth, setTestingHealth] = useState(false);

  const handleTestViking = async () => {
    setTestingHealth(true);
    setHealthState({ ok: true, text: "正在测试连接..." });
    const res = await checkOpenVikingHealth(preferences.openViking);
    setHealthState({ ok: res.ok, text: res.detail });
    setTestingHealth(false);
  };

  return (
    <View className="gap-6">
      <SettingsSection
        title="LunaCode · OpenViking 云端记忆"
        footer="按需手动检索与沉淀，结果仅附加到用户消息尾部以保护 Prefix Cache，绝不在后台静默消耗 Token。"
      >
        <View className="gap-3.5 p-4">
          <View className="gap-1.5">
            <Text className="text-xs font-t3-medium text-foreground-muted">
              服务地址 (Base URL)
            </Text>
            <TextInput
              accessibilityLabel="OpenViking 服务地址"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={preferences.openViking.baseUrl}
              onChangeText={(value) =>
                updatePreferences((curr) => ({
                  ...curr,
                  openViking: {
                    ...curr.openViking,
                    baseUrl: value,
                  },
                }))
              }
              placeholder="http://192.168.3.160:1933"
              placeholderTextColorClassName="accent-foreground-muted"
              className="rounded-xl border border-border-subtle bg-input px-3 py-2 font-mono text-sm text-foreground"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-xs font-t3-medium text-foreground-muted">
              X-API-Key（开启鉴权时填写，可选）
            </Text>
            <TextInput
              accessibilityLabel="OpenViking API Key"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              value={preferences.openViking.apiKey}
              onChangeText={(value) =>
                updatePreferences((curr) => ({
                  ...curr,
                  openViking: {
                    ...curr.openViking,
                    apiKey: value,
                  },
                }))
              }
              placeholder="可选"
              placeholderTextColorClassName="accent-foreground-muted"
              className="rounded-xl border border-border-subtle bg-input px-3 py-2 font-mono text-sm text-foreground"
            />
          </View>

          <View className="flex-row gap-3">
            <View className="flex-1 gap-1.5">
              <Text className="text-xs font-t3-medium text-foreground-muted">
                尾部注入上限 (400-8000)
              </Text>
              <TextInput
                accessibilityLabel="尾部单次注入字符上限"
                keyboardType="number-pad"
                value={String(preferences.openViking.maxChars)}
                onChangeText={(value) => {
                  const parsed = Number.parseInt(value, 10);
                  if (Number.isFinite(parsed)) {
                    updatePreferences((curr) => ({
                      ...curr,
                      openViking: { ...curr.openViking, maxChars: parsed },
                    }));
                  }
                }}
                className="rounded-xl border border-border-subtle bg-input px-3 py-2 font-mono text-sm tabular-nums text-foreground"
              />
            </View>

            <View className="flex-1 gap-1.5">
              <Text className="text-xs font-t3-medium text-foreground-muted">最小相关度 (0-1)</Text>
              <TextInput
                accessibilityLabel="检索最小相关性分数"
                keyboardType="decimal-pad"
                value={String(preferences.openViking.minScore)}
                onChangeText={(value) => {
                  const parsed = Number.parseFloat(value);
                  if (Number.isFinite(parsed)) {
                    updatePreferences((curr) => ({
                      ...curr,
                      openViking: { ...curr.openViking, minScore: parsed },
                    }));
                  }
                }}
                className="rounded-xl border border-border-subtle bg-input px-3 py-2 font-mono text-sm tabular-nums text-foreground"
              />
            </View>
          </View>

          <View className="flex-row flex-wrap items-center gap-2 pt-1">
            <Pressable
              accessibilityRole="button"
              disabled={testingHealth}
              onPress={() => void handleTestViking()}
              className="min-h-10 items-center justify-center rounded-full border border-border bg-secondary px-4 active:opacity-70 disabled:opacity-50"
            >
              <Text className="text-xs font-t3-medium text-foreground">
                {testingHealth ? "测试中..." : "测试连接"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                updatePreferences((curr) => ({
                  ...curr,
                  openViking: DEFAULT_LUNA_PREFERENCES.openViking,
                }))
              }
              className="min-h-10 items-center justify-center rounded-full bg-subtle px-4 active:opacity-70"
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">恢复默认</Text>
            </Pressable>
          </View>

          {healthState ? (
            <View
              className={
                healthState.ok
                  ? "rounded-xl border border-border-subtle bg-adaptive-emerald-500-a12-a16 px-3 py-2"
                  : "rounded-xl border border-danger-border bg-danger px-3 py-2"
              }
            >
              <Text
                className={
                  healthState.ok
                    ? "text-xs text-adaptive-emerald-700-300"
                    : "text-xs text-danger-foreground"
                }
              >
                {healthState.text}
              </Text>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title="LunaCode · 结构化 /compact 保留模板"
        footer="仅用于支持自定义指令的 Claude Code 原生 /compact；Codex 会直接走官方原生压缩协议。"
      >
        <View className="gap-3.5 p-4">
          <View className="flex-row items-center justify-between gap-3">
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm font-t3-medium text-foreground">
                点击底栏「压缩」时附带保留模板（限 Claude）
              </Text>
              <Text className="text-xs text-foreground-muted">
                默认关闭，以保持 Claude 原生压缩完整度与推断质量
              </Text>
            </View>
            <ThemedSwitch
              accessibilityLabel="启用自定义 /compact 保留模板"
              value={preferences.compactTemplateEnabled}
              onValueChange={(enabled) =>
                updatePreferences((curr) => ({
                  ...curr,
                  compactTemplateEnabled: enabled,
                }))
              }
            />
          </View>

          <TextInput
            accessibilityLabel="自定义 /compact 保留重点模板"
            multiline
            numberOfLines={3}
            maxLength={300}
            value={preferences.compactTemplateText}
            onChangeText={(value) =>
              updatePreferences((curr) => ({
                ...curr,
                compactTemplateText: value.slice(0, 300),
              }))
            }
            placeholder={DEFAULT_COMPACT_TEMPLATE_TEXT}
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-[76px] rounded-xl border border-border-subtle bg-input px-3 py-2 text-xs text-foreground"
            textAlignVertical="top"
          />

          <View className="flex-row items-center justify-between gap-2">
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                updatePreferences((curr) => ({
                  ...curr,
                  compactTemplateText: DEFAULT_COMPACT_TEMPLATE_TEXT,
                }))
              }
              className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">恢复默认模板</Text>
            </Pressable>
            <Text className="text-2xs tabular-nums text-foreground-tertiary">
              {preferences.compactTemplateText.length}/300
            </Text>
          </View>

          <View className="rounded-xl border border-border-subtle bg-subtle px-3 py-2.5">
            <Text className="text-2xs leading-4 text-foreground-muted">
              LunaCode 三条红线：1) 官方订阅合规（无代理劫持/保活探针/自动轮询切号）；2) 零额外
              Token 浪费（纯本地只读统计与显式触发）；3) 禁止影响 Agent
              智商（默认保持原生压缩与完整工具输出）。
            </Text>
          </View>
        </View>
      </SettingsSection>
    </View>
  );
}
