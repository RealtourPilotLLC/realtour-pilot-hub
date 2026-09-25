# Handoff — the September 24 content-platform completion audit

Audit: `~/Downloads/Realtour-Pilot-Content-Platform-Completion-Audit-2026-09-24.md`,
pinned at `5fb89d3` — identical to HEAD when work began, so there was no drift
to reconcile.

**Stop point.** Everything below is built, tested and deployed with every new
automation OFF. Nothing here authorises client invitations, client-facing
automation, or a real provider write. Those wait for Jordan.

---

## The four states, kept apart

The audit asked that these never be folded into one word:

- **Implemented** — the code exists, typechecks and lints.
- **Tested** — a drill reproduces the old behaviour, then the new, on an
  isolated Postgres (PGlite) with every provider faked or fenced. **Tested
  against a real provider** is separate, and for bookings it has not happened.
- **Deployed** — running on `hub.realtourpilot.com`.
- **Enabled** — its automation switch is on for real clients. **Nothing from
  this audit is enabled.**

## How it was done

1. One read-only verification of all 15 findings plus the UI section, by 8
   agents against HEAD. Every finding was CONFIRMED; most were UNDERSTATED;
   none was refuted. The verified designs drove the build.
2. Six batches, each: builders with disjoint file ownership → two review
   lenses (correctness/concurrency; client-facing/permissions/money) → one
   independent skeptic per review finding → a fixer → my own full drill run.
3. Confirmed-and-fixed review findings: batch A 23 of 24, B–D 14 of 14, E–F 21
   of 21 (one of which is a coverage gap, below).

## Commits

| Commit | What | Deployed |
|---|---|---|
| `9defa7a` | Batch A schema (4 tables, 8 columns, additive) + `scripts/backup-all.ts` | schema pushed |
| `c17242c` | Drill harness: survives unique violations; runs the real cron GET | — |
| `f709f69` | **Batch A** — CP-01, 02, 03, 09 recovery, 10 | `a8mnss4e7` |
| `e26cacd` | Batches B–D schema (additive) | schema pushed |
| `4831554` | **Batches B–D** — CP-04, 05, 06, 07, 08, 09 rest, 11, 12, 13, 14 | `zgs7eticd` |
| `7d0d5c9` | CP-15 read-only configuration probe | with E/F |
| `c338f87` | Kyle's "notify the customer" box really emails (Jordan's call) | with E/F |
| `2bdfdcc` | Travel between addresses is Aryeo's call (Jordan's call) | with E/F |
| `d698f78` | journey-comms: weekend-paging section pinned to a real Sunday | — |
| `87c9f82` | A same-day extra shoot uploaded in the morning is no longer refused | with E/F |
| `84a15e3` | **Batch E** — CP-15: deploy stamp, strict email, the representative month, the real-cron journey, the private demo | with E/F |
| `46e109e` | **Batch F** — UI-01 portal, UI-02 staff workspace | **`dmjua42bl`, live** |

