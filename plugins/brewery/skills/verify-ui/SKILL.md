---
name: verify-ui
description: Verify a user-facing change by running it and showing evidence. Bring up a local stack the skill owns, drive the change in the browser with Playwright under the required checks (right page, not blank, no error overlay, console clean, DOM assertion, interaction proof, screenshot), run the repository's Maestro flows on the simulator for mobile-focused work, and publish screenshots and video to a secret gist in the report format. Use before claiming any UI change is done, when asked to verify, prove, or show a screenshot or video, and from Roast for UI-facing tasks.
---

# Verify UI

If you made a user-facing change, you must run it, check that it actually works, and
show evidence. No evidence, no completion claim. A passing build, type check, or unit
test is necessary, not sufficient.

**User-facing** is anything a user could notice: components, screens, routes,
navigation, styles, layout, responsive behavior, theming, forms, validation, error /
empty / loading states, copy, translations, API changes whose output a client renders,
emails, push, SMS, exported files. Pure refactors, internal tooling, and backend-only
changes with no rendered consumer are exempt, but say so: "No user-facing change:
<reason>".

## What the repository provides

The process below assumes four small scripts, kept in the repository and documented in
its own `verify-ui` skill. Skybound's `scripts/verifyUi/` (`stack.ts`, `capture.ts`,
`maestro.ts`, `publish.ts`, `config.ts`) is the reference implementation; copy it and
change `config.ts` (ports, apps, accounts, simulators, Maestro flow directory). State,
logs, and evidence live outside the source tree (for example `~/.claude/verifyUi/`) and
are never committed.

| Script | Contract |
|---|---|
| `stack.ts up / status / down` | Own database with seed data, the backend, and each app as web on fixed ports. **Refuses a port it did not open** and names the owner. `down` stops only what it started. |
| `capture.ts --run <slug> --scenario <file>` | Signs in, runs a scenario per app and viewport, records interactions, DOM assertions, console, screenshots, and video, and scores the required checks. Exit 2 on failure with a failure screenshot. |
| `maestro.ts --run <slug> --app <app> --flow <a,b>` | Runs the repository's Maestro flows on the app's simulator: confirms the backend and Metro are the stack's own, picks the device, boots it, records, runs with a JUnit report, keeps the final and failure screenshots. Exit 2 failed, exit 3 UNVERIFIED with the blocker. |
| `publish.ts --run <slug> --title "..."` | Creates a **secret gist**, pushes the evidence, and writes the README in the report format. Prints the URL. |

Two rules the scripts must keep, because getting them wrong turns a skipped check into
a false pass or a false failure:

- **Ownership is a live process, not a pid file.** "Started by the stack" means the
  recorded pid is alive and is (or leads the process group of) the current listener on
  that port. A stack that crashed and was followed by a developer's Metro or a backend
  on staging leaves the pid file behind; that port is not ours.
- **A blocker is never a failure.** The runner tells apart a flow that ran and failed
  (exit 2) from a flow that never ran (exit 3, UNVERIFIED with the blocker recorded:
  stack not ours or down, no simulator or dev client, simulator would not boot, Maestro
  or Java missing, no JUnit report written) and from a script crash (exit 1). The report
  reads exit 3 as UNVERIFIED, not as FAIL and not as PASS.

No repository scripts yet? Do the same steps by hand with Playwright and Maestro, keep
the evidence outside the tree, and still produce the report. Do not skip a check because
the tooling is missing; mark it UNVERIFIED.

## The loop

1. **State the flow in one sentence** before testing:
   `<entry point> -> <user action or state> -> <expected visible result>`. For a general
   smoke: app loads -> first meaningful screen renders -> primary controls respond
   without errors.
2. **Get the apps running on a stack you own.** If the backend or an app port is already
   taken by something the stack script did not start, **stop and say which ports are
   taken**. Do not test through them and do not kill them: on a developer machine they
   are usually the simulators' Metros and a backend pointed at staging, and the checks
   could change staging data. Only test against a staging database when the user asks,
   and then answer every write locally unless they allow writes.
3. **Write adversarial instructions, not happy-path ones.** Bad: "check that the form
   renders". Good: "submit empty, with an invalid email, with a wrong password, with
   valid credentials; assert each error message, the redirect, and the console". Cover
   the error, empty, and loading states the change touches. Drive the UI through
   `testID`s; if an element has none, add one to the component first
   (`{screen}-{element}-{qualifier}`), never a class or structural selector.
4. **Capture** every affected app. Visual or layout work gets a desktop and a phone
   viewport.
