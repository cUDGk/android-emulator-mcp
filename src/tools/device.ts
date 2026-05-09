import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { resolve as resolvePath, sep as PATH_SEP } from "node:path";
import { promisify } from "node:util";
import {
  adb,
  adbShell,
  AdbError,
  DeviceNotConnectedError,
  listDevices,
  resolveDevice,
  getEmulatorPath,
  sleep,
  clearScreenSizeCache,
  invalidateDeviceCache,
} from "../adb.js";
import {
  isValidAvdName,
  isValidPackageName,
} from "../utils/validators.js";

const execFileAsync = promisify(execFile);

/**
 * Sanitize a user-supplied string before echoing it back in an error message.
 * Strips control / non-printable bytes (so a malicious value can't smuggle
 * ANSI sequences or newlines into a tool response) and caps the length so a
 * pathological multi-MB input does not blow up the response.
 */
function sanitizeForMessage(s: string, maxLen = 80): string {
  return s.replace(/[^\x20-\x7E]/g, "?").slice(0, maxLen);
}

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
    "Manage Android devices and emulators.",
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
        .describe(
          "Actions: list/list_avds (no args), " +
            "info/kill_emulator (optional `device`), " +
            "start_emulator (avd_name), launch_app/force_stop (package_name), " +
            "install_apk (apk_path).",
        ),
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
      device: z
        .string()
        .optional()
        .describe(
          "Device serial (default: $DEFAULT_DEVICE or emulator-5554)",
        ),
    },
    async ({ action, avd_name, package_name, apk_path, device }) => {
      try {
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
            if (!isValidAvdName(avd_name)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid avd_name: ${sanitizeForMessage(avd_name)}. Must match [A-Za-z0-9._-]+ .`,
                  },
                ],
                isError: true,
              };
            }

            // Snapshot devices before launch so we can identify the new
            // emulator's serial via diff polling. On multi-device hosts an
            // unqualified `wait-for-device` returns immediately if *any*
            // existing device is reachable, so we skip it and rely on the
            // diff alone.
            const before = await listDevices();
            const beforeSet = new Set(
              before.filter((d) => d.status === "device").map((d) => d.serial),
            );

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

            // Wait for the *new* serial to appear (status=device). This is
            // strictly more useful than a global `wait-for-device` on hosts
            // with pre-existing devices.
            let newSerial: string | undefined;
            const pollDeadline = Date.now() + 60_000;
            while (Date.now() < pollDeadline) {
              const after = await listDevices();
              const candidate = after.find(
                (d) => d.status === "device" && !beforeSet.has(d.serial),
              );
              if (candidate) {
                newSerial = candidate.serial;
                break;
              }
              await sleep(1000);
            }

            // Wait for boot to complete on the specific new serial. If we
            // failed to identify a new serial, fall back to the default
            // device (best-effort).
            const targetDevice = newSerial ?? resolveDevice(device);
            const start = Date.now();
            while (Date.now() - start < 120_000) {
              const prop = await adbShell(
                "getprop sys.boot_completed",
                targetDevice,
              ).catch(() => "");
              if (prop.trim() === "1") break;
              await sleep(2000);
            }

            clearScreenSizeCache();
            invalidateDeviceCache();

            const bootProp = await adbShell(
              "getprop sys.boot_completed",
              targetDevice,
            ).catch(() => "");
            const bootOk = bootProp.trim() === "1";
            const bootTime = Math.round((Date.now() - start) / 1000);
            const serialNote = newSerial ? ` (serial=${newSerial})` : "";

            return {
              content: [
                {
                  type: "text",
                  text: bootOk
                    ? `Emulator '${avd_name}' started${serialNote}. Boot time: ${bootTime}s`
                    : `WARNING: Emulator '${avd_name}' started${serialNote} but boot may not be complete (${bootTime}s elapsed). Try again shortly.`,
                },
              ],
            };
          }

          case "kill_emulator": {
            const dev = resolveDevice(device);
            try {
              // Pass device via options so adb() prepends -s once. Avoid
              // duplicate -s flags that would result from both options.device
              // and a hardcoded -s in the args array.
              await adb(["emu", "kill"], { device: dev });
            } catch (err) {
              const msg =
                err instanceof Error ? err.message : String(err);
              return {
                content: [
                  {
                    type: "text",
                    text: `Failed to kill emulator ${dev}: ${msg}`,
                  },
                ],
                isError: true,
              };
            }
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
            if (!isValidPackageName(package_name)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid package_name: ${sanitizeForMessage(package_name)}. Must look like com.example.app.`,
                  },
                ],
                isError: true,
              };
            }
            const dev = resolveDevice(device);
            // package_name has been validated by isValidPackageName above
            // (must start with [a-zA-Z]), so it cannot be misread as a flag.
            const result = await adb(
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
            // monkey reports exit 0 even when the package has no LAUNCHER
            // activity or doesn't exist; the only signal is stderr/stdout.
            const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
            if (
              combined.includes("monkey aborted") ||
              combined.includes("no activities found") ||
              combined.includes("error: ") ||
              combined.includes("** error")
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Failed to launch ${package_name}:\n${result.stdout.trim()}\n${result.stderr.trim()}`.trim(),
                  },
                ],
                isError: true,
              };
            }
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
            if (!isValidPackageName(package_name)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid package_name: ${sanitizeForMessage(package_name)}. Must look like com.example.app.`,
                  },
                ],
                isError: true,
              };
            }
            const dev = resolveDevice(device);
            // package_name has been validated by isValidPackageName above.
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
            const absPath = resolvePath(apk_path);
            if (!absPath.toLowerCase().endsWith(".apk")) {
              return {
                content: [
                  {
                    type: "text",
                    text: `apk_path must end with .apk: ${absPath}`,
                  },
                ],
                isError: true,
              };
            }
            try {
              await access(absPath);
            } catch {
              return {
                content: [
                  {
                    type: "text",
                    text: `apk_path not found or unreadable: ${absPath}`,
                  },
                ],
                isError: true,
              };
            }
            // If APK_DIR is set, confine apk_path to that directory.
            // Resolve symlinks on both sides so a symlink inside APK_DIR can't
            // be used to escape the sandbox.
            const apkDirEnv = process.env.APK_DIR;
            if (apkDirEnv && apkDirEnv.trim().length > 0) {
              try {
                const realApk = await realpath(absPath);
                const realDir = await realpath(resolvePath(apkDirEnv));
                const sep = realDir.endsWith("/") || realDir.endsWith("\\") ? "" : PATH_SEP;
                if (
                  realApk !== realDir &&
                  !realApk.startsWith(realDir + sep)
                ) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `apk_path is outside APK_DIR (${realDir}): ${realApk}`,
                      },
                    ],
                    isError: true,
                  };
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Failed to resolve apk_path / APK_DIR: ${msg}`,
                    },
                  ],
                  isError: true,
                };
              }
            }
            const dev = resolveDevice(device);
            // `--` separates flags from the positional path so an APK path
            // beginning with `-` cannot be reinterpreted as a flag.
            const result = await adb(
              ["install", "-r", "--", absPath],
              { device: dev, timeout: 120_000 },
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Install result: ${result.stdout.trim()}`,
                },
              ],
            };
          }
        }
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
