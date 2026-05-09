import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adb,
  adbShell,
  AdbError,
  DeviceNotConnectedError,
  dumpUI,
  ensureDevice,
  resolveDevice,
  sleep,
  getScreenSize,
} from "../adb.js";
import { findElementsInTree, parseXmlToTree, parseUIXml } from "../parsers/ui-parser.js";
import { centerOf, isZeroBounds } from "../utils/bounds.js";
import { coerceObject } from "../utils/coerce.js";
import { clampInt, validateKeycode } from "../utils/validators.js";

const actionSchema = z.object({
  action: z
    .enum(["tap", "find_and_tap", "type", "key", "swipe", "sleep", "shell"])
    .describe(
      "Action type. Note: batch action names ('type', 'key') differ from " +
        "their tool counterparts ('type_text', 'press_key').",
    ),
  // tap
  x: z.number().optional().describe("tap: X coordinate"),
  y: z.number().optional().describe("tap: Y coordinate"),
  // find_and_tap
  by: z
    .enum(["text", "id", "desc", "class"])
    .optional()
    .describe("find_and_tap: search criterion"),
  value: z
    .string()
    .optional()
    .describe("find_and_tap: search value (substring match unless `exact`)"),
  exact: z
    .boolean()
    .optional()
    .describe("find_and_tap: exact-match instead of substring (default false)"),
  // type
  text: z.string().optional().describe("type: text to send"),
  submit: z
    .boolean()
    .optional()
    .describe("type: press Enter after typing (default false)"),
  clear_first: z
    .boolean()
    .optional()
    .describe("type: clear focused field (Ctrl+A, Delete) before typing"),
  // key
  key: z.string().optional().describe("key: key name (BACK, HOME, ...) or numeric keycode"),
  // swipe
  direction: z
    .enum(["up", "down", "left", "right"])
    .optional()
    .describe("swipe: direction the finger moves on screen"),
  duration_ms: z
    .number()
    .optional()
    .describe("swipe: gesture duration in ms (clamped to [0,10000], default 200)"),
  // sleep
  ms: z
    .number()
    .optional()
    .describe("sleep: milliseconds to wait (clamped to [0,5000], default 300)"),
  // shell
  command: z.string().optional(),
});

const KEY_MAP: Record<string, string> = {
  BACK: "4", HOME: "3", ENTER: "66", TAB: "61",
  DELETE: "67", DEL: "67", SPACE: "62",
  DPAD_UP: "19", DPAD_DOWN: "20", DPAD_LEFT: "21", DPAD_RIGHT: "22",
};

const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;

async function clearFocusedField(device: string): Promise<void> {
  // See input.ts: `input keyevent A B C` does NOT chord; use keycombination
  // for Ctrl+A, then DEL. keycombination requires API 31+.
  try {
    await adb(
      ["shell", "input", "keycombination", "113", "29"],
      { device },
    );
  } catch {
    // unsupported on older API levels; fall through to plain DEL
  }
  await adb(["shell", "input", "keyevent", "67"], { device });
}

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

