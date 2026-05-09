import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adbShell,
  AdbError,
  DeviceNotConnectedError,
  ensureDevice,
  resolveDevice,
} from "../adb.js";

export function registerShellTool(server: McpServer): void {
  server.tool(
    "shell",
    "Execute an arbitrary ADB shell command. Use only when no dedicated tool exists (tap/swipe/type_text/device etc). Output is truncated by ADB's buffer.",
    {
      command: z.string().describe("Shell command to execute"),
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
    },
    async ({ command, device }) => {
      try {
        const dev = resolveDevice(device);
        await ensureDevice(dev);

        const output = await adbShell(command, dev);

        return {
          content: [
            {
              type: "text",
              text: output || "(no output)",
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
