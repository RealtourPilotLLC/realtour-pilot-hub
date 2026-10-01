# September 30 workflow audit — implementation tracker

This tracks the user's full workflow audit at `/Users/jordanspackman/Downloads/Realtour-Pilot-Full-Workflow-Audit-2026-09-30.md` against the local checkout. The audit is evidence and backlog, not an instruction to turn on client-facing features. Update each row with a commit and acceptance evidence before calling it complete. See `docs/handoff.md` for the current resume point.

**Current release boundary (Oct 1):** the user explicitly authorized production deployment of the committed work on `codex/audit-2026-09-30`. Exact candidate: `3c3c2d741aaf7a30d6c5fe1314fbb6611348e0e3`. The reviewed five-table additive schema has been applied and verified; Vercel remote compile/types/build, staging checks and promotion passed. Canonical https://hub.realtourpilot.com serves `3c3c2d741aaf`; deployment HTTP smoke passed. Normal-role/browser journeys and gated real-client visibility remain unaccepted. This authorization supersedes historical deployment prohibitions only. No production mutation test, seed, reset, client send, invitation, real booking, financial change or automation activation is authorized. A branch push is not part of this release. The production database remains shared with local `.env`.

Status terms: **done in code** still requires its named acceptance check; **partial** means a concrete remainder; **open** means implementation remains. At takeover `origin/main` was the audit's pinned `1075a5b`, and local `main` had eight newer commits. The Oct 1 fresh main fetch found the exact release candidate 0 commits missing from main / 161 commits ahead.

## Oct 1 authorized release checkpoint

### Policy candidate held — client approval repair

`974327f` passed the separate clean Node20 build and Vercel remote build. Its
stage completed at15:33:14Z; protected version/login checks passed and canonical
production remained3c3c2d741aaf at15:39:27Z. It is **not promoted**. Inspection
found that the existing outside-delivery entitlement treated the new monthly
portal handoff stamp as client download/caption permission.

The repair commits an exact `monthly_portal_handoff` AuditLog marker in the same
transaction as the first handoff stamp. Entitlement and finishing-file readers
honor that marker, including paused/ended fallback, and propagate failed reads.
Exact client approval, prior-approved v1 and unmarked historical/listing rules
remain. Marker backend41/0 and signed stream/download/caption PostgreSQL21/0
pass; scoped lint0, non-incremental types0 and focused root/peer review pass.
A new exact commit/build and replacement stage are required before promotion.
No new schema or live write. Combined gate logs:
`/tmp/ops-hub-portal-handoff-types.log`, `/tmp/ops-hub-portal-handoff-lint.log`.
Logs: `/tmp/monthly-portal-handoff-marker/`, `/tmp/monthly-portal-approval-gate/`.

### Follow-up W04 — monthly portal plus final Dropbox backup (local)

Supplemental canonical legacy-original check: when the portal's no-blob
`assetPath` differs from the final backup, both files must have matching hash
and size, and source metadata is bound to the check fingerprint. Equal-copy and
overwritten-source fixtures raise the backend to40/0
(`/tmp/monthly-final-acceptance/`); scoped lint and non-incremental types0
(`/tmp/monthly-final-legacy-types.log`). This is a small follow-up to148440a,
before build/deployment. The38/0 checkpoint below remains historical evidence.

- Monthly handoffs now require the current approved/released canonical client
  file, exact final-folder Dropbox proof, an eligible owner on this enrollment
  under the existing rollout, and a matching staff final-file attestation.
  Recording delivery is atomic with a fresh cut/access/check comparison; already
  recorded sends retain repair behavior. Listing delivery remains unchanged.
- Monthly portal release no longer hides an unrecorded handoff. The board and
  summary name the portal and final Dropbox backup. Staff can play canonical
  processed client bytes through an office-only route; Review Room originals
  retain their existing behavior. Temporary-link metadata must match the check.
- Copy acknowledgment/path/timestamp alone cannot prove backup content.
  Verified source hashes and version/file receipts survive normal retention.
  Prior originals/enhanced files move only after the replacement lands, only
  older canonical rounds move, and actual autorename paths are recorded by CAS.
  Failed moves preserve historical paths/timestamps. No live record backfill.
- Final-check attempts have exact actor/payload-bound receipts and held unknown
  outcomes. Native answers remain mounted; another file resets only its six
  attestations, and late reads/metadata cannot replace newer choices.
- Signed isolated PostgreSQL backend38/0; actual fake UI19/0; affected listing
  final34/0 and mixed photo/video25/0. Focused review repaired first-claim, copy
  acknowledgment and preview races plus enhanced-history/checkbox issues;
  narrow rechecks, changed-file lint, diff check and final non-incremental types
  pass. Logs `/tmp/monthly-final-complete/`, `/tmp/monthly-final-check-ui-identity/`,
  `/tmp/ops-hub-policy-listing-regression/`, `/tmp/ops-hub-monthly-final-types.log`.
- No new schema, real provider operation, client message, approval, invitation or
  automation/rollout change. Clean build/deployment remain pending; browser,
  phone and real media/provider acceptance remain open.

### Follow-up C19 — approved general welcome link (local)

- The welcome default/fallback now uses Jordan's approved
  `https://calendly.com/realtourpilot-info/strategy-call`. The dedicated monthly
  Content Program constant, event mapping and classifiers are unchanged.
- Actual fenced resolver/sweep/template and monthly-link fixture:26/0;
  scoped lint and root source review pass. Saved custom URLs, messages, switches,
  send windows, opt-outs and dedupe are preserved. No real message was sent.
- Fresh read-only live settings check found no `auto_texts` row. No row was
  inserted or changed; production will use the new default only after this
  source is released. Current policy source passed non-incremental TypeScript
  (`/tmp/ops-hub-policy-types.log`); the final clean build remains pending.
  Production still serves3c3c2d7.

### Follow-up W02 — explicit no-brand and returning assignments (local)

- Versioned briefs distinguish intentional no-brand from an unset choice. The
  choice appears in editor/shoot/PDF/new agency packets and exact receipts.
  Existing frozen packets and legacy unspecified choices are preserved.
- Actual effective owner changes advance the existing output `ownerSetAt`
  generation in the same Project→Output transaction as assignment/card writes.
  Queue, project, task/status/checklist/dismiss and Ask Hub paths are covered;
  explicit per-output owners and unchanged assignments keep their generation.
  Returning/unassigning and returning requires a fresh receipt, even if the
  intervening editor never acknowledged. Clock skew cannot reuse an old receipt.
- Signed isolated PostgreSQL fixture44/0, including real stale-ack lock wait;
  affected existing W02 15/0 and A28 61/0; scoped lint and focused review pass.
  Review found and repaired queue-add bypasses; targeted recheck passed.
- No new schema, live writes, Start/Pause changes, provider messages or
  activation. Non-incremental TypeScript passed with the current policy source
  (`/tmp/ops-hub-policy-types.log`). Clean build and normal mounted editor
  acceptance remain pending. This follow-up is separate from deployed3c3c2d7.

| Stage | Verified fact / next step |
|---|---|
| Candidate | `3c3c2d741aaf7a30d6c5fe1314fbb6611348e0e3`; existing source/test/build evidence below remains applicable. |
| Production before release | Build `bf2e0b48a0dd`, Vercel deployment `dpl_8Je8ULY9Pf6sy3asVwjtrCKvTXzj`. |
| Fresh backup | `/Users/jordanspackman/rtp-backup-2026-10-01-predeploy.json`, 144/144 models, 118,636 rows, 211,904,272 bytes, mode 0600; snapshot `2026-10-01T13:44:46.972Z`. Full-stream counts, ID hashes and schema coverage verified; checksum `52ab7390a31cf5eb3762959dcef16df0baef001590e968b575a31f06642fa691`. Private backup stays outside Git. |
| Schema applied | `ClientBrandReceipt`, `DeliveryFollowUpHealth`, `FinalRenditionCheck`, `ShootBriefRead`, `EditorBriefReceipt`; 14 DDL statements applied atomically at `2026-10-01T13:54:34.540Z`. No schema ledger, reset, seed or backfill. |
| Live schema postflight | 149 tables; 12 indexes for the additions (5 primary-key indexes + 7 others); 2 validated foreign keys; all five new tables empty; schema diff exit 0. |
| Remote build / promotion | Passed; dpl_FaUomN98Qz8EDuFnUopYgtnt55HS (r6ajwlsup), canonical version3c3c2d741aaf. Login/headers, sampled assets, office auth redirects, streamed portal sign-in and old-host redirect passed. Existing browser/phone/media acceptance remains open. |
| Existing gates / access inventory | Before release: 1 stored automation row, off; rollout default `TEST_ONLY`; raw totals 2 active `ClientUser` records / 3 unrevoked memberships. These totals do not identify real client seats. No switch, rollout or invitation authorization follows from deployment. |
| Acceptance | Normal browser/phone/provider/media evidence, business decisions and the historical 13-candidate roster reconciliation remain open. Preserve existing settings, permissions, exact versions and manual Start/Pause. |

