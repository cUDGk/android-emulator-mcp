import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dumpUI, ensureDevice, resolveDevice, sleep } from "../adb.js";
import { parseXmlToTree, findElementsInTree, parseUIXml } from "../parsers/ui-parser.js";

export function registerWaitForElementTool(server: McpServer): void {
  server.tool(
    "wait_for_element",
    "Wait until a UI element appears on screen. Polls the UI hierarchy until the element is found or timeout.",
    {
      by: z.enum(["text", "id", "desc", "class"]).describe("Search criterion"),
      value: z.string().describe("Search value"),
      exact: z.boolean().optional().default(false),
      timeout_ms: z.number().optional().default(10000).describe("Timeout in ms (max 30000)"),
      poll_interval_ms: z.number().optional().default(1000).describe("Poll interval in ms"),
      device: z.string().optional(),
    },
    async ({ by, value, exact, timeout_ms, poll_interval_ms, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const timeout = Math.min(timeout_ms, 30000);
      const start = Date.now();
      let lastXml = "";

      while (Date.now() - start < timeout) {
        lastXml = await dumpUI(dev);
        const tree = parseXmlToTree(lastXml);
        const elements = findElementsInTree(tree, by, value, exact);

        if (elements.length > 0) {
          const rendered = parseUIXml(tree, "visible");
          return {
            content: [{
              type: "text",
              text: `Found ${by}="${value}" after ${Date.now() - start}ms (${elements.length} match${elements.length > 1 ? "es" : ""})\n\nUI:\n${rendered.text}`,
            }],
          };
        }

        await sleep(poll_interval_ms);
      }

      // Timeout - reuse last XML instead of re-dumping
      const rendered = lastXml ? parseUIXml(lastXml, "visible") : { text: "[no UI data]" };

      return {
        content: [{
          type: "text",
          text: `Timeout: ${by}="${value}" not found after ${timeout}ms\n\nLast UI:\n${rendered.text}`,
        }],
        isError: true,
      };
    },
  );
}
