import { DEFAULT_COMPACT_TEMPLATE_TEXT } from "@t3tools/client-runtime/lunacode/preferences";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { ThemedSwitch } from "../components/ui/ThemedSwitch";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { useLunaMobilePreferences } from "./useLunaMobilePreferences";

export function LunaMobileSettingsSection() {
  const [preferences, updatePreferences] = useLunaMobilePreferences();

  return (
    <View className="gap-6">
      <SettingsSection
        title="LunaCode · OpenViking 云端记忆"
        footer="记忆由各 Agent CLI 的 OpenViking 插件提供（自动召回与沉淀）；连接地址、API Key 与召回阈值统一在 ~/.openviking/ovcli.conf 维护。"
      >
        <View className="gap-2 p-4">
          <Text className="text-xs text-foreground-muted">
            LunaCode 不再内置独立客户端，避免同一服务上的参数漂移与重复注入。
          </Text>
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
