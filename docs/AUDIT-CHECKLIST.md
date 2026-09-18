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

**And so does the evidence.** These are not the same strength and this document had been letting
one stand in for another (external review, Sep 18):

| Tier | What it means |
|---|---|
| **source** | The code changed. Typecheck and lint pass. Proves nothing about behaviour. |
| **scenario** | The real exported function was called with stated inputs and its output quoted — in an isolated PostgreSQL where a database is needed. |
| **production read** | A read-only query or live API read against real data, with the number printed. |
| **production run** | A real engine or script executed against production, with before/after counts. |
| **deployed** | Live on hub.realtourpilot.com and smoke-tested (HTTP status only unless stated). |
| **browser** | A person or an automated browser actually used the screen. **Almost nothing below carries this tier**, and where a row needs it, it says so. |

Two things this distinction rules out, both of which had crept in: "nobody had ever pressed the
button" proves a defect was **latent**, not that the repaired button works; and a release recorded
as SUPPRESSED proves the switch is off, not that the enabled path sends.

**ONE STATUS PER FINDING, AND IT LIVES IN THAT FINDING'S ROW.** The second Sep 18 review was right
that this document had been contradicting itself: a row said **Done** while a later section
qualified or reopened the same thing, and the reader had no way to know which sentence won. The rule
now is that a status is written in exactly one place — the finding's own row — and when a later
round reopens something, **that row changes** and names the round that changed it. Nothing below
restates a status set elsewhere; where two rounds looked at related things they are separate
findings with separate rows, and each row says so.

**Two rules that outrank everything below:** client launch stays off — no invitations, reminders,
publishing or new outbound automation is enabled by any of this work; and nothing is deleted —
records are retired, withheld or flagged.

---

## A. Workflow findings

