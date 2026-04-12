import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dumpUI, ensureDevice, resolveDevice, sleep } from "../adb.js";
import { findElements, parseUIXml } from "../parsers/ui-parser.js";

export function registerWaitForElementTool(server: McpServer): void {
  server.tool(
    "wait_for_element",
    "Wait until a UI element appears on screen. Polls the UI hierarchy until the element is found or timeout.",
    {
      by: z.enum(["text", "id", "desc", "class"]).describe("Search criterion"),
      value: z.string().describe("Search value"),
      exact: z.boolean().optional().default(false),
      timeout_ms: z
        .number()
        .optional()
        .default(10000)
        .describe("Timeout in ms (max 30000)"),
      poll_interval_ms: z
        .number()
        .optional()
        .default(1000)
        .describe("Poll interval in ms"),
      device: z.string().optional(),
    },
    async ({ by, value, exact, timeout_ms, poll_interval_ms, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const timeout = Math.min(timeout_ms, 30000);
      const start = Date.now();

      while (Date.now() - start < timeout) {
        const xml = await dumpUI(dev);
        const elements = findElements(xml, by, value, exact);

        if (elements.length > 0) {
          const tree = parseUIXml(xml, "visible");
          return {
            content: [
              {
                type: "text",
                text: `Found ${by}="${value}" after ${Date.now() - start}ms (${elements.length} match${elements.length > 1 ? "es" : ""})\n\nUI:\n${tree.text}`,
              },
            ],
          };
        }

        await sleep(poll_interval_ms);
      }

      // Timeout - return last UI state
      const xml = await dumpUI(dev);
      const tree = parseUIXml(xml, "visible");

      return {
        content: [
          {
            type: "text",
            text: `Timeout: ${by}="${value}" not found after ${timeout}ms\n\nLast UI:\n${tree.text}`,
          },
        ],
        isError: true,
      };
    },
  );
}
