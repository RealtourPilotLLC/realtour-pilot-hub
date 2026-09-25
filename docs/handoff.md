# Progress record — unified implementation handoff (Sep 25 2026)

> The handoff asked for `handoff.md`. This Mac's filesystem is case-insensitive,
> so a root `handoff.md` would overwrite `HANDOFF.md` (the Aug 19 session's
> record) — which happened once already. This file is that progress record.

Source of truth for scope: `~/Downloads/Realtour-Pilot-Unified-Claude-Implementation-Handoff-2026-09-25.md`.
Durable checklist: [`docs/unified-checklist.md`](unified-checklist.md) (written after batch 0's verification).

## Resume here

- **Current batch:** 3 — scheduling and integrations.
- **Batch 1:** `e954b23`, live (deployed with `f2555f7`). **Batch 2:** `2c74adc`, deployed with the docs commit after it.
- **Live:** read from the hourly run's deploy stamp (`/content/monitoring`), not assumed.
- **Enabled:** nothing new for clients. Every ProgramAutomation row is absent (OFF).
  Review seats saved (James → Kyle → Jordan).
- **Next action:** register the Stripe webhook (authorised); switch review
  cuts to the private store (authorised); batch 3.

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
| 3 Scheduling and integrations | — | | |
| 4 Capture through delivery | — | | |
| 5 Operational visibility | — | | |
| 6 UI and release proof | — | | |

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


## Production changes made in this handoff

| When (ET) | What | How | Backout |
|---|---|---|---|
| Sep 25 | `review_room` seats saved: James primary, Kyle backup, Jordan fallback (row was absent; every other value = its default) | one `putSetting` after `validateReviewSeats(…, "OWNER")`; chain read back: all three canRule | delete the `review_room` AppSetting row (→ unconfigured, the old OWNER+ADMIN broadcast) |
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

**Cutover plan (after batch 2's deploy):** only review cuts use Blob, but
`BLOB_READ_WRITE_TOKEN` is integration-managed, so rather than swapping it the
code will treat `REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN` as the primary store
when present (the public one becomes the legacy slot), pass that token to
`handleUpload` explicitly, and give the uploader its access word from the
server — so one connection decides both halves and they cannot disagree.
Then: connect the store to production with the same prefix, deploy, run
`migrate-cut-store.ts` (dry run, then `--apply`), check hosts, and have one
real upload watched.

## Tests and environment

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
