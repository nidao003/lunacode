export const LUNACODE_BRAND_NAME = "LunaCode";
export const LUNACODE_CONNECT_NAME = "Luna Connect";
export const LUNACODE_ACCOUNT_NAME = "Luna Account";
export const LUNACODE_CHAT_NAME = "Luna Chat";

const T3_CODE_BRAND_PATTERN = /\bT3 Code(s?)(?=$|[^A-Za-z0-9_])/g;
const T3_SHORT_BRAND_PATTERN = /\bT3(?=$|[^A-Za-z0-9_])/g;

/** Replaces user-facing "T3 Code" and standalone "T3" brand mentions while leaving technical identifiers intact. */
export function rebrandTextToLunaCode(text: string): string {
  if (!text.includes("T3")) return text;
  return text
    .replace(T3_CODE_BRAND_PATTERN, `${LUNACODE_BRAND_NAME}$1`)
    .replace(T3_SHORT_BRAND_PATTERN, "Luna");
}

/** Rebrands GT translation catalog strings and AST nodes without altering inline CLI code spans. */
export function rebrandCatalogToLunaCode<T>(catalog: T): T {
  if (typeof catalog === "string") {
    return rebrandTextToLunaCode(catalog) as T;
  }
  if (Array.isArray(catalog)) {
    let changed = false;
    const next = catalog.map((item) => {
      const updated = rebrandCatalogToLunaCode(item);
      if (updated !== item) {
        changed = true;
      }
      return updated;
    });
    return (changed ? next : catalog) as T;
  }
  if (catalog !== null && typeof catalog === "object") {
    const record = catalog as Record<string, unknown>;
    if (record.t === "code") {
      return catalog;
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const value = record[key];
      const updated = key === "t" || key === "i" ? value : rebrandCatalogToLunaCode(value);
      if (updated !== value) {
        changed = true;
      }
      next[key] = updated;
    }
    return (changed ? next : catalog) as T;
  }
  return catalog;
}
