# The completion contract

**What the hub means by owed, approved, delivered, overdue, overridden and unknown.**

**Status: Phase 1 SHIPPED, Sep 18 2026.** The `DeliverableOutput` table in §9 exists — 922 rows across 645 jobs, one per owed video, materialised against a pre-change slot baseline with 0 mismatches. Phases 2–4 (the evidence backfill, the dual run and flipping readers behind `evidenceModel`) are NOT built: `computeUnits` still answers from the legacy model on purpose, because flipping a reader early would silently restate the Phase 0 reconciliation's numbers. The §13 questions that blocked Phase 1 were answered by Jordan's Sep 18 directives; the ones about later phases stand.
RTP-03, RTP-05 and RTP-24 were all blocked on this page being agreed, because all three are the
same disagreement wearing three hats.

Written Sep 16 2026 against `books-cleanup` (HEAD f0f1f9b). Every number below came from a read-only
pass over the live database, `scripts/evidence-reconcile.ts`, which you can re-run any time.

---

## 1. The problem in one paragraph

The hub currently decides whether a job is finished by asking four yes/no questions: are there
photos, a video, a floor plan, a 3D tour? Everything shot with a camera — the listing photos, the
drone set, the twilight set, the headshots, the virtual staging — shares the **same** yes. So one
listing photo answers "yes" for all five, and a four-video branding month is finished the moment one
video lands. A finished video sitting in the job's Dropbox Final folder counts the same as a video
the client can actually see on their listing, and the sentence the hub then prints — *"All ordered
deliverables confirmed live on Aryeo"* — is not true of it. The Editing Room already knows better:
it tracks each cut separately. The rest of the hub does not read that.

The fix is not a new system. It is one shared definition of **what a single finished thing is**, and
one set of words for its state, used by every screen.

---

## 2. The unit

> **One unit = one deliverable slot.** Not the job, not the category.

"Video 2 of 4" is a unit. "Twilight" is a unit. "Photos" is a unit. "Floor plan" is a unit. A job is
a bag of units, and it is finished when every unit in the bag is finished.

