# Testing plan

Every IP plans its end-to-end tests up front, and says whether it adds any manual
regression case, so no stage decides alone whether a feature deserves a spec. Most
features add no regression case. Grow writes both sections. Later stages read them;
they do not invent rows.

## Standardized spot

| Key | Default | What it holds |
| --- | --- | --- |
| `E2E guide` | `docs/testing/e2e.md` | How this repository builds and writes e2e tests |
| `Regression suites` | `docs/regression/` | One manual suite file per area, `<area>.md` |
| `Smoke command` | none | The command that runs the repository's smoke tests, when it has one |

The guide covers every e2e layer the repository uses: `browser` (a page driven in a
real browser), `native flow` (a flow on a simulator, emulator, or device), `http` (a
real server on a real port), and `process` (a compiled binary or child process). It
states, per layer, where specs live, how they find elements, how they wait, and the
command that runs them.

A repository whose layout differs overrides the defaults with a `## Testing
conventions` table in its agent instructions (AGENTS.md or CLAUDE.md):

```markdown
## Testing conventions

| Key | Value |
| --- | --- |
| E2E guide | docs/qa/e2e-guide.md |
| Regression suites | docs/qa/regression/ |
| Smoke command | make smoke |
```

Resolve each key once: the table's value when the table names it, otherwise the
default. The resolved `E2E guide` path is the only guide; never fall back to the
default when an override names a missing file. When no file exists at the resolved
`E2E guide` path, Grow adds a task that writes it there, and every task that writes a
planned spec depends on that task.

## Keep regression minimal

A feature does not need a regression case. `## Regression cases` is `None` for most
IPs. The suites stay small: a short check that the app works as intended, plus the
behavior a developer or QA must check by hand because automation cannot reach it.

A check is an `## E2E tests` row whenever a layer in the e2e guide can drive it and
assert the result. Add a regression case only when the feature changes something a
person must do or judge, and only when no existing case already covers it:

- hardware and the operating system: push notifications, camera, biometrics,
  permission prompts, reinstall
- a full flow across apps, devices, or channels that automation cannot reasonably drive
  end to end, such as a real email reaching an inbox
- how the app feels: motion, responsiveness, layout under real fonts and screens

Prefer editing an existing case to adding one. A developer or QA walks the cases; no
stage executes them or stamps `Last full run`. When a case has an automatable part, that
part is an `## E2E tests` row and the case keeps only the human part.

## IP tables

Every IP has both sections. Either may be `None — <reason>`, but neither may be missing.
`None — no hard-to-automate change` is the usual `## Regression cases` entry.

### `## E2E tests`

| ID | Spec or flow | Layer | Proves | Written in |
| --- | --- | --- | --- | --- |
| E1 | `e2e/todos-due-date.spec.ts` | browser | A user sets a due date and sees it in the list | T2 |

- `ID` is `E<n>`, unique within the IP.
- `Spec or flow` is the repository-relative path the guide prescribes.
- `Layer` is one of the guide's layers.
- `Proves` names the acceptance criterion in observable terms.
- `Written in` is the one task that delivers the behaviour. That task writes the spec.

Every UI or cross-process acceptance criterion maps to a row, or the IP gives the
reason it does not (for example: covered by an existing spec, which is named).

### `## Regression cases`

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| TODO-new-1 | Due date survives a reinstall | Signed in on a phone with one dated todo, delete and reinstall the app, then sign in | The todo shows the same due date | iOS, Android | manual | todos-due-date |

- IDs in an IP are provisional: `<AREA>-new-<n>`. `<AREA>` is the prefix a suite file
  declares on its `Area:` line.
- The section opens with one `Destination:` line per prefix, naming the suite file:
  `Destination: TODO → docs/regression/todos.md`. A prefix no suite declares yet gets a
  new file at that path.
- `Automated by` is `manual`, or the `## E2E tests` row ID or spec path that covers the
  case's automatable part. When the case is written into the suite, an `E<n>` value
  becomes that row's spec path. A case a spec covers completely is not a regression
  case: it is only the `## E2E tests` row.
- `Added` is the IP slug.
- A row that edits an existing case uses that case's real ID.

## Suite file format

One living file per area at `<Regression suites>/<area>.md`:

```markdown
# Todos regression suite

Area: TODO
Owner: <team or person>
Last full run: 2026-01-15 (<who>, <short sha>)

| ID | Case | Steps | Expected | Platforms | Automated by | Added |
| --- | --- | --- | --- | --- | --- | --- |
| TODO-001 | ... | ... | ... | ... | manual | todos-due-date |
```

- `Area:` declares the file's ID prefix. Find a suite by this line, not by file name.
- IDs are `<AREA>-NNN`, zero-padded to three digits, and never reused. A retired case
  keeps its row with `Retired` in `Expected`.
- The next free ID is assigned only when a case is written into the suite, never in
  the IP. It is one past the highest ID the file has ever held.
- `Last full run` changes only after a human walks every case in the file.
- A new suite file starts with `Last full run: never` and `Owner:` set to the IP's
  owner, or `unassigned` when the IP names none.
- `Automated by` in a suite is `manual` or a spec path, never an IP-local `E<n>` ID.

## Deferral rule

A stage that cannot run a row's layer (no browser, no device, no service) records the
row as `deferred` with the exact command that runs it. Record it in the stage result
and the execution state, never as a new column or note in the IP tables, so the table
formats stay fixed. Deferral is not a pass. Only
Brew may accept a deferred row, and only once that command has passed locally or in
product CI on the branch.

## Regression-step bar

Each regression case names:

- a concrete starting state (who is signed in, what data exists, which build or device)
- an action a person can follow without guessing
- an observable Expected (what is on screen, in the inbox, or in the response)

"Check that it works", "verify the feature", or an Expected that restates the action
does not meet the bar.

## Legacy rule

An IP approved before this contract that lacks either section is read as `None —
predates contract` for that section. Stages warn once in their result and do not fail.
A revised legacy IP gains both sections in the Grow invocation that revises it.
