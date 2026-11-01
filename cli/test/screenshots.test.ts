// The screenshot skills' scripts, driven end to end with fake xcrun, adb, and maestro on PATH.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkFlow } from "../../plugins/brewery/skills/screenshot-flows/scripts/check.ts";
import { findBrowser } from "../../plugins/brewery/skills/screenshot-matrix/scripts/browser.ts";
import { maestroArgs, type Row } from "../../plugins/brewery/skills/screenshot-matrix/scripts/matrix.ts";
import { pngInfo, solidPng, stripAlpha } from "../../plugins/brewery/skills/screenshot-matrix/scripts/png.ts";
import { acceptsSize, canDerive, SLOTS, slotById } from "../../plugins/brewery/skills/screenshot-matrix/scripts/slots.ts";

const SKILLS = join(import.meta.dir, "..", "..", "plugins", "brewery", "skills");
const MATRIX = join(SKILLS, "screenshot-matrix", "scripts", "matrix.ts");
const RENDER = join(SKILLS, "screenshot-banners", "scripts", "render.ts");
const CHECK = join(SKILLS, "screenshot-flows", "scripts", "check.ts");

const GOOD_FLOW = `appId: \${APP_ID}
---
- launchApp
- waitForAnimationToEnd
- takeScreenshot: 01-home
- tapOn:
    id: "tab-plan"
- waitForAnimationToEnd
- takeScreenshot: 02-plan
`;

describe("checkFlow", () => {
  test("a flow that follows the rules is clean and lists its shots", () => {
    expect(checkFlow(GOOD_FLOW)).toEqual({ shots: ["01-home", "02-plan"], problems: [], warnings: [] });
  });

  test.each([
    ["a hard-coded app id", GOOD_FLOW.replace("${APP_ID}", "com.example.app"), "appId"],
    ["a shot not after a settle", GOOD_FLOW.replace("- waitForAnimationToEnd\n- takeScreenshot: 01-home", "- takeScreenshot: 01-home"), "must directly follow"],
    ["a badly named shot", GOOD_FLOW.replace("01-home", "home"), "must look like"],
    ["a repeated shot", GOOD_FLOW.replace("02-plan", "01-home"), "used twice"],
    ["shots out of order", GOOD_FLOW.replace("01-home", "09-home"), "out of order"],
    ["a nested shot", `${GOOD_FLOW}- runFlow:\n    commands:\n      - takeScreenshot: 03-nested\n`, "nested"],
    ["coordinates", `${GOOD_FLOW}- tapOn:\n    point: 50%,50%\n`, "coordinates"],
    ["a hard-coded account", `${GOOD_FLOW}- inputText: demo@example.com\n`, "hard-coded"],
    ["no shots at all", "appId: ${APP_ID}\n---\n- launchApp\n", "no screenshots"],
  ])("reports %s", (_name, flow, phrase) => {
    expect(checkFlow(flow).problems.join("\n")).toContain(phrase);
  });

  test("comments do not count as commands", () => {
    expect(checkFlow(GOOD_FLOW.replace("- waitForAnimationToEnd\n- takeScreenshot: 02-plan", "- waitForAnimationToEnd\n# settle first\n- takeScreenshot: 02-plan")).problems).toEqual([]);
  });

  test("the script exits 2 on problems and 0 when clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-"));
    const good = join(dir, "good.yaml");
    const bad = join(dir, "bad.yaml");
    writeFileSync(good, GOOD_FLOW);
    writeFileSync(bad, "appId: x\n");
    expect(Bun.spawnSync(["bun", CHECK, good]).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", CHECK, bad]).exitCode).toBe(2);
  });
});