The Editing Room already computes exactly this for video (`reviewCuts.cutSlots`, via
`editOverrides.effectiveSlotCounts`, with the office's "videos owed" laid over it). This contract
generalises that arithmetic to every deliverable type and gives the unit a name, `deliverableId:slot`
— which is the identity `ReviewSubmission` already indexes on, so the existing review history
attaches with nothing rewritten.

*Predicate.* Video rows **still on the order**: `effectiveSlotCounts(project, baseCounts)` slots,
where `baseCounts` is each row's `quantity`, with the monthly batch size on the first video row.
Every other row: one slot.

Waived and removed rows still produce units — they are classified, not hidden, so an office decision
reads as a decision instead of as an absence. But **a removed row produces exactly one REMOVED unit
and never takes a slot from the rows still on the order**, because the office's "videos owed" total
is split across the video rows *by position*. 893 S Matlack St is the job that proves it: videos
owed 16, two video rows, one of them removed. Count the removed row and 15 of the 16 land on the row
nobody is editing; skip it, as `cutSlots` does, and the Editing Room's 16 live cuts and this
contract's 16 units are the same 16. Parity is checked, not asserted: over all 642 live jobs with a
video row, the unit keys this module produces and the ones `reviewCuts.cutSlots` produces are
identical — 0 mismatches.

*Today: 4,026 deliverable rows across 1,553 live jobs become **4,144 units**.*

---

## 3. The eight states

A unit is always in exactly one. States are **derived from evidence on every read** — nothing writes
a state by hand except through a named office column.

| State | In plain English | The predicate |
| --- | --- | --- |
| **OWED** | Ordered. Nothing exists yet. | required, a **fresh** look found no evidence of any kind (an old look that found nothing is UNKNOWN, not OWED — §4, *unknown*) |
| **RAW_IN** | The files are in. Nothing has been made from them. | `Deliverable.uploadedAt` / `capturedAt`, or raw files in the job's folder for that lane |
| **REVIEW_READY** | A version exists. Nobody outside the office has seen it. | a `ReviewSubmission` for this slot is PENDING or CHANGES_REQUESTED, **or** a finished file sits in the Final folder that the listing cannot account for |
| **APPROVED** | *We* accept it. | `ReviewSubmission.status = APPROVED` for this slot |
| **DELIVERED** | The client can actually see it. | the unit's category is live on **this job's** Aryeo listing **and** the listing's delivery status is DELIVERED; or the portal exposes the file; or the office pressed "delivered by hand" on this unit |
| **WAIVED** | The office said it isn't required on this job. | `Deliverable.waivedAt` |
| **REMOVED** | It came off the order, or moved to another order. | `Deliverable.removedFromOrderAt`, or moved-to-order |
| **UNKNOWN** | **The hub cannot see this.** | the source this unit depends on could not be read, has never been read, was read too long ago to prove an absence, or has no channel that could ever answer (drone/twilight/staging inside one gallery count) |

**REVIEW_READY off a Final-folder file is the "produced but unverified" state** the Review Room work
also needs: work that definitely exists, that the client definitely has not been shown through any
channel the hub can see.

`UNKNOWN` is never silently folded into owed *or* delivered. It is the honest answer, and it is a
question for a person, not a status.

---

## 4. The six words

### owed

> Work we still have to finish.

`state ∈ {OWED, RAW_IN, REVIEW_READY, APPROVED}`

This is `tasks.OWED_DELIVERABLE_WHERE` (the row-level rule agreed on the Sep 16 call:
`removedFromOrderAt: null, waivedAt: null`) generalised from the row to the unit. **It is the only
definition any screen may use.** An UNKNOWN unit is *not* owed — we do not put work on Kyle's board
that we merely failed to look at.

### approved

> We are happy with it. The client has not got it.

`state = APPROVED`. A **unit** property only. A job is never "approved" — that word belongs to a cut.

### delivered

Two different facts, and conflating them is why a job delivered in August and reopened yesterday
currently appears on no screen at all:

* **delivered (unit)** — `state = DELIVERED`. Positive, client-visible evidence.
* **delivered (job)** — every unit is DELIVERED, WAIVED or REMOVED. An UNKNOWN unit blocks it: the
  hub must not claim a delivery it cannot see.
* **`Project.deliveredAt` keeps exactly its present meaning** — the *history* fact that this job was
  delivered once, stamped once, never rewritten, never cleared. No phase of this migration touches
  it.
* **the obligation is closed** — terminal status, no open revision, nothing outstanding. This is the
  predicate the delivery board, the blocker chip and the recency queries should read, instead of the
  timestamp. `obligationClosed()` in `src/lib/evidenceUnits.ts`.

### overdue

> Past the promise, with work still owed.

Per unit: `promisedAt != null && now > promisedAt && owed(unit)`. A job is overdue if any unit is.

**Never derived from `Project.status`.** Today `getVideoSlaStatus` ends
`const delivered = p.status === "DELIVERED"`, which makes a hand-delivered job with a missing video
"on time" and, on a reopened job, hides lateness entirely.

### overridden

> The office said so, and no sweep may argue.

A unit or job carries an explicit office value: `waivedAt` (is it owed), `videosOwedOverride` (how
many units), `dueOverrideAt` + the new `dueOverrideScope` (the promise), `statusPinnedAt` (the
stage), and in Phase 1 `deliveredVia = 'office-hand'` (delivery). Each stays hub-owned, attributed,
and un-clearable by any sync or reconcile. Every surface renders it as *"set by the office on
&lt;date&gt; by &lt;who&gt;"* beside what the hub would have said on its own.

*Live today: 1 due override (99 W Bridge St), 2 videos-owed overrides (893 S Matlack St → 16, 5642
Limeport Rd → 4), 0 status pins, 0 tier overrides, 3 waived floor plans (195 Woodhill Rd, 99 W
Bridge St, 68 New St).*

### unknown

> The hub cannot see this.

Shown as its own thing, in its own words, with the reason. Never a red failure and never a green
tick.

*Predicate.* Four reasons, kept apart because they need four different answers: the hub has **never
read** this job's evidence; the last read **failed**; there is **no channel** that could ever show
it (question 2); or the last good read is **stale**.

**Stale needs its own rule, because evidence is not symmetric.** What a read SAW still stands — a
gallery that was live and released on Jun 20 is still delivered today, because media does not
un-deliver. What a read DID NOT see proves nothing a day later: the listing may have gone out that
same evening. So an old successful read may still say *delivered*, and may never again say *owed* —
anything it cannot see is UNKNOWN. The ceiling is the hub's existing one, `EVIDENCE_STALE_HOURS`
(24h, what the project card already calls stale), deliberately rather than a second definition of
"stale" invented for this document.

*This matters more than it sounds: only 48 of 1,553 jobs carry a read from the last 24 hours. 434
carry one older than 30 days and 1,013 have never been read at all — so the reconciliation's honesty
about what it does not know is most of its output, and question 12 is how that gets fixed.*

---

## 5. Approval is not delivery. A Final-folder copy is not delivery.

This is the single rule with the most consequences, so it gets its own heading.

* An editor uploading a cut is **REVIEW_READY**.
* Kyle or Jordan approving that cut in the Review Room is **APPROVED**.
* The approved file being copied into the job's `05-Final-Video` folder (`ReviewSubmission
  .completedAt`) is **still APPROVED**. A Dropbox folder is not a place a client looks.
* **DELIVERED** needs one of: the media live on the job's own Aryeo listing with the listing
  released; the file exposed in the client portal; or a person pressing "delivered by hand" on that
  unit, which records who and when.

If there is a fourth way you actually send finished work to clients — a Dropbox link in a text, a
WeTransfer, an email — say so (question 1) and we log **that send** as the delivery evidence. The
hub cannot count a channel it has never been told about.

---

## 6. What the override on a job's due date means

`Project.dueOverrideAt` currently means three different things in three files:

| Reader | What it treats the date as |
| --- | --- |
| `src/lib/projectStatus.ts:1032` | the **video's** deadline (guarded on "Video" still missing) |
| `src/lib/deliveryBoard.ts:368` | the **whole job's** deadline |
| `src/lib/editorQueue.ts:319` (`effectiveDue`) | the **whole job's** deadline |

So the same date you type produces two different verdicts on two screens.

**Proposed:** add `Project.dueOverrideScope` = `'job' | 'video' | '<unit id>'`, default **`'video'`**
— which is what the Sep 13 dialog copy and the status card both already assume. Exactly **one** row
in the whole database needs backfilling (99 W Bridge St), so this decision is cheap to make and
cheap to change. Question 3.

---

## 7. One promise engine (RTP-05)

Two engines currently date the same job. For a Sep 14, 10:00 AM premium reel, the task engine says
Sep 17 10:00 AM and the delivery board says Sep 18 5:00 PM. On the live board, **31 of the 32 dated
jobs disagree** with `Project.deliveryDue` — by up to 285 hours (measured Sep 16, before the current
delivery-board work).

The contract:

* `src/lib/turnaround.ts` is deleted. Its only consumer is the delivery board. Its **words** —
  "Same day", "Next day", "48 hours", "3-4 days", "7-10 business days" — move into `tasks.ts`, which
  has the hours but not the vocabulary the board chips print.
* Every promise is written by `tasks.deliveryDueFrom` with `turnaroundRules()` loaded,
  `slaTierOf` for the tier (the office's `tierOverride` on top), `videoAnchorFor` for video units.
* Each unit carries its **own** `promisedAt` (what we told the client) and `targetAt` (what we aim
  for internally), plus the anchor the clock started from.
* `Project.deliveryDue` is redefined as **the earliest outstanding unit promise**. The current value
  — the longest thing ordered — moves to a new column `promisedCompleteAt` so the on-time history in
  `queries.ts` is not silently rewritten. Question 4 decides whether history is restated.
* A monthly job with no shoot date gets a **persisted** anchor. Today the board anchors it to `now`
  on every page load, so its deadline slips one day for every day it waits.

---

## 8. What the reconciliation found

`npx tsx --env-file=.env scripts/evidence-reconcile.ts` — read-only, ~2 seconds, writes nothing.
Run Sep 16 2026 over 1,553 non-cancelled jobs.

**4,144 units:**

| State | Units | |
| --- | ---: | --- |
| DELIVERED | 1,080 | 26.1% |
| UNKNOWN | 2,878 | 69.4% |
| OWED | 96 | 2.3% |
| RAW_IN | 65 | 1.6% |
| REVIEW_READY | 15 | 0.4% |
| APPROVED | 1 | 0.0% |
| REMOVED | 6 | 0.1% |
| WAIVED | 3 | 0.1% |

**That 2,878 is the headline, and it is not what it looks like.** It splits into four very
different problems:

* **2,512 — never read.** 1,013 jobs (mostly the historical import) have never been successfully
  cross-checked at all. Nothing is wrong with them; the hub simply has no evidence either way.
  The 14-day freeze in §10 swallows this population whole.
* **274 — no evidence channel.** The photo gallery is out, but Aryeo gives one count for the whole
  gallery, so nothing proves the drone / twilight / staging set is inside it. This is question 2.
* **72 — the last good read is stale.** It was a real read, and what it saw still stands; what it
  did not see is a guess now (§4, *unknown*). These were the units a first pass called OWED off
  evidence up to four months old.
* **20 — the last read failed.** A stale zero that today is indistinguishable from a clean zero.

**The other side of the same coin, stated plainly:** 1,041 of the 1,080 DELIVERED units, across 466
jobs, rest on a read older than 24 hours. The contract lets those stand — a delivery does not undo
itself — and says so out loud rather than burying it. If that is not acceptable, the answer is not a
stricter predicate, it is question 12: re-read the back catalogue, or freeze it.

### Where the screens and the evidence disagree

| Screens say | Contract says | Units |
| --- | --- | ---: |
| DONE | UNKNOWN | 2,857 |
| DONE | DELIVERED | 1,080 (agree) |
| PENDING | OWED | 96 |
| DONE | RAW_IN | 45 |
| PENDING | UNKNOWN | 21 |
| DONE | REVIEW_READY | 14 |
| UPLOADED | RAW_IN | 11 |
| PENDING | RAW_IN | 9 |
| DONE | REMOVED | 4 |
| PENDING | WAIVED | 3 |
| DONE | APPROVED | 1 |
| anything | more than the screens claim | **0** |

The screens never understate. They only ever claim more than the evidence supports.

### The three predictions, checked

**1. "~11 jobs move from DELIVERED to APPROVED on their video unit" — CORRECTED.**

**10** jobs delivered since Aug 1 have a produced video that never reached the listing (the
verification's own predicate re-run today also returns 10 — one of its 11 has since had its video
land on Aryeo). Of those, **1 lands on APPROVED** and **9 land on REVIEW_READY**: they predate the
Review Room, so there is a file in the Final folder but no review round to approve.

| Street | Project id | Delivered | New state |
| --- | --- | --- | --- |
| 330 N Charlotte St | `cmrm43tmm00bll404wxy5ulvv` | 2026-08-12 | REVIEW_READY |
| 1741 Hilltop Rd | `cmsg7xsu9003blb04ls1zkukd` | 2026-08-17 | REVIEW_READY |
| 2310 Ellsworth St | `cmsvzjr8m009xl204zoc75a5i` | 2026-08-21 | REVIEW_READY |
| 1125 N Broom St | `cmss1bgfd003ajl04nerpjshg` | 2026-08-25 | REVIEW_READY |
| 3408 Oak Hill Rd | `cmsp5sb6q000fl404dtagqv35` | 2026-08-27 | REVIEW_READY |
| 1845 Serene Way | `cmt30g5fx0037l804y9hh4kzl` | 2026-08-29 | REVIEW_READY |
| 2009 Garrison Dr | `cmtadsigb0006l7041hg0zlyg` | 2026-09-01 | REVIEW_READY |
| 626 Greycliffe Ln | `cmss0hm14000al104d1pehjhh` | 2026-09-03 | REVIEW_READY |
| 208 N Adams St | `cmtak04sn0006ic04gmr9f3qa` | 2026-09-03 | REVIEW_READY |
| 2051 Old Sumneytown Pike | `cmtmvttvp0006lb04t7cf76kf` | 2026-09-09 | **APPROVED** |

One more sits outside the Aug 1 window — 143 Penns Manor Dr (`cmqzn6rph0001lk043p1yjtyk`, delivered
Jul 18) — so the all-time population is 11 jobs.

Separately, **375** jobs the screens call Delivered have at least one video unit the evidence cannot
call delivered: **363 UNKNOWN**, 10 waiting in the Final folder, 1 with raws only, 1 approved.

Not one of those 363 lands on *owed*, and that is deliberate. They split **330 never read once · 30
read, but too long ago · 3 whose last read failed**. The 30 are the ones that look genuinely short —
877 S York Dr shows two delivered videos of four, 1244 West Chester Pike one of four, 103 Swedesford
Rd and 198 Bridge St none of four — and they are exactly the ones an earlier pass of this report
called OWED. Then look at the dates: 103 Swedesford Rd and 198 Bridge St were both last read on
**Jun 20**, when the listing had not gone out at all. Calling a four-video batch "still owed" off a
June zero would put months-old jobs back on Kyle's board as live work. So the contract says *we
don't know* — and question 12 is how we find out.

**2. "~55 photo add-on units move from DONE to UNKNOWN" — CONFIRMED.**

**57 units across 52 jobs** in the same window the verification used (delivered since Jul 1, or in
REVIEW/REVISION). Across all live jobs where the gallery is out, the figure is **252 units on 228
jobs**: Drone 210, Twilight 23, Virtual staging 19. Every one reads DONE today because one listing
photo made the whole "Photos" category present. Live obligations invisible inside "Photos" across
every state: Drone 671, Twilight 186, Virtual staging 156, Headshots 1.

**3. "Erica Walker's August moves from 4/5 to 1/5" — CONFIRMED, exactly.**

One delivered job (131 Woodcutter St) with four ordered video units: the roster credits all four off
`Project.status = DELIVERED`. One video unit has client-visible evidence; the other three have none
of any kind (UNKNOWN — nothing produced, nothing on the listing, and the job's last read is old).
**4/5 → 1/5**, and 1/5 on either answer to question 5 (delivered-only, or approved-or-better).

Every other live content month is unchanged: Joe Sutow 4/4, Mike Ciunci 2/2, Marcee McMullen 4/5,
Bernadette Rabel 0/5 all read the same under both models today.

### The blast radius

**1,285 of 1,553 jobs (83%) would read differently somewhere.** That number is why this document
exists and why §10 is non-negotiable. With the 14-day freeze applied, **the live tail is 21 jobs** —
and that is the real blast radius of the migration:

```
S Lehigh River Dr        Drone · Photos · Floor plan · Video   DONE → UNKNOWN (never cross-checked)
Adventure Dr             Photos · Drone · Video · Floor plan   DONE → UNKNOWN (never cross-checked)
626 Greycliffe Ln        Standard Reel w/ Agent Intro          DONE → REVIEW_READY ·  Drone DONE → RAW_IN
195 Woodhill Rd          Drone                                 DONE → UNKNOWN
2530 W Walnut St         Drone                                 DONE → UNKNOWN
617 Westbourne Rd        Drone                                 DONE → RAW_IN
208 N Adams St           Standard Cinematic Video              DONE → REVIEW_READY ·  Drone DONE → RAW_IN
15 Larch Rd              Drone                                 DONE → RAW_IN
102 Knoxlyn Farm Dr      Drone                                 DONE → RAW_IN
750 E Marshall St 103    Virtual staging                       DONE → UNKNOWN
68 New St                Drone                                 DONE → RAW_IN
204 Spring Ln            Drone                                 DONE → RAW_IN
439 Lake George Cir      Drone                                 DONE → RAW_IN
2051 Old Sumneytown Pike Standard Cinematic Video              DONE → APPROVED ·      Drone DONE → RAW_IN
632 Greenridge Rd        Drone                                 UPLOADED → RAW_IN
… and 6 more
```

---

## 9. The five phases

**Phase 0 — measure (this document + the report). No writes. Ships first.**
`src/lib/evidenceUnits.ts` computes units and their states from the rows that already exist. It is
imported by the report and by nothing else. Jordan and Kyle sign off the numbers in §8 before a
single column is added.

**Phase 1 — the unit table.** Add `DeliverableOutput` (one row per unit) via `npm run db:push`
only — never `db:seed`, `db:reset` or a destructive migration. Columns: `deliverableId`, `slot`,
`category`, `requiredFrom`, `promisedAt`, `targetAt`, `promiseSource`, `promiseAnchorAt`, the six
evidence stamps (`rawInAt`, `reviewReadyAt`, `approvedAt`, `deliveredAt`, `deliveredVia`,
`deliveredBy`), `waivedAt/By/Note`, `removedFromOrderAt/Note`, and `evidenceAttemptedAt` /
`evidenceSucceededAt` / `evidenceSource`. Unique on `(deliverableId, slot)` — which is
`ReviewSubmission`'s existing index, so cuts join on identity with nothing rewritten.

*Must ship in the same PR:* `reviewCuts.ts:419` and `:1358`, `contentProgram.ts:142/264/279` and
`app/content/[id]/page.tsx:88` still filter on `removedFromOrderAt` alone, so a **waived** video row
still mints cut slots and still counts against the meter. The backfill would inherit that.

*One known gap to settle in the same phase:* **12 of the 24 `ReviewSubmission` rows carry no
`deliverableId`** — the older folder-discovered cuts, which are identified by their Dropbox path
instead. They cannot attach to a unit until they are re-keyed, and a path is mutable (overwrite the
file and an old round plays something else). Re-keying them is the same work the Review Room's
immutable-history ticket needs, so it belongs here, not after.

**Phase 2 — backfill the evidence stamps, deliberately conservative.** Every stamp tagged with its
source. `rawInAt` ← `Deliverable.uploadedAt`/`capturedAt`. `approvedAt` ← the approved
`ReviewSubmission` for that slot. `deliveredAt` ← `Project.deliveredAt`, **only** for categories the
last evidence read shows live on Aryeo — never from a Dropbox final count. Anything the backfill
cannot decide is **UNKNOWN, never OWED**: that is what stops the migration re-opening closed jobs as
live work.

**Phase 3 — dual run, one week, no visible change.** The hourly sweep computes both models, writes
only the new table, and logs every disagreement **on a live (undelivered) job** with the unit, both
verdicts and the source. Gate to Phase 4: that list is empty, or every entry has a named
explanation.

**Phase 4 — flip readers one at a time**, behind `AppSetting evidenceModel: 'legacy' | 'units'`, one
PR each, the old path retained: (1) the delivery board's due and blocker; (2) the QC card and the
"Photos done" gate in `app/ops/actions.ts`; (3) the status card's reason sentence, which must name
the actual source — *"the video is in the Final folder but not on the listing"*, never "confirmed
live on Aryeo"; (4) the editor queue; (5) the Content Program roster, workspace and portal; (6) the
KPIs last.

**Phase 5 — retire the duplicates** the contract makes redundant: `src/lib/turnaround.ts`; the second
`CATEGORY_KEYWORDS` table in `qcCategories.ts` (already drifted from `projectStatus.ts`); the
duplicate `videoUnits` arithmetic in `app/content/[id]/page.tsx` vs `contentProgram.ts`; and
`projectStatus.syncDeliverableStatuses`'s category-spreading write.

---

## 10. The hard freeze (non-negotiable)

> **Any job delivered more than 14 days before the migration is written DELIVERED on every unit,
> regardless of what the evidence says**, tagged `evidenceSource = 'legacy-closed'`.

History is not re-litigated. Only the live tail is re-derived. This is what protects the jobs
delivered before the Review Room existed: of the 55 jobs delivered since Aug 1 that owed a video, 12
cannot prove every video unit, and most of those were genuinely delivered by Dropbox or direct send.
It is also what stops `/content` showing the whole program in the red on day one.

The same rule applies to `ContentMonth`: months older than the Review Room's first use freeze at
their recorded delivered count.

Fourteen days is a proposal, not a law — question 11.

---

## 11. Send suppression (non-negotiable)

> **Any unit whose `evidenceSource` starts with `legacy-` is excluded from every automated side
> effect until a human touches the job.**

That means: confirmation and delivery texts (`clientTextSweeps`), `tasks.chaseVendorsForMissing`,
`ensureEditorHandoff`, every bell/Slack/SMS in `notify.ts`, and the Content Program portal.

The migration must be **incapable** of texting a real agent about a job that closed in August.

---

## 12. What this contract will never do

Nothing in any phase deletes or rewrites: `Project.deliveredAt`; any `ReviewSubmission` row,
including withdrawn, superseded and reassigned history; `Deliverable.capturedAt` / `uploadedAt` /
`notCompletedReason`; `statusEvidence` history; `ContentEnrollment` / `ContentMonth` rows; the
skipped / historical / imported month semantics; any office override or pin; the optional QC ticks;
or the configured automatic client texts.

Quantity is still never lowered by the Aryeo reconcile. Lowering stays an explicit office act
(question 8).

---

## 13. The questions only Jordan can answer

**These block Phase 1.** Each has a proposed default, so silence is still a decision — but a stated
one.

1. **A finished video sitting in the job's Dropbox Final folder, never posted to the Aryeo listing —
   is the client delivered?** 10 jobs since Aug 1 turn on this (listed in §8). *Proposed: no — that
   is "approved", not "delivered". If you do send those by link or text, tell me which path and we
   log that send as the delivery evidence instead.*
2. **Drone, twilight and virtual staging land in the same Aryeo gallery, and Aryeo gives one count.**
   252 units on 228 live jobs have no channel of their own. *Proposed: (a) Kyle ticks each add-on off
   on the QC card, or (b) the add-on is treated as delivered with the gallery and the screen says so
   as an assumption, not as proof.* Pick one.
3. **The due date you set in the override dialog — the video's, or the whole job's?** *Proposed:
   the video's; one existing row (99 W Bridge St) backfills to that.*
4. **If a job's due becomes "the earliest thing still owed" instead of "the longest thing ordered",
   the historical on-time percentage moves.** *Proposed: freeze history on the old definition, start
   the new measure today.*
5. **Content meter: does a video count when the cut is APPROVED, or only once the client has it?**
   Erica Walker's August is 1/5 either way today, but the two answers diverge the moment a month is
   mid-flight. *Proposed: show delivered, with approved-but-not-delivered called out beside it.*
6. **When a content month comes up short, do the missing videos carry forward automatically, or wait
   for you to move them?** The debt has to stay visible either way — the question is whether it reads
   "still owed in August" or "moved to September".
7. **A monthly job with no shoot date: what does its clock run from** — the 1st, the strategy call,
   or the first filming day? Today it re-anchors to "now" on every page load.
8. **If a 16-video package is cut to 8 in Aryeo, should Aryeo win, or does lowering stay your job in
   the override dialog?** *Proposed: stays yours — the hub only ever raises, to stop hourly
   ping-pong.*
9. **A delivered job the client reopens — what is the new promise?** A fixed turnaround from the ask
   (24h? 48h?), or Kyle sets it by hand? Today a reopened job has no due date at all.
10. **Where do ON_HOLD jobs live in the obligation model** — does a hold suspend the promise and its
    clock, or park the work while the promise stands? And should a reopened job be exempt from the
    board's 10-day delivered tail? (56 Hillview Rd has been on hold since Jul 30 and appears on no
    screen; 1337 Carolannes Way was delivered Aug 28, reopened Sep 14, and is on no board.)
11. **Is 14 days the right freeze line?** Longer means less re-derivation and more history taken on
    trust; shorter means more jobs re-examined and more noise on day one.
12. **The hub is barely looking, and that is most of this report.** 1,013 jobs have never been
    successfully cross-checked, and only 48 of 1,553 carry a read from the last 24 hours — the sweep
    takes 80 jobs a pass, ordered by a column it bumps itself, so it circles the same top of the
    list. Three decisions ride on it: (a) the never-read 1,013 — *proposed: freeze as delivered under
    §10, never re-derived*, the alternative being a one-off read of all of them, ~1,000 Aryeo calls
    that will surface real gaps in jobs you closed months ago; (b) fix the sweep's selection so
    oldest-checked goes first (a one-line handover on `syncProjectStatuses`); (c) the staleness
    ceiling for a NEGATIVE conclusion, currently the hub's existing 24 hours (§4, *unknown*) — and
    whether a delivery seen months ago still counts as seen. *Proposed: yes, it counts. 1,041
    DELIVERED units rest on it.*

Two smaller ones, for whoever owns those files: the delivery board's `dueFor` chip encodes a
delivery definition inside a tooltip and must resolve to the predicate above; and `finance.ts`'s
`aryeoDelivered`, labelled `invoiced`, should either adopt this definition verbatim or be deleted.

---

## 14. Running the report

```bash
export PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH
npx tsx --env-file=.env scripts/evidence-reconcile.ts                 # the summary above
npx tsx --env-file=.env scripts/evidence-reconcile.ts --all           # every affected job
npx tsx --env-file=.env scripts/evidence-reconcile.ts --json=/tmp/units.json   # per-unit detail
```

Read-only: it opens the database, reads projects, deliverables, review submissions and content
months, and writes nothing. It touches no Dropbox file, no Aryeo record and sends no message.

It should also get an npm entry so nobody has to remember the invocation —
`"reconcile:units": "tsx scripts/evidence-reconcile.ts"` in `package.json`, run as
`npm run reconcile:units -- --all`. That one line is the only change this work needs outside its own
files.

The computation itself lives in `src/lib/evidenceUnits.ts` and is imported by the report and by
nothing else. Wiring it into a screen is Phase 4, after the questions above are answered.

---

## 15. One honest read (shipped alongside this document)

The contract leans on "the hub could not look" being distinguishable from "the hub looked and saw
nothing". Until Sep 16 it was not: when both Aryeo and Dropbox failed, the sweep stamped
`statusCheckedAt` — the same column a clean pass stamps — and moved on. Two readers take that as
proof of freshness (`StatusEvidenceCard`'s *"Cross-checked 3 minutes ago"*, and `deliveryWatch`,
which can text Kyle and Jordan off a stale zero).

`src/lib/projectStatus.ts` now stamps three columns instead of one:

* `evidenceAttemptedAt` — every time we look.
* `evidenceSucceededAt` — **only** when a source actually answered *and* nothing we tried to read
  failed. A pass where both sources were simply unavailable — no Aryeo listing on the job, and
  Dropbox not connected (which is decided once for the whole batch) — read nothing, so it is not a
  success either. Without that second half the failure this section exists to kill comes back in a
  new shape: 52 live jobs have no listing id, and the day the Dropbox token lapses every one of them
  would go confidently green.
* `evidenceError` — the reason, in the words of whichever of the three it was ("no evidence source
  could be read", the source's own error, or "read outcome not recorded"), or null on a clean pass.

`statusCheckedAt` keeps its existing meaning ("the status engine ran") because other screens and
batches read it. No status decision, threshold or guard changed: `computeStatus` never sees the read
outcome, which is proven by a fixture that computes the same status and the same sentence with a
failed outcome attached.