5. **Run the required checks** on every app × viewport run:

   | Check | Passing looks like |
   |---|---|
   | Right page | Final pathname is the expected one and is not the login page |
   | Not blank | ≥ 40 characters of visible text, not an empty shell or a stuck spinner |
   | No error overlay | No framework red box or compile-error text in the document |
   | Console clean | Zero console or page errors; warnings are listed for you to explain |
   | DOM assertion | ≥ 1 assertion on a visible element, text, or URL, all passed |
   | Interaction proof | ≥ 1 tap / type / key press, followed by an assertion of the new state |
   | Screenshot | ≥ 1 screenshot; a failure screenshot is taken automatically |

   For visual or layout work also look at the phone run for clipping, overlap,
   unreadable text, bad wrapping, layout shift, missing assets, and z-index problems.
6. **Look at every screenshot.** Check the changed state actually rendered: not a
   spinner, not an empty state caused by seed data, not the login page. DOM assertions
   are primary; screenshots support visual claims, they do not replace them. A console
   error in the changed code path is a failure even when the shot looks right: explain
   it or fix it.
7. **Mobile-focused change? Run the matching native flow on the simulator** (below).
8. **If anything fails: fix it and re-verify immediately.** Do not stop to report a
   half-working state. Retry a failing tool or UI action once before calling it a
   blocker. Repeat until zero failures.
9. **Publish and report.** The gist README is the report. Put the link in the PR body
   when there is one, and give the user the link plus the Result line.

Run long captures in the background so you can keep editing.

## Simulator leg (mobile-focused changes)

Required when the change is native screens, gestures, navigation stacks, keyboard
behavior, safe areas, push, camera / permissions, auth storage, `*.ios.tsx`,
`*.android.tsx`, `*.native.tsx`, `Platform.OS` branches, or the ticket says "mobile" or
"app". Web alone is not enough.

Phone apps are verified with the repository's **Maestro** flows on the app's dedicated
simulator, not with an ad-hoc tap script. Run the flow that matches the change (login,
chat, schedule, live session, or whatever the repository's flow list names).

- **No matching flow?** Add one next to the existing flows, reusing their launch and
  login subflows, with `testID` selectors and `extendedWaitUntil` instead of sleeps. The
  new flow is part of the change and stays in the repository. Do not script taps outside
  Maestro.
- **Dev client missing or stale** (`Cannot find native module`, a build older than the
  native dependencies): rebuild it with the repository's documented command, then rerun.
- The flow deep-links the dev client to the app's Metro, so Metro and the backend must
  be the stack you started.

Also check what web cannot: the keyboard does not cover inputs, safe areas, and the
tablet vs phone layout fork. If the simulator or dev client is unavailable, the report
says **UNVERIFIED (simulator)**; a passing web check never stands in for the mobile one.
A platform you did not run stays under remaining risk.

## Evidence rules

- Seed or QA data only. Never screenshot, log, or paste real user data or PHI into
  evidence. Secret gists are unlisted, not private. If the only way to verify is against
  real data, stop and ask.
- Store screenshots, recordings, and temporary test scripts outside the committed source
  tree unless the project specifies an evidence directory or the user asks for committed
  artifacts. Scenario and Maestro flow files that document a feature may stay in the
  repository.
- If credentials are missing, ask for them. Never guess.

## Report format (the gist README)

Findings first when anything broke (what the user sees, repro, evidence, fix made or
open). Then **Result** (PASS / FAIL / UNVERIFIED, one line), **Flow under test**,
**Environment** (URLs, viewports, tool, database, commit), **Remaining risk**, and per
app × viewport: the checks table, the interaction steps, the DOM assertions, every
screenshot labelled, the GIF and MP4, and the console log; then per simulator flow:
result, device, failure text, final screen, failure screenshots, recording, log tail.
Concise, but concrete enough that a PR reviewer trusts it without re-running.

## When you can't verify

No browser tooling, app won't start, missing credentials, ports taken by a stack that is
not yours, needs a device: do not claim it works. Mark it **UNVERIFIED** with the exact
blocker, say what you did verify (build, types, unit tests), give the user the exact
steps to verify themselves, and ask for missing credentials rather than guessing.

## Rationalizations to reject

- "The build passes, so it works." Render it.
- "It's a one-line CSS change." Screenshot it, at phone width too.
- "I checked the happy path." Check error, empty, and loading states.
- "The screenshot looks right." Assert on the DOM as well.
- "There's a console error but it's probably unrelated." Explain it or fix it.
- "I'll mention it might need testing." Verify it or mark it UNVERIFIED.
- "It works on web, and it's React Native, so it works on the phone." Not for
  mobile-focused features. Run the Maestro flow on the simulator.
- "Something is already on the port, I'll just use it." It may be staging. Stop and say
  the ports are taken.
