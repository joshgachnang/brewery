---
name: playwright-react-native-web
description: Write and run rock-solid Playwright end-to-end tests against a React Native Web application. Use when the user wants to add, write, debug, or run Playwright tests for an app built with React Native for Web (Expo Web, RNW).
---

# Playwright × React Native Web Testing

## Overview

This skill helps you write reliable, non-flaky Playwright tests against React Native Web (RNW) apps. RNW renders non-standard HTML — most elements are `<div>` with ARIA roles instead of semantic tags — so standard Playwright selectors will fail silently or be brittle. This skill encodes the patterns that actually work.

---

## Critical: How RNW Renders to the DOM

Before writing ANY selector, understand these mappings:

| RN Component        | DOM Output                          | Key Attribute            |
|----------------------|-------------------------------------|--------------------------|
| `<View>`             | `<div>`                             | —                        |
| `<Text>`             | `<div role="text">` or `<span>`     | `dir="auto"`             |
| `<Pressable>`        | `<div role="button" tabindex="0">`  | `aria-disabled`, cursor  |
| `<TouchableOpacity>` | `<div role="button">`               | `tabindex="0"`           |
| `<TextInput>`        | `<input>` or `<textarea>`           | standard HTML input      |
| `<Image>`            | `<img>` or `<div>` with background  | `role="img"`             |
| `<ScrollView>`       | `<div>` with overflow styles        | —                        |
| `<FlatList>`         | `<div>` containing item divs        | —                        |
| `<Switch>`           | `<div role="switch">`               | `aria-checked`           |
| `<ActivityIndicator>`| `<div role="progressbar">`          | `aria-valuetext`         |

### The #1 Rule: Use `testID` Everywhere

In RN code, `testID` maps to `data-testid` in the DOM. This is your **primary selector strategy**.

```tsx
// Component code
<Pressable testID="submit-button" onPress={handleSubmit}>
  <Text testID="submit-label">Save</Text>
</Pressable>
```

```ts
// Test code — reliable
await page.getByTestId('submit-button').click();

// Test code — FRAGILE, avoid
await page.locator('div[role="button"]').click(); // which button?
await page.getByText('Save'); // text may change, be duplicated, or be nested oddly
```

---

## Selector Strategy (Priority Order)

