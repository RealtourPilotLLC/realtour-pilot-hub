# Final report — unified implementation handoff (Sep 25 → Sep 28 2026)

Scope: `~/Downloads/Realtour-Pilot-Unified-Claude-Implementation-Handoff-2026-09-25.md`, batches 0–6,
plus Jordan's asks during the work. Durable checklist: [`unified-checklist.md`](unified-checklist.md)
(163 items). Progress record: [`handoff.md`](handoff.md).

**Where it stands.** Every batch is built, reviewed, fixed, deployed and live for staff.
**No client-facing automation is on for any real client**: the launch gate is closed and
nothing was turned on. The build is done in the handoff's sense (§17). **Release is not.** It still
needs:
- the supervised Aryeo sitting;
- a real-phone pass;
- Jordan's launch decisions (§7 below).

---

## 1. What changed, and what the business now does

**Editing Room — who is really working on what**
- An editor presses **Start** on the job they are on.
  - Only one job is active at a time. Switching pauses the other job.
  - Nothing automatic ever claims someone is editing.
  - An upload asks the editor "still on this?" instead of silently ending their session.
- The office panel names each editor's state. When there is no Start, it shows the evidence instead:
  "Last action 12:14 PM — uploaded a version of … · hasn't pressed Start today".
  - This is the fix for "It says Kim is not working on anything": Kim had never pressed Start, and his uploads counted for nothing.
- Every transition is logged once, with who did it. Office changes are recorded as made on the editor's behalf.

**Review — James first, Kyle covers, Jordan any time**
- All three are notified of every cut, even when "away".
  - The cut names James as the first reviewer.
  - Kyle is nudged after 9 covered hours and can rule himself.
  - Jordan can approve whenever he likes.
- Every note, reply, approval and send-back now shows **who** and **when**. That covers the Review Room, the editor's page and the edit tracker. A client send-back names the client, not the office person who approved earlier.
- Delivered jobs leave the Review Room (38 E Gay St was the case). Editor and delivery-fix notes on a job delivered after them close themselves.
- Editors must finish a self-QC before they submit. Revision asks become classified issues, attributed fairly, and feed the editor KPIs.
- **Approve → Topaz → client.** The client portal only ever shows the Topaz version.

**Uploads and hand-off**
- The upload page saves drafts as you go. Photos and video are submitted separately.
- When photos are in and the video is not, the photographer gets "upload the video before 8 AM tomorrow" with the link. A miss counts on the KPI. No split pay: My Pay is untouched.
- The upload portal shows each video's own brief. The photographer can add signed on-site notes to it.
- The footage evidence is truthful:
  - a tick is not files, and a stale Dropbox read is not a confirmation;
  - the edit tracker, the project summary and the upload page all say it the same way.
- Missing work (a reshoot, a video that could not be filmed) becomes an owned **gap**. The delivery board shows "Missing work: … — owner by date" instead of letting the job look deliverable.
- Photographer field notes about a client are **proposals**. The office confirms them before they reach the client's AI profile.

**Content program**
- Two guided routes: a strategy call, or written answers.
  - Filming opens 72 hours after the call ends or the answers are in.
  - Booking times start at that line.
- Topic recommendations respect the month's allowance.
- Scripts are drafted from the client's own sources. They are released only with approval.
- Script nudge 48 hours before; deadline 24 hours.
- Self-booking is address-first and travel-aware: OSRM drive time plus a 15-minute buffer, alongside Aryeo's live availability. Pro gets two sessions.
- Calendly is embedded, and booking through its API is proven on the real account.
- The production booking mode is explicitly closed. It writes only for named TEST fixtures, and only while armed.

**Operations**
- Reopened jobs are due the same business day.
- Email reply-time alerts are bell-only. Overnight urgent pages are held to 7 AM.
- **Jordan's Saturday quiet time runs until 7:30 PM ET**:
  - the bell is written at once;
  - texts and DMs are held and delivered at 7:30 PM, never dropped;
  - each person can set their own quiet windows in Settings → Communication & notifications → Notification schedule.
- **Rush:** James or Kyle approve; anyone can send it to Jordan.
  - A **Rush** button shows the new due date and priority, and exactly which jobs it pushes back, before saving.
  - An open ask shows on the job as "Rush asked".
