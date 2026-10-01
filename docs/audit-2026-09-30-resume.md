# Ops Hub audit — current resume point

Use this page first. The full backlog is in
`audit-2026-09-30-checklist.md`; acceptance and release boundaries are in
`audit-2026-09-30-release-matrix.md`; `handoff.md` preserves batch history.
Do not restart the audit or repeat green checks without a specific changed risk.

## Current checkpoint — portal status repair verified, release preparing

The user now requests production deployment after each verified checkpoint.
The prior application release below remains live until this checkpoint passes
its exact build, protected stage, promotion and unchanged-state checks.

Focused follow-up found a concrete cache gap: monthly portal markers were
missing from library cache derivation. Downloads stayed gated, but cached
DELIVERED/final pointers and page fallback could advertise an unapproved cut.
The repair uses canonical marker facts before cache writes and validates marked
cached rows on reads. Unreadable/stale status uses existing unavailable panels
in both portal layouts; no local reconstruction grants release. Isolated real
PostgreSQL/domain/routes/cache and actual both-layout page SSR pass 35/0.
Focused peer/root review, non-incremental TypeScript and six-file ESLint pass.
Logs: `/tmp/monthly-portal-approval-cache-page/`,
`/tmp/ops-hub-cache-http-types.log`, `/tmp/ops-hub-cache-http-lint.log`.

Actual built Next HTTP acceptance against e6eac69 passed 37/0: password/cookies,
role middleware, owned and foreign work, one-use client sign-in, seven portal
tabs, exact script/cut approval, download/range bytes, and manual Start/Pause.
Disposable DB5601/media5602/Next3211 were stopped; main3200/5599/5598 preserved.
Logs: `/tmp/normal-role-http-acceptance/`,
`/tmp/normal-role-http-acceptance-run.log`. This closes transport checks only;
mounted browser/phone/provider/full-watch acceptance remains open.

W05 automatic exact provider-echo settlement for held delivery texts is verified
locally in a separate checkpoint:36/0 real PG/actual webhook tests, lint/types0
and focused review clear. Pre-intent provider time is refused. Ambiguous/unsigned/stale proof stays held; no retry/send,
new manual authority, schema or activation is included. Optional manual
settlement and generated-workflow date policy questions remain pending. Exact
commit/build/release follow the cache checkpoint; port5972 is stopped. Evidence
is `/tmp/w05-delivery-echo-recovery-final-source/`.

Fresh SELECT-only active-candidate launch inventory at 16:11:14Z found 13 real
candidates, 13 October workspaces, zero active eligible real-client seats,
zero released strategies and zero canonical approved available topics. No
audience has been approved. The private preparation plan and exact C13/C18/
Sarina reconciliation proposal are ready for staff source review; no business
record was repaired. Browser access is still blocked by the supported tool's
explicit policy rejection; do not work around it. See the C14/U6 acceptance map.
U0–U5 remain partial and U6 open. Real-client onboarding is not accepted.

## Previous checkpoint — policy code deployed, launch acceptance open

Production now serves `e6eac69f1d41` at https://hub.realtourpilot.com, Ready
`dpl_7UpNA2AXJsCdiGEAeopg7iUHkbMv`, promoted Oct1 11:47 AM EDT. Exact local/remote
build, protected stage smoke, canonical version/login/assets/auth gates and
read-only settings/automation/seat comparison passed. No settings changed;
rollout TEST_ONLY and stored automation OFF remain. No client send/invite, real
booking, financial change, activation or Git push. See
`audit-2026-10-01-policy-release.md` and its sanitized evidence.

Commits 7220dca/0334622/148440a/974327f/e6eac69 implement the approved welcome,
no-brand/returning-editor receipt and portal/exact Dropbox policies. The atomic
portal marker preserves exact client approval/download/caption and legacy rules.
Backend 41/0, approval gate 21/0, W02 44/0, welcome 26/0 and affected checks pass.
Held 974327f stage is superseded and must never be promoted. Build checkout is
clean/detached e6eac69; the main3200 fenced preview remains intentional.

