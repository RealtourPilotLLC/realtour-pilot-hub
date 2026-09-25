# Unified implementation checklist

Source: `~/Downloads/Realtour-Pilot-Unified-Claude-Implementation-Handoff-2026-09-25.md` (§13 batches).
Progress record: [`docs/handoff.md`](handoff.md). Verified designs: `docs/.unified-verify-batch0.json`.

Each item: **verified status → commit → test evidence / environment → deployed SHA → enabled scope → remaining owner/action**.
Implemented, tested, deployed and enabled are separate fields. A passing total is not a substitute for a missing journey or provider test.

Status key: CONFIRMED (defect/gap real) · PARTIALLY_IMPLEMENTED · ALREADY_FIXED (evidence in the design column of the JSON) · CONFIGURATION_DEPENDENT · NOT_REPRODUCIBLE.

## Batch 1 — Operational correctness (38 items)

| Item | Verified | Size | Commit | Tests | Deployed | Enabled | Owner / next |
|---|---|---|---|---|---|---|---|
| O09 | CONFIRMED | L |  | | | | |
| 7.1-states | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 7.1-one-active-atomic-switch | CONFIRMED | M |  | | | | |
| 7.1-identity-on-behalf | CONFIRMED | S |  | | | | |
| 7.1-sync-never-starts | PARTIALLY_IMPLEMENTED | M |  | | | | |
| 7.1-derived-in-editing-labels | CONFIRMED | M |  | | | | |
| 7.1-editor-controls | CONFIRMED | M |  | | | | |
| 7.1-working-now | CONFIRMED | M |  | | | | |
| 7.1-refresh-stale | CONFIRMED | S |  | | | | |
| 7.1-logging | PARTIALLY_IMPLEMENTED | S |  | | | | |
| 7.1-close-on-submit-reassign-cancel | CONFIRMED | M |  | | | | |
| 7.1-revision-semantics | CONFIRMED | S |  | | | | |
| 7.1-migration | CONFIRMED | S |  | | | | |
| A58 | PARTIALLY_IMPLEMENTED | S |  | | | | |
| A59 | CONFIRMED | S |  | | | | |
| A60 | CONFIGURATION_DEPENDENT | S |  | | | | |
| A61 | CONFIRMED | S |  | | | | |
| A62 | CONFIRMED | S |  | | | | |
| A63 | CONFIRMED | S |  | | | | |
| A64 | CONFIRMED | S |  | | | | |
| A65 | CONFIRMED | S |  | | | | |
| O03 | CONFIRMED | M |  | | | | |
| 8.1-reviewer-assignment | CONFIRMED | L |  | | | | |
| 8.1-scoped-authority | CONFIGURATION_DEPENDENT | M |  | | | | |
| 8.1-notifications-oversight | CONFIRMED | M |  | | | | |
| 8.1-coverage-transfer | CONFIRMED | S |  | | | | |
| O07 | CONFIRMED | L |  | | | | |
| 8.2-self-qc | CONFIRMED | XL |  | | | | |
| 8.3-revision-issues | PARTIALLY_IMPLEMENTED | XL |  | | | | |
| 8.4-kpi | CONFIRMED | L |  | | | | |
| A34 | CONFIRMED | XL |  | | | | |
| A35 | CONFIGURATION_DEPENDENT | M |  | | | | |
| A36 | PARTIALLY_IMPLEMENTED | L |  | | | | |
| A37 | CONFIRMED | M |  | | | | |
| A38 | CONFIRMED | M |  | | | | |
| O02 | CONFIRMED | L |  | | | | |
| A39 | CONFIRMED | S |  | | | | |
| O01 | CONFIRMED | M |  | | | | |

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
| A32 | CONFIRMED | S |  | | | | |
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
