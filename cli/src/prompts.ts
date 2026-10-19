// Prompts for each step. Skills hold the method; these say which slice of it this
// process runs and where brewery takes over.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ask, Finding } from "./agents.ts";
import { activeRules, RULES_PATH } from "./docs.ts";
import type { Ctx } from "./step.ts";
import { refreshNotes } from "./state.ts";
import type { PlanRef } from "./approve/context.ts";
import type { PrSnapshot } from "./vcs.ts";

const skill = (ctx: Ctx, path: string): string => join(ctx.config.skillsDir, path);

// Per-task steps prove a slice with the fast tiers. Browser suites run once, on the
// integrated branch, where cross-task behavior is visible anyway.
const fastTestsOnly = `- Run only fast checks for the packages this task touches: lint, typecheck, and unit and
  integration tests. Do not run e2e, Playwright, or other browser suites, and do not launch
  the app for UI verification. brewery runs those once in the integrated roast. You may
  write or update an e2e spec; check that it typechecks, not that it passes.`;

const taskSplitting = `Task splitting rules:
- Put the tracer first.
- Each task is one independently testable behaviour that can be roasted on its own.
- Every task carries an indented Depends on: line (Depends on: none or Depends on: T1, T3)
  and Files: listing the files or seams it touches.
- Two tasks that share a file depend on each other; order their writes with a dependency.
- Prefer wide over deep: fan out independent tasks and keep dependency chains short.
  Depend on a task only when this one reads or extends something that task creates.
  Never chain tasks just to order them; a chain longer than 3 needs a reason per link.
- List every file each task writes in Files:, including shared registries, barrels, and
  route or tool indexes. brewery never builds two tasks with a shared file at once.
- Split any task that needs more than one roast-able behaviour.`;

const fileResult = (resultFile: string): string => `- Before exiting, write your result as JSON to:
    ${resultFile}
  Shape: {"status": "PASS" | "FAIL" | "BLOCKED" | "PENDING", "action": "<next concrete action>",
          "summary": "<what you did>", "ask": [{"q": "", "rec": "", "opts": [""]}],
          "fail": [{"need": "", "want": "", "got": "", "ev": ""}],
          "block": [{"kind": "human|environment|access|external", "why": "", "ev": ""}]}
  plus any step-specific keys named below. Omit keys you do not use. Writing this file is
  mandatory, including on failure.
`;

const readOnlyResult = `- This is a read-only step. You cannot edit files or write a result file. Read what you
  need, then give your final answer as one JSON object that matches the schema this step
  was launched with. Nothing else goes in the final answer.
`;

export const header = (ctx: Ctx, resultFile: string, opts: { readOnly?: boolean } = {}): string => {
  refreshNotes(ctx.state);
  const answers = ctx.state.answers.length
    ? `\nPrior human answers. Treat these as settled decisions; do not re-ask them.\n${ctx.state.answers
        .map((a) => `- Q: ${a.q}\n  A: ${a.a}`)
        .join("\n")}\n`
    : "";
  const notes = ctx.state.notes?.length
    ? `\nNotes the human added, mid-run. Apply these at the next sign-off or gate.\n${ctx.state.notes
        .map((note) => `<note>\n${note}\n</note>`)
        .join("\n")}\n`
    : "";
  const rules = activeRules(ctx.state.repo);
  const learned = rules.length
    ? `\nRules learned from past runs in this repo (${RULES_PATH}). Follow them:\n${rules.join("\n")}\n`
    : "";
  return `You are running one bounded step of a brewery run in ${ctx.state.repo}.
brewery is the outer loop. It owns sequencing, retries, commits between tasks, waiting on
CI, and every contact with the human.

Rules for this step:
- Do only the step below, then exit. Do not start another stage, loop to the next task,
  or invoke a skill or command that does (barrel, finish, planning-loop, pick-roast-loop).
- The human is not available. Never ask a question in chat or with a question tool.${opts.readOnly ? "" : ` Put
  a human decision in \`ask\` (question, recommended answer, options) with status BLOCKED.`}