At that checkpoint no further autonomous source gap had been identified. The
cache follow-up and W05 proof recovery above supersede that conclusion. Do not
restart the audit or repeat green suites. Next work needs supported browser
access for UA01–UA14/U6 and phone/provider/media acceptance, Jordan's first real
roster, Kyle's exact C13/C18/Sarina source reconciliation, and prepared released
strategy/topic bank/eligible seats. Generated-workflow date overrides and W05
manual unknown-text settlement questions remain pending; existing clocks and
no-blind-resend holds stand. U0–U5 are partial; U6 is open. The platform is not
accepted for real-client onboarding.

## Checkout and execution boundary

- Main checkout: `/Users/jordanspackman/Realtour Pilot POT Dashboard`.
- Working branch: `codex/audit-2026-09-30`. Latest application release:
  `e6eac69f1d41f4697a9cb64c8011644be458a3ea`; exact build/release evidence is in
  `audit-2026-10-01-policy-release.md`. First-release source evidence at
  `2b87cc2` and mixed-handoff953e680 remains historical.
  At first-release3c3c2d7, the fresh main fetch found no missing main commits;
  that candidate was161 commits ahead. No push/main merge followed.
  Inspect actual HEAD/status when resuming; do not overwrite local work.
- Use Node 20.20.2 at `/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin`.
- Local `.env` is live production. On Oct 1 the user explicitly authorized
  production deployment of the committed work. The reviewed additive schema was
  applied under that release authorization; remote build and promotion passed.
  Canonical production now serves e6eac69f1d41; first-release 3c3c2d7 is rollback. This supersedes the historical deployment prohibition
  only. No reset/seed, live mutation tests, client messages/invitations, real
  bookings, financial changes or automation activation is authorized. A branch
  push is not part of this release.
- The prior isolated demo used port 3200 and the main checkout's `.next`. It
  was absent at an earlier resume check. Latest Oct 1 inspection found a new
  `scripts/demo/run-demo-dev.sh` process started at 00:38 ET, with the fenced
  demo database and Next server on port 3200 in the main checkout. It is left
  running at that check. At Oct 1 01:32 ET the process and port3200 listener were
  absent; no process was stopped or restarted by this continuation. Inspect
  before any build/start.
  This continuation subsequently restored the inspected fenced demo without
  reset for user review:3200 pid34961, isolated DB/media5599/5598 pid34884,
  exec28483 intentionally running. Private log `/tmp/ops-hub-demo-resume-2026-10-01.log`
  is0600 and contains synthetic one-time links; never stage/publish it.
- Build checkout:
  `/Users/jordanspackman/.codex/worktrees/audit-visual-check/Realtour Pilot POT Dashboard`.
  Advanced by inspected fast-forward to clean/detached `e6eac69` for the
  latest successful remote release; exact clean Node20 build and remote gates pass.
  Non-incremental types and changed-file lint (41 files plus type-only fixture
  repair) passed; logs are in the checklist/handoff.
  Advance only
  with an inspected fast-forward to an exact committed candidate; use a clean
  environment and dead loopback DB. Never copy production env/credentials there.
- Browser access was rejected by tool policy. Do not bypass with another
  browser transport/CDP or treat the ambient local tab as fresh authorization.

## Completed since the prior build candidate

