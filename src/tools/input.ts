import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adb, adbShell, ensureDevice, resolveDevice, sleep, dumpUI } from "../adb.js";
import { parseUIXml } from "../parsers/ui-parser.js";

export function registerTypeTextTool(server: McpServer): void {
  server.tool(
    "type_text",
    "Type text into the currently focused input field. Supports ASCII directly; non-ASCII (Japanese etc.) uses clipboard paste.",
    {
      text: z.string().describe("Text to type"),
      clear_first: z.boolean().optional().default(false).describe("Clear the field before typing (Ctrl+A, Delete)"),
      submit: z.boolean().optional().default(false).describe("Press Enter after typing"),
      get_ui_after: z.boolean().optional().default(true).describe("Return UI tree after typing"),
      device: z.string().optional(),
    },
    async ({ text, clear_first, submit, get_ui_after, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      if (clear_first) {
        await adb(["shell", "input keyevent KEYCODE_CTRL_LEFT KEYCODE_A KEYCODE_DEL"], { device: dev });
      }

      const isAscii = /^[\x20-\x7E]+$/.test(text);

      if (isAscii) {
        const escaped = text.replace(/ /g, "%s");
        await adb(["shell", "input", "text", escaped], { device: dev });
      } else {
        // Non-ASCII: try ADBKeyBoard, then clipboard paste
        const broadcastResult = await adb(
          ["shell", "am", "broadcast", "-a", "ADB_INPUT_TEXT", "--es", "msg", text],
          { device: dev },
        ).catch(() => null);

        if (!broadcastResult || broadcastResult.stdout.includes("result=-1")) {
          // Clipboard paste fallback via base64
          const b64 = Buffer.from(text, "utf-8").toString("base64");
          await adbShell(
            `echo '${b64}' | base64 -d | xargs -0 am broadcast -a clipper.set -e text`,
            dev,
          ).catch(async () => {
            // Last resort: write to file, then use input
            await adbShell(`echo '${b64}' | base64 -d > /data/local/tmp/input_text.txt`, dev);
            await adb(["shell", "input keyevent 279"], { device: dev }); // PASTE
          });
          await adb(["shell", "input keyevent 279"], { device: dev });
        }
      }

      if (submit) {
        await adb(["shell", "input keyevent KEYCODE_ENTER"], { device: dev });
      }

      const typedMsg = `Typed: "${text}"${submit ? " + Enter" : ""}`;

      if (!get_ui_after) {
        return { content: [{ type: "text", text: typedMsg }] };
      }

      await sleep(200);
      const xml = await dumpUI(dev);
      const tree = parseUIXml(xml, "visible");

      return {
        content: [{ type: "text", text: `${typedMsg}\n\nUI after:\n${tree.text}` }],
      };
    },
  );
}

const KEY_MAP: Record<string, string> = {
  BACK: "4", HOME: "3", ENTER: "66", TAB: "61",
  DELETE: "67", DEL: "67", SPACE: "62", SEARCH: "84",
  DPAD_UP: "19", DPAD_DOWN: "20", DPAD_LEFT: "21", DPAD_RIGHT: "22", DPAD_CENTER: "23",
  VOLUME_UP: "24", VOLUME_DOWN: "25", POWER: "26",
  APP_SWITCH: "187", RECENTS: "187", MENU: "82", ESCAPE: "111",
};

export function registerPressKeyTool(server: McpServer): void {
  server.tool(
    "press_key",
    "Press a key button (BACK, HOME, ENTER, etc.)",
    {
      key: z.string().describe(`Key name or keycode number. Names: ${Object.keys(KEY_MAP).join(", ")}`),
      device: z.string().optional(),
    },
    async ({ key, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const keycode = KEY_MAP[key.toUpperCase()] || key;
      await adb(["shell", `input keyevent ${keycode}`], { device: dev });

      return {
        content: [{ type: "text", text: `Pressed: ${key} (keycode ${keycode})` }],
      };
    },
  );
}
