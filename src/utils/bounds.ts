import type { Bounds } from "../parsers/ui-types.js";

export function parseBounds(raw: string): Bounds {
  const m = raw.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  return {
    x1: parseInt(m[1], 10),
    y1: parseInt(m[2], 10),
    x2: parseInt(m[3], 10),
    y2: parseInt(m[4], 10),
  };
}

export function centerOf(b: Bounds): [number, number] {
  return [Math.round((b.x1 + b.x2) / 2), Math.round((b.y1 + b.y2) / 2)];
}

export function isZeroBounds(b: Bounds): boolean {
  return b.x1 === 0 && b.y1 === 0 && b.x2 === 0 && b.y2 === 0;
}

export function boundsToString(b: Bounds): string {
  return `[${b.x1},${b.y1}][${b.x2},${b.y2}]`;
}