1. **`getByTestId()`** — Always prefer. Stable, immune to DOM structure changes.
2. **`getByRole()` + name** — Good for semantic queries: `getByRole('button', { name: 'Save' })`
3. **`getByPlaceholder()` / `getByLabel()`** — For `<TextInput>` elements with labels or placeholders.
4. **`getByText()`** — Use sparingly. RNW nests text in extra `<div>`s; `exact: false` or `hasText` may be needed.
5. **CSS selectors** — Last resort. Never select by class name (they're generated hashes).

### Selector Anti-Patterns (Never Do These)

```ts
// ❌ Class names are generated — will break on rebuild
page.locator('.css-1a2b3c4')

// ❌ Deep structural selectors — RNW DOM structure is an implementation detail
page.locator('div > div > div > div[role="button"]')

// ❌ Index-based selectors without scoping — fragile
page.locator('div[role="button"]').nth(3)

// ✅ Instead, scope to a testID container, THEN narrow
page.getByTestId('user-list').getByRole('button', { name: 'Delete' })
```

---

## Dealing with RNW Async Behavior

RNW apps are full of async: navigation transitions, data fetching, animations, and layout shifts. **Flaky tests almost always come from not waiting properly.**

### Wait Patterns

```ts
// ✅ Wait for a specific element that proves the page/state is ready
await page.getByTestId('dashboard-content').waitFor({ state: 'visible' });

// ✅ Wait for network idle after navigation
await page.waitForLoadState('networkidle');

// ✅ Wait for an element to disappear (loading spinner)
await page.getByTestId('loading-spinner').waitFor({ state: 'hidden' });

// ❌ Never use fixed timeouts
await page.waitForTimeout(3000); // FLAKY — too short on CI, too slow locally
```

### Navigation Waits

React Navigation on web uses hash or path-based routing. After triggering navigation:

```ts
// Trigger navigation
await page.getByTestId('go-to-settings').click();

// Wait for the destination to be ready — don't just check URL
await page.getByTestId('settings-screen').waitFor({ state: 'visible' });

// If you need URL-based waits:
await page.waitForURL('**/settings');
```

### Animations

RNW `Animated` and `react-native-reanimated` cause elements to exist in the DOM but be invisible/offscreen during transitions.

```ts
// ✅ Wait for the final state, not just DOM presence
await expect(page.getByTestId('modal-overlay')).toBeVisible();

// ✅ For disappearing elements (modal close animation)
await page.getByTestId('close-modal').click();
await page.getByTestId('modal-overlay').waitFor({ state: 'detached', timeout: 5000 });
```

---

## Form Interaction Patterns

RNW `<TextInput>` renders as `<input>` or `<textarea>`, so standard Playwright fill works — but **clear first**:

```ts
// ✅ fill() clears and types — use this
await page.getByTestId('email-input').fill('user@example.com');

// ✅ For inputs that have custom onChange handlers that need keystrokes:
await page.getByTestId('search-input').pressSequentially('search term', { delay: 50 });

// ✅ For RN Switch components
const toggle = page.getByTestId('notifications-toggle');
await toggle.click(); // toggles the switch
await expect(toggle).toHaveAttribute('aria-checked', 'true');
```

---

## Test File Structure

```ts
import { test, expect } from '@playwright/test';

// Group related tests
test.describe('Feature: User Authentication', () => {
  // Navigate to starting point before each test
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-screen').waitFor({ state: 'visible' });
  });

  test('shows validation errors for empty form', async ({ page }) => {
    await page.getByTestId('submit-button').click();
    await expect(page.getByTestId('email-error')).toBeVisible();
    await expect(page.getByTestId('email-error')).toHaveText(/required/i);
  });

  test('successfully logs in with valid credentials', async ({ page }) => {
    await page.getByTestId('email-input').fill('test@example.com');
    await page.getByTestId('password-input').fill('password123');
    await page.getByTestId('submit-button').click();

    // Wait for navigation to complete — don't just check URL
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 10000 });
    await expect(page).toHaveURL(/\/home/);
  });
});
```

---

## Playwright Configuration for RNW

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',

  use: {
    baseURL: 'http://localhost:19006',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

---

## Common RNW Testing Recipes

### Testing FlatList / ScrollView Content

```ts
// Wait for list to populate
const list = page.getByTestId('todo-list');
await list.waitFor({ state: 'visible' });

// Count items
const items = list.getByTestId(/^todo-item-/);
await expect(items).toHaveCount(5);

// Interact with a specific item
await list.getByTestId('todo-item-3').getByRole('button', { name: 'Delete' }).click();
await expect(items).toHaveCount(4);
```

### Testing Modals / Overlays

```ts
await page.getByTestId('open-modal-button').click();
const modal = page.getByTestId('confirmation-modal');
await modal.waitFor({ state: 'visible' });

await modal.getByTestId('confirm-button').click();
await modal.waitFor({ state: 'detached' });
```

### Testing Toast / Snackbar Notifications

```ts
await page.getByTestId('save-button').click();

// Toasts are often animated — wait for visibility
const toast = page.getByTestId('toast-message');
await toast.waitFor({ state: 'visible', timeout: 5000 });
await expect(toast).toContainText(/saved/i);

// Optionally wait for it to auto-dismiss
await toast.waitFor({ state: 'hidden', timeout: 8000 });
```

### Testing with Authentication State

```ts
// Create a reusable auth setup
// auth.setup.ts
import { test as setup, expect } from '@playwright/test';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('email-input').fill('test@example.com');
  await page.getByTestId('password-input').fill('password123');
  await page.getByTestId('submit-button').click();
  await page.getByTestId('home-screen').waitFor({ state: 'visible' });

  // Save auth state
  await page.context().storageState({ path: './e2e/.auth/user.json' });
});
```

---

## Debugging Flaky Tests

When a test is flaky, add these to diagnose:

```ts
// 1. Pause and inspect the page interactively
await page.pause();

// 2. Screenshot at a specific point
await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });

// 3. Log the actual DOM structure of an element
const html = await page.getByTestId('problem-area').innerHTML();
console.log(html);

// 4. Check if element exists but is hidden (common RNW issue with transforms/opacity)
const el = page.getByTestId('maybe-hidden');
console.log('visible:', await el.isVisible());
console.log('count:', await el.count());
```

---

## Setup Commands

### Running Tests

```bash
# Run all tests
bunx playwright test

# Run with UI mode (interactive — great for debugging)
bunx playwright test --ui

# Run a specific test file
bunx playwright test e2e/login.spec.ts

# Run in headed mode (see the browser)
bunx playwright test --headed

# Show HTML report
bunx playwright show-report
```

---

## Checklist Before Committing Tests

- [ ] Every interactive element in the app under test has a `testID`
- [ ] No selectors rely on class names or deep DOM structure
- [ ] All navigation waits use element visibility, not `waitForTimeout`
- [ ] Tests pass 5x consecutively locally before being called stable
- [ ] Animations are waited through, not just assumed complete
- [ ] Auth state is stored/reused, not re-created per test
- [ ] Tests are grouped in `describe` blocks by feature
- [ ] Assertions use `expect()` auto-retry (not manual polling)

---

## Adding testIDs to Your RN Components

If the app is missing `testID` props, here's the pattern to add them systematically:

```tsx
// Pattern: screen-element-qualifier
// Examples:
<View testID="login-screen">
  <TextInput testID="login-email-input" />
  <TextInput testID="login-password-input" />
  <Pressable testID="login-submit-button">
    <Text>Log In</Text>
  </Pressable>
  <Text testID="login-error-message">{error}</Text>
</View>
```

Naming convention: `{screen}-{element}-{qualifier}`
- `login-email-input`
- `settings-notifications-toggle`
- `profile-avatar-image`
- `todo-item-{id}` (dynamic IDs for list items)