- A **"Waiting on a file"** card lets the office record what a job cannot start without, for example the plat for lot lines or a client logo.
  - Finding the file is Kyle's task.
  - The work from it is blocked until the file is attached.
- Also in this area:
  - capacity and scope exceptions with owners;
  - rework cost;
  - AutoHDR's Monday balance reading (Kyle reads, Jordan tops up);
  - Luma Visuals as an active outside agency with a dispatch and acknowledgement record.

**Release proof and infrastructure**
- Settings is grouped into 7 sections, and a **readiness panel** shows each switch as configured / connected / enabled / effective, with its blockers.
- Cron health covers every scheduled job. The evening job now records its runs.
- Backups:
  - they are one consistent snapshot, private (0600), and cover every table;
  - a restore rehearsal on real backups under two engines gave 0 differences.
- Review cuts moved to a **private** video store. The Stripe webhook is registered and verified.

## 2. Findings

**Checklist items.** All 163 were verified before building:

| Status | Items |
|---|---|
| Confirmed | 67 |
| Partially implemented | 55 |
| Already fixed | 23 |
| Configuration-dependent | 18 |

**Review findings.** Each batch had an adversarial review, and every finding was checked by a skeptic:

| Batch | Confirmed and fixed |
|---|---|
| 1 | 18 of 18 (1 left partial by design: "With the editor" label) |
| 2 | 19 of 19 |
| 3 | 12 of 12 |
| 4 | 17 of 17 |
| 5 | 7 of 9 (2 refuted) |
| 6 | 24 of 24 |
| Completion | 3 of 4 (1 refuted) |
| Final remainders | my own review of the diff, which found the same time-zone bug in 3 more portal files; fixed |

**Real bugs only the real-Postgres race drills found.** All fixed:
- A burst of Aryeo events for a new agent crashed 25 of 30 imports.
- An automatic approval could overwrite a client's own approval.
- An AI run whose lease had lapsed could still write a second script version.
- The evening cron never recorded a run.

**Corrected assumptions** (what the handoff or we believed, and what was true):
- "Kim isn't working." He was working. He had never pressed Start, and uploads ended nothing and started nothing.
- The rush panel already existed on the job page for the office. What was missing was a control anyone would read as "rush", and any sign that a rush had been sent to Jordan.
- Calendly's booking API refuses a booking unless all six tracking keys are sent. This was found on the real API and fixed; our test fake is now as strict.
- "Bobby TEST Michael TEST" looked like a real client inbox. It is Jordan's own test account, so it is now the Aryeo test fixture.
- The launch gate read "closed" while script auto-share could still release scripts: its listed dependencies were not ones its sweep enforced. Fixed.
- 38 E Gay St stayed in the Room because "sent back" never checked for a later delivery.
- The private video store was not yet proven by a real upload. It now is: 10 editor uploads since Sep 25 landed on the private store, the last on Sep 28.

## 3. Commits, deploys, schema, backups, production data

| Work | Commit | Deployed as (Vercel) |
|---|---|---|
| Batch 1 | `e954b23` (+ remainder `2c74adc`) | `f2555f7` (783ja2fmz), `810b29f` (hhpbwowz1) |
| Batch 2 | `2c74adc` | `810b29f` (hhpbwowz1) |
| Batch 3 | `417fe90`; Calendly fix `22f572f` | `fa9a2c9` (73ep3ma1b); `22f572f` (qqbsh0kl3) |
| Batch 4 | `b4403ea` | `b4403ea` (41mfzx706) |
| Batch 5 | `a183ed6` | `a183ed6` (hy0rnlrxb) |
| Batch 6 + 38 E Gay St | `57a2820`, `81e5fb6` | `15fc7f4` (fojahizaz) |
| Delivered-notes rule, test inboxes, editor clarity | `ac297e8`, `2694cfe` | `eaee7fa` (mqazwgvmn) |
| Portal tab fix | `0950c1c` | `0950c1c` (5d2osiip6) |
| Completion + final remainders | `c6b54e3` (+ docs) | ⟨FINAL-DEPLOY⟩ |

**Schema.** Three additive pushes, each after a full backup:
- `2528374` — batches 1–4;
- `17df024` — batch 5;
- `3de6023` — batch 6 attribution columns.

Nothing was dropped or renamed. Production schema = HEAD (`prisma migrate diff`: none).

