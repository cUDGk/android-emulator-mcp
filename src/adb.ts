import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 15_000;

let adbPath: string = process.env.ADB_PATH || "adb";
let emulatorPath: string = process.env.EMULATOR_PATH || "emulator";
let defaultDevice: string = process.env.DEFAULT_DEVICE || "emulator-5554";

export function getAdbPath(): string {
  return adbPath;
}

export function getEmulatorPath(): string {
  return emulatorPath;
}

export function getDefaultDevice(): string {
  return defaultDevice;
}

export function resolveDevice(device?: string): string {
  return device || defaultDevice;
}

export class AdbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbError";
  }
}

export class DeviceNotConnectedError extends AdbError {
  constructor(device: string) {
    super(`No device connected: ${device}`);
    this.name = "DeviceNotConnectedError";
  }
}

export class ElementNotFoundError extends AdbError {
  public uiTree: string;
  constructor(selector: string, uiTree: string) {
    super(`Element not found: ${selector}`);
    this.name = "ElementNotFoundError";
    this.uiTree = uiTree;
  }
}

function cleanOutput(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

export interface AdbResult {
  stdout: string;
  stderr: string;
}

export async function adb(
  args: string[],
  options?: { device?: string; timeout?: number },
): Promise<AdbResult> {
  const fullArgs = options?.device
    ? ["-s", options.device, ...args]
    : args;

  try {
    const result = await execFileAsync(adbPath, fullArgs, {
      timeout: options?.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: cleanOutput(result.stdout),
      stderr: cleanOutput(result.stderr || ""),
    };
  } catch (err: any) {
    if (err.killed) {
      throw new AdbError(
        `ADB command timed out after ${options?.timeout ?? DEFAULT_TIMEOUT}ms: adb ${fullArgs.join(" ")}`,
      );
    }
    if (err.code === "ENOENT") {
      throw new AdbError(
        `ADB not found at '${adbPath}'. Set ADB_PATH environment variable.`,
      );
    }
    throw new AdbError(
      `ADB command failed: adb ${fullArgs.join(" ")}\n${cleanOutput(err.stderr || err.message)}`,
    );
  }
}

export async function adbShell(
  command: string,
  device?: string,
): Promise<string> {
  const result = await adb(["shell", command], { device });
  return result.stdout;
}

export async function adbExecOut(
  args: string[],
  device?: string,
): Promise<Buffer> {
  const fullArgs = device
    ? ["-s", device, "exec-out", ...args]
    : ["exec-out", ...args];

  return new Promise((resolve, reject) => {
    execFile(
      adbPath,
      fullArgs,
      {
        encoding: "buffer" as any,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        timeout: 30_000,
      },
      (err, stdout) => {
        if (err) return reject(new AdbError(`exec-out failed: ${err.message}`));
        resolve(stdout as unknown as Buffer);
      },
    );
  });
}

// Cached device check - only re-verify after errors
let deviceVerified = false;
let deviceVerifiedAt = 0;
const DEVICE_CACHE_TTL = 30_000; // 30s

export async function ensureDevice(device: string): Promise<void> {
  const now = Date.now();
  if (deviceVerified && now - deviceVerifiedAt < DEVICE_CACHE_TTL) return;

  const result = await adb(["devices"]);
  const lines = result.stdout.trim().split("\n").slice(1);
  const found = lines.some(
    (l) => l.startsWith(device) && l.includes("device"),
  );
  if (!found) {
    deviceVerified = false;
    throw new DeviceNotConnectedError(device);
  }
  deviceVerified = true;
  deviceVerifiedAt = now;
}

export function invalidateDeviceCache(): void {
  deviceVerified = false;
}

export async function listDevices(): Promise<
  Array<{ serial: string; status: string }>
> {
  const result = await adb(["devices"]);
  const lines = result.stdout.trim().split("\n").slice(1);
  return lines
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const parts = l.split("\t");
      return { serial: parts[0], status: parts[1] || "unknown" };
    });
}

let screenSizeCache: { width: number; height: number } | null = null;

export async function getScreenSize(
  device: string,
): Promise<{ width: number; height: number }> {
  if (screenSizeCache) return screenSizeCache;
  const output = await adbShell("wm size", device);
  const m = output.match(/(\d+)x(\d+)/);
  if (!m) return { width: 720, height: 1280 };
  screenSizeCache = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  return screenSizeCache;
}

export function clearScreenSizeCache(): void {
  screenSizeCache = null;
}

/**
 * Dump UI hierarchy. Uses single-command approach:
 * `uiautomator dump /dev/tty` outputs XML directly to stdout via exec-out,
 * saving a round-trip compared to dump-to-file + cat.
 * Falls back to file-based approach if direct dump fails.
 */
export async function dumpUI(device: string): Promise<string> {
  // Fast path: direct stdout dump via exec-out (single round-trip)
  try {
    const result = await adb(
      ["exec-out", "uiautomator", "dump", "/dev/tty"],
      { device, timeout: 10_000 },
    );
    const xml = result.stdout;
    const end = xml.lastIndexOf("</hierarchy>");
    if (end > 0) {
      return xml.slice(0, end + "</hierarchy>".length);
    }
  } catch {
    // fall through to file-based
  }

  // Slow fallback: file-based dump (two round-trips)
  const path = "/data/local/tmp/ui_dump.xml";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await adb(["shell", `uiautomator dump ${path}`], {
        device,
        timeout: 10_000,
      });
      const result = await adb(["shell", `cat ${path}`], { device });
      if (result.stdout.includes("<hierarchy")) {
        return result.stdout;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  throw new AdbError("Failed to dump UI hierarchy");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
