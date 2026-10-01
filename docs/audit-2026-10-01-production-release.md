# Oct 1 production release — Ops Hub audit candidate

## Authorization and current state

Jordan explicitly requested: “And deploy whats been done to production.”
This authorizes the reviewed deployment and required additive schema release.
Client sends/invitations, real bookings, financial changes, live mutation tests,
automation activation and unrelated data repairs remain outside authorization.

Candidate: `3c3c2d741aaf7a30d6c5fe1314fbb6611348e0e3` on
`codex/audit-2026-09-30`. The checkout was clean. A fresh fetch of `main` showed
zero remote commits missing locally, with this candidate 161 commits ahead.
No Git push or merge into `main` was required or performed.

**Released:** the remote compile, TypeScript and production build succeeded.
The staged build reported `3c3c2d741aaf` before promotion, and both login routes
passed authenticated Vercel availability/header checks. Promotion succeeded;
the canonical domain now reports the same exact candidate.
The build checkout contains no production environment files. Only the existing
Vercel project metadata was copied. The intentionally running fenced local
preview remains on port3200; no competing build uses its `.next`.

## Verified previous deployment and target

- Canonical host: `https://hub.realtourpilot.com`.
- Project: `realtour-pilot-hub`, `prj_tC9t7sZB4QsDoStiWjEuABUWkN82`.
- Team: `team_mHuw13legZgwAo5GNXOT4n8e`.
- Previous production: `dpl_8Je8ULY9Pf6sy3asVwjtrCKvTXzj`, Ready,
  `https://realtour-pilot-iqe17q220-realtour-pilot-s-projects.vercel.app`.
- Read-only authenticated `/api/cron/version` confirmed `bf2e0b48a0dd`.
- Existing Vercel Node runtime is24.x; local implementation checks use the
  required Node20.20.2. No runtime setting was changed.
- Vercel protected production values were unavailable for read-back. The
  attempted private environment pull was discarded without setting/replacing
  any variables. The existing local CRON credential authenticated the live
  build probe; AGENTS identifies local DATABASE_URL as the shared production DB.
  Remote builds use the existing managed production environment.

## Backup and additive schema

The fresh production connection proved read-only enforcement with SQLSTATE25006.
It found144 existing mapped tables, no unmapped tables and no Prisma migration
ledger. The schema diff contained only the five expected additions.

Backup: `/Users/jordanspackman/rtp-backup-2026-10-01-predeploy.json`.

- Snapshot: `2026-10-01T13:44:46.972Z`, repeatable-read.
- Coverage:144/144 existing models,118,636rows,211,904,272bytes, mode0600.
- The export used the current client's144 models proven present by live-table
  inventory; the five absent candidate models were explicitly recorded.
  Nothing existing was silently skipped. Existing schema fields had no diff.
- Full-file stream parse verified every model count, primary-key hash, production
  schema coverage and complete file ending. This is file integrity evidence,
  not a fresh restore rehearsal. Earlier exporter/restore drills remain recorded.
- SHA256: `52ab7390a31cf5eb3762959dcef16df0baef001590e968b575a31f06642fa691`.
- Matching production schema and integrity receipt are beside the backup as
  `.schema.prisma` and `.verification.json`, both0600. No backup data is in Git.

Applied at `2026-10-01T13:54:34.540Z` in one bounded DDL transaction:
`FinalRenditionCheck`, `DeliveryFollowUpHealth`, `ClientBrandReceipt`,
`ShootBriefRead`, `EditorBriefReceipt`. The transaction used5s lock/60s statement
timeouts and an advisory release lock. The immediately refreshed read-only
diff had to match the reviewed SQL hash before any write.

SQL is preserved in `prisma/rollouts/2026-10-01-audit-additions.sql`;
SHA256 `5f5c0146cf8eb749f09498c3e403356190eba9200e40cdb368a7b254b635132d`.
There were14 statements: five CREATE TABLE, seven CREATE INDEX, two added FKs.
No existing rows were updated, no backfill ran, no migration ledger was invented,
and no reset/seed ran. This follows the project's existing additive schema model.

Postflight `2026-10-01T13:56:05.358Z`:149tables,12new indexes including the five
PKs, two validated foreign keys, all five tables empty, live schema diff exit0.

## Existing verification and acceptance limits

Application source/schema/config is unchanged from the previously successful
`2b87cc2` build. Non-incremental types, changed-file lint, separate clean build
and focused behavioral fixtures are recorded in the Sep30 checklist/handoff.
Later `953e680` adds the mixed photo/video fixture25/0; final types passed.
The release does not repeat those green suites.

