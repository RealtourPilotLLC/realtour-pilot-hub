# Unified implementation checklist

Source: `~/Downloads/Realtour-Pilot-Unified-Claude-Implementation-Handoff-2026-09-25.md` (§13 batches).
Progress record: [`docs/handoff.md`](handoff.md). Verified designs: `docs/.unified-verify-batch0.json`.

Each item: **verified status → commit → test evidence / environment → deployed SHA → enabled scope → remaining owner/action**.
Implemented, tested, deployed and enabled are separate fields. A passing total is not a substitute for a missing journey or provider test.

Status key: CONFIRMED (defect/gap real) · PARTIALLY_IMPLEMENTED · ALREADY_FIXED (evidence in the design column of the JSON) · CONFIGURATION_DEPENDENT · NOT_REPRODUCIBLE.

## Batch 1 — Operational correctness (38 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| O09 | CONFIRMED | L | e954b23 | b1-active-editing (§0 (old at 75d56f1: office click logged as "Kim started editing.", three jobs claimed at once) + §2 + §7) · PGlite | pending | live on deploy (staff only) | the task-card dropdown and setTaskAssignee are not delegated (src/app/actions.ts not owned) |
| 7.1-states | PARTIALLY_IMPLEMENTED | M | e954b23 | b1-active-editing (§1, §6, §9 workLabel over lifecycle × {none, active, paused}; queue labels) · PGlite | pending | live on deploy (staff only) | — |
| 7.1-one-active-atomic-switch | CONFIRMED | M | e954b23 | b1-active-editing (§2 switch; §3 a trigger failure after the pause write leaves A ACTIVE with the same activeSince; §4 concurrent tabs, doubled click, P2002) · PGlite | pending | live on deploy (staff only) | real-Postgres interleaving deferred to R04 |
| 7.1-identity-on-behalf | CONFIRMED | S | e954b23 | b1-active-editing (§5: John untouched by Kim; Jordan (OWNER) and Kyle (ADMIN) recorded on behalf with their own names; editor refused on others' work; forEdito…) · PGlite | pending | live on deploy (staff only) | — |
| 7.1-sync-never-starts | PARTIALLY_IMPLEMENTED | M | e954b23 | b1-active-editing (§8: 11 automatic/office paths give 0 new ACTIVE and 0 START/RESUME/CONFIRM; correctedCutWithdrawn now writes SHOT; an override pin reads "no…) · PGlite | pending | live on deploy (staff only) | PARTIAL — setSmartTaskStatus not delegated to startEditing (not owned) |
| 7.1-derived-in-editing-labels | CONFIRMED | M | e954b23 | b1-active-editing (§9: editorQueue, videoStatesFor, EditTracker and workingNow agree; no "In editing" without someone ACTIVE) · PGlite | pending | live on deploy (staff only) | PARTIAL — QualityDials/queries.ts, opsDay pipeline.editing, deliveryBoard, TaskCard chip not changed (not owned) |
| 7.1-editor-controls | CONFIRMED | M | e954b23 | b1-active-editing (drill drives the server actions; WorkStateBar on /edit/[id], EditorDesk on /editing, pill Paused plus requestId) · PGlite | pending | live on deploy (staff only) | no browser walkthrough; the guide text in content.ts is not owned |
| 7.1-working-now | CONFIRMED | M | e954b23 | b1-active-editing (§1, §9 workingNow by editor (active, paused, unconfirmed); backlog heading; lane relabelled) · PGlite | pending | live on deploy (staff only) | — |
| 7.1-refresh-stale | CONFIRMED | S | e954b23 | b1-active-editing (§9 table made unreadable → ok:false with a reason; AutoRefresh 60s is mounted) · PGlite | pending | live on deploy (staff only) | PARTIAL — client-side stale warning not drilled |
| 7.1-logging | PARTIALLY_IMPLEMENTED | S | e954b23 | b1-active-editing (§2: one event and one Activity row per transition; a replay writes zero; close events carry actor and reason) · PGlite | pending | live on deploy (staff only) | — |
| 7.1-close-on-submit-reassign-cancel | CONFIRMED | M | e954b23 | b1-active-editing (§7: SUBMITTED (portal finalize), REASSIGNED (setEditVideoEditor), REMOVED and restore, PROJECT_DELIVERED (board), PROJECT_CANCELLED, PUT_BAC…) · PGlite | pending | live on deploy (staff only) | setTaskAssignee and lib merge close via ghost sweep (hourly or next Start), not immediately |
| 7.1-revision-semantics | CONFIRMED | S | e954b23 | b1-active-editing (§6: status stays REVISION, the revision task is untouched, the row reads Revisions with an "Active — Kim" chip) · PGlite | pending | live on deploy (staff only) | — |
| 7.1-migration | CONFIRMED | S | e954b23 | b1-active-editing (§1: zero rows on read, 3 claims with Activity dates where they exist, confirm gives 1 ACTIVE + 2 PAUSED, status unchanged, payroll identical) · PGlite | pending | live on deploy (staff only) | live count probe not run (forbidden this batch) |
| A58 | PARTIALLY_IMPLEMENTED | S | e954b23 | b1-active-editing (§8) · PGlite | pending | live on deploy (staff only) | PARTIAL — dropdown delegation (not owned) |
| A59 | CONFIRMED | S | e954b23 | b1-active-editing (§2, §3) · PGlite | pending | live on deploy (staff only) | — |
| A60 | CONFIGURATION_DEPENDENT | S | e954b23 | b1-active-editing (§4) · PGlite | pending | live on deploy (staff only) | R04 real-Postgres run |
| A61 | CONFIRMED | S | e954b23 | b1-active-editing (§5) · PGlite | pending | live on deploy (staff only) | — |
| A62 | CONFIRMED | S | e954b23 | b1-active-editing (§2 snapshot of card, revision, project dates and outputs is byte-identical across pause and resume) · PGlite | pending | live on deploy (staff only) | — |
| A63 | CONFIRMED | S | e954b23 | b1-active-editing (§7) · PGlite | pending | live on deploy (staff only) | — |
| A64 | CONFIRMED | S | e954b23 | b1-active-editing (§9) · PGlite | pending | live on deploy (staff only) | PARTIAL — readers in files I don't own |
| A65 | CONFIRMED | S | e954b23 | b1-active-editing (§1) · PGlite | pending | live on deploy (staff only) | live probe |
| O03 | CONFIRMED | M | e954b23 | b1-review-ownership (b1 §0 (old code: only the OWNER+ADMIN broadcast, the non-admin seat refused) + §2 (tm:<james> row, Kyle FYI DM, Jordan oversight) + §3 (Jame…) · PGlite | pending | seats unset until saved | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: save the review_room seats in production (settings action); confirm James's AppUser role (batch-0 probe) |
| 8.1-reviewer-assignment | CONFIRMED | L | e954b23 | b1-review-ownership (b1 §2 (one reviewer, one SUBMITTED event, 3-way race writes one event), §4 (away order James→Kyle→Jordan→office), §5 (take/hand on with comp…) · PGlite | pending | seats unset until saved | PARTIAL — Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: Review Room queue "Mine" filter and reviewer label (reviewRoom.ts, review pages) and videoReviewBoard — outside my file list |
| 8.1-scoped-authority | CONFIGURATION_DEPENDENT | M | e954b23 | b1-review-ownership (b1 §3: Approve/Send back/office note work for a non-admin seat through the real actions under AUTH_ENFORCE; Harrison, Harrison with the crea…) · PGlite | pending | live on deploy (staff only) | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: review pages still gate on OWNER |
| 8.1-notifications-oversight | CONFIRMED | M | e954b23 | b1-review-ownership (b1 §1 (unconfigured = old broadcast), §2 (assignee row + OWNER oversight + FYI, no ADMIN broadcast, repeat adds 0 rows, James bell-only by h…) · PGlite | pending | seats unset until saved | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: the bell-only warning is in the Review Room card rather than TeamNotifications; James's external channel is Jordan's call |
| 8.1-coverage-transfer | CONFIRMED | S | e954b23 | b1-review-ownership (b1 §4 (away moves only PENDING cuts; coming back moves nothing), §6 (Fri-5pm cut offered to Kyle once on Monday at 9½ covered hours, nothing…) · PGlite | pending | auto-move OFF (null) | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: Jordan's answer on coverTransferHours (null/off today) and James's channel |
| O07 | CONFIRMED | L | e954b23 | b1-selfqc-issues (b1-selfqc-issues §C: kpi.ts scoreQuarterRoster and qc.getQcStats identical before and after (with seeded data); §B causes set by a reviewer …) · PGlite | pending | live on deploy (staff only) | — |
| 8.2-self-qc | CONFIRMED | XL | e954b23 | b1-selfqc-issues (§A (a)–(l): 44 checks — refusal, binding, finish/callback race, held on mismatch, button dry run, content_hash, sweep held, drift void, move…) · PGlite | pending | live on deploy (staff only) | PARTIAL — stream-route drift void; Review Room "waiting on check" group and attestation in CutReviewPanel (§8.1 files); checklist editor lives on /quality, not Settings |
| 8.3-revision-issues | PARTIALLY_IMPLEMENTED | XL | e954b23 | b1-selfqc-issues (§B: 28 checks — idempotent note and brief ingestion, portal addendum, addressed on v2 then verified at approval, unticked approval refused, …) · PGlite | pending | live on deploy (staff only) | PARTIAL — verify/not-fixed controls inside the Review Room panel; `revisionActions.reanalyzeBrief` clears ticks before the lock (not my file) |
| 8.4-kpi | CONFIRMED | L | e954b23 | b1-selfqc-issues (§C: pure outcomes, 17h Fri 5pm → Mon 10am, James/Kyle 16h/1h split, 5 of 6 then 6 of 6 after reclassification, duplicate counted once, block…) · PGlite | pending | live on deploy (staff only) | editor card not mounted on /editing (reached via /quality and a link on /edit) |
| A34 | CONFIRMED | XL | e954b23 | b1-selfqc-issues (§A (a)–(l) plus the cp01/cp02/cp02b/cp03/cp12 regression drills green) · PGlite | pending | live on deploy (staff only) | stream-route drift |
| A35 | CONFIGURATION_DEPENDENT | M | e954b23 | b1-review-ownership (b1 §3: one approval completes; Kyle/Jordan intervening is one call plus one COVER event, no co-approval; creativeManager and pay columns unc…) · PGlite | pending | live on deploy (staff only) | Jordan's Sep 25 answer applied: all three rung, James first, Kyle nudged at 9 covered h, rule directly. Seats saved after deploy (see handoff.md). remaining: none beyond the production seat configuration |
| A36 | PARTIALLY_IMPLEMENTED | L | e954b23 | b1-selfqc-issues (§B: addendum, replacement v2, finish retry race, Kim→John reassignment, verification required) · PGlite | pending | live on deploy (staff only) | Review Room panel UI |
| A37 | CONFIRMED | M | e954b23 | b1-selfqc-issues (§B merge counts once; CLASSIFIED events with from→to; §C CLIENT_CHANGE vs EDITOR_ERROR re-scores; nothing classified by the hub) · PGlite | pending | live on deploy (staff only) | — |
| A38 | CONFIRMED | M | e954b23 | b1-selfqc-issues (§C: pending and unclassified excluded from the denominator, n and product shown, reviewer waiting time per queue, blocked time "not recorded…) · PGlite | pending | live on deploy (staff only) | — |
| O02 | CONFIRMED | L | e954b23 | b1-readiness-topaz (Drill sections:) · PGlite | pending | live on deploy (staff only) | — |
| A39 | CONFIRMED | S | e954b23 | b1-readiness-topaz (Drill B1/B3/B4: the approved original stays intact and becomes the file to send under an explicit reviewer decision; no blind re-render or r…) · PGlite | pending | live on deploy (staff only) | — |
| O01 | CONFIRMED | M | e954b23 | b1-readiness-topaz (Drill sections A0–A10: the old code at 75d56f1 says "ready for editing" on a blocked job; the new receipt is truthful and quotes the card's …) · PGlite | pending | live on deploy (staff only) | PARTIAL — Remaining: the editorQueue/SimpleQueue "Waiting on instructions" label (other lane's files), and stale Luma comments in upload/actions.ts and dropboxFolders.ts |

## Batch 2 — Guided content preparation (38 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| 6.1-stripe-price-catalogue | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A03 | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.1-discovery-different-address | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 6.1-calendly-event-types | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.1-account-access-scoping | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.1-setup-brand-assets | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.2-transcript-association | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 6.2-discovery-analysis-into-month | CONFIRMED | M |  | | | | |
| A04 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A08-strategy-reference-format | PARTIALLY_IMPLEMENTED | M |  | | | | |
| A08-strategy-editing-and-release | CONFIRMED | L |  | | | | |
| 6.2-strategy-ready-notice | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 6.2-call-knowledge-proposals | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| A09 | PARTIALLY_IMPLEMENTED | M |  | | | | |
| stripe-webhook-registration-readiness | PARTIALLY_IMPLEMENTED | M |  | | | | |
| R01 | CONFIRMED | L |  | | | | |
| U01 | CONFIRMED | M |  | | | | |
| U02 | CONFIRMED | S |  | | | | |
| 6.3-topic-bank | CONFIGURATION_DEPENDENT | S |  | | | | |
| 6.3-recommendations | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 6.3-staff-bank-controls | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 6.4-route-choice | CONFIRMED | M |  | | | | |
| 6.4-call-route-advance-booking | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 6.4-written-route-gate | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 6.4-schedule-later | CONFIRMED | S |  | | | | |
| 6.4-route-switch | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.4-written-route-call-buffer | CONFIRMED | S |  | | | | |
| 6.5-questions | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 6.5-drafting-durability | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.5-call-topic-capture | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 6.5-script-framework | CONFIGURATION_DEPENDENT | S |  | | | | |
| 6.5-release-controls | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 6.5-approve-share-records | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.5-version-exact-decisions | ALREADY_FIXED | S | ✓ closed at verification | | | | |
| 6.5-approval-reminders-24h | CONFIRMED | M |  | | | | |
| 11-your-month | CONFIRMED | L |  | | | | |
| 11-plain-labels | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 11-precise-progress | CONFIRMED | S |  | | | | |

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
| O08 | ALREADY_FIXED | S | ✓ closed at verification | | | | |
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
| A32 | CONFIRMED | S | e954b23 | b1-readiness-topaz (The same A1–A10 checks count timeline markers, Notification rows (unique dedupeKey) and ops-Slack posts held at fetch.) · PGlite | pending | live on deploy (staff only) | PARTIAL — Remaining: the queue does not yet read "Waiting on instructions", so queue/card/board agreement depends on the editorQueue label |
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
