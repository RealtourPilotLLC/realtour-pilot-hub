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

Evening recovery release confirmed: source `92366971d3df13a0930d604845be570a250456ea` deployed READY as `dpl_AAP5qnMVEEHR7BXAoDL16X24uTdv`, https://realtour-pilot-66cbglwks-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com. Remote build/typecheck passed. Existing rollout gates/schema/settings preserved. Direct supported-browser navigation to raw JSON receipt API returned net::ERR_BLOCKED_BY_CLIENT; this does not establish whether ordinary in-page fetch is blocked. No alternative access mechanism used for that navigation. Existing authenticated owner Hub tab read normally; its only text input was empty and saved error idle. Normal page reload loaded new release and current database receipt: Ready for upload9→8, Uploaded/not sent2→3, exact Matlack Video2/v2 present in minimal unsent row, save error gone. No live mutation or client/provider send used in verification. Screenshot `/private/tmp/rtp-upload-recovery-production-proof.jpg`. Lost-response automatic recovery verified by actual helper/fenced network and PostgreSQL drills, not a newly forced live timeout. Git main release receipt follows. Previous rollback app deployment `dpl_YGQgmAosoXfh8aSVQi7GRh2v9gvj` retains all saved business data; never undo the original upload receipt. Browser-choice clarification optional/pending; broader actual choose-file/QC/provider-handoff acceptance remains open.

## Owner status controls / Newburg assignment release

Application source `02c0c643386532ab4c61e89b6f298175e6659300` deployed production READY as `dpl_8AnRxmSY5vhE8dGKeWhWJNeRXNb9`, https://realtour-pilot-80rl8vy0i-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com. Remote optimized build, TypeScript and page generation passed (build approximately two minutes). Private archive/logs `/private/tmp/rtp-office-status-release`; no env files or private assets in the archive/commit. No migration or rollout-gate change.

Read-only supported-browser smoke at 7:57PM ET: Newburg still shows its saved Kim assignment; its primary status menu exposes all six stages enabled, including Waiting and Completed. Portalled menu remains compact, fully within viewport, and does not stretch the job row. Pause is correctly a separate real-work action and is unavailable when nobody started. No production status/assignment/upload/send was submitted; actual save/readback, attribution, view-as guards, cut preservation and manual Start/Pause were tested on isolated fixtures (41 new Postgres +140 existing desk checks). Typecheck/scoped lint pass. Screenshot `/private/tmp/rtp-office-status-production-proof.png`. GitHub main fast-forward receipt follows in final response.

Rollback target is previous production deployment `dpl_AAP5qnMVEEHR7BXAoDL16X24uTdv` (upload save recovery); retain every saved business record. Broader native choose-file/QC and authentic provider delivery acceptance remain as recorded in the completion checklist; this release does not claim that full platform acceptance is finished.

### Release confirmed — October 3, receipt/group/approval fixes

