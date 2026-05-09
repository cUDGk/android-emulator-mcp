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
import {
  parseXmlToTree,
  findElementsInTree,
  parseUIXml,
} from "../parsers/ui-parser.js";
import {
  centerOf,
  boundsToString,
  isZeroBounds,
} from "../utils/bounds.js";
import { clampInt } from "../utils/validators.js";

export function registerFindAndTapTool(server: McpServer): void {
  server.tool(
    "find_and_tap",
    "Find a UI element by text/id/desc/class and tap it. Returns element info and updated UI tree after tap.",
    {
      by: z
        .enum(["text", "id", "desc", "class"])
        .describe("Search criterion"),
      value: z
        .string()
        .describe("Search value (substring match by default)"),
      exact: z.boolean().optional().default(false).describe("Exact match"),
      index: z
        .number()
        .optional()
        .default(0)
        .describe("Index when multiple matches (0-based)"),
      long_press: z.boolean().optional().default(false),
      wait_ms: z
        .number()
        .optional()
        .default(200)
        .describe("Wait after tap before re-dumping UI (ms, max 5000)"),
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
    async ({
      by,
      value,
      exact,
      index,
      long_press,
      wait_ms,
      get_ui_after,
      device,
    }) => {
      try {
        const dev = resolveDevice(device);
        await ensureDevice(dev);

        const xml = await dumpUI(dev);
        const tree = parseXmlToTree(xml);
        const elements = findElementsInTree(tree, by, value, exact);

        if (elements.length === 0) {
          const rendered = parseUIXml(tree, "visible");
          return {
            content: [
              {
                type: "text",
                text: `Element not found: ${by}="${value}"\n\nCurrent UI:\n${rendered.text}`,
              },
            ],
            isError: true,
          };
        }

        if (index >= elements.length) {
          return {
            content: [
              {
                type: "text",
                text: `Index ${index} out of range. Found ${elements.length} matches for ${by}="${value}":\n${elements
                  .map(
                    (e, i) =>
                      `  [${i}] ${e.className} t="${e.text}" ${boundsToString(e.bounds)}`,
                  )
                  .join("\n")}`,
              },
            ],
            isError: true,
          };
        }

        // elements[index] is guaranteed by the index >= elements.length check above.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const element = elements[index]!;
        const [cx, cy] = centerOf(element.bounds);

        if (isZeroBounds(element.bounds)) {
          const rendered = parseUIXml(tree, "visible");
          return {
            content: [
              {
                type: "text",
                text: `Element found but has zero bounds (not visible on screen): ${by}="${value}"\n\nCurrent UI:\n${rendered.text}`,
              },
            ],
            isError: true,
          };
        }

        const cxs = String(Math.trunc(cx));
        const cys = String(Math.trunc(cy));
        if (long_press) {
          await adb(
            ["shell", "input", "swipe", cxs, cys, cxs, cys, "1000"],
            { device: dev },
          );
        } else {
          await adb(["shell", "input", "tap", cxs, cys], { device: dev });
        }

        const matchInfo =
          elements.length > 1
            ? ` (${elements.length} matches, used index ${index})`
            : "";
        // Show the field that was actually matched against, not whichever
        // attribute happens to be non-empty first.
        const matchedValue =
          by === "text"
            ? element.text
            : by === "id"
              ? element.resourceId
              : by === "desc"
                ? element.contentDesc
                : element.className;
        const tapMsg = `Tapped: ${element.className} ${by}="${value}" (matched: ${matchedValue || "<empty>"}) at (${cx},${cy})${matchInfo}`;

        if (!get_ui_after) {
          return { content: [{ type: "text", text: tapMsg }] };
        }

        const waitTime = clampInt(wait_ms, 0, 5000, 200);
        if (waitTime > 0) await sleep(waitTime);

        const xmlAfter = await dumpUI(dev);
        const treeAfter = parseUIXml(xmlAfter, "visible");

        return {
          content: [
            {
              type: "text",
              text: `${tapMsg}\n\nUI after tap:\n${treeAfter.text}`,
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
