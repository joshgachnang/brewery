## Why
Posts load twice on cold start. See [the plan](docs/plans/2026-10-01-post-cache.md).

## What changed
- Cache the first page in syncdb.

## Verification
| Status | Scope | Evidence / action |
| --- | --- | --- |
| ✅ Tested | Cold start loads once | `bun test apps/web/posts` → 4 passed |

![cold start](https://user-images.githubusercontent.com/1/cold.png)
<img src="https://gist.github.com/x/warm.gif" width="300">
