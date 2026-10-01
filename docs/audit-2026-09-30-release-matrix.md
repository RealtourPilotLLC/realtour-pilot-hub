# September 30 release evidence — Oct 1 production candidate

This is an acceptance ledger. Jordan explicitly authorized the Oct1 deployment;
reviewed candidate3c3c2d7 is now live, with existing gates unchanged. The detailed C01–C19,
W01–W06 and U0–U6 backlog remains in `audit-2026-09-30-checklist.md`; the resume
instructions and batch evidence remain in `handoff.md`.

## Release state

| Area | Implemented | Tested | Committed | Deployed | Enabled | Client-visible |
|---|---|---|---|---|---|---|
| Access, manual work state, draft preservation, rollout guards | Local corrections | Targeted isolated signed-role/action tests; normal browser journey open | Yes; see C01–C03/C09/C12 | Yes;3c3c2d7 | Existing switches unchanged | Code live under existing gates; client acceptance open |
| Client sign-in and teammate invitation feedback | Local correction; privacy-generic acknowledgement and newer-draft retention | Actual fake UI29/0 + wrapper10/0; typecheck/lint/review; real email/browser open | Yes | Yes;3c3c2d7 | No invite or login switch changes | Public login verified; sends remain gated |
| Written and call planning; exact script acceptance | Local corrections | Written 23/0, call 25/0; fake model/provider evidence only | Yes | Yes;3c3c2d7 | No worker or rollout activation | Code live under existing gates; client acceptance open |
| Brand alert recovery and individual receipts | Local corrections | Recovery 8/0 + 12/0; receipts 12/0; signed setup 130/0 | Yes | Yes;3c3c2d7 | Alerts remain off | Code live under existing gates; client acceptance open |
| Editing, revision, filming and final delivery handoffs | Substantial local implementation; named W remainders open | Connected signed journey 19/0; exact approval/issue race PostgreSQL 11/0; real media, phone and provider paths open | Yes for completed batches; active work in handoff | Yes;3c3c2d7 | No new automation activation | Code live under existing gates; client acceptance open |
| Truthful workload, revision causes and empty queues | Local corrections | C14 scoped drills; C15 12/0; C16 17/0 + 141/0 + 5/0 | Yes | Yes;3c3c2d7 | No switch changes | Staff code live; normal-role acceptance open |
| Home, task ownership and Sidebar grouping | Local implementation; guarded office ad hoc date editing | Home 15/0; Tasks 21/0; Sidebar 41/0; dates/role/CAS/receipt 49/0 and retained detail 26/0 | Yes | Yes;3c3c2d7 | Not applicable | Staff code live; normal-role acceptance open |
| Settings reminder fields and search | Local implementation | Policy 27/0; navigation 21/0; signed Settings 56/0 | Yes | Yes;3c3c2d7 | Policy save does not activate | Staff code live; normal-role acceptance open |
| Upload and appointment uncertain-write recovery | Local implementation; named recovery limits retained | Upload PG26/0 + UI18/0, CP09 142/0, B4 69/0; appointment signed action13/0 + fake UI23/0 | Yes | Yes;3c3c2d7 | No provider/automation activation | Code live under existing gates; client acceptance open |
| Resources drafts and uncertain-write recovery | Local implementation; current-tab retention | Actual handler/action/page fixture33/0 and focused review, including group/removal remounts; browser open | Yes | Yes;3c3c2d7 | No publishing or automation change | Staff code live; normal-role acceptance open |
| Exact-cut removal/move dialog and recovery | Local correction; preserved destructive confirmation and file rules | Actual fake UI/action30/0; lint/types/review; native browser/provider open | Yes | Yes;3c3c2d7 | No provider operation activated | Code live under existing gates; client acceptance open |
| Month/library corrections and office review controls | Local correction; preserved fee/clock/identity rules | Fake actual UI/action38/0; office handler/wrapper/CAS25/0; lint/review; browser open | Yes | Yes;3c3c2d7 | No switch or billing changes | Code live under existing gates; client acceptance open |
| Logins/access conflict and recovery | Local correction; shared account guards and atomic override reset | Fake actual handler/action/CAS26/0; types/lint/review; browser open | `5ae370a` | Yes;3c3c2d7 | No account/invite change | Staff code live; normal-role acceptance open |
| Capacity/calendar controls | Local correction; exact newer drafts and unknown guards | Fake actual handlers/wrappers20/0 including all-day count repair; lint/review; browser open | `6972796` | Yes;3c3c2d7 | No capacity/date/pay change | Staff code live; normal-role acceptance open |
| Team/Slack identity and DM recovery | Local correction; Find/Sync conditional writes, no fallback after uncertain direct post | Fake UI29/0, wrappers15/0, transport13/0; types/lint/review; real browser/provider/DB concurrency open | `41c8baf` | Yes;3c3c2d7 | No real Slack call or ID change | Staff code live; normal-role acceptance open |
| Map read/keyboard recovery | Local correction; exact pin/home/query scopes and native suggestions | Actual fake handlers/read effects36/0; lint/review; Leaflet/normal-role browser/provider open | `4681377` + fixture type repair `2b87cc2` | Yes;3c3c2d7 | No provider or route changes | Staff code live; normal-role acceptance open |
| Mixed photo/video final handoff | Existing implementation verified; no app change | New actual signed/domain fixture25/0 with fake Aryeo; manual/automatic video and converse photo-task paths | `953e680` | Yes;3c3c2d7 | No delivery or switch changes | No distinct source change; delivery acceptance open |
| Remaining UI and complete journey acceptance | Partial | Evidence below; no complete U-phase acceptance | Completed slices only | Completed slices at3c3c2d7 | No | Complete journey/UI acceptance open |

