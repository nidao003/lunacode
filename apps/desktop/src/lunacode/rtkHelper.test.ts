import { assert, describe, it } from "@effect/vitest";
import { hasRtkClaudeHook, resolveRtkCandidatePaths } from "./rtkHelper.ts";

describe("rtkHelper", () => {
  it("detects rtk hooks inside Claude settings.json PreToolUse arrays", () => {
    assert.isFalse(hasRtkClaudeHook(null));
    assert.isFalse(hasRtkClaudeHook("{bad json"));
    assert.isFalse(
      hasRtkClaudeHook(
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
          },
        }),
      ),
    );
    assert.isTrue(
      hasRtkClaudeHook(
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: "/Users/test/.claude/hooks/rtk-rewrite.sh",
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
  });

  it("collects deduplicated macOS Homebrew, Cargo, and PATH candidate binaries", () => {
    const paths = resolveRtkCandidatePaths(
      "/usr/local/bin:/custom/bin:/opt/homebrew/bin",
      "/Users/ada",
    );
    assert.include(paths, "/opt/homebrew/bin/rtk");
    assert.include(paths, "/usr/local/bin/rtk");
    assert.include(paths, "/Users/ada/.cargo/bin/rtk");
    assert.include(paths, "/Users/ada/.local/bin/rtk");
    assert.include(paths, "/custom/bin/rtk");
    assert.equal(new Set(paths).size, paths.length);
  });
});
