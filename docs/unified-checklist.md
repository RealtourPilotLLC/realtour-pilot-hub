# Unified implementation checklist

Source: `~/Downloads/Realtour-Pilot-Unified-Claude-Implementation-Handoff-2026-09-25.md` (§13 batches).
Progress record: [`docs/handoff.md`](handoff.md). Verified designs: `docs/.unified-verify-batch0.json`.

Each item: **verified status → commit → test evidence / environment → deployed SHA → enabled scope → remaining owner/action**.
Implemented, tested, deployed and enabled are separate fields. A passing total is not a substitute for a missing journey or provider test.

Status key: CONFIRMED (defect/gap real) · PARTIALLY_IMPLEMENTED · ALREADY_FIXED (evidence in the design column of the JSON) · CONFIGURATION_DEPENDENT · NOT_REPRODUCIBLE.

## Batch 1 — Operational correctness (38 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| O09 | CONFIRMED | L | e954b23 + 2c74adc | b1-active-editing (§0 (old at 75d56f1: office click logged as "Kim started editing.", three jobs claimed at once) + §2 + §7) · PGlite · remainder: b1-remainders (b1-remainders §1 (setTaskAssignee closes REASSIGNED at once, recorded as Jordan on Kim's behalf; unassign closes UNASSIGNED; Kim h…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; the project-page pick is not honoured while the old editor has open work (tasks.mintEditTask; measured, not my file) |
| 7.1-states | PARTIALLY_IMPLEMENTED | M | e954b23 | b1-active-editing (§1, §6, §9 workLabel over lifecycle × {none, active, paused}; queue labels) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| 7.1-one-active-atomic-switch | CONFIRMED | M | e954b23 | b1-active-editing (§2 switch; §3 a trigger failure after the pause write leaves A ACTIVE with the same activeSince; §4 concurrent tabs, doubled click, P2002) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | real-Postgres interleaving deferred to R04 |
| 7.1-identity-on-behalf | CONFIRMED | S | e954b23 | b1-active-editing (§5: John untouched by Kim; Jordan (OWNER) and Kyle (ADMIN) recorded on behalf with their own names; editor refused on others' work; forEdito…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| 7.1-sync-never-starts | PARTIALLY_IMPLEMENTED | M | e954b23 + 2c74adc | b1-active-editing (§8: 11 automatic/office paths give 0 new ACTIVE and 0 START/RESUME/CONFIRM; correctedCutWithdrawn now writes SHOT; an override pin reads "no…) · PGlite · remainder: b1-remainders (b1-remainders §2: "In progress" refused for office and editor with the card untouched; at f2555f7 it was written with no work behi…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; restoreToEditorQueue still restores the card's IN_PROGRESS while the work stays closed (as designed; not my file) |
| 7.1-derived-in-editing-labels | CONFIRMED | M | e954b23 + 2c74adc | b1-active-editing (§9: editorQueue, videoStatesFor, EditTracker and workingNow agree; no "In editing" without someone ACTIVE) · PGlite · remainder: b1-remainders (b1-remainders §3: board, card and queue agree across Ready, not-confirmed, active, paused and agency; at f2555f7 the board said "W…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; home page rows chip "editing" (src/app/page.tsx ~1373) is still stage-derived; stale comment in editorWork.ts ~278 |
| 7.1-editor-controls | CONFIRMED | M | e954b23 | b1-active-editing (drill drives the server actions; WorkStateBar on /edit/[id], EditorDesk on /editing, pill Paused plus requestId) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | no browser walkthrough; the guide text in content.ts is not owned |
| 7.1-working-now | CONFIRMED | M | e954b23 | b1-active-editing (§1, §9 workingNow by editor (active, paused, unconfirmed); backlog heading; lane relabelled) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| 7.1-refresh-stale | CONFIRMED | S | e954b23 | b1-active-editing (§9 table made unreadable → ok:false with a reason; AutoRefresh 60s is mounted) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | PARTIAL — client-side stale warning not drilled |
| 7.1-logging | PARTIALLY_IMPLEMENTED | S | e954b23 | b1-active-editing (§2: one event and one Activity row per transition; a replay writes zero; close events carry actor and reason) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| 7.1-close-on-submit-reassign-cancel | CONFIRMED | M | e954b23 + 2c74adc | b1-active-editing (§7: SUBMITTED (portal finalize), REASSIGNED (setEditVideoEditor), REMOVED and restore, PROJECT_DELIVERED (board), PROJECT_CANCELLED, PUT_BAC…) · PGlite · remainder: b1-remainders (b1-remainders §1: the setTaskAssignee close is immediate) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; lib merge still closes through the ghost sweep (not my file) |
| 7.1-revision-semantics | CONFIRMED | S | e954b23 | b1-active-editing (§6: status stays REVISION, the revision task is untouched, the row reads Revisions with an "Active — Kim" chip) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| 7.1-migration | CONFIRMED | S | e954b23 | b1-active-editing (§1: zero rows on read, 3 claims with Activity dates where they exist, confirm gives 1 ACTIVE + 2 PAUSED, status unchanged, payroll identical) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | live count probe not run (forbidden this batch) |
| A58 | PARTIALLY_IMPLEMENTED | S | e954b23 + 2c74adc | b1-active-editing (§8) · PGlite · remainder: b1-remainders (b1-remainders §1/§2: setTaskAssignee, setSmartTaskStatus (office and editor), dismissTask and moveProjectStatus in both directions…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | closed in 2c74adc |
| A59 | CONFIRMED | S | e954b23 | b1-active-editing (§2, §3) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| A60 | CONFIGURATION_DEPENDENT | S | e954b23 | b1-active-editing (§4) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | R04 real-Postgres run |
| A61 | CONFIRMED | S | e954b23 | b1-active-editing (§5) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| A62 | CONFIRMED | S | e954b23 | b1-active-editing (§2 snapshot of card, revision, project dates and outputs is byte-identical across pause and resume) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| A63 | CONFIRMED | S | e954b23 | b1-active-editing (§7) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| A64 | CONFIRMED | S | e954b23 + 2c74adc | b1-active-editing (§9) · PGlite · remainder: b1-remainders (b1-remainders §3 (plus the card read's scope and a failed read returning ok:false)) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; same as the 7.1-derived-in-editing-labels row |
| A65 | CONFIRMED | S | e954b23 | b1-active-editing (§1) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | live probe |
| O03 | CONFIRMED | M | e954b23 | b1-review-ownership (b1 §0 (old code: only the OWNER+ADMIN broadcast, the non-admin seat refused) + §2 (tm:<james> row, Kyle FYI DM, Jordan oversight) + §3 (Jame…) · PGlite | f2555f7 (Vercel 783ja2fmz) | seats unset until saved | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: save the review_room seats in production (settings action); confirm James's AppUser role (batch-0 probe) |
| 8.1-reviewer-assignment | CONFIRMED | L | e954b23 | b1-review-ownership (b1 §2 (one reviewer, one SUBMITTED event, 3-way race writes one event), §4 (away order James→Kyle→Jordan→office), §5 (take/hand on with comp…) · PGlite | f2555f7 (Vercel 783ja2fmz) | seats unset until saved | PARTIAL — Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: Review Room queue "Mine" filter and reviewer label (reviewRoom.ts, review pages) and videoReviewBoard — outside my file list |
| 8.1-scoped-authority | CONFIGURATION_DEPENDENT | M | e954b23 | b1-review-ownership (b1 §3: Approve/Send back/office note work for a non-admin seat through the real actions under AUTH_ENFORCE; Harrison, Harrison with the crea…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: review pages still gate on OWNER |
| 8.1-notifications-oversight | CONFIRMED | M | e954b23 | b1-review-ownership (b1 §1 (unconfigured = old broadcast), §2 (assignee row + OWNER oversight + FYI, no ADMIN broadcast, repeat adds 0 rows, James bell-only by h…) · PGlite | f2555f7 (Vercel 783ja2fmz) | seats unset until saved | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: the bell-only warning is in the Review Room card rather than TeamNotifications; James's external channel is Jordan's call |
| 8.1-coverage-transfer | CONFIRMED | S | e954b23 | b1-review-ownership (b1 §4 (away moves only PENDING cuts; coming back moves nothing), §6 (Fri-5pm cut offered to Kyle once on Monday at 9½ covered hours, nothing…) · PGlite | f2555f7 (Vercel 783ja2fmz) | auto-move OFF (null) | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: Jordan's answer on coverTransferHours (null/off today) and James's channel |
| O07 | CONFIRMED | L | e954b23 | b1-selfqc-issues (b1-selfqc-issues §C: kpi.ts scoreQuarterRoster and qc.getQcStats identical before and after (with seeded data); §B causes set by a reviewer …) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| 8.2-self-qc | CONFIRMED | XL | e954b23 + 2c74adc | b1-selfqc-issues (§A (a)–(l): 44 checks — refusal, binding, finish/callback race, held on mismatch, button dry run, content_hash, sweep held, drift void, move…) · PGlite · remainder: b1-remainders (b1-remainders §5: unchanged bytes keep the check; at f2555f7 changed bytes streamed with the check still VALID; now VOID, cut sent…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; Review Room "waiting on check" group, CutReviewPanel attestation, checklist editor in Settings (not in this brief) |
| 8.3-revision-issues | PARTIALLY_IMPLEMENTED | XL | e954b23 + 2c74adc | b1-selfqc-issues (§B: 28 checks — idempotent note and brief ingestion, portal addendum, addressed on v2 then verified at approval, unticked approval refused, …) · PGlite · remainder: b1-remainders (b1-remainders §6: at f2555f7 a refused re-read wiped the tick; now refused with the ticks kept and no model call; an unticked requ…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; verify/not-fixed controls in the Review Room panel (not in this brief) |
| 8.4-kpi | CONFIRMED | L | e954b23 + 2c74adc | b1-selfqc-issues (§C: pure outcomes, 17h Fri 5pm → Mon 10am, James/Kyle 16h/1h split, 5 of 6 then 6 of 6 after reclassification, duplicate counted once, block…) · PGlite · remainder: b1-remainders (b1-remainders §7: the /editing page tree carries Kim's own card for Kim and John's for John; the office view has none) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | closed in 2c74adc |
| A34 | CONFIRMED | XL | e954b23 | b1-selfqc-issues (§A (a)–(l) plus the cp01/cp02/cp02b/cp03/cp12 regression drills green) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | stream-route drift |
| A35 | CONFIGURATION_DEPENDENT | M | e954b23 | b1-review-ownership (b1 §3: one approval completes; Kyle/Jordan intervening is one call plus one COVER event, no co-approval; creativeManager and pay columns unc…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: none beyond the production seat configuration |
| A36 | PARTIALLY_IMPLEMENTED | L | e954b23 | b1-selfqc-issues (§B: addendum, replacement v2, finish retry race, Kim→John reassignment, verification required) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | Review Room panel UI |
| A37 | CONFIRMED | M | e954b23 | b1-selfqc-issues (§B merge counts once; CLASSIFIED events with from→to; §C CLIENT_CHANGE vs EDITOR_ERROR re-scores; nothing classified by the hub) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| A38 | CONFIRMED | M | e954b23 | b1-selfqc-issues (§C: pending and unclassified excluded from the denominator, n and product shown, reviewer waiting time per queue, blocked time "not recorded…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| O02 | CONFIRMED | L | e954b23 + 2c74adc | b1-readiness-topaz (Drill sections:) · PGlite · remainder: b1-remainders (b1-remainders §8: HOW-A-VIDEO-MOVES describes the HELD file in unverified/ and the three buttons (Check again, Keep the approved o…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | closed in 2c74adc |
| A39 | CONFIRMED | S | e954b23 | b1-readiness-topaz (Drill B1/B3/B4: the approved original stays intact and becomes the file to send under an explicit reviewer decision; no blind re-render or r…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | — |
| O01 | CONFIRMED | M | e954b23 + 2c74adc | b1-readiness-topaz (Drill sections A0–A10: the old code at 75d56f1 says "ready for editing" on a blocked job; the new receipt is truthful and quotes the card's …) · PGlite · remainder: b1-remainders (b1-remainders §4: at f2555f7 the queue said "Ready for editing"; now "Waiting on instructions" with the engine's sentence; card an…) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | remainder in 2c74adc; editorWorkload.laneOf has no case for the new word (the page maps it to Waiting) |

## Batch 2 — Guided content preparation (38 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| 6.1-stripe-price-catalogue | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-signups + cp14 (cp14 §14: OLD (f2555f7) returns 'not_program' for a renamed product on price_1ToRWNRrlUAkQjeVnlqXzQZp, and for a known product wit…) · PGlite | pending | live on deploy | — |
| A03 | ALREADY_FIXED | S | 2c74adc | b2-signups + cp14 (b2 §1: OLD (f2555f7) two concurrent checkouts for one new email → 2 Client rows. NEW → 1 client, 1 enrollment, 2 signups on it, se…) · PGlite | pending | live on deploy | real-Postgres contention run (R04); PGlite cannot prove the lock under true concurrency |
| 6.1-discovery-different-address | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-signups + cp14 (b2 §2 (real Calendly sync against a fake): OLD (f2555f7) welcome '1. Book your brand discovery call at…' + Kyle 'Book the brand di…) · PGlite | pending | live on deploy | the candidate task is not re-evaluated if the candidate booking is later cancelled |
| 6.1-calendly-event-types | ALREADY_FIXED | S | 2c74adc | b2-signups + cp14 (b2 §3: a booking on an unmapped event type named 'Brand Discovery Call' → the real sync writes no record (unrelated:1, created:0).…) · PGlite | pending | live on deploy | add uri/enabled/validationStatus/lastSyncedAt to scripts/_recon/cp15-config-probe.ts (not my file) |
| 6.1-account-access-scoping | ALREADY_FIXED | S | 2c74adc | b2-signups + cp14 (b2 §4: an address seated on another client → CONFLICT, nothing seated, existing name 'Jo Oldfield' not rewritten) · PGlite | pending | live on deploy | — |
| 6.1-setup-brand-assets | ALREADY_FIXED | S | 2c74adc | b2-signups + cp14 (b2 §5: SETUP_ITEMS carries colors/logo/headshot/fonts/links/music; setupFacts all false for a fresh signup; cp06-brand-setup.ts 12…) · PGlite | pending | live on deploy | launch-gated display (portal_invites / portal_layout_v2) unchanged |
| 6.2-transcript-association | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-discovery-strategy (b2 §1: OLD renamed attached doc not strong; NEW attached doc gives auto even when renamed; other person's same-hour doc stays a ca…) · PGlite | pending | OFF/TEST-only per switches | PARTIAL — read-only check that Meet attaches the Gemini doc on the real account (one Calendar GET) |
| 6.2-discovery-analysis-into-month | CONFIRMED | M | 2c74adc | b2-discovery-strategy (b2 §2: OLD discovery ANALYZE made a 2026-09 month with COMPLETED and a selection; NEW: 0 months, 0 selections, 2 PROPOSED bank top…) · PGlite | pending | OFF/TEST-only per switches | — |
| A04 | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-discovery-strategy (b2 §3: NEW Drive/Calendly/Notetaker sweeps all 'retired' with 0 mappings; OLD first-name fallback filed Mike Flatley's notes on Mi…) · PGlite | pending | OFF/TEST-only per switches | re-run cron-route-journey §6 once contentDrafting settles |
| A08-strategy-reference-format | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-discovery-strategy (manifest script and committed docs/strategy-reference-manifest.md (7 files, --check deterministic); b2 §5: OLD '(framework: policy…) · PGlite | pending | OFF/TEST-only per switches | PARTIAL — real-model (live) draft evidence not run (provider-call rule) |
| A08-strategy-editing-and-release | CONFIRMED | L | 2c74adc | b2-discovery-strategy (b2 §5–§8: staff draft with strategy_generation OFF gives a DRAFT and 1 bell; section edit gives a new version, 0 AI runs, others b…) · PGlite | pending | OFF/TEST-only per switches | UI not browser-rendered |
| 6.2-strategy-ready-notice | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-discovery-strategy (b2 §8: real client SUPPRESSED launch_not_authorised; TEST client sent only to info@ with subject 'Your Content Strategy is Ready +…) · PGlite | pending | OFF/TEST-only per switches | W03 in-portal booking link to replace the Calendly fallback when it lands |
| 6.2-call-knowledge-proposals | ALREADY_FIXED | S | 2c74adc | b2-discovery-strategy (cp11 67/67 on port 5623; b2 §2: the discovery call's changed preference becomes a PROFILE proposal with the call as provenance) · PGlite | pending | OFF/TEST-only per switches | — |
| A09 | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-discovery-strategy (b2 §4: STRATEGY_DRAFT waits (QUEUED, attempts 0) until ANALYZE succeeds, then runs once; §5: OLD prompt had broker/80-20/Harriet, …) · PGlite | pending | OFF/TEST-only per switches | cp08 re-run after SCRIPTS-TOPICS lands (its 3 failures are in their files) |
| stripe-webhook-registration-readiness | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-signups + cp14 (cp14 §16: malformed whsec_ refused without echo; good one saved encrypted; receiver 200 PROCESSED with it; coverage bell rings exa…) · PGlite | pending | live on deploy | PARTIAL — run the dry run, then --apply, after deploy; proof = next real checkout activatedVia 'webhook' |
| R01 | CONFIRMED | L | 2c74adc | b2-planning (b2-planning §1–4 (OLD f2555f7: planModel said 2 chosen / 3 need answers, monthProgress counted the extra twice (3+1), the gate car…) · PGlite | pending | OFF/TEST-only per switches | programOverview.ts answersOutstanding and callMode patch (not mine); update cp15, scheduled-journey and cron-route-journey expectations; browser walk |
| U01 | CONFIRMED | M | 2c74adc | b2-scripts-topics (b2 P1/P2: every renderScript shape parses as Hook + 3 roled points + Close (+Caption) with zero word loss; the f2555f7 ScriptBody …) · PGlite | pending | OFF/TEST-only per switches | StrategyDocView (DISCOVERY-STRATEGY); postingKit body should use {audience:'client'}; PlanTab could pass parts |
| U02 | CONFIRMED | S | 2c74adc | b2-scripts-topics (b2 U02: before the repair the TEST page showed acceptance/§25; dry run = 1/5/2 TEST rows, real-client rows REFUSED, nothing writte…) · PGlite | pending | live on deploy | main session runs scripts/repair-test-fixture-wording.ts (dry run, then --write) on production |
| 6.3-topic-bank | CONFIGURATION_DEPENDENT | S | 2c74adc | b2-scripts-topics (b2: the bankStock target follows the policy (10, then 12 after an owner change); cp07 116/0) · PGlite | pending | OFF/TEST-only per switches | turning on topic_refresh and topic_carryover at rollout is Jordan's call |
| 6.3-recommendations | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-scripts-topics (b2: OLD recommended 4 on a 4-video month with 1 carried, could include declined/unapproved AI topics, and had no client reason; NE…) · PGlite | pending | OFF/TEST-only per switches | a bank link for "Choose another topic" (PLANNING's PlanTab); the auto-rank rides topic_refresh |
| 6.3-staff-bank-controls | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-scripts-topics (b2: approve-all turns 3 PENDING into 3 approved topics and a second click adds 0; hold takes a suggestion off the queue and blocks…) · PGlite | pending | OFF/TEST-only per switches | — |
| 6.4-route-choice | CONFIRMED | M | 2c74adc | b2-planning (b2 §5 (OLD: month 2 REQUIRED/CALL for ever; NEW: OPTIONAL_WRITTEN/UNDECIDED after a held call, month 1 stays REQUIRED, explicit co…) · PGlite | pending | OFF/TEST-only per switches | run the read-only enrollment count before rollout; workspaceData/programOverview still show the column reading |
| 6.4-call-route-advance-booking | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-planning (b2 §8 (OLD source read the call START; NEW: open 10 minutes into the call with earliest = END + window; a call booked for Mon Oct …) · PGlite | pending | OFF/TEST-only per switches | W01 72h at earliestFilmingStart (batch 3) |
| 6.4-written-route-gate | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-planning (b2 §4 (OLD: an unanswered extra kept the gate shut, AWAITING_ANSWERS; NEW: open at last submission + window, evaluator moves to BO…) · PGlite | pending | OFF/TEST-only per switches | W01 |
| 6.4-schedule-later | CONFIRMED | S | 2c74adc | b2-planning (b2 §7 (server stamp, idempotent, survives refresh, reminder lanes identical before/after with one BOOK_SESSION, Home keeps "Book f…) · PGlite | pending | OFF/TEST-only per switches | — |
| 6.4-route-switch | ALREADY_FIXED | S | 2c74adc | b2-planning (b2 §6 (CALL→WRITTEN→CALL: same selection, interview and script ids; 0 call records, session requests or AI runs added; step ON_CAL…) · PGlite | pending | OFF/TEST-only per switches | — |
| 6.4-written-route-call-buffer | CONFIRMED | S | 2c74adc | b2-planning (b2 §9 (OLD: no exception; NEW: 1 exception + 1 KYLE CALL_INSIDE_BUFFER, new offers ≥ call end + window, the session is untouched; …) · PGlite | pending | OFF/TEST-only per switches | W01 window |
| 6.5-questions | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-scripts-topics (b2: OLD (f2555f7) a call topic started the full questionnaire; NEW opens as CALL/GAPS_ONLY and asks talkingPoints only, then done …) · PGlite | pending | OFF/TEST-only per switches | tailored wording still needs script_drafting + ai_runs |
| 6.5-drafting-durability | ALREADY_FIXED | S | 2c74adc | b2-scripts-topics (b2: 1st failure opens no task; 2nd opens ONE task on 'jordan'; the next success drafts once and closes it; 3 model calls; 1 script…) · PGlite | pending | OFF/TEST-only per switches | — |
| 6.5-call-topic-capture | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-planning (b2 §3 (a portal pick re-mentioned on the call, through the shipped KEPT path, reads WRITING and drafts FROM_CALL with 2 excerpts; …) · PGlite | pending | OFF/TEST-only per switches | — |
| 6.5-script-framework | CONFIGURATION_DEPENDENT | S | 2c74adc | b2-scripts-topics (b2: a two-point script refuses approval with 'House script format' even with a note; a long draft is flagged outside 20-30 s and n…) · PGlite | pending | OFF/TEST-only per switches | the A15 real-model run and the hard-block-vs-warn question stay open (Jordan's answer: keep warn plus one-click tighten) |
| 6.5-release-controls | PARTIALLY_IMPLEMENTED | M | 2c74adc | b2-scripts-topics (b2: script_auto_share missing row = OFF, with its own words; settings shows the three rows with dependencies; all OFF: no DRAFT te…) · PGlite | pending | OFF/TEST-only per switches | turning on script_auto_share is Jordan's call (OFF per §3) |
| 6.5-approve-share-records | ALREADY_FIXED | S | 2c74adc | b2-scripts-topics (b2 release section: distinct APPROVE and SHARE rows, SUPPRESSED notification, idempotent; r1-r2 37/0) · PGlite | pending | OFF/TEST-only per switches | — |
| 6.5-version-exact-decisions | ALREADY_FIXED | S | 2c74adc | b2-scripts-topics (b2: approving a stale version id is refused; the shared id is approved; changed words re-share with decision null and staleApprova…) · PGlite | pending | OFF/TEST-only per switches | — |
| 6.5-approval-reminders-24h | CONFIRMED | M | 2c74adc | b2-scripts-topics (b2 P5 + DB: Thu 10:00 session gives Tue 10:00 email (Mon session: Fri 09:00; evening: Tue 09:00), deadline Wed 10:00, no em dash, …) · PGlite | pending | OFF/TEST-only per switches | outbox.ts subject case (not mine); turning on reminders is Jordan's launch decision |
| 11-your-month | CONFIRMED | L | 2c74adc | b2-planning (b2 §5/§7/§10 (exactly one current step across 7 states; the page renders one aria-current step with the embedded picker and Schedu…) · PGlite | pending | OFF/TEST-only per switches | browser walk at 375px and desktop pending |
| 11-plain-labels | PARTIALLY_IMPLEMENTED | S | 2c74adc | b2-planning (b2 §11 (OLD strings present at f2555f7; NEW: none left in rendered code; CTA_WORDS equal §11's list; nav "Your Month"; client pill…) · PGlite | pending | OFF/TEST-only per switches | — |
| 11-precise-progress | CONFIRMED | S | 2c74adc | b2-planning (b2 §1 (headlines: one more answer / answers for 2 topics / ready for review / writing / reviewing / on your call / all approved; p…) · PGlite | pending | OFF/TEST-only per switches | — |

## Batch 3 — Scheduling and integrations (18 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| R03 | CONFIGURATION_DEPENDENT | M |  | | | | |
| W01 | CONFIRMED | S |  | | | | |
| A18 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A19 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A20 | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A21 | CONFIRMED | M |  | | | | |
| W02 | CONFIRMED | L |  | | | | |
| A22 | CONFIRMED | S |  | | | | |
| A23 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A24 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A25 | CONFIRMED | M |  | | | | |
| R02 | CONFIRMED | M |  | | | | |
| A26 | CONFIRMED | S |  | | | | |
| W03 | CONFIGURATION_DEPENDENT | L |  | | | | |
| 3-booking-behavior | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 6.6-24h-contact | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.6-legacy-call-stamp | CONFIGURATION_DEPENDENT | S |  | | | | |
| 6.6-prepaid-entitlement | CONFIGURATION_DEPENDENT | S |  | | | | |

## Batch 4 — Capture through delivery (34 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| O08 | ALREADY_FIXED | S | 2c74adc | b1-remainders (b1-remainders §8: no "Luma dispatch" claim in upload/actions.ts or dropboxFolders.ts; Luma's roster entry and tracker link remain) · PGlite | pending | live on deploy | assignees.ts:20 still says the Luma engagement ended (not my file) |
| 9.1-per-output-identity | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 9.2-evidence-stages | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 9.3-provider-events | CONFIGURATION_DEPENDENT | S |  | | | | |
| A40 | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| A41 | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| A42 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 9.6b-program-1080p-output | CONFIRMED | M |  | | | | |
| A43 | CONFIGURATION_DEPENDENT | S |  | | | | |
| 9.8-download-destination | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| A47 | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| caption-grounding | CONFIGURATION_DEPENDENT | S |  | | | | |
| legacy-library-identity-exceptions | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A52 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| O04 | CONFIRMED | M |  | | | | |
| O05 | CONFIRMED | L |  | | | | |
| 7.3-truthful-evidence | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 7.4-product-requirements | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 7.5-per-output-briefs | PARTIALLY_IMPLEMENTED | L |  | | | | |
| 7.6-missing-work-reshoots | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 7.7-external-editor-packet | CONFIGURATION_DEPENDENT | M |  | | | | |
| 7.8-field-feedback | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 6.8-topic-folders | CONFIGURATION_DEPENDENT | S |  | | | | |
| 6.8-filming-report-and-extras | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.8-carryover | CONFIGURATION_DEPENDENT | S |  | | | | |
| 6.8-brief-destinations | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 6.8-routing-and-actionable | CONFIGURATION_DEPENDENT | S |  | | | | |
| 6.8-per-session-clocks | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| A28 | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A29 | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| A30 | CONFIRMED | S |  | | | | |
| A31 | CONFIRMED | S |  | | | | |
| A32 | CONFIRMED | S | e954b23 + 2c74adc | b1-readiness-topaz (The same A1–A10 checks count timeline markers, Notification rows (unique dedupeKey) and ops-Slack posts held at fetch.) · PGlite · remainder: b1-remainders (b1-remainders §4 (queue, card and board carry the same sentence)) · PGlite | f2555f7 (Vercel 783ja2fmz) | live on deploy (staff only) | closed in 2c74adc |
| A33 | CONFIGURATION_DEPENDENT | S |  | | | | |

## Batch 5 — Operational visibility (23 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| O06 / AU-07 email reply-SLA scope | CONFIRMED | M |  | | | | |
| 9-canned-ack-closes-reply (A51, F3/F4) | CONFIRMED | S |  | | | | |
| 9-mailbox-health (hello@ vs info@) | CONFIGURATION_DEPENDENT | S |  | | | | |
| 9-digest-reports-sent-on-failure (A51 notification truth) | CONFIRMED | S |  | | | | |
| 9-oncall-urgent-page-held-overnight (A51 coverage) | CONFIRMED | S |  | | | | |
| 9-inert-alert-switches (§11 effective controls) | CONFIRMED | S |  | | | | |
| 9-single-owned-item (queues/ownership, AU-02/03 overlap noted) | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 9-related-comms-context (portal/email/text linked to client/project/month) | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 9-exception-digest | PARTIALLY_IMPLEMENTED | S |  | | | | |
| AU-24 / F5 promise-backed at-risk update drafts | PARTIALLY_IMPLEMENTED | M |  | | | | |
| AU-05 existing confirmation/welcome/after-hours/delivery texts | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| A50 / AU-08 monthly program reminders | PARTIALLY_IMPLEMENTED | S |  | | | | |
| AU-01 / H1 / B1 order-scope reconciliation (§10) | PARTIALLY_IMPLEMENTED | M |  | | | | |
| §10 priority/rush + AU-24 rush impact (B4, G1, A3) | PARTIALLY_IMPLEMENTED | M |  | | | | |
| §10 capacity and training (G2, G3, A4) | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A53 / AU-21 / J2 / C4 AutoHDR batch register | CONFIRMED | L |  | | | | |
| AU-19 AutoHDR photo editing (existing path) | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| AU-20 / J1 AutoHDR balance monitor | CONFIRMED | M |  | | | | |
| AU-25 / I2 / I3 money and identity exceptions | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A54 no automatic refunds/merges/charges/top-ups; actuals vs estimates | PARTIALLY_IMPLEMENTED | S |  | | | | |
| AU-26 / I4 rework cost, coaching, escalation digest | CONFIRMED | L |  | | | | |
| §10 assets/special corrections (J3) | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A51 acceptance — unanswered/replies/notification failures/coverage | PARTIALLY_IMPLEMENTED | M |  | | | | |

## Batch 6 — UI and release proof (12 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| R04-harness | CONFIRMED | M |  | | | | |
| R04-duplicate-jobs-bookings | CONFIRMED | L |  | | | | |
| R04-revision-vs-expiry | PARTIALLY_IMPLEMENTED | M |  | | | | |
| R04-lease-loss-external-writes | PARTIALLY_IMPLEMENTED | M |  | | | | |
| R04-extra-round-fee | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A01 | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A01-cron-health | CONFIRMED | S |  | | | | |
| A02-backup-coverage | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A02-restore-rehearsal | CONFIRMED | M |  | | | | |
| A02-restore-guard | CONFIRMED | S |  | | | | |
| A56-readiness | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 11-settings-grouping | CONFIRMED | M |  | | | | |

## Batch 0 — verify and prepare

- Verification: 9 read-only clusters, 163 items (Sep 25).
- Inventory: probe run; backup 127/127 models; schema for batches 1–4 pushed (`2528374`).
