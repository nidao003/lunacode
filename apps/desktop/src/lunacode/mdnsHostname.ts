import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

const VALID_HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

/**
 * Normalizes a host / Bonjour name into a `.local` mDNS hostname suitable for LAN URLs,
 * rejecting loopback, numeric IPs, invalid DNS labels, and non-`.local` multi-label domains.
 */
export function normalizeMdnsHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\.+$/u, "").toLowerCase();
  if (!trimmed || trimmed.length > 253) return null;
  if (trimmed === "localhost" || trimmed === "localhost.localdomain") return null;
  if (trimmed.includes(":") || /^\d+(?:\.\d+)*$/u.test(trimmed)) return null;
  if (!VALID_HOSTNAME_RE.test(trimmed)) return null;

  if (!trimmed.includes(".")) {
    return `${trimmed}.local`;
  }
  if (trimmed.endsWith(".local")) {
    const stem = trimmed.slice(0, -".local".length);
    return stem.length > 0 && stem !== "localhost" ? trimmed : null;
  }
  return null;
}

/**
 * Resolves this machine's LAN mDNS `.local` hostname, preferring macOS `scutil --get LocalHostName`
 * so Bonjour names work even when DNS search suffixes change `os.hostname()`.
 */
export const readLocalMdnsHostname: Effect.Effect<
  string | null,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const fallbackHostname = yield* HostProcess.Hostname;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  if (platform === "darwin") {
    const macLocalHostName = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("scutil", ["--get", "LocalHostName"], {
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? normalizeMdnsHostname(stdout) : null;
      }),
    ).pipe(
      Effect.timeout("1500 millis"),
      Effect.catchDefect(() => Effect.succeed(null)),
      Effect.orElseSucceed(() => null),
    );
    if (macLocalHostName) return macLocalHostName;
  }

  return normalizeMdnsHostname(fallbackHostname);
});

/** Test seam for reading the machine's mDNS `.local` hostname without spawning `scutil`. */
export const DesktopMdnsHostnameReader = Context.Reference<
  () => Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner>
>("lunacode/DesktopMdnsHostnameReader", {
  defaultValue: () => () => readLocalMdnsHostname,
});
