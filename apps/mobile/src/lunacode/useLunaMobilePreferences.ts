import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_LUNA_PREFERENCES,
  type LunaPreferences,
  sanitizeLunaPreferences,
} from "@t3tools/client-runtime/lunacode/preferences";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, saveMobilePreferences } from "../state/preferences";
import { useAtomCommand } from "../state/use-atom-command";

export function useLunaMobilePreferences(): readonly [
  LunaPreferences,
  (updater: (current: LunaPreferences) => LunaPreferences) => void,
] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences, {
    label: "luna preferences update",
    reportFailure: false,
  });

  const current =
    AsyncResult.isSuccess(preferences) && preferences.value.lunaPreferences
      ? sanitizeLunaPreferences(preferences.value.lunaPreferences)
      : DEFAULT_LUNA_PREFERENCES;

  const updatePreferences = (updater: (value: LunaPreferences) => LunaPreferences) => {
    void savePreferences({
      transform: (stored) => {
        const base = stored.lunaPreferences
          ? sanitizeLunaPreferences(stored.lunaPreferences)
          : DEFAULT_LUNA_PREFERENCES;
        return {
          lunaPreferences: sanitizeLunaPreferences(updater(base)),
        };
      },
    });
  };

  return [current, updatePreferences] as const;
}
