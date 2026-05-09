import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adb,
  AdbError,
  DeviceNotConnectedError,
  dumpUI,
  ensureDevice,
  resolveDevice,
  sleep,
  getScreenSize,
} from "../adb.js";
import { parseUIXml } from "../parsers/ui-parser.js";
import { clampInt } from "../utils/validators.js";

export function registerSwipeTool(server: McpServer): void {
  server.tool(
    "swipe",
    "Perform a swipe gesture. Use direction presets (up/down/left/right) or custom coordinates.",
    {
      direction: z
        .enum(["up", "down", "left", "right"])
        .optional()
        .describe(
          "Swipe direction. Naming convention: describes the direction the *finger* moves on screen. " +
            "'up' drags from lower-screen toward upper-screen (which scrolls page content up to reveal what is below).",
        ),
      from_x: z
        .number()
        .optional()
        .describe(
          "Custom swipe start X. from_x/from_y/to_x/to_y must be provided as a complete 4-set; otherwise `direction` is used.",
        ),
      from_y: z
        .number()
        .optional()
        .describe(
          "Custom swipe start Y. from_x/from_y/to_x/to_y must be provided as a complete 4-set.",
        ),
      to_x: z
        .number()
        .optional()
        .describe(
          "Custom swipe end X. from_x/from_y/to_x/to_y must be provided as a complete 4-set.",
        ),
      to_y: z
        .number()
        .optional()
        .describe(
          "Custom swipe end Y. from_x/from_y/to_x/to_y must be provided as a complete 4-set.",
        ),
      duration_ms: z
        .number()
        .optional()
        .default(200)
        .describe("Swipe duration (ms), clamped to [0, 10000]"),
      get_ui_after: z.boolean().optional().default(true),
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
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
      try {
        const dev = resolveDevice(device);
        await ensureDevice(dev);

        let fx = 0, fy = 0, tx = 0, ty = 0;

        if (
          from_x !== undefined &&
          from_y !== undefined &&
          to_x !== undefined &&
          to_y !== undefined
        ) {
          if (
            !Number.isFinite(from_x) || !Number.isFinite(from_y) ||
            !Number.isFinite(to_x)   || !Number.isFinite(to_y)
          ) {
            return {
              content: [{ type: "text" as const, text: `Invalid swipe coordinates: from=(${from_x},${from_y}) to=(${to_x},${to_y})` }],
              isError: true,
            };
          }
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
                text: "Either 'direction' or the full from_x/from_y/to_x/to_y 4-set is required.",
              },
            ],
            isError: true,
          };
        }

        const dur = clampInt(duration_ms, 0, 10000, 200);
        await adb(
          [
            "shell",
            "input",
            "swipe",
            String(Math.trunc(fx)),
            String(Math.trunc(fy)),
            String(Math.trunc(tx)),
            String(Math.trunc(ty)),
            String(dur),
          ],
          { device: dev },
        );

        const swipeMsg = `Swiped ${direction || "custom"}: (${fx},${fy}) -> (${tx},${ty})`;

        if (!get_ui_after) {
          return { content: [{ type: "text", text: swipeMsg }] };
        }

        await sleep(150);
        const xml = await dumpUI(dev);
        const tree = parseUIXml(xml, "visible");

        return {
          content: [
            { type: "text", text: `${swipeMsg}\n\nUI after:\n${tree.text}` },
          ],
        };
      } catch (err) {
        const msg =
          err instanceof AdbError || err instanceof DeviceNotConnectedError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          content: [{ type: "text" as const, text: msg }],
          isError: true,
        };
      }
    },
  );
}
