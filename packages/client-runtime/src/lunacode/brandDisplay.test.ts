import { describe, expect, it } from "vite-plus/test";

import {
  LUNACODE_ACCOUNT_NAME,
  LUNACODE_BRAND_NAME,
  LUNACODE_CHAT_NAME,
  LUNACODE_CONNECT_NAME,
  rebrandCatalogToLunaCode,
  rebrandTextToLunaCode,
} from "./brandDisplay.ts";

describe("brandDisplay", () => {
  it("replaces user-facing T3 brand mentions without touching technical identifiers", () => {
    expect(LUNACODE_BRAND_NAME).toBe("LunaCode");
    expect(LUNACODE_CONNECT_NAME).toBe("Luna Connect");
    expect(LUNACODE_ACCOUNT_NAME).toBe("Luna Account");
    expect(LUNACODE_CHAT_NAME).toBe("Luna Chat");
    expect(rebrandTextToLunaCode("Welcome to T3 Code")).toBe("Welcome to LunaCode");
    expect(rebrandTextToLunaCode("T3 Code Mobile / T3 Codes")).toBe("LunaCode Mobile / LunaCodes");
    expect(rebrandTextToLunaCode("Open T3 Code for T3 Connect")).toBe(
      "Open LunaCode for Luna Connect",
    );
    expect(rebrandTextToLunaCode("T3 Account · T3 account · T3 Chat")).toBe(
      "Luna Account · Luna account · Luna Chat",
    );
    expect(
      rebrandTextToLunaCode("登录 T3 Connect · T3 账户 · T3 账号 · T3 服务器 · T3 主目录"),
    ).toBe("登录 Luna Connect · Luna 账户 · Luna 账号 · Luna 服务器 · Luna 主目录");
    expect(rebrandTextToLunaCode("T3 会话 · T3 团队 · T3Code에 / T3 Code에")).toBe(
      "Luna 会话 · Luna 团队 · T3Code에 / LunaCode에",
    );
    expect(rebrandTextToLunaCode("Use t3code, https://t3.codes, or ~/.t3/userdata")).toBe(
      "Use t3code, https://t3.codes, or ~/.t3/userdata",
    );
    expect(
      rebrandTextToLunaCode("T3CODE_HOME=~/.t3 T3_WORKTREE_ROOT=/tmp @t3tools/contracts"),
    ).toBe("T3CODE_HOME=~/.t3 T3_WORKTREE_ROOT=/tmp @t3tools/contracts");
  });

  it("rebrands GT catalog strings and AST nodes while preserving code spans", () => {
    const catalog = {
      simple: "{organization} manages T3 Code updates.",
      nested: [
        "Get one in Use T3 Code in another app (MCP) or run",
        " ",
        { t: "code", i: 1, c: "t3 auth pairing create" },
        " and keep T3 Code open.",
      ],
      preservedCodeMention: ["Or inspect ", { t: "code", i: 2, c: "T3 Code" }],
      plainNode: { t: "b", i: 3, c: "T3 Code Desktop" },
    };

    expect(rebrandCatalogToLunaCode(catalog)).toEqual({
      simple: "{organization} manages LunaCode updates.",
      nested: [
        "Get one in Use LunaCode in another app (MCP) or run",
        " ",
        { t: "code", i: 1, c: "t3 auth pairing create" },
        " and keep LunaCode open.",
      ],
      preservedCodeMention: ["Or inspect ", { t: "code", i: 2, c: "T3 Code" }],
      plainNode: { t: "b", i: 3, c: "LunaCode Desktop" },
    });
  });
});
