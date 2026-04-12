import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { adbExecOut, ensureDevice, resolveDevice, getAdbPath } from "../adb.js";

async function compressWithFfmpeg(
  pngBuffer: Buffer,
  maxWidth: number,
  quality: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const qv = Math.max(2, Math.min(31, Math.round(31 - quality * 0.29)));
    const proc = execFile(
      "ffmpeg",
      [
        "-i",
        "pipe:0",
        "-vf",
        `scale=${maxWidth}:-1`,
        "-q:v",
        String(qv),
        "-f",
        "mjpeg",
        "pipe:1",
      ],
      {
        encoding: "buffer" as any,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout as unknown as Buffer);
      },
    );
    proc.stdin?.write(pngBuffer);
    proc.stdin?.end();
  });
}

async function captureRawPng(device: string): Promise<Buffer> {
  return adbExecOut(["screencap", "-p"], device);
}

export function registerScreenshotTool(server: McpServer): void {
  server.tool(
    "screenshot",
    "Take a screenshot of the device screen. Use only when UI tree is insufficient (games, canvas, visual verification). Returns a compressed JPEG image.",
    {
      quality: z
        .number()
        .optional()
        .default(40)
        .describe("JPEG quality 1-100 (default 40)"),
      max_width: z
        .number()
        .optional()
        .default(360)
        .describe("Max width in pixels (default 360)"),
      device: z.string().optional(),
    },
    async ({ quality, max_width, device }) => {
      const dev = resolveDevice(device);
      await ensureDevice(dev);

      const pngBuffer = await captureRawPng(dev);

      let jpegBuffer: Buffer;
      try {
        jpegBuffer = await compressWithFfmpeg(pngBuffer, max_width, quality);
      } catch {
        // ffmpeg not available, return raw PNG as base64
        const base64 = pngBuffer.toString("base64");
        return {
          content: [
            {
              type: "image" as const,
              data: base64,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text: `Screenshot: raw PNG, ${Math.round(pngBuffer.length / 1024)}KB (ffmpeg not available for compression)`,
            },
          ],
        };
      }

      const base64 = jpegBuffer.toString("base64");
      return {
        content: [
          {
            type: "image" as const,
            data: base64,
            mimeType: "image/jpeg",
          },
          {
            type: "text" as const,
            text: `Screenshot: JPEG q=${quality}, max_width=${max_width}, ${Math.round(jpegBuffer.length / 1024)}KB`,
          },
        ],
      };
    },
  );
}
