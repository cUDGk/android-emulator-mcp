import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adb, dumpUI, ensureDevice, resolveDevice, sleep } from "../adb.js";
import { parseUIXml } from "../parsers/ui-parser.js";

export function registerTapTool(server: McpServer): void {
  server.tool(
    "tap",
    "Tap at specific screen coordinates. Returns updated UI tree after tap.",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      long_press: z.boolean().optional().default(false),
      wait_ms: z
        .number()
        .optional()
        .default(500)
        .describe("Wait after tap (ms)"),
      get_ui_after: z
        .boolean()
        .optional()
        .default(true)
        .describe("Return UI tree after tap"),
      device: z.string().optional(),
    },
    async ({ x, y, long_press, wait_ms, get_ui_after, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      if (long_press) {
        await adb(["shell", `input swipe ${x} ${y} ${x} ${y} 1000`], {
          device: dev,
        });
      } else {
        await adb(["shell", `input tap ${x} ${y}`], { device: dev });
      }

      const waitTime = Math.min(wait_ms, 5000);
      if (waitTime > 0) await sleep(waitTime);

      let uiText = "";
      if (get_ui_after) {
        const xml = await dumpUI(dev);
        const tree = parseUIXml(xml, "visible");
        uiText = `\n\nUI after tap:\n${tree.text}`;
      }

      return {
        content: [
          {
            type: "text",
            text: `Tapped (${x}, ${y})${long_press ? " (long press)" : ""}${uiText}`,
          },
        ],
      };
    },
  );
}