Post-release comparison: automation configuration/rollout/raw seat counts unchanged; all saved preference values unchanged. Only two old scheduled sweep state keys advanced. See `audit-2026-10-01-production-release.md` and sanitized release JSON.

User decisions after release: monthly content = portal plus final Dropbox backup; intentional no-brand acknowledgment and fresh reassignment receipts required; general welcome URL = https://calendly.com/realtourpilot-info/strategy-call. These require a new focused source/config batch and are not claimed implemented/deployed in3c3c2d7.

Earlier batch notes below preserve their checkpoint history. Their statements
that no schema/deployment was authorized or applied are superseded only by this
Oct 1 release checkpoint. A code rollback retains additive tables and any new
receipts; do not reset/seed or replay an ambiguous delivery.

Historical takeover evidence: Sep 30 `prisma migrate status` found no Prisma
migration history, and the initial live/schema diff was empty. The earlier
private backup `/Users/jordanspackman/rtp-backup-2026-09-30-pre-brand-reliability.json`
covered 144/144 models and 117,762 rows (213.3 MB, mode 0600). The five later
additions were unapplied then; their current applied state is recorded above.

## Functional findings

| ID | Current disposition | Evidence and next step |
|---|---|---|
| C01 | Route-function and preview recovery proof passed; browser/HTTP open | `/edit/[id]` checks assignment before script sync or job reads, including current per-output ownership. New configured fake-provider test exposed preview importing saved script words (14/2 before); preview now skips sync while ordinary authorized sync remains. Actual page function with signed sessions passes 16/0: anonymous/unassigned/disabled/retired ownership refused before reads, owner/admin/assigned editor retain exact script, preview writes no script, read receipt, brief receipt or Start. HTTP middleware and browser acceptance remain open. |
| C02 | Locally committed before takeover; targeted test passed | `b222dde` + `ffaf173` + `b2be2b6`; `realpg-start-eligibility` 76/0 on isolated Postgres. Check browser Start/Pause only in the final journey. |
| C03 | Locally committed before takeover; targeted test passed | `193dbed`; `r02-draft-topics` 138/0. Test failed autosave and recovery in the client/upload journey. |
| C04 | Local recovery and provider interruption proof passed; release gate open | Recoverable claims create Kyle's task and change links in one transaction; expired preparing/sending rows recover and legacy ambiguous deliveries remain unknown. `c04-brand-alert-recovery` 8/0 covers after claim, after task, catch-up and old claims. `c04-brand-provider-recovery` 12/0 injects fake Slack refusals at `notifyInApp`: a failed leg stays retryable, the five-minute sweep reuses one bell/task and delivers once, a crash after accepted delivery does not resend, a bell with no channel receipt becomes unknown for staff, three explicit refusals end unreached, and a failed catch-up retains its dispatch-hour key on retry. Node20 TypeScript and focused lint pass. `cp06-brand-setup` now passes 130/0: its old normal-client fixture was correctly refused under TEST_ONLY, so the disposable test now explicitly admits only that seat for sign-in, proves denial before/after the pilot, and queues no invitation or email. No production access rule was relaxed. Production brand alerts remain OFF. The additive schema gate is complete as of Oct 1; deployment promotion and signed normal-role/provider observation remain open. |
| C05 | Implemented locally; schema applied; browser/release open | Added `ClientBrandReceipt` keyed by change/version and editor. Each editor's Got it records only their receipt; Kyle's task stays open and names remaining keys. Owner/admin can record an attributed override with reason; generic task completion cannot bypass it. Historical shared acknowledgments are labeled as such. Isolated two-editor drill 12/0. The reviewed table, unique key, index and FK are applied under the Oct 1 atomic schema release, with fresh backup and empty-table/schema postflight evidence above. Still verify two-editor UI and role/preview behavior; remote build/promotion and deployment HTTP smoke passed; normal-role journeys remain open. |
| C06 | Done in code; visual proof open | Independent follow-up reads report availability and retry. The global office read now persists each lane's last successful check in `DeliveryFollowUpHealth`; project-scoped and dry-run reads never update this health signal. Isolated `a02-a04-delivery-truth` 27/0 covers each failure, both together, durable prior timestamps and an actual waiting row restored on retry. Node 20 typecheck, focused lint and build pass. The additive table is applied under the Oct 1 release; visually check the warning and timestamp on Kyle's Home after promotion. |
| C07 | Partial; direct brief and concurrent-message proof passed | Brief/project/message-center page loads do not stamp `ThreadRead`. `ede6acf` adds a prominent unread-team-message link near Start/Pause. `4729c87` freezes the read target at the last message loaded when a conversation opens, including Retry, and remounts that target only when switching projects. In a signed-owner isolated Parker route, direct brief load left the receipt null; after a third TEST message was inserted, opening chat saved the second loaded message's timestamp and left the third unread. A fresh 390px brief showed one new-message cue. Node20 TypeScript, focused lint and build pass. `c07-editor-read-receipt` now passes 13/0 with real signed editor/preview/unassigned sessions: exact loaded watermark, newer unread message, old-tab monotonicity, failed create/update preserving unread, retry, and cross-project refusal. No C07 source fix needed. Browser observation of normal editor receipt/error feedback remains open. |
| C08 | Date paging already correct; context/recovery implemented and tested | All returned dates page in groups of six. New signed-client/action and first-paint drill 20/0 covers 15 dates, final time choice, Pro session isolation, validated month/session navigation, and address-version invalidation. Call month changes reset the picker; failed loads/bookings show retry. Mounted phone/browser and real provider booking acceptance remain open. |
| C09 | Locally committed before takeover; targeted test passed | `f6109bb`; `r03-rollout-scope` 112/0. Recheck all queued-before-scope-change paths at release. |
| C10 | Signed client action journey passed; browser acceptance open | `83b680a` / `client-written-journey` 23/0 uses the actual one-time login route, signed normal named-client cookie, membership resolver and named pilot. It proves first-call protection, eligible later-month written selection/answers/submission, signed staff approval and canonical release, exact client acceptance, newer-version reapproval, stale-version refusal and immediate seat revocation. Request cookie transport alone is injected; production authorization is real. No provider request/outbox/booking. A connected signed named-pilot scenario now couples strategy/bank, written month, exact scripts, two-output production and client final/download decisions (19/0, `7cb9e03`); call/discovery has separate 25/0. Browser, actual model/media/providers and onboarding release remain open. |
| C11 | Partial; dependency and live blocker visible | Stage A now names `transcript_jobs` for queued call processing and distinguishes the separate manual drafting path. Monitoring uses the driver's read-only queue classifier to show queued/running/failed/human-review counts, off-switch and backlog/rollout/handler holds, with a link to owner review and Re-run. Read-only live Sep 30: worker off, 5 queued (3 INGEST, 2 ANALYZE), 0 running/failed/review, oldest Sep 18; all 5 are excluded by the first-on backlog default, and 2 are AI jobs. No switch/backlog choice changed. `client-call-journey` now passes 25/0 on disposable named-pilot records with real signed sessions/actions and fake model output: distinct discovery/monthly calls, off-switch holds, retry recovery, strategy approval/release, confirmed monthly selections, drafting gate and exact client script acceptance. The replay exposed a stale current-call error after successful retry; recovery now clears only the matching error captured before that job ran, preserving newer and other-kind errors plus failed-run history. Still prove actual model quality/spend, provider booking and browser paths before enabling the worker; the production backlog/switches are unchanged. Confirmed/queued/off/imported evidence wording now matches actual state (17/0); October candidate inventory confirms two held monthly transcripts waiting behind the off switch. |
| C12 | Locally committed before takeover; targeted test passed | `c52d4a2` + `8654acb` + `77fa13d`; `isolation-boundary` 131/0. Build failure from `process.argv` in Edge graph repaired locally; production build passes. |
| C13 | Partial; named read-only replay and focused isolated checks passed | `759d2fb` aligns the client-file next-action reader with the roster and names drafts accurately; v1 Home stops asking a filmed client to book the planning call. `3ffef4f` makes an unlinked filmed allowance video a staff reconciliation issue before script work; a live released cut's review/send stays first. Read-only Neon replay via `scripts/_recon/c13-current.ts` found Erica Walker, John Collins, Mike Ciunci, Mike Flatley and Rick Schultz staff-owned for topic-link reconciliation in both staff readers. Rick has four September topics and four linked drafts, but both delivered videos lack topic links; the portal reader counts four selected and exposes zero visible September selections, so client preview needs normal-role proof. CP-10 isolated 135/0 covers filmed legacy, reminder suppression, partial Pro, extra output, next month, draft/review, null video link then explicit link, and review priority; UI-01 C13 action assertions pass. No historical link or live record changed. Still repair exact named links only after staff verifies source identity, then replay normal signed client v1/v2 views and provider-backed reminders before enabling any reminder or rollout. |
| C14 | Partial; roster/review, demo, identity and exception scope checked | `c17f4a2`: normal Content roster and Review Room queue/QC pattern counts omit rows whose client passes `isSyntheticClientRow`; each has an explicit `?test=1` view. Isolated demo browser: normal September roster 0 clients/0 videos versus test view 2 clients/4 of 12; normal Review Room 0 cuts/3 test cuts. The loopback demo's believable pillars and complete scripts are asserted; a late-month Pro flexible-request collision was fixed and fenced demo passes 89/0. Manual fixture confirmation does not prove Aryeo booking. Bounded OpenPhone read found 469 conversations, 24 with the TEST account phone and no provider group labels; that phone is also Jordan's team number. Inbox/thread now prefer team identity, with read-only replay showing Jordan Spackman and no synthetic client context; real Jordan numbers remain named. Normal roster failures exclude synthetic client/enrollment and global cut-transcript rows, including legacy cuts whose project is found through the submission; Monitoring and explicit test view retain them. Empty normal rosters still show real global failures. Isolated failure scope 5/0. Delivery reconciliation skips by durable synthetic client identity, never a TEST word in a real job title; isolated 3/0. Home exception sources exclude synthetic clients before row caps and totals; `c14-home-counts` 8/0 includes a capped synthetic follow-up pile, protected real client and real TEST Avenue job. Existing scope regression 28/0. New clients card excludes fixtures before its cap; `c14-new-clients` 3/0 keeps a protected real client and an older real arrival visible. Read-only live snapshots had no global failures and Home exceptions 11 with no TEST-labeled title; no conversation was filtered or message sent. A browser policy blocked local-tab access in this run. Remaining normal Home workload readers were completed in `7ed0432` (15/0); explicit Home test scope/return links pass 22/0 (`c74db96`), and Office Editing/Schedule scope parity passes 23/0 (`fcc476a`) with fixture filtering before caps and preserved creative assigned work. Signed browser identity, filtered-empty/read failure and mounted scope/return acceptance remain open. |

