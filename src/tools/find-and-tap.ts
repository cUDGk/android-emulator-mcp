import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dumpUI, ensureDevice, resolveDevice, adb, sleep } from "../adb.js";
import { parseXmlToTree, findElementsInTree, parseUIXml } from "../parsers/ui-parser.js";
import { centerOf, boundsToString, isZeroBounds } from "../utils/bounds.js";

export function registerFindAndTapTool(server: McpServer): void {
  server.tool(
    "find_and_tap",
    "Find a UI element by text/id/desc/class and tap it. Returns element info and updated UI tree after tap.",
    {
      by: z.enum(["text", "id", "desc", "class"]).describe("Search criterion"),
      value: z.string().describe("Search value (substring match by default)"),
      exact: z.boolean().optional().default(false).describe("Exact match"),
      index: z.number().optional().default(0).describe("Index when multiple matches (0-based)"),
      long_press: z.boolean().optional().default(false),
      wait_ms: z.number().optional().default(200).describe("Wait after tap before re-dumping UI (ms, max 5000)"),
      get_ui_after: z.boolean().optional().default(true).describe("Return UI tree after tap (set false for speed)"),
      device: z.string().optional(),
    },
    async ({ by, value, exact, index, long_press, wait_ms, get_ui_after, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const xml = await dumpUI(dev);
      const tree = parseXmlToTree(xml);
      const elements = findElementsInTree(tree, by, value, exact);

      if (elements.length === 0) {
        const rendered = parseUIXml(tree, "visible");
        return {
          content: [{
            type: "text",
            text: `Element not found: ${by}="${value}"\n\nCurrent UI:\n${rendered.text}`,
          }],
          isError: true,
        };
      }

      if (index >= elements.length) {
        return {
          content: [{
            type: "text",
            text: `Index ${index} out of range. Found ${elements.length} matches for ${by}="${value}":\n${elements.map((e, i) => `  [${i}] ${e.className} t="${e.text}" ${boundsToString(e.bounds)}`).join("\n")}`,
          }],
          isError: true,
        };
      }

      const element = elements[index];
      const [cx, cy] = centerOf(element.bounds);

      if (isZeroBounds(element.bounds)) {
        const rendered = parseUIXml(tree, "visible");
        return {
          content: [{
            type: "text",
            text: `Element found but has zero bounds (not visible on screen): ${by}="${value}"\n\nCurrent UI:\n${rendered.text}`,
          }],
          isError: true,
        };
      }

      if (long_press) {
        await adb(["shell", `input swipe ${cx} ${cy} ${cx} ${cy} 1000`], { device: dev });
      } else {
        await adb(["shell", `input tap ${cx} ${cy}`], { device: dev });
      }

      const matchInfo = elements.length > 1 ? ` (${elements.length} matches, used index ${index})` : "";
      const tapMsg = `Tapped: ${element.className} ${by}="${element.text || element.resourceId || element.contentDesc}" at (${cx},${cy})${matchInfo}`;

      if (!get_ui_after) {
        return { content: [{ type: "text", text: tapMsg }] };
      }

      const waitTime = Math.min(wait_ms, 5000);
      if (waitTime > 0) await sleep(waitTime);

      const xmlAfter = await dumpUI(dev);
      const treeAfter = parseUIXml(xmlAfter, "visible");

      return {
        content: [{ type: "text", text: `${tapMsg}\n\nUI after tap:\n${treeAfter.text}` }],
      };
    },
  );
}
