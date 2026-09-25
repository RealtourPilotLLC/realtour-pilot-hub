# Handoff — the September 22 follow-up audit (R1–R5)

> Filed here rather than at `HANDOFF.md`: that file is the Aug 19 session's own
> record and this macOS filesystem is case-insensitive, so writing `handoff.md`
> silently replaced it. Restored; this is the new document.

**Stop point.** This is the end of the batch. Nothing beyond it is authorised:
no client invitations, no client-facing automation switched on, no Aryeo
provider write, no further phase. Jordan's approval gate is where this stops.

---

## The commits

Baseline `4547f68`. The audit's own snapshot matched this working tree exactly
(tree `d1119a59`), so there was no drift to reconcile before starting.

| Commit | What |
|---|---|
| `977bddb` | **R1 + R2** — client script decisions pinned to the version displayed; one decision rule across three surfaces; change request atomic with its work item |
| `bda400b` | **R3** — staff SMS digest strands nothing; the recovery scan can reach an orphan |
| `5a43ba2` | **R4 + R5** — manual texts through the outbox; a half-finished send is visible and repairable |
| `7f3b0a1`* | Drop the now-unused direct OpenPhone imports from both comms rails |
| `245ddcd` | **R5** — the repair item survives a refresh, not just the press |

\* two small cleanup commits; see `git log` for exact ids.

## Changed paths

```
prisma/schema.prisma                       PendingSms.settledAt; OutboxMessage.extraToRefsJson, mediaUrlsJson
src/lib/scriptDecisions.ts                 currentScriptDecision (the one rule); version pinning; atomic change request; repair sweep
src/lib/filmedTopics.ts                    the filming brief reads the same rule; deterministic script pick
src/lib/portal.ts                          PortalTopic.script.sharedVersionId on the wire
src/lib/notify.ts                          pack-then-claim; settledAt checkpoint; bounded due read
src/lib/outbox.ts                          manual kind + manualKey; group + attachments; pendingManualSends; settleUnknownFromEcho
src/lib/readyToSend.ts                     incomplete reporting; repairIncompleteDeliveries; deliveriesNeedingFinishing
src/lib/opsDay.ts                          ReadyBoard shape
src/app/portal/actions.ts                  both client decisions carry the read version
src/app/ops/actions.ts                     SentResult passthrough; revalidation gated on a completed settle
src/app/communications/threadActions.ts    through the outbox, with an intent id
src/app/communications/replyActions.ts     same
src/app/api/webhooks/openphone/route.ts    the echo settles an unconfirmed send
src/app/api/cron/sync/route.ts             repairScriptChangeRequests, repairIncompleteDeliveries
src/components/portal/TopicBank.tsx        sends the version it rendered
src/components/comms/ConversationView.tsx  intent id; unconfirmed bubble; amber, not red
src/components/comms/ReplyQueue.tsx        intent id
src/components/ops/MarkSent.tsx            "Finish the bookkeeping" state
src/components/ops/ReadyToSendCard.tsx     the durable repair note
scripts/_drill/r1-r2-script-decisions.ts   37 checks
scripts/_drill/r3-staff-sms-recovery.ts    18 checks
scripts/_drill/r4-r5-send-and-repair.ts    30 checks
```

## Test results

| Drill | Result |
|---|---|
| `r1-r2-script-decisions` | 37 passed, 0 failed |
| `r3-staff-sms-recovery` | 18 passed, 0 failed |
| `r4-r5-send-and-repair` | 30 passed, 0 failed |
| `a01-digest-packing` | 15 passed, 0 failed |
| `a02-a04-delivery-truth` | 19 passed, 0 failed |
| `a07-appointment-evidence` | 18 passed, 0 failed |

Every one asserts the OLD behaviour before the new one. `npx tsc --noEmit`
clean; `npx eslint` on every changed path clean apart from warnings that
predate this batch.

**Browser checks**, both named by the audit, both on the Jordan test account:

- *Stale script tab.* Loaded the portal on v1, released v2 behind it, pressed
  "I'll film this". Refused with "We've published a newer version of this script
  since this page loaded." The ledger confirms no CLIENT_APPROVED row against
  v2.
- *Delivery retry card.* Pressed "Mark as sent" on a cut whose per-video row
  does not exist. The row stayed, the button became amber "Finish the
  bookkeeping" with no re-send confirm, and the durable note appeared at the top
  of the card — then cleared itself when the fixture was retired.

## Data touched in production

- Schema: three nullable columns, pushed additively. Backup taken first:
  `~/rtp-backup-2026-09-22-pre-followup.json`, 56 models, 6,953 rows.
- A TEST-only fixture project (`TEST r5-retry-card-drill — 1 Drill Court`) was
  created on the Jordan test client and then CANCELLED, not deleted.
- One October script on the test client has a v2 released, from the stale-tab
  check.
- No real client's data was written.

## Unresolved

1. **`settleUnknownFromEcho` has never met a real OpenPhone incident.** The
   classification and the reconcile are drilled against mocks. The first genuine
   timeout or 5xx on a live send is the real test.
2. **The duplicate-submit path is not asserted in the drill**, and the file says
   so: it re-reads the row inside its P2002 catch, and PGlite's socket server
   closes the connection on a unique violation. What is asserted is that the
   identity is stable and that Postgres, not the code, enforces one row per
   identity.
3. **No scheduled journey has been proven.** Every `ProgramAutomation` row is
   absent, which means off. A manual click is not evidence the cron path runs.