| C15 | Existing correction verified with signed role rendering; browser open | Review Room scopes its empty headline to cuts, labels mixed `media_qa` as delivery checks, and renders `DeliveryExitSummary` from Home's pending delivery reader (W05). New actual signed Kyle/James page-render drill passes 12/0: no first-cut queue still names the exact revision/version, video-only media checks, and unknown text's actual conversation link; normal/test scope and signed-out refusal pass; no task/version/send state changes. No further C15 product fix needed. Earlier isolated test browser showed three cuts, three mixed checks and three exit rows. Current signed browser acceptance remains blocked. |
| C16 | Confirmed-cause reporting implemented and targeted tests passed; UI acceptance open | Optional unticked QC boxes remain **not recorded**, never confirmed defects. Review Room now shows existing root revision issues by reviewer-confirmed cause, with period, applicable denominator, duplicate/N/A exclusions, recorded editor attribution, exact-version coverage and unknown history. Editor first-review/recurring/client-visible fault metrics require confirmation actor/time; unknown labels go to classification. Normal quality views exclude fixtures; explicit Quality test view retains them. Moved cuts cannot inherit former-project issue history, and staff uploads credited by valid self-checks appear in the editor roster. New drill 17/0, existing self-QC/issues 141/0, signed Editing page scope 5/0; lint/review passed. Required self-QC, pay and recorded source words remain unchanged. Browser/readability acceptance and historical unknown classification remain open. |
| C17 | Partial; shared assignment truth in code and browser | Home exceptions, Editing Room and job brief now resolve task override → project editor/vendor → saved manual unassignment → routing suggestion through `editorAssignment`. Suggested routing is visibly unsaved in the queue dropdown, and Home asks Kyle to confirm it rather than claiming the editor accepted. Isolated five-state drill 11/0; queue removal 22/0, active editing 147/0, handoff 116/0. Live read-only: 8 active video candidates; 4600 Newburg has no project editor/vendor/open edit task and the saved route suggests Kim. No assignment changed. Isolated browser with Kim routing: desktop queue select reads “Suggested: Kim · not assigned”; Home says Kyle should confirm; at 390px the same control is reachable by horizontal scrolling, but the table is hard to use and remains U3 work. In-house acceptance/acknowledgment is a separate W02 handoff, never inferred from assignment or Start. |
| C18 | Code guard done; live one-row repair pending review | Read-only Neon check: task `cmucuidu10005gu04uws9vz24` is OPEN, title names 3826 Fairmount, but project/property address point to 3057 N 10th. The related OpenPhone conversation was filed with `projectGuess=true` on 3057, and the task's matched inbound text did not itself name 3826; the generated task title did. New routing checks the message plus proposed title/detail against the client's own order addresses, clears explicit unknowns and contradictions, and refuses cross-client/cross-property merges. Isolated C18 drill 11/0 plus reply-request regression 108/0. Proposed surgical repair: after Kyle verifies source conversation, relink only this task to project `cmucuivp8000bgu04xf08gzwm` (3826 Fairmount), update its `propertyAddress`, preserve its original title/body/source and audit the correction. No live row was changed. |
| C19 | Approved link implemented and targeted-tested locally; release pending | Jordan approved https://calendly.com/realtourpilot-info/strategy-call. Commit7220dca separates the general default/fallback from monthly booking; actual fenced fixture26/0 and lint/review pass. Fresh live read found no auto_texts row, so no settings write was needed. Release the repaired exact policy candidate; never replay old welcomes. |

### C14 Home progress

`0f3c5e4` filters the operating-day/revision sources; `c14-home-day` 7/0. `e516d7b` filters Stuck jobs and seven-day shoots; `c14-home-windows` 5/0. `ee832f4` filters Home/Project Tracker delivery sources before caps with `/pipeline?test=1`; `c14-delivery-board` 4/0. Real TEST Avenue jobs and protected real clients remain visible.

`6816465` filters strategic delivery/AR/VIP/revision flags before caps (`c14-strategic-flags` 10/0). Home’s Other and media-check badges now use the same shared predicates as Tasks Other and Review Room, including fixture scope; Tasks Other has a retained `?test=1` view (`c14-other-qc-scope` 10/0). Unlinked work, old reply tasks, current editor assignment and on-hold QC rules remain intact. Focused lint passed (one existing queries.ts warning). The integration typecheck found one typo in the new, separate signed-journey drill and no source errors; that typo was corrected, final shared typecheck pending. Comms/Outbox and ready-to-send sources now also filter before caps (`d1c402b` / `c14-comms-delivery-scope` 15/0): Home and destination badges/lists match, normal batch review sees the same drafts, explicit test views restore fixtures, old real reply obligations and team identity rules remain intact. Delivery candidates, finishing/not-told lanes and notice incidents share normal Home/Review scope; health timestamps still record office reads and project reads cannot overwrite them. Slack/Done now have source filters and explicit test views: `c14-slack-done-scope` 12/0 proves capped Slack/deep-link behavior, Done badge/history parity, real cancellations staying separate, and matching real/test recap inputs through fake model HTTP. The shared scope predicate is extracted to avoid a queries/board import cycle. A final Home composition check identified remaining unscoped owner-only summary readers (`getOwnerStats`, `getOwnerPulse`, `getOwnerDials`, operational fields of `ownerPulse`), handled-today and personal flagged work; those were completed in `7ed0432` (15/0), with historical markers and Finance definitions preserved. Signed browser identity and consistent Home test-view navigation remain open. Do not treat financial definitions as operational fixture filters. Local browser access remains policy-blocked; no alternate path attempted.

## Operating improvements

Latest C14 composition: Home's explicit `?test=1` view and supported scoped
links/Review Room return passed signed isolated count/link checks 22/0
(`/tmp/c14-home-test-view-reviewed/`), lint/diff and source review. Office
Editing/Schedule scope parity now passes 23/0, with before-cap activity/rail scope,
creative assigned-work/Start/Pause preservation and retained return URLs. Affected
Home 22/0, U3 layout 15/0 and stage/URL 14/0 pass. Browser identity, filtered-empty
and scope acceptance remain open. Exact cut links and Finance definitions are intact.

