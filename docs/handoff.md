# Progress record — unified implementation handoff (Sep 25 2026)

## Sep 30 takeover addendum

### U1 checkpoint — shared action, field and save-state presentation

Added small native Button/ActionLink, FormField/TextField and SaveStatus pieces
alongside the existing Badge, ModalDialog and ActionMenu. Settings save rows and
numeric fields use them; switches keep their visual track but have a 44px target.
Client planning/cancellation controls use readable labels, 44px actions and
accessible save/error feedback. Existing action handlers, input bounds, eligibility
and confirmation policy remain unchanged. Semantic type/target/action tokens and
the shared-control contract are in `docs/ui-controls.md`.

Development-only `/settings/ui-preview` requires existing Settings access and
uses fixed fictional states in staff and client-light palettes. Outside development
it returns notFound before rendering. No domain reader/provider/mutation is used
by its examples. It includes loading, loaded/dirty/saved/error, partial, empty,
filtered-empty and disabled cases for the pending screenshot comparison.

Focused native semantics/control fixture passed 9/0
(`/tmp/u1-control-states-final/`), existing Settings snapshot regression 12/0,
lint, stable-tree TypeScript and one independent source review passed. The initial
fixture run needed a router stub; only that failed drill was repeated. Flat token
calculations: primary white 5.06 dark / 5.53 light, danger white 6.47, sampled muted
text 5.46–7.12. These are token calculations, not rendered contrast acceptance.
Keyboard, phone, zoom, clipping and browser contrast remain blocked/open; U1 and
UA10–UA12 are not complete.

### U4 checkpoint — compact task rows and retained detail drafts

The operational board shows concise work rows with source, property, owner,
status and exact due context. Quick ownership uses the existing guarded action.
The full TaskCard stays mounted inside a controlled native detail drawer, so
closing it retains an unsent note or draft on the current page. Nested source
context also uses the native dialog. Known same-project output references link
to that exact brief; unbound, removed and mismatched outputs stay in task context.
No latest cut is guessed. Existing filters and task deep links remain intact.

Signed SSR/context checks passed 26/0 and the existing navigation regression
21/0 (`/tmp/ops-u4-task-rows/`); Node20 TypeScript, focused lint and diff checks
passed. One focused review repaired nested cancel propagation and retained draft
text on returned or thrown failures. Note/send/assignment uncertainty is explicit.
Money scrubbing and manual Start/Pause are unchanged; opening a row reads or
sends nothing. Browser focus/draft persistence acceptance remains open. Editing
a SmartTask deadline remains unimplemented because the existing guarded actions
do not define a task-specific due-date override; retain its displayed due date
until that behavior is explicitly designed.

### C11 / launch inventory checkpoint — held evidence and actual launch gaps

The monthly roster no longer says a confirmed queued transcript never arrived.
The shared wording distinguishes confirmed, queued/off, running, failed,
human-review, genuinely absent, imported and analysed evidence. Import success
alone does not claim analysis completed. The existing hard/soft blocker priority,
script/downstream work and all worker/backlog/rollout settings are preserved.
Focused isolated overview checks passed 17/0, lint and TypeScript passed; one
focused source review completed (`/tmp/c14-call-evidence-status-logs/`).

The SELECT-only October candidate inventory finished at 2026-10-01 02:33:46 UTC
(Sep 30 ET). The private report is
`/private/tmp/realtour-launch-candidates-2026-10-final.json`, mode 0600, outside
Git. The reusable reader is `scripts/_recon/launch-inventory.ts`; it pins read-only
database settings before Prisma import, verifies them using SELECT, blocks fetch,
omits bodies/contact addresses/provider URLs and refuses output outside private
temporary storage or overwriting an existing export. Review repaired omission of
month-linked calls and export of unconstrained onboarding free text.

All 13 active non-synthetic candidates have zero recorded active client login
seats and no released strategy; the canonical approved available bank is empty.
Only three have October workspaces. Kristin and Erica hold confirmed monthly-call
sources queued while processing is off; Ashley still needs a planning-route choice.
No section read failed. These are candidate readiness facts, not an approved
launch audience or a signed browser/media acceptance test. Jordan's roster choice,
identity/source verification, strategy/bank preparation, access setup, provider
and phone acceptance, schema release and deployment approval remain concrete gates.
No client records, seats, switch, backlog job or provider was changed.

### W03 checkpoint — durable intake before task and attachment effects

Staff submissions now save the exact words, contact/actor, video/output, first
timestamp and attachment identity before any upload or task handoff. The project
flag, activity, revision task, QC reopen and queue restoration commit together.
Editor-work reconciliation and existing internal notification paths run after
commit. Saved request retries preserve the first cut even when a newer cut or
changed form arrives; closed tasks stay closed.

Attachments use one deterministic path with add-only/no-autorename writes and
exact-byte readback. Unknown transport outcomes are checked before retry; only
confirmed absence permits the same bytes/name/size/type to be uploaded again.
Mismatched bytes remain a staff exception. File-record failure recovers existing
bytes without another upload. Model reanalysis merges current receipt metadata
under the same lock. Browser storage keeps IDs only, supports refresh/resume and
same-key target reselection after a stale first submit with no server receipt.
A failed cleanup of the browser reminder cannot turn a recorded request into
a reported recording failure.

Evidence: real PostgreSQL existing W03 26/0 and retry 23/0; real PostgreSQL intake
review 24/0 (`/tmp/w03-intake-reviewed/`); final PGlite intake 26/0 includes the
two added stale-first-submit/reselection cases (`/tmp/audit-resume-targeted/`).
Scoped lint has only two existing tasks.ts warnings; stable-tree TypeScript
passed. One focused review found and repaired the browser identity, known-absent
upload and concurrent metadata risks. No production/schema/provider write or
manual Start/Pause change. Normal browser refresh/resume, real Dropbox behavior
and distinct per-cut stage readability remain open.

### U3 checkpoint — persistent Editing stage filters

The queue now filters by the project status it already displays: Ready for
editing, Changes requested, Awaiting review, Blocked / waiting, and distinct
choices for other recorded states. A project with mixed video stages is labelled
as such; this presentation filter does not infer manual Start, approval or delivery.
Stage/editor/due/view intersect consistently, survive the URL and brief return
link, and preserve canonical copied job links. Clear filters resets all dimensions.

Focused drill passed 14/0, including 1,903 rendered filter/count transitions
(`/tmp/u3-editing-stage-filters-logs/u3-editing-stage-filters.ts.log`). Lint,
diff check and one focused review passed. An HTML attribute-order assertion was
corrected during verification. Full TypeScript found only a concurrent W03 drill
typing error; the stable candidate needs the next integrated gate. Mounted browser
and visual acceptance remain blocked. No work state or provider was changed.

### U5 checkpoint — call recovery in the existing operations queue

Settings links to Content → Monitoring → Calls when the viewer has content
access. Settings-only users retain their existing recovery controls and owner
mutation guards; no access override is widened. Monitoring distinguishes failed
call/alias/transcript/client/month reads from empty queues, retains legacy-month
transcript provenance, catches lost action responses and shows check-before-retry
feedback. Controls now have explicit names/44px targets. Typed month entry remains
available alongside known-month choices, preserving Settings' prior capability.

Signed SSR and injected-read-failure drill passed 26/0
(`/tmp/ops-u5-call-recovery-final/u5-call-recovery.ts.log`); lint, diff checks
and one focused review passed. Fixtures/transcript records were unchanged and no
provider was called. Initial test cleanup socket race and Prisma mock typings
were fixed. Browser interaction/visual acceptance remains open. Full removal of
the Settings fallback would require a deliberate permission design decision;
this batch preserves the existing settings-versus-content access distinction.

### U3 checkpoint — Editing queue before diagnostics

Editing Room now leads with a compact evidence-aware Editors today strip and
its work queue. Add to queue stays alongside it; removal undo stays visible.
Detailed capacity/activity moves below the queue in a collapsed section whose
summary retains overdue and availability-change counts. Open work / Completed
labels retain existing URL values. Mobile cards, status/More menus, exact due,
assignment, active editor desk and manual Start/Pause are unchanged.

Actual signed owner/editor/photographer/unmapped page SSR passed 15/0
(`/tmp/u3-editing-queue-focus-logs/u3-editing-queue-focus.ts.log`), lint, full
nonincremental TypeScript and one focused source review passed. The first test
attempts had an invalid fixture MediaNote field; no product failure. Named stage
filters remain a separate next slice. Mounted responsive/keyboard/visual proof
is still browser-blocked; no workflow/provider/database state was changed.

### W03 checkpoint — finish saved revision receipts after partial failure

A repeated staff request now finishes its saved receipt instead of reporting
success while video issues or the timestamp are missing. The original timestamp
(including deliberately blank) is persisted in existing itemsJson metadata; retries
ignore changed words/contact/file/cut fields. Every saved item must exist and
match the saved project/output/version. Late recovery uses the original version
and editor, not the newest cut. Moved pins, unknown legacy timestamp evidence and
closed tasks with missing issues require staff review rather than silent repair.
Legacy DONE/CLOSED count as closed. Reanalysis preserves staff reference/timing
metadata. Project+validated request-key locking covers simultaneous changed-cut
receipts as well as ordinary retries.

Real Postgres targeted retry/concurrency drill passed 22/0; existing W03 signed
regression passed 26/0 (`/tmp/w03-retry-reviewed-pg/`). Scoped lint and one focused
review passed; review fixes included source selection typing, legacy closed tasks
and locking across different cuts. Earlier failure-injection interception missed
a dynamic import; the final fixture injects failure at actual issue writes.
No provider call, production mutation, schema change or Start/Pause transition.

Still open: the older task/project/activity writes and attachment upload happen
before the receipt transaction. That earlier interruption/concurrent-input window
is a separate active reliability item; this batch does not claim all W03 writes
are atomic. Browser attachment/error acceptance remains open.

### Integrated build checkpoint

The committed candidate through `c5e619e` passed a production build, including
TypeScript, in the separate managed checkout with environment credentials removed
and an unreachable loopback database (`/tmp/ops-hub-build-c5e619e.log`, exit 0).
This covers completed Home/Settings/task/sidebar/context batches. W03 and later
active recovery/Editing batches need the next integrated gate. No build touched
production or a development server, and no deployment occurred.

### U5 checkpoint — exact save feedback across core Settings forms

Routing, turnaround, internal alerts, text wording and review rules now share
section-specific loaded/dirty/saving/saved/error feedback. A late success only
acknowledges the submitted snapshot; newer input remains unsaved. Rejected or
unconfirmed saves retain input and expose retry. Dirty forms warn on browser
refresh/close; search/collapse still leaves them mounted. Existing actions,
permissions and policy values are unchanged. Empty template input now remains
empty with built-in wording as its placeholder, matching the existing server's
use-default semantics rather than refilling the draft while deleting text.

Fenced UI state/actual first-paint regression passed 12/0
(`/tmp/u5-settings-save-feedback-final/u5-settings-save-feedback.ts.log`), lint
and one independent focused source review passed. The initial run passed all
assertions but used the wrong test-summary helper; it was corrected. No database
or provider calls. Broader panel migration and mounted browser acceptance remain.

Release evidence and explicit UA01–UA14 remaining steps are maintained in
`docs/audit-2026-09-30-release-matrix.md`. It records implementation, tests,
commits, deployment, activation and client visibility separately; no UI phase
is accepted solely from first-paint rendering.

### U2 checkpoint — selected month/session and address-bound appointments

Portal navigation retains a validated enrollment month and Pro session between
Plan, Schedule and Library. The call picker remounts on month/mode changes;
filming choices belong to a specific session/address version, and changing that
address clears stale choices. Date pages clamp when a shorter result arrives.
Availability horizon, explicit retry and all-month labels are shown. Failed call
booking retains its error and clears the rejected selection. Existing six-date
paging and all server eligibility/travel/72-weekday/provider rules remain intact.

Signed-client fixture/first-paint drill passed 20/0, including all 15 dates,
last-date/last-time choice, cross-enrollment and Pro-plan boundaries, and actual
address actions (`/tmp/u2-scheduling-context-logs/u2-scheduling-context.ts.log`).
Lint and one focused review passed. TypeScript found no U2 errors; the concurrent
W03 selected-source typing fix is pending. No real provider booking or client
message. Mounted browser navigation, phone visuals and provider acceptance remain.

### U4 checkpoint — grouped Sidebar with identical access

Sidebar destinations now sit under Daily work, Production, Clients, Team &
learning, Reference, and Administration. Frequent groups and the current section
open by default; Report a hub issue remains reachable without opening a group.
The existing filtered destination list is unchanged, including photographer
exceptions, explicit My Pay grants and configured owner-only Script Writing.
Notices, theme/logout and longest-path selection remain intact. Unique disclosure
IDs support both mounted sidebars; the drawer's existing focus selector includes
summary controls. If overrides remove ordinary work groups, the first authorized
group opens so initial focus remains visible.

Actual role SSR comparison passed 41/0 across 12 role/override profiles
(`/tmp/ops-u4-sidebar-navigation-final/u4-sidebar-navigation.ts.log`); lint,
diff checks and one focused review passed. Browser/drawer keyboard and tablet
acceptance stay open. Home drill assertion was explicitly narrowed to boolean
for TypeScript; its runtime check is unchanged.

### U4 checkpoint — role-first Home and optional operating routine

Home now leads with a compact role-specific orientation, fixed appointments,
ranked next actions and delivery count/age. James's creative review view follows
the saved primary reviewer seat rather than a name heuristic. Kyle retains the
operating checklist in an optional section; all 15 existing block anchors open it.
Exact oldest assigned-cut links are preserved. Delivery controls remain in the
video-review block, because Review Room itself links back there. Owner money
and private tasks remain gated and lower. Failed assigned-review reads retain
known general workload with an explicit warning rather than implying no work.