describe("slots", () => {
  test("ids are unique and each store's required slots are present", () => {
    expect(new Set(SLOTS.map((slot) => slot.id)).size).toBe(SLOTS.length);
    expect(SLOTS.filter((slot) => slot.required).map((slot) => slot.id)).toEqual(["iphone-6.3", "ipad-13", "android-phone"]);
  });

  test("every Android slot meets Play's 9:16 rule and carries a density", () => {
    for (const slot of SLOTS.filter((candidate) => candidate.platform === "android")) {
      const [width, height] = slot.sizes[0];
      expect(height / width).toBeCloseTo(16 / 9, 3);
      expect(width).toBeGreaterThanOrEqual(1080);
      expect(slot.density).toBeGreaterThan(0);
    }
  });

  test("every Android tablet density gives a tablet layout, and the phone a phone layout", () => {
    const smallestWidthDp = (id: string): number => {
      const slot = slotById(id);
      return ((slot?.sizes[0][0] ?? 0) * 160) / (slot?.density ?? 1);
    };
    expect(smallestWidthDp("android-phone")).toBeLessThan(600);
    expect(smallestWidthDp("android-tablet-7")).toBeGreaterThanOrEqual(600);
    expect(smallestWidthDp("android-tablet-10")).toBeGreaterThanOrEqual(720);
  });

  test("every slot can be reached: a device, a source to scale from, or a stated reason", () => {
    for (const slot of SLOTS) {
      expect(Boolean(slot.manual || slot.simulators || slot.density || slot.deriveFrom)).toBe(true);
      for (const source of slot.deriveFrom ?? []) {
        expect(slotById(source)?.platform).toBe(slot.platform);
        // A source must come earlier, so a derived slot can feed a smaller one in the same run.
        expect(SLOTS.findIndex((s) => s.id === source)).toBeLessThan(SLOTS.indexOf(slot));
        expect(slot.sizes.some((to) => slotById(source)?.sizes.some((from) => canDerive(from, to)))).toBe(true);
      }
    }
  });

  test("deriving only scales down, within 1% aspect", () => {
    expect(canDerive([2064, 2752], [1536, 2048])).toBe(true);
    expect(canDerive([1536, 2048], [2064, 2752])).toBe(false);
    expect(canDerive([1320, 2868], [750, 1334])).toBe(false);
    expect(acceptsSize(slotById("iphone-6.3") as (typeof SLOTS)[number], 1179, 2556)).toBe(true);
    expect(acceptsSize(slotById("iphone-6.3") as (typeof SLOTS)[number], 1080, 2400)).toBe(false);
  });
});

describe("png", () => {
  test("strips alpha, flattening onto white, and keeps the size", () => {
    const flat = stripAlpha(solidPng(12, 7, [10, 20, 30, 255]));
    expect(pngInfo(flat)).toEqual({ width: 12, height: 7, hasAlpha: false });
    const half = stripAlpha(solidPng(2, 2, [0, 0, 0, 128]));
    expect(pngInfo(half).hasAlpha).toBe(false);
    // An image without alpha comes back byte for byte.
    expect(stripAlpha(flat).equals(flat)).toBe(true);
  });

  test("rejects a file that is not a PNG", () => {
    expect(() => pngInfo(Buffer.from("not an image"))).toThrow("not a PNG");
  });
});

// A fake toolchain: maestro copies the images a test prepared for each slot into its output.
const fakeBin = (root: string, tools: Record<string, string>): string => {
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
};

const FAKE_MAESTRO = `
echo "$@" >> "$FAKE_LOG"
slot=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test-output-dir) out="$2"; shift ;;
    --env) case "$2" in DEVICE=*) slot="\${2#DEVICE=}" ;; esac; shift ;;
  esac
  shift
done
if [ -f "$FAKE_IMAGES/$slot/fail" ]; then echo "tap failed on $slot"; exit 1; fi
mkdir -p "$out/nested/takeScreenshot"
cp "$FAKE_IMAGES/$slot"/*.png "$out/nested/takeScreenshot/"
`;

const DEVICE_TYPES = JSON.stringify({ devicetypes: [{ name: "iPhone 17 Pro", identifier: "type.17pro", minRuntimeVersion: 0x130000, maxRuntimeVersion: 4294967295 }] });
const RUNTIMES = JSON.stringify({ runtimes: [{ identifier: "rt.26", version: "26.0", isAvailable: true, platform: "iOS" }] });
const FAKE_XCRUN = `
echo "xcrun $*" >> "$FAKE_LOG"
case "$*" in
  *"list devicetypes"*) echo '${DEVICE_TYPES}' ;;
  *"list runtimes"*) echo '${RUNTIMES}' ;;
  *"list devices"*) echo '{"devices":{}}' ;;
  *create*) echo UDID-1 ;;
esac
exit 0
`;
const FAKE_ADB = `
echo "adb $*" >> "$FAKE_LOG"
case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  *"pm path"*) echo "package:/data/app/base.apk" ;;
esac
exit 0
`;