| Checkpoint | Scope | Evidence |
|---|---|---|
| `f25a7b8` / `967b11b` | W03 receipt retry and immutable intake | Existing W03 real PG 26/0; retry 23/0; intake PG24/0 and PGlite26/0 |
| `cb6ed54` / `0966195` | Editing queue first; preserved stage URLs | Signed page15/0; stage/context14/0 |
| `cd0392d` / `afb0f97` | Call recovery/evidence | Signed/action26/0; transcript wording17/0 |
| `59bdb31` | Compact tasks with retained detail |26/0 and navigation21/0 |
| `018f22f` / `8d06490` | Native shared controls and typography |9/0, Settings12/0; source/lint for typography |
| `7d79c3e` / `0cd3d71` | Team/schedule/email save receipts |16/0 and21/0 |
| `c74db96` / `fcc476a` | C14 Home and Office Editing/Schedule scope |22/0 and23/0; affected15/0 and14/0 |
| `4a189d4` / `3c6b2d2` | Honest automation/rollout recovery |12/0 and22/0; no actual switches called |
| `9b506d8` | Exact review stages/drafts/recovery |15/0 fake action/SSR |
| `7cb9e03` | Connected client journey; exact cut/issue approval guards |19/0 connected; PostgreSQL11/0 |
| `d57cbe9` / `9e04cd3` | Secondary screens and delivery/readiness type/focus |Focused lint/diff/source review; browser open |
| `625b1c6` | Office ad hoc task date CAS/audit/recovery |49/0; retained details26/0 |
| `dc925a3` | Workspace tab/AI/copy/partial note receipts |21/0; non-incremental typecheck/lint |
| `fde699a` | Newer task notes and reply drafts |16/0; retained details26/0 |
| `4ee68bb` | Real month-stage destinations, visible unknown evidence |14/0; review caught and removed falsely month-scoped library link |
| `587d389` | Exact upload/size recovery and retained draft-conflict holds |PostgreSQL26/0; hook/refresh18/0; CP09 142/0; B4 69/0 |
| `1570ba5` | Month/library readability, focus and exact history |Lint/diff/source review; browser open |
| `a642e79` | Exact clipboard receipts and native Markdown controls |Fake clipboard handlers12/0; lint/review; browser open |
| `681030b` / `f154bb4` | Appointment/Resources authoring and common navigation |Lint/diff/source review; behavior fixes separate |
| `9a721dc` | Appointment uncertainty and retained date/email choices |Signed fake-provider action13/0; actual form/refresh23/0; lint/types/review |
| `d9f5306` | Guide drafts/read failures/uncertain-write recovery |Actual handler/action/page33/0; remount repair reviewed; combined types/lint/build |
| `8f708b7` | Privacy-generic sign-in and newer invitation drafts |Actual fake UI29/0 + wrapper10/0; typecheck/lint/root review |
| `aab1f99` | Native exact-cut dialog and retry recovery |Actualfake30/0; typecheck/lint/review and narrow remount recheck |
| `59af2da` | Identity/month and office fee/clock/hold receipts |Actualfake38/0+25/0; lint/review; fee CAS/read ambiguity repaired |
| `5ae370a` | Shared account recovery, atomic reset and role/permission CAS |Actual fake26/0; typecheck/lint/diff/root review |
| `6972796` | Exact newer drafts/unknown guards and native calendar disclosure |Actual fake20/0; lint/diff/peer review; all-day count repair |
| `41c8baf` | ID/save conflict and uncertain-DM recovery |Actual fake UI29/0; wrappers15/0; transport13/0; types/lint/review |
| `4681377` | Exact-pin reads and keyboard/pointer suggestions |Actual fake36/0; lint/diff/root review with narrow skip/scroll repairs |
| `2b87cc2` | Map fixture type-only boundary; combined candidate |Non-incremental types0; ESLint41 files+repair0; isolated build0 |
| `953e680` | Exact mixed photo/video final-delivery separation |Actual signed/domain fixture25/0; lint/root review; final non-incremental types0; no app changes |

These commits are included in the Oct1 production candidate3c3c2d7.
No automation or real-client rollout was activated. Signed action/SSR/fake handler evidence is not mounted
browser, real provider/model output, real rendition/watch or phone-file proof.

## Oct 1 authorized release — schema applied, candidate deployed

- Exact candidate: `3c3c2d741aaf7a30d6c5fe1314fbb6611348e0e3`.
  Production before release: build `bf2e0b48a0dd`, Vercel deployment
  `dpl_8Je8ULY9Pf6sy3asVwjtrCKvTXzj`.
- Fresh private backup:
  `/Users/jordanspackman/rtp-backup-2026-10-01-predeploy.json`, 144/144 models,
  118,636 rows, 211,904,272 bytes, mode 0600; snapshot
  `2026-10-01T13:44:46.972Z`. Full-stream counts, ID hashes and schema coverage
  were verified; checksum
  `52ab7390a31cf5eb3762959dcef16df0baef001590e968b575a31f06642fa691`.
  The backup remains private outside Git.
