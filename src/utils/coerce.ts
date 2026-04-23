/**
 * Claude Code の LLM ツール使用パスでは、object / array 型の引数が
 * JSON 文字列として届く事がある（http-mcp v0.2.1 で発覚）。
 * zod の union で string も受けた上で、ハンドラ側で本来の型に戻すために使う。
 */
export function coerceObject<T>(val: unknown): T | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (parsed !== null && typeof parsed === "object") return parsed as T;
    } catch {}
    return undefined;
  }
  if (typeof val === "object") return val as T;
  return undefined;
}
