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
  } catch (err) {
    if (err instanceof AdbError) throw err;
    // execFile rejects with a NodeJS.ErrnoException-shaped object
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (e.killed) {
      throw new AdbError(
        `ADB timed out (${options?.timeout ?? DEFAULT_TIMEOUT}ms): adb ${fullArgs.join(" ")}`,
      );
    }
    if (e.code === "ENOENT") {
      throw new AdbError(
        `ADB not found at '${adbPath}'. Set ADB_PATH environment variable.`,
      );
    }
    const detail = cleanOutput(e.stderr || (err instanceof Error ? err.message : String(err)) || "unknown error");
    const exitCode = e.code != null ? ` (exit ${e.code})` : "";
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
    const stderrChunks: Buffer[] = [];
    const proc = spawn(adbPath, fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new AdbError(`exec-out timed out (${timeout}ms): ${args.join(" ")}`));
    }, timeout);

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    // Drain stderr so the child cannot deadlock when its stderr pipe fills.
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf-8").trim();
        const detail = stderrText.length > 0 ? `\n${stderrText}` : "";
        return reject(
          new AdbError(`exec-out failed (exit ${code}): ${args.join(" ")}${detail}`),
        );
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
  const found = lines.some((l) => {
    const [serial, status] = l.split("\t");
    return serial === device && status === "device";
  });
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
      return { serial: parts[0] ?? "", status: parts[1] ?? "unknown" };
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
  if (!m || m[1] === undefined || m[2] === undefined) {
    return { width: 720, height: 1280 };
  }
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

// ─── UI Dump with per-device mutex (prevents concurrent uiautomator calls) ───

const dumpLocks = new Map<string, Promise<string>>();

export async function dumpUI(device: string): Promise<string> {
  // Serialize concurrent dump requests *per device*. Different devices must
  // not share a lock or they will clobber each other's results.
  const existing = dumpLocks.get(device);
  if (existing) {
    try {
      return await existing;
    } catch {
      // Previous dump failed; fall through and start our own.
    }
  }

  // Install the lock *synchronously* before any await, otherwise concurrent
  // callers could race past the `dumpLocks.get()` check above and each kick
  // off their own dumpUIInternal() (defeating the mutex).
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  dumpLocks.set(device, promise);
  dumpUIInternal(device)
    .then(resolve, reject)
    .finally(() => {
      if (dumpLocks.get(device) === promise) dumpLocks.delete(device);
    });
  return await promise;
}

async function dumpUIInternal(device: string): Promise<string> {
  // Fast path: direct stdout via exec-out (single round-trip)
  let fastPathError: unknown = null;
  try {
    const result = await adb(
      ["exec-out", "uiautomator", "dump", "/dev/tty"],
      { device, timeout: 10_000 },
    );
    const xml = result.stdout;
    const end = xml.lastIndexOf("</hierarchy>");
    if (end !== -1) {
      return xml.slice(0, end + "</hierarchy>".length);
    }
    fastPathError = new AdbError(
      "uiautomator fast path returned no </hierarchy> terminator",
    );
  } catch (err) {
    fastPathError = err;
    // If device disconnected, fail fast
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("device") && msg.includes("not found")) {
      invalidateDeviceCache(device);
      throw err;
    }
  }

  // Slow fallback: file-based (two round-trips), exponential backoff.
  // Use a unique path per call so concurrent invocations on different
  // devices (or retries here) cannot read each other's stale dumps.
  const path = `/data/local/tmp/ui_dump_${Date.now()}_${Math.floor(Math.random() * 1e6)}.xml`;
  const delays = [300, 600, 1200];
  let lastSlowError: unknown = null;
  let result: AdbResult | null = null;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await adb(["shell", "uiautomator", "dump", path], {
          device,
          timeout: 10_000,
        });
        const r = await adb(["shell", "cat", path], { device });
        if (r.stdout.includes("<hierarchy")) {
          result = r;
          break;
        }
        lastSlowError = new AdbError(
          "uiautomator dump file did not contain <hierarchy>",
        );
      } catch (err) {
        lastSlowError = err;
      }
      const delay = delays[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  } finally {
    // Best-effort cleanup; ignore failures (file may not exist).
    adb(["shell", "rm", "-f", path], { device, timeout: 5_000 }).catch(() => {});
  }

  if (result) return result.stdout;

  const fastMsg =
    fastPathError instanceof Error ? fastPathError.message : String(fastPathError);
  const slowMsg =
    lastSlowError instanceof Error ? lastSlowError.message : String(lastSlowError);

  throw new AdbError(
    `Failed to dump UI hierarchy after 3 attempts. Screen may be animating or transitioning.\n` +
      `fast-path error: ${fastMsg}\nslow-path error: ${slowMsg}`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