**Backups** (all mode 0600, outside the repo):

| File | Taken | Contents |
|---|---|---|
| `~/rtp-backup-2026-09-25-full-pre-unified.json` | before any change | 127 models, 113,290 rows |
| `~/rtp-backup-2026-09-26-full-pre-batch5.json` | before batch 5 | 140 models, 114,364 rows |
| `~/rtp-backup-2026-09-28-full-pre-batch6.json` | before batch 6 | 144 models, 114,991 rows |
| `~/rtp-backup-2026-09-28-full-pre-final.json` | before the final deploy | 144 models, 115,401 rows, one snapshot |
| `~/rtp-backup-2026-09-25-cut-rows-pre-private-store.json` | before the store move | row backup |
| `~/rtp-backup-2026-09-28-delivered-job-notes.json` | before closing notes | row backup |
| `~/rtp-backup-2026-09-28-fixture-cmtl98xl90008jl04yt5zawnv.json` | before Bobby's email change | row backup |

**Production data changes.** Every change is recorded with its backout in `handoff.md`:
- Review seats saved: James, then Kyle, then Jordan.
- Stripe webhook `we_1UJhFVRrlUAkQjeVojLRmkXt` registered. The secret is saved encrypted.
- Private store `review-cuts-private` created. 32 existing cuts copied to it and verified (32 of 32). **The old public copies still exist.**
- Calendly: capability probe row stored. One supervised TEST booking was made and cancelled.
- 38 E Gay St: 2 of Jordan's notes resolved.
- 16 editor and delivery-fix notes on 7 delivered jobs closed. 0 linked issues, so no KPI moved.
- Bobby TEST's hub email moved to `jspackman215+bobbytest@gmail.com`.

## 4. Verification

- **Isolated drills: 102 drills, about 7,810 checks, all green at `c6b54e3`.**
  - Each drill boots its own Postgres (PGlite), with providers faked and fenced and clocks pinned.
  - Drills show the old behaviour failing and the new behaviour passing wherever that is meaningful.
- **Real Postgres:** 4 race drills on embedded Postgres 18.4, matched to production's 18.6. The harness self-test ran on both engines.
- **Restore rehearsal:** the Sep 25 and Sep 28 backups restored under both engines. Every count matched and there were 0 round-trip differences.
- **Today's pre-final backup** was restored on embedded Postgres 18.4:
  - 115,401 of 115,401 rows across 144 models;
  - the round trip was identical and the id hashes equal the header's;
  - 49 foreign keys, none orphaned;
  - 3 dangling plain references that were already in the data;
  - the app's month progress (116 of 116), the Ready-to-send board, cut entitlement and the TEST portal all read the restored copy.
  - Evidence: `~/rtp-backup-2026-09-28-full-pre-final.rehearsal.json`.
- **Real providers.** These were exercised for real:

  | Provider | What was proven |
  |---|---|
  | Calendly | Booked, read back 7 of 7, cancelled |
  | Stripe webhook | Good signature → 200, bad signature → 400 |
  | Private video store | 13 of 13 mechanics; 32 of 32 migrated; 10 real editor uploads since |
  | Live hub | Pages 200; cut stream 206 through Jordan's session |

- **Faked only:**
  - every Aryeo write (booking, address sync, the $0 order);
  - Dropbox;
  - OpenPhone;
  - Slack;
  - Gmail sends;
  - the AI model, apart from one earlier attended TEST run.
- **Browsers:** the isolated demo hub at desktop size and 375 px, in a real browser. Production was never opened.
  - The Review Room named the client and the time on the send-back, the earlier round and each note.
  - On the job page, a "Waiting on a file" item was recorded for Video 2 with Kim to work from it, then attached; Kim's step unblocked.
  - The Rush dialog opened.
  - The portal Home and Schedule tabs had no sideways scrolling, and September times read EDT.
  - Settings showed its 7 groups, the readiness panel and the Notification schedule.
  - The office wrote Video 2's brief on the job page, and it appeared on the upload page at 375 px. The photographer's on-site note made Brief v2, signed with name and date.
  - The Editing Room office panel rendered.
  - An editor pressing Start was not clicked in a browser; it is drilled through the server actions.
- **Not done:**
  - real phones (iPhone Safari, Android Chrome);
  - a real-model strategy draft (a paid AI run, not authorised).