**Deployed SHA: `46e109e`**, verified on the live monitoring page ("This page:
46e109e586c0"). From this deploy on, every hourly run records the commit it
ran on (`HUB_COMMIT_SHA`), so "what is live" is read, not assumed.

## Findings

| ID | Resolved by | State |
|---|---|---|
| CP-01 approval gates download/captions | One rule, `cutEntitlement.ts`, behind every door incl. the ungated `stream?dl=1` | Implemented · tested (119) · deployed |
| CP-02 revision policy | Review windows (CAS), per-video ledger, 2 included rounds, fee acknowledgement, office charge/waive, expiry | Deployed · **enforcement and auto-approval OFF** (`revision_policy`, `review_auto_approve`) |
| CP-03 one video blocking another | Project throttle removed; per-video idempotency; addenda reach the open editor request | Tested (52) · deployed |
| CP-04 self-booking | Booking adapter with a pre-write marker, readback, reschedule/cancel, Pro = two orders | Tested against a **fake** Aryeo (147) · deployed · **OFF**; never written to real Aryeo |
| CP-05 address follow-up | Area → exact-address link → Aryeo PATCH + readback; Friday reminder; Kyle task on failure; Aryeo decides travel | Tested against the fake (77) · **OFF** (`address_sync`) |
| CP-06 setup and brand | Setup checklist, structured brand slots, clearing, team page, editor banner + Kyle task | Deployed · editor Slack DM **OFF** (`brand_change_alerts`) |
| CP-07 topic bank upkeep | Initial bank + refills, not-interested, carryover + swap | Deployed · **OFF** (`topic_refresh`, `topic_carryover`) |
| CP-08 insufficient answers | Sufficiency gate, gap questions, follow-up link, confidential filter | Deployed · follow-up email **OFF** (`reminders`) |
| CP-09 filming handoff | Durable filming report + retry; slot binding; topic folders; extras and notes | Deployed · folders **OFF** (`topic_folders`) |
| CP-10 misleading counts | One month-progress reader everywhere | Tested (122) · deployed |
| CP-11 call knowledge | "Remember" vs "apply a change", applied by a person with history | Deployed |
| CP-12 library and downloads | Previous content; identity-correction tool; download progress/share | Deployed · **real-device test not done** |
| CP-13 messages and resources | Program thread; staff panel; nine guides drafted UNPUBLISHED; Contact Kyle | Deployed · reply email **OFF** (`program_message_notice`) · guides unpublished |
| CP-14 Stripe | Docs no longer point at a 404; signed receiver built; polling stays | Deployed · receiver **not registered** (Jordan's action) |
| CP-15 configuration and journey | Probe, deploy stamp, strict email, representative month, real-cron drill, private demo | Deployed |
| UI-01 client portal | Home · My Plan · Library · Schedule · More | Live for **TEST clients only** · **OFF** for real clients (`portal_layout_v2`) |
| UI-02 staff workspace | Roster cards + table; six client tabs; redirects | **Live for staff** |

## Defects found along the way (not in the audit)

- **A closed switch was recorded as a failure** (Sep 23, `4b8658e`, earlier).
- **Two overlapping hourly runs could draft one topic twice** (a second paid AI
  run). Fixed in `84a15e3`: the dedupe key is held until the version is written.
- **A package decision that repeated a scheduled change silently cancelled it**
  (a Pro client could stay at one session a month). Fixed in `46e109e`.
- **Kyle's "notify the customer" box emailed nobody** (it sent a field Aryeo
  does not define). Now emails when ticked; starts unticked. `c338f87`.
- **A photographer adding same-day footage before noon was refused.** `87c9f82`.
- **Moving a hand-booked session could auto-confirm, or orphan the original.**
  Fixed in `4831554`.
- **The drill harness** could not survive a unique violation. The cause was
  PGlite sending ReadyForQuery twice; fixed in `c17242c`. Three older drills
  passed only at certain times of day; pinned.

## Tests

- 48 isolated drills, all green on a Friday morning (the time that exposed the
  clock-dependent ones), about 4,300 checks. Environment: PGlite in-process
  Postgres with the harness's socket fix; fetch **and** net/tls fenced; the
  model stubbed at `aiJsonWithUsage`; Aryeo faked from its saved API docs.
- The **real hourly entry point** (`GET /api/cron/sync`, bearer-authenticated,
  all 34 steps) runs end to end in `scheduled-journey` and `cron-route-journey`,
  including a SIGKILLed run reclaimed on the next tick.
- `npx tsc --noEmit` clean; eslint 0 errors on every changed file.
- Browser checks on the live hub: roster cards, the TEST client's six-tab
  workspace, the TEST portal's new layout, the monitoring deploy stamp.
- **The private demo** (Jordan's choice for the final demonstration):
  `scripts/demo/run-demo-dev.sh`, walkthrough in `docs/demo.md` — a complete
  client month (setup, strategy, topics, both planning paths, scheduling,
  filming handoff, internal review, client revision, approval, download,
  caption, carryover), a Pro month and an ended account, on an isolated
  database with every provider fenced.

## Data touched in production

- Two additive schema pushes, each after a full row-level backup
  (`~/rtp-backup-2026-09-24-full-pre-completion.json`, 117 models /
  112,181 rows; `…-pre-batchBCD.json`, 121 models / 112,520 rows).
- No real client's data was written by hand. Measured read-only before each
  deploy: of 170 program videos, the new release rule kept 162 files and moved
  one ("Mike Video 1" v3, approved internally, not yet sent) off "delivered" —
  it sits on Kyle's Ready-to-send card until he sends it.
- The representative month was **not** seeded on the live hub (Jordan chose the
  private demo).

## Not proven, and not claimed

1. **No real Aryeo write has ever been made.** The booking and address adapters
   are tested against a faithful fake only. See the supervised test plan below.
2. **Genuine contention under a real multi-session Postgres.** PGlite is one
   session, so contended advisory locks and overlapping transactions are
   reasoned, not run. One run of `cron-route-journey` against a disposable real
   Postgres would close it — never production.
3. **Real-device downloads** (iPhone Safari, Android Chrome) with real files.
4. **The new portal layout at phone width on a real phone.**
5. **Caption quality.** No speech-to-text provider is connected, so captions
   draft from the approved script only, and say so.
6. Everything carried from earlier handoffs that this audit did not reach: the
   reopened-job production clock, the four un-re-keyed legacy library rows
   (the new identity tool is how to fix them), script length against 20–30 s.

## Jordan's decisions recorded during this audit

- The extra-round fee may be acknowledged by the owner **or their assistant**.
- An extra round goes to the editor at once; the office charges or waives.
- An approved version **stays downloadable** while its replacement awaits
  approval.
- Hub bookings in Aryeo notify **our team only**.
- Kyle's "notify the customer" box **really emails** (default unticked).
- A $0 checkout **does not** activate a program; the office reviews it.
- Travel between addresses: **Aryeo's live availability decides**, no mileage rule.
- The final demonstration runs as a **private copy on this Mac**.

## Waiting on Jordan

- **The supervised Aryeo write test** (one sitting settles CP-04 and CP-05),
  on a disposable TEST fixture with its own Aryeo customer:
  - switches `session_booking` and `address_sync` on, with only that client in
    each switch's `authorizedFixtureClientIds`;
  - Video Accelerator, 240 minutes, James, a weekday at least 24 hours out;
  - area "West Chester, PA 19382", then an exact address, then one reschedule
    and one cancel from the portal;
  - watch: an **unpaid balance** appears on the test customer's order; whether
    the customer is emailed despite notify off; whether the address change
    moves the order title and map pin; whether Aryeo's availability counts
    drive time;
  - cleanup by hand: cancel the test order in Aryeo and void its balance; take
    the fixture out of both configs and turn both switches off.
- **Switches**, each his to turn on, each off today: `portal_layout_v2`,
  `revision_policy`, `review_auto_approve`, `brand_change_alerts`,
  `topic_refresh`, `topic_carryover`, `topic_folders`, `address_sync`,
  `session_booking`, `program_message_notice`, plus the pre-existing
  `portal_invites`, `portal_login_email`, `reminders`, `script_drafting`,
  `ai_runs` and the rest.
- **Publish the nine portal guides** (`docs/portal-guides/`) once read.
- **Optional:** register the Stripe webhook (URL and events in
  `docs/integration-tasks.md` §2); polling works without it.
- **Optional:** a disposable real Postgres (a local server or a Neon branch) to
  close the contention gap.

Future work, by the audit's own label: Instagram publishing, the broader
manager-agent organisation, and advanced marketing analytics.
