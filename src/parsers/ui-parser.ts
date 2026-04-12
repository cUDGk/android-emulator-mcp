import { XMLParser } from "fast-xml-parser";
import type { UINode, FilterMode } from "./ui-types.js";
import { parseBounds, isZeroBounds, boundsToString } from "../utils/bounds.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "node",
});

function toBool(val: string | undefined): boolean {
  return val === "true";
}

function shortenClass(full: string): string {
  const parts = full.split(".");
  return parts[parts.length - 1];
}

function shortenResourceId(full: string): string {
  if (!full) return "";
  const idx = full.indexOf("/");
  return idx >= 0 ? full.slice(idx + 1) : full;
}

function parseNode(raw: any): UINode {
  const children: UINode[] = [];
  if (raw.node) {
    const nodes = Array.isArray(raw.node) ? raw.node : [raw.node];
    for (const child of nodes) {
      children.push(parseNode(child));
    }
  }

  return {
    index: parseInt(raw["@_index"] || "0", 10),
    text: raw["@_text"] || "",
    resourceId: shortenResourceId(raw["@_resource-id"] || ""),
    className: shortenClass(raw["@_class"] || "View"),
    contentDesc: raw["@_content-desc"] || "",
    bounds: parseBounds(raw["@_bounds"] || "[0,0][0,0]"),
    clickable: toBool(raw["@_clickable"]),
    scrollable: toBool(raw["@_scrollable"]),
    focusable: toBool(raw["@_focusable"]),
    focused: toBool(raw["@_focused"]),
    checked: toBool(raw["@_checked"]),
    selected: toBool(raw["@_selected"]),
    enabled: toBool(raw["@_enabled"]),
    password: toBool(raw["@_password"]),
    children,
  };
}

function hasContent(node: UINode): boolean {
  return !!(node.text || node.resourceId || node.contentDesc);
}

function isInteractive(node: UINode): boolean {
  return (
    node.clickable || node.scrollable || node.focusable || node.checked
  );
}

function filterVisible(node: UINode, maxDepth: number, depth: number): UINode | null {
  if (depth > maxDepth) return null;

  const filteredChildren: UINode[] = [];
  for (const child of node.children) {
    const filtered = filterVisible(child, maxDepth, depth + 1);
    if (filtered) filteredChildren.push(filtered);
  }

  // Remove zero-bounds leaf nodes that have no content
  if (isZeroBounds(node.bounds) && !hasContent(node) && filteredChildren.length === 0) {
    return null;
  }

  // Flatten: empty container with single child
  if (
    !hasContent(node) &&
    !isInteractive(node) &&
    filteredChildren.length === 1
  ) {
    return filteredChildren[0];
  }

  return { ...node, children: filteredChildren };
}

function filterInteractive(node: UINode, maxDepth: number, depth: number): UINode | null {
  if (depth > maxDepth) return null;

  const filteredChildren: UINode[] = [];
  for (const child of node.children) {
    const filtered = filterInteractive(child, maxDepth, depth + 1);
    if (filtered) filteredChildren.push(filtered);
  }

  if (isInteractive(node) || hasContent(node) || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }

  return null;
}

function countNodes(node: UINode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function renderNode(node: UINode, depth: number, lines: string[]): void {
  const parts: string[] = [node.className];

  if (node.resourceId) parts.push(`#${node.resourceId}`);

  if (node.text) parts.push(`t="${truncate(node.text, 30)}"`);

  if (node.contentDesc) parts.push(`d="${truncate(node.contentDesc, 30)}"`);

  const flags: string[] = [];
  if (node.clickable) flags.push("C");
  if (node.scrollable) flags.push("S");
  if (node.focused) flags.push("F");
  if (node.checked) flags.push("K");
  if (node.selected) flags.push("X");
  if (!node.enabled) flags.push("!E");
  if (node.password) flags.push("P");
  if (flags.length) parts.push(`[${flags.join("")}]`);

  parts.push(boundsToString(node.bounds));

  lines.push("  ".repeat(depth) + parts.join(" "));

  for (const child of node.children) {
    renderNode(child, depth + 1, lines);
  }
}

export interface ParseResult {
  text: string;
  totalNodes: number;
  shownNodes: number;
  filterMode: FilterMode;
}

export function parseUIXml(
  xml: string,
  filter: FilterMode = "visible",
  maxDepth: number = 15,
): ParseResult {
  const parsed = xmlParser.parse(xml);
  const hierarchy = parsed.hierarchy;
  if (!hierarchy || !hierarchy.node) {
    return {
      text: "[empty screen]",
      totalNodes: 0,
      shownNodes: 0,
      filterMode: filter,
    };
  }

  const nodes = Array.isArray(hierarchy.node)
    ? hierarchy.node
    : [hierarchy.node];
  const roots: UINode[] = nodes.map(parseNode);

  const totalNodes = roots.reduce((sum: number, r: UINode) => sum + countNodes(r), 0);

  let filteredRoots: UINode[];
  switch (filter) {
    case "interactive":
      filteredRoots = roots
        .map((r: UINode) => filterInteractive(r, maxDepth, 0))
        .filter((r: UINode | null): r is UINode => r !== null);
      break;
    case "visible":
      filteredRoots = roots
        .map((r: UINode) => filterVisible(r, maxDepth, 0))
        .filter((r: UINode | null): r is UINode => r !== null);
      break;
    default:
      filteredRoots = roots;
  }

  const lines: string[] = [];
  for (const root of filteredRoots) {
    renderNode(root, 0, lines);
  }

  const shownNodes = filteredRoots.reduce(
    (sum, r) => sum + countNodes(r),
    0,
  );

  const text =
    lines.join("\n") +
    `\n\n[${totalNodes} nodes -> ${shownNodes} shown, filter=${filter}]`;

  return { text, totalNodes, shownNodes, filterMode: filter };
}

export function findElements(
  xml: string,
  by: "text" | "id" | "desc" | "class",
  value: string,
  exact: boolean = false,
): UINode[] {
  const parsed = xmlParser.parse(xml);
  const hierarchy = parsed.hierarchy;
  if (!hierarchy || !hierarchy.node) return [];

  const nodes = Array.isArray(hierarchy.node)
    ? hierarchy.node
    : [hierarchy.node];
  const roots = nodes.map(parseNode);

  const results: UINode[] = [];

  function search(node: UINode): void {
    let target: string;
    switch (by) {
      case "text":
        target = node.text;
        break;
      case "id":
        target = node.resourceId;
        break;
      case "desc":
        target = node.contentDesc;
        break;
      case "class":
        target = node.className;
        break;
    }

    const match = exact
      ? target === value
      : target.toLowerCase().includes(value.toLowerCase());

    if (match) results.push(node);

    for (const child of node.children) {
      search(child);
    }
  }

  for (const root of roots) {
    search(root);
  }

  return results;
}
