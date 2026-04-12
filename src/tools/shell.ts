import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adbShell, ensureDevice, resolveDevice } from "../adb.js";

export function registerShellTool(server: McpServer): void {
  server.tool(
    "shell",
    "Execute an arbitrary ADB shell command on the device and return the output.",
    {
      command: z.string().describe("Shell command to execute"),
      device: z.string().optional(),
    },
    async ({ command, device }) => {
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
    },
  );
}
