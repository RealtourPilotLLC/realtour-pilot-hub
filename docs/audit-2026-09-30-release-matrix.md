# September 30 release evidence — Oct 1 production checkpoints

This is an acceptance ledger. Jordan authorized production checkpoint releases.
Detailed C01–C19/W01–W06/U0–U6 evidence is in the checklist; current resume and
batch history remain in resume.md and handoff.md. Deployment does not close
normal-client, browser, phone, provider or team acceptance.

## Current release state — Oct 1 evening

Canonical https://hub.realtourpilot.com serves fa346fa1d9a4, Ready
`dpl_6AecMWxtXaNvM6SQUt3vvGbS8CEG`, promoted 9:22:45 PM EDT. Exact clean
Node 20/remote builds, protected stage, Ready promotion and production version/
login/assets/auth checks pass. The initial final canonical stage read was
unconfirmed; fresh read and one bounded gate retry passed before one promotion.
Saved business settings, automation OFF/TEST_ONLY and seats unchanged; only two
mailbox-health timestamps advanced independently. Rollback 830a559, retain all
DB/newer writes. Source fa346fa matches current application/config/schema files;
009b00b adds final Pro verification only. No agent sends/invitations/bookings/
financial/schema change, activation/rollout expansion or push.

| Checkpoint | Implemented | Tested | Committed | Deployed | Enabled | Client-visible |
|---|---|---|---|---|---|---|
| Current-data error retry | Installed Next refetch, duplicate guard, interrupted-action guidance |14/0 handler/runtime/SSR; exact release gates |ab6cfdf |Yes |Existing users/gates |Fallback live; mounted acceptance open |
| Durable exact delivery proof | Atomic authenticated receipt; strict stored replay; no resend |25/0 + existing36/0; exact release gates |d22c582 |Yes |Existing authenticated callback; no switch change |Staff settlement path live; real callback unobserved |
| Portal-safe error destinations | Client portal return and ordinary team guidance |24/0 handler/runtime/SSR; exact release gates |830a559 |Yes |Existing users/gates |Fallback live; mounted acceptance open |
| First CALL/later WRITTEN causal journeys |Verification fixtures; no distinct app feature |18/0 +22/0 against exact built ab6; signed HTTP/bytes |c298fba |Local evidence |No activation |No audience/invitation change |
| Pro confirmed-session quota |Quota sweep/single/batch repair; canonical confirmed flexible/near-slot bookings |21/0 canonical +7/0 timing +28/0 final HTTP; lint/types/reviews/exact gates |bcfa41d/67f5beb corrections culminatefa346fa |Yes,fa346fa |Existing gates; no switch change |Source live; normal/browser/provider acceptance open |
| Pro causal two-session fixture |Verification only; two independent four-hour/eight-output journey |28/0 exact fa346fa; source/provenance/addresses/bytes |009b00b |Local evidence |No activation |No new audience/invitation |
| Historical repair preparation |Read-only plan; guarded transactional tool |PG 20/0; seven ready pointers in bounded read-only probe |b7909ab |Local tooling |No live apply |No record changed |

All following release paragraphs/tables preserve earlier checkpoint history.
U0–U5 remain partial and U6 open; none is accepted by these source/HTTP gates.

Current production is W05 checkpoint4354aca113ef, Ready
dpl_JAen2oGKAa4ZLunmbZzrz1u1kcNp, promoted17:15:02Z.36/0 exact proof tests,
types/lint/review, clean builds/stage and canonical HTTP pass. Saved business
settings/automation/rollout/seat counts unchanged; seven operational Aryeo
markers moved, separately recorded. Existing webhook prerequisite true, real
callback acceptance open. No switch or provider operation. a38715d rollback.
Home/C14 read-failure repair14/0, types/lint/review clear is next local source
checkpoint. Other entries below retain earlier release history.

Latest production is cache checkpoint `a38715d5ecef`, Ready
`dpl_EmkwoicgF6Lp7PeKGNg7P7Bvvomf`, promoted17:07:26Z. Exact local/remote
build/stage, canonical HTTP/auth/assets and readonly checks pass; saved business
settings, automation/rollout and seat counts unchanged. Existing library cursor
movement is recorded separately. e6eac69 rollback, no schema/activation/send.
W05 source4354aca clean build0 is staging. Home unreadable exceptions is a newly
identified narrow repair. Other entries below retain their original checkpoints.