| ID | State | Next evidence |
|---|---|---|
| W01 | Partial; month view and repair verified in isolated demo | `/edit/[id]` shows only same-client, explicitly linked month jobs the viewer may open, including separate Pro appointments, dates/addresses, topic pairing status and each job's own raw folder. Package allowance and output-row counts stay separate, with mismatch/incomplete-filming warnings; no slot is changed. Staff Sessions offers an explicit same-client unlinked-video-job link with reason, conflict refusal and activity log. Isolated W01 drill 15/0 covers two-project and one-project/two-appointment Pro, editor scope, legacy cuts with no output pointers, unpaired cuts, cross-client/conflicting-record refusal and audit trail; typecheck, focused lint and build pass. Browser replay: Avery month summary matched the review panel (4 submitted, 3 approved), desktop and 390px layout passed; a disposable unlinked TEST job was linked through the staff form, showed success and appeared under September, with missing Aryeo appointment still marked unverified. Demo was reset after the check. Live read-only Sarina: allowance 4, two linked jobs with 9 output slots, 2 delivered, no confirmed filmed/topic binding; Kyle must reconcile actual owed scope and per-video source before any live row repair. Normal authenticated role route replay remains. |
| W02 | Partial; per-video brand pin and assignment summary in code | An office save can pin the exact active logo/branding-card asset version in the existing versioned output brief; cross-client/stale files are rejected, historical pins remain visible after replacement, and editor writes are refused. `/edit/[id]` shows output/cut/brief version, script standing, owner, deadline, brand choice, source folder, purpose/treatment and limitation near the top, after manual Start/Pause. Shoot, printable brief and new frozen agency packets carry the choice. Existing packet snapshots remain unchanged. Isolated A28 61/0 and A33 48/0; TypeScript, focused lint and build pass. Avery TEST editor page desktop and 390px phone visual check passed. `6693c47` adds a separate per-video in-house receipt pinned to the current saved owner, script, brand, source, direction and due date; assignment never implies Start. It also admits the current per-output owner through the job read guard. Signed-session isolated W02 drill 15/0, TypeScript/lint/build pass. Avery TEST unassigned state is readable at desktop/390px, but the auth-disabled demo cannot show the editor button. Still replay normal signed editor/office UI and a real multi-output job, decide an intentional no-brand state, and settle whether reassignment back to a previous editor needs a fresh receipt. The fifth additive table is applied under the Oct 1 atomic schema release; normal browser and policy acceptance remain open. |
| W03 | Partial; staff approved-cut and chat conversion verified | Authorized staff can request changes on the current exact approved video/version from Review Room, or convert an immutable stored team message after explicitly matching an output and naming the client contact. The request preserves the exact words, timestamp and optional attachment reference; the existing writer creates the editor task/clock and internal notifications. Only the named slot reopens. Isolated `w03-staff-revisions` now uses enforced actual signed Kyle/James/editor/preview sessions: PGlite 25/0 and disposable Postgres 26/0, including four observed backends and one real advisory-lock wait. Concurrent same-key actions initially created two briefs; the writer now locks that request key and reuses one exact brief, issue and task without changing other thread-based sources. Delivered-file history and saved editor assignment are preserved without automatic Start; related B1/CP03/C2 regressions pass. Isolated desktop/390px browser replay submitted synthetic direct and chat requests, showed exact brief issues and source link, and kept an unrelated approved cut closed. Staff-facing source wording was cleaned up. Signed roles, concurrent submission and delivered-cut actions pass. Receipt-first intake now preserves evidence before provider/task effects and commits project/activity/task/QC/restoration together. Exact attachment readback, known-absence retry, refresh identity and current-metadata merge are verified: real PG intake 24/0, final PGlite 26/0 with stale-target recovery; existing real PG W03 26/0 + retry 23/0. Exact per-cut historical/creative/client stage and uncertain action receipts now pass isolated 15/0 (`9b506d8`); connected v1/v2 handoff 19/0 and PostgreSQL exact approval/issue race 11/0 (`7cb9e03`) pass. Still verify normal browser refresh/resume/stage and actual Dropbox behavior; no production request was made. |
| W04 | Partial; listing final-file check in code | Added `FinalRenditionCheck` for the exact approved cut, source rendition fingerprint, Aryeo video ID/URL and named staff attestation of identity, playback, audio, frames, title and access. Staff can open the provider file and see browser metadata; the record explicitly says ticks do not prove a full watch. Older Aryeo videos are excluded by the same UUIDv7 date helper as delivery proof. Manual Mark sent, Topaz delivery card and task completion re-read the provider video and require the listing to show DELIVERED; a changed source/provider URL or newer cut invalidates the check. The task path now uses the per-cut send writer so output and Topaz/task stamps settle together. Automated Aryeo proof stays independent. Isolated W04 drill now 34/0 with AUTH_ENFORCE=true and real signed ADMIN/client/editor/preview sessions covers missing/partial check, sibling output, older media, provider/source changes, delivery status, both manual send paths and exact output stamps; Node 20 typecheck/lint/build pass. Desktop and 390px isolated browser showed the check form and clear Aryeo-read failure with Record disabled. **Release schema gate:** table applied and verified Oct 1; remote build/promotion and deployment HTTP smoke passed. Signed Kyle public read/check/send and Topaz-task completion now pass; client, unassigned editor and owner preview are refused without provider reads or record changes. New actual-domain mixed-job fixture25/0 verifies signed final-checked manual send and automatic Topaz/Aryeo proof retain flagged/unwaived photo obligations, exact photo revision/image flag/QC and original project revision stamp; converse photo-task completion retains the assigned video ask, exact current/approved cut pointers and unstamped video output. Existing automated-proof/notice follow-up evidence is retained (aryeo-autosent20/20, percut-stamp18/18 and B4 delivery122/0); no old suite was rerun. Still verify normal browser behavior, real approved rendition/watch/provider proof/notice, the newly approved portal/Dropbox monthly destination implementation. No production delivery action was used. |
| W05 | Partial; shared Review Room exit and delivery-text state | `07d25d1` adds a read-only delivery exit to Review Room using Home's `readyToSend` reader: finishing 1080p, exact ready file/destination, incomplete records, and client notice pending. `916a30c` adds job-level delivery-text queued/failed/unknown outcomes from the existing outbox to both Home and Review Room; an accepted retry supersedes an old failure, unknown never offers a blind retry, and failed query marks the lane unavailable. `e4d79a2` clarifies exact-cut versus job-level text. `35819c0` links an incident by opaque outbox ID to Communications, where its exact text/state and matching recipient conversations are shown without retry or settlement. Rows carry Kyle, age, next action and links; TEST rows stay behind `?test=1` in Review Room. Isolated B4 120/0 and W05 notice 10/0, Node20 typecheck/lint/build pass; desktop/390px Review Room and disconnected Communications incident checks passed. Still establish per-job monthly portal/Aryeo-copy policy, verify actual Aryeo/OpenPhone outcomes and normal auth, settle manual-versus-automated unknown-text policy, and check production rows after the authorized code promotion; additive schema is applied. |
| W06 | Partial; handoff and pre-shoot read receipts | `895601a`/`13b0d77` add the photo/video handoff review and saved receipt, separate filmed/unfilmed topics, folder evidence, exceptions and still-owed work; off-script videos require title and note. Isolated CP09 139/0, B4 upload 69/0, desktop/390px submit and saved read-back passed. `3ba7982` adds a versioned `ShootBriefRead` snapshot for the assigned photographer, a delta for later script/topic/direction/asset changes, and pronunciation/reference assets beside the current released scripts, game plan and per-video briefs. The action re-reads the current brief, rejects stale digests, enforces assignment, and blocks owner preview; isolated W06 brief drill 13/0 with real sessions, Node20 typecheck/lint/build, desktop/390px shoot view passed. `967390c` fixes preview copy (typecheck/lint pass). `18a3d94` adds a timestamped, read-only Dropbox check at final review using the job’s current raw-photo folder and job-wide video search. Unknown reads stay unknown; the saved receipt labels older counts as recorded evidence. Isolated handoff drill 119/0 and B4 upload 69/0, Node20 typecheck/lint, and desktop/390px synthetic review passed. Still verify a normal authenticated photographer browser journey and real connected-provider file locations; a checked upload is a report, not verified files. **Release gate:** all five additive tables are applied and verified Oct 1; code promotion and normal-browser/provider acceptance remain open. |

## UI phases and acceptance

