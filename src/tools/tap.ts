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
} from "../adb.js";
import { parseUIXml } from "../parsers/ui-parser.js";
import { clampInt } from "../utils/validators.js";

export function registerTapTool(server: McpServer): void {
  server.tool(
    "tap",
    "Tap at specific screen coordinates. Optionally returns updated UI tree.",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      long_press: z.boolean().optional().default(false),
      wait_ms: z
        .number()
        .optional()
        .default(200)
        .describe("Wait after tap (ms)"),
      get_ui_after: z
        .boolean()
        .optional()
        .default(true)
        .describe("Return UI tree after tap (set false for speed)"),
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
    },
    async ({ x, y, long_press, wait_ms, get_ui_after, device }) => {
      try {
        const dev = resolveDevice(device);
        await ensureDevice(dev);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return {
            content: [{ type: "text" as const, text: `Invalid coordinates: x=${x}, y=${y}` }],
            isError: true,
          };
        }
        const xs = String(Math.trunc(x));
        const ys = String(Math.trunc(y));

        if (long_press) {
          await adb(
            ["shell", "input", "swipe", xs, ys, xs, ys, "1000"],
            { device: dev },
          );
        } else {
          await adb(["shell", "input", "tap", xs, ys], { device: dev });
        }

        const tapMsg = `Tapped (${x}, ${y})${long_press ? " (long press)" : ""}`;

        if (!get_ui_after) {
          return { content: [{ type: "text", text: tapMsg }] };
        }

        const waitTime = clampInt(wait_ms, 0, 5000, 200);
        if (waitTime > 0) await sleep(waitTime);

        const xml = await dumpUI(dev);
        const tree = parseUIXml(xml, "visible");

        return {
          content: [
            { type: "text", text: `${tapMsg}\n\nUI after tap:\n${tree.text}` },
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
