#!/usr/bin/env bun
// Runs an app's screenshot flow once per store size and accounts for every size in the report.
//   bun matrix.ts plan <app> [--platform ios|android] [--only a,b] [--root dir]
//   bun matrix.ts run  <app> [--platform ios|android] [--only a,b] [--root dir]
// Exit 0: every slot captured, derived, or not applicable. 2: a flow ran and failed. 3: UNVERIFIED,
// a slot could not run, with the blocker recorded. 1: this script crashed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkFlow } from "../../screenshot-flows/scripts/check.ts";
import { findBrowser, scaleHtml, screenshotHtml } from "./browser.ts";
import { pngInfo, stripAlpha } from "./png.ts";
import { acceptsSize, canDerive, SLOTS, slotById, type Size, type Slot } from "./slots.ts";

export interface AppConfig {
  appDir: string;
  account?: { email?: string; password?: string };
  matrix?: {
    flow?: string;
    ios?: { appId?: string; app?: string };
    android?: { appId?: string; apk?: string };
    // Oldest iOS the app runs on, so a simulator below it is never picked.
    minIos?: string;
    // Run per device before the flow, with APP, SLOT, PLATFORM, and DEVICE_ID set.
    prepare?: string;
  };
}

export interface StoreConfig {
  homeScreenTestId?: string;
  apps: Record<string, AppConfig>;
}

type Status = "captured" | "derived" | "failed" | "blocked" | "manual" | "not-applicable";

export interface Row {
  slot: string;
  label: string;
  required: boolean;
  status: Status;
  detail: string;
}

export interface Loaded {
  root: string;
  appKey: string;
  app: AppConfig;
  config: StoreConfig;
  appDir: string;
  flow: string;
  outDir: string;
}

export const parseArgs = (argv: string[]): { positional: string[]; flags: Record<string, string> } => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i] ?? "";
    else positional.push(argv[i]);
  }
  return { positional, flags };
};

export const loadApp = (appKey: string, rootFlag?: string): Loaded => {
  const root = resolve(rootFlag ?? process.env.STORE_ASSETS_ROOT ?? ".");
  const path = join(root, process.env.STORE_ASSETS_CONFIG ?? "storeAssets.config.json");
  if (!existsSync(path)) throw new Error(`no ${path}: run the screenshot-flows skill first`);
  const config = JSON.parse(readFileSync(path, "utf8")) as StoreConfig;
  const app = config.apps?.[appKey];
  if (!app) throw new Error(`no app "${appKey}" in ${path} (have: ${Object.keys(config.apps ?? {}).join(", ")})`);
  const appDir = join(root, app.appDir);
  return { root, appKey, app, config, appDir, flow: join(appDir, app.matrix?.flow ?? "maestro/screenshots.yaml"), outDir: join(appDir, "storeScreenshots") };
};

interface Expo {
  ios?: { bundleIdentifier?: string; supportsTablet?: boolean };
  android?: { package?: string };
}

const readExpo = (appDir: string): Expo => {
  const path = join(appDir, "app.json");
  return existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { expo?: Expo }).expo ?? {}) : {};
};

interface Shell {
  code: number;
  out: string;
}

const sh = (args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Shell => {
  const proc = Bun.spawnSync(args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs ?? 120_000 });
  return { code: proc.exitCode ?? 1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
};

const versionNumber = (version: string): number => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major * 100 + minor;
};

// simctl's minRuntimeVersion and maxRuntimeVersion pack x.y.z as 0xXXYYZZ.
const packed = (version: string): number => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major << 16) | (minor << 8);
};

class Blocked extends Error {}

const SIMCTL_CREATE_HINT = "install the runtime with `xcodebuild -downloadPlatform iOS`, or an older one in Xcode > Settings > Components";

