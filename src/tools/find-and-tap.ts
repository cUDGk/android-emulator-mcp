import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  dumpUI,
  ensureDevice,
  resolveDevice,
  adb,
  sleep,
  ElementNotFoundError,
} from "../adb.js";
import { findElements, parseUIXml } from "../parsers/ui-parser.js";
import { centerOf, boundsToString } from "../utils/bounds.js";

export function registerFindAndTapTool(server: McpServer): void {
  server.tool(
    "find_and_tap",
    "Find a UI element by text/id/desc/class and tap it. Returns element info and updated UI tree after tap.",
    {
      by: z
        .enum(["text", "id", "desc", "class"])
        .describe("Search criterion"),
      value: z.string().describe("Search value (substring match by default)"),
      exact: z.boolean().optional().default(false).describe("Exact match"),
      index: z
        .number()
        .optional()
        .default(0)
        .describe("Index when multiple matches (0-based)"),
      long_press: z.boolean().optional().default(false),
      wait_ms: z
        .number()
        .optional()
        .default(500)
        .describe("Wait after tap before re-dumping UI (ms, max 5000)"),
      device: z.string().optional(),
    },
    async ({ by, value, exact, index, long_press, wait_ms, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const xml = await dumpUI(dev);
      const elements = findElements(xml, by, value, exact);

      if (elements.length === 0) {
        const tree = parseUIXml(xml, "visible");
        return {
          content: [
            {
              type: "text",
              text: `Element not found: ${by}="${value}"\n\nCurrent UI:\n${tree.text}`,
            },
          ],
          isError: true,
        };
      }

      if (index >= elements.length) {
        return {
          content: [
            {
              type: "text",
              text: `Index ${index} out of range. Found ${elements.length} matches for ${by}="${value}":\n${elements.map((e, i) => `  [${i}] ${e.className} t="${e.text}" ${boundsToString(e.bounds)}`).join("\n")}`,
            },
          ],
          isError: true,
        };
      }

      const element = elements[index];
      const [cx, cy] = centerOf(element.bounds);

      if (long_press) {
        await adb(["shell", `input swipe ${cx} ${cy} ${cx} ${cy} 1000`], {
          device: dev,
        });
      } else {
        await adb(["shell", `input tap ${cx} ${cy}`], { device: dev });
      }

      const waitTime = Math.min(wait_ms, 5000);
      await sleep(waitTime);

      const xmlAfter = await dumpUI(dev);
      const treeAfter = parseUIXml(xmlAfter, "visible");

      const matchInfo =
        elements.length > 1
          ? ` (${elements.length} matches, used index ${index})`
          : "";

      return {
        content: [
          {
            type: "text",
            text: [
              `Tapped: ${element.className} ${by}="${element.text || element.resourceId || element.contentDesc}" at (${cx},${cy})${matchInfo}`,
              "",
              "UI after tap:",
              treeAfter.text,
            ].join("\n"),
          },
        ],
      };
    },
  );
}
