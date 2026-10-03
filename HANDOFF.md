# Handoff — RealTour Pilot Operations Hub

**Session date:** 2026-08-19 · **Branch:** `books-cleanup` · **Deployed:** all work below is live in production
**Latest deploy:** `5586a70` → https://realtour-pilot-hub.vercel.app (● Ready)

---

## 1. What shipped this session

Five commits, all deployed and verified in-browser against live data.

| Commit | What it fixes |
|---|---|
| `560b855` | Editing-workflow audit — package tiers, stuck statuses, honest comms |
| `888743e` | Marketing suffixes could strip a reel's premium tier |
| `d03e1e9` | Comms threads rendered blank — OpenPhone/Quo API change |
| `333f9b6` | Editor queue shows the customer's real order notes; notes are editable |
| `5586a70` | Finance: Venmo tagged, 107 review items cleared, books-behind warning |

### Editing-workflow audit (`560b855`)
28-agent audit, 23 confirmed findings, high-impact set fixed.

- **Package tiers were being misread.** Video Starter / Accelerator / Pro (personal branding) were flattened to a generic "Video" label at import, so 39 live jobs got a 48-hour listing SLA and routed to the standard lane. Plan titles now survive import; `MONTHLY_PLAN_RE` broadened and exported from `pipeline.ts`; "Standard Cinematic Video" can never read as premium.
- 8 branding shoots booked as "Content Day"/"Branding Shoot" had **no video deliverable at all** — they parsed as `OTHER`. Fixed.
- **Statuses:** replying to a client's revision email was auto-completing the re-edit (gmail sweep now excludes `revision`/`edit_video`); off-Revisions queue clicks stopped snapping back; past-shoot jobs awaiting raws now show as "Waiting" instead of vanishing.
- **Comms:** approving 1 of N videos no longer tells Kyle "ready to deliver"; the dead "Send raws to Luma" task was removed.
- Data repaired: 39 deliverables relabeled, Koser Rd zombies closed, 2 stranded REVISION jobs unstuck.

### Premium-tier suffix bug (`888743e`)
Aryeo renamed a product to `"Premium Social Media Reel - Most Popular"`; the exact product-map lookup missed and the fallback stamped a generic "Social Reel" — losing the premium tier and the 72h SLA (1337 Carolannes).

- `mappedTypesForTitle()` — exact match, then longest-key word-prefix match, **vetoed** when the leftover suffix contains media words (`MEDIA_WORD_RE`) or restriction/fee words (`SUFFIX_VETO_RE`: only/no/without/fee/refund/cancel/reschedul). Without that veto, `"Essentials Package - Interior Only"` would have minted phantom drone + floorplan deliverables.
- Monthly now outranks premium everywhere (label ternaries, dedupe rank 3>2>1, jobProfit rates) — the plan title carries *both* signals, `"Premium Video"` erases one.
- Verified against **all 206 live product titles**: 9 resolve via the new prefix path, all correct.
- Data: 6 reels relabeled Premium (1 live + 5 delivered history).

### Comms threads were blank (`d03e1e9`)
**OpenPhone is now Quo and their API changed.** Every conversation in the inbox rendered "No messages yet."

- The participants filter must be the plain key `participants`, **repeated once per number**. The bracketed `participants[]` we'd always sent now returns 400 (`"/participants: Expected array"`, error body cites quo.com/docs).
- `conversationThread` had `.catch(() => [])` on it, so a broken query looked exactly like a client who'd never written. **That swallow is why it went unnoticed.**
- Added `pageAll` (100/page via `nextPageToken`) so long threads load in full, not the newest 30.
- New `src/lib/commsThread.ts` `loadConversation()` merges the live pull with our own logged `CommLog` texts — a provider outage now shows saved history behind a banner instead of a blank room.
- Chat gained Today/Yesterday/date separators.

### Editor queue notes (`333f9b6`)
"Customer notes" never contained anything the *customer* said — it showed Kyle's typed style prefs. The client's real order request lived in `Appointment.description`, parsed only for `/shoot`. **7 of 27 live jobs carry one.**