// The newest installed runtime that runs a candidate device type, at or above the app's minimum.
export const pickSimulator = (slot: Slot, minIos?: string): { typeId: string; typeName: string; runtimeId: string } => {
  const types = JSON.parse(sh(["xcrun", "simctl", "list", "devicetypes", "-j"]).out) as { devicetypes: Array<{ name: string; identifier: string; minRuntimeVersion?: number; maxRuntimeVersion?: number }> };
  const runtimes = (JSON.parse(sh(["xcrun", "simctl", "list", "runtimes", "-j"]).out) as { runtimes: Array<{ identifier: string; version: string; isAvailable: boolean; platform?: string }> }).runtimes
    .filter((runtime) => runtime.isAvailable && (runtime.platform ?? "iOS") === "iOS" && (!minIos || versionNumber(runtime.version) >= versionNumber(minIos)))
    .sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
  for (const name of slot.simulators ?? []) {
    const type = types.devicetypes.find((candidate) => candidate.name === name);
    if (!type) continue;
    const runtime = runtimes.find((candidate) => packed(candidate.version) >= (type.minRuntimeVersion ?? 0) && packed(candidate.version) <= (type.maxRuntimeVersion ?? Number.MAX_SAFE_INTEGER));
    if (runtime) return { typeId: type.identifier, typeName: name, runtimeId: runtime.identifier };
  }
  throw new Blocked(`no installed simulator for ${(slot.simulators ?? []).join(" / ")}${minIos ? ` on iOS ${minIos}+` : ""}: ${SIMCTL_CREATE_HINT}`);
};

const simulatorFor = (slot: Slot, minIos?: string): string => {
  const pick = pickSimulator(slot, minIos);
  const name = `Store ${slot.id}`;
  const devices = JSON.parse(sh(["xcrun", "simctl", "list", "devices", "-j"]).out) as { devices: Record<string, Array<{ name: string; udid: string; isAvailable?: boolean }>> };
  const existing = devices.devices[pick.runtimeId]?.find((device) => device.name === name && device.isAvailable !== false);
  if (existing) return existing.udid;
  const created = sh(["xcrun", "simctl", "create", name, pick.typeId, pick.runtimeId]);
  if (created.code !== 0) throw new Blocked(`simctl create ${pick.typeName} failed: ${created.out.trim()}`);
  return created.out.trim();
};

const bootIos = (udid: string, load: Loaded): void => {
  const boot = sh(["xcrun", "simctl", "bootstatus", udid, "-b"], { timeoutMs: 300_000 });
  if (boot.code !== 0) throw new Blocked(`simulator would not boot: ${boot.out.trim().slice(-200)}`);
  sh(["xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"]);
  const build = load.app.matrix?.ios?.app;
  if (build) {
    const install = sh(["xcrun", "simctl", "install", udid, join(load.root, build)], { timeoutMs: 300_000 });
    if (install.code !== 0) throw new Blocked(`could not install ${build}: ${install.out.trim().slice(-200)}`);
  }
};

const androidDevice = (): string => {
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const line = sh(["adb", "devices"]).out.split("\n").slice(1).find((row) => /\tdevice\s*$/.test(row));
  if (!line) throw new Blocked("no Android device connected: start an emulator and check `adb devices`");
  return line.split("\t")[0];
};

const prepareAndroid = (serial: string, slot: Slot, load: Loaded): void => {
  const adb = (...args: string[]): Shell => sh(["adb", "-s", serial, ...args]);
  const [width, height] = slot.sizes[0];
  if (adb("shell", "wm", "size", `${width}x${height}`).code !== 0) throw new Blocked(`could not set the display to ${width}x${height}`);
  adb("shell", "wm", "density", String(slot.density));
  adb("shell", "settings", "put", "global", "sysui_demo_allowed", "1");
  const demo = (command: string, ...extras: string[]): Shell => adb("shell", "am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", command, ...extras);
  demo("enter");
  demo("clock", "-e", "hhmm", "0941");
  demo("battery", "-e", "level", "100", "-e", "plugged", "false");
  demo("network", "-e", "wifi", "show", "-e", "level", "4");
  demo("network", "-e", "mobile", "show", "-e", "datatype", "none", "-e", "level", "4");
  demo("notifications", "-e", "visible", "false");
  const apk = load.app.matrix?.android?.apk;
  if (apk) {
    const install = adb("install", "-r", join(load.root, apk));
    if (install.code !== 0) throw new Blocked(`could not install ${apk}: ${install.out.trim().slice(-200)}`);
  }
};

