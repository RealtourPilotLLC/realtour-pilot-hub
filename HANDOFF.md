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