| # | Finding | Status | Commit | Acceptance evidence |
|---|---|---|---|---|
| WF-01 | Delivery must mean the client can reach the file. `computeStatus` poured Aryeo counts and Dropbox Final counts into one `present` set, so photos going out flipped the Aryeo order to delivered, a video sitting only in `05-Final-Video` satisfied the remaining category, and the job read "All ordered deliverables confirmed live on Aryeo" over a send Kyle still owed. | **Done** | `1d9d3d8` | Presence split into `clientHas` (the listing) and `weHave` (Dropbox Final); anything ordered, finished and not on the listing is `awaitingSend` and blocks DELIVERED. Measured over 564 Aryeo jobs carrying evidence: 16 had finished work the listing did not show; 14 already DELIVERED and untouched (status is sticky by design), 2 live. A hand delivery by the office still outranks the cross-check, and a failed Aryeo read invents nothing. |
| WF-02 | Batches must be managed as individual owed outputs. One `Deliverable` row is N videos; the sixteenth video existed only as an integer inside a count. | **Done** | `0ab546f`, `2aaae42`, `44940a5` | 922 `DeliverableOutput` rows across 645 jobs — one per owed video, 0 failures. Keyed `(deliverableId, slot)`, the same key cuts and verdicts already use, so nothing was re-keyed. Parity proved against the PRE-CHANGE baseline file (645 projects / 922 slots), not a freshly-computed one: 0 illegitimate mismatches, and a second run created 0 rows. 893 S Matlack St went from the integer 16 to sixteen rows that each say where they stand. The `waivedAt` slot bug shipped in the same change, with waived rows dropped AFTER the per-row counts so the office's videos-owed split could not shift. |
| WF-03 | A revision on one video must not close work on another. `correctedCutApproved` took a project, a time and a round — never the identity of the item satisfied. | **Done** | `868cfb8`, `2aaae42`, `44940a5` | Each item on a client's ask now carries the videos it is about (`cuts` + `scope` inside the existing free-form `itemsJson` — no migration), assigned by giving the analyser the job's REAL cut slots instead of one collapsed deliverable label. Approving video 1 leaves an untouched item about video 3 open, proved on seven pure cases. One work order per medium is unchanged. A folder-discovered round with no deliverable is re-keyed to the job's sole owed slot where there is exactly one, and to NOTHING on a multi-video job — naming which of four videos a Dropbox path is would put a client's approval on the wrong deliverable. |
| WF-04 | One service-promise calculation across the business. Two engines: `turnaround.ts` dated Kyle's board, `tasks.ts` dated everything else, and only `tasks.ts` read the office's settings. | **Done** | `868cfb8`, `af9f8dd`, `f371965`, `f25b97f`, `7569b7b`, `017bf4b` | One DST-correct business-day walk replaced four implementations, three of which added 86,400,000ms in a loop. Premium is 4 business days to the client and 3 internally. 538 promises frozen BEFORE the arithmetic moved, and on-time measured identical across the change (243/463 = 52.48%). New jobs are pinned as they are sold, so the freeze does not decay. Every reader — board, project card, QC card, stuck-jobs, the photographer bonus — goes through one guard. |
| WF-05 | Unresolved communication must not age out. `unansweredComms` read seven days and queried nothing older. | **Done** | `b1f0d8e` | The seven-day window is right about noise (at 21 days the email board went 5 rows → 17, and the twelve extra were out-of-office replies and vendor pitches). A thread belonging to a client with an OPEN `client_reply` task is now read past it, bounded to 45 days and 600 rows — an obligation the hub itself recorded, not a rolling read. Measured: 4 open reply tasks across 3 clients, 79 extra rows against the window's 396. |
| WF-06 | Handoffs must be explicit: files present and instructions ready are different facts. | **Done** | `a5c0157`, `80a9876` | `handoffReadiness` is the same `videoStepSpec` the upload portal already enforces at the photographer's submit — the gap was that nothing read it once footage arrived any other way. The engine's select now carries the brief fields it never had. A blocked job names what is missing, who has it and a chase date one business day out; `handoff_incomplete` is ONE new member of the existing blocker vocabulary. A plain social reel demands nothing. Verified both ways on production: 5 Raymond Cir stamped ready through the real engine, then its blocker stamped by hand and read back on Kyle's board as "Waiting on the flow and vision for the edit… from Harrison Wells", then restored. |
| WF-07 | Capacity and exceptions, not just assignment counts. | **Done** *(was Partial; closed Sep 18 pm)* | `22ba2ce`, `51c832f`, `74b3268` | *browser* — the Editing Room carries a workload panel: four lanes (in editing · waiting on a verdict · approved not sent · waiting on footage) with **whose move each one is**, because a row count is not a workload. Capacity is measured, not assumed — approved cuts per editor over eight weeks — and every line prints its sample and says nothing at all below three cuts, because two events are not a rate. Read live: 43 videos an editor can move right now, Kim holding 35 of them against a rate that cannot absorb them, one job overdue on John Mark. The exceptions the audit listed are now a card of their own — see WF-08. |
| WF-08 | One clear purpose and action trail per conversation. | **Done** *(was Partial; closed Sep 18 pm)* | `80a9876`, `7635cde`, `74b3268`, `ff42e6a` | *browser* — a job has one named blocker with one owner; replacing an approved video records why, under a name, on the timeline; and the consolidated summary now exists. **Where this job is** sits at the top of the project page and carries scope, how many videos are with the client and which version each is on, the promise and where it came from, the client's last ask, the blocker, whose move it is and the one next action — the same facts from the same engines, said once. Read live on 893 S Matlack: sixteen ordered, none with the client, video one at v2, promised Sep 23 against a Sep 18 internal target, blocked on a filmed count from James, one finished video Kyle owes a send on. **Also new:** an exceptions card on the board for the five quiet failures — nobody assigned, a cut nobody has ruled on, a follow-up date that passed, a render stuck at the provider, an approved replacement never sent — each with a name and one next action. It found four cuts waiting 16–22 days for a verdict on its first render. |

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
| P1 | `CutUploader` uploads with `access: public`; the store's access level is fixed at creation. | **Blocked** | `f3d70a3` | See directive 9. |
| P1 | Topaz `release()` updated by job id without checking it still held the lease, and swallowed errors. | **Done** *(this fence caused R01 — see that row)* | `9b315c7` | All 26 call sites compare-and-swap on the lease observed at the top of the step; the resumable upload's per-part write carries the same fence; a lost race is a logged no-op. **The fence itself was correct and the change was not**: it broke the one caller that released twice. That is R01, and its row carries the status of the repair. |
| P1 | Topaz capacity and spend checks were separate from the commitment. | **Superseded by R01 and S01** | `ec6d747`, `56be631`, `eecda83` | Accept-then-recheck is gone entirely: compare-after-commit was never a guarantee. The reservation is taken before anything is spent, behind a shared budget lock. Status lives in S01. |
| P1 | Gmail cron recovery rechecked only the client-text window. | **Done** | `ec6d747` | The facts the sweep checked when it queued the row are checked again from the row's own identity: a confirmation for a moved or cancelled shoot, or a feedback ask for a job that has bounced into revisions, is held and named rather than sent. |
| P1 | `editorScopeOf` fell back from a missing `editorKey` to the login name's slug. | **Done** | `9b315c7` | Unlinked now fails closed to the sentinel. Verified both live editors carry explicit keys, so it locks nobody out. |
| P1 | `YourTasksCard` called `useMemo` after an empty-list return. | **Done** | `9b315c7` | Hooks moved above the early exit; the overdue clock comes off the server with the row, so the card reads one clock instead of its own. |
| P1 | Cut round allocation read max and separately reserved max+1. | **Done** *(broken on arrival Sep 17; repaired Sep 18 pm)* | `9b315c7`, `eecda83` | Read and create share a transaction behind a Postgres advisory lock on that one slot. A unique index is the wrong tool here — a WITHDRAWN round keeps its number while freeing it for reuse, so duplicates are legal by design. **The lock call was malformed and nobody had tried an upload since**: Prisma sends a JS number as a bigint parameter and Postgres has no two-argument bigint form of `pg_advisory_xact_lock`, so every call raised 42883, the transaction aborted, and `startCutUpload` threw. An editor could not have uploaded a version at all from `9b315c7` until `eecda83`. Verified against the real database both ways; the last upload predates the deploy by four hours. |
| P2 | A failed delivery-board query rendered as a clean board. | **Done** | `9b315c7` | The board carries an `unavailable` flag, says so on the Pipeline block, and withholds the "0 past due" reassurance instead of asserting it. |
| P2 | The mobile drawer stayed mounted off-screen without a dialog focus lifecycle. | **Done** | `31293da` | `inert` while closed takes the subtree out of tab order, the accessibility tree and hit-testing; Escape closes; focus moves in on open and returns to the hamburger on close; the button carries `aria-expanded`/`aria-controls`. |

