export const LUNACODE_APP_BASE_NAME = "LunaCode";
export const LUNACODE_APP_ID = "com.nidao003.lunacode";
export const LUNACODE_DEV_APP_ID = "com.nidao003.lunacode.dev";
export const LUNACODE_MAC_USER_DATA_DIR = "lunacode-v2";

export const OFFICIAL_T3_MAC_APP_NAMES = [
  "T3 Code (Beta)",
  "T3 Code (Nightly)",
  "T3 Code",
] as const;

export type OfficialT3MacAppName = (typeof OFFICIAL_T3_MAC_APP_NAMES)[number];
