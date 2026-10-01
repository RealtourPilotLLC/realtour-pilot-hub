# Ops Hub audit — current resume point

Use this page first. The full backlog is in
`audit-2026-09-30-checklist.md`; acceptance and release boundaries are in
`audit-2026-09-30-release-matrix.md`; `handoff.md` preserves batch history.
Do not restart the audit or repeat green checks without a specific changed risk.

## Checkout and execution boundary

- Main checkout: `/Users/jordanspackman/Realtour Pilot POT Dashboard`.
- Working branch: `codex/audit-2026-09-30`. Last recorded completed source
  checkpoint: `d9f5306` plus the access recovery commit containing this update;
  inspect actual HEAD/status when resuming.
- Use Node 20.20.2 at `/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin`.
- Local `.env` is live production. No reset/seed, live mutation tests, client
  messages/invitations, real bookings, financial changes, automation activation,
  branch push or deployment is authorized.
- The prior isolated demo used port 3200 and the main checkout's `.next`. It
  was absent at an earlier resume check. Latest Oct 1 inspection found a new
  `scripts/demo/run-demo-dev.sh` process started at 00:38 ET, with the fenced
  demo database and Next server on port 3200 in the main checkout. It is left
  running; no process was stopped or restarted. Inspect before any build/start.
- Build checkout:
  `/Users/jordanspackman/.codex/worktrees/audit-visual-check/Realtour Pilot POT Dashboard`.
  Last observed clean/detached at `d9f5306`, whose clean-environment build passed.
  Main-checkout non-incremental types and changed-file lint passed at that SHA.
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
| Access commit containing this update | Privacy-generic sign-in and newer invitation drafts |Actual fake UI29/0 + wrapper10/0; typecheck/lint/root review |
| `8f708b7` | Client access recovery |See exact29/0+10/0 evidence above |
| Take-back commit containing this update | Native exact-cut dialog and retry recovery |Actualfake30/0; typecheck/lint/review and narrow remount recheck |
| `aab1f99` | Take-back recovery |Exact30/0 evidence above |
| Month/review commit containing this update | Identity/month and office fee/clock/hold receipts |Actualfake38/0+25/0; lint/review; fee CAS/read ambiguity repaired |

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

The Resources checkpoint passed combined gates. Remaining concrete local forms
are in progress: month/identity receipts, review fee/clock/hold and native
take-back dialog recovery, then Users/Slack/Map/Calendar/capacity controls named
by the bounded remaining-scope review. Preserve the frozen evidence and ownership;
finish/checkpoint each, then run one final combined gate for the new stable SHA.
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