| Phase | State | Remaining |
|---|---|---|
| U0 | In progress | Current disposition and isolated comparison set; C13/C14/C17 truth, per-client inventory and baseline screenshots. UX08's false autosave promise is removed; drafts survive a refresh in the current tab until explicit Save. |
| U1 | In progress | `9f9213f` separates filled-action orange from the brand accent, raises secondary text contrast, migrates client white-on-orange controls and Editing Room/ready-file first consumers, and shares badge colors with the queue. `a65a6de` deepens light badge ink after rendered amber was 4.24:1. Sampled client/staff action and secondary text pairs now calculate about 5.05–5.53:1; rendered light amber pill about 5.05:1. Node20 TypeScript, changed-file lint/build passed; 390px Editing Room had no overflow and its active filter was 44px. Shared native action/field/save-state primitives now cover core Settings and client planning controls (9/0 + Settings snapshot 12/0), with a development-only fixed comparison gallery. Full typography migration and rendered contrast/keyboard/zoom/phone acceptance remain. |
| U2 | In progress | `7b07840` makes Your Month expand its current work area only: the call controls are folded after booking, the filming picker mounts on the current step, and the topic bank opens for topic/answer work. Completed steps are compact, later booking stays available in Appointments, and a deep-linked script step has its own review action. The existing route/booking gates are unchanged. Isolated planning drill 153/0, Node20 TypeScript/lint/build, and Avery TEST desktop/390px browser passed; current September script v1 was reached from the step. `1f2d933` scopes a same-tab answer draft to client/enrollment/month/interview/question, restores older drafts, avoids showing another question's text, and offers an explicit storage retry with truthful local-vs-team wording. Avery TEST draft survived refresh and did not appear in Parker's matching interview; read-only demo DB counts stayed 8 answers/0 script versions with no preparation timestamp. CP08 80/0 and Node20 TypeScript/lint/build passed. `4ad0993` gives the Scripts view 16px/28px reading text, bounded width, clear month/version, and 44px decision targets at desktop/tablet/phone widths. A change note survives closing/reopening its panel. UI01 92/0, Node20 TypeScript/lint/build, and Avery TEST desktop/768px/390px browser passed. `2162186` caps the portrait player, puts note/decision controls beside it at desktop widths, and gives primary review actions 44px targets. Avery TEST exact cut played from fenced local media; desktop/390px browser showed no overflow and keyboard Enter opened then cancelled version-1 confirmation. CP03 52/0, TypeScript/lint/build passed. `bc44dbf` persists per-question suggestion provenance in the local draft and adds a current-vs-suggested preview before Replace. CP08 80/0, Node20 TypeScript/lint/build, and fenced browser Add/Replace/Undo, refresh, second-question isolation, rejected Save and 390px layout passed; demo answer/script-version counts remained 42/18. UX08 normal suggestion account and denied-storage retry, plus UX09 signed-editor money filtering, client failure/auth, media and phone-download checks remain. Written/call/Pro second-session transitions, normal client seat, brand and full journey remain. |
| U3 | In progress | W02 puts a compact per-video assignment/source/brand summary and receipt state on the editor brief after Start/Pause; desktop and 390px demo check passed for unassigned state. Signed editor receipt UI remains untested. W01 sibling-session block and staff month-link repair passed desktop/390px demo checks. W03 direct/chat request forms passed desktop and 390px demo checks. W04 final-file form, W05 Review Room exit, W06 upload receipt and pre-shoot brief passed isolated desktop/390px checks. UX15's Kim + overdue queue filter survived job return, refresh and a copied link in the isolated browser (`530d43c`). `8eb9754`/`6d0a463` replace phone horizontal scrolling with stacked job cards and larger controls. `ede6acf` adds the editor's unread-team-message cue near work controls; signed-owner desktop/390px and concurrent-message check passed (`4729c87`). `ae07289` uses the shared structured script renderer in the per-topic brief after the existing money scrub; CP09 139/0, Node20 TypeScript/lint/build, and fenced Avery TEST desktop/390px browser passed. `2114488` leads ready-file rows with linked month/topic and exact cut, folds file detail, and labels download evidence conservatively; B4 122/0, build and fenced Home desktop/390px passed. Editing queue now follows a compact work strip, with diagnostics below and removal undo visible (signed page 15/0); stage filters are implemented with focused evidence below; browser acceptance remains. Connected-provider evidence, monthly route policy and normal creative-role tests remain. Stage filters pass 14/0 with 1,903 rendered combinations and preserve URL/brief context; browser acceptance remains open. |
| U4 | In progress | `19e7a00` adds URL-backed All/Mine/Unread/Active work filters to the shared team-conversation reader and binds program month/topic context from explicit project/video links. Mine uses the viewer's roster assignment, authored messages and direct tags; an unlinked login has no inferred ownership. Isolated signed-owner demo with TEST messages: 4 all, 1 mine, 3 unread, 3 active; opening the tagged thread lowered unread to 2; delivered August work was absent from Active. Both Communications and Editing Room preserved the filter; 390px check passed. `ce2a027` makes Mark all read wait for confirmed server state, show pending/error feedback and preserve unread on failure; server watermarks advance monotonically across tabs. Isolated comms drill 170/0 includes an old-tab rewind check; Node20 TypeScript, lint and build pass. On the fenced phone demo, a forced POST 503 kept six unread and showed the error; after removing the temporary override, a real isolated save cleared the badge. Ownership-first Tasks is committed in `958ffb7` (21/0). Role-first Home with preserved delivery controls, optional routine and all old anchors passes signed SSR 15/0. Sidebar grouping preserves destinations across 12 role/override profiles (41/0); Compact task rows and retained native detail drafts pass signed SSR/context 26/0 plus navigation 21/0; exact stored output links are validated. Browser focus/draft acceptance, live roster role and actual team checks remain. Office ad hoc task dates are committed (`625b1c6`) with signed eligibility/CAS/recovery 49/0; generated-workflow overrides require an explicit clock/sweep policy and browser acceptance remains open. |
| U5 | In progress | Reminder policy now has ordinary validated fields and canonical template previews, advanced JSON with unknown-field preservation, draft-specific validation and dirty/saved/error feedback. Config-only save preserves current switch and activation receipts, including a concurrent disable. Isolated signed-role/editor drill 27/0, lint and TypeScript passed. Seven collapsed Settings groups now have label/keyword search, loaded summaries and preserved legacy anchors; filtering retains mounted drafts. Navigation 21/0 and actual signed Settings/UI03 56/0 passed, including unchanged saved state. Core routing/turnaround/alert/wording/review forms now share snapshot-specific dirty/save/error feedback (12/0); server policy/actions remain unchanged. Call recovery now links to the existing operations queue with truthful read failures, legacy transcript evidence and unchanged access (26/0). Settings-only users keep the existing fallback. Per-person Team notifications retain newer/unconfirmed edits and folded save feedback (16/0). Schedule/email normalized receipts pass 21/0 (`0cd3d71`), automation partial/unknown feedback 12/0 (`4a189d4`) and rollout/write-scope recovery 22/0 (`3c6b2d2`). Six secondary screens share readable/focus/target patterns (`d57cbe9`), and delivery/readiness evidence uses the shared scales (`9e04cd3`). ClientWorkspace recovery is committed (`dc925a3`,21/0); exact task text receipts (`fde699a`,16/0) and month navigation (`4ee68bb`,14/0) are tested. Upload attempt recovery (`587d389`) passed PostgreSQL26/0 and UI18/0 with CP09 142/0 and B4 69/0. Remaining embedded editors/secondary tables and browser acceptance remain open. |
| U6 | Open | UA01–UA14 evidence, actual team/phone tests, screenshot set and release matrix. |

`5d52526`–`808f6fe` begin UX14/U3 keyboard work: the editor self-check and Kyle draft-update use a top-layer modal with initial focus, contained Tab, pending-aware Escape and focus return; the mobile drawer contains focus and inerts the covered page; staff now have Skip to content. Node20 TypeScript, focused lint and final production build passed. Fenced TEST keyboard replay verified six self-check answers retained after refusal, draft initial focus, drawer Tab wrap/return, and 44px controls without 390px overflow. An additional replay found repeated Escape could close the native dialog while leaving the form mounted; `808f6fe` intercepted Escape during the unsaved-answer choice. The final replay showed repeated Escape preserving the answer, Keep checking returning to Close, and deliberate Discard returning to the trigger. The disposable fixture was removed. Normal signed-role contexts, actual pending timing and the custom status menu remain.

