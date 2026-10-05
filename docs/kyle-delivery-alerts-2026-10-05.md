# Kyle delivery alerts — October 5, 2026

## Request and implementation
Notify Kyle in Slack as soon as videos are ready; upload promptly, confirm uploaded, send, then confirm sent. Staff Slack explicitly authorized; no client messages, provider uploads/sends, finance changes, or portal rollout activation.

- The five-minute Topaz cron now checks the verified delivery queue before processing jobs. This also covers approved originals and monthly branding switched to Aryeo. Processing/held/finished-delivery exclusions come from the existing authoritative readyToSend selector.
- Separate stable notification identities for ready-to-upload and uploaded-not-sent, tied to exact source/destination fingerprints. Repeated sweeps use the existing notification bridge's successful-send dedupe and bounded failed-send retry. Alerts stop being candidates when the queue resolves delivery.
- Direct Kyle-only Slack prompt with exact version, download/listing links, queue link, and both explicit confirmation steps. Portal cuts retain portal checks/access gates.
- Retired the duplicate Topaz-completion Slack emitter; legacy task instructions now point to upload/sent confirmations. Existing manual Start/Pause and permissions unchanged.
- Runs every five minutes; new completion during a long Topaz tick is announced on the next sweep. Saved quiet-hours/channel settings remain authoritative.

## Verification and release
- Kyle Smith uniquely matched; Slack ID present; live saved review_ready preferences: Slack enabled, SMS disabled.
- Six pure message/state tests pass; scoped ESLint passes; clean release-source TypeScript passes. Working-tree tsc also picked up pre-existing ignored private import scripts; these are excluded from the release archive, not shipped or erased.
- Existing isolated Slack acceptance drill: 46 passed (mocked provider, no real sends). Its old emitter-location assertion was updated to the new queue source; all delivery/quiet-hour/client-send boundary assertions retained. Remote optimized build pending.
- No schema change. Checkpoint ae98177; release receipt to append.

## Related data work completed
- Imported/reconciled ten supplied strategy PDFs; private detailed receipt: storage/content-strategy-import-2026-10-05/IMPORT-REPORT.md.
- Joe/Joseph merged under Stripe's Joseph account. Retained existing program enrollment/portal token/exact strategy and video history; moved related rows transactionally. Twenty isolated assertions passed before production apply. Private recovery snapshot and receipt: storage/sutow-merge-2026-10-05/.
- October: Joe complete, existing October 13 appointment preserved. Erica/Kristin September call records retained but detached from incorrectly assigned October; other pending statuses and not-required entitlements preserved. No bookings or client sends.

## Remaining broader acceptance
Previously documented physical iPhone playback and client portal rollout holds remain. This notification release does not certify or enable the client portal.