## D. Jordan's directives, Sep 18

| # | Directive | Status | Commit | Acceptance evidence |
|---|---|---|---|---|
| 1 | Clients must not see unreviewed AI scripts. | **Done** | `1b24065`, `3f9e03c`, `39f505b` | The server sends a stage, never draft text — six unreleased drafts were live across four interviews. `CLIENT_VISIBLE_SCRIPT` no longer contains APPROVED. And the portal now actually renders a RELEASED script under its topic, so "it's under this topic" is true: 5 of the 6 released scripts were reachable by zero surfaces before. There is exactly one visibility rule — `scriptVisibility` — and every caller goes through it. A client's own script is no longer piped through the staff money-clamp, which deleted whole sentences from 46 of them, including one whose subject is price. |
| 2 | Complete individual video tracking. | **Done** | `0ab546f`, `2aaae42`, `44940a5` | See WF-02. 922 rows, 0 failures, parity against the pre-change baseline. |
| 3 | Finish revision tracking; keep the return-to-client action visible. | **Done** | `2aaae42`, `44940a5` | See WF-03. The return-to-client half: `markVideoSent` stamps the video's own row, resolving a revision says out loud when an approved video still has not gone, and the project card carries "Approved — not sent" as its own state. Five videos across the business are in it today. |
| 4 | Reconcile the previously delivered jobs; exceptions for anything owed or uncertain. | **Done** | `9e7f385`, `6d5e2df`, `51c832f` | A repeatable read-only pass that asks Aryeo live. **Corrected arithmetic** (the earlier line — "17 candidates, 4 TEST skipped: 13 fine, 2 owed, 1 uncertain" — did not reconcile as one population: 13+2+1 is 16, not 17). Re-run Sep 18: 1,559 non-cancelled jobs scanned; 17 carried an internal reason to doubt the delivery; 2 synthetic TEST jobs skipped; 2 had a reason to doubt but no lane this pass can read. Verdicts over the 17: **13 delivered · 3 still owed · 1 cannot tell** — which does reconcile. **This corrects my earlier report of "14 jobs":** that came from the cached evidence blob, which goes stale seven days after delivery. Confirmed separately that no stamp on this database proves a human confirmed anything — 1,524 projects carry `deliveredAt`, 0 carry `deliveredBy`. **Four** exceptions now written (893 S Matlack St, 5642 Limeport Rd, 358 N Church St, 45 Heron Hill Dr) — 358 N Church St joined after the scope fix, and is a job whose photos and floor plans went out while two finished videos never did. Idempotent: a re-run raised 0 and left 3 exactly as they were. First on the owner's radar. No client contacted, no file re-sent, no timestamp or status changed. |
| 5 | Premium reels: 3 business days internal target, 4 business days client deadline; preserve agreed promises. | **Done** | `af9f8dd`, `f371965`, `f25b97f`, `7569b7b`, `017bf4b` | See WF-04. **Correction to a figure of mine:** I said moving the premium default would flip "39 of 222" delivered premium jobs. Production has 121 such jobs, not 222, and 34 flip — the risk was real, my numbers were not. |
| 6 | Coverage Mon–Fri 9–6 ET; defer routine alerts; explicit on-call for urgent. | **Done** | `af9f8dd`, `931c690`, `1890cedcd937` | Measured first: of 196 reply-SLA pages in 90 days, 47 fired at the weekend and — the part nobody had counted — **61 more fired on a weeknight**, so 108 of 196 landed when nobody was on. Routine now defers to the next covered period; urgent goes to a named on-call, and with nobody named behaves exactly as today, because silence is the one outcome an urgent alert must never have. Capture is unchanged. The window is also cross-validated on save, so the screen and the pager cannot disagree. **For Jordan:** 9–6 is narrower than the pager's old weekday 8–7. |
| 7 | 20–30s stays a generation target with a tighten action, never a hard rejection. | **Done** | `ec6d747`, `740ec7a`, `1890cedcd937` | Structure is unoverridable; pacing is a warning. A one-click tighten builds its instruction server-side from the version's own stored numbers. The overrun is now visible where it matters: the findings box only rendered for 9 of 174 rows while the estimate chip was on all 174 and untinted, so 47s and 24s looked identical. An UNDER-target script is told it is short too. No duration override exists anywhere, and the "should pacing ever hard-block" question is recorded as still open, because it is. |
| 8 | Handoff requirements, named blockers, next actions, follow-up dates, workload visibility. | **Done** *(was Partial; closed Sep 18 pm)* | `a5c0157`, `22ba2ce`, `80a9876`, `51c832f`, `74b3268`, `ff42e6a` | Status lives in WF-06, WF-07 and WF-08; all three are now Done. The last pieces were the workload lanes, the exceptions card and the one project summary. |
| 9 | Finish private media; name the account action. | **Blocked** | `f3d70a3`, `7deed1b3a64a` | Everything code-side is done: the store is a setting rather than a hard-coded word, the read token only ever goes to our own store (and the guard folds case, which it did not — it would have refused every legitimate blob the day the store went private), and `docs/REVIEW-CUT-STORE-HANDOVER.md` carries the exact steps. Survey: **14 of 14 objects answer an anonymous ranged GET with HTTP 206 right now**; 10 still advertise a 30-day public cache. Verified against the installed SDK that `access` is the browser's header in @vercel/blob 2.8.0 and `onBeforeGenerateToken` cannot set it — so no code change can convert the store. **Jordan must create a new private Blob store.** Also surfaced: Instagram publishing passes the blob URL to Meta, whose servers fetch it, so that breaks on a private store. |
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

