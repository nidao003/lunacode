export interface LunaOpenVikingConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly maxChars: number;
  readonly minScore: number;
}

export interface LunaPreferences {
  readonly modelAlertThresholdsK: Readonly<Record<string, number>>;
  readonly compactTemplateEnabled: boolean;
  readonly compactTemplateText: string;
  readonly openViking: LunaOpenVikingConfig;
  readonly customLanHost: string;
}

export const DEFAULT_COMPACT_TEMPLATE_TEXT =
  "保留：已修改文件路径、关键架构决策、当前阻塞与报错、已运行验证命令及下一步待办；精简过程日志。";

export const DEFAULT_LUNA_PREFERENCES: LunaPreferences = {
  modelAlertThresholdsK: {},
  compactTemplateEnabled: false,
  compactTemplateText: DEFAULT_COMPACT_TEMPLATE_TEXT,
  openViking: {
    baseUrl: "http://192.168.3.160:1933",
    apiKey: "",
    maxChars: 2400,
    minScore: 0.25,
  },
  customLanHost: "",
};

export function sanitizeLunaPreferences(raw: unknown): LunaPreferences {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_LUNA_PREFERENCES;
  }
  const obj = raw as Record<string, unknown>;

  const thresholds: Record<string, number> = {};
  if (
    typeof obj.modelAlertThresholdsK === "object" &&
    obj.modelAlertThresholdsK !== null &&
    !Array.isArray(obj.modelAlertThresholdsK)
  ) {
    for (const [model, value] of Object.entries(obj.modelAlertThresholdsK)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        thresholds[model] = Math.round(value);
      }
    }
  }

  const compactTemplateEnabled =
    typeof obj.compactTemplateEnabled === "boolean"
      ? obj.compactTemplateEnabled
      : DEFAULT_LUNA_PREFERENCES.compactTemplateEnabled;

  const compactTemplateText =
    typeof obj.compactTemplateText === "string" && obj.compactTemplateText.trim().length > 0
      ? obj.compactTemplateText.trim().slice(0, 300)
      : DEFAULT_LUNA_PREFERENCES.compactTemplateText;

  const rawViking =
    typeof obj.openViking === "object" && obj.openViking !== null && !Array.isArray(obj.openViking)
      ? (obj.openViking as Record<string, unknown>)
      : {};

  const baseUrl =
    typeof rawViking.baseUrl === "string" && rawViking.baseUrl.trim().length > 0
      ? rawViking.baseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_LUNA_PREFERENCES.openViking.baseUrl;

  const apiKey = typeof rawViking.apiKey === "string" ? rawViking.apiKey.trim() : "";

  const maxChars =
    typeof rawViking.maxChars === "number" &&
    Number.isFinite(rawViking.maxChars) &&
    rawViking.maxChars >= 400
      ? Math.min(8000, Math.round(rawViking.maxChars))
      : DEFAULT_LUNA_PREFERENCES.openViking.maxChars;

  const minScore =
    typeof rawViking.minScore === "number" &&
    Number.isFinite(rawViking.minScore) &&
    rawViking.minScore >= 0 &&
    rawViking.minScore <= 1
      ? Number(rawViking.minScore.toFixed(2))
      : DEFAULT_LUNA_PREFERENCES.openViking.minScore;

  const customLanHost = typeof obj.customLanHost === "string" ? obj.customLanHost.trim() : "";

  return {
    modelAlertThresholdsK: thresholds,
    compactTemplateEnabled,
    compactTemplateText,
    openViking: {
      baseUrl,
      apiKey,
      maxChars,
      minScore,
    },
    customLanHost,
  };
}
