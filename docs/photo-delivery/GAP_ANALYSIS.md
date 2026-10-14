# Photo Delivery: gap analysis and build map (Oct 13-14 2026)

The plan (`01-PHOTO-DELIVERY-PLAN.md`) was written without the repo. This is what the repo and the live data said, and how the build adapted. AutoHDR API facts: `AUTOHDR_API_PLAN.md`.

## Phase 0 stabilization (plan §0.2)

| Item | Status |
|---|---|
| Unguarded database reset | Fixed earlier: `db:reset` runs `scripts/guard-prod-db.ts`, seeds refuse a hosted database. Remaining risk: calling the Prisma CLI directly bypasses the npm guard. |
| Migration history | By design there is none: additive `prisma db push` after a verified backup (`scripts/backup-content-program.ts`, `scripts/backup-all.ts`). The photo-delivery tables were pushed that way (backup `pre-photo-delivery-20261013-2234`). |
| Failing daily cron | Healthy: `daily`, `daily-clients`, `daily-reconcile` 7/7 in 7 days, 30/30 in 30 days. |
| Unsigned webhooks | Aryeo HMAC (armed), Stripe signature, Slack v0 HMAC, Scripting HMAC; OpenPhone uses a constant-time URL token. No Dropbox receiver exists (none is needed: everything polls). |

## What the live data changed

1. **Edited photos never land in Dropbox.** 0 of 41 tracked AutoHDR batches ever wrote to `04-Final-Photos`. AutoHDR's Dropbox watcher DOES create the shoots (named `<Street> (<Client>)`), and the edits reach the **Aryeo listing** (`<Street> (N of M).jpg`) before Kyle delivers. So QC runs on the listing's images; the Dropbox finals folder is read as a second source.
2. **No second AutoHDR shoot.** The plan's API intake (`from-urls`) would edit and charge every shoot twice. The API is used for the balance, shoot/version reads, and approved fixes on the shoots AutoHDR already made.
3. **Kyle is reached by Slack, not text** (his roster phone is the company line). Jordan's only quiet window is Saturday until 7:30 PM. Alerts go through the hub's existing `notifyStaffSms` / bell.
4. **No queue service.** No Upstash/QStash/Redis. The pipeline is a 5-minute Vercel cron (`/api/cron/photo-delivery`) with compare-and-swap leases and content-hash resumability, the same pattern as the Topaz lane.
5. **Private storage exists** (`REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN`): unreleased photos and fixed results go there, never in the public Blob store.
6. **Hand QC barely happens today** (38 of the last 40 QC cards closed automatically on delivery), and photo-only on-time delivery fell to about 25%. Shadow mode keeps the AI advisory for the first two weeks.

## Spec items mapped to the repo

| Plan | Repo |
|---|---|
| `/Realtour Pilot/Jobs/...` folder tree | Kept the existing `/AutoHDR/{Y}/{Q}/{Month}/{Street} ({Client})/0x-...` convention; the app cannot write to the team root. |
| Upload portal `/upload/[token]` | Kept the login-based `/upload/[id]` debrief; no token portal. |
| QStash / Redis locks | Cron + `PhotoJob.leaseUntil` + optimistic `stageVersion` + unique keys. |
| Resend email | Not used: notifications are the bell, Slack and staff texts. |
| Aryeo tags / notes / tasks | Behind `aryeoTags` (OFF) until Jordan approves Aryeo writes. |
| Stages SCHEDULED / UPLOADING / UPLOADED | Not stored: the job opens at EDITING after the shoot; upload state lives in the existing debrief and `PhotoEditBatch`. |

## File map

- Schema: `PhotoJob`, `PhotoAsset` (source ARYEO / DROPBOX / AUTOHDR), `PhotoVersion`, `PhotoQcRun`, `PhotoQcFinding`, `PhotoFixBatch`, `PhotoFixOperation`, `AutohdrCreditEntry`, `ClientQcProfile`, `PhotoJobEvent` (end of `prisma/schema.prisma`).
- `src/lib/integrations/autohdr.ts`: the AutoHDR client (read-only token for GETs; POSTs never retried).
- `src/lib/photoDelivery/`: `registry.ts` (425 rules), `settings.ts`, `jobState.ts`, `jobs.ts` (sync), `autohdrLink.ts`, `credits.ts`, `catalog.ts`, `fixes.ts` (cart), `fixRunner.ts`, `delivery.ts` (gate, steps, verification), `verifySweep.ts`, `notifyOps.ts`, `qc/` (the QC engine).
- `src/app/api/cron/photo-delivery/route.ts`, `src/app/api/photo-fixes/[versionId]/route.ts`, `src/app/api/photo-delivery/img/...`.
- UI: `src/app/ops/photo-delivery/**`, `src/components/photoDelivery/**`; Connections → AutoHDR card.
- Drills: `oct14-autohdr-credits`, `oct14-autohdr-fix-runner` (against `_fake-autohdr.ts`), `oct14-photo-qc*`, `oct14-photo-delivery-ui`.

## Switches (all owner-editable)

| Switch | Default | Why |
|---|---|---|
| `enabled` (sync + queue) | ON | Reads only; writes hub rows. |
| `qcEnabled` | OFF until deployed and checked | Costs Anthropic money (about $2 a gallery). |
| `qcShadow` | ON | QC advisory for the first two weeks. |
| `fixRunnerEnabled` | OFF | Jordan approves the first live paid test. |
| `autoFixZeroCredit` | OFF | Plan default. |
| `aryeoTags` | OFF | Aryeo writes need Jordan's go-ahead. |