## F1. The Sep 18 verification review (R01–R10)

`~/Downloads/Realtour-Pilot-Remaining-Work-2026-09-18.md`, read against `28524a5`. It reproduced
four defects locally and was right about all of them. Worked at `e5627dc`, deployed.

| # | Finding | Status | Commit | Evidence |
|---|---|---|---|---|
| R01 | Topaz overshoot reset and worker ownership. **A regression I introduced**: fencing `release()` on the observed lease broke the one caller that released twice, so a cap overshoot cancelled the provider request, kept `acceptedAt`, stayed `uploading`, and counted against every cap for ever. | **Reopened Sep 18 pm — status now lives in S01** | `56be631` | *scenario* — accept-then-recheck replaced by `reserveSpendSlot`, which evaluates every cap inside the UPDATE that claims the slot. The overshoot path no longer exists. Proved in an isolated PostgreSQL, 7 checks: two workers contesting the last slot → exactly one wins; the credit cap is never crossed; a lost lease reserves nothing; a slot can be handed back; a job cannot reserve twice. The drill's first run failed and found a real hole — a reservation did not occupy a concurrency slot, so both workers won. |
| R02 | Individual output evidence not connected to project completion — one Aryeo video satisfied a sixteen-video package. | **Reopened Sep 18 pm — status now lives in S02** | `be5adf1`, `e5627dc` | *scenario + production read* — `computeStatus` counts instead of testing. Four owed with one delivered now reads "3 of 4 videos still outstanding" where it previously read DELIVERED. Blast radius on real rows: 2 of 46 sweep-carried jobs change, and both are the defect. A checker then caught that the "live on Aryeo" sentence was reading the widened `clientHas`, so a hand-delivered video could claim the listing again — fixed and proved both ways. |
| R03 | An old send hid an unsent replacement — v1 sent + v2 approved read "Sent to the client". | **Done** | `aaa7f46` | *scenario* — 41 assertions against an isolated database, with the pre-change module imported beside the new one at every step. |
| R04 | Name-based editor authorization survived in `addressableKeys` and on the Editing Room page. | **Done** | `0866ea3` | *scenario* — the reported case (`task scope __none__` / `project keys [john]`) now returns `[]` for both; a linked editor keeps `[kim]`; an ADMIN keeps the task-ticking fallback. |
| R05 | Private-media code not finished: six paths still handed a bare public URL to somebody. | **Done (code)** — the cutover is Blocked on Jordan | `a5352c6`, `e5627dc`, `63b8613` | *scenario* — internal reads carry the store token; an external fetcher (Dropbox, Meta) gets a short-lived presigned GET scoped to one pathname, never the store credential. A checker caught that the migration would change `cutIdentityHash` and silently break recorded client approvals; it now pins `contentHash` first. The probe in `aryeoDelivery.ts` closed at `63b8613` — it was the last raw store URL in the codebase. **Everything code-side is finished; the cutover is Jordan's store** (see directive 9, which holds that status). |
| R06 | Output lifecycle not wired after the backfill. | **Done** *(was Partial; closed Sep 18 pm)* | `aaa7f46`, `63b8613` | *scenario + production run* — creation wired into Aryeo import, the order reconcile, waive/un-waive and an hourly repair sweep, and now the two quantity paths that were still a number: the office's videos-owed override (how 893 S Matlack came to owe sixteen) and the monthly quota lift. Both materialise in the same press. The drill runs the REAL office dialog and the REAL status sweep with no sync call of its own, so a missing wire fails it: five videos owed the moment the dialog closes, the extras retired and not deleted on the way down, and the order row and the per-video rows agreeing in one pass. 50 checks. |
| R07 | Unanswered obligations still aged out. | **Reopened Sep 18 pm — status now lives in S03** | `aa1838f`, `e5627dc` | *scenario* — the obligation, not the message, is what persists: open `client_reply`/`lead` tasks with no window and no row cap. 35 checks. A checker caught that one unrelated email marked a sixty-day-old text question answered; the answered test is now scoped to the lane. **Live impact today is zero recovered rows** — all five open obligations are inside the seven-day window, so this is preventive. |
| R08 | Daily workflow and frontend consolidation. | **Partial** *(most of it closed Sep 18 pm)* | `80b44a9`, `74b3268`, `ff42e6a` | *browser* — the workload lanes, the exceptions card, the one project summary and the assignable creative approver all shipped and were read in a browser against live data; their statuses live in WF-07, WF-08 and S05. **Still open, and named:** the three note registers (internal chat, the client's own words, timestamped cut feedback) are distinct on `/edit` but not cross-linked, and browser coverage is now five screens rather than three — the portal, the Review Room workspace and any private-store playback have still never been watched. |
| R09 | Listing delivery versus content-program release. | **Done** | `db2a5a5` | *production read* — a content cut counted as delivered on approval because the portal library row is written then. 29 enrollments, 3 ClientUser rows, 1 client with any membership — and that one is a TEST client. Sarina Spinelli's video had left Kyle's card while the reconciliation flagged the same job as owed. Kyle's board now carries exactly the three the reconciliation flags. |
| R10 | Checklist, evidence and arithmetic. | **Reopened Sep 18 pm — status now lives in S06** | `30f7045` | The evidence tiers above, the corrected reconciliation arithmetic, and the completion contract no longer calling itself an unbuilt proposal. The reviewer then showed the document still contradicted itself; that is S06. |

## F3. The second Sep 18 review (S01–S06)

`~/Downloads/Realtour-Pilot-Remaining-Work-2026-09-18 (1).md`, read against `274eca6`. It reopened
three findings the round before had called Done, and it was right about all three. Worked at
`ff42e6a`.

| # | Finding | Status | Commit | Evidence |
|---|---|---|---|---|
| S01 | Topaz: an interrupted reservation could not resume, and one UPDATE does not serialize a shared budget. | **Done** | `eecda83` | *scenario + production read* — **Recovery:** `acceptedAt` is written before the provider call and before the upload targets are saved, so a worker killed in between left a row committed to spend with nowhere to put the bytes; the resume test read one fact and treated everything else as a fresh start, so that row asked for a slot it already held, was refused, and returned without progressing or releasing. Every tick, for ever. The row already carried three states and none needed storing — nothing claimed, claimed with the provider outcome unknown, targets persisted — and the middle one now gets an ANSWER rather than a guess: a dead request hands the slot back and starts over free, a finished one goes to the poller, a running one waits, an unreachable Topaz holds the slot, because both guesses cost money in opposite directions. `topaz-recovery.ts` walks all three interruption points plus the four provider answers with every call mocked and counted; 28 checks. **Serialization:** the reviewer was right that counting inside the UPDATE serializes nothing under Read Committed, and right that the PGlite drill could not have caught it — PGlite Socket multiplexes every connection onto one, so its concurrent statements were serialized by the harness. The budget now has a transaction-scoped advisory lock. `scripts/_recon/budget-lock.ts` answers the isolation question on the real PostgreSQL over two independent backends (different `pg_backend_pid`s, a held lock refusing a second taker, a waiter admitted only after the holder commits), touching no table. **A third defect fell out of writing that lock** — see the cut-round row in section C: the identical call added to the upload path the day before raised 42883 on every attempt, so an editor could not have uploaded a cut at all. |
| S02 | The delivery summary contradicted its own engine: `parseEvidence` dropped the unit counts and an empty `missing` list read as finished. | **Done** | `83a80bf`, `ff42e6a` | *scenario + production read + browser* — the parser keeps the counts and the type that describes them now lives next to the PARSER rather than next to the writer, since the field was dropped precisely because the two shapes lived apart. An empty `missing` no longer means finished: a video can be made, approved, in our Final folder and owed to a client who has never seen it, and the headline ignored that. **Confirmed by count is not confirmed by name:** Aryeo's listing count is real and anonymous, so four exports of one cut are indistinguishable from four videos. Measured the same day — 922 per-video rows exist and **six** carry a delivery stamp, so on **234** jobs the anonymous count is the only thing carrying the total. Refusing to count it would invent 234 false obligations; letting it claim an identification is the error the reviewer reproduced. Both numbers are reported, the sentence says which one it is leaning on, amber on a live job and quiet on a delivery the office already made. The blob also stops assigning certainty to particular videos: it used to spend the listing total across outstanding slots in array order and publish the survivors as unaccounted for, which is evidence about nothing. `r02-headline.ts` walks computeStatus → the blob → the parser → the tone → the chip, 15 checks. Read in the browser on 1337 Carolannes: "Confirmed by count, not by name". |
| S03 | An unsuccessful outbound call closed a reply obligation. | **Done** | `68833f7` | *scenario* — OpenPhone logs an outbound attempt as a call row like any other, and the persistent ledger took the newest outbound row of any kind, so one missed callback made a twenty-day-old question disappear from the board while the to-do behind it stayed open and invisible. The live walk had always known the difference, which is the tell that this was two rules rather than one: there is now one predicate and the ledger's SQL aggregate is built from the same word list. Eight new checks on the obligation drill — a missed callback leaves it standing, an answered one resolves it, a missed one after that brings it back, an email does not answer a text, and a hub text recognised by its body closes nothing. 43 passing. |
| S04 | The two remaining quantity paths, and the last raw store URL. | **Done** | `63b8613` | Status lives in R06 (the quantity paths) and R05 (the probe). |
| S05 | Workload, exceptions, the one project summary, and assignable creative approval. | **Done** | `74b3268`, `ff42e6a` | Statuses live in WF-07 and WF-08. The fourth piece: **the capability to approve was never missing** — `approveCut` has always taken any owner or admin, so Kyle could rule on a cut today — what was missing is a designation, so every waiting cut was implicitly Jordan's and no screen said otherwise. Settings now names the creative approver, and the picker says which people have a login that could actually press the button; Harrison, John Mark and Kim do not, and pointing somebody at a button they cannot press is a delegation that delegates nothing. Where the name came from is reported too, so a name lifted off the creative-manager flag — which exists for the shoot bonus — says so rather than passing itself off as a decision. |
| S06 | The checklist contradicted itself: older rows said Done for things later sections reopened. | **Done** | *this revision* | The rule is now stated at the top and applied throughout: a status is written in exactly one place, and a row that a later round reopened says so and names where its status went. Six rows changed in this revision (WF-07, WF-08, directive 8, the two Topaz P1 rows, the cut-round P1 row) and four F1 rows now point at their S-row. The screenshot contradiction in F2 is corrected below. |

## F2. What this document does NOT claim

Two external verification reviews on Sep 18 read `main` at `28524a5` and then at `274eca6`. Between
them they reproduced seven defects locally and were right about all seven. Two were regressions
**I** introduced: R01, when I fenced the Topaz lease, and the malformed advisory-lock call that
would have stopped editors uploading. Reviewing my own work found neither; an outside reader found
both, and a drill written for the second one found the third.

Three limits to state plainly rather than leave implied:

- **Browser evidence exists for three screens and no more** (Sep 18, dev server, real production
  data). Kyle's home renders "3 videos ready to send to the client" with the three jobs the
  reconciliation independently flags as owed, each labelled per video ("Video 1 of 16"); at 375px it
  stacks with no horizontal scroll and the Dropbox path wraps. The mobile drawer was measured, not
  inspected: 25 links inside it, `inert` set while closed and the first one unreachable by keyboard,
  focus moving to "Home" on open and back to the hamburger on Escape. The project page shows
  "VIDEOS ON THIS JOB (16) · 1 approved, not sent" with video 1 reading "v2 approved — still has to
  go to the client" and videos 2–16 "No cut uploaded yet".
  **That screenshot showed R02 still open** — the status card above that list read "Everything
  ordered is confirmed" while fifteen videos were owed, one screen with two answers. That is fixed
  and re-read: the same job now opens with "Where this job is — 0 of 16 with the client · furthest
  along: v2", and 1337 Carolannes reads "Confirmed by count, not by name" instead of an all-clear.
  **Browser evidence now covers five screens** (Sep 18 pm): Kyle's home with the exceptions card,
  the Editing Room with the workload lanes, the project page with the summary, the project page at
  375px with no horizontal overflow, and the Settings creative-approver picker. The portal, the
  Review Room workspace and any private-store playback have still never been watched by anybody.
- **Coverage is operationally incomplete until somebody is on call.** `routeAlert` deliberately
  falls back to the old recipients for an urgent out-of-hours alert when the rota is empty, because
  silence is the one outcome an urgent alert must never have. That is a safe default, not a
  finished feature: directive 6's "explicitly assigned person" is not in force.
- **The program backup alone cannot rebuild the hub, and that has not changed.** The drill proves it
  rebuilds the content program into an empty database — 6,409 of 6,426 rows with every internal
  relationship intact — and prints its own limit: 17 RevisionBrief rows depend on operational
  `Project` rows a program backup does not contain. A full disaster recovery still needs the
  database-level dump, the Blob store's objects and the Dropbox tree, none of which this drill
  touches. **Said plainly because the reviewer asked twice:** there is no tested whole-hub recovery
  path. What exists is a tested recovery of one subsystem plus a printed statement of what it
  cannot reach. Closing it needs a `pg_dump` restore rehearsal against a scratch database, which is
  an account action on Neon and therefore Jordan's — it is in his list below.

## F. Open questions for Jordan

| Question | Why it is his | Current state |
|---|---|---|
| Premium reel: is 4 business days the deadline and 3 the target? | Jordan answered this on Sep 18 — it is being implemented. | In progress. |
| Coverage 9–6 narrows the pager from its current weekday 8–7. | It removes paging between 8–9am and 6–7pm. | Implementing as specified; flagged here so it is a decision, not a surprise. |
| Who is on call for urgent alerts out of hours? | Nobody can be assumed available. | Unset. Until somebody is named, urgent alerts page exactly as they do today. |
| The private Blob store. | Only the account owner can create one. | Blocked. Exact steps to follow. |
| A scratch Neon branch to rehearse a full `pg_dump` restore against. | Creating one is an account action, and it is the only way to test whole-hub recovery without touching production. | Not started. Until then, recovery is proved for the content program and stated as unproved for everything else. |
| Who is the creative approver? | Any owner or admin can approve a cut; naming who is *expected* to is a business decision. | Unset. Settings → Review Room now has the picker; until somebody is named the exceptions board says "the office", or names whoever carries the creative-manager flag and says that is where the name came from. |
| Should pacing ever hard-block a script? | It is an estimate from a word count. | Warning, with a tighten action being added. |


---

## G. How this was built, and what checked it

The work ran as three waves. Seven builders on disjoint files in isolated git
worktrees; then seven adversarial reviewers, each told to REFUTE its builder's
report rather than confirm it; then six fixers on what the reviewers proved.

The review was not a formality. **Two of seven changes were sound; five were
flawed**, including two blockers that would have shipped:

- The client-facing script renderer piped a client's own script through the
  STAFF money-clamp, which deletes whole sentences. 46 scripts were affected,
  one of them titled "The List Price and the Sale Price Are Not the Same Thing".
- The private-store guard compared a case-sensitive store id against a hostname
  the URL parser always lowercases, so it would have refused every legitimate
  blob on the day it was supposed to start working.

Reviewers also caught claims that were not true — a builder reporting "every
reader goes through this guard" when two did not, and an "idempotent" that had
never been run twice. Those corrections are in the commit messages.

**Two numbers of mine were wrong and are corrected above:** the "14 previously
delivered jobs" (built on a stale cache; live, it is 2 owed and 1 uncertain),
and "39 of 222 delivered premium jobs" (it is 34 of 121).

## H. Written up separately

- `docs/HOW-A-VIDEO-MOVES.md` — how Kyle runs delivery, and a video from booking
  to a client, including revisions and replacing something already sent.
- `docs/REVIEW-CUT-STORE-HANDOVER.md` — the private-store steps, what breaks
  when the flip happens, and what is still untested.
- `docs/COMPLETION-CONTRACT.md` — the per-video design this work is Phase 1 of.
