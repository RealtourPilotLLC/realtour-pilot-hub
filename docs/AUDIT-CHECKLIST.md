# Audit worklist — Sep 2026

One row per finding from the combined workflow-and-code audit of
`238e3d17d10b6df73e4dfd490a38518a7f420d73` (`~/Downloads/Realtour-Pilot-Latest-Audit-2026-09-17.md`),
plus Jordan's ten follow-up directives of Sep 18.

**Status words mean exactly this:**

- **Done** — shipped, and the acceptance evidence in the row was actually observed. Not "the code
  looks right": a number was printed, a query was run, or a scenario was executed.
- **Partial** — some of it shipped and the rest is named in the row. Never a synonym for "mostly".
- **Blocked** — cannot proceed without something outside the code. The blocker is named.
- **Not started** — no work done. Said plainly rather than dressed up.

**Two rules that outrank everything below:** client launch stays off — no invitations, reminders,
publishing or new outbound automation is enabled by any of this work; and nothing is deleted —
records are retired, withheld or flagged.

---

## A. Workflow findings

| # | Finding | Status | Commit | Acceptance evidence |
|---|---|---|---|---|
| WF-01 | Delivery must mean the client can reach the file. `computeStatus` poured Aryeo counts and Dropbox Final counts into one `present` set, so photos going out flipped the Aryeo order to delivered, a video sitting only in `05-Final-Video` satisfied the remaining category, and the job read "All ordered deliverables confirmed live on Aryeo" over a send Kyle still owed. | **Done** | `1d9d3d8` | Presence split into `clientHas` (the listing) and `weHave` (Dropbox Final); anything ordered, finished and not on the listing is `awaitingSend` and blocks DELIVERED. Measured over 564 Aryeo jobs carrying evidence: 16 had finished work the listing did not show; 14 already DELIVERED and untouched (status is sticky by design), 2 live. A hand delivery by the office still outranks the cross-check, and a failed Aryeo read invents nothing. |
| WF-02 | Batches must be managed as individual owed outputs. One `Deliverable` row is N videos; the sixteenth video existed only as an integer inside a count. | **Partial** | `0ab546f` (schema) | `DeliverableOutput` exists — one row per owed thing, keyed `(deliverableId, slot)`, the same key cuts, notes and verdicts already use, so nothing is re-keyed. Columns follow `COMPLETION-CONTRACT.md` §9 plus the owner and current-version fields Jordan named. **Remaining:** the unit factory, the `waivedAt` slot bug, and the materialisation run. Baseline captured first: `scripts/_recon/slot-baseline.json`, 645 projects / 922 slots. |
| WF-03 | A revision on one video must not close work on another. `correctedCutApproved` took a project, a time and a round — never the identity of the item satisfied. | **Partial** | `868cfb8` | An approval now holds the revision open on two pieces of evidence: another slot re-cut since the ask and still unjudged, or a brief part-way through being ticked. Measured first — 0 of 20 projects with cuts are multi-slot and 6 of 10 analysed briefs have never been ticked, so gating on ticks alone would have frozen revisions for a problem that cannot happen yet. **Remaining:** per-item linkage to the affected video, which is what Jordan asked for and what makes this finish. |
| WF-04 | One service-promise calculation across the business. Two engines: `turnaround.ts` dated Kyle's board, `tasks.ts` dated everything else, and only `tasks.ts` read the office's settings. | **Partial** | `868cfb8`, `af9f8dd` | The two engines now share numbers and settings, split by how a promise is quoted (hours land on the hour, days land at 5pm ET). One DST-correct business-day walk in `datetime.ts` replaced four implementations, three of which added 86,400,000ms in a loop. **Remaining:** premium as 3/4 business days, and pinning the promise each job was sold under. |
| WF-05 | Unresolved communication must not age out. `unansweredComms` read seven days and queried nothing older. | **Done** | `b1f0d8e` | The seven-day window is right about noise (at 21 days the email board went 5 rows → 17, and the twelve extra were out-of-office replies and vendor pitches). A thread belonging to a client with an OPEN `client_reply` task is now read past it, bounded to 45 days and 600 rows — an obligation the hub itself recorded, not a rolling read. Measured: 4 open reply tasks across 3 clients, 79 extra rows against the window's 396. |
| WF-06 | Handoffs must be explicit: files present and instructions ready are different facts. | **Not started** | — | `ensureEditorHandoff` still mints editing work from footage evidence without reading `debriefSubmittedAt` or the brief. A simple standard reel must keep demanding nothing. |
| WF-07 | Capacity and exceptions, not just assignment counts. | **Not started** | — | Jordan rejected a workload strip on Sep 17 ("I was thinking more of a filter"); the answer is filters plus the home screen's existing exception-flag mechanism, not a new dashboard. |
| WF-08 | One clear purpose and action trail per conversation. | **Not started** | — | |

## B. Code findings

