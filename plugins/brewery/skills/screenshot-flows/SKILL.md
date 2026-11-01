---
name: screenshot-flows
description: Generate the Maestro flow that captures an app's store screenshots. Reads the app's routes, tabs, and seed data, proposes the screens to capture, adds any missing testIDs, writes `<appDir>/maestro/screenshots.yaml` so the same flow works on every device size, lints it, and proves it on one device. Use when asked to write, generate, or fix Maestro screenshot commands or flows; run `screenshot-matrix` next to capture every size, then `screenshot-banners` for the marketing gallery.
---

# Screenshot flows

The first of three steps: this skill writes the flow, `screenshot-matrix` runs it on every
store size, and `screenshot-banners` composes the gallery. All three share
`storeAssets.config.json`, the `NN-name` shot names, and `<appDir>/storeScreenshots/`, the
same layout as terreno's `store-assets` skill. When a repository already uses `store-assets`,
reuse its config and its `openApp.yaml` and `goHome.yaml` subflows.

## 1. Read the app

Find the app directory, `app.json` (bundle id, package, `supportsTablet`), the routes and tab
layout, any existing flows under `maestro/` or `.maestro/`, the seed script, and the test
accounts. Never guess a path or an account; if there is no seeded login, ask for one.

## 2. Propose the screens

List 4 to 8 screens in store order, most compelling first, each with one line on what it
shows and the data it needs. The first three matter most, because they are what a store
visitor sees without scrolling. Leave out login, splash, permission, and empty screens:
Apple rejects screenshots that are mostly title art or login, and they sell nothing.

Send the list to the human and take their edits. If nobody is available, proceed with your
list and say so in the report.

Screenshots are public. Use seed or demo data only, never real user data or PHI. If a screen
needs data that the seed lacks, extend the seed rather than capturing an empty state.

## 3. Add what the screens need

Select only by `testID`. Add any that are missing to the components first, named
`{screen}-{element}-{qualifier}`, including a content testID on each screen that appears only
once its data has loaded, and `tabBarButtonTestID` on tabs.

## 4. Write the flow

Write `<appDir>/maestro/screenshots.yaml`, and add the app to `storeAssets.config.json` at the
repository root if it is not there:

```json
{
  "homeScreenTestId": "home-screen",
  "apps": { "mobile": { "appDir": "apps/mobile", "account": { "email": "demo@example.com", "password": "from the seed" } } }
}
```

`SCREENSHOT_EMAIL` and `SCREENSHOT_PASSWORD` override the account, and are the place for any
login that is not a throwaway seed account.

```yaml
appId: ${APP_ID}
---
- launchApp:
    clearState: true
- runFlow: subflows/login.yaml
- extendedWaitUntil:
    visible:
      id: "home-content"
    timeout: 60000
- waitForAnimationToEnd
- takeScreenshot: 01-home

- tapOn:
    id: "tab-schedule"
- extendedWaitUntil:
    visible:
      id: "schedule-list"
    timeout: 20000
- waitForAnimationToEnd
- takeScreenshot: 02-schedule

# Layouts can fork; the shot cannot. Fork navigation in a subflow.
- runFlow:
    when:
      true: ${FORM == 'tablet'}
    file: subflows/openDetailTablet.yaml
- runFlow:
    when:
      true: ${FORM == 'phone'}
    file: subflows/openDetailPhone.yaml
- extendedWaitUntil:
    visible:
      id: "detail-content"
    timeout: 20000
- waitForAnimationToEnd
- takeScreenshot: 03-detail
```

Write every subflow the flow references next to it, under `maestro/subflows/`. The login subflow
takes `${EMAIL}` and `${PASSWORD}` and skips itself when already signed in.

`launchApp` with `clearState` is for a release build. A dev client lands on its launcher that way,
and a cold relaunch can leave Android blank, so a dev-client flow never calls `launchApp`: it starts
from the app already open in Metro. In a `store-assets` repository, start it with `runFlow` on
`scripts/storeAssets/maestro/openApp.yaml`, with `../` per directory level, and return home with
`goHome.yaml`.

The runner passes `APP_ID`, `PLATFORM` (`ios` or `android`), `DEVICE` (the slot id), `FORM`
(`phone` or `tablet`), `HOME_SCREEN_ID`, `EMAIL`, and `PASSWORD`.

These rules are what make one flow work on every size, and `scripts/check.ts` enforces them:

- The header is `appId: ${APP_ID}`, because iOS and Android ids differ.
- Every shot is a top-level `- takeScreenshot: NN-name`, in order, directly after
  `waitForAnimationToEnd`. A shot never sits inside a `when`: every size must produce every shot.
- No `point:` coordinates. They land somewhere else on every size.
- No hard-coded accounts, and no fixed waits. Wait with `extendedWaitUntil` on a content testID.

Bare shot names only. Maestro rejects a path outside its output folder.

## 5. Check and prove it

```bash
bun <this skill>/scripts/check.ts <appDir>/maestro/screenshots.yaml
bun <screenshot-matrix>/scripts/matrix.ts run <app> --only iphone-6.3,android-phone
```

`<this skill>` is the directory holding this file; `screenshot-matrix` is its sibling. Read
every PNG in `<appDir>/storeScreenshots/`. Look for spinners, empty states, error toasts,
system dialogs, and clipped text. Fix the flow and rerun rather than handing over a bad shot.

No simulator or emulator here? Say **UNVERIFIED (flow not run)** with the blocker, and give
the human the exact commands from `matrix.ts plan <app>`. A clean lint is not proof the flow runs.

## Report

The flow's path, the shots in order, the testIDs you added, the data you seeded, the devices
it ran on or why it did not run, and the next step: `screenshot-matrix`.
