import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AdbError,
  DeviceNotConnectedError,
  dumpUI,
  ensureDevice,
  resolveDevice,
  adbShell,
} from "../adb.js";
import { parseUIXml } from "../parsers/ui-parser.js";
import { clampInt } from "../utils/validators.js";

export function registerUiTreeTool(server: McpServer): void {
  server.tool(
    "get_ui_tree",
    "Get the current screen state as structured text (replaces screenshot). Shows UI elements with their properties, positions, and hierarchy.",
    {
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
      filter: z
        .enum(["all", "visible", "interactive"])
        .optional()
        .default("visible")
        .describe(
          "Filter mode: visible (default), interactive (clickable elements only), all",
        ),
      max_depth: z
        .number()
        .optional()
        .default(15)
        .describe("Maximum tree depth"),
    },
    async ({ device, filter, max_depth }) => {
      try {
        const dev = resolveDevice(device);
        await ensureDevice(dev);

        const [xml, activity] = await Promise.all([
          dumpUI(dev),
          adbShell("dumpsys window | grep mCurrentFocus", dev).catch(
            () => "",
          ),
        ]);

        const depth = clampInt(max_depth, 1, 50, 15);
        const result = parseUIXml(xml, filter, depth);

        const activityMatch = activity.match(/mCurrentFocus=\S+\s+(\S+)/);
        const currentActivity = activityMatch?.[1] ?? "unknown";

        const header = `[activity=${currentActivity}]`;

        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${result.text}`,
            },
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
