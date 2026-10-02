# October 2 review/delivery production release

Status: production READY; authenticated read-only Editing Room smoke passed. Application source a3133a5 is live. Release documentation committed with the GitHub main fast-forward; verify the remote commit receipt before claiming pushed.

## Authorization and committed source

User explicitly requested production deployment and Git commit after the compact rows and floating-menu fixes. This supersedes the updated backlog's deployment hold for this release. Client sends, invitations, real provider uploads/bookings, activation of client automation, financial changes and bulk repairs remain excluded.

Application source: `a3133a540c95de021513500d5582c5db696c773a`, `codex/audit-2026-09-30`. Includes local checkpoints b3f856c, a60424b, 01a460f, 9787ccf, a3133a5. Clean committed source archive uploaded; no local environment files, database exports, private fixture credentials or uncommitted source included. Git main was 5596d4e, fast-forward compatible.

## Backup and schema

- Read-only production connection proven before export; one repeatable-read snapshot at 2026-10-02T20:46:22.287Z.
- 149/149 existing models, 120403 rows, 212832016 bytes; no unmapped tables or columns.
- Backup SHA256 `4696d68f753cc9098f145fcc0c92167ca58e4af32a755888692889c8caa61e10`; all counts and primary-key hashes verified through full-file parse. Mode0600 in protected directory `/private/tmp/rtp-release-2026-10-02`; not committed. Existing restore/export drill evidence remains applicable; no fresh full restore rehearsal claimed.
- Only absent candidate field was ReviewSubmission.portalPublicationRequiredAt. No migration ledger exists, consistent with prior db-push release history.
- Applied reviewed `prisma/rollouts/2026-10-02-portal-publication.sql` at 2026-10-02T20:49:00.078Z in transaction with5s lock/60s statement timeout and advisory release lock. Verified nullable TIMESTAMP(3). No backfill/seed/reset/record/settings edits.
- First attempt rolled back before adding column (advisory lock returned unsupported void); read-only absence check preceded corrected text-cast retry.

## Verification and rollback

Focused tests, scoped lint/typecheck and isolated build documented in completion checklist. Remote production build validates actual deployed package and font path. Existing Vercel Node24.x setting retained; local commands used Node20 as repository instructions require.

Previous production deployment: `dpl_7127RKyLEwrSAdH27hjy1JRXXdU8`, https://realtour-pilot-794493oqa-realtour-pilot-s-projects.vercel.app. Roll back application alias if needed; retain the additive nullable column and all business writes. Never restore this whole snapshot over later live records.

Production deployment: `dpl_8GwGG1X8Tim5nqo2t5ENUWf7DSMu`, https://realtour-pilot-ec00bq414-realtour-pilot-s-projects.vercel.app, READY and aliased to https://hub.realtourpilot.com. Remote optimized production build passed. Authenticated owner browser smoke on the live Editing Room passed: real queue loads, compact aligned rows and Raw/Final links visible; opening the 288px floating menu leaves the first row height unchanged (70.78125px before/after), office actions present, Escape closes it. Screenshot retained outside Git at `/private/tmp/rtp-release-2026-10-02/production-menu.jpg`. No live project action or send was submitted.

Automatic approval review rejected downloading all production environment secrets; that command was not run. Release uses existing project linkage and production connection, without that download.

Remaining acceptance: supported real-browser choose-file/QC/upload journey and authentic provider event/file-hash handoff; music policy for premium horizontal cinematic remains unanswered. No real client/provider mutation tests or bulk legacy repair performed.

## Status distinctions

- Implemented and committed: application checkpoints through a3133a5.
- Tested: focused isolated behavioral tests and local browser proofs listed in the checklist; remote production build and authenticated read-only queue/menu smoke passed.
- Deployed/client-visible: these application changes are now live on the production alias.
- Enabled: existing rollout settings and permissions retained; no additional client automation or client access enabled.
- Still unverified: complete supported-browser choose-file/QC/upload journey and genuine provider handoff. Deployment does not close those acceptance items.
- Git: fast-forward application plus documentation commits to RealtourPilotLLC/realtour-pilot-hub main; application SHA is a3133a540c95de021513500d5582c5db696c773a, later documentation-only SHA does not change deployed source.

## Two-stage delivery / Editing Room release candidate

Committed application `e0b5a5aae826b4f44ad8de5ff1106c32df2cc0c7`, branch `codex/audit-2026-09-30`. Listing Ready for upload → Uploaded, not sent → removed on verified send, minimal unsent rows, accessible confirm, direct saved-send receipt, exact-source replacement guards, saved/suggested assignment separation, responsive queue and mobile brief interior-grid correction. Typecheck/scoped lint, delivery UI/API60, queue17, earlier desk140 pass. Native disposable upload confirmation/cancel/move/manual-send/remove/reload and responsive dark/light queue/brief checks pass. No live client mutation, provider upload/send, settings, financial or schema change. Existing rollout gates retained.

Clean source archive in `/private/tmp/rtp-two-stage-release/source`, production deploy log `deploy-corrected.log`. First source preparation failed due local Python tar API incompatibility; the following CLI attempt uploaded zero files to a newly created separate project `source` and failed; Hub production alias unchanged. Source archive preparation corrected and existing Hub project linkage verified before retry. Empty project ID `prj_cGT2C2BwMZTEIk3JzwJE3L7AEuI0`, created17:47EDT. Automatic approval review blocked its deletion because an external project deletion needs explicit approval; user question pending, no bypass. Production Hub project ID `prj_tC9t7sZB4QsDoStiWjEuABUWkN82` unaffected by that failure.

Release build/READY/alias/main receipt to be appended after confirmed success. Remaining choose-file/QC and authentic provider-event acceptance stay open; this release does not certify those journeys.

Release confirmed: application `e0b5a5aae826b4f44ad8de5ff1106c32df2cc0c7` is production READY as `dpl_YGQgmAosoXfh8aSVQi7GRh2v9gvj`, https://realtour-pilot-j5ge46yr8-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com. Remote optimized build/typecheck/page generation passed. No schema/settings/live record mutation/client-send action. Previous rollback target remains `dpl_FvYP24cZAaKWnS7J4rtLcJpGRX5i` (retain all business writes/schema). Production read-only browser smoke underway; main fast-forward receipt follows.

Final receipt: GitHub `RealtourPilotLLC/realtour-pilot-hub` main read back as `c589dd506c080920ee0d9c11c5bb6fcf376cdb39`, containing application e0b5a5a and release documentation; local worktree clean before this final receipt. Live supported-browser navigation to Editing Room timed out, then supported focus inspection also timed out; no fresh live visual/click acceptance claimed and no live action submitted. Vercel READY/production alias and remote build are confirmed; isolated native acceptance remains the evidence for current interactive fixes. Empty temporary `source` project cleanup remains blocked by automatic approval review pending the explicit user response. Other retained local fixtures unchanged; current owned3225 fixture expires through its3600s serve runner. No stalled build/test/push; no repeated failing tests.