- The five additive tables (`ClientBrandReceipt`, `DeliveryFollowUpHealth`,
  `FinalRenditionCheck`, `ShootBriefRead`, `EditorBriefReceipt`) were applied
  atomically as 14 DDL statements at `2026-10-01T13:54:34.540Z`.
  Live postflight verified 149 tables, 12 indexes for these additions
  (5 primary-key indexes + 7 others), 2 validated foreign keys, all five new
  tables empty, and schema diff exit 0. No schema ledger, reset, seed or backfill
  was created or run.
- Vercel remote compile/types/build passed; staged version and login responses
  were checked with authenticated Vercel requests, retaining deployment protection.
  Promotion succeeded: dpl_FaUomN98Qz8EDuFnUopYgtnt55HS (r6ajwlsup), canonical
  https://hub.realtourpilot.com serves 3c3c2d741aaf. HTTP version/login/assets/auth
  redirects and old-host redirect passed. Anonymous portal uses a verified
  streamed sign-in redirect. See `audit-2026-10-01-production-release.md`.
  Normal-role/browser/client visibility and launch acceptance remain open.
- Before release, the stored automation inventory had 1 row, off, and rollout
  defaulted to `TEST_ONLY`. Raw totals were 2 active `ClientUser` records and
  3 unrevoked memberships; these counts do not identify real client seats.
  The historical 13-candidate launch inventory below has not been refreshed.
  Deployment authorization does not authorize sends, invitations, bookings,
  financial changes, automation activation or rollout expansion.

## Policy implementation and release history

Historical held-stage checkpoint, resolved by the e6eac69 release above:
policy commits 7220dca,0334622,148440a,974327f are
preserved. Candidate 974327f clean/local and remote builds passed; stage
`https://realtour-pilot-br6mfk7cs-realtour-pilot-s-projects.vercel.app` completed
successfully, but **must not be promoted**. Protected stage smoke passed and
canonical stayed3c3c2d741aaf at15:39:27Z. A concrete entitlement regression was
found: a new portal handoff reused the historical external-send stamp and could
unlock downloads/captions before approval. The focused repair is frozen in
monthlyFinal.ts/cutEntitlement.ts and two fixtures: atomic marker 41/0 and signed
approval gate 21/0, lint0. Combined types0 and focused peer/root review pass.
The repair was then committed, the build checkout advanced, exact builds/stage
passed and only e6eac69 was promoted. These gates are complete; do not repeat
them without a new changed risk. No schema change or live backfill.
Preserve the held stage receipts under `/private/tmp/ops-hub-policy-release-2026-10-01`.
At the held-stage checkpoint the intentional preview remained running; no stalled deployment command remained.

User decisions received after release: monthly finals go to the portal with a
backup in the final Dropbox folder; intentional no-brand requires acknowledgment;
returning an editor after reassignment requires a fresh receipt. General welcome
strategy calls use https://calendly.com/realtourpilot-info/strategy-call.
These decisions are approved but not yet implemented in3c3c2d7. Next batch must
align exact final/backup evidence and receipt generations, preserving property
Aryeo delivery and dedicated monthly Calendly mapping. Do not send or activate.

C19 source is now prepared locally: approved general default/fallback, fixture26/0,
scoped lint and root review. Fresh guarded production read found no `auto_texts`
row, so no stored settings write was needed or performed. The new default takes
effect only with its release. W02 source and signed PostgreSQL fixture44/0 are
complete locally, with affected15/0 and61/0, lint and focused repair review.
Intentional no-brand and returning-editor receipts are separate from Start/Pause.
Monthly source is now complete locally with final backend40/0, UI19/0, affected listing
34/0 and mixed25/0, lint/diff and focused repair review. Final non-incremental types
pass (`/tmp/ops-hub-monthly-final-types.log`). Preserve all source and continue to
the exact clean build/release. Mounted browser/phone/provider acceptance remains
open. Supplemental legacy source/backup equality proof after 148440a passed lint
and non-incremental types0 (`/tmp/monthly-final-legacy-types.log`). Do not repeat
completed drills.

## Earlier source checkpoint