- **Process failures, recorded:**
  - Two read-only production scripts were run without the connection guard. They were SELECT-only.
  - Twice, a production read-only script in the drill folder was taken for an isolated drill:
    - `product-eligibility`, run by a builder;
    - `pro-two-sessions`, picked up by the suite runner because it mentions PGlite in a comment.
  - Postgres refused every write (25006), so nothing was written.
  - All 23 such scripts now live in `scripts/_live/` with a warning README.
  - The harness self-test now fails if any file in the drill folder can reach a database it did not create.
  - A fake token-shaped string triggered GitGuardian. No real secret was ever committed; this was checked across all history.

## 5. Automation controls

Read from production at ⟨PROBE-TIME⟩ by the read-only probe.

**Client-program switches: all 25 OFF.** No row exists for any of them. Pilot lists are empty, and no TEST fixture is armed.

| Switch | Reaches | Blocker besides the switch |
|---|---|---|
| Client reminders | clients, email from info@ | TEST-only lock in the reminder policy |
| Approve & share → email | clients, email | TEST-only lock |
| Share scripts without approval | client portal | **stays OFF (Jordan's decision)**; TEST-only lock |
| Portal invitations / sign-in links | invited client seat, email | — |
| Email clients when the office replies | clients, email | — |
| New portal layout for everyone | every real client | — |
| Review deadlines and rounds | clients (portal), Kyle (task) | — |
| Automatic approval on expiry | client portal | TEST-only lock; needs review deadlines |
| Carry unfilmed scripts over | client portal | Jordan's decision (OFF) |
| Self-booking / address sync (Aryeo) | Aryeo booking + Aryeo's notice to the team | supervised test; fixtures/pilot |
| Strategy-call booking (Calendly API) | Jordan's Calendly + confirmation | mode is EMBED (the portal embeds Calendly) |
| Instagram publishing | the public | no Meta credentials |
| AI runs (master) and the 5 AI jobs | internal (AI spend) | — |
| Transcribing cuts | internal | no speech-to-text provider |
| Topic folders in Dropbox, fact acceptance, brand-change alerts, old call sweeps | internal / staff | old call sweeps stand down by design |

**Already live and unchanged (approved before this handoff):**
- Client texts: confirmation 48 hours before, delivery, after-hours, welcome.
- Photographer upload reminder and chaser.
- Photos-not-delivered alert to Kyle and Jordan.
- Raw-video-missing bell.
- Kyle's digests.
- Topaz.
- Editor routing: John for standard and premium, Kim for personal branding.
- Review coverage: James → Kyle → Jordan.

**Staff-only behaviour that went live with the deploys:**
- everything in §1 that isn't client-facing;
- Jordan's Saturday quiet time (Sat 00:00–19:30 ET);
- the 7 AM overnight hold;
- bell-only email alerts;
- the delivered-notes rule.

## 6. What is left, and whose it is

| # | What | Owner | If it waits | Next step |
|---|---|---|---|---|
| 1 | **Supervised Aryeo sitting** (~20 min) | Jordan or Kyle present; Claude runs it | Self-booking and address sync cannot be offered to any real client | Set Bobby TEST's package Starter → Accelerator; arm `session_booking` + `address_sync` for Bobby only; `aryeo-supervised-test.ts --apply`; void the balance/QBO invoice by hand; tell James it was a test. Runbook in `handoff.md` |
| 2 | **Delete the old public video copies** | Jordan decides; Claude runs it | Links to client video sent before Sep 25 stay world-readable | After ~a week of the private store serving (from Oct 2): delete the old store's objects, disconnect it. Permanent |
| 3 | **Real-phone pass** | Jordan or Kyle with a phone; ~15 min | Portal/download behaviour on iPhone Safari and Android Chrome is unproven | On each phone: open a TEST client's portal link, sign in, Scripts, book a time, review a video, download |
| 4 | **One real-model strategy draft** | Jordan authorises (paid AI call) | The strategy format is proven with a stub model only | Say yes; Claude runs one attended draft on the TEST client |
| 5 | **Meet/Gemini transcript check** | Jordan (Google re-consent) | Automatic transcript matching for Meet calls is unproven | Reconnect Google with Calendar scope; Claude does one read-only Calendar GET |
| 6 | **Evening job's first recorded run** | Claude (read-only check) | None; this confirms the batch 6 fix | Tonight after 7 PM ET: cron health should show "evening" ok |
| 7 | **Launch decisions** | Jordan | Nothing client-facing runs | §7 package below |
| 8 | GitGuardian alert (optional) | Jordan | None | Mark the Sep 26 incident "false positive / test credential" |
| 9 | Deliberately not built | — | — | First-cycle "book your call" reminder: the portal already refuses the written route unless eligible, and reminders are OFF. `rawInAt` backfill for jobs already in flight: nothing reads it yet. AutoHDR API alerts: Jordan said "at some point" |

**Small leftovers, no decision needed:**
- The raise-gap-from-brief button is on the job page only.
- There is no rush control on /tasks; the card links to the job page.
- The booking picker shows the first 6 days.
- A stale Dropbox read that once saw files still says "files found". That's a wording question, if Jordan cares.
- `rawInAt` is not backfilled for jobs already in progress.

## 7. Walkthroughs and the client-launch approval package

### Short walkthroughs

**Jordan**
- **/review:** each cut shows who reviews it first, and every note, approval and send-back shows who and when. Approve any time. It then goes through Topaz before the client sees it.
- **Settings → Communication & notifications → Notification schedule:** your Saturday window is there. Change it or add others.
- **Settings → Readiness:** every switch, whether it would actually do anything, and why not.
- A rush sent to you shows on the job as "Rush asked". Open the job and press **Rush**: save the date to approve, or change it.

**Kyle**
- **/editing:** the office panel shows each editor's state. With no Start, it shows what they last did.
- **/review:** you cover when James hasn't got to a cut. After 9 covered hours you'll be nudged, and you can approve or send it back yourself.
- **Delivery board:** "Missing work: …" means an open gap with an owner and a date. The job isn't deliverable until it's resolved.
- **Job page, "Waiting on a file":** record what a job needs (for example the plat for lot lines) and attach it once found. The work from it unblocks by itself.
- **Mondays:** read the AutoHDR balance into the card. Jordan tops up.

**James**
- **/review:** you're first on every cut. Approve (it goes to Topaz, then the client), or send it back with notes. Your name is on each note.
- **Rush:** the **Rush** button on a job shows which jobs it pushes back before you save. You can approve it, or send it to Jordan.

**Editors (Kim, John)**
- Press **Start** on the job you're working on. Pressing Start on another job pauses the first.
- After you upload, answer "still on this?".
- Finish the self-check before you submit.

**Photographers**
- On the upload page, submit photos and video separately. The video is due by 8 AM the next day.
- Each video's brief is on the page. Add on-site notes there.

### Client-launch approval package

**Must be true first:**
1. Supervised Aryeo sitting passed (#1), if self-booking is included.
2. Real-phone pass done (#3).
3. Reminder wording and hours reviewed in Settings → Content program → Program reminders. Its dry run shows every email that would go out.
4. Recommended: old public video copies deleted (#2).

**Proposed stages.** Jordan approves each one separately:

| Stage | Turn on | Reaches | Undo |
|---|---|---|---|
| A — internal AI help | `ai_runs`, `script_drafting`, `strategy_generation`, `topic_refresh` | nobody; drafts wait for Jordan (AI credit per run) | switch off in Settings |
| B — TEST clients end to end | `reminders`, `script_share_email`, `portal_invites`, `portal_login_email`, `program_message_notice`, `revision_policy` (the TEST-only lock stays on) | Jordan's test inboxes only | switch off |
| C — pilot (Jordan names 1–3 clients) | stage B's switches for the named clients; `session_booking` + `address_sync` for them after #1 | those clients by email; their Aryeo bookings | remove from the pilot list or switch off; nothing further goes out |
| D — everyone | lift the TEST-only lock; `portal_layout_v2` | every client with a program | switch off / restore the lock |

**Stays OFF whatever the stage:**
- `script_auto_share` (Jordan's decision);
- `review_auto_approve` (TEST-only);
- `topic_carryover` (Jordan's decision);
- `publishing` (no Meta app);
- `cut_transcripts` (no speech-to-text provider).

**To approve a stage**, Jordan replies with the stage letter and, for C, the client names. Claude then:
- switches it on;
- confirms with the readiness panel and the dry run what will go out and to whom;
- watches the first hourly run.