const makeRepo = (app: Record<string, unknown> = {}): { root: string; appDir: string; images: string; log: string } => {
  const root = mkdtempSync(join(tmpdir(), "matrix-"));
  const appDir = join(root, "apps", "m");
  mkdirSync(join(appDir, "maestro"), { recursive: true });
  writeFileSync(join(appDir, "maestro", "screenshots.yaml"), GOOD_FLOW);
  writeFileSync(join(appDir, "app.json"), JSON.stringify({ expo: { ios: { bundleIdentifier: "com.example.m", supportsTablet: true }, android: { package: "com.example.m" } } }));
  writeFileSync(join(root, "storeAssets.config.json"), JSON.stringify({ apps: { m: { appDir: "apps/m", ...app } } }));
  return { root, appDir, images: join(root, "fake-images"), log: join(root, "fake.log") };
};

const prepareImages = (images: string, slot: string, width: number, height: number, rgba: [number, number, number, number] = [200, 220, 240, 255]): void => {
  mkdirSync(join(images, slot), { recursive: true });
  for (const shot of ["01-home", "02-plan"]) writeFileSync(join(images, slot, `${shot}.png`), solidPng(width, height, rgba));
};

const runMatrix = (repo: ReturnType<typeof makeRepo>, args: string[], tools: Record<string, string>): { code: number; out: string; rows: Row[] } => {
  const bin = fakeBin(repo.root, tools);
  const proc = Bun.spawnSync(["bun", MATRIX, ...args, "--root", repo.root], {
    // The narrow PATH hides real device tools, so name the browser for the slots that scale images.
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CHROME_PATH: findBrowser() ?? "", FAKE_IMAGES: repo.images, FAKE_LOG: repo.log },
    stdout: "pipe",
    stderr: "pipe",
  });
  const coverage = join(repo.appDir, "storeScreenshots", "coverage.json");
  return { code: proc.exitCode ?? 1, out: `${proc.stdout.toString()}${proc.stderr.toString()}`, rows: existsSync(coverage) ? (JSON.parse(readFileSync(coverage, "utf8")) as { rows: Row[] }).rows : [] };
};

const rowFor = (rows: Row[], slot: string): Row | undefined => rows.find((row) => row.slot === slot);
const TOOLS = { maestro: FAKE_MAESTRO, xcrun: FAKE_XCRUN, adb: FAKE_ADB };