- Never add AI attribution to commits, PRs, or comments. No conventional-commit prefixes.
- Never put PHI, customer data, or secrets in your result.
${opts.readOnly ? readOnlyResult : `${fileResult(resultFile)}${answers}${notes}${learned}`}`;
};

export const distillBody = (ctx: Ctx, request: string, ipPath: string): string => `## Step: distill (write the IP)

Read and follow ${skill(ctx, "distill/SKILL.md")} steps 1–9, with these overrides:
- Write the IP at ${ipPath} unless the repository's instructions name another location.
  Put the path you used in the result's \`ip\` key.
- The human is not in the chat. For fundamental questions, follow step 6's async branch:
  write the plan on your recommendation and mark the question fundamental.
- Stop after step 9. brewery runs cut (step 10) and sign-off (step 11) itself.
- Leave the \`Status:\` line as \`Status: draft\`. brewery owns that line.
${existsSync(join(ctx.state.repo, "docs", "learnings")) ? "- Before shaping the plan, grep the frontmatter in docs/learnings/ (module, component, tags,\n  symptoms) for the area this request touches. Carry what applies into the IP as constraints,\n  and name approaches that already failed so Pick does not retry them.\n" : ""}
- The task list must use exactly this line format so brewery can track it, with details
  indented or in a following block:
    - [ ] **T1** — <task title, written as a commit subject>
- In \`ask\`, put the sign-off questions: fundamental first, then the open questions whose
  answers would change the most. At most 5. Status PASS when the IP is written.

${taskSplitting}

The request, verbatim:

<request>
${request}
</request>`;

export const fixBody = (ctx: Ctx, findings: Finding[]): string => `## Step: distill step 10 (fix the cut findings)

Read ${skill(ctx, "distill/SKILL.md")} step 10 and ${skill(ctx, "distill/references/distilling.md")}.
The IP is ${ctx.state.ip}. A fresh attacker that saw only the human's words produced these
findings. For each one, edit the IP, move it to Open questions or Expansions, or rebut it in
one line with evidence. Every blocking finding must be handled. Record the tally in the
Sign-off section's \`Cut:\` line. Leave the \`Status:\` line alone. Keep the task line format.

${taskSplitting}

Result keys: \`structural\` (true when a blocking finding changed tasks, the tracer, or the
data model), \`tally\` ({edited, moved, rebutted}), and \`ask\` (the refreshed sign-off
questions, at most 5, fundamental first).

Findings:
\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\``;

export const applyReplyBody = (ctx: Ctx, asks: Ask[], reply: string, verdict: string): string => `## Step: distill step 12 (apply the human's reply)

Read ${skill(ctx, "distill/SKILL.md")} step 12 and ${skill(ctx, "distill/references/distilling.md")}.
The IP is ${ctx.state.ip}. brewery sent these questions:

${asks.map((a, i) => `${i + 1}. ${a.q} (recommended: ${a.rec}${a.opts?.length ? `; options: ${a.opts.join(" / ")}` : ""})`).join("\n")}

The human replied, verbatim:

<reply>
${reply}
</reply>

brewery read this reply as: ${verdict}.
- "ok" alone accepts every recommendation. "2b" picks option b for question 2.
- Move every question the reply settles into Decisions, with the question as asked. Mark
  the ID \`(durable)\` only when the answer should outlive this plan (see distilling.md).
- Where an answer differs from the recommendation, rewrite the affected tasks and criteria.
${verdict === "reject" ? "- The human rejected the plan. Return to distill step 5 with their reason and reshape it.\n" : ""}- Leave the \`Status:\` line alone. brewery sets it. Keep the task line format.

Result keys: \`structural\` (true when tasks, tracer, or data model changed) and \`ask\`
(questions still genuinely open that need the human before building; usually none).`;

