## Why
Admin table sync drops rows past the first window.

## What changed
- Window the sync cursor (T3, T4).

## Verification
| Status | Scope | Evidence / action |
| --- | --- | --- |
| ✅ Tested | Windowed sync | `bun test` |

<details>
<summary>Details</summary>
Plan: `docs/implementationPlans/windowed-admin-sync.md`
</details>
