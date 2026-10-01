# Oct 1 policy release — verified production checkpoint

## Release

Jordan authorized deployment and confirmed these business decisions:

- General welcome strategy calls use
  https://calendly.com/realtourpilot-info/strategy-call. Monthly Content Program
  booking retains its dedicated link and classifier.
- Monthly finals go to the portal with the exact backup in the final Dropbox
  folder. Listing/property Aryeo delivery remains unchanged.
- Intentional no-brand requires acknowledgment. Returning to an earlier editor
  after reassignment requires a fresh receipt; manual Start/Pause remains separate.

Exact application commit: `e6eac69f1d41f4697a9cb64c8011644be458a3ea`.
Vercel deployment: `dpl_7UpNA2AXJsCdiGEAeopg7iUHkbMv`, Ready.
Production: https://hub.realtourpilot.com.
Promoted at `2026-10-01T15:47:55.715Z` (11:47 AM EDT).
Authenticated production version confirmed `e6eac69f1d41` after promotion.
No Git push or main merge occurred.

## Implemented and targeted-tested

| Batch | Commit | Evidence |
|---|---|---|
| General welcome URL | `7220dca` | Actual fenced resolver/sweep/template/monthly classifier26/0; saved custom settings and dedupe preserved. Guarded live read found no auto_texts row, so no setting write/replay was required. |
| No-brand and returning editor receipts | `0334622` | Signed isolated PostgreSQL44/0, affected W02 15/0 and A28 61/0; assignment generation committed with owner changes, exact current receipt, queue-add and skew race verified. |
| Portal and exact final Dropbox backup | `148440a`, `974327f` | Backend40/0 before marker repair; fake actual UI19/0; affected listing34/0 and mixed photo/video25/0. Current version/access/staff check, backup hashes, canonical preview, unknown receipts and history CAS verified. |
| Preserved client approval gate | `e6eac69` | Marker backend 41/0 and signed stream/download/caption PostgreSQL21/0. Portal handoff and marker commit atomically; no download/caption before exact client approval. Prior-approved v1, finishing holds, old external sends/pre-gate/listing rules and failed-read holds verified. |

Non-incremental TypeScript0, four-file ESLint0, diff check and one focused
root/peer repair review passed. The separate clean Node20 build passed at the
exact application commit with a dead loopback DB and no provider credentials.
The active main-checkout preview was untouched. Remote Vercel compile, types,
build and protected version/login checks passed before promotion. Existing
Vercel Node24 configuration and deployment protection remain unchanged.

Candidate `974327f` also built/staged, but was deliberately held when the old
outside-delivery entitlement was found to interpret portal availability as
client approval. It was never promoted to canonical. Its stage is superseded;
never promote it. Replacement `e6eac69` contains the verified repair.

## Production checks and unchanged boundaries

- Exact version and both login pages200; nosniff/SAMEORIGIN retained.
- Six sampled static assets200.
- Anonymous Home, Editing, Review and Tasks redirect to login.
- Anonymous portal uses the verified streamed sign-in redirect.
- New office-only final preview refuses anonymous requests403.
- Old host redirects307 to the canonical host.
- Proven read-only connection25006: automation hash unchanged, stored automation
  inventory1/off, rollout defaultTEST_ONLY, setting hashes unchanged, raw active
  ClientUser2/unrevoked membership3 unchanged. Raw counts are not real-seat proof.

No client message/invitation, approval verdict, real booking, financial change,
automation activation, rollout expansion, production mutation test or record
backfill was performed. This release adds no schema; the earlier five-table
schema/backup evidence remains in `audit-2026-10-01-production-release.md`.

## Rollback and evidence

Previous verified canonical deployment:
`dpl_FaUomN98Qz8EDuFnUopYgtnt55HS`,
https://realtour-pilot-r6ajwlsup-realtour-pilot-s-projects.vercel.app,
build `3c3c2d741aaf`. It was freshly confirmed before promotion. A code rollback
must retain additive tables, receipts, marker rows and newer business writes;
never restore the older backup over current data or replay ambiguous delivery.

Sanitized evidence: `release-evidence/2026-10-01-policy-release.json`.
Private exact build/stage/promotion/HTTP/read-only state receipts:
`/private/tmp/ops-hub-policy-release-e6eac69-2026-10-01` (0700, receipt/log files0600).
Held-stage receipts remain separately at
`/private/tmp/ops-hub-policy-release-2026-10-01`.
Fixture logs: `/tmp/monthly-portal-handoff-marker/`,
`/tmp/monthly-portal-approval-gate/`, `/tmp/w02-assignment-policy-clock/`,
`/tmp/monthly-final-check-ui-identity/`, `/tmp/ops-hub-policy-listing-regression/`.
Combined gate logs: `/tmp/ops-hub-portal-handoff-types.log` and
`/tmp/ops-hub-portal-handoff-lint.log`.

## Acceptance still open

Implemented, targeted-tested, committed and deployed does not mean the complete
journey is accepted. Existing gates remain; no new automation is enabled. Staff
code and approved defaults are live under existing permissions; real-client
visibility/onboarding remains unaccepted.

Next steps are the existing UA01–UA14 normal-role/browser/phone/provider/media
checks, U6 rendered comparison, Jordan's initial client roster, Kyle's exact
C13/C18/Sarina source/identity reconciliation, and strategy/topic-bank/access
preparation before invitations. U0–U5 are partial, U6 open. Browser tool policy
refused access; do not bypass it with another transport. Generated-workflow date
overrides and W05 manual-versus-automatic unknown-text settlement need business
decisions; existing conservative holds/clocks remain. See the checklist and
resume page for owners. The platform is not declared finished or ready to
onboard real content clients.