- Application commit: `198376115f3e7de83a1bd0f01361ddbd03a2b246` on `codex/audit-2026-09-30`.
- Production deployment: `dpl_2bXcBFQSiHA4xZJ7YfCc61UUJtG3`, READY; https://realtour-pilot-h5lktc7v2-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com.
- Remote optimized compilation, TypeScript and page generation passed (build2m). Local typecheck/scoped lint and172 focused checks pass. One focused source review completed; browser nonce failure is inside the bounded request/error path.
- Authenticated owner read-only live smoke: new release loads, delivery section has only2 portal-attention items; uploaded-not-sent listing section and old reconciliation controls absent. Separate creative review/revision work remains. No horizontal overflow at1280px. Screenshot `/private/tmp/rtp-grouped-release-production-proof.png`. No live Mark Uploaded/Mark Sent/Approve mutation submitted for acceptance. Actual click workflows verified against disposable owned loopback fixture, including approval with3 missing ticks and grouped2-video send. Client-specific failing transport/browser cause remains unproven; exact prior production saves are confirmed and preserved.
- Implemented/tested/committed/deployed: upload confirmation, grouped manual delivery, signed later-event reconciliation, stale delivery-repair protection, missing-tick approval warning/audit. Enabled/client-visible: existing office/reviewer controls on production; existing role/automation/rollout gates retained, no new activation.
- No schema, production business-record test mutation, client/provider send, invitation, automation enablement or financial action. Existing verified backup retained; no migration/backup refresh required. Source archive excludes `.env`, private assets/exports, docs/tests; correct pre-linked Hub project retained.
- Rollback source deployment: `dpl_8AnRxmSY5vhE8dGKeWhWJNeRXNb9` (previous app02c0c64). Roll back application only, preserve all new and historical business records/audits/schema.
- Handoff/open: authentic choose-file/QC/provider handoff acceptance and remaining monthly portal-access/publication work stay open on existing checklist. Next steps are isolated/provider-controlled acceptance and staff completion of recorded portal follow-up. Historical physical sends before upload acknowledgements require explicit manual project confirmation rather than treating an older listing delivery as proof of new versions. Optional browser-choice question and temporary empty Vercel source-project cleanup approval remain unanswered; neither blocks this release.
- GitHub main fast-forward receipt follows; no force push.

### Release confirmed — October 3, optional branding Aryeo / Topaz Final backup

- Application commit: `6d9e0fa5956ea8d2f59d36d75363a120ff338102`, branch `codex/audit-2026-09-30`.
- Production: `dpl_3wTAMBJDWuzi5iovVwaVLS6goXfn`, READY; https://realtour-pilot-6irkdo59h-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com. Remote optimized build, TypeScript and page generation passed.
- Implemented/tested/committed/deployed: optional office Aryeo routing for exact monthly branding versions before/during Topaz finishing, durable version/listing choice, immediate upload/grouped-send journey, portal publication race protection and truthful channel labels. Enabled/client-visible: existing authorized office controls are visible in production; client portal remains default. Requires a linked Aryeo listing; choosing a destination performs no provider upload or client send. Already delivered portal history is retained.
- Verification:290 focused checks (31 destination,83 UI,22 grouped delivery,52 monthly/race,102 Topaz), local full types/scoped lint/diff checks and one focused source review. Native isolated missing-listing → choose → reload → upload → grouped sent passed with providers fenced. Production authenticated read-only smoke confirms both pending branding options beneath file buttons, no1280px horizontal overflow; screenshot `/private/tmp/rtp-branding-aryeo-production-proof.png`. No real mutation submitted for acceptance.
- Final Dropbox evidence: existing Topaz driver saves verified processed files into `actualFolderPaths(project).finalVideo` before marking done; hold/retry preserves original and older versions. Live read-only DB + Dropbox file metadata spot check confirms6/6 recently finished current approved files are nonempty in their correct Final folder. Private proof `/private/tmp/rtp-topaz-final-readonly-proof.json`; no file bytes downloaded/provider writes. This is a bounded recent-file check, not a universal historical-file audit.
- No migration, production business-record mutation, client/provider send, invitation, automation/rollout activation or financial action. Existing backup retained; no schema/backup refresh needed. Committed source-only archive excludes `.env`, private assets/exports/docs/tests. Initial malformed archive was rejected before upload/build; corrected archive explicitly validated before successful deployment.
- Owned isolated fixture stopped gracefully; app3225/PG5617/sample5618 ports free. Serve runner exit143 is intentional cleanup after23 assertions passed/0 failed; older servers untouched. No app build/test/deploy command remains.
- Rollback: previous application deployment `dpl_2bXcBFQSiHA4xZJ7YfCc61UUJtG3`; application only, retain all saved business/audit data and existing schema.
- Open next steps unchanged: authentic choose-file/QC/provider handoff acceptance and recorded monthly portal-access/publication follow-ups. No claim that the broader platform journey is completely accepted. GitHub main fast-forward/readback follows with release documentation; no force push.