export function registerBatchTool(server: McpServer): void {
  server.tool(
    "batch",
    "Execute multiple actions in sequence with a single tool call. Much faster than calling tools individually. Returns UI tree only once at the end.",
    {
      // Claude Code の一部ツール使用パスでは array 型引数が JSON 文字列で届くため string も受ける
      actions: z
        .union([z.array(actionSchema), z.string()])
        .describe(
          'Array of actions. Examples: [{"action":"find_and_tap","by":"text","value":"OK"}, {"action":"sleep","ms":300}, {"action":"swipe","direction":"up"}]',
        ),
      stop_on_error: z
        .boolean()
        .optional()
        .default(true)
        .describe("Stop batch on first error"),
      get_ui_after: z.boolean().optional().default(true),
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
    },
    async ({ actions: actionsRaw, stop_on_error, get_ui_after, device }) => {
      try {
        const coerced = coerceObject<z.infer<typeof actionSchema>[]>(actionsRaw);
        if (!coerced || !Array.isArray(coerced)) {
          return {
            content: [
              {
                type: "text",
                text: "actions must be an array (got string that failed to parse as JSON array)",
              },
            ],
            isError: true,
          };
        }
        const parsed = z.array(actionSchema).safeParse(coerced);
        if (!parsed.success) {
          return {
            content: [
              {
                type: "text",
                text: `actions validation failed: ${parsed.error.message}`,
              },
            ],
            isError: true,
          };
        }
        const actions = parsed.data;

        const dev = resolveDevice(device);
        await ensureDevice(dev);

        const log: string[] = [];
        let stopped = false;

        for (let i = 0; i < actions.length; i++) {
          if (stopped) break;
          const a = actions[i];
          if (!a) continue;
          try {
            switch (a.action) {
              case "tap": {
                if (a.x === undefined || a.y === undefined) {
                  log.push(`[${i}] tap: ERROR - x and y required`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
                  log.push(`[${i}] tap: ERROR - invalid coordinates x=${a.x}, y=${a.y}`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                const xs = String(Math.trunc(a.x));
                const ys = String(Math.trunc(a.y));
                await adb(["shell", "input", "tap", xs, ys], { device: dev });
                log.push(`[${i}] tap (${a.x},${a.y})`);
                break;
              }

              case "find_and_tap": {
                if (!a.by || !a.value) {
                  log.push(`[${i}] find_and_tap: ERROR - by and value required`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                const xml = await dumpUI(dev);
                const tree = parseXmlToTree(xml);
                const elements = findElementsInTree(tree, a.by, a.value, a.exact ?? false);
                if (elements.length === 0) {
                  log.push(`[${i}] find_and_tap: NOT FOUND ${a.by}="${a.value}"`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                // elements.length > 0 guarantees elements[0] exists.
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const el = elements[0]!;
                if (isZeroBounds(el.bounds)) {
                  log.push(
                    `[${i}] find_and_tap: ZERO BOUNDS ${a.by}="${a.value}" (not visible)`,
                  );
                  if (stop_on_error) stopped = true;
                  break;
                }
                const [cx, cy] = centerOf(el.bounds);
                const cxs = String(Math.trunc(cx));
                const cys = String(Math.trunc(cy));
                await adb(["shell", "input", "tap", cxs, cys], { device: dev });
                log.push(`[${i}] find_and_tap ${a.by}="${a.value}" -> (${cx},${cy})`);
                break;
              }

              case "type": {
                if (a.text === undefined) {
                  log.push(`[${i}] type: ERROR - text required`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                if (a.clear_first) {
                  await clearFocusedField(dev);
                }
                const isAscii = ASCII_PRINTABLE_RE.test(a.text);
                if (isAscii) {
                  // Escape "%" first so it is not misread as "%s" (space) by Android.
                  const escaped = a.text.replace(/%/g, "%%").replace(/ /g, "%s");
                  await adb(["shell", "input", "text", escaped], {
                    device: dev,
                  });
                } else {
                  const hasAdbKeyboard = await isAdbKeyboardInstalled(dev);
                  if (!hasAdbKeyboard) {
                    log.push(
                      `[${i}] type: ERROR - non-ASCII requires ADBKeyBoard IME (com.android.adbkeyboard) installed and selected on device`,
                    );
                    if (stop_on_error) stopped = true;
                    break;
                  }
                  // ADBKeyBoard reads the `msg` extra as a literal string,
                  // so a value beginning with "--" is *not* re-interpreted
                  // as another `am` flag here. The shape of the argv list
                  // (with `--es msg` immediately preceding the value) is
                  // what matters; `--` would be redundant.
                  await adb(
                    [
                      "shell",
                      "am",
                      "broadcast",
                      "-a",
                      "ADB_INPUT_TEXT",
                      "--es",
                      "msg",
                      a.text,
                    ],
                    { device: dev },
                  );
                }
                if (a.submit) {
                  await adb(["shell", "input", "keyevent", "66"], {
                    device: dev,
                  });
                }
                log.push(`[${i}] type "${a.text}"${a.submit ? " + Enter" : ""}`);
                break;
              }

              case "key": {
                if (!a.key) {
                  log.push(`[${i}] key: ERROR - key required`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                const upper = a.key.toUpperCase();
                const mapped = KEY_MAP[upper];
                const candidate = mapped !== undefined ? mapped : a.key;
                const keycode = validateKeycode(candidate);
                if (keycode === null) {
                  log.push(`[${i}] key: ERROR - invalid key "${a.key}"`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                await adb(["shell", "input", "keyevent", keycode], {
                  device: dev,
                });
                log.push(`[${i}] key ${a.key}`);
                break;
              }

              case "swipe": {
                if (!a.direction) {
                  log.push(`[${i}] swipe: ERROR - direction required`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                const size = await getScreenSize(dev);
                const cx = Math.round(size.width / 2);
                const cy = Math.round(size.height / 2);
                const dy = Math.round(size.height * 0.3);
                const dx = Math.round(size.width * 0.3);
                let fx = 0, fy = 0, tx = 0, ty = 0;
                switch (a.direction) {
                  case "up":
                    fx = cx; fy = cy + dy; tx = cx; ty = cy - dy; break;
                  case "down":
                    fx = cx; fy = cy - dy; tx = cx; ty = cy + dy; break;
                  case "left":
                    fx = cx + dx; fy = cy; tx = cx - dx; ty = cy; break;
                  case "right":
                    fx = cx - dx; fy = cy; tx = cx + dx; ty = cy; break;
                }
                const dur = clampInt(a.duration_ms ?? 200, 0, 10000, 200);
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
                log.push(`[${i}] swipe ${a.direction}`);
                break;
              }

              case "sleep": {
                const ms = clampInt(a.ms !== undefined ? a.ms : 300, 0, 5000, 300);
                await sleep(ms);
                log.push(`[${i}] sleep ${ms}ms`);
                break;
              }

              case "shell": {
                if (!a.command) {
                  log.push(`[${i}] shell: ERROR - command required`);
                  if (stop_on_error) stopped = true;
                  break;
                }
                const output = await adbShell(a.command, dev);
                log.push(`[${i}] shell: ${output.trim().slice(0, 200)}`);
                break;
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.push(`[${i}] ${a.action}: ERROR - ${msg}`);
            if (stop_on_error) stopped = true;
          }
        }

        let uiText = "";
        if (get_ui_after) {
          await sleep(200);
          const xml = await dumpUI(dev);
          const tree = parseUIXml(xml, "visible");
          uiText = `\n\nUI:\n${tree.text}`;
        }

        return {
          content: [
            {
              type: "text",
              text: `Batch (${actions.length} actions):\n${log.join("\n")}${uiText}`,
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