Actual signed Home SSR drill passed 15/0
(`/tmp/u4-home-focus-reviewed/u4-home-focus.ts.log`); focused lint and one review
passed. Browser acceptance remains blocked. The optional Home test toggle is
still deferred until every nested destination uses matching scope; normal
operating readers retain the C14 filtering. Full stable integration checks follow
once the active portal/sidebar batches are complete.

### U5 checkpoint — searchable Settings without losing drafts

Seven purpose groups now collapse independently, show already-loaded summaries,
and support label/keyword search. Filtering hides rather than unmounts forms so
unsaved input survives. Old hash links reveal the matching group/card and focus
the target. Owner-only financial groups are omitted server-side. No saved values,
permissions, connections or automation state changed.

Pure/SSR navigation drill passed 21/0 through the existing fenced runner
(`/tmp/ops-u5-settings-navigation-runner/u5-settings-navigation.ts.log`);
actual signed Settings/UI03 passed 56/0 (`/tmp/ops-u5-settings-ia.log`).
Owner/admin rendering, editor/anonymous refusal, unique legacy anchors and
unchanged settings/automation/connection/calendar/team/audit records are covered.
Focused lint and one review passed. Browser interaction, per-section save/error
consistency and remaining recovery/secondary-page work stay open.

### C15 checkpoint — existing no-cuts/other-work behavior verified

Actual signed Kyle and James Review Room page rendering passes 12/0 with no
first-cut approvals pending, a real-client video-only check, exact v2 revision,
and unknown delivery text. The headline is scoped to cuts while revisions,
delivery checks and the real incident link remain visible. Normal/test and
signed-out cases pass; task rows, version and unknown send state stay unchanged.
No additional product fix was required. This is server rendering, not browser
interaction/visual acceptance. Provider fence recorded zero calls.

### U4 checkpoint — ownership-first task navigation

Task entry now leads with My work / Needs assignment / All work / Completed,
with Replies, Revisions and Slack kept as specialist queues. All work is labelled
as the operational board rather than implying every specialist queue is included.
Legacy `other`, `board`, `today`, named-owner and exact task links retain their
meaning. URL-backed source/type/owner filters and test scope survive navigation;
unassigned routine work still belongs to Kyle under the existing rule. No task
action, permission, source identity or automatic completion behavior changed.
Isolated signed route/BoardView drill passed 21/0 (final log
`/tmp/u4-task-navigation-final/u4-task-navigation.ts.log`), lint and one focused
review passed. Earlier 18/0 log predates the three review-edge checks. Browser,
compact row/detail drawer and external drill-down context acceptance remain open.
Role-first Home composition is a separate active batch.

### U5 checkpoint — reminder policy form and activation separation

Reminder policy has ordinary cadence/timing/limits/safeguard/template fields,
fictional canonical template previews and retained advanced JSON. Unknown nested
keys round-trip unchanged. Validation and saved status identify the exact draft;
late responses cannot mark newer edits saved, and failure keeps the draft.
Policy save previously read enabled and replayed it through setAutomation,
rewriting activation receipts and risking reversal of a concurrent disable. It
now upserts config only; a missing automation row is created OFF.

Isolated `u5-reminder-policy-editor` 27/0 includes actual signed owner/admin/preview
rules, ON/OFF receipt preservation, failure/retry, malformed advanced JSON and
first-paint render. Lint, nonincremental TypeScript and one focused review passed.
Browser interactions and broader U5 panels remain open. No settings were changed
in production, and no reminder/provider/client message or activation occurred.

### C16 checkpoint — confirmed causes and consistent editor reports

Review Room now separates reviewer-confirmed revision causes from optional QC
recording gaps. The new read-only summary counts root issues once, excludes N/A
and duplicates, names its period/denominator/test scope, and reports missing
version or editor attribution. No historical unknown is silently reclassified.
Existing editor reports now require cause confirmation actor/time before fault
attribution; unconfirmed legacy/invalid labels remain pending. Normal Quality
and Editing reports exclude fixtures, and Quality retains an explicit test view.

One focused review found and fixed whitespace/invalid-cause queue mismatch,
overstated version wording, inconsistent Editing scope, office-upload roster
omission and moved-cut issue leakage. Classification candidates are filtered by
the same validity rule before the display cap. Issue-to-submission project
agreement protects first-review, carried corrections and declared-not-done reads.
Office uploads use the existing valid self-check owner rule. Empty report scopes
cannot borrow another job's pause history. Operational missed-correction tracking
is still separate from editor-fault classification; the existing rule is intact.

Checks: `c16-revision-quality` 17/0, `b1-selfqc-issues` 141/0,
`c16-editor-quality-scope` signed page 5/0; focused lint passed. Full integrated
type/build and browser acceptance remain to be recorded. No schema/live write,
client send, provider call, pay change or work-state transition.

### U1/U3 checkpoint — keyboard status and rare queue actions

Added shared ActionMenu (arrows/Home/End/type-to-focus/Escape/Tab, focus return,
disabled reasons, viewport limits and 44px targets). Status uses the same guarded
actions and request IDs. Office overrides/removal are under More actions. Override
now uses the existing native ModalDialog and holds dismissal while saving or
escalating. Failed queue removal keeps its reason and shows an inline retry error;
successful removal/undo and permissions are unchanged. Focused lint and source
review passed. The concurrent reminder batch's full TypeScript run passed before
the last modal/failure-retention correction; final integrated gate remains. Browser
keyboard, mobile/zoom, screen-reader and pending/error acceptance are still blocked.

### Resume checkpoint — interrupted build recovered; C14 summary scope

The interrupted build at `cd3fc86` completed with exit 0 in the separate managed
checkout. Stable-tree TypeScript also passed. On the latest resume, no Ops Hub
build/test/migration/deployment process or listener on 3200/5599 remained; the
previous Claude demo stopped outside this work. Unrelated Premium Reel Claude
commands were left alone. Main branch is still `codex/audit-2026-09-30`.

Remaining Home summary sources now receive the same client identity exclusions:
owner project totals, delivery/reply/SLA/QC dials, active-work count, personal
flags before their cap, operational owner pulse fields, and handled-today.
Historical markers for deleted/unlinked work survive. Catch-up detection retains
its full activity context. Bank/ledger/AR figures keep Finance's existing full
definitions; scoping does not reclassify money or change a stored record.
`c14-home-summaries` passes 15/0; focused lint (one older queries.ts warning),
TypeScript and one focused source review passed. Two initial fixture assumptions
about appointment anchors and accounting dates were corrected, not product rules.
C14 signed-browser identity and summary test-view UI acceptance remain open.

Agent capacity recovered. Separate U1/U3 queue-menu, U4 task navigation and U5
reminder policy batches are underway. No approval pending, deployment, switch
change, production mutation or client/provider send. Browser access remains
policy-blocked; do not work around it with another browser or CDP.

### C11 checkpoint — signed first-month call processing and recovery

`client-call-journey` passes 25/0 using the actual one-time client login route,
signed owner/Kyle actions, worker and source records, with six fake model
responses. It covers required first-month CALL, discovery transcript/strategy,
manual approval and suppressed release, distinct monthly call/confirmed topic
selection, script switch hold, exact drafting/release/client acceptance, and
idempotent next sweep. No real model quality, booking or browser proof implied.

The failed-analysis retry correctly recovered its job but left the call's old
error visible. Successful processing now clears only the same-kind error it
captured before running, using an exact error/timestamp comparison; a newer
error during the job or another kind's error survives. Failed ProgramAiRun
history remains. No queue/scope/backlog or client-send policy changed. Real
production transcript worker remains OFF with its previously recorded backlog.
Focused lint passed; the shared typecheck saw the draft test's old invalid
version-month predicates, now corrected. Stable rerun/build is the next gate.


### C14 checkpoint — Slack/Done and recap scope

The interrupted agent's Slack/Done source edits were preserved and integrated.
The isolated drill passes 12/0: fixture rows do not consume normal Slack or
closed-task caps, exact linked Slack asks remain reachable beyond the oldest
page, normal Done count/history/recap agree, and cancellations remain separate
from completed work. Explicit test views retain fixtures. Recaps used a dummy
local key and intercepted HTTP response, with no real model spend. Focused
lint passed (existing queries.ts warning). Shared scope now has its own module,
avoiding a query/board import cycle.

Remaining C14 found in the actual Home composition: owner-only stats/pulse/
quality summaries, operational fields in ownerPulse, handled-today and personal
flagged work still use unscoped readers. Signed browser identity also remains
open. Do not call the whole Home fixture-free. The live demo from Claude's app
remains on 3200/5599; no build should use this checkout's `.next`. No active
migration/deploy command, production write, send or switch change.


### Signed editor and photographer checkpoint

C01 configured fake-provider regression found that owner preview could import
changed script words just by loading `/edit/[id]` (14/2). The page now skips
`autoSyncScript` while impersonating, preserving ordinary authorized sync.
The actual signed page function passes 16/0, covering anonymous/unassigned,
disabled account, retired per-output ownership, authorized office/editor and
read-only preview. HTTP middleware and actual browser behavior remain open.

C07 signed editor receipt/actions pass 13/0: loaded-message watermark, newer
unread message, old-tab monotonicity, failed create/update and retry, foreign
message refusal, preview/unassigned refusal. It writes no work/brief/task
completion. No C07 production source change was needed.

CP09 now enforces authentication with a real signed photographer and assigned
shoots. Final run 142/0 covers report failure/recovery, exact approved script
and topic/output identity, Pro chronology, fake Dropbox partial/retry behavior,
and refusal of other photographers or preview. A test-ordering mistake left
preview active before later sections; moving that case to the end fixed the
drill. All provider traffic stayed fenced. Final stable-tree typecheck/build
pending; no production write, send, activation or deployment.


### C14 checkpoint — Comms, Outbox and delivery follow-ups

`c14-comms-delivery-scope` passed 15/0. Normal Home/Tasks unanswered email,
Communications Email/Outbox and the draft-review batch filter synthetic clients
before caps; explicit test views retain them. More than 3,000 fixture messages
cannot crowd out real/protected clients, and old real obligations remain.
Phone navigation preserves explicit channel choice. The draft modal discards
obsolete load results and remounts when scope changes, preventing stale test
rows from replacing the real-client view. No send execution changed.

Home and Review Room now share scoped ready/rendering cuts, incomplete delivery,
client-not-told and notification incident readers. Fixture piles cannot consume
follow-up caps. Office health timestamps remain live; project reads cannot
claim global success. Default complete readers remain available. Focused lint
passed; two in-flight drill typing errors were corrected. Final stable-tree
shared typecheck/build pending. Slack/Done and signed browser identity remain
open; no live mutation, provider call or send occurred.


### W03 checkpoint — signed roles and concurrent revision receipts

The signed action drill exposed two simultaneous submissions with the same
request key creating two revision briefs. `createRevisionBrief` now uses the
existing transaction advisory lock for `review_room_staff` source/request keys,
reusing the first exact words/version/clock. Other sources can still record
separate asks on one thread. PGlite 25/0 and disposable Postgres 26/0 passed;
four backends and an actual advisory-lock wait confirm the race ran. Kyle and
James's named creative-review seat pass; editor, other photographer, signed-out
and owner-preview sessions are refused. Removing James's saved seat takes
effect on his current cookie. Delivered history stays intact; the task routes
to Kim without Start. Earlier activity or attachment attempts are outside this
receipt transaction. Focused lint/diff passed; shared typecheck in progress.
No schema, production write, provider action, push or deployment.


### C14 local checkpoint — radar and destination counts

Strategic flags now scope delivery exceptions, AR, VIP and stale revisions
before query caps (`c14-strategic-flags` 10/0). Home's Other and media-check
badges share predicates with Tasks Other and Review Room; Tasks Other retains
an explicit test-record toggle (`c14-other-qc-scope` 10/0). Unlinked work,
current editor scope and real TEST addresses remain visible. Focused lint
passed, with one older queries.ts warning. Final shared typecheck is pending
following a corrected property typo in the new signed-journey drill.
Comms/Outbox, ready-to-send follow-ups, Slack/Done and signed browser checks
remain open. No live write or external action.

### Sep 30 resumed checkpoint — signed client and delivery actions

The interrupted build in the clean managed worktree at `21aa4aa` reached final
`next-build` trace completion and emitted BUILD_ID/required-server-files at
20:58 ET. Its terminal exit code was lost. Read-only process inspection found no
Ops Hub dev/build/test/migration/deployment command running; the unrelated
Premium Reel Next14 server on port 3100 was left untouched. No build rerun was
needed solely to recover that state. A later 21:12 ET snapshot found the isolated
demo launcher running from the main checkout since 21:02 on 3200/5599. It was
identified and left untouched; use the separate managed worktree for builds.

`client-written-journey` passed 23/0: actual one-time login route, normal named
pilot owner cookie, first-month call protection, later written planning and
answer submission, staff-only approval/canonical release, exact client
acceptance, newer release needing a fresh decision, stale refusal and revoked
seat denial. Only request cookie transport is injected; the real resolver and
signed staff/client authorization execute. The manually authored script uses
that interview's exact answer IDs. No model/provider/outbox/booking request.
The newer-version replay exposed a script-wide office-notification key; it now
includes the accepted version. Both acceptances create distinct notices and a
retry creates neither another decision nor notice. This does not close browser,
discovery/monthly-call or final-media acceptance.

CP06 is now 130/0. Its previous three failures came from a normal-client test
seat being correctly excluded under TEST_ONLY; the isolated fixture now admits
only that seat for sign-in, proves refusal before/after, and creates no outbox
or enabled invite switch. Production access rules are unchanged.

W04 is now 34/0 under enforced actual signed ADMIN/client/editor/preview
sessions. Kyle's public attestation saves his real user ID; both manual exact
cut send paths pass. Client, unassigned editor and owner preview cannot read,
check, send or complete Kyle's delivery task, with no extra provider reads or
persisted changes. Aryeo reads are fake; normal browser and real rendition
playback remain open. All five additive tables remain unapplied. No push,
deployment, live mutation, client communication or automation activation.


