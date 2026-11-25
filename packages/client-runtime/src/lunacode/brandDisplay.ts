export const LUNACODE_BRAND_NAME = "LunaCode";

const T3_CODE_BRAND_PATTERN = /\bT3 Code\b/g;

/** Replaces user-facing "T3 Code" mentions while leaving CLI/protocol/storage names intact. */
export function rebrandTextToLunaCode(text: string): string {
  return text.includes("T3 Code") ? text.replace(T3_CODE_BRAND_PATTERN, LUNACODE_BRAND_NAME) : text;
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
