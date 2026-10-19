## Why
Terreno's GCP story was "how Flourish deploys Terreno". Part of [#1005](https://github.com/TerrenoLabs/terreno/issues/1005) (IP: `docs/implementationPlans/deploy-to-gcp.md`, Tasks 2.1–2.2).

## What changed
- New `terraform/modules/terreno-backend`: Artifact Registry, runtime SA, Cloud Run service.
- Root Terraform moved to `infra/flourish/`.

## Verification
| Status | Scope | Evidence / action |
| --- | --- | --- |
| ✅ Tested | Module behavior and IAM scoping | `terraform test` → 8 passed |
| 🧭 Test instructions | Preview no-op | Open the `gcp-cd-preview` job log and confirm `Plan: 0 to add` |
| ⚠️ Not tested | Live apply to a scratch project | Deferred per GC8 |

<details><summary>Details</summary>
- Secrets are created empty, so they are mounted at deploy time.
<details><summary>Stage result</summary>

```yaml
v: 2
stage: brew
status: PASS
ip: deploy-to-gcp
sha: 775ed94aa1e0dd103a98f9965b93390bbd3db2c3
done: ["2.1 Roast PASS", "2.2 Roast PASS"]
next: taste
action: Watch CI and review bots; react
```
</details></details>