### Earlier checkpoint — C04 provider recovery and C14 Home scope

C04 now has a fake-provider boundary replay: Slack explicitly refuses the DM,
`NotificationDelivery` records failed, the brand row stays `delivery_failed`,
and the expired claim retries the same notification once after the simulated
provider recovers. A process interruption after accepted delivery reuses its
receipt without another DM. An existing bell with no channel leg is marked
`delivery_unknown` for staff instead of blindly resent; three explicit
failures end `delivery_unreached` and no fourth DM is attempted. The
`c04-brand-provider-recovery` drill passed 12/0, including a failed catch-up
retry that retains its dispatch-hour notification key; the prior claim/catch-up drill
8/0, Node20 TypeScript and focused lint passed. The catch-up claim keeps its
original hour in the notification key on retry. No production provider call,
database write, switch activation, push or deployment. The local brand alert
switch remains OFF in production. The existing five-table additive schema
release gate remains, followed by normal-role/provider observation; C04 is
local code/test evidence, not client-visible proof.

Home and Project Tracker now read the same normal delivery board with synthetic
client jobs excluded before the 400-job cap; an explicitly indexed extra-shoot
source is filtered before its 200-row cap too. `/pipeline?test=1` restores the
full board and labels that view. Isolated `c14-delivery-board` passed 4/0,
including a real TEST Avenue title and protected real client. Node20 TypeScript,
focused lint and an isolated-worktree production build passed. The loopback browser action is still blocked by
policy, so this is source/fixture evidence only. No production DB/provider
write, push or deployment. Off-page task badges, ready-to-send follow-ups and
strategic flags remain open for C14.

Home's Stuck jobs panel and seven-day appointment strip now exclude synthetic
project/client rows at their database reads. The same client ID list is passed
into the operating-day reader so this does not add another all-client scan.
The isolated `c14-home-windows` drill passed 5/0: real TEST Avenue and a
protected real client remain in both readers, synthetic fire/appointment rows
do not, and default full readers retain them. Node20 TypeScript and focused
lint and the isolated-worktree production build passed (one pre-existing
unused-import warning in `queries.ts`). Off-page task badges, ready-to-send and strategic flags
remain open for C14 scoping; no production or provider mutation was made.

A read-only Neon probe (`scripts/_recon/c14-home-workload.ts`) found five
synthetic clients, three active TEST Review projects, and two open TEST tasks;
this was a current Home operating-day count issue, not only a theoretical cap.
`buildOpsDay({includeTest:false})` now excludes synthetic client/project rows
before its shoot, QC, pipeline, Review count, revision, and loop caps; its
unanswered-client and pending-cut lists use the same IDs. Shared reader defaults
retain their full view. The Tasks Revisions tab now uses that normal reader for
its badge and list and offers `?test=1` to show fixtures; the tab link retains
that view. The isolated `c14-home-day` drill passed 7/0 including review,
revision, pending cut, loop, protected-real and shared Tasks reader counts;
provider traffic was fenced. Node20 TypeScript and focused lint passed. The
component itself has not had a browser replay because the loopback browser
action was policy-blocked. The isolated-worktree build passed.
Ready-to-send follow-up lanes,
off-page badges,
and signed browser identity still need C14 scoping/proof; do not claim all Home
workload totals are clean.

The New clients card now also removes synthetic arrivals before its six-row
cap. The isolated `c14-new-clients` drill passed 3/0: eight newer fixture
arrivals did not crowd out a real arrival or a protected real client renamed
TEST; the explicit full reader retains fixtures. Node20 TypeScript and focused
lint passed. A browser security policy blocked opening the loopback demo tab
in this run; no alternate browser path was attempted. A demo process already
running from this checkout was inspected and left untouched. The remaining
Home workload readers and signed browser identity still need focused checks.

The normal Home exception board now excludes synthetic client rows at each
source query, before its row caps and totals are computed. It covers editing
assignment, review, follow-up, render, library, reopened delivery, order scope,
AutoHDR and at-risk promises. An explicit full board read still includes test
records. The filter uses `isSyntheticClientRow` on client ID and name, so a
real job titled TEST Avenue and the protected real Jordan client are retained.
The isolated `c14-home-counts` drill passed 8/0 across four count categories,
including a synthetic follow-up pile larger than the display cap; the older
scope-exceptions regression passed 28/0. Node20 TypeScript, focused lint and
production build passed. No provider call or production write. Next, verify
the signed browser identity and remaining C14 normal Home surfaces.

### Current resume point — C14 demo and communication identity

The loopback demo's existing representative month already has believable
Market Authority, Neighborhood Life and Seller Playbook pillars, topic-specific
scripts with three points and a spoken close, and a resettable isolated database.
The C14 smoke drill now asserts those facts. Its initial Sep 30 run was 85/1:
Parker Pro had only one confirmed request. Both late-month requests were
flexible-time asks and collided on the same `<enrollment>:<month>:flex` key.
`createSessionRequest` now distinguishes explicitly indexed flexible asks;
unindexed legacy requests keep the old key. The representative fixture passes
session index 1/2, and the fenced demo drill is 89/0, including a repeated
second ask resolving to its own confirmed row. TypeScript and focused lint pass.
The fixture's manual confirmation has no Aryeo appointment and does not prove
provider-backed booking. No production database or provider write occurred.

C14 communication identity source is now measured. A read-only Neon inventory
(`scripts/_recon/c14-identity.ts`) found two real Jordan Spackman client rows,
one Jordan Spackman TEST row, and **no direct phone collision** between the
real and TEST rows. The TEST phone instead matches Jordan's team member row
and a generic Realtour Pilot contact. A bounded read-only OpenPhone list
(`scripts/_recon/c14-openphone.ts`) returned 469 conversations; 24 include the
TEST phone, many in groups, and their provider group names are null. The old
inbox and thread participant readers named that phone from the synthetic
client before the team row. The new readers name the team person first, keep
the conversations visible, and do not attach the fixture's client context to
a team member. Duplicate real client numbers are ranked among real candidate
rows using the existing activity/parent rule instead of database row order.
Read-only replay prints Jordan Spackman/no client context for the TEST/team
phone and Jordan Spackman/real client context for both real phone rows. This
passed Node20 typecheck, focused lint (one pre-existing `isProjectRecent`
warning in `queries.ts`) and production build. It still needs a normal signed
browser replay; the two real Jordan client rows
remain distinct and were not merged. Read-only snapshots also found an empty
global failed-automation index and 11 Home exceptions with no TEST-labeled
title; those snapshots do not prove all production counts are isolated.

The next C14 batch scopes the roster's failed-automation index by durable
client identity, including global cut-transcript failures with a missing
project pointer (resolved through the submission). The Monitoring ledger still
contains every TEST failure, and the explicit test view includes it. An empty
normal roster still reports real global failures. The isolated failure drill
is 5/0 after a legacy-cut fallback check. Delivery reconciliation no longer
skips a real job merely because its title says TEST; it skips only a synthetic
client row. The isolated delivery drill is 3/0 with no provider request. Home
exception totals remain to scope; a clean live snapshot alone is not proof.

### Current resume point — C13 month next-action reconciliation

`3ffef4f` adds the missing output-link check to both staff readers. The second
read-only Neon replay found Rick has four September topics and four draft
scripts linked to topics, but his two delivered videos have no topic link.
Mike Flatley's two delivered videos are likewise unlinked; Erica, John and
Mike Ciunci have confirmed filming without September topic rows. All five
now show staff-owned topic-link reconciliation in the roster and client file.
Rick's drafts remain intact; the UI does not guess which are for the two
remaining videos. The portal topic reader reports four selected for Rick but
zero visible September selections, so normal signed-role portal replay is
still required. No production record was edited.

The isolated CP-10 drill now passes 135/0. It creates an unlinked filmed
allowance video over selected topics, sees reconciliation in both readers,
then links that exact video to a topic and sees script review resume. It also
keeps a released cut's live client approval or staff send ahead of the older
link repair. Final Node20 TypeScript and focused lint pass. The production
build passed after the output-link code and before the final narrow roster
review-priority refinement; that final code has TypeScript/lint and the
isolated drill, but has not had another build run. No schema changed.

`759d2fb` repairs the second staff next-action ladder (`monthProgress`), which
still told filmed legacy clients to plan or called existing drafts ready for
approval even after the roster had been corrected. Confirmed filming with
missing topic/route links now stays with staff reconciliation. A draft says it
needs work; only a current internal-review script asks for approval. The v1
portal Home also stops offering a new planning call after filmed work.

The first read-only Neon replay `scripts/_recon/c13-current.ts` on Sep 30
checked Erica Walker, John Collins, Mike Ciunci, Mike Flatley and Rick Schultz.
It made no database write.
The isolated CP-10 drill passed 132/0, including a filmed legacy Pro reminder
that offered the remaining session without a planning chase, a partial Pro
with five selected topics, a separately counted filmed extra, a next-month
planning step and draft versus internal-review script wording. Final Node20
TypeScript and focused lint passed; production build passed after the source
repair, before the small delivered-done ordering change and final test-only
assertion. The isolated Avery client file rendered at desktop and 390px with
the script owner/action readable and no document overflow. The demo is stopped
and its worktree is clean at `759d2fb`.

The broader UI-01 drill reports 91/1: its v1 page must exactly match the old
`7d0d5c9` tree, and later action styling already changed that tree. The same
91/1 occurs on clean `808f6fe` before this batch; the C13 action checks pass.
Do not treat that old full-tree snapshot as proof that current v1 behavior is
unchanged. Refresh or replace that assertion in a separate, focused UI-01
test-maintenance batch if needed.

C13 stays partial: have staff verify the source identity for the named missing
links before any targeted repair, replay normal signed client v1/v2 and
provider-backed reminder outcomes, and determine any genuine policy choices
before client rollout. No client send, invitation, provider booking, automation,
production DB mutation, push or deployment was performed.

### Current resume point — staff keyboard dialogs and mobile menu

`dc33727` adds an explicit leave/keep choice when an editor has unsaved
self-check answers. The first Escape or Not yet opens it; Keep checking
preserves the answers, and Discard answers closes by deliberate choice.
`8f47f43`/`808f6fe` keep a repeated Escape inside that choice: the first
replay exposed a native-dialog close that left the React form mounted but
unopenable, so the modal now intercepts Escape while the choice is present.
In the fenced TEST fixture, repeated Escape kept the choice and the answer,
Keep checking returned focus to Close with the answer intact, and Discard
answers closed and returned focus to Open self-check. Node20 TypeScript,
focused lint and the final production build passed. The
temporary fixture was removed and the demo stopped, clean at `808f6fe`.

`5d52526` adds a shared native modal wrapper for the editor's send-for-review
check and Kyle's draft-update dialog. It opens in the browser top layer so
background controls are inert and Tab stays inside; Escape closes only when a
submission is not pending and focus returns to the trigger. `316549e` puts
initial focus on the self-check heading or the draft time field. `5ac3a52`
raises their visible decision, close and entry controls to 44px; `40b0d67`
guards cancellation in the narrow interval before a pending render appears.
The mobile staff drawer now has its own Close button, traps Tab/Shift+Tab,
makes the covered main column inert, and returns focus to Open menu. A staff
Skip to content link targets the existing main area.

Node20 TypeScript, focused lint and production build passed at `5ac3a52`;
TypeScript and focused lint passed after the final cancellation guard. In a
temporary, provider-fenced TEST UI fixture, keyboard Enter filled the six
self-check lines, a simulated refusal left all answers in place, and Escape
returned to Open self-check. The draft dialog opened with focus on its time
input and Escape returned to Draft update. At 390px neither dialog caused
horizontal overflow and the sampled controls measured 44px. The drawer's
Shift+Tab/Tab wrapped between its last control and Close menu, Escape returned
to Open menu, and Skip to content focused `staff-main`. The temporary fixture
was removed; the demo is stopped and clean at `40b0d67`. No form was sent,
no provider or production write occurred, and nothing was pushed or deployed.

UX14 remains partial: replay the real signed editor and Kyle contexts, test
pending request timing, and finish the custom status menu keyboard pattern.

### Previous checkpoint — Kyle's ready-file row

`2114488` makes the ready row lead with the client and linked month/topic on
monthly work, or the property and client on listing work. It names the exact
cut/version, Kyle, age, portal/Aryeo state and next action. A missing topic
remains explicitly unlinked; it is not guessed from the property placeholder.
Filenames, source explanation, Dropbox link and noncritical listing evidence
sit under File and delivery evidence. Contested or possibly matching listing
media remain visible on the row. The download stamp now reads **Download
started**, because the route only proves a link handoff or stream start, not
complete device receipt or client delivery. Monthly rows say the Aryeo-copy
requirement is unresolved; the existing send action and gates were preserved.

Node20 TypeScript, focused lint and production build passed. The isolated B4
delivery drill passed 122/0, including two new checks for the real month and
the exact output's linked topic, with null left null. In the fenced TEST Home,
the two Morgan rows showed the month, missing topic, version and route warning;
Details expanded to the file evidence. At 390px the page had no horizontal
overflow. Download and Mark as sent were not used. The demo is stopped and
its worktree is clean at `2114488`. No live DB write, provider action, push or
deployment occurred. UX10 and W05 remain partial: resolve portal versus Aryeo
policy per affected monthly job, then test actual provider outcomes, a partial
download, normal staff roles, and a listing row with contested evidence.

### Previous checkpoint — readable action and status colors

`9f9213f` adds a separate filled-action orange while retaining the decorative
brand accent, moves portal white-on-orange controls and the Editing Room/ready
delivery first consumers onto it, raises secondary text contrast, and gives
the Editing Room filter and ready-file Download 44px targets. `SimpleQueue`
status/type pills now use the same theme-aware colors as `Badge`. A browser
check found light amber status ink still short of the normal-text target, so
`a65a6de` raises the light badge mix from 42% to 50%.

