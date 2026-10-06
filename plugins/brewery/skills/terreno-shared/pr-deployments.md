# PR deployments in chat

When a pull request has GitHub Deployments attached, the human must see those demo
URLs without hunting through CI, comments, or the middle of a long reply.

This is **chat-only**. Do not post the links as a PR comment. Do not wait for
deployments to become ready just to print them. Print what is attached now.

## When to print

Close with the Demo section on every **user-visible** message that either:

- waits for human input (grilling round, confirm-and-write, `BLOCKED` human gate,
  `ask`, or any other stop that needs a reply), or
- ends the invocation (`PASS`, `FAIL`, `BLOCKED`, `PENDING`, completion report)

Skip the section when there is no PR, GitHub access cannot list deployments, or the
PR/head has no `environmentUrl` values. Do not write "no deployments."

Do not print this on intermediate tool-only work. Print it on the message the human
reads.

## Where it goes

Lead with `status` / `next` / `action` (or the grilling/gate question). Put stage YAML
in a collapsed Details block. **The last visible section is Demo** whenever URLs exist.

A human-gate question still appears in the body. Demo follows it so the links are the
last thing on screen.

## Discover

1. Resolve the current PR number and head SHA (`gh pr view --json number,url,headRefOid`
   on this branch, or the PR already in execution state).
2. List GitHub Deployments for that PR/head. Prefer GraphQL on the pull request:

   ```bash
   gh api graphql -F owner=<owner> -F name=<repo> -F number=<pr> -f query='
   query($owner:String!,$name:String!,$number:Int!){
     repository(owner:$owner,name:$name){
       pullRequest(number:$number){
         deployments(last:20){
           nodes{
             environment
             latestStatus{state environmentUrl createdAt}
           }
         }
       }
     }
   }'
   ```

   REST fallback: `gh api "repos/<owner>/<repo>/deployments?sha=<headSha>&per_page=20"`,
   then each deployment's statuses for `environment_url`.
3. Keep rows whose latest status has a non-empty `environmentUrl` (success, in-progress,
   or queued with a preview URL already assigned). Skip statuses that only have a log URL.
4. Deduplicate by URL. For the same environment name, keep the newest `createdAt`.
5. Do not invent URLs from job names. Do not scrape PR comments for previews.

## How to print

```markdown
## Demo

- **<environment>**: <environmentUrl>
```

Use the deployment environment name as the label. One bullet per unique URL. No extra
prose. No CI log links in this section.
