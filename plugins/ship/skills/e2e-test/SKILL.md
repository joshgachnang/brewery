---
name: e2e-test
description: Scaffold and write a new Playwright E2E test for example-frontend. Use when the user asks to add or write an E2E test for a specific screen or feature.
---

# Build a Playwright E2E Test

## Overview

This skill scaffolds a new Playwright E2E test for `example-frontend`. Follow each step in order.

## Arguments

$ARGUMENTS: The screen or feature to test (e.g. "todos", "profile", "signup")

---

## Step 1: Understand the Feature

Read the relevant screen file(s) in `example-frontend/app/` to understand:
- What `testID` props already exist
- What interactions and states are present
- Whether the screen requires authentication

```bash
# Find relevant screen files
find example-frontend/app -name "*.tsx" | xargs grep -l "$ARGUMENTS" 2>/dev/null
```

## Step 2: Add Missing testIDs

If the screen lacks `testID` props for elements you need to test, add them now before writing the test.

Rules:
- Root `<View>` of every screen: `testID="{screen}-screen"` (e.g. `testID="todos-screen"`)
- All interactive elements: `testID="{screen}-{element}-{qualifier}"` (e.g. `testID="todos-create-button"`)
- Error messages: `testID="{screen}-error"`
- Loading indicators: `testID="{screen}-loading"`
- List items: `testID="{screen}-item-{id}"` (dynamic)

## Step 3: Create the Test File

Create `example-frontend/e2e/{feature}.spec.ts`.

### Template for authenticated screens

```typescript
import {expect, test} from "@playwright/test";
import {loginAs} from "./helpers/login";

test.describe("{Feature}", () => {
  test.beforeEach(async ({page}) => {
    await loginAs(page);
    await page.getByTestId("{feature}-screen").waitFor({state: "visible"});
  });

  test("renders correctly", async ({page}) => {
    await expect(page.getByTestId("{feature}-screen")).toBeVisible();
    // Assert key UI elements are visible
  });

  test("user can {primary action}", async ({page}) => {
    // Steps to perform the action
    // Wait for result
  });
});
```

### Template for unauthenticated screens (e.g. login, signup)

```typescript
import {expect, test} from "@playwright/test";

test.describe("{Feature}", () => {
  test.beforeEach(async ({page}) => {
    await page.goto("/{route}");
    await page.getByTestId("{feature}-screen").waitFor({state: "visible"});
  });

  test("renders correctly", async ({page}) => {
    await expect(page.getByTestId("{feature}-screen")).toBeVisible();
  });
});
```

## Step 4: Write Meaningful Test Cases

Cover these scenarios in priority order:
1. **Renders correctly** — key elements are visible on load
2. **Happy path** — primary user action succeeds
3. **Error state** — what happens when something fails (invalid input, network error, etc.)
4. **Navigation** — links/buttons that take the user elsewhere

Name tests as user behaviors: `"user can create a todo"`, `"shows error with invalid input"`.

## Step 5: Verify the Test Runs

```bash
cd example-frontend && bunx playwright test e2e/{feature}.spec.ts --headed
```

Fix any failures before considering the test complete. Common issues:
- Missing `testID` → add to the component
- Strict mode violation (multiple elements) → scope with `.first()` or fix duplicate testIDs
- Timeout → add explicit `waitFor({state: 'visible'})` after navigation or action
- Never use `waitForTimeout()` — always wait for a specific element state

## Step 6: Check for Lint Errors

```bash
cd example-frontend && bun run lint
```

Fix any issues before committing.

## Step 7: Commit

Commit the spec file and any component changes together:
```bash
git add example-frontend/e2e/{feature}.spec.ts example-frontend/app/...
git commit -m "Add E2E tests for {feature}"
```
