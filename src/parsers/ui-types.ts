export interface UINode {
  index: number;
  text: string;
  resourceId: string;
  className: string;
  contentDesc: string;
  bounds: Bounds;
  clickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  focused: boolean;
  checked: boolean;
  selected: boolean;
  enabled: boolean;
  password: boolean;
  children: UINode[];
}

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type FilterMode = "all" | "visible" | "interactive";