export const cutBody = (ctx: Ctx, context: string, ipRel: string): string => `## Step: cut (attack the IP)

Read ${skill(ctx, "cut/SKILL.md")} and act as the attacker it describes. You are in a clean
checkout. You have only what the human said and the plan at ${ipRel}. You may read the files
the IP cites to check its claims about the code. Do not look for planning notes.

Attack axis 7. Decomposition: two tasks that write the same file with no dependency between them;
a task that is really two independently roast-able behaviours; a chain that could be a fan-out;
a dependency with no real read/extend relationship; a Files: line that omits a shared
registry, index, or barrel the task must edit.

Result: status PASS, and \`findings\`: at most 12, most severe first, each
{"id": "C1", "severity": "blocking" | "should-fix" | "nit", "axis": "", "where": "",
"attack": "", "evidence": "", "fix": ""}. A finding without evidence is dropped. An empty
list is a valid answer.

What the human said, verbatim:

<human>
${context || "(no transcript: use the ticket or PR the IP cites and its Decisions table)"}
</human>`;

export const pickBody = (ctx: Ctx, taskId: string, taskTitle: string, evidence?: string): string => `## Step: pick ${taskId} — ${taskTitle}

Read and follow ${skill(ctx, "barrel/stages/pick.md")} steps 1–11 for task ${taskId} of the
IP at ${ctx.state.ip}, and no other task. Overrides:
- Skip step 12 (Roast), 13 (commit), and 14 (continue). brewery commits your working tree
  when you finish, runs Roast in separate agents, and picks the next task.
- Do not commit, push, or edit the task's checkbox. brewery marks it.
${fastTestsOnly}
- Status PASS when the task is built and your own checks are green. FAIL with evidence
  when you cannot get it green. BLOCKED only for a genuine human or access gate.
${evidence ? `\nThis is a retry. Roast or the previous attempt reported the following. Form a new
hypothesis from it; do not repeat an approach that already failed.\n\n\`\`\`json\n${evidence}\n\`\`\`\n` : ""}`;

export const roastBody = (ctx: Ctx, taskId: string, taskTitle: string, base: string): string => `## Step: roast ${taskId} — ${taskTitle}

Read and follow ${skill(ctx, "barrel/stages/roast.md")} for task ${taskId} of the IP at
${ctx.state.ip}. The task's work is the HEAD commit on this branch (\`git show HEAD\`; the
branch diff is \`git diff ${base}...HEAD\`). You are an independent verifier. Do not trust
any claim of completion. Prove or disprove every acceptance criterion of ${taskId} by
running things. Do not fix implementation code. Do not commit.
${fastTestsOnly}
- A criterion that only a browser or running app can prove is not FAIL here. Prove what
  the fast tiers can, and list the rest in \`summary\` as deferred to the integrated roast.

Status PASS only when every criterion has passing evidence. FAIL with one \`fail\` entry per
disproved criterion (need, want, got, reproducible ev).`;

export const integratedRoastBody = (ctx: Ctx): string => `## Step: roast INTEGRATE (integrated branch)

Independently prove every task's acceptance criteria on the combined tree against the
IP at ${ctx.state.ip}. Run the repo's full test command, including cross-task behavior.
This is the only step that runs e2e, Playwright, and other browser suites. Run them
all, and launch the app to exercise every UI-facing criterion the per-task roasts deferred.
All tasks have landed on this feature branch. Judge the combined HEAD, not just the
last task commit. Use ${skill(ctx, "barrel/stages/roast.md")} for verification method.
Do not fix code or commit. Do only this integrated roast, then exit.
Status PASS only with passing evidence for every criterion; otherwise FAIL with
one fail entry per disproved criterion (need, want, got, reproducible ev).`;

