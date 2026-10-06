---
name: testaudit
description: Audit test coverage for screens and components — identifies gaps, missing testIDs, happy-path-only coverage. Use when assessing test coverage or the user asks about what's tested.
---

This command accepts an optional argument. Behavior changes based on what's provided:

| Input | Example | Scope |
|-------|---------|-------|
| Nothing | `/testaudit` | Full project scan — all screens and user-facing components |
| Feature description | `/testaudit user onboarding flow` | Find all screens/components related to that feature, audit test coverage |
| Folder path | `/testaudit src/screens/settings/` | Audit all screens/components in that folder |
| Single file | `/testaudit src/screens/TodoDetailScreen.tsx` | Audit test coverage for every user interaction and state in that screen |

### Full project audit (`/testaudit` with no argument)

1. **Scan all screens and components** in the app source.
2. **Scan existing test cases** in `qa/test-cases/` and `e2e/`.
3. **Identify gaps:**
   - Screens with no test cases at all
   - Features with happy-path-only coverage (missing error, edge, boundary tests)
   - Test cases marked `[automated]` but no corresponding `.spec.ts` file
   - Components missing `testID` props
4. **Output a coverage report** as a Markdown table with recommendations prioritized by P0 → P1 → P2.

### Scoped audit (`/testaudit` with an argument)

1. **Determine scope.** Based on the argument:
   - **Feature description:** Search the codebase for screens, components, and navigation routes related to the described feature. List what you found and confirm with the user before proceeding.
   - **Folder path:** Read all `.tsx`, `.ts` files in the folder (and subfolders). Identify every screen and component.
   - **Single file:** Read the file. Identify every user interaction, state, and navigation path.

2. **Map the feature surface area.** Build a list of everything that needs test coverage from the user's perspective:
   - Screens and their user interactions (taps, inputs, gestures)
   - UI states: loading, empty, success, error (how the UI responds, not whether the API is correct)
   - Navigation paths into and out of the feature
   - Form validations visible to the user
   - Conditional UI (e.g., admin vs. regular user, permission-gated features)

3. **Check existing coverage.** Cross-reference against:
   - `qa/test-cases/*.md` — do QA test cases exist for this feature?
   - `e2e/*.spec.ts` — do Playwright tests exist?
   - The coverage type table (happy path, error, edge, boundary, empty, loading, accessibility, destructive)

4. **Output a scoped coverage report:**

```markdown
# Test Audit: {Feature / Path}

## Scope
{What was analyzed and why}

## Surface Area
| Screen / Component | Interactions | UI States |
|-------------------|-------------|-----------|
| LoginScreen | email input, password input, submit tap, forgot password link | loading spinner, success → navigate to home, validation error messages, server error banner |
| ForgotPasswordModal | email input, submit tap, close tap | loading, success confirmation, error message |

## Existing Coverage
| Screen / Component | QA Cases | Playwright | Missing Coverage |
|-------------------|----------|------------|-----------------|
| LoginScreen | 5 (auth-login.md) | 3 (auth-login.spec.ts) | empty state, accessibility, server error banner |
| ForgotPasswordModal | 0 | 0 | all — no test cases exist |

## Recommendations (by priority)

### P0 — Must add
- [ ] TC for what the user sees when login fails due to server error (error banner, retry option)
- [ ] TC for ForgotPasswordModal happy path (submit email → see confirmation)

### P1 — Should add
- [ ] TC for accessibility: keyboard navigation through login form
- [ ] TC for "Forgot Password" link opens the modal correctly
- [ ] Playwright test for validation error states (currently QA-only)

### P2 — Nice to have
- [ ] TC for extremely long email input (boundary)
- [ ] TC for double-tap on submit button (edge case)

## Missing testIDs
- `LoginScreen` → root View needs `testID="login-screen"`
- Forgot Password link needs `testID="login-forgot-password-link"`
```

5. **Offer to generate.** After showing the report, ask: "Want me to generate the missing test cases now? I'll start with the P0 items."