| # | Finding | Status | Commit | Acceptance evidence |
|---|---|---|---|---|
| 1 | Returning a script to review did not restore a reviewable state — the parent moved to INTERNAL_REVIEW while the version stayed APPROVED/SHARED with both pointers standing, so it never reached the queue it said it was entering and stayed one click from the portal. | **Done** | `9b315c7` | Version, pointers and parent move in one transaction; release asks the version whether the approval is still live. Ledger history untouched. Verified nobody had ever pressed the button: 0 `RETURN_TO_QUEUE` rows, so this was latent, not damage. |
| 2 | The workspace said a share email was queued without creating the notice. | **Done** | `b1f0d8e` | The button runs the same idempotent operation the batch does. Verified it never lied in production: the switch has been off since the feature landed, all 4 releases recorded SUPPRESSED, 0 orphaned QUEUED rows. |
| 3 | Backup and restore did not cover the rebuilt program. | **Done** | `ec6d747`, `d5a79f1` | Backup went from 9 models to 56 (6,426 rows, stamped with commit and schema hash). The restore's dry run proved nothing (an id lookup); it now checks every column against the live model, `--deep` replays inside a rolled-back transaction, and `--strict` refuses on a broken reference. |
| 4 | Photographer access reused an unfiltered office workspace. | **Done** | `369c0d5` | The workspace takes a lens applied in the query, not the markup. A photographer gets the cut, the PHOTOGRAPHER-lane notes scoped to their own member id, and their own replies; the editor brief, the reel recipe and the client's portal comments are withheld. |
| 5 | Photographer review controls offered actions the server rejects. | **Done** | `369c0d5` | The composer offers the capture lane alone, the verdict row says who is cutting it, take-down is hidden, and the return link goes to My Shoots rather than the office queue a photographer is redirected off. |
| 6 | Required new-script rules remained bypassable — every blocking finding cleared on any non-empty note. | **Done** | `ec6d747` | Nine codes describing the SHAPE of a script (hook, exactly three roled points, close, title, no greeting) take no override, and the panel stops offering one. Pacing stays a warning deliberately: it is an estimate from a word count. |

## C. Operational issues

| Priority | Issue | Status | Commit | Acceptance evidence |
|---|---|---|---|---|
| P1 | `CutUploader` uploads with `access: public`; the store's access level is fixed at creation. | **Blocked** | — | All 14 objects are world-readable; a survey pulled HTTP 200 on every one with no session. Needs a new private Blob store, which is Jordan's account action. |
| P1 | Topaz `release()` updated by job id without checking it still held the lease, and swallowed errors. | **Done** | `9b315c7` | All 26 call sites compare-and-swap on the lease observed at the top of the step; the resumable upload's per-part write carries the same fence; a lost race is a logged no-op. |
| P1 | Topaz capacity and spend checks were separate from the commitment. | **Done** | `ec6d747` | The post-accept re-read closed only the month's credit cap; concurrency, renders-per-day and renders-per-month are now re-counted with the job in the ledger, and an overshoot hands the commitment back for free. |
| P1 | Gmail cron recovery rechecked only the client-text window. | **Done** | `ec6d747` | The facts the sweep checked when it queued the row are checked again from the row's own identity: a confirmation for a moved or cancelled shoot, or a feedback ask for a job that has bounced into revisions, is held and named rather than sent. |
| P1 | `editorScopeOf` fell back from a missing `editorKey` to the login name's slug. | **Done** | `9b315c7` | Unlinked now fails closed to the sentinel. Verified both live editors carry explicit keys, so it locks nobody out. |
| P1 | `YourTasksCard` called `useMemo` after an empty-list return. | **Done** | `9b315c7` | Hooks moved above the early exit; the overdue clock comes off the server with the row, so the card reads one clock instead of its own. |
| P1 | Cut round allocation read max and separately reserved max+1. | **Done** | `9b315c7` | Read and create share a transaction behind a Postgres advisory lock on that one slot. A unique index is the wrong tool here — a WITHDRAWN round keeps its number while freeing it for reuse, so duplicates are legal by design. |
| P2 | A failed delivery-board query rendered as a clean board. | **Done** | `9b315c7` | The board carries an `unavailable` flag, says so on the Pipeline block, and withholds the "0 past due" reassurance instead of asserting it. |
| P2 | The mobile drawer stayed mounted off-screen without a dialog focus lifecycle. | **Done** | `31293da` | `inert` while closed takes the subtree out of tab order, the accessibility tree and hit-testing; Escape closes; focus moves in on open and returns to the hamburger on close; the button carries `aria-expanded`/`aria-controls`. |

## D. Jordan's directives, Sep 18