export const integrationFixBody = (ctx: Ctx, evidence: string): string => `## Step: pick INTEGRATE (fix integration of parallel tasks)

Read ${skill(ctx, "barrel/stages/pick.md")} for method (specify, failing test, fix, clean up).
Fix the combined-tree failures against the IP at ${ctx.state.ip} in the main tree.
Do not commit, push, edit task checkboxes, run Roast, or continue to another stage.
Status PASS when the integration failures are fixed and your own checks are green.
Use the evidence below to form a focused hypothesis and add a regression test.

Evidence:
\`\`\`json
${evidence}
\`\`\``;

export const reviewBody = (ctx: Ctx, base: string): string => `## Step: branch review

Review the whole branch against the IP at ${ctx.state.ip}, following
${skill(ctx, "terreno-shared/independent-review.md")}. The change is \`git diff ${base}...HEAD\`.
Look for correctness bugs, spec drift, missing tests or docs, security and PHI exposure.
Read only. Do not edit files, run formatters, or commit.

Result: status PASS, and \`findings\` (at most 12, most severe first), each
{"id": "R1", "severity": "blocking" | "should-fix" | "nit", "where": "<file:line>",
"attack": "<the defect>", "evidence": "<code quote or reproduction>", "fix": ""}.
Blocking means it must not ship. An empty list is a valid answer.`;

export const reviewFixBody = (ctx: Ctx, findings: Finding[]): string => `## Step: pick REVIEW (fix branch-review findings)

Read ${skill(ctx, "barrel/stages/pick.md")} for method (specify, failing test, fix, clean up).
Fix these branch-review findings on the IP at ${ctx.state.ip}. Do not commit or push.
Status PASS when each blocking finding is fixed with a test that would have caught it.
${fastTestsOnly}

\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\``;

export const roastReviewFixBody = (ctx: Ctx, findings: Finding[]): string => `## Step: roast REVIEW

Independently verify that the HEAD commit fixes each of these findings without regressing
the IP at ${ctx.state.ip}. Run the repository's tests for the touched packages. Do not fix
code.
${fastTestsOnly}
Status PASS or FAIL with one \`fail\` entry per finding still present.

\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\``;

export const brewBody = (ctx: Ctx, base: string): string => `## Step: brew (submit)

Read and follow ${skill(ctx, "barrel/stages/brew.md")} for the IP at ${ctx.state.ip} on branch
${ctx.state.branch} against ${base}. Overrides:
- Skip step 4 (independent review). brewery already ran a multi-agent branch review.
- Every task is already committed and Roast-verified. Do not rewrite those commits.
- Skip step 12. brewery runs finish.
Result keys: \`pr\` (the PR number) and \`sha\` (the pushed head).`;

export const tasteBody = (ctx: Ctx, pr: number, snap: PrSnapshot): string => `## Step: taste (one reaction on PR #${pr})

Read ${skill(ctx, "finish/taste.md")} and ${skill(ctx, "finish/SKILL.md")}. Perform exactly one
reaction on PR #${pr}. brewery already waited for CI and bots, so skip taste steps 3–4 and
the post-push watch in step 10. Push at most once. brewery watches the new head.

Current snapshot of head ${snap.sha}:
- mergeable: ${snap.mergeable} (${snap.mergeState})
- checks:
${snap.checks.map((c) => `  - ${c.bucket.toUpperCase()} ${c.name}${c.link ? ` ${c.link}` : ""}`).join("\n") || "  (none)"}
- unanswered bot review threads:
${(snap.botThreads ?? []).map((t) => `  - ${t.id} ${t.author}${t.path ? ` ${t.path}${t.line ? `:${t.line}` : ""}` : ""}: ${t.body.replace(/\s+/g, " ")}`).join("\n") || "  (none)"}

Act on it:
- A conflict: merge the latest base and resolve per taste step 9. A conflict that needs a
  behavior choice is BLOCKED with an \`ask\`.
- A branch-caused failure: fix it, run the pre-push gates, push.
- A failure the branch did not cause (fails on base too, known flake, infrastructure): rerun
  only the failed jobs (\`gh run rerun <id> --failed\`). Never push code for it.
- Every unanswered bot thread above: fix it and resolve the thread, or reply with one
  sentence (false positive, intended, or out of scope with a follow-up link) and resolve
  it. Leave one open only as a human decision, with an \`ask\`. Never leave one unanswered.
Status PASS after acting (or when nothing was actionable), with \`sha\` set to the head you
leave. BLOCKED for a human decision, with \`ask\`.`;