Fresh Oct1 production:3c3c2d741aaf, Ready deployment
dpl_FaUomN98Qz8EDuFnUopYgtnt55HS, at https://hub.realtourpilot.com. Remote build
and HTTP deployment smoke passed; automation/rollout remain unchanged. Previous
productionbf2e0b48a0dd was freshly verified for rollback. No branch push occurred.
See `audit-2026-10-01-production-release.md` for backup/schema/smoke evidence.

Application candidate `2b87cc2` passed non-incremental types, changed-file lint
(41 files plus type-only fixture repair) and the separate clean-environment
production build. Logs are in the checklist/handoff. These gates establish a
local build, not deployment, activation, browser acceptance or launch readiness.
The later W04 fixture953e680 passed25/0, lint/root review and final
non-incremental types (`/tmp/ops-hub-types-953e680.log`). Git comparison confirms
no app/schema/config changes after2b87cc2; later commits contain only tests/docs.
The restored isolated preview intentionally runs on3200, with saved fixture
data and provider fences; it is not normal-role/browser or real-provider proof.

## Usability acceptance ledger

No row below is a complete browser acceptance pass. Server rendering verifies
data/roles/markup; it does not prove focus, pointer behavior, layout or real-phone
file saving. Earlier owner/demo walkthroughs remain useful but do not substitute
for normal authorized client/editor access.

| Scenario | Evidence retained | Concrete remaining step / owner |
|---|---|---|
| UA01 — role work discovery | Home role rendering, saved reviewer seat, preserved actions | Kyle, James and Jordan each identify their next owned action without narration; record time and hints, not an invented score |
| UA02 — authorized navigation | Sidebar identical destination sets for 12 role/override profiles; old Settings anchors | Engineering: keyboard/cold-link/back navigation under normal role sessions |
| UA03 — written month | Signed written path 23/0; connected strategy/bank→written month→exact scripts→filming→final decisions 19/0 | Engineering: complete normal client browser journey with carried and client-added topics |
| UA04 — call and Pro sessions | Signed call route 25/0, fake transcript/model output; Pro action evidence | Engineering: normal client browser and approved provider sandbox booking; Jordan decides historical worker backlog |
| UA05 — draft recovery | Existing draft/recovery and failed save fixtures | Engineering: normal client refresh/navigation and denied browser storage; ensure saved choices and words survive |
| UA06 — exact version decisions | Pinned revisions/role guards; connected v1→checked v2 decision/download; multi-session stale verdict/issue and finishing regression 11/0 | Engineering: browser newer-cut and failed revision submission, captions/download gates |
| UA07 — editor context | Kim + overdue isolated demo return/refresh; Start/Pause 76/0 and connected two-output handoff 19/0 | Kim/engineering: normal signed editor, two-session monthly scope and receipt, keyboard/phone checks |
| UA08 — photographer handoff | Signed CP09 142/0 with fake partial Dropbox failure/retry | Photographer/engineering: actual phone partial/mixed raw files, upload interruption, receipt and exact script/output |
| UA09 — delivery and communication | Ready-file context, final-rendition34/0, mixed photo/video25/0, notice10/0, comms recovery; connected approved v2 fixture download and foreign/revoked denial | Kyle/engineering: approved exact final media, explicit destination policy, provider sandbox handoff and incident recovery |
| UA10 — failures and honest state | Delivery read failures, notification failure demo, reminder late-save/failure proof | Engineering: browser saves/data fetches fail and recover; no false zero/success or lost input |
| UA11 — keyboard | Existing isolated dialog/drawer walkthrough; shared queue menu source proof | Engineering: normal-role pending/failure menus and dialogs; focus return, Escape, Tab and screen reader |
| UA12 — responsive/contrast | Earlier fenced desktop/390px samples; partial token improvements | Engineering: fixed fixtures at 375/390/768/laptop, light/dark, 200% zoom and long names; capture matching screenshots and measure rendered contrast |
| UA13 — phone file save | Honest download wording implemented; no real-device proof | Engineering with iPhone and Android: interruption/retry, correct approved file, save/share instructions; no Photos auto-save claim |
| UA14 — truthful empty/disabled/test | Scoped C14 readers and signed C15/C16 results; Home test-view links 22/0; Office Editing/Schedule scope 23/0 | Engineering: normal browser identity, filtered-empty/read failure/rollout-disabled states and mounted scope/return checks |

