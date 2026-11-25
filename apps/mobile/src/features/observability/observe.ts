import Constants from "expo-constants";
import { Observe } from "expo-observe";

// LunaCode: crash reporting is permanently disabled; no data leaves to relay.
// Importing expo-observe installs its global JS error handler; reports leave only through the relay.
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

// LunaCode: always false — we never send crash data to upstream relay.
export const crashReportingAvailable = false;

interface PromiseRejectionTracker {
  readonly enablePromiseRejectionTracker?: (options: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
}

// React Native tracks unhandled rejections only in development, for LogBox; Observe has no hook.
// LunaCode: handler kept for local LogBox visibility but does NOT dispatch to relay.
if (!__DEV__) {
  const hermes: PromiseRejectionTracker | undefined = Reflect.get(globalThis, "HermesInternal");
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, _rejection) => {
      // LunaCode: intentionally no-op; was: Observe.reportError(rejection)
    },
  });
}

let latestConfiguration = 0;

// While sending is off, a dispatch pass drops what it finds, so one runs before turning it back on.
// Best effort: Observe skips the pass while it is backing off from a failed send.
export async function setCrashReportsEnabled(_enabled: boolean) {
  // LunaCode: always disabled regardless of user preference.
  const configuration = ++latestConfiguration;
  void configuration; // suppress unused warning
  Observe.configure({
    dispatchingEnabled: false,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

// LunaCode: immediately disable on module load, no relay check needed.
void setCrashReportsEnabled(false);