- `/editing` now parses the appointment brief (reusing `parseShootBrief`) into a read-only **"From their order"** block. Aryeo's literal `"n/a"` placeholder is not treated as a note.
- Three voices kept separate: their order (Aryeo) · our note for this job (`Project.notes`) · their usual style (`Client.editingPreferences`).
- Both note boxes editable inline via `saveJobNotes`. **Owners, admins, photographers can write; editors read only** — enforced server-side with `requireRole` (which also blocks "view as").
- The Aryeo order text is deliberately **not** editable: it's their record and the next sync would overwrite it. Corrections go in the job note beside it.

### Finance audit + fixes (`5586a70`)
See §3 for the full financial picture. Code changes:

- Venmo account tagged BUSINESS.
- Classification **rules** (not hand-tagging) for recurring merchants; `PLAID_FALLBACK` added to `classifyRow` (4th arg `plaidDetail`).
- `booksHealth()` now measures the newest **transaction date**, not `syncedAt`; banner above the KPIs past 7 days.

---

## 2. Gotchas worth remembering

- **`CommLog.externalId` is source-prefixed** (`op-AC123…`) vs the API's bare `AC123…`. Normalize with `.replace(/^[a-z]+-/, "")` or every message renders twice. (I shipped that bug and caught it in the browser.)
- **`PlaidAccount.isBusiness` does NOT drive business-vs-personal spend**, despite what the schema comment says. Per-transaction `financeKind` does. `isBusiness` only filters the business cash balance (`type: "depository"` only) and card-paydown attribution.
- **`booksHealth` tracking `syncedAt` hid a two-week hole** — "synced today" while the newest entry was Aug 4. Measure data age, not job age.
- Aryeo's auto-loan pull reads `DIRECTPAY…AUTO`; the card paid by phone reads `MOBILE PMT…`. They must not match the same rule.
- The classifier reads `name` first, then `merchantName` — write rules against `name`.
- `categorizeAllPlaid()` re-classifies every row where `financeLocked: false`, so hand-set categories get reverted unless locked. Prefer fixing rules.
- Node 20 required: `export PATH="/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH"`. `tsx` does not autoload `.env` — use `set -a && source .env; set +a`.
- **The Neon DB is shared with production.** Every probe write is immediate. `npm run db:reset` would destroy prod — there is no guard.

---

## 3. Financial position (as of 2026-08-19)

Audited read-only against live bank feeds, QuickBooks, and Aryeo.

**Verified correct:** the personal-account detour is booked properly. $94,772 of 2026 revenue landed in personal ...0942 from Stripe/Intuit and is counted as income. Of 107 business→personal round trips ($46,851), only 2 ($500) double-count. **$0** of self-transfers are misbooked as business expense.

**2026 year to date (live bank feed):**

| | |
|---|---|
| Revenue arriving | **$324,048** |
| Business spend | $191,969 |
| **Business net** | **+$132,079** (positive every single month) |
| Personal spend | $129,127 |
| **Left over** | **+$2,952** |

- **Cash at audit:** total available across checking **−$2,032**. Business ...3002 overdrawn −$3,369; personal ...0942 shows $1,614 but only **$29 available**.
- **Overdraft/bank fees: $4,187 YTD**, climbing ($80 Jan → $1,467 Jul; ~$1,200 refunded in Aug).
- **Detour trend:** 11% of revenue to personal in Jan → **82% in August**.
- **AR: $7,185** across 21 jobs — not a meaningful lever.
- **QuickBooks stops at Aug 4** — verified by querying QBO directly, not a sync-window bug (`syncQuickBooks` pulls 400 days). August in QBO: $140 of purchases vs $11,330 real.

> Commingling and owner-draw treatment is a **CPA question** — deliberately not decided here.

---

## 4. Open items — need Jordan

1. **Kim has no hub login.** She's the live personal-branding route in settings, but every notification addressed to her lands where nobody can see it. *Needs her email.*
2. **Editor texts during the ET workday are silently dropped, not delayed** — Manila quiet hours overlap exactly with review time. Needs a queue-for-their-morning build.
3. **John Mark's phone number is missing** — SMS to him no-ops. (Standing item.)
4. **QuickBooks needs August entered** — 66 business transactions have posted since its last entry.
5. **5 finance rows left in review on purpose** ($67 total): a UPS shipment, two Commonwealth of PA payments, a masked merchant, a "SUPER+" charge. Genuinely his call.
6. **Three statement-fed accounts are stale** — Venmo (33d), Venmo–Lauren (44d), Tilt Engage (40d). Spend there since mid-July is missing from every total.
7. **Auto Loan ...6075** tagged business, $19,625 balance, zero transactions flowing.

