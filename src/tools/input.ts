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
      clear_first: z
        .boolean()
        .optional()
        .default(false)
        .describe("Clear the field before typing (Ctrl+A, Delete)"),
      submit: z
        .boolean()
        .optional()
        .default(false)
        .describe("Press Enter after typing"),
      device: z.string().optional(),
    },
    async ({ text, clear_first, submit, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      if (clear_first) {
        // Select all + delete
        await adb(["shell", "input keyevent KEYCODE_CTRL_LEFT KEYCODE_A"], {
          device: dev,
        });
        await adb(["shell", "input keyevent KEYCODE_DEL"], { device: dev });
        await sleep(100);
      }

      const isAscii = /^[\x20-\x7E]+$/.test(text);

      if (isAscii) {
        // Escape special shell characters and spaces
        const escaped = text.replace(/ /g, "%s");
        await adb(["shell", "input", "text", escaped], { device: dev });
      } else {
        // Non-ASCII: use clipboard via am broadcast or content provider
        // First try ADBKeyBoard method
        try {
          await adb(
            [
              "shell",
              "am",
              "broadcast",
              "-a",
              "ADB_INPUT_TEXT",
              "--es",
              "msg",
              text,
            ],
            { device: dev },
          );
        } catch {
          // Fallback: set clipboard and paste
          // Use content command to set clipboard
          await adbShell(
            `am broadcast -a clipper.set -e text '${text.replace(/'/g, "'\\''")}'`,
            dev,
          );
          await adb(["shell", "input keyevent 279"], { device: dev }); // PASTE
        }
      }

      if (submit) {
        await sleep(100);
        await adb(["shell", "input keyevent KEYCODE_ENTER"], { device: dev });
      }

      await sleep(300);
      const xml = await dumpUI(dev);
      const tree = parseUIXml(xml, "visible");

      return {
        content: [
          {
            type: "text",
            text: `Typed: "${text}"${submit ? " + Enter" : ""}\n\nUI after:\n${tree.text}`,
          },
        ],
      };
    },
  );
}

const KEY_MAP: Record<string, string> = {
  BACK: "4",
  HOME: "3",
  ENTER: "66",
  TAB: "61",
  DELETE: "67",
  DEL: "67",
  DPAD_UP: "19",
  DPAD_DOWN: "20",
  DPAD_LEFT: "21",
  DPAD_RIGHT: "22",
  DPAD_CENTER: "23",
  VOLUME_UP: "24",
  VOLUME_DOWN: "25",
  POWER: "26",
  APP_SWITCH: "187",
  RECENTS: "187",
  MENU: "82",
  ESCAPE: "111",
  SPACE: "62",
  SEARCH: "84",
};

export function registerPressKeyTool(server: McpServer): void {
  server.tool(
    "press_key",
    "Press a key button (BACK, HOME, ENTER, etc.)",
    {
      key: z
        .string()
        .describe(
          `Key name or keycode number. Names: ${Object.keys(KEY_MAP).join(", ")}`,
        ),
      device: z.string().optional(),
    },
    async ({ key, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const keycode = KEY_MAP[key.toUpperCase()] || key;
      await adb(["shell", `input keyevent ${keycode}`], { device: dev });

      return {
        content: [
          {
            type: "text",
            text: `Pressed: ${key} (keycode ${keycode})`,
          },
        ],
      };
    },
  );
}
