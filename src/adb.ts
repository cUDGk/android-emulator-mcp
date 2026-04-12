import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 15_000;

const adbPath: string = process.env.ADB_PATH || "adb";
const emulatorPath: string = process.env.EMULATOR_PATH || "emulator";
const defaultDevice: string = process.env.DEFAULT_DEVICE || "emulator-5554";

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

// ─── Errors ───

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

// ─── Core ADB ───

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
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: cleanOutput(result.stdout),
      stderr: cleanOutput(result.stderr || ""),
    };
  } catch (err: any) {
    if (err.killed) {
      throw new AdbError(
        `ADB timed out (${options?.timeout ?? DEFAULT_TIMEOUT}ms): adb ${fullArgs.join(" ")}`,
      );
    }
    if (err.code === "ENOENT") {
      throw new AdbError(
        `ADB not found at '${adbPath}'. Set ADB_PATH environment variable.`,
      );
    }
    const detail = cleanOutput(err.stderr || err.message || "unknown error");
    const exitCode = err.code != null ? ` (exit ${err.code})` : "";
    throw new AdbError(
      `ADB failed${exitCode}: adb ${fullArgs.join(" ")}\n${detail}`,
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

/**
 * Capture binary output from ADB using spawn (no maxBuffer limit, no type hacks).
 * Safer than execFile with encoding:"buffer" on Windows.
 */
export async function adbExecOut(
  args: string[],
  device?: string,
  timeout: number = 30_000,
): Promise<Buffer> {
  const fullArgs = device
    ? ["-s", device, "exec-out", ...args]
    : ["exec-out", ...args];

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(adbPath, fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new AdbError(`exec-out timed out (${timeout}ms): ${args.join(" ")}`));
    }, timeout);

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && chunks.length === 0) {
        return reject(new AdbError(`exec-out failed (exit ${code}): ${args.join(" ")}`));
      }
      resolve(Buffer.concat(chunks));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new AdbError(`exec-out error: ${err.message}`));
    });
  });
}

// ─── Device verification (per-device cache) ───

const deviceCache = new Map<string, number>();
const DEVICE_CACHE_TTL = 30_000;

export async function ensureDevice(device: string): Promise<void> {
  const now = Date.now();
  const cached = deviceCache.get(device);
  if (cached && now - cached < DEVICE_CACHE_TTL) return;

  const result = await adb(["devices"]);
  const lines = result.stdout.trim().split("\n").slice(1);
  const found = lines.some(
    (l) => l.startsWith(device) && l.includes("device"),
  );
  if (!found) {
    deviceCache.delete(device);
    throw new DeviceNotConnectedError(device);
  }
  deviceCache.set(device, now);
}

export function invalidateDeviceCache(device?: string): void {
  if (device) {
    deviceCache.delete(device);
  } else {
    deviceCache.clear();
  }
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

// ─── Screen size cache (per-device) ───

const screenSizeMap = new Map<string, { width: number; height: number }>();

export async function getScreenSize(
  device: string,
): Promise<{ width: number; height: number }> {
  const cached = screenSizeMap.get(device);
  if (cached) return cached;
  const output = await adbShell("wm size", device);
  const m = output.match(/(\d+)x(\d+)/);
  if (!m) return { width: 720, height: 1280 };
  const size = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  screenSizeMap.set(device, size);
  return size;
}

export function clearScreenSizeCache(device?: string): void {
  if (device) {
    screenSizeMap.delete(device);
  } else {
    screenSizeMap.clear();
  }
}

// ─── UI Dump with mutex (prevents concurrent uiautomator calls) ───

let dumpLock: Promise<string> | null = null;

export async function dumpUI(device: string): Promise<string> {
  // Serialize concurrent dump requests
  if (dumpLock) {
    try {
      return await dumpLock;
    } catch {
      // Previous dump failed, try our own
    }
  }

  const promise = dumpUIInternal(device);
  dumpLock = promise;

  try {
    const result = await promise;
    return result;
  } finally {
    if (dumpLock === promise) dumpLock = null;
  }
}

async function dumpUIInternal(device: string): Promise<string> {
  // Fast path: direct stdout via exec-out (single round-trip)
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
  } catch (err: any) {
    // If device disconnected, fail fast
    if (err.message?.includes("device") && err.message?.includes("not found")) {
      invalidateDeviceCache(device);
      throw err;
    }
  }

  // Slow fallback: file-based (two round-trips), exponential backoff
  const path = "/data/local/tmp/ui_dump.xml";
  const delays = [300, 600, 1200];

  for (let attempt = 0; attempt < 3; attempt++) {
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
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
      }
    }
  }

  throw new AdbError(
    "Failed to dump UI hierarchy after 3 attempts. Screen may be animating or transitioning.",
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