**UX tracker:** UX01 partial (role-first Home and optional routine, signed SSR 15/0; browser acceptance open); UX02 partial (Sidebar grouping, identical role destinations 41/0; browser and route-return acceptance open); UX03 partial (`9f9213f`/`a65a6de` sampled action, secondary text and badge contrast; broader typography/zoom sweep open); UX04–UX05 partial (exact stage/save receipts and shared typography/control slices; full mounted acceptance open); UX06 partial (ownership-first compact Tasks with retained detail drafts; office ad hoc dates verified49/0; generated-workflow policy/browser open); UX07 partial (`7b07840` guided current work area, full route/booking journey open); UX08 partial (`1f2d933` draft isolation/recovery, `bc44dbf` preview/source retention and isolated rejected Save; normal suggestion account and denied-storage retry open); UX09 partial (`4ad0993` script reading/decision controls, `2162186` player/review layout, `ae07289` editor brief renderer; signed-role, failure, media and phone-download checks open); UX10 partial (`2114488` factual ready-row context, folded evidence and Download started; monthly route policy, partial-download and normal-role proof open); UX11 partial (existing team filters/context and confirmed notification saves; normal role/browser acceptance open); UX12 partial (search/groups, reminder fields and exact save/recovery slices); UX13 partial (stacked queues, wrapping shared controls and bounded player; actual responsive/zoom set open); UX14 partial (`5d52526`–`808f6fe` modal/drawer keyboard and explicit unsaved-answer choice; role, pending and status-menu checks open); UX15 partial (Editing Room URL/return complete in isolated demo, client script all-month scope labelled, appointment/library context implemented with signed fixture proof 20/0; mounted navigation/auth browser replay open); UX16 partial (first shared ModalDialog, other patterns open). C15/C16 contain truthful copy changes only; they do not close a UI phase. The original 14 UA scenarios remain unpassed unless individually recorded here.

## Current checks and environment

- **W04 mixed photo/video acceptance:** new actual-domain fixture25/0 at
  `/tmp/w04-mixed-delivery-isolation-approved/` uses real signed admin actions,
  final-file checks, manual send and automatic proof with fake Aryeo reads.
  Exact video/output stamps preserve outstanding photo correction/revision/QC;
  converse photo completion preserves current video tasks/version pointers.
  AUTH_ENFORCE remains true; disposable PGlite5793 stopped and no provider
  request escaped. Scoped lint and root review pass. No product defect or app
  change was needed. The first launch failed before execution on tsx IPC EPERM;
  approved rerun was the sole actual fixture run. Final non-incremental types exit0 at
  `/tmp/ops-hub-types-953e680.log`. App/schema/config files have no diff from the
  successful2b87cc2 build; only tests/docs changed afterward.

- **Combined application candidate `2b87cc2`:** non-incremental TypeScript
  exit0 (`/tmp/ops-hub-types-2b87cc2.log`), changed-file ESLint41 files exit0
  (`/tmp/ops-hub-lint-4681377.log`) plus the exact fixture repair lint exit0
  (`/tmp/ops-hub-lint-2b87cc2-repair.log`), and separate clean-checkout production
  build exit0 (`/tmp/ops-hub-build-2b87cc2.log`). The first candidate4681377
  compiled but type/build failed on the Map fixture's unknown React child
  annotation; two type-only lines were repaired in2b87cc2. No runtime code or
  passing behavior changed; only the failed gates were retried. Build used env-i,
  no copied env files/provider credentials and dead loopback database.
  The existing Next middleware-convention deprecation warning remains nonfatal.
  Main checkout preview was restored through the existing fenced demo script,
  reusing saved fixtures without reset: port3200 pid34961 and isolated DB/media
  5599/5598 pid34884, exec28483. It is intentionally running, not acceptance
  proof. No production process, schema, deployment or setting changed.

- **U5 Map read/keyboard recovery:** native named address combobox supports
  Arrow/Enter/Escape, IME and pointer selection without blur loss. Weather,
  home drive, address distance and suggestions keep exact pin/home/query scopes;
  late replies cannot replace a newer selection/input/overlay, and read failures
  preserve the address. Primary providers/actions, territory, mileage, coordinates
  and routes are unchanged. One focused review repaired a same-label suggestion
  skip and ensured active wrapped options scroll within the list only. Actual
  handlers/read effects36/0 (`/tmp/u5-project-map-recovery-reviewed/`), scoped
  lint/diff and root review/recheck pass. The fixture omits browser-only Leaflet
  initialization and fakes all reads; canvas/tiles/layout/provider/normal-role
  acceptance is open, not proved by hook/geometry doubles. No external read,
  booking/send or database mutation occurred.

- **U5 Team/Slack recovery:** Save/Find retains newer typed IDs after late
  results, catches failures and uses opaque current-tab unknown holds. Find
  compares the previously read ID before saving; Sync writes only a still-empty
  row, preserving intervening manual IDs. Existing matching, uniqueness checks,
  scopes and fixed test message remain. Direct DM fallback now stops on network,
  malformed, service and uncertain provider results; only documented negative
  responses retain the existing open/post fallback. Slack's primary method docs
  explicitly allow partial success for internal/fatal errors. Actual fake UI29/0,
  wrappers/CAS contract doubles15/0 and adapter transport13/0 pass, with types,
  scoped lint/diff and root review. Logs `/tmp/team-slack-recovery-fixed-fixtures/`,
  `/tmp/team-slack-action-seam/`, `/tmp/team-slack-recovery/`. No real Slack/DB/send
  occurred. Provider/browser and real DB concurrency acceptance remain open;
  markers are device guards, not backend receipts/cross-tab locks.

- **U5 capacity/calendar recovery:** record/cancel uses exact-input capture,
  synchronous pending guards, typed known refusals and visible unknown holds.
  Newer availability notes/end dates survive older success; only unchanged
  submitted note/end clear. Opaque current-tab markers survive reload without
  storing names/dates/notes. Existing self-only kinds, Eastern conversion,
  permissions and capacity/register mutation rules remain. Week disclosure keeps
  its controlled region mounted, has native expanded state and readable focus
  targets; unavailable data is distinct from a free week. Peer review found its
  new collapsed count omitted all-day entries, repaired and covered. Actual fake
  handlers/wrappers20/0 (`/tmp/u5-capacity-review-repair/`), lint/diff and source
  review pass. Prior19/1 was a numeric/whitespace fixture helper assertion,
  repaired without changing calendar behavior. No availability, reassignment,
  deadline, pay or provider data changed. Browser acceptance remains open;
  unknown writes need exact register inspection, not blind replay.

- **U5 Logins/access recovery:** one per-account guard covers role, permissions,
  link, status and removal; opaque current-tab markers hold unknown writes
  across reload without storing names, emails or tokens. Newer invite fields
  survive older success, and clipboard status uses confirmed CopyButton receipts.
  Role/permission writes compare the displayed raw baseline and use server-read
  CAS; concurrent changes cannot overwrite another grant. Reset is one atomic
  write of the same valid overridable keys as before, retaining unknown and
  owner-only keys; an explicit reset still clears a My Pay override. Existing
  owner, preview, self, role and default-pruning rules remain. Actual fake
  handlers/actions/CAS26/0 (`/tmp/u5-users-manager-recovery-final/`), typecheck,
  lint/diff and root review pass. No real user/token/invite/send changed.
  Unknown results need account/activity inspection; markers are device guards,
  not backend receipts or cross-tab locks. Browser acceptance remains open.

- **U5 month/library and office review receipts:** month refusals now show their
  exact result; unconfirmed/partial moves retain the selected month without a
  false rollback. Identity fields merge untouched refreshed values before
  constructing corrections; exact edited words/reason/destinations stay after
  late receipts. Existing identity/domain/role/allowance rules are unchanged.
  Actual fake UI/action38/0 and root review/lint/diff pass
  (`/tmp/u5-month-identity-recovery-final/`). Office fee/clock/hold controls share
  pending guards, show exact results, retain moneyEyes visibility and hold
  uncertainty with exact-record opaque markers. Actual fake handlers/wrappers/
  role visibility plus actual fee-writer CAS/read regression25/0 pass
  (`/tmp/u5-client-review-controls-cas/`). One review found a won fee write
  followed by a missing read mislabeled as refused; only its outcome annotation
  changed, repaired and narrowly rechecked. No billing, fee/clock policy,
  scripts/version or provider behavior changed. Browser acceptance remains open;
  month/identity drafts and holds are mounted-state, office markers are device
  guards rather than server receipts/cross-tab serialization.

