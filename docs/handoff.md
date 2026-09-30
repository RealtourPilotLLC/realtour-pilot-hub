# Progress record — unified implementation handoff (Sep 25 2026)

## Sep 30 takeover addendum

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
