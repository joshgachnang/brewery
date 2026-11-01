---
name: screenshot-matrix
description: Run an app's Maestro screenshot flow on every App Store and Google Play size and account for each one. Picks or creates the iOS simulator for each iPhone and iPad slot, resizes an Android emulator for phone, 7-inch, and 10-inch tablet slots, sets a clean status bar, checks each image against the sizes the store accepts, strips alpha, and reports every slot as captured, derived, blocked, failed, or manual. Use when asked for store screenshots on all device sizes; run after `screenshot-flows` and before `screenshot-banners`.
---

# Screenshot matrix

Takes the flow from `screenshot-flows` and produces one complete set of images for every store
size. `<this skill>` below is the directory holding this file.

```bash
bun <this skill>/scripts/matrix.ts plan <app>                     # every slot and its exact maestro command
bun <this skill>/scripts/matrix.ts run <app>                      # every slot
bun <this skill>/scripts/matrix.ts run <app> --platform android   # one platform
bun <this skill>/scripts/matrix.ts run <app> --only ipad-13,ipad-11  # rerun some; the report keeps the rest
```

Run `run` in the background, because a full pass takes a long time. Images land in
`<appDir>/storeScreenshots/<slot>/NN-name.png`, and the report in
`<appDir>/storeScreenshots/coverage.json`. Keep `storeScreenshots/` tracked and git-ignore
`/.storeAssets/`, which holds Maestro logs and output.

## Setup

- **iOS:** a Mac with Xcode and the runtimes the slots need. The older slots need older
  runtimes: `iPhone 8 Plus` runs on iOS 16 at the latest. Install one from Xcode > Settings >
  Components.
- **Android:** platform-tools and a connected emulator (`adb devices`, or `ANDROID_SERIAL`). One
  emulator covers all three slots, because the runner resizes it with `wm size` and `wm density`
  and resets it afterwards.
- **Maestro** on `PATH`, and **Chrome or Chromium** for scaling derived slots.
- **The app installed on each device.** Prefer a release-mode simulator build and APK, so no dev
  menu shows in a shot. Point the config at them, or use `prepare` to install and launch however
  the repository does it. It runs per device with `APP`, `SLOT`, `PLATFORM`, and `DEVICE_ID` set:

```json
{
  "apps": {
    "mobile": {
      "appDir": "apps/mobile",
      "matrix": {
        "ios": { "app": "builds/Mobile.app" },
        "android": { "apk": "builds/mobile.apk" },
        "minIos": "16.0",
        "prepare": "bun run devclient:ensure $APP $PLATFORM --device $DEVICE_ID && bun run devclient:open $APP $PLATFORM --device $DEVICE_ID"
      }
    }
  }
}
```

The `prepare` line is for a dev client in a repository set up with terreno's `store-assets`; drop
it for a release build. It needs a production Metro already running on the app's port
(`expo start --no-dev --minify`, with `EXPO_PUBLIC_API_URL` at the local API), and it does not hide
the dev menu the way `bun run screenshots` does, so check the shots for the gear button. A release
build is the cleaner route.
App ids come from `app.json` unless `matrix.ios.appId` or `matrix.android.appId` is set. An app
with `supportsTablet: false` skips the iPad slots. Set `minIos` to the app's deployment target,
so a simulator too old to run the app is never picked.

## Every size

The script's `scripts/slots.ts` is the source of truth, checked against Apple's and Google's
pages on 2026-11-01. Recheck it against those pages when a store changes its rules; both URLs are
at the top of that file.

| Slot | Portrait sizes accepted | Required | How it is filled |
| --- | --- | --- | --- |
| `iphone-6.9` | 1320×2868, 1290×2796, 1260×2736 | no | iPhone 17 / 16 / 15 Pro Max, iPhone Air |
| `iphone-6.5` | 1284×2778, 1242×2688 | no | iPhone 14 Plus and older; else scaled from 6.9 |
| `iphone-6.3` | 1206×2622, 1179×2556 | **yes** | iPhone 17 Pro, 17, 16 Pro, 16, 15 Pro, 15 |
| `iphone-6.1` | 1170×2532, 1125×2436, 1080×2340 | no | iPhone 16e, 14, 13, 12, 11 Pro; else scaled from 6.3 or 6.5 |
| `iphone-5.5` | 1242×2208 | no | iPhone 8 Plus |
| `iphone-4.7` | 750×1334 | no | iPhone SE (3rd generation), 8; else scaled from 5.5 |
| `iphone-4` | 640×1136, 640×1096 | no | Scaled from 4.7 or 5.5; no current simulator |
| `iphone-3.5` | 640×960, 640×920 | no | Manual: 2:3, nothing to scale from without distorting |
| `iphone-duo-outer`, `iphone-duo-inner` | 1398×2034, 2007×2853 | from April 2027, on the iOS 27.1 SDK | Manual: this runner cannot drive the posture |
| `ipad-13` | 2064×2752, 2048×2732 | **yes, on iPad** | iPad Pro 13-inch, iPad Air 13-inch |
| `ipad-12.9` | 2048×2732 | no | iPad Pro 12.9-inch (6th generation); else scaled from 13 |
| `ipad-11` | 1668×2420, 1668×2388, 1640×2360, 1488×2266 | no | iPad Pro or Air 11-inch, iPad (A16), iPad mini |
| `ipad-10.5` | 1668×2224 | no | iPad Air (3rd generation); else scaled from 12.9 or 13 |
| `ipad-9.7` | 1536×2048, 768×1024 | no | iPad mini (5th generation); else scaled from 10.5, 12.9, or 13 |
| `android-phone` | 1080×1920 | **yes** | Emulator at 1080×1920, density 420 |
| `android-tablet-7` | 1080×1920 | no | Emulator at 1080×1920, density 280, so the tablet layout shows |
| `android-tablet-10` | 1440×2560 | no | Emulator at 1440×2560, density 320 |

Device names only say where to look first. The image's pixel size decides: anything the store
would not accept fails the slot. Play wants 9:16 and rejects anything past 2:1, so a 20:9 Pixel
never fits, which is why the emulator is resized. Wear OS, TV, XR, and Automotive are not covered:
those stores have their own rules and most apps do not ship there. The runner is portrait only.

## Reading the result

Every slot gets a row, so a size is never silently missing.

| Result | Meaning | What to do |
| --- | --- | --- |
| `captured` | The flow ran there and every image passed | Review it |
| `derived` | No device could run, so it was scaled down from a larger capture within 1% aspect, as the store itself would | Fine to upload; the blocker stays in the row |
| `blocked` | It never ran, and nothing could fill it. Exit 3 | Fix the blocker in the row and rerun with `--only` |
| `failed` | It ran and failed. Exit 2 | Fix the flow or the app; the log path is in the row |
| `manual` | No run can capture it | Nothing, unless the row names a deadline that applies |
| `not-applicable` | The app is not on this form factor | Nothing |

A failed slot is never papered over with a derived image. **A blocker is not a failure and not a
pass**: exit 3 means UNVERIFIED, and the report must say so. A required slot that is blocked or
failed means the set cannot be submitted.

## Review

Read one image per slot at minimum, and every image for `iphone-6.3`, `ipad-13`, and
`android-phone`. Check for what a size check cannot see: clipped text on the smallest iPhone, a
stretched phone layout on tablets, keyboards or dialogs left open, a stale status bar, seed data
that reads badly. Screenshots are public: seed or demo data only, never real user data or PHI.

## Report

The coverage table the script prints, the Result line (PASS, FAIL, or UNVERIFIED), what you saw
in review, and the next step: `screenshot-banners`.