## Approval and external evidence needed

| Item | Required owner | Concrete next step |
|---|---|---|
| Monthly delivery destination | Engineering; local source prepared | Portal plus exact final Dropbox backup implemented; backend38/0, UI19/0, affected listing34/0+mixed25/0, lint/types/focused review pass. Atomic current cut/access claim and backup/preview/history recovery verified in fixtures. Clean build/release and real browser/phone/provider acceptance remain; not implemented in deployed3c3c2d7. |
| Editor brand/brief receipt policy | Engineering; local source prepared | Explicit no-brand and fresh returning-editor generation implemented; signed PG44/0, affected15/0+61/0, lint and focused review pass. Stable combined types/build and mounted browser acceptance open. Not deployed; historical receipts and manual Start/Pause preserved. |
| General welcome destination | Engineering; local source prepared | Approved general default/fallback implemented; actual fenced fixture26/0, lint and root review pass. Fresh live read found no `auto_texts` row, so no stored write. New source not yet deployed; retain monthly mapping and never replay welcomes. |
| Named historical links | Kyle | Verify source identity before changing C13 client/topic links, the C18 property task, and Sarina's month/output reconciliation |
| Client identities | Kyle/Jordan | Resolve Janice/Arielle and other named conflicts using source evidence; investigate Joe/Joseph without assuming they should merge |
| Intended first client roster | Jordan | Confirm the intended first roster using the private Sep 30 22:33 ET inventory of 13 candidates; then prepare the exact seats, strategy/bank, month and source evidence. No invitations are authorized by the inventory |
| Browser evidence | Engineering/environment | Restore authorized local-browser access; the current tool policy refusal must not be bypassed with another browser transport |
| Provider and real-media acceptance | Jordan + engineering | Agree on isolated/sandbox recipients, booking/media records and destinations before any external write; keep clients and real bookings untouched |
| Production deployment | Completed under Jordan authorization |3c3c2d7 promoted and HTTP verified; existing gates unchanged. No activation/client sends authorized. Future source batches need their own exact release evidence. |

## Schema and rollback gate

Five additive tables were applied and verified on Oct1: `ClientBrandReceipt`,
`DeliveryFollowUpHealth`, `FinalRenditionCheck`, `ShootBriefRead`,
`EditorBriefReceipt`. No migration history was present at takeover. Fresh pre-release
backup covered144/144existing models; postflight149tables,12indexes,2validatedFKs
and schema diff0 passed. Backups remain private outsideGit. No reset/seed is allowed.

Prepare schema before code that depends on it, then smoke-check the exact
candidate with client automation still off. A code rollback uses the previously
verified deployment. Retain additive tables and any receipts written after
release; do not drop them to roll back application code. Reconcile jobs already
started before any replay. Never resend an ambiguous/unknown delivery as part
of rollback. Activation and named-client invitations require a separate explicit
decision after deployment and acceptance.

## Scope still deliberately open

U0–U5 are partial and U6 is not accepted. Complete normal client journeys,
generated-task deadline override policy, team usability sessions and the fixed
visual/keyboard/phone comparison remain. The named high-use secondary editors
have local source slices and targeted evidence, recorded in `ui-controls.md`;
their rendered typography, table overflow, focus and honest-failure acceptance
remain open. Broader UI migration stays on the checklist, and any defect found
in that comparison requires its own local repair and focused verification.

Individual Finance/Trends, My Pay/HR, Catalog, Training, Assistant, Feedback and
Connections interiors have not had a full rendered comparison in this run.
They remain explicit shared-shell/theme and role-boundary regression surfaces,
not claimed migrated or accepted. Preserve monetary calculations, pay policies,
content and permissions. No efficiency or performance gain is claimed without
measurement. Browser/tool access and approved test setup are required for the
remaining comparison; no alternate browser transport is authorized.
