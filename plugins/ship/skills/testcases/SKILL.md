---
name: testcases
description: Generate QA test case files for new or changed components. Use when new components or screens are created or significantly modified and test cases should be generated.
---

When the user runs `/testcases`, do the following:

1. **Identify what's new or changed.** Look at recently modified screen/component files (or ask the user which feature to cover).

2. **Read the component code** to understand all user interactions, states (loading, empty, error, success), edge cases, and validation rules.

3. **Generate the QA test case file** at `qa/test-cases/{feature}.md` following the format in `qa-test-case-format.md`. Cover all required test types from the coverage table.

4. **Mark which tests can be automated.** For each test case, determine if it's Playwright-eligible.

5. **If Playwright-eligible tests exist**, ask the user: "I've written {N} QA test cases, {M} of which can be automated with Playwright. Want me to write and run the Playwright tests now?"

6. **Regenerate `qa/test-cases/_index.md`** with updated counts.