## 5. Open items — code

- `music`/`audio`/`song` keywords can still route a *photo* request to the video revision lane.
- `Project.packageName` is never populated from Aryeo (blank on all 1,501 projects).
- Negation titles (`"… - No Drone"`) still mint the phantom component via the keyword fallback (pre-existing).
- Frame.io webhook uses `client.socialClient` as the monthly flag instead of `isMonthlyContentJob` (dormant integration).
- `README.md` / `AGENTS.md` are stale.

---

## 6. Standing constraints

- **Never deliver anything to a client without human review.** Draft-then-send everywhere.
- **No pricing on any creative-visible page.**
- **Jordan enters all passwords/secrets himself.** Never type credentials into a field.
- **QuickBooks access is read-only.**
- Audit/probe scripts against prod must be strictly read-only unless doing a deliberate, reported repair.


## October 2 review/delivery simplification follow-up

Resume from `docs/review-delivery-simplification-2026-10-02-checklist.md`, which supersedes earlier UI state and records latest local checkpoints, verified behavior and release holds. Raw/Final buttons restored visibly with green/empty dots; history and client assets expanded; exact selected-video navigation/status fixed. New backlog excludes deployment, sends, provider deliveries and bulk production repair. Do not repeat the completed audit or causal checks. Production `.env` remains live; new publication column is not applied. Check the checklist's concrete remaining real-world checks before release.

## Latest production release — October 2

The user subsequently authorized deployment and Git commit. The old deployment hold and schema-absent statements are historical: a3133a5 is now READY at https://hub.realtourpilot.com after verified backup, additive nullable portalPublicationRequiredAt rollout, successful remote build and authenticated read-only Editing Room menu smoke. All existing rollout settings retained; no client sends/provider deliveries/automation activation. See `docs/review-delivery-simplification-2026-10-02-production-release.md` for deployment ID, source SHA, backup integrity, rollback target and open native upload/provider acceptance. Do not repeat completed investigation. Latest source and documentation are being fast-forwarded to GitHub main under the user’s existing authorization.

### Latest upload acknowledgement follow-up

User reported spinning Mark as Uploaded and requested always-visible Files and Upload, green acknowledgement beside Watch it. Implemented/tested in 2131f6e and 10e5af8; 47 isolated UI and 21 ledger checks, scoped lint/typecheck, remote build passed. 10e5af8 deployed READY (dpl_EPg4b58VvSvvYhjeeP5AqKn3jCky) on production alias. Fifteen-second browser confirmation bound retains explicit same-version reconciliation, optional Dropbox metadata limited to two seconds, saved receipts/permissions/destination proof unchanged. Dashboard browser navigation/screenshot stalled; no real live acknowledgement used to verify the report. No schema/settings/client-send changes. Full receipt in latest completion-checklist section.

### Latest two-stage delivery and display candidate

Continue from the final section of `docs/review-delivery-simplification-2026-10-02-checklist.md`. Uploaded history is superseded by expanded Ready for upload / Uploaded, not sent queues with immediate exact-source movement/removal. Saved editor assignment and routing suggestion now distinct; portalled editor menu and contained status errors; mobile brief inner-grid clipping fixed. Isolated native upload acknowledgement/manual send flow passed, no live mutations. Candidate release underway; record exact READY deployment and main SHA before claiming deployed/pushed. Broader native choose-file/QC and authentic provider handoff acceptance remain separate open checks. Preserve sends/rollout restrictions.

Release confirmed: application `e0b5a5aae826b4f44ad8de5ff1106c32df2cc0c7` is production READY as `dpl_YGQgmAosoXfh8aSVQi7GRh2v9gvj`, https://realtour-pilot-j5ge46yr8-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com. Remote optimized build/typecheck/page generation passed. No schema/settings/live record mutation/client-send action. Previous rollback target remains `dpl_FvYP24cZAaKWnS7J4rtLcJpGRX5i` (retain all business writes/schema). Production read-only browser smoke underway; main fast-forward receipt follows.

Final receipt: GitHub `RealtourPilotLLC/realtour-pilot-hub` main read back as `c589dd506c080920ee0d9c11c5bb6fcf376cdb39`, containing application e0b5a5a and release documentation; local worktree clean before this final receipt. Live supported-browser navigation to Editing Room timed out, then supported focus inspection also timed out; no fresh live visual/click acceptance claimed and no live action submitted. Vercel READY/production alias and remote build are confirmed; isolated native acceptance remains the evidence for current interactive fixes. Empty temporary `source` project cleanup remains blocked by automatic approval review pending the explicit user response. Other retained local fixtures unchanged; current owned3225 fixture expires through its3600s serve runner. No stalled build/test/push; no repeated failing tests.