describe("matrix run", () => {
  test("captures an iOS slot: creates the simulator, cleans the status bar, strips alpha", () => {
    const repo = makeRepo({ account: { email: "demo@example.com", password: "pw" } });
    prepareImages(repo.images, "iphone-6.3", 1206, 2622);
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "iphone-6.3"], TOOLS);
    expect(rowFor(rows, "iphone-6.3")?.status).toBe("captured");
    expect(code).toBe(0);
    const saved = readFileSync(join(repo.appDir, "storeScreenshots", "iphone-6.3", "01-home.png"));
    expect(pngInfo(saved)).toEqual({ width: 1206, height: 2622, hasAlpha: false });
    const log = readFileSync(repo.log, "utf8");
    expect(log).toContain("simctl create Store iphone-6.3 type.17pro rt.26");
    expect(log).toContain("status_bar UDID-1 override --time 9:41");
    expect(log).toContain("--device UDID-1 test");
    expect(log).toContain("--env APP_ID=com.example.m");
    expect(log).toContain("--env FORM=phone");
    expect(log).toContain("--env EMAIL=demo@example.com");
  });

  test("runs Android slots on one emulator: resizes per slot, then resets it", () => {
    const repo = makeRepo();
    prepareImages(repo.images, "android-phone", 1080, 1920);
    prepareImages(repo.images, "android-tablet-10", 1440, 2560);
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "android-phone,android-tablet-10"], TOOLS);
    expect(code).toBe(0);
    expect(rows.map((row) => row.status)).toEqual(["captured", "captured"]);
    const log = readFileSync(repo.log, "utf8");
    expect(log).toContain("wm size 1080x1920");
    expect(log).toContain("wm density 420");
    expect(log).toContain("wm size 1440x2560");
    expect(log).toContain("wm density 320");
    expect(log).toContain("wm size reset");
    expect(log).toContain("com.android.systemui.demo");
  });

  test("an image at a size the store rejects fails the slot and keeps nothing", () => {
    const repo = makeRepo();
    prepareImages(repo.images, "android-phone", 1080, 2400);
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "android-phone"], TOOLS);
    expect(code).toBe(2);
    expect(rowFor(rows, "android-phone")?.status).toBe("failed");
    expect(rowFor(rows, "android-phone")?.detail).toContain("1080x2400");
    expect(existsSync(join(repo.appDir, "storeScreenshots", "android-phone"))).toBe(false);
  });

  test("a shot the flow should have taken but did not fails the slot", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.images, "android-phone"), { recursive: true });
    writeFileSync(join(repo.images, "android-phone", "01-home.png"), solidPng(1080, 1920, [1, 2, 3, 255]));
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "android-phone"], TOOLS);
    expect(code).toBe(2);
    expect(rowFor(rows, "android-phone")?.detail).toContain("no image for 02-plan");
  });

  test("a flow that fails is retried once, then reported with its output", () => {
    const repo = makeRepo();
    prepareImages(repo.images, "android-phone", 1080, 1920);
    writeFileSync(join(repo.images, "android-phone", "fail"), "");
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "android-phone"], TOOLS);
    expect(code).toBe(2);
    expect(rowFor(rows, "android-phone")?.detail).toContain("tap failed on android-phone");
    expect(readFileSync(repo.log, "utf8").split("\n").filter((line) => line.startsWith("--device")).length).toBe(2);
  });

  test.skipIf(process.platform === "darwin")("no simulator tooling is a blocker, exit 3, and the maestro flow never runs", () => {
    const repo = makeRepo();
    const { code, rows, out } = runMatrix(repo, ["run", "m", "--only", "iphone-6.3"], { maestro: FAKE_MAESTRO });
    expect(code).toBe(3);
    expect(rowFor(rows, "iphone-6.3")?.status).toBe("blocked");
    expect(rowFor(rows, "iphone-6.3")?.detail).toContain("xcrun");
    expect(out).toContain("Result: UNVERIFIED");
    expect(existsSync(repo.log)).toBe(false);
  });

  test("an app that is not installed is a blocker, not a failure", () => {
    const repo = makeRepo();
    const adbNoApp = FAKE_ADB.replace('echo "package:/data/app/base.apk"', "true");
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "android-phone"], { maestro: FAKE_MAESTRO, adb: adbNoApp });
    expect(code).toBe(3);
    expect(rowFor(rows, "android-phone")?.detail).toContain("not installed");
  });

  test("the installed check waits for prepare, which may be what installs the app", () => {
    const repo = makeRepo({ matrix: { prepare: 'echo "prepare $SLOT $PLATFORM $DEVICE_ID" >> "$FAKE_LOG"; touch "$FAKE_LOG.installed"' } });
    prepareImages(repo.images, "android-phone", 1080, 1920);
    const adb = FAKE_ADB.replace('*"pm path"*) echo "package:/data/app/base.apk" ;;', '*"pm path"*) [ -f "$FAKE_LOG.installed" ] && echo "package:/data/app/base.apk" ;;');
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "android-phone"], { maestro: FAKE_MAESTRO, adb });
    expect(rowFor(rows, "android-phone")?.status).toBe("captured");
    expect(code).toBe(0);
    expect(readFileSync(repo.log, "utf8")).toContain("prepare android-phone android emulator-5554");
  });

  test("a prepare that fails is a blocker", () => {
    const repo = makeRepo({ matrix: { prepare: "echo no dev client; exit 7" } });
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "android-phone"], TOOLS);
    expect(code).toBe(3);
    expect(rowFor(rows, "android-phone")?.detail).toContain("matrix.prepare exited 7: no dev client");
  });

  test("a slot with no matching simulator says what to install", () => {
    const repo = makeRepo();
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "iphone-5.5"], TOOLS);
    expect(code).toBe(3);
    expect(rowFor(rows, "iphone-5.5")?.detail).toContain("iPhone 8 Plus");
  });

  test("minIos rules out a runtime below it", () => {
    const repo = makeRepo({ matrix: { minIos: "27.0" } });
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "iphone-6.3"], TOOLS);
    expect(code).toBe(3);
    expect(rowFor(rows, "iphone-6.3")?.detail).toContain("iOS 27.0+");
  });

  test("manual and not-applicable slots are reported without counting as misses", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.appDir, "app.json"), JSON.stringify({ expo: { ios: { bundleIdentifier: "com.example.m", supportsTablet: false } } }));
    const { code, rows } = runMatrix(repo, ["run", "m", "--only", "iphone-3.5,ipad-13"], TOOLS);
    expect(code).toBe(0);
    expect(rowFor(rows, "iphone-3.5")?.status).toBe("manual");
    expect(rowFor(rows, "ipad-13")?.status).toBe("not-applicable");
  });

  test("a filtered rerun replaces its own rows and keeps the others", () => {
    const repo = makeRepo();
    prepareImages(repo.images, "android-phone", 1080, 1920);
    prepareImages(repo.images, "android-tablet-7", 1080, 1920);
    runMatrix(repo, ["run", "m", "--only", "android-phone"], TOOLS);
    const { rows } = runMatrix(repo, ["run", "m", "--only", "android-tablet-7"], TOOLS);
    expect(rows.map((row) => row.slot)).toEqual(["android-phone", "android-tablet-7"]);
  });

  test("a flow that breaks the rules stops before any device is touched", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.appDir, "maestro", "screenshots.yaml"), GOOD_FLOW.replace("- waitForAnimationToEnd\n- takeScreenshot: 01-home", "- takeScreenshot: 01-home"));
    const { code, out } = runMatrix(repo, ["run", "m", "--only", "android-phone"], TOOLS);
    expect(code).toBe(2);
    expect(out).toContain("must directly follow");
    expect(existsSync(repo.log)).toBe(false);
  });

  test("plan lists every slot with its exact command and leaves accounts out", () => {
    const repo = makeRepo({ account: { email: "demo@example.com", password: "secret-pw" } });
    const { code, out } = runMatrix(repo, ["plan", "m"], {});
    expect(code).toBe(0);
    for (const slot of SLOTS) expect(out).toContain(`# ${slot.id} (`);
    expect(out).toContain("maestro --device <udid> test --test-output-dir .storeAssets/matrix/iphone-6.3/out");
    expect(out).toContain("--env APP_ID=com.example.m");
    expect(out).not.toContain("secret-pw");
    expect(out).not.toContain("demo@example.com");
  });

  test("maestroArgs puts the device before test and the flow last", () => {
    expect(maestroArgs("emulator-5554", "/out", "flow.yaml", { APP_ID: "a" })).toEqual(["maestro", "--device", "emulator-5554", "test", "--test-output-dir", "/out", "--env", "APP_ID=a", "flow.yaml"]);
  });
});

