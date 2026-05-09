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
  return parts[parts.length - 1] ?? full;
}

function shortenResourceId(full: string): string {
  if (!full) return "";
  const idx = full.indexOf("/");
  return idx >= 0 ? full.slice(idx + 1) : full;
}

// fast-xml-parser returns an untyped object graph; use a structural alias.
type XmlNode = Record<string, unknown> & { node?: XmlNode | XmlNode[] };

/** Extract a string attribute from an XmlNode, returning fallback if absent or wrong type. */
function attr(raw: XmlNode, key: string, fallback = ""): string {
  const v = raw[key];
  return typeof v === "string" ? v : fallback;
}

function parseNode(raw: XmlNode): UINode {
  const children: UINode[] = [];
  if (raw.node) {
    const nodes = Array.isArray(raw.node) ? raw.node : [raw.node];
    for (const child of nodes) {
      children.push(parseNode(child as XmlNode));
    }
  }

  return {
    index: parseInt(attr(raw, "@_index", "0"), 10),
    text: attr(raw, "@_text"),
    resourceId: shortenResourceId(attr(raw, "@_resource-id")),
    className: shortenClass(attr(raw, "@_class") || "View"),
    contentDesc: attr(raw, "@_content-desc"),
    bounds: parseBounds(attr(raw, "@_bounds", "[0,0][0,0]")),
    clickable: toBool(attr(raw, "@_clickable")),
    scrollable: toBool(attr(raw, "@_scrollable")),
    focusable: toBool(attr(raw, "@_focusable")),
    focused: toBool(attr(raw, "@_focused")),
    checked: toBool(attr(raw, "@_checked")),
    selected: toBool(attr(raw, "@_selected")),
    enabled: toBool(attr(raw, "@_enabled")),
    password: toBool(attr(raw, "@_password")),
    children,
  };
}

function hasContent(node: UINode): boolean {
  return !!(node.text || node.resourceId || node.contentDesc);
}

function isInteractive(node: UINode): boolean {
  return node.clickable || node.scrollable || node.focusable || node.checked;
}

function filterVisible(node: UINode, maxDepth: number, depth: number): UINode | null {
  if (depth > maxDepth) return null;

  const filteredChildren: UINode[] = [];
  for (const child of node.children) {
    const filtered = filterVisible(child, maxDepth, depth + 1);
    if (filtered) filteredChildren.push(filtered);
  }

  if (isZeroBounds(node.bounds) && !hasContent(node) && filteredChildren.length === 0) {
    return null;
  }

  if (
    !hasContent(node) &&
    !isInteractive(node) &&
    filteredChildren.length === 1 &&
    filteredChildren[0]
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

// ─── Parsed UI tree (parse once, use for both rendering and searching) ───

export interface ParsedUI {
  roots: UINode[];
  totalNodes: number;
}

export function parseXmlToTree(xml: string): ParsedUI {
  const parsed = xmlParser.parse(xml);
  const hierarchy = parsed.hierarchy;
  if (!hierarchy || !hierarchy.node) {
    return { roots: [], totalNodes: 0 };
  }

  const nodes: XmlNode[] = Array.isArray(hierarchy.node)
    ? (hierarchy.node as XmlNode[])
    : [hierarchy.node as XmlNode];
  const roots: UINode[] = nodes.map(parseNode);
  const totalNodes = roots.reduce((sum: number, r: UINode) => sum + countNodes(r), 0);

  return { roots, totalNodes };
}

export interface ParseResult {
  text: string;
  totalNodes: number;
  shownNodes: number;
  filterMode: FilterMode;
}

/**
 * Render UI tree to compressed text.
 * Accepts either raw XML string or pre-parsed ParsedUI to avoid double-parsing.
 */
export function parseUIXml(
  xmlOrTree: string | ParsedUI,
  filter: FilterMode = "visible",
  maxDepth: number = 15,
): ParseResult {
  const tree = typeof xmlOrTree === "string" ? parseXmlToTree(xmlOrTree) : xmlOrTree;

  if (tree.roots.length === 0) {
    return { text: "[empty screen]", totalNodes: 0, shownNodes: 0, filterMode: filter };
  }

  let filteredRoots: UINode[];
  switch (filter) {
    case "interactive":
      filteredRoots = tree.roots
        .map((r: UINode) => filterInteractive(r, maxDepth, 0))
        .filter((r: UINode | null): r is UINode => r !== null);
      break;
    case "visible":
      filteredRoots = tree.roots
        .map((r: UINode) => filterVisible(r, maxDepth, 0))
        .filter((r: UINode | null): r is UINode => r !== null);
      break;
    default:
      filteredRoots = tree.roots;
  }

  const lines: string[] = [];
  for (const root of filteredRoots) {
    renderNode(root, 0, lines);
  }

  const shownNodes = filteredRoots.reduce(
    (sum: number, r: UINode) => sum + countNodes(r),
    0,
  );

  const text =
    lines.join("\n") +
    `\n\n[${tree.totalNodes} nodes -> ${shownNodes} shown, filter=${filter}]`;

  return { text, totalNodes: tree.totalNodes, shownNodes, filterMode: filter };
}

/**
 * Search elements in a pre-parsed tree (avoids re-parsing XML).
 */
export function findElementsInTree(
  tree: ParsedUI,
  by: "text" | "id" | "desc" | "class",
  value: string,
  exact: boolean = false,
): UINode[] {
  // An empty value with substring match would match every node in the tree.
  // That is never what a caller wants, so short-circuit to no matches.
  if (value === "") return [];

  const results: UINode[] = [];
  const valueLower = exact ? "" : value.toLowerCase();

  function search(node: UINode): void {
    let target: string;
    switch (by) {
      case "text":  target = node.text; break;
      case "id":    target = node.resourceId; break;
      case "desc":  target = node.contentDesc; break;
      case "class": target = node.className; break;
    }

    const match = exact
      ? target === value
      : target.toLowerCase().includes(valueLower);
    if (match) results.push(node);

    for (const child of node.children) {
      search(child);
    }
  }

  for (const root of tree.roots) {
    search(root);
  }

  return results;
}

/**
 * Legacy wrapper: parse XML and search (for backward compat).
 */
export function findElements(
  xml: string,
  by: "text" | "id" | "desc" | "class",
  value: string,
  exact: boolean = false,
): UINode[] {
  return findElementsInTree(parseXmlToTree(xml), by, value, exact);
}