| New checkpoint | Implemented | Tested | Committed | Deployed | Enabled | Client-visible |
|---|---|---|---|---|---|---|
| Monthly cached release and page failure | Canonical cache markers/read guards; both-layout unavailable detail | Real PG/SSR35/0, lint/types/review, exact builds/HTTP | a38715d | Yes | Existing gates unchanged | Code live; real client/browser/phone acceptance open |
| Actual normal-role HTTP evidence | Test fixtures; no distinct product change | Built e6eac69 HTTP37/0; services stopped | a38715d | Fixtures are local verification only | No | No distinct user feature |
| Authenticated exact delivery-text echo | Conservative settlement, provider time, no resend | Real PG/actual webhook36/0, lint/types/review, clean build |4354aca | Stage building, not promoted | No new automation activation | Not yet shipped |

Current local follow-up: canonical monthly marker facts now repair cache writes
and validate marked library/Home/detail reads; stale/unreadable answers use both
layouts' failure panels. Actual PostgreSQL and both-layout SSR35/0, peer/root
review, types/lint pass. Commit/build/release pending. Separate normal-role
actual built HTTP37/0 against e6eac69 covers password/cookies/middleware,
ownership, client tabs/exact approvals/range download/manual Start/Pause.
All temporary3211/5601/5602 services stopped. Browser/phone/provider/full-watch
acceptance stays open; no automation/rollout or live client record change.

Fresh readonly16:11Z readiness inventory has13 candidates and13 October
workspaces; no eligible real seats, released strategies or approved canonical
available topics. First roster and staff source preparation remain unapproved.
W05 exact delivery-echo source recovery is in progress independently.

Policy candidate 974327f built/staged successfully but was held, never promoted:
recording monthly portal availability must not grant client download/caption
permission. The atomic AuditLog marker and entitlement repair have backend 41/0
and actual signed approval-gate 21/0 evidence; combined types/lint and focused
review pass. Replacement e6eac69 passed exact local/remote builds and protected
stage smoke, then promoted 11:47 AM EDT. Production version/login/assets/access
and read-only unchanged-state checks pass. Ready dpl_7UpNA2AXJsCdiGEAeopg7iUHkbMv;
settings/automation/seats unchanged, rollout TEST_ONLY. No activation, client
verdict, invitation, provider booking, message or Git push was performed.

Rows naming3c3c2d7 identify their first deployment; all remain included in the
current e6eac69 application. Source and targeted evidence do not close the
browser/client acceptance column.

| Area | Implemented | Tested | Committed | Deployed | Enabled | Client-visible |
|---|---|---|---|---|---|---|
| Approved general welcome link | Approved default/fallback; monthly link preserved | Actual fenced26/0; lint/review; no saved auto_texts row | `7220dca` | Yes;e6eac69 | No automation activation | Default live; no welcome sent/replayed; provider acceptance open |
| Explicit no-brand and returning editor receipt | Exact versioned choice and owner generation; Start/Pause preserved | Signed PG 44/0; affected15/0+61/0; combined gates/review | `0334622` | Yes;e6eac69 | Existing permissions/gates | Staff source live; normal editor/browser acceptance open |
| Monthly portal/exact Dropbox and client approval | Exact canonical backup/check/access; atomic portal marker | Backend 41/0, approval gate 21/0, UI19/0, listing34/0+mixed25/0; exact builds/review | `148440a`, `974327f`, `e6eac69` | Yes;e6eac69 | No rollout expansion/send/approval fabricated | Code live under existing gates; client/phone/provider acceptance open |
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

Fresh Oct 1 production: e6eac69f1d41, Ready deployment
dpl_7UpNA2AXJsCdiGEAeopg7iUHkbMv, at https://hub.realtourpilot.com. Remote build
and HTTP deployment smoke passed; automation/rollout remain unchanged. Previous
production3c3c2d741aaf was freshly verified before promotion and remains the rollback target.
No branch push occurred. See `audit-2026-10-01-policy-release.md` for the latest
evidence and `audit-2026-10-01-production-release.md` for the earlier backup/schema.