describe.skipIf(!findBrowser())("with a browser", () => {
  const HERO = { layout: "hero", screen: "01-home", headline: "Your week, planned in one place", body: "Everything together.", points: ["See who does what", "Reminders for all"] };
  const STANDARD = { layout: "standard", screen: "02-plan", headline: "Plan in seconds" };

  const repoWith = (panels: unknown[], slots: Array<[string, number, number]>): ReturnType<typeof makeRepo> => {
    const repo = makeRepo({ banners: { theme: { background: "#14323f", backgroundEnd: "#2a7f6f" }, panels } });
    for (const [slot, width, height] of slots) {
      const dir = join(repo.appDir, "storeScreenshots", slot);
      mkdirSync(dir, { recursive: true });
      for (const shot of ["01-home", "02-plan"]) writeFileSync(join(dir, `${shot}.png`), solidPng(width, height, [220, 230, 240, 255]));
    }
    return repo;
  };

  const render = (repo: ReturnType<typeof makeRepo>, args: string[]): { code: number; out: string } => {
    const proc = Bun.spawnSync(["bun", RENDER, "render", "m", ...args, "--root", repo.root], { stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode ?? 1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  };

  const images = (repo: ReturnType<typeof makeRepo>, slot: string): string[] => readdirSync(join(repo.appDir, "storeScreenshots", "banners", slot)).sort();

  test(
    "renders the hero as three images plus singles at the slot's exact size with no alpha",
    () => {
      const repo = repoWith([HERO, STANDARD], [["iphone-4.7", 750, 1334]]);
      const { code, out } = render(repo, ["--only", "iphone-4.7"]);
      expect(out).toContain("iphone-4.7: ok");
      expect(code).toBe(0);
      expect(images(repo, "iphone-4.7")).toEqual(["01-home-a.png", "02-home-b.png", "03-home-c.png", "04-plan.png"]);
      for (const name of images(repo, "iphone-4.7")) {
        expect(pngInfo(readFileSync(join(repo.appDir, "storeScreenshots", "banners", "iphone-4.7", name)))).toEqual({ width: 750, height: 1334, hasAlpha: false });
      }
    },
    120_000,
  );

  test(
    "Android tablets get bare screens, one per panel",
    () => {
      const repo = repoWith([HERO, STANDARD], [["android-tablet-7", 1080, 1920]]);
      expect(render(repo, ["--only", "android-tablet-7"]).code).toBe(0);
      expect(images(repo, "android-tablet-7")).toEqual(["01-home.png", "02-plan.png"]);
    },
    120_000,
  );

  test(
    "copy too long to fit fails with the panel named",
    () => {
      const repo = repoWith([{ ...STANDARD, headline: "Long words ".repeat(60) }], [["iphone-4.7", 750, 1334]]);
      const { code, out } = render(repo, ["--only", "iphone-4.7"]);
      expect(code).toBe(2);
      expect(out).toContain("iphone-4.7 panel 1 (02-plan)");
      expect(out).toContain("shorten it");
    },
    120_000,
  );

  test(
    "too much text on the Play phone slot fails, and `capped` copy fixes it",
    () => {
      const wordy = { ...HERO, headline: "words ".repeat(90), points: ["One", "Two"] };
      const repo = repoWith([wordy], [["android-phone", 1080, 1920]]);
      const { code, out } = render(repo, ["--only", "android-phone"]);
      expect(code).toBe(2);
      expect(out).toContain("Play allows 20%");
      const fixed = repoWith([{ ...wordy, capped: { headline: "Your week, planned" } }], [["android-phone", 1080, 1920]]);
      expect(render(fixed, ["--only", "android-phone"]).code).toBe(0);
    },
    120_000,
  );

  test(
    "more images than a slot allows fails",
    () => {
      const panels = [HERO, ...Array.from({ length: 6 }, () => STANDARD)];
      const repo = repoWith(panels, [["android-phone", 1080, 1920]]);
      const { code, out } = render(repo, ["--only", "android-phone"]);
      expect(code).toBe(2);
      expect(out).toContain("9 images, and this slot allows 8");
    },
    300_000,
  );

  test(
    "a slot with no capture of a chosen screen is UNVERIFIED, not a failure",
    () => {
      const repo = repoWith([{ ...STANDARD, screen: "07-missing" }], [["iphone-4.7", 750, 1334]]);
      const { code, out } = render(repo, ["--only", "iphone-4.7"]);
      expect(code).toBe(3);
      expect(out).toContain("no capture of 07-missing");
    },
    120_000,
  );

  test(
    "a blocked slot derives by scaling down a capture from the same run",
    () => {
      const repo = makeRepo();
      prepareImages(repo.images, "iphone-5.5", 1242, 2208);
      const types = JSON.stringify({ devicetypes: [{ name: "iPhone 8 Plus", identifier: "type.8plus", minRuntimeVersion: 0x0b0000, maxRuntimeVersion: 4294967295 }] });
      const { code, rows } = runMatrix(repo, ["run", "m", "--only", "iphone-5.5,iphone-4.7,iphone-4"], { maestro: FAKE_MAESTRO, adb: FAKE_ADB, xcrun: FAKE_XCRUN.replace(DEVICE_TYPES, types) });
      expect(rowFor(rows, "iphone-5.5")?.status).toBe("captured");
      expect(rowFor(rows, "iphone-4.7")?.status).toBe("derived");
      expect(rowFor(rows, "iphone-4")?.status).toBe("derived");
      expect(pngInfo(readFileSync(join(repo.appDir, "storeScreenshots", "iphone-4.7", "01-home.png")))).toEqual({ width: 750, height: 1334, hasAlpha: false });
      expect(pngInfo(readFileSync(join(repo.appDir, "storeScreenshots", "iphone-4", "01-home.png")))).toEqual({ width: 640, height: 1136, hasAlpha: false });
      expect(code).toBe(0);
    },
    120_000,
  );

  test(
    "the sheet command writes one image of the captures",
    () => {
      const repo = repoWith([STANDARD], [["iphone-6.3", 1206, 2622]]);
      const proc = Bun.spawnSync(["bun", RENDER, "sheet", "m", "--root", repo.root], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      expect(existsSync(proc.stdout.toString().trim())).toBe(true);
    },
    120_000,
  );
});
