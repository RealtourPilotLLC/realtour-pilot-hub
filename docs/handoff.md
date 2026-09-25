# Progress record — unified implementation handoff (Sep 25 2026)

> The handoff asked for `handoff.md`. This Mac's filesystem is case-insensitive,
> so a root `handoff.md` would overwrite `HANDOFF.md` (the Aug 19 session's
> record) — which happened once already. This file is that progress record.

Source of truth for scope: `~/Downloads/Realtour-Pilot-Unified-Claude-Implementation-Handoff-2026-09-25.md`.
Durable checklist: [`docs/unified-checklist.md`](unified-checklist.md) (written after batch 0's verification).

## Resume here

- **Current batch:** 0 — verify and prepare.
- **HEAD:** `27ebf88` (clean, = origin/main).
- **Live:** `46e109e` — read from the hourly run's deploy stamp, not assumed.
- **Enabled:** nothing new. Every ProgramAutomation row is absent (OFF).
- **Next action:** read the batch-0 verification results, write the checklist,
  ask Jordan the genuinely open questions (batched), start batch 1.

## Batch 0 — facts measured Sep 25 (read-only probe, `scripts/_recon/cp15-config-probe.ts`)

- Deploy stamp works: last hourly run recorded `46e109e586c0`. HEAD differs by
  one docs-only commit.
- Production schema = HEAD (`prisma migrate diff`: none).
- Backup: `~/rtp-backup-2026-09-25-full-pre-unified.json`, **127/127 models,
  113,290 rows**, taken before any batch-1 schema change.
- Switches: all 22 automation keys have no row → OFF.
- Calendly: BRAND_DISCOVERY and MONTHLY_STRATEGY mappings enabled and VALID;
  the legacy name-matched Drive sweep has stood down.
- Connections present: Aryeo, Stripe, Calendly, Gmail (info@ and hello@),
  Dropbox, OpenPhone, Slack, Anthropic. No speech-to-text provider.
- Cron (48h): sync 1 and reconcile 3 not-ok — all Aryeo timeouts (resumable).
  The evening job writes no CronRun, so its health is unreadable (to fix).
- Webhooks (7d): Script Studio 9 FAILED alongside 13 processed (to look at).
- Outbox (7d): 104 SMS accepted; 0 program emails pending.

## Batches

| Batch | State | Commits | Deployed |
|---|---|---|---|
| 0 Verify and prepare | in progress | — | — |
| 1 Operational correctness | — | | |
| 2 Guided content preparation | — | | |
| 3 Scheduling and integrations | — | | |
| 4 Capture through delivery | — | | |
| 5 Operational visibility | — | | |
| 6 UI and release proof | — | | |

## Decisions needed (asked / answered)

_None asked yet._

## Tests and environment

_Recorded per batch._