### Evening upload-save recovery

Latest screenshot failure was a saved exact upload with lost browser confirmation: no live data repair needed. Added bounded, authenticated read-only exact-receipt recovery and explicit retry preflight; no automatic mutation retry/provider action. Added sanitized outcome diagnostics.99 isolated checks/typecheck/scoped lint pass. Continue from the latest completion-checklist section and verify new deployment receipt. Never mark this as client sent or alter original upload receipt.

Evening recovery release confirmed: source `92366971d3df13a0930d604845be570a250456ea` deployed READY as `dpl_AAP5qnMVEEHR7BXAoDL16X24uTdv`, https://realtour-pilot-66cbglwks-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com. Remote build/typecheck passed. Existing rollout gates/schema/settings preserved. Direct supported-browser navigation to raw JSON receipt API returned net::ERR_BLOCKED_BY_CLIENT; this does not establish whether ordinary in-page fetch is blocked. No alternative access mechanism used for that navigation. Existing authenticated owner Hub tab read normally; its only text input was empty and saved error idle. Normal page reload loaded new release and current database receipt: Ready for upload9→8, Uploaded/not sent2→3, exact Matlack Video2/v2 present in minimal unsent row, save error gone. No live mutation or client/provider send used in verification. Screenshot `/private/tmp/rtp-upload-recovery-production-proof.jpg`. Lost-response automatic recovery verified by actual helper/fenced network and PostgreSQL drills, not a newly forced live timeout. Git main release receipt follows. Previous rollback app deployment `dpl_YGQgmAosoXfh8aSVQi7GRh2v9gvj` retains all saved business data; never undo the original upload receipt. Browser-choice clarification optional/pending; broader actual choose-file/QC/provider-handoff acceptance remains open.

### Owner status controls / Newburg (current checkpoint)

Read-only evidence: Newburg has manual project Kim, no edit/revision card and unowned outputs. New office primary status picks reuse `saveEditOverrides` directly (server-role/view-as checked, pin and attribution); never manufacture an editor Start or file/QC/send receipt. Start now recognises explicit manual project pins without a conflicting live task. Automatic routing, deliberate task unassignment and agency/reassignment precedence remain protected. Final isolated checks:41 new actual Postgres action checks +140 existing desk regressions, types/scoped lint pass. First broader fallback failed the old handoff regression and was narrowed to manual pins before release. No production mutations or schema change. Files: `src/app/editing/actions.ts`, `src/components/editing/SimpleQueue.tsx`, `src/lib/editorWork.ts`, new `scripts/_drill/editing-office-status.ts`; optional boolean assertion type fixes only in prior `scripts/_drill/upload-record-recovery.ts`. Commit/deployment/menu read-only smoke receipt follows in the checklist and release log. Continue existing broader acceptance backlog; preserve client-send restrictions.

Release confirmed: app `02c0c643386532ab4c61e89b6f298175e6659300` is production READY `dpl_8AnRxmSY5vhE8dGKeWhWJNeRXNb9`, https://hub.realtourpilot.com alias. Remote build/types pass; native owner Newburg menu confirms all six stage choices enabled, compact and within viewport; saved Kim remains. No live status save/send used for proof; isolated actions verified. Screenshot `/private/tmp/rtp-office-status-production-proof.png`. Push this receipt commit to main by fast-forward, no force. Previous rollback deployment `dpl_AAP5qnMVEEHR7BXAoDL16X24uTdv` retains all saved records. No stalled test/build/deploy remains; other pre-existing fixture servers untouched. Continue broader existing acceptance checklist without restarting the audit.

### Current late-night receipt/group/approval candidate

