# Review, delivery and editor simplification — October 2

Baseline: `5596d4e4daaf88a50b41bb60bd26c3eec6976165`, clean `codex/audit-2026-09-30`; identical to audited main. Updated source backlog: Downloads/Realtour-Pilot-Review-and-Delivery-Simplification-2026-10-02.md (read all sections).

## Boundaries

No deployment, real client sends/invitations, provider delivery/upload, automation activation, financial change, bulk repair, or production mutation testing. Local `.env` is production. Use isolated fixtures. Preserve manual Start/Pause, receipts, QC, exact versions, access and rollout gates. Earlier deployment authorization is superseded for this request by the updated backlog.

## Execution / completion

`[ ]` open; `[~]` implemented, verification pending; `[x]` implemented and verified. Commits recorded below. No item implies deployed/enabled/client visible.

### A — Recovery / focused validation

- [x] Full updated backlog read; baseline matches current clean HEAD.
- [x] Existing fixture processes identified; no process terminated or competing operation started.
- [x] Relevant Next server directive documentation read before action changes.
- [x] Named delivery gate, missing upload state and review-window marker findings confirmed in source.

### B — Durable listing handoff

- [ ] R01 exact upload/version/file/listing/actor/time history, correction and idempotent saves.
- [ ] R02 shared Home/task manual send transition without human checklist or notice questionnaire; stale version and partial-save repair preserved.
- [ ] Compact Ready to upload / Uploaded, not sent groups; simple saved/error/reconciliation feedback.
- [ ] R08 finished preview matches download, authorized for listing delivery.
- [ ] R09 same provider ID replacements can be acknowledged without count growth.

### C — Provider settlement / monthly publication

- [x] R07 portal markers excluded from outside-portal sends; real handoff-shaped deadline/reminder/expiry + entitlement regression: 37 passed, 0 failed (isolated PostgreSQL).
- [ ] R05 both Aryeo paths + hourly reconcile require upload/version/listing/file/event occurrence evidence; ambiguity held.
- [ ] R03 automatic technical portal publication, exact backup/library/seat/access, exception retry.
- [ ] R06 release clock starts at publication; eligibility independent of release, idempotent notices under existing gates.
- [ ] R10 failed/skipped/unverified Topaz not normal successful monthly publication; existing authorized overrides/history retained.
- [ ] Read-only legacy backlog/window repair proposal, no live repair.

### D — Review Room

- [ ] R04 stable owed output tabs Video X of Y · V1/Vn, including unsubmitted slots.
- [ ] Remove duplicate delivery boards on index/detail; compact project output status, next action and unavailable read state.
- [ ] QC/comments/revisions/reviewer coverage/history retained.

### E — Editing Room / Brief

- [ ] E03–E05 factual identity, confirmed scoped preferences; no AI/general note commands; exact project/month source scope.
- [ ] E01 compact office/editor queue, Working now, filters/back navigation and role constraints.
- [ ] E02/E06 one selected video workspace with all owed outputs reachable, unfinished default, upload target locked while running.
- [ ] E07 one current linked issue action list per output; verified legacy flags/history, reopen/unmapped cases.
- [ ] E08 reviewer classification correction including verified issues; conversation retained, nondefects excluded from work/KPI.
- [ ] Manual Start/Pause, scoped brand choices/alerts, meaningful receipt changes, approved replacement QC/history preserved.

### F — Acceptance

- [ ] Delivery checks 1–22 in updated backlog, isolated behavioral evidence.
- [ ] Editor checks 1–16, actual office/editor fixtures.
- [ ] Update obsolete drills without deleting access/state safeguards.
- [ ] Typecheck/lint/build required gates; focused review per batch.
- [ ] Native desktop/mobile simple, 16-output mixed-state and reopened revision visual evidence.

## Checkpoints / handoff

- Baseline already recoverable at `5596d4e` (remote main matches). No production changes made for this request.
- R07 checkpoint: reviewWindows marker reader fix + integrated monthly portal regression; typecheck passed. Evidence `/private/tmp/rtp-simplification-drills/monthly-portal-approval-gate.ts_postgres.log`.
- Current batch B: durable upload ledger + guarded Home/task send + compact UI implemented, behavioral verification pending. No live schema/data/provider change.
