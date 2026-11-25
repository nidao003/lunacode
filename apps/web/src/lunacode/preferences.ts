import {
  DEFAULT_COMPACT_TEMPLATE_TEXT,
  DEFAULT_LUNA_PREFERENCES,
  type LunaOpenVikingConfig,
  type LunaPreferences,
  sanitizeLunaPreferences,
} from "@t3tools/client-runtime/lunacode/preferences";
import { useSyncExternalStore } from "react";

export {
  DEFAULT_COMPACT_TEMPLATE_TEXT,
  DEFAULT_LUNA_PREFERENCES,
  type LunaOpenVikingConfig,
  type LunaPreferences,
};

const LUNA_PREFERENCES_STORAGE_KEY = "lunacode.preferences.v1";
const LUNA_PREFERENCES_EVENT = "lunacode:preferences-updated";

let cachedRaw: string | null | undefined;
let cachedSnapshot: LunaPreferences = DEFAULT_LUNA_PREFERENCES;

function readLunaPreferences(): LunaPreferences {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return DEFAULT_LUNA_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(LUNA_PREFERENCES_STORAGE_KEY);
    if (raw === cachedRaw) {
      return cachedSnapshot;
    }
    cachedRaw = raw;
    if (!raw) {
      cachedSnapshot = DEFAULT_LUNA_PREFERENCES;
      return cachedSnapshot;
    }
    cachedSnapshot = sanitizeLunaPreferences(JSON.parse(raw));
    return cachedSnapshot;
  } catch {
    cachedRaw = null;
    cachedSnapshot = DEFAULT_LUNA_PREFERENCES;
    return cachedSnapshot;
  }
}

function writeLunaPreferences(next: LunaPreferences): LunaPreferences {
  const sanitized = sanitizeLunaPreferences(next);
  const serialized = JSON.stringify(sanitized);
  cachedRaw = serialized;
  cachedSnapshot = sanitized;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LUNA_PREFERENCES_STORAGE_KEY, serialized);
    } catch {
      // Ignore storage quota or private mode failures.
    }
    window.dispatchEvent(new Event(LUNA_PREFERENCES_EVENT));
  }
  return sanitized;
}

function updateLunaPreferences(
  updater: (current: LunaPreferences) => LunaPreferences,
): LunaPreferences {
  const current = readLunaPreferences();
  return writeLunaPreferences(updater(current));
}

function subscribeLunaPreferences(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LUNA_PREFERENCES_STORAGE_KEY) {
      cachedRaw = undefined;
      onStoreChange();
    }
  };
  const onLocalUpdate = () => {
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LUNA_PREFERENCES_EVENT, onLocalUpdate);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LUNA_PREFERENCES_EVENT, onLocalUpdate);
  };
}

export function useLunaPreferences(): readonly [
  LunaPreferences,
  (updater: (current: LunaPreferences) => LunaPreferences) => void,
] {
  const preferences = useSyncExternalStore(
    subscribeLunaPreferences,
    readLunaPreferences,
    () => DEFAULT_LUNA_PREFERENCES,
  );
  return [preferences, updateLunaPreferences] as const;
}
