import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adb,
  adbShell,
  AdbError,
  DeviceNotConnectedError,
  ensureDevice,
  resolveDevice,
  sleep,
  dumpUI,
} from "../adb.js";
import { parseUIXml } from "../parsers/ui-parser.js";
import { validateKeycode } from "../utils/validators.js";

const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;

async function isAdbKeyboardInstalled(device: string): Promise<boolean> {
  try {
    const out = await adbShell(
      "pm list packages com.android.adbkeyboard",
      device,
    );
    return /package:com\.android\.adbkeyboard/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Clear the focused field via Ctrl+A + DEL.
 * `input keyevent KEYCODE_CTRL_LEFT KEYCODE_A KEYCODE_DEL` does NOT produce
 * a Ctrl+A combo — `input keyevent` sends each token as a sequential discrete
 * keyevent. Use `input keycombination 113 29` for the actual chord, then DEL.
 *
 * Note: `keycombination` requires API 31+. On older API levels this command
 * exits with non-zero; in that case we fall back to plain DEL, which is the
 * safest non-destructive option.
 */
async function clearFocusedField(device: string): Promise<void> {
  try {
    await adb(
      ["shell", "input", "keycombination", "113", "29"],
      { device },
    );
  } catch {
    // keycombination unsupported (pre-API-31); skip the select-all step
  }
  await adb(["shell", "input", "keyevent", "67"], { device }); // KEYCODE_DEL
}

export function registerTypeTextTool(server: McpServer): void {
  server.tool(
    "type_text",
    "Type text into the currently focused input field. ASCII text is sent via 'input text' directly. Non-ASCII (Japanese etc.) requires the ADBKeyBoard IME (com.android.adbkeyboard) to be installed and selected on the device — otherwise this tool returns an error for non-ASCII input.",
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
      get_ui_after: z
        .boolean()
        .optional()
        .default(true)
        .describe("Return UI tree after typing"),
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
    },
    async ({ text, clear_first, submit, get_ui_after, device }) => {
      try {
        const dev = resolveDevice(device);
        await ensureDevice(dev);

        if (clear_first) {
          await clearFocusedField(dev);
        }

        const isAscii = ASCII_PRINTABLE_RE.test(text);

        if (isAscii) {
          // Pass text as argv so the device-side shell does not re-parse it.
          // Android's `input text` decodes "%s" → space and "%%" → "%", so
          // we must escape literal "%" first, then substitute spaces.
          const escaped = text.replace(/%/g, "%%").replace(/ /g, "%s");
          await adb(["shell", "input", "text", escaped], { device: dev });
        } else {
          // Non-ASCII: only ADBKeyBoard is supported. The previous clipper /
          // file-based fallbacks were broken (xargs put the text as a
          // positional arg of `am`, not the value of `-e text`; the file
          // fallback never copied to clipboard so PASTE pasted stale data).
          const hasAdbKeyboard = await isAdbKeyboardInstalled(dev);
          if (!hasAdbKeyboard) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Non-ASCII input requires the ADBKeyBoard IME " +
                    "(com.android.adbkeyboard) to be installed and selected " +
                    "on the device. Install it from " +
                    "https://github.com/senzhk/ADBKeyBoard and select it via " +
                    "Settings > System > Languages & input > On-screen keyboard.",
                },
              ],
              isError: true,
            };
          }
          // Argv form: `text` is the value of `--es msg`, not re-parsed by
          // sh. ADBKeyBoard reads it as a literal string extra, so even a
          // value starting with "--" is not parsed as another `am` flag.
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
        }

        if (submit) {
          await adb(["shell", "input", "keyevent", "66"], { device: dev }); // KEYCODE_ENTER
        }

        const typedMsg = `Typed: "${text}"${submit ? " + Enter" : ""}`;

        if (!get_ui_after) {
          return { content: [{ type: "text", text: typedMsg }] };
        }

        await sleep(200);
        const xml = await dumpUI(dev);
        const tree = parseUIXml(xml, "visible");

        return {
          content: [
            {
              type: "text",
              text: `${typedMsg}\n\nUI after:\n${tree.text}`,
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
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
  SPACE: "62",
  SEARCH: "84",
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
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
    },
    async ({ key, device }) => {
      try {
        const dev = resolveDevice(device);
        await ensureDevice(dev);

        const upper = key.toUpperCase();
        const mapped = KEY_MAP[upper];
        const candidate = mapped !== undefined ? mapped : key;
        const keycode = validateKeycode(candidate);
        if (keycode === null) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Invalid key: ${key}. Must be a known key name (${Object.keys(KEY_MAP).join(", ")}) ` +
                  `or a positive integer keycode.`,
              },
            ],
            isError: true,
          };
        }
        await adb(["shell", "input", "keyevent", keycode], { device: dev });

        return {
          content: [
            { type: "text", text: `Pressed: ${key} (keycode ${keycode})` },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

function toolError(err: unknown) {
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
