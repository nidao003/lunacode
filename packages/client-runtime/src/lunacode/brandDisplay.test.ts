import { describe, expect, it } from "vite-plus/test";

import {
  LUNACODE_BRAND_NAME,
  rebrandCatalogToLunaCode,
  rebrandTextToLunaCode,
} from "./brandDisplay.ts";

describe("brandDisplay", () => {
  it("replaces user-facing T3 Code mentions without touching technical identifiers", () => {
    expect(LUNACODE_BRAND_NAME).toBe("LunaCode");
    expect(rebrandTextToLunaCode("Welcome to T3 Code")).toBe("Welcome to LunaCode");
    expect(rebrandTextToLunaCode("T3 Code Mobile / T3 Code")).toBe("LunaCode Mobile / LunaCode");
    expect(rebrandTextToLunaCode("Open T3 Code for T3 Connect")).toBe(
      "Open LunaCode for T3 Connect",
    );
    expect(rebrandTextToLunaCode("Use t3code, https://t3.codes, or ~/.t3/userdata")).toBe(
      "Use t3code, https://t3.codes, or ~/.t3/userdata",
    );
    expect(rebrandTextToLunaCode("T3CODE_HOME=~/.t3 @t3tools/contracts")).toBe(
      "T3CODE_HOME=~/.t3 @t3tools/contracts",
    );
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