Continue from the last checklist section. No investigation restart: production exact Matlack upload and manual-send writes succeeded; the browser lost confirmation. Candidate replaces body-dependent confirmation with committed source/attempt-bound headers, portable timeout signals, local-only upload save, one uploaded-not-sent row/action per project, signed subsequent delivery settlement and safe exact-version group retries. New direct group endpoint avoids root refresh/reconciliation UI. Missing revision-fix verification ticks now warn and permit explicit authorized Approve anyway with transactional audit; missing ticks remain unverified.172 focused checks and native isolated upload/group-send/approval workflow pass. No schema/live mutation/client sends/provider deliveries/settings changes. Supplementary legacy A02/A04 drill omitted modern upload precondition; stopped owned leaked process, repair verified in new real PG test. Record final types/lint, app SHA, READY deployment, read-only production smoke, main SHA below. Current source clean base f1995fd; preserve any additional work. Broader authentic choose-file/QC/provider handoff checks remain open.

Release now confirmed: app198376115f3e7de83a1bd0f01361ddbd03a2b246 deployed READY as dpl_2bXcBFQSiHA4xZJ7YfCc61UUJtG3 on https://hub.realtourpilot.com.172 focused checks, local types/lint, remote optimized build/types pass. Native isolated upload/group-send/approve-anyway pass; live owner read-only smoke shows only2 monthly portal-attention delivery rows, zero uploaded-not-sent/reconciliation controls and no horizontal overflow. Separate review/revision work remains. Preserve original real receipts; no live mutation used for tests. Git main receipt follows. Full release/rollback/open acceptance details in final checklist/release sections. Owned new3225/5617/5618 fixture can be gracefully stopped via script's SIGTERM handler; leave older3215/3216 fixtures untouched.
- Final Git/cleanup receipt: GitHub main read back as `46b6f0b0444f5d9f3907f37efd540d57931b9498`, containing application `1983761` and its production release notes. Local branch remains `codex/audit-2026-09-30`; no force push. The owned visual fixture was intentionally stopped with SIGTERM after completed browser acceptance; ports3225/5617/5618 have no listeners. Its serve wrapper reports exit143 from that shutdown (23 assertions passed,0 failed), not a newly failing behavioral test. Both temporary verification tabs closed; older processes preserved. This receipt is documentation only; production application remains READY at deployment `dpl_2bXcBFQSiHA4xZJ7YfCc61UUJtG3`. No pending application build/test/deploy.

### October 3 — branding destination and Final Dropbox follow-up

Latest local batch adds **Upload to Aryeo instead?** for approved monthly branding cuts in the portal attention queue and during Topaz processing. Staff routing choice is version/listing-bound in the existing audit ledger; finishing does not reset it, while exact finished-file upload fingerprints remain separate. It enters the existing Aryeo upload/grouped-send/webhook journey and blocks automatic portal publication for that selected version. Monthly identity, backups, original send/choice attribution and role/rollout gates remain intact. A missing linked listing returns a clear error; already delivered portal history cannot be silently converted. No migration/provider upload/client send/automation enablement.

290 targeted checks, local types/scoped lint and one focused source review passed. Supported native isolated choice → reload → uploaded → grouped sent flow passed. Existing Topaz save/hold/retry tests passed; read-only live metadata confirmed6/6 recent current approved processed files in their correct Final Dropbox folders. Private proof `/private/tmp/rtp-topaz-final-readonly-proof.json`; native visual `/private/tmp/rtp-branding-aryeo-option-native.png`. No Topaz saving rewrite was necessary. Commit/deployment/main receipts follow in the checklist/release notes. Preserve earlier wider acceptance holds; no broad re-audit.

Release confirmed: application `6d9e0fa5956ea8d2f59d36d75363a120ff338102` is production READY `dpl_3wTAMBJDWuzi5iovVwaVLS6goXfn`, https://realtour-pilot-6irkdo59h-realtour-pilot-s-projects.vercel.app aliased to https://hub.realtourpilot.com. Remote build/types/pages passed. Authenticated owner read-only native smoke confirms the option below file buttons on both pending live branding rows, no1280px overflow; screenshot `/private/tmp/rtp-branding-aryeo-production-proof.png`. No live choice/upload/send mutation used for testing. GitHub main fast-forward receipt follows. Corrected source-only archive successfully released after an initial missing-package archive was rejected before upload/build; no competing deployment remains. Owned fixture app3225/PG5617/sample5618 stopped, ports free; serve exit143 reflects intentional shutdown after23 assertions passed/0 failed. Older servers preserved. Rollback app only to `dpl_2bXcBFQSiHA4xZJ7YfCc61UUJtG3`; never revert saved business/audit data. Existing wider authentic choose-file/QC/provider and portal follow-ups remain open.
