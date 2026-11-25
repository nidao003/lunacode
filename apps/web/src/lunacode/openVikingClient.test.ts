import { assert, describe, it } from "@effect/vitest";
import {
  buildMemoryUri,
  buildOpenVikingHeaders,
  formatMemoryTailInjection,
  normalizeSearchResults,
} from "./openVikingClient";

describe("openVikingClient", () => {
  it("builds headers cleanly with optional X-API-Key", () => {
    assert.deepStrictEqual(buildOpenVikingHeaders(""), {
      "Content-Type": "application/json",
    });
    assert.deepStrictEqual(buildOpenVikingHeaders("  secret-key "), {
      "Content-Type": "application/json",
      "X-API-Key": "secret-key",
    });
  });

  it("normalizes nested OpenViking search results and sorts by score desc", () => {
    const hits = normalizeSearchResults({
      result: {
        memories: [
          {
            uri: "viking://user/memories/a.md",
            title: "旧记录",
            abstract: "低分内容",
            score: 0.42,
          },
          {
            uri: "viking://user/memories/b.md",
            title: "核心结论",
            content: "高分记忆内容",
            score: 0.91,
          },
          {
            uri: "viking://user/memories/empty.md",
            title: "空",
            content: "",
            score: 0.99,
          },
        ],
      },
    });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.title, "核心结论");
    assert.equal(hits[0]?.score, 0.91);
    assert.equal(hits[1]?.uri, "viking://user/memories/a.md");
  });

  it("sanitizes memory URIs and enforces strict tail injection maxChars", () => {
    const uri = buildMemoryUri("Fix Bug / 登录鉴权!", 1700000000000);
    assert.equal(uri, "viking://user/memories/lunacode/fix-bug-登录鉴权-1700000000000.md");

    const block = formatMemoryTailInjection(
      [
        {
          id: "1",
          uri: "viking://user/memories/1.md",
          title: "记忆一",
          snippet: "X".repeat(800),
          score: 0.88,
        },
      ],
      240,
    );
    assert.isAtMost(block.length, 240);
    assert.include(block, "OpenViking");
  });
});