| # | Directive | Status | Commit | Acceptance evidence |
|---|---|---|---|---|
| 1 | Clients must not see unreviewed AI scripts. | **Partial** | `1b24065` | The server no longer sends draft text: `portalInterview` counts whether a version exists and returns a stage instead. Six unreleased drafts were live across four interviews. `CLIENT_VISIBLE_SCRIPT` no longer contains APPROVED (0 non-historical rows affected — a closed door, not a change). **Remaining:** the portal has no reader for a RELEASED script, so "it's under this topic" is not yet true. |
| 2 | Complete individual video tracking. | **Partial** | `0ab546f` | See WF-02. |
| 3 | Finish revision tracking; keep the return-to-client action visible. | **Partial** | `868cfb8` | See WF-03. |
| 4 | Reconcile the previously delivered jobs; exceptions for anything owed or uncertain. | **Partial** | — | Read-only live evidence gathered. **This corrects an earlier report:** the cached evidence is stale on delivered jobs (the sweep stops looking 7 days after delivery), so the "14 jobs" figure was built on a stale cache. A live Aryeo read of all 16 shows 13 fine, 2 genuinely owed (893 S Matlack St, 5642 Limeport Rd — both REVIEW, not delivered) and 1 uncertain (45 Heron Hill Dr: listing has the video and 8 floor plans but zero images, while Dropbox holds 60 final photos). Every one of those DELIVERED stamps was written by the sweep, not a human — the Activity line says so verbatim, and 626 Greycliffe Ln carries a client complaint, "Gary cannot find the social media video". **Remaining:** the durable exception record. |
| 5 | Premium reels: 3 business days internal target, 4 business days client deadline; preserve agreed promises. | **Partial** | `af9f8dd` | One DST-correct business-day clock, and `endOfBusinessDaysET` for day-quoted promises — a Friday 9am shoot is due end of the following Thursday, which no elapsed-hour arithmetic produces. **Remaining:** the premium numbers themselves and the promise pin. The pin must land FIRST: moving the premium default without it flips 39 of 222 delivered premium jobs from late to on-time, re-scoring both the owner's on-time dial and the photographer bonus that reads it. |
| 6 | Coverage Mon–Fri 9–6 ET; defer routine alerts; explicit on-call for urgent. | **Partial** | `af9f8dd` | `src/lib/coverage.ts` decides who gets woken, never what gets seen — capture is unchanged. Verified across seven cases including both sides of the November clock change. With nobody on call an urgent alert behaves exactly as today rather than being held: silence is the one outcome an urgent alert must never have. **Remaining:** wiring it into `commsSla`/`deliveryWatch` and a settings surface. **For Jordan:** 9–6 is narrower than the pager's current weekday 8–7, so 8–9am and 6–7pm will defer. |
| 7 | 20–30s stays a generation target with a tighten action, never a hard rejection. | **Partial** | `ec6d747` | Structure is enforced and unoverridable; pacing is a warning. **Remaining:** the one-click tighten and making the overrun visible (the findings box renders for 9 of 174 rows; the estimate chip is on all 174 but untinted, so 47s and 24s look identical). |
| 8 | Handoff requirements, named blockers, next actions, follow-up dates, workload visibility. | **Not started** | — | Columns exist (`Project.handoff*`, `SmartTask.followUpAt/blockedReason`). Sequenced after per-video identity so blockers and owners land on the unit rows rather than a competing tracker. |
| 9 | Finish private media; name the account action. | **Blocked** | — | See C/P1. |
| 10 | Prove recovery in isolation; maintain this checklist. | **Done** | `d5a79f1` | `scripts/recovery-drill.ts` runs a real PostgreSQL in-process and passes three scenarios: 6,409 of 6,426 rows rebuilt into an empty database with every internal relationship intact; a missing parent fails loudly and writes nothing; parents-then-children recovers fully with self-references resolved. It found three real defects on the way — see below. |

## E. What the recovery drill found

Recorded because each was a genuine defect, not a drill artefact.

1. **The restore could not place a row whose parent sat later in the same table.** `Client` rows
   reference other `Client` rows (`parentClientId` — the Aryeo customer-team folding), and no
   ordering of tables fixes an ordering problem inside one. Retry passes took scenario 1 from 6,314
   rows to 6,409.
2. **Orphaned children were accepted.** Restoring enrollments into a database with no `Client` rows
   SUCCEEDED, writing 29 enrollments belonging to nobody. `ContentEnrollment.clientId` is a plain
   ref with no foreign key, and 177 columns in this schema are the same, because the Content Program
   is deliberately decoupled from the operational core. Postgres cannot object, so the restore now
   does: it reads the schema's own `// -> Model` convention into a reference map and checks every
   plain ref resolves. On live data it finds exactly two, both left by test probes.
3. **Prisma error reporting.** Messages open with ``Invalid `x.upsert()` invocation`` and a stack;
   reporting the first line told us nothing for three runs.

**One honest limit, printed by the drill itself:** `RevisionBrief` references `Project`, an
operational table not in a program backup. Those 17 rows restore correctly into a database that
still holds the operational core; a bare-metal rebuild needs the full `pg_dump` too.

## F. Open questions for Jordan

| Question | Why it is his | Current state |
|---|---|---|
| Premium reel: is 4 business days the deadline and 3 the target? | Jordan answered this on Sep 18 — it is being implemented. | In progress. |
| Coverage 9–6 narrows the pager from its current weekday 8–7. | It removes paging between 8–9am and 6–7pm. | Implementing as specified; flagged here so it is a decision, not a surprise. |
| Who is on call for urgent alerts out of hours? | Nobody can be assumed available. | Unset. Until somebody is named, urgent alerts page exactly as they do today. |
| The private Blob store. | Only the account owner can create one. | Blocked. Exact steps to follow. |
| Should pacing ever hard-block a script? | It is an estimate from a word count. | Warning, with a tighten action being added. |