export const compoundBody = (ctx: Ctx, evidence: string): string => `## Step: compound (record at most one learning)

Read and follow ${skill(ctx, "compound/SKILL.md")}. The run's IP is ${ctx.state.ip}; the branch is
${ctx.state.branch} against ${ctx.state.base}. This run struggled here:

${evidence}

${ctx.config.phi ? "This repo handles PHI. Do not quote CI log lines in the learning; describe the error by its shape.\n\n" : ""}Write or update at most one file under docs/learnings/<category>/<slug>.md, using
docs/learnings/TEMPLATE.md, or write nothing when the bar is not met. Change no other file:
not RULES.md, not code. brewery commits what you leave. Do not commit or push.

Result: status PASS, \`learning\` (the repo-relative path you wrote or updated, or null), and
\`summary\` (one line: what the learning says, or why nothing cleared the bar).`;

export const cellarBody = (ctx: Ctx, name: string, since: string, evidence: string): string => `## Step: cellar (learn from ${name} since ${since})

Read and follow ${skill(ctx, "cellar/SKILL.md")}. You are in a fresh worktree of the default
branch of ${name}, on a new branch. Learning mode for this repo: ${ctx.config.learn}.${ctx.config.phi ? "\nThis repo handles PHI: never quote CI log lines in anything you write; describe errors by shape." : ""}
brewery commits what you leave, pushes, and opens one PR. Do not commit, push, or open a PR.

Limits brewery enforces: at most 3 changes counting each new Active rule in
docs/learnings/RULES.md and each changed file outside docs/learnings/<category>/. Over the
limit, nothing ships. Learning files themselves are not counted.

Result: status PASS, \`summary\` (two or three sentences for the PR description),
\`changes\` (one line per change, each citing its evidence: run, PR, CI link, or learning)${
  ctx.config.learn === "shared"
    ? `, and \`proposals\` (markdown: generic changes to the brewery skills that would have
prevented these failures in any repo; describe them, do not edit skill files)`
    : ""
}. Leave the tree unchanged and say why in \`summary\` when nothing clears the bar.

${evidence}`;

// The plan judge's whole world. Nothing from the PR body or the rubric belongs here.
export const judgeBody = (plans: PlanRef[], scope: string[], diff: string): string => `## Step: approve (plan judge)

You are judging whether a code change delivers the implementation plan it claims to
implement. You see only the plan, the task scope claimed, and the diff. Read repository
files only to confirm what the diff shows. Do not infer intent from anything else.

Scope claimed: ${scope.length ? scope.join(", ") : "not stated; treat every unchecked task as in scope"}.

Report, citing task ids and file paths:
- status: "aligned" when every claimed task's behavior and acceptance criteria are in the diff
  and nothing beyond the plan was built; "drift" otherwise.
- missing: claimed tasks or acceptance criteria the diff does not deliver.
- unrequested: behavior in the diff that no claimed task asks for. Refactors the plan does not
  name count. Tests and docs for claimed work do not.
- planEdited: true when the diff changes the plan file itself.
- evidenceGaps: acceptance criteria whose named verification method (test, probe, artifact)
  is absent from the diff.
- summary: two or three sentences a reviewer can act on.

${plans.map((p) => `### Plan: ${p.path}${p.editedInPr ? " (changed in this diff)" : ""}\n\n${p.text}`).join("\n\n")}

### Diff

\`\`\`diff
${diff}
\`\`\``;