- **U3 take-back recovery:** existing two-step cut removal/move now uses the
  native dialog, pending-aware close and retained mounted reason/search/message.
  Read failures are separate from no matching jobs. Shared exact-cut opaque
  retry markers hold uncertain dialog/file changes across remount/refresh;
  known terminal responses clear only their own marker. Refusals remain visible,
  deletion/location failures stay unconfirmed, and existing removal/file/role/
  notification sequence stays intact. Actual fake UI/action30/0, typecheck,
  focused lint/diff/root review plus narrow marker repair recheck pass
  (`/tmp/u3-cut-takeback-marker-final-approved/`). No real deletion/provider
  occurred. Native focus/phone/provider acceptance remains open; markers are
  device guards, not server receipts or cross-tab serialization.

- **U2/U5 client access recovery:** public sign-in acknowledges a request without
  proving an account or email delivery. Rejection remains unconfirmed; mounted
  invitation forms retain newer name/email/role after older success. Password
  fields are labeled and failed transport has honest feedback. Staff access
  wrappers annotate existing refusals/confirmed paths versus uncertain errors;
  opaque current-tab markers hold replay and survive refresh without persisting
  PII/password/token/link/body. Actual fake UI29/0 and wrapper10/0, typecheck,
  scoped lint/diff and root review pass (`/tmp/client-access-recovery-final/`).
  No send/session/role/rollout policy changed. Unknown results require staff
  inspection; markers are not backend terminal receipts or cross-tab locks.
  Native drafts last while mounted; real delivery/browser acceptance is open.

- **Combined committed checkpoint `d9f5306`:** non-incremental TypeScript exit0,
  changed-file ESLint123 files exit0 (three unused-variable warnings), and one
  separate-checkout production build exit0. Logs `/tmp/ops-hub-types-d9f5306.log`,
  `/tmp/ops-hub-lint-d9f5306.log`, `/tmp/ops-hub-build-d9f5306.log`.
  Build used an empty environment, no copied env files, and dead loopback DB.
  The running isolated main-checkout demo on3200 was left untouched. This gate
  covers through Resources; later access/month/review source needs a new final
  gate after its concrete repairs, not repeated whole-drill verification.

- **U5 Resources recovery:** create/update/publish/review now distinguish existing
  pre-write refusals from confirmed and uncertain outcomes. Pending submission
  blocks duplicate writes/dismissal; Close/Cancel retains editor text. ID-scoped
  sessions retain drafts and uncertainty holds when guides move groups or a
  failed list read removes and restores rows. Guide/owner read failures are
  explicit rather than empty data. Isolated actual handler/action/page fixture
  33/0, focused lint/diff and one review with a narrow remount repair recheck pass
  (`/tmp/u5-resource-recovery-stable/u5-resource-recovery.ts.log`). Publication,
  ownership and backfill rules remain unchanged. Retention is within this tab;
  unknown writes require staff inspection before another write, not auto-retry.
  Normal browser and navigation/storage acceptance remain open.

- **U5 appointment recovery:** typed confirmed/pre-write-refused/unknown results,
  retained native date/email input, sync duplicate guard, exact device marker and
  visible held refresh panel. Local prep refusals retry; unknown provider requests
  require Kyle's exact appointment/timeline/email inspection, not refresh unlock.
  Signed disposable action13/0 + fake actual UI23/0, lint/TypeScript/diff and
  focused review passed. No provider policy, booking, send or schema change;
  device guard is not server serialization or provider completion evidence.

- **U1/U5 Resources/common navigation controls:** labeled readable authoring
  fields and owner/review/publication evidence, focused44px actions/disclosures;
  shared BackLink/ShowMore preserve destinations/history/toggle behavior, with
  an explicit non-submit ShowMore button. Lint/diff/source review passed.
  Resource retention/unconfirmed feedback is verified separately above; browser open.

- **U5 appointment controls:** native shared buttons and labeled datetime field,
  existing device-local-time interpretation explained, readable facts/brief/
  feedback and focused44px targets. Conditions/provider payloads/time conversion
  unchanged; lint/diff/source review passed. Rejected provider-response feedback
  is verified separately above; browser and actual timezone acceptance remain open.

- **U1/U3 shared copy/editor controls:** exact supported clipboard receipts,
  visible denied/unavailable failures, native label/pending guard/timer cleanup,
  wrapping labeled Markdown toolbar and readable focused input. Fake actual
  CopyButton handlers 12/0, lint/diff and independent review passed. Existing
  formatting/selection/callsite values remain. Real clipboard/browser/zoom and
  combined type/build gate remain open; no sensitive values logged or real copied.

- **U1/U5 month/library controls:** native SubNav/MonthHeader picker/Skip targets,
  readable library identity/status/release text, shared badge ink and focused cut
  history overflow region; routes/all-month scope/rows/roles/pay/handlers retained.
  Lint/diff and source review passed; browser acceptance open. ClientReview
  financial forms, LibraryIdentityEditor/dialogs and MonthControls action logic
  are explicitly not migrated or acceptance-tested by this slice.

- **U3/W06 upload reconciliation:** opaque exact-attempt AuditLog receipts bind
  actor/project/payload to the atomic brief/report commit and separate terminal
  state. Unknown/unfinished submits hold replay and server autosave while newer
  local text and explicit draft-conflict choices survive. Size writes serialize
  and require their own terminal receipt after a lost response. Signed isolated
  PostgreSQL 26/0, actual handler/refresh fixture 18/0, affected CP09 142/0 and B4
  upload 69/0; lint/TypeScript/diff passed. No new schema or provider policy.
  Absent/nonterminal receipts require office request/log/handoff inspection if
  they cannot settle; no blind expiry/retry. Browser/phone/provider acceptance open.

- **Month stage navigation:** real monthly Call/Topics/Scripts/Shoot targets keep
  exact enrollment/month; unknown stage/count reasons are visible. Unneeded
  calls, missing workspaces and Delivered's all-month library stay informational.
  Pure links/SSR 14/0, lint/diff and independent review pass. Existing readers,
  next-action, library scope and permissions remain; browser/card layout open.

- **U4 task text receipts:** newer notes/reply drafts survive older async
  completions, with read-only AI suggestion evidence and honest Cancel handling.
  Fake handler/receipt 16/0 plus retained signed rows 26/0, lint/TypeScript/diff
  and independent review pass. No send/recipient/domain policy changed; mounted
  browser interaction remains open.

- **U5 client workspace reliability:** retained section drafts, snapshot-specific
  AI result/copy receipts, explicit failures and distinct partial notes saves
  passed delayed-promise/first-paint 21/0, lint, TypeScript and focused review.
  Existing handlers/provider policy remain; actual mounted browser acceptance
  remains open. No real copy/send/provider was executed.

- **U4 office ad hoc dates:** same existing manual/explicit-instruction creation
  rules, strict date→5pm Eastern, transaction eligibility/date CAS and atomic
  audit; exact read-only recovery retains the chosen draft. Signed isolated
  49/0 plus retained task detail regression 26/0, lint/diff and review pass.
  Generated workflow clocks stay protected; their override policy and browser
  acceptance remain open. No project/output/work/pay clock changed.

- **U3/U5 evidence readability:** delivery/readiness use shared status/body type,
  44px controls and visible focus. Native GET check, separate readiness facts,
  exact file links and all state/rollout behavior are retained. Lint/diff and
  independent source review passed; rendered/browser acceptance remains open.

- **U5 secondary presentation:** Clients list/workspace, Resources landing/role
  guide and Team directory/member detail now use readable type, native/shared
  action targets, focus and wrapping. Focused lint/diff and source review passed;
  handlers, queries, role gates and pay math retained. Browser acceptance and
  remaining secondary tables/embedded editors stay open. ClientWorkspace's
  confirmed draft/AI/clipboard defects are committed and tested21/0 (`dc925a3`).

- **Connected client production handoff:** signed normal named-pilot action
  scenario 19/0 now couples login, strategy/bank, written month, exact scripts,
  filming task/provider input, two-output creative handoff, manual Start/Pause,
  James's revision, checked v2, final fixture, client approval/download and
  revocation. New stale staff cut and client finishing guards plus post-verdict
  issue-version CAS passed real multi-session PostgreSQL 11/0, typecheck/lint
  and focused source review. See handoff for exact logs and fixture preconditions.
  This closes server-action coupling gaps; browser, real providers/media,
  policy and launch/activation acceptance remain open. The production schema gate is now complete under the Oct 1 release checkpoint; code promotion and deployment HTTP smoke passed; normal journeys remain open.

- **U5 rollout/write-scope recovery:** loaded details, confirmed receipts and
  unrelated drafts survive read failures; unknown mutations require a successful
  read-only Refresh. Partial access-release and stale preview context are explicit.
  Mocked operations/SSR 22/0, lint/diff and review pass. No domain action or actual
  activation/send was executed. Browser interaction and stable build remain open.