Node20 TypeScript, changed-file lint and production build passed. Rendered
client Approve script measured white on `#b94008` (about 5.53:1, 44px); staff
dark uses `#c2450c` (about 5.06:1). Secondary text token pairs calculate
about 5.46:1 on light white and 5.47:1 on dark surface. The light Editing
Room amber pill measured about 5.05:1 after the second commit; the dark pill
uses its original 18% lift. At 390px the Editing Room had no horizontal
overflow and its active filter measured 44px. The demo is stopped and clean at
`a65a6de`. This is a sampled contrast fix, not a full accessibility pass:
remaining typography, dialogs, form feedback, role views and U1–U6 acceptance
are tracked below.

### Previous checkpoint — written-answer suggestion safety

`bc44dbf` keeps a suggestion's source pointer with the scoped, browser-local
answer draft. The pointer is restored only for that client/enrollment/month/
interview/question, survives edits and refresh, and is removed with a saved
answer or emptied draft. The server still re-resolves it and treats edited
words as a typed answer based on a suggestion, never as verbatim call text.
Choosing a suggestion over existing words now previews the current draft and
suggested replacement; Add preserves both, Replace offers Undo, and switching
questions cannot carry the prior question's source. Editing clears stale save
errors. No submission, drafting or clock rule changed.

The CP08 isolated drill passed 80/0; Node20 TypeScript, focused lint and build
passed. In the fenced browser, a synthetic invalid-interview fixture showed
Add, replacement preview/Undo, refresh recovery of words and source, and
question separation. The rejected Save retained the edited text and source;
the server log showed the correct suggestion ID on the failed request. Demo
DB answer and script-version counts stayed 42/18. At 390px the preview had no
horizontal overflow. The temporary route was removed; demo stopped and its
worktree clean at `bc44dbf`. A normal signed client route was also opened,
but its existing topic had no suggestions. UX08 still needs a normal
suggestion-bearing account and storage-denial/retry check before closure.

### Previous checkpoint — editor brief script presentation

`ae07289` replaces the editor brief's separate plain-text per-topic script
display with `ScriptView`. The same Hook, Talking Points and Close structure
now appears in the brief. The script standing and version still come from the
same filmed/shared/draft reader, and the existing role-based money scrub runs
before text crosses into the client component. The brief has no pillar-link
data, so it suppresses the renderer's missing-pillar claim; a category in the
safe script text still appears. An all-scrubbed script gives a truthful
placeholder. Copy/Download are off because this brief carries clipped text.

The isolated CP09 handoff drill passed 139/0. Node20 TypeScript, focused lint
and production build passed. In the provider-fenced Avery TEST editor brief,
the approved version-1 script and an unapproved draft expanded into structured
sections. The 390px page had no horizontal overflow and displayed the script
readably. No Start, script decision, provider action or production write was
made. The demo is stopped; its clean worktree is at `ae07289`.

UX09 remains partial: verify signed editor money filtering, normal client
roles, injected comment/revision failures, real portrait/landscape files and
phone download. Then finish the U2 planning, brand and booking journeys.
U0–U6 and the five-table release gate remain open as tracked below.

### Previous checkpoint — client video review layout

`2162186` caps the portal video player at the available 70vh/760px bound
with `object-contain`, preserving portrait and landscape aspect ratios. On
desktop, the current cut sits beside its exact-version notes and decisions;
on phones the same controls follow the player. The player remains visible
while scrolling the desktop review column. Primary note, request and approval
buttons are 44px tall. The version pin, comment writer, review window,
download gate and confirmation rules are unchanged.

The isolated CP03 revision drill passed 52/0; Node20 TypeScript, focused
lint and production build passed. The provider-fenced Avery TEST review
played the exact current cut from local sample media. At 1280x720, the
portrait box was 504px tall and the note/decision controls sat beside it;
at 390x844, it was 576px tall and the controls stacked below, without page
overflow. The main decision buttons measured 44px at both widths. Keyboard
Enter opened the version-1 approval confirmation, and Not yet cancelled it.
No note, change request or approval was submitted. The demo was stopped;
its clean worktree is at `2162186`. No live DB write, provider call, push or
deployment occurred.

UX09 remains partial: replay normal client roles and injected comment/revision
failures, verify real portrait/landscape files and phone download, then reuse
the shared script renderer in the editor brief after confirming its audience
and money scrubbing. The complete U2 journey and other U0–U6 items remain.

### Previous checkpoint — client script reading

`4ad0993` gives the client Scripts queue a 70-character reading width,
16px/28px body text and more space between Hook, Talking Points and Close.
Its month and exact script version are legible beside the title. The existing
ScriptApprovalCard still sends only the version rendered on the page; its
client decision buttons remain 44px tall through phone, tablet and desktop
breakpoints. Closing and reopening Request changes keeps an unsent note;
editing after a failed request hides the old retry closure so it cannot send
stale wording. The rest of the shared renderer and staff views keep their
prior sizes. No version, approval, release or permission rule changed.

The isolated UI01 drill passed 92/0; Node20 TypeScript, focused lint and
production build passed. The provider-fenced Avery TEST portal rendered
September script v1 at 16px with 28px line height; both decision buttons
measured 44px at desktop, 768px tablet and 390px phone widths, with no phone
horizontal overflow. An unsent TEST note remained after closing/reopening
the request panel. No script decision or client message was sent. The demo
server was stopped; its clean worktree is at `4ad0993`. No live DB write,
provider call, push or deployment occurred.

UX09 remains partial. Next: cap the portrait player and put the exact-version
review controls beside it on desktop and beneath it on phones; then replay
client comment/revision failures and the editor's approved-script brief with
normal roles. Continue the U2 route/brand/booking journeys and keep the
five-table schema release gate intact.

### Previous checkpoint — client answer draft isolation

`1f2d933` scopes the existing sessionStorage answer draft by client, enrollment,
month, interview and question. It restores an old-key draft when present,
prevents a previous question's words appearing during a question switch, and
adds an explicit retry if browser storage is unavailable. The copy now names
the actual Save & next or Save new answer action. These are browser-local
drafts; only that action sends words to the team. No draft storage action
enqueues a script, submits an interview or changes the preparation clock.

The isolated CP08 drill passed 80/0; Node20 TypeScript, focused lint and
production build passed. In the provider-fenced Avery TEST interview, an
unsent draft survived refresh and reopened on the same question. Opening the
corresponding Parker Pro TEST interview in that tab showed only Parker's
stored answer. Read-only demo DB checks before and after both showed eight
answer rows, zero script versions and no preparation timestamp for Avery's
interview/month. The editor at 390px had no horizontal overflow. The browser
tab and demo server were closed; the clean demo worktree is at `1f2d933`.
No client answer was submitted, and no live DB write, provider call, push or
deployment occurred.

UX08 remains partial: inject a browser storage failure, verify retry and
retained text, and exercise Add/Replace/Undo on an isolated suggestion.
The complete written/call route and normal client-seat journeys are still
required. Five additive tables remain local only.

### Previous checkpoint — guided Your Month work area

`7b07840` keeps the existing one-current-step planning model and changes its
presentation. The current call booking or filming picker expands in place;
booked-call management and the month topic list fold into labeled disclosures
when a later step is current. Filming remains reachable on the separate
Appointments page, and a released script keeps a Review script link on its own
step for deep links. Completed stages are compact, with truthful links to
their available views. No route, eligibility, allowance, version, booking,
notification or release rule changed. The topic bank still opens during
topic/answer work.

The isolated `b2-planning` drill passed 153/0. Node20 TypeScript, focused
lint and production build passed. The provider-fenced Avery TEST portal was
checked on desktop and at 390px: current September script review was clear,
chosen topics started folded and opened on request, the page had no horizontal
overflow, and the deep-linked step opened September script v1. The demo was
stopped; its clean worktree is at `7b07840`. No client approval, booking,
provider message, live DB write, push or deployment occurred.

UX07 and U2 remain partial. Next: verify a normal signed client seat through
the written route and first required/later optional call routes, including
answer submission, schedule later, Pro session two and script review, using
only isolated fixtures. The rest of UX08/UX09, brand, video review and other
U2 acceptance work remains. Keep the five-table schema release gate intact.

### Previous checkpoint — bounded project chat reads

`ede6acf` puts a read-only team-message cue near the editor brief's work
controls, linking to the conversation far below. A read failure is shown as
unknown, never as zero. `4729c87` fixes a race found during verification:
ProjectMessages now freezes the last message ID present when that conversation
opened, including its Retry control. Same-project server refreshes do not
silently acknowledge a message that arrived later; switching to another
project begins a new reading visit. Page load alone still writes no receipt.

Node20 TypeScript, focused lint and production build passed. In the signed
owner, provider-fenced Parker TEST route, opening the brief left ThreadRead
null. After adding a new TEST message to PGlite, opening the chat saved the
timestamp of the second previously loaded message, while the new third one
remained unread. A fresh 390px load showed one new-message cue beside the
unchanged manual Start/Pause bar. Normal editor-role, read-only preview and
read-save failure checks are still open. The demo server was stopped; its
worktree is clean at `4729c87`. No production DB write, provider send, push
or deployment.

### Previous checkpoint — notification read feedback

`ce2a027` repairs the bell's optimistic Mark all read behavior. The button
shows Saving, changes the count/highlight only after a confirmed JSON response,
and shows an inline error with the prior unread count if the request fails or
its outcome is uncertain. The API now uses a conditional monotonic watermark
write, so an older tab closing cannot replace a later explicit all-read mark.
No notification kind, audience, channel preference or source task changed.

The isolated `journey-comms` drill passed 170/0, including a stale-tab request
against the newer saved mark. Node20 TypeScript, focused lint and production
build passed. In the signed, provider-fenced demo at 390px, a temporary forced
POST 503 preserved six unread and showed the error. The temporary override was
then removed; the next request returned 200 and the badge cleared only after
that response. The demo server was stopped and its worktree is clean at
`ce2a027`. These are TEST notifications, not a live staff read mark. No live
database write, provider send, push or deployment.

### Previous checkpoint — team conversation filters

`19e7a00` extends the existing two-pane team message center in Communications
and Editing Room with URL-backed All, Mine, Unread and Active work filters.
Mine includes explicit team-roster assignments, authored messages and direct
mentions; an unlinked login does not acquire guessed ownership. The rail and
thread header show month and topic only from saved program/project/video links,
and opening a thread preserves its filter. No message-send or assignment rule
changed. Node20 TypeScript, focused lint and production build passed.

The provider-fenced demo was signed in as the demo owner after adding three
clearly marked TEST messages and a TEST roster link to its isolated PGlite
database. All/Mine/Unread/Active counts were 4/1/3/3; reading the tagged
thread lowered Unread to 2. Active excluded the delivered August job; the
month/topic labels and same filters appeared in both routes. The 390px phone
layout had no horizontal overflow. The demo server was stopped; its worktree
is clean at `19e7a00`. Normal Kyle/James/editor accounts and message volume
remain untested. No production DB write, provider send, push or deployment.

The C15 tracker was corrected: Review Room already has `DeliveryExitSummary`
and labels mixed media checks accurately. Its no-cuts/other-work state remains
to verify before closing C15.

### Previous checkpoint — W05 focused delivery text check

`35819c0` gives every job-level delivery-text incident an opaque outbox ID
link from Home and Review Room. Communications resolves that ID server-side,
admits only delivery texts, shows the exact intended text and recorded state,
and narrows the OpenPhone inbox to conversations with the recipient. Phone
numbers and draft words are not put in the URL. The focused view has no
send/retry/settle control; an unknown result remains unknown.

The isolated W05 drill passed 10/0, including rejection of an unrelated
failed text and bad ID. Node20 TypeScript, focused lint and production build
passed. A synthetic Avery TEST unknown outbox row in the provider-fenced demo
appeared at the Review Room exit and opened the correct Communications card
on desktop and 390px. OpenPhone is deliberately disconnected there, so live
thread matching and a normal signed-role route remain release checks. The
demo server was stopped; its clean worktree is at `35819c0`. The fixture is
disposable demo data. No production write, provider send, push or deployment.

One genuine policy decision is pending with Jordan: whether Kyle may mark an
unknown delivery text as found in OpenPhone with attributed evidence, or
whether only automated provider reconciliation may settle it. Until then the
UI gives direct context but does not clear the unknown row or offer a retry.

### Previous checkpoint — client script scope in Your Month

`a9743fe` makes the client Plan subviews name their actual scope. The guided
month says it is the current month's plan; Scripts says it is a review queue
across all program months; Topic bank and Strategy identify their wider
account scope. Script cards and previously answered rows name their own month,
or say no month is assigned. The phone tab now says “Topics” in full. This
changes presentation only; script version/approval and month planning rules
are unchanged.

Node20 TypeScript, focused lint and production build passed. The isolated
Avery TEST client browser showed the all-month heading, September/version on
the pending script, and readable phone navigation at 390px. No approval or
request was submitted. The provider-fenced demo server was stopped, and its
clean worktree is at `a9743fe`. UX15 remains partial: appointment/library
month context and a normal client seat journey still require testing; no
client portal layout gate was changed. No production write, client send,
provider call, push or deployment occurred.

### Previous checkpoint — UX15 Editing Room URL context

`8eb9754` and `6d0a463` finish the queue's first U3 phone layout batch:
the same rows become stacked cards below `sm`, with visible stage, due,
editor, files and chat labels. Phone controls and essential text are larger;
desktop remains a comparison table. Node20 TypeScript, focused lint and final
production build passed. The isolated Avery Kim/overdue row was visually
checked at 390px and desktop without horizontal card scrolling. This is not
a whole-site touch or accessibility pass, and the assignment/status controls
still need a normal signed-role replay. The demo server was stopped and its
clean worktree is at `6d0a463`.

