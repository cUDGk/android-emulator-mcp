import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import {
  adbExecOut,
  AdbError,
  DeviceNotConnectedError,
  ensureDevice,
  resolveDevice,
} from "../adb.js";

async function compressWithFfmpeg(
  pngBuffer: Buffer,
  maxWidth: number,
  quality: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const qv = Math.max(2, Math.min(31, Math.round(31 - quality * 0.29)));
    // Use spawn so stdout is always a Buffer stream — no encoding-cast hacks.
    const proc = spawn(
      "ffmpeg",
      [
        "-i", "pipe:0",
        "-vf", `scale=${maxWidth}:-1`,
        "-q:v", String(qv),
        "-f", "mjpeg",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    // Drain stderr to prevent backpressure / deadlock.
    proc.stderr.on("data", () => {});

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${String(code)}`));
      }
      resolve(Buffer.concat(chunks));
    });

    proc.on("error", (err) => reject(err));

    // Suppress EPIPE on stdin in case ffmpeg exits before all input is written.
    proc.stdin.on("error", () => {});
    proc.stdin.write(pngBuffer);
    proc.stdin.end();
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
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(40)
        .describe("JPEG quality 1-100 (default 40)"),
      max_width: z
        .number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .default(360)
        .describe("Max width in pixels, 64-4096 (default 360)"),
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
    },
    async ({ quality, max_width, device }) => {
      try {
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