Upload reconciliation now has exact actor/project/payload-bound AuditLog
core/terminal receipts, authorized read-only recovery and retained local drafts.
Uncertain submits, size writes and existing draft-conflict choices hold replay
and server autosave; newer text stays mirrored. Isolated PostgreSQL 26/0, UI
hook/refresh 18/0, affected CP09 142/0 and B4 69/0 pass, as do lint/TypeScript.
No new schema. If an absent/core_saved receipt cannot settle, office staff must
inspect its request logs and saved handoff/task/notification evidence; no blind
retry/expiry is offered. See handoff for logs and actual browser/provider limits.

Appointment and Resources recovery are now verified local source batches.
Typed known refusals versus unknown outcomes retain native/editor drafts and
hold replay; guide/owner failures remain explicit. Appointment device markers
are not provider receipts; Resources retention is current-tab only. Unknown
requests still require staff inspection. Provider/notify, validation/publication,
ownership and backfill rules remain intact. Those batches used no real mutation;
the only current production write authorization is the reviewed schema/release.

The Resources checkpoint passed combined gates. Access, month/identity,
review fee/clock/hold, take-back and Users recovery now have completed local
source/targeted checks. Capacity/calendar now has fixture20/0, lint/diff and
peer review with one all-day count repair. Its earlier numeric/whitespace
assertion was repaired in the fake helper. Slack source/targeted checks are
complete:29/0 UI,15/0 wrapper/CAS doubles,13/0 fake transport and types/lint/review.
Map's last bounded batch is complete locally with36/0, lint/diff and root review
including exact skip/scroll repairs. Combined types/changed-file lint/separate
build passed at2b87cc2. The bounded W04 mixed photo/video acceptance fixture
passed25/0, lint and root review; disposable DB5793 stopped. It closes the older
final-rendition fixture's photoCount0 coverage gap without app changes. Final non-incremental types passed at953e680;
`git diff 2b87cc2 HEAD` shows no app/schema/config changes after the successful
build. At that final local checkpoint only the intentionally running demo
remained; no test/build/migration/deployment was active or stalled, and no
approval was waiting. That process snapshot is historical. The current Oct 1
release applied schema, passed the remote build and promoted3c3c2d7 with verified
canonical HTTP smoke. The next batch is the approved policy alignment. The blocked
normal-role browser/phone/provider acceptance and business decisions below
remain. Keep broader UI comparison on the checklist. Do not
repeat green suites or restart investigation; inspect process/HEAD state first
on the next resume and act on the specific restored access or decision.
Do not repeat already-passed whole drill suites. Business and browser acceptance
remainders below stay open; this continuation is not a new broad audit.

## Required release and business remainders

- Normal browser UA01–UA14, Kyle/James work-finding observations, actual phone
  upload/download, rendered contrast/zoom/screenshots and provider/media evidence
  remain open. U0–U5 are partial; U6 is unaccepted.
- The five additive tables are applied and their live schema diff is empty;
  backup and postflight evidence are recorded above and in the checklist.
  Remote build, promotion, exact-version HTTP smoke and rollback evidence passed.
  Normal journeys remain open. Preserve additive tables/receipts during code rollback;
  never reset, seed or replay an ambiguous delivery.
- Last guarded private launch inventory (Sep30 22:33 ET) had 13 active candidates,
  zero active client login seats, zero released strategies and no approved
  available topic bank. Three October workspaces existed. The export is private
  outside Git; this is launch preparation evidence, not permission to invite.
- Jordan resolved monthly destination, no-brand/reassignment and welcome URL;
  their source is deployed at e6eac69. Intended first real roster still needed.
- W05 manual-versus-automatic unknown-text settlement is a pending business
  question; preserve the current evidence/unknown hold and never blindly resend.
- Kyle: verify exact C13 historical links, C18 wrong-property source, Sarina's
  owed scope/topic binding and identity conflicts before any live repair.
- Generated-task date override policy remains open; ad hoc edits preserve
  existing creation rules and cannot alter editing/revision/SLA clocks.
- Transcript worker remains off; five held historical jobs are excluded by its
  default first-on backlog. No automation, audience, saved settings or activation
  decision changed.

See each C/W and UA row for the concrete next acceptance step. The platform
must not be declared finished or ready to onboard while these journeys are open.
