import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adb,
  adbShell,
  dumpUI,
  ensureDevice,
  resolveDevice,
  sleep,
  getScreenSize,
} from "../adb.js";
import { findElements, parseUIXml } from "../parsers/ui-parser.js";
import { centerOf } from "../utils/bounds.js";

const actionSchema = z.object({
  action: z
    .enum(["tap", "find_and_tap", "type", "key", "swipe", "sleep", "shell"])
    .describe("Action type"),
  // tap
  x: z.number().optional(),
  y: z.number().optional(),
  // find_and_tap
  by: z.enum(["text", "id", "desc", "class"]).optional(),
  value: z.string().optional(),
  // type
  text: z.string().optional(),
  submit: z.boolean().optional(),
  clear_first: z.boolean().optional(),
  // key
  key: z.string().optional(),
  // swipe
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  // sleep
  ms: z.number().optional(),
  // shell
  command: z.string().optional(),
});

const KEY_MAP: Record<string, string> = {
  BACK: "4", HOME: "3", ENTER: "66", TAB: "61",
  DELETE: "67", DEL: "67", SPACE: "62",
  DPAD_UP: "19", DPAD_DOWN: "20", DPAD_LEFT: "21", DPAD_RIGHT: "22",
};

export function registerBatchTool(server: McpServer): void {
  server.tool(
    "batch",
    "Execute multiple actions in sequence with a single tool call. Much faster than calling tools individually. Returns UI tree only once at the end.",
    {
      actions: z
        .array(actionSchema)
        .describe(
          'Array of actions. Examples: [{"action":"find_and_tap","by":"text","value":"OK"}, {"action":"sleep","ms":300}, {"action":"swipe","direction":"up"}]',
        ),
      get_ui_after: z.boolean().optional().default(true),
      device: z.string().optional(),
    },
    async ({ actions, get_ui_after, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const log: string[] = [];

      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        try {
          switch (a.action) {
            case "tap": {
              if (a.x === undefined || a.y === undefined) {
                log.push(`[${i}] tap: ERROR - x and y required`);
                break;
              }
              await adb(["shell", `input tap ${a.x} ${a.y}`], { device: dev });
              log.push(`[${i}] tap (${a.x},${a.y})`);
              break;
            }

            case "find_and_tap": {
              if (!a.by || !a.value) {
                log.push(`[${i}] find_and_tap: ERROR - by and value required`);
                break;
              }
              const xml = await dumpUI(dev);
              const elements = findElements(xml, a.by, a.value, false);
              if (elements.length === 0) {
                log.push(`[${i}] find_and_tap: NOT FOUND ${a.by}="${a.value}"`);
                break;
              }
              const [cx, cy] = centerOf(elements[0].bounds);
              await adb(["shell", `input tap ${cx} ${cy}`], { device: dev });
              log.push(
                `[${i}] find_and_tap ${a.by}="${a.value}" -> (${cx},${cy})`,
              );
              break;
            }

            case "type": {
              if (!a.text) {
                log.push(`[${i}] type: ERROR - text required`);
                break;
              }
              if (a.clear_first) {
                await adbShell("input keyevent KEYCODE_CTRL_LEFT KEYCODE_A", dev);
                await adbShell("input keyevent KEYCODE_DEL", dev);
              }
              const isAscii = /^[\x20-\x7E]+$/.test(a.text);
              if (isAscii) {
                const escaped = a.text.replace(/ /g, "%s");
                await adb(["shell", "input", "text", escaped], { device: dev });
              } else {
                await adb(
                  ["shell", "am", "broadcast", "-a", "ADB_INPUT_TEXT", "--es", "msg", a.text],
                  { device: dev },
                ).catch(async () => {
                  await adbShell(
                    `am broadcast -a clipper.set -e text '${a.text!.replace(/'/g, "'\\''")}'`,
                    dev,
                  );
                  await adb(["shell", "input keyevent 279"], { device: dev });
                });
              }
              if (a.submit) {
                await adb(["shell", "input keyevent KEYCODE_ENTER"], { device: dev });
              }
              log.push(`[${i}] type "${a.text}"${a.submit ? " + Enter" : ""}`);
              break;
            }

            case "key": {
              if (!a.key) {
                log.push(`[${i}] key: ERROR - key required`);
                break;
              }
              const keycode = KEY_MAP[a.key.toUpperCase()] || a.key;
              await adb(["shell", `input keyevent ${keycode}`], { device: dev });
              log.push(`[${i}] key ${a.key}`);
              break;
            }

            case "swipe": {
              if (!a.direction) {
                log.push(`[${i}] swipe: ERROR - direction required`);
                break;
              }
              const size = await getScreenSize(dev);
              const cx = Math.round(size.width / 2);
              const cy = Math.round(size.height / 2);
              const dy = Math.round(size.height * 0.3);
              const dx = Math.round(size.width * 0.3);
              let fx: number, fy: number, tx: number, ty: number;
              switch (a.direction) {
                case "up":    fx = cx; fy = cy + dy; tx = cx; ty = cy - dy; break;
                case "down":  fx = cx; fy = cy - dy; tx = cx; ty = cy + dy; break;
                case "left":  fx = cx + dx; fy = cy; tx = cx - dx; ty = cy; break;
                case "right": fx = cx - dx; fy = cy; tx = cx + dx; ty = cy; break;
              }
              await adb(["shell", `input swipe ${fx!} ${fy!} ${tx!} ${ty!} 200`], { device: dev });
              log.push(`[${i}] swipe ${a.direction}`);
              break;
            }

            case "sleep": {
              const ms = Math.min(a.ms || 300, 5000);
              await sleep(ms);
              log.push(`[${i}] sleep ${ms}ms`);
              break;
            }

            case "shell": {
              if (!a.command) {
                log.push(`[${i}] shell: ERROR - command required`);
                break;
              }
              const output = await adbShell(a.command, dev);
              log.push(`[${i}] shell: ${output.trim().slice(0, 200)}`);
              break;
            }
          }
        } catch (err: any) {
          log.push(`[${i}] ${a.action}: ERROR - ${err.message}`);
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
    },
  );
}