`530d43c` saves the Editing Room tab, editor and due filters in a validated,
shareable URL. Job links carry only those choices back to the queue; the edit
page's return link prefers that explicit context, including in a new tab.
The queue records scroll position for the return in session storage and clears
it after restoration. No server reader, permission, assignment or database
schema changed.

Node20 TypeScript, focused lint, production build and four pure URL checks
passed. A provider-fenced isolated demo fixture put one Avery TEST row with
Kim and an overdue office due date. Browser replay: select Kim + Overdue,
open job, return, refresh and open the copied queue URL in a new tab; all
showed the same single row and selected filters. The fixture was
only in the disposable demo database. No production write, provider call, push or
deployment occurred.

UX15 remains partial for client month context through plan/scripts/sessions/
library and a normal authenticated queue replay. Continue U3 role/touch checks
and the open functional/operating work. Five additive tables remain local;
none has been applied to live Neon.

### Previous checkpoint — W02 in-house brief receipt

`6693c47` adds `EditorBriefReceipt`, a fifth additive local table for a named
in-house editor's receipt of one output's current brief. The snapshot pins
video identity, saved owner, deadline, directions, script standing/words,
chosen brand asset version and source folder. A changed digest asks for a new
receipt; the old receipt stays. An editor can only record their own assigned
video, never an office preview. Receipt does not start, pause, approve or
deliver work. The job read guard now admits a current per-output owner, which
the isolated drill proved was otherwise denied the very brief they own.

The signed-session isolated W02 drill passed 15/0: stale version, repeat,
brief change, reassignment, cross-job id, retired output, owner preview and
unchanged Start/Pause state. Node20 TypeScript, focused lint and production
build passed. The provider-fenced demo was reset to the new isolated schema,
its Prisma client regenerated, and the unassigned receipt state was checked
at desktop and 390px on Avery TEST. The demo has auth disabled, so the editor
button and read-back still need a normal browser role replay. The demo server
was stopped; the clean demo worktree is at `6693c47`.

W02 remains partial: a real multi-output assignment/brand/source replay,
normal signed editor and office browser checks, intentional no-brand policy,
and whether reassignment back to a prior editor requires a new receipt.
`EditorBriefReceipt` has **not** been pushed to production; all five additive
tables remain local. No live database write, provider call, send, push or
deployment occurred. Continue open operating work and UI U0–U6; do not
describe the editor receipt as deployed or client-visible.

### Previous checkpoint — W06 fresh handoff evidence

`18a3d94` adds a read-only Dropbox check when the photographer opens the final
handoff review. It uses the job's recorded current folder, counts RAW-Photos
and searches video under the listing (matching the existing submit gate),
records the check time, shows where video was found, and keeps a failed read
unknown. The review waits for the check before its final button is available;
if the reviewer leaves it open for over two minutes, confirmation reopens a
new check. A checked deliverable remains the photographer's report. The saved
receipt's older status count is now described as a recorded check, never as a
fresh read on submit. No schema or provider write was added.

Isolated handoff drill passed 119/0, B4 upload regression 69/0, Node20
typecheck, focused lint and final production build passed. The demo browser
showed the synthetic Avery TEST review at desktop
and 390px, with 4 filmed, 1 unfilmed, 1 still owed, editor vision and an
explicit unknown Dropbox result. No final submit was clicked. The demo server
was stopped; its clean worktree is at `18a3d94`.

W06 remains partial: normal authenticated photographer browser journey,
current production file locations and field-use acceptance. The demo had no
Dropbox connection, so the live found/zero path is verified by the stubbed
isolated drill only. The `ShootBriefRead` table and the other three additive
tables remain unapplied to live Neon. No production database write, provider
write, send, push or deployment occurred. Continue W02 acceptance and the
other open operating/UI work; do not mark the journeys client-visible.

### Previous checkpoint — W05 delivery-text exception visibility

W06 pre-shoot receipt is committed through `b742421`; see the checkpoint below.
`916a30c` extends the shared `readyToSend` board used on Home and Review Room
with delivery-text states from the existing `OutboxMessage` ledger. A queued,
in-progress, failed or unknown job-level delivery text is distinct from the
exact video cut. Newer accepted attempts supersede older failed rows, a
released failed identity is matched through its delivery-text task, cancelled
jobs are excluded, and an unreadable outbox lane reports unavailable instead
of all clear. No send, retry, or provider call was added. `e4d79a2` corrects
the Review Room copy and links an unknown send without a task to Communications
for a human to inspect its OpenPhone conversation.

Isolated W05 notice drill passed 8/0, including failed/unknown/accepted retry,
unrelated text exclusion, per-job scope and simulated outbox query failure.
Node20 typecheck, focused lint and build passed; a later small copy/link fix
passed typecheck and lint. A synthetic unknown send was written only to the
provider-fenced TEST demo database and visibly appeared at the Review Room
exit with Kyle, age and a reconcile instruction. The demo server was stopped.
No real provider call, client send, production write, push or deployment.

W05 remains partial for per-job monthly portal versus Aryeo-copy policy, real
provider-outcome reconciliation and normal auth, plus a direct unconfirmed
send settlement flow in Communications. W06 still needs fresh raw-file reads
and normal photographer browser testing. Four additive local tables remain
unapplied to production. Continue the audit execution order and U0–U6; do
not describe client release or operational acceptance as complete.

### Previous checkpoint — W06 pre-shoot brief read

W06 upload/handoff code and notes are committed through `24eb0ab`.
`3ba7982` adds `ShootBriefRead`, a durable per-project/per-photographer
snapshot of what the field brief showed. The shoot page compares the last read
with current released scripts, topic choices, field direction, per-video
briefs/chosen assets, pronunciation and references. The assigned photographer
can mark the current version read; the server re-reads it and refuses a stale
page digest. Owner previews and unassigned photographers cannot mark it read.
`967390c` adjusts the prompt for office viewers who cannot acknowledge.

The isolated W06 brief drill passed 13/0, including actual signed session
cookies, assignment/preview authorization, stale version refusal, idempotent
repeat, exact script/shot-list delta and preserved prior snapshot. Node20
typecheck, focused lint and build passed; the small viewer-copy follow-up
passed typecheck/lint. The isolated demo showed the pre-shoot card, current
released scripts, expanded script readability and mobile layout at 390px.
The fenced demo server was stopped and its clean worktree now points at
`967390c`. No production mutation, provider call, client message, financial
change, push or deployment occurred.

W06 remains partial: actual raw location/fresh Dropbox verification, a normal
photographer browser journey, and any final grouping of game-plan/must-get/
avoid content remain. `ShootBriefRead` is a **fourth** additive local schema
table; none of the four tables has been pushed to live Neon. Production backup
and schema-diff evidence from this takeover remain valid; recheck the live
diff before a schema rollout and obtain deployment approval. W05's failed or
unknown notification/provider states and monthly policy are still open; then
continue Kyle/James operating work and U0–U6. This is a checkpoint, not
release acceptance.

### Previous checkpoint — W06 photographer handoff

W05 is committed at `07d25d1` plus `d68b99c` (verification and a monthly
route link correction). W06's first commits are `895601a` and `13b0d77`.
Before submitting an upload page, the photographer now reviews the actual
photo/video half, filmed and unfilmed topics separately, off-script titles and
notes, raw folder destinations, Dropbox read status, instructions, field
exceptions and work still owed. The same details remain on the success screen.
A titled off-script video without a note is refused by the client and server;
the existing filming report still owns the exact topic/version data. The
confirmation hides the second submit button. A successful submit refreshes
the server read-back: isolated replay caught the old contradiction where it
said "never submitted" beside the success banner, and the second replay
showed the saved submit time and vision after refresh.

Node 20 typecheck, focused lint (two pre-existing unused-symbol warnings on
the upload page) and build passed after the final refresh/confirmation
change. Isolated CP09 filming drill passes 139/0 (including
missing off-script note refusal) and B4 upload drill passes 69/0. Isolated
desktop and 390px browser review passed; one synthetic monthly handoff was
submitted in the fenced demo database only. The demo server is stopped. No
production mutation, client message, provider booking, financial change,
push or deployment.

W06 remains partial for a pre-shoot brief read receipt and changed-brief
delta, the complete latest script/game plan/must-get/avoid/pronunciation/
references/chosen-assets view, fresh file-location verification and normal
photographer auth. W05 still needs failed/unknown notification and provider
outcomes; monthly release policy and per-job portal/Aryeo obligation are
unresolved. U0–U6 and other checklist rows remain active. Production still
lacks the three additive C05/C06/W04 tables. Continue the checklist in audit
order with the independent notification/exception work, preserving the
deployment gate.

### Current resume point — W05 shared delivery exit

W04 is committed at `b1622b1`. Its isolated desktop and 390px form check passed:
the TEST listing showed the exact cut, and a fenced Aryeo read produced a clear
error with the record button disabled. No provider or production delivery was
changed. W05's first local commit, `07d25d1`, adds a shared read-only delivery
exit on the Review Room index and each job's cut view. It uses Home's existing
reader and labels finishing 1080p, exact ready file, delivery-record repair,
and client notice pending. The global view follows Review Room's TEST toggle;
the per-job view stays on that job. A monthly row says portal release does not
settle access or any legacy Aryeo copy until the job's route is reconciled.
Home's long card introduction is shortened.

Node 20 typecheck, focused lint, build and isolated B4 delivery drill (120/0)
passed. Isolated desktop/390px browser showed the global and per-cut views;
normal Review Room hid TEST rows and `?test=1` showed them. The follow-up copy
edit changed the monthly row's action link from Home to the job page; typecheck
and lint passed before its commit.
The demo server is stopped. No production mutation, push or deployment.

W05 remains partial: surface failed/unknown notification and provider outcomes
from existing outbox readers; decide monthly portal/Aryeo obligations per
affected job, without bulk clearing; verify normal authenticated roles and
production rows after the additive schema gate. W06 photographer handoff and
U0–U6 remain. The monthly portal release question sent to the user is still
unanswered; continue independent work. Current production schema still lacks
the C05/C06/W04 additive tables.

### Current resume point — W04 listing delivery verification

W03 is committed through `9a3c9d5`. W04 is committed at `b1622b1`.
`FinalRenditionCheck` is a third
additive, unapplied table. Staff select the actual Aryeo video after upload and
record a named check of its playback, audio, first/last frames, title, output
identity and client access. The exact cut/source fingerprint and provider ID/URL
are stored. Older provider videos, changed files, a newer cut, missing media or
an undelivered listing cannot satisfy manual delivery. The Home Mark sent,
Topaz action and Topaz task Complete paths use this gate; task completion now
settles via the per-cut send writer. The software displays browser metadata
separately and never claims the checklist proves a full watch.

Isolated W04 drill passes 18/0, including negative and positive send/task
actions in PGlite with a fake Aryeo listing and fenced network. TypeScript,
focused lint and build passed after the last narrow task-route adjustments.
A read-only Prisma diff against live Neon lists only
`ClientBrandReceipt`, `DeliveryFollowUpHealth`, and `FinalRenditionCheck` plus
their indexes/FKs. No `db:push`, production mutation, real provider write,
client send, push or deployment happened. The isolated demo server was stopped
gracefully after the W03 visual replay; ports 3200/5599 were free on check.
Remaining W04: normal-auth/visual check, live-provider behavior after approval,
monthly portal final-file verification and its release policy. A question about
whether to hold monthly portal release before verification is pending with the
user. Continue W05's shared delivery summary independently.

### Current resume point — W03 staff revisions (Sep 30 night)

The local branch is `codex/audit-2026-09-30`. W03 commits `dc5aea7`,
`7d2b28b`, and `35a4a04` add a staff request on an exact current approved
cut/version, conversion of a stored team message with an explicit output match,
and exact-slot reopening for the editor and server upload gate. The brief keeps
the client's exact words, source link, timestamp and optional file reference;
the existing revision writer creates the task, weekday clock and internal
notification. The approved file is not replaced by the request, and another
approved video on the same job remains closed. A follow-up improves source
language in the brief/issue/task and gives monthly video work a delivery step
that asks for destination confirmation rather than assuming Aryeo.

Isolated `w03-staff-revisions` passes 13/0; related B1/CP03/C2 drills pass
141/0, 52/0 and 140/0. TypeScript, focused ESLint and build passed for this
batch. In the provider-fenced PGlite demo, direct and team-chat synthetic TEST
requests were submitted. The editor brief showed the exact issues and original
chat link; Video 1 and Video 3 reopened, while Video 4 stayed approved.
Desktop and 390px form checks passed. W03 remains partial for a normal
authenticated role replay, concurrent duplicate submission, the delivered-cut
journey and distinct per-cut stage wording. No production request, client send,
push or deployment was made.

The isolated demo worktree is at
`/Users/jordanspackman/.codex/worktrees/audit-visual-check/Realtour Pilot POT Dashboard`,
on ports 3200/5599 with provider fencing, no `.env`, and synthetic TEST rows.
It was stopped gracefully after the W03 replay; check processes before
starting another or changing that checkout. Production schema
still lacks the C05/C06/W04 additive tables. See
[`audit-2026-09-30-checklist.md`](audit-2026-09-30-checklist.md) for the full
backlog; W04 final-rendition verification is next.

### Current resume point — W01 month scope (Sep 30 evening)

`f3b8007` pinned the chosen brand version per output and showed the editor's
exact assignment. Isolated A28/A33 checks, TypeScript, lint and build passed;
the Avery TEST editor page was visually checked at desktop and 390px. The
local W01 batch `63d6eef` added an exact,
permission-scoped month/session overview, package-versus-job-slot mismatch
warning, and an explicit staff repair control for unlinked video jobs. The
isolated `w01-editor-month` drill passes 15/0, and Node 20 typecheck, focused
lint and production build pass. Initial browser replay caught that legacy cuts
without output submission pointers made the new submitted/approved summary
read zero. The follow-up reads exact cut slot/round rows and warns about
unpaired cuts; the drill covers that legacy shape and the build passes again.
Final browser replay passed: Avery TEST now reads 4 submitted and 3 approved,
matching the review panel; desktop and 390px layout passed. A disposable
unlinked TEST video job was linked through the staff form, confirmed in the
session list with its missing Aryeo appointment still marked unverified, then
the isolated demo was reset. The normal authenticated editor/office route
replay and Sarina's actual business reconciliation remain open.

