import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adb,
  dumpUI,
  ensureDevice,
  resolveDevice,
  sleep,
  getScreenSize,
} from "../adb.js";
import { parseUIXml } from "../parsers/ui-parser.js";

export function registerSwipeTool(server: McpServer): void {
  server.tool(
    "swipe",
    "Perform a swipe gesture. Use direction presets (up/down/left/right) or custom coordinates.",
    {
      direction: z
        .enum(["up", "down", "left", "right"])
        .optional()
        .describe(
          "Swipe direction (content movement direction: 'up' scrolls content up)",
        ),
      from_x: z.number().optional().describe("Custom start X"),
      from_y: z.number().optional().describe("Custom start Y"),
      to_x: z.number().optional().describe("Custom end X"),
      to_y: z.number().optional().describe("Custom end Y"),
      duration_ms: z
        .number()
        .optional()
        .default(300)
        .describe("Swipe duration in ms"),
      get_ui_after: z.boolean().optional().default(true),
      device: z.string().optional(),
    },
    async ({
      direction,
      from_x,
      from_y,
      to_x,
      to_y,
      duration_ms,
      get_ui_after,
      device,
    }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      let fx: number, fy: number, tx: number, ty: number;

      if (
        from_x !== undefined &&
        from_y !== undefined &&
        to_x !== undefined &&
        to_y !== undefined
      ) {
        fx = from_x;
        fy = from_y;
        tx = to_x;
        ty = to_y;
      } else if (direction) {
        const size = await getScreenSize(dev);
        const cx = Math.round(size.width / 2);
        const cy = Math.round(size.height / 2);
        const dy = Math.round(size.height * 0.3);
        const dx = Math.round(size.width * 0.3);

        switch (direction) {
          case "up":
            fx = cx;
            fy = cy + dy;
            tx = cx;
            ty = cy - dy;
            break;
          case "down":
            fx = cx;
            fy = cy - dy;
            tx = cx;
            ty = cy + dy;
            break;
          case "left":
            fx = cx + dx;
            fy = cy;
            tx = cx - dx;
            ty = cy;
            break;
          case "right":
            fx = cx - dx;
            fy = cy;
            tx = cx + dx;
            ty = cy;
            break;
        }
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Either 'direction' or all custom coordinates (from_x, from_y, to_x, to_y) must be provided.",
            },
          ],
          isError: true,
        };
      }

      await adb(
        ["shell", `input swipe ${fx!} ${fy!} ${tx!} ${ty!} ${duration_ms}`],
        { device: dev },
      );

      await sleep(300);

      let uiText = "";
      if (get_ui_after) {
        const xml = await dumpUI(dev);
        const tree = parseUIXml(xml, "visible");
        uiText = `\n\nUI after swipe:\n${tree.text}`;
      }

      return {
        content: [
          {
            type: "text",
            text: `Swiped ${direction || "custom"}: (${fx!},${fy!}) -> (${tx!},${ty!})${uiText}`,
          },
        ],
      };
    },
  );
}
