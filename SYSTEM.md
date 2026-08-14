# RealTour Pilot — Operations Hub

**The complete system reference.** Last verified against the live code and database on
**14 August 2026** (commit `9290b33`, 209 commits in). Every claim was checked against the
source by one agent and then adversarially re-checked against the source by a second; where
something could not be verified it says so.

**How to use this file.** It is written to bring a person or an AI project from zero context to
working understanding. Read [**Read this first**](#read-this-first) — one page, ten facts, and the
six things most likely to bite you — then use the [Contents](#contents) to jump. The twelve numbered
sections are reference depth, not narrative; you are not expected to read them front to back.
[Current state](#current-state-what-is-live-what-is-dormant-what-is-broken) is where the known
breakage, dormant features and stale comments are collected, and is the section most worth reading
in full before changing anything.

Contains **no credentials** — environment variables are named and explained, never valued.

> Two files in this repo will actively mislead you and should not be trusted over this one.
> `README.md` describes "Milestone 1", a local SQLite database, and lists Aryeo / OpenPhone /
> Gmail / QuickBooks / Stripe / Dropbox / Slack as integrations that "come later" — all of them
> have been live for months. `AGENTS.md`, which is loaded as project instructions into every
> Claude session, still says the database is "SQLite at `prisma/dev.db`"; it is Postgres on Neon,
> and that file is a stale leftover.

---

## What this is

RealTour Pilot is a real-estate media agency in Lititz, PA. It photographs and films
listings for agents, and the work moves through a chain: an agent orders a package → a
photographer shoots it → files get uploaded → an editor cuts it → someone checks the
quality → it gets delivered → the agent pays.

The Operations Hub is the in-house platform that runs that chain. It is not a CRM the
agency bought; it is a bespoke system built around how this specific business actually
works, and it holds the parts no off-the-shelf tool would know about: the real turnaround
promises per product, who edits what, how each creative is paid, the true cost and margin
of every package, and the entire history of what has been said to every client.

It exists because the business ran on five disconnected tools — Aryeo for orders,
OpenPhone for texts, Gmail for email, Dropbox for files, QuickBooks for money — and
nothing joined them. Work fell through the gaps between them. The Hub is the join.

**Who uses it**

| Person | Role | Lives on |
| --- | --- | --- |
| Jordan Spackman | `OWNER` | Dashboard, My Day, Finance, Trends, Review Room |
| Kyle | `ADMIN` | Tasks, Communications, Project Tracker, Review Room |
| Photographers (Harrison, James, Jordan) | `PHOTOGRAPHER` | My Shoots, Upload Portal, My Pay |
| Editors (Kim, Remar, Luma, external vendors) | `EDITOR` | Editor Queue, the per-edit tracker |

---

## The shape of it

```
                         ┌──────────────────────────────────────────┐
   ORDERS                │              OPERATIONS HUB              │
   Aryeo ────────────────▶                                          │
                         │   Project ── Deliverable ── SmartTask    │
   COMMS                 │      │            │             │        │
   OpenPhone ────────────▶      │            │             │        │
   Gmail ────────────────▶   CommLog     turnaround    the task     │
   Slack ────────────────▶  (one memory)   promises     engine      │
                         │      │                          │        │
   FILES                 │      ▼                          ▼        │
   Dropbox ──────────────▶   AI layer ◀────────────── Notifications │
   Frame.io ─────────────▶  (drafts, brain,               + alerts  │
                         │   Ask the Hub)                           │
   MONEY                 │      │                                   │
   Stripe ───────────────▶      ▼                                   │
   QuickBooks (read) ────▶  payroll · margin · P&L                  │
   Plaid ────────────────▶                                          │
                         └──────────────────────────────────────────┘
                                    │              │
                              Vercel crons    Signed webhooks
                            (5min / hourly /   (inbound events)
                                 daily 8am)
```

Four things carry the whole system, and everything else hangs off them:

1. **`Project`** — one job. Imported from Aryeo, enriched here. Its status is *derived
   from evidence* (files in Dropbox, media in Aryeo, what the client said), not typed in
   by hand.
2. **`SmartTask`** — one piece of work someone must do. Created by engines and by inbound
   messages, deduplicated by key, and **closed automatically when evidence says it's
   done** — that auto-close logic is the subtlest part of the codebase.
3. **`CommLog`** — every text, call, email and Slack message, in one table. It is the
   system's memory, and it is what the AI reads before it writes anything.
4. **The turnaround promises** (`src/lib/turnaround.ts`) — Jordan's real delivery
   commitments, encoded once. Due dates everywhere derive from these, per *deliverable*,
   not one flat SLA per job.

---

## Every surface

51 pages. Access is role-based (`src/lib/auth/access.ts`), with per-user overrides on top.
`•` = default access for that role.

| Route | What it is | Owner | Admin | Editor | Photog |
| --- | --- | :-: | :-: | :-: | :-: |
| `/` | Dashboard — 10-second "is anything on fire" | • | • | | |
| `/day` | **My Day** — owner's day plan + personal to-dos | • | | | |
| `/tasks` | Tasks hub: Today / Board / Done | • | • | • | |
| `/review` | Review Room — the quality desk | • | • | | |
| `/pipeline` | Project Tracker — the delivery board | • | • | | |
| `/schedule` | Schedule + map view | • | • | | |
| `/shoot` | My Shoots — the field platform | • | • | | • |
| `/upload` | Upload Portal — cull + submit | • | • | • | • |
| `/editing` | Editor Queue | • | • | • | |
| `/edit/[id]` | Per-edit tracker (Luma-style) | • | • | • | |
| `/communications` | Inbox / **Replies** / Email / Team / Outbox | • | • | | |
| `/clients` | Clients + AI working profiles | • | • | | |
| `/users` | People: Team · Logins · Activity | • | • | | |
| `/sales` | Finance: Revenue · Unpaid · Payroll | • | • ¹ | | |
| `/trends` | Leading indicators | • | • | | |
| `/my-pay` | Own pay + history | • | • | | • |
| `/catalog` | Service catalog | • | • | | |
| `/assistant` | **Ask the Hub** + saved documents | • | • | • | • |
| `/training` | 910 Academy course library | • | • | • | • |
| `/resources` | SOPs and quick links | • | • | • | • |
| `/feedback` | Platform feedback + feature board | • | • | | |
| `/connections` | Integration credentials | • | | | |
| `/marketing` | Campaigns scaffold | • | • | | |

¹ Admin sees only the **Unpaid** tab; Revenue and Payroll gate owner-only on the page itself.

**Redirect stubs** (old routes kept alive so existing links and bookmarks work):
`/today` `/queue` `/history` → `/tasks` · `/texts` → `/communications?tab=outbox` ·
`/map` → `/schedule?view=map` · `/billing` `/payouts` → `/sales` · `/team` → `/users?tab=team`.
These deliberately carry **no** `PageKey`, so any signed-in user may take the hop and the
destination enforces its own access.

---

## Read this first

If you are an AI project or a developer being handed this system cold, this page is the
minimum viable understanding. Everything below it is depth.

### The system in ten facts

1. **It is a join, not an app.** Five external systems hold the truth about different things —
   Aryeo (orders, client-facing delivery), OpenPhone (texts/calls), Gmail (email), Dropbox
   (files), QuickBooks + Stripe + Plaid (money). The Hub imports from all of them, reconciles
   them against one another, and is the only place the whole picture exists. It rarely
   *originates* data; Aryeo does. The Hub has never written an order back to Aryeo.
2. **Status is derived from evidence, not typed in.** A job's state comes from cross-checking
   what is actually true outside the Hub — files present in Dropbox, media live on Aryeo, what
   the client said. Anywhere a human tick is the input instead, that is a known weak point
   (see the delivery-board blocker, below).
3. **Due dates belong to deliverables, not to jobs.** One job can have photos due tomorrow and a
   premium reel due Thursday. The real promises live in `src/lib/turnaround.ts`: next-day for
   stills/floor plans/3D/staging, 48h standard video, 3–4 days premium reel, 7–10 **business**
   days for the monthly social packages.
4. **`SmartTask` is the unit of work, and auto-close is the hard part.** Tasks are minted by
   engines and by inbound messages, deduplicated on `dedupeKey`, and closed automatically when
   evidence says the work happened. Most subtle bugs in this system's history live here.
5. **`CommLog` is the memory.** 31,265 rows of every text, call, email and Slack message. Sensitivity
   tiers (`minRole`: `CREATIVE` < `ADMIN` < `OWNER`) gate who sees what — Jordan's Slack DMs and
   personal inbox are owner-only and invisible to Kyle.
6. **Everything client-facing is draft-then-send.** The AI writes; a human reads and clicks Send.
   There is no path in this system that auto-sends a message to a client. Treat that as an
   invariant, not a preference — several features are deliberately less convenient to preserve it.
7. **Time is Eastern, everywhere.** Every date shown or bucketed goes through `src/lib/datetime.ts`.
   Hard-coded UTC offsets are a recurring bug class here; a literal `-04:00` is right for eight
   months of the year and silently wrong for four.
8. **The comments are the documentation.** This codebase is commented unusually heavily and on
   purpose: comments explain *why*, and many record a specific past bug. They are load-bearing.
9. **Four roles, and creatives are walled off from money and client comms.** `OWNER`, `ADMIN`
   (Kyle), `EDITOR`, `PHOTOGRAPHER`. Editors and photographers both fold to the `CREATIVE`
   content tier and never see pay data or client conversations.
10. **It is deployed and in daily use.** Vercel + Neon Postgres, 1,496 projects, 332 clients,
    209 commits. There is no staging environment and no migration history — schema changes ship
    via `prisma db push` straight at production.

### The six things most likely to bite you

| | |
| --- | --- |
| **`npm run db:reset` deletes the business** | One `DATABASE_URL`, pointed at live Neon. The seed opens with `deleteMany()`. No guard. |
| **The daily cron has never completed a run** | 29/29 rows `finishedAt: null`. The failure alert lives *inside* the function that never runs, so nothing has ever reported it. |
| **Four webhook receivers accept unsigned POSTs** | Frame.io, OpenPhone, Aryeo, Script Studio — all fail-open "until a token is stored". |
| **Two turnaround engines disagree** | `/pipeline` and `Project.deliveryDue` give different answers for the same job. |
| **Three pages read a null user as the owner** | `/`, `/editing`, `/edit/<id>`. A deleted account with a live JWT is not "nobody". |
| **`Project.squareFeet` is null on 100% of rows** | So the photo-cull budget is a flat 50 for every property regardless of size. |

Full detail and the rest of the register: [Current state](#current-state-what-is-live-what-is-dormant-what-is-broken).

### Where to look for what

| If you need to… | Read |
| --- | --- |
| Understand the shape of the business | §1 The data model |
| Change how jobs move or when they're due | §2 Jobs, the pipeline and delivery promises |
| Touch anything about work assignment or auto-close | §3 The task engine |
| Send, draft, or read a message | §4 Communications |
| Connect, debug or re-auth an external system | §5 External integrations |
| Touch revenue, cost, pay or margin | §6 Money |
| Work on shoot → upload → edit → review | §7 The creative pipeline |
| Call a model, add a tool, or change a prompt | §8 The AI layer |
| Change who can see what | §9 Access control and security |
| Work on the dashboard, My Day or Trends | §10 Owner surfaces |
| Add a cron, webhook, alert or notification | §11 Automation |
| Set up the repo, deploy, or match house style | §12 Conventions, UI system and operations |

---

## Contents
- [Read this first](#read-this-first)
- [1. The data model](#1-the-data-model)
  - [Where the database lives](#where-the-database-lives)
  - [The seven domains](#the-seven-domains)
  - [The models that matter](#the-models-that-matter)
  - [Conventions and invariants the code assumes](#conventions-and-invariants-the-code-assumes)
  - [Dead, dormant, and barely-used models](#dead-dormant-and-barely-used-models)
- [2. Jobs, the pipeline and delivery promises](#2-jobs-the-pipeline-and-delivery-promises)
  - [The job record itself](#the-job-record-itself)
  - [The nine statuses](#the-nine-statuses)
  - [What actually moves a job between statuses](#what-actually-moves-a-job-between-statuses)
  - [The evidence-based status engine](#the-evidence-based-status-engine)
  - [The delivery promises — `src/lib/turnaround.ts`, verbatim](#the-delivery-promises-srclibturnaroundts-verbatim)
  - [The other turnaround engine, and where the two disagree](#the-other-turnaround-engine-and-where-the-two-disagree)
  - [`/pipeline` — the delivery board (Kyle's screen)](#pipeline-the-delivery-board-kyles-screen)
  - [`/editing` — the older tracker, still live](#editing-the-older-tracker-still-live)
  - [The project page](#the-project-page)
  - …and 1 more
- [3. The task engine](#3-the-task-engine)
  - [The row](#the-row)
  - [Every task type, who creates it, who closes it](#every-task-type-who-creates-it-who-closes-it)
  - [The dedupeKey scheme](#the-dedupekey-scheme)
  - [The Smart Brain router](#the-smart-brain-router)
  - [The hourly reconciler](#the-hourly-reconciler)
  - [Auto-close — every rule](#auto-close-every-rule)
  - [`assignedManually` — the invariant every engine must respect](#assignedmanually-the-invariant-every-engine-must-respect)
  - [Role scoping for editors](#role-scoping-for-editors)
  - [The Tasks hub — Today, Board, Done](#the-tasks-hub-today-board-done)
  - …and 2 more
- [4. Communications](#4-communications)
  - [The Communications hub — five tabs](#the-communications-hub-five-tabs)
  - [`CommLog` — the single comms memory](#commlog-the-single-comms-memory)
  - [Inbound: how a text becomes a task](#inbound-how-a-text-becomes-a-task)
  - [Inbound: email (Gmail poll)](#inbound-email-gmail-poll)
  - [Inbound: Slack](#inbound-slack)
  - [The Reply Queue (`?tab=replies`)](#the-reply-queue-tabreplies)
  - [Draft-then-send, and the house rules baked into the prompt](#draft-then-send-and-the-house-rules-baked-into-the-prompt)
  - [Every other outbound path (all draft-then-send)](#every-other-outbound-path-all-draft-then-send)
  - [Auto-close on outbound](#auto-close-on-outbound)
  - …and 4 more
- [5. External integrations](#5-external-integrations)
  - [The shared connection framework](#the-shared-connection-framework)
  - [Aryeo — orders, listings, appointments, media](#aryeo-orders-listings-appointments-media)
  - [OpenPhone (Quo) — calls and texts](#openphone-quo-calls-and-texts)
  - [Google — Gmail, Calendar, Drive (one OAuth client, several jobs)](#google-gmail-calendar-drive-one-oauth-client-several-jobs)
  - [Slack — notifications out, history in](#slack-notifications-out-history-in)
  - [Dropbox — the file system](#dropbox-the-file-system)
  - [Frame.io — editor review on finished video](#frameio-editor-review-on-finished-video)
  - [Anthropic (Claude) — the AI layer](#anthropic-claude-the-ai-layer)
  - [Stripe — collected revenue, fee-accurate](#stripe-collected-revenue-fee-accurate)
  - …and 5 more
- [6. Money: finance, payroll and profitability](#6-money-finance-payroll-and-profitability)
  - [How money is stored, per model](#how-money-is-stored-per-model)
  - [The two P&L engines, and why profit says "provisional"](#the-two-pl-engines-and-why-profit-says-provisional)
  - [Revenue: counted at the processor, never at the bank](#revenue-counted-at-the-processor-never-at-the-bank)
  - [Cost: the audited all-account ledger](#cost-the-audited-all-account-ledger)
  - [The QuickBooks classifier](#the-quickbooks-classifier)
  - [`/sales` — the Finance hub and its per-tab gating](#sales-the-finance-hub-and-its-per-tab-gating)
  - [Cash position and runway](#cash-position-and-runway)
  - [Payroll: the creative pay formula](#payroll-the-creative-pay-formula)
  - [Payouts and My Pay share one engine](#payouts-and-my-pay-share-one-engine)
  - …and 6 more
- [7. The creative pipeline: shoot, upload, edit, review](#7-the-creative-pipeline-shoot-upload-edit-review)
  - [The guided shoot screen](#the-guided-shoot-screen)
  - [Cull before upload, and the photo budget](#cull-before-upload-and-the-photo-budget)
  - [The Dropbox folder convention, and how file presence drives status](#the-dropbox-folder-convention-and-how-file-presence-drives-status)
  - [The upload portal](#the-upload-portal)
  - [Editor routing: who gets what](#editor-routing-who-gets-what)
  - [The editor queue and the per-edit brief](#the-editor-queue-and-the-per-edit-brief)
  - [The Review Room](#the-review-room)
  - [Photo review: pins, threads, verdicts, and image flags](#photo-review-pins-threads-verdicts-and-image-flags)
  - [Photographer feedback and KPIs](#photographer-feedback-and-kpis)
  - …and 2 more
- [8. The AI layer](#8-the-ai-layer)
  - [The connection and the two model tiers](#the-connection-and-the-two-model-tiers)
  - [Every place the system calls a model](#every-place-the-system-calls-a-model)
  - [`runHubAgent` — the tool-loop contract](#runhubagent-the-tool-loop-contract)
  - [Ask the Hub (`/assistant`)](#ask-the-hub-assistant)
  - [The knowledge base](#the-knowledge-base)
  - [The teach-it loop](#the-teach-it-loop)
  - [Policies — how taught facts constrain client drafts](#policies-how-taught-facts-constrain-client-drafts)
  - [Saved documents (HubDocuments)](#saved-documents-hubdocuments)
  - [Per-client AI working profiles](#per-client-ai-working-profiles)
  - …and 4 more
- [9. Access control and security](#9-access-control-and-security)
  - [Signing in](#signing-in)
  - [AUTH_ENFORCE, and what fails open vs closed](#auth_enforce-and-what-fails-open-vs-closed)
  - [Roles and the page matrix](#roles-and-the-page-matrix)
  - [Middleware: what it gates and what it does not](#middleware-what-it-gates-and-what-it-does-not)
  - [Page-level guards](#page-level-guards)
  - [`contentTier` and the CREATIVE / ADMIN / OWNER ladder](#contenttier-and-the-creative-admin-owner-ladder)
  - [The money scrub](#the-money-scrub)
  - ["View as" impersonation](#view-as-impersonation)
  - [Server-action guards](#server-action-guards)
  - …and 4 more
- [10. Owner surfaces](#10-owner-surfaces)
  - [The dashboard (`/`)](#the-dashboard)
  - [My Day (`/day`)](#my-day-day)
  - [Trends (`/trends`)](#trends-trends)
  - [Clients: the 6-tier segment model and the working profile](#clients-the-6-tier-segment-model-and-the-working-profile)
  - [Usage tracking — People → Activity](#usage-tracking-people-activity)
  - [`/history` — a redirect stub](#history-a-redirect-stub)
  - [The ET-everywhere date rule](#the-et-everywhere-date-rule)
- [11. Automation: crons, webhooks, alerts](#11-automation-crons-webhooks-alerts)
  - [1. The cron layer](#1-the-cron-layer)
  - [2. Webhooks](#2-webhooks)
  - [3. The notification system](#3-the-notification-system)
  - [4. Ops alerts — who gets interrupted, and on what](#4-ops-alerts-who-gets-interrupted-and-on-what)
  - [5. @mentions and the 3am-Manila rule](#5-mentions-and-the-3am-manila-rule)
  - [6. Usage tracking (internal-only, no alerts)](#6-usage-tracking-internal-only-no-alerts)
- [12. Conventions, UI system and operations](#12-conventions-ui-system-and-operations)
  - [The environment (read this first)](#the-environment-read-this-first)
  - [Every npm script](#every-npm-script)
  - [Deploying](#deploying)
  - [Folder layout](#folder-layout)
  - [The ET-everywhere date rule](#the-et-everywhere-date-rule)
  - [The design system](#the-design-system)
  - [The commenting convention](#the-commenting-convention)
  - [Required environment variables](#required-environment-variables)
- [Current state: what is live, what is dormant, what is broken](#current-state-what-is-live-what-is-dormant-what-is-broken)
- [Glossary](#glossary)

---


## 1. The data model

Everything the Hub knows lives in one Postgres database described by a single file,
`prisma/schema.prisma` (1,580 lines, 54 tables, 7 enums). Two tables carry the business:
`Project` (one shoot/order, 1,496 rows) and `Client` (one agent or brokerage, 332 rows).
Almost everything else hangs off those two — the tasks, the texts, the money, the photo
notes, the pay. The rest of this section is the map: what each table is for, the rules the
code assumes but the database does not enforce, and which tables are quietly empty.

All row counts below are live production counts read on **2026-08-14**.

### Where the database lives

| Thing | Value | Source |
| --- | --- | --- |
| Provider | `postgresql`, url from `env("DATABASE_URL")` | `prisma/schema.prisma:10-13` |
| Generator | `prisma-client-js` (the classic generator, not `prisma-client`) | `prisma/schema.prisma:6-8` |
| Host | Neon (`DATABASE_URL="postgresql://n…"` in the repo `.env`) | `.env:2` |
| Migrations | **None.** There is no `prisma/migrations/` directory | `ls prisma/` |
| Schema changes | `npm run db:push` → `prisma db push` | `package.json:11` |
| Client singleton | global-cached `PrismaClient`, `log: ["error","warn"]` in dev | `src/lib/prisma.ts` |

There is **no dev/prod datasource split**. One `datasource db` block, one `DATABASE_URL`.
The `.env` in the repo points at the same Neon database the deployed app uses — running the
count queries above from this working copy returned live production rows, including projects
created yesterday. See "Gotchas" for why that matters.

`prisma/dev.db` (1.5 MB, last modified 17 Jun) is a leftover SQLite file from before the
Postgres move. It is git-ignored (`.gitignore:21-22`) and nothing reads it. `AGENTS.md` still
says "SQLite at `prisma/dev.db`" — that line is stale.

### The seven domains

Read this as a hub-and-spoke: `Project` and `Client` are the hubs, and each domain is a
cluster of tables that either points at one of them or floats free as its own ledger.

| Domain | Models | How it connects |
| --- | --- | --- |
| **Pipeline / ops** | `Project`, `Deliverable`, `Appointment`, `OrderItem`, `Activity`, `ChecklistItem`, `UploadedFile`, `SmartTask`, `ProjectMessage`, `Feedback`, `QcRecord` | Everything cascades off `Project`. `Appointment` is the real scheduling truth (Aryeo `/appointments`); `Deliverable` is the internal production view; `OrderItem` is the commercial truth. |
| **People** | `TeamMember`, `AppUser`, `Client`, `Contact`, `UsageEvent` | `TeamMember` = the ops roster (who shoots/edits). `AppUser` = who can log in. They are **separate tables joined by a plain, unconstrained id**. `Client` self-relates via `parentClientId` to fold agency assistants under their agent. |
| **Money** | `StripeTransaction`, `QboTransaction`, `PlaidItem`/`PlaidAccount`/`PlaidTransaction`, `Expense`, `CashSnapshot`, `PayrollEntry`, `PayoutAdjustment`, `JobPayOverride`, `MileageDay`, `BonusPeriod`/`BonusAward`, `FinanceReport`, `BudgetTarget`, `SavingsItem`, `MarginSnapshot` | Three independent inbound rails (Stripe, QuickBooks, Plaid) each with their own ledger table; the payroll cluster hangs off `TeamMember`; `JobPayOverride` is the only one that also touches `Project`. |
| **Comms** | `CommLog`, `Notification`, `WebhookEvent`, `Connection`, `CronRun` | `CommLog` is the full-text memory of every text/call/email/Slack message (31,266 rows) and connects to `Client`/`Project` by **plain id, no FK**. `Connection` holds one encrypted credential blob per provider. |
| **AI / knowledge** | `KnowledgeItem`, `HubChat`/`HubMessage`, `HubDocument`, `TrainingLesson`, `Sop`, `Resource`, `GrowthPlan` | Free-floating. `KnowledgeItem` (5,825 rows) is the retrieval corpus and carries the `minRole` content tier. |
| **Creative / review** | `MediaNote`, `ReviewSubmission`, `MediaVerdict`, `ImageFlag` | All four hang off `Project`. `MediaNote` threads via `parentId`. `ImageFlag` is **not** superseded — it is still written by `src/app/projects/flagActions.ts:108` and read by the gallery and `src/lib/qc.ts:88`; the two coexist. |
| **Owner / system** | `OwnerTodo`, `OwnerMeeting`, `PlatformFeedback`, `Product` | `OwnerTodo` exists specifically so nothing automated can touch it (see below). |

Schema-wide counts: **89 `@@index`**, **22 single-column `@unique`** plus **6 composite
`@@unique`**, **31 `onDelete`** (25 `Cascade`, 6 `SetNull`), **zero** `Json` columns, **zero**
`Decimal` columns, **zero** `@db.*` attributes. The six composites are the real business
uniqueness rules: `PayrollEntry([teamMemberId, periodStart])` (:181),
`JobPayOverride([projectId, teamMemberId])` (:818), `QboTransaction([qboId, type])` (:878),
`BonusAward([periodId, teamMemberId])` (:960), `MileageDay([teamMemberId, dayKey])` (:982),
`MediaVerdict([projectId, assetUrl])` (:1091).

`Project.client` is a required relation with no `onDelete`, so Prisma defaults it to
`Restrict` — a `Client` with projects cannot be deleted. Every *optional* relation
(`Project.photographer`, `Activity.author`, `SmartTask.owner`, `Contact.client`, …) defaults
to `SetNull`, so deleting a `TeamMember` blanks their assignments rather than deleting work.

### The models that matter

| Model | Rows | What it is | Key fields |
| --- | --- | --- | --- |
| `Project` | 1,496 | One booked shoot/order, cradle to delivery. 100% `source: "ARYEO"` today. | `status` (`ProjectStatus`), `aryeoOrderId @unique`, `price`/`payableInvoice` (dollars), `balanceAmount` (**cents**), `statusEvidence` (JSON blob), `revisionRequestedAt`, `photographerManual`, `photoTarget`, `frameio*`, `scripting*`, `reel*` |
| `Client` | 332 | An agent, team, or brokerage. | `aryeoCustomerId @unique`, `email` + `backupEmail` (both identity keys), `parentClientId` (self-relation, 24 rows set), `segment`/`lifetimeSpendCents`/`transactionCount`, `profileSummary`/`profileJson` (AI working profile, 213 built), `socialClient`/`socialPlan` |
| `SmartTask` | 1,225 | Every unit of work in Kyle's queue, machine-minted or manual. | `dedupeKey @unique` (idempotency), `taskType`/`status`/`priority` as free strings, `assignedKey` (editor roster key), `assignedManually`, `checklist` (JSON), `summary` |
| `CommLog` | 31,266 | Full body of every text (14,238), Slack message (16,467), email (475), call transcript (86). Direction: 19,965 in / 11,301 out. | `externalId @unique` (dedup), `minRole` (`ADMIN` 17,334 / `OWNER` 13,932), `fromPhone` (10-digit key, normalized at write), `clientId`/`projectId` as **plain refs**. Carries a composite `@@index([channel, occurredAt])` whose comment says why: *"the reply queue scans recent texts newest-first; without this it table-scans."* |
| `TeamMember` | 8 | The ops roster: who shoots, edits, or runs ops. | `payType` (`PER_SHOOT` 5 / `HOURLY` 2 / `MONTHLY_FLAT` 1), `payPercent`/`payFloor`/`mileageRate`/`homeRadiusMi`, `creativeManager`, `opsAlerts`, `aryeoUserId @unique`, `aryeoTeamMemberId @unique`, `focusSummary`+`focusSummaryKey` |
| `AppUser` | 6 (2 OWNER / 1 ADMIN / 3 PHOTOGRAPHER — no EDITOR login exists yet) | Who can log in. Google-OAuth allowlist + optional scrypt password. | `email @unique`, `role` (`OWNER`/`ADMIN`/`EDITOR`/`PHOTOGRAPHER`, **defaults to `PHOTOGRAPHER`** — least privilege), `status` (`INVITED`/`ACTIVE`/`DISABLED`, defaults `INVITED`), `permissions` (per-page JSON), `passwordHash`, `inviteToken @unique`, `notificationsSeenAt` (single unread watermark), `teamMemberId`, `editorKey` |
| `Appointment` | 1,486 | An Aryeo appointment. Payroll is appointment-centric, not project-centric. | `aryeoId @unique`, `assignedToId`, `startAt`, `completedAt` (photographer's in-field mark, distinct from Aryeo `status`), `rawJson` |
| `Deliverable` | 3,791 | The internal production view of what has to be captured. | `type` (`DeliverableType`), `status` (`DeliverableStatus`), `capturedAt` (18 set), `uploadedAt` (10 set) |
| `OrderItem` | 1,610 | The verbatim Aryeo line items — "the commercial truth". Exists because `Deliverable` destroys product mix (a $350 Standard reel and a $2,000 Premium reel both collapse to `SOCIAL_REEL`). | `title` (verbatim, indexed), `amount` (**dollars**, converted from Aryeo cents), `isCanceled` (83 rows) |
| `KnowledgeItem` | 5,825 | The Ask-the-Hub corpus. Sources: `chatgpt-export` 3,780, `910-courses` 1,904, `aoc-training` 101, `playbook` 19, `hub-guide` 19, `learned` 2. | `minRole` (`CREATIVE` < `ADMIN` < `OWNER`), `category`, `pinned`, `archived`, `confidence` |
| `PlaidTransaction` | 10,704 | Bank/card lines from Jordan's business *and* personal accounts. | `id` = Plaid `transaction_id` (natural PK), `amount` (**positive = money OUT**), `financeKind` (`PERSONAL` 4,283 / `EXCLUDE` 3,611 / `BUSINESS` 1,656 / `REVIEW` 737 / `INCOME` 417), `financeLocked` (owner re-tag; auto-categorizer must not overwrite) |
| `QboTransaction` | 3,953 | The QuickBooks ledger. 320 rows flagged `needsReview`. | `@@unique([qboId, type])`, `memo` (bank-feed text — the only signal separating an owner draw from revenue), `linkedCount`, `duplicateOf`, `category`/`confidence`/`needsReview`, `personal` |
| `StripeTransaction` | 3,101 | Stripe balance transactions — gross, fee, net. | `id` = Stripe `txn_…` (natural PK), `destination` (Connect payee acct), `projectId` (best-effort, plain ref) |
| `Activity` | 4,490 | Project timeline. 4,303 of them are `SYSTEM`. | `type` (`ActivityType`), `body`, `authorId` |
| `Notification` | 758 | The bell. One row **per target**. | `kind`, `audience` (JSON `Role[]`), `userKey` (`null` = role broadcast, `tm:<id>` or `editor:<key>` = one person), `dedupeKey @unique` |
| `MediaNote` | 40 | Frame.io-style pin/timestamp note on a photo or video, threaded. | `lane` (`EDIT`/`PHOTOGRAPHER`/`EDITOR`), `kind` (`fix`/`coaching`), `x`/`y` (normalized 0..1) or `timeSec`, `sharedAt`/`seenAt`/`acknowledgedAt` receipts, `parentId` self-relation |
| `MileageDay` | 623 | Cached daily drive miles per creative (home → shoots → home via OSRM). | `@@unique([teamMemberId, dayKey])`, `sig` (route signature — invalidates the cache), `overrideMiles`/`overrideNote` (owner correction that wins over the computed figure) |
| `WebhookEvent` | 3,674 | Audit log of every inbound webhook, for debugging and replay. | `provider`, `externalId`, `status`, `payload` (raw JSON, truncated to 2,000 chars on rejection) |
| `CronRun` | 9,482 | One row per scheduled run so a failed step is visible on `/connections`. Live: `gmail` 8,723 ok / 4 failed, `sync` 711 ok / 15 failed, `daily` **0 ok / 29 failed** (see Gotchas — every one hard-killed). | `job` (`sync`/`daily`/`gmail`), `startedAt`/`finishedAt` (**null `finishedAt` = hard-killed mid-flight**), `ok`, `summary` (per-step JSON) |
| `OwnerTodo` | 22 | Jordan's personal list. Deliberately **not** a `SmartTask`. | `priority` (`NOW`/`NEXT`/`LATER`), `energy` (`DEEP`/`SHALLOW`), `estimateMin`, `plannedFor` (ET day key), `blockStart`/`blockEnd`/`calendarEventId`, `commLogId`/`gmailThreadId` as plain ids |
| `QcRecord` | 105 | One row per completed QC pass — the owner's quality dial. | `itemsChecked` (JSON snapshot), `missCount`, `clientSegment`, `reopenedByRevisionAt` (the actual QC-miss event) |
| `Connection` | 12 | One row per integration, all currently `CONNECTED`: aryeo, openphone, gmail, dropbox, slack, slack_user, stripe, quickbooks, plaid, frameio, frameio_app, ai. | `provider @unique`, `secretEncrypted` (AES-GCM, see `src/lib/integrations/crypto.ts`), `webhookSecret`, `lastError` |

The reason `OwnerTodo` is its own table is written into the schema at
`prisma/schema.prisma:1454-1467` and is the single best example of the commenting style in this
codebase: `SmartTask` has bulk sweeps that would eat a personal item — `closeObsoleteTasks`
cancels **every** open task on a project when Aryeo cancels the order, and the Gmail reply sweep
completes any task carrying a Gmail thread once that thread is answered. Neither filters on
`taskType` or `source`. "A personal list that silently loses items is worse than no list."

### Conventions and invariants the code assumes

#### Money is Float, and the unit varies by field

There is no `Decimal` anywhere. Every money column is `Float` (dollars) or `Int` (cents),
and **which one depends on the field**:

| Unit | Fields |
| --- | --- |
| **Dollars** (`Float`) | `Project.price`, `Project.payableInvoice`, `OrderItem.amount`, `Expense.amount`, `CashSnapshot.balance`, `StripeTransaction.gross`/`fee`/`net`, `QboTransaction.amount`/`balance`, `PlaidTransaction.amount`, `PayrollEntry.amount`, `PayoutAdjustment.amount`, `JobPayOverride.flatAmount`/`invoiceOverride`, all `BonusPeriod`/`BonusAward` amounts, `TeamMember.payFloor`/`monthlyPay`/`hourlyRate`/`mileageRate`, `SavingsItem.savesPerMonth`, `BudgetTarget.monthlyTarget` |
| **Cents** (`Int`) | `Project.balanceAmount`, `Client.lifetimeSpendCents`, `Product.minPrice`/`maxPrice` |

Aryeo sends integer cents; `money()` at `src/lib/integrations/aryeo.ts:404` divides by 100 on
the way in — but `balance_amount` is stored raw (`aryeo.ts:1007`), which is why every reader
divides it again: `src/lib/queries.ts:1002`, `src/app/projects/[id]/page.tsx:432`,
`src/lib/ownerPulse.ts:102`, `src/app/billing/actions.ts:29`,
`src/components/finance/RevenueTab.tsx:67,69`. Six call sites, no shared helper — a seventh
reader that forgets the `/100` shows a balance 100× too large.

Plaid has its own sign convention, documented at `prisma/schema.prisma:1395-1396`:
**positive `amount` = money OUT of the account, negative = money IN.** The finance layer must
honour this.

Typed money input goes through `parseMoney()` (`src/lib/money.ts:15`), which exists because a
bare `Number("$1,200")` returns `NaN`, and the payout override code read `NaN` as "nothing set"
and silently wiped the override.

#### Dates: UTC instants vs ET day-key strings

Instants are `DateTime`. Anything that names a *business day* is a `String` in `yyyy-mm-dd`
Eastern Time, because the business runs in ET and a UTC day boundary rolls over a few hours
early: `MileageDay.dayKey`, `PayrollEntry.periodStart`, `BonusPeriod.startKey`/`endKey`,
`FinanceReport.startKey`/`endKey`, `MarginSnapshot.startKey`/`endKey`, `OwnerTodo.plannedFor`.
`BonusPeriod.quarter` is `"2026-Q4"`. Helpers live in `src/lib/datetime.ts` (`etDayKey`,
`etDayStartUtc`).

#### JSON is stored as `String`, everywhere

Zero Prisma `Json` columns. Around 22 fields are JSON-in-a-string, a hangover from the SQLite
origin that was never migrated: `Project.statusEvidence`, `SmartTask.checklist`,
`Notification.audience`, `AppUser.permissions`, `Client.profileJson`, `Contact.phones`,
`Product.variants`/`tags`, `Connection.metadata`, `ImageFlag.tags`, `QcRecord.itemsChecked`,
`CronRun.summary`, `KnowledgeItem.tags`, `HubMessage.toolsUsed`, `BonusAward.breakdown`,
`OwnerMeeting.proposed`, `MarginSnapshot.json`, `GrowthPlan.json`, `WebhookEvent.payload`,
`QboTransaction.raw`, `Appointment.rawJson`, `TeamMember.focusSummary`, `ProjectMessage.mentions`.

Consequence: you cannot query into any of them from SQL, and every reader needs a defensive
parser. `src/lib/statusEvidence.ts` is the model to copy — a `parseEvidence()` (`:31`) that
returns `null` on malformed JSON and fills every field with a default, so a corrupt blob
degrades one card instead of throwing a page. `src/lib/checklist.ts` does the same for
`SmartTask.checklist` (`parseChecklist`/`serializeChecklist`/`checklistComplete`).

**Naming trap:** `ChecklistItem` is *both* a Prisma model (the vestigial per-project checklist
table, 0 rows) and a TypeScript type in `src/lib/checklist.ts:7` describing one entry inside the
`SmartTask.checklist` JSON string. They are unrelated. An import of `ChecklistItem` in
`src/lib/tasks.ts` is always the second one.

#### Plain refs with no foreign key — and why

Several id columns look like FKs but have no `@relation`, on purpose:

- **`CommLog.clientId` / `projectId`** — `prisma/schema.prisma:1204`: *"plain ref (no FK) so log rows survive client edits."* A comms log is a historical record; it must not vanish or block a merge when a duplicate client is cleaned up.
- **`OwnerTodo.commLogId` / `gmailThreadId`** — `prisma/schema.prisma:1486-1489`: stored as plain ids *"rather than a `source` string so no sweep can pattern-match them."* The FK-lessness is the point: it makes the row invisible to the task sweeps. (`OwnerTodo.project` and `.client` *are* real relations, both `onDelete: SetNull`.)
- **`UsageEvent.userId`** — denormalized alongside `email`/`name`/`role` so the trail survives a user being renamed or deleted.
- **`AppUser.teamMemberId` / `editorKey`** — the login↔roster link is a bare string, unconstrained. `editorKey` points into a **code constant, not a table**: `EDITORS` in `src/lib/editors.ts` (`kyle`, `jordan`, `creative_director`, `kim`, `remar`, `luma`, `autohdr`, `cubicasa`). Same for `SmartTask.assignedKey`, `MediaNote.editorKey`, `ReviewSubmission.submittedByKey`, and the `editor:<key>` half of `Notification.userKey`.
- **`Feedback.photographerId`**, **`StripeTransaction.projectId`**, **`ProjectMessage.authorId`**, **`MediaNote.authorKey`** — all plain.
- **`PlaidTransaction.account`** *is* a real relation, but it references `PlaidAccount.accountId` (a unique non-PK column, the Plaid account id) rather than the cuid PK.

#### Four idempotency patterns

Everything that ingests from outside has to be re-runnable. The codebase uses four distinct
mechanisms and it is worth knowing which is which:

1. **`dedupeKey @unique` on `SmartTask` and `Notification`.** For `SmartTask` the key is `sha1(parts).slice(0,24)` (`dedupe()`, `src/lib/tasks.ts:119-121`). The dominant pattern is a bare `findUnique` *before* create, which blocks re-creation **even if the task is already COMPLETED or CANCELLED** — deliberately, so a nudge Jordan has dealt with never comes back; the rationale is spelled out on the editor-login nudge (`src/lib/tasks.ts:1198-1202`: *"the dedupeKey row (open OR completed) permanently blocks re-creation"*). It is not universal: a handful of sweeps deliberately look only at *non-closed* rows (`tasks.ts:852`, `:1414`, `:1556`) so a closed one can be re-minted. Check which variant a given engine uses before assuming. For `Notification` the key is suffixed `-0`, `-1`, … per target index (`src/lib/notify.ts:283`) so a multi-target event inserts every row, and the `P2002` unique violation is caught and swallowed as "already announced" (`src/lib/notify.ts:305-309`).
2. **`externalId @unique` on `CommLog`.** `logComm()` pre-checks then catches `P2002`. Critically, **only** `P2002` is swallowed — anything else rethrows so the caller's error path (webhook `ERROR` row, cron error report) retries it. The comment records why: *"treating every failure as a dupe silently punched holes in comms memory"* (`src/lib/commLog.ts:59-64`).
3. **Provider id as the primary key.** `StripeTransaction.id` = Stripe `txn_…`; `PlaidTransaction.id` = Plaid `transaction_id`. Sync is a plain upsert on the natural key.
4. **Deterministic hashed primary key.** `UsageEvent.id = sha1(userId|path|20s-bucket).slice(0,25)` (`src/app/api/activity/route.ts:44-45`), so double-fires from React strict mode or two racing tabs collapse on the unique id instead of racing past a check-then-create.

Aryeo's own linkage keys are `Project.aryeoOrderId @unique`, `Appointment.aryeoId @unique`,
`Client.aryeoCustomerId @unique`, `Product.aryeoId @unique`, `TeamMember.aryeoUserId @unique`,
`TeamMember.aryeoTeamMemberId @unique`. `Project.aryeoId` and `aryeoListingId` are **not** unique.

#### Client identity: two unique slots, resolved by code not constraints

`Client.email` is only `@@index`ed (`prisma/schema.prisma:330`), never unique. Duplicate
prevention is entirely in `resolveClient` — **not an exported function**, a local closure inside
`syncAryeoOrders` at `src/lib/integrations/aryeo.ts:776-844` — which matches in ranked order:
`aryeoCustomerId` → `email` → `phone`+same-name → `name`+`company` → `backupEmail`+same-name.
A hit on any signal below `email` *adopts* onto the existing row (taking the Aryeo-id slot only
if empty, stashing the new address as `backupEmail` only if empty) rather than minting a twin.
Two rules are written in as past-bug scars:

- A phone match **also requires the same name** — *"two agents sharing an office line must not get collapsed into one client."*
- An **occupied** `backupEmail` is never clobbered, because it is itself an identity key (usually a merged-away twin's old address). `backupEmail` ranks *below* phone and name+company and needs name corroboration, *"backup addresses can be shared team inboxes."*

29 clients currently carry a `backupEmail`; 62 carry an `aryeoTeamId`; 24 are folded under a
`parentClientId`.

#### Three role vocabularies, plus a fourth for content

This trips people up constantly. They are not the same enum and do not map cleanly:

| Vocabulary | Values | Where | Meaning |
| --- | --- | --- | --- |
| `Role` enum | `ADMIN`, `MANAGER`, `SALES`, `PHOTOGRAPHER`, `EDITOR`, `VA` | `TeamMember.role`, `ChecklistItem.forRole` | What someone *does* operationally |
| `AppUser.role` (String) | `OWNER`, `ADMIN`, `EDITOR`, `PHOTOGRAPHER` | login + page access, `src/lib/auth/access.ts:18` | What someone can *see* |
| Editor key (String) | `kyle`, `kim`, `remar`, `luma`, `autohdr`, `cubicasa`, … | `SmartTask.assignedKey`, `MediaNote.editorKey` | Who work is *delegated to* — a code constant, not a table |
| `minRole` (String) | `CREATIVE` < `ADMIN` < `OWNER` | `KnowledgeItem.minRole`, `CommLog.minRole` | Content sensitivity tier |

The `minRole` tier is enforced on retrieval, not storage: `ROLE_RANK = {CREATIVE:1, ADMIN:2,
OWNER:3}` in `src/lib/hubTools.ts:199`, and `allowedRolesFor(viewer)` builds an `IN` list the
queries filter on. `contentTier()` (`src/lib/auth/access.ts:161`) collapses the four AppUser
roles into the three content tiers — anything that isn't OWNER or ADMIN is CREATIVE.
`saveFact()` applies a **sensitivity floor**: a fact whose text matches `OWNER_SENSITIVE` or
whose category is owner-only gets forced up to `minRole: "OWNER"` regardless of what the model
asked for (`src/lib/learn.ts:82-88`).

`TeamMember` carries two boolean flags that exist precisely *because* `Role` doesn't identify
the right people, and the reasoning is in the schema (`prisma/schema.prisma:103-114`):
`creativeManager` (sees every creative's field alerts) and `opsAlerts` (gets the ops pages).
*"Kyle is MANAGER, and so is Kim, an editor in Manila who must never get ops pages. Jordan is
PHOTOGRAPHER because he shoots. Roles describe what someone does; this describes who to wake up."*

#### Enums vs free strings

All seven enums are attached to columns, but only to **eight columns in total**, all of them
from the original 2026 pipeline schema: `Role` (`TeamMember.role:91`, `ChecklistItem.forRole:545`),
`ProjectStatus` (`Project.status:358`), `Priority` (`Project.priority:359` — and *only* there),
`DeliverableType` (`:501`), `DeliverableStatus` (`:504`), `ActivityType` (`:559`),
`PayType` (`TeamMember.payType:130`). Everything newer is a
`String` with the legal values in a trailing comment — `SmartTask.status`/`taskType`/`priority`,
`Notification.kind`, `CommLog.channel`/`direction`, `ImageFlag.status`, `MediaNote.lane`/`kind`/
`status`, `ReviewSubmission.status`, `PlaidItem.status`, `PlatformFeedback.status`,
`BonusPeriod.status`, `OwnerTodo.status`/`priority`/`energy`, `WebhookEvent.status`,
`Connection.status`. The stated reason is at `prisma/schema.prisma:623`: *"status/taskType/
priority are strings (the spec has many values) to stay flexible."* The cost is that several of
those comment-lists have drifted from reality (see Gotchas).

Live `SmartTask.taskType` values (16 distinct), most common first: `media_qa` 192,
`internal_instruction` 159, `confirmation_text` 155, `client_reply` 155, `delivery_text` 114,
`appointment_prep` 99, `todo` 73, `delivery` 70, `vendor_update` 51, `lead` 38, `revision` 36,
`comms_followup` 34, `finish_delivery` 32, `edit_video` 12, `image_fixes` 3, `connection_fix` 2.
The schema comment (`:644`) is explicitly open-ended (`appointment_prep | media_qa | delivery |
client_reply | reschedule_confirmation | ...`) — four of those are live, `reschedule_confirmation`
has zero rows. `SmartTask.status` (`:643`) is live on three of its six documented values:
`COMPLETED` 1,002, `CANCELLED` 113, `OPEN` 110 — `IN_PROGRESS`, `WAITING_*` and `BLOCKED` are
never written.

#### Denormalised and cached-on-the-row fields

Several columns exist purely so a page never has to compute or wait:

- `Client.segment` / `lifetimeSpendCents` / `transactionCount` / `segmentUpdatedAt` — recomputed by `syncClientSegments()` (`src/lib/segmentSync.ts`), which only writes rows that actually changed. Thresholds live in `computeSegment()` (`src/lib/segments.ts:21`, first match wins): 0 txns → `never_converted`, 1 → `one_timer`, then <$1.5k → `casual_repeat`, <$5k → `regular`, <$20k → `heavy`, else `vip`. Live spread in that order: 119 / 101 / 39 / 41 / 22 / 10.
- `TeamMember.focusSummary` + `focusSummaryKey` + `focusSummaryAt` — the key **fingerprints the notes the summary was built from**; when the notes change the key stops matching and the summary rebuilds. Cached so the page never waits on a model call.
- `Client.profileSummary` / `profileJson` / `profileUpdatedAt` — 213 clients have one; refreshed 20 at a time by the daily cron (cost-capped).
- `MarginSnapshot` and `GrowthPlan` are single-row caches (`scope @unique` = `"ytd"` / `"default"`). The `MarginSnapshot` comment explains why it must exist: costing a year of shoots runs the whole payroll engine, which reaches the **public OSRM router over the network** for mileage — *"fine in a nightly cron, fatal in a page request (it timed out a 60-second serverless function while taking 3s against a warm local cache)."* `GrowthPlan.snapKey` hashes the business numbers so the plan rebuilds when the business moves, not on every page load.
- `Project.coverImageUrl` (193 set) — the first live Aryeo listing image, so the My Shoots card can switch from a Street View placeholder to the real cover shot.
- `HubChat.summary` + `summaryAtCount` — lazily generated, invalidated when `messageCount` moves past `summaryAtCount`.

#### Override-wins fields (nullable by design)

A recurring pattern: an automatic value and a human correction live in **separate columns**, and
the recompute path is written to never touch the human one.

| Computed | Human override | Rule |
| --- | --- | --- |
| `MileageDay.miles` | `MileageDay.overrideMiles` / `overrideNote` | *"The upsert never touches the override columns — a recompute (route change, cache clear) must not eat an owner correction"* (`src/lib/payroll.ts:137-138`) |
| `Project.photographerId` from appointment assignee | `Project.photographerManual` (set on **0** rows) | When true the Aryeo sync stops auto-filling, *"so a manual assignment isn't silently reverted an hour later"* (`prisma/schema.prisma:405-408`) |
| `SmartTask.assignedKey` from the engines | `SmartTask.assignedManually` (set on **1** of 1,225 rows) | Three engines must respect it (`prisma/schema.prisma:653-657`): `mintEditTask`'s refresh keeps the editor, `ensureEditorHandoff` skips its editorId/raw-chase overrides, and evidence-based auto-close leaves the row alone — *"stale 'video delivered' evidence must not kill work a human just reopened on purpose"* |
| `PlaidTransaction.financeKind` from the categorizer | `PlaidTransaction.financeLocked` | Auto-categorizer must not overwrite a hand-tagged row |
| `Project.photoTarget` computed from `squareFeet` | `Project.photoTarget` set by owner | `photoTargetFor()` (`src/lib/culling.ts:29`), threshold `LARGE_PROPERTY_SQFT = 3500` (`:23`): ≥3,500 sq ft → 80, else 50 |
| `JobPayOverride.invoiceOverride` / `flatAmount` / `noMileage` / `excluded` / `manualAdd` | — | The whole table (32 rows) is the override layer over `computePayroll`, keyed `@@unique([projectId, teamMemberId])` |

`BonusPeriod.poolAmount` is nullable with the reason spelled out (`prisma/schema.prisma:912`):
*"Null until computed; 0 is a legitimate, meaningful value."* Same idea in `BonusAward.score`
(`:940`): *"0..100. Null when the quarter had too little signal to score fairly."* Both live on
tables with zero rows — see Dead models.

#### Retention

| Table | Window | Where |
| --- | --- | --- |
| `WebhookEvent` | 30 days | `src/app/api/cron/daily/route.ts:94` |
| `CronRun` | 30 days | `src/app/api/cron/daily/route.ts:100` |
| `Notification` | 90 days (own try/catch — *"never degrade the run over housekeeping"*) | `src/app/api/cron/daily/route.ts:107-113` |
| `UsageEvent` | 90 days, **pruned on read** (*"owner opens this tab rarely; volume tiny"*) | `src/lib/usage.ts:15, 94` |

`CommLog` has **no retention** — 31,266 rows and growing. Bodies are clipped to 6,000 chars and
subjects to 300 at write time (`src/lib/commLog.ts:45-46`). Neither do `PlaidTransaction`
(10,704), `QboTransaction` (3,953), `StripeTransaction` (3,101), `Activity` (4,490) or
`KnowledgeItem` (5,825) — retention exists only for the four tables above.

### Dead, dormant, and barely-used models

Verified by row count on the live database plus a `grep` for `prisma.<model>.` across `src/`.

| Model | Rows | State |
| --- | --- | --- |
| `BonusPeriod`, `BonusAward` | **0, 0** | **Fully dead.** Zero references anywhere in `src/`. The scoring engine `src/lib/bonus.ts` (277 lines, elaborate design comments) exists and compiles but **nothing imports it**, and it never touches either table. No UI, no server action, no approval path. The quarterly bonus is designed and unbuilt. |
| `ChecklistItem` | **0** | Loaded on the project page via the `checklist` relation (`src/lib/queries.ts:50`), rendered by `src/components/project/Checklist.tsx`, toggled by `toggleChecklistItem` (`src/app/actions.ts:695`) — but **nothing creates rows** except the demo seed (`prisma/seed.ts:163`). Vestigial — the `SmartTask.checklist` JSON replaced it. |
| `UploadedFile` | **0** | Create/delete actions exist (`src/app/upload/actions.ts:22,52`), it is read on the project page (`src/lib/queries.ts:212`) and has its own ownership guard (`src/lib/auth/guards.ts:119`) — but photographers upload to Dropbox directly now. The model's own comment still says *"the actual bytes live in local storage today."* |
| `MediaVerdict` | **0** | Per-photo APPROVED/NEEDS_WORK in the gallery lightbox. Wired (`src/app/projects/reviewActions.ts:353`, `src/lib/review.ts:103`), never used. |
| `Expense`, `CashSnapshot` | **0, 0** | Fully wired UI (`src/app/sales/moneyActions.ts`, `src/components/finance/MoneyTab.tsx`, `src/lib/finance.ts:196-199`) — the manual-entry money surfaces exist and Jordan has never entered anything. Superseded in practice by the Plaid/QBO/Stripe rails. |
| `PayrollEntry` | **0** | The editor/ops payroll bridge into the P&L. Write path is `src/app/sales/moneyActions.ts:54` (upsert on `@@unique([teamMemberId, periodStart])`), read path is `src/lib/finance.ts:62` (an `aggregate`). Built, never populated — those costs still only exist in the bank account, which is the exact gap the model was created to close. |
| `HubDocument` | **0** | Newest model (commit `f9afcf2`, "Ask the Hub can write documents that save"). Full read/write path at `/assistant/docs`. No documents saved yet. |
| `ReviewSubmission` | **1** | The editor "Done — send to review" flow. One submission ever. |
| `Feedback` | **1** | Post-delivery client feedback. Two writers (`src/lib/feedback.ts:55`, `src/lib/comms.ts:127`), six live readers including the photographer scorecards (`src/lib/photographerFeedback.ts:95,107`) and the client profile builder — all feeding on one row. Every quality KPI derived from it is statistically meaningless today. |
| `OwnerMeeting` | **2** | Meet-transcript → summary + proposed to-dos. Barely started. |
| `PayoutAdjustment` | 3 | Manual pay-period adjustments. The three live rows: "7 Park Lane" +$100, "Camera Payback - Final Payment" −$150, "Bernadette Rabel (Personal Branding Content)" +$357.76. Working, rarely needed. |
| `ProjectMessage`, `PlatformFeedback`, `Resource` | 6, 6, 9 | Working but low-traffic. |
| `Sop` (30), `ImageFlag` (25), `SavingsItem` (18), `BudgetTarget` (15) | | Working, small by nature. |

`Product` (49 rows) is written only by the Aryeo sync (`src/lib/integrations/aryeo.ts:1186`) and
read only by `/catalog` — a straight mirror with no downstream consumer.

`TrainingLesson` (160 rows) is fully populated but `shareToken` — the unguessable public
`/learn/<token>` link — has been minted exactly **once**.

Healthy but undocumented above: `Contact` 915 (synced OpenPhone contacts; `openPhoneId @unique`,
`phones` a JSON string array matched on last-10 digits — this is what lets a text from a client's
secondary line still resolve), `UsageEvent` 731, `HubMessage` 118 across `HubChat` 21,
`JobPayOverride` 32, `PlaidAccount` 9 under `PlaidItem` 6, `FinanceReport` 4.

### Gotchas / known state

- **Local dev runs against production.** There is one `DATABASE_URL` and the repo `.env` points at the live Neon database — the counts in this document were read from a working copy. `npm run db:reset` is `prisma db push --force-reset && npm run db:seed` (`package.json:15`), and `prisma/seed.ts` opens with `deleteMany()` on `activity`, `checklistItem`, `deliverable`, `project`, `client`, `teamMember`, `resource`, `sop` before inserting demo data. Running either command from this checkout would destroy 1,496 real projects and 332 real clients. There is no guard.
- **No migration history.** No `prisma/migrations/` directory; schema changes ship via `prisma db push`. There is no way to review, replay, or roll back a schema change, and no record of when a column appeared. Several code paths defend against this directly — `src/app/api/cron/daily/route.ts:112` wraps the notification prune in a try/catch with the comment *"table not pushed yet — never degrade the run over housekeeping"*, and `src/lib/packageMargin.ts:278` `.catch()`es a `findUnique` for the same reason.
- **`Project.squareFeet` is null on 100% of 1,496 rows — including projects created yesterday.** The sync code at `src/lib/integrations/aryeo.ts:1048-1054` carries the fix note ("Square footage lives on the LISTING, not the address. It was never mapped (audit: 0/153 projects had it)… Pull it through so large homes get the 80 target") and reads `order.listing?.square_feet` into the create. It still isn't landing — either Aryeo isn't returning `square_feet` under the configured `ORDER_INCLUDES`, or it is null upstream. Downstream, `photoTargetFor()` (`src/lib/culling.ts:29`) therefore returns 50 for **every** property, and `Project.photoTarget` is also null on all 1,496 rows, so no owner override compensates. The culling budget the status engine and Kyle's deliver card enforce is a flat 50 regardless of house size. The write only exists in the `project.create` path — there is **no update path** that backfills `squareFeet` onto an existing project, so even fixing the include leaves 1,496 rows blank.
- **`CommLog.fromPhone` is null on 13,590 of 14,238 text rows (95%).** The schema comment (`prisma/schema.prisma:1206-1211`) says nulls are pre-column rows that *"fall back to the client's number on file"* — which means the reply queue is running on that fallback for almost every historical text, and can't reply to a text from a number that isn't the client's primary.
- **`WebhookEvent.status`: the schema comment is stale in one direction, the data is thinner than the code in the other.** The comment says `RECEIVED | PROCESSED | ERROR`; the code can actually write five values — `RECEIVED` (the column default), `PROCESSED`, `ERROR` (receiver caught an exception, e.g. `src/app/api/webhooks/aryeo/route.ts:89`), `REJECTED` (signature failure at the door — aryeo `:42`, openphone `:24`, frameio `:24`, scripting `:32`), and `FAILED` (written by `retryFailedWebhooks` when the one retry is exhausted, `src/lib/webhookRetry.ts:44`). But **production holds only two**: `PROCESSED` 3,668 and `FAILED` 6 (all scripting). Zero `RECEIVED`, zero `ERROR`, zero `REJECTED` — no signature has ever been rejected, and the retry sweep only ever *selects* `ERROR` rows (`webhookRetry.ts:19`), so with none present it currently runs against nothing. Gmail rows are deliberately excluded from retry because their stored payload is only a snippet.
- **`Notification.kind` comment is stale.** The schema comment (`:1307`) lists 13 kinds; production has 19, and 11 of the live ones aren't in the comment: `reply_sla` (121), `raws_missing` (102), `order_canceled` (38), `cull` (16), `review_ready`, `review_submitted`, `review_approved`, `review_feedback`, `feedback_shared`, `photos_undelivered`, `task_assigned` (1 each). Conversely **five** documented kinds have zero rows: `order_paid`, `edit_finished`, `shoot_completed`, `client_feedback`, `mention`.
- **`PlaidTransaction.financeKind` comment is stale** — it documents four values (`BUSINESS | PERSONAL | EXCLUDE | REVIEW`) but the type is five (`src/lib/financeCategories.ts:22` adds `INCOME`), and 417 rows carry it.
- **Four doc-comments are stranded above the wrong model.** Someone inserted a model between an existing comment block and its model: the `SmartTask` description sits above `model UsageEvent` (`:622-623`, with `UsageEvent`'s own comment beneath it and `model SmartTask` 18 lines later at `:641`), the `Product` description "Service catalogue synced from Aryeo /products" sits above `model OrderItem` (`:733`, `model Product` at `:761`), the long PLAID section header sits above `model SavingsItem` (`:1319-1332`, the Plaid models start at `:1348`), and the `GrowthPlan` description sits above `model OwnerTodo` (`:1449-1452`, `model GrowthPlan` at `:1554`). Read the comment nearest the `model` keyword, not the top of the block.
- **`src/lib/qc.ts` claims "NOT WIRED YET" (line 9) — it is wired.** `getQcStats` is imported by `src/app/review/page.tsx:13` and `src/lib/queries.ts:9`. The comment is a leftover instruction to a future agent.
- **`reclassifyAryeoDeliverables()` destroys photographer field signals.** Defined at `src/lib/integrations/aryeo.ts:1955`, it runs `deleteMany` + `createMany` inside one `$transaction` (`:1974-1985`), carrying forward only the highest-ranked `status` per type (`STATUS_RANK` at `:1954`: PENDING 0, UPLOADED/FLAGGED 1, IN_PROGRESS 2, DONE 3). `capturedAt` and `uploadedAt` — the photographer's on-site capture tick and Dropbox-upload tick — are **not** in the `createMany` payload and are silently dropped. Currently harmless in practice: it is exported but called from nowhere in `src/`, so it is a manual maintenance function, and only 18/10 deliverables carry those stamps at all.
- **Money is `Float`, not `Decimal`, in every column.** No repro of a rounding bug was found, and `payableInvoiceFromItems` (`src/lib/integrations/aryeo.ts:490`) rounds cents before dividing (`:496`), but the P&L, payroll, and bonus engines all sum `Float` dollars.
- **The guided field flow is barely adopted.** `Deliverable.capturedAt` set on 18 rows, `uploadedAt` on 10, `Project.editorBrief` on **0**, `Project.reelHook` on **0**, `Project.photographerManual` on **0**, `Client.brandColors` and `Client.editingPreferences` on **0**. The `/shoot` and `/upload` capture-checklist and reel-recipe features exist and are essentially unused.
- **Frame.io and Script Studio are near-dormant on the data side.** 17 projects carry a `frameioProjectId`; exactly **1** carries a `scriptingId`. Both integrations show `CONNECTED` in the `Connection` table, but the `WebhookEvent` provider split is `openphone` 1,359 / `gmail` 1,134 / `aryeo` 895 / `slack` 244 / `scripting` 42 (36 processed, 6 failed) — and **zero `frameio` rows**. The Frame.io comment webhook has never been registered, so the comment→revision receiver has never fired in production.
- **`MediaNote.lane = "EDITOR"` has zero rows.** 38 of 40 notes are PHOTOGRAPHER-lane, 2 are EDIT. The editor feedback lane and its `editorKey` scoping are built and unexercised.
- **`Project.status` is 1,441 DELIVERED out of 1,496** (plus 20 SCHEDULED, 11 CANCELLED, 10 REVIEW, 10 REVISION, 3 BOOKED, 1 SHOT). Any query that scans all projects is effectively scanning delivered history; `@@index([status])` exists but has almost no selectivity for `DELIVERED`.
- **`CommLog` has no `CREATIVE`-tier rows.** Every one of the 31,266 rows is `ADMIN` (17,334) or `OWNER` (13,932), so the lowest content tier is currently a no-op on comms — a creative viewer sees nothing at all, not a filtered subset.
- **The `daily` cron has never once completed a run — and the code comment claiming that was fixed is wrong.** Every one of the 29 `daily` `CronRun` rows (one per day, 08:00 UTC, 2026-07-16 through today 2026-08-14) has `finishedAt: null`, `ok: false`, an empty `summary` and an empty `error`. That is the signature of `finish()` never executing: the Vercel function is hard-killed past `maxDuration = 300` before it can write the row. Consequences: no per-step visibility on `/connections` for the heaviest cron in the system, and — because the Slack ping and owner bell for a degraded run live *inside* `finish()` (`src/lib/cron.ts`, the `if (!ok)` block) — **no alert has ever fired for it**. The `ordersFullReconcile` step comment (`src/app/api/cron/daily/route.ts:126-129`) describes this exact failure — *"it kept blowing past maxDuration and killing the function BEFORE finish() — so every CronRun died with finishedAt=null and monitoring was blind since inception"* — and says a 150s hard cap (`:133`) fixed it; the data says otherwise. The mechanism is still open: `cronBudget`'s 250s gate is checked only *before* a step starts, so a step that begins at t=249s and races a 150s timer can reach t=399s — 99s past `maxDuration`. By contrast `sync` is 711 ok / 15 failed (7 with null `finishedAt`) and `gmail` is 8,723 ok / 4 failed.
- **Good news buried in the above: the early daily steps *do* run.** The oldest `WebhookEvent` (2026-07-15) and oldest `CronRun` (2026-07-15) sit exactly on the 30-day horizon, so `webhookLogTrimmed` and `cronRunLogTrimmed` — which execute before `ordersFullReconcile` — are completing every day. What cannot be verified is anything ordered after the step that dies, because no `summary` is ever written.

## 2. Jobs, the pipeline and delivery promises

Every shoot RealTour Pilot books is one `Project` row. It carries the address, the client, what
was ordered, who is shooting it, who is editing it, when it is promised, and where it currently
sits between "an agent just booked" and "the content is in their hands". Almost nothing about a
job's stage is typed in by hand — the hub reads Aryeo, Dropbox and the client's own texts and
emails and works the stage out for itself, then writes down its reasoning so anyone can see
*why* it thinks a job is where it is.

---

### The job record itself

`Project` is defined in `prisma/schema.prisma:355`. The fields that matter for the pipeline:

| Field | Meaning |
| --- | --- |
| `status` | `ProjectStatus` enum — the stage (see below) |
| `orderedAt` | the real Aryeo order date. `createdAt` is import time and must never be used as the order date |
| `shootDate` | start of the live scheduled appointment |
| `deliveryDue` | computed job-level promise (see the two-engine problem below) |
| `deliveredAt` | first arrival at DELIVERED; stamped once, never re-stamped |
| `uploadedAt` | first time raws were detected in Dropbox |
| `statusEvidence` | JSON blob of the status engine's reasoning |
| `statusCheckedAt` | when the engine last looked |
| `revisionRequestedAt` / `revisionNote` | set by the comms engine when a client asks for changes after delivery |
| `photoTarget`, `squareFeet` | culling budget inputs |
| `aryeoOrderId` (`@unique`), `aryeoListingId` | the external linkage |
| `source` | `MANUAL` \| `ARYEO` — the status sweep only touches `ARYEO` rows in bulk mode |

Two child tables describe *what was ordered*, and they are deliberately different things:

- **`OrderItem`** (`schema.prisma:745`) — the Aryeo line items kept **verbatim**: real product
  title, quantity, line total in dollars, `isCanceled`. This is the commercial truth and the
  only place the actual product names survive. `amount` comes from `gross_total_amount ??
  amount` (Aryeo sends cents; `orderItemRows()` divides by 100) — the discounted figure, not
  list price. The delivery board dates jobs off these rows, and `deliveryWatch` reads their
  titles — so the model's own comment, "Purely additive — nothing reads it for production", is
  now **stale**.
- **`Deliverable`** (`schema.prisma:497`) — the *production* view: one row per media type we
  have to capture (`PHOTOS`, `VIDEO`, `FLOORPLAN`, `DRONE`, `TWILIGHT`, `MATTERPORT_3D`,
  `VIRTUAL_STAGING`, `SOCIAL_REEL`, `ZILLOW_3D`, `HEADSHOT`, `OTHER`), with its own
  `DeliverableStatus` (`PENDING` / `UPLOADED` / `IN_PROGRESS` / `DONE` / `FLAGGED`),
  `capturedAt` (photographer ticked it on site) and `uploadedAt` (photographer ticked it in
  `/upload`).

Order items are mapped to deliverables in `src/lib/integrations/aryeo.ts` by
`itemToDeliverables()`, which first consults `PRODUCT_DELIVERABLES` — a hand-verified,
authoritative map of 49 real catalogue products built by reading each product's description
(Jun 2026) — and only falls back to keyword parsing (`COMPONENT_RULES`) for products not in the
map. `dedupeParsedDeliverables()` then collapses to one row per type, because "a Zillow add-on
and a package both list 'photos' + 'floor plan'" would otherwise create the same deliverable
two or three times.

Two rules inside the fallback parser are worth knowing, because they only fire on *unmapped*
one-off products: if both `SOCIAL_REEL` and `VIDEO` are detected, the standalone `VIDEO` is
dropped ("drone video included in the social media reel" is the reel, not a second property
video); and if no media keyword matched at all but the title says package / bundle / interior /
exterior, it becomes `PHOTOS` — fees and travel lines fall through to `OTHER`.

`isPremiumProduct()` decides whether a product's reel/video is Premium (→ Luma, longer clock)
purely from the product NAME, with a comment worth preserving: the generic tier bundles —
Silver / Gold / Aerial / Basics / EVERYTHING / STR combos — include a **standard** reel, not a
premium one, and anything explicitly named "Standard …" is never premium. Per Jordan, the
EVERYTHING bundle has no premium reels.

---

### The nine statuses

`ProjectStatus` (`schema.prisma:29`), presented by `src/lib/pipeline.ts` as six flow stages plus
three off-pipeline states.

| Status | `PIPELINE_STAGES` label | Description in code |
| --- | --- | --- |
| `BOOKED` | Booked | "Order received — needs scheduling" |
| `SCHEDULED` | Scheduled | "Shoot date set, photographer assigned" |
| `SHOT` | Shot / Uploaded | "Content captured and uploaded" |
| `EDITING` | In Editing | "Assigned to an editor, in production" |
| `REVIEW` | Review / QC | "Internal quality check before delivery" |
| `DELIVERED` | Delivered | "Sent to client" |

`SIDE_STATES` — shown separately, never as flow columns:

| Status | Label | Description |
| --- | --- | --- |
| `REVISION` | Revisions | "Delivered — client requested changes" |
| `ON_HOLD` | On Hold | "Blocked — waiting on client or info" |
| `CANCELLED` | Cancelled | "Order cancelled" |

`nextStage()` / `prevStage()` walk the six-stage line only and return `null` off-pipeline —
both are exported but have **no callers anywhere in `src/`**, left over from the drag-and-drop
board. `stageMeta()` and `ALL_STAGES` are the live exports (the `StageSelector` dropdown lists
all nine).

### What actually moves a job between statuses

There is no single state machine. Six different writers set `Project.status`:

| Writer | Transition | File |
| --- | --- | --- |
| Aryeo import (`initialStatus`) | new order → `DELIVERED` if `fulfillment_status === "FULFILLED"` or `fulfilled_at` is set, else `SCHEDULED` only if an appointment whose status is literally `SCHEDULED` exists, else `BOOKED` | `src/lib/integrations/aryeo.ts:668` |
| Aryeo order update pass | any → `CANCELLED` when `order_status` starts with "CANCEL" — **but never for a job with `deliveredAt`** (refunds are a human call; that case files a SYSTEM activity + owner bell instead) | `aryeo.ts:907` |
| Evidence engine `syncProjectStatuses` | `BOOKED`/`SCHEDULED`/`SHOT`/`REVIEW`/`DELIVERED`/`REVISION` from real media evidence | `src/lib/projectStatus.ts:467` |
| Photographer field buttons | `BOOKED`/`SCHEDULED` → `SHOT` (`completeShoot`, and `finalizeUpload`) | `src/app/shoot/actions.ts:182`, `src/app/upload/actions.ts:154` (status write at `:230`) |
| Editor / Review Room | `SHOT`/`EDITING` → `REVIEW` on submit-for-review; `REVIEW` → `EDITING` on changes-requested; manual "Add a job to the queue" sets `EDITING` | `src/app/review/actions.ts:231`, `:527`, `src/app/editing/actions.ts:290` |
| Owner / admin dropdown | any → any, via `StageSelector` → `moveProjectStatus` | `src/components/project/StageSelector.tsx`, `src/app/actions.ts:464` |

Notes that matter:

- `computeStatus()` can never *produce* `EDITING`, `ON_HOLD` or `CANCELLED`. `EDITING` is a
  human signal ("an editor is working"), `ON_HOLD` is manual only, `CANCELLED` comes from Aryeo
  or the dropdown.
- `moveProjectStatus` to `DELIVERED` stamps `deliveredAt`, **clears** `revisionRequestedAt` /
  `revisionNote`, closes the open `revision` task, and calls `closeObsoleteTasks`.
- The Review Room deliberately sends a rejected cut back to `EDITING`, not `REVISION`, with the
  comment: "REVISION stays reserved for client-requested post-delivery changes so the comms
  engine's meaning holds."

#### How REVISION is raised and cleared

`REVISION` is the one stage driven by conversation rather than files. `raiseRevision()`
(`src/lib/comms.ts:285`) sets `revisionRequestedAt` + `revisionNote` and flips the stage **only
if the project is currently `DELIVERED`** (a `REVIEW`/`REVISION` job keeps its stage). It is
called from four places:

- inbound texts / calls / emails via `recordClientCommunication` — gated on the project being in
  `DELIVERED_ISH = {DELIVERED, REVISION, REVIEW}`; on an earlier stage the same message is filed
  as a `SPECIAL_REQUEST` activity with no status churn (`comms.ts:101`, `:268`)
- the Gmail poller, even for mail Kyle already answered — audit crack #33: "a client's 'can you
  brighten the kitchen' that Kyle answered 'on it!' from his phone used to skip classification
  entirely" (`src/lib/integrations/google.ts:894`)
- Frame.io review comments (`src/app/api/webhooks/frameio/route.ts:125`)
- `scanProjectCommsForRevision()`, a backfill sweep over the last 12 inbound-text activities,
  run for every delivered Aryeo project at the start of a **full** status sync

The revision is routed to the editor who actually made that deliverable, deciding from the words
in the ask, not just what the job contains — with a specific fix recorded: `\bcut\b` on its own
used to send "cut out the trash can" (a photo retouch) to the video editor, so the regex now
only matches a named cut (`rough/final/first/new cut`, `re-cut`).

`resolveRevision()` (`comms.ts:452`) clears the flag, closes the revision task, returns a
`REVISION` job to `DELIVERED` (re-stamping `deliveredAt`), and calls
`closeObsoleteTasks(projectId, "DELIVERED")` — added because "the task sync skips REVISION jobs
and this function only closed the revision task — every revision left a permanently-overdue QC
in Kyle's list (audit crack #22)."

---

### The evidence-based status engine

**Plain English:** Aryeo marks an order "fulfilled" the moment *anything* is delivered. Send the
photos on Tuesday and the reel on Friday, and Aryeo says the job is done on Tuesday — so jobs
with real work outstanding looked finished. This engine ignores that flag and instead checks,
per ordered item, what is actually live on the listing and what is actually sitting in Dropbox,
and only calls a job delivered when every ordered category is genuinely present.

The header comment in `src/lib/projectStatus.ts:13` states it directly:

> Aryeo flips an order to FULFILLED the moment ANY media is delivered — so when we send photos
> early and the video later, the order looks "done" while work remains. Kyle forgets to
> un-toggle it.

#### The four signals it cross-checks

| Signal | Source | What it tells us |
| --- | --- | --- |
| **EXPECTED** | the project's `Deliverable` rows (mirroring Aryeo order items) | which of `PHOTOS` / `VIDEO` / `FLOORPLAN` / `THREED` are owed |
| **PRESENT** | live Aryeo listing: `images`, `videos`, `floor_plans`, `interactive_content`, `delivery_status`, cover thumbnail | what the client can actually see |
| **IN-FLIGHT** | Dropbox folder counts for `01-RAW-Photos`, `02-RAW-Video`, `04-Final-Photos`, `05-Final-Video` | whether raws are in / finals are cut but not yet released |
| **COMMS** | `Project.revisionRequestedAt` (set by texts, email, calls, Frame.io comments) | the client has asked for changes since delivery |

**Where "fulfilled" actually comes from.** The `StatusSignals.fulfilled` field is documented in
the type as "Aryeo order fulfilled_at present", but `gatherSignals` sets it to `!!p.deliveredAt`
(`projectStatus.ts:432`) — the hub's own column, which was seeded from `order.fulfilled_at` at
import and is re-stamped by this sweep on first arrival at DELIVERED. Inside `computeStatus` it
is then OR'd with the *listing's* `delivery_status === "DELIVERED"`. So "fulfilled" is a mix of
the stored order flag and the live listing flag, not a fresh read of `fulfilled_at`; the type
comment is stale.

`expectedCategories()` trusts the parsed `Deliverable.type` first, then keyword-scans the label
for extras — one line item can imply several categories. `categoriesForLabel()` runs floorplan →
3D → video → photos, photos last and broadest (packages, bundles, bronze/silver/gold/platinum/
diamond, twilight, drone, headshot, virtual staging all count as photos, because they are
delivered as listing images).

Dropbox is only read when Aryeo does *not* already account for everything ordered
(`aryeoSatisfies`) — "Aryeo is the delivery source of truth; Dropbox explains the in-flight
stage when Aryeo is short."

**Unknown is not zero.** `folderCount()` returns `0` only for a genuine `not_found`/`path_lookup`
error; any other failure (auth, rate limit, network, 5xx) returns `null`, and a single `null`
poisons the whole Dropbox signal (`dropboxUnavailable = true`). The comment records why: "treating
it as zero made a one-second Dropbox blip read as 'no media', which demoted shot jobs and
destroyed their QC/delivery tasks (audit crack #2)."

#### The decision ladder (`computeStatus`, `projectStatus.ts:197`)

In order, first match wins:

1. `sig.revisionOpen` → **REVISION**, with the client's own words in the reason.
2. `satisfied && fulfilled` → **DELIVERED** ("All ordered deliverables confirmed live on Aryeo.")
3. `satisfied && !fulfilled` → **REVIEW** ("All media is present but the order isn't marked
   delivered on Aryeo yet — ready to deliver.")
4. Core content out but something missing → **REVIEW**, flagged as a partial. The gate is
   deliberately narrow: `fulfilled || anyFinalDropbox || present.has("PHOTOS") ||
   present.has("VIDEO")`. Floor plans and 3D tours arrive on their own from vendors (CubiCasa
   auto-syncs to Aryeo hours after the scan) and counting those as "delivery started" "jumped
   fresh shoots SCHEDULED → REVIEW before the photographer even uploaded raws, which hid the job
   from the upload portal (3188 Thornapple, Jul 2026)".
5. `anyRaw` → **SHOT** ("Raw files uploaded to Dropbox — awaiting editing.")
6. a `SCHEDULED` appointment, or a future `shootDate` → **SCHEDULED** ("Shoot scheduled.")
7. any non-cancelled appointment or any `shootDate` → **SCHEDULED** ("Appointment on file.")
8. otherwise → **BOOKED** ("No shoot scheduled yet.")

`anyAppt` deliberately excludes `CANCELED` legs — "a job whose only appointments were canceled
must not read as scheduled (audit crack #14)".

`satisfied` = every expected category present. When the order can't be parsed at all
(`expected` empty) it falls back to "Aryeo says fulfilled AND some media exists".
`partial = fulfilled && verifiable && missing.length > 0` — that's the flag that drives the red
"Aryeo marked this order fulfilled, but the cross-check found missing deliverables" banner on the
project page.

A missing **video** is treated gently: it is only called out once photos (or other media) are
already out (`missing.includes("VIDEO") && present.size > 0 && sig.videoTier && sig.shootDate`),
and the reason line reads "Photos delivered. Standard video in production — due Mar 4" (the lead
is "Delivery underway." when photos specifically aren't present) until the window passes, then
flips to "Video overdue — was due Mar 4. Confirm it was delivered to the client, or upload it."
The date itself comes from `deliveryDueFrom` in `tasks.ts` — computeStatus calls the task
engine's window on purpose, "so the status card, delivery-due, and QA task never disagree".

#### The three anti-demotion guards

These are the most load-bearing lines in the file (`projectStatus.ts:533`–`592`).

`shootHappened` = `shootDate < now` **OR** any non-cancelled appointment leg that started in the
past. Both halves are needed: shootDate alone is movable, and "when an already-shot job gets a
return visit or a forward reschedule, the appointment sync points shootDate at the FUTURE leg,
and a guard keyed only on `shootDate < now` silently disarms — re-opening the exact demotion
cascade it was built to stop (audit crack #2 / 2075 Flint Hill)". The `shootDate` test still
matters on its own because manual/unsynced projects have no appointment rows at all.

1. **Total blindness → do nothing.** If Aryeo couldn't be read AND Dropbox is unavailable AND
   the job is in `SHOT`/`EDITING`/`REVIEW`/`REVISION` AND the shoot happened, the engine writes
   only `statusCheckedAt` and skips. Recomputing from nothing "erased 'present' evidence,
   flipped deliverables back to PENDING, and cascaded into destroyed QC tasks".
2. **Human signals win.** `EDITING` is never demoted to `SHOT`/`SCHEDULED`/`BOOKED`; `REVIEW`
   is never demoted to `SHOT` ("an editor's 'send to review' is a human signal the cut exists —
   in the Review Room or Frame.io — that the evidence engine can't see").
3. **A shot job can never un-shoot.** From `SHOT`/`EDITING`/`REVIEW`/`REVISION`, a computed
   `SCHEDULED`/`BOOKED` is discarded when `shootHappened`.

#### What the sweep does besides setting a status

Each pass over a project also:

- writes `statusEvidence` JSON + `statusCheckedAt`
- recomputes and writes `deliveryDue` = `standardDeliveryDue(shootDate, deliverables, monthly)`
- stamps `deliveredAt` on first arrival at DELIVERED, and `uploadedAt` the first time raws are
  detected — the latter was missing, so "`/upload` kept showing 'Upload' CTAs on jobs whose raws
  were fully in, and photographers got no confirmation their drop registered"
- refreshes `coverImageUrl` from the first live Aryeo gallery image (the My Shoots card swaps
  its Street View for the real cover once photos land)
- calls `syncDeliverableStatuses()` — flips each `Deliverable` to `DONE`/`PENDING` based on
  whether its category is present
- **cull check** (SHOT/EDITING only, and only when the Dropbox raw count is actually known):
  if raw photos > `photoTarget × 5.5`, stamps `evidence.cull` and calls `mintCullTask` — one
  task per project *ever* (`dedupeKey: cull-<projectId>`) plus an SMS to the photographer,
  because "they've left the property, so the bell alone won't reach them". Budget from
  `src/lib/culling.ts`: owner override wins, else 80 for homes ≥ 3500 sq ft, else 50;
  `BRACKET_RATIO = 5`, `RAW_OVERAGE_FACTOR = 5.5` — 5.5 not 5.0 because it "leaves the same
  ~10% slack over the pure bracket ratio the old 3.3-on-3 had". (The `Project.photoTarget`
  schema comment still says "~3.3×" — stale.)
- `chaseVendorsForMissing()` on SHOT/EDITING/REVIEW with anything missing (audit crack #16 —
  a CubiCasa floor plan or AutoHDR edit still missing days after the shoot means the vendor
  handoff dropped)
- `ensureEditorHandoff()` on SHOT/EDITING/REVIEW — **stage-independent on purpose**. The old
  wiring fired only inside `statusChanged && final === "SHOT"`, which had two proven-live holes:
  a job whose photos deliver fast jumps SCHEDULED→REVIEW without ever landing on SHOT (4 of 5
  video-owing REVIEW jobs had no editor task, no notification, no Luma dispatch), and the
  photographer "done" buttons set SHOT directly so the sweep saw no transition
- `reconcileRawsMissing()` on BOOKED/SCHEDULED/**SHOT** when the shoot happened and the raw
  folders are *known* empty — "877 S York sat 11 days with nobody told". SHOT is included
  deliberately: "marking it shot is a claim about the camera, not about Dropbox". Inside, it
  waits `RAWS_MISSING_AFTER_MS = 18 * HOUR` past the latest past appointment leg ("give them
  the evening"), fires once per project (`raws-missing-<id>`), and auto-**closes** its own task
  the moment raws land, Aryeo already has media, or Dropbox becomes unreadable
- on a real status change: activity line, `closeObsoleteTasks` for DELIVERED/CANCELLED, and a
  one-time "Delivered" bell to ops + the photographer

#### When it runs

| Trigger | Scope | File |
| --- | --- | --- |
| Hourly Vercel cron `0 * * * *` | active set, `take: 80`, concurrency 5 | `src/app/api/cron/sync/route.ts:33` |
| Aryeo webhook (ORDER / LISTING / APPOINTMENT) | one project | `src/app/api/webhooks/aryeo/route.ts:149` |
| "Recheck status" button on the project page | one project | `src/app/actions.ts:755` |
| "Refresh from Aryeo" button | one project | `src/app/projects/refreshActions.ts:70` |
| Photographer marks shoot complete / finalizes upload | one project | `shoot/actions.ts:213`, `upload/actions.ts:262` (first finalize only) |
| Connections page "Recheck statuses" | all active | `src/app/connections/actions.ts:206` |
| Connections page "Sync Aryeo now" | all active (after the order/appointment/customer sync) | `src/app/connections/actions.ts:50` |

The default `where` covers `BOOKED, SCHEDULED, SHOT, EDITING, REVIEW, REVISION` on `source:
"ARYEO"`; `{ full: true }` covers every non-`ON_HOLD`/`CANCELLED` Aryeo project and additionally
pre-scans delivered jobs' comms for missed revisions. Cron routes fail **closed**: a missing
`CRON_SECRET` in prod/Vercel returns 401 rather than running open.

#### Reading the evidence on the client

`src/lib/statusEvidence.ts` is the client-safe reader (no `server-only` import).
`parseEvidence()` tolerates any shape and returns nulls/empties rather than throwing.
`statusFlag()` turns the blob into one short chip, with the important nuance that a "missing"
flag is only shown when it means something: `meaningful = e.partial || status === "REVIEW" ||
status === "DELIVERED"`, because "Booked/Scheduled jobs haven't been shot yet — 'missing photos'
there is just noise". A video still inside its window gets a calm `pending` chip
("Video due Mar 4"), not an alarm.

`src/components/project/StatusEvidenceCard.tsx` renders the whole thing on the project page:
reason line, partial warning, per-category present/missing chips, the revision banner with
`RevisionResolveButton`, a `RecheckStatusButton`, and deep links into the four Dropbox folders.

---

### The delivery promises — `src/lib/turnaround.ts`, verbatim

**Plain English:** this file is Jordan's turnaround promises written down once, so the board, the
tasks and the status card can't disagree about when something is late.

The header comment, quoted from him directly:

> "We always need to deliver the next day unless it was a premium reel. Premium Reels are due in
> 3-4 days. Monthly Social Content like Video Starter, Video Accelerator, and Video Pro are
> always due within 7-10 BUSINESS days. Standard Videos within 48hrs. Photos, floor plans,
> Zillow Showcase 3D Tour, virtual staging, all due the next day."

And the consequence, in the file's own words:

> The important consequence: a DUE DATE BELONGS TO A DELIVERABLE, NOT A JOB. A shoot with photos
> and a premium reel owes the photos tomorrow and the reel in four days. Rolling that up to one
> project date would either make the whole job look late the day after the shoot, or hide the
> photos being overdue behind the reel's longer clock. So every ordered item is dated on its own,
> and the job shows the EARLIEST thing still outstanding.
>
> The clock starts at the shoot, because that's when we take possession of the work. Monthly
> social content often has no shoot of its own, so it falls back to the order date.

#### The tiers

```ts
export const TIERS: Record<TierKey, Tier> = {
  // Sold as a rush add-on ("Same Day Photo Delivery"). Not in the rules Jordan
  // dictated, but it's on real orders, and defaulting it to next day would give
  // away the extra day the client paid for.
  same_day: { key: "same_day", label: "Same day", targetDays: 0, dueDays: 0, businessDays: false },
  next_day: { key: "next_day", label: "Next day", targetDays: 1, dueDays: 1, businessDays: false },
  video_48h: { key: "video_48h", label: "48 hours", targetDays: 2, dueDays: 2, businessDays: false },
  // "3-4 days" — we aim at 3 and are late after 4.
  premium_reel: { key: "premium_reel", label: "3–4 days", targetDays: 3, dueDays: 4, businessDays: false },
  // "7-10 business days" — aim at 7, late after 10.
  monthly_social: { key: "monthly_social", label: "7–10 business days", targetDays: 7, dueDays: 10, businessDays: true },
};
```

`targetDays` is what we aim for; `dueDays` is the promise — late means past *that*. Only
`monthly_social` counts business days; everything else is calendar days.

#### The rules, in order — and why order is the whole trick

```ts
// Order matters: the first pattern that matches wins, so the specific named
// packages are tested before the generic word "video" can swallow them.
const RULES: { re: RegExp; tier: TierKey }[] = [
  // Rush add-ons win outright — the words "same day" are the promise.
  { re: /\bsame[-\s]?day\b/i, tier: "same_day" },

  // Monthly social retainers. Named packages first — "Video Pro" contains
  // "video", and must not be read as a standard 48-hour video.
  { re: /\bvideo\s*(starter|accelerator|pro)\b/i, tier: "monthly_social" },
  { re: /\b(monthly|social)\s+(content|package|plan)\b/i, tier: "monthly_social" },
  { re: /\bmonthly\b.*\breel/i, tier: "monthly_social" },

  // Premium reels.
  { re: /\bpremium\b.*\breel\b/i, tier: "premium_reel" },
  { re: /\breel\b.*\bpremium\b/i, tier: "premium_reel" },

  // These sit ABOVE the generic video rule on purpose. "Drone Photo and Video"
  // and "Video Staging" both contain the word video, but they're add-ons that
  // ship alongside the stills, not standard videos — and the whole default is
  // "next day unless it's a premium reel", so the shorter clock is the safer
  // reading of an ambiguous name.
  { re: /\bstag(ing|e)\b/i, tier: "next_day" },
  { re: /\b(drone|aerial|twilight|headshot|lot lines?)\b/i, tier: "next_day" },
  { re: /\b(floor\s*plan|floorplan|cubicasa)\b/i, tier: "next_day" },
  { re: /\b(zillow|showcase|3d tour|matterport)\b/i, tier: "next_day" },

  // Everything shot and cut as a standard video.
  { re: /\b(video|reel|walkthrough|tour video|listing video|agent intro)\b/i, tier: "video_48h" },

  // Next-day stills.
  { re: /\b(photo|photos|photography|image|hdr)\b/i, tier: "next_day" },
];
```

`tierFor(productTitle)` returns the first match; an unrecognised product falls through to
`TIERS.next_day` — "We always need to deliver the next day unless it was a premium reel."

**The rule-order gotcha, with real catalogue names.** Because `tierFor` takes the whole line-item
title and returns exactly one tier, the drone/floorplan/3D rules sitting above the generic video
rule mean any bundle whose *name* mentions drone or aerial is dated at next-day even when the
bundle contains a video:

| Real product title (from `PRODUCT_DELIVERABLES_RAW`) | Rule that fires | Tier |
| --- | --- | --- |
| `Deluxe Land Only Package - Drone Photo and Video` | drone | Next day (documented intent) |
| `AERIAL BUNDLE - Highlight Your Listing's Best Features` | aerial | Next day — even though it includes VIDEO |
| `GOLD BUNDLE - Photography, Video, Drone, 2D Floor Plan, & More!` | drone | Next day — includes VIDEO + SOCIAL_REEL |
| `Photography and Standard Reel` | generic video | 48 hours — the photos' next-day promise disappears into the reel's clock |
| `Premium Social Media Reel` | premium+reel | 3–4 days |
| `Premium Cinematic Video` | generic video (no "reel") | 48 hours |
| `SOCIAL MEDIA INFLUENCER - Dominate Social Media, Build Your Brand.` | none | Next day (default) |
| `Video Starter - 2HR Session` | named plan | 7–10 business days |
| `Zillow Showcase 3D Tour Add-on` | zillow | Next day |
| `Detail Shots` | none | Next day (default) |

#### Business days and where the promise lands

```ts
/** Weekends don't count for the monthly-social clock. Holidays are not modelled. */
function addBusinessDays(from: Date, days: number): Date { … }
```

The weekday test derives the ET calendar day first
(`new Date(`${etDayKey(d)}T12:00:00Z`).getUTCDay()`), so a late-evening ET shoot isn't counted on
the wrong day.

`dueAtFor(tier, startedAt)` lands the due instant at **5pm Eastern** on the due day, via
`etAt(etDayKey(end), 17)` — "a 'next day' promise means end of that day, not the same minute of
the morning after". `etAt` in `src/lib/datetime.ts:62` is DST-safe by construction; the file
explains why you must never hard-code an offset (`T17:00:00-04:00` is 5pm ET for eight months
and 4pm for the other four).

---

### The other turnaround engine, and where the two disagree

`src/lib/tasks.ts` carries an **older, independent** turnaround implementation that the status
engine, the task engine, `Project.deliveryDue` and every on-time KPI all use. It works on
`DeliverableType`, in hours, from the shoot date:

```ts
const TURNAROUND_HOURS: Record<string, number> = {
  PHOTOS: 20, DRONE: 20, FLOORPLAN: 36, MATTERPORT_3D: 36, ZILLOW_3D: 36,
  TWILIGHT: 20, VIRTUAL_STAGING: 48, SOCIAL_REEL: 48, VIDEO: 48,
  HEADSHOT: 24, OTHER: 48,
};
const PREMIUM_HOURS = 72;
const STANDARD_REEL_HOURS = 48;
```

`deliveryDueFrom(anchor, type, { premium, monthlyContent })` — for `VIDEO`/`SOCIAL_REEL`:
premium 72h, else monthly `addBusinessDays(anchor, 10)`, else 48h. **Precedence is documented:
premium beats monthly** — "A premium LISTING reel is a one-off premium deliverable, NOT recurring
monthly content — so it keeps the 3-day premium SLA even when the client is on a social plan."

`standardDeliveryDue()` takes the **LONGEST** turnaround among the ordered deliverables. That's
what gets written to `Project.deliveryDue`, shown as "Delivery due" on the project page, sorted
on in `/editing`, and used by `getStuckJobs()` (`src/lib/queries.ts:477`), `getOwnerPulse()`
on-time %, and the photographer bonus calculation (`src/lib/bonus.ts:144`).

`isPremiumLabel` / `PREMIUM_VIDEO_RE` = `/premium|influencer|cinematic|luxury|signature|elite|
flagship/i`, and `tasks.ts:74` carries the note that these two constants MUST stay in sync:
"they previously diverged: this was `/premium/` only, so an Influencer/Cinematic reel got a 48h
SLA here but showed 72h on the status card — a 24h disagreement."

The two engines are **not** reconciled with each other:

| Product | `turnaround.ts` (delivery board) | `tasks.ts` (deliveryDue / tasks / status card) |
| --- | --- | --- |
| Photos | next day, 5pm ET | 20h from the shoot |
| Floor plan / Zillow 3D | next day, 5pm ET | 36h |
| Virtual staging | next day, 5pm ET | 48h |
| Premium reel | +4 days | +72h (3 days) |
| `SOCIAL MEDIA INFLUENCER` package | next day (no rule matches) | 72h (label is "Premium Social Reel") |
| Monthly social | +10 business days at 5pm ET | +10 business days, weekday computed in **UTC**, keeps the shoot's time of day |
| Roll-up | earliest outstanding item | longest of all items |

#### Is this job "monthly content"?

`isMonthlyContentJob()` in `src/lib/pipeline.ts:215` is the project-level test, and its comment
is one of the most valuable in the codebase:

> `Client.socialClient` is a CLIENT attribute — using it alone branded every listing shoot those
> agents booked as "monthly content" (wrong QC copy, wrong SLA, wrong editor routing — caught
> live on 523 S Coventry / 238 Hudson / 419 Riverview, July 2026). Jordan's definitive rule:
> monthly content is one of the three PLANS — Video Starter, Video Accelerator, or Video Pro.

`MONTHLY_PLAN_RE = /video\s*[-–]?\s*(starter|accelerator|pro)\b|monthly\s*content|personal[-\s]*brand/i`
— the `\b` after `pro` exists so "Video Production" doesn't match.

`src/lib/packageNames.ts` is the companion: Aryeo order-item titles are typed by hand per order,
so `canonicalPackage()` collapses "Video Accelerator - 4HR Session", "4hr session", "4h session",
"4 Hour Content Session", "Content Day 4hrs" onto one name — "left alone they split one line into
six rows that each look like a rounding error instead of the retainer business they actually
are." Canonicalising is display-and-grouping only; the stored `OrderItem` is never rewritten.
Note the rules only actually match three patterns — `/accelerator/i`, `/video\s*pro\b|\bpro\b.*8\s*h/i`
and `/video\s*starter|starter.*\b2\s*h/i` — so the bare spellings the comment names ("4hr
session", "4 Hour Content Session", "Content Day 4hrs") pass through **unchanged**; only titles
that still carry the plan word collapse.
`isRetainerSession()` flags the three retainer products whose Aryeo line is **$0 by design** —
the revenue is a recurring QuickBooks invoice — so money engines must treat them as a separate
rail rather than a free job.

---

### `/pipeline` — the delivery board (Kyle's screen)

**Plain English:** one screen that answers three questions and nothing else — what's due today,
what's holding it up, and what's coming.

`src/app/pipeline/page.tsx` (39 lines) renders `deliveryBoard()` into `DeliveryBoardView`. The
page comment records the rebuild: "The old page was a sortable spreadsheet of every job in the
last fortnight. It could answer any question if you knew which column to read — which is the same
as answering none of them at a glance." The header reads `N in production · N due today · N past
due`.

`src/lib/deliveryBoard.ts` is **one query for the whole board** — "this screen is open all day and
must not fan out." It pulls up to 400 non-cancelled projects that are either undelivered or
delivered within the last 10 days, selecting `orderItems` (non-cancelled), `deliverables`, and
the first appointment's assignee.

Per job it computes:

- `items` — every order item priced against `tierFor(title)` and dated with `dueAtFor(tier,
  shootDate ?? now)`
- `dueAt` / `dueTierLabel` / `dueFor` — the **earliest** outstanding item, and *what product* that
  date is for
- `overdue` — that date is in the past
- `photos` / `video` — `none` / `some` / `in` / `n/a`, from `Deliverable.uploadedAt` over
  `PHOTOISH = {PHOTOS, DRONE, TWILIGHT}` and `VIDEOISH = {VIDEO, SOCIAL_REEL}`

#### Blocker logic

`blockerFor()` returns exactly one answer, most-blocking first, "in the words Kyle would use" —
"A card listing six half-true states is what makes a board unreadable."

| Order | Condition | `BlockerKind` | Label |
| --- | --- | --- | --- |
| 1 | `deliveredAt` set | `delivered` | Delivered |
| 2 | status `ON_HOLD` | `on_hold` | On hold |
| 3 | status `REVISION` | `revision` | Client asked for changes |
| 4 | no `shootDate`, or it's in the future | `not_shot` | "Not shot yet" / "No shoot date" |
| 5 | any deliverable without `uploadedAt` | `awaiting_upload` | "Waiting on video / the floor plan / the 3D tour / virtual staging / photos / files" |
| 6 | status `REVIEW` | `qc` | Needs QC |
| 7 | at least one deliverable, and every one `DONE` | `ready` | Ready to deliver |
| 8 | fallthrough | `editing` | With the editor |

The missing-thing name is picked in a fixed priority: video → floor plan → 3D tour → virtual
staging → photos → "files". "Waiting on video" is Jordan's own example.

#### Tabs

| Tab | Contents |
| --- | --- |
| Due today | live jobs whose `dueAt` ET day ≤ today — **overdue rides here, at the top** |
| Due tomorrow | `dueAt` ET day == tomorrow |
| Upcoming | everything else, **including every job with no `dueAt` at all** |
| Delivered | delivered in the last 10 days, newest first |

"Overdue rides in Today. A day late is more urgent than due-at-5pm, and a separate Overdue tab is
a tab nobody opens until it's already too late." `DeliveryBoardView` puts a red count banner above
the tabs, each tab carries its own count, and each card expands to show every ordered product with
its individual tier label and date.

---

### `/editing` — the older tracker, still live

The original spreadsheet tracker was not deleted; it was repurposed. `src/app/editing/page.tsx`
builds `buildTrackerRows(projects)` from `src/lib/tracker.ts` and filters to `kind === "video"`,
because "the Editor dashboard is VIDEO-ONLY — photos are edited by AI, so editors only touch
video/reel jobs."

`TrackerRow` flattens a project into a spreadsheet line: street, client, status, priority,
shoot/due/delivered ISO dates, `kind` (`video` / `photo` / `other`), `videoTier`
(`Premium` / `Standard`, from `/premium/i` on the video deliverable's label), a `details` string
via `refinedDeliverableLabel()`, photographer + editor with avatar colours, and three Dropbox
deep links (raw / final / listing root, video jobs pointing at the video folders).

`src/components/tracker/ProjectTracker.tsx` renders it with status tabs, search and sort. It
also has type boards (All / Video / Photo), but `/editing` — its **only** caller — passes
`showBoards={false}`, so that control never renders in the live app. Its `STATUS_GROUP` map is a
*different* grouping from the pipeline stages: `BOOKED`/`SCHEDULED`/`SHOT`/`ON_HOLD` →
"Undelivered", `EDITING`/`REVISION` → "In editing", `REVIEW` → "Review / QC", `DELIVERED` →
"Delivered", `CANCELLED` → `"other"` (no tab, so hidden). The Undelivered tab groups by shoot
date ascending "so it reads like a shoot schedule"; Delivered groups by delivery date
descending; undated rows sort last. The page's own query is not recency-windowed — it takes
`SHOT`/`EDITING`/`REVIEW`/`REVISION` plus `DELIVERED` within **60 days**, ordered by
`deliveryDue` ascending.

Above it sit `AddToQueue` (the manual override for jobs the automatic handoff never picks up) and
`VideoSlaPanel`, which calls `getVideoSlaStatus()` from `projectStatus.ts:83` — the single place
that answers "is this video job's SLA blown, and by how much?", so "the /editing countdown, the
/edit header line, and any later dashboard read all agree by calling this instead of recomputing
the window."

Editors with a login are never shown this page: an `EDITOR` role gets `EditorDay` scoped to their
`editorKey`, and an `EDITOR` with neither an editor key nor a name **fails closed** with a nudge
rather than falling through to the owner view.

---

### The project page

`src/app/projects/[id]/page.tsx` is owner/admin only — the route isn't a top-level nav key so the
middleware doesn't gate it, and the page guards itself: photographers are redirected to
`/shoot/[id]`, every other non-admin role to `/`. Layout is "the work, in workflow order: status →
tasks → order → logistics → output → money → collaboration":

`StatusEvidenceCard` → open `SmartTask`s → reel script (Script Studio) → ordered deliverables
(each with a `DeliverableStatusSelect`) → appointments → map → drone advisory → live Aryeo media →
uploads & editor brief → billing → team messages → checklist → activity. The side rail carries
special requests, Order & schedule (package, order total, sq ft, `PhotoTargetControl`, shoot,
**Delivery due** = `Project.deliveryDue`, delivered), and the assignment panel.

Header controls: `RefreshFromAryeo`, "Open in Aryeo" (`https://app.aryeo.com/orders/<id>`), and
the `StageSelector` dropdown listing all nine stages. The back link goes to `/pipeline`
("Back to tracker").

---

### Supporting helpers

**`src/lib/recency.ts`** — the "recent + moving forward" view window, `RECENT_DAYS = 14`. The hub
was back-filled with a year of historical orders, so day-to-day views show only the last two weeks
plus anything in the future, **based on real dates** (`orderedAt`, `shootDate`, `deliveredAt`,
`revisionRequestedAt`) and never `createdAt`, which is import time. Critically, the window only
ages out finished work: any project in `ACTIVE_STATUSES` (`BOOKED, SCHEDULED, SHOT, EDITING,
REVIEW, REVISION`) is always shown regardless of age, because "a stalled job's dates never move,
so the old date-only window made an undelivered job vanish from every screen at exactly 14 days,
precisely when it most needed eyes (audit crack #9)." Live consumers: the dashboard/queue queries
in `src/lib/queries.ts` (four `recentProjectWhere()` call sites plus `isProjectRecent`),
`components/tasks/TodayView.tsx`, `components/tasks/BoardView.tsx`, and `src/lib/clientTexts.ts`.
(It is also used by the dead `getPipelineProjects`, whose doc comment still says "last-30-day
window" though `RECENT_DAYS` is 14.)

**`src/lib/matchProject.ts`** — best-effort "which job is this message about". Scans up to 600
non-cancelled projects and scores: street number + first street word present in the text = 3
("320 tarbert" is a strong signal), full street ≥ 7 chars = 3, full client name > 4 chars = 2,
client last name ≥ 4 chars as a word = 1. Requires `bestScore >= 2` to return anything; most
recent wins ties. Note the ordering is `createdAt: "desc"` — **import** order, the one date the
rest of the codebase explicitly refuses to treat as recency (`recency.ts`, `orderedAt`), so on
back-filled history "most recent wins ties" means "imported last", not "booked last".

**`src/lib/delivery.ts`** — the client-facing texts, written in Jordan's voice (no em dashes, no
emojis). `deliveryMessage()` reads the status evidence and adapts: if something is still missing
it says "we just delivered the *photos* … and the *video* is still in production" using the real
present/missing lists. `confirmationMessage()` is the day-before text — "we dropped confirmation
calls — no one answers" — confirming date/time and what was ordered, and asking for notes.

**`src/lib/dropboxFolders.ts`** — the folder convention the whole evidence engine depends on,
mirroring the Zapier "AutoHDR" Zap:
`/AutoHDR/{Year}/{Quarter}/{Month}/{Street} ({Client})/{01-RAW-Photos|02-RAW-Video|04-Final-Photos|05-Final-Video}`.
Year/month are computed **in Eastern time**, because "the Zap names folders by the shoot's local
(ET) date; `getFullYear()`/`getMonth()` run in SERVER time — UTC on Vercel — so an ET evening shoot
near a month/quarter boundary computed a DIFFERENT folder than the one the files actually live in,
and every count read zero."

**`src/lib/deliveryWatch.ts`** — the "photos still not out" watchdog wired into the hourly cron
(the `photosUndelivered` step, run straight after `statuses` so the evidence it reads is fresh).
Shot ≥ 26 hours ago (`PHOTOS_LATE_AFTER_MS`), status `SHOT`/`EDITING`/`REVIEW` (`REVISION` and
`ON_HOLD` excluded on purpose), has an Aryeo listing, within a `LOOKBACK_DAYS = 6` window, `take: 60`,
and only fires between **16:00 and 19:00 ET** so the miss is caught while there's still a business
day to fix it. Per candidate it additionally requires: parsed evidence with a non-null `aryeo`
block, `statusCheckedAt` within the last 6 hours, photos among `expected`, and the listing-level
`delivery_status !== "DELIVERED"` — "media merely EXISTING on the listing is not the same as the
client having it". One alert per job **ever** (the `photos-undelivered-<id>-0` notification row is
the ledger); the SMS goes to `TeamMember` rows flagged `opsAlerts`, deliberately not role-derived
because "Kyle is MANAGER and so is Kim (an editor in Manila), while Jordan is PHOTOGRAPHER because
he shoots". Three rules stated in the file: unknown is not late; never touch history;
monthly-social sessions are not listings.

---

### Gotchas / known state

- **Two turnaround engines that disagree.** `turnaround.ts` (delivery board only) and
  `tasks.ts`'s `deliveryDueFrom` (everything else) are independent implementations with different
  units, different inputs and different answers — see the comparison table above. A premium reel
  is "late after 4 days" on `/pipeline` and "due at 72h" in `Project.deliveryDue`. Nothing
  reconciles them, and neither imports the other.
- **Two opposite roll-ups of the same job.** `/pipeline` shows the **earliest** outstanding item;
  `Project.deliveryDue` — the field every on-time KPI, `getStuckJobs`, the owner pulse and the
  photographer bonus read — is the **longest**. A job can be "past due" on Kyle's board and
  perfectly on time in the owner's on-time percentage, simultaneously.
- **The delivery board's blocker runs off a manual tick, not evidence.** `blockerFor` uses
  `Deliverable.uploadedAt`, which is written **only** by `markDeliverableUploaded` when a
  photographer ticks the `/upload` checklist (`src/app/upload/actions.ts:63`). Nothing else in
  the repo sets that column: the evidence engine writes `Deliverable.status` (DONE/PENDING), and
  even `uploadFiles` only bumps `status` to `UPLOADED`. So a job whose photos are live on Aryeo
  still reads "Waiting on photos" if nobody ticked the box — and because rule 5 fires before
  rules 6–8, such a job can never show "Needs QC" or "Ready to deliver".
- **Jobs with no `OrderItem` rows never get a due date.** `deliveryBoard` dates jobs off
  `orderItems`; if there are none, `dueAt` is null and the job lands in **Upcoming** forever,
  invisible to Due today / Due tomorrow. Manual (non-Aryeo) projects and any Aryeo order imported
  before the `OrderItem` table existed and never back-filled are in this bucket.
- **Booked-but-unscheduled jobs float in "Due tomorrow" permanently.** `startedAt = p.shootDate ??
  now`, so a job with no shoot date is re-dated from *today* on every page load: with a next-day
  item (the default tier) it shows "due tomorrow", never becomes overdue, and never leaves the
  tab. Its blocker correctly says "No shoot date", but the date beside it is meaningless.
- **`ON_HOLD` jobs still get due dates and still appear in Due today/tomorrow.** The board query
  only excludes `CANCELLED`.
- **The Aryeo update pass never re-derives deliverables or order items.** For an already-imported
  project, `syncAryeoOrders` writes only price, `payableInvoice`, payment status, balance,
  invoice/payment URLs, client re-link and cancellation (`aryeo.ts:943`). Add a product to an
  existing Aryeo order and the hub's `Deliverable` and `OrderItem` rows stay stale — which means
  the delivery board's dates and the status engine's "expected" set stay stale too. The
  re-derivation functions (`backfillOrderItems`, `reclassifyAryeoDeliverables`) are manual
  one-shots with no caller in the app; only `relabelPremiumDeliverables` has a route, at
  `/api/cron/relabel-deliverables`, explicitly marked "NOT scheduled".
- **"Refresh from Aryeo" over-promises.** Its header comment says step 1 pulls "line items", and
  it reports a `±N order items` delta from `_count.deliverables` — but for an existing project the
  order sync it calls doesn't touch deliverables, so that delta is effectively always 0.
- **`src/components/PipelineBoard.tsx` and `src/components/ProjectCard.tsx` are dead code.** The
  original drag-and-drop stage board and its card are still in the repo, still compile, and are
  imported by nothing (`ProjectCard` only by `PipelineBoard`; `PipelineBoard` by nothing).
  `getPipelineProjects()` in `src/lib/queries.ts:16` survives solely so the `PipelineProject` type
  export still resolves. `statusFlag()` from `statusEvidence.ts` has exactly one consumer —
  `ProjectCard` — so **the status flag chips are not rendered anywhere in the live app**.
- **`syncDropboxFolderStatus()` is a legacy, contradictory sweep.** Still exported from
  `dropboxFolders.ts` and reachable from the Connections page (`connections/actions.ts:190`), it
  advances `SHOT`/`EDITING` → REVIEW on "final files exist" and `BOOKED`/`SCHEDULED` → SHOT on
  "raw files exist" (also stamping `uploadedAt`), and it treats a failed Dropbox read as **zero**
  — the exact behaviour the evidence engine was rewritten to stop. Its own comment concedes:
  "legacy manual sweep: unknown reads as 0". Nothing schedules it, and its transitions duplicate
  (and can race) the evidence engine's.
- **Holidays are not modelled** in either business-day implementation, and the two compute the
  weekday differently: `turnaround.ts` derives the ET calendar day first, `tasks.ts`
  `addBusinessDays` calls `d.getUTCDay()` directly — so an ET evening shoot (Friday 8pm ET =
  Saturday UTC) counts weekend days differently in the two engines.
- **`same_day` is unverified against the catalogue.** `TIERS.same_day` exists and the comment
  claims "it's on real orders", but no product in the authoritative `PRODUCT_DELIVERABLES_RAW` map
  contains "same day"; the tier can only be reached by an unmapped one-off line item.
- **`videoTier()` and `tierFor()` classify premium differently.** `projectStatus.ts`'s
  `PREMIUM_VIDEO_RE` matches `premium|influencer|cinematic|luxury|signature|elite|flagship` on the
  deliverable label; `turnaround.ts` requires the words "premium" **and** "reel" together on the
  order-item title. `Premium Cinematic Video` is premium to one and a 48-hour standard video to
  the other.
- **Deliverable status is round-tripped by the sweep.** `syncDeliverableStatuses` sets every
  deliverable to `DONE` or `PENDING` on every pass, so a manual `IN_PROGRESS` or `FLAGGED` set via
  `DeliverableStatusSelect` on the project page is overwritten on the next hourly run.
- **`prisma/dev.db` is stale.** The datasource is `postgresql` (Neon); the leftover SQLite file
  (last written Jun 17) holds only 11 tables — `Project`, `Deliverable`, `Client`, `Activity`,
  `ChecklistItem`, `TeamMember`, `UploadedFile`, `Connection`, `Resource`, `Sop`, `WebhookEvent`
  — with no `OrderItem`, `Appointment` or `SmartTask` at all. `AGENTS.md` still describes the
  stack as "SQLite at `prisma/dev.db`".
- **`canonicalPackage()` under-delivers on its own comment.** Its three regexes need the plan
  word ("accelerator", "video pro", "video starter"); the shorthand spellings the comment lists
  as the reason it exists — "4hr session", "Content Day 4hrs" — do not match and stay split.

## 3. The task engine

Every piece of work the business owes somebody — confirm tomorrow's shoot, QC a gallery, reply to
a client text, cut a reel, chase CubiCasa — exists as one row in a single table called `SmartTask`.
Nothing in the hub keeps a private to-do list: the pipeline, the phone, the inbox, Slack, the
Review Room and the photographer's app all mint rows into the same table, and the Tasks page is a
view over it. The engine's whole job is to make sure work appears **once** (never twice), lands on
the **right person**, and **disappears on its own** the moment the real-world evidence says it's done
— because the one thing that kills an ops queue is a list full of things that are already finished.

Technically: `SmartTask` (`prisma/schema.prisma:641-688`) plus three layers around it —
generators (many), one hourly reconciler (`src/lib/tasks.ts`), and a family of auto-close rules
scattered across the integrations that own each signal.

---

### The row

| Field | Meaning |
| --- | --- |
| `taskType` | Free string. The type decides which queries surface it, which card renders, and which auto-close rules apply. See the table below. |
| `status` | `OPEN` · `IN_PROGRESS` · `WAITING_CLIENT` · `WAITING_PHOTOGRAPHER` · `WAITING_EDITOR` · `WAITING_VENDOR` · `WAITING_JORDAN` · `BLOCKED` · `COMPLETED` · `CANCELLED`. Validated against `TASK_STATUSES` in `src/app/actions.ts:120` before any write ("never write a free-form status"). |
| `priority` | `URGENT` / `HIGH` / `MEDIUM` / `LOW`, from `computePriority()` or set by the Smart Brain. |
| `title` / `summary` / `description` | Title = the imperative. `summary` = "what happened / what's needed" (the card's expanded body). `description` = the **raw message** or the pre-drafted text to send. The split exists because rendering both used to double the same paragraph on the card (`src/lib/tasks.ts:423-432`). |
| `checklist` | JSON. Historically `string[]`, now `{label,done}[]`; `parseChecklist` in `src/lib/checklist.ts` reads both (legacy strings become unchecked items). |
| `source` / `sourceDetail` | Origin channel + provenance ref (`gmail-thread:<mailbox>:<threadId>`, `phone:(610) 555-1234`, `channel C123 · 1718…`). `sourceDetail` is what the email-reply and lead auto-closes key off. |
| `assignedKey` | First-name slug (`kyle`, `jordan`, `harrison`) or an editor/vendor key (`kim`, `remar`, `luma`, `autohdr`, `cubicasa`). **Null means Kyle by default** on the board. |
| `assignedManually` | A human picked the assignee. See the invariant section. |
| `dedupeKey` | Unique (nullable). The idempotency handle. |
| `contactName` | The real human who wrote in when it differs from the account client (assistant → agent). `differentName()` returns null when they match, so the card doesn't print a redundant name (`src/lib/tasks.ts:127-132`). |
| `deliverableType` | Legacy. Only the retired per-deliverable QC tasks ever set it; the reconciler now cancels any `media_qa` that has one (`src/lib/tasks.ts:1633-1636`). |

Indexes: `status`, `projectId`, `clientId`, `dueAt`, `completedAt`.

---

### Every task type, who creates it, who closes it

| taskType | Created by | Closed by |
| --- | --- | --- |
| `confirmation_text` | Reconciler spec for `BOOKED`/`SCHEDULED` jobs whose shoot is still ahead (`tasks.ts:257-278`) | `sendConfirmationText()` (actions.ts:638), the send-all batch, all steps ticked, or **CANCELLED** by the reconciler once the spec stops emitting |
| `media_qa` | Reconciler spec for `SHOT`/`EDITING`/`REVIEW`/`REVISION` (`tasks.ts:283-356`); `reflectRevisionInQc()` re-creates one post-delivery; Frame.io webhook mints a separate `frameio-review-<id>` one | Every checklist item done (reconciler or human tick); `closeObsoleteTasks(DELIVERED)`; "no longer expected" sweep |
| `client_reply` | `createCommTask()` from any inbound client text / missed call / voicemail / email (`tasks.ts:374`) | Outbound text or answered call (`closeReplyForOutbound` / `closeReplyForOutboundCall`), `sendReplyForTask`, `sendEmailReply`, the OpenPhone thread sweep, the Gmail thread sweep |
| `comms_followup` | `createProjectFollowupTask()` (a teammate texted about a named job); `chaseVendorsForMissing()`; the Luma raws-dispatch task | `closeObsoleteTasks(DELIVERED)` (it's in `DELIVERED_CLOSE_TYPES`); Luma "edit finished" email closes the chase/dispatch keys; steps ticked |
| `delivery_text` | `createDeliveryTextTask()`, fired from `closeObsoleteTasks` on DELIVERED (`tasks.ts:874`) | `sendDeliveryText()`, the send-all batch, **any** outbound text to that client (openphone webhook), or the 7-day `closeStaleDeliveryTexts()` sweep |
| `revision` | `raiseRevision()` in `src/lib/comms.ts:285` (client asked for changes post-delivery); `requestCutChanges()` in `review/actions.ts:467` (key `cut-changes-<pid>`); `addToEditorQueue()` prior-cut path | `resolveRevision()` — reached from the Complete button, from ticking the last step, or the project page; `submitCutForReview()` closes the submitting editor's own revision task |
| `edit_video` | `mintEditTask()`, called by `ensureEditorHandoff()` (`tasks.ts:1248`, `1484`). VIDEO/SOCIAL_REEL jobs only — photos are AutoHDR'd, no human. Due = the video's SLA **minus a 12h QC buffer**, clamped to now+1h rather than backdated on an already-late job | Evidence the cut landed (`present.Video`, `dropbox.finalVideo>0`, any `ReviewSubmission`, status DELIVERED) — **unless `assignedManually`**; `submitCutForReview()`; DELIVERED sweep |
| `image_fixes` | `syncFixTask()` in `src/app/projects/flagActions.ts:28` — one 24h task per project rebuilt from OPEN `ImageFlag` rows | Last flag marked FIXED (rebuild finds zero open); `closeObsoleteTasks(DELIVERED)`, which also force-resolves the flags |
| `feedback_review` | `src/lib/feedback.ts:83`, **negative feedback only** | 7-day `closeStaleFeedbackReviews()` — but only for non-`URGENT` rows, and every one it mints is `URGENT` (see gotchas) |
| `internal_instruction` | Slack listener (`slackSync.ts:108`); @-mention companion tasks — **two** generators sharing one key: note surfaces (`mentions.ts:134`) and team-thread tags (`projects/messageActions.ts:79`); Script Studio webhook (`api/webhooks/scripting/route.ts:137`, `:159`); Ask the Hub `create_task` tool (`hubTools.ts:702`); My Day "task for Kyle" (`day/actions.ts:445`); photographer shoot-debrief "had issues" (`upload/actions.ts:117`) | Script Studio nudges close on the next Studio event; everything else is manual or all-steps-ticked. Gmail-sourced ones close via the thread sweep |
| `lead` | Unknown email sender (`google.ts:940`, key `lead-<email>`); unknown phone number (`upsertPhoneLeadTask`, `openphone/route.ts:481`, key `lead-<10-digit>`) | Outbound text / answered call to that number; Gmail thread answered |
| `vendor_update` | Luma Visuals email that is either "edit finished" or a real human message (`google.ts:771`) | Gmail thread answered; a later "edit finished" email; `closeObsoleteTasks(DELIVERED)` |
| `todo` | Manual add (`createManualTask`); `mintCullTask()`; "find the raw video" nudge; "no raws uploaded" watchdog; `ensureEditorLoginNudge()`; Review-Room "Review fixes" / "Capture fixes" (`reviewActions.ts:403`, `:449`); My Pay pay-question flag | Mostly nothing automatic — the exceptions self-clear (raw-video nudge when footage appears, raws-missing when raws land, `cull-<id>` on DELIVERED, `review-edit-` when the last EDIT note is FIXED, `review-photog-` when the photographer marks the last capture fix FIXED) |
| `connection_fix` | `reportGmailSendBroken()` (`gmailHealth.ts:29`) — one per mailbox, assigned `jordan`, plus an owner-only bell | `reportGmailSendWorking()` on the next successful send from that mailbox |
| `delivery`, `finish_delivery`, `appointment_prep` | **Nothing.** No creator exists any more | The reconciler actively retires them: `appointment_prep` is bulk-CANCELLED every run (`tasks.ts:1639`), `delivery`/`finish_delivery` fall out of `expectedKeys` and get COMPLETED |

`client_texts` (TodayView.tsx:149) is not a real task type — it's a sentinel `taskType` on a synthetic
rollup card whose id is the literal string `client-texts-rollup`; no such row exists in the DB.

The Review-Room fix tasks are typed `todo` **on purpose** (`reviewActions.ts:20-27`): `image_fixes` would
be force-completed by the DELIVERED sweep, which would fight their own closer; and because they carry an
`assignedKey`, `todo` doesn't drop them into the "Needs assigning" pile.

---

### The dedupeKey scheme

The whole idempotency story is one nullable-unique column. Two families of key exist.

**Hashed keys** — `dedupe(parts)` = `sha1(parts.filter(Boolean).join("|")).slice(0,24)` (`tasks.ts:119`).
`filter(Boolean)` matters: the reconciler's `dedupe([projectId, "media_qa", undefined])` produces the
same 24 chars as `reflectRevisionInQc`'s `dedupe([projectId, "media_qa"])`, so the revision path
mutates the reconciler's card rather than minting a rival one.

| Key | Scope |
| --- | --- |
| `sha1(projectId\|<taskType>)` | reconciler specs — one confirmation, one QC per project |
| `sha1(clientId\|projectId\|client_reply)` | one open reply **per client per order** — `"noproject"` stands in when unmatched, so a multi-order client's questions stay separate |
| `sha1(projectId\|comms_followup\|<senderSlug>)` | sender normalized to lowercase letters, 16 chars, so "Harrison" and "Harrison Wells" collapse |
| `sha1(projectId\|revision)` | one open revision per job, shared by `comms.ts` and the manual queue-add |
| `sha1(projectId\|delivery_text)` | one post-delivery text per job |
| `sha1(feedbackId\|feedback)` | one per feedback row |

**Literal keys** — readable, and used by `startsWith` sweeps:
`edit-video-<pid>` · `cull-<pid>` · `vendor-chase-<pid>-<category>` · `luma-dispatch-<pid>` ·
`raw-video-missing-<pid>` · `raws-missing-<pid>` · `image_fixes-<pid>` · `frameio-review-<pid>` ·
`scripting-script-<pid>` / `scripting-client-<pid>` · `cut-changes-<pid>` · `shoot-issue-<pid>` ·
`review-edit-<pid>` / `review-photog-<pid>` · `mention-<pid>-<teamMemberId>` · `slack-<messageTs>` ·
`lead-<email>` / `lead-<phone10>` · `luma-client-<clientId>-<projectId|subjectKey>-<done|msg>`
(falling back to `luma-<threadId>` when the Luma email matches no client) ·
`editor-login-<editorKey>` · `gmail-reconnect-<mailbox>` · `payflag-<memberId>-<pid|"period">-<periodKey>`.

Three different re-mint policies ride on those keys, and which one a generator picks is a real
design decision:

- **Reopen on new signal** (`client_reply`, `revision`, `lead`, `vendor_update`, `image_fixes`,
  `mention-`): `findUnique` → if COMPLETED, update it back to `status: "OPEN", completedAt: null`.
- **Never again, ever** (`cull-`, `vendor-chase-`, `luma-dispatch-`, `editor-login-`,
  `raws-missing-`): the mere *existence* of the row — open or completed — blocks creation.
  `mintCullTask` says it plainly: "a completed one means the photographer already handled it;
  don't re-nag on the next hourly pass."
- **Refresh but never resurrect** (`edit-video-`): an open row gets its due/priority/route
  refreshed; a COMPLETED or CANCELLED one is left alone — "the reconciler owns re-open"
  (`tasks.ts:1304-1319`).

Tasks minted by hand (`createManualTask`), by Ask the Hub, and by My Day carry **no** dedupeKey.
Postgres allows many NULLs in a unique column, so duplicates are possible there by design (Ask the
Hub instead dedupes on `source:"assistant"` + same title + same project, `hubTools.ts:689`).

`EXTERNAL_KEY_PREFIXES` (`tasks.ts:1696`) = `frameio-review-`, `scripting-script-`,
`scripting-client-`, `luma-`, `slack-`, `lead-`, `edit-video-`. These are excluded from the
reconciler's "no longer expected" sweep. The comment records why: the Frame.io "Review finals" task
self-destructed on first use, because its key isn't a spec hash and the reconciler read that as
"not expected any more" and closed it within the hour (audit crack #20).

---

### The Smart Brain router

Plain English: when a text or email arrives, the hub doesn't just make a generic "reply to X" note.
It hands the message, that client's orders, the recent conversation, and the team's open to-dos to
an AI, and asks: does this need work at all, which property is it about, how urgent, and is this the
same thing as a to-do we already have open? That's how one client sending five texts about one
problem produces one task, not five.

Two entry points in `src/lib/brain.ts`; the prompts and output validation live in
`src/lib/integrations/ai.ts:437` and `:542`. Both return `null` when the AI key isn't connected or
anything throws, and every caller has a keyword/single-message fallback path.

`routeCommTask()` gathers: the client's last **14** orders (id, address, status, delivery due,
delivered date, in-revision flag), their newest **14** open tasks **restricted to `MERGEABLE_TYPES`**
(`client_reply`, `comms_followup`, `internal_instruction`, `revision`, `vendor_update`, `lead`), and
the last **12** comms flipped into chronological order. It returns a `BrainDecision`:

| Field | What it decides | How it's trusted |
| --- | --- | --- |
| `actionable` | Is this work at all ("thanks", an emoji, already-handled → false) | Defaults to **true** on a malformed answer — "create a task if unclear" |
| `projectId` | Which order the message is about | Rejected unless it's one of the ids that were passed in |
| `title` / `detail` | ≤12-word imperative + one sentence of context | Falls back to "Follow up on client message" |
| `priority` | URGENT if upset / time-sensitive / delivery overdue | Non-enum values become `HIGH` |
| `mergeIntoTaskId` | This is the same request as an open to-do | Rejected unless it's an id that was passed in |
| `isRevisionRequest` | Client wants **already-delivered** work changed | The prompt spends a paragraph excluding scheduling, pricing, new orders, and — for monthly-social clients — sharing reference videos/ideas for the *next* piece |
| `flags` | ≤4 grounded notes ("asking a second time", "delivery 2 days overdue") | Written into the project Activity feed, not the task |

The prompt also carries the roster so titles don't invent activities: photographers Harrison and
James shoot; Kim and Remar are editors who *never* shoot; Luma/AutoHDR/CubiCasa/ReadyPost are
vendors.

`routeSlackTask()` is thread-aware: it reads the **newest 40** messages for the channel ordered
`desc` then flips them back chronological, keeping 22 — the comment records the bug that forced
this: reading oldest-first on a long DM made the brain reason about months-old history and
resurrect finished conversations as new tasks. It resolves client candidates by **full name only**
(`resolveClientCandidates`, `brain.ts:112`) — a bare first name like "Daniel" false-matches too
easily — and passes each candidate's orders plus upcoming shoots so "she"/"the form" resolve.
Its merge rule is stricter: never combine work about a different client, property or vendor.
Slack tasks land unassigned on purpose — keyword auto-routing "mis-fired constantly: any message
mentioning reel/video/social got shoved at Remar/Kim even when it wasn't theirs"
(`slackSync.ts:103-105`).

Merging is `mergeIntoExistingTask()` (`tasks.ts:599`). It **refuses** to merge into `media_qa`,
`delivery`, `confirmation_text`, `delivery_text`, `feedback_review` or `image_fixes` — merging
overwrites title and summary, and a production task's content must survive. On refusal the caller
falls through and creates a proper reply task. The appended log keeps the **latest** 4000 chars,
not the first: "the old head-slice silently ate new updates."

Revision detection has a second safety net in `src/lib/comms.ts:232-257`. If the brain says
"revision" but the anchored project is pre-delivery, the code re-anchors to the client's most
recent delivered-ish job — *unless* the brain explicitly picked that project or the client named
the street in the message. Without it a real revision "silently degrades to an activity line on the
wrong project."

---

### The hourly reconciler

`generateTasksForActiveProjects()` runs from `/api/cron/sync` (hourly, `vercel.json`), after the
Aryeo order/appointment sync and the status sweep. `generateTasksForProject(projectId)` is the same
code for one job, called by the Aryeo webhook (`api/webhooks/aryeo/route.ts:159`), the project
refresh button (`projects/refreshActions.ts:76`) and the "recheck statuses" button
(`actions.ts:765`) — so an order change produces or clears its tasks at event time instead of up to
an hour later. It no-ops unless the project is in one of the six `ACTIVE_TASK_STATUSES`.

**Turnaround → due date.** `TURNAROUND_HOURS` (`tasks.ts:21-33`): PHOTOS 20h, DRONE 20h,
TWILIGHT 20h, HEADSHOT 24h, FLOORPLAN 36h, MATTERPORT_3D 36h, ZILLOW_3D 36h, VIRTUAL_STAGING 48h,
SOCIAL_REEL 48h, VIDEO 48h, OTHER 48h (unknown types also fall to 48h). Reels/videos override:
premium = **72h**, monthly-content = **10 business days** (`addBusinessDays` skips Sat/Sun),
standard = 48h. Precedence is documented and deliberate — premium beats monthly, because a premium
reel ordered with a listing shoot is a one-off, not recurring monthly content, even for a
social-plan client. "Premium" is detected off the deliverable **label**:
`/premium|influencer|cinematic|luxury|signature|elite|flagship/i` — and the comment insists this
must match `PREMIUM_VIDEO_RE` in `projectStatus.ts`, because when it was just `/premium/` an
Influencer reel got a 48h SLA here and displayed 72h on the status card, a 24h disagreement.

**Priority.** `computePriority()` (`tasks.ts:97`): overdue or due <4h → URGENT; due <24h → HIGH;
shoot today/tomorrow → URGENT; shoot within 72h → HIGH; else MEDIUM. Post-shoot types
(`media_qa`, `delivery`, `delivery_text`) deliberately pass `shootDate: null` so "a 7–10 day monthly
job shouldn't read URGENT because it shot today."

**What it emits** (`specsForProject`, `tasks.ts:210`):

1. `confirmation_text` — only while `status ∈ {BOOKED, SCHEDULED}` **and** the shoot is not in the
   past (`etDayStartUtc()` comparison). Due = shoot − 24h. `deliverableType` is explicitly
   `undefined` so the key stays stable — keying it on the primary deliverable meant a re-synced
   order whose deliverables reordered minted a *second* confirmation.
2. `media_qa` — **one card per project**, "QC & deliver — <address>", due at the *soonest* pending
   deliverable's turnaround. Deliverable types are deduped with DRONE folded into PHOTOS and capped
   at 4. The spec is **only emitted when at least one checklist row is still unchecked**
   (`qcItems.some(i => !i.done)`) — once everything is live and delivered the spec stops, and the
   "no longer expected" sweep below is what actually completes the card.

**The QC checklist is the interesting part.** It is built category by category:

- One auto-checked evidence row per deliverable category (`QC Photos`, `QC Reel`, `QC Floor plan`,
  `QC 3D tour`), ticked from the project's `statusEvidence.present` — i.e. from Aryeo, not from Kyle.
- Then, **only once that category is actually live**, the guided failure modes
  (`QC_FAILURE_MODES`, `tasks.ts:166`). Photos: straight verticals/horizontals, blemishes & AI
  errors removed, consistent colour/lighting, clutter + our yard sign removed, people/camera out of
  mirrors and reflections, virtual staging / item removal done. Video: text on screen spelled right,
  music + branding correct. Floor plan: square footage matches the listing. These exist because QC
  was blind — one static sentence of guidance, nothing to tick — revisions ran **13.7%**, and the
  sampled bounce-back reasons were exactly those misses. Gating them on "category is live" means a
  job whose photos haven't landed shows no photo sub-items yet, so nothing gates prematurely.
- Two extra ticks for VIP/heavy clients (`VIP_SEGMENTS = {vip, heavy}`), appended **only to the
  Photos block** ("that's where reflections/clutter misses live"): mirrors re-checked frame by
  frame, clutter sweep on every room. Rationale in code: 38% of deliveries are VIP-segment
  (66% VIP+heavy) yet QC was client-blind.
- The **deliver step is the last checklist row**, not a separate task: "QC and deliver the gallery
  are ONE motion for Kyle" — a parallel `Deliver gallery` task doubled every job's cards (47 of 65
  recent jobs carried 2–4 check-type tasks).
- A cull nudge when the live photo count exceeds the home's budget
  (`photoTargetFor`: explicit override, else 80 for ≥3500 sq ft, else 50). It's pushed
  **`done: true`** so it can never block auto-close — it's "a READ, not a gate."

Labels are load-bearing: the reconciler's merge keys on the label string to preserve Kyle's ticks
across syncs, so "these must never change wording once shipped or a re-sync would drop the tick and
silently re-open the gate."

**What it reconciles each pass** (`syncOneProjectTasks`, `tasks.ts:1700`):

- Evidence-close `edit_video` (below), skipped entirely during REVISION.
- Retire open `media_qa` / `delivery` / `finish_delivery` whose key isn't in `expectedKeys` and
  isn't external-prefixed. During REVISION, `media_qa` is removed from that list — a
  revision-reopened QC card's spec may not be emitted at all (everything reads "live" because the
  *old* cut is what's live), so "no longer expected" must never close it.
- A `confirmation_text` whose spec vanished is stamped **CANCELLED, not COMPLETED**: it was never
  sent through the hub, it's moot. Before this, ~40% of "completed" confirmations in the Done ledger
  were never-sent ones.
- Re-merge the QC checklist: `done = spec says live || Kyle already ticked it`, plus any item the
  spec didn't produce (a revision-injected `Re-QC after revision` row) preserved with its state.
  All done → COMPLETED. **Completed but the evidence shows unchecked work on a live job → REOPEN**,
  because auto-close requires positive evidence and a completed dedupe key is never re-minted, so
  the work would vanish forever (audit crack #2).
- Follow due-date drift (≥1h, so rounding noise doesn't churn writes) and re-render the
  confirmation draft, "or it surfaces in the morning brief on the WRONG day and then sits overdue."
- The confirmation is the **only** type allowed to come back from a terminal state: CANCELLED
  (postponed shoot re-booked) or COMPLETED with a due-date drift ≥1h (rescheduled) reopens it with
  a fresh draft. The comment proves the two sweeps can't ping-pong: reopen only fires while the
  spec IS emitted, the auto-close only when it is NOT.

Other engines that mint work run from the same hourly status sweep (`src/lib/projectStatus.ts:604-711`),
each gated on the project's freshly-computed stage: `mintCullTask` (raws > target × **5.5**,
SHOT/EDITING only — `RAW_OVERAGE_FACTOR` in `src/lib/culling.ts:20`, "5.5 (not 5.0) leaves the same
~10% slack over the pure bracket ratio"), `chaseVendorsForMissing` (SHOT/EDITING/REVIEW; Floor
plan/CubiCasa after 3 days, Photos/AutoHDR after 2 — deliberately conservative against a 36h/20h
SLA; 14 of 141 recent deliveries shipped missing a whole ordered category), `ensureEditorHandoff`
(SHOT/EDITING/REVIEW), and `reconcileRawsMissing` (BOOKED/SCHEDULED/**SHOT**, 18h after the shoot;
877 S York sat SCHEDULED for 11 days with nobody told — SHOT is included on purpose because
"marking it shot is a claim about the camera, not about Dropbox").

---

### Auto-close — every rule

This is the subtle half of the engine. A rule fires only on **positive evidence** that the work
happened; the code repeatedly refuses to treat ambiguity as completion.

#### 1. Checklist-driven (any type)

`toggleTaskChecklistItem` (`actions.ts:345`): ticking the last box sets COMPLETED; **unticking a box
on a COMPLETED task reopens it**. `checklistComplete` requires ≥1 item, so an empty checklist can
never auto-complete. On a `media_qa` this also writes a `QcRecord`; on a `revision` it runs the full
`resolveRevision()` side effects, "or the project stays pinned in REVISION with its re-QC card
frozen open and the editor never gets the resolved ping."

#### 2. Evidence-driven (the reconciler)

| Task | Evidence that closes it | Explicitly NOT evidence |
| --- | --- | --- |
| `media_qa` | Every checklist row done (Aryeo categories live + gallery delivered + Kyle's ticks) | Anything during REVISION — every "done" signal describes the previous accepted cut |
| `edit_video` | `statusEvidence.present` contains `Video`, or `dropbox.finalVideo > 0`, or **any** `ReviewSubmission` exists, or the project is DELIVERED | **Project status `REVIEW`** — the status engine derives REVIEW for partial deliveries too (photos live, video missing), and using it auto-completed the editor's only work item within the hour of photo delivery while the reel was unmade. Proven live on 5 Nathaniel Ct. Also skipped entirely while REVISION, and skipped for `assignedManually` rows |
| `confirmation_text` | Spec no longer emitted → CANCELLED | — |
| `delivery` / `finish_delivery` | Spec no longer emitted → COMPLETED | — |

`ensureEditorHandoff` adds a **resurrection** rule in the other direction (`tasks.ts:1491`): an
`edit_video` marked COMPLETED with no cut anywhere and no open revision is set back to OPEN, with a
timeline note — "this is how the 5-Nathaniel-Ct class of silent losses self-heals."

#### 3. Terminal project state (`closeObsoleteTasks`, `tasks.ts:804`)

Called from four places: the status sweep on a status *change* into DELIVERED/CANCELLED
(`projectStatus.ts:713-719`), the owner's manual status button (`actions.ts:492`), `resolveRevision()`
(`comms.ts:482`), and the Aryeo dead-slot cancel (`aryeo.ts:959`).

- **CANCELLED** → every open task on the job becomes CANCELLED.
- **DELIVERED** → COMPLETE everything in `DELIVERED_CLOSE_TYPES` = `confirmation_text`,
  `appointment_prep`, `media_qa`, `delivery`, `finish_delivery`, `image_fixes`, `comms_followup`,
  `edit_video`, `vendor_update`. Plus: the `cull-<id>` todo (raws can't be thinned retroactively),
  and **all OPEN `ImageFlag` rows are force-set FIXED** — leaving them open made the Flags tab lie
  ("3 open flags" on a delivered gallery) and one new flag resurrected every stale one into Kyle's
  24h task. Then it queues the `delivery_text`.
- Before the sweep completes any `media_qa`, it snapshots each into a `QcRecord` with
  `completedBy: "auto:delivered"` — because Kyle delivers on Aryeo directly, so this sweep (not the
  checklist) is how most QC cards actually die: **30 of 30 deliveries closed this way with zero
  QcRecords and the owner's quality dial read empty** (July 2026 audit).
- `client_reply` and `revision` are deliberately left open — still actionable.

#### 4. Comms-driven

| Trigger | Closes |
| --- | --- |
| Outbound text to a client (OpenPhone webhook, incl. a group-thread echo from our own line) | That order's `client_reply` — order inferred first from a street named in the text, then from the client's most recent inbound with a project. If neither resolves, `closeReplyScoped` blanket-closes **only when the client has exactly one** open reply task; multi-order + unknown is left for a human, "so a generic 'thanks!' outbound can't silently clear an unrelated order's open question" |
| Same outbound text | Any open `delivery_text` for that client — Kyle often sends the gallery-ready text from his own phone; delivery texts were 36% of all overdue and were previously only swept by the 7-day timer |
| Outbound **answered** call (`answeredAt` set or `duration > 0`) | The callback task. A no-answer leaves it open so we try again |
| Outbound text / answered call to an unmatched number | `lead` tasks matching that number in `dedupeKey` or `sourceDetail` — every external recipient of a group text is checked, not just `to[0]` |
| `sweepRepliedOpenPhoneTasks()` (backstop for missed webhooks; runs on the **5-minute** `/api/cron/gmail`, not the hourly) | Queries each client's thread directly; if the newest message is outbound, close. **Skips any client with >1 open reply task** — phone level can't tell which order |
| Gmail scan (`google.ts:986-1005`) | Any open task with `source: "gmail"` and a `gmail-thread:` sourceDetail whose thread we've since answered |
| `sendReplyForTask` (`today/actions.ts:16`) / `sendEmailReply` (`emailActions.ts:12`) | The exact task. Both accept `keepOpen` for revision acks: replying doesn't finish the edit. Only `sendEmailReply` does an **atomic claim before sending, reverted on failure** — "a stale second tab must never email the client twice"; `sendReplyForTask` texts first and then closes (its double-send guard is the button's busy state). The send-all text batch (`sendDraftText`, `tasks/sendAllActions.ts:139-146`) uses the same claim-then-send-then-revert pattern |
| `closeClientReplyTask` | Never touches `comms_followup` — that's a *teammate's* instruction (a photographer's lockbox code); replying to the client doesn't handle it |

#### 5. Flow-driven

- `submitCutForReview()` closes the submitting editor's open `edit_video` **or** `revision`, scoped
  to `assignedKey === myEditorKey` — unscoped, "one editor's submit closed ANOTHER editor's work item."
- `resolveRevision()` clears the flag, returns REVISION → DELIVERED, closes revision tasks, and then
  calls `closeObsoleteTasks(DELIVERED)` — before that last call every revision left a permanently
  overdue re-QC card in Kyle's list (audit crack #22).
- `syncFixTask()` closes `image_fixes` when zero flags remain OPEN.
- Marking the last EDIT-lane review note FIXED closes `review-edit-<pid>` and rings the owner for a
  re-review pass; the photographer marking the last PHOTOGRAPHER-lane *fix* note FIXED does the same
  for `review-photog-<pid>` — that one "had NO closer at all (audit)" (`reviewActions.ts:306-340`).
- Script Studio: `project.sent_to_client` closes the "script ready" nudge, `project.script_generated`
  closes the "client responded" one (a regenerated script means their response was handled),
  `project.client_responded` closes nothing but reopens its own, `project.done` closes both. Before
  this "each event used to only re-open the same key, so nothing ever closed these tasks"
  (audit crack #35).
- A Luma "edit finished" email closes that project's open `vendor_update`, `vendor-chase-*` and
  `luma-dispatch-*` rows before minting the "go download it" task.
- `reportGmailSendWorking(mailbox)` closes `gmail-reconnect-<mailbox>` (plus the legacy keys).
- `reconcileRawsMissing` closes its own `raws-missing-<pid>` as soon as raws appear, Aryeo has
  media, **or Dropbox was unreadable** — "unknown is not proof of absence" cuts the other way here.
- `ensureEditorHandoff` clears `raw-video-missing-<pid>` when footage or a submission appears.

#### 6. Timers (daily cron, `/api/cron/daily`)

- `closeStaleDeliveryTexts(7)` — a delivery text still open a week later was either already sent
  from Kyle's phone or is moot (the client got Aryeo's own delivery email anyway); leaving it
  inflates the overdue count forever.
- `closeStaleFeedbackReviews(7)` — non-URGENT only; a week on, "thanks, loved it!" needs no
  follow-up. Negative feedback is URGENT and stays until a human resolves it.

---

### `assignedManually` — the invariant every engine must respect

Plain English: when a human picks who does a job, the robots stop second-guessing it.

The flag is set in exactly two places, both in `src/app/editing/actions.ts`: `setEditVideoEditor()`
(owner reassigns a video job) and `addToEditorQueue()` (owner manually adds a job to the editor
queue, both the fresh and the prior-cut/revision rails). Everything that runs automatically must
check it:

| Engine | Behaviour when `assignedManually` is true |
| --- | --- |
| `mintEditTask()` refresh (`tasks.ts:1312`) | Still refreshes due/priority/summary, but does **not** overwrite `assignedKey` |
| `ensureEditorHandoff()` (`tasks.ts:1394-1409`, `1435`) | Skips repointing `Project.editorId`, and skips the "find the raw video" chase — no footage in the folder is *expected* for old-footage or externally-shot work, and the wrong "upload your video" text would chase a photographer who owes nothing |
| Reconciler evidence-close (`tasks.ts:1743-1755`) | Filters `assignedManually: false`. The "landed" evidence is the **previous** cut (an old final-video file, a past ReviewSubmission, a live listing video), so it must not close work a human just reopened. Manual edits close only via the editor's "send to review" |
| `raiseRevision()` re-raise (`comms.ts:399`) | Keeps `existing.assignedKey` instead of the routing suggestion |
| `reportGmailSendBroken()` (`gmailHealth.ts:54`) | Comment states the rule from the other side: engine-minted tasks must **never** set the flag — "that flag is the humans' hands-off signal to every automatic engine, this task included" |

`addToEditorQueue` also documents the two-rail design that exists *because* of this invariant: a
job with any prior cut (DELIVERED, a past ReviewSubmission, or final-video evidence) goes down the
**revision** rail rather than the edit rail, precisely because those three signals are exactly what
the evidence auto-close reads — an `edit_video` task there would be completed by the next hourly
sweep.

---

### Role scoping for editors

Kim, Remar and anyone else with role `EDITOR` never see the team's queue.

- `src/app/tasks/page.tsx:35` — `boardOnly = me?.role === "EDITOR"`. Editors get **only** the Board
  tab; no tab bar, no Today stack, no Done ledger, no drafted-texts panel, no unanswered-replies
  pill ("editors never see client comms"). Every one of those counts is short-circuited to 0 so the
  queries don't even run.
- `BoardView.editorScopeOf()` resolves their scope to `editorKey`, falling back to
  `slugForName(name)`, and folds it into the SQL `where` — "so their view can't even load others'
  work." The `?who=` param can't broaden it (`whoRaw = editorScope ?? sp.who ?? "all"`), and the
  person-filter chips and the "Needs assigning" triage section are hidden.
- `TaskCard` takes `editorView`, which: points the project link at `/edit/<id>` instead of
  `/projects/<id>` (the EDITOR role can't open `/projects` — audit crack #38), renders the client
  chip unlinked, hides the AI-draft and OpenPhone-send buttons, and makes both checklists read-only.
- `requireTaskAccess()` (`guards.ts:53`) is the server-side twin: owner/admin always pass; an
  EDITOR or PHOTOGRAPHER passes only if the task's `assignedKey` matches **any** key that human is
  addressable by — editor key, AppUser display-name slug, or their TeamMember name slug — "so an
  AppUser renamed away from the roster spelling doesn't lose the ability to act on their own work."
  Anyone in "view as" preview mode is refused outright.
- `BoardView.category()` files `edit_video` under **Edits & revisions**, not comms: "an editor's
  edit_video card filed under Replies & admin made no sense on their board."
- Photographers have **no** `tasks` page at all (`ROLE_PAGES.PHOTOGRAPHER` in `auth/access.ts`).
  Their assigned tasks reach them via `listPhotographerTasks()` (`src/lib/shoot.ts:556`) on the My
  Shoots card, which resolves their roster name to a slug, **fails closed to zero tasks** if it
  can't, runs every title/summary through `stripMoneySentences`, and never sends `description` or
  `sourceDetail` to the field at all.

---

### The Tasks hub — Today, Board, Done

One page, three tabs (`/tasks?tab=`). `/today`, `/queue` and `/history` survive only as redirect
stubs that forward every query param. Jordan's driving quote is in the file header: "the toolbar has
too many things — today, daily tasks, and task history could all be combined."

| | **Today** (default) | **Board** | **Done** |
| --- | --- | --- | --- |
| Question it answers | What do I finish right now? | Who owns everything that's open? | What happened? |
| Query | `stackWhere()` in `TodayView.tsx:25` | `boardWhere()` in `BoardView.tsx:37` | `getTaskHistory(45)` + `getDeliveryHistory(45)` + `getShootHistory(45)` |
| Status filter | 8 active statuses | same 8 | `COMPLETED` only |
| Message types (`client_reply`, `comms_followup`, `revision`, `lead`, `internal_instruction`, `vendor_update`, `todo`) | always, any due date | always, any project age | n/a |
| QC/deliver types | open on a **recent** project, any due date | same recency rule | n/a |
| Everything else | due by end of today **including overdue** | no due filter at all | n/a |
| Client texts (`confirmation_text`, `delivery_text`) | **excluded**, replaced by one synthetic rollup card | included, in their own groups | included |
| Assignee filter | none — every assignee visible | none by default; `?who=` chips; editors DB-scoped | none |
| Shape | flat action stack sorted `dueAt asc`, with verbs `reply` / `check` / `do` | grouped **by person**, then by category, in collapsed `<details>` panels | grouped by ET calendar day, merged with shoots and deliveries |

Three rules are load-bearing in those queries:

- **No assignee scoping on Today or Board.** The comment marks it "audit critical": scoping to
  Kyle + delegate keys made tasks assigned to `jordan` or a photographer vanish from every surface.
  Delegated work instead renders with a `→ Name` chip and a `do` verb — Kyle's action is to check on
  the person, not to do it himself.
- **Recency** (`recentProjectWhere()`, `src/lib/recency.ts`): last 14 days by *real* dates
  (`orderedAt`/`shootDate`/`deliveredAt`/`revisionRequestedAt`, never `createdAt` which is import
  time) **plus every active-status project regardless of age** — a stalled job's dates never move,
  so the date-only window made an undelivered job disappear at exactly 14 days, "precisely when it
  most needed eyes" (audit crack #9).
- **Client texts have one membership rule**, `clientTextWhere()` in `src/lib/clientTexts.ts`, shared
  by the Outbox panel, the Today rollup, the hub badge and the send-all batch. Four inline copies had
  drifted (finding #44: the badge advertised texts the panel didn't show). Its encoded rules: no
  assignee filter ever, a null `dueAt` **counts** (a confirmation on a job with no shoot date is real
  work), `projectId` required, recency everywhere, and due by end of today ET — surfacing a
  confirmation for a shoot weeks out "invites an insane early send."

The Board's pinned **"Needs assigning"** section is `isNeedsAssigning()` from `src/lib/triage.ts`:
no `assignedKey` **and** `taskType ∈ {internal_instruction, todo, revision, lead, vendor_update}`.
That module exists solely so the queue and the morning brief can never drift on the definition, and
its header states the exclusion: Kyle's SOP routine (confirm / QC / deliver / client replies) is his
by default and is not triage. `getActionCounts()` re-expresses the same predicate in SQL so the
dashboard chips count system-wide.

The Done tab renders each ET day as one card: shoots, deliveries, then completed tasks, with a
per-bucket one-line recap and an on-demand AI narrative (`DayRecap`).

---

### The card

`src/lib/taskView.ts` is the single mapper from a `SmartTask` row to `QueueTask`, used by both the
Board and the project page "so they never drift." Every task type surfaces its checklist — the
operational steps live there for all types, not just QC. `media_qa` additionally gets a
`qcClient` context strip built from the client's segment, editing preferences, and AI working
profile (`profileJson.revisions.commonTypes` = "usually asks for", the single line that predicts the
bounce-back this QC pass exists to prevent).

`TaskCard` (`src/components/queue/TaskCard.tsx`) renders three checklist modes:

- **Evidence rows** (QC only) — `isEvidenceRow()` matches `^QC ` without `(revision)`, the deliver
  row, and the cull line. Rendered as non-interactive live/pending chips. This predicate **must**
  match `isAutoCheckRow()` in `tasks.ts:658`, which is what the miss-count keys on.
- **Kyle's failure-mode ticks** — one-tap, optimistic, `toggleTaskChecklistItem`.
- **VIP extra pass** — its own amber block; the `VIP — ` prefix is stripped in the row because the
  header carries it.

Other affordances: `Draft` (AI reply) for `client_reply`/`revision`/`feedback_review`/
`delivery_text`/`lead`; `Send` for confirmation and delivery texts, with "Review before sending. The
hub never sends on its own." printed under the draft; `Send email` into the original Gmail thread
with the resolved recipient shown and re-verified server-side; a `Call back` / `Text` pair for phone
leads (their number lives in `sourceDetail` as `phone:…` — before that, lead cards had nothing to
do); a `Luma tracker` link on Luma vendor updates; `Note` (posts to the job's team thread, not to
the client); and `Full view` (the complete text plus, for owner/admin, the live original
conversation). `TaskFocus` handles `?task=<id>` deep links from the morning brief and notifications
— a query param rather than a `#hash` on purpose, because a hash makes the browser expand the
`<details>` before hydration and trips a mismatch.

---

### QcRecord — the owner's quality dial

One row per QC pass, written from **three** completion paths so a pass can't be invisible:
the reconciler's auto-complete, the interactive tick (`actions.ts:367`), and the status-button
Complete (`actions.ts:142`) — plus the `auto:delivered` snapshot in the DELIVERED sweep. All four call
`recordQcCompletion()` (`tasks.ts:681`), which dedupes on "a QcRecord for this project in the last
5 minutes" so two paths firing together can't double-write, and is best-effort everywhere ("a
QcRecord failure must never break the task flow").

`missCount` = Kyle-tick items left unchecked at completion (`countQcMisses`, evidence rows excluded).
When a revision later bounces the job, `reflectRevisionInQc()` stamps the project's latest record
with `reopenedByRevisionAt` + `revisionReason` — "that bounce IS the QC-miss event." `getQcStats()`
in `src/lib/qc.ts` aggregates passes, average misses, reopened rate, and a most-missed-label list.

`reflectRevisionInQc` also re-arms the gate: on a *second* generic revision it flips the existing
"Re-QC after revision" row back to unchecked, because leaving it done meant "the reconciler saw an
all-done card and auto-completed the re-QC within the hour."

---

### Gotchas / known state

- **`qc.ts`'s "NOT WIRED YET" header is stale — don't trust it.** `src/lib/qc.ts:9-14` still says
  "NOT WIRED YET: this is a ready-to-adopt data source" with instructions for the dashboard to import
  it, but `getQcStats` **is** wired in two places since: the Review Room (`src/app/review/page.tsx:13`,
  called at `:76` as `getQcStats(30)`) and `src/lib/queries.ts:9` (called at `:672`). The comment is a
  leftover; the function is live. Its sibling `getFixPatterns()` (photo-flag tags + capture notes per
  photographer, the "what's slipping through" rollup) is wired the same way.
- **`closeStaleFeedbackReviews` can never fire on anything it's meant to.** It filters
  `priority: { not: "URGENT" }`, but `src/lib/feedback.ts:83` only mints `feedback_review` for
  **negative** feedback and always at `priority: "URGENT"`. The comment acknowledges the positive/
  neutral task was removed and says "any pre-existing rows still drain" — so this sweep is now a
  one-time drain for legacy rows only, and `feedback_review` has no other auto-close.
- **Three task types are dead but still referenced everywhere.** `delivery`, `finish_delivery` and
  `appointment_prep` have no creator left. `appointment_prep` is bulk-CANCELLED on every reconciler
  pass (`tasks.ts:1639`); the other two are only ever retired. All three still appear in
  `PRODUCTION_TASK_TYPES`, `category()` and the TodayView/TaskCard `TYPE_LABEL` maps; `delivery` and
  `finish_delivery` (not `appointment_prep`) are also still in `DELIVER_TASK_TYPES`.
- **`connection_fix` is nearly invisible.** `reportGmailSendBroken` sets no `dueAt`, and the type
  isn't in `MESSAGE_TASK_TYPES`, `DELIVER_TASK_TYPES` or `TRIAGE_TYPES`. Today's stack and the
  morning brief both require a `dueAt` for "everything else", so a null one never matches — the task
  only ever appears on the Board (under Jordan, in the "Replies & admin" group), despite being
  URGENT. The bell notification is what actually reaches Jordan.
- **A hand-added task "for Kyle" lands in "Needs assigning".** `createManualTask` stores
  `assignedKey: null` whenever the picked assignee is `kyle` (`actions.ts:243`), and `todo` is in
  `TRIAGE_TYPES` — so `isNeedsAssigning()` is true and it renders in the pinned unassigned pile
  rather than in Kyle's own section. Same for Ask the Hub's `create_task` (`hubTools.ts:702`) and
  My Day's `createTaskForKyle` (`day/actions.ts:445`): both write `ownerId` = Kyle's TeamMember but
  no `assignedKey`, and `internal_instruction` is also a triage type.
- **`computePriority` computes "today" in server-local time**, not ET:
  `new Date(now.toDateString())` at `tasks.ts:104`. Everywhere else in the codebase uses
  `etDayStartUtc`. On a UTC server that's a 4–5 hour offset, so the shoot-proximity branch flips a
  few hours early — a task can read URGENT ("shoot tomorrow") sooner than the ET-based surfaces say.
- **Two implementations of the same "Today" count.** `queries.getTodayCardCount()` (used by the
  dashboard's "Start your day →" button) and `TodayView.todayCardCount()` / `stackWhere()` (the hub
  badge and the feed) duplicate the same logic. The `queries.ts:428` comment claims "Kept here so
  /today can adopt this helper later and the two numbers can never drift" — the adoption never
  happened. They also differ at DST boundaries: `stackWhere` uses `startToday + 24h − 1ms`, which
  `clientTexts.ts:22-31` documents at length as the wrong way to compute end-of-day-ET.
- **The Gmail thread sweep is broad.** `google.ts:990` closes *any* open task with
  `source: "gmail"` and a `gmail-thread:` sourceDetail once the thread has an outbound reply — that
  includes `lead` tasks and Luma `vendor_update` tasks. Replying "thanks, got it" to a Luma
  "edit finished" email will close the "Download + QC the finished Luma reel" task before anything
  was downloaded.
- **Slack `internal_instruction` tasks have no auto-close path at all.** They close only by a human
  pressing Complete or ticking both steps ("Do the requested action" / "Reply in Slack when done").
  Same for the @-mention companion tasks and Ask-the-Hub tasks.
- **A project can carry two `media_qa` cards.** The Frame.io webhook upserts
  `frameio-review-<projectId>` while the reconciler owns `sha1(projectId|media_qa)`, and
  `frameio-review-` is in `EXTERNAL_KEY_PREFIXES` so the reconciler won't touch it. Worse,
  `reflectRevisionInQc` picks its target with `findFirst({ projectId, taskType: "media_qa" })`
  ordered by `createdAt desc` — on such a project it may mutate the Frame.io card instead of the
  guided QC one. (Frame.io itself is documented elsewhere as dormant pending webhook re-registration.)
- **The automatic `closeObsoleteTasks` only runs on a status *transition*.** `projectStatus.ts:713-719`
  calls it inside `if (statusChanged)`. A job already sitting at DELIVERED when a stale production
  task is created (or when this logic changed) is never swept by the hourly sweep again — the only
  ways back in are the owner re-pressing the Delivered/Cancelled status button (`actions.ts:492`) or
  a revision being resolved.
- **Editors cannot tick their own checklists.** `toggleTaskChecklistItem` calls `requireAdmin()`
  (`actions.ts:349`), while `setSmartTaskStatus` and `setTaskAssignee` use the wider
  `requireTaskAccess`. The UI is consistent (`interactive={!editorView && !done}`), so no editor
  hits an error — but an editor's only way to finish work from a card is the Complete button.
- **The Board's "N done" badge is a lifetime count.** `prisma.smartTask.count({ status: "COMPLETED" })`
  with no date or project bound (`BoardView.tsx:126`) — it grows forever and is unrelated to the
  filtered view beneath it.
- **`assignedManually` is never surfaced or clearable in the UI.** Changing the assignee through the
  card dropdown (`setTaskAssignee`) writes `assignedKey` but leaves `assignedManually` untouched, so
  a task claimed once through `/editing` stays permanently exempt from the evidence auto-close and
  the automatic re-routing, with nothing on screen saying so.
- **`ensureEditorLoginNudge` implies a real, live gap**: it exists because work is pinged to editor
  bells that no `AppUser` can see, and its copy names Remar specifically ("add Remar's phone to her
  Team row so texts can reach her too"). `src/lib/editors.ts:54` still carries the comment
  "No TeamMember/phone yet (Jordan to add), so SMS no-ops until then."
- **`recordQcCompletion`'s 5-minute dedupe is per project, not per task.** Two `media_qa` cards on
  the same project completing within five minutes of each other produce one `QcRecord`.

## 4. Communications

Every text, call, voicemail, email and Slack message the business touches lands in one
place, gets remembered, and — when it needs an answer — turns into a piece of work someone
can see. The hub reads all of it automatically. It **never answers on its own**: every
client-facing message in this system is written as a draft, shown to a human, edited if they
want, and sent only when a person taps Send. That rule is not a preference, it is enforced in
code on every outbound path (`src/app/communications/replyActions.ts`,
`src/app/tasks/sendAllActions.ts`, `src/app/shoot/actions.ts`, `src/app/emailActions.ts`).

The technical shape: inbound events arrive by webhook (OpenPhone, Slack) or by poll (Gmail,
Slack user-token backfill), are written to a single `CommLog` table, and are then classified
into tasks / revisions / leads. Outbound goes through the OpenPhone or Gmail APIs from a
server action that a human triggered.

---

### The Communications hub — five tabs

`src/app/communications/page.tsx` is one route with five `?tab=` views. The page comment
records why: Jordan asked to *"keep comms all in one tab"* → *"sick messaging and comms hub"*.
Each tab loads **only its own body data** — the heavy OpenPhone conversation pull never runs
for the other four. Two queries do run on every tab, because they feed the tab strip's badges:
`getClientTextTasks()` and `replyWaitingSummary()` (`page.tsx:86-89`).

| Tab | `?tab=` | What it shows | Data source |
|---|---|---|---|
| **Inbox** | *(default)* | Live OpenPhone conversation list, group threads flagged, client/contact chips | `recentOpenPhoneConversations()` + `OpenPhone.phoneNumbers()` (live API), joined against `Client` / `Contact` / `TeamMember` phones |
| **Replies** | `replies` | Every inbound text still owed an answer, each with an AI draft | `replyQueue()` over `CommLog` (`src/lib/replyQueue.ts`) |
| **Email** | `email` | Client/lead email from the last 60 days, grouped into threads, read-only | `getEmailThreads()` over `CommLog` where `channel="email"` (`src/components/comms/emailThreads.ts`) |
| **Team** | `team` | Internal project message threads across all jobs, read-only | `ProjectMessage` roots + reply counts (`src/components/comms/TeamMessagesPanel.tsx`) |
| **Outbox** | `outbox` | Today's drafted confirmation + delivery texts awaiting review | `getClientTextTasks()` → `SmartTask` via `clientTextWhere()` |

Badges on the tab strip: **Replies** shows `replyWaitingSummary().count` (danger-soft red),
**Email** shows `fresh` (inbound within 48h, computed by the email tab's own query so no extra
`CommLog` scan is spent elsewhere), **Outbox** shows the drafted-text count.

Caps that matter: Inbox displays `DISPLAY_CAP = 150` conversations; Team shows
`THREAD_CAP = 40` root messages; Email pulls `take: 800` rows / `WINDOW_DAYS = 60` and renders
`THREAD_CAP = 50` threads.

Access: `communications` is in the ADMIN role's default page set (`src/lib/auth/access.ts`
`ROLE_PAGES`; OWNER gets `ALL`) — EDITOR and PHOTOGRAPHER are deliberately excluded. It is
*not* marked `ownerOnly`, so a per-user permission override in `canAccess()` can still grant
it to an individual editor/photographer. Every server action in `replyActions.ts` /
`threadActions.ts` additionally calls `requireAdmin()`.

---

### `CommLog` — the single comms memory

Everything the business hears goes through one writer, `logComm()` in `src/lib/commLog.ts`.
Its header states the purpose plainly: *"Every client text, call transcript, email, and note
flows through here so 'Ask the Hub' can recall what was actually said."*

#### The row (`prisma/schema.prisma`, model `CommLog`)

| Field | Notes |
|---|---|
| `channel` | `text \| call \| email \| slack \| note` |
| `direction` | `in \| out` (default `in`; anything not `"out"` is coerced to `"in"`) |
| `minRole` | `CREATIVE \| ADMIN \| OWNER`, default `ADMIN` — lowest role allowed to see the row |
| `clientId` / `clientName` | **Plain refs, no FK** — "so log rows survive client edits" |
| `projectId` | which order it's about, when known |
| `contactName` | sender label (`"Us"` for our own outbound) |
| `fromPhone` | the OTHER party's 10-digit key |
| `subject` | email subject, capped 300 |
| `body` | full text / transcript, capped **6000** |
| `occurredAt`, `source`, `externalId` (`@unique`) | provider ids: `op-<msgId>`, `op-call-<callId>`, `gmail-<mailbox>:<msgId>`, `slack-<channel>-<ts>` |

Indexes: `clientId`, `projectId`, `occurredAt`, `minRole`, `[channel, occurredAt]` (the schema
comment says this exists because *"the reply queue scans recent texts newest-first; without
this it table-scans"*), and `fromPhone`.

#### `fromPhone` — why the column exists

The schema comment is the rationale: *"Without it a logged text can be read but not replied
to — the reply queue needs a number to send back on, and CommLog is the only complete record
of every text."* `logComm` normalizes it to the same last-10 key everything else compares on,
so a row logged as `+1 (610) 555-0100` still matches a lookup for `6105550100`
(`commLog.ts:41-44`); anything that isn't 10 digits is stored as `null`. It is null on email
and Slack rows, and on texts logged before the column existed — the reply queue falls back to
the client's number on file for those (`replyQueue.ts:169`).

#### `minRole` tiering

Every `CommLog` reader applies the same ladder — `{ CREATIVE: 1, ADMIN: 2, OWNER: 3 }` — and a
viewer sees their tier **and below**. Implemented identically in `src/lib/replyQueue.ts:31`,
`src/components/comms/emailThreads.ts:44`, and the Hub's `search_comms` tool
(`src/lib/hubTools.ts`). `contentTier()` (`src/lib/auth/access.ts:161`) folds app roles onto
that ladder: `OWNER→OWNER`, `ADMIN→ADMIN`, everything else (EDITOR, PHOTOGRAPHER) → `CREATIVE`.

Who stamps what:

- **OpenPhone webhook** — never passes `minRole` → every text and call lands at the `ADMIN`
  default.
- **Slack channel webhook** — explicit `minRole: "ADMIN"` with the note *"the bot only sees
  channels, not Jordan's DMs"*.
- **Slack user-token sync** — channels `ADMIN`; Jordan's DMs and group DMs `OWNER`.
- **Gmail** — unknown senders on `info@realtourpilot.com` (Jordan's personal mailbox) are
  stamped `OWNER`, so a missed personal-inbox lead is *"at least auditable instead of leaving
  zero trace"* (`src/lib/integrations/google.ts`).

#### Idempotency, and why a failure throws

`logComm` returns `true` only when a **new** row was inserted, so callers (the Slack sync) can
act only on genuinely-new messages. It pre-checks `externalId` so the common dedupe case is
clean, then catches Prisma `P2002` (lost race on the same id) as a harmless duplicate. Every
other error is **rethrown** — the comment records the past bug: *"treating every failure as a
dupe silently punched holes in comms memory."* Rethrowing lets the caller's error path (the
`WebhookEvent` ERROR row, the cron step log) retry it.

#### Who writes to it

| Writer | File | Channel / direction |
|---|---|---|
| OpenPhone texts (in + out, incl. group echoes) | `src/app/api/webhooks/openphone/route.ts:164` | `text` |
| Unmatched inbound call (lead path) | same, `:366` | `call` in |
| Call transcript, unknown caller | same, `:422` | `call` in |
| Call transcript, matched client | same, `:447` | `call` in |
| Slack channel messages, real-time | `src/app/api/webhooks/slack/route.ts:85` | `slack` in |
| Slack channels + DMs, hourly/5-min backfill | `src/lib/integrations/slackSync.ts:194` | `slack` in/out |
| Gmail inbound (every human email, even answered ones and leads) | `src/lib/integrations/google.ts:870` | `email` in |
| Hub-sent email reply | `src/app/emailActions.ts:78` | `email` out |
| Reply-queue send | `src/app/communications/replyActions.ts:170` | `text` out |
| Photographer status/free-form text from `/shoot` | `src/app/shoot/actions.ts` (direct `prisma.commLog.create`) | `text` out |

`clientDedupe.ts` re-points `CommLog.clientId` inside the merge transaction
(`clientDedupe.ts:165`, `:215`) so merging two duplicate client rows never orphans comms
memory.

---

### Inbound: how a text becomes a task

`POST /api/webhooks/openphone` (`src/app/api/webhooks/openphone/route.ts`) is the real-time
door for texts, calls and transcripts. Registered events (`src/lib/integrations/openphone.ts`):
`message.received`, `message.delivered`, `call.completed`, `call.ringing`,
`call.recording.completed`, and — on a separate resource that not all plans expose —
`call.transcript.completed`.

**The order of operations for one inbound text:**

1. **Auth.** `openPhoneRequestAuthorized(?t=…)` compares a shared-secret token in the callback
   URL, constant-time. A rejected POST writes a `WebhookEvent` row with
   `eventType: "signature.rejected"` and calls `alertWebhookRejections("openphone")` so it is
   countable on `/connections`. **Backward-compatible: if no `openphone_webhook` secret is
   stored, the check returns `true`** — see Gotchas.
2. **Idempotency.** A prior `WebhookEvent` with the same `provider + externalId + status
   PROCESSED` short-circuits (`{ ok: true, deduped: true }`). Otherwise a `RECEIVED` row is
   created, processing runs, then the row is stamped `PROCESSED` or `ERROR` with the message.
3. **Phone extraction.** `collectPhones()` walks the whole payload. It splits comma-joined
   strings because *"Group texts arrive with `to` as ONE comma-joined string ('+1555…,+1444…')
   — so every participant is matched, not none."*
4. **Own-line detection.** `ourOpenPhoneNumberKeys()` (10-minute per-lambda cache, best-effort:
   an API blip returns the last known set rather than throwing). In a group thread *our own
   replies echo back as "incoming" events FROM our line* — `fromUs` catches that, so
   `effIncoming = incoming && !fromUs`, and our lines are excluded from client matching so the
   thread resolves on the real participants.
5. **Sender identity.** `resolveSenderName(fromPhone)` (`src/lib/contacts.ts:270`) checks
   `TeamMember` → `Client` → synced `Contact` (whose `phones` is a JSON array of alternates).
6. **Robo filter.** `AUTOMATED_SENDER_RE = /aryeo|notif|no-?reply|do-?not-?reply|automat|alert|
   reminder|noreply|system|notify|real\s*tour/i` tested against the resolved sender *name*.
   Robo senders are *"notifications, not humans — never leads, never logged as client messages,
   never project instructions."*
7. **Client match.** `resolveClientByPhones()` collects **every** matching client row then ranks
   them deterministically (`rankClientRows`): agent over folded assistant → freshest project
   activity → has an Aryeo identity → oldest row (*"the canonical original beats a
   freshly-minted twin"*). The comment records the bug: an unordered `.find()` *"picked
   whichever Postgres returned first, which could dodge the clientId-scoped task auto-close."*
8. **Which order is it about?** For a matched non-call with text, `findClientProjectByText()`
   prefers the project whose **street** the message names over the client's most-recent order.
   Client-scoped by construction, *"so it never routes onto a different client's job."*
9. **`logComm`** with `fromPhone = counterparty` (whoever wrote in, or on our outbound whoever
   we texted — our own lines excluded so a group thread resolves to a real person).
10. **`recordClientCommunication()`** (`src/lib/comms.ts:105`) — the single entry point for an
    inbound client communication *from ANY source*. The file header is explicit that this is
    source-agnostic on purpose: *"OpenPhone calls it today; Gmail / Facebook Messenger / web
    form listeners call the SAME entry point as they come online."*

#### Inside `recordClientCommunication`

- **Reactions are dropped first.** `isReaction()` — a `"Liked …"` / `"Loved …"` iMessage tapback,
  or an emoji/punctuation-only string ≤8 chars — returns before anything is created.
- **Unhappiness is recorded separately.** `isNegativeSentiment()` writes a `NEGATIVE` `Feedback`
  row on the project (category `communication`), which flows into the client and photographer
  scorecards. Separate from a revision.
- **The Smart Brain routes the task.** `routeCommTask()` (`src/lib/brain.ts:24`) loads the
  client's last 14 orders, their open *mergeable* to-dos, and the last 12 `CommLog` turns, then
  decides: actionable or not, which order, title, priority, and whether to **merge into an
  existing open to-do** rather than duplicate. Merges into a production task (`media_qa`,
  `delivery`, `confirmation_text`, `delivery_text`, …) are refused by
  `mergeIntoExistingTask()` — the caller then falls back to creating a fresh reply task *"so
  the message is still tracked."*
- **Fallback.** With no AI key or a brain failure, `messageToTodo()` writes a single-message
  to-do; an AI title matching `/no action needed/i` suppresses it.
- **Observability.** An `Activity` row of type `SYSTEM` records `Smart Brain: <what> — <reason>
  [flags]` on the chosen order.
- **Revision detection.** `classifyComm()` runs 21 broad regexes (`revise`, `redo`, `too dark`,
  `missing`, `swap`, …) — deliberately broad, because *"a false positive just shows up as a
  dismissible REVISION flag … far cheaper than missing a real one"* — then vetoes them when the
  message is scheduling talk
  (`SCHEDULING_RE` — *"the #1 false-positive source"*, e.g. *"Thursday works, that's the soonest
  you have"*) unless a `STRONG_REVISION` term is present. When the brain is available its
  `isRevisionRequest` verdict wins; the keyword classifier is the fallback.
- **Re-anchoring before the gate.** A revision-shaped message anchored to a *pre*-delivery job is
  re-pointed at `mostRecentDeliveredIsh(clientId)` — unless the brain explicitly picked the
  project, or the client literally named that street. Without this *"the revision silently
  degrades to an activity line on the wrong project (audit crack #33's silent-loss class)."*
  Only `DELIVERED / REVISION / REVIEW` (`DELIVERED_ISH`) actually raise a revision; on an
  in-flight job the same ask becomes a `SPECIAL_REQUEST` activity with no status churn.

The resulting task is a `client_reply` `SmartTask` (`createCommTask`, `src/lib/tasks.ts:374`),
deduped **one per (client, order)** — the key is `sha1(clientId|projectId||"noproject"|client_reply)`
truncated to 24 chars — so *"a multi-order client's questions stay separate, and replying about
one order won't close another's."* Due in 4h for a text, 1h for a call.

Note the entry condition: `recordClientCommunication` only runs for `isInboundText`. A matched
client's plain inbound **call** event never reaches the brain — it becomes a missed-call task
(below) or, once the transcript event lands, a voicemail.

#### The other inbound paths on the same webhook

| Path | Trigger | Result |
|---|---|---|
| **Missed call** | `call.completed`, incoming, status matches `/no[-\s]?answer\|missed\|unanswered\|declined\|rejected/` or `answeredAt === null && !(duration > 0)` | `createCommTask(kind: "missed_call")` — deduped onto the same `client_reply` key as a following voicemail |
| **Voicemail / transcript** | `call.transcript.completed` | Full transcript to `CommLog`; the **client's spoken words only** (lines with no `userId`) go through `recordClientCommunication(kind: "voicemail")`, source deliberately kept as `"openphone"` not `"openphone-call"` so the reply sweep picks it up |
| **Project instruction** | Inbound text from a *known non-client* (a photographer, a coordinator) that names an active project's street, and that project isn't the one the reply task already covers | `createProjectFollowupTask()` on that exact project + a `NOTE` activity. Routed through the brain first so it can merge or skip chatter |
| **Phone lead** | Inbound text/call from a number with no client match, not a teammate, not robo, not already routed to a project | `upsertPhoneLeadTask()` — one open HIGH `lead` task per number (`dedupeKey: lead-<10digits>`), Kyle owner, due +4h, Slack ping + in-app bell. A later voicemail *upgrades* the open task's summary with what the caller actually said |

---

### Inbound: email (Gmail poll)

Gmail has no push, so `syncGmail()` (`src/lib/integrations/google.ts`) runs from the comms cron
every 5 minutes (`vercel.json`: `/api/cron/gmail`, `*/5 * * * *`). Per mailbox it pages
`in:inbox newer_than:3d -from:me`, up to 6 pages × 50 = ~300 messages/run.

Key behaviours verified in the code:

- **`format=full`, not metadata.** The comment records the bug: the old metadata fetch fed the
  ~200-char HTML-encoded snippet to the classifier, the AI triage *and the task text itself* —
  *"tasks showed '&#39;' artifacts, quotes cut mid-word, and the brain literally couldn't see
  what the client asked for past the first two sentences."*
- **Own words only.** `stripQuotedReply()` (`src/lib/text.ts:68`) removes quoted history while
  **preserving inline and bottom-posted replies**, and falls back to the full body when
  stripping leaves nothing — because *"a short head ('Perfect!') IS the message"*, and replacing
  it with quoted history *"fed our own outbound text to the revision classifier and flipped
  delivered jobs on praise replies."*
- **Durability.** The `WebhookEvent` dedupe row starts `RECEIVED` and is only stamped
  `PROCESSED` after the message is handled; the old stamp-first order meant *"a crash or timeout
  mid-message permanently ate that email."* One bad message marks its own row `ERROR` and the
  scan continues.
- **Human filter.** `isLikelyHuman()` rejects `List-Unsubscribe` mail, automated local-parts
  (`noreply|billing|invoice|orders|support|team|hello|info|…`), our own `realtourpilot.com`,
  a 32-domain `VENDOR_DOMAINS` list, `zapiermail.com`, vendor brand names
  (`autohdr|cubicasa|matterport|aryeo`), and receipt/marketing subjects. **A sender already
  matched to a client bypasses the filter entirely** so a known agent emailing from a brokerage
  `info@`/`team@` role address is never dropped.
- **No `category:primary`.** The comment warns not to add it: these are Workspace mailboxes with
  no tabbed-inbox categories, so *"that operator matches zero messages and silently drops
  everything."*
- **Which listing.** Sender's own orders by street first; a **global** street match is allowed
  only when the sender is unknown or the match is their own listing — never reassigning a known
  sender's mail to another client, because the town *"West Chester" inside "1244 West Chester
  Pike"* would hijack it. With no street named, a revision-shaped email anchors to
  `mostRecentDeliveredIsh()` instead of `mostRelevantProject()`, for the same DELIVERED_ISH-gate
  reason as the text path.
- **Vendor routing.** Luma Visuals (the premium-reel video editor) gets its own branch: only
  "edit finished" and "message from the editor" become tasks. Acks of our own submissions do
  nothing — the comment records that *"the old handler even raised a REVISION off Luma's
  revision-received ack — us asking Luma for a fix boomeranged into an urgent task at us."*
- **Already answered.** `threadAlreadyAnswered()` suppresses *task creation* but **not** revision
  detection: a *"can you brighten the kitchen"* that Kyle answered from his phone before the scan
  used to skip classification entirely, so the project never flipped to `REVISION` (audit crack
  #33).
- **Reply sweep.** At the end of every run, open `gmail`-sourced tasks whose thread we've since
  answered are closed.

---

### Inbound: Slack

Two paths, sharing one dedupe scheme (`externalId = slack-<channel>-<ts>`):

**Real-time webhook** — `POST /api/webhooks/slack`. HMAC-SHA256 over `v0:<ts>:<raw>` with
`SLACK_SIGNING_SECRET`, 300-second replay guard, `timingSafeEqual`. Handles the
`url_verification` challenge before the signature check. Skips `bot_id` and any `subtype`
(edits/joins). Text is decoded with `resolveSlackText()` **before** storing, because *"the
externalId dedupe makes whatever this path writes permanent (the hourly cron can never
overwrite it clean)."*

**User-token backfill** — `syncSlackHistory()` (`src/lib/integrations/slackSync.ts`), called
from the same 5-minute comms cron with `sinceHours: 2`. A user token can't receive webhooks, so
this pulls: channels matching `/video-editing|project-tracker|photo-editing/i` (ADMIN tier),
Jordan's DMs with Kyle / Kim / Remar (OWNER tier), and group DMs (OWNER tier). Rate-limit aware
(4 attempts with backoff on `ratelimited`).

`maybeCreateSlackTask()` turns a message into an `internal_instruction` task (`dedupeKey:
slack-<ts>`, due +6h) only when it is ≥6 chars, passes `INSTRUCTION_RE`, and fails `IGNORE_RE`,
and carries a **4-day recency guard** — *"This is
what stopped a Sep conversation from being resurrected in June."* Tasks land unassigned on
Kyle, deliberately: *"Keyword auto-routing mis-fired constantly: any message mentioning
'reel'/'video'/'social' got shoved at Remar/Kim even when it wasn't theirs."* Only messages
`logComm` reports as genuinely new (`created === true`) become tasks, so backfilled history
can't re-trigger.

---

### The Reply Queue (`?tab=replies`)

**What it does for the business:** it shows every text somebody sent us that nobody has
answered yet, oldest first, each with a reply already written and ready to read. Kyle can also
type what he *wants* to say in plain words and get it back written properly.

`src/lib/replyQueue.ts` opens with Jordan's own brief: *"a generate response engine for Kyle so
he can have responses generated to all inbound text messages, and then give him the ability to
explain what he wants to say to be able to tailor the message."*

#### Built on `CommLog`, not on tasks — and why

The header states the reason outright:

> *Built on CommLog rather than on open reply TASKS, deliberately. A task only exists when the
> sender matched a client; the 30-day comms review found a large share of inbound texts come
> from people we haven't matched (a new lead, an assistant on someone's team, a number that
> never got saved). Those are exactly the ones that go unanswered, so a queue that can't see
> them misses the problem it exists to solve.*

The second consequence is self-clearing state:

> *A conversation is "waiting" when its newest text is INBOUND. That single rule is
> self-clearing: the moment we send, the outbound row lands and the card leaves the queue.
> Nothing to tick off, nothing to go stale.*

#### Mechanics

- `WINDOW_DAYS = 21` (*"older than this and a reply isn't a reply any more"*), `SCAN_CAP = 1200`
  rows (*"~3 weeks of texts sits well under this"*), `THREAD_TURNS = 24` turns per card for the AI.
- Query: `channel: "text"`, in-window, `minRole` in the viewer's allowed tiers, newest-first.
- **Grouping:** `c:<clientId>` → `p:<10-digit phone>` → `n:<contactName>`. Client id is preferred
  *"so a client texting from a second number is ONE conversation."* A row with none of the three
  is skipped — *"an untraceable row can't be replied to — don't fake a card."*
- **Waiting** = `bucket.rows[0].direction === "in"`.
- Three batched enrichment lookups (clients, team members, open `client_reply` tasks) rather than
  per-card queries. `TeamMember` is loaded with **no phone filter** — *"the name set has to cover
  teammates whose number we don't hold, or they read as strangers in the queue."*
- Sorted **longest wait first**: *"The message that's been sitting two days is the one that costs
  us a client, not the one that came in ten minutes ago."*

#### The courtesy-closer split

`looksHandled()` moves conversations whose last inbound is a pure closer ("Thank you!", "Copy
that") into a collapsed `handled` list under the queue. The rationale is about trust:

> *Left in the main queue they're most of the list, and a queue that's mostly noise is one Kyle
> stops trusting: he drafts ten, five come back "nothing to answer", and the screen has taught
> him to ignore it.*

It is deliberately conservative — anything with a `?`, any digit (a time, an address, a price),
anything over 90 chars, or any of a list of action words (`can|could|would|when|need|send|fix|
reschedul|cancel|confirm|still|waiting|…`) falls through to the real queue, because *"a false
'needs an answer' costs a click, a false 'handled' costs a client."*

#### Cheap summary for the badges

`replyWaitingSummary()` runs the same grouping rule with only the fields that rule needs and no
enrichment — the dashboard, the Tasks header and the other comms tabs all read it. It returns
`{ count, oldestHours }` because *"seven unanswered is a queue, one of them sitting three days
is a problem."* It applies the **same** `looksHandled` split as the tab, so *"a badge must never
claim work the tab then files under 'probably done'."*

Surfaces reading it: `src/app/page.tsx` (owner dashboard `CountChip`, turns danger red at ≥24h),
`src/app/tasks/page.tsx` → `src/components/tasks/UnansweredPill.tsx`, and the tab strip itself.
The pill's comment: *"Kyle's day starts on /tasks, and the reply queue is the one pile that
lives somewhere else. Without this he has to remember to go looking for it."*

#### The card (`src/components/comms/ReplyQueue.tsx`)

Who it is (client / **our team** / **not a saved client** chip + segment badge), how long they've
waited (green <4h, amber ≥4h, red ≥24h), the message itself, an expandable full conversation,
the draft in an editable textarea, the tailoring box, and Send. Filters: `Everyone` / `Clients
only`. **Draft all N** generates every visible draft in one pass.

---

### Draft-then-send, and the house rules baked into the prompt

Nothing in the reply queue sends on its own. `replyActions.ts` says so twice — on
`generateReply` (*"DRAFT ONLY. Nothing here sends anything."*) and on `sendReply` (*"A HUMAN
clicks this — nothing in the reply queue ever sends on its own, which is the same rule every
other client-facing message in the hub follows."*).

#### What the draft is given (`draftFor`, `replyActions.ts:40`)

- The last 24 turns of the real conversation, oldest first.
- The client's last 6 jobs with stage.
- Their `segment` and `socialPlan` (VIP / heavy / regular / … via `segmentLabel()`).
- **Real availability** — when `lastInbound + instruction` matches
  `/\b(availab|when can|what (day|days|time|times)|schedul|book|come out|opening|calendar|
  times? work|soonest|reschedul)\b/i`, `getSchedulingAvailability({limit: 6})`
  pulls actual open Aryeo shoot dates *"so the draft offers dates we can actually keep instead of
  inventing them."* A failure drafts without them rather than failing the whole generation.
- **Policies** — `relevantPolicies(ask)` (`src/lib/policies.ts`) scores the taught knowledge base
  by inverse document frequency so a rare discriminating word ("drone", "weather", "reschedule")
  outweighs a common one, with a floor for `fee`/`policy` rules. Scoped to `minRole` CREATIVE +
  ADMIN only: *"owner-only strategy, margins, and costs never go into a client reply."*
- A tone note when the counterpart is a teammate: *"This is one of our own team members, not a
  customer. Reply like a colleague."*

#### The rules in the prompt (`draftReplyWithContext`, `src/lib/integrations/ai.ts:288`)

Verbatim from the prompt body:

- **No vague timing** — *"NEVER say 'should be', 'shortly', 'soon', 'in a bit', 'as soon as
  possible' or any other vague timing. Every time you mention when something will happen, give a
  specific one ('by 6pm tonight', 'tomorrow morning', 'Thursday'). If you genuinely don't know
  the time, ask for it or say we'll confirm the exact time — do not fill the gap with a vague
  word."*
- **No internal reasons** — *"NEVER give the client an internal reason. Do not name a teammate,
  an editor, a vendor, or a mistake on our end ('the editor is behind', 'Kyle forgot', 'our
  photographer is running late'). State what WE will do and when. What went wrong inside the
  business is not the client's problem."*
- Spell the client's name exactly as in the profile, or don't use one.
- *"Write like a professional running a business, not a friend texting. No 'lol', no 'haha', no
  slang, no emoji."*
- Only facts present in the thread / profile / policies. No invented dates, prices, delivery
  times, fees, or commitments.
- Never promise a free reschedule, refund or waived fee unless a policy explicitly allows it; if
  a fee may apply, say so plainly and kindly.
- Only offer dates that appear in the supplied availability list.
- Absent an instruction, a message needing no reply returns exactly `NO_REPLY_NEEDED`.

#### Belt and braces on vague timing

The same regex is enforced **twice more**, outside the model:

```
/\b(should be|shortly|soon|asap|as soon as possible|in a bit|in a few|at some point|when it'?s ready)\b/i
```

- Server (`replyActions.ts:16`) — *"The model is told not to use them; this catches the cases
  where it does anyway, so the rule holds even on a bad generation."* A hit downgrades the
  success message to *"Draft ready — but it still has a vague time in it. Put a real one in
  before sending."*
- Client (`ReplyQueue.tsx:26`) — highlights live in the editor: *"so the habit is visible while
  it's being typed rather than a month later in a report."* The inline warning reads *"…doesn't
  tell them when. Put a real time in it — that's the one thing clients chase us about."*

The page comment ties both to evidence: *"The 30-day comms review found the two habits that
cost us: messages that go unanswered, and answers with no real time in them ('should be' was
the most used phrase). This tab attacks both."*

#### The "tell it what to say" tailoring loop

The textarea labelled **Tell it what to say** feeds `instruction` into the prompt. It is the
point of the feature (`replyActions.ts:20`): Kyle types *"tell her Saturday morning works but I
need the lockbox code"* and gets it back written properly with history, jobs, availability and
policies folded in. In the prompt the instruction is explicitly ranked above the model's own
reading:

> *Say exactly this, written properly in our voice. Their intent and every fact they give you
> (times, dates, answers, requests) are correct and OUTRANK your own read of the thread — they
> know things the transcript doesn't. Do not water it down, do not add commitments they didn't
> make, and do not refuse to say it. Still obey the agency policies above.*

With an instruction present, the `NO_REPLY_NEEDED` escape hatch is removed from the prompt
(*"We have decided to send something, so ALWAYS write a message"*), and the UI button flips from
*Write it* to *Rewrite it this way*.

#### Batch drafting

`generateAllReplies(keys)` builds the queue **once** for the whole batch (*"instead of
re-scanning three weeks of comms for every message it drafts"*) and runs `WAVE = 4` concurrent
generations — *"the AI provider rate-limits, and one 429 shouldn't take the other nine drafts
down with it."* Failures are reported per card (*"Couldn't draft this one — try it on its own."*).

#### The send

`sendReply(key, text)` → `requireAdmin()` → re-resolve the card (a conversation answered in the
meantime returns *"That conversation has already been answered."*) → `OpenPhone.sendMessage(from,
+1<phone>, body)`. Then it logs the outbound **itself** rather than waiting on the delivery
webhook:

> *The queue's "newest row is inbound" rule is what clears the card, so if the webhook is slow or
> drops the event the message would sit there looking unanswered and get sent twice.*

It stamps the row with the **same** `externalId` the webhook will use (`op-<message id>`), so
the `message.delivered` echo dedupes — *"Without that id the two rows are different records and
comms memory ends up holding every sent reply twice."* Then `closeReplyForOutbound()` and a
`Text sent: …` project activity.

---

### Every other outbound path (all draft-then-send)

| Surface | Action | Message source | Human gate | Logs to `CommLog`? |
|---|---|---|---|---|
| Replies tab | `sendReply` (`replyActions.ts`) | AI draft, editable | Send button | **Yes**, `op-<id>` |
| Outbox tab | `sendDraftText` (`src/app/tasks/sendAllActions.ts`) | `SmartTask.description`, editable | Send button per card | **No** (relies on the delivery webhook) |
| Tasks "send all" panel | `listDraftedTexts` + `sendDraftText` | **Re-rendered fresh** from `deliveryMessage()` / `confirmationMessage()` | tick-list + Send all | **No** |
| Thread / client chat | `sendThreadText` (`threadActions.ts`) | Typed, or `draftThreadReply` AI draft | Send button | **No** |
| `/shoot` status texts | `sendShootStatusText` (`src/app/shoot/actions.ts`) | `shootStatusText()` template, editable in a bottom sheet | Send sheet | **Yes**, direct `prisma.commLog.create` with `op-<id>` |
| `/shoot` free-form | `sendClientMessage` + `draftClientMessage` (AI polish) | Photographer's rough note, polished | Send sheet | **Yes** |
| Email reply on a task | `sendEmailReply` (`src/app/emailActions.ts`) | Human-written | Send button | **Yes**, `hub-send-<taskId>-<ts>` |
| Ask the Hub | `draft_client_message` (`src/lib/hubTools.ts`) | AI draft only — returns text, sends nothing | n/a | n/a |

#### The drafted client texts (Outbox)

`clientTextWhere()` (`src/lib/clientTexts.ts`) is **the** membership rule for confirmation +
delivery texts, and its comment is a direct record of a past failure:

> *Four surfaces show "today's client texts" … each used to carry its own inline copy of the
> filter, which is how they drifted apart (audit finding #44: the badge advertised texts the
> panel didn't show, and the batch could send what the panel had already filtered out).*

Its clauses, each with a stated reason:
- **No assignee filter, ever** — scoping to Kyle+delegates *"made assigned texts vanish from
  every screen (the finding-1 regression)."*
- **`dueAt: null` counts** — a confirmation on a job with no shoot date yet is real work.
- **`projectId` is required** — *"a projectless row can't even produce a message."*
- **Recency filter everywhere** — *"A month-late 'your content is ready' must never batch-send."*
- **Due by end of today (ET)** — computed by `etEndOfTodayUtc()`, which derives tomorrow's
  midnight through `etDayStartUtc` twice rather than adding 24h, because on DST days *"the
  boundary came out an hour short (or long) on every DST eve."*

Both surfaces warn before a stale confirmation, but they compute it differently and only one
carries the QC warning:

| Surface | Stale-confirmation rule | QC-open warning |
|---|---|---|
| Outbox panel (`ClientTextsPanel.tsx:45`) | `confirmation_text && (!dueAt \|\| dueAt < now)` | **Yes** — `warnQcOpen`, from a live query of that project's open QC-ish tasks |
| `/tasks` send-all batch (`sendAllActions.ts:97`) | `confirmation_text && (!dueAt \|\| !shootDate \|\| shootDate < now)` | **No** — `DraftedText` has no QC field at all |

The batch loads warned/blocked rows **unticked** (`checked: !blocked && !warnStale`) — *"'Confirming
your shoot at 10 AM' sent at 2pm reads insane."* A null `dueAt` is treated as unsendable-by-default
there too: *"the task minted before the shoot was scheduled, and the reconciler may not have caught
up."* The `/today` feed (`TodayFeed.tsx`) carries both warnings.

`sendDraftText` **atomically claims** the task (`updateMany … status notIn [COMPLETED,
CANCELLED]`) before texting, reverting on failure, *"so the batch panel racing the per-card Send
button (or a second tab) must never double-text the client."* `sendEmailReply` uses the same
claim-then-send pattern, except under `keepOpen: true` (a revision acknowledgement — the reply
goes out but the edit work stays open), where the only double-press guard is the button's busy
state.

#### Photographer status texts

`src/lib/statusTexts.ts` holds three templates (`on_my_way`, `arrived`, `complete`), written
*"in Jordan's voice (no em dashes, no emojis, warm + low-pressure), copy-paste ready. The
photographer reviews + edits before sending — these are the smart defaults, never auto-sent."*
`ShootScreen.tsx` opens a `SendSheet` prefilled with the rendered text; the edited string is
what actually goes out.

---

### Auto-close on outbound

Answering is the completion signal — nobody ticks a reply task off by hand.

**Real-time, on the OpenPhone webhook** (route.ts:225-243), for an outbound event *or* our own
group-thread echo (`fromUs && !isCall` — *"that's still us replying, so it closes the task too"*):

- `closeReplyForOutbound(clientId, text)` — infers the order from the text via
  `findClientProjectByText()`, else from the client's latest inbound `CommLog` row that carried a
  `projectId`. Then `closeReplyScoped()`: with a known order, close that one; without one, close
  **only** if the client has exactly ONE open reply task — *"so a generic 'thanks!' outbound
  can't silently clear an unrelated order's open question."*
- Any open `delivery_text` for that client is completed too, because *"Kyle often sends the 'your
  gallery is ready' text straight from his phone — that outbound text to a client with a queued
  delivery_text IS the delivery text (audit: delivery_texts were 36% of all overdue, only ever
  swept by a 7-day timer)."*
- An outbound **call** closes the callback only when it actually connected (`answeredAt` or
  `duration > 0`) — *"a no-answer leaves it open so we still try again."*
- **Phone leads** (no client match) get their own close: every external recipient of an outbound
  text or answered call clears an open `lead` task whose `dedupeKey`/`sourceDetail` contains that
  number — *"audit: phone-lead tasks could never auto-close."*

**Sweeps**, from the 5-minute comms cron (`src/app/api/cron/gmail/route.ts`):

- `sweepRepliedOpenPhoneTasks()` — for each open `client_reply` task, query that client's thread
  directly (*"don't scan the conversation list — it's capped/ordered and can miss older
  threads"*). If the newest message is outbound, close it. Clients with **more than one** open
  reply task are skipped: *"this phone-level sweep can't tell which order a reply addressed."*
- The Gmail reply sweep closes any `gmail-thread:`-sourced task whose thread we've since answered.

---

### Reply-SLA escalation

**What it does:** if a client texts and nobody answers, the system starts tapping people on the
shoulder — first Kyle, then Jordan.

`src/lib/commsSla.ts` exists because of a measured failure:

> *A 60-day audit found 13 client texts that NEVER got a reply, one of them a "call me quick…
> Help!!" that sat unanswered for 12 days. Nothing in the system escalated any of them.*

`sweepReplySla()` runs every 5 minutes as a step in the comms cron and **never throws** (*"a
broken escalation must not take down Gmail polling"*).

| Tier | Threshold | VIP threshold | Goes to |
|---|---|---|---|
| 1 | > 30 min | > 15 min | ADMIN bell + one Slack ops line (`opsAlert`) |
| 2 | > 2 h | > 1 h | **also** OWNER bell + urgent Slack (`notifyUrgent`) |

- VIP = `segment` in `{vip, heavy}` — checked on the client **and their `parent`**, because *"a
  folded assistant texts with the agent's urgency."*
- `SCAN_DAYS = 7` bounds the sweep — *"anything older is an audit problem, not a live page."*
- Business hours **8:00–19:00 ET** gate tier 1: *"a 2am text shouldn't page anyone at 2:05am."*
  Tier 2 never *leads* overnight — it fires after hours only when tier 1 already went out, so an
  18:30 tier-1 still escalates at 20:30 while a 2am text stays quiet until 08:00 then jumps
  straight to both tiers.
- Dedupe keys are `sla-1-<clientId>-<inboundISO>` / `sla-2-…`, so each tier fires exactly once per
  inbound message. `alreadySent()` probes the concrete `Notification` row (`<key>-0`) rather than
  relying on `notifyInApp`'s silent P2002 skip — *"Knowing freshness OURSELVES is what lets the
  Slack line fire only alongside a brand-new bell row."*
- Its own no-reply-needed filter (`needsReply`) stacks `isReaction` + `isPraiseOnly` (≤120 chars,
  praise, no `?`) + `isAckOnly` + a call-artifact regex. A prod probe drove this: *"without this
  filter the go-live sweep would page the owner over five closers and zero real waits."*
- Links go to `/clients/<id>` because *"client page hosts the comms thread (ClientChat)."*

---

### Identity: who is this number, and whose job is this?

| Helper | File | What it does |
|---|---|---|
| `phoneKey()` | `integrations/openphone.ts:452` | last 10 digits — the universal match key |
| `syncOpenPhoneContacts()` | `contacts.ts:23` | pulls every OpenPhone/HubSpot contact, resolves phone → email → **unique** name (ambiguous names map to `null` and are skipped) |
| `resolveClientByPhones()` | `contacts.ts:166` | client phones, then linked contacts' alternates; ranks candidates deterministically |
| `resolveSenderName()` | `contacts.ts:270` | TeamMember → Client → Contact; returns `{name, isTeam, clientId}` |
| `mostRelevantProject()` | `contacts.ts:102` | next upcoming shoot → newest active → newest overall. The old "most recent overall" rule *"pinned a client's new ask to a job delivered months ago"* (Jesse's Zillow ask on a 133-day-old delivery) |
| `mostRecentDeliveredIsh()` | `contacts.ts:128` | newest job that can actually *receive* a revision |
| `findClientProjectByText()` / `findActiveProjectByText()` / `findProjectByText()` | `contacts.ts` | street-core matching, whole-word only |

**Street matching** deliberately refuses to fall back to the bare last word: it *"is usually a
common word ('Market', 'Run', 'Way') that turns up in unrelated messages, and the old raw
substring test also matched 'market' inside 'marketing' — which once filed a note about one
client's video order onto a DIFFERENT client's 'E Market St' job."* Cores under 5 chars are
skipped; the longest match wins.

#### Group threads

- OpenPhone group texts arrive with `to` as one comma-joined string — `collectPhones()` splits it
  so every participant matches.
- Our own replies in a group echo back as *incoming* events from our line; `fromUs` reclassifies
  them as outbound, and they still close the reply task.
- The Inbox marks a conversation as a group when more than one participant isn't one of our
  numbers, and labels it with the resolved names.
- `loadClientGroupThreads()` (`threadActions.ts:29`) scans the 12 most recent conversation pages
  for threads with ≥2 non-our-line participants, one of whom is the client **or a folded
  teammate**. Our own OpenPhone numbers are dropped from the participant list; everything else is
  kept for fetch/send — including a contact mis-saved as "RealTour Pilot" — and only the display
  label filters those out, because *"OpenPhone matches a group conversation by its exact
  participants, so dropping any … returns 0 messages and would fork a new conversation on reply."*
  Capped at 8 threads; the client chat loads it in the background because it's slow.

#### Customer-team folding (`parentClientId`)

`syncAryeoCustomerTeams()` (`src/lib/integrations/aryeo.ts:1439`) reads Aryeo customer teams
(e.g. "The Jamie Achberger Group" = Jamie + Kelly + Ruthie as separate customer-users). Orders
live under the **agent**, identified as the member with the most orders. Every teammate with
**zero** orders of their own is folded under them via `parentClientId`; a co-agent with their
own orders is tagged with the team but stays standalone.

Downstream, `effectiveClientWithProject()` (`contacts.ts:142`) hops to the parent so an
assistant's text or email lands on the agent's order — *"that's where the projects live"* — while
`contactName` keeps the real human on the task card *"instead of showing the agent who never sent
anything."* The SLA sweep also reads the parent's segment for VIP timing.

#### Duplicate clients

`src/lib/clientDedupe.ts` merges on phone (last-10) **or** name+company together — *"so two
different agents who only share a brokerage are NOT collapsed together"* — via a tiny union-find.
Survivor = most projects, tie-break most recently updated. The surviving email is the one with
the most projects behind it; any other becomes `backupEmail`. The merge transaction re-points
`Project`, `SmartTask`, `Contact`, **`CommLog`**, and `Client.parentClientId`, then deletes the
losers *"first so their unique aryeoCustomerId frees up."* `mergeClientsById()` does the same for
a human-verified pair.

---

### Text hygiene

`src/lib/text.ts` exists because *"Inbound channels arrive dirty in channel-specific ways —
Gmail snippets/bodies are HTML-entity-encoded ('&#39;' apostrophes), Slack escapes &/</>,
Outlook mail carries zero-width BOMs — and the old mid-word .slice() caps left quotes ending
like 'can we make a few cha'."*

| Helper | Purpose |
|---|---|
| `decodeEntities` | numeric + named HTML entities |
| `stripInvisible` | zero-widths, word-joiner, BOM, soft hyphen |
| `cleanText` | one-call inbound cleanup |
| `clip(s, max)` | word-boundary cap with a real ellipsis; only backs up to a space when it doesn't eat >40% of the budget |
| `stripQuotedReply` | sender's own words only, preserving inline + bottom-posted replies |
| `stripMoneySentences` | drops sentences with `$`/`invoice`/`price`/`refund`/… — used when client text lands on an **EDITOR-visible** task, because *"creatives never see pricing"* |

Slack has its own resolver (`resolveSlackText`, `slackSync.ts:153`): unwrap `<@U…>` / `<#C…|name>`
/ `<url|label>` tokens **first**, then entity-decode — *"Without the decode, tasks read 'photos
&amp; video'."*

---

### Revisions raised from comms

`raiseRevision()` (`src/lib/comms.ts:285`) is where a client's *"can you brighten the kitchen"*
becomes real work. It flags the project (`revisionRequestedAt`, `revisionNote`), moves
`DELIVERED → REVISION` (a `REVIEW`/`REVISION` job keeps its stage), writes a `FLAG` activity, and
raises one URGENT `revision` task per project, `dueAt` = now (dedupe key =
`sha1(<projectId>|revision)` truncated to 24 chars — the same `dedupeKey()` helper every comms
task uses). The note is kept whole at `clip(note, 1500)` *"so the editor isn't guessing past
'can we make a few cha…'"*.

- **Editor routing is deterministic**, from the actual deliverable, not guessed from wording —
  but scoped by what the client *asked*: a `VIDEO_ASK` regex routes to the video lane, otherwise
  Kyle triages. `\bcut\b` is deliberately narrowed to named cuts (`rough/final/first/new cut`,
  `re-cut`) because *"'cut out the trash can' is a photo retouch ask and bare \bcut\b was
  misrouting those to the video editor on mixed jobs."*
- **A second ask appends**, it does not replace: *"overwriting description with only the newest
  message made earlier asks vanish from every editor-visible surface (audit)."* Only while the
  round is open — a task re-raised after completion starts a fresh list — and the appended log
  keeps its **last** 4000 chars when it outgrows the cap.
- **`assignedManually` survives a re-raise** — only the automatic routing suggestion is overwritten.
- **Money is scrubbed** from the editor-facing copy via `stripMoneySentences`; the full note stays
  on `revisionNote`/activity (admin surfaces).
- The checklist says *"Read the client's request below"* rather than pointing at Communications,
  because that *"pointed editors at a page their role can't open (audit crack #38)."*
- Slack + bell fire **only on a newly-raised** revision; a repeat text about an already-open one
  stays quiet. The editor bell row is added only for `TEAM_MEMBER_EDITOR_KEYS` (kim/remar — the
  ones with a channel + login) and its `href` is `/edit/<projectId>`, because *"`/projects`
  bounces the EDITOR role, and the Slack/SMS bridge ships whatever href this row has."*
- **QC is reopened too.** `reflectRevisionInQc(projectId, qcCategories, note)` reopens the job's
  QC task for the revised deliverable(s) and stamps the latest `QcRecord` with
  `reopenedByRevisionAt` + `revisionReason` — *"that bounce IS the QC-miss event the owner dial
  reads."* Best-effort; a failure never breaks the revision.

`resolveRevision()` clears the flag, returns a `REVISION` job to `DELIVERED`, and calls
`closeObsoleteTasks` — because the revision flow reopened the QC task and *"nothing could ever
close it … every revision left a permanently-overdue QC in Kyle's list (audit crack #22)."*

---

### Gotchas / known state

- **Two of the five outbound text paths never write to `CommLog`.** `sendDraftText`
  (`src/app/tasks/sendAllActions.ts`, used by the Outbox tab and the send-all panel) and
  `sendThreadText` (`threadActions.ts`, the Inbox thread + client chat) write only an `Activity`
  row. Those messages reach comms memory **only** if OpenPhone's `message.delivered` webhook
  fires and is accepted. Since the reply queue's entire clearing rule is *"newest row is
  inbound"*, a dropped or unregistered webhook leaves those conversations looking unanswered.
  `sendReply` and the `/shoot` actions do log directly (with the `op-<id>` stamp) — the three
  paths are inconsistent. The `/shoot` row is also thinner than `sendReply`'s: it writes no
  `fromPhone` (harmless only because it carries a `clientId`, which is what the queue groups on
  first) and it never calls `closeReplyForOutbound`, so a photographer answering a client from
  the shoot screen leaves any open reply task open.
- **The OpenPhone webhook fails OPEN when no token is stored.** `openPhoneRequestAuthorized`
  returns `true` if there is no `openphone_webhook` secret (`openphone.ts:433`, *"not yet
  activated — backward compatible"*). The signing is dormant until the webhook is re-registered
  via `registerOpenPhoneWebhooks`, which mints and stores the token. Until then, anyone who knows
  the URL can POST fake texts, which inject tasks, leads and revisions.
- **The Slack webhook fails CLOSED and is dead without `SLACK_SIGNING_SECRET`** — `verifySlack`
  returns `false` when the env var is empty, so every event 401s. The 5-minute user-token
  `syncSlackHistory` is the only Slack path that still works in that state.
- **The Outbox placeholder lies about empty drafts.** `ClientTextsList.tsx:142` shows *"No draft
  on this task — Send composes the message fresh from the job."* but `sendDraftText` returns
  `{ok:false, message:"Message is empty."}` on a blank body. The *other* surface (the `/tasks`
  send-all panel) genuinely does re-render from `deliveryMessage()`/`confirmationMessage()` — so
  the same task can show a stale stored draft in one place and a fresh one in the other.
- **The Email tab's copy is stale.** `emailThreads.ts` and `EmailThreadList.tsx` both state *"no
  gmail.send scope"* / *"Reply from Gmail"*, and the page subtitle says the same — yet
  `src/app/emailActions.ts` `sendEmailReply()` sends threaded Gmail replies today (from task
  cards, not from this tab). The scope really may be missing per mailbox, which is why
  `src/lib/gmailHealth.ts` exists (owner bell + reopenable `connection_fix` task, per-mailbox);
  an ADMIN who hits it is told *"Jordan's been pinged to reconnect it."*
- **`replyPulse()` is dormant.** `commsSla.ts:238` computes median / p90 / under-60-minute reply
  KPIs and its own comment says *"NOT wired anywhere yet; built for the future
  dashboard/digest."* Grep confirms no callers.
- **Dead reply-queue surface area.** `refreshReplyQueue()` (`replyActions.ts:199`) is exported
  with no importers. `ReplyCard.openTaskId` is populated but never read by the UI.
  `ReplyQueue.clientCount` / `teamCount` / `oldestHours` are computed but the page destructures
  only `{ cards, handled }`.
- **A group conversation replies 1:1.** `sendReply` sends to a single `+1<card.phone>`
  (`replyActions.ts:155`) and `CommLog` stores no participant list — answering a group thread
  from the Replies tab texts one person and forks a new conversation. The Inbox thread view
  (`sendThreadText`) is the only group-safe send path.
- **Three different "needs no reply" filters coexist and can disagree.**
  `comms.isReaction`, `replyQueue.looksHandled` (≤90 chars, ACK_ONLY), and
  `commsSla.needsReply` (`isPraiseOnly` ≤120 / `isAckOnly` ≤80 / call-artifact). The Replies
  count and the SLA escalation are computed by two of them, so a borderline message can be
  escalated to Jordan while sitting in the collapsed "probably need nothing" list.
- **Two hand-copied helpers.** `PRAISE_RE` in `commsSla.ts:28` duplicates the unexported
  `PRAISE_ONLY` in `comms.ts:50` — the comment says *"keep the two in sync"*, a standing drift
  hazard. `emailThreads.ts:58` likewise carries its own `decodeEntities` rather than importing
  the one in `src/lib/text.ts`; the two implementations already differ (the local one guards
  out-of-range codepoints, the shared one doesn't).
- **Every text is `minRole: ADMIN` by default.** The OpenPhone webhook never passes `minRole`, so
  no text row is ever `CREATIVE`-tier. A CREATIVE-tier viewer's reply queue and email tab return
  zero rows by construction — moot today, since `communications` is OWNER/ADMIN by default and
  Ask the Hub's `search_comms` refuses a CREATIVE caller outright (*"Client communication history
  is available to admin and owner roles only"*). Where the ladder actually bites is ADMIN vs
  OWNER: Jordan's Slack DMs, group DMs, and unknown-sender mail on `info@` are `OWNER`-only and
  invisible to Kyle everywhere.
- **An unrecognised automated sender becomes a lead.** The robo filter only fires when the number
  resolves to a *known* name (`robo = !fromUs && !!sender && AUTOMATED_SENDER_RE.test(sender.name)`).
  A new short code or unsaved automated number falls through to the lead path and mints a HIGH
  `lead` task for Kyle. The same regex also matches `real\s*tour`, so a contact saved as "RealTour
  Pilot" is treated as robo.
- **`sendEmailReply`'s `externalId` is not idempotent** — `hub-send-<taskId>-<Date.now()>`
  (`emailActions.ts:88`) is unique per call by construction, so a retried send double-logs.
  Contrast with the deliberate `op-<id>` sharing on the text path.
- **Email threads are grouped by normalized subject + counterpart, not by Gmail `threadId`.**
  `CommLog` doesn't store the thread id, so `emailThreads.ts` uses `normalizeSubject()` + person
  as *"the closest stable stand-in"*, and the "Open in Gmail" link is a **subject search**, not a
  thread deep link. Multi-mailbox duplicates (mail addressed to both `info@` and `hello@`) are
  collapsed by a heuristic: same direction + same first 200 chars within a 10-minute bucket.
- **The Inbox tab is the expensive one.** `recentOpenPhoneConversations()` defaults to 20 pages ×
  50 conversations on every render (`dynamic = "force-dynamic"`), then loads all clients with a
  phone, all contacts with phones, and all team members with phones, and matches in JS. The
  comment for the paging is real, though: OpenPhone's `/conversations` order is arbitrary, so a
  single page *"drops active threads (incl. group texts) from the inbox."*
- **`resolveClientByPhones` / `resolveSenderName` load whole tables per inbound event.**
  `prisma.client.findMany({where:{phone:{not:null}}})` with a JS filter — no phone index is used.
  Fine at current volume, but it runs on every webhook event.
- **`scanProjectCommsForRevision()` is effectively dead, and parses Activity strings.** It
  re-reads `Activity` rows whose `body` contains `"text:"` and splits on that literal
  (`comms.ts:511`), so it cannot see anything logged only to `CommLog`. Its one call site is
  `src/lib/projectStatus.ts:485`, inside `if (opts.full)` — and **no caller anywhere passes
  `{full: true}`** (`actions.ts`, `refreshActions.ts`, `connections/actions.ts`, the Aryeo
  webhook, `/api/cron/sync`, `/shoot`, `/upload` all pass `{projectId}` or nothing). The comment
  labels `full` *"one-time backfill; run locally"*. Treat this path as dormant.
- **The Team tab deep-links to `/projects/<id>` with no anchor** — the comment states plainly
  *"no #anchor exists for the messages section, so land on the page itself."* It is also
  read-only; posting/replying lives on the project page.
- **`sendDraftText` caps a text at 1200 characters**; `sendEmailReply` caps a reply at 20,000.
  Neither limit is surfaced in the UI until the send fails.

## 5. External integrations

The Hub is not the system of record for most of the business. Aryeo holds the orders, OpenPhone
holds the texts and calls, Dropbox holds the files, QuickBooks and Stripe hold the money, Google
holds the mail and calendar. The Hub's job is to pull all of that into one place, react to it, and
occasionally write a small amount back (a Frame.io project, a calendar block, a reply email, a
staff text). `src/lib/integrations/` holds 17 files: 14 are clients that talk to a real external
service (`aryeo`, `openphone`, `google`, `googleCalendar`, `googleDrive`, `slack`, `slackSync`,
`dropbox`, `frameio`, `ai`, `stripe`, `quickbooks`, `plaid`, `scripting`); the other three
(`registry`, `connections`, `crypto`) are the plumbing they share.

Two rules run through every integration and are worth reading before the per-provider detail:

1. **Credentials never live in source.** App-level identity (OAuth client id/secret) lives in
   Vercel env vars. Per-account tokens live encrypted in a `Connection` row in the database.
2. **Where a webhook drives system state, the payload is not trusted.** Aryeo, Frame.io and Script
   Studio all re-fetch the authoritative record from the provider's API before acting on it — which
   is precisely why Aryeo's signature check can safely be optional. The two *content* receivers are
   the exception and have to be: OpenPhone and Slack take the message text straight off the payload
   (there is nothing else to fetch), which is why their auth — a `?t=` shared secret and a v0 HMAC —
   is what actually protects the task pipeline from spoofed messages.

### The shared connection framework

Every service the Hub can connect to is described once, in one file, and the Connections page is
generated from that list. When Jordan pastes an API key it is encrypted before it touches the
database, and the plaintext is never sent back to a browser.

#### The catalogue — `src/lib/integrations/registry.ts`

`PROVIDERS` is an array of 13 `ProviderDef` records that drives `/connections` entirely: name,
blurb, `segment` (Operations · Communication · Finance · Files · Marketing), `authType`
(`"apikey"` = paste a secret, `"oauth"` = redirect flow), lucide icon name, brand colour, the
`keyLabel`/`keyHelp` shown next to the paste field, `capabilities` bullets, and a `ready` flag for
"we have actually built this". Three entries are `ready: false` and have no client code at all:
`hubspot`, `messenger`, `sendgrid`.

#### Credential storage — `connections.ts` + `crypto.ts` + the `Connection` model

`src/lib/integrations/connections.ts` is the only layer that touches secrets. It exposes
`getConnection` / `getAllConnections` / `getSecret` / `saveSecret` / `markError` / `markSynced` /
`disconnect`, all keyed on the unique `Connection.provider` string. `getSecret` returns `null`
rather than throwing when decryption fails, so a rotated `APP_SECRET` degrades to "not connected"
instead of a 500.

`src/lib/integrations/crypto.ts` is AES-256-GCM. The master key is `sha256(process.env.APP_SECRET)`,
so any length of secret works. Blobs are stored as `ivHex:tagHex:cipherHex`. There is a committed
dev fallback key (`rtp-dev-only-secret-change-me-please-32xx`), and the guard around it is
deliberately wider than `NODE_ENV`:

> Require a real key on ANY deployed environment (Vercel sets VERCEL), not only
> `NODE_ENV=production` — otherwise a preview/staging deploy would silently encrypt real
> integration tokens with the committed dev fallback key.

`Connection` (`prisma/schema.prisma:787`) carries `provider` (unique), `status`
(`DISCONNECTED | CONNECTED | ERROR`), `secretEncrypted`, `accountLabel`, `metadata` (a JSON
string used as per-provider scratch space — Stripe's sync cursor, QuickBooks' `realmId`, Plaid's
`clientId`), `lastSyncedAt`, `lastError`, and `webhookSecret`.

Not every `Connection` row is a registry card. Four are internal slots the Connections page never
renders as their own card:

| provider row | in `PROVIDERS`? | what it holds |
| --- | --- | --- |
| `frameio_app` | no | the Adobe OAuth **client secret**, pasted in-app so the owner never touches Vercel |
| `frameio_webhook` | no | shared-secret token embedded in the Frame.io custom-action URL |
| `openphone_webhook` | no | shared-secret token embedded in the OpenPhone webhook URL |
| `plaid` | no | Plaid app secret; `metadata` holds `clientId` + `env`. Surfaced instead as a link tile to `/connections/banks` |
| `gmail` | yes | encrypted JSON map `{ email: refreshToken }` — one token per mailbox, not a bare secret |
| `slack_user` | yes (its own card, "Slack (read history)") | Slack user OAuth token (`xoxp-`), separate from the bot token |
| `quickbooks` | yes | Intuit refresh token; `metadata` holds `realmId` + `env` |

#### Inbound events — `WebhookEvent` + `src/lib/webhookRetry.ts`

Every receiver writes a `WebhookEvent` row (`provider`, `eventType`, `externalId`, raw `payload`,
`status`, `error`, `processedAt`; indexed on `provider` and `externalId`). The schema comment lists
`RECEIVED | PROCESSED | ERROR`; the code also writes `REJECTED` (signature failures) and `FAILED`
(terminal after retry). Rejections are counted separately by `webhookHealthByProvider(days = 7)`,
which exists because *"765 bounced Aryeo events ran silent for 13 days while the page stayed green
(audit crack #7)."*

`retryFailedWebhooks(limit = 25)` runs on the hourly cron. It takes `status: "ERROR"` rows from the
last 24 hours and re-runs the *same* processor the route used, via `dispatch()` re-importing
`processOpenPhoneEvent` / `processAryeoEvent` / `processSlackEvent` / `processFrameioEvent` /
`processScriptingEvent`. Success → `PROCESSED`; still failing → `FAILED`, which stays visible in
the Connections error count until the 30-day purge. Gmail rows are explicitly excluded:

> Gmail rows are excluded: they can't be re-dispatched from the stored payload (it's just a
> snippet) — the gmail cron re-scans the inbox and retries any non-PROCESSED row itself.

Every receiver returns HTTP 200 even on a processing failure, on the reasoning that the provider's
retries do not help but ours do.

#### Scheduled pulls — `vercel.json`

| path | schedule | what it drives |
| --- | --- | --- |
| `/api/cron/gmail` | `*/5 * * * *` | Gmail scan, OpenPhone replied-task sweep, Slack history (2h window), reply-SLA escalation |
| `/api/cron/sync` | `0 * * * *` | Aryeo orders (incremental) + appointments (21d), status engine, undelivered-photos sweep, task generation, webhook retry, Frame.io project sweep |
| `/api/cron/daily` | `0 8 * * *` (UTC → ~4am ET) | 21 steps: Stripe, QuickBooks + classify, Plaid + categorize, photo counts, full Aryeo client/dedupe/segment/social/team/appointment reconciles, stale-task retirement, 30/90-day log trims, client-profile refresh, `ordersFullReconcile`, Plaid error retry, shoot-focus summaries, package margins, growth plan |

All three fail **closed**: `if (!secret && enforced) return 401` where `enforced` is
`NODE_ENV === "production" || Boolean(VERCEL)` — "losing an env var never fails open". Each uses
`cronBudget(...)` so a slow step degrades to `skipped` (reported on `/connections`) rather than
being hard-killed mid-write: `maxDuration` 120s / 300s / 300s with budgets of 100,000 / 250,000 /
250,000 ms (~20s and ~50s of headroom).

---

### Aryeo — orders, listings, appointments, media

Aryeo is where clients actually place orders, and it is the single most important upstream system:
almost every project, client, shoot date and deliverable in the Hub originated as an Aryeo order.
The Hub reads Aryeo constantly and writes almost nothing back to it.

**Client:** `src/lib/integrations/aryeo.ts` (2,118 lines) · **Base:** `https://api.aryeo.com/v1`

#### Auth

A single **group-level API key** as `Authorization: Bearer {key}`. From the registry's own help
text: *"In Aryeo: Group Settings → Developers → API Keys → Generate."* This is vendor-level auth —
**there is no per-customer OAuth anywhere in the codebase**. One key sees the whole RealTour Pilot
Aryeo group; the Hub cannot act as, or on behalf of, an individual agent. The key is stored
encrypted as the `aryeo` connection. `testAryeoKey()` validates it by fetching one order
(`/orders?page=1&per_page=1`) and returns the generic label `"Aryeo account"` — it never asks
Aryeo who the account is, even though a `/me` helper exists.

#### Transport

`aryeoRequest()` is generic so any endpoint is reachable. It carries a hard 12-second
`AbortController` timeout (*"an un-timed media fetch was holding workers open and OOM-ing the
instance"*), and retries **GETs only**, up to 3 attempts, on 5xx or timeout with `attempt * 1000`
backoff — *"Aryeo throws transient timeouts/5xxs routinely … Writes are never retried."* A timeout
surfaces as `AryeoError` with status 504. `fetchAll()` walks Laravel-style
`{ data, meta: { current_page, last_page } }` pages at `per_page: 50`, capped at 200 pages.

Money is always integer cents on the wire; `money()` divides by 100 on the way in.
`ORDER_INCLUDES = "customer,items,appointments,listing"`,
`LISTING_INCLUDES = "images,videos,floor_plans,interactive_content,files"`.
`ARYEO_MIN_DATE = 2021-01-01` — the full order history is imported so lifetime spend and client
segments are accurate; the pipeline applies its own recency window for display.

#### Endpoints wired vs. actually used

| wired in the `Aryeo` client | used today? |
| --- | --- |
| `orders`, `order` | yes — the main sync |
| `createOrder` (POST /orders) | **no callers anywhere** |
| `listing` (with media includes) | yes — `getListingMedia()` for the project gallery |
| `listings` | no callers |
| `appointments`, `appointment` | yes |
| `rescheduleAppointment`, `cancelAppointment` (PUT) | yes — `AppointmentManager` → `src/app/actions.ts:65,100`, the only real writes to Aryeo |
| `scheduling/available-dates` | yes — `getSchedulingAvailability()`, 3 callers (`src/app/actions.ts`, `clients/actions.ts`, `communications/replyActions.ts` — all drafting "when can you come out?" replies) |
| `scheduling/available-timeslots` | no callers |
| `products` | yes — service catalogue (`product` singular has no callers) |
| `customerUsers` | yes — client enrichment + full roster import (in-file only; `customerUser` singular has no callers) |
| `companyTeamMembers` | yes — team roster (in-file only) |
| `orderForms` | yes — one caller, `src/app/resources/page.tsx:49` |
| `users`, `me`, `tasks`, `activities`, `tags`, `groups`, `group` | no callers |
| `discounts`, `addresses` | no callers, and marked `(perm)` — they returned 401 for the current key |

#### Data in

`syncAryeoOrders(opts)` is the core. Incremental by default (orders come newest-first; it stops at
the first order already imported), `{ full: true }` sweeps everything (daily cron), `{ orderId }`
scopes the whole per-order body to one job for the "Refresh from Aryeo" button — deliberately
reusing the same code path *"instead of a parallel implementation that would drift"*.

Client identity resolution (`resolveClient`) is the most defended code in the file, because getting
it wrong mints duplicate clients and strands live jobs. The ladder is: `aryeoCustomerId` → primary
`email` → **phone + matching name** → **name + company** → **backupEmail + matching name**. Each
weaker signal carries a comment explaining the failure it prevents — *"two agents sharing an office
line must not get collapsed into one client"*, and backup addresses *"are often shared team
inboxes (that's how they got stashed), so a backup hit must be corroborated by the customer's
NAME."*

Other sync entry points: `syncAryeoProducts` (→ `Product`), `syncAryeoCustomers` (backfills
license #, brokerage, internal notes from `/customer-users` — the customer object embedded on an
order is a *group* and carries none of these; only fills EMPTY fields, never overwrites edits),
`syncAllAryeoClients` (full roster, adopts onto existing rows), `syncAryeoSocialPlans`,
`syncAryeoCustomerTeams` (folds assistants under their agent via `parentClientId`),
`syncAryeoTeam` (→ `TeamMember`, mapping `company_team_member.id`; deletes seed placeholders but
refuses to touch anyone with `jobPayOverrides` / `payoutAdjustments` / `mileageDays` /
`assignedAppointments` — *"a manually-paid member … has no photographer links, so without this
guard one 'Sync team' could silently erase pay overrides, adjustments, and Jordan's mileage
corrections"*), `syncAryeoAppointments({ recentOnlyDays, orderId })`.

#### Data out

Only two writes: appointment reschedule and appointment cancel, both from the project page, both
with an explicit `notify_customer` flag.

#### Webhook — `src/app/api/webhooks/aryeo/route.ts`

Signature verification is **optional and only runs when `Connection.webhookSecret` is set**:
HMAC-SHA256 over the raw body, header `Signature` (also accepting `x-aryeo-signature`,
`x-signature`, `aryeo-signature`), `sha256=` prefix stripped, `timingSafeEqual`. It is safe to
leave off *"because processAryeoEvent never trusts the payload's contents — it re-fetches the
authoritative record from Aryeo's API."* Rejections are logged as `eventType: "signature.rejected"`,
`status: "REJECTED"`, and `alertWebhookRejections("aryeo")` fires. Note the trigger is exact
equality (`n === REJECTION_ALERT_THRESHOLD`, which is `6`): it pings once as the 6th rejection of
the hour lands, deliberately using the hour bucket as its own rate limit rather than alerting on
every subsequent rejection.

`classifyAryeoPayload()` handles two shapes, and the comment records why:

> Aryeo's docs describe an ACTIVITY wrapper … but REAL deliveries (verified against stored
> WebhookEvent payloads, Jul 2026) are the FLAT RESOURCE itself … and appointment payloads carry no
> `object` key at all, just start_at/end_at/rescheduled_at/previous_start_at. The old parser only
> knew the wrapper shape, so every real event fell through unrouted … and was silently dropped.

Flat appointment payloads are detected by shape (`start_at` present plus one of `end_at` /
`duration` / `requires_confirmation`). Idempotency is applied **only** when a true activity id
exists — flat resource payloads deliberately reprocess every time, because deduping on the
*resource* id *"would skip every FUTURE event about the same order/appointment after the first one
processed."*

The 10 registered subscriptions, per the route comment: `ORDER_CREATED` / `FULFILLED` / `PAID`,
`LISTING_UPDATED`, `APPOINTMENT_SCHEDULED` / `ASSIGNED` / `RESCHEDULED` / `CANCELED`,
`CUSTOMER_CREATED` / `UPDATED`. Because flat payloads hide the verb, routing is by resource type
and every branch reconciles authoritative state (`syncAryeoOrders`, `syncProjectStatuses`,
`generateTasksForProject`, `syncClientSegments`).

**Aryeo has no media-upload webhook.** The hourly cron's `statuses` step exists precisely for that:
*"Aryeo has no media-upload webhook, so this is how a shoot's media gets detected → SHOT/REVIEW."*

#### Media proxy

`getListingMedia(listingId)` returns counts, cover, images (filtered on `display_in_gallery`),
videos and floor plans. Downloads go through `/api/media/download`, which allow-lists only
`aryeo.com`, `digitaloceanspaces.com`, `mux.com`, `cloudfront.net` over https —
*"prevents this route from becoming an open proxy / SSRF vector."*

**Current state:** LIVE, the busiest integration in the system.

---

### OpenPhone (Quo) — calls and texts

OpenPhone is the company phone line. Every inbound text and call lands in the Hub in real time,
gets matched to a client and a job, and becomes a reply task. Outbound client texts are always
drafted for a human to send; the only automated texts go to staff.

**Client:** `src/lib/integrations/openphone.ts` · **Base:** `https://api.openphone.com/v1`

#### Auth

API key stored encrypted as `openphone`. The key goes in the `Authorization` header **raw — no
`Bearer` prefix** (called out explicitly in the file header). `testOpenPhoneKey()` fetches
`/phone-numbers` and labels the connection with the first formatted number.

#### Endpoints

`/phone-numbers`, `/users`, `/contacts`, `/conversations`, `/messages` (GET + POST),
`/calls`, `/call-transcripts/{callId}`, `/webhooks`, `/webhooks/messages`, `/webhooks/calls`,
`/webhooks/call-transcripts`.

Two API quirks are documented in code. Participants must be passed as the array param
`participants[]`. And conversation listing is not sorted:

> CRITICAL: OpenPhone's /conversations endpoint does NOT sort by lastActivityAt (its native order
> is arbitrary), so a single page can omit a thread that's active today. We must page through and
> sort ourselves … Page size caps at 50.

`recentOpenPhoneConversations()` pages up to 20 times and sorts client-side;
`allOpenPhoneContacts()` pages up to 200 times.

#### Data in

Real-time via webhook; `callTranscriptText()` splits a transcript into the full text and the
*other party's* words only (`userId === null` marks the external speaker), which is what revision
detection scans. `sweepRepliedOpenPhoneTasks()` is the backstop for missed webhooks: it queries
each client's thread directly rather than scanning the conversation list, and closes the reply
task when the newest message is outbound. Clients with more than one open reply task are skipped —
*"this phone-level sweep can't tell which order a reply addressed."* Our own numbers are cached
10 minutes (`ourOpenPhoneNumberKeys`) so group-thread echoes aren't mistaken for client messages.

#### Data out

`OpenPhone.sendMessage(from, to, content, mediaUrls?)`. The policy is in the code:

> CLIENT texts are human-initiated only (a person clicks Send) — never auto-sent. Sole automated
> caller: the internal TEAM SMS bridge in notify.ts, which only ever texts TeamMember phones.

`src/lib/notify.ts` enforces that boundary in the function signature — `notifyStaffSms` accepts
TeamMember **ids**, never a raw phone string, *"because the one thing separating a staff text from
a client text in this codebase is which table the number came out of."* Staff texts carry a
`⚙️ RealTour Hub:` prefix, title + deep link only (never the body), and `withinTextingHours()` gates
them to `hour >= 7 && hour < 22` in the recipient's timezone (`DEFAULT_EDITOR_TZ` = Asia/Manila for
the editors; America/New_York otherwise). The bridge also refuses to text the company's own line —
per the file comment, Kyle's `TeamMember.phone` **is** the company OpenPhone number
`(215) 645-4889`, so a naive send would text the office from itself and echo back through the
inbound webhook as a fake client message. Each attempt returns an explicit outcome
(`sent | no-phone | own-line | quiet-hours | failed`), and anything unreached is relayed to Slack
via `opsAlert` — **except `quiet-hours`, which is filtered out of the relay set**, so an
out-of-hours staff alert reaches nobody by text or Slack.

`channelForEditor()` is the sibling path for `editor:<key>` targets: Slack DM when the roster
carries a `slackUserId`, else SMS to their TeamMember phone, else a loud `opsAlert` to relay by
hand — *"the old silent return meant editor-addressed work landed NOWHERE a human saw."*

#### Webhook — `src/app/api/webhooks/openphone/route.ts`

`registerOpenPhoneWebhooks(callbackUrl)` (fired by the "Enable real-time" button →
`enableOpenPhoneRealtime` in `src/app/connections/actions.ts`) mints a 24-byte hex token, saves it
as the `openphone_webhook` secret, appends it as `?t=`, deletes any existing hooks pointing at the
same base URL, then creates message + call hooks. The transcript hook is attempted separately and
allowed to fail (*"not every plan exposes it"*), and the action's success message says so.

Events: `MESSAGE_EVENTS = message.received, message.delivered`;
`CALL_EVENTS = call.completed, call.ringing, call.recording.completed`;
`TRANSCRIPT_EVENTS = call.transcript.completed`.

`openPhoneRequestAuthorized()` compares the `?t=` token constant-time — **and returns `true` when
no token is stored**, by design, *"so the pipeline keeps working until the webhook is
(re)registered with a token."*

**Current state:** LIVE.

---

### Google — Gmail, Calendar, Drive (one OAuth client, several jobs)

Google is three integrations wearing one credential: reading the two company inboxes into tasks,
writing focus blocks onto Jordan's calendar so Calendly can't double-book him, and reading Google
Meet / Gemini meeting notes out of Drive. All three are gated behind the same consent screen.

**Files:** `src/lib/integrations/google.ts` (1,010 lines), `googleCalendar.ts`, `googleDrive.ts`,
plus `src/lib/auth/google.ts` for login.

#### Auth and the two redirect URIs

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (env) back **both** flows:

| flow | file | redirect | scopes | token kept |
| --- | --- | --- | --- | --- |
| Login | `src/lib/auth/google.ts` | `/api/auth/callback/google` | `openid email profile`, `prompt=select_account` | none — id_token is decoded once for the verified email |
| Data | `src/lib/integrations/google.ts` | `/api/google/callback` | see below, `access_type=offline`, `prompt=consent` | refresh token, encrypted |

The login callback decodes the `id_token` payload without re-verifying its signature, and says why:
*"the id_token comes directly from Google's token endpoint over our server-side TLS request (not
from the user), so decoding its payload without re-verifying the signature is safe."* It then
checks the email against the `AppUser` allowlist — random Google accounts are denied.

#### Scopes declared vs. scopes actually granted

```
gmail.readonly · gmail.send · userinfo.email · calendar.events · drive.readonly
```

The comment above that list is the single most important operational fact in this section:

> ONE consent grants all of these. `gmail.send` has been declared here for a while but was never
> actually approved — the live tokens carry only `gmail.readonly` + `userinfo.email` — so the
> reconnect that fixes sending is the same reconnect that turns on the day planner's calendar
> blocking and the meeting-transcript reader. Adding scopes here changes nothing until the owner
> re-consents.

Because the declared list can lie, the Hub probes the **live token** rather than trusting it.
`googleScopeHealth()` and `gmailSendHealth()` call
`https://oauth2.googleapis.com/tokeninfo?access_token=…` and read back the granted `scope` string,
returning `canSend` / `canCalendar` / `canDrive` as `true | false | null` where `null` means the
check itself failed — *"the stored scope list can lie (the user can untick send on the consent
screen), the token can't."* The Connections page races that probe against a 4-second timeout so a
slow Google can't hold the page hostage.

#### One token per mailbox

The `gmail` connection secret is an encrypted **JSON map `{ email: refreshToken }`** — hello@ and
info@ are separate grants with separate tokens (`gmailAccounts()`; a bare string is tolerated as a
legacy single-token connection). `addGmailAccount()` merges a new token into the map and rewrites
`accountLabel` as `Gmail · ` + every mailbox address joined by `, `.

`ownerGoogleToken()` resolves **only** `info@realtourpilot.com` — the identity whose calendar and
Drive the Hub acts on — and *"deliberately does NOT fall back to another mailbox: writing a block
onto the wrong calendar is worse than writing none."*

#### Access-token caching

`accessTokenFor(refreshToken)` caches in an in-process `Map`, keyed by refresh token, TTL
`min(expires_in − 300s, 45min)`:

> Access tokens last an hour, so minting a fresh one for every single API call spends a network
> round trip to Google before every network round trip to Google. One page that reads the calendar
> twice paid for four.

`forgetGoogleToken()` drops an entry so a 401 retry re-mints.

#### Gmail — reading

`syncGmail()` (comms cron, every 5 minutes) queries
`in:inbox newer_than:3d -from:me`, `maxResults=50`, up to 6 pages (~300 messages/run). Two hard-won
notes sit on that query:

> do NOT add `category:primary` — these are Workspace mailboxes that don't use Gmail's tabbed-inbox
> categories, so that operator matches zero messages and silently drops everything.

> `format=full` so we read the MESSAGE, not the ~200-char HTML-encoded preview. The old metadata
> fetch fed the raw snippet to the classifier, the AI triage, and the task text itself — tasks
> showed `&#39;` artifacts, quotes cut mid-word, and the brain literally couldn't see what the
> client asked for past the first two sentences.

Dedupe rows are `WebhookEvent` rows with `provider: "gmail"`, `externalId: "<mailbox>:<msgId>"`.
The row is created `RECEIVED` and only stamped `PROCESSED` *after* the message is handled — the old
stamp-first order *"meant a crash or timeout mid-message permanently ate that email."*

Filtering (`isLikelyHuman`): any `List-Unsubscribe` header, an automated local-part
(`AUTOMATED_LOCAL`, ~43 alternatives: `noreply`, `billing`, `orders`, `alerts`, `support`, `team`,
`hello`, `info`, …), our own `realtourpilot.com` domain, the 32-entry `VENDOR_DOMAINS` list
(aryeo.com, dropbox.com, dropboxmail.com, stripe.com, intuit.com, quickbooks.com, calendly.com,
openphone.com, slack.com, anthropic.com, frame.io, matterport.com, cubicasa.com, autohdr.com,
venmo.com, canva.com, zoom.us …, matched on exact domain **or** subdomain), `zapiermail.com`,
`VENDOR_NAME_RE` (`autohdr|cubicasa|matterport|aryeo` in the sender name or local-part), and an
invoice/receipt/marketing subject regex. A
sender who is **already a known client** bypasses the filter entirely, so an agent mailing from
`team@brokerage.com` is never dropped.

`CLIENTS_ONLY_MAILBOXES = ["info@realtourpilot.com"]` — Jordan's personal account. Unknown senders
there are logged owner-only (`minRole: "OWNER"`) and create no lead task; hello@ still mints leads.

Luma Visuals (`lumavisuals.co` / `.com`, the premium-reel video editor) gets its own routing branch,
built after a real bug: *"The old handler even raised a REVISION off Luma's revision-received ack —
us asking Luma for a fix boomeranged into an urgent task at us."* Only "finished" and
"human editor wrote us" produce work; everything else is logged and dropped.

Other read paths: `clientEmailThreads()` (Gmail OR-group query `{from:a to:a …} newer_than:1y`),
`fetchGmailThread()` for the task full-view's original-conversation panel, and
`threadAlreadyAnswered()` — a cheap `format=metadata&metadataHeaders=From` read of the thread's last
message, used both to suppress a new reply task and to run the end-of-`syncGmail` sweep that closes
already-answered email tasks. It returns `false` on error, *"if we can't tell, don't suppress."*

#### Gmail — sending

`sendGmailReply()` loads the thread metadata, targets the newest message that is **not** from our
domain, builds a proper `In-Reply-To` / `References` / `Re:` MIME (subject RFC 2047 base64-encoded)
and posts to `users/me/messages/send` with the original `threadId`, so it lands inside the
conversation. It takes an `expectedTo` and aborts if the thread moved under the human who confirmed
it. A 403 is translated into *"Gmail can read but not send yet — reconnect Google in Connections"*
with `needsReconnect: true`. `notifyOwnerEmail()` does the same for platform notifications and, on
403, files a `reportGmailSendBroken` health record rather than vanishing — *"silently returning
false here left every owner notification vanishing with no trace (finding #41)."*

#### Google Calendar — `googleCalendar.ts`

Two design rules are stated up front:

> 1. We write to the PRIMARY calendar on purpose. Calendly reads that calendar to decide when
>    Jordan is bookable, so a block that lives anywhere else is decoration.
> 2. We only ever touch events WE created. Every hub-written event carries a private extended
>    property (`rtpTodoId`); update and delete refuse to act on anything without it.

`assertOurs()` re-reads the event before every write — *"Costs one extra request per write; the
alternative is a bug class where a stale id points at a real meeting and we delete it."*

`listCalendarEvents()` uses `singleEvents=true`, `orderBy=startTime`, `maxResults=100`, and drops
three row types that look like commitments but aren't: cancelled events, events the owner declined,
and `transparency: "transparent"` (free) events — *"Blocking work around a declined meeting is how
a plan quietly loses an hour a day."* Calendly's own padding events (titled
`[2-hour buffer before … event]`) are detected and treated as already-buffered.

Two 403-handling details matter and are duplicated in `googleDrive.ts`:

- **Scope failure vs. API-not-enabled are different problems.** Only
  `insufficient (authentication scopes|permission)` / `invalid credentials` (or a bodyless 403)
  raises `CalendarNotConnected`; anything else keeps Google's own wording, because
  *"API has not been used in project … or it is disabled"* means a switch in Cloud Console and
  *"sends you round the consent screen forever on a problem consent cannot fix."*
- **`calendarConnected()` probes the events collection, not the calendar resource**, because
  `calendar.events` grants exactly read/write on events and *"does NOT grant `Calendars.Get` or
  `CalendarList.List`. Checking either of those would report 'not connected' forever while blocking
  worked perfectly."*

#### Google Drive — `googleDrive.ts`

Reads Meet/Gemini meeting notes and nothing else. `drive.readonly` is broad, so the narrowing is in
the query, not the grant: Docs mimeType only, `'me' in owners`, `trashed = false`, a `createdTime`
window, and a name containing `Notes by Gemini` / `Transcript` / `transcript`.

`heldAtFromTitle()` parses the real meeting time out of the filename
(`… - 2026/08/03 15:57 EDT - Notes by Gemini`) because Drive's `createdTime` is when the notes were
*finalised* — *"on Jordan's files that runs about ninety minutes late, which would file a 4pm call
under 5:25pm and land every deadline a day out."* Only EDT/EST offsets are trusted; anything else
falls back rather than guessing. The query window is padded ±2 days and then re-filtered on meeting
time, so a call on the last day of a month isn't filed into the next one.
`readTranscript()` exports `mimeType=text/plain`.

**Current state:** Gmail reading LIVE. **Gmail sending, Calendar and Drive are all blocked on one
Google re-consent** — the code is written and reachable, the tokens just don't carry the scopes.

---

### Slack — notifications out, history in

Slack is both an alert channel (the Hub pings the team) and a memory source (the editing channels
and Jordan's DMs get read into the assistant's comms memory, and actionable messages become to-dos).

**Files:** `src/lib/integrations/slack.ts` (bot), `slackSync.ts` (user token + task creation),
`src/app/api/webhooks/slack/route.ts` (real-time events).

#### Two tokens, two jobs

| connection | token | why |
| --- | --- | --- |
| `slack` | Bot User OAuth `xoxb-` | `chat.postMessage`, `conversations.list`, `auth.test`. Needs the `chat:write` scope |
| `slack_user` | User OAuth `xoxp-` | reads channel + DM history — *"a bot token cannot read user-to-user DMs"* — and `users.list`, since *"the bot lacks users:read"* |

`testSlackKey` / `testSlackUserKey` reject the wrong prefix with a plain-English message before
calling Slack. `slackUserName()` caches the id→name map for an hour off the user token.

#### History sync — `syncSlackHistory({ sinceHours })`

Called from the comms cron with a 2-hour window (default 48). Pulls
`conversations.list` for channels (`public_channel,private_channel`, 500), IMs (400) and MPIMs
(100), then `conversations.history` at `limit: 200`, up to 12 pages, with a 4-attempt
rate-limit backoff (`(attempt + 1) * 1500 ms`). Scope is hard-coded:

- Channels matching `/video-editing|project-tracker|photo-editing/i` that the token is a member of → logged `minRole: "ADMIN"`
- DMs with `U07SCBTPDC7` (Kyle Smith), `U0ASP9C1WRK` (Kim), `U0B7WNGEH0D` (Remar) → `minRole: "OWNER"`
- All group DMs → `OWNER`
- `ME = "U07D2KJH1JP"` (Jordan) marks outbound direction

Idempotency is `logComm`'s `externalId = slack-<channel>-<ts>`, so overlapping windows are safe.
Only newly-created comm rows are offered to task creation, so a backfill can't resurrect old work.

#### Slack → to-do — `maybeCreateSlackTask`

Prefilters on `INSTRUCTION_RE` / `IGNORE_RE`, then a **recency guard**:

> never turn an OLD message into a task … if a history backfill … feeds us a months-old message,
> skip it. This is what stopped a Sep conversation from being resurrected in June.

(The threshold is 4 days.) It then routes through the thread-aware brain (`routeSlackTask`), which
can merge into an existing open Slack to-do, and falls back to `messageToTodo`. Deduped on
`slack-<ts>`. Tasks land on Kyle unassigned, and the comment says why keyword routing was removed:
*"any message mentioning 'reel'/'video'/'social' got shoved at Remar/Kim even when it wasn't
theirs."* `URGENT` priority also fires `notifyUrgent`.

#### Real-time events — `/api/webhooks/slack`

HMAC-SHA256 Slack v0 signing over `v0:{ts}:{raw}` with `SLACK_SIGNING_SECRET` (env), 300-second
replay guard, `timingSafeEqual`. It **fails closed**: `verifySlack` returns `false` when the secret
is unset, so every event 401s. The `url_verification` challenge is answered before the check. Bot
messages and subtypes are skipped. Text is decoded *before* storage
(`resolveSlackText` unwraps `<@U…>` / `<#C…|name>` / `<url|label>` tokens then decodes
`&lt; &gt; &amp;`) because *"the externalId dedupe makes whatever this path writes permanent (the
hourly cron can never overwrite it clean)"* — without it tasks read `photos &amp; video`.

#### Alert destination — `src/lib/notify.ts`

`SLACK_ALERT_CHANNEL` env wins; otherwise the first channel the bot is in matching
`/project-tracker|alert|ops|notif/i`; otherwise Kyle's DM. Cached one hour. `slackNotify()` never
throws — a failed ping can't break the calling flow.

**Current state:** LIVE both directions.

---

### Dropbox — the file system

Vercel's disk is wiped between invocations, so Dropbox *is* the Hub's filesystem: uploaded raws,
generated editor-brief PDFs, and the shoot folders the AutoHDR Zapier automation creates.

**Client:** `src/lib/integrations/dropbox.ts`

#### Auth

OAuth 2 with `token_access_type=offline`. `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` in env; the
long-lived **refresh token** is stored encrypted as `dropbox`, and access tokens (~4h) are minted
per call.

The connect flow is the **manual copy-paste code flow, not a redirect callback**:
`dropboxAuthorizeUrl()` sets no `redirect_uri`, the owner approves and copies the shown code into a
form, and `connectDropbox` (`src/app/connections/actions.ts`) exchanges it. There is no
`/api/dropbox/callback` route.

#### Team namespace

`pathRootHeader()` fetches `users/get_current_account` once and, if the account has a
`root_namespace_id`, sends `Dropbox-API-Path-Root: {".tag":"root","root":…}` on every subsequent
call — *"so file paths like /AutoHDR resolve against the team space (where the Zap creates folders)
rather than the user's personal home."* Cached at module level.

#### Endpoints

`users/get_current_account`, `files/create_folder_v2`, `files/list_folder` (+ `/continue`),
`files/upload` and `files/download` on `content.dropboxapi.com`, `files/delete_v2`,
`sharing/create_shared_link_with_settings`, `sharing/list_shared_links`.

Notable hardening: the JSON parse is guarded so *"a non-JSON edge/maintenance page (HTML 502, etc.)
must surface as a clean DropboxError, not an uncaught SyntaxError"*; `dropboxListFolder` is
paginated (50-page guard) because *"a 400-raw shoot folder exceeds one page and used to be silently
truncated, which under-counted photos (and photo-editing cost)"*; create-folder swallows
already-exists conflicts and delete swallows not-found, so both are idempotent.
`directLink()` rewrites `www.dropbox.com` → `dl.dropboxusercontent.com` and `dl=0` → `raw=1` so
OpenPhone can fetch an MMS attachment.

#### Path conventions

- `src/lib/storage.ts` — everything the app itself stores lives under `STORAGE_PREFIX = "/RealTour Pilot/Hub"`, and `/api/file` refuses any path outside it (`withinStorage`) *"so this endpoint can never be used to pull arbitrary files from the rest of the team's Dropbox."*
- `src/lib/dropboxFolders.ts` — mirrors the Zapier AutoHDR convention: `/AutoHDR/{Year}/{Quarter}/{Month}/{Street} ({Client})/` with `01-RAW-Photos · 02-RAW-Video · 04-Final-Photos · 05-Final-Video`. Year/month are computed in **Eastern time** via `Intl.DateTimeFormat`, because server time is UTC on Vercel and *"an ET evening shoot near a month/quarter boundary computed a DIFFERENT folder than the one the files actually live in, and every count read zero."*

Consumers: `projectStatus.ts` (file presence drives stage), `photoCount.ts` (AutoHDR cost),
`clientFolders.ts`, `upload/cullActions.ts`, `review/actions.ts`, `communications/threadActions.ts`
(MMS attachments).

**Current state:** LIVE.

---

### Frame.io — editor review on finished video

Editors upload the finished cut to a per-job Frame.io project; when they hit "Send to RealTour for
review" the job flips to Review and Kyle gets a task. This is the newest integration and the least
finished.

**Client:** `src/lib/integrations/frameio.ts` · **API:** `https://api.frame.io/v4` ·
**IMS:** `https://ims-na1.adobelogin.com`

#### Auth

Frame.io V4 is the Adobe era: OAuth via **Adobe IMS** (`/ims/authorize/v2`, `/ims/token/v3`), scopes
`openid,offline_access,profile,email,additional_info.roles`. `offline_access` is what yields the
refresh token, stored encrypted as `frameio`; access tokens are minted per call (no cache). Every
V4 request carries `api-version: 4.0` — *"the current stable version (per the published OpenAPI
spec — 'experimental' only exposes reads)."*

The credential split is unusual and deliberate: `FRAMEIO_CLIENT_ID` comes from env, but the **client
secret is pasted into the Connections page** and stored as the `frameio_app` connection (env
`FRAMEIO_CLIENT_SECRET` is a fallback) *"so the owner never touches Vercel."* `frameioConfigured()`
is true only once both exist.

Connect flow: `/api/frameio/connect` (owner-gated when `AUTH_ENFORCE === "true"`) sets a
`rtp_fio_state` CSRF cookie for 600s → Adobe → `/api/frameio/callback` verifies state and exchanges.

#### Endpoints

`/accounts`, `/accounts/{a}/workspaces`, `/accounts/{a}/workspaces/{w}/projects` (POST),
`/accounts/{a}/projects/{p}` (DELETE), `/accounts/{a}/workspaces/{w}/actions` (GET/POST/DELETE).
`frameioContext()` caches the first account + first workspace per warm instance.

#### Data out

`createFrameioProject(name)` creates a project named `"<street> — <Client Name>"` (250-char cap) and
stores `Project.frameioProjectId` / `frameioViewUrl`. It is reached three ways:
the manual button (`src/app/frameio/actions.ts:30`, calling `createFrameioProject` directly), the
upload-portal auto-create (`src/app/upload/actions.ts:286`, also direct), and the hourly cron sweep
`ensureFrameioProjectsForActiveVideoJobs(5)` → `ensureFrameioProjectForProject()`, which selects
`EDITING | REVIEW | REVISION` jobs with `frameioProjectId: null` and at least one `VIDEO` or
`SOCIAL_REEL` deliverable. Only the third path goes through the idempotent wrapper — see gotchas.

#### Custom action + receiver

`ensureReviewAction()` registers a workspace custom action with `event: "rtp.ready_for_review"`,
minting a 24-byte token into the `frameio_webhook` secret and embedding it as `?t=` on the callback
URL. It always deletes and recreates any existing action, because *"the list response doesn't
expose the URL, so we can't tell if it already has one."*

`/api/webhooks/frameio` checks that token (`frameioRequestAuthorized`, constant-time, **true when no
token is stored**), then either:
- **Comment payload** → `raiseRevision()` with `Frame.io review note: …`. This path only fires once a *comment* webhook is registered; the custom action alone does not send comment events.
- **Otherwise** → flip `SHOT | EDITING | REVISION` → `REVIEW` (never touching delivered/cancelled jobs), upsert task `frameio-review-<projectId>` on Kyle at HIGH priority, and bell the owner plus the in-house editor (`kim` / `remar` only — Luma is external and has no login).

It returns Frame.io-visible `{ title, description }` and always HTTP 200, with the failure branch
rewritten after an audit finding: the old version *"wrapped every write in `.catch(()=>{})`,
blanket-marked PROCESSED, and returned 'Sent ✓' regardless."*

**Current state:** OAuth and project creation code is LIVE; the review action is **dormant** — see
gotchas. Whether a Frame.io account is actually connected is a database fact, not a source fact.

---

### Anthropic (Claude) — the AI layer

Every AI feature in the Hub — drafted replies, message→to-do triage, Ask the Hub, client profiles,
the growth plan — runs through one file. Nothing it produces is ever sent to a client automatically.

**Client:** `src/lib/integrations/ai.ts` · **Endpoint:** `https://api.anthropic.com/v1/messages`

#### Auth

API key (`sk-ant-…`) stored encrypted as the `ai` connection, sent as `x-api-key` with
`anthropic-version: 2023-06-01`. `testAiKey()` sends a 5-token "ping". There are 24 `getSecret("ai")`
call sites (19 outside `ai.ts`, across 14 files) — every AI feature degrades to "not connected"
rather than failing.

#### Models

`FAST = "claude-haiku-4-5-20251001"` · `SMART = "claude-sonnet-4-6"`.

#### Transport

`callMessages()` retries 4 times with `attempt * 1200 ms` backoff on 429 / 529 / 5xx and network
errors; a persistent overload becomes *"The AI is briefly overloaded. Please try again in a moment."*
Non-retryable errors throw immediately.

Three shapes sit on top:
- `anthropic()` — one-shot text.
- `aiJson<T>()` — forces `tool_choice: { type: "tool", name: "emit" }` whose `input_schema` *is* the desired shape, *"so the model cannot answer with prose, a code fence, or a near-miss key name — the failure modes the regex-a-JSON-blob-out-of-the-text approach elsewhere in this file has to defend against."*
- `runHubAgent()` — the Ask the Hub agent loop: read-only data tools supplied by the caller, `maxSteps = 6`, `maxTokens = 1600` (raised for long reports), tool results truncated to 14,000 chars, with image / PDF / text attachment support.

#### House style

`STYLE` is a compact system prompt encoding Jordan's voice, with hard rules: no em dash or double
dash, no bold, no emojis, banned words/phrases ("hidden gem", "gem", "move the needle", "break the
mold", "deal breaker"), "investment" over "price", "fully committed" over "booked", "thank you for
your patience" over "sorry", "we" not "I". And a fabrication clamp:
*"NEVER invent specifics you were not given: do not make up dates, times, availability, prices,
fees, refunds, discounts, or delivery promises."* Full-email sign-off is
"In the Spirit of Success, Jordan Spackman".

Named helpers: `draftReply`, `polishOutbound`, `draftReplyWithContext`, `summarizeWorkday`,
`decideCommTask`, `decideSlackTask`, `summarizeShootFocus`, `summarizeHubConversation`,
`synthesizeClientProfile`, `messageToTodo`.

**Current state:** LIVE.

---

### Stripe — collected revenue, fee-accurate

Stripe knows exactly what was charged, what it netted after fees, and when it hit the bank. The Hub
reads that ledger and never writes to it.

**Client:** `src/lib/integrations/stripe.ts` · **Base:** `https://api.stripe.com/v1`

#### Auth

A **restricted, read-only key** (`rk_live_…`) as a Bearer token with `Stripe-Version: 2024-06-20`,
stored encrypted as `stripe`. The registry help text asks for READ on Balance, Balance transactions,
Charges and Payment intents. `testStripeKey()` proves the key with `/balance` and *tries*
`/account` for a nicer label, degrading cleanly because *"a restricted key may not"* be able to read
it.

#### Endpoints

`/balance` (the live cash hero, best-effort → `null`), `/account`, `/balance_transactions`,
`/transfers`.

#### Sync

`syncStripe({ fullDays? })` upserts `StripeTransaction` rows keyed on Stripe's own txn id
(gross / fee / net straight from `balance_transactions`, cents → dollars). The high-water mark
`lastTxnCreated` lives in `Connection.metadata`, with a 3-day overlap on each incremental run.
Two comments carry real incident history:

> BACKFILL: … Without this the cursor is a one-way ratchet — once set, the floor is always
> `lastTxnCreated`, so history EARLIER than the first run can never be reached. That is exactly how
> 2025 went missing.

> 100 rows/page. The old 40-page cap silently truncated at 4,000 rows, which a multi-year backfill
> blows straight through.

Incremental runs cap at 40 pages, a backfill at 400. `expand[]` is deliberately not used —
*"data.source expansion can 403 under a narrow restricted key; customerName enrichment isn't worth
failing the whole sync over."* A second pass over `/transfers` (60-day window, 5 pages) stamps
`destination` onto the matching balance-transaction rows, because balance transactions don't carry
who got paid; it is wrapped so it *"must never fail the sync."*

The sync gate is on `secretEncrypted` being present, **not** `status === "CONNECTED"` —
*"otherwise one transient ERROR would freeze sync forever (a later success never runs to clear the
error)."*

**Current state:** LIVE, daily cron (first step, deliberately — see gotchas).

---

### QuickBooks Online (Intuit) — the books

QuickBooks holds everything Stripe doesn't: revenue processed on other rails, and the entire expense
ledger. Until it was connected, every profit figure in the Hub was understated.

**Client:** `src/lib/integrations/quickbooks.ts`

#### Auth

Intuit OAuth 2. Scope is **`com.intuit.quickbooks.accounting` only** — *"We deliberately do NOT
request payments/payroll write."* Connect at `/api/quickbooks/connect` (owner-gated when
`AUTH_ENFORCE === "true"`, `rtp_qbo_state` CSRF cookie, 600s) → Intuit → `/api/quickbooks/callback`.

The callback also carries `realmId` (the company id), which Intuit sends **only there**, never in
the token body; a callback without it is a hard failure rather than a partial connect. It is stored
in `Connection.metadata` alongside `env`.

#### Two environments, one switch

`QBO_ENV=sandbox` selects `QBO_SANDBOX_CLIENT_ID/SECRET` + `sandbox-quickbooks.api.intuit.com`;
anything else selects `QBO_CLIENT_ID/SECRET` + `quickbooks.api.intuit.com`. `assertEnv()` refuses to
use a token minted in the other environment with an explicit 409, because
*"Without this you get a generic 401 that looks like a broken integration, when the real cause is
'QBO_ENV was flipped and nobody reconnected'."*

#### Refresh-token rotation

The most important line in the file:

> Intuit ROTATES the refresh token on most refreshes — if we don't persist the new one the
> connection silently dies in ~24h. That is the single most common way a QuickBooks integration
> breaks, so we always write it back.

#### Requests

All calls go through `qbo()` at `/v3/company/{realmId}/…` with `minorversion=70`. Failures capture
Intuit's `intuit_tid` correlation id into both the thrown message and `console.error` —
*"turns a support ticket from 'it failed sometime Tuesday' into a single lookup on their side."*
`qboQuery()` runs Intuit's SQL-ish query language and unwraps whichever array key `QueryResponse`
returned.

#### Data in

`syncQuickBooks({ sinceKey })` pages 200 rows at a time (`startposition` loop up to 4,000) over five
transaction types → `QboTransaction`:

| type | why it matters |
| --- | --- |
| `Invoice` | what we billed, including everything not in Stripe |
| `Payment` | cash actually received, any processor |
| `Purchase` | expenses — *"the half of the P&L the Hub has never seen"* |
| `SalesReceipt` | paid at point of sale (bundles, prepaid packages) — never appears as an Invoice |
| `Deposit` | *"the most important type … Everything ambiguous lives here"* — personal ...0942 transfers, Stripe payouts, Venmo, bank-feed twins |

`expenseAccount()` reads the expense category off the **line** — `AccountBasedExpenseLineDetail`
(or `ItemBasedExpenseLineDetail`'s `ItemRef`), taking the largest line when a purchase is split —
not the transaction's `AccountRef`, which is only used as a last-resort fallback:

> The TOP-LEVEL AccountRef on a Purchase is the account the money came OUT of ("Business Checking")
> — not what it was spent on. Using the top-level ref left 2,312 of 2,363 expenses uncategorised and
> hid the fact that over a thousand lines are coded to "Owner Draw".

`lineText()` flattens a deposit's lines + memo into one searchable string of raw bank-feed text
("ONLINE TRANSFER FROM XXXXX0942", "VENMO*…") — the only signal that separates an owner draw from
revenue. `linkedCount` counts lines carrying a `LinkedTxn`, distinguishing a real settlement from a
bare bank-feed line that would double-count a dollar.

`profitAndLoss(start, end)` pulls `/reports/ProfitAndLoss` with `accounting_method: "Cash"` and
walks the nested row tree for line items plus the `Total Income` / `Total Expenses` summaries.

Default sync window is 400 days; the daily cron narrows to 45 days and then runs `categoriseBooks`,
which **must** follow the sync because *"it persists the `category` that trueProfitAndLoss / the
Overview read."*

**Current state:** LIVE, read-only.

---

### Plaid — bank and card accounts (read-only)

Business QuickBooks only sees business checking plus Stripe, but real costs also run through
Jordan's personal account, personal Venmo, and a Capital One card with zero rows in the books.
Plaid reads those accounts so the money picture is complete. It cannot move money.

**Client:** `src/lib/integrations/plaid.ts` · **SDK:** the official `plaid` npm package ·
**UI:** `/connections/banks`

#### Auth

Two layers:
- **App credentials** — `client_id` in `Connection.metadata`, secret encrypted in the `plaid` connection, both entered by the owner in-app (*"same posture as the Stripe/Anthropic keys"*), with an `env` of `sandbox` or `production` selecting `PlaidEnvironments[env]`.
- **Per-bank access tokens** — obtained by exchanging the public token from Plaid Link and stored in `PlaidItem.accessTokenEncrypted` using the same AES-256-GCM helper.

The security posture is stated explicitly: *"Jordan authenticates each bank INSIDE Plaid Link
(Plaid's own hosted screen); the bank login never touches our server."*

#### Link + OAuth redirect

`createLinkToken()` requests `Products.Transactions`, `CountryCode.Us`, and
`transactions: { days_requested: 730 }` — *"so we capture the full picture, not just the default
90-day window."* `redirect_uri` is `{appBase}/connections/banks` and is **only sent on https
deploys** (Plaid rejects http/localhost); it must be registered in the Plaid dashboard for OAuth
banks such as Capital One and Chase.

#### Sync

`syncItem()` runs `/transactions/sync` with a stored cursor (up to 200 pages × 500 txns) and
applies `added` via `createMany({ skipDuplicates })`, `modified` per-row, `removed` via
`deleteMany`. Balances and the account list are refreshed first, which also picks up newly-shared
accounts.

`backfillItem(id, monthsBack = 24)` uses `/transactions/get` over an explicit window instead,
because:

> /transactions/sync delivers history in async batches and stops short on the initial connect (it
> left PNC at ~30 days while Plaid actually held 7,664).

`retryErroredPlaidItems()` re-runs `syncItem` for every `PlaidItem` still in `status: "ERROR"`:

> One daily sync used to be the only attempt an item got, so a single transient 429 froze it for a
> full day (PNC sat stuck 2 days on exactly this) … minutes after syncAllPlaid, comfortably past
> minute-scale rate limits.

Its comment claims it runs "as its LAST step" of the daily cron. That is now **stale**: it sits at
step 18 of 21, after `ordersFullReconcile` but before `shootFocusSummaries`, `packageMargins` and
`growthPlan`. The intent (a gap of minutes after `plaidSync`) still holds.

Disconnecting calls `itemRemove` at Plaid and deletes locally regardless of whether that succeeds.
The owner tags each account BUSINESS or PERSONAL (`PlaidAccount.isBusiness`) so the finance engine
can separate true business cost from owner draws; `categorizeAllPlaid` runs nightly and skips
hand-locked rows.

**Current state:** LIVE code path; whether real banks are linked depends on the Plaid production
keys and registered redirect URI being in place (not verifiable from source).

---

### Script Studio — Jordan's external script generator

Script Studio is a separate app Jordan owns that generates reel hooks and scripts and collects the
agent's intake. The Hub creates the Studio project, and pulls the finished hook / script / song back
into the job's reel recipe.

**Client:** `src/lib/integrations/scripting.ts` · **Base:** `{SCRIPTING_BASE_URL}/api/v1`

#### Auth

Pure env, no `Connection` row: `SCRIPTING_BASE_URL` + `SCRIPTING_API_KEY` (sent as
`Authorization: Bearer`), plus `SCRIPTING_WEBHOOK_SECRET` for inbound HMAC. The reasoning:
*"Config is pure env (like Google/Frame.io app creds) so a rotated key just works and nothing
sensitive ever lands in source or the DB."* `scriptingConfigured()` gates the UI panel and makes
every call a safe no-op until both are set.

#### Endpoints and direction of truth

| call | purpose |
| --- | --- |
| `POST /projects` | create (or dedupe to) a Studio project; `external_id` = the hub project id, `external_source: "ops-hub"` |
| `GET /projects/{hubId}?by=external_id` | full detail — the source of truth |
| `GET /projects?since=&limit=` | reconcile / "Test connection" |

> The hub is the single source of truth: it CREATES a Studio project … then reads the generated
> hooks/script back into the reel recipe. Inbound Studio webhooks are the fast-path; a GET is the
> source of truth.

The detail endpoint wraps the record as `{ project: {…} }` while list/create return it flat;
`unwrap()` normalises both. `studioToRecipe()` extracts hook (chosen, else the recommended option),
script markdown (`script.raw` / `raw_ai_output` / `markdown` / …), song (`script.song`, intake
answers, or a `SONG:` line inside the script) and the best link, and *"Only returns what it actually
found, so a partial payload never blanks existing recipe data."* `studioBestLink()` prefers
`creative_url` once `status` is in the 9-entry `READY_STATUSES` set (`hooks_proposed`, `generating`,
`awaiting_review`, `approved`, `sent_to_client`, `done`, `client_approved`,
`client_revision_requested`, `revising`), and `intake_url` before that; `admin_url` is the last
fallback.

Callers: `src/app/projects/scriptingActions.ts` — `testScriptingConnection` (read-only, *"no writes,
no emails"*, so verification doesn't trigger an agent intake email), `createScriptProject`,
`syncScriptFromStudio` — surfaced by `src/components/project/ScriptStudioCard.tsx`.

#### Webhook — `/api/webhooks/scripting`

HMAC-SHA256 over the raw body in `x-scripting-signature`, verified against
`SCRIPTING_WEBHOOK_SECRET` (which must equal `HUB_WEBHOOK_SECRET` on the Studio server), with the
`sha256=` prefix stripped and `timingSafeEqual`; verification is **skipped entirely when the env var
is unset**. Every event name is `project.`-prefixed: `project.created`, `.hooks_proposed`,
`.script_generated`, `.sent_to_client`, `.client_responded`, `.done`, `.updated`, `.deleted`. Six of
them (all but `created` and `deleted`) are the enrich set that re-fetches by `external_id` before
mirroring; `project.created` only writes the baseline `scriptingId` / `scriptingStatus` /
`scriptingUrl`.

`project.deleted` unlinks (`scriptingId/Status/Url` → null) but *"never delete the hub job."*
Studio-native projects (created inside Studio, no `external_id`) are skipped cleanly rather than
erroring forever into the retry loop; only an event carrying a hub id is a real linkage failure
worth retrying. Two nudge tasks (`scripting-script-<id>`, `scripting-client-<id>`) are opened and,
importantly, **closed** on status advance — *"each event used to only re-open the same key, so
nothing ever closed these tasks (audit crack #35)."*

**Current state:** wired both directions and env-configured; per project memory the connection test
and a signed webhook probe have both passed, but the field mapping is confirmed by the first real
sync (not verifiable from source).

---

### Unauthenticated / key-only endpoints outside the registry

These have no Connections card and no `Connection` row, but they are real external dependencies.

| service | where | used for |
| --- | --- | --- |
| Google Maps Street View | `src/lib/shoot.ts:479`, `/api/health/streetview` | property thumbnail on the shoot screen; `GOOGLE_MAPS_API_KEY` env. The health route exists to prove the key works against the Street View endpoint specifically |
| OSRM public router | `src/lib/travel.ts:41,73` | driving distance/time for mileage pay. Slow enough that the daily cron runs it — *"it took a 60s serverless function down in production"* |
| US Census geocoder | `src/lib/travel.ts:99` | address → lat/lng (primary) |
| Nominatim / OpenStreetMap | `src/lib/travel.ts:113,138` | geocoding fallback + address autocomplete |
| Open-Meteo | `src/lib/travel.ts:190` | shoot-day weather |
| FAA UAS Facility Map (ArcGIS) | `src/lib/faa.ts:14` | drone airspace ceiling per property |
| Esri World Imagery tiles | `ProjectMap.tsx`, `ShootRouteMap.tsx` | satellite basemap |
| Vimeo player | `/training` | embedded lesson videos |

---

### Summary table

| Service | Module | Auth | Credentials live in | Webhook | State |
| --- | --- | --- | --- | --- | --- |
| Aryeo | `aryeo.ts` | Vendor/group API key (Bearer) | `Connection` `aryeo` | `/api/webhooks/aryeo`, HMAC **only if `webhookSecret` set** | LIVE |
| OpenPhone | `openphone.ts` | API key, raw `Authorization` header | `Connection` `openphone` (+ `openphone_webhook` token) | `/api/webhooks/openphone`, `?t=` shared secret | LIVE |
| Gmail | `google.ts` | OAuth2 offline, per-mailbox refresh token | env client id/secret + `Connection` `gmail` (JSON map) | none (polled every 5 min) | Reading LIVE; **sending blocked on re-consent** |
| Google Calendar | `googleCalendar.ts` | same grant, `calendar.events` | via `ownerGoogleToken()` (info@ only) | none | **Blocked on re-consent** |
| Google Drive | `googleDrive.ts` | same grant, `drive.readonly` | via `ownerGoogleToken()` | none | **Blocked on re-consent** |
| Google login | `src/lib/auth/google.ts` | OAuth2, `openid email profile` | env client id/secret; no token kept | n/a | LIVE |
| Slack (bot) | `slack.ts` | Bot token `xoxb-` | `Connection` `slack` | `/api/webhooks/slack`, v0 HMAC, fails closed | LIVE |
| Slack (history) | `slackSync.ts` | User token `xoxp-` | `Connection` `slack_user` | n/a (polled) | LIVE |
| Dropbox | `dropbox.ts` | OAuth2 offline, manual code paste | env app key/secret + `Connection` `dropbox` | none | LIVE |
| Frame.io | `frameio.ts` | Adobe IMS OAuth, `api-version: 4.0` | env client id + `Connection` `frameio_app`, `frameio` | `/api/webhooks/frameio`, `?t=` token | Projects LIVE; **review action dormant** |
| Anthropic | `ai.ts` | API key `x-api-key` | `Connection` `ai` | n/a | LIVE |
| Stripe | `stripe.ts` | Restricted read key (Bearer) | `Connection` `stripe` | none (cursor sync) | LIVE |
| QuickBooks | `quickbooks.ts` | Intuit OAuth2, accounting scope | env client id/secret + `Connection` `quickbooks` (+ `realmId` in metadata) | none | LIVE |
| Plaid | `plaid.ts` | App creds + per-item access token | `Connection` `plaid` + `PlaidItem.accessTokenEncrypted` | none | LIVE (read-only) |
| Script Studio | `scripting.ts` | Bearer API key | env only | `/api/webhooks/scripting`, HMAC **only if `SCRIPTING_WEBHOOK_SECRET` set** | Wired both ways |
| HubSpot / Messenger / SendGrid | — | — | — | — | **Registry cards only, no code** |

---

### Gotchas / known state

Everything below was verified in the code, not inferred.

- **The Frame.io "Send to RealTour for review" action can never be registered from the app.**
  `ensureReviewAction()` (`src/lib/integrations/frameio.ts:195`) has **zero callers** — no button, no
  action, no cron step. Because it is the only thing that writes the `frameio_webhook` secret, and
  `frameioRequestAuthorized()` returns `true` when no token is stored, `/api/webhooks/frameio` is
  currently an **unauthenticated public receiver** that can flip a job to REVIEW and create a task.
  `/connections` does surface this via its `unsignedProviders` banner.
- **Two Frame.io exports are dead:** `frameioPing()` and `deleteFrameioProject()` have no callers
  anywhere — so nothing in the app ever probes `/accounts` for connectivity, and a Frame.io project
  is never removed when its hub job is.
- **`ensureFrameioProjectForProject()`'s own comment is half true.** It says it is *"Used by BOTH the
  manual 'set up' button and the auto-create sweep."* Only the sweep
  (`ensureFrameioProjectsForActiveVideoJobs`) uses it. The manual button
  (`src/app/frameio/actions.ts:30`) and the upload flow (`src/app/upload/actions.ts:286`) each call
  `createFrameioProject` directly and reimplement the name-build and the
  `frameioProjectId`/`frameioViewUrl` write, so a fix in the wrapper lands in one of three places.
- **Frame.io comment → revision is half-built.** The receiver handles a comment payload, but the
  code says it *"only fires once a comment webhook is registered (the custom action alone doesn't
  send comment events)"*, and nothing in the codebase registers one.
- **Aryeo webhook signature verification is effectively off.** It runs only when
  `Connection.webhookSecret` is set, and **no code path anywhere writes that column** — grep finds
  only the two read sites and the schema. It would have to be seeded directly in the database.
- **Google's biggest open item: one re-consent unlocks three features.** The declared scope list
  includes `gmail.send`, `calendar.events` and `drive.readonly`, but the comment at
  `google.ts:15-21` states the live tokens carry only `gmail.readonly` + `userinfo.email`. Until the
  owner re-authorises, email sending 403s (with a `needsReconnect` message), the day planner cannot
  write calendar blocks, and Meet transcripts cannot be read. Adding scopes to the array changes
  nothing on its own.
- **`/api/google/callback` has no CSRF state check and no owner gate.** Every other connect flow
  (`/api/quickbooks/connect`, `/api/frameio/connect`, `/api/auth/login`) sets and verifies a state
  cookie; the Gmail data callback verifies nothing and exchanges any `?code` it is handed, then
  writes the resulting refresh token into the `gmail` map.
- **`AUTH_ENFORCE` gates the OAuth connect routes.** `/api/quickbooks/connect` and
  `/api/frameio/connect` only check `realRole === "OWNER"` when `AUTH_ENFORCE === "true"`. With that
  env var unset, any visitor can start those consent flows.
- **Webhook auth for OpenPhone and Frame.io is deliberately fail-open.** Both
  `openPhoneRequestAuthorized` and `frameioRequestAuthorized` return `true` when no token is stored,
  "backward compatible" until the hook is re-registered.
- **Aryeo `createOrder` is defined and never called.** The Hub reads Aryeo orders and can reschedule
  or cancel appointments, but it has never written an order back.
- **Aryeo product sync carries no media.** Neither the `AryeoProduct` interface
  (`aryeo.ts:278`) nor the `Product` Prisma model (`schema.prisma:761`) has any image, thumbnail or
  asset field — only title, type, category, description, min/max price, variants JSON and tags. The
  catalogue cannot show product imagery without a schema and sync change.
- **Thirteen Aryeo helpers exist but have no callers:** `createOrder`, `listings`,
  `availableTimeslots`, `product`, `customerUser`, `users`, `me`, `tasks`, `activities`, `tags`,
  `groups`, `group`, and the two permission-gated ones `discounts` / `addresses` (marked `(perm)` —
  they 401 for the current key). `testAryeoKey()` therefore returns the flat label
  `"Aryeo account"` rather than the company name, even though `/me` would provide it.
- **Aryeo flat payloads have no idempotency.** Only events carrying a true activity id are deduped;
  everything else reprocesses on every delivery. Deliberate — the alternative silently swallowed
  every event after the first for a given order.
- **Aryeo has no media-delivered webhook**, so a shoot's media going live is detected only by the
  hourly `statuses` polling step.
- **Stripe's sync cursor is a one-way ratchet.** Once `lastTxnCreated` is set, incremental runs can
  never reach earlier history; recovering it requires an explicit `fullDays` backfill. This is
  documented as the cause of 2025 disappearing from the books.
- **The daily cron's step order was itself a bug.** Stripe now runs first because it used to run last,
  behind the 130–330s `ordersFullReconcile`, and *"had not run from cron in weeks while every
  CronRun died with finishedAt=null. That single ordering bug is why the books showed a 32% revenue
  collapse that never happened."* `ordersFullReconcile` is now hard-capped at 150s via `Promise.race`
  so `finish()` always records the run.
- **QuickBooks dies in ~24h if the rotated refresh token isn't persisted**, and flipping `QBO_ENV`
  without reconnecting throws a deliberate 409 rather than a misleading 401.
- **Dropbox has no OAuth callback route** — connecting is a manual copy-paste of the authorization
  code. Unlike Google, Dropbox access tokens are **not cached**: every `dbx()` call mints a fresh one
  from the refresh token, so a busy page pays two round trips per operation. The team root namespace
  (`cachedRootNs`) is a module-level cache that is never invalidated.
- **Slack real-time dies silently without `SLACK_SIGNING_SECRET`.** `verifySlack()` returns `false`
  when the env var is unset, so every event 401s — the safe direction, but the hourly user-token
  poll keeps working, which can mask the outage.
- **`slackSync.ts` hard-codes Slack identity.** Jordan (`U07D2KJH1JP`), Kyle (`U07SCBTPDC7`), Kim
  (`U0ASP9C1WRK`), Remar (`U0B7WNGEH0D`) and the channel-name regex
  `/video-editing|project-tracker|photo-editing/i` are literals. A renamed channel or a new team
  member silently drops out of comms memory.
- **`syncGmail`'s reply-sweep count is discarded.** It computes `closed`, then `void closed`
  (`google.ts:1007`) — the number of auto-closed email tasks is never returned or surfaced.
- **Gmail webhook rows are excluded from `retryFailedWebhooks`** because the stored payload is only a
  1,000-char snippet; retries happen via the next inbox scan instead.
- **Kyle's `TeamMember.phone` is the company OpenPhone line.** `notifyStaffSms` detects this and
  relays to Slack instead of texting, because a naive send would text the office from itself and
  echo back through the inbound webhook as a fake client message.
- **`getSchedulingAvailability()` swallows every error and returns `null`** — a broken or
  unpermitted Aryeo scheduling endpoint is indistinguishable from "no availability", and the caller
  just drafts a reply without dates.
- **The AI's `SMART` model id is unpinned.** `FAST` is `claude-haiku-4-5-20251001` (dated) but
  `SMART` is `claude-sonnet-4-6` with no date suffix, so it floats.
- **Three registry entries are decoration.** `hubspot`, `messenger` and `sendgrid` render cards with
  capability bullets on `/connections` and carry `ready: false`; there is no client module for any of
  them.
- **The Aryeo registry card promises a capability that does not exist.** Its bullets advertise
  *"Real-time webhooks (fulfilled, media delivered, paid)"*, but Aryeo has no media-delivered
  webhook — that state is polled hourly by the `statuses` step.
- **Script Studio's inbound webhook is unverified when `SCRIPTING_WEBHOOK_SECRET` is unset.** Same
  fail-open shape as OpenPhone and Frame.io: the HMAC block is inside `if (secret)`, so an
  unconfigured env var means any POST is processed. Unlike those two, there is no `unsignedProviders`
  chip for scripting on `/connections`.
- **A staff SMS suppressed by quiet hours reaches nobody.** `notifyStaffSms` relays every unreached
  recipient to Slack via `opsAlert` — but the `unreached` filter excludes `quiet-hours` alongside
  `sent`. Between 22:00 and 07:00 in the recipient's timezone the text is dropped and no Slack
  fallback fires; only the in-app bell row (written by a different call) survives.
- **`/connections`'s "N of 13 services connected" over-counts.** The subtitle divides by
  `PROVIDERS.length` (13) but counts CONNECTED rows from `getAllConnections()` — which includes the
  internal, card-less slots `frameio_app`, `frameio_webhook`, `openphone_webhook` and `plaid`, all
  of which `saveSecret` stamps `status: "CONNECTED"`. The numerator can therefore exceed the
  denominator.
- **`syncSlackHistory` skips every message with a subtype except `thread_broadcast`,** so file
  shares, channel joins and edited messages never reach comms memory or task creation.
- **The Slack real-time receiver answers `url_verification` before checking the signature.** That is
  required by Slack's handshake, but it means an unsigned POST with
  `{"type":"url_verification","challenge":…}` is echoed back by an otherwise fail-closed endpoint.
- **`/connections` already reports most of this.** It renders `unsignedProviders` (connected
  providers with no signing token), the 7-day webhook error count, `webhookHealthByProvider`
  (rejected vs errored per provider), per-mailbox Gmail send chips, and the last five runs of each
  cron from `CronRun` — with a `cronLogReady` fallback for a database where that table hasn't been
  pushed yet. A run with `finishedAt = null` renders grey ("still running or hard-killed"), not red.

## 6. Money: finance, payroll and profitability

Almost everything about the agency's money lives under one route, `/sales` (labelled "Finance" in
the nav), as eleven tabs; `/my-pay` is the one separate screen, a creative's view of their own pay.
`/billing` and `/payouts` still exist but only as redirects into `/sales` tabs. The hub answers four
questions Jordan never had a single answer to: *what did I actually collect*, *what did I actually
spend*, *what did each job earn me*, and *what do I owe each person this Friday*. It does that by
reading four external systems — Aryeo (what was sold and delivered), Stripe, QuickBooks Online and
Plaid (every bank + card + a Venmo statement import) — plus the hub's own payroll engine, and
reconciling them into one set of numbers that every screen shares.

The design rule stated in `src/lib/bookkeeping.ts:14-16` governs the whole area: *"NEVER guess
silently. A row we cannot classify with evidence gets `needsReview = true` and a plain-English
`reviewNote`... Filing something wrong quietly is worse than asking."*

### How money is stored, per model

There is no single unit convention. Almost everything is **dollars as a `Float`**; the exceptions
are the ones that bite.

| Model / field | Unit | Notes |
|---|---|---|
| `Project.price`, `Project.payableInvoice` | dollars (Float) | `schema.prisma:379,383` |
| `Project.balanceAmount` | **cents (Int)** | `schema.prisma:393`; divided by 100 in `getBillingRows` (`src/lib/queries.ts:1002`) and in `nudgeTemplate` (`src/app/billing/actions.ts:29`) |
| `OrderItem.amount` | dollars (Float) | *"line total in DOLLARS (Aryeo sends cents)"* — `schema.prisma:753` |
| `Product.minPrice` / `maxPrice` | **cents (Int)** | `schema.prisma:770-771` |
| `StripeTransaction.gross/fee/net` | dollars | converted from Stripe cents by `dollars()` in `src/lib/integrations/stripe.ts:22` |
| `QboTransaction.amount/balance` | dollars | straight from QuickBooks `TotalAmt` |
| `PlaidTransaction.amount` | dollars, **signed** | Plaid convention: **positive = money OUT**, negative = money IN (`schema.prisma:1395-1397`) |
| `PayrollEntry.amount`, `PayoutAdjustment.amount`, `Expense.amount`, `CashSnapshot.balance` | dollars | `PayoutAdjustment.amount` may be negative (camera payback) |
| `JobPayOverride.invoiceOverride` / `flatAmount` | dollars | |
| `MileageDay.miles` / `overrideMiles` | miles (Float) | not money |
| `BonusPeriod.poolAmount`, `BonusAward.amount` | dollars | dormant, see gotchas |

Two formatters: `usd()` in `src/lib/money.ts` keeps cents (payouts need `$90.50`); `formatMoney()`
in `src/lib/utils.ts:20` rounds to whole dollars for headline order totals. `parseMoney()`
(`src/lib/money.ts:14`) exists because of a real bug: a bare `Number("$1,200")` is `NaN`, *"which
the payout override code then read as 'nothing set' and silently wiped the override."*

### The two P&L engines, and why profit says "provisional"

There are genuinely two profit engines, and they answer different questions.

**Engine A — the year/period true P&L (Overview, Categories, Advisor).** Revenue comes from
`revenueByProcessor()` (`src/lib/bookkeeping.ts:447`); cost comes from `categoryBreakdown()`
(`src/lib/financeCategories.ts:278`), which sums the *audited Plaid ledger* (every bank account,
card, and the Venmo statement pseudo-account) tagged `BUSINESS`. Profit = `rev.total −
cats.businessTotal` (`OverviewTab.tsx:84`). This is the number the Overview headline shows.

**Engine B — the calendar-month cash-basis P&L (`getMonthlyPnl`, Money tab).**
`src/lib/finance.ts:123`. Same revenue source (it calls `revenueByProcessor` for the ET month) and
the *same* `categoryBreakdown` for costs, but it decomposes the month into named lines:
photographers, editors & team, card fees, "other expenses" (the plug), and reports the payroll
*engine's* accrual figures alongside as context only.

The two agree on profit by construction — both do revenue-at-processor minus the same ledger — but
they window differently (calendar month vs arbitrary range) and Engine B additionally exposes
`accruedPhotographerPay` / `accruedTeamPay` from `computePayroll` + `PayrollEntry`.

`src/lib/finance.ts:146-153` records exactly why the itemised lines were rebuilt onto the ledger:

> *"They used to be sourced from the payroll ENGINE (what creatives were owed) while profit came
> from the bank — two different worlds. The July 2026 audit measured the damage: 'Photographers'
> overstated by $48,316 YTD, 'Editors & team' printed $0.00 every month while $76,164 was genuinely
> paid, card fees understated by $6,086, and the 'Other expenses' plug silently absorbed a $33,934
> error — with the plug heading for a NEGATIVE number once payroll plus fees exceeded the ledger
> total (July had $7,519 of headroom left). Profit itself was always right; only the story it told
> was wrong."*

**Why "provisional".** `OverviewTab.tsx:146` labels the YTD net-profit KPI `"… margin ·
provisional"` unconditionally, and line 251 adds a warning whenever `cats.reviewTotal > 100`:
*"$X still uncategorized (see Categories → To review) — the profit above firms up as they're
tagged."* Cost is a *classification* of raw bank rows, and any row the rule table can't match lands
in `REVIEW` kind, which is **excluded from `businessTotal`**. So the cost side is a lower bound
until review is empty. The Books-health card (`OverviewTab.tsx:278-303`) states the same thing in
Jordan's words: revenue is solid, expenses are the reconciliation his accountant closes.

### Revenue: counted at the processor, never at the bank

`revenueByProcessor(startKey, endKey)` — `src/lib/bookkeeping.ts:447`. Three rails, summed:

1. **QuickBooks Payments** — `QboTransaction` rows of type `Payment` + `SalesReceipt`.
2. **Stripe** — `StripeTransaction` types `charge | payment | refund`, summed on `gross` (refunds
   are negative so they net automatically). Fees are summed *separately* because they are a cost.
3. **Venmo** — one client, Stephen Kennedy, into Jordan's *personal* Venmo.

The rationale (`bookkeeping.ts:436-445`): *"Counting at the processor makes the entire bank-deposit
problem disappear — duplicates, personal-account detours through ...0942, and payout deposits are
all just MOVEMENT of money already counted, so they are never counted at all."* It deliberately
does **not** read Deposits or Invoices: *"a deposit is cash arriving somewhere it already was; an
invoice is a bill, not money."* No-overlap was verified: *"of 12 manually-recorded 'Credit Card'
payments in QuickBooks, ZERO matched a Stripe charge within 5 days."*

The Venmo rail has a **three-level** fallback chain (`bookkeeping.ts:482-511`), first-hit-wins:
(1) `PlaidTransaction` rows on the `mask: "venmo"` pseudo-account with `financeCategory = "Venmo
revenue (client)"`; (2) any bank credit whose `name` contains "venmo"; (3) the hand-transcribed
`VENMO_CHARGES` array (22 rows, 2026-01-05 → 2026-07-16, `bookkeeping.ts:406`). Separately,
`VENMO_COVERAGE_FROM = "2026-01-01"`: for the part of a window *before* that date, bank-feed QBO
`Deposit` rows with a `VENMO` memo are added instead, *"and the two must never both be counted."*
The comment explains the switch: the old bank cash-out method *"missed every balance-funded dollar
and recorded the rest net of fees."* `VENMO_EXCLUDED_CENTS = new Set([297500, 124322])` hard-excludes
two cash-outs by cent value — but **only inside fallback level 2**, so it does nothing in the normal
statement-import path.

One hard-coded correction lives in the revenue path (`bookkeeping.ts:461-463`): a 2026-02-13
`VIDEO PRO` $1,999 QuickBooks Payment was clawed back on 2026-05-07, so `quickbooks -= 1999`
whenever the window covers 2026-02-13.

### Cost: the audited all-account ledger

`src/lib/financeCategories.ts` turns every `PlaidTransaction` into one of five kinds —
`BUSINESS | PERSONAL | EXCLUDE | REVIEW | INCOME` — plus a human category label.

- **`EXCLUDE` runs first**: self-transfers, transfers to the wife's `···4284`, credit-card
  paydowns, Stripe top-ups, Venmo movement. Money-movement is surfaced but never summed, so it
  cannot inflate anything.
- **Owner fuel rule** (`financeCategories.ts:37-52`, quoting Jordan 2026-07-24; the test itself is
  at `:177`): a gas-station or convenience charge **strictly greater than `FUEL_BUSINESS_MIN = 25`**
  is business `"Fuel & travel (business)"`; below that it's a coffee and falls through to the
  personal `"Fuel & convenience"` rule. Food-delivery orders placed *from* a gas station
  (`DOORDASH SHEETZ`) are excluded from the fuel rule and land on the restaurant rule.
- **Paul's consulting**: any `Staffify`/`FlyListed` pull within $1 of $1,500 is
  `Consulting (Paul)`, everything else from those vendors is `Video editing`. The QuickBooks
  classifier carries the same split independently (`bookkeeping.ts:198-206`, `OPERATING` vs
  `COST_OF_SALES`) — two rule tables that must be kept in step by hand.
- **Refunds net inside their own category, not as income** (`financeCategories.ts:151-168`): a
  credit that matches a spend rule returns the *same* category with a negative amount ("Cash / ATM"
  is skipped, because money coming in is never a cash withdrawal). The audit
  found *"15 credits worth $1,146.79 overstated the household total"* before this. A second pass
  (`categorizeAllPlaid`, from line 211) makes each refund adopt the *dominant* kind/category its own
  vendor's charges actually carry — including the owner's manual re-tags — because a T-Mobile refund
  drove the "Phone" category to −$170 when every phone charge was hand-locked to the business. A
  refund from a vendor with **no** charges anywhere stays `INCOME`.
- **Card-side paydown credits** ("Payment received. Thank you!", "AUTOPAY PYMT") are `EXCLUDE`;
  missing the CapOne wording once produced *"$326.61 of phantom revenue"*. `reverse ACH` credits are
excluded too, so a bounced debit and its reversal both net out.
- **`financeLocked`**: any owner hand-tag sets it, and `categorizeAllPlaid` skips those rows
  forever. Re-tagging is done from the Categories tab via `retagCategoryAction` /
  `retagTxnAction` / `retagTxnsBulkAction` (`src/app/sales/spendingActions.ts`), all `requireOwner`.

`categoryBreakdown()` then adds the two Stripe-rail costs that never touch a bank feed: Connect
transfers (merged into the single `Creative specialist pay` line) and **all** Stripe fees — charge
fees + instant-payout fees + standalone `stripe_fee` rows, because *"the audit found $1,399 was
missing when only charge fees counted"* (`financeCategories.ts:304-320`).

`personalTruth()` (line 396) is the Personal tab's engine. Its most important comment is the
double-count warning: net transfers to the wife's `···4284` are a **funding pipe, not spend** —
*"it must NEVER be added to `total` (doing so double-counts every dollar of it — that misread is
exactly how a $121.8k household year got quoted as $156.7k, Jul 2026)."* The return value carries
the receipts (`wifeCounted`, `wifeInReview`, `wifeUnaccounted`) so any surface can prove it, and the
same warning is repeated verbatim in the AI tool payload
(`financeTools.ts:199-206`, field literally named
`wife_account_funding_ALREADY_INCLUDED_IN_TOTAL`).

### The QuickBooks classifier

`classify()` in `src/lib/bookkeeping.ts:179` produces a `Verdict { category, confidence,
needsReview, reviewNote, personal, duplicateOf }` per `QboTransaction`. Categories:
`REVENUE | ALREADY_COUNTED | DUPLICATE | TRANSFER | OWNER_DRAW | OWNER_CONTRIBUTION | FEE_REFUND |
COST_OF_SALES | OPERATING | VEHICLE | FINANCING | UNCATEGORISED`.

The classifier reads `describe(r)` — payee (`EntityRef.name`) + `PrivateNote` + line descriptions —
*not* the `memo` column, which *"is frequently empty."* `VENDOR_RULES` (line 86) is an ordered
first-match-wins table with real research baked in and a note per rule, e.g. Empower/Tilt/Sunbit are
consumer lenders and *"Principal is NOT deductible — only the fee"*; Katie MacIntyre is *"the family
nanny — personal, not a business cost (confirmed by Jordan)"*; Cliffside Cuts / Nguyen /
Harrison / Matthew / James are contractors. A deliberate anti-rule: *"'money transfer' / 'visa
direct' are deliberately NOT here — on a Purchase those strings are Venmo contractor payouts
('VENMO \*<name> Visa Direct'), which are real COST_OF_SALES."*

Deposits are where the ambiguity lives. A personal-`0942` deposit is only `ALREADY_COUNTED` when it
ties an exact Stripe payout amount within 6 days; otherwise it is `TRANSFER` + `needsReview`,
*"Treated as NOT revenue until you confirm — the safe direction."* An unlinked deposit matching a
receipt/payment within 4 days is `DUPLICATE`.

`categoriseBooks()` (line 339) persists verdicts. **A row with `reviewedAt` set is final** — *"its
category is a human decision (e.g. 'those checks are rent') and must survive every re-run."*

`trueProfitAndLoss()` (line 530) is a second, QBO-only P&L that reuses `revenueByProcessor`
verbatim and adds Stripe Connect contractor pay to expenses. It is **not called from any page** —
see gotchas.

### `/sales` — the Finance hub and its per-tab gating

`src/app/sales/page.tsx`. One route, eleven tabs, each early-returning only its own data so *"the
heavy payroll computation never runs for a Revenue view, the AR pull never runs for a Payroll
view."* `export const maxDuration = 60` because the Jobs tab runs the payroll/mileage engine over a
60-day window.

| Tab | Component | Reads | Who |
|---|---|---|---|
| Overview | `OverviewTab` | `revenueByProcessor` (YTD, prior full year, and current ET month), `categoryBreakdown` (YTD + month), `getCashPosition`, `getMonthlyPnl`, books-health groupBy, `SavingsItem` checklist | owner |
| Advisor | `AdvisorTab` | AI CPA chat + `FinanceReport` list | owner |
| Jobs | `JobsTab` | `jobProfitability(60d)` | owner |
| People | `PeopleTab` | `peoplePayments` | owner |
| Personal | `PersonalTab` | `personalTruth` | owner |
| Budget | `BudgetTab` | `BudgetTarget` + `personalTruth` | owner |
| Categories | `SpendingTab` | `categoryBreakdown`, `revenueByProcessor`, `vendorBreakdown`, `cardPaydowns` | owner |
| Money | `MoneyTab` | `getMonthlyPnl`, `getCashPosition`, `getPayrollTrend`, manual entry forms | owner |
| Revenue | `RevenueTab` | legacy Aryeo-only Sales Tracker | owner |
| Unpaid | `UnpaidTab` | `getBillingRows` | owner **+ admin** |
| Payroll | `PayrollTab` | `computePayroll` for a bi-weekly period | owner |

Gating runs in three steps: a signed-out request bounces to `/login?next=/sales` **only when
`authEnforced()`** (so local dev renders the owner view); a signed-in user without `canAccess(me,
"sales")` goes to `/`; then `isOwner = me ? me.role === "OWNER" : !authEnforced()`. A non-owner
asking for an owner-only tab is redirected to `/sales?tab=unpaid`. The comment is explicit that
`!me` must not grant owner tabs in prod because `getCurrentUser()` also returns null for a
disabled/deleted account still holding a valid 7-day JWT. `/billing` and `/payouts` are now pure redirect shims
(`src/app/billing/page.tsx`, `src/app/payouts/page.tsx`) that forward every query param so old
notification links — and the `?start=<period>` deep link — still land on the right tab.

### Cash position and runway

`getCashPosition()` — `src/lib/finance.ts:190`.

- **Bank balance**: live from Plaid — sum of `PlaidAccount.currentBalance` where
  `isBusiness && type === "depository"` — with the hand-typed `CashSnapshot` as fallback.
  `bankLive` tells the UI which it is.
- **`goingOut30`**: trailing 3 full months of **every** `QboTransaction` of type `Purchase` ÷ 3.
  *"This is the fix for a 'going out' that read an (empty) manual-expense table and so wildly
  under-counted."*
- **`comingIn30`**: trailing 3 full months of `Deposit` rows ÷ 3, **excluding any memo containing
  "capital"**. The comment: *"BORROWED MONEY IS NOT INCOMING REVENUE. A Stripe Capital drawdown
  lands as a bank Deposit exactly like a customer settlement... counting it made a typical month
  look $5,178 richer than it is (Jul 2026 audit, one $15,533.56 advance)."* It is deliberately not
  revenue, because revenue counts Venmo (lands in a personal account) and is gross of fees —
  *"for this business the gap is large (~$56k earned vs ~$42k banked)."*
- Both fall back to last month's `getMonthlyPnl` when their 3-month aggregate is not positive:
  `goingOut30 → prevPnl.allPayroll + recurring Expense sum`, `comingIn30 → prevPnl.revenue`.
- `projected = bank + comingIn30 − goingOut30`; Stripe available/pending is best-effort and
  degrades to null if the restricted key can't read `/balance`.

`getMonthlyPnl` is wrapped in React `cache()` because MoneyTab, `getCashPosition` and
`getPayrollTrend` all ask for the same months in one render.

### Payroll: the creative pay formula

`src/lib/payroll.ts`. Stated at the top of the file:

```
Shoot Pay            = max(eligible services invoice × payPercent, payFloor)
Daily Mileage Pay    = max(total daily drive miles − (homeRadius × 2), 0) × mileageRate
Mileage Pay Per Job  = Daily Mileage Pay ÷ jobs that day (that take mileage)
Job Total            = Shoot Pay + Mileage Pay Per Job
Period Total         = Σ Job Totals ± manual adjustments
```

Rates are per-creative on `TeamMember`: `payPercent`, `payFloor`, `mileageRate` (default `0.65`),
`homeRadiusMi` (`Int`, default `35`, so 70 free miles/day). The per-person values are data, not
code — nothing is hard-coded in the engine.

**The pay basis** is `Project.payableInvoice`, computed at Aryeo sync time by
`payableInvoiceFromItems()` (`src/lib/integrations/aryeo.ts:490`): non-cancelled order items in
dollars, minus anything matching `PAY_EXCLUDED_RE`
(`/\bvirtual\b|\bai\b|a\.i\.|\brender(ing|ings)?\b|\bdigital (stag|declutter|twilight)/i`) —
*"no work on a shoot"* — and **capped at the discounted order
total**, because *"item list prices can sum ABOVE a discounted order's total, and the % must never
be paid on money the client didn't actually pay (audit crack #18 — 205 orders)."*

**Payroll is appointment-centric, not project-centric.** Each `Appointment` is paid to
`assignedTo`, not the project's single photographer. The earliest appointment is the primary shoot
(full pay); a later appointment by a different shooter — or the same shooter on a *different ET day*
— is a return trip paid at that person's **flat `payFloor`**, unless an `invoiceOverride` exists for
them on that job (audit crack #5: *"the override badge showed but the engine silently paid the
floor"*). Same-day extra appointment rows are one visit and are skipped. `photographerManual = true`
means the owner took over who is paid, and Aryeo's per-leg assignee is ignored.

`SHOOT_HAPPENED_STATUSES = {SHOT, EDITING, REVIEW, REVISION, DELIVERED}` handles a real Aryeo
behaviour: *"Aryeo retro-cancels an order's appointment rows when it's canceled AFTER the shoot...
so all-rows-canceled on one of these jobs still means the visit happened and must pay."* Conversely
a `BOOKED`/`SCHEDULED` job whose rows are all cancelled must **not** pay off the never-cleared
`shootDate`. The same logic is mirrored in `shootEarnings()` (`src/lib/shoot.ts:274`) for the
photographer's own `/shoot` pay card, which scopes the payroll pass to **one ET day** rather than
the whole 14-day period so the page doesn't stall on OSRM.

#### Pay periods

`PERIOD_ANCHOR = "2026-05-31"`, `PERIOD_DAYS = 14`, payout = period end **+ 6 days** (a Friday).
`payPeriodFor()` defaults to today *in ET* — *"Using the UTC day here would roll the period over a
few hours early on the evening a period ends."* `periodBounds()` returns ET-midnight to
last-ms-of-endKey, so *"a shoot at 8pm ET on the last day of a period"* stays in its own period.

#### Mileage: computed, cached, and owner-overridable

`routeMiles()` builds `home → stops (time order) → home` and routes each leg through the **public
OSRM server** (`src/lib/travel.ts:30`), asking for `alternatives=3` and picking the **shortest-
distance** route, not the fastest: *"creatives are paid per mile, so mileage uses the fewest-miles
route."* 5-second timeout; on failure it falls back to haversine × 1.25. Legs are routed in
parallel (they used to be serial, "so a multi-stop day meant N sequential OSRM round-trips on the
payouts render path").

Results are cached in `MileageDay` keyed `(teamMemberId, dayKey)`. The cache key `sig` is
`home + sorted stop coords`, not the stop count — *"Keying on the stop COUNT alone missed
reassignments that kept the count equal."*

**The owner per-day override** (`MileageDay.overrideMiles` / `overrideNote`) is the piece that
survives everything:

- `dailyMiles()` returns `miles: cached?.overrideMiles ?? computed`, keeping `computedMiles`
  alongside so the UI shows "adjusted · was 128.4".
- The recompute `upsert` **never touches the override columns** — *"a recompute (route change, cache
  clear) must not eat an owner correction."*
- `recomputeMileage()` (`src/app/payouts/actions.ts:283`) deletes only rows with
  `overrideMiles: null` and merely clears `sig` on override rows, so the computed figure refreshes
  *underneath* the override.
- `setMileageOverride()` accepts 0–2000 miles, rounds to 0.1, and **clearing is explicit** (the
  reset arrow sends `null`): *"A blank string from the Save button is a mistake, not a clear —
  silently reverting pay to the routed figure on an empty input bit the review."*
- An override on a day with no pay lines this period is surfaced as a zero-job row **plus a `warn`
  issue** ("has no shoots this period — it pays nothing") so it is visible and resettable —
  *"an invisible override would silently re-apply if a shoot ever lands back on that day."*
- An override also applies when the member has **no geocodable home address** at all, which
  downgrades the "no home address" warning from `warn` to `info` when every day is hand-set.

#### Per-job overrides and discrepancy detection

`JobPayOverride` (unique on `projectId + teamMemberId`) carries `invoiceOverride`, `flatAmount`
(wins over the %), `noMileage` (drop this job from the day's mileage split), `excluded` (drop it
entirely — restorable via the "Removed shoots" list), `manualAdd` (pay this member for a job they
aren't the appointment shooter on) and a `note`. `computePayroll` deliberately does **not**
early-out on an empty timeline, *"a manualAdd override below is an explicit owner decision and must
still pay."*

`PayrollIssue[]` per person, all rendered on `PayoutCard`:

- rates not set (`warn`) / no home address (`warn` or `info`)
- shoots missing map coordinates → not counted in mileage
- orphaned override: *"Pay override on \<street\> was set for X but Y shot it — re-apply it to Y or
  clear it"*, attached to both people, with the primary shooter blamed deterministically rather
  than by Set-insertion order
- mileage > 350 mi/day or > 200 mi/job → "verify the locations" (**suppressed on hand-adjusted
  days** — *"A hand-adjusted day IS the verification — never nag about the owner's own figure"*)
- `$0` eligible invoice (all add-ons virtual/AI) → paid at the floor
- return trips paid flat
- `invoiceOverTotal` — pay basis above the discounted order total
- `invoiceIsFallback` — no itemised invoice synced, using the order total, so virtual add-ons may
  not be excluded

`unassignedShootsInRange()` surfaces shoots with no photographer so nobody is silently unpaid.

The Payroll tab also offers `creativeStatementHtml()` — a self-contained print-ready HTML statement
opened in a new window, which *"Deliberately HIDES internal mechanics: no override badges, no
invoice corrections, no '$0 invoice'/return-trip/discrepancy flags."*

#### Non-photographer pay

Editors and ops aren't on the % engine. `TeamMember.payType` is
`PER_SHOOT | MONTHLY_FLAT | HOURLY | NONE` (schema comments name the people: Kim = MONTHLY_FLAT,
Remar and Kyle = HOURLY), and each payment is hand-recorded as a `PayrollEntry`
via `recordPayrollEntry` on the Money tab (`src/app/sales/moneyActions.ts:36`) — *"amount is the
source of truth; for HOURLY it defaults to hours×rate but the owner can override to what actually
left the bank."* MONTHLY_FLAT entries are keyed on `yyyy-mm-01` *"so they can't be booked into a P&L
month 2–3× (once per bi-weekly payout)"*; HOURLY stays per bi-weekly period
(`MoneyTab.tsx:34-37`). The MoneyTab roster is `payType in (MONTHLY_FLAT, HOURLY)` **or** a
name in the literal list `["Kim Miguel", "Remar", "Kyle Smith"]`. Paul is not on this rail at all —
his consulting is picked up from the bank ledger as the `Consulting (Paul)` category.

### Payouts and My Pay share one engine

`/payouts` (now `/sales?tab=payroll`) and `/my-pay` both bottom out in `computePayroll`.

`src/lib/payHistory.ts` is the My Pay engine. It runs **one** `computePayroll` pass over the whole
year scoped to one member, then decomposes it into periods: *"That is not just a speed trick, it is
the only sane way to do it: computePayroll resolves mileage through the public OSRM router, so
running it once per period would multiply a network-bound job... One pass, scoped to the one member,
is ~1.7s and yields both the history and the YTD figure."* The decomposition is exact because pay is
inherently per-day (`jobTotal = shootPay + mileageShare`, adjustments carry their own date), and
*"is verified to reconcile against a direct per-period computePayroll."*

Two dated edge cases are handled explicitly:
- The window starts at the **period containing Jan 1**, not Jan 1 — a period straddles the new year
  (2025-12-28 → 2026-01-10) and windowing at Jan 1 under-reported it.
- **YTD is counted from the jobs, not by summing period rows** — the New Year period carries
  December days, and the not-yet-started period holds work that hasn't happened.

`HISTORY_FLOOR_KEY = "2026-05-31"` is the earliest period ever shown, unless the member has earlier
activity in the year.

`/my-pay` defaults to the **closed period still awaiting its payday** ("Getting paid") *"because
on/before payday the money landing in their account is the number they came to check."* Access:
photographers see their own; owner/admin who also shoot (a linked `TeamMember` with `payPercent`)
see their own; owner/admin without a shoot rate are redirected to `/payouts`; editors are bounced
home. `?as=<memberId>` is an explicit owner/admin read-only preview. The comment records a real
incident: *"the old 'first photographer' local-dev fallback put James's page in front of the owner
twice and is gone for good."*

`flagPay()` (`src/app/my-pay/actions.ts`) files a `SmartTask` assigned to `jordan` plus an
owner-only bell, deduped on `payflag-<member>-<project|period>-<periodStart>`; a second comment
appends rather than duplicating. It resolves the member **from the session, not a parameter**, so it
can never expose someone else's pay, and `requireRole` blocks "view as".

### AR / billing — the Unpaid tab

`getBillingRows()` (`src/lib/queries.ts:969`): projects where (`status = DELIVERED` **or**
`deliveredAt` is set) **and** `balanceAmount > 0`. `outstanding = balanceAmount / 100`.
`lastNudgedAt` is read in a **separate best-effort pass** so the page keeps rendering if the code
deploys before the migration lands *"(the shared prod DB would otherwise 500 the whole page)."*

The tab groups into aging buckets — 90+, 60–89, 30–59, under 30 — anchored on `deliveredAt ?? orderedAt`,
oldest first *"so collections work oldest first."* `RevenueTab` deliberately uses the **same**
definition for its Outstanding card *"so the two tabs can never show contradictory money"*, and
splits out invoiced-but-not-yet-delivered separately.

Chasing is draft-then-send (`src/app/billing/actions.ts`, all `requireAdmin`):
`draftPaymentNudge()` builds a deterministic template carrying real facts (amount, street, delivery
date, payment link) and optionally warms the wording with `polishOutbound`; `sendPaymentNudge()`
sends via OpenPhone, writes an `Activity` + a `CommLog` whose `externalId` uses OpenPhone's
`op-<id>` format *"so its later echo of this same outbound text dedupes instead of double-logging"*,
and stamps `lastNudgedAt`. `markBillingNudged()` records a chase done outside the hub.

### Per-job profit and package margin

`src/lib/jobProfit.ts` — `jobProfitability(start, end)` windows on **shoot date** and computes, per
project:

- **revenue** = `Project.price ?? payableInvoice` — the order total. The comment is explicit:
  `payableInvoice` *"is the photographer PAY basis (excludes virtual/AI add-ons) and understates job
  revenue, so it's used only inside the cost calc, never as the top line."*
- **photographer cost** = exact `computePayroll` `jobTotal` (base % + mileage share)
- **editing cost** = video tiers + photo editing, at owner-supplied rates (2026-07-22):
  `RATE_PREMIUM = 299` (Luma premium reels/cinematics), `RATE_MONTHLY_SOCIAL = 120` (Kim's monthly
  social videos), `RATE_STANDARD = 40` (Remar, in-house), `RATE_PER_PHOTO = 0.5` (AutoHDR)
- **finished photos** = `round((rawCount − droneCount) / 5) + droneCount` (`src/lib/photoCount.ts:20`) —
  5-bracket JPG sets merge to one photo, drone shots are singles. Counts come from the project's
  Dropbox `01-RAW-Photos` folder, swept nightly, and are **null until counted** — shown as "—",
  never a fake zero. `countProjectPhotos` returns null on auth/rate-limit so *"never stores a bad
  zero"*, but does store a trustworthy zero when the folder genuinely doesn't exist.

`src/lib/packageMargin.ts` splits that per-job cost across the **packages** on the order. Its
header explains why the naive approach was rejected: *"Splitting it proportionally to revenue would
be worthless: every package would come back with the identical margin percentage as the job it sat
on, which tells you nothing about which product to sell."* So each bucket is allocated by its own
driver — shooter pay follows the **eligible** invoice (so virtual staging correctly carries **zero**
shooter cost: *"nobody drives to a virtual twilight"*), video editing follows the video deliverables
the item expands into at the real rates, photo editing follows the photo-bearing items. Weights are
then normalised to the job's actual cost *"so the sum of every package's allocated cost equals the
job total to the penny."*

Two carve-outs:
- **Only paying lines can carry cost.** A `$0` line item is a component of a bundle priced elsewhere
  on the same order; *"Letting a $0 row absorb cost prints it as a pure loss and flatters whatever
  package actually holds the revenue."*
- **Whole orders priced at $0 are set aside entirely** (`unpricedJobs` / `unpricedCost`). These are
  monthly-social retainer sessions billed in QuickBooks; *"including them would print a pure loss
  against a product that is in fact one of the better ones."*

`packageMargins()` is **never computed on a request**. `packageMargin.ts:237-252`: *"Against a warm
local MileageDay cache that is ~9 seconds; from a serverless function with a cold cache it is
minutes... It timed out a 60-second function in production while measuring 3 seconds locally — the
exact shape of bug that only ever shows up on the deployed site."* The nightly cron calls
`rebuildPackageMargins()`, which stores JSON in `MarginSnapshot(scope: "ytd")`; every reader uses
`getPackageMargins()`, a single indexed row read, and gets `null` until the first nightly build.

### Recurring revenue — the rail Aryeo cannot see

`src/lib/recurring.ts`. Monthly social-content clients (Video Starter 2HR / Accelerator 4HR / VIDEO
PRO 8HR, roughly $1,099–$2,500/mo) pay a recurring QuickBooks invoice, and *"Their Aryeo order is
deliberately priced at $0 so they can schedule the session they have already paid for without being
charged twice."* Every Aryeo-based figure therefore silently omits them.

A retainer is **detected, not hard-coded**: same QuickBooks customer, same exact amount, in **≥3
distinct months**, amount ≥ `MIN_MONTHLY = 900` (*"The cheapest real tier is $1,099"*). Billed within
`ACTIVE_DAYS = 70` = live; beyond that = `lapsed`. Client matching (`matchClient`) requires **first
and last name** to agree and only accepts an unambiguous single hit, *"because 'Gary Mercer Jr' and
'Gary Mercer, Sr' are two different people who both book with us."*

A hard-won rule at `recurring.ts:192`: *"A STOPPED RETAINER IS A STOPPED RETAINER. An earlier version
reclassified it as an 'upgrade' whenever the client later bought a content pass — which hid a genuine
churn... Erica Walker holds a live monthly retainer AND has bought two passes, so a pass plainly does
not replace the monthly service."* Any later pass is recorded as `passSince` context only.

### Trends, the growth plan, and the AI advisor

`src/lib/trends.ts` keys everything on `Project.orderedAt`, never `createdAt` (import time) or
`shootDate`: *"'How busy are we?' answered by shoot dates tells you about work already won; answered
by ORDER dates it tells you what is coming."* Coverage is 100% (1,467/1,467 projects carry
`orderedAt`). Cancelled orders **count as bookings** and are reported separately, *"hiding
cancellations would flatter a bad month."*

Package revenue prefers real `OrderItem` line-item dollars, but only past a **coverage gate of 90%**
of YTD orders having items: *"A half-finished backfill would otherwise report real-looking revenue
that is quietly missing half the orders — worse than an honest estimate."* Below the gate it falls
back to `learnPackagePrices()`, which learns each package's standalone price from orders where it
was the only package (287 such orders since 2025 — Photos $250, Premium Social Reel $1,000, Social
Reel $450), requiring ≥3 observations, then splits multi-package orders in proportion.

"Going quiet" is relative to each client's **own** rhythm: past **double** their median booking gap
with a 14-day floor, and at least 3 lifetime orders. Gaps are measured on **booking events collapsed
to one per ET day**, because *"14% of all gaps in this book are under a day, and 40% of repeat
clients have at least one same-day pair."* The at-risk dollar figure is **measured trailing-365
money annualised over tenure (clamped 90–365 days)**, not a cadence projection — the first version
*"came out ~2.2× what those same clients had actually paid in a year. A projection that exceeds
every dollar the client has ever spent is not a projection."*

`src/lib/growthPlan.ts` feeds all of that (plus margins and recurring) to an LLM and caches the
result in `GrowthPlan(scope: "default")`, hashed on the **business shape only** — deliberately not
the whole snapshot, because days-since-last-order and the MTD projection *"tick over at midnight
whether or not anything happened"*, so the plan was rebuilt and paid for daily. Its margin `basis`
is only reported as `"exact"` when **both** job coverage ≥90% **and** `photoCostKnown` ≥90%, because
*"Judging on job coverage alone told the model the margins were exact while the AutoHDR bill was
silently booked as $0 on most jobs."*

`src/lib/financeTools.ts` + `src/app/sales/advisorActions.ts` are the owner-only AI CPA. 15 tools,
all reading the same engines the tabs render *"so the advisor's numbers always match the dashboard."*
`set_budget` and `create_report` are its only writes. The system prompt carries an all-caps
anti-double-count rule: *"NEVER ADD UP TOTALS FROM DIFFERENT TOOLS OR ACCOUNTS... If you find
yourself summing two numbers to answer 'how much did we spend', stop — you are about to
double-count."* Boundaries are explicit: not a licensed CPA/tax preparer/investment advisor; never
moves money.

Generated statements are stored as `FinanceReport` markdown and rendered at `/sales/report/[id]`
(owner-only) with print CSS that hides all app chrome so browser Save-as-PDF produces a clean
document. `generateReportAction` retries once because *"The model sometimes ANNOUNCES its plan ('let
me compose and save it') and ends the turn without acting"*, and refuses to save an answer under 300
chars or with no table pipe.

### Integrations

**Stripe** (`src/lib/integrations/stripe.ts`) — read-only, a restricted key pasted on
`/connections`, stored encrypted. Syncs `/v1/balance_transactions` (the fee-accurate ledger) into
`StripeTransaction`, keyed on Stripe's own txn id so re-scans are idempotent. Sync is gated on the
**secret existing**, not `status === CONNECTED`, *"otherwise one transient ERROR would freeze sync
forever."* Two documented bugs are fixed in-file:
- the high-water cursor is a one-way ratchet, *"That is exactly how 2025 went missing: the connection
  was made in 2026, the first run reached back 120 days, and every run since has only moved
  forward"* → `syncStripe({ fullDays })` ignores the cursor for a backfill and never rewinds it.
- `maxPages` is 40 incremental / **400** on backfill: *"The old 40-page cap silently truncated at
  4,000 rows."*

A second best-effort pass reads `/v1/transfers` to stamp `destination` onto each transfer row —
balance transactions don't carry it. `STRIPE_CONNECT_ACCOUNTS` maps two account ids to people
(`acct_1TKG7cRqstgTY1BH` → James Livingston, `acct_1QsbJ32MCrVSS8mb` → Harrison Wells), *"verified
2026-07-23 — per-account sums match the owner's Connect dashboard to the penny: James $13,567.46,
Harrison $4,377.93."* Unstamped rows fall back to a combined "James & Harrison (Stripe,
unattributed)" line, never a guess.

**QuickBooks** (`src/lib/integrations/quickbooks.ts`) — OAuth, **accounting scope only**:
*"We deliberately do NOT request payments/payroll write."* Read-mostly by design; nothing is ever
posted back. Two operational traps are handled:
- `QBO_ENV` picks the credential pair *and* the host together, and `assertEnv()` refuses a token
  minted in the other environment rather than returning *"a generic 401 that looks like a broken
  integration."*
- Intuit **rotates the refresh token**; `accessToken()` always writes the new one back —
  *"That is the single most common way a QuickBooks integration breaks."*

`syncQuickBooks` pulls Invoice, Payment, Purchase, SalesReceipt and Deposit (200 per page, up to
4,000 each). Two extraction details matter: `expenseAccount()` reads the **line-level**
`AccountBasedExpenseLineDetail.AccountRef`, not the transaction's top-level `AccountRef` (which is
just the funding account) — *"Using the top-level ref left 2,312 of 2,363 expenses uncategorised and
hid the fact that over a thousand lines are coded to 'Owner Draw'."* And `linkedCount` counts lines
with a `LinkedTxn`, which is what separates a genuine customer settlement from a bank-feed twin.
Errors capture Intuit's `intuit_tid` correlation id so a support ticket is one lookup.

`profitAndLoss()` pulls QuickBooks' own cash-basis P&L report — it is **not** wired into any page.

**Plaid** (`src/lib/integrations/plaid.ts`) — read-only bank/card, LIVE. The bank login happens
inside Plaid Link; the per-item access token is exchanged server-side and stored AES-GCM encrypted.
App credentials live in the encrypted `plaid` `Connection` row. Link tokens request
`days_requested: 730`. Notable: `backfillItem()` uses `/transactions/get` over an explicit window
rather than `/transactions/sync`, because sync *"stops short on the initial connect (it left PNC at
~30 days while Plaid actually held 7,664)."* `retryErroredPlaidItems()` is the cron's last step —
a second chance minutes after the morning sweep, because *"a single transient 429 froze it for a
full day (PNC sat stuck 2 days on exactly this)."* The owner tags each account BUSINESS/PERSONAL on
`/connections/banks` (`tagPlaidAccount`), which is what lets the finance engine separate true
business cost from owner draws.

### Nightly cron order (`/api/cron/daily`)

`src/app/api/cron/daily/route.ts`, `maxDuration = 300`, steps run under a ~250s budget so a slow one
degrades to `skipped` rather than being killed. Fails **closed**: in prod a missing `CRON_SECRET`
returns 401.

Order matters and is documented: `stripe` runs **first** — *"It used to run LAST, behind
ordersFullReconcile — which the comment below admits can eat the entire budget — and as a result it
had not run from cron in weeks while every CronRun died with finishedAt=null. That single ordering
bug is why the books showed a 32% revenue collapse that never happened."* Then `booksSync`
(45-day window) → `booksClassify` (2026-only; *"categoriseBooks MUST follow the sync"*) →
`plaidSync` → `plaidCategorize` → `photoCounts` (21 days, max 80 — the function's own default is
120) → …ops steps… → `ordersFullReconcile` → `plaidRetryErrored` → `shootFocusSummaries` →
`packageMargins` → `growthPlan` (last).

`ordersFullReconcile` sits deliberately near the end and is `Promise.race`d against a **150s** cap:
*"measured 130-330s, it kept blowing past maxDuration and killing the function BEFORE finish() — so
every CronRun died with finishedAt=null and monitoring was blind since inception."* Everything after
it — including `packageMargins` and `growthPlan` — therefore runs on whatever budget it leaves.

### Gotchas / known state

- **`src/lib/bonus.ts` (277 lines) is entirely dormant.** Nothing imports it — no page, no action,
  no cron (verified by grep for `lib/bonus`, `scorecardFor`, `poolMath`, `splitPool`). The
  `BonusPeriod` / `BonusAward` schema models exist and are unused. The engine is fully written
  (self-funding pool = `poolPercent × (surplus − threshold)` capped, weights
  onTime 40 / improve 15 / capture 25 / rating 20, targets calibrated to measured Q2 2026 baselines
  — team on-time 74%, Harrison 80%, James 67%), including an `improve` metric so *"the bonus only
  ever rewards whoever already leads"* isn't the outcome. It has simply never been wired to a UI.
  Note also that `WEIGHTS.improve` is declared but **no `improve` metric row is ever pushed** into
  `metrics[]`, so 15 of the 100 nominal points can never be earned as written.
- **`trueProfitAndLoss()` and `personalSpending()` in `bookkeeping.ts` are dead.** Only a cron
  *comment* mentions `trueProfitAndLoss`. The live P&L is `revenueByProcessor` + `categoryBreakdown`.
  Likewise `paymentChannel()`, `payeeGroup()` and `PAYEE_GROUPS`-adjacent logic: `peoplePayments`
  groups via the `PEOPLE_CATS` map, and `payeeGroup()` can return `"Photographers"`, which is **not
  a member of `PAYEE_GROUPS`** — a rendering mismatch that only doesn't bite because nothing calls
  it.
- **The MoneyTab "revenue is estimated from Aryeo" banner is unreachable.**
  `getMonthlyPnl` hard-codes `revenueIsEstimate: false` (`src/lib/finance.ts:164`), so the
  `AlertTriangle` block at `MoneyTab.tsx:116` can never render.
- **`getMonthlyPnl` still calls `revenueForMonth()` and throws away most of it.** That function runs
  a `StripeTransaction.aggregate` plus a `findMany` and a delivered-projects query, but only
  `aryeoDelivered` is consumed (as the `invoiced` line). `stripeConnected`, `stripeGross` and
  `stripeFees` are computed and discarded on every month.
- **`YEAR_START` is hard-coded `"2026-01-01"`** in `OverviewTab.tsx:19`, `PersonalTab.tsx:10` and
  `PeopleTab.tsx:10`, and books-health counts from the same constant. `SpendingTab` correctly uses
  `new Date().getUTCFullYear()`. On 1 Jan 2027 those three tabs will still show 2026-to-date.
- **`RevenueTab` is the un-migrated legacy Sales Tracker.** It reads `Project.price` only (no
  Stripe, no QuickBooks, no Venmo), buckets "Bookings by month" on `createdAt` (import time) rather
  than `orderedAt` — the exact axis `trends.ts` warns against — and still renders the badge
  *"QuickBooks & Stripe sync — coming with integrations"*, which is stale: both are live.
- **The manual `Expense` table is effectively vestigial for the P&L.** `addExpense` /
  `deleteExpense` still exist on the Money tab and the last 12 rows are listed, but no profit figure
  reads `Expense` — costs come from the Plaid ledger. Its only remaining use is a *fallback* in
  `getCashPosition` (`personal: false, recurring: true` sum) that fires only when 3 months of QBO
  `Purchase` rows fail to sum above zero. `CashSnapshot` is likewise fallback-only now that Plaid
  supplies a live business balance.
- **`jobProfitability()` does not exclude cancelled projects.** Its query is `shootDate` in-window
  with **no `status` filter** (`src/lib/jobProfit.ts:94-95`), while `computePayroll` explicitly skips
  `CANCELLED`. A cancelled job that kept its `shootDate` and `price` therefore lands on the Jobs tab
  with full revenue and $0 photographer cost — a fake 100%-margin row. The Jobs tab's best/worst
  cards filter zero-cost rows out, but the tab totals and `packageMargins` do not.
- **`unassignedShootsInRange()` can produce false positives.** It filters on
  `photographerId: null` only (`payroll.ts:200`) and does not check appointment assignees, so a
  project whose appointments *are* assigned but whose project-level `photographerId` is null will be
  reported as "nobody is being paid for this" even though `computePayroll` pays it.
- **Venmo revenue depends on a manual statement import.** The `VENMO_CHARGES` array is the last-
  resort fallback and covers only 2026-01-05 → 2026-07-16 (22 rows). The file says it plainly:
  *"It is manual by necessity, not by choice: add new charges here, or the Venmo rail silently
  under-reports."* The Aryeo proxy ran ~5% light ($12,425 vs the real $13,125).
- **A hard-coded $1,999 subtraction** sits inside `revenueByProcessor` for a single 2026-02-13
  clawback, and two hard-coded Venmo cash-out cent values are excluded. Both are correct today and
  both are landmines for anyone re-running historical windows.
- **`categoryBreakdown` inserts synthetic rows with `count: 0`** for `Stripe processing fees` and
  adds Stripe Connect transfers into `Creative specialist pay` without incrementing its count, so
  transaction counts on those two Categories rows understate reality.
- **Package margins can be `null` / stale.** `getPackageMargins()` returns `null` until the first
  nightly `rebuildPackageMargins()` succeeds, and `rebuildPackageMargins` swallows its own error and
  returns `{ built: false, error }` — a repeated failure leaves the last good snapshot silently
  ageing (`ageHours` is exposed but the Trends card must choose to show it). Margin is also
  **shoot-date windowed** while revenue-by-package is **order-date windowed**, so the two totals are
  deliberately close but never identical.
- **Photo-editing cost is often $0.** `finishedPhotos` is null until the nightly Dropbox sweep
  visits a job (21-day window, 80 jobs max), and `jobProfit` then books `photoCost = 0`. Every
  photo-heavy margin is an upper bound; `margins.photoCostKnown` is the honest coverage figure and
  the growth-plan prompt is told to say so out loud.
- **Jordan's own shoots carry $0 photographer cost** (he doesn't pay himself), so anything he shoots
  looks cheaper to deliver than it will be once he's out of the field — documented in the
  growth-plan prompt, and the Jobs tab guards its best/worst cards by excluding zero-cost jobs
  *"a $0-cost job... shows a fake 100% margin and would falsely crown 'most profitable'."*
- **OSRM is a public, unauthenticated third party in the pay path.** 5s timeout per leg with a
  haversine × 1.25 fallback, which means a bad OSRM day produces *slightly different pay figures*
  than a good one until the day is cached or hand-overridden. `/sales` and `/my-pay` both set
  `maxDuration = 60` specifically because of this.
- **`travel.ts`'s `MILEAGE_RATE` / `HOME_RADIUS_MI` / `dailyMileagePay()` are not the live formula.**
  Payroll uses the per-member `TeamMember.mileageRate` / `homeRadiusMi` columns (whose schema
  defaults happen to match 0.65 / 35). `dailyMileagePay()` and `haversineMiles()` are only used
  inside `travel.ts` itself; `DriveInfo.cost` is never read by payroll.
- **Live-traffic drive times are not available** — *"Live-traffic drive times would require a
  Google/Mapbox key (future upgrade)"* (`travel.ts:8`).
- Small dead code, verified: `saveSecret` is imported but never called in
  `src/lib/integrations/stripe.ts:2`; `keyToDate()` is defined and unused at
  `src/lib/trendsTools.ts:313`; a local `Kpi` component is defined and never rendered in
  `PersonalTab.tsx:141` and `SpendingTab.tsx:169` (both now use the shared `KpiCards`). `OverviewTab`
  has no such leftover — its local helper is `Stat`, which is used.
- **`classifyRow`'s `accountMask` parameter is deliberately inert** (`void accountMask`,
  `financeCategories.ts:132`) — the "≥$900 → nanny" bank-proxy rule was retired once Lauren's Venmo
  statements were imported under mask `venmoL`; the parameter is kept as a hook.
- **A stale comment in `trends.ts`.** The `SpenderRow.overdue` doc comment at `trends.ts:542` still
  says *"past 1.5x their own normal booking gap"*; the code at `:675` uses
  `Math.max(medianGap * 2, 14)`. The code is the live rule — read the comment as history.
- **The Books-health "Need review" count is the open reconciliation.** It counts `QboTransaction`
  rows with `needsReview = true` since 2026-01-01. Handwritten checks with no payee in the bank
  feed, credit-card payments of unknown business/personal provenance, financing principal-vs-fee
  splits, and personal-account deposits with no Stripe tie are all *designed* to sit there until
  Jordan or his CPA rules on them. Nothing auto-resolves them.

## 7. The creative pipeline: shoot, upload, edit, review

This is the chain that turns a booked order into delivered media: the photographer's
phone screen on site, the cull-and-upload step when they get home, the editor's
brief and queue, and Jordan's review desk where a cut gets approved or bounced.
Everything here is built around one idea — the files themselves are the source of
truth. Nobody "marks a job as shot"; the hub watches the Dropbox folders and moves
the job. The checklists and buttons exist so a human always knows what's left.

The chain, end to end:

| Stage | Surface | What moves it forward | Code |
| --- | --- | --- | --- |
| Booked → on site | `/shoot`, `/shoot/[id]` | Photographer opens the shoot, texts status, ticks the capture list | `src/lib/shoot.ts`, `src/app/shoot/actions.ts` |
| Shot | Same screen, "Mark shoot complete" | `Appointment.completedAt` stamped; BOOKED/SCHEDULED → `SHOT` | `src/app/shoot/actions.ts:182` |
| Upload | `/upload`, `/upload/[id]` | Cull → browser uploads JPGs straight to Dropbox `01-RAW-Photos`; "Submit to editors" | `src/app/upload/cullActions.ts`, `src/app/upload/actions.ts` |
| Editing | `/editing`, `/edit/[id]` | `ensureEditorHandoff` mints the `edit_video` task and routes an editor | `src/lib/tasks.ts:1361` |
| Review | `/review`, `/review/[id]` | Editor "Done — send to review" → `ReviewSubmission` round; owner approves or requests changes | `src/app/review/actions.ts` |
| Fixes back down | `/shoot/feedback`, `/edit/[id]` | Review notes land in the creative's own lane with reply / mark-fixed | `src/lib/review.ts`, `src/lib/photographerFeedback.ts` |

---

### The guided shoot screen

When a photographer opens a job on their phone they get one scrolling card stack:
how to get there, how to get in, what to shoot, who it's for, what to tell the
editor, and what they'll be paid. Three canned client texts and a free-form
message live in a floating bar so they're always one thumb away.

`src/app/shoot/page.tsx` is the list (My Shoots); `src/app/shoot/[id]/page.tsx`
loads one shoot and renders `src/components/shoot/ShootScreen.tsx` (902 lines,
the whole field UI). `getShoot()` in `src/lib/shoot.ts:160` assembles the view
model. The module header states the rule the whole file follows: assemble one
serializable view "while leaving every pricing/financial field OUT."

**Card order is deliberate.** `ShootScreen.tsx:117` records the July 2026 field-UX
audit spec: "get there (map) → get in (access/brief) → shoot (checklist, capture
tools, script) → who it's for (customer, collapsed) → wrap up (editor notes,
media) → pay last."

#### The access brief

Aryeo ships the appointment description as HTML-ish text. `cleanBrief()`
(`shoot.ts:17`) strips tags and entities; `parseShootBrief()` (`shoot.ts:57`)
pulls the structured fields out of Aryeo's "Order Questions:" block into
`lockbox / access / presence / special / timing / orderNotes / extra`. Two
parsing details carry real rationale:

- It parses **only** the text between `Order Questions:` and `Or View Full Order
  Details`, because order-item and customer lines "also look like `- Key: Value`"
  and were being scooped up as questions (`shoot.ts:65`).
- `waitlist` and `square footage` questions are dropped as "internal noise".

`extractZillowUrl()` (`shoot.ts:90`) scans the whole appointment description
(not just the order-notes block) for the first Zillow URL and renders a "Capture
Zillow 3D Home Tour" call-to-action card (`ShootScreen.tsx:508`).

#### Status texts (draft-then-send, never auto-send)

`src/lib/statusTexts.ts` holds three templates — `on_my_way`, `arrived`,
`complete` — written "in Jordan's voice (no em dashes, no emojis, warm +
low-pressure)". Tapping a status button opens a `SendSheet` with the drafted text
editable; only then does it call `sendShootStatusText()`. `src/app/shoot/actions.ts:9`
states the contract: "Client texts are DRAFT-then-SEND … nothing here auto-sends."

Sending goes through `sendClientText()` (`actions.ts:23`), which resolves the
client's phone, calls `OpenPhone.sendMessage`, then writes **both** an `Activity`
row (team timeline) and a `CommLog` row (Ask-the-Hub memory). The CommLog
`externalId` is stamped `op-<id>` deliberately: "Match the OpenPhone webhook's
`op-<id>` format so its later echo of this same outbound text dedupes instead of
double-logging the conversation."

`draftClientMessage()` polishes a rough note via `polishOutbound` — draft only,
and it errors out with a clear message if the AI connection isn't configured.

#### Capture checklist

Each ordered `Deliverable` becomes a tick row. `CAPTURE_GUIDE`
(`ShootScreen.tsx:34`) maps `DeliverableType` → a plain-English "what to actually
capture" line (e.g. `DRONE`: "Aerials — front, rear, roofline, lot lines, and a
little neighborhood context"). Ticking calls `setDeliverableCaptured()` which
writes `Deliverable.capturedAt`.

`POST_PRODUCTION_TYPES = {VIRTUAL_STAGING}` is excluded from the checklist —
"ticking 'captured virtual staging' makes no sense" — but still renders a dashed
reminder card telling the photographer to shoot those rooms "empty, clean, and
straight-on so the editor can furnish them."

Above the checklist sit two blocks the audit added:
- **"Don't leave without"** (amber) — the order's `special` instruction plus
  logged `SPECIAL_REQUEST` activities, capped at 6, with the `Client request
  (openphone):` provenance prefix stripped. Comment: "the things that aren't a
  standard deliverable but WILL come back as a revision if missed."
- **"Good to know for this agent"** — up to 5 `shootNotes` from the AI-built
  client profile, de-duplicated against the must-gets.

"Mark shoot complete" warns via `window.confirm` if any checklist rows are
unticked but never blocks.

#### Other cards

- **Map/route** — `getShootMapData()` (`shoot.ts:371`) pins this shoot plus the
  photographer's other shoots that ET day, plus home base, plus a driving route
  from `dayRouteGeometry`. Its member-scoping OR clause is written to match
  `computePayroll`'s so "the route map agrees with the pay card's
  dayMiles/sharedJobs" — including the case where all of a day's legs were
  reassigned, and the same-day-cancel case (`shoot.ts:398-411`).
- **Reel script** — read-only. For video/reel jobs `ReelScriptCard` renders
  `reelHook / reelScript / reelSong / reelShotList` synced from Script Studio; if
  empty it renders an amber "No script yet" card pointing at Script Studio.
- **Pay** — `ShootPayCard` streams in via Suspense. `shootEarnings()`
  (`shoot.ts:274`) reuses `computePayroll` but scopes it to that shoot's ET day
  only: "the difference between a snappy page and a multi-second OSRM stall."
  It only ever shows the *viewer's* own numbers — `payMemberId = viewerMemberId ??
  view.photographer?.id` so "a second shooter on someone else's project must never
  see the primary's pay" (`shoot/[id]/page.tsx:37`).
- **Flag an issue** — free-text box; `flagShootIssue()` writes an `Activity` of
  type `FLAG` *and* calls `fileFieldIssue()`.
- **Notes for the editor** — writes straight into `Project.editorBrief`, the same
  field the upload portal and `/edit/[id]` read, "so nothing is re-typed."

#### Field flags → the Feedback board

`src/lib/fieldIssues.ts` exists because flags "died unseen unless someone happened
to open the job." `fileFieldIssue()` mirrors every field flag into a
`PlatformFeedback` row with `kind: "field_issue"`, an ops Slack alert, and an
OWNER bell. Three call sites with three labels:

| Label | From | Dedupe |
| --- | --- | --- |
| `Shoot issue` | `flagShootIssue`, `/shoot/<id>` | no — "each typed flag is a distinct issue" |
| `Upload issue` | `flagIssue`, `/upload/<id>` | no |
| `Shoot debrief` | `submitAppointmentFeedback`, `/upload/<id>` | **yes** — the debrief card re-renders on every portal visit |

The "had issues" debrief also upserts a HIGH `internal_instruction` SmartTask due
in 4 hours, deduped `shoot-issue-<projectId>`, owned by Kyle.

#### Marking the shoot complete

`completeShoot()` (`src/app/shoot/actions.ts:182`) stamps
`Appointment.completedAt`, advances BOOKED/SCHEDULED → `SHOT`, and then
**immediately** calls `syncProjectStatuses({ projectId })`. The comment records
why: "The old button set SHOT and told no one — the sweep saw no transition, so
the editor's task never minted (July 2026 audit)." It also posts a
`ProjectMessage` ("Shoot complete at X. Ready to upload content.") and rings
OWNER+ADMIN. It deliberately does **not** text the client — that stays the
separate reviewable status text.

---

### Cull before upload, and the photo budget

Galleries were shipping way over count. Extra photos cost real AutoHDR money and
clients said big galleries are a hassle. So the hub now gives every home a photo
*budget*, shows it in the field and at the drop point, and lets the photographer
throw away bad bracket sets **before** they upload.

`src/lib/culling.ts` is the whole policy, and its header is the evidence base:
"Nobody culls at any stage: delivered count == final-folder count in EVERY
observed job, 76% of galleries ship over 50 photos and 40% over even the 80
large-property allowance. Kyle delivers the whole final folder because he has no
signal." It has no `server-only` import on purpose so the client shoot guide can
render the same number the sweep enforces.

| Constant | Value | Meaning |
| --- | --- | --- |
| `BRACKET_RATIO` | 5 | Crews shoot 5-bracket JPG sets; AutoHDR blends each to one final |
| `RAW_OVERAGE_FACTOR` | 5.5 | Raw ceiling. "5.5 (not 5.0) leaves the same ~10% slack over the pure bracket ratio the old 3.3-on-3 had" |
| `LARGE_PROPERTY_SQFT` | 3500 | At/above this, budget is 80 finals; otherwise 50 |

`photoTargetFor(project)` = explicit `Project.photoTarget` override → else 80 if
`squareFeet >= 3500` → else 50. `squareFeet` comes from the Aryeo listing sync and
may be null on older/manual jobs, which falls back to 50. The owner sets the
override from the project page (`PhotoTargetControl`, saved by `src/app/actions.ts:452`).

`roomBudgetText(target)` renders the room-by-room plan on the PHOTOS checklist row:
"exteriors 6-8, kitchen 4-5, living/dining 4-6, each bedroom 2-3, each bath 1-2,
features 4-6. Shoot each composition ONCE — don't machine-gun."

`CullingReminder` (`src/components/upload/CullingReminder.tsx`) carries the pay
line — "Over-delivering comes out of shoot pay" — but the `/shoot` field view
passes `hidePay`, because photographers see counts only, never money.

#### The cull UI

`src/components/upload/CullUploader.tsx` (498 lines) runs entirely in the browser:

1. Pick the card's JPGs. `onPick` **silently filters** non-JPGs out of the
   selection and only errors ("No JPGs in that selection") when nothing is left;
   the hard reject lives server-side in `safeName`.
2. `groupFiles()` sorts by `File.lastModified` (the file's mtime — not EXIF) and
   collapses consecutive frames ≤ `GAP_MS` (2500ms) apart into one bracket set,
   capped **at** the bracket size (`cap = Math.max(1, bracket)` → 5) — "machine-
   gunned back-to-back bursts (<2.5s between compositions) must split ON the
   bracket boundary, never mid-HDR." Files matching `/^DJI[_-]/i` are treated as
   single-shot drone sets.
3. Keep/drop per set, with **split at any frame** and **merge with next** for when
   the grouping guess is off (Jordan: "sometimes it's messy and we have more or
   less"). A full-screen lightbox supports ← → between sets, space to keep/drop,
   Esc to close; opening a set lands on its middle frame (the 0EV exposure).
4. Only keepers upload.

Thumbnails are lazily created object URLs behind an `IntersectionObserver`
(`rootMargin: 400px`) and revoked on unmount — "a 600-JPG card would eat a phone's
memory otherwise."

Staged sets are held in a module-level `cullStash` Map so in-app navigation doesn't
lose the cull; a hard reload does (browsers can't rehydrate `File` handles), so a
`beforeunload` handler warns while work is at stake. Returning to a page that was
mid-upload shows an honest warning rather than a guess.

#### The upload path (bytes never touch the server)

`src/app/upload/cullActions.ts`:

- `createUploadLinks(projectId, fileNames)` — guards with `requireShootAccess`,
  caps at `MAX_FILES_PER_BATCH` 400, sanitises names (`safeName`: JPG-only, no
  dotfiles, `[^\w.\- ()]` → `_`, 120 chars), then mints Dropbox
  `files/get_temporary_upload_link` per file at `LINK_CONCURRENCY` 12 with
  `mode: add, autorename: true`. Each mint retries up to 3 times with 500/1000/1500 ms
  backoff on 429/5xx/network, because "one flaky call out of hundreds used to
  reject the whole `Promise.all` and abort the entire upload."
- The browser then `POST`s each file to its one-time link, `UPLOAD_CONCURRENCY` 4
  at a time, links minted `LINKS_PER_CALL` 25 at a time *as the upload progresses*
  so "the first bytes move within a second of pressing Upload." Files are paired
  with links **positionally** — "two cards can both have an IMG_0001.jpg."
- Failures collect into a retry list with a re-upload button; the batch keeps going.
- `finalizeCullUpload()` writes the receipt Activity: `Culled on upload: kept N of M
  sets — X JPGs uploaded, Y culled before upload[, Z FAILED …]`.

The design note at the top: the hub's Dropbox token never reaches the client and
the bytes never touch the server, "so it's as fast as their connection allows."

#### Budget chips

- `/upload` list — one `folderFileCount` call per **SHOT** job (`rawPhotoCounts`,
  lean by design so a list doesn't fan out four calls per row). Amber "Over budget"
  chip when raws > `rawOverageCeiling(target)`.
- `/upload/[id]` — live raw count vs budget: muted ≤ `target × 5`, **warning** past
  it, **danger** past `round(target × 5.5)` with "over budget, cull before
  delivering".
- Inside the culler — `overBudget` when kept sets > `round(photoTarget × 1.15)`.

#### The server-side backstop: `mintCullTask`

The chips only help someone who is looking. The hourly status sweep also checks
(`src/lib/projectStatus.ts:598`): for a `SHOT` or `EDITING` job with a readable
Dropbox signal, if `rawPhotos > photoTarget × RAW_OVERAGE_FACTOR` it stamps
`evidence.cull = { rawPhotos, photoTarget, overBy }` — "so the project page shows
WHY" — and calls `mintCullTask` (`src/lib/tasks.ts:1012`). That mints **one** HIGH
`todo` task ever per project (`cull-<projectId>`), due in 4 hours, routed to the
photographer by first-name slug (null → triage rather than the wrong person),
titled `Cull before edit — <street>: N JPGs ≈ M finals vs ~T target`, with a
4-step checklist. It then texts the photographer, "they've left the property, so
the bell alone won't reach them." Window rationale: "Raws in but not yet delivered
is the only window where over-shooting can still be fixed cheaply … SHOT/EDITING
only — never nag a delivered job." Note the asymmetry: the task *fires* on the 5.5×
overage trip but reports `overBy` against the 5× bracket budget.

---

### The Dropbox folder convention, and how file presence drives status

Every job has a folder tree in Dropbox named the same way the old Zapier "AutoHDR"
automation named it. The hub computes that path from the project and counts files
in it — that's how a job becomes "Shot" or "in Review" without anyone pressing a
button.

`src/lib/dropboxFolders.ts:53`:

```
/AutoHDR/{Year}/{Quarter}/{Month}/{Street} ({Client Name})/
  01-RAW-Photos · 02-RAW-Video · 04-Final-Photos · 05-Final-Video
```

(There is no `03-` folder in the convention.) `Street` is `addressLine` or the
first comma-segment of the title; `Quarter` is `Q{floor(monthIdx/3)+1}`; the date
used is `shootDate ?? createdAt`.

**Year/month are computed in Eastern time** via `Intl.DateTimeFormat`
(`etYearMonth`, `dropboxFolders.ts:41`). The comment records the bug: server time
on Vercel is UTC, so "an ET evening shoot near a month/quarter boundary computed a
DIFFERENT folder than the one the files actually live in, and every count read
zero (July 2026 audit)."

**Null ≠ zero.** `folderFileCount()` returns `0` only when Dropbox says
`not_found`/`path_lookup` (a trustworthy "nothing was uploaded there"), and `null`
for auth/rate-limit/network. The rationale: "an expired token used to render every
folder 'empty' to a photographer double-checking their 300-raw drop." The upload
page renders `"couldn't check"` for a null, never `"empty"`. `rawPhotoCounts`
simply omits a row whose read failed so the over-budget chip doesn't render at all.

**Where status actually comes from.** The live engine is `syncProjectStatuses()`
in `src/lib/projectStatus.ts`, run hourly by `/api/cron/sync` (`vercel.json`:
`0 * * * *`) and on demand after both photographer "done" buttons.
`gatherSignals()` (`projectStatus.ts:387`) reads Aryeo media first and only spends
Dropbox calls "when Aryeo doesn't already account for everything ordered — Aryeo is
the delivery source of truth; Dropbox explains the in-flight stage." If **any** of
the four folder reads returns null, the whole Dropbox signal is discarded as
unavailable: "partial counts would read as 'media vanished'. Unknown beats wrong."

`syncDropboxFolderStatus()` (`dropboxFolders.ts:152`) is the older, simpler
advance-only sweep, scoped to `source: "ARYEO"` projects in
BOOKED/SCHEDULED/SHOT/EDITING/REVIEW: RAW files present + status BOOKED/SCHEDULED
→ `SHOT` + `uploadedAt`; FINAL files present + status SHOT/EDITING → `REVIEW`;
plus auto-completing `confirmation_text`/`appointment_prep` tasks, calling
`notifyRawsLanded`, and re-running `generateTasksForActiveProjects()` if anything
moved. It is **only** reachable from the owner's "Check Dropbox folders" button
on `/connections` (`syncDropboxFoldersNow`, `src/app/connections/actions.ts:187`,
`requireOwner`) — it is not on any cron.

**Photo counting for cost.** `src/lib/photoCount.ts` counts `01-RAW-Photos` and
persists `rawPhotoCount / dronePhotoCount / photoCountedAt` on the Project so the
Finance Jobs tab never hits Dropbox at render time. Owner's formula (2026-07-22):
`finishedPhotos = round((raw − drone) / 5) + drone`, costed at $0.50 each
(`src/lib/jobProfit.ts`). Drone files are detected by filename
(`/^dji|dji[_-]|drone|mavic|air ?2|^m3[_-]/i`). `sweepPhotoCounts` runs in the
daily cron (`days: 21, max: 80`) and re-counts anything shot in the last 10 days
"(files keep landing for a few days after the shoot)".

**Other Dropbox conventions:**
- `src/lib/storage.ts` — everything the app itself stores lives under one
  app-owned prefix, `/RealTour Pilot/Hub`, so the `/api/file` route "can hard-scope
  what it's willing to serve and never reach into the rest of the team's Dropbox."
- `src/lib/clientFolders.ts` — `/RealTour Pilot/Clients/<Client Name>/Brand Assets`,
  created idempotently and cached on `Client.brandAssetsPath`; linked from the
  editor brief page as "Brand assets (logo, fonts)".

---

### The upload portal

Come home, unload the gear, clear the day's uploads. The list is bucketed by day
so the newest shoots are first; each job page shows the Dropbox folders with live
file counts, the cull tool, a per-deliverable checklist, a flag box, the editor
brief, and a shoot debrief.

`src/app/upload/page.tsx` buckets by ET calendar day: `today / yesterday / week
(≤7d) / older / upcoming / unscheduled`. Upcoming sorts oldest-first (next shoot
first); everything else newest-first. Only `BOOKED | SCHEDULED | SHOT` projects
appear. Photographers are scoped to their own jobs, failing closed to `"__none__"`.

`src/app/upload/[id]/page.tsx` renders, in order: the Dropbox folder card with
per-folder counts and web deep links, the culling reminder, the `CullUploader`,
the `UploadPortal` checklist, then `AppointmentFeedback` (the debrief).

`markDeliverableUploaded()` is the accountability tick — "Photographers upload to
Dropbox directly (no in-app files), so this is the accountability signal that the
raw files for this item are in." It only moves `PENDING → UPLOADED`; it never
downgrades work already in progress, and unticking leaves the status alone.

#### "Submit to editors" — `finalizeUpload()`

`src/app/upload/actions.ts:154` does five things, in this order:

1. **Server-side completeness check against the order.** For a job that ordered
   photos (`PHOTOS|DRONE`) or video (`VIDEO|SOCIAL_REEL`), it counts the matching
   raw folder. An empty folder returns `needsConfirm` with a specific warning
   ("the RAW-Video folder is empty (a video is ordered!)"), which the client turns
   into one `window.confirm` and then re-submits with `force: true`. The comment
   names the bug it replaced: "the old client-side confirm was honor-system only —
   July 2026 audit: 'photos-only upload reads as raws-in for a video job'." If
   Dropbox can't be read, it does **not** block — "unknown is not proof of absence."
2. Writes `editorBrief` (only if non-empty — "a re-finalize with an empty field
   must not wipe the photographer's notes") and stamps `uploadedAt`.
3. Advances BOOKED/SCHEDULED → `SHOT`.
4. On the **first** finalize only, calls `syncProjectStatuses({ projectId })` so
   the full editor handoff runs immediately. Comment: "the old wiring only pinged
   Slack and never minted the editor's work item (July 2026 audit: 'both
   photographer done buttons suppress the editor handoff')." If that throws it
   falls back to `notifyRawsLanded` alone.
5. Best-effort: auto-creates the Frame.io review project for VIDEO jobs (only
   when Frame.io is connected and `frameioProjectId` is still null).

**If nobody ever presses submit**, `reconcileRawsMissing` (`src/lib/tasks.ts:1547`)
is the backstop: for BOOKED/SCHEDULED jobs whose shoot is in the past and whose
raws are `RAWS_MISSING_AFTER_MS` (18h) late, it mints ONE deduped chase task on
Kyle plus a bell/SMS to the photographer, and self-clears when files land — "the
'shoot happened, nothing ever landed' alarm the system never had (877 S York sat
SCHEDULED for 11 days with nobody told)."

`Project.editorPdfPath` is set to `/api/projects/<id>/editor-brief` — a route, not
a file. `src/app/api/projects/[id]/editor-brief/route.ts` rebuilds the PDF from
live project data on every request: "That keeps it working on Vercel's ephemeral
filesystem, always reflects the latest project data, and means a photographer's
field submit can't fail on a storage hiccup." Access is `requireShootAccess` —
owner/admin or the assigned photographer.

`src/lib/editor-pdf.ts` builds it with `pdf-lib` (A4, Helvetica) in sections:
Shoot details → Deliverables to edit → Client editing preferences → Special
requests → Photographer's notes → Flagged issues (red). `clean()` strips smart
quotes, ellipses, dashes and anything outside WinAnsi "so user notes never crash"
the standard-font encoder.

---

### Editor routing: who gets what

Photos are edited by AI (AutoHDR); humans only touch video. The hub has two
routing tables — one for *display* (which vendor a deliverable belongs to) and one
for *people* (which editor's queue a job lands in).

**Vendor routing** — `src/lib/vendors.ts`, used for the vendor chips on cards:

| Deliverable type | Vendor |
| --- | --- |
| `PHOTOS`, `TWILIGHT`, `DRONE`, `HEADSHOT` | AutoHDR (external) |
| `FLOORPLAN` | CubiCasa (external) |
| `VIRTUAL_STAGING` | Staging (external) |
| `SOCIAL_REEL`, `VIDEO` matching `/premium/i` (on the refined label **or** the raw label) | Luma (external) |
| `SOCIAL_REEL`, `VIDEO` otherwise | In-house |
| `MATTERPORT_3D`, `ZILLOW_3D`, `OTHER` | In-house |

**People routing** — `src/lib/editors.ts`. The roster as of 2026-06, recorded in
the file header: Kim → personal-branding / monthly social · Remar → standard reels
+ horizontal video · Luma → premium/influencer reels (external) · Kyle → QC +
item removal / virtual staging / declutter / fixes · AutoHDR → AI photo editing ·
CubiCasa → floor plans. "Adrian was let go — not an editor." The Creative Director
(Jordan) does **scripting and creative direction only**.

`editorForDeliverable(type, label, monthly)`:
- `FLOORPLAN` → `cubicasa`
- `SOCIAL_REEL`/`VIDEO` + premium/influencer label → `luma`
- `SOCIAL_REEL`/`VIDEO` + monthly/brand/social → `kim`
- other video → `remar`
- everything else (photos, drone, twilight, headshots, staging, 3D) → `kyle`

`routeEditWork(text)` routes a free-text instruction, and **precedence matters**.
Coordination is checked first and always goes to Kyle even when it reads like
editor work: music selection, delivery dates, virtual/digital staging, declutter,
retouch/photo fix, reflection/blemish/crooked/tilt. The comment explains: "These
read like editor work ('…for the video') but the admin owns them … Checked FIRST
so an incidental 'script' mention in the thread can't pull a delivery/music task
to the Creative Director." Then, in order: `script|storyboard` → `creative_director`
· floor plan → `cubicasa` · premium/influencer + reel/video/social/bundle → `luma`
· personal-brand/monthly/social/logo/animation → `kim` · reel/horizontal video/
b-roll → `remar` · photo/saturation/HDR/brighten → `kyle` · otherwise **null**
("stays in 'Needs you' for a human to assign").

Only `TEAM_MEMBER_EDITOR_KEYS = ["kim", "remar"]` map to a real `TeamMember` and
therefore to `Project.editorId`; externals/vendors "stay Kyle-dispatch and never
get a TeamMember link — their work is tracked by the `edit_video` task."

**Notification channels** are code constants, not schema. Each editor carries an
optional `teamMemberName` (to resolve their SMS phone), `slackUserId`, and a `tz`.
`DEFAULT_EDITOR_TZ = "Asia/Manila"` because "the Manila editors' night is
precisely the old ET texting window, so a text keyed to ET would fire at 3am their
time." Kim has a TeamMember row with a phone; **Remar does not yet, so SMS no-ops
for her**, and `slackUserId` is unset for everyone.

#### The handoff

`ensureEditorHandoff(projectId)` (`src/lib/tasks.ts:1361`) runs on every status
sweep pass and is idempotent throughout. Its five steps, from the header:

1. Raws in → `notifyRawsLanded` (bench ping + Luma dispatch, once).
2. Video job → persist `Project.editorId` for the tracker + one-click reassign.
3. Cut already submitted or verifiably live → clear stale nudges, done.
4. Raw video **known** missing (folders readable, zero video files) → ONE deduped
   HIGH `todo` task, "Find the raw video — <street>", due in 4 hours, owned by
   Kyle, plus a bell to the photographer pointing at their upload page. It then
   *holds* the edit task until footage is findable.
5. Otherwise → `mintEditTask`, and resurrect a falsely-completed work item when
   the sweep can prove no cut exists anywhere (submissions, video evidence) and no
   open revision is carrying the work. This is "how the 5-Nathaniel-Ct class of
   silent losses self-heals."

A job with `assignedManually` on its `edit_video` task is exempt from steps 2 and 4:
"don't overwrite their routing, and don't chase raw video — the owner just looked
at the job (old footage / externally-held files are expected there)."

`notifyRawsLanded` writes its timeline marker row **first** ("crash-safe
idempotence") with neutral wording, then stamps the *actual* outcome once
`notifyInApp` reports which channel worked — Slack DM, SMS, ops relay, quiet-hours
hold, or bell only. The comment names why: "the old hard-coded 'notified via
Slack' claimed delivery that often never happened (Remar has no Slack/phone)."
Premium-reel jobs additionally mint one deduped `luma-dispatch-<projectId>` task
for Kyle ("Send raws + brief to Luma"), HIGH, due +4h.

`mintEditTask` sets `dueAt` to the video's SLA delivery-due **minus a 12h QC
buffer** — "the edit has to be in the door early enough for Kyle to QC + the client
to see it before the SLA clock actually expires" — and never backdates below
"now + nudge" for an already-late job.

#### Chasing the external vendors

The two vendors that deliver *directly into Aryeo* get a round-trip watchdog:
`VENDOR_CHASE` (`src/lib/tasks.ts:949`) — CubiCasa floor plans after **3** days,
AutoHDR photo edits after **2** — because "Floor-plan turnaround is 36h; photos are
next-morning. Chasing a day+ past those SLAs keeps this conservative." The sweep
calls `chaseVendorsForMissing` for any non-delivered `SHOT/EDITING/REVIEW` job with
that category still missing, minting one HIGH `comms_followup` per project+category
("one chase per project+category, ever — a completed chase means Kyle already
handled it"). Related: `computeStatus` deliberately excludes floor plans and 3D
tours from the "delivery started" test, because "vendors (CubiCasa auto-syncs to
Aryeo hours after the scan) … jumped fresh shoots SCHEDULED → REVIEW before the
photographer even uploaded raws, which hid the job from the upload portal (3188
Thornapple, Jul 2026)."

---

### The editor queue and the per-edit brief

`/editing` is video-only: "photos are edited by AI, so editors only touch
video/reel jobs" (`src/app/editing/page.tsx:14`).

**If you're an editor** you get `EditorDay` — a personal worklist DB-scoped to
your own `assignedKey`: "Do now" (open `edit_video` + `revision` tasks sorted by
due date, each with a live SLA countdown, RAW / Brief / Frame.io links and the
"Done — send to review" button) and "Up next — this week" (booked/scheduled video
shoots in the next 7 days, deliberately **not** editor-scoped — "a shoot has no
editor yet"). Creative-safe: no money anywhere.

An EDITOR login with neither an `editorKey` nor a name **fails closed** to a
"ask Jordan to set your editor key" message rather than falling through to the
owner view, "it carries every job + the add-to-queue control."

**If you're owner/admin** you get the manual `AddToQueue` control, a
`VideoSlaPanel` of in-flight video jobs with one-click reassign, and the
`ProjectTracker` spreadsheet filtered to `kind === "video"`.

#### Manual add-to-queue

`addToEditorQueue()` (`src/app/editing/actions.ts:143`) is "the human override" for
jobs the automatic handoff never picks up: video added after booking, old footage,
non-Aryeo work. `requireAdmin`, and the editor must be one of Kim / Remar / Luma.
A job whose order had **no** video first gets a synthetic `VIDEO` deliverable
labelled `Video — added manually`, "so every engine (tasks, SLA, tracker) sees
it." Then it has **two rails**, "so the hourly engines never fight the add (the
adversarial review proved they would)":

- **Fresh job** (no prior cut anywhere) → status `EDITING` + `edit_video` task with
  `assignedManually: true`. It calls `mintEditTask` → claim → `mintEditTask` again,
  because "the second pass refreshes summary/due/priority for a task that was
  COMPLETED before the reopen (mint #1 early-returns on those)".
- **Prior-cut job** (DELIVERED, or any past `ReviewSubmission`, or final-video
  evidence in `statusEvidence`) → the **revision** machinery: `revisionRequestedAt`
  pins the stage, `reflectRevisionInQc` reopens the QC card with revision framing,
  and one deduped `revision` task lands on the editor. Explicitly *not* a QC-miss
  stamp on Kyle's dial: "a new-cut request is NOT a QC bounce."

Bells split by editor kind: Kim/Remar get a person-addressed `editor:<key>` row;
Luma has no login or phone, so the row goes to ADMIN — "Kyle dispatches Luma work,
so the bell goes to ADMIN instead of a row nobody can see."

`setEditVideoEditor()` (reassign) sets `assignedManually: true` so "the hourly
handoff/mint refresh won't route it back", and repoints `Project.editorId` (or
clears it for externals so the tracker doesn't show a stale name).

#### `/edit/[id]` — the editor's brief

`src/app/edit/[id]/page.tsx` (336 lines). Photographers are redirected to
`/shoot/<id>`. The page carries:

- **`EditTracker`** — a Luma-style stage timeline derived entirely from hard state:
  project status, video-lane revision tasks, whether raws landed
  (`statusEvidence.dropbox.rawVideo > 0`), and the round history.
- **Video-lane scoping.** `VIDEO_REVISION_KEYS = {kim, remar, luma}`: "a photo
  retouch routed to Kyle also flips the project to REVISION, but it is NOT this
  editor's work order — it must never flip the video tracker or render as their ask."
- **Approval doesn't get resurrected.** Only a video revision raised *after* the
  approval outranks an approved latest round.
- **Strict money scrub.** `canSeeRaw` requires a live OWNER/ADMIN session; anything
  else gets `stripMoneySentences`, and an ask that scrubs away entirely becomes
  `"(a note was held back — ask Jordan)"` rather than being dropped, "so the round
  labels stay on the right ask."
- Review-Room feedback for that editor (`getEditorFeedback`), the read-only Script
  Studio card, the photographer's editing notes + per-deliverable notes + special
  requests, RAW / Final / Brand-assets Dropbox links, the "Done — send to review"
  card, project chat, and the client's brand colors + working profile.

---

### The Review Room

`/review` is Jordan's quality desk now that he's out of the field: every cut an
editor has submitted, every cut waiting on editor changes, photo sets sitting in
QC, and every open review note by lane. `/review/<projectId>` is the workspace
where he watches one cut, drops timestamped notes, and approves or bounces it.

Owner/admin only (`src/app/review/page.tsx:73`, redirects to `homeFor(role)`; a
sessionless local dev with `AUTH_ENFORCE` off passes) — creatives get their feedback
on their own surfaces. Reads live in `src/lib/reviewRoom.ts`, mutations in
`src/app/review/actions.ts`.

#### Submissions and rounds

`ReviewSubmission` (`prisma/schema.prisma:1060`) is an append-only audit trail:
"rows are an audit trail of every cut, never overwritten." One row per submitted
cut with `round` (+1 per re-submission), `status` ∈ `PENDING | CHANGES_REQUESTED |
APPROVED`, `assetUrl` / `assetPath` / `fileName`, `submittedByKey/Name`, `note`,
`decidedAt/By`. `kind` defaults to `"video"` and the schema comment marks
`photos` as "reserved for later" — nothing writes it today.

`submitCutForReview()` (`review/actions.ts:145`):
- Finds the submitting editor's **own** open `edit_video`/`revision` task and
  authorises off it — "authorizing off the oldest open task regardless of assignee
  let one editor's submit close ANOTHER editor's work item (audit)." An EDITOR with
  no `editorKey` falls back to their name slug, because "a bare null here would
  UNSCOPE the close."
- `findLatestCut()` lists the `05-Final-Video` folder, filters `.mp4|.mov|.m4v|.webm`,
  sorts by `server_modified` descending, and mints a Dropbox shared link. Failure
  is non-fatal — the room "degrades to folder links + manual-timestamp notes", and
  the success message honestly says "no video file was found in the Final folder
  yet, so upload it there if you haven't."
- Closes only the submitter's own tasks, moves EDITING/SHOT → `REVIEW` (never
  demoting a job past review), rings OWNER+ADMIN.

#### Notes on a cut

`addCutNote()` is owner/admin only. Notes are `MediaNote` rows with a `timeSec` and
a lane — `EDITOR` (the editor fixes it) or `PHOTOGRAPHER` (a capture problem, which
gets pinned to whoever shot it, falling back to the earliest appointment assignee).
Cuts with no minted link thread their notes under a synthetic `cut:<submissionId>`
asset key "so feedback still works when Dropbox couldn't serve a streamable URL."

`replyCutNote()` opens the door wider than `setCutNoteStatus()` on purpose: an
`@`-mentioned photographer may reply (their ping said "reply on the note"), but
status flips stay with the note's own addressee — `allowMentioned` is a
reply-path-only flag "so a mention never lets someone flip another photographer's
fix status."

#### Verdicts

- `approveCut()` → `APPROVED` + decidedAt/By, ADMIN bell ("Ready to deliver"), and
  an EDITOR bell **only** for Kim/Remar: "a Luma/vendor (or 'editor:kyle') key
  would mint a row visible to NOBODY."
- `requestCutChanges()` → refuses if there are no open EDITOR notes **on this
  submission's asset key** ("the editor needs to know what to change"), and again
  if no editor is routed ("assign one on the Editor Queue first"); otherwise
  bundles them into **one** `revision` task deduped
  `cut-changes-<projectId>` (HIGH, due +24h) with each note rendered as
  `• [m:ss] body`, flips the submission to `CHANGES_REQUESTED`, and moves REVIEW →
  `EDITING`. Not `REVISION` — that status is "reserved for client-requested
  post-delivery changes so the comms engine's meaning holds."

#### The queue page

`getReviewQueue()` (`reviewRoom.ts:63`) builds four lists in one pass:

- `pending` / `waitingOnEditor` / `recentlyApproved` (14-day window) — only the
  **latest round per project** appears; "older rounds are history and live in the
  workspace timeline instead."
- `photoQc` — open `media_qa` SmartTasks (Kyle's photo QC cards).
- `followUps` — per project+lane rollup of `OPEN` (someone owes a fix) and `FIXED`
  (the owner owes a re-look), plus `awaitingReply`: threads where a **creative**
  spoke last. That last one exists because "a creative's 'which bathroom do you
  mean?' otherwise rots invisibly once the owner stops opening the thread."

The page also renders "What's slipping through" from `src/lib/qc.ts`:
`getFixPatterns(60)` (photo-flag tag counts, open count, EDIT-lane note count,
capture notes per photographer) and `getQcStats(30)` (QC passes, most-missed
checklist labels, and the % of passes a revision later reopened).

---

### Photo review: pins, threads, verdicts, and image flags

Two separate mechanisms operate on delivered photos, and they mean different things.

**Review pins** (`MediaNote`, owner's desk) — in the project gallery's Review mode
the owner taps anywhere on a photo to drop a note at a normalized x/y, choosing a
lane. Reads: `src/lib/review.ts`. Mutations: `src/app/projects/reviewActions.ts`.

- Root notes carry the pin and the status; replies thread via `parentId` and carry
  neither. **Every rollup filters `parentId: null`** — "a chatty thread must never
  inflate an 'open fixes' count."
- The EDIT lane is coerced to `kind: "fix"` server-side ("EDIT lane is always
  actionable"); the PHOTOGRAPHER lane can be `fix` or `coaching`.
- Status flows `OPEN → FIXED` (creative marks it done) `→ RESOLVED` (owner
  approves). Reopen and approve stay with the owner; the creative may only mark
  their own note `FIXED`.
- When the **last** open EDIT note flips to FIXED, the bundled task auto-completes
  and the owner gets a "Ready for re-review" bell, deduped on the FIXED count so
  it's "one bell per review round, not per click." The PHOTOGRAPHER lane got the
  same closer later — the comment notes it "had NO closer at all (audit)."
- `setMediaVerdict()` is the quick per-asset thumbs call (`APPROVED` /
  `NEEDS_WORK` / null to clear) while arrowing through the gallery.
- `sendReviewToLane()` bundles a lane's open notes into one task. It uses
  `taskType: "todo"`, **not** `image_fixes`, and the header explains at length:
  `image_fixes` is in `DELIVERED_CLOSE_TYPES`, so the delivered-close sweep "would
  silently blanket-complete the review task while notes were still open. Review
  happens ON delivered jobs, so that sweep would fight our own closer." EDIT bundles
  go to `assignedKey: "kyle"`; PHOTOGRAPHER `fix` notes go to `assignedKey:
  "jordan"` ("owner follows up on capture quality personally") while coaching rides
  the bell only.

**Image flags** (`ImageFlag`, the "many flags → one fix task" path) —
`src/app/projects/flagActions.ts`. From the lightbox anyone can tag a photo with
one or more of the six fixed tags in `src/lib/imageFlags.ts`:

`Item Removal · Perspective Corrections · Color/Lighting · Mirror Reflection ·
Sign in the Yard · AI Error`

That vocabulary is deliberately fixed — it doubles as "the training labels for the
later automated QA/editing model", and the module is kept plain (not `"use server"`)
so both the server action and the client gallery can import it.

`syncFixTask()` rebuilds **one** task per project from its currently-OPEN flags:
`image_fixes-<projectId>`, HIGH, due in 24 hours, owned by Kyle, titled `Fix N
flagged photos — <street>`, with an aggregated tag summary (`Color/Lighting (3),
Item Removal`) and every note as a bullet, plus a 4-step checklist. When the last
flag is resolved the task auto-completes. `flagImages` tries `requireStaff`
(OWNER/ADMIN/EDITOR) first and falls back to `requireShootAccess` — "the lightbox
shows them the Flag button, and the old staff-only guard made every tap error
(audit)."

The lightbox nudges the distinction explicitly: below "Flag for Kyle (24h)" sits
"Capture issue? Pin it for the photographer instead", because "a flag is 'Kyle
fixes the file'; a capture problem belongs to whoever shot it."

---

### Photographer feedback and KPIs

Every capture note Jordan ever pinned to one photographer, in one place, with
the numbers that answer "how am I doing" — plus an AI summary that turns a pile
of per-photo critiques into three or four habits to work on.

`/shoot/feedback` (`src/app/shoot/feedback/page.tsx`), reads in
`src/lib/photographerFeedback.ts`. Photographers see only themselves (fail-closed);
owner/admin without `?as=` get the roster, and `?as=<memberId>` opens any
photographer's hub read-only.

**KPIs** (`HubKpis`, 90-day window with the prior 90 days as the trend):

| Field | Meaning |
| --- | --- |
| `shoots` | Shoots in the window (project photographer **or** appointment assignee) |
| `openFixes` | All-time OPEN `fix` notes — work they owe |
| `awaitingReReview` | FIXED, waiting on the owner's re-look |
| `openCoaching` | OPEN `coaching` notes |
| `notesPerTenShoots` / `prev…` | Capture-note rate and its trend |
| `cleanStreak` | Consecutive recent shoots with zero notes |
| `avgRating` / `ratingCount` | Client stars from `Feedback.rating`, all time |

Two accuracy details: exact status/kind counts come from a `groupBy`, "never
clipped by the display cap" of 300 notes; and the clean streak skips shoots younger
than a 3-day review lag ("it just hasn't had its review yet") while any noted shoot
breaks the streak immediately.

**Work-on themes.** `rebuildShootFocusSummary()` calls `summarizeShootFocus` to
turn up to 40 open notes into bullets, cached on `TeamMember.focusSummary` with a
`focusSummaryKey` fingerprint of the note ids. It runs on note-share and from the
daily cron — "never from a page render, so /shoot never waits on the model." A
failed/empty model call does **not** poison the cache. `getNextShootFocus` always
*displays* whatever summary exists: "`focusKey` only decides WHETHER to rebuild,
never whether to display."

**The feedback loop and its receipts.** `MediaNote` carries three timestamps:
- `sharedAt` — stamped by `shareShootFeedback()` (owner/admin, `requireAdmin`),
  which texts the photographer a link ("Hey X — &lt;sender's first name, "Jordan"
  when unresolvable&gt; left some feedback on your shoot for &lt;street&gt;. Check
  it out here: …/shoot/&lt;id&gt;"), refuses if the photographer has no phone on
  file, and immediately rebuilds their focus summary "so the themed
  bullets are fresh the moment they tap the link." Its bell kind
  `feedback_shared` is "deliberately NOT in SMS_KINDS — the custom-worded text
  above is the one SMS."
- `seenAt` — stamped **only** when the real photographer loads their own page.
  "Previews never stamp — Jordan looking isn't Harrison reading." On the standalone
  note page (`/shoot/note/[noteId]`) only the addressee stamps, and only that
  thread's root.
- `acknowledgedAt` — the "Got it" on a coaching note. Acknowledging retires it from
  the work-ons card: "acknowledged notes sat there forever with nothing the
  photographer could do (audit)." Open **fixes** always stay — "they're work, not
  reading."

**Client feedback never reaches creatives raw.** Two readers, both filtering
`sentiment ∈ {POSITIVE, NEUTRAL}` (NEGATIVE and null-sentiment rows never match)
*and* running a second gate, `hasNegativeCues()` from `src/lib/feedback.ts`,
because the sentiment column trusts stars over words: "a 4-star 'love it, but the
video was shaky — please redo' is POSITIVE by rating yet must NOT render for the
photographer." The two differ in what they do with a mixed review:

| Reader | Surface | Mixed review (`hasNegativeCues`) |
| --- | --- | --- |
| `getClientFeedback` (`review.ts:151`) | the per-shoot praise card on `/shoot/<id>` | body blanked, **row still shows if it carries stars** |
| `recentPraise` (`photographerFeedback.ts:170`) | the KPI hub on `/shoot/feedback` | **dropped entirely** — "the quote IS this card" |

Surviving bodies are `stripMoneySentences`'d because "clients mention price in
praise all the time". A body that scrubs away to nothing drops the row on the hub
but keeps it on the shoot card if it still carries stars.
Negative feedback instead mints an URGENT `feedback_review` task for Kyle plus an
**owner-only** bell (`src/lib/feedback.ts:75-109`).

**`/shoot/note/[noteId]`** is the landing page for mention pings and thread-reply
texts. It exists because "a tagged photographer may not OWN the shoot the note sits
on (/shoot/<id> bounces non-owners and the mention evaporates)." It shows the
street and the thread — no client name/phone, no order details, no pay — and admits
the addressee or anyone `isMentionedIn` the thread, using "the EXACT matcher that
minted the ping."

---

### FAA drone airspace

Before a drone shoot, the hub checks the FAA's LAANC grid for that address and, if
the property sits in controlled airspace, drafts a heads-up text to the assigned
creative for Jordan to send.

`src/lib/faa.ts` queries the FAA UAS Facility Map (ArcGIS FeatureServer V5) — free,
no API key. Three outcomes:

| Result | Condition | Warning? |
| --- | --- | --- |
| `clear` | No cell intersects the point → Class G | no — "Part 107 OK to 400 ft, no LAANC needed" |
| `restricted` | Winning cell has `CEILING === 0` | yes — "manual FAA authorization required", effectively a no-fly for a same-day shoot |
| `laanc` | Any other intersecting cell (including a null `CEILING`) | yes — auto-authorization up to that ceiling, file LAANC first |

The most restrictive (lowest-ceiling) intersecting cell wins. Any fetch failure
returns a benign `clear` with `summary: "Airspace check unavailable right now."`

It surfaces in exactly two places, both gated `requireAdmin`
(`src/app/projects/droneActions.ts`): the `DroneAdvisory` card on the project page
(rendered only when `hasDroneOps(deliverables)` — i.e. a `DRONE` deliverable
exists) and the same card inside a drone pin's popup on the project map. The
advisory text names the class, the airport, the shoot date/time in ET, and either
the LAANC ceiling or the manual-authorization warning. `sendDroneAdvisory()` texts
it via OpenPhone — a human clicks Send.

**Service territories** are a separate, unrelated concept.
`src/lib/territories.ts` reads a versioned snapshot,
`src/lib/data/aryeoTerritories.json`, because "Aryeo only exposes these through its
logged-in dashboard … NOT the public API." Re-syncing means re-pulling that page by
hand. The file warns in capitals that a territory "is NOT the same as a creative's
no-mileage radius" — the radius is a pay boundary, the territory is coverage. Only
`src/components/map/ProjectMap.tsx` consumes it (ray-cast point-in-polygon, used to
shade territories, mark which one covers the assigned photographer, and warn when a
dropped pin falls outside every service area).

---

### What a photographer can and cannot see

Access is defined in `src/lib/auth/access.ts`. A PHOTOGRAPHER role's default pages
are exactly six: `shoot`, `mypay`, `upload`, `resources`, `training`, `assistant`.
The comment spells out the intent: "Photographers live entirely in the field
platform … They get NO ops/dashboard, schedule, map, clients, comms, billing,
pipeline." Their post-login home (`homeFor`) is `/shoot`. Ask the Hub auto-gates
them to the CREATIVE content tier.

**Can see**
- Their own shoots only — every list and page is scoped by `photographerId` **OR**
  an appointment `assignedToId`, and fails closed (`"__none__"`) when the login
  can't be resolved to a `TeamMember`: "a photographer we can't place sees no
  shoots, never everyone's" (`shoot.ts:333`).
- Access brief, lockbox code, capture list, client name/phone/email with tap-to-call,
  the client's working profile, the reel script, their day's route and map.
- **Their own** pay for a shoot (`ShootPayCard`) and `/my-pay`.
- Their own open SmartTasks (`listPhotographerTasks`), which are money-scrubbed
  unconditionally server-side because "task text is minted from client comms and can
  carry pricing", and whose `description`/`sourceDetail` "never cross to the field
  at all."
- Their own PHOTOGRAPHER-lane review notes, their KPIs, and POSITIVE/NEUTRAL client
  praise.
- The project's Aryeo gallery on their shoot page, and the flag-a-photo button.

**Cannot see or do**
- Any pricing, invoice, package price, or another creative's pay.
- Review mode / pin creation / verdicts — `ListingMedia` only fetches review data
  when the **effective** role is OWNER/ADMIN, so a "view as" preview shows exactly
  what that person sees.
- EDIT-lane notes (Kyle's fix list) or EDITOR-lane notes.
- Negative client feedback, in any form, on any surface.
- `/projects/<id>`, `/editing`, `/edit/<id>` (redirected to `/shoot/<id>`),
  `/review`, comms, clients, pipeline.
- `?as=` previews — "Photographers can never use `?as=` — they're always scoped to
  themselves, fail-closed."

**"View as" is read-only everywhere.** `requireShootAccess` blocks impersonation
outright: "a previewing owner tapping Send on the shoot screen would REALLY text
the client (audit: field actions were the one guard family missing this block)."
The same rule appears in `requireNoteAccess` and `requireCutNoteAccess`.

---

### Gotchas / known state

- **The in-app file-upload path is dormant.** `uploadFiles()` and `removeUpload()`
  in `src/app/upload/actions.ts` (and therefore `saveUpload`/`deleteFile` in
  `src/lib/storage.ts`) have **no callers in the UI** — `UploadPortal` only imports
  `markDeliverableUploaded`, `flagIssue` and `finalizeUpload`, and the
  `uploadFiles` in `CullUploader.tsx:178` is a local function, not the action.
  Consequences: the `N files` chip on the `/upload` list (`_count.uploads`) and the
  `N uploaded` label on the shoot capture checklist (`d.uploads.length`) will read
  0 for any job created since the cull flow landed.
- **`writeFile()` and `dropboxDisplayPath()` in `src/lib/storage.ts` have no
  callers either.** The editor brief is generated on demand by the API route, so
  nothing writes generated bytes to Dropbox any more.
- **`syncDropboxFolderStatus()` is not on any cron.** Despite its header describing
  file-presence-driven status, the only caller is the owner's manual "Check Dropbox
  folders" button in `src/app/connections/actions.ts:190`. Live status comes from
  `syncProjectStatuses` (hourly `/api/cron/sync`). It also flattens failed reads to
  `0` (`.map((n) => n ?? 0)`) — self-documented as "legacy manual sweep: unknown
  reads as 0 (advance-only logic)" — the opposite of the null-safe rule the rest of
  the module enforces.
- **`CullUploader`'s own header comment is stale about the set cap.** Line 14 says
  sets are "capped at 7 for messy triggers"; the code caps at the bracket size
  (`cap = Math.max(1, bracket)`, i.e. 5 — `BRACKET_RATIO` is what `/upload/[id]`
  passes). A 6th trigger becomes a ×1 the viewer merges back in, which is what the
  in-function comment (line 53-55) actually describes.
- **Two different drone-filename regexes.** `src/lib/photoCount.ts` uses
  `/^dji|dji[_-]|drone|mavic|air ?2|^m3[_-]/i` for cost counting; `CullUploader`
  uses only `/^DJI[_-]/i` for set grouping. A Mavic/`M3_` file culls as a bracketed
  frame but costs as a drone single.
- **The completeness check on submit ignores TWILIGHT.** `finalizeUpload` computes
  `wantsPhotos` from `PHOTOS|DRONE` only (`upload/actions.ts:186`), so a
  twilight-only order never trips the "RAW-Photos folder is empty" guard.
- **A stale comment in `getEditorFeedback`.** `src/lib/reviewRoom.ts:266` orders by
  `status: "asc"` with the note "FIXED sorts after OPEN alphabetically" — it does
  not (F < O), so the DB returns FIXED first. Harmless in practice because
  `EditFeedback.tsx:46` re-sorts client-side (open fixes → fixed → coaching), but
  the comment is wrong and any new consumer that trusts it will render backwards.
- **Remar has no phone and no login.** `src/lib/editors.ts:54` records that SMS
  no-ops for her until Jordan adds a TeamMember phone; `slackUserId` is unset for
  every editor, so the Slack-DM branch of the notify bridge is dead code today.
  `ensureEditorLoginNudge` (`src/lib/tasks.ts:1204`) mints a one-time task for
  Jordan when work is addressed to an editor key no login can see.
- **Street View thumbnails need a key that lives only in Vercel.**
  `streetViewSrc()` (`shoot.ts:478`) returns null without `GOOGLE_MAPS_API_KEY`, so
  My Shoots cards render no thumbnail until either the key exists or the photos go
  live on Aryeo. The comment records the tuning: coords-first with `radius=250`
  resolved 6/6 upcoming shoots where "full-address lookups failed on unit/suite-style
  addresses", and `return_error_code=true` turns a miss into a 404 the `<img>`
  hides rather than a grey placeholder.
- **`/map` is a redirect stub.** `src/app/map/page.tsx` forwards every query param
  to `/schedule?view=map`. The directory survives only for
  `src/app/map/actions.ts`, which `ProjectMap` still imports for weather /
  drive-time / geocoding. Those actions are admin-gated because otherwise "these
  are a free geocoding/routing proxy burning the providers' rate limits that
  payroll mileage depends on."
- **`src/lib/qc.ts`'s "NOT WIRED YET" banner for `getQcStats` is entirely stale.**
  It says the dashboard "can `import { getQcStats }` … and render one owner-only
  tile". Both consumers now exist: `/review` calls `getQcStats(30)` +
  `getFixPatterns(60)` (`src/app/review/page.tsx:76`), and the dashboard adopted it
  exactly as described — `getOwnerDials()` (`src/lib/queries.ts:672`) is called
  owner-gated at `src/app/page.tsx:62` and rendered by `<QualityDials>` at
  `page.tsx:199`. The banner's other point does still hold: the function does no
  auth of its own, so every call site must gate it.
- **The cull stash is memory-only.** Staged sets survive in-app navigation via a
  module-level `Map`, but a hard reload loses them; the component warns via
  `beforeunload` and, on return, tells the photographer honestly that an upload may
  have completed in the background rather than guessing.
- **`sendReviewToLane` PHOTOGRAPHER bundles are assigned to `"jordan"`**, not to the
  photographer. The photographer is reached by bell/SMS only; the task is Jordan's
  follow-up item. Coaching notes mint no task at all.
- **Three different "is this premium?" tests, and they do not agree.**
  `PREMIUM_VIDEO_RE = /premium|influencer|cinematic|luxury|signature|elite|flagship/i`
  drives the SLA tier and the Luma dispatch task (`projectStatus.ts:60`, comment:
  "Tune these keywords"); `editors.ts:139` uses `/premium|influencer/i` for editor
  routing; `vendors.ts:51` uses **`/premium/i` only** for the vendor chip. So a
  deliverable labelled "Influencer Reel" routes to Luma and gets the premium SLA
  but renders an **In-house** vendor chip; one labelled "Cinematic Video" gets the
  premium SLA + Luma dispatch task while `editorForDeliverable` routes it to
  Remar/Kim. All three must be edited together.
- **Vendor round-trips are watched, not integrated.** Nothing in this chain pulls a
  finished CubiCasa plan or AutoHDR pass back; the hub only notices it's late
  (`VENDOR_CHASE`: CubiCasa 3 days, AutoHDR 2) and hands Kyle a chase task. Each
  chase is "one per project+category, ever" — if Kyle completes a chase and the
  vendor still never delivers, nothing re-nags.
- **The cull nudge is also one-shot.** `cull-<projectId>` is checked for existence
  regardless of status, so a completed cull task means the photographer is never
  nudged again on that job even if they re-upload an even bigger pile.

## 8. The AI layer

Almost every "smart" thing the hub does runs through one file. When an inbound text becomes a to-do with the right title and the right job attached; when Kyle opens the reply queue and finds every message already drafted in Jordan's voice; when Jordan asks the Finance tab what he paid Harrison last quarter — all of it is a call to Claude, made from `src/lib/integrations/ai.ts`, using an Anthropic API key stored encrypted as the `ai` connection.

The dividing line that matters for the business: **the hub drafts, humans send.** Nothing in the AI layer can text a client, email a client, or move money. The complete list of things a model can *choose* to write is: an internal to-do (`SmartTask`), a remembered fact (`KnowledgeItem`), a saved document (`HubDocument`), a saved financial statement (`FinanceReport`), a personal budget target (`BudgetTarget`), and Jordan's own to-dos (`OwnerTodo`). Every one is a row in the hub's own database, and each tool that writes one is role-gated. (Separately, code — not the model — stores AI output on `Client.profileJson`, `TeamMember.focusSummary`, `HubChat.summary` and the cached `GrowthPlan`.)

---

### The connection and the two model tiers

The API key lives in the `Connection` row with `provider = "ai"`, encrypted (`src/lib/integrations/connections.ts:18` `getSecret`). Every AI entry point starts with `await getSecret("ai")` and degrades cleanly when it returns null (either a friendly "the AI isn't connected" message, or `null`/`[]` so the caller falls back to non-AI behaviour). The Connections page tests the key with `testAiKey()`, registered in the generic tester map at `src/app/connections/actions.ts:76`.

Two model constants, at the top of `src/lib/integrations/ai.ts:12-13`:

| Constant | Model id | Used by |
| --- | --- | --- |
| `FAST` | `claude-haiku-4-5-20251001` | `testAiKey`, `polishOutbound`, `summarizeWorkday`, `summarizeShootFocus`, `summarizeHubConversation`, `messageToTodo` |
| `SMART` | `claude-sonnet-4-6` | `draftReply`, `draftReplyWithContext`, `decideCommTask`, `decideSlackTask`, `synthesizeClientProfile`, default for `aiJson` and `runHubAgent` |

The split is deliberate and commented: polishing a photographer's rough note is "a light rewrite" (`ai.ts:258`) so it gets Haiku; anything that has to read a thread and make a judgement call gets Sonnet.

#### The transport

`callMessages(body, key)` (`ai.ts:34`) is the only place that touches `https://api.anthropic.com/v1/messages`. It POSTs with `anthropic-version: 2023-06-01`, `cache: "no-store"`, and retries up to **4 attempts** with a linear backoff of `attempt * 1200 ms` (0, 1.2s, 2.4s, 3.6s). It retries on network failure, `429`, `529`, and any `5xx`; anything else throws immediately. Only after all four attempts are spent is the error inspected: if it mentions "overload" it is rewritten to the user-facing *"The AI is briefly overloaded. Please try again in a moment."* (a non-retryable error throws its raw message and never gets that treatment).

Two thin wrappers sit on top:

- `anthropic({ model, system, user, maxTokens, key })` — one-shot text completion, `max_tokens` default 600. Not exported; every one-shot helper below uses it.
- `aiJson<T>({ system, prompt, schema, maxTokens, model, key })` — **exported**. Structured output guaranteed to match a schema, implemented by declaring a single tool named `emit` whose `input_schema` *is* the desired shape and forcing `tool_choice: {type:"tool", name:"emit"}`. The comment at `ai.ts:84-91` explains why it exists: it removes the failure modes ("prose, a code fence, or a near-miss key name") that the regex-a-JSON-blob-out-of-the-text approach used elsewhere in the same file has to defend against. Default model `SMART`, default `max_tokens` 4000. Two callers: `src/lib/meetings.ts` and `src/lib/growthPlan.ts`.

---

### Every place the system calls a model

| Exported function | Model | Called from | Writes anything? |
| --- | --- | --- | --- |
| `runHubAgent` | `SMART` (overridable) | `/assistant`, `/day`, `/sales` advisor, `/trends` advisor | Only via the tools each caller supplies |
| `aiJson` | `SMART` | `meetings.ts` (Meet transcripts), `growthPlan.ts` (Trends growth plan) | No |
| `draftReplyWithContext` | `SMART` | `src/app/actions.ts:576` (task reply drafts), `clients/actions.ts:109` + `:180` (text + email drafts on a client page), `communications/replyActions.ts:70` (the reply queue), `communications/threadActions.ts:235` (chat thread), `hubTools.ts:619` (Ask the Hub's `draft_client_message`) | No — returns text |
| `polishOutbound` | `FAST` | `shoot/actions.ts:126` (photographer's rough note → clean client text), `billing/actions.ts:61` (warms up the templated payment nudge) | No |
| `decideCommTask` | `SMART` | `brain.ts` → `routeCommTask`, used by `comms.ts` and the OpenPhone webhook | Caller creates/merges a SmartTask from the decision |
| `decideSlackTask` | `SMART` | `brain.ts` → `routeSlackTask`, used by `integrations/slackSync.ts` | Same |
| `messageToTodo` | `FAST` | `comms.ts:198`, `slackSync.ts:83`, `api/webhooks/openphone/route.ts:322` — **fallback only**, when the Smart Brain is unavailable | Caller creates a SmartTask |
| `synthesizeClientProfile` | `SMART` | `clientProfile.ts:62` | Caller writes `Client.profileJson` |
| `summarizeShootFocus` | `FAST` | `photographerFeedback.ts:231` | Caller writes `TeamMember.focusSummary` |
| `summarizeWorkday` | `FAST` | `history/actions.ts:33` (a button on Task History) | No |
| `summarizeHubConversation` | `FAST` | `hubChats.ts:181` | Caller writes `HubChat.summary` |
| `testAiKey` | `FAST` | `connections/actions.ts` | No |
| `draftReply` | `SMART` | **nothing** — dead export | — |
| `aiConfigured` | — | **nothing** — dead export | — |

Scheduled model spend lives in two crons (`vercel.json`):

- **Daily**, `0 8 * * *` → `src/app/api/cron/daily/route.ts`: `clientProfiles` (20 profiles/run), `shootFocusSummaries` (`rebuildAllShootFocusSummaries`), and `growthPlan` (cache-keyed, usually a no-op — see below).
- **Every 5 minutes**, `*/5 * * * *` → `src/app/api/cron/gmail/route.ts`: `syncGmail()` and `syncSlackHistory({ sinceHours: 2 })` both feed the Smart Brain, so each newly ingested email or Slack message can cost a `SMART` call. Inbound texts and calls do the same in real time from the OpenPhone webhook (`api/webhooks/openphone/route.ts:300`). So unattended spend is driven by inbound message volume, not only by the nightly batch.

---

### `runHubAgent` — the tool-loop contract

`ai.ts:133-219`. This is the agent loop every conversational surface shares. The caller supplies the system prompt, the tool schemas, and an executor; the loop supplies the turns.

```ts
runHubAgent(opts: {
  system: string;
  history?: { role: "user" | "assistant"; content: string }[];
  question: string;
  attachments?: HubAttachment[];
  tools: HubTool[];
  exec: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  model?: string;      // default SMART
  maxSteps?: number;   // default 6
  maxTokens?: number;  // default 1600
}): Promise<{ answer: string; toolsUsed: HubToolCall[] }>
```

Contract, in order:

1. Attachments (if any) are prepended to the user turn as native blocks — `image` with base64 source, `document` with `application/pdf`, or plain text inlined as `[Attached file "name"]\n…`.
2. Loop up to `maxSteps` times. Each pass calls `callMessages`, pushes the assistant's raw content blocks onto `messages`, and stops early if `stop_reason !== "tool_use"` or there are no `tool_use` blocks — returning the joined text, or `"I couldn't find an answer to that."` if the text is empty.
3. Otherwise every `tool_use` block is executed **sequentially** via `opts.exec`. A thrown executor returns `{ error: message }` to the model rather than killing the turn. Each result is JSON-stringified and **truncated to 14,000 characters** before being sent back as a `tool_result`.
4. Every call is recorded in `toolsUsed` (name + input) whether it succeeded or not — that array is what the UIs use to render the "what I looked at" trail and the button-worthy proposals.
5. If the loop exhausts `maxSteps`, one final call is made with `max_tokens: 1200`, **no `tools` array**, and the system prompt suffixed with *"You have gathered enough data. Give your best answer now from what you have; do not request more tools."*

Per-surface settings:

| Surface | `maxSteps` | `maxTokens` | History window |
| --- | --- | --- | --- |
| Ask the Hub (`assistant/actions.ts:214`) | 7 | 1600 (default) | last 8 turns |
| My Day (`day/actions.ts:410`) | 8 | 1600 | last 8 turns, each clipped to 4000 chars |
| Finance advisor (`sales/advisorActions.ts:78`) | 12 | 8000 | last 10 turns |
| Growth advisor (`trends/advisorActions.ts:65`) | 12 | 8000 | last 10 turns |
| Finance report builder (`sales/advisorActions.ts:178`) | 14 | 8000 | — |
| Budget setup, one-click (`sales/advisorActions.ts:103`) | 10 | 6000 | — |

The `maxTokens` parameter carries a comment explaining itself: *"raise for long outputs (formal reports blow the 1600 default)"* (`ai.ts:142`).

---

### Ask the Hub (`/assistant`)

Plain English: this is the chat box where anyone on the team can ask about the live business — "what's shooting today", "who owes us money", "draft a follow-up to Stephen" — and get an answer built from the actual database, not a guess. It can also be *taught*: tell it a new fee and it remembers.

The server action is `askHub()` in `src/app/assistant/actions.ts:137`.

#### Who is asking, and how that is decided

```
me = await getCurrentUser()
if (authEnforced()) { no session → refuse; !canAccess(me,"assistant") → refuse }
viewerRole = me ? contentTier(me.role) : "OWNER"
```

The comment at `actions.ts:142-148` explains the care taken: middleware only gates page navigation, not the POST that invokes the server action, so with enforcement on (always in prod) an unauthenticated call must refuse cleanly rather than fall back to a privileged tier. With enforcement off (local dev) there is no session and the tier is `OWNER`.

`contentTier()` (`src/lib/auth/access.ts`) maps the four app roles onto three content tiers: `OWNER → OWNER`, `ADMIN → ADMIN`, and both `EDITOR` and `PHOTOGRAPHER → CREATIVE`. Both creative roles have `assistant` in their default page set, so photographers and editors genuinely use this surface.

#### The system prompt

`hubSystemPrompt(role)` (`actions.ts:75-112`) is rebuilt per request and stamped with today's ET date. It contains:

- **A per-role identity line** from `ROLE_DESC`: OWNER is "Jordan, the owner… including finances, margins, pay rates, strategy, and personnel"; ADMIN is "Kyle, the operations admin / VA… but NOT owner-only finances, margins, pay rates, strategy, or personnel assessments"; CREATIVE is "a creative (photographer or editor)… NOT pricing internals, client lists, finances".
- **A hand-written map of the whole app**, page by page, so the assistant can give directions ("Daily Tasks (/queue) = Kyle's single to-do list…"). This block is stale in places — see Gotchas.
- **Tool-usage rules**: call `current_datetime` first for relative dates; `search_projects` then `get_project_detail`; `search_business_knowledge` for judgement/pricing/"how do we"; `search_comms` *before* drafting any client reply, "and if search_comms returns nothing say there is no record."
- **A CONFIDENTIALITY paragraph**: "The business-knowledge tool ALREADY filters out anything above the current viewer's clearance, so only share what it returns. Never speculate about, reconstruct, or hint at finances… Never put owner-only facts into any message drafted for a client or creative."
- **Hard style rules**: no em dashes, no emojis, no bold.
- **The critical boundary**, verbatim: *"aside from drafting client messages (proposed for a human to send), creating internal to-dos when asked, and saving facts you are taught, you do not send anything to clients or change external records on your own. The human always stays on the Send button."*

#### The tool belt — 15 tools

Defined as `HUB_TOOLS` and executed by `execHubTool(name, input, ctx)` in `src/lib/hubTools.ts`. The file header states the rule for the read-only set: *"Each tool maps to a bounded Prisma query and returns compact JSON (token- and Neon-egress-friendly). NOTHING here writes, sends, or mutates"* — which was true before the three write tools were added at the bottom.

| Tool | What it does | Gate |
| --- | --- | --- |
| `current_datetime` | ET now / today / dayKey | none |
| `search_projects` | Projects by address or client name, optional status filter, limit 15 cap 30 | dollars hidden below ADMIN |
| `get_project_detail` | One project: status, deliverables ordered vs present vs missing (from `parseEvidence`), photographer, appointments, open SmartTasks, last 6 messages, Aryeo + hub URLs | `billing` block admin+ only |
| `find_client` | Up to 5 name matches: tier/segment, contact, preferences, notes, last 6 projects | `lifetime_spend` admin+ only |
| `get_schedule` | Appointments in a range (`today`/`tomorrow`/`week`/`yesterday`, or explicit from/to), cap 60 | none |
| `list_tasks` | Open or overdue SmartTasks, optional `taskType`, limit 25 cap 40 | none |
| `get_billing` | Full AR via `getBillingRows()`, top 40 jobs + grand total | **ADMIN+ only**, else refuses |
| `day_summary` | One ET day: shoots, deliveries, completed tasks + counts | none |
| `search_knowledge` | Keyword scan of `Sop` + `Resource` tables (top 3 SOPs, 4 resources) | none |
| `search_business_knowledge` | The KnowledgeItem KB — see below | **role-filtered in SQL** |
| `search_comms` | CommLog: texts, call transcripts, emails, Slack channels + Jordan's DMs; `person` matches a client *or* a teammate | **ADMIN+ only**; rows further filtered by per-row `minRole` |
| `draft_client_message` | Pulls the client's last 14 client-facing comms, calls `draftReplyWithContext`, returns a Send-ready draft | **ADMIN+ only** |
| `create_task` | Creates a SmartTask (`taskType: "internal_instruction"`, `source: "assistant"`, owner = Kyle) | **ADMIN+ and not impersonating** |
| `remember_fact` | Writes a KnowledgeItem via `learnFact()` | **ADMIN+ and not impersonating** |
| `save_document` | Writes a `HubDocument` row | **not impersonating** (no role gate) |

Role ranks are `CREATIVE: 1, ADMIN: 2, OWNER: 3` (`hubTools.ts:199`), and `canSeeMoney = rank >= ADMIN`. The money comment is explicit: *"creatives (photographers/editors) may look up schedules, projects, and clients — but NEVER dollars"*.

The `ctx` passed by `askHub` carries `{ role: viewerRole, impersonating: me?.impersonating, who: me?.name ?? me?.email }`. `impersonating` is the owner's read-only "view as" preview; `create_task` and `remember_fact` both refuse in that state, and `remember_fact`'s comment gives the second reason: *"a fact taught mid-preview would be misattributed to the impersonated role."*

#### DRAFT-ONLY vs can-act, precisely

**Can act (writes to the hub DB, never outside it):**
- `create_task` → one `SmartTask` row, deduped against an open assistant task with the same title and project; due date defaults to tomorrow, or 5pm ET on an explicit `YYYY-MM-DD` via `etEndOfDay`.
- `remember_fact` → one `KnowledgeItem` row (plus archiving of superseded ones).
- `save_document` → one `HubDocument` row.

**Draft only:**
- `draft_client_message` returns `{ drafted: true, message, can_text }`. `askHub`'s `exec` wrapper captures it into a `HubDraft`, and `AskHub.tsx`'s `DraftCard` renders an editable textarea with **Send via OpenPhone** and **Copy**. The send is `sendClientText(clientId, text)` fired by the human's click — the model never reaches it. If `phone` has fewer than 10 digits, `can_text` is false and the card says "No phone on file — copy and send manually."
- The tool also strips a leaked meta-preamble ("…here is the reply:") with a deliberately narrow regex, commented as being narrow *"so legit lines like 'here is the link:' inside the message aren't cut"*, and unwraps surrounding quotes.

**Nothing** in this tool belt can email, text, change an Aryeo record, alter a price, or touch money.

#### Attachments

`sanitizeAttachments` (`actions.ts:120`) accepts at most **4** files per question: images (jpeg/png/gif/webp only) and PDFs up to `MAX_B64_CHARS = 5_500_000` base64 chars (≈4MB raw, per the comment), and text up to 60,000 chars. The client (`AskHub.tsx:87` `stageFile`) downscales images to ≤1568px JPEG at quality 0.85 before upload, rejects PDFs over 4MB and text files over 512KB (the error says "under 500KB"), and supports paste and drag-drop. When files are present the system prompt gains an ATTACHMENTS paragraph and, if the question is empty, defaults to *"Take a look at the attached file(s) and tell me what's relevant."*

---

### The knowledge base

Plain English: the hub has a long-term memory of how Jordan runs the business — distilled from his entire ChatGPT history, a hand-written playbook, a guide to the app itself, and 160 lessons of the 910 Academy training course. Ask the Hub searches it before answering judgement questions, and everything in it is tagged with who is allowed to see it.

The `KnowledgeItem` model (`prisma/schema.prisma:1173`) carries `category`, `title`, `body`, `minRole` (default `ADMIN`), `tags` (JSON string), `source`, `sourceRef`, `confidence` (1-5), `pinned`, `archived`, with indexes on category / minRole / archived.

Live counts, read from the production database on 2026-08-14:

| Source | Rows | Where it came from |
| --- | ---: | --- |
| `chatgpt-export` | 3,780 | `scripts/ingestKnowledge.ts` — streams Jordan's full ChatGPT export JSONL, drops non-business conversations with a keyword prefilter, and uses Haiku (`claude-haiku-4-5-20251001`, concurrency 6) to extract ≤6 durable insights per conversation with a `minRole` assigned by the model |
| `910-courses` | 1,904 | Transcript chunks of the 910 Academy "All Courses" volume (the ingestion pipeline is not in this repo) |
| `aoc-training` | 101 | Agent-on-Camera training lessons (same) |
| `hub-guide` | 19 | `scripts/seedHubGuide.ts` — hand-written "how the hub works" facts, pinned, `category: "hub_help"` |
| `playbook` | 19 | `scripts/seedPlaybook.ts` — the crown-jewel operating facts (fee schedule, turnaround SLAs, problem-handling rules, contractor pay rates, comms style), pinned, confidence 5 |
| `learned` | 2 | Taught live through Ask the Hub |
| **Total** | **5,825** | 5,824 unarchived |

By visibility (unarchived): CREATIVE 2,772 · ADMIN 2,562 · OWNER 490.

`search_business_knowledge` (`hubTools.ts:493`) is where scale bit. The comment records the fix: a plain keyword scan over a few hundred curated facts stopped working once the training courses added thousands of transcript chunks, so the query now does a **SQL prefilter** and fetches title/tag matches (take 300) and body matches (take 500) as two separate queries, then merges and de-dupes — *"so a specific lesson title is never crowded out of the slice by a common word that appears in thousands of chunks."* Scoring gives 2 points for a whole-word or title hit and 1 otherwise, breaks ties on `confidence`, and returns at most `limit` (default 8, cap 15) items with each body clipped to 2,600 chars.

The role gate is a `where` clause, not a post-filter: `{ archived: false, minRole: { in: allowedRolesFor(ctx.role) } }`. A CREATIVE viewer's query never fetches an OWNER row, which is what makes the system prompt's "the tool ALREADY filters" claim true.

---

### The teach-it loop

Plain English: when Jordan or Kyle tells the hub something — "our rush fee is now $200", "from now on we don't shoot Saturdays" — it saves it, and every future answer uses it. Corrections retire the old version so the brain never holds two truths.

`learnFact()` in `src/lib/learn.ts` is the writer, reached only through the `remember_fact` tool. The file header names its two safety rails:

**1. Sensitivity floor.** The tier requested by the model is a *floor to be raised, never lowered*. `learn.ts:29` holds a deliberately broad regex:

```
\b(margin|markup|profit|payroll|salary|salaries|wage|wages|commission|payout|payouts|cogs|
gross|strateg\w*|acquisi\w*|acquir\w*|personnel|competitor\w*)\b
|\bpay\s*rate|\bwe\s+pay\b|\bour\s+cost|\bvendor\s+cost|\bcosts?\s+us\b|\bnet\s+profit\b
```

Any match on `title + fact`, **or** a category in `{financial, strategy, pricing}`, forces `minRole = OWNER`. The comment justifies the bias: *"a false positive just means Kyle/creatives don't see one operational note (safe + correctable)."*

**2. Supersede-on-correction.** Within the same category it scans up to 600 unarchived candidates. An exact normalized title+body match is a **no-op** — it returns `{ noop: true }` and writes nothing, which the comment says exists to stop "the assistant re-saving a fact every time someone asks about it." Otherwise it archives same-titled facts always, and on `correction: true` also anything with a title-token Jaccard similarity ≥ 0.6, capped at 8 archivals. Superseding is wrapped in its own try/catch: *"never block saving the new fact."*

Saved rows get `source: "learned"`, `sourceRef: "Taught via Ask the Hub (ROLE)"`, `confidence: 5`, `pinned: false`. Category must be one of 13 (`preference, goal, issue, outcome, sop, fee, pricing, client_insight, strategy, financial, team, comms, script`) or it silently becomes `preference`.

The UI closes the loop: `askHub`'s exec captures `remembered: true` into a `HubMemoryCard`, and `AskHub.tsx`'s `MemoryCard` shows the title, the humanised category, a lock chip reading "Owner only" / "Team" / "Everyone", and "replaced N older notes" when `superseded > 0`. A no-op returns `{ remembered: false, already_known: true }` and renders no card.

The system prompt is unusually strict about *when* to call it (`actions.ts:109`): only when the user is actively teaching or correcting, and *"NEVER call remember_fact to answer a question, to confirm, or to restate a fact you already know or just looked up."*

---

### Policies — how taught facts constrain client drafts

`src/lib/policies.ts` is a 55-line file that does one job: pull the agency policies most relevant to what a client just said, so the drafter cannot promise something the business does not offer.

It selects unarchived KnowledgeItems where `minRole ∈ {CREATIVE, ADMIN}` and `category ∈ {fee, pricing, sop, policy, comms, client_insight}` — ordered by confidence then recency, **take 200**. The header explains the tier choice: *"owner-only strategy, margins, and costs never go into a client reply."*

Scoring is inverse document frequency, and the comment says why: *"a plain keyword count drowns the specific policy (e.g. 'drone weather') under generic SOPs that share common words."* Each word of the client's message longer than 3 characters contributes `1 / (1 + df)` where `df` is how many of the 200 candidates contain it, so a rare word like "drone" or "reschedule" outweighs "shoot". Items in category `fee` or `policy` get a `+0.15` bonus, commented as a "hard-rule floor" so we never contradict them. Anything scoring `> 0.05` survives, top 12, rendered as a `- bullet` list of bodies. Two fallbacks: a message with no scoreable words returns the first 8 by confidence, and a message where nothing clears the threshold returns the first 6.

That string is passed as `policies` into `draftReplyWithContext`, where the prompt (`ai.ts:330`) frames it as *"Agency policies you MUST follow (never contradict these; never promise anything they don't allow)"* and a rule adds: *"When a policy answers the client's question, explain it plainly in the reply instead of saying you will 'confirm' or 'check' it. Never promise a free reschedule, refund, waived fee, or 'no additional cost' unless a policy explicitly allows it."*

Callers that pass policies: the task-reply drafter (`app/actions.ts:574`), the reply queue (`communications/replyActions.ts:80`), the chat thread (`communications/threadActions.ts:244`), and both client-page drafters (`clients/actions.ts:118`, `:179`). The one caller that does **not** is `hubTools.ts`'s `draft_client_message`.

---

### Saved documents (HubDocuments)

Plain English: when an answer is a report rather than a couple of sentences, the assistant writes the whole thing as a document and saves it, and Jordan opens it from a Documents list instead of scrolling a chat.

`save_document` (`hubTools.ts:762`) takes `title`, `kind` (`report | sop | brief | plan | summary | doc`, defaulting to `report`), and the complete `markdown`. Two guards:

- **`markdown.length < 200` is rejected** with *"That's too short to be a document — compose the full markdown and call save_document again."* The comment records the incident: *"The finance advisor hit this: the model would answer 'let me compose that' and the answer got saved as the report body. A stub with a title is worse than no document, because it looks like the work was done."*
- Title clipped to 160 chars, markdown to 120,000, `createdBy` stamped from the signed-in name/email. The model's `kind` is checked against `["report","sop","brief","plan","summary","doc"]` and falls back to `report`.

`HubDocument` also carries a `prompt` column, commented in `prisma/schema.prisma:1573` as *"What was asked for, so a stale doc can be regenerated without guessing"* — `save_document` never writes it, and nothing reads it. Half-built.

The returned payload includes a `note` that steers the chat reply: *"Saved. Tell Jordan it's saved and that he can open it from Documents — do not paste the whole document back into the chat."*

The UI is `/assistant/docs` (list, newest first, take 200, with a 180-char markdown-stripped preview line) and `/assistant/docs/[id]` (rendered by `<Markdown>`, with `print:hidden` chrome so printing produces the document and not the app furniture). `DocActions.tsx` gives Copy, Print/PDF, Download (as `.md`), and a two-step Delete backed by `deleteHubDocument`, which calls `requireAdmin()`.

---

### Per-client AI working profiles

Plain English: before a photographer shoots for someone, the hub can tell them who they're about to work with — how hands-on they are, how they communicate, what they usually ask to be changed, what their brand looks like. It is written from real messages and shoot notes, and it is written to be safe for a creative to read.

`buildClientProfile(clientId)` in `src/lib/clientProfile.ts` gathers: the client's last 40 projects, up to 40 CommLog rows **filtered to `minRole ∈ {CREATIVE, ADMIN}`** (`COMM_ROLES`, so owner-tier comms never reach a creative-facing profile), 30 `NOTE | FLAG | SPECIAL_REQUEST` activities, 12 feedback rows, plus counts of revision tasks and inbound messages. It then calls `synthesizeClientProfile` (`ai.ts:706`, SMART, `max_tokens` 900).

That system prompt is the strongest safety text in the file: the reader is the creative team, and *"It MUST be appropriate for a creative to read… NEVER include pricing, fees, payments, balances, internal finances, margins, business strategy, or anything unkind or gossipy. If you have nothing solid for a section, leave it brief or empty rather than inventing."*

Output shape (`ClientProfileInsights`): `summary`, `touchLevel` (`high|medium|low|""`), `workingStyle`, `communication`, `revisions {summary, commonTypes[]}`, `brandStyle`, `shootNotes[]`, `aboutThem[]`, `dos[]`, `donts[]`. Every array is coerced and capped at 6 entries; `touchLevel` falls back to `""` if it isn't one of the three. Stored as `Client.profileSummary` + `profileJson` + `profileUpdatedAt`.

`refreshStaleClientProfiles(limit = 20)` runs nightly from the cron: real clients only (`parentClientId: null`, `transactionCount > 0`), missing or older than **10 days**, oldest first, hard-capped at 60 — *"so the creatives portal always has fresh context without a big one-time spend."* **213 clients** currently have a stored profile. It is also triggered by hand from `regenerateClientProfile` on a client page (`requireAdmin`).

Read back with `parseClientProfile()`; consumed on the client page, the edit tracker (`/edit/[id]`), `shoot.ts` and `taskView.ts`.

---

### The Smart Brain — inbound messages become the right to-do

Plain English: when a text, call, email or Slack message lands, the hub doesn't just make a generic "reply to this" task. It looks at everything that client has in flight, the recent conversation, and the team's existing open to-dos, then writes one specific task on the right job — or merges it into a task that already covers it, or decides no action is needed at all.

Two routers, both in `src/lib/brain.ts`, both returning `null` on any failure "so callers safely fall back to their old behavior."

#### `routeCommTask` → `decideCommTask` (text / call / email)

Context assembled: up to 14 of the client's projects (id, address, status, due, delivered, `inRevision`), up to 14 **open comms-type** tasks, and the last 12 CommLog rows reversed into chronological order. The mergeable set is deliberately narrow (`brain.ts:22`):

```
MERGEABLE_TYPES = ["client_reply", "comms_followup", "internal_instruction",
                   "revision", "vendor_update", "lead"]
```

with the reason inline: production tasks (`media_qa` / `delivery` / `confirmation_text`) are excluded because *"whose title/summary would get clobbered if the brain picked it as 'the same request'."*

The model returns strict JSON: `{actionable, projectId, title, detail, priority, mergeIntoTaskId, isRevisionRequest, flags[], reason}`. The prompt carries the real team roster so it doesn't invent roles — *"photographers Harrison Wells + James Livingston shoot on site; Kim + Remar are EDITORS (edit only, never shoot/film); Luma/AutoHDR/CubiCasa/ReadyPost are editing vendors."*

Two rules are worth quoting because they encode past bugs:

- On merging: *"NEVER merge a NEW topic into a revision to-do: merging overwrites that to-do's title and summary, and a revision task must keep describing the revision."*
- On `isRevisionRequest`: true **only** when the client wants already-delivered media changed. Explicitly false for scheduling, pricing, new orders, complaints about service — and false when a monthly-social client shares ideas, reference videos or style examples for their *next* content, *"that is a normal reply/instruction, not a revision. When in doubt, false."*

Every field is re-validated in code after parsing: `projectId` must be one of the ids that were sent, `mergeIntoTaskId` must be one of the task ids that were sent, priority must be in the enum (defaults `HIGH`), `actionable` defaults to true "if unclear", flags capped at 4.

The caller (`comms.ts`) writes an observability trail: an `Activity` row of type `SYSTEM` reading `Smart Brain: <created a to-do | merged into an open to-do | no action needed> — <reason> [flags]`.

#### `routeSlackTask` → `decideSlackTask` (internal Slack)

Slack is harder because messages say "she" and "the form". This router reads the last 40 messages in the channel — **newest-first then flipped**, with the comment recording the bug: *"Reading oldest-first on a huge DM thread made the brain reason about months-old history and resurrect long-finished conversations as new tasks"* — and keeps the last 22.

Candidate clients come from `resolveClientCandidates()`, which matches only **full multi-word names ≥6 chars** as whole phrases, because *"a bare first name like 'Daniel' false-matches too easily"*. Top 3 by name length are sent with their orders and upcoming shoots; the brain picks one or none (*"NEVER guess; a wrong client is worse than none"*).

The roster block goes further than the comms one and handles dictation errors: *"when a name is a near-miss of a roster name (e.g. 'Omar'/'Raymar' = Remar, 'Kym' = Kim, 'Cyle' = Kyle), ALWAYS write the correct roster spelling."* Other rules: never describe an editor filming or a photographer editing; one task = one client/subject; merge only for the *same* client/property/vendor.

Both routers fall back to `messageToTodo` (FAST, one message, no cross-checking) when the AI key is missing or the brain throws. That helper has its own hard-won rules (`ai.ts:801`): *"The assistant works remotely and does NOT attend, drive to, or shoot anything. Never write 'attend', 'go to', 'show up at', 'shoot', or 'cover' as the action"*, and automated notifications are titled "No action needed", which callers detect by regex and skip.

---

### The three other agents

All three reuse `runHubAgent` with a different tool belt and a different prompt.

#### My Day (`/day`) — owner-only

`askMyDay` in `src/app/day/actions.ts:394`, guarded by `requireOwner()`. Ten tools in `src/lib/dayTools.ts`, and the file header states the single rule that shapes them:

> *"it may do what it likes to JORDAN'S OWN list, and it may not touch anyone else without him pressing a button… Clients — nothing at all. There is no tool here that can reach a client, by any route, deliberately."*

| Tool | Effect |
| --- | --- |
| `my_day`, `my_todos`, `week_ahead`, `business_snapshot`, `find_job` | Read-only |
| `add_todo`, `update_todo`, `complete_todo` | **Write** — but only to `OwnerTodo`, Jordan's own list |
| `draft_slack_to_kyle`, `draft_task_for_kyle` | **Write nothing.** They return `{ staged: true, note: "Nothing sent…" }` |

The two draft tools are the clearest DRAFT-ONLY implementation in the codebase — their executor returns a note aimed at the model itself: *"Jordan now has a Send button with this text — say so plainly and do not claim it went out."* `proposalsFrom(toolsUsed)` then reads the *inputs the model passed* (not the outputs) into `DayProposal[]`, and `DayAssistant.tsx` renders each as an editable card with a button wired to `sendSlackToKyle` (→ `opsAlert`) or `createTaskForKyle`. Both of those are separate server actions, each with its own `requireOwner()`.

`complete_todo` clears `calendarEventId`, `blockStart` and `blockEnd` alongside the status, *"so a finished to-do can't go on refusing Calendly bookings."*

The system prompt is built per request by `daySystem(now)` rather than held as a constant, and the doc comment says exactly why: *"the model has no clock: asked to message Kyle about 'Friday', it guessed the date was four days off and named the wrong shoot."* It now stamps the full ET date and instructs the model to say which date it landed on "so a wrong guess is visible rather than silent." Other standing rules: be SHORT, give ONE recommendation not a menu of five, *"Never guess anyone's gender; if you don't know someone's pronouns, use 'they'"*, and *"Money: quote only figures the tools return."*

#### The AI CPA / Finance advisor (`/sales`) — owner-only

`askAdvisor` in `src/app/sales/advisorActions.ts:53`, `requireOwner()`. 15 tools in `src/lib/financeTools.ts`, all reading the same audited engines the Finance tabs render *"so the advisor's numbers always match the dashboard"* (`financeTools.ts:9`). `aiSetupBudgetAction` (`:92`) is a second entry point on the same prompt and tool belt: the Budget tab's empty state runs one 10-step pass that must call `get_budget` + `personal_spending` and then `set_budget` for every meaningful category.

Read-only: `finance_overview`, `category_breakdown`, `vendor_breakdown`, `people_payments`, `personal_spending`, `card_payments`, `monthly_pnl`, `job_profitability`, `search_transactions`, `accounts_snapshot`, `savings_plan`, `get_budget`, `current_datetime`. **Writes:** `set_budget` (1-40 `BudgetTarget` upserts/deletes, amounts clamped to 0-100,000) and `create_report` (a `FinanceReport` row; same `< 200` chars rejection as `save_document`). Unlike the assistant's `save_document`, both writes are in real use: **4 `FinanceReport` rows and 15 `BudgetTarget` rows** live today.

The system prompt embeds a `BUSINESS_CONTEXT` block of ground truth — revenue rails, who gets paid what, the account last-4s — and one all-caps rule born of a real error:

> *"NEVER ADD UP TOTALS FROM DIFFERENT TOOLS OR ACCOUNTS… If you find yourself summing two numbers to answer 'how much did we spend', stop — you are about to double-count. (Jul 2026: adding the wife-transfer memo to the personal total reported a real $121.8k household year as $156.7k and badly misled the owner.)"*

The same fix is enforced in the tool payload itself: `personal_spending` renames the field to `wife_account_funding_ALREADY_INCLUDED_IN_TOTAL` and attaches a `note` reading *"MEMO ONLY … NEVER add this to `total`; doing so double-counts every dollar of it"* — a comment at `financeTools.ts:197` explains the rename.

Boundaries are stated: *"You are not a licensed CPA, tax preparer, or investment advisor… You never move money or pay anyone; your only writes are saving reports and budget targets when asked."*

`generateReportAction` is the one place with a **retry loop around the agent** (up to 2 passes). The comment: *"The model sometimes ANNOUNCES its plan ('let me compose and save it') and ends the turn without acting — nudge it once to actually do it."* The second pass sends *"You stopped before saving… Do not describe your plan — act."* If the agent still never called `create_report`, a fallback saves the raw answer only when it is ≥300 chars and contains a `|` (a markdown table), otherwise it returns an error quoting the model's actual answer.

#### The growth advisor (`/trends`) — owner-only

`askTrendsAdvisor` in `src/app/trends/advisorActions.ts:51`, `requireOwner()`. Nine tools in `src/lib/trendsTools.ts`, **all read-only** — *"BOUNDARIES: you are read-only. You never message a client, change a price, or send anything — you tell Jordan what to do and he decides."*

The prompt's dominant idea is that there are two revenue rails and only one of them shows up in Aryeo. `recurring_revenue` exists to surface the other, and its description warns: *"Never tell Jordan a retainer client is small or shrinking from their Aryeo total alone, and never suggest 'fixing' a $0 session order — it is intentional."* Also: *"NEVER guess a client's gender from their name… A wrong guess misgenders a real customer in Jordan's own tool."*

`package_margins` deliberately reads the nightly snapshot rather than running the engine, because *"Running the engine here would drag the payroll/OSRM cost into a chat turn that may already be a dozen model round-trips deep."*

#### The Growth Plan card (`aiJson`, not an agent)

`src/lib/growthPlan.ts` builds a `growthSnapshot()` of the whole demand picture and asks for a six-section plan via `aiJson` at `max_tokens: 8000`. Two comments are load-bearing:

- On the token ceiling: *"the fields are emitted in schema order, so a ceiling hit silently truncates the LAST sections. At 4k the focus and fix lists came back empty every time."*
- On caching: `snapKey()` hashes only the **business shape**, not the snapshot, because the snapshot carries the calendar (today's date, days-since-last-order, MTD projection) *"all of which tick over at midnight whether or not anything happened. Hashing those meant the key changed every single night, so the plan was rebuilt (and paid for) daily even on a day with no orders."* A quiet day is now free.

The prompt also carries a "KNOWN AND ALREADY EXPLAINED — do not spend a recommendation on these" block covering the $0 retainer orders, null-margin vendor-billed packages, Jordan's own unpaid shoot labour, and the AutoHDR photo-cost coverage caveat. On failure it returns the last good plan with `stale: true` rather than an empty card.

#### Meeting recaps (`aiJson`)

`src/lib/meetings.ts` reads Google Meet transcripts (≤60,000 chars) and returns `{ summary, actionItems[], draftEmail }` against a strict schema, `max_tokens` 4000. Jordan's shape is quoted verbatim in the header, and the design rule follows: *"one OwnerMeeting card holds many proposed items and NOTHING is created until he taps Accept. A meeting recap that silently spawns eight to-dos is a list he stops trusting."* Rules include *"Action items are ONLY things Jordan himself committed to"*, *"Do not invent deadlines… if nothing was agreed, use 7 days"*, *"an honest empty list is more useful than a padded one"*, and *"The draft email is a starting point Jordan will edit. Never imply it has been sent."* `sourceId` is unique on the Drive file id so re-running can never duplicate a meeting.

---

### The STYLE system prompt and the house writing rules

`STYLE` (`ai.ts:20-24`) is the shared system prompt for every client-facing draft — `draftReply`, `polishOutbound`, and `draftReplyWithContext`. Kept short on purpose: *"kept tight so it steers tone without bloating tokens."* In full, its rules are:

- Voice: warm, confident, accountable, solution-first. Never pushy or defensive.
- **HARD RULES**: no em dash or double dash. No bold. No emojis. Banned words: *hidden gem, gem, move the needle, break the mold, deal breaker*.
- Luxury substitutions: "investment" over "price", "fully committed" over "booked", "thank you for your patience" over "sorry". Use "we" not "I".
- Structure: acknowledge once, take ownership, give the clear next step, then stop. Leave room for recourse ("let us know if you need anything"). Keep texts short and copy-paste ready.
- **Never invent specifics**: no made-up dates, times, availability, prices, fees, refunds, discounts or delivery promises; never say "no additional cost" or "free" unless a policy says so. Only propose real openings you were given.
- Sign-off only if it reads like a full email, as `"In the Spirit of Success, Jordan Spackman"`.

`draftReplyWithContext` layers a much longer per-request prompt on top. It sends the last **24** turns (each clipped to 600 chars), then explicitly re-states the last *client* turn — *"so the model anchors on it rather than the most recent line (which might be ours)"* — plus a profile block: client name, relationship (`segmentLabel` maps `vip → "VIP / top client — treat with extra care"`, `never_converted → "lead / has not booked yet"`, etc.), social plan, property, up to 6 recent jobs with pretty statuses, a note, and real Aryeo availability when scheduling words are detected.

Its extra rules, beyond STYLE:

- **No vague timing, ever**: *"NEVER say 'should be', 'shortly', 'soon', 'in a bit', 'as soon as possible'… If you genuinely don't know the time, ask for it or say we'll confirm the exact time — do not fill the gap with a vague word."*
- **No internal reasons**: *"Do not name a teammate, an editor, a vendor, or a mistake on our end… What went wrong inside the business is not the client's problem."*
- Spell the client's name exactly as given, or don't use one.
- *"Write like a professional running a business, not a friend texting. No 'lol', no 'haha', no slang, no emoji."*
- Availability: offer 2-4 of the exact real open dates, never one that isn't listed.
- If nothing needs answering, return exactly `NO_REPLY_NEEDED` — every caller regex-tests for it and shows a "looks handled" message instead of a draft.

The `instruction` parameter is the human override. When Kyle types "tell her Saturday works but I need the lockbox code", that text is inserted as WHAT WE WANT TO SAY with the strongest language in the file: *"Their intent and every fact they give you (times, dates, answers, requests) are correct and OUTRANK your own read of the thread — they know things the transcript doesn't. Do not water it down, do not add commitments they didn't make, and do not refuse to say it. Still obey the agency policies above."* With an instruction present, `NO_REPLY_NEEDED` is disabled — *"We have decided to send something, so ALWAYS write a message."*

The reply queue additionally post-checks the output against a `VAGUE` regex and, on a hit, returns *"Draft ready — but it still has a vague time in it. Put a real one in before sending"* instead of the normal message (`communications/replyActions.ts`).

---

### Conversation memory and analytics

`src/lib/hubChats.ts` persists every Ask the Hub exchange. `recordHubTurn()` is called best-effort from `askHub` inside its own try/catch — *"never let logging break the answer."* It creates a `HubChat` on the first turn (title = the question clipped to 60 chars) and appends two `HubMessage` rows per exchange, storing the tools used as JSON on the assistant turn.

Question categories are derived **from which tools were called**, not from a second model call — *"no extra AI cost on the hot path."* `classifyCategory()` is first-match-wins over nine keys, ordered so concrete intents beat the broad business-knowledge tool: drafting → tasks → billing → comms → scheduling → clients → projects → tasks → business → general.

The owner-only `/assistant/history` page (guarded by `isOwnerView()`, else `notFound()`) shows a hand-rolled SVG donut (`HubPie.tsx`) of question categories with up to 3 real example questions per slice, a "Who's asking" table from `hubUserStats()`, and the conversation list. It pre-builds summaries for up to **12** stale recent chats on render and offers on-demand generation for the rest; `summarizeHubChat()` skips the model entirely when `summaryAtCount >= messageCount`.

Current volume: **21 chats, 118 messages.**

---

### Gotchas / known state

- **`draftReply()` and `aiConfigured()` are dead exports.** Nothing in `src/` imports either (`ai.ts:15`, `ai.ts:233`). The file's own header comment still describes the module as powering "two things… `draftReply()` … `messageToTodo()`", which has not been true for a long time — the module now has 14 exports and four agent surfaces.
- **`HubDocument` has no `minRole` and `save_document` has no role gate.** The tool refuses only when impersonating (`hubTools.ts:763`); the model's own role is never checked. `/assistant/docs` and `/assistant/docs/[id]` gate on `canAccess(me, "assistant")` only — and `EDITOR` and `PHOTOGRAPHER` both have `assistant` in their default page set. A document composed from owner-tier knowledge (or by the owner-only finance advisor, which writes to the separate `FinanceReport` table but which the assistant could be asked to restate) would therefore be readable by a photographer. **Currently latent: the `HubDocument` table has 0 rows** — the feature has never been used in production.
- **The teach-it loop has been used twice.** `source = "learned"` returns 2 rows out of 5,825. The KB is, in practice, still the ChatGPT-export + training-course corpus.
- **`search_business_knowledge`'s `category` filter can't reach ~1,528 rows.** The tool description lists 13 valid categories, but the live table also holds `sales` (568), `production` (525), `marketing` (239), `systems` (144), `coaching` (33) and `hub_help` (19) — categories minted by the training-course and hub-guide ingests that were never added to the tool's list or to `learn.ts`'s `VALID_CATEGORIES`. An unfiltered query still reaches them; a category-filtered one cannot.
- **`policies.ts` scores a `"policy"` category that does not exist.** `POLICY_CATEGORIES` includes `"policy"` and the scorer gives `category === "policy"` a `+0.15` bonus, but there are **0 rows** with that category and `learn.ts` cannot create one (it isn't in `VALID_CATEGORIES`). Only `fee` ever gets the bonus — and only **12 rows**, since 27 unarchived `fee` items exist but `policies.ts` selects the `CREATIVE`/`ADMIN` tiers only.
- **`policies.ts` sees at most 200 of 2,264 eligible rows.** The `take: 200` sits before the IDF scoring, ordered by confidence then `updatedAt`, so roughly 91% of the CREATIVE/ADMIN policy pool is never scored. A newly taught, low-confidence policy competes for those 200 slots on recency alone.
- **A taught `pricing` fact can never reach a client draft.** `learn.ts` forces `minRole = OWNER` for category `pricing`; `policies.ts` only selects `CREATIVE`/`ADMIN`. (Pre-existing `pricing` rows from the ChatGPT ingest are unaffected — 102 of the 149 are ADMIN/CREATIVE tier.)
- **`save_document` is missing from `TOOL_LABEL`.** `assistant/actions.ts:51` labels 14 of the 15 tools; a `save_document` call renders in the "Looked at" trail as the raw string `save_document`.
- **The "Viewing as" selector described in the KB no longer exists.** `seedHubGuide.ts:28` seeds a pinned, OWNER-tier fact saying *"The Viewing as selector (Owner, Admin, Creative) controls what it will share."* In the current `AskHub.tsx` the `ROLES` array only supplies a **read-only label** for a badge (`AskHub.tsx:351`); the tier comes from the signed-in user via `contentTier()` and cannot be changed from the chat. That seeded fact is stale and the assistant will happily repeat it.
- **Parts of the Ask the Hub app-map prompt are stale — and so is the seeded hub guide.** The prompt describes "Daily Tasks (/queue)", "Task History (/history)", "Billing (/billing)", "Map (/map)" and "Team (/team)" as destinations; `src/lib/auth/access.ts` documents all five as redirect stubs merged into `/tasks`, `/sales`, `/schedule?view=map` and `/users`. The same routes are named as live pages in four of the 19 `hub-guide` KnowledgeItems (`seedHubGuide.ts` lines 12, 19, 20, 27), which `search_business_knowledge` returns verbatim. Links still resolve via the stubs, but the descriptions no longer match the UI.
- **`keyToDate()` in `src/lib/trendsTools.ts:313` is dead code** — defined, never called.
- **The Meet-transcript scan is manual only.** `scanMeetTranscripts()` is reached only from `scanMeetings()` on `/day` (a button); it is not in the daily cron. It is also scoped to the current month by design — *"Jordan asked for 'only backfilling this month'"* — so an older meeting needs an explicit `until`. 2 `OwnerMeeting` rows exist.
- **`draft_client_message` (the Ask the Hub tool) does not pass policies.** Every other drafting entry point calls `relevantPolicies()` first; `hubTools.ts:620` does not, so a draft produced from chat is unconstrained by the taught fee/weather/scheduling rules. It is the only such gap — `threadActions.ts`, the reply queue, the task drafter and both client-page drafters all pass them.
- **The `search_knowledge` tool loads the whole SOP and Resource tables into memory** (`prisma.sop.findMany()` + `prisma.resource.findMany()` with no `where` or `take`) and scores them in JS. Fine at current size; it is the pattern `search_business_knowledge` had to abandon.
- **Tool results are truncated at 14,000 characters** (`ai.ts:198`) with no signal to the model that truncation happened. A `get_billing` over 40 rows or a long `search_comms` can silently lose its tail.
- **Tools are executed serially inside a step**, not in parallel (`ai.ts:186`). Multi-tool turns cost the sum of their latencies.
- **The out-of-steps final call omits the `tools` array** while the message history still contains `tool_use`/`tool_result` blocks (`ai.ts:205-213`). This shape is *accepted* — probed live against `/v1/messages` with the hub's own key on 2026-08-14 (haiku, tool_use + tool_result history, no `tools`): HTTP 200, `stop_reason: "end_turn"`, a normal text answer. Not a bug; just undocumented in the code.
- **The model tiers are hard-coded constants with no env override.** `FAST` is a pinned dated snapshot (`claude-haiku-4-5-20251001`); `SMART` is an undated alias (`claude-sonnet-4-6`) that floats to whatever that alias currently resolves to. Both ids returned HTTP 200 when probed on 2026-08-14. Changing either means a code edit and a deploy — there is no `AI_MODEL` env var anywhere.
- **The whole layer is single-key and unmetered.** There is no per-user rate limit, no token accounting, and no spend cap anywhere — the only throttles are the per-surface `maxSteps`/`maxTokens` and the `WAVE = 4` concurrency in `generateAllReplies`. The one cost-conscious design is the growth-plan snapshot hash and the 20-per-night client-profile cap.

## 9. Access control and security

The Hub holds everything the business runs on — client phone numbers, what every
job was billed, what each photographer gets paid, Jordan's own inbox. So it is
invite-only: nobody can sign in unless Jordan has already added their email to
the list, and once they are in, what they can see is decided by their role.
Kyle (admin) runs operations but never sees the payroll tab. Photographers see
their own shoots and their own pay and nothing else. Editors see their own
queue. Jordan sees everything, and can click "view as" to look at the app
exactly the way anyone else sees it — but that preview is look-only; every
button that would change something is disabled.

Under the hood there are five layers, and they are deliberately independent so
that one of them failing does not open the door:

1. **Middleware** (`src/middleware.ts`) — the login gate + coarse page routing.
2. **Page guards** — every gated page re-reads the user from the database.
3. **Server-action guards** (`src/lib/auth/guards.ts`) — 166 call sites.
4. **Content tiers** — row-level `minRole` on comms and knowledge.
5. **Money scrub** — text-level filtering before anything reaches a creative.

That is the design. Layer 2 is not applied uniformly — three pages read a
missing user as the owner rather than bouncing them; see Gotchas.

---

### Signing in

Three ways in. The two password paths end at `establishSession()`
(`src/lib/auth/session.ts:34`) — the comment there says why: *"One place so no
path drifts on session claims."* **The Google callback does not actually use
it**: `src/app/api/auth/callback/google/route.ts:43-68` re-implements the same
four steps inline (flip `status` to ACTIVE + stamp `lastLoginAt`, adopt Google's
`name`, link `teamMemberId` by case-insensitive email, `signSession` + set the
cookie). Two copies of the login epilogue, exactly the drift the comment on
`establishSession` was written to prevent. (It has already drifted cosmetically —
the callback's comment still says "admin → /today", but `homeFor("ADMIN")`
returns `/tasks`.)

| Path | Entry | Verification | File |
|---|---|---|---|
| Google OAuth | `/api/auth/login` → Google → `/api/auth/callback/google` | random-UUID `state` cookie (`rtp_oauth_state`, 600s), then the `id_token` from Google's own token endpoint | `src/lib/auth/google.ts`, `src/app/api/auth/callback/google/route.ts` |
| Email + password | `/login` form → `loginWithPassword` server action | scrypt hash compare, constant time | `src/app/login/actions.ts:34`, `src/lib/auth/password.ts` |
| Invite / password reset | `/invite/<token>` → `setPasswordFromToken` | one-time `AppUser.inviteToken` (UUID, unique column), consumed (`inviteToken: null`) as the password is set | `src/app/invite/[token]/page.tsx`, `src/app/login/actions.ts:57` |

Sign-out is `/api/auth/logout` (`src/app/api/auth/logout/route.ts`) — POST from
the sidebar, GET allowed as a convenience; both just clear `rtp_session`. There
is no server-side revocation (see Gotchas).

**The allowlist is the gate.** The Google callback looks the verified email up in
`AppUser`; no row (or `status === "DISABLED"`) → `fail("denied")`. A random
Google account cannot get in. The only bypass is an invite: if
`rtp_oauth_invite` carries a token AND the token's `AppUser.email` matches the
email Google just verified, that row is adopted
(`src/app/api/auth/callback/google/route.ts:38-41`).

**Google scopes for login are minimal** — `openid email profile`, no
`access_type=offline`, no refresh token (`src/lib/auth/google.ts:30`). This is a
*separate* redirect URI from the Gmail integration, which reuses the same
`GOOGLE_CLIENT_ID`/`SECRET`. The id_token signature is deliberately not
re-verified, and the comment explains why: it *"comes directly from Google's
token endpoint over our server-side TLS request (not from the user)"*. It does
still check `email_verified` is not false.

**Passwords** exist because "contractors on personal Gmail addresses that a
Workspace-'Internal' OAuth app rejects" cannot use Google sign-in
(`src/lib/auth/password.ts:5-8`). Storage is `salt:hash` hex, scrypt, 16-byte
random salt, 64-byte key, `timingSafeEqual` compare, malformed rows return false
rather than throwing. Minimum length 8, max 200 (`passwordProblem`).

Brute-force throttling is an in-process `Map` — 8 attempts, 5-minute lock
(`src/app/login/actions.ts:15-17`). The comment is honest about the limit:
*"on serverless it's per-instance (not global), but combined with the
invite-only allowlist … and scrypt's deliberate slowness, it's a sensible
deterrent for a small team."* The failure message is identical for "no such
user", "no password set", and "wrong password" so it never enumerates the
allowlist.

#### The session token

`src/lib/auth/jwt.ts` — a stateless HS256 JWT in an httpOnly cookie named
`rtp_session`, 7 days, signed with `APP_SECRET`. Edge-safe (no `next/headers`,
no node crypto) specifically so middleware can import it.

```ts
type SessionPayload = { uid; email; role; name?; permissions?; actingAs? }
```

Cookie flags: `httpOnly`, `sameSite: "lax"`, `secure` only when
`NODE_ENV === "production"`, `path: "/"`.

**Fail-closed on the signing key**: `jwt.ts:14` throws at module load if
`NODE_ENV === "production"` and `APP_SECRET` is unset — *"never fall back to a
public dev key (that would make every session token forgeable)"*. Dev keeps the
literal fallback `"dev-insecure-secret-change-me"`.

`establishSession()` also does two housekeeping jobs on every login: flips
`status` to `ACTIVE`, stamps `lastLoginAt`, and — if `teamMemberId` is null —
links the `AppUser` to its `TeamMember` roster row by case-insensitive email.
That link is what scopes a photographer to their own shoots.

#### The `AppUser` model

`prisma/schema.prisma:1273`. `email` (unique, lowercased), `name`, `role`,
`permissions` (JSON string of per-page overrides), `status`
(`INVITED | ACTIVE | DISABLED`), `passwordHash`, `inviteToken` (unique),
`invitedAt`, `lastLoginAt`, `notificationsSeenAt`, `teamMemberId`, `editorKey`.

`prisma/seed.ts:37` idempotently upserts `info@realtourpilot.com` as an ACTIVE
OWNER — *"so a fresh DB always has an active OWNER and turning on AUTH_ENFORCE
can never lock everyone out."*

---

### AUTH_ENFORCE, and what fails open vs closed

The hub ran "open" (no login) for its first months. `AUTH_ENFORCE` was the
cut-over switch. The important thing today is that **it is no longer the only
signal**, because losing an env var once nearly opened the whole app.

Both `src/middleware.ts:53-57` and `src/lib/auth/guards.ts:18-21` compute:

```ts
const enforced =
  process.env.AUTH_ENFORCE === "true" ||
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.VERCEL);
```

The guards.ts comment records the reason (referenced as "audit crack #26"):
*"losing/typo-ing the env var on a redeploy or an unscoped preview deployment
must never turn every permission check into a no-op against the shared prod
database. The AUTH_ENFORCE flag remains only as a way to turn enforcement ON
locally."*

So the gate is off **only** in local dev with no `AUTH_ENFORCE`, no
`NODE_ENV=production`, no `VERCEL`. In that mode: middleware passes everything
through, all guards are no-ops, `getCurrentUser()` returns null, and the pages
treat a null user as "owner view" (see `src/app/sales/page.tsx:53`,
`src/app/users/page.tsx:37`).

**Three places still key off the raw `AUTH_ENFORCE === "true"` string** and
therefore fail *open* if that variable ever goes missing in production:

| File | Effect if `AUTH_ENFORCE` unset in prod |
|---|---|
| `src/lib/access.ts:10` (`isOwnerView`) | returns `true` for everybody → `/assistant/history` (Ask-the-Hub chat log + analytics) and its two actions become readable by any signed-in user, including editors and photographers, who all have the `assistant` page |
| `src/app/api/quickbooks/connect/route.ts:13` | owner check skipped; any signed-in user can start the Intuit consent flow |
| `src/app/api/frameio/connect/route.ts:13` | same, for Adobe IMS |

The two `/connect` routes are still behind the middleware login gate — the
middleware comment at `src/middleware.ts:31-34` calls this out explicitly:
*"NOTE: /api/quickbooks is deliberately NOT public … Opening the prefix would
bypass middleware auth on /connect, whose own guard only fires when AUTH_ENFORCE
is explicitly 'true'."* `isOwnerView` has no such backstop.

The cron routes use their own fail-closed variant (`NODE_ENV==="production" ||
VERCEL`) but **without** `AUTH_ENFORCE`, so they are unconditionally protected in
prod — see *Cron authentication* below.

---

### Roles and the page matrix

Four roles (`src/lib/auth/access.ts:17`): `OWNER`, `ADMIN`, `EDITOR`,
`PHOTOGRAPHER`. Pages are declared once in `PAGES` — **22 live entries**; the
`PageKey` union carries 26 names because four retired keys (`map`, `billing`,
`payouts`, `team`) stay in the type for legacy permission JSON. Each role gets a
default set in `ROLE_PAGES`.

| Page (key) | Route | OWNER | ADMIN | EDITOR | PHOTOGRAPHER |
|---|---|:-:|:-:|:-:|:-:|
| Dashboard (`dashboard`) | `/` | ● | ● | | |
| Tasks (`tasks`) | `/tasks` | ● | ● | ● | |
| Review Room (`review`) | `/review` | ● | ● | | |
| Project Tracker (`pipeline`) | `/pipeline` | ● | ● | | |
| Schedule (`schedule`) | `/schedule` | ● | ● | | |
| My Shoots (`shoot`) | `/shoot` | ● | ● | | ● |
| My Pay (`mypay`) | `/my-pay` | ● | | | ● |
| Communications (`communications`) | `/communications` | ● | ● | | |
| Clients (`clients`) | `/clients` | ● | ● | | |
| Upload Portal (`upload`) | `/upload` | ● | ● | ● | ● |
| Editor Queue (`editing`) | `/editing` | ● | ● | ● | |
| Finance (`sales`) | `/sales` | ● | ● | | |
| Trends (`trends`) | `/trends` | ● | ● | | |
| **My Day (`day`)** | `/day` | ● (ownerOnly) | | | |
| Service Catalog (`catalog`) | `/catalog` | ● | ● | | |
| Campaigns (`marketing`) | `/marketing` | ● | | | |
| Resources & SOPs (`resources`) | `/resources` | ● | ● | ● | ● |
| Training (`training`) | `/training` | ● | ● | ● | ● |
| Ask the Hub (`assistant`) | `/assistant` | ● | ● | ● | ● |
| Feedback (`feedback`) | `/feedback` | ● | ● | | |
| **Connections (`connections`)** | `/connections` | ● (ownerOnly) | | | |
| People (`users`) | `/users` | ● | ● | | |

`ownerOnly: true` is absolute: `canAccess()` returns false for a non-owner
*"even via override"* (`access.ts:131`). Only `/day` and `/connections` carry it.

Notable design decisions carried in comments:
- **EDITOR has no `dashboard`** — *"the overview page carries ops counts + owner
  money strips that aren't an editor's business — middleware bounces them to
  /editing"* (`access.ts:88`).
- **PHOTOGRAPHER lives entirely in the field platform** — shoot, mypay, upload,
  resources, training, assistant. *"They get NO ops/dashboard, schedule, map,
  clients, comms, billing, pipeline"* (`access.ts:91-98`).
- `ADMIN` has `sales` and `users` at page level only so Kyle reaches the Unpaid
  and Team **tabs**; the owner-only tabs gate on the page itself.

#### Per-user overrides

`AppUser.permissions` is a JSON object like `{"clients":true,"catalog":false}`.
`canAccess()` checks overrides *before* the role default, so `true` grants and
`false` revokes. Set from People → Logins via `setUserPermission`
(`src/app/users/actions.ts:116`), whose check is `PAGES.some((p) => p.key === key
&& !p.ownerOnly)` — so the two `ownerOnly` pages **and** the four retired legacy
keys are both unsettable from the UI. `value: null` deletes the key and falls
back to the role default.

#### Legacy key folding

Several routes were merged into tabbed hubs. `canAccess()` carries a `LEGACY`
map (`access.ts:140-145`) so stored permission JSON keeps working:
`tasks ← today|history`, `schedule ← map`, `sales ← billing|payouts`,
`users ← team`. The old routes survive as redirect stubs with **no** PageKey, so
`pathKey()` returns null and any signed-in user may take the redirect hop — the
destination page enforces access itself.

#### Where people land

`homeFor(role)` (`access.ts:106`): PHOTOGRAPHER → `/shoot`, EDITOR → `/editing`,
ADMIN → `/tasks`, everyone else → `/`. Used for post-login redirect and for the
middleware bounce. *"every target is in that role's ROLE_PAGES, so there's no
redirect loop."*

The sidebar hides pages the viewer cannot open (`Sidebar.tsx:133`), plus two
cosmetic rules: `mypay` is stripped for anyone who is not a PHOTOGRAPHER, and
`resources` is relabelled "SOP Center" for creatives.

---

### Middleware: what it gates and what it does not

`src/middleware.ts` runs on everything except Next internals and static asset
extensions. It is described in its own comment as an *"optimistic login gate"* —
it enforces (a) you have a valid session, and (b) your role/permissions allow
this top-level nav page. **Real authorization lives in the pages and the server
actions**, because the middleware only sees the JWT claims, not the database.

`pathKey()` matches only the 22 `PAGES` hrefs (exact or `href + "/"` prefix).
Detail routes like `/projects/<id>`, `/edit/<id>`, `/review/<id>` return null and
are open to **any signed-in user** — they gate themselves.

Public prefixes (`middleware.ts:35`), each with a stated reason:

| Prefix | Why it must be public |
|---|---|
| `/login`, `/invite` | the sign-in surfaces themselves |
| `/api/auth`, `/api/google` | OAuth callbacks |
| `/api/webhooks` | inbound provider events (each verifies its own signature) |
| `/api/cron` | Vercel cron (bearer-token authenticated) |
| `/api/health` | *"read-only integration diagnostics (no secrets in responses)"* |
| `/api/activity` | the usage beacon — *"it self-authenticates (204 on no session), and gating it here would 307 stale-cookie beacons into pointless /login renders on every navigation"* |
| `/learn` | public training-lesson share; *"the unguessable token is the gate; the page shows video + summary only, never the verbatim transcript"* |
| `/privacy`, `/terms` | *"the public legal pages OAuth providers (Intuit, Google, Adobe) require in order to issue production credentials"* |
| `/feedback/<projectId>` | client-facing feedback form (regex `^/feedback/[^/]+$`; the bare `/feedback` board stays gated) |

---

### Page-level guards

`src/lib/auth/user.ts` exposes `getCurrentUser()`, wrapped in React `cache()` so
*"the layout + the page + any guard share ONE AppUser read per request."* It
re-reads the `AppUser` row every request, so a role change, a permission change,
or a `DISABLED` flip takes effect immediately at page level (not at the
middleware level — see Gotchas).

`CurrentUser` carries both the **effective** identity (what to render) and the
**real** one: `impersonating`, `realRole`, `realName`.

The pattern every gated page actually uses is inline, not the exported helpers:

```ts
const me = await getCurrentUser().catch(() => null);
if (!me && authEnforced()) redirect("/login?next=/sales");
if (me && !canAccess(me, "sales")) redirect("/");
const isOwner = me ? me.role === "OWNER" : !authEnforced();
```

Verified on `/sales`, `/users` (`:32`), `/tasks` (`:29`), `/shoot` (`:24`),
`/my-pay` (`:76-79`). `/review` uses a variant with the same effect — no
`/login` bounce, but `ownerDesk = me ? OWNER||ADMIN : !authEnforced()` then
`redirect(homeFor(me?.role))`, so a null viewer in prod is bounced, not served
(`src/app/review/page.tsx:72-74`).

**Three pages skip the `!me` bounce entirely** and read a null viewer as
owner — see Gotchas: `/` (`src/app/page.tsx:50`), `/editing`
(`src/app/editing/page.tsx:21`, no null branch at all) and `/edit/<id>`
(`src/app/edit/[id]/page.tsx:54`).

The comment on `src/app/sales/page.tsx:45` explains the `!me` branch:
*"Transient session/DB failure must not render owner finance to a stale tab …
getCurrentUser also returns null for a DISABLED/deleted account, so in prod `!me`
must NOT grant the owner-only Revenue/Payroll tabs to a revoked session still
holding a valid 7-day JWT."*

Two hubs gate **per tab**, mirroring the routes they replaced:

| Hub | Tab | Who |
|---|---|---|
| `/sales` (Finance) | Revenue, Payroll, Overview, Money, Personal, People, Jobs, Spending, Advisor, Budget | owner |
| | Unpaid | admin + owner |
| `/users` (People) | Team | admin + owner |
| | Logins & access, Activity | owner |

A non-owner deep-linking `?tab=logins` is redirected to `?tab=team`
(`src/app/users/page.tsx:51`).

Role-scoped detail pages:
- `/editing` — an EDITOR gets `EditorDay` scoped to their `editorKey` (or their
  name slug). An EDITOR with neither **fails closed** into an explanatory empty
  state rather than falling through to the owner/admin view, which *"carries
  every job + the add-to-queue control"* (`src/app/editing/page.tsx:29-39`).
- `/shoot` — photographers are always scoped to `photographerMemberId(user)`,
  falling back to the sentinel `"__none__"`. *"Photographers can never use ?as=
  — they're always scoped to themselves, fail-closed"* (`shoot/page.tsx:31`).
- `/my-pay` — PHOTOGRAPHER sees their own; EDITOR is redirected away; owner/admin
  with a `payPercent` see their own, without one are sent to `/payouts`.
  The comment records a past incident: *"the old 'first photographer' local-dev
  fallback put James's page in front of the owner twice and is gone for good."*
- `/edit/<id>` — a PHOTOGRAPHER is redirected to `/shoot/<id>`.

---

### `contentTier` and the CREATIVE / ADMIN / OWNER ladder

Four app roles fold onto three **content sensitivity tiers**
(`access.ts:161`): OWNER → `OWNER`, ADMIN → `ADMIN`, everything else →
`CREATIVE`. This is the ladder used for stored comms and stored knowledge, and
it is row-level, not page-level.

```ts
const ROLE_RANK = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };
// a viewer sees rows whose minRole rank <= their own
```

Two tables carry a `minRole` column:

- **`CommLog`** — every text, call transcript, email, Slack message and note.
  `logComm()` (`src/lib/commLog.ts:30`) defaults to `ADMIN`, accepts only
  `OWNER` or `CREATIVE` as overrides. Slack DMs are logged `OWNER`. Unknown
  senders on `info@realtourpilot.com` (Jordan's personal mailbox) are logged
  `OWNER` — *"so a missed lead is at least auditable instead of leaving zero
  trace"* (`google.ts:864-869`).
- **`KnowledgeItem`** — the Ask-the-Hub brain. `searchBusinessKnowledge` in
  `hubTools.ts:500` describes it as a *"STRICT role gate: only items at or below
  the viewer's role are even fetched"* — the filter is in the SQL `where`, not
  applied after the fact.

Consumers that apply the ladder, verified:

| Surface | File |
|---|---|
| Reply queue (unanswered texts) + its dashboard summary | `src/lib/replyQueue.ts:101`, `:237` |
| Email threads on Communications | `src/components/comms/emailThreads.ts:91` |
| Ask the Hub (`search_business_knowledge`, `search_comms`) | `src/lib/hubTools.ts:501`, `:559` |
| Client working profiles | `src/lib/clientProfile.ts:38`, `:57` |
| Policy lookup | `src/lib/policies.ts:19` — **not viewer-derived**: a hardcoded `minRole: { in: ["CREATIVE","ADMIN"] }`, so OWNER-tier policy items are excluded from every caller including the owner |

**Writing knowledge has a sensitivity floor.** `learnFact()`
(`src/lib/learn.ts:82-88`) forces `minRole` up to `OWNER` when the title/body
matches `OWNER_SENSITIVE` (`learn.ts:28`) — margin, markup, profit, payroll,
salary/salaries, wage/wages, commission, payout/payouts, cogs, gross, strateg\*,
acquisi\*, acquir\*, personnel, competitor\*, `pay rate`, `we pay`, `our cost`,
`vendor cost`, `costs us`, `net profit` — or when the category is `financial`,
`strategy`, or `pricing` (`OWNER_CATEGORIES`, `learn.ts:32`). The rationale:
*"Over-restricting is safe; leaking is not"*, and *"a false positive just means
Kyle/creatives don't see one operational note (safe + correctable)."*

**Content filtering by tier** also drives the read-only surfaces:
`/resources` shows creatives SOPs only (no booking forms, no ops quick links);
`/training` filters lessons to the Agent-on-Camera volume plus a whitelist of
Vol II courses; `/` (dashboard) redirects any CREATIVE-tier user to their home.

Ask the Hub's viewer tier is derived server-side and is never accepted from the
client (`askHub`, `src/app/assistant/actions.ts:141-156`): *"The viewer's content
tier is derived from the SIGNED-IN user, never trusted from the client … an
unauthenticated or unauthorized call must refuse cleanly, never fall back to a
privileged tier."* It also re-checks `canAccess(me, "assistant")`, because a
server action is a POST that middleware never saw. Note the last line:
`const viewerRole = me ? contentTier(me.role) : "OWNER"` — sessionless **local
dev** resolves to OWNER, which is only reachable because `authEnforced()` already
refused a null user in prod. `execHubTool`'s own ctx default is
`{ role: "CREATIVE" }` (`hubTools.ts:231`) — least privilege if a caller forgets.

---

### The money scrub

Creatives are never shown a dollar figure. Three mechanisms stack.

**1. Tool-level suppression** — `canSeeMoney(role)` in `hubTools.ts:208` is
`rank >= ADMIN`. Below that: `search_projects` drops `balance_owed` (`:261`),
`get_project_detail` omits the whole `billing` block (`:315`), `find_client`
omits `lifetime_spend` (`:345`), and `get_billing` (`:425`), `search_comms`
(`:548`), `draft_client_message` (`:594`), `create_task` (`:656`) and
`remember_fact` (`:735`) return a plain "admin and owner only" error string.

**2. Text-level scrubbing** — `stripMoneySentences()` (`src/lib/text.ts:102`)
splits on sentence boundaries and drops any sentence matching:

```
/[$€£]\s?\d|\b(invoice|price|pricing|charge[ds]?|refund|discount|billing|payment|paid|owe[ds]?)\b/i
```

Applied server-side and unconditionally at:

| Surface | File | Note |
|---|---|---|
| A photographer's own task list on My Shoots | `src/lib/shoot.ts:583` | *"task text is minted from client comms and can carry pricing"*; `description`/`sourceDetail` never cross to the field at all |
| Client praise on `/shoot` and the feedback hub | `src/lib/review.ts:167`, `src/lib/photographerFeedback.ts:173` | *"clients mention price in praise all the time"* |
| Revision asks on the editor's `/edit/<id>` tracker | `src/app/edit/[id]/page.tsx:120-127` | gate is strict: only a live OWNER/ADMIN sees raw text; a scrubbed-empty ask becomes `"(a note was held back — ask Jordan)"` so round labels stay aligned |
| Task notes routed to a non-Kyle assignee | `src/lib/comms.ts:334` | |
| A photographer's tapped note preview | `src/app/shoot/note/[noteId]/page.tsx:76` | labelled "defense-in-depth" |

**3. Negative feedback never reaches creatives.** `getClientFeedback()`
(`src/lib/review.ts:151`) filters `sentiment: { in: ["POSITIVE","NEUTRAL"] }` —
*"The sentiment-in filter deliberately fails closed: NEGATIVE and
null-sentiment rows never match"* — and then runs `hasNegativeCues()` on the
body, because *"the sentiment column trusts stars over words (4★ + 'please redo
the yard' is POSITIVE)"*. A mixed review shows its star rating and no text;
Jordan relays the criticism himself.

---

### "View as" impersonation

Jordan can preview another person's exact view. The session gains an
`actingAs` claim (`viewAs()` in `src/app/users/actions.ts:148`), and
`getCurrentUser()` resolves the effective user from it — but **only if the real
session user is an active OWNER**:

```ts
if (s.actingAs && real.role === "OWNER" && s.actingAs !== real.id) { … }
```

The read-only guarantee is enforced in four independent places:

| Layer | Mechanism |
|---|---|
| `requireRole` / `requireOwner` / `requireAdmin` | throws *"You're previewing another user — exit the preview to make changes."* unless `opts.allowImpersonation` |
| `requireTaskAccess`, `requireShootAccess` | same check, inlined. The shoot one carries the reason: *"a previewing owner tapping Send on the shoot screen would REALLY text the client (audit: field actions were the one guard family missing this block)"* |
| Ask the Hub write tools | `create_task` (`hubTools.ts:652`), `remember_fact` (`:731`) and `save_document` (`:763`) refuse on `ctx.impersonating`. `remember_fact` carries the extra reason: *"a fact taught mid-preview would be misattributed to the impersonated role"* |
| Bespoke checks | `src/app/users/actions.ts:16`, `src/app/review/actions.ts:92`, `src/app/projects/reviewActions.ts:97` |

Side effects also suppressed while impersonating: the usage beacon returns 204
(`src/app/api/activity/route.ts:20`, plus a client-side skip in
`Shell.tsx:33` — *"belt … and suspenders"*), and marking notifications seen is a
no-op so the preview *"must never move THEIR watermark"*
(`src/app/api/notifications/route.ts:50`).

The UI shows a persistent amber `ViewAsBanner` with an Exit button; `/shoot`
additionally passes `tasksReadOnly` so the Done button is not even offered.

**The single documented exception**: `src/app/map/actions.ts:11` —
`requireRole(["OWNER","ADMIN"], { allowImpersonation: true })` for weather,
drive time, address autocomplete and distance lookups. These are read-only
lookups, so allowing them during a preview keeps the previewed screens working.

---

### Server-action guards

Middleware gates *navigation*, not the POST that invokes a `"use server"`
function — so every sensitive action guards itself. `src/lib/auth/guards.ts`:

| Guard | Allows | Blocks impersonation | Call sites¹ |
|---|---|:-:|:-:|
| `requireOwner()` | OWNER | ● | 74 |
| `requireAdmin()` | OWNER, ADMIN | ● | 62 |
| `requireRole(roles, opts)` | explicit list | ● unless opted out | 9 |
| `requireTaskAccess(taskId)` | OWNER, ADMIN, **or the person the task is assigned to** | ● | 3 |
| `requireShootAccess(projectId)` | OWNER, ADMIN, **or the assigned photographer** | ● | 15 |
| `requireDeliverableAccess(id)` | resolves `Deliverable.projectId` → `requireShootAccess` | ● | 2 |
| `requireUploadFileAccess(id)` | resolves `UploadedFile.projectId` → `requireShootAccess` | ● | 1 |

¹ direct calls outside `guards.ts` itself; 166 total. (Counts verified by grep at
the time of writing.)

Every guard short-circuits on `if (!enforced()) return` — they are genuine
no-ops in local dev. The one exception is user management's
`requireOwnerActor()`, which has no `enforced()` escape hatch and therefore
throws "Not signed in." even locally.

`requireTaskAccess` exists because of a specific bug (labelled "audit crack #28"
in the source): editors were DB-scoped to their own tasks on `/queue` but the
Complete/status/assign buttons behind them were admin-only, so *"the day
Kim/Remar get accounts they'd hit 'You don't have access' on their own finished
work."* It matches the task's `assignedKey` against **every** key the human is
addressable by — `editorKey`, the `AppUser` name slug, and the roster
`TeamMember` name slug — *"so an AppUser renamed away from the roster spelling
doesn't lose the ability to act on their own work."* Its header comment still
claims *"Photographers stay excluded — their field flow goes through
requireShootAccess"*, but `guards.ts:61` admits `PHOTOGRAPHER` too; the inline
comment two lines down records the later fix (*"a photographer with work moved
onto their plate must be able to complete it"*). The comment is stale, the code
is the newer behaviour.

`requireShootAccess` resolves ownership via `photographerOwnsShoot()`
(`src/lib/shoot.ts:354`): the project's `photographerId` **or** an appointment's
`assignedToId`.

User management uses its own `requireOwnerActor()`
(`src/app/users/actions.ts:13`) with three self-lockout protections: you cannot
change your own role away from OWNER, disable your own account, or remove
yourself.

**The unguarded server actions** are exactly three, all by design: `submitFeedback`
in `src/app/feedback/[id]/actions.ts` (backs the public client-facing form at
`/feedback/<projectId>`) and `loginWithPassword` / `setPasswordFromToken` in
`src/app/login/actions.ts` (they *are* the sign-in path). Every other file
containing `"use server"` imports a guard, `getCurrentUser`, or `authEnforced`.

---

### Secrets at rest

Every third-party credential is encrypted with **AES-256-GCM** before it touches
the database (`src/lib/integrations/crypto.ts`). Blob format is
`ivHex:tagHex:cipherHex`, 12-byte random IV, key = `sha256(APP_SECRET)`.

`masterKey()` throws if `APP_SECRET` is absent on **any** deployed environment —
the guard checks `NODE_ENV === "production" || VERCEL`, and the comment says
why: *"otherwise a preview/staging deploy would silently encrypt real
integration tokens with the committed dev fallback key."*

Stored encrypted in `Connection.secretEncrypted` (`saveSecret` /
`getSecret` in `src/lib/integrations/connections.ts`): `aryeo`, `openphone`,
`openphone_webhook`, `stripe`, `dropbox`, `slack`, `slack_user`, `ai`
(Anthropic), `gmail` (a JSON map of `email → refreshToken`), `quickbooks`
(refresh token), `frameio`, `frameio_app`, `frameio_webhook`, `plaid`.
Plaid per-bank access tokens live in `PlaidItem.accessTokenEncrypted`, same
crypto (`src/lib/integrations/plaid.ts:173`).

`getSecret()` returns `null` on a decrypt failure rather than throwing — which
is what happens to every stored secret if `APP_SECRET` is ever rotated. Nothing
in the codebase re-encrypts on rotation.

Secrets never leave the server: `connections.ts` states *"The plaintext secret
never leaves this layer except to the provider's own API client"*, and
`maskSecret()` renders `sk_l…3a9f` for display.

`disconnect(provider)` nulls `secretEncrypted`.

Provider-level OAuth app credentials stay in env vars, not the DB:
`GOOGLE_CLIENT_ID/SECRET`, `DROPBOX_APP_KEY/SECRET`, `QBO_CLIENT_ID/SECRET`
(plus `QBO_SANDBOX_CLIENT_ID/SECRET`, selected by `QBO_ENV`),
`FRAMEIO_CLIENT_ID/SECRET`, `SLACK_SIGNING_SECRET`, `SCRIPTING_API_KEY`,
`SCRIPTING_WEBHOOK_SECRET`, `CRON_SECRET`, `APP_SECRET`. That is the complete
set of secret-bearing env vars in `src/`, `scripts/` and `prisma/`.

---

### Webhook signature verification

Five inbound webhook routes, three different verification schemes. All of them
are on the middleware public list, so the signature *is* the authentication.

| Provider | Scheme | Secret source | Rejection behaviour |
|---|---|---|---|
| **Slack** | HMAC-SHA256 over `v0:{ts}:{raw}`, header `x-slack-signature`, plus a ±300s replay window on `x-slack-request-timestamp` | `SLACK_SIGNING_SECRET` env | 401. **Fails closed**: `if (!SIGNING_SECRET) return false` |
| **OpenPhone** | shared-secret token in the callback URL (`?t=`), constant-time compare | encrypted `openphone_webhook` Connection, minted by `registerOpenPhoneWebhooks()` (24 random bytes, rotated each registration) | 401 + a `signature.rejected` `WebhookEvent` row + spike alert. **Fails open when no token is stored** |
| **Frame.io** | identical `?t=` token scheme | encrypted `frameio_webhook` Connection | same as OpenPhone |
| **Aryeo** | HMAC-SHA256 hex of the raw body; accepts headers `signature`, `x-aryeo-signature`, `x-signature`, `aryeo-signature`; strips a `sha256=` prefix | `Connection.webhookSecret` column | 401 + `signature.rejected` row + spike alert. **Verification is skipped entirely when the column is null** |
| **Script Studio** | HMAC-SHA256 hex, header `x-scripting-signature` | `SCRIPTING_WEBHOOK_SECRET` env (must equal `HUB_WEBHOOK_SECRET` on the Studio server) | 401 + `signature.rejected` row. Skipped when the env var is unset |

All comparisons check length first, then `crypto.timingSafeEqual`.

The "fails open until a token exists" choice is deliberate and documented:
*"backward compatible: allowed until a token is stored"* — the webhook keeps
working until Jordan re-registers it. `/connections` surfaces every such
provider in an `unsignedProviders` list (`src/app/connections/page.tsx:70-80`)
*"by design, but it should be visible, not silent."*

Aryeo's skip has a second justification at
`src/app/api/webhooks/aryeo/route.ts:19`: *"it's safe to leave off because
processAryeoEvent never trusts the payload's contents — it re-fetches the
authoritative record from Aryeo's API."*

Rejections are not silent. Each logs a `WebhookEvent{ status: "REJECTED" }` and
calls `alertWebhookRejections(provider)` (`src/lib/notify.ts:334`), which pings
Slack + the owner's bell at **exactly** the 6th rejection in an hour — the test
is `n === REJECTION_ALERT_THRESHOLD` (`notify.ts:333`, `= 6`), an equality, not
`>=`. That is what makes it fire once rather than on every subsequent rejection,
but it also means concurrent rejections that step the count straight past 6
produce no alert at all. The comment records why the alert exists: *">5 rejections in an hour means real events are bouncing
at the door (this ran silent for 13 days once)."*

---

### Cron authentication

Four routes (`/api/cron/{daily,gmail,sync,relabel-deliverables}`), three of them
scheduled in `vercel.json` (gmail every 5 min, sync hourly, daily at 08:00 UTC).
Each opens with the same fail-closed block:

```ts
const secret = process.env.CRON_SECRET;
const enforced = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
if (!secret && enforced) return 401 "CRON_SECRET not configured";
if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return 401;
```

*"FAIL CLOSED: in prod/Vercel a missing CRON_SECRET must refuse, not open the
door — same rule as the auth gate (losing an env var never fails open)."*

---

### Other hardening on the API surface

| Route | Control |
|---|---|
| `/api/file` | `withinStorage(rel)` path check — *"the path must live inside our app-owned storage prefix, so this endpoint can never be used to pull arbitrary files from the rest of the team's Dropbox"* |
| `/api/media/download` | https-only + hostname allowlist (`aryeo.com`, `digitaloceanspaces.com`, `mux.com`, `cloudfront.net` and subdomains) — *"prevents this route from becoming an open proxy / SSRF vector"* |
| `/api/activity` | session-derived identity only, `isTrackablePath()` route-shape allowlist (*"an arbitrary client string would let a user paint fabricated entries into the owner's trail"*), 120-events/hour flood cap, and an atomic dedupe where the row id is `sha1(user|path|20s-bucket)` |
| `/api/notifications` | session-scoped `visibleWhere()` — role broadcasts plus rows keyed `tm:<teamMemberId>` / `editor:<editorKey>` |
| `/learn/<token>` | `body` (the verbatim transcript) is deliberately not selected; only `summaryMd` + `videoUrl` reach the public page. Missing token → `notFound()` *"(no leak that it existed)"* |
| Task full view (`getTaskConversation`) | conversation section is OWNER/ADMIN only; `info@` Gmail threads never live-fetch for an ADMIN and fall through to the `minRole`-filtered `CommLog`. Uses the **effective** role so "view as" honestly shows what that role would see. The catch block returns no conversation data — *"failing closed here leaks nothing"* |
| `/api/quickbooks/callback`, `/api/frameio/callback` | CSRF `state` cookie compare (`rtp_qbo_state`, `rtp_fio_state`); QBO additionally hard-fails without `realmId` |

---

### Gotchas / known state

- **`isOwnerView()` fails OPEN.** `src/lib/access.ts:10` returns `true` whenever
  `AUTH_ENFORCE !== "true"` — it does **not** use the fail-closed
  `enforced()` helper the middleware and guards use. If that env var is ever
  dropped or typo'd on a Vercel redeploy, `/assistant/history` (Jordan's full
  Ask-the-Hub chat log and analytics) plus `deleteHubChat`/`renameHubChat` open
  to every signed-in user — and every role has the `assistant` page. This is
  the one remaining instance of the exact pattern the rest of the codebase was
  audited to remove ("audit crack #26").

- **The login epilogue exists twice.** `establishSession()` was written so "no
  path drifts on session claims", but the Google callback never calls it —
  `src/app/api/auth/callback/google/route.ts:43-68` repeats activate + stamp +
  roster-link + `signSession` + cookie by hand. Anything added to
  `establishSession` (a new claim, an audit write) silently applies to the
  password paths only.

- **The Gmail-connect OAuth flow has no CSRF `state` and no auth on its
  callback.** `googleAuthorizeUrl()` (`src/lib/integrations/google.ts:244`) sets
  no `state` param, and `/api/google/callback` is on the middleware public list
  and checks nothing before calling `addGmailAccount(refreshToken)`, which
  writes into the shared encrypted `gmail` secret map. Every sibling flow —
  login, QuickBooks, Frame.io, Dropbox — does the state-cookie dance. Unverified
  whether this is practically exploitable end-to-end, but the code-level
  asymmetry is real, and the token at stake is no longer just mail: the scope
  list at `google.ts:22-34` is `gmail.readonly`, `gmail.send`,
  `userinfo.email`, `calendar.events` (write) and `drive.readonly`.

- **`Connection.webhookSecret` has no write path.** The column exists in
  `prisma/schema.prisma:796` and is read at
  `src/app/api/webhooks/aryeo/route.ts:23`, but nothing anywhere in `src/` or
  `scripts/` ever sets it. Aryeo webhook signature verification is therefore
  **dormant in practice** — the route accepts unsigned POSTs. `/connections`
  correctly lists `aryeo` under `unsignedProviders`.

- **OpenPhone and Frame.io webhook tokens are also conditional.** Both return
  `true` when no token is stored. Per the Frame.io memory notes the token auth
  is dormant "until re-register". Whether the OpenPhone token is currently
  present in prod could not be verified from the repo.

- **`requireUser()` and `requireAccess()` are dead code.** Exported from
  `src/lib/auth/user.ts:64` and `:70`, imported by nothing. Every page rolled
  its own `getCurrentUser() + authEnforced() + canAccess()` inline instead. Two
  ways to do the same thing, one of which is never exercised.

- **Three pages have no null-user bounce, and read `!viewer` as owner.** Unlike
  `/tasks`, `/sales`, `/users`, `/shoot` and `/my-pay`, these never do
  `if (!me && authEnforced()) redirect("/login")`. A null user in prod is not
  "nobody" — it is a DISABLED/deleted account still holding a valid 7-day JWT
  (middleware only checks the signature), or a transient DB failure:
  - `/` — `src/app/page.tsx:50`, `const isOwner = !me || me.role === "OWNER"`.
    That flag gates `getOwnerStats()`, `getOwnerPulse()` and `getOwnerDials()`
    — the revenue/pulse/quality strips. The only guard on the page is a
    CREATIVE-tier redirect at `:49`, which needs a `me` to fire.
  - `/editing` — `src/app/editing/page.tsx:21` has no null branch at all, so a
    null viewer falls straight through to the owner/admin accountability view
    the EDITOR fail-closed branch was written to keep people out of (every job
    plus the add-to-queue control).
  - `/edit/<id>` — `src/app/edit/[id]/page.tsx:54`,
    `const isOwnerAdmin = !viewer || …`, which unlocks the "Full details" link
    to the full project page (`:153`), the Script Studio URL (`:224`) and
    every lane's editor feedback (`:60`). The money-bearing revision asks are
    still safe there, because `canSeeRaw` (`:120`) uses the strict positive
    test.

- **Middleware page-gating runs on a snapshot.** The JWT carries `role` and
  `permissions` as they were at login and is valid 7 days; nothing re-issues it
  when Jordan changes someone's role or revokes a page. So for up to 7 days,
  *navigation* to a newly-forbidden page is not blocked by middleware. The page
  itself does re-read from the database and bounces, and every server action
  uses the fresh DB role — so this is a routing-latency wart, not an
  authorization hole. There is no server-side session revocation list;
  disabling an account relies on `getCurrentUser()` returning null.

- **The password brute-force counter is per-instance.** `src/app/login/actions.ts`
  keeps it in a module-level `Map`; on Vercel each lambda instance has its own,
  so the effective limit is 8 × (number of warm instances). The code comments
  acknowledge this.

- **`exitViewAs()` trusts the JWT, not the DB.** `src/app/users/actions.ts:170`
  checks `s.role !== "OWNER"` from the session claim rather than the database
  row. Harmless in effect (it only *removes* elevated state), but inconsistent
  with every other guard in the file, which uses `realRole`.

- **`PageKey` still contains four retired keys** — `map`, `billing`, `payouts`,
  `team` — kept only so stored `permissions` JSON keeps resolving through the
  `LEGACY` map. They are absent from `PAGES`, so their routes are ungated
  redirect stubs.

- **No Content-Security-Policy.** `next.config.ts` does set baseline headers on
  `/:path*` — `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: strict-origin-when-cross-origin`, HSTS
  (`max-age=63072000; includeSubDomains; preload`) and
  `X-DNS-Prefetch-Control: on` — but no CSP, and the root layout injects an
  inline `<script>` for the theme boot that a strict CSP would need to
  accommodate. The same file raises the server-action body limit to `8mb` for
  Ask-the-Hub photo attachments.

- **The Slack webhook answers `url_verification` before checking the
  signature.** `src/app/api/webhooks/slack/route.ts:34-36` echoes back
  `payload.challenge` on any POST claiming that type. Harmless (it reflects the
  caller's own string and touches nothing), but it means the route is not
  literally "signature-first".

- **No rate limiting on server actions.** The only throttles that exist are the
  login attempt counter and the `/api/activity` flood cap.

- **Twelve `_tmp_wf_skep*.ts` scratch files sit uncommitted at repo root**
  (git status shows them untracked). Not an auth issue, but they are inside the
  Next.js project root and were not reviewed as part of this section.

## 10. Owner surfaces

These are the screens only Jordan sees: the dashboard he opens first thing, My Day (his personal
to-dos plus an auto-planned calendar), Trends (is the business speeding up or slowing down), the
client segment/profile layer, and the owner-only record of who is actually using the platform.
Everything else in the hub is somebody's work queue; these five answer "how are we doing" and
"what am I doing next".

Gating is layered. `pathKey()` (`src/middleware.ts:9`) maps a pathname to a `PageKey` by matching
`PAGES` (`src/lib/auth/access.ts`) on `pathname === href || pathname.startsWith(href + "/")`, and
middleware bounces anyone whose role/permissions fail `canAccess`. Pages then re-check themselves,
and server actions guard independently with `requireOwner()` / `requireAdmin()`
(`src/lib/auth/guards.ts`) because, in that file's words, "middleware only gates page navigation,
not the POST that invokes a `use server` action". Those guards are **no-ops when enforcement is
off** — and enforcement is always on in production or on Vercel regardless of `AUTH_ENFORCE`,
because "losing/typo-ing the env var on a redeploy … must never turn every permission check into a
no-op against the shared prod database (audit crack #26)". Two page keys are `ownerOnly: true` and
can never be granted by a per-user permission override: `day` (`/day`) and `connections`.

---

### The dashboard (`/`)

Plain English: this is the ten-second glance. It answers "is anything on fire?" and gives one
button into where the work happens. It shows **numbers**, never lists — the lists live in the Tasks
hub and on `/billing`. (Note the chip hrefs still point at `/today` and `/queue`, which are now
redirect stubs into `/tasks?tab=today` and `/tasks?tab=board`; every link takes one extra hop.)

#### The design contract

`src/app/page.tsx:22-30` states it as a rule, with the history that produced it:

> The dashboard's ONE job: a 10-second, role-aware glance … It shows COUNTS; `/today` shows rows.
> It never renders a task list. Keep it to ~one phone screen with exactly one primary CTA. (The old
> page was ~5,000px tall with 154 links and no primary action — don't let it grow back.)

Four rules fall out of that, each enforced in code:

| Rule | Where | Why (from the code comments) |
| --- | --- | --- |
| One primary CTA | `page.tsx:107-115` — the single `bg-brand` "Start your day" link to `/today` | Everything else on the page is a quiet secondary link |
| Counts are **honest and system-wide** | `getActionCounts()` (`src/lib/queries.ts:409-420`) | Audit 2026-07-08: the old chips read off the morning-brief slice and showed "1 replies / 0 to assign" while 34 tasks sat unassigned |
| The button's number can't lie | `getTodayCardCount()` (`queries.ts:430-459`) replicates `/today`'s stack query exactly | "= the card count `/today` renders, so the button never lies" (`page.tsx:53`) |
| Never show the same number twice | `page.tsx:201-203` | "the old footer also repeated the chip numbers in grey; deleted — the same number twice on one screen is how dashboards start lying" |

#### The chips

Every chip deep-links into the surface where that pile is actually worked (`CountChip`,
`page.tsx:32-42`).

| Chip | Source | Definition | Link |
| --- | --- | --- | --- |
| `texts unanswered` | `replyWaitingSummary()` (`src/lib/replyQueue.ts:228-264`) | Newest row per conversation is inbound and doesn't `looksHandled()`. Counted off `CommLog` (`channel: "text"`, last `WINDOW_DAYS = 21`, `SCAN_CAP = 1200` rows), **not** off reply tasks. Role-scoped by `minRole` against the viewer's content tier | `/communications?tab=replies` |
| `message to-dos` | `counts.replies` | Open `SmartTask` in `MESSAGE_TASK_TYPES` | `/tasks` |
| `in QC` | `counts.qc` | Open task in `DELIVER_TASK_TYPES` | `/tasks?tab=board` |
| `running late` | `counts.late` | Any active task with `dueAt < now` | `/today` |
| `to assign` | `counts.toAssign` | Active + `assignedKey: null` + `taskType in TRIAGE_TYPES`; the SQL twin of `isNeedsAssigning` in `src/lib/triage.ts` | `/queue` |

The unanswered-texts chip goes red (`var(--danger)`) and re-labels to `unanswered · oldest Nd` once
`oldestHours >= 24` (`page.tsx:131-138`). The "to assign" chip only renders when non-zero —
"routine work defaults to Kyle and isn't triage".

#### The honesty rule about the all-clear

```ts
const allClear =
  todayCount === 0 && stuck.length === 0 && shoots.today.length === 0 && unanswered.count === 0;
```

The comment at `page.tsx:71-76` explains why the fourth clause exists and cannot be dropped:
unanswered texts are counted from the comms log, so a message from someone never matched to a
client contributes **no task and no `todayCount`** — without that clause the page could tell you
you're clear while seven people wait on a reply.

All-clear renders one calm card (check mark, `N handled today`, next shoot) instead of five empty
sections. Critically, the pulse/money/dials strips are rendered **outside** the all-clear branch:
"quiet days still show whether the machine is speeding up or slipping" (`page.tsx:188-190`).

#### The rest of the page, in order

Under the CTA sits one quiet secondary link — `or walk me through it one at a time →`
(`/today?guided=1`), the same stack served one card at a time.

1. **Orientation** — `Good morning, {firstName}` + `getHandledToday()` (`queries.ts:741`; tasks
   `COMPLETED` since ET midnight — genuinely shared code, `TodayView.tsx:87` calls the same helper
   for its footer, so the two can't disagree).
2. **Stuck jobs** (`getStuckJobs`, `queries.ts:477-529` → `StuckJobs.tsx`) — **project**-level
   lateness, not overdue admin tasks. Three triggers: past `deliveryDue`; `REVISION` with
   `revisionRequestedAt` ≥ 2 days old; `SHOT`/`EDITING` shot ≥ 48h ago and `deliveredAt` null. A
   project matching several is deduped to **one row with the worst reason** so it reads as bad as
   reality. Capped at 3 rows, overflow → `/pipeline`. The rationale (`queries.ts:461-467`): the old
   "Blockers" panel listed two unsent confirmation texts while projects days past their delivery
   promise were invisible.
3. **Today's shoots + week strip** — `getShootWindow()` (`queries.ts:697`) runs off `Appointment`
   rows (not `project.shootDate`) so an order with several appointments shows every visit with its
   own photographer; it filters `status: { not: "CANCELED" }` and skips appointments on
   CANCELLED/DELIVERED projects. The window is today + the next 7 days (`week` = tomorrow onward);
   the today list renders at most **4** rows. `WeekStrip.tsx` is a JS-free `<details>`/`<summary>`
   per-day strip; an amber dot on a day means at least one visit has no photographer. It replaced a
   "Tomorrow: N" one-liner that "hid a 9-shoot week behind a single number".
4. **Radar** — `getProactiveFlags()` (`queries.ts:1046-1145`), capped at **3** flags, sorted
   high→low severity. Three rule-based sources: aged AR (client balance whose oldest delivered
   unpaid job is ≥ 30 days; `high` at ≥ 60; top 5 kept), VIP/heavy clients with no `CommLog` in
   ≥ 21 days (`high` at ≥ 45; top 4 kept — clients with *no* comms on record at all are included and
   sort first), stale revisions (≥ 2 days; `high` at ≥ 3; top 5 kept). Both AR and VIP lists sort
   **freshest risk first** — "a VIP who JUST crossed 21 days is a save; one silent for a year is a
   churn statistic".
5. **Money strip** (owner only) — `getOwnerStats()`: delivered revenue this month, pipeline value,
   plus `topAr` (largest AR balance, computed inside `getProactiveFlags` so `/billing` isn't queried
   twice).
6. **Pulse strip** (owner only) — `getOwnerPulse()` (`queries.ts:555-634`): on-time delivery %,
   median shoot→delivered hours, % of inbound texts answered inside 1h, open revisions. Trailing 30
   days with deltas vs the prior 30. The reply metric pairs each inbound text with the *next*
   outbound to the same client and counts a never-answered inbound against the percentage — but it
   only reads `CommLog` rows with a **non-null `clientId`**, so the unmatched senders the
   `texts unanswered` chip exists to catch are invisible to this number. Buckets by when the
   *inbound* arrived, "the reply may cross the boundary".
   `PulseStrip.tsx` colours the arrow by `downIsGood` per metric, never by direction — turnaround
   improving means the number goes *down*. There is deliberately **no QC pass-rate** here: "that
   metric was judged gameable and is not shipped".
7. **Quality dials** (owner only) — `getOwnerDials()`: a video-SLA roll-up ("N in editing · M past
   SLA", linking to `/editing`) plus QC stats. `QualityDials.tsx` returns `null` when there is no
   video in flight *and* `qc.qcPasses === 0`, so a fresh DB never shows a misleading 0%.

Creatives are redirected away at `page.tsx:49` (`contentTier(me.role) === "CREATIVE"` →
`homeFor(me.role)`) — middleware already bounces the roles, this covers per-user permission
overrides. A sessionless request (local dev only) renders the full owner view.

---

### My Day (`/day`)

Plain English: Jordan's private command centre. His own to-do list, an automatically planned day
built around the shoots and meetings he actually has, a way to push that plan onto Google Calendar
so Calendly stops booking over his focus time, AI recaps of his calls waiting for a yes/no, and an
assistant that can reorganise his list but can only *draft* anything aimed at Kyle.

Guarded twice: `PAGES` marks `day` as `ownerOnly`, and `src/app/day/page.tsx:82-83` redirects a
signed-in non-owner to `/`. Every server action in `src/app/day/actions.ts` calls `requireOwner()`.
The page was rebuilt for readability after Jordan's verdict — *"too much of the text looks the same
and is same color, it's just hard to read"* — producing the rules at `page.tsx:23-37`: size carries
rank, nothing below 12px, colour means something (red = late, amber = warning, brand = deep work,
accent = a real commitment), one question per block, reference material last.

#### The day has a fixed shape

`src/lib/ownerDay.ts:27-38`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `DAY_START_HOUR` / `DAY_END_HOUR` | 8 / 17 ET | The working day |
| `DEEP_UNTIL_HOUR` | 12 | Deep work may only be placed before noon |
| `TRAVEL_BUFFER_MIN` | 30 | Held either side of anything you physically drive to |
| `RECOVERY_BUFFER_MIN` | 10 | Held *after* a call, to write it up |
| `MIN_USABLE_GAP_MIN` | 20 | "A gap shorter than this is not workable time — it is a coffee" |

The design intent (`ownerDay.ts:8-23`) is to remove decisions, not add them: a fixed shape means the
plan is never a blank page; real commitments win and to-dos fill what is left, never the reverse;
travel and recovery are real time, because "slotting work into a gap that is actually a commute is
how a plan stops being trusted"; and deep work goes to the morning and only as much as actually
fits — "better to under-commit the day and finish it than to write a wish list".

#### Fixed blocks: shoots + the real calendar

`fixedBlocksFor(dayKey)` merges two sources (`ownerDay.ts:143-248`):

- **Shoots** from `Appointment`, filtered to the day and optionally scoped to one `assignedToId`;
  the `status !== "CANCELED"` filter is applied in `assemble()`, not in the query. Aryeo doesn't
  always carry an end time, so a shoot with no `endAt` is assumed **90 minutes**. Guard bounds =
  ±30 min. Note it does *not* exclude shoots on cancelled/delivered projects the way
  `getShootWindow` does.
- **Meetings** from Google Calendar (`listCalendarEvents`, `src/lib/integrations/googleCalendar.ts`),
  with three kinds of row dropped as "look like commitments but aren't": cancelled events, events the
  owner has **declined**, and events marked free/`transparency: "transparent"` (birthdays, FYI
  holds). "Blocking work around a declined meeting is how a plan quietly loses an hour a day."

Then three more filters in `assemble()`:

- `allDay` rows are context (a holiday, a trip), not hours — skipped from the timeline, surfaced
  separately as `CalendarDay.allDay`.
- `e.ours` (a block the hub itself wrote) is skipped: "counting them as fixed commitments would make
  the plan double-book itself against itself".
- **Aryeo/Google duplicate collapse**: if a calendar event overlaps a shoot by ≥ 50% of the shorter
  of the two, the Google copy is dropped — "whichever we drop, keep the Aryeo one, it carries the
  project link and the real address".

#### Buffers, including the Calendly special case

`buffersFor()` (`ownerDay.ts:112-122`), first match wins:

1. **`e.buffer === true` → 0 / 0.** Calendly writes its own padding onto the calendar as real events
   titled like `[2-hour buffer before Discovery Call event]`, matched by
   `CALENDLY_BUFFER = /^\s*\[.*\bbuffer\s+(before|after)\b.*\]\s*$/i` (`googleCalendar.ts:93`). They
   are genuinely busy time but they *are* the buffer — adding ours on top would charge it twice.
   `tidyTitle()` rewrites the bracketed title to "Buffer before Discovery Call" for the timeline.
2. **Not virtual and has a location → 30 / 30.** Somewhere to drive to; hold the drive both ends.
3. **Everything else → 0 / 10.** A call costs no drive time but a short beat after. An event with no
   location *and* no link is treated as a call — the cautious read, "since over-holding an hour a day
   for a phone call is its own kind of wrong". Virtual detection is `hangoutLink`, a Calendly buffer,
   or `VIRTUAL = /\b(meet\.google|zoom\.us|teams\.microsoft|whereby|hangout|google meet|phone|call)\b/i`
   over title + location.

#### Laying to-dos into the gaps

`buildDayPlan(dayKey)` (`ownerDay.ts:355-469`):

1. Load `OwnerTodo` rows with `status: "OPEN"` and `plannedFor === dayKey`.
2. **Pinned rows keep their time.** A to-do that already has `blockStart`/`blockEnd` on this day is
   held exactly where it was put. Without pinning "the plan would drift a few minutes each render and
   we'd be rewriting Google events all day. Pinned once, then stable — it only moves when Jordan
   moves it."
3. `openWindows()` subtracts every guard span (and every pinned block) from 08:00–17:00 and discards
   any remaining window under 20 minutes.
4. Unpinned to-dos are ordered **DEEP first**, then `NOW > NEXT > LATER`.
5. Each needs `max(estimateMin, 15)` minutes and is placed in the first window that fits before its
   limit — `deepUntil` (12:00) for DEEP, `dayEnd` for SHALLOW.
6. Anything that doesn't fit is returned as `unplaced` and shown in an amber note ("they stay on the
   list rather than being squeezed in") — never crammed in, because "a plan you cannot finish is the
   thing that stops getting opened".
7. `conflicts` reports any pinned block a real commitment has since landed on (usually a Calendly
   booking). It is reported, never silently moved: "the hub and his calendar would then disagree".

`fullyBooked` is `freeMinutes < 20`. `calendarOk` / `calendarError` carry Google's **own wording**
forward, because a missing OAuth scope and an API disabled in Cloud Console need different fixes —
`page.tsx:307-319` pattern-matches `/has not been used in project|is disabled/i` to show the Cloud
Console message instead of a "Reconnect Google" link that cannot fix it.

`calendarAhead(days = 7)` (`ownerDay.ts:270`) powers the read-only week card. It makes **one** Google
call and **one** appointment query for the whole span then buckets by ET day — "looping
`buildDayPlan` per day would be seven round trips to Google on every page load — the shape of
mistake that took `/trends` down." Days are clamped to 1–31. (`listCalendarEvents` asks for
`maxResults: 100` and does **not** page, so a very busy multi-week span could be truncated —
harmless at 7 days.)

`ownerMemberId(loginMemberId?)` decides which `TeamMember` counts as "me": the logged-in user's
`teamMemberId`, else the first active member whose `name` contains `"Jordan"`. Both the page and the
calendar actions resolve it identically so the plan on screen and the plan written to Google can't be
built from different days.

#### Writing blocks back to Google Calendar

`src/lib/integrations/googleCalendar.ts`, two rules stated at the top of the file:

1. **Writes go to the `primary` calendar on purpose** — Calendly reads that calendar to decide when
   Jordan is bookable, so a block anywhere else is decoration.
2. **We only ever touch events we created.** Every hub-written event carries a private extended
   property `rtpTodoId`. `assertOurs()` re-reads the event before every update/delete and throws
   "That event wasn't created by the hub, so it won't be changed" if the tag is absent. It costs one
   extra request per write; "the alternative is a bug class where a stale id points at a real meeting
   and we delete it." `deleteBlock` passes `missingIsFine` so deleting it by hand in Google is fine.

Blocks are written `transparency: "opaque"` (so Calendly reads busy) with
`reminders: { useDefault: false, overrides: [] }` — "focus blocks shouldn't ping".

Actions in `src/app/day/actions.ts` (every one `requireOwner()`-guarded):

- `blockDayOnCalendar(dayKey)` — idempotent. Pinned rows are skipped. A row carrying a
  `calendarEventId` but no pinned time (a crash between the Google write and the DB write) is
  **PATCHed** to the planned time rather than duplicated. A `CalendarNotConnected` aborts the whole
  run instead of hammering Google once per to-do with a token that cannot work.
- `rescheduleBlock(id, dayKey, hhmm, minutes?)` — takes an ET day plus wall-clock `"09:30"`, never an
  instant, "the browser shows Eastern regardless of where it is, so it must not be the thing that
  decides what 9:30 means". Conversion happens server-side in `etInstant()` (`ownerDay.ts:102-109`).
  Creates the Google event if the row didn't have one; length is clamped to 5–480 min and written
  back to `estimateMin`; `plannedFor` is set to the block's day so the two stay in step.
- `releaseBlock(id)` — an **internal helper** (`day/actions.ts:81`), not an exported action. Deletes
  the Google event then clears `calendarEventId`/`blockStart`/`blockEnd`. Called from
  `completeOwnerTodo` (on done), `dropOwnerTodo`, `planOwnerTodo` when the day actually changes, and
  the exported `unblockTodo(id)` ("the to-do stays; only the held time goes"). Best-effort: if
  Google is unreachable the local fields are still cleared, because "a to-do you can't complete
  because an API is down is worse than a stale event you can delete by hand". The failure that
  matters is the inverse — leaving the event behind means "Calendly would go on refusing bookings
  for work that is already done".
- `restoreOwnerTodo(id)` — undo for a mis-tapped checkbox. Deliberately does **not** restore the
  calendar block: "completing it gave that hour back, and silently re-taking time on his calendar days
  later would be a worse surprise". If the row's `plannedFor` is in the past it is cleared so the
  to-do lands in "not scheduled yet" rather than a day that is over.
- Plus the plain CRUD: `addOwnerTodo`, `updateOwnerTodo`, `completeOwnerTodo(id, done = true)`
  (which doubles as un-complete), `dropOwnerTodo`, `planOwnerTodo(id, dayKey | null)`, and
  `searchProjectsForTodo(q)` behind the quick-add box's job picker.

#### The lists either side of the plan

`ownerTodoLists()` (`ownerDay.ts:500-535`) returns `open` / `overdue` / `today` / `unscheduled` /
`later` / `finished` / `doneToday`. Finished reaches back `HISTORY_DAYS = 60` and includes **both**
`DONE` and `DROPPED` — "both are reversible decisions, and 'not doing this' gets mis-tapped exactly
as often as 'done'". A still-open to-do whose `plannedFor` is in the past rolls back into
`unscheduled`: "without this it belonged to no list at all and vanished off the page while still
open, which is exactly what happens to a restored to-do."

`OwnerTodo` (`prisma/schema.prisma`) carries `priority` (NOW/NEXT/LATER — "three buckets on purpose:
a long flat list is the thing that stops getting looked at"), `energy` (DEEP/SHALLOW), `estimateMin`,
and optional links to a `Project`, a `Client`, a `commLogId`, a `gmailThreadId` and a free-text
`sourceNote`. The comms links are stored as plain ids "rather than a `source` string so no sweep can
pattern-match them". `addOwnerTodo` sets `plannedFor = today` automatically when `priority === "NOW"`
— "NOW means today by definition — no second decision about when" — and due dates land at **5pm ET**
via `etEndOfDay()`.

#### Meeting recaps (Google Meet / Gemini notes → review cards)

`src/lib/meetings.ts`. Jordan's shape, quoted verbatim in the file: *"it should land in a review list
and tap to accept… it should all be one task with multiple tasks in it… give a detailed summary of
the call, action items, and a deadline."*

- `scanMeetTranscripts()` lists Drive docs for the **current ET month** (`etAt(month-01, 0)` —
  anchoring at UTC midnight "would start the window at 8pm ET on the last day of the previous month
  and sweep in a call that belongs to it").
- `listMeetTranscripts()` (`src/lib/integrations/googleDrive.ts`) narrows a broad `drive.readonly`
  grant *in the query*: Google Docs only, `'me' in owners`, not trashed, name contains
  `Notes by Gemini` / `Transcript` / `transcript`. It matches Gemini notes as well as raw transcripts
  because "his Drive holds no file named 'Transcript' at all, so a transcript-only filter finds
  nothing".
- **`heldAtFromTitle()`** parses `2026/08/03 15:57 EDT` out of the filename, because Drive's
  `createdTime` is when the *notes were finalised* — on Jordan's files ~90 minutes late, "which would
  file a 4pm call under 5:25pm and land every deadline a day out". Only `EDT`/`EST` are honoured;
  anything else falls back rather than guessing an offset. The date window is applied to the parsed
  meeting time, with the Drive query padded ±2 days.
- Each transcript is trimmed to 60,000 chars and sent to `aiJson` with a schema producing
  `summary` (150–350 words markdown), `actionItems[]` and `draftEmail`. The system prompt restricts
  action items to *things Jordan himself committed to*, forbids inventing deadlines (default 7 days),
  forbids guessing anyone's gender, forbids estimating money, and explicitly asks for an empty array
  when the call was small talk — "an honest empty list is more useful than a padded one". The draft
  email is a starting point: "never imply it has been sent."
- Transcripts under 400 characters are skipped ("a meeting nobody spoke in"). One unreadable meeting
  is caught and counted as `failed` so it can't stop the rest of the month importing. Each run
  processes at most **25** new files (`opts.limit ?? 25`); the rest are reported as `skipped`.
  `meetingsForReview(limit = 10)` is what the page renders (status `REVIEW`, newest `heldAt` first).
- `OwnerMeeting.sourceId` is `@unique` on the Drive file id, so re-running the scan can never
  duplicate a meeting.
- **Nothing is created until Accept.** `acceptMeeting(id, skip[])` mints the un-skipped proposals as
  `OwnerTodo` rows with `meetingId` set. Deadlines are counted from `meeting.heldAt`, not review time
  — "a week is a week from the promise" — and land at 5pm ET via `etEndOfDay(etDayKey(...))`.
  `dismissMeeting` sets `DISMISSED` (the recap stays readable). `addMeetingItem` lets him add one by
  hand before accepting.

#### The day assistant, and the DRAFT-ONLY Kyle tools

`src/lib/dayTools.ts` — the whole tool set is shaped by one rule (`dayTools.ts:9-21`): it may do what
it likes to Jordan's own list, and it may not touch anyone else without him pressing a button.

| Tool | Effect |
| --- | --- |
| `my_day`, `my_todos`, `week_ahead`, `business_snapshot` | Read-only |
| `add_todo`, `update_todo`, `complete_todo` | **Write** — directly to `OwnerTodo` |
| `find_job` | Read-only project search |
| `draft_slack_to_kyle` | **Creates nothing.** Returns `{ staged: true, note: "Nothing sent. Jordan now has a Send button…", text }` |
| `draft_task_for_kyle` | **Creates nothing.** Returns `{ staged: true, note: "Nothing created…", title }` |

There is no tool that can reach a client, "by any route, deliberately."

`proposalsFrom(toolsUsed)` reads the *tool inputs the model actually supplied* and turns them into
`DayProposal` objects, which `DayAssistant.tsx` renders as editable cards with Send / Add-to-queue
and Discard buttons. Only that click fires `sendSlackToKyle()` (→ `opsAlert()`) or
`createTaskForKyle()` (→ an `internal_instruction` `SmartTask` owned by the first active `TeamMember`
whose name contains "Kyle", plus a best-effort Slack ping — "the task is what matters").

`daySystem(now)` is **built per request, not held as a constant**, and stamps the current ET moment
into the prompt. The reason (`dayTools.ts:373-380`): "the model has no clock: asked to message Kyle
about 'Friday', it guessed the date was four days off and named the wrong shoot." It is also told to
say which date it landed on, "so a wrong guess is visible rather than silent." Other prompt rules:
answer from tools not guesses; be short (two or three sentences); give ONE recommendation not a menu
of five; say what you'd drop; never claim a Kyle message was sent; never guess anyone's gender; quote
only figures the tools return; say plainly when a tool errors rather than filling the gap.

Loop limits (`askMyDay`): last 8 turns of history, question clipped to 4,000 chars, `maxSteps: 8`,
`maxTokens: 1600`.

`find_job` searches `city` separately from `addressLine` because "Aryeo stores '1033 Preserve Ln' and
'West Chester' in different columns, so a street-only search finds nothing for a town name — which is
exactly how Jordan refers to a shoot out loud."

#### `ownerPulse.ts` — the money snapshot on My Day

`src/lib/ownerPulse.ts` feeds the "Where the business is" block at the bottom of `/day` and the
`business_snapshot` tool. Its constraint is stated at the top of the file and is a hard rule:

> EVERY figure here is a cheap indexed read. Nothing in this file may reach `computePayroll` (which
> resolves mileage over the public OSRM router) or make an external HTTP call — that combination
> already took `/trends` down in production with a 60-second timeout.

So: no `getMonthlyPnl`, no `getCashPosition`, no `jobProfitability`, no live Stripe balance. The bank
figure is read straight off stored `PlaidAccount` rows (`isBusiness: true`, `type: "depository"`), and
`bankLabel` names the accounts because "today that is a single overdrawn payroll account — a bare 'in
the bank' figure would read as ALL the cash and quietly be wrong". Profit is computed exactly the way
Finance → Overview computes it (`revenueByProcessor` minus `categoryBreakdown().businessTotal`) "so
the two screens can never quote different numbers at each other". Every query is individually
`.catch()`-ed so one dead integration degrades a stat rather than the page.

---

### Trends (`/trends`)

Plain English: leading indicators. How many orders came in *this week* compared with last, what
people are buying, which packages actually carry the money, and which regulars have quietly stopped
booking.

#### Everything keys on `orderedAt`, never `shootDate`

`src/lib/trends.ts:8-21`:

> EVERYTHING here keys on `Project.orderedAt` (the real Aryeo order date), never `createdAt` (import
> time) and never `shootDate`. "How busy are we?" answered by shoot dates tells you about work
> already won; answered by ORDER dates it tells you what is coming — which is what the owner actually
> feels first when things slow down. Coverage is 100% (1,467/1,467 projects carry `orderedAt`), so no
> fallback is needed.

Cancelled orders **stay counted** as bookings ("the order WAS placed, and hiding cancellations would
flatter a bad month") and are reported separately per window as `cancelled`.

`bookingTrends()` pulls 800 days of rows once and derives everything in memory:

- Four windows — `today`, `7d`, `30d`, `365d` — each with prior-period and year-ago comparisons.
  YoY is only computed for windows ≥ 7 days: "year-over-year on a SINGLE day is noise".
- `daily` = last 90 ET days, zero-filled "so gaps read as real zeros". `monthly` = last 24 ET months.
- `leadTimeDays` = median/p75/p90 of `orderedAt → shootDate` over the last 180 days.
- `busiestDow` over 365 days, derived from the **ET day key** rather than a locale-parsed `Date`,
  "which would be read in the server's own timezone".
- `avgPerWeek` over 4 / 12 / 52 whole weeks ending today.
- `projection`: MTD run-rate, plus the honest comparison shipped alongside it — MTD vs the **same
  point** in the previous month (`lastMonthSamePoint`, day count clamped to the shorter month),
  because "a run rate early in a month is jumpy". The page says so out loud at `page.tsx:193-197`.
  Also carries `yoyMonthCount` (the same calendar month a year ago, full) when it's inside the
  800-day pull.

Performance note worth keeping (`trends.ts:141-145`, and the same lesson recorded at
`trends.ts:24-30` about the hand-rolled ET helper): ET day keys for all rows are bucketed **once**
up front. The daily loop used to re-derive the key for ~1,300 rows on each of 90 days — 115,000
`Intl` calls — and that alone was ~2.9 of the 3 seconds the function took, against a 0.11s query.

#### Services vs packages, and how revenue is attributed

`serviceTrends()` returns two parallel views:

- **`services`** — keyed on the `DeliverableType` enum. Order value is split evenly across the
  distinct services on an order. Explicitly an approximation, "good for ranking, not for accounting".
- **`packages`** — keyed on the product name the client actually bought. The enum is deliberately
  *not* used here because it "collapses 'Premium Social Reel' and 'Social Reel' into one line, hiding
  that they are different products at different prices".

Package revenue has two paths:

1. **Exact** — `packagesFromOrderItems()` reads real Aryeo `OrderItem` rows (`isCanceled: false`),
   grouping titles through `canonicalPackage()` because "one product, many hand-typed spellings —
   group on the canonical name or the monthly-session products fragment into six near-identical
   rows". Gated on **coverage ≥ 0.9** of YTD orders having order items: "a half-finished backfill
   would otherwise report real-looking revenue that is quietly missing half the orders — worse than
   an honest estimate." (The fallback also fires if the line-item path returns zero rows.)
2. **Estimated fallback** — `learnPackagePrices()` learns each package's standalone price from orders
   where it was the *only* package bought (needs ≥ 3 observations, takes the median; 287 such orders
   since 2025 per the comment — Photos $250, Premium Social Reel $1,000, Social Reel $450), then
   splits multi-package orders in proportion to those learned prices. Packages never sold alone get
   the median learned price and are marked `~` in the UI. The comment explains why even splitting is
   wrong: "a $50 'Travel' fee would book the same revenue as $250 of Photos on the same order."

`exactRevenue` drives the label on the card (`from Aryeo line items` vs `estimated`). Packages with
fewer than 2 orders are moved into `packageTail` and reported as a count.

**Margin by package** (`MarginByPackage`, `src/lib/packageMargin.ts`) is a *precomputed row read*.
Costing the year runs the payroll engine, which resolves mileage over the public OSRM router — "that
took a 60-second serverless function down in production while running in 3s locally". It is rebuilt
nightly by the `packageMargins` cron step; the component streams inside `<Suspense>` and `/trends`
sets `maxDuration = 60` so the request isn't killed mid-stream. Note the axis mismatch, which the UI
states rather than hides: margin windows on **shootDate**, revenue-by-package counts by **orderedAt**.

#### Going quiet — the most actionable card on the page

`topSpenders()` builds a `SpenderRow` per client, then `summarizeQuiet()` filters it. Three
non-obvious decisions, each with the bug that produced it:

1. **Booking *events*, not orders.** Order dates are collapsed to one event per ET day before gaps
   are measured. "Agents list several properties in one sitting, so a single phone call can produce
   three orders seconds apart… 14% of all gaps in this book are under a day, and 40% of repeat
   clients have at least one same-day pair."
2. **`overdue` is relative, with a floor.** `daysSince > Math.max(medianGap * 2, 14)` — double the
   client's *own* rhythm, and only for clients with YTD spend. "A client who books weekly and hasn't
   in a month matters more than a once-a-quarter client who is 3 weeks out." The 14-day floor exists
   because "without it, a client up 66% on the quarter was being flagged." (The `SpenderRow` type
   comment at `trends.ts:542` still says "past 1.5x their own normal booking gap" — stale; the
   implementation is 2×.)
3. **The quiet set needs ≥ 3 lifetime orders and ≥ 1 YTD order.** "A single order is not a rhythm…
   without that floor a first-time buyer trips the flag two weeks later and inflates the total."

`annualValue` is **measured money**: `trailing365Revenue × 365 / clamp(tenureDays, 90, 365)`. The long
comment at `trends.ts:568-588` records the failure it replaced — an earlier version projected
`(365 ÷ median gap) × average ticket` and "came out ~2.2× what those same clients had actually paid in
a year. A projection that exceeds every dollar the client has ever spent is not a projection." The
clamp refuses to multiply a three-week-old account up by 12, and never scales a >1-year client *down*.

The quiet set is computed over **every** client, not the top-20 slice the table shows, "otherwise the
money attached to it silently misses every mid-size regular". Clients on a QuickBooks retainer get a
`+ retainer` chip on the top-spenders table (`recurringRevenue().clientIds`) so their Aryeo total
isn't read as their whole value.

#### The growth plan and the growth advisor (owner-only inside an admin-visible page)

`/trends` itself is admin-visible (`ROLE_PAGES.ADMIN` includes `trends`), but `page.tsx:56` computes
`isOwner` and gates three things behind it: the growth plan card, the margin-by-package section, and
the advisor — "they quote margins, which means real payroll and editor costs".

`src/lib/growthPlan.ts` builds one structured plan (`headline`, `aovMoves`, `newPackages`,
`promotions`, `focus`, `fix`) from a `growthSnapshot()` that folds together booking pace, package mix,
per-package margin, quiet clients, AOV by month, and the recurring-revenue rail.

- **Cache key = business shape only.** `snapKey()` hashes packages/bookings/MTD/AOV/margins/top
  clients/quiet clients — deliberately *not* the whole snapshot, because the snapshot carries the
  calendar (today's date, days-since-last-order, MTD projection) which "tick over at midnight whether
  or not anything happened. Hashing those meant the key changed every single night, so the plan was
  rebuilt (and paid for) daily even on a day with no orders, and the 'stale' flag could never fire."
- `maxTokens: 8000`, and the reason is spelled out: "the fields are emitted in schema order, so a
  ceiling hit silently truncates the LAST sections. At 4k the focus and fix lists came back empty
  every time."
- `getGrowthPlan()` is read-only and never calls the model; `stale` = `builtAt` older than 8 days.
  On a rebuild failure the last good plan is kept: "keep showing the last good plan rather than an
  empty card."
- `normalize()` coerces every list field to a real array, because "a schema-forced tool call still
  occasionally drops an optional-looking array or hands back a single object where a list was asked
  for".
- Rebuilt nightly by the `growthPlan` cron step; `refreshGrowthPlanAction()` (owner-only) forces it.

The prompt carries a **KNOWN AND ALREADY EXPLAINED** block so the model doesn't waste
recommendations: $0 Aryeo retainer-session orders are intentional (the client already pays a monthly
QuickBooks invoice), null-margin packages are outside-vendor billed, Jordan's own shoots carry no
shoot pay, every revenue figure is Aryeo-only, and `photoEditingCostKnownPct` below 100 means
photo-package margins are an upper bound. `margins.basis` is only reported as `"exact"` when **both**
job coverage ≥ 0.9 **and** `photoCostKnown` ≥ 0.9 — judging on job coverage alone "told the model the
margins were exact while the AutoHDR bill was silently booked as $0 on most jobs".

`askTrendsAdvisor()` (`src/app/trends/advisorActions.ts`) is a `requireOwner()`-guarded agent loop
over `TRENDS_TOOLS` (`current_datetime`, `booking_pace`, `package_mix`, `package_margins`,
`top_clients`, `quiet_clients`, `recurring_revenue`, `client_history`, `package_buyers`), all reading
the same engines the page renders "so the advisor and the page can never quote different numbers at
each other". `maxSteps: 12`, `maxTokens: 8000`. Boundary, stated in the prompt: **read-only** — "you
never message a client, change a price, or send anything". Both the plan prompt and the advisor
prompt carry the same explicit instruction never to guess a client's gender from their name, because
"a wrong guess misgenders a real customer in Jordan's own tool".

---

### Clients: the 6-tier segment model and the working profile

Plain English: every client name in the hub carries a chip saying how big a customer they are, and
each client page carries an AI-written "who is this person to work with" card that photographers and
editors can safely read.

#### The segment model

`src/lib/segments.ts` mirrors the HubSpot segment model Jordan runs in the marketing project, "so the
same label shows up everywhere a client name does". Two inputs: lifetime spend (dollars, from
non-cancelled orders) and transaction count. **First match wins** — identical order and thresholds to
`SEGMENT_FOR` in the marketing project's `sync-segments.js`:

| Key | Chip | Test | Colour | Blurb |
| --- | --- | --- | --- | --- |
| `never_converted` | New | `txns <= 0` | `PALETTE.gray` | No completed orders yet — a lead or first booking in flight |
| `one_timer` | One-Timer | `txns === 1` | `PALETTE.blue` | One completed order. Win the second to start a habit |
| `casual_repeat` | Casual | spend < $1,500 | `PALETTE.teal` | Repeat client, under $1.5k lifetime. Room to add video |
| `regular` | Regular | spend < $5,000 | `PALETTE.indigo` | Steady repeat client, $1.5k–$5k |
| `heavy` | Heavy | spend < $20,000 | `PALETTE.violet` | Top customer, $5k–$20k |
| `vip` | VIP | ≥ $20,000 | `PALETTE.gold` | Biggest accounts — handle personally |

`segmentFromOrders()` filters `status !== "CANCELLED"` and sums `Project.price` (dollars), returning
`{ key, spendCents, txns }`. `syncClientSegments()` (`src/lib/segmentSync.ts`) recomputes every
client and writes only those whose `segment` / `lifetimeSpendCents` / `transactionCount` actually
changed, stamping `segmentUpdatedAt`. It runs as the `segments` step of the daily cron
(`src/app/api/cron/daily/route.ts:76`) and again from three branches of the Aryeo webhook
(`src/app/api/webhooks/aryeo/route.ts:188,241,263`), each wrapped in a non-fatal try/catch.

`SegmentBadge` (`src/components/clients/SegmentBadge.tsx`) renders the compact `short` label by
default and the full `label` with `title`; it returns `null` for an unscored client. `/clients`
groups the whole book by segment in high→low order (`SEGMENT_ORDER`,
`src/app/clients/page.tsx:15`) "so the most important customers sit at the top" — note it buckets a
`null` segment into `never_converted`, so an unscored client sits under the "Never Converted"
heading while its own row shows no chip. Segments also drive the VIP-quiet radar flag on the
dashboard (`segment in ["vip","heavy"]`).

#### The AI working profile

`src/lib/clientProfile.ts` — "a creative-safe synthesis of who a client is to work with, drawn from
comms, creatives' shoot debriefs, revision history, feedback, and the manual notes on file".

Inputs per build: last 40 `CommLog` rows, last 30 `Activity` rows of type `NOTE`/`FLAG`/
`SPECIAL_REQUEST` on that client's projects, last 12 `Feedback` rows, a count of `revision` SmartTasks,
a count of inbound comms, up to 8 recent order titles, and the manual `clientPreferences` /
`editingPreferences` / `generalNotes` / `brandColors` fields. The project pull is capped at the 40
most recent orders, so `stats.totalOrders` is "non-cancelled among the last 40", not a lifetime
count — it can under-report a long-standing client.

**The safety boundary is a query filter, not a prompt instruction:** `COMM_ROLES = ["CREATIVE",
"ADMIN"]` — owner-tier comms are never read into the profile. The prompt
(`synthesizeClientProfile`, `src/lib/integrations/ai.ts:732-759`) additionally forbids pricing, fees,
payments, balances, internal finances, margins, business strategy, and anything unkind or gossipy,
and requires every statement be grounded in the supplied data ("Empty arrays and short strings are
fine when the signal is thin").

Output shape: `summary`, `touchLevel` (high/medium/low), `workingStyle`, `communication`,
`revisions.{summary, commonTypes[]}`, `brandStyle`, `shootNotes[]`, `aboutThem[]`, `dos[]`, `donts[]`,
plus a `stats` block (`totalOrders`, `revisions`, `inboundMsgs`). Stored on `Client` as
`profileSummary` + `profileJson` + `profileUpdatedAt`; rendered by
`src/components/clients/ClientProfileCard.tsx` with a Regenerate button
(`regenerateClientProfile`, `src/app/clients/actions.ts:13`, `requireAdmin()`).

`refreshStaleClientProfiles(limit = 20)` runs as the `clientProfiles` cron step: `parentClientId:
null` (agents, not folded assistants), `transactionCount > 0`, profile missing or older than 10 days,
oldest first, capped at `min(limit, 60)` "to keep AI cost predictable". A single failure is swallowed
so the batch continues.

---

### Usage tracking — People → Activity

Plain English: an owner-only view of who has actually opened the hub, how often, and which pages they
use. It exists so Jordan can tell whether the platform is being used, not just built.

**Collection** — `src/components/Shell.tsx:32-43` posts `{ path: pathname }` to `/api/activity` on
every in-app navigation (`keepalive: true`, errors swallowed: "tracking must never break
navigation"). `/api/activity` is in `PUBLIC_PREFIXES` in middleware because it self-authenticates,
"and gating it here would 307 stale-cookie beacons into pointless `/login` renders on every
navigation".

`src/app/api/activity/route.ts` hardening, all four verified in code:

| Guard | Value | Reason in code |
| --- | --- | --- |
| Identity from session only | `getCurrentUser()`; 204 on no session | "nothing identity-shaped is trusted from the body" |
| **"View as" excluded** | `user.impersonating` → 204 | "recording them under the previewed person would fake their activity" |
| Path allowlist | `isTrackablePath()` (`src/lib/usage.ts:37-43`) | An arbitrary client string "would let a user paint whatever they want into the owner's trail (and grow the table unboundedly)" |
| Flood cap | 120 events / user / hour → 204 | "a human doesn't navigate 120+ times an hour; a script might" |
| Atomic dedupe | row id = `sha1(userId|path|floor(now/20s))[:25]` | Double-fires (React strict mode, two racing tabs) "collapse on the unique id instead of racing past a check-then-create" |

`isTrackablePath` accepts `/`, nine detail-route regexes (`/shoot/[id]`, `/projects/[id]`,
`/edit/[id]`, `/review/[id]`, `/upload/[id]`, `/clients/…`, `/training/…`, `/resources/…`,
`/shoot/feedback`), a list of redirect stubs (`/today`, `/queue`, `/history`, `/texts`, `/team`,
`/map`, `/billing`, `/payouts`, `/my-pay`), and any nav `PAGES` href.

**Read** — `getUsageOverview(windowDays = 14)` (`src/lib/usage.ts`). Counts come from SQL
`groupBy` aggregation, never from a capped slice: "so a heavy week can't silently zero out someone's
real activity (adversarial-review finding)". `activeDays` is a raw query that marks the naive
timestamp UTC *before* converting: `DATE(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE
'America/New_York')` — "or Postgres would read the UTC digits as NY time". Retention is 90 days,
pruned lazily on read ("owner opens this tab rarely; volume tiny"). The feed is the newest 60 events;
each user gets their top 3 pages by friendly label via `pageLabel()`.

`ActivityTab` (`src/components/people/ActivityTab.tsx`) renders two sections — per-person cards (last seen, last page, today / window / days-in
counts) and the raw recent trail — plus a footer stating the privacy contract out loud: *"Counts are
page visits. Your 'view as' previews are never recorded — not for you, not for them."* Users with no
events are listed separately with `invited — never logged in` / `never logged in` / `no visits in
14d — last login …`.

**Gating** — `/users` is the merged People hub. `src/app/users/page.tsx` computes
`isOwner = me ? me.role === "OWNER" : !authEnforced()` and offers `["team","logins","activity"]` to
the owner, `["team"]` otherwise; a non-owner deep-linking `?tab=activity` is redirected to
`?tab=team`. The null-user branch is deliberate: "in prod a null user is unauthenticated OR a
revoked/disabled account with a live JWT — neither may reach the owner-only Logins allowlist."

---

### `/history` — a redirect stub

`src/app/history/page.tsx` is 16 lines: it forwards to `/tasks?tab=done`, preserving any other query
params. Task History became the Tasks hub's Done tab (Jordan: *"today, daily tasks, and task history
could all be combined"*). The route survives only so old links keep working. The AI day recap it used
to host is still live — `summarizeDay()` in `src/app/history/actions.ts` (guarded `requireAdmin()`
because "it costs an AI call") is called by `src/components/history/DayRecap.tsx`, which is rendered
from `src/components/tasks/DoneView.tsx:118`.

---

### The ET-everywhere date rule

The business runs on US Eastern; Vercel runs in UTC. `src/lib/datetime.ts` is the single enforcement
point — every display helper goes through `Intl.DateTimeFormat` with `timeZone: "America/New_York"`,
because `date-fns format()` "would show UTC times — e.g. a 1pm EDT shoot as '5:00 PM'".

| Helper | Use |
| --- | --- |
| `etDayKey(d)` | `"YYYY-MM-DD"` ET key for bucketing/comparison (via `en-CA` locale) |
| `etDayStartUtc(d)` | ET midnight as a UTC `Date`, for DB range queries |
| `etAt(dayKey, hour, minute)` | A wall-clock ET time as a real instant |
| `etEndOfDay(dayKey)` | 5pm ET — the default for a due date with no time |
| `etDate` / `etTime` / `etDateTime` / `etFullDate` / … | Display |

`etDayStartUtc` **refines its offset twice** (`datetime.ts:41-49`): it guesses midnight, then
re-samples the offset *at the guess*. "DST flips at 2am, never midnight, so the offset AT the guessed
midnight is always the right one. Sampling only at `d` was an hour off whenever `d` sat on the other
side of a transition." `etAt` anchors at noon UTC for the same reason.

Owner surfaces that enforce it explicitly:

- Both the dashboard and Trends carry `eyebrow="Eastern time"` on their `PageHeader`.
- `trends.ts:26-31` replaced a hand-rolled ET helper: "A hand-rolled version here was
  machine-timezone-dependent and gave different window boundaries locally than on Vercel."
- `getShootWindow`, `getHandledToday`, `getOwnerStats` and `getTodayCardCount` all bound on
  `etDayStartUtc`.
- `addOwnerTodo` / `dayTools.add_todo` / `acceptMeeting` all land due dates on `etEndOfDay` — "a bare
  `…T17:00:00Z` would be 1pm ET in summer and noon in winter — the day still lands right, but the time
  on the card lies."
- `rescheduleBlock` takes `(dayKey, "09:30")` and converts server-side, never trusting the browser.
- `scanMeetTranscripts` anchors its month window with `etAt(…-01, 0)`.
- The usage `activeDays` query converts inside Postgres.

---

### Gotchas / known state

- **Google Calendar and Drive scopes are declared but not granted — calendar blocking and Meet
  ingestion are DORMANT.** `src/lib/integrations/google.ts:15-21` says it plainly: `gmail.send`,
  `calendar.events` and `drive.readonly` "have been declared here for a while but … the live tokens
  carry only `gmail.readonly` + `userinfo.email`". Until Jordan re-consents (`prompt=consent` in
  `googleAuthorizeUrl`), `/day` renders the amber "Google Calendar isn't readable — this plan is
  shoots only" state, `BlockDayButton` never appears (it needs `plan.calendarOk && unblocked > 0`),
  the week calendar card is hidden (`week?.calendarOk`), and `scanMeetings()` returns the
  `DriveNotConnected` message. `googleScopeHealth()` exists to report exactly which of the three a
  stored token carries. One reconnect turns on all three at once.
- **In that dormant state the Scan button is itself hidden.** The "From your calls" block only
  renders when `meetings.length > 0 || plan.calendarOk` (`day/page.tsx:325`), and
  `ScanMeetingsButton` lives inside it. With Google unconsented and no `OwnerMeeting` rows yet there
  is no visible way to trigger a scan — a chicken-and-egg that only clears on the reconnect.
- **`scanMeetTranscripts` has no cron.** `src/lib/meetings.ts:18-19` says it is "safe to run on a cron
  and safe to run by hand", but the only caller is the manual `ScanMeetingsButton` on `/day`
  (`scanMeetings()` in `src/app/day/actions.ts`). `src/app/api/cron/daily/route.ts` has no meetings
  step. Recaps only appear when Jordan presses the button.
- **Two different things are called "owner pulse".** `getOwnerPulse()` in `src/lib/queries.ts:555` is
  operational health (on-time %, turnaround, replies <1h, revisions) and feeds the dashboard strip.
  `ownerPulse()` in `src/lib/ownerPulse.ts:43` is a money snapshot (revenue, spend, profit, bank, AR)
  and feeds `/day` and the assistant's `business_snapshot`. Same name, different modules, no shared
  code. Easy to grab the wrong one.
- **`ownerPulse()` breaks the ET rule in two places.** `ownerPulse.ts:49-51` builds `weekStart` with
  `setUTCHours(0,0,0,0)`, so "Shoots this week" is a 7-day window starting 8pm ET the previous
  evening, in a file that otherwise uses `etDayKey`. `ownerPulse.ts:73` counts `deliveredThisMonth`
  from `new Date(\`${monthStartKey}T00:00:00Z\`)` — 8pm ET on the last day of the *previous* month —
  while `getOwnerStats()` uses `etDayStartUtc` for the same boundary. The two screens can disagree by
  one job at a month edge.
- **`ownerPulse()`'s shoot count doesn't exclude cancelled appointments.** `prisma.appointment.count`
  at `ownerPulse.ts:71` has no `status` filter, unlike `getShootWindow` (`status: { not: "CANCELED" }`)
  and `assemble()` in `ownerDay.ts`.
- **Dashboard money vs Trends money use different fields.** `getOwnerStats()` sums
  `Project.price`; every figure in `src/lib/trends.ts` uses `payableInvoice ?? price`. The same job can
  be worth two different amounts on the two screens.
- **YTD boundaries in Trends are server-local, not ET.** `new Date(new Date().getFullYear(), 0, 1)`
  appears in `trends.ts:393` (`serviceTrends`), `trends.ts:599` (`topSpenders`) and `growthPlan.ts:44`.
  On Vercel (UTC) that is Dec 31, 7pm ET — orders placed in that window fall into the wrong year.
- **The dashboard's `/today` count is a *copy* of the Today feed's query, and the comment naming the
  original is stale.** `queries.ts:422-429` admits the duplication ("It replicates `/today`'s stack
  query EXACTLY … Kept here so `/today` can adopt this helper later and the two numbers can never
  drift"), but it points at `src/app/today/page.tsx`, which is now only a 16-line redirect stub. The
  real feed is `src/components/tasks/TodayView.tsx`, which has since factored its own
  `stackWhere()` + `todayCardCount()` (`TodayView.tsx:25,52`) — so there are now **three** copies of
  the same predicate and the dashboard uses none of the shared one. The two currently agree
  (identical status list, identical `CHECK_TYPES` carve-out of `delivery_text`, identical texts
  rollup), but nothing enforces it.
- **The dashboard always says "Good morning".** `page.tsx:89` has no time-of-day branch.
- **"Me" and "Kyle" are resolved by name substring.** `ownerMemberId()` falls back to the first active
  `TeamMember` whose `name` contains `"Jordan"` (`ownerDay.ts:481-484`); `createTaskForKyle()` looks up
  `name: { contains: "Kyle" }` and silently creates the task with `ownerId: null` if no match
  (`day/actions.ts:438-458`). A rename or a second Jordan/Kyle breaks both quietly.
- **`/clients` and `/clients/[id]` have no in-page auth guard.** Unlike `/trends`, `/day` and `/users`,
  neither page calls `getCurrentUser()` or `canAccess()`; both rely entirely on middleware, which does
  cover them (`pathKey` matches `/clients/<id>` via the `startsWith(href + "/")` branch). That is
  consistent with `PAGES` — clients is admin-visible — but there is no second line of defence in the
  page itself, and no owner/admin split on the page's contents the way `/users` and `/trends` have.
- **Segments and quiet-client value are Aryeo-only.** `segmentFromOrders` sums `Project.price`, and
  `src/lib/recurring.ts` documents that monthly retainers ($1,099–$2,500/mo) are billed in QuickBooks
  and appear in **no** Aryeo figure. A retainer client's segment chip therefore understates them. The
  Trends top-spenders table compensates with a `+ retainer` chip; `/clients` does not.
- **Package revenue silently changes basis.** If `OrderItem` coverage of YTD orders drops below 90%,
  `serviceTrends` falls back to the learned-price estimate. The card's `action` label
  (`from Aryeo line items` / `estimated`) is the only signal, and the `~` marker only appears on the
  estimated path for packages never sold standalone.
- **`ProactiveFlags` swallows every error.** All three branches in `getProactiveFlags` are wrapped in
  bare `catch { /* non-fatal */ }`. A broken `getBillingRows()` makes the AR flags and `topAr` silently
  vanish from the dashboard rather than erroring.
- **`getUsageOverview` does an N+1 for last-page.** One `findFirst` per user with activity
  (`usage.ts:150-160`), acknowledged in the comment as acceptable because "this team is single-digit
  sized". It scales linearly with account count.
- **`syncClientSegments` writes one row at a time** in a `for` loop over every client
  (`segmentSync.ts:20-39`) — fine at current volume, but it runs on three Aryeo webhook branches as
  well as nightly.
- **The `MarginByPackage` card is empty until the cron has run at least once.** `getPackageMargins()`
  returning null renders "not built yet … The first figures land with tonight's run."
- **`ownerTodoLists()` silently caps at 200 rows** for both the open list and the 60-day finished
  list (`ownerDay.ts:507,519`). Not a problem at current volume, but "open" is not guaranteed
  complete and nothing in the UI says so.
- **`OwnerTodo.priority` is settable but invisible after capture.** `QuickAdd` offers NOW/NEXT/LATER
  chips, and `TodoRow` takes `priority` in its props type but never renders it — there is no NOW
  section and no priority badge anywhere on `/day`. The value only affects auto-planning
  (`priority === "NOW"` ⇒ `plannedFor = today`) and the tie-break order inside `buildDayPlan`.

## 11. Automation: crons, webhooks, alerts

This is everything the hub does while nobody is looking. Three scheduled jobs keep the
data fresh (orders, shoots, email, books), five webhook receivers catch things the
moment they happen (a text arrives, an order is paid, an editor marks a cut ready),
and a notification layer decides who — if anyone — actually gets interrupted. The
governing rule across all of it: **nothing in this layer ever texts or emails a
client.** Automated outbound goes only to Slack and to phone numbers that came off a
`TeamMember` row (photographers via `smsPhotographer`, named staff via
`notifyStaffSms`, Manila editors via `channelForEditor`).

---

### 1. The cron layer

Jordan's plain-English version: three alarm clocks. One every 5 minutes for
communications, one every hour for jobs and shoots, one every night for the heavy
book-keeping and clean-up. If one of them breaks, it writes down what broke and
Slacks once — not once per tick.

#### Schedules (`vercel.json`)

```json
{ "crons": [
  { "path": "/api/cron/gmail", "schedule": "*/5 * * * *" },
  { "path": "/api/cron/sync",  "schedule": "0 * * * *" },
  { "path": "/api/cron/daily", "schedule": "0 8 * * *" }
] }
```

`/api/cron/relabel-deliverables` exists as a route but is **not** in `vercel.json` —
its own header comment says "Manual maintenance trigger (NOT scheduled)".

| Cron | Schedule (Vercel = UTC) | `maxDuration` | Step budget | `CronRun.job` | Net effect |
|---|---|---|---|---|---|
| `/api/cron/gmail` | `*/5 * * * *` | 120 s | 100 s | `gmail` | Gmail inbox → tasks/leads/comms; closes answered OpenPhone reply tasks; Slack comms memory; reply-SLA escalation |
| `/api/cron/sync` | `0 * * * *` (hourly) | 300 s | 250 s | `sync` | Aryeo orders + recent/future appointments; project status re-evaluation; per-job task reconcile; undelivered-photos watchdog; webhook retry; Frame.io project auto-create |
| `/api/cron/daily` | `0 8 * * *` (08:00 UTC ≈ 04:00 ET EDT) | 300 s | 250 s | `daily` | Stripe + QuickBooks + Plaid money sync and classification; photo counts; full client/segment/appointment/order reconcile; stale-task sweeps; 30/90-day log trims; AI client profiles, shoot-focus summaries, package margins, growth plan |
| `/api/cron/relabel-deliverables` | **unscheduled** — manual GET | 300 s | none (bare try/catch) | — | Re-derives premium deliverable labels from live Aryeo order items |

#### Auth: fail-closed

All four routes carry the identical gate (`src/app/api/cron/daily/route.ts:19-27`, and
byte-identical in `sync`, `gmail`, `relabel-deliverables`):

```ts
const secret = process.env.CRON_SECRET;
const enforced = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
if (!secret && enforced) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 401 });
if (secret) { /* require `Authorization: Bearer <secret>` */ }
```

The comment states the rationale: *"in prod/Vercel a missing CRON_SECRET must refuse,
not open the door — same rule as the auth gate (losing an env var never fails open)."*
Locally, with no `CRON_SECRET` set and `NODE_ENV !== production`, the routes are open.

#### The step runner (`src/lib/cron.ts`)

`cronBudget(budgetMs, startedAtMs, job)` returns `{ step, out, finish }`. Every cron
step is wrapped in it. Three things it buys, all documented in the file header:

1. **Time budgeting.** Once `Date.now() - startedAtMs >= budgetMs`, `step()` stops
   starting new work and pushes the name onto `out.skipped`. *"Vercel kills a function
   when it hits maxDuration… so we don't even know what got skipped."* Every step is
   idempotent, so the next tick picks up the remainder.
2. **Per-step error capture.** A throwing step writes `out["<name>Error"]` and records
   the first error into `CronRun.error` (truncated to 500 chars). The run continues.
3. **Eager run row.** The `CronRun` row is created **before** any step runs
   (fire-and-forget promise, `cron.ts:46-58`) — *"so a hard-killed run still leaves a
   visible row with no finishedAt — the one failure mode a write-at-the-end log can
   never capture."* A `CronRun` with `finishedAt = null` therefore means "killed
   mid-flight", and `/connections` renders it grey (`ok: r.finishedAt ? r.ok : null`,
   `src/app/connections/page.tsx:39`, which keeps the 5 most recent runs per job).

`finish()` stamps `finishedAt`, `ok` (= no error **and** nothing skipped),
`summary` (the whole `out` object as JSON, clipped to 4000 chars) and `error`.

**Alert dedupe.** On a not-ok run, `finish()` loads the *previous* `CronRun` for the
same job and compares failure signatures — `failureSignature()` (`cron.ts:26-30`) is
the sorted list of `*Error` step keys plus `skip:<name>` entries. Only if the signature
**changed** does it fire:

- `opsAlert("🟥 Cron \"<job>\" degraded: …")` → Slack (external send).
- `notifyInApp({ kind:"system", href:"/connections", targets:[{roles:["OWNER"]}] })`
  with an hour-bucketed `dedupeKey` (`cron-<job>-YYYY-MM-DD-HH`, i.e. the ISO string
  sliced to 13 chars with `T`→`-`) — *"a flapping job can't spam."*

Everything inside `finish()` is in one big try/catch: *"recording/alerting is
best-effort — the cron response still reports `out`."*

#### `/api/cron/gmail` — steps in order

| Step | Function | Notes |
|---|---|---|
| `gmail` | `syncGmail()` (`src/lib/integrations/google.ts:597`) | Both mailboxes; `in:inbox newer_than:3d -from:me`, up to 6 pages × 50 = ~300 ids/run. Each message gets a `WebhookEvent{provider:"gmail", externalId:"<mailbox>:<msgId>"}` row created **RECEIVED first, stamped PROCESSED only after handling** — *"a crash or timeout mid-message permanently ate that email; now it's marked ERROR and the next scan retries it."* Deliberately no `category:primary` (Workspace mailboxes have no tabbed inbox — it would match zero messages). Unknown human sender → one `lead-<email>` SmartTask + `notifyUrgent` Slack + `new_lead` bell. Ends with a reply sweep closing `gmail-thread:` tasks we've since answered. |
| `openphoneClosed` | `sweepRepliedOpenPhoneTasks()` (`src/lib/integrations/openphone.ts:206`) | Closes `client_reply` tasks whose thread's newest OpenPhone message is outbound. **Skips clients with >1 open reply task** — this phone-level sweep can't tell which order a reply addressed. |
| `slack` | `syncSlackHistory({ sinceHours: 2 })` | User-token pull of member channels (ADMIN tier) + Jordan's DMs/group DMs (OWNER tier) into `CommLog`; `logComm` dedupes the overlap with the real-time Slack webhook. |
| `replySla` | `sweepReplySla()` (`src/lib/commsSla.ts:171`) | See §4. |

#### `/api/cron/sync` — steps in order

`orders` (`syncAryeoOrders({full:false})`, incremental) → `appointments`
(`recentOnlyDays: 21`) → `statuses` (`syncProjectStatuses()`, default cap 80 active
projects) → `photosUndelivered` (`sweepUndeliveredPhotos()`) → `tasks`
(`generateTasksForActiveProjects()`) → `retryWebhooks`
(`retryFailedWebhooks(25)`) → `frameioProjects`
(`ensureFrameioProjectsForActiveVideoJobs(5)`).

Two ordering decisions are commented:

- `statuses` runs before `photosUndelivered` *"so the Aryeo evidence it reads was
  refreshed moments ago."*
- `photosUndelivered` is hosted here rather than in `daily` because *"daily fires 3-4am
  ET: inside SMS quiet hours (the text would be silently dropped while the dedupe key
  was still consumed) and hours before anyone could act."* It self-gates to the
  16:00–19:00 ET window, so on 21 of 24 hourly ticks it returns
  `{ skippedOutsideWindow: true }` without touching the DB.

`syncProjectStatuses` is also where four best-effort side-engines live (all wrapped
so they can't break the sweep):

- `reconcileRawsMissing` (`src/lib/projectStatus.ts:703-711`) for BOOKED/SCHEDULED/**SHOT**
  jobs whose shoot already happened. SHOT is included on purpose: *"a photographer
  pressing 'Mark shoot complete' in the field flips the job to SHOT, and the old gate of
  BOOKED/SCHEDULED meant exactly the people who told us they had finished were the ones
  never chased."*
- `mintCullTask` (`src/lib/projectStatus.ts:646-650` → `src/lib/tasks.ts:1012`) when raw
  photo count exceeds the home's budget × `RAW_OVERAGE_FACTOR`.
- `chaseVendorsForMissing` (`projectStatus.ts:664-672`, SHOT/EDITING/REVIEW with
  `evidence.missing` non-empty) — audit crack #16: *"a floor plan (CubiCasa) or the photo
  edits (AutoHDR) still missing days after the shoot means the vendor handoff dropped."*
  One deduped chase task per project+category.
- `ensureEditorHandoff` (`projectStatus.ts:685-690`) — the raws-landed / editor-brief
  handoff, run on **every** SHOT/EDITING/REVIEW pass rather than on a transition. The
  comment records why: the old `statusChanged && final === "SHOT"` gate had *"two fatal
  holes… (1) a job whose photos deliver fast jumps SCHEDULED→REVIEW without ever landing
  on SHOT — its video got NO editor task, NO notification, NO Luma dispatch (4 of 5
  video-owing REVIEW jobs had none); (2) the photographer 'done' buttons set SHOT
  directly, so the sweep saw no transition."*

#### `/api/cron/daily` — steps in order

`stripe` · `booksSync` · `booksClassify` · `plaidSync` · `plaidCategorize` ·
`photoCounts` · `clients` · `dedupe` · `segments` · `social` · `customerTeams` ·
`appointments` · `staleDeliveryTexts(7)` · `staleFeedbackReviews(7)` ·
`webhookLogTrimmed` · `cronRunLogTrimmed` · `notificationsTrimmed` · `clientProfiles(20)` ·
`ordersFullReconcile` · `plaidRetryErrored` · `shootFocusSummaries` · `packageMargins` ·
`growthPlan`.

The ordering carries three expensive lessons, all written into the file:

- **`stripe` is first.** *"It used to run LAST, behind ordersFullReconcile… and as a
  result it had not run from cron in weeks while every CronRun died with
  finishedAt=null. That single ordering bug is why the books showed a 32% revenue
  collapse that never happened."* (`daily/route.ts:30-35`)
- **`ordersFullReconcile` is late and hard-capped at 150 s** via
  `Promise.race([syncAryeoOrders({full:true}), setTimeout(…150_000)])`. *"measured
  130-330s, it kept blowing past maxDuration and killing the function BEFORE finish() —
  so every CronRun died with finishedAt=null and monitoring was blind since inception."*
  Its position also protects the cheap steps: *"July 5's profile refreshes ran zero
  times because this step ran mid-list."*
- **`plaidRetryErrored` sits after it deliberately** — minutes later, *"comfortably past
  minute-scale 429 rate limits (a single 429 used to freeze an item for a full day; PNC
  sat stuck 2 days)."*

Retention housekeeping, all 30/90-day cutoffs:

| Step | Table | Cutoff |
|---|---|---|
| `webhookLogTrimmed` | `WebhookEvent` | 30 days |
| `cronRunLogTrimmed` | `CronRun` | 30 days |
| `notificationsTrimmed` | `Notification` | 90 days (own try/catch returning 0 — *"table not pushed yet — never degrade the run over housekeeping"*) |

`packageMargins` is here specifically because it runs the payroll engine, which resolves
mileage through the public OSRM router: *"far too slow and too network-dependent for a
page request (it took a 60s serverless function down in production)."* `growthPlan` is
cached against a hash of the business numbers, so on a flat day it's a free no-op.

#### What leaves the building

| Cron | External sends |
|---|---|
| `gmail` | Slack (`opsAlert`/`notifyUrgent` for new leads and reply-SLA); an inbound email that raises a revision can also bridge an `editor:<key>` bell to a Manila editor's Slack DM/SMS (`comms.ts:424`). **No client email or SMS.** |
| `sync` | Slack; **staff SMS** via `notifyStaffSms` (undelivered photos); **photographer SMS** via the `notifyInApp` bridge — `cull`, `raws_missing`, `order_canceled` and `appointment_change` rows all carry a `tm:` + PHOTOGRAPHER target |
| `daily` | Slack; the same photographer/editor bridges are *reachable* (full `syncAryeoOrders`/`syncAryeoAppointments` emit `order_canceled` / `appointment_change`), but 08:00 UTC is 03:00–04:00 ET, outside the 7:00–22:00 ET texting window, so `smsPhotographer` returns early and only the bell row lands. Reads Stripe/QBO/Plaid/Aryeo/Dropbox |
| `relabel-deliverables` | none |

---

### 2. Webhooks

Five receivers under `src/app/api/webhooks/`. Every one logs a `WebhookEvent` row and
returns HTTP 200 even when processing failed, so the provider doesn't hammer retries —
**our** hourly retry loop owns recovery instead.

| Provider | Route | Events | Verification | Rejection logged? | Spike alert? |
|---|---|---|---|---|---|
| OpenPhone | `/api/webhooks/openphone` | `message.received`, `message.delivered`, `call.completed`, `call.ringing`, `call.recording.completed`, `call.transcript.completed` | shared-secret `?t=` token, constant-time (`openPhoneRequestAuthorized`) | yes (`signature.rejected`) | yes |
| Aryeo | `/api/webhooks/aryeo` | 10 subscriptions per the code comment: `ORDER_CREATED/FULFILLED/PAID`, `LISTING_UPDATED`, `APPOINTMENT_SCHEDULED/ASSIGNED/RESCHEDULED/CANCELED`, `CUSTOMER_CREATED/UPDATED` | HMAC-SHA256 of raw body vs `Connection.webhookSecret`, header `Signature` (plus 3 aliases) | yes | yes |
| Slack | `/api/webhooks/slack` | Events API `message` | `v0=` HMAC over `v0:<ts>:<raw>` with `SLACK_SIGNING_SECRET` + 300 s replay window | **no** | no |
| Frame.io | `/api/webhooks/frameio` | custom action `rtp.ready_for_review`; comment events if/when registered | shared-secret `?t=` token (`frameioRequestAuthorized`) | yes | yes |
| Script Studio | `/api/webhooks/scripting` | `project.created/hooks_proposed/script_generated/sent_to_client/client_responded/done/updated/deleted` | HMAC-SHA256, header `x-scripting-signature`, secret `SCRIPTING_WEBHOOK_SECRET` | yes | **no** |

Both token checks are **backward-compatible by design**: `if (!expected) return true`
— *"not yet activated — backward compatible"* (`openphone.ts:431-437`,
`frameio.ts:230-236`). Aryeo's HMAC and Script Studio's HMAC are the same shape at the
call site (`if (secret) { … }` — no secret, no check). The `/connections` page surfaces
this by listing `unsignedProviders` (`connections/page.tsx:71-80`) — but that list only
covers **openphone, frameio and aryeo**; Script Studio has no entry, so an unset
`SCRIPTING_WEBHOOK_SECRET` is invisible there. *"It should be visible, not silent."*

Tokens are minted at registration time, 24 random bytes hex, and rotated on every
re-register: `registerOpenPhoneWebhooks` (`openphone.ts:387`) and `ensureReviewAction`
(`frameio.ts:195`). There is **no Aryeo webhook-registration code** in the repo — that
subscription is configured in Aryeo's own dashboard, and its `webhookSecret` lives on
the `Connection` row.

#### OpenPhone receiver — what it actually mutates

`processOpenPhoneEvent` (`openphone/route.ts:103`) is the busiest piece of automation in
the codebase. Per event it can:

- Log a `CommLog` row (texts and full call transcripts) attributed to the real sender.
  Our own numbers are resolved via `ourOpenPhoneNumberKeys()` — *"in a group thread our
  own replies echo back as 'incoming' events FROM our line — those are OURS."*
- Create an `Activity` row on the matched project.
- `recordClientCommunication(...)` → reply task + revision detection.
- Missed inbound call → `createCommTask({kind:"missed_call"})`.
- **Auto-close** on outbound: `closeReplyForOutbound`, `closeReplyForOutboundCall`
  (only when the call actually connected — `answeredAt` or `duration > 0`), and a
  blanket close of any open `delivery_text` task for that client, because *"Kyle often
  sends the 'your gallery is ready' text straight from his phone… delivery_texts were
  36% of all overdue, only ever swept by a 7-day timer."*
- Phone-lead auto-close for outbound texts/answered calls to a number with an open
  `lead` task (leads have no client match, so the client-scoped close never reached them).
- **Smart project routing**: an inbound text from a known non-client (a photographer, a
  coordinator) that names a specific job goes through `routeCommTask` (the Smart Brain),
  which can judge it non-actionable, merge it into an existing to-do, or emit a clean
  title/detail/priority for `createProjectFollowupTask`.
- **Lead path**: unknown number → `upsertPhoneLeadTask` (`lead-<10digit>` dedupe key,
  HIGH, due +4 h, owned by Kyle) + `notifyUrgent` Slack + `new_lead` bell. A voicemail
  transcript *upgrades* an already-open lead task's summary with what the caller said.

`AUTOMATED_SENDER_RE` (`/aryeo|notif|no-?reply|…|real\s*tour/i`) filters robo-senders out
of comms memory, task creation and the lead path entirely.

Idempotency: `WebhookEvent` lookup on `(provider:"openphone", externalId, status:"PROCESSED")`.

#### Aryeo receiver — the payload-shape trap

`classifyAryeoPayload` (`aryeo/route.ts:106`) handles two shapes. The documented ACTIVITY
wrapper, and the one Aryeo actually sends. From the comment:

> REAL deliveries (verified against stored WebhookEvent payloads, Jul 2026) are the FLAT
> RESOURCE itself… and appointment payloads carry no `object` key at all, just
> start_at/end_at/rescheduled_at/previous_start_at. The old parser only knew the wrapper
> shape, so every real event fell through unrouted ("unknown" or a customer's NAME as the
> event type) and was silently dropped.

Idempotency is deliberately **only** applied when a true ACTIVITY id exists:

> Flat resource payloads carry the RESOURCE's id — deduping on that would skip every
> FUTURE event about the same order/appointment after the first one processed (which is
> exactly what happened: real events silently swallowed).

Because flat payloads hide the verb, routing is by resource type and every branch
**re-fetches authoritative state** rather than trusting the body: ORDER → `syncAryeoOrders`
+ `restatusProject` + `retaskProject` + `syncClientSegments`; LISTING → restatus + retask
that project; APPOINTMENT → bounded 21-day appointment sync (with an unbounded re-run if
the appointment's `startAt` is older than the window), orders sync, restatus, retask;
CUSTOMER → customers + segments + social plans. A substring fallback catches legacy shapes.

#### Frame.io receiver

The editor clicks "Send to RealTour for review" in Frame.io. `processFrameioEvent`
resolves `Project.frameioProjectId`, then either:

- **comment-shaped payload** → `raiseRevision({source:"frameio"})` and returns "filed as
  a revision"; or
- **the action** → flips `SHOT/EDITING/REVISION` → `REVIEW` (never touches
  delivered/cancelled), upserts a HIGH `media_qa` task for Kyle (`frameio-review-<pid>`,
  due +4 h), and fires an `edit_finished` bell to OWNER plus an `editor:<key>` row for
  in-house editors only (Luma is external — no channel, no login).

The function **throws** on real failure rather than swallowing. Comment: *"the old
version wrapped every write in .catch(()=>{}), blanket-marked PROCESSED, and returned
'Sent ✓' regardless."* The 200 response now carries a real title/description telling the
editor the handoff didn't land and will retry.

#### Script Studio receiver

Mirrors status + best link + hooks/script/song into the project's reel recipe fields
(`scriptingId/Status/Url/SyncedAt`, `reelHook/reelScript/reelSong/reelScriptUrl`), always
by **re-fetching** the authoritative project (`scriptingGetByExternalId`). Mints and —
crucially — **closes** two nudge tasks (`scripting-script-<pid>`, `scripting-client-<pid>`):
*"each event used to only re-open the same key, so nothing ever closed these tasks (audit
crack #35)."* `project.deleted` unlinks the Studio ids and never deletes the hub job.
A Studio-native project (no `external_id`) returns cleanly instead of erroring forever
into the retry loop.

#### The retry mechanism (`src/lib/webhookRetry.ts`)

`retryFailedWebhooks(25)` runs on the hourly cron. It takes up to 25 `WebhookEvent` rows
with `status:"ERROR"`, `provider != "gmail"`, `createdAt` within 24 h, oldest first, and
re-runs the *same* processor via `dispatch()` — which reconstructs each receiver's args
from the stored raw payload. Success → `PROCESSED`; failure → `FAILED` (terminal).

> Each receiver returns HTTP 200 even on a processing failure (so the provider doesn't
> hammer retries), marking the row status:"ERROR" — but nothing re-ran them, so a
> transient blip (DB/API hiccup) silently dropped a real event (a delivered gallery, a
> paid invoice, an inbound text).

Gmail rows are excluded on purpose: *"they can't be re-dispatched from the stored payload
(it's just a snippet) — the gmail cron re-scans the inbox and retries any non-PROCESSED
row itself, so marking them FAILED here would only fight that loop."*

Two read helpers feed `/connections`:

- `webhookErrorCount()` — `ERROR` + `FAILED` in the last 7 days.
- `webhookHealthByProvider(7)` — groups `REJECTED | ERROR | FAILED` rows by provider and
  folds them into `rejected` (signature failures) vs `errored` (everything else). This
  exists because rejections were counted nowhere: *"765 bounced Aryeo events ran silent
  for 13 days while the page stayed green (audit crack #7)."*

`alertWebhookRejections(provider)` (`notify.ts:334`) counts the last hour's REJECTED rows
for a provider and fires **only on exact equality with 6** — *"equality check = natural
rate limit; a steady rejection stream alerts at the crossing, not on every event."* It
sends a Slack line + an hour-bucketed OWNER bell.

---

### 3. The notification system

Jordan's version: the bell in the sidebar. One row per person or per role, a red count
of what's new since you last looked, and a hard rule that anyone on the creative side
never sees a dollar figure.

#### Model

```prisma
model Notification {
  id, kind, title (≤90), body?, href, audience (JSON Role[]),
  userKey?    // null = role broadcast; "tm:<id>" | "editor:<key>" = that person
  dedupeKey?  @unique
  createdAt   @@index([createdAt])
}
```

#### `notifyInApp` — the single write path (`src/lib/notify.ts:248`)

One `Notification` row per entry in `targets`. `dedupeKey` is suffixed with the target
index (`${dedupeKey}-${i}`) so a multi-target event inserts every row while still
collapsing repeats. A unique violation (`P2002`) is swallowed silently — *"this event was
already announced… recurring events put the changing part IN the key, e.g. a reschedule's
new startAt."* The whole function is best-effort and **never throws**: *"a bell miss must
never break a webhook, cron, or task write."*

**The money clamp** (`notify.ts:266-273`) — enforced here and nowhere else:

```ts
if (roles.includes("EDITOR") || roles.includes("PHOTOGRAPHER")) {
  body = null;
  if (href.startsWith("/billing") || href.startsWith("/payouts") || n.kind === "order_paid") {
    roles = ["OWNER"];
    console.warn("notifyInApp money clamp", n.kind);
  }
}
```

Comment: *"the SINGLE enforcement point (not 16 call sites): creatives never see money.
Any row that can reach an editor/photographer loses its body; a money destination
collapses the row to owner-only."*

#### The emitters

23 modules call `notifyInApp`. By kind:

| Kind | Emitter | Audience |
|---|---|---|
| `order_booked` | `integrations/aryeo.ts:1077` | OWNER, ADMIN |
| `order_canceled` | `aryeo.ts:927` (canceled after delivery, OWNER) / `:975` (cancel, + photographer) | OWNER, ADMIN, PHOTOGRAPHER |
| `order_paid` | `aryeo.ts:995` (first flip to `paid`) | OWNER |
| `appointment_change` | `aryeo.ts:1743-1779` — canceled / moved / postponed / rebooked / reassigned | ADMIN + assigned photographer |
| `delivery_out` | `projectStatus.ts:737` on first arrival at DELIVERED | OWNER, ADMIN, photographer |
| `revision_raised` / `revision_resolved` | `comms.ts:425` / `:499` | — |
| `new_lead` | `webhooks/openphone/route.ts:531`, `integrations/google.ts:962` | OWNER, ADMIN |
| `raws_landed` | `tasks.ts:1142` | ADMIN + whole EDITOR bench + routed `editor:<key>` |
| `raws_missing` | `tasks.ts:1468` (raw video missing) / `:1617` (nothing landed at all) | OWNER, ADMIN, creative manager, shooter |
| `cull` | `tasks.ts:1068` | the photographer (`tm:` + PHOTOGRAPHER → SMS) |
| `edit_finished` | `webhooks/frameio/route.ts:182` | OWNER + in-house editor |
| `edit_assigned`, `task_assigned`, `mention_done` | `app/actions.ts:303/318/187` | — |
| `mention`, `note_reply` | `mentions.ts:174` / `:311` | see §5 |
| `review_ready`, `review_feedback`, `feedback_shared` | `projects/reviewActions.ts` | — |
| `review_submitted`, `review_approved`, `review_changes` | `review/actions.ts` | — |
| `shoot_completed` | `shoot/actions.ts:226` | — |
| `client_feedback` | `feedback.ts:122` | — |
| `photos_undelivered` | `deliveryWatch.ts:128` | OWNER, ADMIN |
| `reply_sla` | `commsSla.ts:192` (ADMIN) / `:212` (OWNER) | — |
| `system` | `cron.ts:112`, `notify.ts:345`, `gmailHealth.ts:34`, `fieldIssues.ts:74`, `feedback/actions.ts:91`, `my-pay/actions.ts:66` | mostly OWNER |

#### The bell: role scoping + seenAt watermark

`GET /api/notifications` (`src/app/api/notifications/route.ts`) builds:

```ts
{ audience: { contains: `"${u.role}"` },
  OR: [ { userKey: null }, { userKey: { in: ["tm:<id>", "editor:<key>"] } } ] }
```

*"Role names are distinct words, so matching the audience JSON with a quoted substring is
safe (no role is a substring of another)."* It returns the 30 newest rows plus `unread` =
count with `createdAt > AppUser.notificationsSeenAt`.

`POST` moves the watermark to now — **except under "view as"**: `if (u.impersonating)
return 204`. *"Owner 'view as' is strictly read-only: it renders the impersonated
person's bell but must never move THEIR watermark."*

`NotificationsBell.tsx` mounts twice (mobile header, desktop sidebar footer), polls every
60 s while the tab is visible, and holds the **pre-open** watermark so rows keep their
unread styling while you read them — the badge drops to 0 immediately, the highlighting
survives until the panel closes. The mobile panel is portaled to `<body>` because the
blurred header creates a stacking context.

**Row visibility depends on the recipient's *current* role.** A `tm:` row is invisible
unless its `audience` contains the person's live `AppUser.role` — which is why
`creativeAlertTargets` (`tasks.ts:1531-1547`) deliberately sets a broad roles list: *"a
promotion would otherwise silently mute them."*

---

### 4. Ops alerts — who gets interrupted, and on what

Two Slack helpers, two SMS helpers, all in `src/lib/notify.ts`, all best-effort.

#### Slack (`opsAlert`, `notifyUrgent`)

Destination resolution (`alertDestination`, cached ~1 h): `SLACK_ALERT_CHANNEL` env wins;
else the first channel the bot is a member of matching `/project-tracker|alert|ops|notif/i`;
else Kyle's DM (`U07SCBTPDC7`, hard-coded).

#### Photographer SMS bridge

Fires inside `notifyInApp` only when **all three** hold: `kind ∈ SMS_KINDS`, `userKey`
starts with `tm:`, and `roles` includes `PHOTOGRAPHER`.

`SMS_KINDS = { appointment_change, order_canceled, mention, review_feedback, cull,
raws_missing, task_assigned, note_reply }`.

Rules from the header comment: team members only (number off the `TeamMember` row, *"the
drafts-only policy for client texting is not weakened here"*); **title + deep link only,
never the body** — *"an SMS is even leakier than the bell"*; prefix `⚙️ RealTour Hub:` so
*"an automated text is never mistaken for Kyle texting from the same number"*; quiet hours
7:00–22:00 ET (the bell row still lands); only on a **newly created** row, so a deduped
re-announcement can't re-text.

#### `notifyStaffSms(teamMemberIds, text)` — named-person interrupts

Accepts **no raw phone string**, only TeamMember ids. From the comment: *"the one thing
separating a staff text from a client text in this codebase is which table the number came
out of, so that boundary is enforced by the signature, not by a comment."*

It refuses to text our own OpenPhone line, and says why:

> Kyle's TeamMember.phone is currently the company number (215) 645-4889, so a naive send
> would text the office line from itself and echo back through the inbound webhook as a
> fake client message.

Per-recipient outcomes are `sent | no-phone | own-line | quiet-hours | failed`. Anyone not
reached (other than quiet-hours) triggers a Slack relay — *"a missed alert is the failure
this whole feature exists to prevent."*

#### Alert A — photos not delivered (`src/lib/deliveryWatch.ts`)

Runs on the hourly cron. Three rules the file says it must never break:

1. **Unknown is not late.** Requires `statusEvidence.aryeo` to exist and
   `statusCheckedAt` to be < 6 h old. *"Alerting on a blind read would page the whole
   roster during an Aryeo outage."*
2. **Never touch history.** `LOOKBACK_DAYS = 6`, `take: 60`.
3. **Monthly-social sessions are not listings.** `isContentSession()` matches
   `video (starter|accelerator|pro)` / `content (session|day)` — *"they would otherwise
   alert every single day forever."*

Other constants: `PHOTOS_LATE_AFTER_MS = 26 h` (sits past `TURNAROUND_HOURS.PHOTOS = 20`
so an afternoon shoot isn't chased before lunch next day); ET window **16:00–19:00**;
statuses `SHOT|EDITING|REVIEW` only (REVISION and ON_HOLD excluded — a REVISION job was
already delivered once); requires `aryeoListingId` and an expected photo category; skips
anything whose Aryeo `delivery === "DELIVERED"`.

One alert per job **ever** — the probe is `Notification.dedupeKey = "photos-undelivered-<pid>-0"`
(the `-0` is `notifyInApp`'s target-index suffix). Then `OWNER/ADMIN` bell, then SMS to:

```ts
prisma.teamMember.findMany({ where: { active: true, opsAlerts: true } })
```

> Deliberately NOT role-derived: Kyle is MANAGER and so is Kim (an editor in Manila),
> while Jordan is PHOTOGRAPHER because he shoots. A role query here texted the wrong
> people and missed Kyle entirely.

Message body lists up to 4 streets with day counts, then `+N more`.
`previewUndeliveredPhotos()` gives a dry-run count with no sends.

#### Alert B — forgotten upload / raws missing (`src/lib/tasks.ts:1518-1631`)

*"the 'shoot happened, nothing ever landed' alarm the system never had (877 S York sat
SCHEDULED for 11 days with nobody told — July 2026 audit)."* Fires 18 h
(`RAWS_MISSING_AFTER_MS`) after the latest past non-canceled appointment leg, only when
raws are **known** empty (`rawsKnownEmpty` = Dropbox readable and zero files) and Aryeo has
no media — *"unknown is not proof of absence."* Mints one `raws-missing-<pid>` HIGH task on
Kyle plus a `raws_missing` bell to `creativeAlertTargets(photographerId, "/upload/<pid>")`
= OWNER/ADMIN broadcast + the Creative Manager personally (`creativeManager: true`) + the
shooter (which SMS-bridges). Self-clears when raws land.

Sibling alarm `raw-video-missing-<pid>` (`tasks.ts:1434-1478`) covers "video ordered,
`02-RAW-Video` empty", and is **skipped for manually-queued jobs** — *"no footage in the
folder is EXPECTED for old-footage / externally-shot work, and the wrong 'upload your
video' text would chase a photographer who owes nothing."*

#### Alert C — reply SLA (`src/lib/commsSla.ts`)

Every 5 minutes. Motivation, verbatim: *"A 60-day audit found 13 client texts that NEVER
got a reply, one of them a 'call me quick... Help!!' that sat unanswered for 12 days."*

`findUnansweredInbound` pulls 7 days of `CommLog` text rows in time order and keeps, per
client, the latest inbound that still needs a reply; any outbound clears it. Three filters
suppress non-questions: `isReaction` (shared with `comms.ts`), `isPraiseOnly`
(≤120 chars, praise words, no `?`), `isAckOnly` (exact closers like `will do`/`yup`/
`you're the man`, or a ≤80-char closing phrase that `classifyComm` doesn't read as a
revision) — *"a prod probe showed these dominate the 'unanswered' list — without this
filter the go-live sweep would page the owner over five closers and zero real waits."*
Plus `CALL_ARTIFACT_RE` for backfilled call breadcrumbs.

| Tier | Threshold | VIP threshold | Goes to |
|---|---|---|---|
| 1 | 30 min | 15 min | ADMIN bell + one Slack line |
| 2 | 120 min | 60 min | OWNER bell + urgent Slack (`notifyUrgent`) |

VIP = client (or folded parent) segment in `{vip, heavy}`. Tier 1 is gated to
**08:00–19:00 ET**. Tier 2 is not hours-gated but *"never LEADS overnight"* — it only fires
if tier 1 already went out, *"so an 18:30 tier-1 still escalates at 20:30, while a 2am text
stays quiet until 8:00, then jumps straight to both tiers."* Dedupe keys embed the exact
inbound timestamp (`sla-1-<clientId>-<iso>`), and freshness is checked by probing the
`-0` notification row directly rather than relying on `notifyInApp`'s silent P2002 skip —
*"what lets the Slack line fire only alongside a brand-new bell row."*
`sweepReplySla` catches everything and never throws.

#### Alert D — Gmail send health (`src/lib/gmailHealth.ts`)

The token can read mail but lack the send scope. *"Before this, a failed send surfaced
only as an inline 'reconnect Google' error to whoever pressed Send, which an ADMIN
literally cannot act on."* `reportGmailSendBroken(context, mailbox)` fires an OWNER bell
(day-bucketed via `etDayKey`) and mints/reopens a URGENT `connection_fix` task keyed
`gmail-reconnect-<mailbox>`, assigned to `jordan`. Per-mailbox on purpose: *"info@ and
hello@ hold separate tokens, so info@ working must not close a task about hello@ being
broken — that flip-flopped the durable item every time an unrelated send succeeded."*
`reportGmailSendWorking(mailbox)` closes that mailbox's task plus the legacy
`unknown`/`gmail-reconnect` keys. Both are awaited by callers, not fire-and-forget:
*"fire-and-forget writes get killed by the serverless freeze right after the response."*
The task is engine-minted and never sets `assignedManually` — *"that flag is the humans'
'hands off' signal to every automatic engine."*

---

### 5. @mentions and the 3am-Manila rule

`src/lib/mentions.ts`. Every note surface calls `notifyMentions` with the saved text.

`matchMentions(text, people)`: full names first (longest first, so `@Kim Miguel` beats a
bare `@Kim`), then bare first names **only when unambiguous on the roster**, and only with
a real word boundary — `(^|\s)@Name(?=$|[\s,!?;:])`. The reason is spelled out: *"'@kim.creates'
(an IG handle) and 'info@kim…' (an email) must NOT ring Kim — media notes contain both."*
`isMentionedIn()` reuses the identical matcher so page guards agree with the pings.

Per tagged person the module writes:

- **One task**, `dedupeKey: mention-<projectId>-<tmId>` — deliberately the same key the
  team-message tags use, *"so one person has ONE 'you were tagged on this job' item however
  they were tagged."* `assignedKey` is set to the editor key or `slugForName(name)` because
  *"ownerId alone shows on no surface."*
- **One bell**, `dedupeKey: mention-note-<pid>-<noteId>-<tmId>-<hash(text)>` (random-free,
  so identical text on the same note won't re-ring but the same words on a different thread
  will).

Link routing: photographer → the note page `/shoot/note/<id>` if there is one, else
`/shoot/<pid>` **only if `photographerOwnsShoot` passes**, else `/shoot` — *"a tagged
photographer may NOT own this shoot — /shoot/<id> bounces non-owners to the bare list and
the mention evaporates."* Editor → `/edit/<pid>` (`/projects` bounces the EDITOR role).
Everyone else → `/projects/<pid>`.

**The 3am rule.** For an editor, the `tm:` visibility row is given
`["OWNER","ADMIN","EDITOR"]` — PHOTOGRAPHER is dropped:

> dropping PHOTOGRAPHER there disarms the SMS bridge (which keys on tm: + PHOTOGRAPHER-in-roles
> and texts on ET quiet hours), so a Manila editor is reached ONLY via their editor:<key>
> channel row below, in their own timezone — no 3am texts, no double delivery.

The `editor:<key>` row goes through `channelForEditor` (`notify.ts:211`), which checks
`withinTextingHours(meta.tz ?? DEFAULT_EDITOR_TZ)` where `DEFAULT_EDITOR_TZ = "Asia/Manila"`
and Kim/Remar carry `tz: "Asia/Manila"` in `src/lib/editors.ts`. Comment: *"the Manila
editors' night is precisely the old ET texting window, so a text keyed to ET would fire at
3am their time."* Channel preference is Slack DM (`meta.slackUserId`) → SMS via their
`TeamMember.phone` → **loud relay to ops Slack** when neither exists:

> The old silent return meant editor-addressed work landed NOWHERE a human saw (audit
> critical) — make it loud so ops relays it by hand.

`EDITOR_CHANNEL_KINDS = { raws_landed, revision_raised, revision_resolved, mention,
edit_finished, review_changes, review_approved, edit_assigned, note_reply }`.
`channelForEditor` returns `slack | sms | relay | quiet | none`, and `notifyInApp` hands
that back as `{ bridged }` so callers can log the truth — `notifyRawsLanded`
(`tasks.ts:1090`) uses it to stamp the project timeline with what actually happened
instead of the old hard-coded *"notified via Slack"* claim (*"Remar has no Slack/phone;
audit #33 honesty residue"*).

`notifyThreadReply` (`mentions.ts:202`) exists because *"a reply on a note used to notify
NOBODY unless it hand-typed an @mention — a photographer's 'which bathroom do you mean?'
rotted invisibly (audit #31)."* It pings the thread's other participants (root author,
prior repliers, plus the root note's implicit addressee via `lane`/`photographerId`/`editorKey`),
minus the replier — recognising that a `tm:<id>` and an `editor:<key>` can be the same
human and de-duplicating both spellings.

Also cron-adjacent: a **new** `editor:` bell row triggers `ensureEditorLoginNudge`
(`notify.ts:299-304`) — a nudge to Jordan to send that editor a Hub invite, because a bell
row with no login behind it is invisible.

---

### 6. Usage tracking (internal-only, no alerts)

`POST /api/activity` is a page-view beacon the Shell posts on every in-app navigation.
Identity comes from the verified session — *"nothing identity-shaped is trusted from the
body."* Three guards:

- `isTrackablePath()` (`src/lib/usage.ts:37`) allow-lists nav `PAGES`, nine detail-route
  regexes, and redirect stubs — *"an arbitrary client string would let a user paint
  fabricated entries into the owner's trail (and grow the table)."*
- Flood cap: 120 events/user/hour — *"a human doesn't navigate 120+ times an hour; a
  script might."*
- Atomic dedupe: the row `id` **is** `sha1(userId|path|20s-bucket).slice(0,25)`, so double
  fires *"collapse on the unique id instead of racing past a check-then-create."*

"View as" previews are skipped entirely (`user.impersonating` → 204) — recording them
*"would fake their activity."* Reads happen in `getUsageOverview(14)`, owner-only, with
exact SQL `groupBy` counts *"never from a capped slice — so a heavy week can't silently
zero out someone's real activity."* Distinct active days use a raw query that marks
`createdAt` as UTC before converting to New York, *"or Postgres would read the UTC digits
as NY time."* Retention is 90 days, pruned lazily on read. Nothing here sends anything.

---

### Gotchas / known state

- **`relabel-deliverables` is dead weight in the scheduler.** It's a full cron-style route
  with a 300 s `maxDuration` and secret gate, but has no `vercel.json` entry, no
  `cronBudget`, no `CronRun` row, and no caller anywhere in `src/`. It only runs if someone
  curls it with the bearer token.
- **`WebhookEvent.status` schema comment is stale.** `prisma/schema.prisma:1122` documents
  `RECEIVED | PROCESSED | ERROR`, but the code also writes `REJECTED` (openphone, aryeo,
  frameio, scripting — not slack) and `FAILED` (`webhookRetry.ts:44`).
  `webhookHealthByProvider` queries three of the five (`REJECTED`, `ERROR`, `FAILED`).
  `CronRun.job`'s comment (`schema.prisma:1138`) is also stale — it lists
  `"sync" | "daily" | "gmail"`, which happens to still be exhaustive only because
  `relabel-deliverables` writes no row.
- **Slack signature rejections are invisible.** `src/app/api/webhooks/slack/route.ts:38-40`
  returns 401 without creating a `WebhookEvent` row and without calling
  `alertWebhookRejections`. Aryeo, OpenPhone and Frame.io all do both. So a rotated or
  missing `SLACK_SIGNING_SECRET` bounces every Slack event and `/connections` shows nothing
  — `verifySlack` returns `false` when the env var is empty, which is correctly fail-closed
  but completely silent.
- **Script Studio rejections are logged but not spike-alerted.** It writes the `REJECTED`
  row (`scripting/route.ts:31-33`) but never calls `alertWebhookRejections`, unlike the
  other three.
- **Four receivers accept unsigned posts by design.** `openPhoneRequestAuthorized`,
  `frameioRequestAuthorized`, the Aryeo HMAC check and the Script Studio HMAC check all
  pass everything through until a token/secret is stored (*"backward compatible: allowed
  until a token is stored"*). `/connections` lists the first three as `unsignedProviders`,
  which is the only signal — **Script Studio isn't in that list at all**, so an unset
  `SCRIPTING_WEBHOOK_SECRET` is a silent open door. Per the Frame.io memory note, that
  token stays absent until the action is re-registered. Slack is the odd one out and is
  fail-closed: `verifySlack` returns `false` when the secret is empty.
- **No Aryeo webhook registration code exists.** The 10 subscriptions named in
  `aryeo/route.ts:163-167` are configured in Aryeo's dashboard; only OpenPhone and Frame.io
  self-register (and rotate their token) from inside the app.
- **`ordersFullReconcile` frequently times out by design.** The 150 s `Promise.race` cap
  resolves `{timedOut:true}` and the step is recorded as a *success*, not a skip — so a
  daily run where the full order reconcile never completed still reports `ok: true`. Only
  the note in the summary JSON reveals it.
- **The `alertWebhookRejections` threshold is an exact equality** (`n === 6`). If two
  rejections land between counts (concurrent receivers) and the observed count jumps 5→7,
  no alert fires that hour. The comment frames the equality as an intentional rate limit,
  but it is also a miss condition. It can also never fire for `slack` or (today) for
  `scripting`, since neither calls it.
- **Both raws watchdogs are one-shot per project, permanently.** `reconcileRawsMissing`
  bails on `if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;`
  (`tasks.ts:1561`) — existence, not open-ness. Once the task has been minted and closed,
  a later shoot on the same project that loses its raws is never chased again. Same shape
  for `photos-undelivered-<pid>-0` in `deliveryWatch.ts` (there it is the stated intent:
  *"one alert per job, ever"*) and for `raw-video-missing-<pid>`.
- **A retried webhook gets exactly one more chance.** `retryFailedWebhooks` moves a
  still-failing row to `FAILED`, which is terminal — nothing re-runs it, and it only stays
  visible in `webhookErrorCount()` until the 30-day `webhookLogTrimmed` purge deletes it.
- **`syncDropboxFolderStatus` (`src/lib/dropboxFolders.ts:152`) is manual-only.** Its sole
  caller is `src/app/connections/actions.ts:190`, a button. The Dropbox evidence that
  actually drives production status hourly comes from `syncProjectStatuses` reading folders
  itself — so the "final media detected → REVIEW" transition in `dropboxFolders.ts` only
  happens when someone presses the button.
- **The hourly `statuses` step is capped at 80 projects** (`opts.limit ?? 80`, ordered by
  `updatedAt desc`). With more than 80 live jobs, the tail of the list is only reconciled
  when its `updatedAt` moves.
- **`.env.example` is stale.** It documents only `DATABASE_URL`, `APP_SECRET` and
  `NEXT_PUBLIC_APP_URL`. `CRON_SECRET`, `SLACK_SIGNING_SECRET`, `SCRIPTING_WEBHOOK_SECRET`
  and `SLACK_ALERT_CHANNEL` — all of which change automation behaviour, two of them
  fail-closed — are absent.
- **Kyle's `TeamMember.phone` is the company OpenPhone line.** `notifyStaffSms` detects this
  and returns `own-line`, relaying to Slack instead. It is handled, not fixed — the data
  problem is still live, and the code says so (`notify.ts:141-144`).
- **Remar has no reachable channel.** `EDITORS.remar` has `teamMemberName: "Remar"` but no
  `slackUserId`, and the comment notes she has no TeamMember phone yet, so
  `channelForEditor` falls through to the ops-Slack relay path for everything addressed to
  her.
- **`SLACK_ALERT_CHANNEL` unset means alerts may land in Kyle's DM.** `alertDestination()`
  falls back to a hard-coded Slack user id `U07SCBTPDC7` when no ops-shaped channel is
  found. Cron-degradation and webhook-rejection alerts — owner-grade signals — would then
  go to Kyle privately.
- **`Notification` has only a `createdAt` index.** The bell's hot query filters on
  `audience contains "<ROLE>"` (a JSON substring scan) plus `userKey`, neither indexed.
  Fine at this team's size; worth knowing.
- **`replyPulse` (`commsSla.ts:238`) is dormant.** Its own comment: *"NOT wired anywhere
  yet; built for the future dashboard/digest."*
- **`PRAISE_RE` in `commsSla.ts:28` is a hand-copy** of the unexported `PRAISE_ONLY` regex
  in `src/lib/comms.ts`, with a "keep the two in sync" comment — a drift hazard with no
  test enforcing it.
- **Frame.io comment→revision is untriggered in practice.** `processFrameioEvent:113-116`
  says the comment branch *"only fires once a comment webhook is registered (the custom
  action alone doesn't send comment events)"*, and the field extraction is explicitly
  marked as unconfirmed against a live trigger.
- **Vercel cron cadence assumption.** `*/5 * * * *` and hourly schedules require a Vercel
  plan that permits sub-daily crons; the repo carries no evidence of which plan is active.
  (unverified)

## 12. Conventions, UI system and operations

This is the "how to work on the Hub" chapter. It covers the machine setup that trips people up,
what every command does, the one date rule the whole app depends on, the small set of shared UI
pieces every screen is built from, and the list of secrets the app needs to run. If you are picking
this codebase up cold — or you are a future Claude session — read this before touching anything.

---

### The environment (read this first)

Three things about this machine break the app if you get them wrong, and all three have bitten
before. They are written down in `AGENTS.md` (which `CLAUDE.md` simply `@`-imports) because they
are not discoverable from the code.

**1. Node 20, never the system Node.** The system Node on Jordan's Mac is 16, which Next 16 refuses
to run. Node 20.20.2 is installed via nvm. `.nvmrc` contains exactly `20.20.2`, and `package.json`
declares `"engines": { "node": ">=20" }`.

```bash
nvm use                                                   # reads .nvmrc
# or, for a non-interactive shell:
export PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH
```

`.claude/launch.json` pins the same interpreter by absolute path — precisely so the preview never
falls through to Node 16. The `dashboard` config runs
`/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin/node node_modules/next/dist/bin/next dev`
on port 3000 with `autoPort: true`.

**2. `rm -rf .next` on the React Client Manifest error.** If dev 500s with
*"Could not find module global-error.js in the React Client Manifest"*, that is a corrupted
Turbopack cache, not a code bug. Delete `.next` and restart. Do not delete `.next` while the server
is live.

**3. Never two writers on one `.next`.** Two dev servers, or `npm run build` while the preview dev
server is running, both write the same `.next` directory and corrupt the Turbopack cache. Symptoms
recorded in the project memory (`~/.claude/projects/…/memory/project-tech-setup.md`) are
`Cannot find module ../chunks/ssr/[turbopack]_runtime.js` and
`Persisting failed: Another write batch or compaction is already active`, with every route 500ing.
Recovery: stop the preview → `pkill -9 -f next` → `rm -rf .next` → restart. For a deploy: stop the
preview **first**, then build, then deploy.

**Stack, exactly.** Next `16.2.9` (App Router) · React `19.2.4` / react-dom `19.2.4` · TypeScript 5
· Tailwind **v4** · Prisma + `@prisma/client` `6.19.3`. Supporting deps that matter: `jose` (session
JWTs), `clsx` + `tailwind-merge` (the `cn()` helper), `lucide-react` (every icon in the app),
`date-fns`, `leaflet` + `@types/leaflet` (the schedule map), `pdf-lib` (editor-brief PDF),
`html2canvas-pro` (feedback-widget screenshots), `plaid` + `react-plaid-link`, `tsx` (runs the seed
and the one-off scripts), `dotenv` (dev-dep, for the `scripts/` one-offs). Note `prisma` itself is a
**runtime** dependency, not a devDependency — `npm run build` shells out to `prisma generate`.

There is **no `tailwind.config.js`**. Tailwind v4 is configured CSS-first: `postcss.config.mjs`
loads `@tailwindcss/postcss`, and `src/app/globals.css` does `@import "tailwindcss"` plus an
`@theme inline { … }` block that maps CSS custom properties onto Tailwind colour names.

`tsconfig.json` is strict, `noEmit`, `moduleResolution: "bundler"`, and defines the single path
alias `@/*` → `./src/*`. Every internal import in the codebase uses `@/…` — relative `../../`
imports are not the house style.

**There is no test suite.** `package.json` has no `test` script and there is no test runner in
`devDependencies`. Verification in this project is done by reading the code, running the app, and
(historically) multi-agent audit passes — see the audit references in the project memory.

---

### Every npm script

| Script | Command | What it does |
| --- | --- | --- |
| `npm run dev` | `next dev` | Local dev server (Turbopack) on :3000. Prefer the `.claude/launch.json` preview so the Node-20 binary is guaranteed. |
| `npm run build` | `prisma generate && next build` | Production build. Regenerates the Prisma client first (belt-and-braces — `postinstall` already does it). |
| `npm start` | `next start` | Serve a built app. |
| `npm run lint` | `eslint` | Flat-config ESLint 9 (`eslint.config.mjs` = `eslint-config-next/core-web-vitals` + `/typescript`, with `.next/`, `out/`, `build/`, `next-env.d.ts` ignored). |
| `postinstall` | `prisma generate` | Runs on every `npm install` (local and on Vercel) so the generated client is never stale. |
| `npm run db:push` | `prisma db push` | Pushes `prisma/schema.prisma` to whatever `DATABASE_URL` points at. **See the gotcha — that is production.** |
| `npm run db:seed` | `tsx prisma/seed.ts` | The **demo** seed: wipes activity/checklists/deliverables/projects/clients/team/resources/SOPs and writes fictional sample data. Also the `prisma.seed` hook. |
| `npm run db:seed:clean` | `tsx prisma/seed-clean.ts` | The **production-safe** seed: team + resources + SOPs only, all upserts/count-guarded, no demo clients or projects. Its header says real data comes from Aryeo. |
| `npm run db:studio` | `prisma studio` | Spreadsheet-style browser over the live database. |
| `npm run db:reset` | `prisma db push --force-reset && npm run db:seed` | **Destructive.** Drops and recreates everything, then loads the demo seed. |

There is also `prisma/seed-playbook.mjs` (223 lines; `seed.ts` is 466 lines, `seed-clean.ts` 69) and
a `scripts/` folder of eight one-off `tsx` utilities — `backfillComms.ts`, `backfillOpenPhone.ts`,
`backfillSlack.ts`, `ingestKnowledge.ts`, `seedHubGuide.ts`, `seedPlaybook.ts`, `auditOwnerTier.ts`,
`_setbf.ts` — none of which are wired to an npm script; they are run by hand with `tsx`.

---

### Deploying

The app is on Vercel. `.vercel/project.json` records `"projectName": "realtour-pilot-hub"`
(projectId `prj_tC9t7sZB4QsDoStiWjEuABUWkN82`, org `team_mHuw13legZgwAo5GNXOT4n8e`). The live URL is
`https://realtour-pilot-hub.vercel.app`.

The deploy command recorded in the project memory (`project-tech-setup.md`, not in the repo — the
repo has no deploy script) is:

```bash
npx vercel@latest deploy --prod --yes --scope=realtour-pilot-s-projects
```

The Vercel CLI session is cached on this machine, so no `VERCEL_TOKEN` is needed; verify with
`npx vercel whoami --scope=realtour-pilot-s-projects`. Run it from the repo root (already linked via
`.vercel/`). Stop the local preview before building — see gotcha 3 above.

**`vercel.json` is only crons.** Three schedules, and the split is deliberate (Neon egress cost —
the daily route's own header says "Run once a day … to keep Neon data transfer low"):

| Path | Schedule | Route file |
| --- | --- | --- |
| `/api/cron/gmail` | `*/5 * * * *` | `src/app/api/cron/gmail/route.ts` (`maxDuration = 120`) |
| `/api/cron/sync` | `0 * * * *` | `src/app/api/cron/sync/route.ts` (`maxDuration = 300`) |
| `/api/cron/daily` | `0 8 * * *` | `src/app/api/cron/daily/route.ts` (`maxDuration = 300`) |

A **fourth** route lives under `api/cron/` but is deliberately *not* scheduled:
`src/app/api/cron/relabel-deliverables/route.ts` (`maxDuration = 300`) — "Manual maintenance trigger
(NOT scheduled): re-derive deliverable labels from the live order items so a change to the
premium-product rules takes effect on existing projects." It is `CRON_SECRET`-gated like the rest, so
you fire it by hand with a bearer header.

Every cron route fails **closed**: `src/app/api/cron/daily/route.ts:17-21` refuses with 401 when
`CRON_SECRET` is unset *and* the process is production or on Vercel — "losing an env var never fails
open." Cron work is wrapped by `cronBudget(budgetMs, startedAtMs, job)` in `src/lib/cron.ts`, which
stops starting new steps once the budget is spent (250 s under the 300 s routes, 100 s under gmail's
120 s — "~50s headroom"), records every invocation as a `CronRun` row, and Slack-pings on failure —
but only when the failure *signature* (errored step names + skipped list, `failureSignature()`)
differs from the previous run, so a persistent outage alerts once rather than every tick. The
`CronRun` row is created **eagerly**, before any step runs, so a hard-killed run leaves a row with
`finishedAt = null`.

`next.config.ts` carries three deliberate settings, each with its reason in a comment:
`turbopack.root` pinned to `__dirname` (to ignore a stray `package-lock.json` in the home
directory); `experimental.serverActions.bodySizeLimit: "8mb"` (Ask-the-Hub photo attachments ride a
server action as base64 and the 1MB default rejected a single phone photo); and a `headers()` block
adding `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, a two-year HSTS
with preload, and `X-DNS-Prefetch-Control`.

**There is no git remote** (`git remote -v` is empty). Commits live on this machine only, and
deploys go straight from the working tree via the CLI. Commit messages are written in plain business
English — e.g. `Replies: every inbound text, answered`, `Project Tracker: a delivery board built on
the real turnaround promises` — with a long body explaining the *why* and what was verified.

---

### Folder layout

```
src/
  app/          route segments (App Router) — one folder per page, plus api/
    actions.ts        top-level server actions ("use server")
    emailActions.ts   Gmail send actions
    layout.tsx        fonts + theme boot script + <Shell>
    loading.tsx       skeleton shown during every navigation
    not-found.tsx
    globals.css       the entire design-token system
    api/          activity · auth · cron · file · frameio · google · health ·
                  media · notifications · projects · quickbooks · webhooks
  components/   UI. Root-level = app chrome (Shell, Sidebar, PageHeader,
                NotificationsBell, ThemeToggle, ViewAsBanner, PipelineBoard,
                ProjectCard); then one folder per feature area (project/,
                tasks/, comms/, finance/, shoot/, review/, editing/, …);
                ui/ = the shared primitives.
  lib/          domain logic — 83 top-level modules. prisma.ts, queries.ts,
                pipeline.ts, datetime.ts, palette.ts, utils.ts, tasks.ts, payroll.ts, …
    auth/         access.ts, guards.ts, jwt.ts, google.ts, session.ts, user.ts,
                  password.ts
    integrations/ one file per external system (aryeo, openphone, dropbox,
                  slack, google, quickbooks, stripe, plaid, frameio, scripting,
                  ai) + crypto.ts, connections.ts, registry.ts
    data/         static JSON (aryeoTerritories.json)
  middleware.ts login gate + page-level role routing (edge)
  generated/    empty — gitignored Prisma output dir that is no longer used
prisma/         schema.prisma · seed.ts · seed-clean.ts · seed-playbook.mjs
scripts/        one-off tsx utilities
```

Conventions inside that layout, all verifiable:

- **`src/lib/` is the only place domain logic lives.** Pages compose; they do not query. `queries.ts`
  describes itself as "the dashboard's single data door" and re-exports types from `qc.ts` so pages
  never reach past it.
- **Pages are server components by default.** 105 of the 391 `.ts`/`.tsx` files under `src/` carry
  `"use client"`; 45 carry `"use server"`. 71 files declare
  `export const dynamic = "force-dynamic"` — the whole app is DB-backed and uncacheable, which is
  exactly why `src/app/loading.tsx` exists ("every page is force-dynamic + DB-backed, so without
  this the user sees a blank frame").
- **Server actions guard themselves.** `src/lib/auth/guards.ts` is imported by the action files, not
  by pages: "Middleware only gates page navigation, not the POST that invokes a `use server`
  action — so sensitive actions must guard themselves." The guard family is `requireRole` /
  `requireOwner` / `requireAdmin` / `requireTaskAccess` / `requireShootAccess` /
  `requireDeliverableAccess` / `requireUploadFileAccess`, and every one of them is a no-op *only* in
  local dev and fails closed in prod.
- **Server-only modules say so.** 80 files open with `import "server-only"` — effectively every
  `src/lib/` module that touches Prisma or a secret (`storage.ts`, `integrations/crypto.ts`,
  `auth/guards.ts`, …). The notable exceptions are the pure-computation ones: `datetime.ts`,
  `palette.ts`, `utils.ts`, `pipeline.ts`, `text.ts` are safely importable from client components,
  and `src/lib/auth/jwt.ts` deliberately omits it because middleware runs on the edge and must
  import it ("Edge-safe session token helpers (no next/headers, no node-only APIs)").
- **Long routes declare their budget.** `maxDuration = 60` on `/my-pay`, `/sales`, `/trends`,
  `/connections/banks`; `300` on the sync/daily/relabel-deliverables crons and
  `/api/media/download`; `120` on the gmail cron.
- **Nav is data, not markup.** `src/lib/auth/access.ts` owns `PAGES` (key/label/href/ownerOnly),
  `ROLE_PAGES` (the per-role default set) and `canAccess()`; `src/components/Sidebar.tsx` renders
  its own `SECTIONS` array filtered through `canAccess()`; `src/middleware.ts` maps a pathname back
  to a `PageKey` via `pathKey()` over the same `PAGES` list. Adding a page means touching the
  `PageKey` union, `PAGES`, the relevant `ROLE_PAGES` entries, and the Sidebar's `SECTIONS` — one
  concept, four small edits, not one.
- **Retired page keys are kept deliberately.** `map`, `billing`, `payouts`, `team` survive in the
  `PageKey` type but are **gone from `PAGES`**, so stored per-user permission JSON keeps resolving;
  `canAccess()`'s `LEGACY` map folds them onto the page they merged into (`map → schedule`,
  `billing`/`payouts` → `sales`, `team` → `users`, plus `today`/`history` → `tasks`). Their routes
  — and `/today`, `/queue`, `/history`, `/texts` — are redirect stubs with **no** PageKey, so
  `pathKey()` returns null, any signed-in user may take the hop, and the destination enforces access
  itself. Every stub forwards its query string so deep links survive.

---

### The ET-everywhere date rule

RealTour Pilot runs on Eastern time — Lititz PA, 215/610 area codes. Vercel runs its servers in UTC.
If you format a date with the plain browser/date-fns API on the server, a 1:00 PM shoot renders as
"5:00 PM" and Jordan's team goes to the wrong house at the wrong time. This actually happened. So:
**every date the user sees, and every day-boundary the app computes, goes through
`src/lib/datetime.ts`.** 85 files import it.

The module header states the rule outright: *"All RealTour dates are shown/bucketed in US Eastern
(the business runs on ET). The server runs in UTC (Vercel), so date-fns `format()` would show UTC
times — e.g. a 1pm EDT shoot as '5:00 PM'. Use these Intl-based helpers instead."* It has zero
dependencies — everything is `Intl.DateTimeFormat` with `timeZone: "America/New_York"` (exported as
`TZ`).

**Display helpers** (all tolerate `Date | string | null | undefined` and return `""` for nothing):
`etTime`, `etDate`, `etDateTime`, `etMonthDay`, `etDateYear`, `etMonth`, `etDayNum`, `etFullDate`.

**Bucketing and arithmetic:**

| Helper | Signature | What it gives you |
| --- | --- | --- |
| `etDayKey` | `(d: Date) => string` | The ET calendar day as `"YYYY-MM-DD"`, via the `en-CA` locale (which formats ISO-style natively). This is the app's canonical day identifier — task days, pay days, feed groupings. |
| `etDaysAgo` / `isTodayET` / `isYesterdayET` | `(d: Date)` | Whole-day distance from today in ET (`+past, -future, 0 today`), and the two obvious predicates on top. |
| `etDayStartUtc` | `(d = new Date()) => Date` | ET midnight of that day, returned as a real UTC instant — the thing you put in a Prisma `gte`/`lt` range. |
| `etAddDays` | `(d, days)` | Plain ±86 400 000 ms. |
| `etAt` | `(dayKey, hour, minute = 0) => Date` | A wall-clock ET time on an ET day, as a real instant. DST-safe. |
| `etEndOfDay` | `(dayKey) => Date` | `etAt(dayKey, 17)` — 5pm ET, "the default when a due date has no time." |

Two pieces of hard-won DST reasoning are worth preserving verbatim, because they are invisible from
the code shape:

`etDayStartUtc` (`datetime.ts:41-49`) samples the ET offset twice — once at `d` to build a guessed
midnight, then again *at that guess* to produce the real one. The comment records the bug:
*"DST flips at 2am, never midnight, so the offset AT the guessed midnight (within ±1h of the true
one) is always the right one. Sampling only at `d` was an hour off whenever d sat on the other side
of a transition from the midnight it was deriving (every DST eve/day)."*

`etAt` (`datetime.ts:52-67`) exists because hand-written offsets drift twice a year:
*"`'…T17:00:00-04:00'` is 5pm Eastern for eight months of the year and 4pm for the other four, and
`'…T17:00:00Z'` is 1pm Eastern in summer and noon in winter — both silently drift when the clocks
change."* It resolves the day by anchoring at noon UTC (7–8am ET, unambiguously the same ET day
either side of a flip) and adding the wall-clock offset to that midnight. It was added in commit
`1ebba0f` ("Dates: one DST-safe helper for wall-clock ET, and fix three drifting deadlines",
Aug 4 2026) after a full timezone audit against a known wall clock, which found and fixed three
drifting deadlines: task due dates in `src/app/actions.ts`, Ask-the-Hub task creation in
`src/lib/hubTools.ts`, and owner to-do due dates in `src/app/day/actions.ts`. The same commit fixed
a transcript scan that anchored a month boundary at midnight UTC and therefore started at 8pm ET on
the last day of the *previous* month.

**When it is acceptable to bypass the helpers.** A number of files call
`toLocaleDateString`/`toLocaleTimeString` directly but always pass
`timeZone: "America/New_York"` (e.g. `src/app/schedule/page.tsx:173`, `src/app/day/page.tsx:42`,
`src/components/map/ProjectMap.tsx:50`, `src/components/tracker/DeliveryBoardView.tsx:37`). That is
correct behaviour, just not routed through the shared helper. `src/components/tasks/DoneView.tsx:47`
deliberately skips the timezone because its input is already an ET day key, and says so in a
comment. `src/lib/hubTools.ts` keeps some `-05:00` anchors on purpose — commit `1ebba0f` notes they
are midday anchors feeding `etDayStartUtc`, and "noon +/- an hour never crosses a day."

---

### The design system

Every screen in the Hub is assembled from a handful of shared pieces so the app reads as one product
rather than forty pages. Jordan's brief was "elegant, high-tech" and matched to realtourpilot.com:
near-black canvas, hairline borders, burnt-orange accent, Inter.

#### Tokens (`src/app/globals.css`)

All colour lives in CSS custom properties on `:root`, re-exported to Tailwind through
`@theme inline` so `bg-surface`, `text-muted`, `ring-brand/20` etc. all work. Dark is the default
(`color-scheme: dark`); light mode is the *same token contract* re-valued under `html.light`.

| Token | Dark | Light |
| --- | --- | --- |
| `--background` | `#0a0a0a` | `#f6f5f2` |
| `--surface` (cards/panels) | `#141414` | `#ffffff` |
| `--surface-2` (insets, hovers, chips) | `#1c1c1c` | `#f1efeb` |
| `--foreground` | `#f2f2f2` | `#1a1a1a` |
| `--muted` / `--muted-2` | `#9b9b9b` / `#6a6a6a` | `#5c5c5c` / `#8a8a8a` |
| `--border` / `--border-strong` | `rgba(255,255,255,.08)` / `.16` | `rgba(20,20,20,.1)` / `.2` |
| `--brand` | `#e96320` | `#d95816` ("a touch deeper so white-on-brand stays readable") |
| `--success` / `--warning` / `--danger` | `#34d399` / `#fbbf24` / `#f87171` | `#059669` / `#b45309` / `#dc2626` |
| `--radius` | `0.875rem` | — |

Each semantic colour has a translucent `--*-soft` companion (`--brand-soft`, `--success-soft`,
`--warning-soft`, `--danger-soft`), plus `--brand-fg` (`#ffffff`, unchanged in light) for text on a
brand fill. Only the tokens listed in the `@theme inline` block become Tailwind class names —
`--chip-ink`, `--chip-ink-mix`, `--hue-ink-mix` and `--radius` are read directly in CSS/inline
styles, not as utilities.

Three tokens exist purely to keep coloured chips legible on both canvases: `--chip-ink`
(`#ffffff` dark / `#1f1f1f` light), `--chip-ink-mix` (`18%` / `42%`) and `--hue-ink-mix`
(`0%` / `40%`). They are consumed by `Badge` and `ink()` — see below.

Utility classes defined there: `.eyebrow` (11px, uppercase, `0.14em` tracking, brand-coloured — "the
brand motif"), `.panel-shadow` (inner top highlight + drop shadow on dark; soft shadow only on
light), `.lift` (2px hover raise, disabled under `prefers-reduced-motion`), and `.scroll-thin` (8px
unobtrusive scrollbars, used on board columns and the main scroll area). A `@custom-variant light`
is declared so `light:` works as a class-based mirror of Tailwind's `dark:`.

The body carries a "subtle high-tech vignette" — a faint copper radial glow at the top plus a white
sheen, `background-attachment: fixed`. The light theme keeps the copper and swaps the sheen for a
paper wash.

#### The chip palette (`src/lib/palette.ts`)

One harmonized set of ten hues, all around 64–70% lightness, so every status / segment / vendor /
role chip in the app feels like one family:

```
gray #9aa4b2 · blue #6ba3d6 · teal #4fb3a6 · green #5cb98a · indigo #8b93e6
violet #b389d6 · gold #d4a95f · rose #d782ac · red #ec6a6a · brand #e96320
```

The file's header states the rule that keeps it coherent: **red is alerts only and brand orange is
brand/accent only — they are intentionally not in the rotation.** `soft(hex, alpha = 0.16)` returns
a translucent tint for chip/inset backgrounds. `src/lib/pipeline.ts` builds every pipeline stage's
`color`/`soft` pair from `PALETTE` + `soft()`, so the board, the badges and the legends can never
drift apart.

#### `Section` — the one canonical panel (`src/components/ui/Section.tsx`)

The card primitive, used by 15 files. Its header comment: *"the one canonical 'panel' used across
the app so every page reads with the same rhythm."* A `rounded-2xl border bg-surface` card with
`panel-shadow`, a `border-b` header row (icon in a 7×7 rounded tile + title + optional count pill +
right-aligned `action`), and a `px-5 py-4` body.

```tsx
<Section icon={Package} title="Ordered deliverables" count={3}>…</Section>
```

Props worth knowing: `flush` when the body owns its own padding (a `divide-y` list of `px-5 py-3`
rows), and `tone="warning"` for the amber highlight variant (`border-warning/30 bg-warning-soft/40`,
warning-tinted icon tile and title).

#### `Badge` and `ink()` (`src/components/ui/Badge.tsx`)

Used by 41 files. Pass a hex `color` and it derives everything: background = that hue at 15% alpha,
inset ring = 24%, and the text is `color-mix`ed toward `--chip-ink` by `--chip-ink-mix`. That mix is
the whole point — the ~65%-lightness palette would be unreadable as plain text on a white card, so
on light it sinks 42% toward near-black; on dark it lifts 18% toward white (the historical value,
kept so dark mode is pixel-identical to before the light theme existed). When `color` is *not* a
6-digit hex it is used verbatim as the text colour and `soft` (or `var(--surface-2)`) as the
background — that is the escape hatch for token-coloured chips.

`ink(color)` is the standalone version for any inline `style={{ color: someHue }}` chip or icon
outside a Badge; it mixes by `--hue-ink-mix`, which is `0%` on dark (raw hue, untouched) and `40%`
on light. `Dot` is an 8px (`size-2`) rounded span for status legends.

#### `AutoTextarea` (`src/components/ui/AutoTextarea.tsx`)

A textarea that grows with what you type, `minRows = 1` → `maxRows = 12`, then scrolls. Its comment
records the origin: the old boxes were fixed at one to four rows, *"so anything longer than a
sentence scrolled inside a slot too small to read it — you couldn't see what you'd written while
writing it. Kyle filed exactly this from Ask the Hub, where the composer was `rows={1}` AND
`resize-none`: one line, no handle, no growth."* Two implementation notes are load-bearing: it sets
`height = "auto"` before measuring because *"scrollHeight never reports LESS than the current
height, so without this the box grows and never shrinks back"*; and it resizes in a
`useLayoutEffect` keyed on `value`, not on `onInput` alone, so it also shrinks back after a send
clears the field. It forwards its `ref` through a callback so the @-mention surfaces can drive the
caret. `MentionTextarea` (`src/components/mentions/MentionTextarea.tsx`) is built on it.

#### `Avatar` (`src/components/ui/Avatar.tsx`)

A coloured circle with up-to-two initials from `initials()` in `src/lib/utils.ts`. `size` (default
28) drives width, height and font size (`size * 0.4`). Default colour `#6366f1`; in practice each
`TeamMember` row carries its own `avatarColor` (the seeds assign one per person).

#### `Markdown` (`src/components/ui/Markdown.tsx`)

A 111-line dependency-free renderer, deliberately not a general parser: *"Tiny, dependency-free
markdown renderer for our own controlled content (training summaries + SOPs)… Not a
general-purpose parser — just what we author."* Every block renders as a `<p>`/`<ul>`/`<table>` —
even headings, which become styled paragraphs rather than real `<h*>` tags. It handles
`#`–`######` headings (h1/h2 → 14px semibold, h3+ → an 11px uppercase `text-muted-2` label, not the
copper `.eyebrow`), `-`/`*`/`•` bullets, `1.` ordered lists,
`**bold**` and `*italic*`, `>` blockquotes (brand-bordered callout), `---` rules, and pipe tables
(first column left-aligned, the rest right-aligned and `tabular-nums`, wrapped in an
`overflow-x-auto scroll-thin` container).

#### Other shared primitives

| Component | What it does |
| --- | --- |
| `PageHeader` (`src/components/PageHeader.tsx`) | Sticky, `backdrop-blur-xl`, `bg-background/70` header with optional `eyebrow` (the copper uppercase label), `title`, `subtitle` and right-aligned `actions`. |
| `BackLink` (`ui/BackLink.tsx`) | Returns you where you *actually* came from. Reads the `rtp_nav` session counter the Shell bumps on every route change; > 1 means in-app history so it calls `router.back()`, otherwise it follows the fallback `href` to a section page. Renders a real `<a>` so middle/cmd-click and no-JS still work. Exists because "Next 16's App Router doesn't expose a history index." |
| `CopyButton` (`ui/CopyButton.tsx`) | Copy-to-clipboard with a 1.5s check-mark; swallows clipboard-blocked errors. |
| `ShowMore` (`ui/ShowMore.tsx`) | Renders the first `initial` (default 5) children plus a "Show N more" toggle. |
| `ThemeToggle` | Flips the `light` class on `<html>` and persists `rtp_theme` in localStorage. Renders its icon only after mount "so the icon always matches the real document state (no hydration guess)". |
| `loading.tsx` / `not-found.tsx` | App-wide skeleton and a friendly 404 with a Back-to-dashboard button. |

#### The shell (`src/components/Shell.tsx`, `src/components/Sidebar.tsx`, `src/app/layout.tsx`)

`layout.tsx` loads Inter (`--font-inter`) and Geist Mono (`--font-geist-mono`) via `next/font/google`,
resolves the current user server-side, passes a **serializable subset** (name/email/role/permissions/
impersonating/realName) to the client `Shell`, and injects a pre-paint theme boot script so a
light-mode user never sees a dark flash.

`Shell` is the app chrome: a static 16rem sidebar at `lg+`, and on mobile a hamburger top bar plus a
slide-in drawer. Two z-index values are deliberate — the backdrop is `z-[1200]` and the drawer
`z-[1300]`, because *"z must clear Leaflet map panes/controls (~z-index 1000), or the menu slides in
behind the map on mobile."* The Shell also (a) bumps the `rtp_nav` session counter on every pathname
change for `BackLink`, (b) fires the `/api/activity` usage beacon — skipped for `/login`, `/invite`
and for any impersonating session, "so a preview never pollutes the previewed person's trail" — and
(c) mounts the always-on `FeedbackWidget`. It renders **bare** (no nav at all) on `/login`,
`/invite/*`, `/learn/*`, `/privacy` and `/terms`, because an unauthenticated visitor opens those.

`Sidebar` is `w-64` (16rem) and renders five sections — Operations, Creative, Finance, Knowledge,
System — each filtered by `canAccess()`, with empty sections dropped entirely. Behaviours encoded
there: creatives (EDITOR/PHOTOGRAPHER) see `/resources` relabelled "SOP Center"; "My Pay" is
filtered out for everyone except PHOTOGRAPHER even though `canAccess(OWNER)` allows it (the comment
justifying that still says "owner/admin use `/payouts`" — `/payouts` is now a redirect stub into the
Finance page's Payroll tab, so the reasoning holds but the path in the comment is stale); and an
external "Script Writing" link is injected into Creative only when `SCRIPTING_BASE_URL` is set and
the viewer is owner/admin. When there is **no** signed-in user the nav shows everything — `can()`
short-circuits on `!user` "so the open app is unchanged" pre-cutover. Items may also carry
`soon: true` (rendered as a non-clickable "soon" chip); nothing currently uses it. The footer holds
the user card, `ThemeToggle`, `NotificationsBell` and a sign-out form posting to `/api/auth/logout`.

`FeedbackWidget` is a slim edge tab rather than a floating pill "(not a floating pill — it kept
sitting on top of content/action bars)", and lifts itself to `bottom-40` on `/shoot/[id]` where the
photographer screen has a two-row sticky action bar.

---

### The commenting convention

This is the single most important convention in the repo, and it is why the code is worth reading.
Roughly **7,700 of the ~69,800 lines under `src/` are `//` comments (~11%)**, and they are almost
never restatements of the code. The house rule, visible everywhere, is: **a comment explains WHY,
and records the bug that made it necessary.**

Representative examples, all real:

- `src/lib/datetime.ts:44-46` — why the DST offset is sampled twice, and exactly which days the
  one-sample version was wrong on.
- `src/middleware.ts:49-52` — *"In production / on Vercel the gate is ALWAYS on regardless of
  `AUTH_ENFORCE` — losing the env var must fail CLOSED, never silently open every page against the
  shared prod database (audit crack #26)."*
- `src/lib/auth/guards.ts:46-52` — why editors can act on their own tasks: *"the day Kim/Remar get
  accounts they'd hit 'You don't have access' on their own finished work (audit crack #28)."*
- `src/lib/auth/guards.ts:93-96` — why "view as" blocks field actions: *"a previewing owner tapping
  Send on the shoot screen would REALLY text the client."*
- `src/lib/cron.ts:44-45` — why the `CronRun` row is created eagerly: *"so a hard-killed run still
  leaves a visible row with no `finishedAt` — the one failure mode a write-at-the-end log can never
  capture."*
- `src/lib/integrations/quickbooks.ts:23-31` — why `QBO_ENV` picks credentials *and* host together:
  *"a sandbox refresh token replayed against the production host fails with a misleading auth
  error."*
- `src/lib/text.ts:1-6` — why every inbound channel needs cleaning: Gmail entity-encodes
  apostrophes, Slack escapes `&<>`, Outlook carries zero-width BOMs, *"and the old mid-word
  `.slice()` caps left quotes ending like 'can we make a few cha'."*
- `src/lib/shoot.ts:471-477` — why Street View is queried by coordinates first: *"Verified against
  the live pipeline: coords resolved 6/6 upcoming shoots (full-address lookups failed on
  unit/suite-style addresses)."*
- `src/components/Sidebar.tsx:95-101` — nav items that were *removed*, and the exact snippet to
  paste back when the feature ships.
- `src/app/api/cron/daily/route.ts:30-35` — why the Stripe step runs **first**: it used to run last,
  behind a reconcile step that "can eat the entire budget", so it had not run from cron in weeks —
  *"That single ordering bug is why the books showed a 32% revenue collapse that never happened."*

Several patterns recur and are worth matching when you add code: cite the audit finding number when
a fix came from one (`audit crack #26`, `#28`); state the verification (`Verified: 5pm ET due dates
land at 21:00Z in August and 22:00Z in January`); and when you delete something, leave a note saying
what would restore it.

`prisma/schema.prisma` follows the same rule — its header explains that clients, deliverables,
checklists and the activity timeline are all first-class *"Designed to grow: … so CRM, finance, and
the upload portal slot in later"*, and enum members carry inline explanations
(`REVISION // delivered, then client requested changes — back in production`).

---

### Required environment variables

Discovered by grepping `process.env` across `src/`, `scripts/` and `prisma/`. **Names and purposes
only — no values appear anywhere in this document, and none should ever be written into source.**
Local values live in the gitignored `.env`; production values live in the Vercel project settings.
`.env.example` is the committed template and documents only three (`DATABASE_URL`, `APP_SECRET`,
`NEXT_PUBLIC_APP_URL`).

**Core — the app will not run correctly without these**

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Prisma connection string. `prisma/schema.prisma` declares `provider = "postgresql"`; the real value points at Neon. |
| `APP_SECRET` | Two jobs. (1) HS256 signing key for the session JWT (`src/lib/auth/jwt.ts` **throws at import time** in production if it is missing — "that would make every session token forgeable"). (2) Master key for AES-256-GCM encryption of integration tokens at rest (`src/lib/integrations/crypto.ts`, which throws on *any* deployed environment including previews, so a preview deploy can never encrypt real tokens with the committed dev fallback). It must stay the same value that originally encrypted the secrets in the DB, or nothing decrypts. |
| `NEXT_PUBLIC_APP_URL` | Public base URL of the deployment. Used for OAuth redirect URIs, webhook callback URLs and links inside outbound notifications. Falls back to `https://$VERCEL_URL`, then `http://localhost:3000`. |
| `CRON_SECRET` | Bearer token Vercel Cron presents. Checked identically by all four `/api/cron/*` routes (including the unscheduled `relabel-deliverables`). Missing + deployed ⇒ 401 (fail closed). |
| `AUTH_ENFORCE` | Turns the auth gate on **locally**. For the page gate (`src/middleware.ts`) and the action guards (`src/lib/auth/guards.ts`) production/Vercel enforcement is unconditional, so the flag can only turn it *on*. **But `src/lib/access.ts`'s `isOwnerView()` checks this flag alone** — see the gotcha below. It must be set to the literal string `"true"` in Vercel. |

**Set automatically by the platform (read, never set by hand):** `NODE_ENV`, `VERCEL`, `VERCEL_URL`.

**Integrations**

| Var | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | One OAuth app serving both sign-in (`src/lib/auth/google.ts`) and the Gmail/Calendar/Drive integrations (`src/lib/integrations/google.ts`). |
| `GOOGLE_MAPS_API_KEY` | Street View Static thumbnails on shoot cards (`src/lib/shoot.ts`) and the `/api/health/streetview` diagnostic. Absent ⇒ no thumbnail, no error. |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` | Dropbox OAuth app credentials (`src/lib/integrations/dropbox.ts`); Dropbox is the real file store behind `src/lib/storage.ts`. |
| `SLACK_SIGNING_SECRET` | Verifies inbound Slack event signatures at `/api/webhooks/slack`. |
| `SLACK_ALERT_CHANNEL` | Optional override for where ops alerts land (channel id or `#name`). Without it `src/lib/notify.ts` auto-discovers a `project-tracker`/`alert`/`ops`/`notif` channel the bot is in, cached ~1h, and falls back to Kyle's DM. |
| `QBO_ENV` | `"sandbox"` or anything else (= production). Picks the credential pair **and** the API host together; the connection stamps its environment and `assertEnv()` refuses a token minted in the other one. |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | Intuit production app credentials. |
| `QBO_SANDBOX_CLIENT_ID` / `QBO_SANDBOX_CLIENT_SECRET` | Intuit Development (sandbox) app credentials — Intuit issues these separately and they are not interchangeable. |
| `FRAMEIO_CLIENT_ID` / `FRAMEIO_CLIENT_SECRET` | Adobe IMS OAuth app for the Frame.io V4 editor-review integration. |
| `SCRIPTING_BASE_URL` | Base URL of Jordan's external Script Studio app. Doubles as the feature flag: unset ⇒ the "Script Writing" nav item does not render. |
| `SCRIPTING_API_KEY` | Bearer key the Studio checks on its `/api/v1` requests. |
| `SCRIPTING_WEBHOOK_SECRET` | HMAC secret for inbound Studio webhooks at `/api/webhooks/scripting`. |

**Script-only:** `LIMIT` — an optional cap read by `scripts/backfillOpenPhone.ts` and
`scripts/ingestKnowledge.ts`.

Per-integration API keys that are *not* env vars (Aryeo, OpenPhone, Stripe, Plaid, the Slack bot
token) are stored encrypted in the database `Connection` table and read through
`src/lib/integrations/connections.ts` — that is why `APP_SECRET` must never rotate casually.

---

### Gotchas / known state

- **Three committed files still say SQLite; the schema says Postgres.** `AGENTS.md`'s Stack bullet
  claims *"Prisma 6 (classic generator, SQLite at `prisma/dev.db`)"*; `README.md:49` says *"Prisma 6
  ORM with a local SQLite database (easy to move to Postgres later)"*; `.env.example` ships
  `DATABASE_URL="file:./dev.db"` under the comment *"Local dev today uses SQLite."* In fact
  `prisma/schema.prisma` has `provider = "postgresql"` and the local `.env` `DATABASE_URL` starts
  with `postgresql://`. The file `prisma/dev.db` still exists on disk (gitignored, untracked) as a
  leftover from the SQLite era. Copy `.env.example` verbatim and Prisma will refuse the URL.
- **`npm run db:push` and `npm run db:reset` hit the LIVE database.** There is no separate local DB.
  `db:reset` runs `prisma db push --force-reset` followed by the *demo* seed — pointed at the Neon
  production URL that is in `.env`, that would drop the real business data and replace it with
  fictional agents. Treat both as production commands. The safe seed is `db:seed:clean`.
- **`README.md` is a Milestone-1 document and is substantially out of date.** It describes local
  file storage ("swapping to the real Dropbox API is a single adapter in `src/lib/storage.ts`" —
  that swap has happened; `storage.ts` now writes to Dropbox under `/RealTour Pilot/Hub` precisely
  because "Vercel's filesystem is ephemeral"), describes Ask the Hub as answering only from SOPs, and
  lists integrations as future roadmap items that are live. The roadmap section is history, not plan.
- **`tsconfig.tsbuildinfo` is committed to git** — a 296 KB TypeScript build artifact tracked in the
  repo, and it shows up dirty in `git status` after every typecheck. It should be gitignored.
- **Twelve untracked `_tmp_wf_*.ts` scratch files sit in the repo root** (`_tmp_wf_skepdup.ts`,
  `_tmp_wf_skepticwife*.ts`, `_tmp_wf_skeptic_venmo_cashout.ts`, …, all dated Jul 24). They are
  ad-hoc Plaid/bookkeeping audit scripts that import `./src/lib/prisma` directly. They are not
  wired to anything and are not gitignored — they are debris from the books cleanup.
- **The current branch is `books-cleanup`, not `main`,** and there is **no git remote**. Nothing is
  backed up off this machine; a deploy publishes whatever is in the working tree.
- **`src/generated/` is an empty directory.** `.gitignore` still excludes `/src/generated/prisma`,
  but `schema.prisma` uses the default `prisma-client-js` generator (output into `node_modules`), so
  nothing is ever written there.
- **Three ET-rule violations survive in server-rendered code** (all three verified line-by-line).
  `src/lib/editor-pdf.ts:117-118` formats the shoot date and delivery due date with date-fns
  `format()` and no timezone — on Vercel (UTC) the editor-brief PDF prints a 1pm EDT shoot as 5:00 PM,
  the exact bug `datetime.ts`'s header warns about. `src/components/editing/EditorDay.tsx:200` (a
  server component) does `new Date(u.shootISO).toLocaleDateString("en-US", {weekday, month, day})`
  with no `timeZone`, so an evening shoot can render on the wrong day for the editor.
  `src/components/finance/RevenueTab.tsx:73` labels chart months with date-fns `format(m, "MMM")`
  over UTC-anchored `startOfMonth`, which can slip at a month boundary.
- **The cron cadence in `vercel.json` requires a paid Vercel plan.** The project memory records that
  the account was Hobby at one point, which caps crons at once per day and rejects sub-daily
  schedules at deploy time with *"Hobby accounts are limited to daily cron jobs"*. `vercel.json`
  currently declares `*/5 * * * *`, so either the plan was upgraded or that deploy would fail —
  worth checking before assuming the 5-minute Gmail poll is actually running. (Plan status is not
  verifiable from the repo.)
- **Neon egress, not disk, is the cost ceiling.** What the code says: the daily route's header is
  *"the heavy, full-table maintenance jobs that scan every client / customer-user. Run once a day
  (not every tick) to keep Neon data transfer low"*, and the hourly `/sync` route says the opposite
  side of it — *"Incremental (stops at known orders), so it's cheap. Heavy full-table jobs live in
  /api/cron/daily."* The project memory records the incident behind that split (a frequent full-table
  sweep exhausting Neon's monthly data-transfer quota); that history is not in the repo. Either way,
  do not casually re-run a full Aryeo backfill from a scheduled function.
- **`.env` is missing four vars the code reads:** `FRAMEIO_CLIENT_SECRET`, `GOOGLE_MAPS_API_KEY`,
  `SLACK_ALERT_CHANNEL` and `AUTH_ENFORCE` appear in `src/` but not in the local `.env` key list.
  The first three degrade quietly rather than crashing (no Street View thumbnail, alerts fall back
  to channel auto-discovery, Frame.io stays dormant), which is by design but means their absence is
  invisible. `AUTH_ENFORCE` is different — see the next item. Whether any of them are set in Vercel
  is not verifiable from the repo.
- **One owner-only gate does NOT fail closed, unlike everything else.**
  `src/lib/access.ts:10` — `isOwnerView()` — is `if (process.env.AUTH_ENFORCE !== "true") return
  true;`. It is missing the `NODE_ENV === "production" || Boolean(process.env.VERCEL)` clause that
  `src/middleware.ts:49-52` and `src/lib/auth/guards.ts:18-21` both carry *specifically* so a lost
  env var can't open the app (audit crack #26). If `AUTH_ENFORCE` is not literally `"true"` in the
  Vercel environment, `isOwnerView()` returns `true` for every visitor. Its four call sites all
  guard the Ask-the-Hub chat history (`src/app/assistant/page.tsx:13`,
  `src/app/assistant/history/page.tsx:16`, `src/app/assistant/history/actions.ts:12,25`) — and
  `assistant` is in the EDITOR *and* PHOTOGRAPHER `ROLE_PAGES` sets, so middleware lets creatives
  reach `/assistant/history`. Fix is a one-line change to match the other two.
- **Two different files are called `access.ts`.** `src/lib/auth/access.ts` is the page/role matrix
  (`PAGES`, `canAccess`); `src/lib/access.ts` is the unrelated `isOwnerView()` chokepoint above. The
  import specifiers (`@/lib/auth/access` vs `@/lib/access`) are one character apart in practice.
- **`Avatar`'s default colour `#6366f1` is off-palette.** It is an indigo from Tailwind's default
  ramp, not `PALETTE.indigo` (`#8b93e6`). The same is true of the hardcoded activity-icon colours in
  `src/app/projects/[id]/page.tsx:66-75` (`#d97706`, `#dc2626`, `#0ea5e9`, `#8b5cf6`, `#64748b`) and
  the `#a78bfa` "Premium" chip in `EditorDay.tsx:191` — all pre-date the harmonized palette and were
  never migrated.
- **`/marketing` is half-built and owner-only by accident.** `Sidebar.tsx:95-101` removed it from the
  nav ("Marketing is retired from the nav entirely (coming-soon stub)") but kept the route *and* its
  `PageKey`, with the exact nav entry to restore written in the comment. Unlike the other retired
  routes it is still a full entry in `PAGES` (`{ key: "marketing", label: "Campaigns",
  href: "/marketing" }`) — note the label there is "Campaigns" while the page's own `PageHeader`
  says "Marketing". Because `marketing` appears in `PAGES` but in **no** `ROLE_PAGES` set except the
  owner's implicit all, middleware bounces every admin, editor and photographer who types the URL.
  The page itself is not empty: it lists the 12 most recently delivered projects under a "Social
  scheduling — coming with integrations" badge.
- **`prisma/seed.ts` is destructive demo data.** It opens with eight `deleteMany()` calls
  (`activity`, `checklistItem`, `deliverable`, `project`, `client`, `teamMember`, `resource`,
  `sop` — `prisma/seed.ts:20-27`) and then writes fictional people (Maya Torres, Devin Park, Sam
  Rivera, Lena Cho, "Ana (VA)") who do not work at RealTour Pilot. `seed-clean.ts:10-16` writes the
  same seven-person roster as `upsert`s keyed on email — so even the "production-safe" seed injects
  those five fake team members into a real database (the other two, Jordan and Kyle, are real). Its
  resources/SOPs blocks are `count() === 0`-guarded; the team block is not.
- **The `AGENTS.md` Next.js block is a live instruction, not decoration.** It says this version of
  Next has breaking changes versus training data and directs you to
  `node_modules/next/dist/docs/` — that directory really exists (`01-app`, `02-pages`,
  `03-architecture`, `04-community`, `index.md`). Read it before writing framework-level code.

## Current state: what is live, what is dormant, what is broken

Every item here was verified against the code (and, where a count is given, against the live
database) during the 14 August 2026 documentation pass. Each section above carries its own
`Gotchas / known state` list; this is the consolidated register, ordered by how much it matters.

### Stop-and-fix

**1 — `npm run db:reset` from a developer checkout destroys production.**
There is one `DATABASE_URL` and the repo `.env` points at the live Neon database. `db:reset` is
`prisma db push --force-reset && npm run db:seed`, and `prisma/seed.ts` opens with `deleteMany()`
across `activity`, `checklistItem`, `deliverable`, `project`, `client`, `teamMember`, `resource`,
`sop`. That is **1,496 real projects and 332 real clients**, with no guard, no confirmation and no
migration history to rebuild from. Anyone cloning this repo and following the README's own
quick-start instructions is two commands from deleting the business.

**2 — The daily cron has never once completed a run, and nothing has ever alerted.**
All 29 `daily` `CronRun` rows (08:00 UTC, 16 July → 14 August) have `finishedAt: null`, `ok: false`,
empty `summary`, empty `error`. That is the signature of the Vercel function being killed past
`maxDuration = 300` before `finish()` executes. Because the Slack ping and the owner bell for a
degraded run live *inside* `finish()`, **no alert has ever fired for it**. A code comment claims
this was fixed by a 150s cap; the data says it was not — `cronBudget`'s 250s gate is only checked
*before* a step starts, so a step beginning at t=249s can run to t=399s. Early steps do complete
(log trimming is provably running daily); everything ordered after the step that dies is unverified
and unmonitored. By contrast `sync` is 711 ok / 15 failed and `gmail` 8,723 ok / 4 failed.

**3 — Four webhook receivers accept unsigned POSTs.**

| Receiver | Why it is open | Exposure |
| --- | --- | --- |
| `/api/webhooks/frameio` | `ensureReviewAction()` is the only writer of the token and **has zero callers** — it can never be registered from the app | Anyone with the URL can flip a job to REVIEW and create tasks |
| `/api/webhooks/openphone` | `openPhoneRequestAuthorized` returns `true` when no token is stored | Fake inbound texts → injected tasks, leads and revision flags |
| `/api/webhooks/aryeo` | Verifies only if `Connection.webhookSecret` is set, and **no code path anywhere writes that column** | Unsigned order/status events |
| `/api/webhooks/scripting` | HMAC check passes through until `SCRIPTING_WEBHOOK_SECRET` is set | Silent — and unlike the other three it is **not** in the `/connections` `unsignedProviders` banner |

Slack is the exception and is correctly fail-closed — but it 401s **silently**, writing no
`WebhookEvent` row and firing no alert, so a rotated `SLACK_SIGNING_SECRET` would look like nothing
happening at all.

**4 — `isOwnerView()` fails open.** `src/lib/access.ts:10` returns `true` whenever `AUTH_ENFORCE !==
"true"`, rather than using the fail-closed `enforced()` helper the middleware and guards use. Drop
or typo that env var on a redeploy and `/assistant/history` — Jordan's entire Ask-the-Hub chat log
and analytics — plus `deleteHubChat`/`renameHubChat` open to every signed-in user, and every role
has the `assistant` page. This is the last surviving instance of the pattern a previous audit was
run specifically to eliminate.

**5 — Three pages read a null user as the owner.** `/`, `/editing` and `/edit/<id>` have no
null-user bounce and use `!me ||` / `!viewer ||` to compute owner-ness. A null user in production is
not "nobody" — it is a disabled or deleted account still holding a valid 7-day JWT, or a transient
database failure. On `/` that exposes the revenue, pulse and quality strips; on `/editing`, the full
accountability view; on `/edit/<id>`, full project details and Script Studio links. (Money-bearing
revision asks on `/edit` are still safe — `canSeeRaw` uses a strict positive test.)

**6 — `/api/google/callback` has no CSRF `state` and no auth.** Every sibling flow (login,
QuickBooks, Frame.io) does the state-cookie dance; this one exchanges any `?code` handed to it and
writes the resulting refresh token into the shared encrypted `gmail` map. The token at stake now
covers `gmail.readonly`, `gmail.send`, `calendar.events` (write) and `drive.readonly`.

### Blocked on one action from Jordan

**One Google re-consent unlocks three dormant features.** The scope list declares `gmail.send`,
`calendar.events` and `drive.readonly`, but the live tokens carry only `gmail.readonly` +
`userinfo.email`. Until re-authorisation: email sending 403s, the day planner cannot write calendar
blocks (`/day` shows "shoots only" and the block button never appears), and Meet transcripts cannot
be read. Adding scopes to the array changes nothing on its own — it needs the consent screen.

There is also a chicken-and-egg here: with Google unconsented and no `OwnerMeeting` rows, the
"Scan meetings" button is itself hidden, because the block it lives in only renders when
`meetings.length > 0 || plan.calendarOk`.

### Built but never wired

| Thing | State |
| --- | --- |
| `src/lib/bonus.ts` (277 lines) + `BonusPeriod` / `BonusAward` | Fully written self-funding bonus engine with calibrated Q2 2026 baselines. **Zero importers.** Also, `WEIGHTS.improve` is declared but no `improve` metric row is ever pushed, so 15 of its 100 points are unearnable as written. |
| Frame.io end-to-end | 17 projects carry a `frameioProjectId`; **zero `frameio` `WebhookEvent` rows ever**. The comment→revision receiver has never fired. |
| Script Studio | Exactly **1** project carries a `scriptingId`; 42 webhook events (36 processed, 6 failed). |
| `MediaNote.lane = "EDITOR"` | Zero rows. The editor feedback lane and its `editorKey` scoping are built and unexercised. |
| `HubDocument` | Zero rows — the save-a-document feature has never been used in production. |
| The teach-it loop | Used **twice**, out of 5,825 knowledge items. The KB is in practice still the ChatGPT export + training corpus. |
| The guided field flow | `Deliverable.capturedAt` on 18 rows, `uploadedAt` on 10, `Project.editorBrief` / `reelHook` / `photographerManual` on **0**, `Client.brandColors` / `editingPreferences` on **0**. Built, essentially unused. |
| `PayrollEntry` | **0 rows** — and this one bites. It is the editor/ops cost bridge into the P&L: the exact gap it was built to close is still open, so those costs reach the books only via the Plaid ledger. |
| `Expense`, `CashSnapshot`, `UploadedFile`, `MediaVerdict`, `ChecklistItem` | 0 rows each, with fully-wired code. `UploadedFile` was superseded by direct Dropbox upload; `ChecklistItem` is read and toggled in code but created only by the demo seed. |
| `replyPulse()`, `trueProfitAndLoss()`, `personalSpending()`, `requireUser()`, `requireAccess()`, `frameioPing()`, `deleteFrameioProject()`, `draftReply()`, `aiConfigured()`, `refreshReplyQueue()` | Exported, zero callers. |
| `PipelineBoard.tsx` + `ProjectCard.tsx` | The original drag-and-drop board. Dead code — and because `ProjectCard` is `statusFlag()`'s only consumer, **the status-flag chips render nowhere in the live app**. |
| 13 Aryeo helpers (`createOrder`, `listings`, `availableTimeslots`, `me`, …) | Defined, never called. The Hub has never written an order back to Aryeo. |

### Two engines that disagree

These are the ones most likely to make two screens contradict each other in front of a client.

- **Turnaround.** `turnaround.ts` (delivery board only) and `tasks.ts`'s `deliveryDueFrom`
  (everything else) are independent implementations with different units, inputs and answers. A
  premium reel is "late after 4 days" on `/pipeline` and "due at 72h" in `Project.deliveryDue`.
  Neither imports the other.
- **Job roll-up direction.** `/pipeline` shows the **earliest** outstanding deliverable;
  `Project.deliveryDue` — which every on-time KPI, `getStuckJobs`, the owner pulse and the
  photographer bonus read — uses the **longest**. A job can be past due on Kyle's board and on time
  in the owner's on-time percentage simultaneously.
- **"Today" count.** Three copies of the same predicate: `queries.getTodayCardCount()` (dashboard
  button), `TodayView.todayCardCount()` and `stackWhere()`. They agree today; nothing enforces it,
  and they diverge at DST boundaries.
- **Dashboard money vs Trends money.** `getOwnerStats()` sums `Project.price`; `trends.ts` uses
  `payableInvoice ?? price`. The same job is worth two different amounts on two screens.
- **"Owner pulse" means two different things.** `getOwnerPulse()` in `queries.ts` is operational
  health; `ownerPulse()` in `ownerPulse.ts` is a money snapshot. Same name, different modules, no
  shared code.

### Data quality

- **`Project.squareFeet` is null on 100% of 1,496 rows**, including projects created yesterday. The
  sync code maps `order.listing?.square_feet` and carries a fix note, but it still isn't landing, and
  the write exists **only** in the `create` path — there is no backfill. Consequence:
  `photoTargetFor()` returns **50 for every property regardless of size**, and that flat number is
  what the status engine and Kyle's deliver card enforce.
- **`CommLog.fromPhone` is null on 13,590 of 14,238 text rows (95%).** The reply queue runs on the
  client's-number-on-file fallback for nearly all history, and cannot answer a text from any number
  that isn't the client's primary. *(The 612-row backfill run on 12 August covered only
  client-linked rows from the last 30 days.)*
- **`CommLog` has no `CREATIVE`-tier rows at all** — every one of 31,265 rows is `ADMIN` (17,334) or
  `OWNER` (13,932), so the lowest content tier is a no-op on comms: a creative sees nothing, not a
  filtered subset.
- **`Project.status` is 1,441 DELIVERED of 1,496.** Any full-table scan is scanning delivered
  history, and `@@index([status])` has almost no selectivity.
- **Venmo revenue depends on a hand-maintained array.** `VENMO_CHARGES` covers 2026-01-05 →
  2026-07-16 (22 rows) and the file says so plainly: add new charges by hand *"or the Venmo rail
  silently under-reports"*.
- **A hard-coded `$1,999` subtraction** for one 2026-02-13 clawback sits inside
  `revenueByProcessor`, plus two hard-coded Venmo cash-out values. Correct today; landmines for any
  historical re-run.
- **`YEAR_START` is hard-coded `"2026-01-01"`** in three finance tabs. On 1 January 2027 they will
  still show 2026-to-date.
- **`jobProfitability()` doesn't exclude cancelled projects**, so a cancelled job that kept its
  `shootDate` and `price` shows as a fake 100%-margin row.
- **Money is `Float`, not `Decimal`, in every column.** No rounding bug was reproduced, but the P&L,
  payroll and bonus engines all sum floats.

### Behavioural traps

- **The Gmail thread sweep is too broad.** Any open task with `source: "gmail"` and a
  `gmail-thread:` ref closes once the thread has an outbound reply — including `lead` and Luma
  `vendor_update` tasks. Replying "thanks, got it" to a Luma "edit finished" email closes the
  "Download + QC the finished reel" task before anything was downloaded.
- **The delivery board's blocker runs off a manual tick, not evidence.** `blockerFor` reads
  `Deliverable.uploadedAt`, which only `markDeliverableUploaded` writes when a photographer ticks the
  `/upload` checklist. A job whose photos are live on Aryeo still reads "Waiting on photos" if nobody
  ticked the box — and because that rule fires first, such a job can never reach "Needs QC" or
  "Ready to deliver".
- **A group text answered from the Replies tab goes to one person.** `sendReply` sends to a single
  number and `CommLog` stores no participant list, so it forks a new 1:1 conversation. The Inbox
  thread view is the only group-safe send path.
- **Two of the five outbound text paths never write to `CommLog`** (`sendDraftText`,
  `sendThreadText`) — they rely entirely on OpenPhone's delivery webhook. Since the reply queue
  clears on "newest row is inbound", a dropped webhook leaves those conversations looking unanswered.
- **A task hand-added "for Kyle" lands in "Needs assigning"** rather than in Kyle's own section,
  because `createManualTask` stores `assignedKey: null` for him. Same for Ask the Hub's `create_task`
  and My Day's `createTaskForKyle`.
- **`computePriority` computes "today" in server-local time**, not ET — a 4–5 hour offset on Vercel,
  so shoot-proximity urgency flips early.
- **"Me" and "Kyle" resolve by name substring** (`contains: "Jordan"`, `contains: "Kyle"`). A rename
  or a second person with either name breaks the day planner and Kyle task creation quietly.
- **The Aryeo update pass never re-derives deliverables or order items.** Add a product to an
  existing Aryeo order and the hub's `Deliverable` / `OrderItem` rows stay stale — so the delivery
  board's dates and the status engine's expected-set stay stale too. The re-derivation functions are
  manual one-shots with no caller.
- **Jobs with no `OrderItem` rows never get a due date** and sit in Upcoming forever.
  Booked-but-unscheduled jobs re-date from *today* on every page load and float in "Due tomorrow"
  permanently.

### Stale comments that will mislead you

The codebase's comments are usually load-bearing and accurate. These specific ones are not:

- `src/lib/qc.ts:9` says "NOT WIRED YET" — `getQcStats` is wired in two places (Review Room and the
  dashboard's owner dials). Flagged independently by three of the twelve agents.
- `WebhookEvent.status` schema comment lists 3 values; the code writes 5 (`RECEIVED`, `PROCESSED`,
  `ERROR`, `REJECTED`, `FAILED`) and production holds only 2 (`PROCESSED` 3,668, `FAILED` 6).
- `Notification.kind` comment lists 13 kinds; production has 19, and 5 documented kinds have zero
  rows.
- `PlaidTransaction.financeKind` documents 4 values; the type has 5.
- **Four doc-comment blocks are stranded above the wrong model** in `schema.prisma` — someone
  inserted a model between a comment and its subject. Read the comment nearest the `model` keyword,
  not the top of the block.
- The Email tab still says "no `gmail.send` scope — reply from Gmail", but `sendEmailReply()` sends
  threaded replies today (from task cards).
- `RevenueTab` still renders "QuickBooks & Stripe sync — coming with integrations". Both are live.
- `README.md` describes Milestone 1, SQLite, and every integration as future work.
- **`AGENTS.md` still says "SQLite at `prisma/dev.db`".** The datasource is Postgres on Neon, and
  `prisma/dev.db` (1.5 MB, last touched 17 June) is a stale leftover file. This one matters more than
  the others because `AGENTS.md` is the file loaded into every Claude session as project
  instructions — it is actively teaching each new session something false.

## Glossary

Terms that mean something specific here, and will confuse you if you assume the ordinary
meaning.

| Term | What it means in this system |
| --- | --- |
| **Aryeo** | The industry order/delivery platform the agency sells through. It is the **source of truth for orders and client-facing delivery**; the Hub imports from it and never invents a job. Auth is *vendor-level* — one key for the whole account, so there is no per-customer sign-in. |
| **Project** | One job / one shoot / one listing. The central object. Imported from an Aryeo order. |
| **Deliverable** | One product on a job (photos, standard video, premium reel, floor plan, 3D tour…). **Due dates belong here, not to the Project** — a job with photos and a premium reel has two different promises running at once. |
| **SmartTask** | One unit of work for a human. Created by engines and inbound messages; deduplicated on `dedupeKey`; auto-closed by evidence. |
| **`dedupeKey`** | A unique string on a SmartTask that makes creation idempotent — the same trigger firing twice produces one task, not two. |
| **Auto-close** | A task closing itself because the system saw proof the work happened (files uploaded, media live on Aryeo, an outbound text sent). The most subtle logic in the codebase. |
| **`assignedManually`** | A flag meaning *a human chose this assignee on purpose*. Every automatic engine must leave such a task alone — otherwise work a human deliberately reopened silently vanishes. |
| **CommLog** | The single table holding every text, call transcript, email and Slack message. The system's memory, and what the AI reads before drafting. |
| **`minRole`** | Content sensitivity tier on a CommLog / KnowledgeItem row: `CREATIVE` < `ADMIN` < `OWNER`. A viewer sees their tier and below. Jordan's personal inbox is `OWNER`-only. |
| **`contentTier`** | Folds the four app roles onto that three-rung sensitivity ladder. `EDITOR` and `PHOTOGRAPHER` both become `CREATIVE`. |
| **Turnaround tier** | The delivery promise class for a product: same-day, next-day, 48h video, 3–4 day premium reel, 7–10 **business** days for monthly social packages. Encoded once in `src/lib/turnaround.ts`. |
| **Segment** | The 6-tier client relationship model (VIP, heavy, regular, casual repeat, one-timer, never-converted). Shown as a chip next to every client name. |
| **Reply queue** | `/communications?tab=replies` — every inbound text still owed an answer, each pre-drafted. Built on CommLog rather than tasks, so senders who were never matched to a client still appear. |
| **Draft-then-send** | The rule that governs every client-facing message in the system: the AI writes, a human reads and clicks Send. Nothing auto-sends to a client, ever. |
| **Ask the Hub** | The AI assistant with tool access over live operational data plus the knowledge base. Can read broadly; can create tasks and save documents; **cannot** send anything to a client. |
| **Teach-it loop** | Telling the assistant a fact or correction and having it persist as a `KnowledgeItem` for future answers, gated by `minRole`. |
| **View as** | Owner-only impersonation that renders another role's view read-only, for checking what a photographer or editor actually sees. |
| **ET-everywhere** | Every date and time shown or bucketed is US Eastern, via helpers in `src/lib/datetime.ts`. Hard-coded UTC offsets are a recurring bug source — a literal `-04:00` is correct for only eight months of the year. |
| **Kyle's list** | The task queue as Kyle sees it — role-scoped and simplified. The morning brief renders the same underlying query. |
| **The brain** | `src/lib/brain.ts` — the AI router that decides whether an inbound message is actionable, which job it is about, how urgent it is, and whether it duplicates an open task. |
| **Evidence** | Observable proof of state pulled from outside the Hub: files present in Dropbox, media live on Aryeo, a delivery recorded, an outbound message sent. Drives both status and auto-close. |

---

## Reading this codebase cold

If you are picking this up with no context, read in this order:

1. **`AGENTS.md`** — the environment rules. Node 20, not the system Node 16. Get this
   wrong and nothing runs.
2. **`prisma/schema.prisma`** — the whole shape of the business is in here, and the models
   are commented.
3. **`src/lib/turnaround.ts`** — small, and it encodes the actual promises the business
   makes. Most date logic downstream only makes sense once you have read it.
4. **`src/lib/tasks.ts`** — the task engine, including auto-close. The largest source of
   subtle behaviour.
5. **`src/lib/queries.ts`** — the shared read layer most pages go through.

**The comments are the documentation.** This codebase is commented unusually heavily and
deliberately: comments explain *why* a thing is the way it is, and many record a specific
past bug ("the old to[0]-only pick missed them", "audit 2026-07-08: the old chips read
1 replies / 0 to assign"). Those notes are load-bearing. If you change the code near one,
read it first — it is usually there because someone already got it wrong once.

**Corollary: when you fix something subtle, leave a comment saying what was wrong.** That
convention is why this document could be written at all.
