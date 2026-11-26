import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { normalizeMdnsHostname, readLocalMdnsHostname } from "./mdnsHostname.ts";

const encoder = new TextEncoder();

function mockSpawner(stdoutText: string, exitCode = 0) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdoutText)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}

describe("normalizeMdnsHostname", () => {
  it("normalizes single labels and .local hostnames while rejecting invalid inputs", () => {
    assert.equal(normalizeMdnsHostname("mac-studio"), "mac-studio.local");
    assert.equal(normalizeMdnsHostname("  Mac-Studio.Local.  "), "mac-studio.local");
    assert.equal(normalizeMdnsHostname("localhost"), null);
    assert.equal(normalizeMdnsHostname("192.168.1.20"), null);
    assert.equal(normalizeMdnsHostname("::1"), null);
    assert.equal(normalizeMdnsHostname("myhost.example.com"), null);
    assert.equal(normalizeMdnsHostname("bad host!"), null);
    assert.equal(normalizeMdnsHostname(""), null);
  });
});

describe("readLocalMdnsHostname", () => {
  it.effect("prefers macOS scutil LocalHostName output on darwin", () =>
    readLocalMdnsHostname.pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Hostname, "ignored.corp.example"),
      Effect.provide(mockSpawner("mac-studio\n", 0)),
      Effect.map((hostname) => {
        assert.equal(hostname, "mac-studio.local");
      }),
    ),
  );

  it.effect("falls back to HostProcess.Hostname when scutil fails", () => {
    const failingSpawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die(new Error("scutil unavailable"))),
    );
    return readLocalMdnsHostname.pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Hostname, "workstation.local"),
      Effect.provide(failingSpawner),
      Effect.map((hostname) => {
        assert.equal(hostname, "workstation.local");
      }),
    );
  });

  it.effect("reads HostProcess.Hostname directly on non-darwin platforms", () => {
    return readLocalMdnsHostname.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Hostname, "ubuntu-box"),
      Effect.provide(mockSpawner("should-not-run", 1)),
      Effect.map((hostname) => {
        assert.equal(hostname, "ubuntu-box.local");
      }),
    );
  });
});