const resetAndroid = (serial: string): void => {
  for (const args of [["wm", "size", "reset"], ["wm", "density", "reset"], ["am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "exit"]]) sh(["adb", "-s", serial, "shell", ...args]);
};

export const maestroArgs = (device: string, outDir: string, flow: string, env: Record<string, string>): string[] => [
  "maestro",
  "--device",
  device,
  "test",
  "--test-output-dir",
  outDir,
  ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
  flow,
];

const flowEnv = (load: Loaded, slot: Slot, appId: string): Record<string, string> => {
  const email = process.env.SCREENSHOT_EMAIL ?? load.app.account?.email;
  const password = process.env.SCREENSHOT_PASSWORD ?? load.app.account?.password;
  return {
    APP_ID: appId,
    PLATFORM: slot.platform,
    DEVICE: slot.id,
    FORM: slot.form,
    HOME_SCREEN_ID: load.config.homeScreenTestId ?? "home-screen",
    ...(email ? { EMAIL: email } : {}),
    ...(password ? { PASSWORD: password } : {}),
  };
};

const findPngs = (dir: string): Map<string, string> => {
  const found = new Map<string, string>();
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) for (const [name, inner] of findPngs(path)) found.set(name, inner);
    else if (/^\d{2}-.*\.png$/.test(entry)) found.set(entry.slice(0, -4), path);
  }
  return found;
};

const collect = (slot: Slot, shots: string[], from: string, to: string): string => {
  const pngs = findPngs(from);
  const missing = shots.filter((shot) => !pngs.has(shot));
  if (missing.length > 0) throw new Error(`no image for ${missing.join(", ")}`);
  const prepared: Array<[string, Buffer]> = [];
  for (const shot of shots) {
    const file = readFileSync(pngs.get(shot) as string);
    const { width, height } = pngInfo(file);
    if (!acceptsSize(slot, width, height)) throw new Error(`${shot} is ${width}x${height}, and ${slot.label} accepts ${slot.sizes.map((s) => s.join("x")).join(", ")}`);
    prepared.push([`${shot}.png`, stripAlpha(file)]);
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const [name, data] of prepared) writeFileSync(join(to, name), data);
  const { width, height } = pngInfo(prepared[0][1]);
  return `${shots.length} shots at ${width}x${height}`;
};

const captureSlot = (load: Loaded, slot: Slot, shots: string[], appId: string): Row => {
  const row = (status: Status, detail: string): Row => ({ slot: slot.id, label: slot.label, required: slot.required, status, detail });
  const work = join(load.root, ".storeAssets", "matrix", slot.id);
  let device: string | undefined;
  try {
    if (slot.platform === "ios") {
      if (!Bun.which("xcrun")) throw new Blocked("no xcrun: iOS simulators need a Mac with Xcode");
      device = simulatorFor(slot, load.app.matrix?.minIos);
      bootIos(device, load);
    } else {
      if (!Bun.which("adb")) throw new Blocked("no adb: install the Android SDK platform-tools");
      device = androidDevice();
      prepareAndroid(device, slot, load);
    }
    if (!Bun.which("maestro")) throw new Blocked("no maestro on PATH: see https://docs.maestro.dev/getting-started/installing-maestro");
    const prepare = load.app.matrix?.prepare;
    if (prepare) {
      const ran = sh(["sh", "-c", prepare], { cwd: load.root, env: { APP: load.appKey, SLOT: slot.id, PLATFORM: slot.platform, DEVICE_ID: device }, timeoutMs: 1_800_000 });
      if (ran.code !== 0) throw new Blocked(`matrix.prepare exited ${ran.code}: ${ran.out.trim().slice(-300)}`);
    }
    // After prepare, which may be what installs the app.
    const installed = slot.platform === "ios" ? sh(["xcrun", "simctl", "get_app_container", device, appId]).code === 0 : sh(["adb", "-s", device, "shell", "pm", "path", appId]).out.includes("package:");
    if (!installed) throw new Blocked(`${appId} is not installed on ${device}: set matrix.${slot.platform === "ios" ? "ios.app" : "android.apk"}, or install it in matrix.prepare`);
    const out = join(work, "out");
    mkdirSync(work, { recursive: true });
    let attempt: Shell = { code: 1, out: "" };
    // Maestro's driver sometimes fails to start on a fresh device, so a flow gets one retry.
    for (let tries = 0; tries < 2 && attempt.code !== 0; tries++) {
      rmSync(out, { recursive: true, force: true });
      attempt = sh(maestroArgs(device, out, load.flow, flowEnv(load, slot, appId)), { timeoutMs: 1_200_000 });
      writeFileSync(join(work, "maestro.log"), attempt.out);
    }
    if (attempt.code !== 0) return row("failed", `flow failed, log ${join(work, "maestro.log")}: ${attempt.out.trim().slice(-300)}`);
    return row("captured", collect(slot, shots, out, join(load.outDir, slot.id)));
  } catch (error) {
    if (error instanceof Blocked) return row("blocked", error.message);
    return row("failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (device && slot.platform === "ios") sh(["xcrun", "simctl", "shutdown", device]);
    if (device && slot.platform === "android") resetAndroid(device);
  }
};

const firstSize = (load: Loaded, slotId: string): Size | undefined => {
  const dir = join(load.outDir, slotId);
  if (!existsSync(dir)) return undefined;
  const first = readdirSync(dir).find((name) => name.endsWith(".png"));
  if (!first) return undefined;
  const { width, height } = pngInfo(readFileSync(join(dir, first)));
  return [width, height];
};

// Fills a slot that could not run by scaling down a capture from this same run. A store does the
// same when a slot is empty, but this way the slot has its own images to compose banners from.
const deriveSlot = (load: Loaded, slot: Slot, shots: string[], usable: Set<string>): string | undefined => {
  const browser = findBrowser();
  if (!browser) return undefined;
  for (const source of slot.deriveFrom ?? []) {
    if (!usable.has(source)) continue;
    const size = firstSize(load, source);
    const target = size && slot.sizes.find((candidate) => canDerive(size, candidate));
    if (!target) continue;
    const to = join(load.outDir, slot.id);
    const work = join(load.root, ".storeAssets", "matrix", slot.id);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    mkdirSync(work, { recursive: true });
    for (const shot of shots) {
      const html = join(work, `${shot}.html`);
      const png = join(work, `${shot}.png`);
      writeFileSync(html, scaleHtml(join(load.outDir, source, `${shot}.png`), target[0], target[1]));
      screenshotHtml(browser, html, target[0], target[1], png);
      writeFileSync(join(to, `${shot}.png`), stripAlpha(readFileSync(png)));
    }
    return `${shots.length} shots at ${target.join("x")}, scaled from ${source}`;
  }
  return undefined;
};

export const coveragePath = (load: Loaded): string => join(load.outDir, "coverage.json");

const writeCoverage = (load: Loaded, rows: Row[]): Row[] => {
  const previous = existsSync(coveragePath(load)) ? (JSON.parse(readFileSync(coveragePath(load), "utf8")) as { rows: Row[] }).rows : [];
  // A filtered rerun replaces its own slots and keeps the rest.
  const merged = SLOTS.flatMap((slot) => rows.find((row) => row.slot === slot.id) ?? previous.find((row) => row.slot === slot.id) ?? []);
  mkdirSync(load.outDir, { recursive: true });
  writeFileSync(coveragePath(load), `${JSON.stringify({ rows: merged }, null, 2)}\n`);
  return merged;
};

const printTable = (rows: Row[]): void => {
  console.log("| Slot | Size class | Required | Result | Detail |\n| --- | --- | --- | --- | --- |");
  for (const row of rows) console.log(`| ${row.slot} | ${row.label} | ${row.required ? "yes" : "no"} | ${row.status} | ${row.detail.replaceAll("\n", " ").replaceAll("|", "\\|")} |`);
};

export const selectSlots = (flags: Record<string, string>): Slot[] => {
  const only = flags.only?.split(",").filter(Boolean);
  for (const id of only ?? []) if (!slotById(id)) throw new Error(`unknown slot ${id} (have: ${SLOTS.map((slot) => slot.id).join(", ")})`);
  return SLOTS.filter((slot) => (!flags.platform || slot.platform === flags.platform) && (!only || only.includes(slot.id)));
};

const notApplicable = (slot: Slot, expo: Expo): string | undefined => (slot.platform === "ios" && slot.form === "tablet" && expo.ios?.supportsTablet === false ? "app.json has supportsTablet: false, so the app is not listed for iPad" : undefined);

const appIdFor = (load: Loaded, expo: Expo, slot: Slot): string | undefined => (slot.platform === "ios" ? (load.app.matrix?.ios?.appId ?? expo.ios?.bundleIdentifier) : (load.app.matrix?.android?.appId ?? expo.android?.package));

const plan = (load: Loaded, slots: Slot[], expo: Expo): number => {
  for (const slot of slots) {
    const skip = slot.manual ?? notApplicable(slot, expo);
    const sizes = slot.sizes.map((size) => size.join("x")).join(" / ");
    if (skip) {
      console.log(`# ${slot.id} (${sizes}): skipped, ${skip}`);
      continue;
    }
    const where = slot.platform === "ios" ? (slot.simulators?.join(" | ") ?? `no simulator; scaled from ${slot.deriveFrom?.join(" or ")}`) : `connected device, wm size ${slot.sizes[0].join("x")}, density ${slot.density}`;
    console.log(`# ${slot.id} (${sizes})${slot.required ? " required" : ""}: ${where}${slot.simulators && slot.deriveFrom ? `; else scaled from ${slot.deriveFrom.join(" or ")}` : ""}`);
    if (slot.platform === "ios" && !slot.simulators) continue;
    console.log(maestroArgs(slot.platform === "ios" ? "<udid>" : "<serial>", `.storeAssets/matrix/${slot.id}/out`, load.flow.replace(`${load.root}/`, ""), flowEnv({ ...load, app: { ...load.app, account: undefined } }, slot, appIdFor(load, expo, slot) ?? "<app id>")).join(" "));
  }
  return 0;
};

const run = (load: Loaded, slots: Slot[], expo: Expo): number => {
  if (!existsSync(load.flow)) throw new Error(`no flow at ${load.flow}: run the screenshot-flows skill first`);
  const check = checkFlow(readFileSync(load.flow, "utf8"));
  for (const warning of check.warnings) console.log(`warning: ${warning}`);
  if (check.problems.length > 0) {
    for (const problem of check.problems) console.log(`problem: ${problem}`);
    return 2;
  }
  const rows = new Map<string, Row>();
  const log = (row: Row): void => {
    rows.set(row.slot, row);
    console.log(`${row.slot}: ${row.status}, ${row.detail}`);
  };
  for (const slot of slots) {
    const base = { slot: slot.id, label: slot.label, required: slot.required };
    const skip = notApplicable(slot, expo);
    if (slot.manual) log({ ...base, status: "manual", detail: slot.manual });
    else if (skip) log({ ...base, status: "not-applicable", detail: skip });
    else if (!slot.simulators && slot.platform === "ios") log({ ...base, status: "blocked", detail: "no simulator on a current iOS" });
    else {
      const appId = appIdFor(load, expo, slot);
      if (!appId) log({ ...base, status: "blocked", detail: `no app id: set matrix.${slot.platform}.appId or fill in app.json` });
      else {
        log(captureSlot(load, slot, check.shots, appId));
      }
    }
  }
  const usable = new Set([...rows.values()].filter((row) => row.status === "captured" || row.status === "derived").map((row) => row.slot));
  const previous = existsSync(coveragePath(load)) ? (JSON.parse(readFileSync(coveragePath(load), "utf8")) as { rows: Row[] }).rows : [];
  for (const row of previous) if (!rows.has(row.slot) && (row.status === "captured" || row.status === "derived")) usable.add(row.slot);
  // Slots are ordered largest first, so a derived slot can feed a smaller one.
  for (const slot of slots) {
    const row = rows.get(slot.id);
    if (row?.status !== "blocked" || !slot.deriveFrom) continue;
    const detail = deriveSlot(load, slot, check.shots, usable);
    if (detail) {
      log({ ...row, status: "derived", detail: `${detail} (${row.detail})` });
      usable.add(slot.id);
    }
  }
  const merged = writeCoverage(load, slots.map((slot) => rows.get(slot.id) as Row));
  console.log("");
  printTable(merged);
  const statuses = [...rows.values()].map((row) => row.status);
  const verdict = statuses.includes("failed") ? "FAIL" : statuses.includes("blocked") ? "UNVERIFIED" : "PASS";
  console.log(`\nResult: ${verdict}. Images in ${load.outDir}/<slot>/, report in ${coveragePath(load)}.`);
  return verdict === "FAIL" ? 2 : verdict === "UNVERIFIED" ? 3 : 0;
};

if (import.meta.main) {
  try {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const [command, appKey] = positional;
    if ((command !== "plan" && command !== "run") || !appKey) throw new Error("usage: matrix.ts plan|run <app> [--platform ios|android] [--only a,b] [--root dir]");
    const load = loadApp(appKey, flags.root);
    const expo = readExpo(load.appDir);
    const slots = selectSlots(flags);
    process.exit(command === "plan" ? plan(load, slots, expo) : run(load, slots, expo));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