Application candidate `2b87cc2` passed non-incremental types, changed-file lint
(41 files plus type-only fixture repair) and the separate clean-environment
production build. Logs are in the checklist/handoff. These gates establish a
local build, not deployment, activation, browser acceptance or launch readiness.
The later W04 fixture953e680 passed25/0, lint/root review and final
non-incremental types (`/tmp/ops-hub-types-953e680.log`). Git comparison confirms
no app/schema/config changes between2b87cc2 and953e680; the subsequent approved
policy application changes have their separate evidence above.
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
| UA03 — written month | Later WRITTEN causal built HTTP22/0 with exact carry/client-added topics/typed answers through final bytes; earlier23/0+19/0 retained | Engineering: complete normal client browser journey with carried and client-added topics |
| UA04 — call and Pro sessions | First CALL causal built HTTP18/0 from empty strategy/bank through final bytes; prior25/0. Pro final current-candidate two-session HTTP28/0; quota writer21/0 + supported timing 7/0 | Engineering: normal client browser and approved provider sandbox booking; Jordan decides historical worker backlog |
| UA05 — draft recovery | Existing draft/recovery and failed save fixtures | Engineering: normal client refresh/navigation and denied browser storage; ensure saved choices and words survive |
| UA06 — exact version decisions | Pinned revisions/role guards; connected v1→checked v2 decision/download; multi-session stale verdict/issue and finishing regression 11/0 | Engineering: browser newer-cut and failed revision submission, captions/download gates |
| UA07 — editor context | Actual HTTP18/0 includes no-brand, return/reassignment stale receipt/fresh acknowledgment and manual clocks; prior queue76/0+19/0 retained | Kim/engineering: normal signed editor, two-session monthly scope and receipt, keyboard/phone checks |
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
| Monthly delivery destination | Engineering; deployed, normal acceptance open | Portal/exact final Dropbox implemented; marker backend 41/0, signed approval gate 21/0, UI19/0, affected listing34/0+mixed25/0 and exact gates/review pass. Deployed ate6eac69. Next: normal client/browser/phone/provider final-file and incident acceptance; no client approval fabricated. |
| Editor brand/brief receipt policy | Engineering; deployed, normal acceptance open | Explicit no-brand/fresh returning-editor generation implemented; signed PG 44/0, affected15/0+61/0 and exact gates/review pass. Deployed ate6eac69. Next: mounted normal editor/office receipt and multi-output journey; historical receipts/manual Start/Pause preserved. |
| General welcome destination | Engineering; deployed, sends remain gated | Approved general default/fallback implemented; actual fenced26/0 and exact gates/review pass. No `auto_texts` row or stored write. Deployed ate6eac69; monthly mapping preserved, no welcome replay. Next: provider/client acceptance under an approved test scope. |
| Named historical links | Kyle | Verify source identity before changing C13 client/topic links, the C18 property task, and Sarina's month/output reconciliation |
| Client identities | Kyle/Jordan | Resolve Janice/Arielle and other named conflicts using source evidence; investigate Joe/Joseph without assuming they should merge |
| Intended first client roster | Jordan | Confirm the intended first roster using the private Sep 30 22:33 ET inventory of 13 candidates; then prepare the exact seats, strategy/bank, month and source evidence. No invitations are authorized by the inventory |
| Browser evidence | Engineering/environment | Restore authorized local-browser access; the current tool policy refusal must not be bypassed with another browser transport |
| Provider and real-media acceptance | Jordan + engineering | Agree on isolated/sandbox recipients, booking/media records and destinations before any external write; keep clients and real bookings untouched |
| Generated-workflow dates | Jordan | Answer pending policy question; ad hoc editing is shipped, automatic editing/revision/SLA clocks remain unchanged |
| Unknown delivery-text settlement | Jordan | Decide manual evidence-backed Kyle resolution versus automatic provider confirmation; question pending, existing unknown holds never offer a blind resend |
| Production deployment | Completed under Jordan authorization |Latestfa346fa promoted and exact HTTP/read-only gates verified; existing switches unchanged. Prior checkpoints remain dated history. No client activation/send authorization. |

## Schema and rollback gate

Five additive tables were applied and verified on Oct 1: `ClientBrandReceipt`,
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