Read-only live Sarina evidence: September month allowance 4; two explicitly
linked jobs hold 5 and 4 video output rows; two output rows are delivered;
none of the `ContentVideo` rows has a filmed confirmation or output/topic
link. This is a reconciliation task, **not** nine owed videos. No live row was
changed. The month view reports the conflict instead of changing counts or
combining folders. Kyle should confirm actual scope, appointment-to-topic
source, and which outputs remain owed before any live repair.

The isolated demo is running on managed worktree `a7f8d03` at ports 3200/5599
in unified exec session 87432 after `--reset`; its seeded IDs changed. Stop
only that owned demo process before switching commits. The checkout has no
`.env` and uses PGlite.
Production schema remains unapplied for the C05/C06 additive tables. No push,
deployment, production mutation, client send, booking, or automation change.

The current working branch is `codex/audit-2026-09-30`. Resume the full audit from
[`audit-2026-09-30-checklist.md`](audit-2026-09-30-checklist.md). This addendum
supersedes any "all done" wording below for the new audit scope; it does not
change the historical Sep 25–28 delivery record. At takeover local `main` was
`77fa13d`, eight commits ahead of `origin/main` (`1075a5b`). The audit branch
retains them. `codex/pre-audit-2026-09-30` preserves the original HEAD, and
`.git/recovery-2026-09-30/` holds a copy and patch of the only original tracked
edit. `2004657` committed that handoff/runbook correction. No Claude worktree
source edit was overwritten; each Claude worktree only had an untracked tool
dependency directory.

Current local batch stabilizes edit-route authorization, message read state,
schedule date paging, follow-up query failure visibility, interview draft copy
and preservation, and truthful review/QC wording. The focused checklist gives
per-finding status and next test. Node 20 build and typecheck pass; five isolated
drills pass with 479 checks. Browser/real-route acceptance remains pending. A
separate normal `next dev` started at 11:30 ET on port 3000 and holds the
primary `.next/dev/lock`; it was left running. Use an isolated checkout for
demo/visual work. No schema change, production write, push, deployment, client
send, booking, or automation activation was made in this takeover batch.

The next local batch addresses C13 conservatively: staff see a reconciliation
task for filmed work with missing topic/route history, and client Home avoids
asking for that work again. Draft scripts are called drafts. This is partial:
named live records and reminder/extra-output replay remain. Isolated UI-01 and
CP-10 drills passed 215 checks; B2 planning passed 151. No historical row was
relinked or generated. The isolated demo runs in a managed worktree at
`~/.codex/worktrees/audit-visual-check/Realtour Pilot POT Dashboard` on ports
3200/5599; it has its own `node_modules` and no `.env`, with provider network
fencing. It must be stopped through `scripts/demo/run-demo-dev.sh --stop` from
that worktree when no longer needed. The separate normal server on port 3000
was no longer running at 12:20 ET; no process was terminated by this task.

C18 source check is recorded in the checklist. The named live task's property
link is wrong; the source conversation had a guessed project and the generated
title supplied the other address. Routing now clears unknown/contradicted
projects and refuses a merge into a different client's or property's task.
The existing live task is unchanged pending Kyle's source check and a reviewed
one-row repair. No private access instructions were copied into this handoff.

The previously reported deployed version is still `bf2e0b4`; read the live
deployment stamp before any later release. September 28 full-backup files were
present at takeover, but verify current migration state and backup coverage
before any necessary schema change. The general listing welcome consultation
destination (C19) needs Jordan's policy answer; other work can continue.

C14 is in progress after the C18 commit. The normal Content roster and Review
Room now omit synthetic client rows by the existing durable identity, with an
explicit `?test=1` view; Review Room QC pattern numbers use the same scope.
Node 20 TypeScript, focused lint, and production build pass. Isolated browser
comparison on `c17f4a2`: normal September roster has 0 fixture clients/videos,
test mode has 2 and 4/12; normal Review Room has 0 fixture cuts/checks, test
mode has 3 cuts/3 checks. Global failure/workload readers, communication
identity and the realistic demo remain open; do not call C14 complete. The
isolated demo was restarted on this commit, ports 3200/5599, session 45353.

Sep 30 C04 reliability batch: `brandProfile` now has recoverable claim states
for both the first alert and the later pending-message sweep. Kyle's task and
the change-to-task links commit together, and retries keep the same task and
hourly notification dedupe. Historical claims with uncertain message delivery
are marked `delivery_unknown` for office verification. Isolated
`c04-brand-alert-recovery` passes 8/0. `cp06-brand-setup` is 121/3: its alert
checks pass; three pre-existing invitation/auth fixture checks fail. A provider
interruption at the `notifyInApp` boundary remains to test before C04 closes.
Node 20 typecheck, lint and build passed. No live automation switch changed.
Read-only live migration check found no Prisma migration history and no schema
diff. A fresh 0600 full backup at
`~/rtp-backup-2026-09-30-pre-brand-reliability.json` covers 144/144 models,
117,762 rows in a single snapshot. No schema push or production write was made.

Sep 30 C05 local batch: `ClientBrandReceipt` now records one required receipt
per change/version and assigned editor. An editor's Got it only stamps their
own receipt. Kyle's confirmation task closes when all required receipts are
resolved, or an owner/admin records a named office override with a reason;
generic task completion is refused. Newly assigned editors can acknowledge
unresolved changes; reassignment does not erase old recipients, so the office
must explicitly override an obsolete recipient. Legacy shared stamps remain
visible as unproven individual receipts. The isolated two-editor drill passes
12/0, and Node 20 build/typecheck/focused lint pass. `cp06-brand-setup` is
123/3; the same three historical invitation/auth fixture checks fail.
The live schema is still unchanged. The local Prisma diff is one additive
table, unique key, index and FK. Apply it only at the reviewed release gate
after rechecking the live diff and backup. The isolated browser has not yet
exercised the two-editor UI. The demo on ports 3200/5599 remains on `c17f4a2`.

Sep 30 C06 local batch: the global Home delivery card now records the last
successful read of each follow-up lane in `DeliveryFollowUpHealth`. When one
lane's current query fails, Kyle sees that lane as unavailable, can retry, and
sees its previous successful check time. A project-scoped or dry-run read does
not claim global desk health. Isolated `a02-a04-delivery-truth` passes 27/0,
including each/both injected query failures and a real waiting row restored
on retry. Node 20 typecheck, focused lint and build pass. A browser warning
check remains. The combined read-only live diff now lists only the two
additive C05/C06 tables; neither was pushed to production.

Sep 30 C17 local batch: a shared assignment resolver now distinguishes a
task or project/vendor assignment, deliberate unassignment, and a routing
suggestion across Home exceptions, Editing Room and the project summary.
The queue select shows “Suggested: … · not assigned” until Kyle saves a choice;
Home sends Kyle to confirm the suggestion instead of saying an editor owns it.
The five-state isolated drill passes 11/0 and three related regressions pass
285/0. A read-only live count found only 8 active video candidates for the
Home resolver's uncapped, exact filtering. The named 4600 Newburg project has
no saved editor, vendor or open edit task; its saved route suggests Kim. No
live assignment changed. In-house acknowledgment is not inferred from
assignment or Start and remains to implement under W02. The browser dropdown
was replayed in the isolated demo with Kim routing: desktop shows “Suggested:
Kim · not assigned,” Home says Kyle should confirm, and phone width 390px
requires horizontal table scrolling to reach the select. That mobile layout
remains U3 work. The demo DB's routing setting was changed only in isolated
PGlite; production settings remain untouched. Demo process is on ports
3200/5599, session 46045, checkout `ac8e6a8`.

Sep 30 C11 dependency batch: the Stage A release recipe now includes
`transcript_jobs` only for the queued call path, and Monitoring shows current
queue states, the off-switch blocker, historical-backlog, rollout and handler
holds, plus Jordan's review/Re-run location. A direct read-only live
`transcriptQueueBatch()` found 5 queued (3 INGEST, 2 ANALYZE), 0 running,
failed or needing review; the worker is off, all 5 predate first switch-on
and are excluded by default, and 2 are AI jobs. No configuration or job row
was changed. TypeScript, focused lint and production build pass. The isolated
demo's six-job fixture shows the blocker/backlog/credit copy and Settings link
at desktop and 390px phone width. The demo worktree is clean at `47ea1d1`
after the one-line spacing replay, with its server stopped. Prove TEST discovery and
monthly-call results with authorized model spend before closing C11.

Sep 30 W02 first local batch: the existing `DeliverableOutput.briefJson`
now pins an exact active client logo/branding-card version per video, with
the same optimistic version check as the rest of the brief. Kyle/Jordan can
choose; editors cannot. The reader flags a replaced/retired/missing choice
without silently switching it. New agency packets, the printable editor
brief and the photographer's brief include the choice; old frozen agency
packet JSON is still rendered as it was. On `/edit/[id]`, the editor sees
each video's identity, cut/brief version, script standing, owner, deadline,
brand and source after the manual Start/Pause bar; large sets stay collapsed
until opened. Listing video source falls back to its job raw folder, while
an unmapped monthly topic explicitly asks Kyle. Isolated A28 61/0 and A33
48/0 pass; Node 20 TypeScript, focused lint and build pass. No schema or live
data changed. Browser replay, explicit in-house acceptance, intentional
no-brand choice and a real multi-output reconciliation are still open.

> The handoff asked for `handoff.md`. This Mac's filesystem is case-insensitive,
> so a root `handoff.md` would overwrite `HANDOFF.md` (the Aug 19 session's
> record) — which happened once already. This file is that progress record.

