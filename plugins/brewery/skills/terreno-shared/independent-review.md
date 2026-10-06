# Independent review

Review a pinned branch diff without changing code. Keep two axes separate:

1. **Repository standards:** applicable instructions/project skills, behavior,
   architecture, security, maintainability, and test quality.
2. **IP/spec:** missing, partial, incorrect, or unrequested behavior; promised tests/docs
   absent; acceptance criteria not met.

Resolve the fixed point. The **parent** builds one [task-scoped briefing](subagent-briefing.md):
current task, criteria, file list, and the patch for those files only. Give each axis
to a fresh reviewer **with that briefing** when the harness supports it. Reviewers must
not rediscover skills, load unnamed lifecycle references, run a full-branch `git diff`,
or spawn nested reviewers. Require the rule or quoted requirement plus concrete
file/hunk evidence for every finding. Tool-enforced formatting is not a review finding.

Rank severity only within an axis. A clean review has no unresolved material finding in
either available axis. If no spec exists, state that; never invent one.

Return:

```markdown
## Standards
<findings or "No material findings">

## Spec
<findings, "No material findings", or "No spec available">

Summary: <count> standards finding(s); <count> spec finding(s).
```