C01–C18 have named implementation or inherited-fix verification; normal browser
acceptance is separate. C19 needs the approved general-welcome destination.
C14 source/filter work is finished; normal-role identity, mounted normal/test
scope, filtered-empty/read-failure and return navigation remain open.
W01–W06 remain partly accepted. U0–U5 are partial and U6 is unaccepted.

Actual phone uploads/downloads, normal client/editor/photographer journeys,
real rendition/watch/provider evidence, Kyle/James work-finding observations and
broader rendered UI comparison remain open. Browser tooling was policy-rejected
earlier; no alternative browser transport was used. HTTP/deployment smoke does
not replace browser acceptance. No platform/onboarding completion claim is made.

## Preservation and recovery

Before release: one stored automation row was off, missing automation switches
retain their existing off defaults, rollout was defaultTEST_ONLY. Private hashes
of798saved settings and automation configuration were recorded, along with total
activeClientUser2/unrevokedMembership3 counts. These totals include any synthetic
fixtures and are not evidence of two active real-client seats. Compare afterward.

For application rollback use the verified previous deployment above. **Retain
the additive tables and any receipts**; do not drop tables or restore the older
row backup over live writes. Reconcile unknown/in-flight operations before retry.
The row backup and prior restore evidence supplement the documented Neon recovery
path; no fresh Neon PITR coverage check was obtained in this release.

## Final release evidence

- Deployment: `dpl_FaUomN98Qz8EDuFnUopYgtnt55HS`, Ready, production.
- Artifact: `https://realtour-pilot-r6ajwlsup-realtour-pilot-s-projects.vercel.app`.
- Remote compilation passed61s, TypeScript76s, build output completed2m.
  Existing nonfatal warnings: deprecated middleware convention and Vercel's
  ignored `memory` property under Active CPU billing. No config was changed.
- Staged read-only version confirmed at `2026-10-01T14:04:52.571Z`, while the
  canonical host still served the old build. Direct staged HTTP requests met
  Vercel SSO302; this was deployment protection, not application failure. The
  supported authenticated Vercel CLI read the version and checked both login
  routes without disabling protection or using browser automation.
- Promotion command succeeded. Canonical GET `/api/cron/version` confirmed
  `3c3c2d741aaf` during post-release checks beginning14:09UTC.
- Office/client login routes returned200 with security headers. Six sampled
  CSS/JS assets returned200. Anonymous Home/Editing/Review/Tasks redirected to
  sign-in. The old alias redirected307 to the canonical login URL.
- Anonymous `/portal/me` uses Next's streamed sign-in redirect: HTTP200 includes
  `1;url=/portal/login` and the redirect digest, verified14:12:33UTC. The first
  status-only smoke assumption failed; the narrow marker check resolved it.
  No application source changed, and no browser navigation acceptance is claimed.
- Automation configuration, test-only rollout and raw client-seat counts matched
  the pre-release snapshot. Saved preference values were unchanged. Only
  `content-video-sweep-cursor` and `deliverable_outputs_sweep` advanced; both
  already existed in the old release and are scheduled sweep state, not policy.
  No cron endpoint, webhook, mutation action, login/invite form or provider send
  was manually invoked.
- Sanitized machine-readable evidence:
  `docs/release-evidence/2026-10-01-production-release.json`.

Implemented and previously tested source is committed and deployed. The five
tables are applied and verified. Code/UI is available under existing permissions
and gates; the public login surfaces were checked. **No automation or real-client
rollout was enabled.** Normal client visibility, complete journeys and U-phase
acceptance remain unverified. This release does not establish onboarding readiness.

## Decisions received after this release

Jordan specified portal delivery with backup in the final Dropbox folder for
monthly content, explicit no-brand acknowledgment and fresh receipts when an
editor is reassigned back. The approved general welcome strategy-call link is
https://calendly.com/realtourpilot-info/strategy-call. These unblock the next
focused implementation batch. They are not claimed implemented in3c3c2d7;
preserve ordinary property Aryeo delivery, historical receipts, manual Start/Pause
and the dedicated monthly Calendly classification. No messages/replay/activation.

Root owns schema/deployment/Git operations. Private operation logs and receipts
are in `/private/tmp/ops-hub-release-2026-10-01`, mode0600/0700. They contain no
authorization for future sends or activation. No build, migration or deployment
remains running. The intentional isolated demo remains running.