Source of truth for scope: `~/Downloads/Realtour-Pilot-Unified-Claude-Implementation-Handoff-2026-09-25.md`.
Durable checklist: [`docs/unified-checklist.md`](unified-checklist.md) (written after batch 0's verification).

## Resume here

- **Current batch:** all six built and deployed, plus the completion pass (`c6b54e3`).
  **Final report: [`unified-final-report.md`](unified-final-report.md)** (the §13 report and
  the client-launch approval package). What is left is Jordan's: the supervised Aryeo
  sitting, a real-phone pass, the launch stages, deleting the old public video copies.
- **Deployed:** `bf2e0b4` (completion `c6b54e3` + docs), Vercel `iqe17q220`, Sep 28 ~4:15 PM ET. Live check: 10 main pages 200, a real job page shows Rush / Waiting on a file / The footage, cut stream 206 (private store). Probe: page build `bf2e0b4`, all 25 program switches OFF, rollout closed. 102 isolated drills green (~7,810 checks). Before it: `0950c1c` (Vercel `5d2osiip6`).
- **Live:** read from the hourly run's deploy stamp (`/content/monitoring`), not assumed.
- **Enabled:** nothing new for clients. Every ProgramAutomation row is absent (OFF); pilot lists empty.
  Review seats saved (James → Kyle → Jordan). Stripe webhook registered. Review cuts on the private store.
  Jordan's Saturday quiet time is a code default (Sat 00:00–19:30 ET, held → delivered at 19:30).
- **Queued for right after batch 6 (Jordan, Sep 28):**
  1. ~~merge branch `room-delivered-closeout`~~ — merged in `15fc7f4`;
  2. ~~standing rule~~ — done `ac297e8` (closes only notes their cut's own history answered): editor-cut and delivery-fix notes on a job delivered after them close
     themselves ("job delivered", never counted as a checked fix); "Feedback follow-through" rows
     open the cut with its notes, not the project page;
  3. ~~test inboxes~~ — done `ac297e8`; Bobby moved to jspackman215+bobbytest@. `jspackman215@gmail.com` and `bobmike0214@gmail.com` are Jordan's own ("The
     email for bobby test is my email so that works. the test email for bobby test can just be
     my jspackman215@gmail.com so I can see the test emails") — add both as verified test
     destinations beside info@, set Bobby TEST's hub email to jspackman215@ (backup first); the
     Aryeo side can stay bobmike0214@, so the Aryeo dashboard edit is no longer needed.
  4. ~~merge branch `editor-clarity`~~ — merged `e9f7f42`, deployed `eaee7fa` (Jordan, Sep 28: "the working on now button for the editors
     needs to be clearer … there is just a lot of information … It says Kim is not working on
     anything, but I believe he is!"). Measured: Kim has never pressed Start (all recorded
     events are John's) yet uploaded 3 versions of 107 E Old Baltimore Pike that morning; the
     office panel read "Kim — Not on anything". Being built in a separate worktree (workflow
     `wf_3e33ce7d-464`): one obvious Start/Pause/Switch control for editors, a one-tap "still on
     this?" after an upload, and an office line per editor from evidence ("Last active 12:14 PM
     — uploaded a version of … · hasn't pressed Start"), never claiming work without Start.

## Batch 0 — facts measured Sep 25 (read-only probe, `scripts/_recon/cp15-config-probe.ts`)

- Deploy stamp works: last hourly run recorded `46e109e586c0`. HEAD differs by
  one docs-only commit.
- Production schema = HEAD (`prisma migrate diff`: none).
- Backup: `~/rtp-backup-2026-09-25-full-pre-unified.json`, **127/127 models,
  113,290 rows**, taken before any batch-1 schema change.
- Switches: all 22 automation keys have no row → OFF.
- Calendly: BRAND_DISCOVERY and MONTHLY_STRATEGY mappings enabled and VALID;
  the legacy name-matched Drive sweep has stood down.
- Connections present: Aryeo, Stripe, Calendly, Gmail (info@ and hello@),
  Dropbox, OpenPhone, Slack, Anthropic. No speech-to-text provider.
- Cron (48h): sync 1 and reconcile 3 not-ok — all Aryeo timeouts (resumable).
  The evening job writes no CronRun, so its health is unreadable (to fix).
- Webhooks (7d): Script Studio 9 FAILED alongside 13 processed (to look at).
- Outbox (7d): 104 SMS accepted; 0 program emails pending.

## Batches

| Batch | State | Commits | Deployed |
|---|---|---|---|
| 0 Verify and prepare | done | `75d56f1` checklist, `2528374` schema | schema pushed |
| 1 Operational correctness | done (4 partial remainders → batch 2's remainder builder) | `e954b23` | see below |
| 2 Guided content preparation | done | `2c74adc` | see below |
| 3 Scheduling and integrations | done | `417fe90` | see below |
| 4 Capture through delivery | done | `b4403ea` | `41mfzx706` |
| 5 Operational visibility | done | `17df024` schema, `a183ed6` | `hy0rnlrxb` |
| 6 UI and release proof | done | `3de6023` schema, `57a2820` | `fojahizaz` (`15fc7f4`) |

## Decisions (asked Sep 25, answered by Jordan the same day)

Asked in three rounds, with a recommendation each time. His words where they
change the design:

| Topic | Jordan's answer | What it means in code |
|---|---|---|
| Video review | "I want everyone Kyle, Me, and James to see the cuts. James role is to approve them or request revisions, Same with Kyle, but James first, then Kyle if James hasn't gotten to it. I also want to be able to approve cuts whenever I want and I want to be kept in the loop." | All three are rung for every cut; the name on the cut says whose it is **first**, never who may act. Kyle and Jordan rule directly (recorded as a cover). Kyle is nudged after 9 covered hours. No automatic move. |
| Review download | "When we approve the edit (which should be done first) it should run through topaz, and deliver to the client in the client portal, already ran through topaz." | Approve → Topaz → the client sees the Topaz version only (batch 4, Topaz-before-release). |
| Travel time | Estimate drive time (recommended). | OSRM estimate between addresses plus a buffer, alongside Aryeo's live availability (batch 3). |
| Split photo/video upload | "We are actually going to get rid of the current MY pay structure. James and Harrison will be getting salary moving forward. So this feature is not needed anymore. I think it should just notify them like it currently does, but says hey photos are uploaded but video is not. Please upload the video before 8am tomorrow. And then a link to the upload portal. This is something that will affect their KPI's." | No split pay. A photos-in/video-missing notice with an 8am-tomorrow deadline and the upload link; a missed deadline counts on the KPI (batch 4). **My Pay is not deleted** — that needs his explicit ask. |
| Reopened work | "Turnarounds should be worked on immediately. It should be due same day." | A reopened job is due the end of that ET business day (weekend → next business day) (batch 4, A52). |
| Script nudge | 48h before, deadline 24h (recommended). | Batch 2. |
| Email alerts | Bell only (recommended). | Email SLA pages are in-app only (batch 5). |
| Overnight urgent | Hold until 7 AM (recommended). | Batch 5. |
| Rush authority | "James and Kyle - James is the creative manager now. Also It can be escalated to me." | Rush approvals: James or Kyle; escalation to Jordan (batch 5). |
| AutoHDR | Kyle checks Mondays, Jordan tops up; "Id like to connect AUTOHDR API to our system here at some point and we can set up notifications when its getting low." | Manual Monday balance reading now; the API alert is future work (batch 5). |
| Outside editor | "Im building for all in house, but we do work with Luma visuals and I have certain video projects that I reassign to them right now as external agency." | Luma Visuals is an active external agency: dispatch + acknowledgement record (batch 4, EditorDispatch). |
| Permissions | Register the Stripe webhook; run the Aryeo + Calendly supervised test; create the private video store. | Authorised external actions, done in the batch that needs them, each recorded here. |
| Notifications (Sep 26) | "no matter what is going on, James, Kyle, and myself should get a notification. I just don't want notifications on Saturdays, until 7:30pm. Implement in settings a setting for controlling notification timing by day and time." Follow-up: the Saturday rule is **Jordan only**; held notifications are **delivered at 7:30 PM**. | A per-person notification schedule in Settings (quiet windows by day and time, ET); Jordan preset Saturday 00:00–19:30; bell rows written at once, texts/DMs held to the window's end, never dropped; the three review seats hear about every cut even when away (batch 5). |


## Production changes made in this handoff

| When (ET) | What | How | Backout |
|---|---|---|---|
| Sep 25 | `review_room` seats saved: James primary, Kyle backup, Jordan fallback (row was absent; every other value = its default) | one `putSetting` after `validateReviewSeats(…, "OWNER")`; chain read back: all three canRule | delete the `review_room` AppSetting row (→ unconfigured, the old OWNER+ADMIN broadcast) |
| Sep 28 | **Editor notes on delivered jobs closed out** (Jordan: "for the editor stuff lets make sure we are up to date and anything completed and delivered can be closed out"). 16 notes (lanes EDITOR 14, EDIT = Kyle's delivery fixes 2) still OPEN/FIXED on 7 DELIVERED jobs delivered after the note — 439 Lake George Cir 1, 632 Greenridge Rd 8, 1462 Brandywine Ln 3, 238 Hudson Dr 1, 13 Chesterland Dr 1, 2051 Old Sumneytown Pike 1, 328 Columbia Ave 1 — resolved with statusBy "Closed out: job delivered", one timeline line per job. **0 linked revision issues**, so no editor KPI moved. Photographer coaching notes left as they are. Backup `~/rtp-backup-2026-09-28-delivered-job-notes.json`. Live: "Feedback follow-through" 14 → 8 (4 photographer rows, 4 editor rows on jobs still in work). | CAS per note on its own status | restore status/resolvedAt/statusBy/statusAt from the backup |
| Sep 28 | **38 E Gay St closed out of the Review Room** (Jordan: "38 E Gay St project is done but its still in the review room. Can we close that one out"). Sent back Sep 1, delivered Sep 14, still under "In revisions". (1) Code `81e5fb6` on branch `room-delivered-closeout` (deployed from a worktree, Vercel `hy2v729h7`; **merge into main after batch 6**): a sent-back cut leaves the Room and the home board once its job is delivered after the send-back — measured first: exactly 1 of 4 matched. (2) Jordan's 2 open notes on that send-back resolved as his decision (statusBy "Jordan Spackman", CAS on OPEN) with a timeline line; no issue rows were linked. Verified live: "In revisions" 4 → 3, "Feedback follow-through" 15 → 14, the address appears nowhere in the Room. | display rule + a 2-row note update | revert `81e5fb6`; set the two notes back to OPEN |
| Sep 25 | **Stripe webhook registered** (authorised): endpoint `we_1UJhFVRrlUAkQjeVojLRmkXt` → `https://hub.realtourpilot.com/api/webhooks/stripe`, 5 events, status enabled; signing secret saved encrypted (Connection `stripe_webhook`, never printed) and read back. Proven: a post signed with the saved secret → 200 (test-mode, ignored); a wrong signature → 400. | `scripts/_ops/register-stripe-webhook.ts --apply` (dry run first) | `… --rollback we_1UJhFVRrlUAkQjeVojLRmkXt` (deletes the endpoint, removes only its own secret); polling keeps activating signups |
| Sep 25 | **Review cuts switched to the private store.** Code `3a301ad` (the private token's presence decides the upload token and the browser's access word together). Store connected for production + development with prefix `REVIEW_CUTS_PRIVATE_`; deployed from a detached worktree at `3a301ad` (Vercel `eclgh0s6v`). Row backup first: `~/rtp-backup-2026-09-25-cut-rows-pre-private-store.json` (32 rows, 4.8 GB, all public, none uploading). Then `migrate-cut-store.ts --apply` (ledger in the session scratchpad, copied beside the backup). | see the cutover section below | disconnect the store (the public token is primary again) and `migrate-cut-store.ts --rollback --ledger <ledger> --apply`; originals were never deleted |
| Sep 25 | **Vercel CLI signed out mid-deploy** (auth.json emptied); Jordan approved a device login; deploys resumed. Batch 3 deployed from a detached worktree at `fa9a2c9` (Vercel `73ep3ma1b`). | `vercel login` (device code) | — |
| Sep 25 | Calendly capability probe stored: **Scheduling API available** (HTTP 200, 22 open times in 7 days). | `calendly-capability-probe.ts --apply` (one AppSetting row, `calendly_scheduling_probe`) | delete that row |
| Sep 25 | **Supervised Calendly test (authorised) — PASSED on the real API** after one fix. First attempt refused ("The supplied parameters are invalid"); with Calendly's `details` surfaced: every tracking key must be present. Fixed in `22f572f` (deployed, Vercel `qqbsh0kl3`). Re-run: booked "Jordan Spackman TEST" for Tue Sep 29 1:30pm ET (event `e3c44be6…`), 7/7 read-back checks (mapped type, active, time, test inbox, portal token, hub match to that client + month), cancelled and read back canceled. `call_booking` armed for the fixture only and disarmed after each run (AuditLog). | `hub-write-fixture.ts` arm → `calendly-supervised-test.ts --apply` → disarm | nothing to undo: the event is cancelled; the hourly sweep will file the cancelled booking on the TEST client |
| Sep 25 | **Private review-cut store created**: `review-cuts-private` (`store_Ivpn6ZpIy2r0feKR`, iad1, access private). Connected to the project for **development only**, env prefix `REVIEW_CUTS_PRIVATE_` → `REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN`. Production untouched. | `vercel blob create-store --access private` from an unlinked folder; `vercel integration-resource connect … --environment development --prefix REVIEW_CUTS_PRIVATE_` | `vercel blob delete-store store_Ivpn6ZpIy2r0feKR` |

### Private store — first real proof (Sep 25)

The shipped cut-store functions (`src/lib/reviewCuts.ts`) run against the new
store with its token, one 300 KB object, deleted after: **13 of 13 passed.**
Browser-style upload (client token + `access: private`) lands on
`*.private.blob.vercel-storage.com`; a public upload into it is refused
("Cannot use public access on a private store"); anonymous GET → 403; our
own GET with the token → 200, bytes identical; ranged GET → 206; a presigned
URL fetches with no headers (the Dropbox/Topaz/Meta path) → 200 and 206;
`probeableUrl` signs; `deleteCutObject` aims at the right store; gone → 404.
Still not exercised: copying objects between stores (`migrate-cut-store.ts
--apply`), the rollback, and a real editor upload in the browser.

**Cutover — DONE (Sep 25).** `3a301ad` deployed; `migrate-cut-store.ts --apply`:
**moved 32 · skipped 0 · failed 0**, each copy HEAD-verified by size before
its row changed; ledger `~/rtp-cut-store-migration-ledger-2026-09-25.jsonl`.
Proven afterwards (read-only DB connection): all 32 rows name
`ivpn6zpiy2r0fekr.private…`; identity pinned on all 32; a bearer ranged read
answers 206 for **32/32**; an anonymous read is refused for **32/32**; a
presigned URL (the Dropbox/Topaz path) answers 206. **Through the live hub**
(Jordan's session, the browser pane): `/api/review/cut/<id>/stream` with a
range → 206 with the right total size for two moved cuts, proxied — the store
address never reaches the browser.

**Still open (Jordan's call):**
- **The old public objects still answer an anonymous GET (206)** — copying
  revokes nothing. Deleting them (handover step 7) is what finally closes every
  link that ever left the building. Recommended: after about a week of the new
  store serving, delete the old store's objects, then disconnect and delete the
  old store. Not done: it is a permanent deletion.
- **The first real editor upload into the private store** is the last untested
  path (the browser's own PUT with `access: private`). The mechanism passed with
  a client-token upload from Node; the next real upload's row should name the
  private host — the configuration probe will show it.

**Earlier plan, kept for the record (after batch 2's deploy):** only review cuts use Blob, but
`BLOB_READ_WRITE_TOKEN` is integration-managed, so rather than swapping it the
code will treat `REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN` as the primary store
when present (the public one becomes the legacy slot), pass that token to
`handleUpload` explicitly, and give the uploader its access word from the
server — so one connection decides both halves and they cannot disagree.
Then: connect the store to production with the same prefix, deploy, run
`migrate-cut-store.ts` (dry run, then `--apply`), check hosts, and have one
real upload watched.

## The supervised Aryeo test — ready, waiting for a watched sitting

Authorised by Jordan (Sep 25). Batch 3 is live, so the hourly jobs run the new
fixture rules while the switches are on. The dry run stops at one missing
piece: **"Jordan Spackman TEST" has no Aryeo customer.** Aryeo's API can create
one (`POST /customers`, operationId customers-post). Kept for a sitting where
Jordan or Kyle is present because the test (a) books James (Aryeo notifies our
team, so James gets a test booking notice), (b) leaves a $0 test order with a
cancelled appointment on the TEST customer, which a person closes in Aryeo; if
Aryeo shows any balance on it, clearing that balance in Aryeo is a money action
that stays Jordan's (the hub never voids, refunds or edits an order), and (c)
must link the new Aryeo customer to the existing TEST client rather than let the
hourly sync create a duplicate. **No QuickBooks step** (review, Sep 28: Jordan
does not use QuickBooks; nothing here assumes an accounting sync).

**Update (Sep 28):** Jordan confirmed "Bobby TEST Michael TEST" is his test
account ("you can do whatever you need to with it"). It already has an Aryeo
customer (`018f10e1-…`, created Apr 2024, type AGENT) with **no orders**
(Aryeo search for the name and the email: 0; the hub holds only its two TEST
jobs, neither linked to an Aryeo order). So the sitting uses **Bobby**
(`cmtl98xl90008jl04yt5zawnv`) instead of creating a customer. Aryeo's public
API cannot change a customer's email (only create), and an undocumented PATCH
is not used on a live record — so step 1 is a dashboard edit.

**Update (Sep 28, later):** both of Jordan's Gmail inboxes are now verified
test inboxes (`ac297e8`), and Bobby's hub email was moved to
`jspackman215+bobbytest@gmail.com` (Gmail delivers it to jspackman215@; a
distinct address so nothing email-matched confuses it with Jordan's REAL row,
which carries jspackman215@ as email and bobmike0214@ as backupEmail).
Backup `~/rtp-backup-2026-09-28-fixture-cmtl98xl90008jl04yt5zawnv.json`,
AuditLog `cmull0gt100009k2xc2a2wbrc`. **The dry run now passes identity**
(own email and the Aryeo customer's bobmike0214@ are both verified inboxes).
**No Aryeo dashboard edit is needed any more.** Remaining preconditions, both
done AT the sitting: set Bobby's enrollment package Starter → Accelerator (the
test books 240 minutes), and arm `session_booking` + `address_sync` for Bobby
only. Step 1 below is superseded.

The sitting, in order (about 30–40 minutes; one run PER PACKAGE, because one
Accelerator booking proves nothing about Starter's 120 minutes or Pro's two
separate 240-minute sessions — review, Sep 28):
1. Set Bobby's enrollment package for the run (Starter → 120 min; Accelerator →
   240 min; Pro → two 240-min sessions booked as the Pro product twice). Backup
   first, restore Starter at the end.
2. Dry run: `NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/aryeo-supervised-test.ts --fixture cmtl98xl90008jl04yt5zawnv
   --address "117 Kyle Lane|West Chester|PA|19382" --new-address "42 Oak
   Street|West Chester|PA|19380"` — it refuses unless the package's product is
   $0 in Aryeo and the fixture's identity is proven.
3. Arm `session_booking` and `address_sync` for the fixture only
   (`hub-write-fixture.ts … --on --apply`), run `--apply` (it books, moves the
   address, re-checks conflicts and cancels), disarm. Repeat 1–3 per package.
4. Jordan/Kyle in Aryeo, per order: read the total, balance and payment status
   (expected $0 / $0), whether the customer was emailed, and whether the
   address change moved the order title and pin; close or cancel the test
   order; if it shows any balance, clear it in Aryeo by hand; tell James it was
   a test.
5. The script's measurement decides `travelSource` (does Aryeo's
   appointment-scoped availability see drive time?).

## Tests and environment

### Completion pass (`c6b54e3`, Sep 28)

The checklist rows still marked PARTIAL that needed nobody's decision.

**Built:**
- per-video briefs and on-site notes on the upload page;
- one evidence ladder on the tracker, the brief card and the upload page, with `rawInAt` on first fresh sight;
- open gaps block the delivery board;
- field reports are confirmed before they reach the AI profile;
- a Rush button and a "Rush asked" state;
- a "Waiting on a file" card;
- booking slots start at the 72-hour line;
- the ten-starts-a-day cap removed;
- every portal time labelled with its own date's zone (the scheduler, the Home and Schedule tabs, the call picker).

**Reviewed and tested:**
- One review lens: 3 of 4 findings confirmed and fixed.
  - Money wording could reach editors through a gap.
  - `rawInAt` was stamped on jobs whose raws were already in.
  - An approved rush could stay "asked".
- New drills: final-remainders 93, rush-slots-stale 93, evidence-gaps-feedback 95, upload-portal-briefs 62.
- **Browser walkthrough on the isolated demo** (`scripts/demo`, production never opened):
  - the Review Room named the client on the send-back, the earlier round and each note;
  - on `/edit`, a file dependency was recorded for Video 2 with Kim to work from it, then attached, and Kim's step unblocked;
  - the Rush dialog opened;
  - the portal Home and Schedule at 375 px: no sideways scroll, September times read EDT;
  - Settings shows its groups, the readiness panel and the Notification schedule;
  - the office's per-video brief showed on `/upload` at 375 px, and an on-site note made Brief v2, signed.

**Measured read-only Sep 28:**
- The probe:
  - the page build and the last hourly build were both `0950c1c` = HEAD;
  - all 25 program switches OFF, fixtures and pilot empty;
  - the evening cron not yet recorded (first run after the fix is tonight).
- **10 real editor uploads have landed on the private store** since Sep 25, the last at 16:14 UTC today. The browser upload path is now proven by use.
- A fresh backup (`~/rtp-backup-2026-09-28-full-pre-final.json`, 144/144, 115,401 rows, one snapshot) restored on embedded Postgres 18.4 with 0 differences.

**Safety fix:**
- Twice a script in `scripts/_drill/` that opens the live database (read-only) was taken for an isolated drill:
  - `product-eligibility.ts`, run by a builder;
  - `pro-two-sessions.ts`, picked up by the full-suite runner because it mentions PGlite in a comment.
- Postgres refused every write (25006), so nothing was written.
- All 23 such scripts now live in `scripts/_live/` (README).
- `harness-selftest` §H fails if any file in `scripts/_drill/` can reach a database it did not create. Proven both ways: it passes now, and it caught a copied production script.

**Left, stated plainly:**
- `rawInAt` is not backfilled for jobs in flight; nothing reads it yet.
- The raise-gap button is on `/edit` only.
- No rush control on `/tasks`.
- The picker shows the first 6 days.
- Open wording question: a stale Dropbox read that once saw files still says "files found".

### Batch 6 (`57a2820`, deployed as `15fc7f4`)

- Schema first (`3de6023`, 8 nullable columns) after a full backup
  (`~/rtp-backup-2026-09-28-full-pre-batch6.json`, 144/144 models, 114,991 rows).
- Seven builders: Review Room attribution (Jordan's ask, all 21 mapped gaps),
  backup/restore/cron, readiness + Settings grouping, a real-Postgres harness,
  then two race builders and the real restore rehearsal. Three review lenses:
  **24 of 24 findings confirmed and fixed** (highs: an assistant's text or call
  was credited to the agent on the account; the launch gate read "closed" while
  auto-share could still release scripts — its listed dependencies were not
  ones its sweep enforced).
- **Real bugs the race drills found, fixed:** a burst of Aryeo events for a new
  agent crashed 25 of 30 concurrent imports (P2002 on Client.aryeoCustomerId)
  and each showed a false Aryeo error on /connections; an automatic approval
  could overwrite a client's own approval or a staff reopen racing it; an AI run
  whose lease lapsed could still write a second script version; the evening
  cron never wrote a CronRun (production had 0 evening rows); /connections
  dropped the daily jobs from Sync health.
- **Restore rehearsal on real backups (isolated only):** the Sep 25 (127 models,
  older schema, pushed from git) and Sep 28 (144 models) backups restored under
  both engines (embedded Postgres 18.4 and PGlite): identical results, every
  count equal to its header, 0 round-trip differences, FK orphans unchanged.
- **94 isolated drills green (7,105+ checks)** including 4 real-Postgres race
  drills; harness self-test 44 (PGlite) and 51 (Postgres). tsc clean; eslint 0.
- Live check: 10 main pages 200; cut stream 206; /api/cron/version 401 without
  the bearer; Settings shows the groups and the readiness panel.
- Not proven: none of the provider writes beyond Calendly's supervised test;
  real phones (iPhone Safari/Android Chrome) for the portal and downloads.

### Batch 5 (`a183ed6`)

- Schema pushed first (`17df024`) after a full backup
  (`~/rtp-backup-2026-09-26-full-pre-batch5.json`, 140/140 models, 114,364
  rows); the SQL was additions only (3 nullable columns, 4 tables).
- Four builders (notification schedule + overnight hold; comms; operations;
  money + vendors), two review lenses. **7 of 9 findings confirmed and
  fixed** — two were Jordan's rule leaking: the 7 PM upload list and the
  photographer chaser reached him inside his Saturday window; the AutoHDR card
  showed the owner's bank top-up to admins.
- **82 isolated drills green.** (One run was interrupted by the Mac sleeping;
  the unreached drills were run separately and the four that the two runs
  killed between them were re-run alone: all green.)
- **Measured before deploy:** 0 saved schedules, 0 held DMs, 0 photo batches,
  7 ordinary queued staff texts, 0 owner-shot Saturday jobs in 180 days.
- Live check: every main page 200, cut stream 206, the Notification schedule
  card renders in Settings.
- Boundary, stated plainly: a message a PERSON types and sends from the hub is
  not held by quiet time — it is their message, not a notification.

### Batch 4 (`b4403ea`)

- Four builders (uploads; briefs + Luma dispatch; delivery + Topaz-before-release;
  reopened same-day due), two review lenses. **17 of 17 findings confirmed and
  fixed** — highs: a video excused after the photos half left the wrap-up
  never stamped (hidden from My Pay, a false late upload); a Topaz "Try again"
  took an approved video off the client's page. **70 isolated drills green,
  5,789 checks.** Deployed and smoke-checked live (Review Room, Editing Room,
  Upload, Content, Settings: 200; cut stream: 206).
- **Measured before deploy:** 0 half-submitted jobs; 2 reopened jobs whose
  due display is re-read; 0 drafts; 0 gaps.
- Removed `src/lib/captionAssistant.ts` — unreachable since before this batch
  (nothing imported it) and it drafted with the switch off; its guard moved
  into the live drafter.
- **My slip, recorded:** `drone-footage` and `ready-card-live` read production
  without the read-only connection guard; I ran them before noticing. Both are
  SELECT-only by code inspection (`readyToSend` and its helpers write nothing).
  They should get the 25006 guard in batch 6.
- **GitGuardian alert (Sep 26, 22:57 UTC push): false alarm.** It matched
  fake `vercel_blob_rw_…` strings in three drills (the stores' public ids with
  made-up secrets). Neither real token nor its secret half appears anywhere in
  the repository's history (checked with `git log --all -S`). The drills now
  build those strings at run time. Nothing to rotate; Jordan can mark the
  GitGuardian incident as a false positive / test credential.

### Batch 3 (`417fe90`)

- Four builders (gates; travel + booking; pilot + reassessment; Calendly),
  two review lenses (correctness/concurrency; provider writes, money, client
  safety). **12 of 12 findings confirmed and fixed** — among them: a retry
  after a payment mismatch skipped every check; a late-month Calendly booking
  was refused and left the month stuck; adding a client to a pilot erased its
  end date; the supervised test's cleanup list was wrong on failure paths.
- New drills: b3-gates 118, b3-travel-booking 99, session-booking-adapter 211,
  hub-write-scopes 81, b3-reassess 53, b3-calendly 143. Five older drills moved
  to the 72-hour law and R02 fixture identity (b2-planning, ui01-portal-ia,
  session-address, preparation-clock, pro-two-sessions) — no product bug among
  their failures. **63 isolated drills green, 5,233 checks.** The read-only
  production drills pass with the 25006 guard proven first.
- **Measured read-only before deploy:** 0 months demoted by the dead-record
  rule; 0 live requests without a session index; 13 past legacy-stamped months
  raise **no** "confirm the call's end" task (the rule only asks while it can
  still move a date); John Mark has no Aryeo mapping (editor, not a creative);
  the saved portal terms carry no 48-hour wording, so nothing contradicts 72.
- **Found:** "Bobby TEST Michael TEST" carries a Gmail inbox and an Aryeo
  customer with TEST in the name. R02 refuses it as a fixture. **Resolved Sep
  28: Jordan confirmed it is his test account** — it becomes the supervised
  Aryeo test's fixture once its email is moved to the test inbox.
- **Not proven:** every Aryeo and Calendly write is against faithful fakes.
  The supervised test settles it.

### Batch 2

- Five builders (planning reader + routes; scripts/topics/release; discovery +
  strategy; signups; batch-1 remainders); two review lenses (correctness/data;
  client words/launch gate). **19 of 19 findings confirmed and fixed**, two of
  them duplicates. The two highs: a booked call on the written route opened
  filming without answers; unreviewed AI topics from the discovery call reached
  the client's topic bank.
- New drills: b2-planning 151, b2-scripts-topics 200, b2-discovery-strategy
  105, b2-signups 54, b1-remainders 73; cp14 108. Pre-R01 drills
  (scheduled-journey, cron-route-journey, cp15) were moved to the one-reader
  rules, not loosened: each now asserts the extra is EXTRA first.
- **Measured read-only before deploy:** 32 enrollments, 31 legacy
  call-required (callMode null); 2 Calendly mappings enabled (so the legacy
  sweeps standing down changes nothing); 0 released strategies carrying
  gaps/proposal sections; 0 edit cards the pin rule would move; 0 written-route
  months that will lock; the script-approval desk-task dry run opens 0 tasks and
  rings 0 bells; 2 Editing-stage jobs will read "In editing — not confirmed"
  until an editor presses Start; every signup price is in the catalogue.

### Batch 1 (`e954b23`)

- Four builders with disjoint files; two review lenses (correctness and
  concurrency; permissions and fairness); one skeptic per finding. **18 of 18
  findings confirmed, 17 fixed, 1 partial** (the delivery board's "With the
  editor" label was left as it is).
- Jordan's review answer applied after the review: all three rung, James first,
  Kyle's copy names his part, the 9-covered-hour nudge tells Kyle to rule
  himself. Found on the way: an any-role bell row loses its BODY to the money
  clamp (notify.ts), so the instruction is in the title.
- **52 isolated drills green, ~4,000 checks** (PGlite, providers fenced, clocks
  pinned): b1-active-editing 118, b1-review-ownership 119, b1-selfqc-issues 141,
  b1-readiness-topaz 102, plus every earlier drill. tsc clean; eslint 0 errors.
- **Not proven:** genuine concurrency on a multi-session Postgres (R04, batch 6);
  the new editor controls in a real browser (batch 6 walkthroughs).
- **Production facts read (read-only, 25006 proven):** James has an ADMIN login;
  Kyle ADMIN; Jordan OWNER; Harrison PHOTOGRAPHER; Kim and John Mark EDITOR.
  `review_room` was unset, 8 cuts pending.
