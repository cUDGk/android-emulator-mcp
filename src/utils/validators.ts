/**
 * Input validators used to gate untrusted strings before they are passed
 * to argv (let alone re-parsed by a device-side shell).
 */

const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const AVD_NAME_RE = /^[A-Za-z0-9._-]+$/;
const KEYCODE_NAME_RE = /^[A-Z0-9_]+$/;

export function isValidPackageName(name: string): boolean {
  // Cap length before regex to defang catastrophic-backtracking style abuse
  // and to keep error messages bounded. Real package names are far below 256.
  if (name.length > 256) return false;
  return PACKAGE_NAME_RE.test(name);
}

export function isValidAvdName(name: string): boolean {
  return AVD_NAME_RE.test(name);
}

/**
 * Validate that `keycode` is either a positive integer (e.g. "67") or an
 * uppercase keycode-name token (e.g. "KEYCODE_DEL", "DEL"). Returns the
 * normalized string suitable for argv, or null if invalid.
 */
export function validateKeycode(keycode: string): string | null {
  const trimmed = keycode.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > 0 && n < 10000) return String(n);
    return null;
  }
  return KEYCODE_NAME_RE.test(trimmed) ? trimmed : null;
}

export function clampInt(
  n: number,
  min: number,
  max: number,
  fallback: number = min,
): number {
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  if (t < min) return min;
  if (t > max) return max;
  return t;
}
