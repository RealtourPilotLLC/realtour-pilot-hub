# Ops Hub audit — current resume point

Use this page first. The full backlog is in
`audit-2026-09-30-checklist.md`; acceptance and release boundaries are in
`audit-2026-09-30-release-matrix.md`; `handoff.md` preserves batch history.
Do not restart the audit or repeat green checks without a specific changed risk.

## Checkout and execution boundary

- Main checkout: `/Users/jordanspackman/Realtour Pilot POT Dashboard`.
- Working branch: `codex/audit-2026-09-30`. Last recorded completed source
  checkpoint: `2b87cc2` (Map fixture type repair after source4681377);
  inspect actual HEAD/status when resuming.
- Use Node 20.20.2 at `/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin`.
- Local `.env` is live production. No reset/seed, live mutation tests, client
  messages/invitations, real bookings, financial changes, automation activation,
  branch push or deployment is authorized.
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
  Last observed clean/detached at `2b87cc2`, whose clean-environment build passed.
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

These are local commits. None is a takeover deployment, activation or new
client-visible release. Signed action/SSR/fake handler evidence is not mounted
browser, real provider/model output, real rendition/watch or phone-file proof.

## Active slice and next safe checkpoint

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
ownership and backfill rules remain intact. No real mutation is authorized.

The Resources checkpoint passed combined gates. Access, month/identity,
review fee/clock/hold, take-back and Users recovery now have completed local
source/targeted checks. Capacity/calendar now has fixture20/0, lint/diff and
peer review with one all-day count repair. Its earlier numeric/whitespace
assertion was repaired in the fake helper. Slack source/targeted checks are
complete:29/0 UI,15/0 wrapper/CAS doubles,13/0 fake transport and types/lint/review.
Map's last bounded batch is complete locally with36/0, lint/diff and root review
including exact skip/scroll repairs. Combined types/changed-file lint/separate
build passed at2b87cc2. Only the intentionally running demo and one new bounded
W04 mixed photo/video acceptance fixture remain active. The new fixture closes
the existing final-rendition fixture's photoCount0 coverage gap; no production
mutation/provider or app source change is authorized. Finish that fixture,
checkpoint evidence and align the ledger. Application files have not changed
since the passing build; any later fixture-only change needs its relevant type/
lint check, not automatic repeats of green app behavioral suites.
Do not repeat already-passed whole drill suites. Business and browser acceptance
remainders below stay open; this continuation is not a new broad audit.

## Required release and business remainders

- Normal browser UA01–UA14, Kyle/James work-finding observations, actual phone
  upload/download, rendered contrast/zoom/screenshots and provider/media evidence
  remain open. U0–U5 are partial; U6 is unaccepted.
- Five additive tables are unapplied: ClientBrandReceipt,
  DeliveryFollowUpHealth, FinalRenditionCheck, ShootBriefRead, EditorBriefReceipt.
  Backup/migration state was recorded in the checklist. Recheck current diff and
  coverage immediately before an approved schema release; no schema was applied.
- Last guarded private launch inventory (Sep30 22:33 ET) had 13 active candidates,
  zero active client login seats, zero released strategies and no approved
  available topic bank. Three October workspaces existed. The export is private
  outside Git; this is launch preparation evidence, not permission to invite.
- Jordan: monthly portal/Aryeo destination rule, intentional no-brand/reassignment
  receipt policy, correct general-welcome destination and intended first roster.
- Kyle: verify exact C13 historical links, C18 wrong-property source, Sarina's
  owed scope/topic binding and identity conflicts before any live repair.
- Generated-task date override policy remains open; ad hoc edits preserve
  existing creation rules and cannot alter editing/revision/SLA clocks.
- Transcript worker remains off; five held historical jobs are excluded by its
  default first-on backlog. No automation, audience, saved settings or activation
  decision changed.

See each C/W and UA row for the concrete next acceptance step. The platform
must not be declared finished or ready to onboard while these journeys are open.