- **U3 exact-cut review:** truthful historical/client/creative stage wording,
  visible checked-fix IDs, retained newer note/reply input and explicit unknown
  outcome recovery are implemented. Fake-action/read-generation/SSR 15/0,
  lint and focused review pass. Legacy no-check policy is retained. Browser
  refresh/late-input and complete W03 per-cut stage acceptance remain open.

- **U5 automation confirmation:** errors identify the attempted stage, partial
  backlog saves require a fresh recorded batch, unread transcript audiences and
  stale responses cannot confirm activation. Pure fake-action/SSR 12/0,
  lint/diff and focused independent review pass. Switches/actions/rollout remain
  unchanged; stable build and browser pending/failure acceptance remain open.

- **U5 schedule/email receipts:** stable rows and normalized snapshot receipts
  preserve newer edits; saved-empty/rota/preset and enabled flags remain distinct.
  Isolated 21/0, lint/diff and focused review pass. Final stable integration gate
  and actual browser late-save/refresh remain open. No action/policy changes.

- **W03 saved-receipt recovery:** missing/partial issues and timing retry safely from immutable saved metadata. Exact original version and editor survive a newer cut; legacy closed/moved/unknown cases refuse. Real PG 22/0 plus existing W03 26/0, lint/review pass. Receipt-first intake is now committed (`967b11b`), with real PG24/0 and PGlite26/0; browser/provider proof remains open.
- **Integrated build:** committed candidate through `c5e619e` passed isolated production build + TypeScript (exit 0, `/tmp/ops-hub-build-c5e619e.log`). W03 and later active batches are not covered by this build.

- **U4 task navigation:** My work / Needs assignment / All work / Completed lead the operational board; specialist Replies/Revisions/Slack remain visible. Legacy URLs, editor restrictions, Kyle's routine ownership, test view and source/type/owner filter state are preserved. Signed route/board drill 21/0, focused lint and review passed. No task mutation or provider calls. Browser, compact rows/detail drawer and external return-context acceptance remain open; Home composition is separate.

- **U1/U3 queue controls:** shared ActionMenu now covers status/rare actions with keyboard navigation and 44px targets; office overrides reuse native ModalDialog and block dismissal during pending saves/escalation. Failed removal retains the reason for retry. Original guards, request IDs, confirmation and undo remain. Lint/source review passed; final integrated type/build pending after the last modal correction. Browser acceptance remains blocked, so neither phase is complete.

- **Latest resume:** interrupted `cd3fc86` production build exited 0 in the isolated managed checkout; stable-tree TypeScript passed. No Ops Hub commands or 3200/5599 listeners remained at the resume check; unrelated Premium Reel commands were untouched. Earlier running-demo notes below are historical.
- **C14 Home summaries:** owner project totals, delivery/reply/SLA/QC dials, active-edit count, personal flags, handled-today and operational pulse fields now use the same normal client scope. Isolated drill 15/0, focused lint, TypeScript and one source review passed. Deleted/unlinked markers and catch-up context survive; bank/ledger/AR formulas and stored state remain unchanged. Initial test date/appointment assumptions were corrected. Signed-browser identity and summary test-view UI acceptance remain open; do not mark all C14 acceptance complete.

- `npm run build` passed on Node 20 after the Edge-compatible drill backstop correction.
- Focused lint and TypeScript passed for changed files; existing unrelated lint warnings remain in older code.
- Five isolated drills passed, 479 checks total: delivery truth 22, real Postgres Start 76, draft topics 138, rollout scope 112, isolation boundary 131. No skips or failures.
- C13 follow-up: isolated UI-01 and CP-10 drills passed 215 checks including three new assertions; B2 planning passed 151 existing checks. Production build and focused lint passed after this patch.
- C18 guard: isolated Postgres drill 11/0 and existing per-property reply drill 108/0. The named live record was inspected read-only; no private access text was printed or changed.
- The normal `next dev` on port 3000 was gone at takeover. The managed isolated demo worktree is clean at `21aa4aa`. The interrupted production build emitted BUILD_ID, required-server-files and a completed final next-build trace at Sep 30 20:58 ET; its terminal exit code was lost. Resume process inspection found no Ops Hub build/dev/test/migration/deployment process. The unrelated Premium Reel Next14 server on port 3100 was left untouched. A later 21:12 ET process snapshot found `scripts/demo/run-demo-dev.sh` started at 21:02 from the main checkout, with the isolated fenced demo on 3200/5599. It was identified and left running; do not build into this checkout’s `.next` while it runs. The temporary modal keyboard route was removed and the worktree is clean. The Kim/overdue, unknown-text, team-conversation and bounded-read fixtures are disposable demo data. The forced notification POST failure was a temporary demo-worktree edit and was removed.
- C05/C06/W04/W06/W02 have a local additive schema diff for `ClientBrandReceipt`, `DeliveryFollowUpHealth`, `FinalRenditionCheck`, `ShootBriefRead`, and `EditorBriefReceipt`; none has been applied to the live database. The last read-only backup and migration-state checks preceded these local edits. No production database write, provider write, or deployment was made. Recheck the diff and backup immediately before an approved release; never reset or seed the shared database.
- C11 read-only live `transcriptQueueBatch()` verified the five-job backlog, off switch, default historical hold and two AI jobs. Stage A and monitoring changes passed Node 20 TypeScript, focused lint and production build. Isolated browser on the `47ea1d1` batch with a six-job fixture verified the off-switch/backlog/AI-credit text and Settings link at desktop and 390px phone width; a spacing follow-up was visually replayed. Real-model result remains open.

### Latest signed journey checkpoint

- `client-written-journey`: 23 passed, 0 failed, including a new shared version invalidating the old client decision without changing old words. The second acceptance exposed a script-wide notification key that suppressed the office notice; it now includes the accepted version. Both versions notify once, and same-version retries add neither a decision nor a notice. Real login route/session and staff/client actions; isolated database and request-cookie transport. No browser or real-model/media-provider proof.
- `cp06-brand-setup`: 130 passed, 0 failed after correcting only its disposable pilot fixture.
- `w04-final-rendition`: 34 passed, 0 failed under enforced signed role sessions, including unauthorized public action refusals and exact-output completion.
- These checks are local only; no schema rollout, push, deployment, client send or enabled automation.

- W03 concurrency repair: signed role/action proof passes on disposable Postgres (26/0). Earlier activity and attachment attempts remain outside the receipt transaction; the test makes no attachment/provider call.

- C14 Comms/Outbox/delivery batch: focused lint passed (one pre-existing warning). The shared typecheck caught two in-flight drill fixture typing errors (required roster email and optional boolean), both corrected; no source errors reported. Final stable-tree typecheck/build pending.

### Latest role and filming checkpoint

- C01 preview sync fixed; actual signed page function 16/0, configured fake provider. C07 signed receipt actions 13/0; no source defect.
- CP09 filming handoff now runs with AUTH_ENFORCE=true, an actual signed assigned photographer, and explicitly assigned disposable shoots: 142/0. Includes report failure/retry, exact script/topic/video binding, Pro session chronology, fake Dropbox partial/retry behavior, plus other-photographer and preview refusal. A test-ordering error was corrected before the final passing run. This is action/fixture evidence, not browser/raw-phone-upload acceptance.
- These changes remain local; final stable-tree typecheck/build is still pending.

- C14 Slack/Done: 12/0, focused lint passed with the existing queries.ts warning. No real model or provider request. Stable-tree typecheck/build still pending. Partial work from the two credit-exhausted agents was preserved and finished locally for this batch; their UI action-menu task made no source change.

- `client-call-journey`: 25/0, six fake model responses, zero external requests/outbox/booking rows. Lint passed. Shared typecheck read the draft script before its invalid version-month predicates were corrected; final stable rerun is pending. Recovery code changes no queue, scope, backlog, approval or send policy.

## October candidate inventory

SELECT-only report at `/private/tmp/realtour-launch-candidates-2026-10-final.json` (0600, outside Git), checked Sep 30 22:33 ET: 13 active non-synthetic candidates, 0 recorded active client login seats, 0 released strategies, no canonical approved available topic bank, and 3 October workspaces. No section read failed. This is not an approved launch roster or browser acceptance. Jordan confirms the initial roster; Kyle/Jordan resolve exact identity/source conflicts and prepare strategy/bank/seats before invitations. This historical 13-candidate inventory has not been refreshed. Existing worker, backlog, rollout and client-send restrictions stay in force; the Oct 1 production deployment authorization supersedes the historical deployment prohibition only. The current raw totals of 2 active ClientUser records / 3 unrevoked memberships above do not establish real-client seat readiness. Reusable guarded reader: `scripts/_recon/launch-inventory.ts`.