4. **Four library rows could not be re-keyed** (their URL is no longer on the
   listing). They keep their old key and are reported; nobody has decided what
   they should point at.
5. **Script length.** The call-path drafts were ESTIMATED at ≈39 s and ≈51 s
   from their word count (2.2 words/s) against a 20–30 s target — an estimate,
   not a timed read. Still a warning, not a block, and still Jordan's open
   question.
6. **Aryeo provider writes** remain unexercised and gated on Jordan's word.
7. **Reopened jobs still have no production clock** — 3 live jobs carry no date
   and say so in words.

## Corrections I owe, carried forward

- Commit `611714c` called the outbox guard "a floor under every send path". It
  was not: the thread composer and the Replies rail called OpenPhone directly
  and sat outside it. R4 is what makes the claim true, and the drill asserts it.
- I told Jordan `LISTING_CHANGED` carried a `videos` array that made it a
  media-added signal. The array is present and EMPTY on the events we have, and
  the receiver already handled the event better than the handler I wrote.
  Reverted; the audit agrees the recommendation should be closed.

## Deployment status

Committed, pushed (`0928b02`), and deployed to production —
`hub.realtourpilot.com`, deployment `realtour-pilot-1gx6zbyi0`, READY.

Enabled: nothing new. Every content-program automation row is still absent.

---

# Continued — September 23: the scheduled path

Same work stream, same stop point. Nothing here was enabled and nothing
client-facing was touched.

## Why this batch existed

Three documents in a row had to write the same sentence: *no scheduled journey
has been proven*. Everything in batch 3 was exercised by a person pressing a
button. The hourly cron — the thing that actually runs this program once Jordan
turns it on — had never been shown to take a month that owes scripts and leave
it with scripts.

## The commits

| Commit | What |
|---|---|
| `4b8658e` | A closed switch is a pause, not a fault — and the drill that proves the scheduled path (88 checks) |
| `e45595a` | The call-path drill survives its own second run |
| `be03313` | The six batch-2 drills that were left untracked |

## What running it found

Two defects, both on the path Jordan takes on day one.

**A deliberate stop was recorded as a failure.** `script_drafting` on with
`ai_runs` off made every draft throw `AutomationDisabledError`. That was counted
as a failure, put in `lastError`, and stamped on the switch row — which
`programMonitoring.ts:112` turns into `Automation "script_drafting" last run
failed`, `retryable:false`. Hourly, for as long as the stop was held, on the one
screen whose job is to show real failures.

**On the transcript side it did not just alarm — it created work.** The same
refusal came back as a `reviewReason`, which parked the job in `NEEDS_REVIEW`
*and* stamped the call record's `transcriptState`. Three hourly ticks with the
switch off exhausted `maxAttempts`, and `NEEDS_REVIEW` does not resume when the
switch returns. Pressing stop manufactured a queue of manual work that stayed
after the stop was lifted, and told Kyle three calls needed him when none did.

`failedAutomations` already promised the opposite in its own docstring — *"a
QUEUED job waiting for its switch is not a failure and is not listed here."* The
drivers underneath made it untrue.

## Changed paths

```
src/lib/contentDrafting.ts      a gated stop is a skip; `paused` reported; both sweeps stop at the first refusal
src/lib/transcriptJobs.ts       a `paused` outcome: requeued, attempt refunded, lease released, no error stamped
src/lib/contentGeneration.ts    AutomationDisabledError returns `paused`, never `reviewReason`
src/lib/contentPipeline.ts      the adapter carries `paused` through instead of folding it into needsReview
scripts/_drill/scheduled-journey.ts   88 checks
scripts/_drill/jordan-call-path.ts    re-runnable assertions (13 checks, twice)
scripts/_drill/{identity-access-baseline,pro-sessions-baseline,pro-two-sessions,
                session-loss-and-double-count,session-loss-and-double-count-proof,
                test-account-guards}.ts   filed, previously untracked
```

## Test results

| Drill | Result |
|---|---|
| `scheduled-journey` | 88 passed, 0 failed |
| `jordan-call-path` | 13 passed, 0 failed (twice, from the state the first run left) |
| `r1-r2-script-decisions` | 37 passed, 0 failed (regression) |

`npx tsc --noEmit` clean. `npx eslint` on every changed path: 0 errors, 2
warnings, both the `ok()` helper idiom every drill in this tree shares.

## Not proven, and not claimed

1. **The route's HTTP shell was not executed.** PGlite's socket server closes
   the connection on any unique violation and a cron run hits them by design —
   the notification dedupe key collided on the first attempt and every later
   query in the process failed. Production Postgres handles those collisions.
   In its place: the step's wiring read from the route source at runtime (same
   two functions, same bounds, questions before scripts) and the route's auth
   gate executed. That boundary is an assertion about source text and the drill
   says so.
2. **The live dedupe collision is still not asserted**, for the same reason.
   What is asserted is the identity of the claim, observed live while a run
   holds it; its lease; its release; and that Postgres — not the application —
   carries the unique constraint.
3. Everything carried forward from September 22 that was not touched here: a
   real Aryeo provider write, a real OpenPhone incident against the new send
   rail, the four un-re-keyed library rows, script length against the 20–30s
   target, the reopened-job production clock.

## Deployment status

Committed and pushed. Enabled: **nothing**. Every `ProgramAutomation` row in
production is still absent, which means off — including `script_drafting`, which
this batch proves works.
