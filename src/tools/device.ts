import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import {
  adb,
  adbShell,
  listDevices,
  resolveDevice,
  getEmulatorPath,
  sleep,
  clearScreenSizeCache,
  invalidateDeviceCache,
} from "../adb.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function listAvds(): Promise<string[]> {
  try {
    const result = await execFileAsync(getEmulatorPath(), ["-list-avds"], {
      timeout: 10_000,
      windowsHide: true,
    });
    return result.stdout
      .replace(/\r\n/g, "\n")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function registerDeviceTool(server: McpServer): void {
  server.tool(
    "device",
    "Manage Android devices and emulators. Actions: list, info, start_emulator, kill_emulator, launch_app, force_stop, install_apk, list_avds",
    {
      action: z
        .enum([
          "list",
          "info",
          "start_emulator",
          "kill_emulator",
          "launch_app",
          "force_stop",
          "install_apk",
          "list_avds",
        ])
        .describe("Action to perform"),
      avd_name: z
        .string()
        .optional()
        .describe("AVD name (for start_emulator)"),
      package_name: z
        .string()
        .optional()
        .describe("Package name (for launch_app, force_stop)"),
      apk_path: z
        .string()
        .optional()
        .describe("APK file path (for install_apk)"),
      device: z.string().optional(),
    },
    async ({ action, avd_name, package_name, apk_path, device }) => {
      switch (action) {
        case "list": {
          const devices = await listDevices();
          if (devices.length === 0) {
            const avds = await listAvds();
            return {
              content: [
                {
                  type: "text",
                  text: `No devices connected.\n\nAvailable AVDs: ${avds.length > 0 ? avds.join(", ") : "none"}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Connected devices:\n${devices.map((d) => `  ${d.serial} [${d.status}]`).join("\n")}`,
              },
            ],
          };
        }

        case "list_avds": {
          const avds = await listAvds();
          return {
            content: [
              {
                type: "text",
                text:
                  avds.length > 0
                    ? `Available AVDs:\n${avds.map((a) => `  - ${a}`).join("\n")}`
                    : "No AVDs found.",
              },
            ],
          };
        }

        case "info": {
          const dev = resolveDevice(device);
          const [model, version, sdk, density, size] = await Promise.all([
            adbShell("getprop ro.product.model", dev).catch(() => "unknown"),
            adbShell("getprop ro.build.version.release", dev).catch(
              () => "unknown",
            ),
            adbShell("getprop ro.build.version.sdk", dev).catch(
              () => "unknown",
            ),
            adbShell("wm density", dev).catch(() => "unknown"),
            adbShell("wm size", dev).catch(() => "unknown"),
          ]);
          return {
            content: [
              {
                type: "text",
                text: `Device: ${dev}\nModel: ${model.trim()}\nAndroid: ${version.trim()} (SDK ${sdk.trim()})\nScreen: ${size.trim()}, ${density.trim()}`,
              },
            ],
          };
        }

        case "start_emulator": {
          if (!avd_name) {
            const avds = await listAvds();
            return {
              content: [
                {
                  type: "text",
                  text: `avd_name is required.\n\nAvailable AVDs: ${avds.join(", ") || "none"}`,
                },
              ],
              isError: true,
            };
          }

          // Check if already running
          const existing = await listDevices();
          const running = existing.find((d) => d.status === "device");
          if (running) {
            return {
              content: [
                {
                  type: "text",
                  text: `Emulator already running: ${running.serial}`,
                },
              ],
            };
          }

          // Note: detached:true on Windows spawns a visible console window.
          // Using detached:false + unref() keeps the emulator GUI but hides console.
          const child = spawn(
            getEmulatorPath(),
            [
              "-avd",
              avd_name,
              "-no-audio",
              "-no-boot-anim",
              "-gpu",
              "auto",
            ],
            { detached: false, stdio: "ignore", windowsHide: true },
          );
          child.unref();

          // Wait for device
          await adb(["wait-for-device"], { timeout: 60_000 });

          // Wait for boot
          const start = Date.now();
          while (Date.now() - start < 120_000) {
            const prop = await adbShell("getprop sys.boot_completed").catch(
              () => "",
            );
            if (prop.trim() === "1") break;
            await sleep(2000);
          }

          clearScreenSizeCache();
          invalidateDeviceCache();

          // Check if boot actually completed
          const bootProp = await adbShell("getprop sys.boot_completed").catch(() => "");
          const bootOk = bootProp.trim() === "1";
          const bootTime = Math.round((Date.now() - start) / 1000);

          return {
            content: [
              {
                type: "text",
                text: bootOk
                  ? `Emulator '${avd_name}' started. Boot time: ${bootTime}s`
                  : `WARNING: Emulator '${avd_name}' started but boot may not be complete (${bootTime}s elapsed). Try again shortly.`,
              },
            ],
          };
        }

        case "kill_emulator": {
          const dev = resolveDevice(device);
          await adb(["-s", dev, "emu", "kill"]).catch(() => {});
          clearScreenSizeCache(dev);
          invalidateDeviceCache(dev);
          return {
            content: [{ type: "text", text: `Emulator ${dev} killed.` }],
          };
        }

        case "launch_app": {
          if (!package_name) {
            return {
              content: [
                { type: "text", text: "package_name is required." },
              ],
              isError: true,
            };
          }
          const dev = resolveDevice(device);
          await adb(
            [
              "shell",
              "monkey",
              "-p",
              package_name,
              "-c",
              "android.intent.category.LAUNCHER",
              "1",
            ],
            { device: dev },
          );
          return {
            content: [
              { type: "text", text: `Launched: ${package_name}` },
            ],
          };
        }

        case "force_stop": {
          if (!package_name) {
            return {
              content: [
                { type: "text", text: "package_name is required." },
              ],
              isError: true,
            };
          }
          const dev = resolveDevice(device);
          await adb(["shell", "am", "force-stop", package_name], {
            device: dev,
          });
          return {
            content: [
              { type: "text", text: `Force stopped: ${package_name}` },
            ],
          };
        }

        case "install_apk": {
          if (!apk_path) {
            return {
              content: [
                { type: "text", text: "apk_path is required." },
              ],
              isError: true,
            };
          }
          const dev = resolveDevice(device);
          const result = await adb(["install", "-r", apk_path], {
            device: dev,
            timeout: 120_000,
          });
          return {
            content: [
              {
                type: "text",
                text: `Install result: ${result.stdout.trim()}`,
              },
            ],
          };
        }

        default:
          return {
            content: [
              { type: "text", text: `Unknown action: ${action}` },
            ],
            isError: true,
          };
      }
    },
  );
}
