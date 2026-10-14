# Realtour Pilot Ops Hub: Photo Delivery Automation Plan

**For:** Claude Code, implementing inside the Realtour Pilot Ops Hub repo (Next.js, Vercel, Upstash, Resend, Stripe, Anthropic)
**Owner:** Jordan (Realtour Pilot). Day-to-day reviewer: Kyle (admin/VA)
**Version:** v1, October 13, 2026
**Feature name in code:** `photo-delivery` (route `/ops/photo-delivery`)

---

## 0. Read this first (instructions for Claude Code)

### 0.1 Files in this package

| File | What it is | How to use it |
|---|---|---|
| `01-PHOTO-DELIVERY-PLAN.md` | This plan: architecture, data model, integrations, UI, phases | Primary spec |
| `02-QC-RULES-REGISTRY.md` | Human-readable QC rules (425 rules, one per checklist bullet) | Reference while building the QC engine |
| `qc-rules.seed.json` | Machine-readable rules registry (source of truth) | Copy into the repo (e.g. `src/features/photo-delivery/qc/rules/qc-rules.seed.json`) and load at runtime |
| `03-QC-CHECKLIST.md` | Realtour Pilot Master Photography QC Checklist | The business standard. Keep in repo under `docs/` |
| `04-QC-PROMPT-PACK.md` | Every Claude prompt (P0 to P4, Fix Planner, Post-Fix, Revision Interpreter, Coaching, Summary) with JSON schemas and zod sketches | Implement as versioned prompt constants |

### 0.2 Before writing any code

1. Read `CLAUDE.md` and the repo structure. Map the existing patterns for: auth and roles, data layer (ORM, migrations), background jobs and cron, webhook receivers, notifications, UI component library, env var handling, and tests.
2. Confirm the Ops Hub "Phase 0 stabilization" items are resolved, because this feature depends on all of them: (a) the unguarded database reset, (b) missing migration history, (c) the failing daily cron, (d) unsigned webhook receivers. If any are still open, fix them first or stop and report.
3. Produce a short gap analysis (`docs/photo-delivery/GAP_ANALYSIS.md`): what exists, what this plan needs, and the exact file and folder map you will create. Adapt every path and library in this plan to the repo's conventions. This plan describes behavior; the repo decides structure.
4. Use the AutoHDR MCP (`https://mcp.realestatephotoediting.com/mcp`) in your Claude Code session during development to read the live `listCapabilities` and `listModels` output (transform names, prices, model ids). Never hardcode prices or model ids; read them at runtime (see 5.1).
5. Work phase by phase (section 15). Each phase ships behind a feature flag, ends with its acceptance criteria passing, and gets a short `docs/photo-delivery/PHASE_N_NOTES.md`.

### 0.3 Rules that apply to the whole build

- **Never use em dashes** in any user-facing copy (UI text, notifications, emails, SMS, Slack, Aryeo notes). Jordan's standing rule. Use commas, colons, or periods.
- Client-facing copy uses the "Realtour Pilot Team" identity. Jordan's personal name never appears to clients.
- Facts marked **[VERIFY]** in this plan come from docs that were incomplete or contradictory. Build them behind an adapter and confirm with a live call or vendor answer before relying on them.
- Every external POST that costs money or credits must persist its intent and returned ids **before** any follow-up step, and must never be blindly retried (AutoHDR POSTs are not idempotent yet). See 5.1.4.
- Every webhook receiver verifies its signature against the raw body. No exceptions.
- Every automated decision is logged (who or what, when, why, inputs) in the job activity log.

---

## 1. Goal

When a photographer finishes uploading, the photos should flow with no human touch until a decision is genuinely needed:

```
Photographer upload portal (Ops Hub)
   │  direct browser → Dropbox upload (no files pass through Vercel)
   ▼
Dropbox  /Jobs/<date> <address> (<order#>)/01-RAW
   │  temporary links
   ▼
AutoHDR API  (HDR edit, client's preferred models, free TV/fire enhancements)
   │  poll until done, download finals (1 credit/photo, the normal edit cost)
   ▼
Dropbox 02-AUTOHDR/v1  +  preview derivatives
   ▼
QC Engine  (CV checks + Claude vision: describe, inspect, dust, gallery, original vs edited, order coverage)
   │
   ├─ clean ─────────────────────────────────────────────┐
   └─ issues → Fix Cart (credit cost per fix) → Jordan/Kyle: Fix all / Ignore / Select
                 → AutoHDR transforms → post-fix verification → re-QC
                                                         ▼
                                Photo Delivery Page: preview, order, hero, gate checklist
                                                         ▼
                        [Deliver] → final set staged in Dropbox 04-FINAL-DELIVERY (sequenced)
                                  → Aryeo: tags, internal notes, task (API)
                                  → admin imports from Dropbox + clicks Deliver Listing in Aryeo (about 2 clicks)
                                                         ▼
                        LISTING_DELIVERED webhook → hub verifies Aryeo images match approved set → Delivered
```

### 1.1 Success measures

| Measure | Target |
|---|---|
| Admin hands-on time per standard gallery (about 40 photos) | Under 5 minutes |
| Photo turnaround (appointment end to delivered) | Under 24 hours, with at-risk alerts |
| Galleries delivered with an unresolved CRITICAL issue | Zero (hard gate) |
| Client revision requests | Down 50% within 90 days of launch |
| Credit surprises | Zero (live balance, alerts at 250 and 100, pre-flight checks) |

---

## 2. API evaluation: what is possible and what is not

This section is the result of reading the AutoHDR external API (OpenAPI 3.1 spec v0.1.0), the AutoHDR knowledge base, the Aryeo public API (OpenAPI 3.1, about 95 operations), and the Dropbox and Anthropic docs, as of October 2026.

### 2.1 Summary

| Need | AutoHDR | Aryeo | Dropbox | Decision |
|---|---|---|---|---|
| Receive photographer uploads | n/a | No media upload API | Temporary upload links let the browser upload straight to Dropbox (150 MB per file) | Hub portal → Dropbox direct |
| Send photos to editing | `POST /v1/photoshoots/from-urls` pulls from Dropbox links | n/a | `files/get_temporary_link` (4 h) | AutoHDR API, not the Dropbox watcher |
| Know when edits finish | No webhooks; poll status | n/a | n/a | Durable poller |
| Get edited files | `downloadPhotos` (1 credit/photo first time, re-downloads free, 6 h links) | n/a | `files/save_url` stores them | Save every version to Dropbox |
| Describe each photo | `describePhoto` (free) | n/a | n/a | Use it, plus Claude P0 |
| QC inspection | n/a | n/a | n/a | Claude vision + CV in hub |
| Fix clutter, dust, reflections | `autoremove` (mask), `declutter`, `reedit` (prompt), `camera_removal`, `grass`, `style`, `repaint` | n/a | n/a | Fix Cart with live prices |
| Credit balance | `GET /v1/credits`, `GET /v1/me` | n/a | n/a | Monitor + alerts |
| Upload photos to an Aryeo listing | Only via Aryeo's own AutoHDR integration (manual, started inside Aryeo) | **Not possible via public API** | Aryeo UI can import from Dropbox | Aryeo-assisted delivery (chosen) |
| Deliver the listing | n/a | **Not possible via public API** (`delivery_status` is read-only) | n/a | Admin clicks Deliver in Aryeo; hub verifies |
| Order data (products, photographer, address, instructions) | n/a | Full read access | n/a | Drives intake, QC coverage, SLA |
| Status back into Aryeo | n/a | Order tags, order `internal_notes`, tasks | n/a | Mirror pipeline status |
| Event triggers | n/a | Webhooks (must be enabled by Aryeo for the account), `LISTING_DELIVERED` confirmed | Webhooks | Webhooks + cron reconcilers |

### 2.2 AutoHDR: every use case

Base URL `https://external.realestatephotoediting.com`, routes under `/v1`. OAuth 2 `client_credentials` at `https://new.autohdr.com/api/auth/oauth2/token`. The token request **must** include `resource=https://external.realestatephotoediting.com/v1` or every call returns 401. Scopes: `photoshoots:read photoshoots:write images:edit presets:read presets:run`. Token lasts about 1 hour. Credentials: new.autohdr.com → Account settings → Developer. API requires Standard plan or above; Realtour Pilot is on **Pro (1,000 credits/month, $500/month, $0.50/credit)**, which qualifies. Balance on October 13, 2026: 399 credits.

| Endpoint (operationId) | Credits | Our use |
|---|---|---|
| `GET /v1/me` (getMe) | Free | Health check on deploy; shows `credit_balance` |
| `GET /v1/credits` (getCredits) | Free | Credit monitor (section 10) |
| `GET /v1/capabilities` (listCapabilities) | Free | Live transform catalog: names, versions, `credit_cost`, `requires_mask`, `looks[]` (twilight). Cache 1 h. Drives the Fix Cart cost calculator |
| `GET /v1/models` (listModels) | Free | Indoor and outdoor model list (Iris, Ember, Classic, Lisa, Aura, Fuse, custom) with `style_credit_cost`. Powers the client profile model picker |
| `POST /v1/photoshoots/from-urls` (createPhotoshootFromUrls) | Free | Create the shoot from Dropbox temporary links. Allowed hosts: Dropbox, S3, ChatGPT attachments. **[VERIFY]** that `*.dl.dropboxusercontent.com` links are accepted |
| `POST /v1/photoshoots` (createPhotoshoot) | Free | Fallback: presigned S3 PUT per file (URLs expire in 5 minutes, so only for small sets) |
| `POST /v1/photoshoots/{id}/commit` | Free | Start processing. Retry on 409 `files_not_landed`; 409 `conflict` means already committed |
| `GET /v1/photoshoots/{id}/status` | Free | Poll: `in_progress` / `success` / `failure`, `awaiting_files` |
| `GET /v1/photoshoots` (listPhotoshoots) | Free | Reconciler: find shoots from the last 7 days (also finds shoots started by the AutoHDR Dropbox watcher fallback) |
| `GET /v1/photoshoots/{id}/photos` | Free | List results in gallery order with `image_uuid`, `image_version_uuid` |
| `POST /v1/photoshoots/{id}/photos/download` | **1 credit/photo, first download only** | Get finals (6 h links). Re-downloads, including after fixes, are free (charged per photo, not per version) |
| `POST .../photos/{image_uuid}/describe` | Free | AI description of a photo or a specific version. Feeds room labels, captions, Aryeo notes |
| `GET .../photos/{image_uuid}/history` | Free | Version tree: Original, Enhanced, Twilight, Declutter, AI Edit, etc. Powers before/after and P3 |
| `POST .../photos/{image_uuid}/version` | Free | Set head version: revert a bad fix, or temporarily select Original to fetch it for P3 **[VERIFY]** |
| `POST .../asset-uploads` (kind `mask` or `reference`) | Free | Upload mask PNGs generated from QC bounding boxes |
| `POST /v1/transforms` (submitTransform) | Charges on submit; refunded if failed or no-op | Fixes: `autoremove` (mask), `autofill` (mask + prompt), `declutter`, `reedit` (prompt), `camera_removal`, `grass`, `repaint` (`params.color`), `style` (`model_id`), `twilight` (`params.look`), `single_angle_staging` |
| `GET /v1/transforms/{job_id}` | Free | Poll fix jobs (`queued` / `running` / `succeeded` / `failed`) |
| `GET /v1/transforms?photoshoot_id=` | Free | Recover lost job ids after a crash |
| `GET/POST /v1/presets...` | Preset `credit_cost` per photo | Phase 6 option: one-click packaged edits |

Ingest-time enhancements on photoshoot creation: `grass`, `declutter`, `fireplace`, `tv_replacement {enabled, mode: blackout|beach|mountain|city|custom}`. Fireplace and TV replacement only exist at ingest and are free on Pro. **Declutter is off at ingest** in our pipeline: QC decides per photo, which saves credits.

Hard constraints to design around:

- **No webhooks.** Poll. Shoots take about 15 to 30 minutes (up to 60 for large RAW sets). Transforms take 30 seconds to 2 minutes.
- **7-day retention.** After 7 days every photoshoot endpoint returns 410 `photoshoot_expired`. Save every downloaded version to Dropbox immediately.
- **No idempotency keys yet.** Persist `job_id`/`photoshoot_id` before anything else; on uncertainty, look up state (`listTransformJobs`, `getPhotoshootStatus`) instead of re-submitting.
- **No cost-estimate endpoint.** We compute estimates from `listCapabilities` prices.
- **No usage history endpoint.** We keep our own credit ledger.
- **Rate limits** are not published; honor 429 `Retry-After`.
- **402 `insufficient_credits`** charges nothing; surface it as a blocking alert.

**AutoHDR MCP** (`https://mcp.realestatephotoediting.com/mcp`, OAuth in the browser): exposes the same operations as tools (getCredits, listPhotoshoots, describePhoto, submitTransform, downloadPhotos, etc.). Credit-spending tools ask for confirmation. Use cases for Realtour Pilot: (1) Claude Code development (inspect live catalog), (2) ad hoc admin questions in Claude ("what's our balance", "re-edit photo 14 to brighten the kitchen"). The pipeline itself uses the REST API, because the MCP is an interactive, user-consented flow and does not expose `autoremove`/`autofill` or asset uploads.

### 2.3 Aryeo: what the public API can and cannot do

Base URL `https://api.aryeo.com/v1`, `Authorization: Bearer <personal access token>` (generated at Aryeo admin → Settings → Developer Settings → API Keys). JSON. Pagination `page`/`per_page`. Filters `filter[x]=`. `include=` is undocumented: call `?include=fake` on `/orders/{id}`, `/listings/{id}`, `/appointments/{id}` once to get the valid include list. Mock server for tests: `https://docs.aryeo.com/_mock/api/aryeo`.

**Cannot do (public API):** upload, caption, reorder, hide, or delete listing images; deliver a listing or send the delivery email; change an order's fulfillment status after creation; toggle download locks; register webhooks.

**Can do:** everything in section 11 (order, appointment, customer, product, listing reads; order tags; order internal notes; tasks; order items; appointment scheduling; order form sessions; listing stats; CubiCasa floor plan status; webhooks once enabled).

**Partner path exists but is not public:** Aryeo's own AutoHDR integration imports edits into a listing "within 30 minutes," and Esoft content imports directly. So Aryeo has an internal media import path. The vendor asks in section 17 request access. The delivery layer is built behind a `DeliveryProvider` interface so we can switch to full automation the day either vendor exposes it.

### 2.4 Dropbox

- **Intake:** `files/get_temporary_upload_link` (4 h, one-time, up to 150 MB per file) lets the browser POST bytes straight to Dropbox. No token in the browser, nothing through Vercel (Vercel functions cap request bodies at 4.5 MB). **[VERIFY]** browser CORS on the temporary link in week 1. Fallback for files over 150 MB (video, rare RAW): upload sessions with a short-lived server-minted token.
- **Change notifications:** webhooks (verify `X-Dropbox-Signature`, HMAC-SHA256 of raw body with the app secret; respond within 10 s; then call `files/list_folder/continue` with the stored cursor).
- **Hand files to AutoHDR:** `files/get_temporary_link` (4 h).
- **Store outputs:** `files/save_url` (async; transfer must finish within 15 minutes; poll `save_url/check_job_status`).
- **Team space:** send `Dropbox-API-Path-Root: {".tag":"root","root":"<root_namespace_id>"}` (from `users/get_current_account`). App type Full Dropbox. Scopes: `files.content.write`, `files.content.read`, `files.metadata.read`, `sharing.write`, `account_info.read` (plus `team_data.member` only if using a team-linked app). Offline refresh token.

### 2.5 Anthropic (QC engine)

Models are env-configurable. Defaults: `claude-haiku-5-5` (classification, summaries), `claude-sonnet-5-5` (per-photo inspection, dust crops, post-fix checks, revision interpretation), `claude-opus-5-5` (gallery consistency, original vs edited, fix planning, arbitration of CRITICAL findings). Structured outputs (`output_config.format` JSON schema), absolute pixel bounding boxes on the image as sent, prompt caching of the system prompt and rules, Message Batches for shadow-mode evaluation only. Estimated QC cost: about $2.25 per 40-photo gallery (see `04-QC-PROMPT-PACK.md` 0.1).

---

## 3. Architecture

### 3.1 Components

| Component | Responsibility |
|---|---|
| **Intake service** | Turns Aryeo orders/appointments into `PhotoJob`s, creates Dropbox folders, issues photographer upload links, builds the shot list |
| **Upload portal** | Photographer-facing page: direct-to-Dropbox upload, preflight checks, "Finish upload" |
| **Editing orchestrator** | AutoHDR shoot creation, commit, polling, download, version storage |
| **QC engine** | CV checks, Claude passes P0 to P4, findings, grouping, verdicts |
| **Fix service** | Cost estimates, approvals, mask generation, transforms, post-fix verification |
| **Delivery service** | Sequencing, final staging, `DeliveryProvider` (Aryeo-assisted now), verification |
| **Credit monitor** | Balance polling, ledger, thresholds, runway, pre-flight checks |
| **Notification service** | Slack, SMS (OpenPhone), in-app; recipients Jordan and Kyle |
| **Photo Delivery Page** | Queue, job detail, review mode, Fix Cart, Deliver panel, settings |

### 3.2 Orchestration

The pipeline is long-running (30 to 90 minutes per job) and must survive deploys, timeouts, and vendor hiccups.

- If the hub already has a queue or workflow runner, use it. Otherwise use **Upstash QStash** (fits the existing Upstash stack): each step is an idempotent POST route handler; QStash provides retries, delayed messages (for polling), and fan-out (per-photo QC). Verify QStash signatures on every step route. Upstash Workflow is an acceptable alternative for multi-step durable functions.
- Each job is a **state machine** persisted in the database. A step handler loads the job, checks the stage is still the expected one (optimistic version column), does one unit of work, writes results, then enqueues the next step.
- **Reconciler cron** (every 5 minutes): finds jobs stuck in a stage longer than its budget, re-enqueues the step, and alerts after the second failure.
- Scheduling: if the hub's Vercel plan limits cron frequency (Hobby allows daily crons only), run the 5, 10, and 15 minute schedules as QStash schedules instead of Vercel crons.
- Vercel function limits: keep each step under 60 s where possible; downloads and derivative generation run per photo (fan-out), never per gallery in one invocation.

### 3.3 Job state machine

| Stage | Entered when | Exit to | Budget | Notes |
|---|---|---|---|---|
| `SCHEDULED` | Aryeo appointment synced | `UPLOADING` | n/a | Upload link sent to photographer |
| `UPLOADING` | First file lands | `UPLOADED` | 24 h | Portal shows progress; preflight warnings |
| `UPLOADED` | Photographer clicks Finish (or 30 min with no new files and admin confirms) | `EDITING` | 5 min | Manifest frozen |
| `EDITING` | AutoHDR shoot committed | `EDITED` or `EDIT_FAILED` | 90 min | Poll every 60 s |
| `EDITED` | All finals downloaded and stored | `QC_RUNNING` | 15 min | Derivatives built |
| `QC_RUNNING` | QC fan-out started | `QC_REVIEW`, `READY`, or `ON_HOLD` | 20 min | `READY` only if no findings at MAJOR or above |
| `QC_REVIEW` | Findings need a decision | `FIXING`, `READY`, `ON_HOLD` | SLA-driven | Jordan/Kyle notified |
| `FIXING` | Fix batch approved | `QC_REVIEW` or `READY` | 30 min | Re-QC of changed photos only |
| `ON_HOLD` | From any active stage: CRITICAL unresolved, 402 out of credits, reshoot, or manual hold | `holdResumeStage` (the stage it left), or `QC_REVIEW` / `FIXING` | n/a | Delivery blocked. Releasing the hold (or a credit top-up for `CREDITS` holds) re-enqueues the step that was interrupted |
| `READY` | Gate passes | `DELIVERING` | SLA-driven | Final set staged |
| `DELIVERING` | Admin clicked Deliver in hub | `DELIVERED` or `DELIVERY_MISMATCH` | 2 h | Waiting for Aryeo confirmation |
| `DELIVERED` | Aryeo confirms and images verified | `REVISION_REQUESTED` | n/a | Post-delivery automations |
| `REVISION_REQUESTED` | Client or admin opens a revision | `FIXING` → `READY` → `DELIVERING` | 24 h | Same loop |
| `EDIT_FAILED`, `DELIVERY_MISMATCH` | Errors | Manual | n/a | Alert immediately |

### 3.4 Storage

- **Database:** use the hub's existing data layer. These entities are relational (findings, ledger, analytics need joins and filters). If the hub currently stores everything in Upstash Redis/KV, add a relational store that matches the repo's direction (for example Postgres via Neon or Vercel Postgres with the repo's ORM) and keep Redis for caches, locks, and rate limiting. Decide in the gap analysis.
- **Masters:** Dropbox (team space).
- **Previews and QC derivatives:** Vercel Blob or the hub's existing object store. Derivatives per photo version follow `04-QC-PROMPT-PACK.md` section 0.2 (`qc2048`, `qc1568`, `qc1024`, `thumb768`, `thumb512`, plus `crop512` and `region768` on demand) and add `thumb256` for the UI grid. The QC long edge is `QC_LONG_EDGE` (default 2048). Generated with `sharp`.
- **Locks:** Upstash Redis (`lock:photo:<id>`) around anything that changes an AutoHDR head version.

### 3.5 Dropbox folder convention (fixes the inconsistent-naming problem)

The hub creates every folder. Photographers never name folders.

```
/Realtour Pilot/Jobs/<YYYY>/<YYYY-MM-DD> <Street Address>, <Town> (<Aryeo order #>)/
    01-RAW/                 photographer uploads (subfolders: photos/, drone/, extra/)
    02-AUTOHDR/v1/          first AutoHDR download, original AutoHDR filenames
    02-AUTOHDR/v2/ ...      later downloads after fixes (only changed photos)
    03-ORIGINALS/           AutoHDR "Original" versions fetched for P3 (optional)
    04-FINAL-DELIVERY/      approved set, sequenced: 01-Front-Exterior.jpg, 02-Front-Exterior.jpg ...
    05-QC/                  qc-report.json, contact-sheet.jpg, activity.csv
```

If the AutoHDR Dropbox integration is connected on the account, keep job folders **outside** the top-level `AutoHDR` folder, or AutoHDR will process them a second time and charge again.

---

## 4. Data model

TypeScript shapes. Map to the repo's ORM. Every table gets `id`, `createdAt`, `updatedAt`. Money in cents, credits as integers.

```ts
type JobStage =
  | 'SCHEDULED' | 'UPLOADING' | 'UPLOADED' | 'EDITING' | 'EDIT_FAILED' | 'EDITED'
  | 'QC_RUNNING' | 'QC_REVIEW' | 'FIXING' | 'ON_HOLD' | 'READY'
  | 'DELIVERING' | 'DELIVERY_MISMATCH' | 'DELIVERED' | 'REVISION_REQUESTED';

interface PhotoJob {
  id: string;
  stage: JobStage;
  stageVersion: number;               // optimistic concurrency
  address: { line1: string; city: string; state: string; zip: string; lat?: number; lng?: number };
  aryeo: {
    orderId: string; orderNumber?: string; listingId?: string; appointmentId?: string;
    customerTeamId?: string; customerName?: string;
    paymentStatus?: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';
    propertyWebsite?: { brandedUrl?: string; unbrandedUrl?: string };
  };
  photographerId?: string;            // hub user, mapped from Aryeo company_team_member
  appointmentStartAt?: string; appointmentEndAt?: string;
  slaDueAt?: string;                  // appointmentEndAt + client SLA (default 24 h)
  expected: ExpectedDeliverables;     // from ProductDeliverableMap + listing data (section 7.6)
  clientProfileId?: string;
  dropbox: { rootPath: string; rawPath: string; finalPath: string };
  autohdr?: {
    photoshootId?: number; createJobId?: string;
    indoorModelId?: number; outdoorModelId?: number;
    enhancements: { grass: boolean; declutter: boolean; fireplace: boolean; tv: { enabled: boolean; mode: string } };
    committedAt?: string; finishedAt?: string; expiresAt?: string;   // createdAt + 7 days
  };
  uploadPortal: { tokenHash: string; expiresAt: string; finishedAt?: string };
  creditsSpent: number;               // sum of CreditLedger for this job
  qcVerdict?: 'PASS' | 'PASS_WITH_MINOR' | 'NEEDS_DECISION' | 'HOLD';
  heroPhotoId?: string;
  holdReason?: 'CRITICAL' | 'CREDITS' | 'RESHOOT' | 'MANUAL'; holdResumeStage?: JobStage;
  deliveredAt?: string; deliveredBy?: string;
  flags: { shadowMode: boolean };
}

interface ExpectedDeliverables {
  minPhotos?: number; maxPhotos?: number;
  droneCount?: number; twilightReal?: number; twilightVirtual?: number;
  virtualStagingCount?: number; floorPlan?: boolean;
  bedrooms?: number; bathrooms?: number;
  requestedFeatures: string[];        // from order custom fields / notes, parsed by P4
  specialInstructions?: string;
  source: Record<string, string>;     // where each value came from (product id, listing field, note)
}

interface UploadFile {               // what the photographer uploaded
  id: string; jobId: string;
  dropboxPath: string; contentHash: string; bytes: number;
  filename: string; ext: string; kind: 'raw' | 'display';
  exif?: { make?: string; model?: string; takenAt?: string; gps?: { lat: number; lng: number } };
  isDrone: boolean;                   // EXIF make DJI, Autel, etc.
}

interface Photo {                    // one AutoHDR output photo
  id: string; jobId: string;
  autohdrImageUuid: string;
  headVersionUuid: string;
  sequence: number;                   // AutoHDR gallery order, then our delivery order
  deliveryOrder?: number;
  roomType?: RoomType; roomConfidence?: number;
  description?: string; features: string[];
  isAerial: boolean; isTwilight: boolean; isVirtuallyStaged: boolean;
  heroScore?: number;
  status: 'ACTIVE' | 'EXCLUDED';      // excluded = not delivered (duplicate, reject)
  excludeReason?: string;
}

interface PhotoVersion {
  id: string; photoId: string;
  autohdrVersionUuid: string; parentVersionUuid?: string;
  label: string;                      // Original, Enhanced, Declutter, AI Edit...
  dropboxPath?: string;               // saved copy
  derivatives: { qc2048?: string; qc1568?: string; qc1024?: string; thumb768?: string; thumb512?: string; thumb256?: string };
  width?: number; height?: number; bytes?: number;
  cv?: CvMetrics;
  source: 'AUTOHDR_INITIAL' | 'FIX' | 'REVISION' | 'ORIGINAL_FETCH';
}

interface CvMetrics {
  blurScore: number; blurRelativeToGallery: number;
  clipHighPct: number; clipLowPct: number; meanLuma: number;
  labMean: [number, number, number]; grayWorldCast: [number, number];
  dHash: string;
  dustCandidates: { x: number; y: number; r: number; score: number }[];  // full-res px
}

interface QcRun {
  id: string; jobId: string;
  trigger: 'INITIAL' | 'POST_FIX' | 'REVISION' | 'MANUAL';
  passes: ('CV' | 'P0' | 'P1' | 'P1B' | 'P2' | 'P3' | 'P4')[];
  rulesRegistryVersion: string; promptVersions: Record<string, string>; models: Record<string, string>;
  checksPerformed: string[]; checksSkipped: { check: string; reason: string }[];
  tokenUsage: { input: number; output: number; cacheRead: number; costUsd: number };
  startedAt: string; finishedAt?: string;
}

interface QcFinding {                // master shape; 04-QC-PROMPT-PACK.md section 0.9 mirrors it
  id: string; qcRunId: string; jobId: string;
  photoIds: string[];                 // one for P1/P1b/P3, several for P2 and grouped tickets, empty for P4 order findings
  ruleId: string;                     // registry id or OTHER_DEFECT
  groupKey: string; pass: Pass;
  specificIssue: string; explanation: string; locationText: string | null;
  bbox: [number, number, number, number] | null;   // full-resolution pixels [x1, y1, x2, y2]
  severity: Severity; confidence: number;          // 0 to 1
  responsibility: Responsibility;
  postFixable: boolean;               // this instance (model judgment); rule-level YES/NO/SOMETIMES lives in the registry
  reshootMayBeNeeded: boolean;
  isPermanentFeature: boolean; privacySensitive: boolean;
  recommendedAction: string; fixStrategy: FixStrategy; reeditPrompt: string | null;
  arbitration: 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'OVERTURNED';
  status: 'OPEN' | 'APPROVED_FIX' | 'FIXING' | 'FIXED' | 'IGNORED' | 'OVERRIDDEN' | 'SENT_TO_EDITOR' | 'RESHOOT_REQUESTED' | 'FALSE_POSITIVE';
  statusReason: string | null;        // required for IGNORED, OVERRIDDEN, FALSE_POSITIVE
  decidedBy: string | null; decidedAt: string | null;
  findingGroupId: string | null;
  promptId: string; promptVersion: number; model: string; rulesRegistryVersion: string;
  claudeCallId: string | null; coerced: string[];   // fields coerced during zod validation
}

interface FindingGroup {             // dedupe the same underlying issue across photos
  id: string; jobId: string; groupKey: string; title: string;
  severity: Severity; photoIds: string[]; findingIds: string[];
}

interface FixBatch {
  id: string; jobId: string;
  mode: 'ALL' | 'SELECTED' | 'CRITICAL_MAJOR_ONLY';
  estimatedCredits: number; estimatedUsdCents: number;
  balanceBefore: number; approvedBy: string; approvedAt: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED';
}

interface FixOperation {
  id: string; fixBatchId: string; photoId: string; findingIds: string[];
  strategy: FixStrategy; transformName?: string; transformVersion?: number;
  prompt?: string; maskAssetS3Url?: string; params?: Record<string, unknown>;
  inputVersionUuid: string; outputVersionUuid?: string;
  autohdrJobId?: string;              // persisted BEFORE polling
  estimatedCredits: number; chargedCredits?: number; refunded?: boolean;
  status: 'QUEUED' | 'SUBMITTING' | 'SUBMITTED' | 'SUCCEEDED' | 'NOOP' | 'FAILED' | 'VERIFIED' | 'REVERTED';
  verification?: { resolved: boolean; newArtifacts: string[]; permanentFeatureChanged: boolean; recommendation: 'ACCEPT' | 'REVERT' | 'RETRY_WITH_PROMPT' | 'ESCALATE_HUMAN' };
  attempt: number;                    // max 2 automated attempts
}

interface CreditLedgerEntry {
  id: string; jobId?: string; at: string;
  kind: 'DOWNLOAD' | 'TRANSFORM' | 'STYLE' | 'PRESET' | 'REFUND' | 'BALANCE_SNAPSHOT' | 'ADJUSTMENT';
  credits: number;                    // negative = spent
  balanceAfter?: number; ref?: string;
}

interface CreditAlertState { below250Sent: boolean; below100Sent: boolean; episodeId?: string; lastBalance: number; lastCheckedAt: string }

interface Revision {
  id: string; jobId: string; source: 'CLIENT_FORM' | 'ADMIN' | 'EMAIL';
  rawText: string; items: RevisionItem[];
  status: 'NEW' | 'INTERPRETED' | 'APPROVED' | 'IN_PROGRESS' | 'DONE' | 'REJECTED';
  requestedBy?: string; createdAt: string;
}
interface RevisionItem { photoIds: string[]; requestedChange: string; mappedRuleId?: string; fixStrategy: FixStrategy; reeditPrompt?: string; misrepresentationRisk: boolean; status: string }

interface ClientQcProfile {          // keyed by Aryeo customer team
  id: string; aryeoCustomerTeamId: string; name: string;
  autohdr: { indoorModelId?: number; outdoorModelId?: number; grass: boolean; fireplace: boolean; tvMode: string };
  slaHours: number;                   // default 24
  ruleOverrides: { ruleId: string; severity?: Severity; disabled?: boolean; reason: string }[];
  sequenceTemplate?: SequenceGroup[];   // P0 sequence groups (prompt pack section 1)
  deliveryMessage?: string;           // pasted into Aryeo deliver dialog
  notes?: string;
}

interface ProductDeliverableMap {    // one row per Aryeo product variant
  aryeoProductId: string; aryeoVariantId?: string; title: string;
  adds: Partial<ExpectedDeliverables>;
  confirmedBy?: string;               // admin confirmed the AI-suggested mapping
}

interface Notification {
  id: string; kind: string; severity: 'INFO' | 'WARN' | 'CRITICAL';
  title: string; body: string; jobId?: string; link?: string;
  channels: ('IN_APP' | 'SLACK' | 'SMS')[]; recipients: string[];
  dedupeKey: string; sentAt?: string; readBy: string[];
}

interface ActivityLog { id: string; jobId: string; at: string; actor: string; action: string; data?: Record<string, unknown> }
```

`Severity`, `Pass`, `RoomType`, `FixStrategy`, `Responsibility` come from `02-QC-RULES-REGISTRY.md`; `SequenceGroup` comes from P0 in `04-QC-PROMPT-PACK.md`. Generate the TypeScript union types from the registry so they never drift.

---

## 5. Integration modules

Put each vendor behind a typed client in `src/integrations/<vendor>/` (adapt to repo). Clients never contain business logic; the services in section 3.1 do.

### 5.1 AutoHDR client

**5.1.1 Auth.** `getAutohdrToken()` posts form-encoded `grant_type=client_credentials`, `client_id`, `client_secret`, `scope=photoshoots:read photoshoots:write images:edit presets:read presets:run`, `resource=https://external.realestatephotoediting.com/v1`. Cache the token in Redis until `expires_in - 300 s`. On 401, refresh once and retry the GET; never auto-retry a POST on 401 without a state lookup.

**5.1.2 Methods.**

```ts
interface AutohdrClient {
  me(): Promise<{ client_id: string; user_id: number; email: string; scopes: string[]; credit_balance: number | null }>;
  credits(): Promise<{ user_id: number; credit_balance: number }>;
  capabilities(): Promise<Capability[]>;                 // cached 1 h in Redis
  models(type?: 'all' | 'predefined' | 'custom'): Promise<Model[]>;   // cached 1 h
  createShootFromUrls(i: { address: string; files: { download_url: string; filename: string; kind: 'raw' | 'display' }[];
    indoor_model_id?: number; outdoor_model_id?: number; enhancements?: Enhancements }): Promise<{ job_id: string; photoshoot_id: number }>;
  createShoot(i: { address: string; files: { filename: string; kind: 'raw' | 'display'; md5?: string /* base64, not hex */ }[]; /* ... */ }):
    Promise<{ job_id: string; photoshoot_id: number; uploads: { filename: string; url: string; content_type: string; image_uuid: string; image_version_uuid: string }[] }>;
  commit(photoshootId: number, jobId: string): Promise<void>;   // 202; maps 409 files_not_landed → RetryLater, 409 conflict → AlreadyCommitted
  status(photoshootId: number): Promise<{ status: 'in_progress' | 'success' | 'failure'; pipeline: string; image_count: number; awaiting_files: boolean }>;
  listPhotos(photoshootId: number): Promise<{ image_uuid: string; image_version_uuid: string; name: string; downloaded: boolean }[]>; // paginates (max 100)
  download(photoshootId: number, images: { image_uuid: string; filename?: string }[]): Promise<{ credits_charged: number; downloads: { image_uuid: string; filename: string; url: string; byte_size: number }[] }>;
  history(photoshootId: number, imageUuid: string): Promise<{ image_version_uuid: string; parent_image_version_uuid: string | null; is_head: boolean; label: string; description: string }[]>;
  setVersion(photoshootId: number, imageUuid: string, versionUuid: string): Promise<void>;
  describe(photoshootId: number, imageUuid: string, opts?: { image_version_uuid?: string; prompt?: string }): Promise<string>;
  createAssetUploads(photoshootId: number, kind: 'mask' | 'reference', files: { filename: string; content_type: 'image/png' | 'image/jpeg' }[]):
    Promise<{ filename: string; url: string; s3_url: string }[]>;
  submitTransform(i: { photoshoot_id: number; image_uuid: string; image_version_uuid: string; transform_name: string; transform_version?: number;
    prompt?: string; model_id?: number; mask_url?: string; reference_image_urls?: string[]; params?: Record<string, unknown> }): Promise<TransformJob>;
  getTransform(jobId: string): Promise<TransformJob>;
  listTransforms(photoshootId: number, state?: 'active' | 'history' | 'all'): Promise<TransformJob[]>;
}
```

**5.1.3 Error mapping.** Body shape `{ error, error_description }`, plus `X-Request-Id` header (log it on every call).

| HTTP / code | Handling |
|---|---|
| 401 `invalid_request` | Refresh token, retry GETs once |
| 402 `insufficient_credits` | Nothing charged. Stop the step, set job `ON_HOLD` with reason `CREDITS`, fire CRITICAL credit alert |
| 403 `plan_required` | Config alert to Jordan (plan downgraded?) |
| 403 `transform_not_exposed` / `model_not_available` | Refresh capabilities cache; fall back to next fix strategy |
| 409 `files_not_landed` | Retry commit with backoff (30 s, up to 20 min) |
| 409 `conflict` | Already committed: switch to polling |
| 410 `photoshoot_expired` | Mark versions read-only; fixes must go through a new shoot built from Dropbox copies |
| 422 | Bug: log body, alert dev channel |
| 429 | Honor `Retry-After` |
| 502/504/5xx | Backoff retry for GETs; for POSTs, do a state lookup first |
| Transform `failed` with `failure_code` `content_policy` / `transform_failed` | Mark operation FAILED, offer fallback strategy |

**5.1.4 Idempotency (no Idempotency-Key support yet).**
- Before every POST that can cost credits or create a billable object (`createShootFromUrls`, `createShoot`, `commit`, `submitTransform`, `download`, `runPreset`), set the row's status to `SUBMITTING` and save. Write the returned ids (`photoshoot_id`, `job_id`, `autohdrJobId`) immediately from the response.
- A handler that starts and finds `SUBMITTING` must never resubmit blindly. It looks up state first: `listTransforms(photoshootId, 'all')` matched on `image_uuid` + `transform_name` + `submitted_at` window; `listPhotoshoots` matched on `address` (the unique job folder name) + creation time for shoots. Resubmit only if no match.
- Enqueue credit-spending steps with QStash `Upstash-Retries: 0`; the reconciler (not QStash) handles their recovery through the lookup above. Read-only and free steps keep normal retries.
- `download` is safe to repeat (re-downloads are free) and `commit` answers 409 `conflict` when already done.

**5.1.5 Polling.** Shoot status: QStash delayed message every 60 s, budget 90 minutes, then one re-check after 5 more minutes (AutoHDR notes slow shoots can flip from failure to success), then `EDIT_FAILED` + alert. Transform jobs: every 10 s, budget 10 minutes.

**5.1.6 Fallback intake path (if `from-urls` rejects Dropbox links).** Use the AutoHDR Dropbox watcher: copy RAWs to `/AutoHDR/<job folder>/01-RAW-Photos/`, AutoHDR starts 20 minutes after the last file and writes finals to `04-FINALS-Photos` **[VERIFY exact folder name]**. The reconciler finds the shoot via `listPhotoshoots` (address equals the folder name above `01-RAW-Photos`) and the pipeline continues from `EDITING` with the API. Downside: 20-minute delay and no per-shoot model choice.

### 5.2 Dropbox client

```ts
interface DropboxClient {
  ensureFolders(paths: string[]): Promise<void>;                          // files/create_folder_batch
  temporaryUploadLink(path: string, durationSec?: number): Promise<string>; // files/get_temporary_upload_link, autorename false, mode add
  temporaryLink(path: string): Promise<string>;                           // files/get_temporary_link (4 h)
  saveUrl(path: string, url: string): Promise<{ asyncJobId: string }>;    // files/save_url
  saveUrlStatus(asyncJobId: string): Promise<'in_progress' | 'complete' | 'failed'>;
  listFolderContinue(cursor: string): Promise<{ entries: DropboxEntry[]; cursor: string; has_more: boolean }>;
  latestCursor(path: string): Promise<string>;
  metadata(path: string): Promise<DropboxEntry>;
  copyBatch(pairs: { from: string; to: string }[]): Promise<void>;        // final staging
  sharedLink(path: string): Promise<string>;                              // for the Aryeo import step if needed
}
```

- Refresh-token auth (`token_access_type=offline`), access tokens cached in Redis.
- Always send `Dropbox-API-Path-Root` for the team space.
- Webhook route `POST /api/webhooks/dropbox`: GET challenge echo; POST verify `X-Dropbox-Signature`; respond 200 immediately; enqueue `dropbox.sync` which walks `list_folder/continue` from the stored cursor and attaches new files under `/Jobs/**/01-RAW/` to their job.
- Upload integrity: the portal computes the Dropbox content hash in the browser (SHA-256 over 4 MB blocks, then SHA-256 of the concatenated block hashes) and compares it with the `content-hash` returned by the temporary upload link.
- Throttle portal uploads to 4 parallel files to avoid `too_many_write_operations`.

### 5.3 Aryeo client

```ts
interface AryeoClient {
  getOrder(id: string, include?: string[]): Promise<AryeoOrder>;          // include: items, appointments, listing, customer (discover with ?include=fake)
  listOrders(filter: Record<string, string>): Promise<AryeoOrder[]>;
  getListing(id: string, include?: string[]): Promise<AryeoListing>;      // images[], floor_plans[], videos[], delivery_status, property_website
  listListings(filter: Record<string, string>): Promise<AryeoListing[]>;  // filter[delivery_status]
  getListingStats(id: string): Promise<ListingStats>;
  getCubiCasa(listingId: string): Promise<CubiCasaSync>;
  getAppointment(id: string): Promise<AryeoAppointment>;
  listAppointments(filter: Record<string, string>): Promise<AryeoAppointment[]>;
  getOrderItem(id: string): Promise<AryeoOrderItem>;
  addOrderItem(i: { order_id: string; product_variant_id?: string; quantity?: number; title?: string; unit_price_amount?: number; description?: string }): Promise<AryeoOrderItem>;
  listProducts(): Promise<AryeoProduct[]>;
  listTeamMembers(): Promise<AryeoTeamMember[]>;
  createTag(i: { type: 'order'; name: string; color: string }): Promise<AryeoTag>;
  addOrderTag(orderId: string, tagId: string): Promise<void>;
  removeOrderTag(orderId: string, tagId: string): Promise<void>;
  setOrderInternalNotes(orderId: string, notes: string): Promise<void>;   // PUT replaces the whole field
  createTask(i: { name: string; description?: string; due_at?: string; company_team_member_id?: string }): Promise<AryeoTask>;
  completeTask(id: string): Promise<void>;
  availableTimeslots(q: { date: string; timezone: string; duration?: number }): Promise<Timeslot[]>;
  createAppointment(i: { order_id: string; start_at: string; end_at: string; company_team_member_ids?: string[]; notify?: boolean }): Promise<AryeoAppointment>;
  createOrderFormSession(i: { order_form_id: string; address_id?: string; customer_id?: string; success_url?: string }): Promise<{ url: string }>;
}
```

- **Webhook receiver** `POST /api/webhooks/aryeo`: verify the `Signature` header as lowercase hex HMAC-SHA256 of the raw JSON body with our shared secret **[VERIFY hex vs base64 with first real event]**, constant-time compare. Payload: `{ object: 'ACTIVITY', id, name, occurred_at, resource: { object, id, ... } }`. Dedupe on `id`. Aryeo retries only twice (10 s, 100 s), so respond fast and enqueue.
- **Reconciler cron** (every 10 minutes, and the only path until Aryeo enables webhooks): `listAppointments` for today and tomorrow, `listOrders` updated recently, `listListings?filter[delivery_status]=DELIVERED` for jobs in `DELIVERING`.
- **Internal notes merge:** read the order, replace only the block between `[RTP-QC START]` and `[RTP-QC END]`, keep everything else, write back. Never clobber human notes.
- **Tag setup** (one-time script): create order tags `RTP: Uploading`, `RTP: Editing`, `RTP: QC Review`, `RTP: QC Hold`, `RTP: Ready to Deliver`, `RTP: Delivered (Verified)`, `RTP: Revision`. Store ids in config. Moving stages removes the previous `RTP:` tag and adds the new one.

### 5.4 Anthropic client

- One wrapper `runPrompt<T>(promptId, input, schema)` that: selects the model from env, applies prompt caching (system + injected rules), sends images first, uses `output_config.format` JSON schema, validates with zod (range checks the JSON schema cannot express), retries once on parse failure with the validation error appended, handles `stop_reason` `refusal` and `max_tokens`, records token usage and cost on the `QcRun`.
- Concurrency limit per job (default 8) via a Redis semaphore.
- Bounding boxes come back in pixels of the image as sent (`qc2048`); convert to full resolution with the exact scale factor and clamp.

### 5.5 Notification service

One function `notify({ kind, severity, title, body, jobId, link, dedupeKey })`. Recipients: **Jordan and Kyle** for everything in this feature (configurable per kind in settings).

| Channel | How | Used for |
|---|---|---|
| In-app (hub) | `Notification` rows, bell icon with unread count, persistent banner for CRITICAL | All kinds |
| Slack | Bot token or incoming webhook to the ops channel, `@`-mention Jordan and Kyle by Slack user id | All WARN and CRITICAL kinds, plus daily digest |
| SMS | OpenPhone API from the business line to Jordan's and Kyle's mobiles **[VERIFY current OpenPhone API endpoint and auth]** | Credit alerts (250, 100), CRITICAL holds, SLA at risk, `EDIT_FAILED`, `DELIVERY_MISMATCH` |

Rules: dedupe on `dedupeKey` within 6 hours; quiet hours 9 pm to 7 am for SMS (SMS during quiet hours are queued and sent at 7 am, never dropped) except credit-below-100 and SLA breach, which send immediately; every SMS includes a short hub link; plain text, no em dashes.

| Kind | Severity | Message example |
|---|---|---|
| `CREDITS_BELOW_250` | WARN | "AutoHDR credits are at 243 (below 250). About 9 days left at the current pace. Top up: <link>" |
| `CREDITS_BELOW_100` | CRITICAL | "AutoHDR credits are at 96 (below 100). New edits may fail. Top up now: <link>" |
| `QC_DECISION_NEEDED` | WARN | "123 Main St: 7 issues need a decision (2 Major fixes, est. 3 credits). Review: <link>" |
| `QC_HOLD` | CRITICAL | "123 Main St is on hold: possible sensor dust in 9 photos. Review: <link>" |
| `READY_TO_DELIVER` | INFO | "123 Main St passed QC (38 photos). Ready to deliver: <link>" |
| `SLA_AT_RISK` | WARN at 6 h left, CRITICAL at 2 h | "123 Main St is due in 2 hours and is still in QC Review." |
| `EDIT_FAILED` | CRITICAL | "AutoHDR failed on 123 Main St after 90 minutes. Open job: <link>" |
| `DELIVERY_MISMATCH` | CRITICAL | "Aryeo shows 36 photos for 123 Main St but 38 were approved. Check: <link>" |
| `UPLOAD_INCOMPLETE` | WARN | "James finished the upload for 123 Main St, but drone was ordered and no drone files were found." |

---

## 6. Pipeline, step by step

### 6.1 Intake (Aryeo → hub)

Trigger: Aryeo `APPOINTMENT_SCHEDULED` / `ORDER_CREATED` webhook, or the reconciler.

1. Fetch the order with items, appointments, listing, customer. Skip orders with no photo product (product map decides).
2. Create or update the `PhotoJob`: address, photographer (from `appointment.company_team_members[].company_user` matched to hub users by email), appointment times, `slaDueAt = appointmentEndAt + clientProfile.slaHours`.
3. Build `ExpectedDeliverables` from the `ProductDeliverableMap` (sum over order items, honoring quantities and canceled items), listing bedrooms/bathrooms (or `GET /listings/{id}/details/search` public record if blank), and requested features/special instructions from the order's custom fields and notes **[VERIFY `custom_fields` shape]**.
4. Create the Dropbox folder tree (3.5).
5. Create the upload portal token (random 32 bytes, store only a hash, expires 72 h after appointment end).
6. Send the photographer their link (Slack DM or SMS, per photographer preference) with the shot list: "Ordered: 25 photos, drone (5), floor plan. Client notes: show the finished basement bar."
7. Aryeo: tag `RTP: Uploading`.
8. Appointment reschedule/cancel events update or cancel the job.

### 6.2 Upload portal (photographer)

Route: `/upload/[token]` (mobile friendly, no login; token-scoped).

- Header: address, appointment time, shot list from `ExpectedDeliverables`, client notes, and the photographer's own top 3 recurring misses from QC history (section 12, item 3).
- Drag and drop files or folders. For each file: server mints a Dropbox temporary upload link into `01-RAW/photos/` (or `drone/` if EXIF make is DJI or similar), browser POSTs bytes directly, verifies content hash, reports to the hub. A failed file retries with a fresh temporary link (links are single-use). 4 files in parallel.
- Browser-side EXIF read (`exifr`) on the first 64 KB of each file for make/model/time/GPS before upload.
- **Preflight checks** before "Finish upload" (warnings, not blockers; the photographer can confirm and proceed):
  - File count vs expected photos times typical brackets (for example fewer than `minPhotos * 3` RAW files when bracketing).
  - Unsupported formats (TIFF is not supported by AutoHDR).
  - Drone ordered but no drone files detected.
  - Twilight ordered but no files captured near local sunset (compare EXIF time with sunset at the address).
  - Floor plan ordered: reminder checkbox "CubiCasa scan submitted?" (the hub also checks Aryeo's CubiCasa status later).
  - Duplicate filenames across cards are auto-prefixed, never overwritten.
- "Finish upload" freezes the manifest, sets `UPLOADED`, and kicks off editing immediately (no 20-minute wait).
- If files stop arriving for 30 minutes without Finish, notify the photographer and Kyle.

### 6.3 Editing (AutoHDR)

1. For each RAW/JPEG in the manifest, get a Dropbox temporary link.
2. `createShootFromUrls` with `address` = job folder name, all files `kind: 'raw'` (camera RAW and bracketed JPEGs; use `display` only for already-finished JPEGs such as a client-supplied photo), model ids and enhancements from the client profile:
   - `fireplace: true`, `tv_replacement: { enabled: true, mode: 'blackout' }` by default (free on Pro).
   - `grass` per client profile (costs 1 credit per photo where applied).
   - `declutter: false` (QC applies it selectively later).
3. Persist `job_id` and `photoshoot_id`, then `commit` with retry on `files_not_landed`.
4. Poll status (5.1.5). Aryeo tag `RTP: Editing`.
5. On `success`: `listPhotos`, then `download` all images in one call (records `credits_charged` in the ledger), then per photo (fan-out): `saveUrl` into `02-AUTOHDR/v1/`, fetch the bytes once to build derivatives and CV metrics, store a `PhotoVersion`. All of this inside the 6-hour link window.
6. Call `describe` (free) per photo and store the text (used by P0 as a second opinion and for captions).
7. Set `EDITED`, enqueue QC.

### 6.4 QC

See section 7. Output: findings, groups, per-photo verdicts, a job verdict, the suggested delivery order and hero image. Stage becomes `READY` (no MAJOR or CRITICAL findings) or `QC_REVIEW`. Aryeo tag `RTP: QC Review` or `RTP: QC Hold`, internal notes block updated with the Delivery Summary prompt output.

### 6.5 Decision and fixes

See section 8.

### 6.6 Delivery (Aryeo-assisted)

See section 9.6.

### 6.7 After delivery

- Verify Aryeo (9.6), set `DELIVERED`, tag `RTP: Delivered (Verified)`, complete the Aryeo task.
- Send the photographer coaching note (section 12, item 3), if any PHOTOGRAPHER findings.
- Start the 7-day revision window: the revision link was included in the delivery message (9.6).
- AutoHDR deletes shoots 7 days after creation, which can be before the revision window closes. If a revision arrives after expiry, the hub re-uploads the delivered JPEG from Dropbox as a `display` photo in a new shoot. A paid edit covers that photo's download, but a zero-credit edit (for example `autoremove`) then costs the 1-credit download. The revision estimate includes this, and the job shows an "AutoHDR expired" badge.
- Record analytics (section 12, item 14).

---

## 7. QC engine

### 7.1 Inputs

- The rules registry (`qc-rules.seed.json`): 425 rules, one per checklist bullet in sections 1 to 18, each with room scope, pass, detector, default severity and escalation, fix strategies, owner, build phase, `groupKey`, and a `visionHint`.
- Client profile rule overrides (disable or change severity per client, with a reason).
- Photo derivatives and CV metrics.
- Order and listing data (`ExpectedDeliverables`).

### 7.2 Pass order for one job

```
CV (per photo, deterministic)         ┐
P0 classify + describe (per photo)    ┘ in parallel
P1 inspect (per photo, rules filtered by P0 room type)
P1-arbiter (each CRITICAL finding, Opus re-check)
P1b dust confirm (crops around CV dust candidates, per photo and recurrence clusters)
P2 gallery consistency (per room cluster, plus one overview)
P3 original vs edited (selective, see 7.5)
P4 order coverage (text only)
→ group findings, apply severity policy, compute verdicts, propose delivery order + hero
```

Rules are filtered by `buildPhase` according to the feature flag `qc.maxBuildPhase` (1 in Phase 3 of the rollout, then 2, then 3). Exception: any rule whose default or escalated severity is CRITICAL (privacy, wrong property, corrupt files, misrepresentation, and similar) runs regardless of `qc.maxBuildPhase` as soon as its pass exists.

### 7.3 Deterministic CV checks (Node, `sharp`)

All thresholds are **starting values**; calibrate on the golden set and store them in settings.

| Check | Method | Starting threshold | Feeds rules |
|---|---|---|---|
| Blur / focus | Variance of Laplacian on a 1500 px grayscale; also relative to the gallery median | Flag when below 35% of gallery median or absolute under 60 | `COMP_*` blur, focus, shake |
| Exposure | Luma histogram; % pixels at 0 and 255 outside detected window regions; mean luma vs gallery median for the same room type | Clipped highs over 4%, mean luma over 1.6x or under 0.6x of median | `EXPO_*` |
| Dust candidates | 3000 px grayscale; flat-region mask (local std dev in 31 px window below threshold); high-pass = image minus Gaussian blur (sigma 8); dark blobs 6 to 400 px area, roughly round, soft edged; top 15 per image | Contrast below -6 luma levels on flat regions | `REFL_SENSOR_DUST`, `REFL_LENS_DUST`, `REFL_DARK_SPOTS_FLAT_SURFACES` |
| Repeated dust | Cluster dust candidates by normalized position across photos | 3+ photos within 0.6% of width (1.5% if using edited, perspective-corrected images) | `REFL_REPEATED_DUST_LOCATION`, `GAL_NO_REPEATED_SENSOR_DUST` |
| Duplicates | 64-bit dHash, Hamming distance | 6 or less → near-duplicate candidate for P2 | `GAL_NO_DUPLICATES` |
| Color stats | Mean Lab, gray-world cast (a*, b*) per photo; z-score within room cluster | Over 2 standard deviations → passed to P2 as a hint | `GAL_*_COLOR_*`, `COLOR_*` |
| File checks | Decode, format, color space (sRGB), dimensions, byte size, long-edge consistency | Long edge below configured minimum, mixed sizes | `FILE_*`, `GAL_RESOLUTION_CONSISTENCY` |
| Verticals (Phase 2+) | Sobel gradient orientation histogram near 90 degrees; median deviation of strong near-vertical edges | Over 1.0 degree | `PERSP_CROOKED_VERTICALS` (Claude P1 covers this until then) |

Dust note: AutoHDR applies perspective correction and crops per photo, so the same sensor speck lands at slightly different coordinates in each edited photo. Run recurrence on the AutoHDR "Original" versions when P3 has fetched them; otherwise use the looser tolerance and let P1b confirm.

### 7.4 Claude passes

Full prompts, schemas, and examples are in `04-QC-PROMPT-PACK.md`. Key behavior:

- **P0** (Haiku): room type, aerial/twilight/staged flags, factual 1 to 2 sentence description, notable features, hero score, sequence group. Low room confidence injects rules for both candidate room types.
- **P1** (Sonnet): one call per photo at 2048 px with only the rules for that room. Returns findings with `ruleId`, severity, confidence, pixel bbox, location text, fix strategy, a ready-to-use `reeditPrompt`, owner, post-fixable, reshoot flag, permanent-feature flag, privacy flag; plus `checksPerformed` and `checksSkipped` (checklist section 22).
- **P1 arbiter** (Opus): re-checks each CRITICAL finding from P1 (`arbitration: PENDING` until it answers). Agreement sets `CONFIRMED`. Disagreement sets `OVERTURNED` and the finding takes the arbiter's severity; privacy findings never drop below MAJOR and route to HUMAN_REVIEW. Findings from CV, P1b, P2, P3, P4 and file checks are `NOT_REQUIRED`.
- **P1b** (Sonnet): 512 px full-resolution crops around dust candidates; confirms dust vs real object vs texture; refined boxes.
- **P2** (Opus): per room cluster (all kitchen angles together, all exteriors together), plus an overview of the whole gallery at small size. Material color drift, white balance, exposure, sky style, editing style mix, duplicates, wrong-property photo, unedited files mixed in. When unsure which photo has the true color, it says so and the finding routes to P3 or human review.
- **P3** (Opus): original vs edited pairs. Runs for: every photo that received an AI fix, all kitchens and exteriors (color and sky risk), and any photo with a color or architecture uncertainty from P1/P2. Setting `qc.p3.allPhotos` runs it on everything.
  - How the original is fetched: lock the photo, `setVersion` to the history step whose parent is null (Original), `download` (free re-download), `setVersion` back to head, unlock. Save to `03-ORIGINALS/`. **[VERIFY with AutoHDR that this is free and has no side effects; ask for a version-specific download parameter.]**
- **P4** (Sonnet, text only): compares P0 room labels and counts with `ExpectedDeliverables` (photo count, bedrooms and bathrooms coverage, drone, twilight, staging, floor plan via Aryeo CubiCasa status, requested features). Returns `MET`, `NOT_MET`, or `UNKNOWN` per item. Missing data is `UNKNOWN`, never a guess (checklist section 16).

### 7.5 Grouping and severity policy

- **Grouping:** findings with the same `groupKey` across photos become one `FindingGroup` ("Toilet seat open in 3 photos", "Possible sensor dust at the same spot in 9 photos"). The UI shows groups first; a group-level decision applies to all its findings.
- **Escalation:** apply the rule's `escalateTo.when` (for example dust in 3+ photos becomes CRITICAL; a trash can in the hero front exterior becomes CRITICAL for that client if their profile says so). Client profile overrides apply last.
- **Confidence display:** findings at or above the display floor (default 0.5; calibration may set a per-rule cutoff stored in settings, see prompt pack section 12) show in the main list. Below 0.5 they go to a collapsed "Low confidence" drawer and never block delivery. Confidence is never treated as proof (checklist section 22).
- **Job verdict:**
  - `HOLD` if any unresolved CRITICAL finding with arbitration `CONFIRMED`, `NOT_REQUIRED`, or still `PENDING`.
  - `NEEDS_DECISION` if any open MAJOR finding.
  - `PASS_WITH_MINOR` if only MINOR findings (these never require approval).
  - `PASS` if nothing.
- **Never automatic:** reshoots (recommendation only), any fix on a rule with `permanentFeatureRisk: true`, privacy findings (human chooses blur, remove, or exclude), and color-truth calls (compare with originals or ask the photographer).

### 7.6 Delivery order and hero

Default sequence uses P0's `sequenceGroup` (client profile can override the group order): hero first (twilight if any, otherwise the best front exterior by hero score), then `FRONT_EXTERIOR`, `ENTRY`, `MAIN_LIVING`, `KITCHEN`, `PRIMARY_SUITE`, `BEDROOMS`, `BATHROOMS`, `FLEX`, `LOWER_LEVEL`, `UTILITY`, `OUTDOOR_LIVING`, `REAR_EXTERIOR`, `AERIAL`, `COMMUNITY`, `DETAIL`. Within a room, keep AutoHDR's walkthrough order. Excluded photos (duplicates, rejects) drop out. Final filenames: `NN-Room-Label.jpg` (for example `01-Front-Exterior.jpg`, `14-Primary-Bathroom.jpg`).

### 7.7 Calibration and shadow mode

- **Golden set:** 15 to 20 past galleries with known issues, labeled from historical client revision requests, Slack threads with Kyle, and Kyle's manual QC notes. Store under `qc-eval/` with expected findings per photo.
- `pnpm qc:eval` runs the full engine on the golden set (Message Batches API, half price) and reports precision and recall per rule and per priority group. Shadow mode in production runs live, not on Batch.
- **Shadow mode** for the first 2 weeks in production: QC runs and shows results, Kyle still does his normal manual QC and marks each AI finding correct, wrong, or missed. Promote a rule group to "blocking" only when it meets the targets in `04-QC-PROMPT-PACK.md` section 12.3 on real jobs (that section is the single source for accuracy, latency, and cost targets).
- Every finding stores the prompt version and model, so tuning is traceable.

---

## 8. Fix Cart: cost calculator, approval, execution

### 8.1 Cost model

- Prices come from `listCapabilities` (`credit_cost` per transform and per twilight look) and `listModels` (`style_credit_cost`). Cache 1 hour. Never hardcode.
- Reference prices from the AutoHDR knowledge base, for sanity checks only: AI ReEdit 1, Declutter 1, Grass 1, AutoRemove/AutoFill free, Virtual Twilight 5, Virtual Staging 5, Style switch 1. Re-downloads after a fix are free because the photo was already downloaded once.
- Dollars: `credits x AUTOHDR_USD_PER_CREDIT` (default $0.50 on the Pro 1K plan; editable in settings).
- Strategies with no AutoHDR cost still appear in the cart with their real cost type: `EDITOR_MANUAL` (editor time), `RESHOOT` (photographer trip), `ADMIN_ACTION`, `HUMAN_REVIEW`.
- All numbers are labeled "estimated." Failed and no-op jobs are refunded by AutoHDR; the ledger records actuals.

### 8.2 How the cart is built

1. Open findings with `postFixable` YES or SOMETIMES and a credit-based strategy go in the cart, grouped by photo.
2. When QC closes, the **Fix Planner** prompt (Opus, see prompt pack) prices every photo's fixable findings (all selected by default) so the cart shows real costs **before** anyone decides. If the admin changes a photo's selection, the planner re-runs for that photo and the total updates before Run. It picks the cheapest safe sequence, for example:
   - Merge all dust spots and small removable objects on one photo into **one** `autoremove` call with a multi-region mask **[VERIFY one charge per call]**.
   - Use one `declutter` instead of many removals when clutter is widespread.
   - Combine compatible state changes into one `reedit` prompt ("Close the toilet lid and seat. Straighten the hand towel. Change nothing else in the photo.").
   - `camera_removal` for photographer or tripod reflections (refunded if nothing found).
3. Each line shows: photo thumbnail, issue(s), strategy, credits, dollars, and flags (`Needs approval: permanent feature`, `Privacy`, `Color truth`).

### 8.3 The decision UI (what Jordan and Kyle see)

```
┌ Fix Cart · 123 Main St ──────────────────────────────────────────┐
│ 9 fixes on 7 photos · est. 6 credits ($3.00) · balance 399 → 393 │
│ [ Fix all ]  [ Fix Critical + Major only ]  [ Ignore all Minor ]  │
├───────────────────────────────────────────────────────────────────┤
│ ☑ 04 Kitchen      Paper towels + soap on counter  autoremove  0 cr │
│ ☑ 11 Hall Bath    Toilet lid open, towel crooked  reedit      1 cr │
│ ☑ 12 Hall Bath    Photographer in mirror          cam removal 1 cr │
│ ☐ 21 Front Ext.   Garden hose by steps            autoremove  0 cr │
│ ⚠ 22 Front Ext.   Car partly hides garage  NEEDS YOUR CALL (human) │
│ ...                                                                │
│ [ Run selected (5 fixes, 3 credits, $1.50) ]                       │
└───────────────────────────────────────────────────────────────────┘
```

Mockup numbers are illustrative; real prices come from the live catalog.

- Three ways to decide, exactly as requested: **Proceed** (Fix all), **Ignore** (per item, per group, or all Minor), **Select** (checkboxes, then Run selected).
- Ignoring a MAJOR or CRITICAL finding requires a reason (dropdown: client preference, intentional staging, permanent feature, false positive, other with text). "False positive" feeds the golden set.
- Other per-item actions: **Send to editor**, **Request reshoot** (recommendation to Jordan; never automatic), **Not an issue**.
- Approval limits: Kyle (ADMIN) can approve batches up to `fix.adminCreditCap` (default 25 credits); above that needs Jordan (OWNER). Both settings editable.
- Optional setting (default **off**): auto-apply zero-credit fixes on non-CRITICAL findings with confidence of at least 0.9 and `autoFixEligible: true`. Everything else waits for a click.
- Pre-flight: if balance is below the estimate, the Run button is disabled with a top-up link. If the run would cross 100, the confirm dialog says so.

### 8.4 Execution

1. Create `FixBatch` and `FixOperation` rows (status `QUEUED`), record approver.
2. Per photo, operations run **sequentially** (each AutoHDR transform creates a new head version; the next op uses it as input). Photos run in parallel. A `style` re-render starts from the originals and drops earlier edits, so the planner always puts it first and re-plans any previously accepted fixes for that photo in the same batch.
3. Masks: boxes are already at full resolution; pad each by `fix.maskPaddingPct` of its longer side (default 10%) and at least `fix.maskPaddingMinPx` (default 16 px), clamp, merge overlaps, render a white-on-black PNG at the photo's exact dimensions with `sharp`, `createAssetUploads(kind: 'mask')`, PUT the PNG, pass `s3_url` as `mask_url`.
4. `submitTransform` → persist `autohdrJobId` → poll.
5. On success: free re-download of the new head, save to `02-AUTOHDR/v<n>/`, build derivatives, store `PhotoVersion`.
6. **Post-Fix Verification** (Sonnet): resolved? new artifacts (checklist section 13)? permanent feature changed? Recommendation:
   - `ACCEPT` → finding `FIXED`.
   - `REVERT` → `setVersion` back to the input version (free), finding back to `OPEN` with note.
   - `RETRY_WITH_PROMPT` → one more attempt with the improved prompt (max 2 automated attempts per finding), only if the retry stays within the approved batch estimate and the approver's cap; otherwise it escalates to a human with the cost shown.
   - `ESCALATE_HUMAN` → shows in Issues with before/after for a human call.
7. Re-run P1 on changed photos and P2 for their room cluster. Record ledger entries. Notify: "Fixes done on 123 Main St: 8 of 9 resolved, 1 needs your eye."

### 8.5 Manual editor path

"Send to editor" copies the current version to `06-EDITOR/out/` with a `NN-notes.txt` describing the issue. When a file with the same base name lands in `06-EDITOR/in/` (Dropbox webhook), the hub stores it as a new `PhotoVersion` (source `REVISION`), re-runs P1 and post-fix checks, and uses the Dropbox file as the delivery source for that photo.

---

## 9. Photo Delivery Page (UI spec)

Build with the hub's existing component library. Desktop first (review happens at a desk), fully usable on a phone for approvals and alerts.

### 9.1 Routes

| Route | Who | Purpose |
|---|---|---|
| `/ops/photo-delivery` | Jordan, Kyle | Queue of all jobs |
| `/ops/photo-delivery/[jobId]` | Jordan, Kyle | Job detail |
| `/ops/photo-delivery/[jobId]/review` | Jordan, Kyle | Full-screen review mode |
| `/ops/photo-delivery/settings` | Jordan | Client profiles, product map, thresholds, recipients, AutoHDR defaults, approval caps |
| `/ops/photo-delivery/analytics` | Jordan | Quality and cost analytics |
| `/upload/[token]` | Photographer | Upload portal |
| `/r/[token]` | Client agent | Revision request page |

### 9.2 Global strip (on every photo-delivery page and the hub dashboard)

- **AutoHDR credits chip:** live balance; green at 250 or more, amber 100 to 249, red below 100; tooltip with runway ("about 11 days at the 14-day average") and committed demand ("about 64 credits needed for jobs in progress").
- Notifications bell with unread count; CRITICAL banner across the top until acknowledged.

### 9.3 Queue

- Kanban (default) and table views. Columns: Uploading, Editing, QC Running, Needs Decision, Fixing, On Hold, Ready, Delivering, Delivered (last 7 days).
- Card: hero thumbnail, address, client, photographer, SLA countdown chip (green, amber at 6 h left, red at 2 h), photo count, issue counts by severity, pending credits, Aryeo payment status.
- Sort by SLA due; filters for client, photographer, date range, at-risk only.

### 9.4 Job detail

- **Header:** address, client team, Aryeo order number (link), appointment time, photographer, SLA countdown, payment status, property website links (copy buttons), credits spent on this job, stage stepper.
- **Gallery (left, about 60% width):** grid in delivery order. Drag to reorder. Star sets hero. Eye toggles include/exclude. Each tile shows room label, worst-severity badge, and a fix-in-progress spinner. Hover shows the AI description. Bulk select.
- **Right panel tabs:**
  - **Issues:** finding groups first ("Toilet seat open, 3 photos"), each with thumbnails, severity, confidence, owner, and actions (Fix, Ignore, Send to editor, Reshoot, Not an issue). Expand to see each photo with its box overlay.
  - **Fix Cart:** section 8.3.
  - **Coverage:** P4 results (MET, NOT_MET, UNKNOWN) next to what was ordered (photo count, bedrooms, bathrooms, drone, twilight, staging, floor plan, requested features). "Accept with reason" on NOT_MET.
  - **Revisions:** client and admin revision requests with status.
  - **Activity:** timeline of every automated and human action.
  - **Files:** Dropbox paths (open links), AutoHDR photoshoot id, version list, QC run ids, cost breakdown (AutoHDR credits plus Claude cost).
- **Lightbox (click any photo):** zoom and pan, overlay toggle for boxes, before/after slider (Original vs current, or previous vs current), version strip from AutoHDR history (click to revert, free), AI description, CV metrics, findings with actions, plus:
  - "Request a fix" text box → `reedit` with that prompt (cost shown before running).
  - "Draw a mask" brush → `autoremove` (or `autofill` with a prompt).
  - "Remove photographer reflection" → `camera_removal`.
  - "Exclude from delivery."

### 9.5 Review mode (speed)

Full screen, one photo at a time, findings listed beside it. Keyboard: `J`/`K` next/previous, `F` add the selected finding's fix to the cart, `I` ignore, `X` exclude photo, `H` set hero, `B` before/after, `O` overlays, `M` add a manual finding, `?` shortcuts. Target: a clean 40-photo gallery reviewed in under 3 minutes.

### 9.6 Deliver panel and the Deliver button (Aryeo-assisted)

Sticky panel at the bottom of the job page.

**Gate checklist** (live; the Deliver button stays disabled until all pass):

1. No unresolved CRITICAL findings.
2. Every MAJOR finding is fixed, ignored with a reason, or overridden.
3. Coverage: every NOT_MET item is resolved or accepted with a reason.
4. File validation passed: every approved photo decodes, is a JPEG in sRGB, meets the minimum dimensions, and the count matches the approved set.
5. The latest approved version of every photo is staged in `04-FINAL-DELIVERY` (hash match).
6. For re-deliveries: every revision item is done or rejected with a reason.
7. The latest QC run covers every photo's current version, and the gallery (P2) and order coverage (P4) passes completed (checklist Final QC Standard).

Payment status shows as information only. Jordan (OWNER) may "Override and deliver" with a typed reason (logged, and posted to Slack), except when a wrong-property or privacy CRITICAL is open.

**Clicking Deliver:**

1. Copy approved versions into `04-FINAL-DELIVERY/` with sequenced names (`01-Front-Exterior.jpg` ...), write `05-QC/qc-report.json` and `captions.csv`, verify hashes.
2. If the Aryeo order has no listing yet, create one (`POST /listings` with `address_id` and `order_ids`).
3. Aryeo API: move tag to `RTP: Ready to Deliver`; update the internal notes QC block; create task "Import finals and deliver: <address>" assigned to Kyle, due at the SLA time.
4. Open the **Finish in Aryeo** modal:
   - Step 1: **Open listing in Aryeo** (deep link to the listing admin page **[VERIFY URL pattern]**).
   - Step 2: **Upload from Dropbox** → folder path with a Copy button. Files are pre-named in delivery order.
   - Step 3: **Check order** → thumbnail strip of the expected sequence so the admin can match Aryeo's grid at a glance.
   - Step 4: **Deliver Listing** → pre-written delivery message (client profile template, Realtour Pilot Team voice, includes the client's revision link `/r/<token>`) with a Copy button.
   - Button: "Done in Aryeo" (optional; confirmation also comes from Aryeo).
5. Stage `DELIVERING`. Wait for `LISTING_DELIVERED` (webhook) or poll the listing every 2 minutes for up to 2 hours (then remind Kyle by Slack and SMS).
6. **Delivery verification** after Aryeo confirms: `GET /listings/{id}` and check that the gallery image count equals the approved count, filenames match `04-FINAL-DELIVERY` **[VERIFY Aryeo preserves filenames]**, nothing extra is present, and a floor plan exists if one was ordered. Pass → `DELIVERED`. Fail → `DELIVERY_MISMATCH` with a diff and an alert.

**Provider interface** so this can become fully automatic later:

```ts
interface DeliveryProvider {
  id: 'ARYEO_ASSISTED' | 'ARYEO_PARTNER_API' | 'HUB_NATIVE';
  prepare(job: PhotoJob): Promise<{ stagedPath: string; fileCount: number }>;
  deliver(job: PhotoJob, opts: { message: string }): Promise<{ mode: 'OPERATOR_STEPS' | 'AUTOMATIC'; steps?: OperatorStep[] }>;
  verify(job: PhotoJob): Promise<{ ok: boolean; diff?: DeliveryDiff }>;
}
```

`ARYEO_ASSISTED` ships now. `ARYEO_PARTNER_API` is implemented if Aryeo or AutoHDR grant a media push (section 17). `HUB_NATIVE` (branded hub gallery plus Resend email) is the natural bridge to the Aryeo replacement project; leave it as a stub.

---

## 10. AutoHDR credit monitor and alerts

### 10.1 Balance and ledger

- Source of truth: `GET /v1/credits`.
- Poll every 15 minutes (cron), right after every download or transform batch, and on page load (cached 60 s).
- Ledger entries from API responses (`credits_charged` on downloads, capability price on transforms, refunds on no-op or failed jobs) plus a `BALANCE_SNAPSHOT` on each poll.
- Reconciliation: if the change between snapshots does not match ledger entries, insert an `ADJUSTMENT` labeled "outside pipeline" (web app or Aryeo integration usage) or "refill" (increase of 500 or more; Pro adds 1,000 per billing cycle, unused credits roll over while subscribed).

### 10.2 Thresholds (250 and 100, with reset)

```ts
// WARN = 250, CRITICAL = 100, RESET_BUFFER = 50 (settings; env defaults CREDIT_ALERT_WARN / _CRITICAL / _RESET_BUFFER)
async function evaluateCreditAlerts(balance: number) {
  const s = await getCreditAlertState();            // persisted: below250Sent, below100Sent, episodeId, lastBalance
  // Reset only after a real refill or top-up, so small refunds near a threshold cannot re-trigger alerts.
  if (balance >= WARN + RESET_BUFFER) { s.below250Sent = false; s.below100Sent = false; }
  else if (balance >= CRITICAL + RESET_BUFFER) { s.below100Sent = false; }

  if (balance < CRITICAL && !s.below100Sent) {
    s.episodeId = s.below250Sent ? s.episodeId : newId();
    await notify({ kind: 'CREDITS_BELOW_100', severity: 'CRITICAL', dedupeKey: `credits100:${s.episodeId}` });
    s.below100Sent = true; s.below250Sent = true;   // one alert if the balance jumps straight past both
  } else if (balance < WARN && !s.below250Sent) {
    s.episodeId = newId();
    await notify({ kind: 'CREDITS_BELOW_250', severity: 'WARN', dedupeKey: `credits250:${s.episodeId}` });
    s.below250Sent = true;
  }
  s.lastBalance = balance; s.lastCheckedAt = new Date().toISOString();
  await saveCreditAlertState(s);
}
```

- Each alert goes to **Jordan and Kyle** through **Slack, SMS, and the hub** (in-app notification plus the colored chip and, below 100, a persistent banner). The below-100 SMS ignores quiet hours.
- Each alert includes balance, runway in days, credits committed to jobs in progress, and the top-up link.

### 10.3 Runway and pre-flight

- Runway = balance divided by average daily net spend over the last 14 days (refills excluded).
- Committed demand = expected finals for jobs in `UPLOADED` or `EDITING` (1 credit each) plus approved fix batches not yet run.
- Pre-flight before `commit` and before running a fix batch: block if balance is below the estimate (with top-up link); warn in the confirm dialog if the run would cross 100.
- Top-ups happen in the AutoHDR web app (no API, no auto-refill). Link: AutoHDR account billing page **[VERIFY URL]**.

### 10.4 Credits page (settings → Credits)

Balance over 30 days, spend by job and by type (downloads, fixes, styles), cost per delivered listing, editable thresholds and recipients, alert history.

---

## 11. Aryeo API: every use case in this feature

Everything the public API allows that saves admin time. Phase numbers refer to section 15.

| # | Aryeo API | What the hub does with it | Phase |
|---|---|---|---|
| 1 | `GET /orders/{id}` (`include` items, appointments, listing, customer) | Creates the job, expected deliverables, client profile link | 2 |
| 2 | `GET /orders` with `filter[appointment_start_at_gte/lte]`, `filter[fulfillment_status]`, `filter[tag_ids][]` | Reconciler; finds work when webhooks are missed | 2 |
| 3 | `GET /appointments` (+ `APPOINTMENT_SCHEDULED`, `_RESCHEDULED`, `_CANCELED`, `_ASSIGNED` webhooks) | Job schedule, photographer assignment, SLA clock, cancellations | 2 |
| 4 | `GET /company-team-members` | Maps Aryeo photographers to hub users by email for the portal, coaching, and scorecards | 2 |
| 5 | `GET /products`, `GET /product-categories` | Product map setup; Claude suggests "25 Photos → minPhotos 25", "Drone Add-on → droneCount 5", `is_twilight` → twilight; admin confirms | 2 |
| 6 | `GET /order-items/{id}` | Quantities, `is_canceled`, attached `tasks[]` | 2 |
| 7 | `GET /listings/{id}` | Beds, baths, sqft, property type for coverage; `images[]` and `floor_plans[]` for delivery verification; `property_website` links on the job page; `delivery_status` | 2, 5 |
| 8 | `POST /listings` | Creates the listing for the order if it does not exist yet, so the admin never has to | 5 |
| 9 | `GET /listings/{id}/details/search` | Public-record beds and baths when the listing is blank | 5 |
| 10 | `GET /listings/{id}/cubi-casa` | Floor plan status. Catches "floor plan ordered but never scanned/uploaded" before delivery | 5 |
| 11 | `GET /listings/{id}/stats` | Views, visitors, time on page shown on delivered jobs (value report for the client) | 6 |
| 12 | `GET /listings?filter[delivery_status]=DELIVERED` | Delivery confirmation fallback | 5 |
| 13 | `POST/PUT/DELETE /orders/{id}/tags`, `POST /tags` | Pipeline status mirrored inside Aryeo (`RTP: Editing`, `RTP: QC Hold` ...). Kyle can filter Aryeo's order list by these tags | 2 |
| 14 | `PUT /orders/{id}/notes` | QC summary block with the hub link inside the order's internal notes (merged, never clobbering human notes) | 3 |
| 15 | `POST /tasks`, `PUT /tasks/{id}/complete` | "Import finals and deliver" task for Kyle due at SLA; auto-completed on verified delivery. Also completes order-item tasks (for example an "Editing" task template) when the matching stage finishes **[VERIFY task template setup]** | 5 |
| 16 | `GET /customers`, `GET /customer-teams/{id}/memberships`, `GET /customer-team-members/{id}` | Links jobs to client QC profiles; shows on the Deliver panel which team members have `listing_delivery_notification_enabled` (who will get Aryeo's email) | 2, 5 |
| 17 | `POST /customer-teams/{id}/tags` | Optional client tier tags such as `QC: Strict` | 6 |
| 18 | `POST /order-items` | Adds an accepted upsell (virtual twilight, staging) or a $0 "Reshoot (no charge)" line, after admin approval | 6 |
| 19 | `GET /scheduling/available-timeslots`, `POST /appointments/store` (`notify`) | Reshoot assistant: suggests slots for the same photographer; admin confirms before anything is booked | 6 |
| 20 | `POST /order-form-sessions` | Pre-filled order link for an upsell (for example "Add virtual twilight to 123 Main St") sent to the agent | 6 |
| 21 | `GET /orders/{id}/payment-info`, `payment_status` | Shown on the job page and Deliver panel (information only) | 5 |
| 22 | `POST /customer-users/{user}/credit-transactions` | Goodwill credit to a client when a revision was caused by our miss (OWNER approval) | 6 |
| 23 | Webhook `LISTING_DELIVERED` | Confirms delivery, triggers verification | 5 |
| 24 | Webhooks `ORDER_PAYMENT_COMPLETED`, `LISTING_CONTENT_DOWNLOADED`, `ORDER_MEDIA_DOWNLOADED`, `LISTING_VIEWED` **[VERIFY which are emitted]** | Payment and engagement timeline on delivered jobs ("Ashley downloaded the photos 14 minutes after delivery") | 6 |
| 25 | `GET /videos/{id}` | If the order includes video, show its status on the job page (video QC is out of scope) | 6 |

Not possible through the public API (handled by the Aryeo-assisted step or vendor asks): image upload, captions, order, hide, cover image, delivery and its email, download locks, fulfillment status changes after creation.

---

## 12. Extra automations (beyond the brief)

Each one exists to move admin time from checking photos to clients and operations.

1. **Upload preflight** (6.2): catches missing drone, twilight, floor plan, or short uploads while the photographer is still on site or just left, instead of at QC.
2. **SLA radar:** every job has a due time from the appointment. Amber at 6 hours left, red at 2 hours, with Slack and SMS to Jordan and Kyle. The queue sorts by it.
3. **Photographer coaching notes and scorecards:** after QC closes, findings owned by PHOTOGRAPHER become a short, kind note (prompt pack) sent to the photographer (Slack or SMS; Jordan approves sends for the first month, then automatic). The upload portal shows each photographer their top 3 recurring misses as a pre-shoot reminder. Monthly scorecard per photographer: defects per gallery by category, reshoots, turnaround.
4. **Client QC profiles that learn:** when a client's revision requests repeat a pattern (for example toilet lids three times), the hub suggests raising that rule's severity for that client. One click to accept. Profiles also hold preferred AutoHDR models, TV and fireplace settings, SLA, sequence, and the delivery message.
5. **Hero picker and sequence:** P0 hero score plus the sequence template produce an MLS-ready order. Filenames carry the order into Aryeo.
6. **Client revision page** (`/r/<token>`, linked in the delivery message): the agent taps photos and types what they want. The Revision Interpreter turns it into fix items with costs; items that would misrepresent the property ("remove the crack in the driveway") are flagged for Jordan. Approved items run through the same Fix Cart and re-delivery flow. The admin then replaces only the listed files in Aryeo (the hub lists exactly which ones).
7. **Upsell previews (opt-in per client):** if no twilight was ordered and P0 finds a strong front exterior, offer to generate one virtual twilight preview (about 5 credits, shown before running). Vacant rooms can get a staging preview. If the agent buys, the hub adds the Aryeo order item and an order form session link.
8. **Weekly QC digest (Slack, Monday 8 am):** galleries delivered, average turnaround, top issues, trends per photographer, credits used, runway, Claude cost.
9. **Wrong-property guard:** EXIF GPS (drones and phones) compared with the listing's coordinates (flag beyond 300 m), plus the P2 "looks like a different property" check.
10. **Captions file:** `05-QC/captions.csv` with room and factual description per photo, ready for MLS remarks or social posts.
11. **Goodwill credits:** one-click Aryeo customer credit when a revision was our fault (OWNER only).
12. **AutoHDR MCP for ad hoc work:** connect it in Claude for questions like "what's our credit balance" or "re-edit photo 14 to brighten the kitchen" without opening AutoHDR.
13. **Optional last-mile helper:** the "Finish in Aryeo" modal has a "Copy steps for Claude in Chrome" button with the exact import-and-deliver steps for that listing, so Claude in Chrome can do the clicks while the admin watches and confirms the final Deliver click.
14. **Analytics page** (`/ops/photo-delivery/analytics`): recurring defects by photographer, editor (AutoHDR model or manual editor), property, client, checklist category, and rule (checklist section 22); trends by month; false-positive rate per rule; QC minutes per gallery; revision rate; turnaround versus SLA; AutoHDR credits and Claude cost per delivered listing.

---

## 13. Security, reliability, observability

- **Roles:** OWNER (Jordan): everything, overrides, settings, approvals above the cap. ADMIN (Kyle): review, fix within the credit cap, deliver. PHOTOGRAPHER: upload portal only, token-scoped. CLIENT: revision page only, token-scoped.
- **Secrets** live in Vercel env, never reach the browser. The upload portal never sees a Dropbox token (temporary upload links only).
- **Tokens** for `/upload` and `/r` pages: 32 random bytes, stored hashed, expiring, rate limited, revocable from the job page.
- **Webhooks:** Dropbox, Aryeo, and QStash signatures verified on the raw body, constant-time compare, replay protection by event id.
- **Privacy:** findings flagged `privacySensitive` never send image crops to Slack or SMS. Notifications carry the address and a hub link only.
- **Reliability:** idempotent step handlers, optimistic stage versioning, Redis locks around AutoHDR head-version changes, reconciler cron, 7-day AutoHDR expiry tracked per job (warn at day 5 if fixes might still be needed).
- **Observability:** structured logs with `jobId`, `step`, vendor request ids (`X-Request-Id` from AutoHDR); a "Stuck jobs" admin view; errors to a dev Slack channel; per-job cost breakdown (AutoHDR credits and Claude dollars).
- **Spend guardrails:** daily cap on automated credit spend (setting), monthly Anthropic budget alert, fix approval caps.
- **Retention:** Dropbox keeps masters. Blob derivatives kept 90 days after delivery. Findings and ledger kept for analytics.

---

## 14. Configuration

```bash
# AutoHDR
AUTOHDR_CLIENT_ID=
AUTOHDR_CLIENT_SECRET=
AUTOHDR_API_BASE=https://external.realestatephotoediting.com
AUTOHDR_TOKEN_URL=https://new.autohdr.com/api/auth/oauth2/token
AUTOHDR_RESOURCE=https://external.realestatephotoediting.com/v1
AUTOHDR_USD_PER_CREDIT=0.50

# Dropbox
DROPBOX_APP_KEY=
DROPBOX_APP_SECRET=
DROPBOX_REFRESH_TOKEN=
DROPBOX_ROOT_NAMESPACE_ID=
DROPBOX_JOBS_ROOT="/Realtour Pilot/Jobs"

# Aryeo
ARYEO_API_BASE=https://api.aryeo.com/v1
ARYEO_API_TOKEN=
ARYEO_WEBHOOK_SECRET=
ARYEO_ADMIN_BASE_URL=https://realtourpilot.aryeo.com/admin

# Anthropic (see prompt pack 0.1 for every model var)
ANTHROPIC_API_KEY=
QC_MODEL_P0=claude-haiku-5-5
QC_MODEL_P1=claude-sonnet-5-5
QC_MODEL_ARBITER=claude-opus-5-5
QC_MODEL_P1B=claude-sonnet-5-5
QC_MODEL_P2=claude-opus-5-5
QC_MODEL_P3=claude-opus-5-5
QC_MODEL_P4=claude-sonnet-5-5
QC_MODEL_FIX_PLANNER=claude-opus-5-5
QC_MODEL_POST_FIX=claude-sonnet-5-5
QC_MODEL_REVISION=claude-sonnet-5-5
QC_MODEL_COACHING=claude-sonnet-5-5
QC_MODEL_SUMMARY=claude-haiku-5-5

# Notifications (recipients: Jordan and Kyle)
SLACK_BOT_TOKEN=
SLACK_CHANNEL_OPS=
SLACK_USER_ID_JORDAN=
SLACK_USER_ID_KYLE=
OPENPHONE_API_KEY=
OPENPHONE_FROM_NUMBER=
ALERT_SMS_JORDAN=
ALERT_SMS_KYLE=

# Orchestration and storage
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
BLOB_READ_WRITE_TOKEN=

# Feature flags and thresholds
PHOTO_DELIVERY_ENABLED=false
QC_SHADOW_MODE=true
QC_MAX_BUILD_PHASE=1
CREDIT_ALERT_WARN=250
CREDIT_ALERT_CRITICAL=100
CREDIT_ALERT_RESET_BUFFER=50
QC_LONG_EDGE=2048
UPLOAD_TOKEN_SECRET=
REVISION_TOKEN_SECRET=
```

Settings stored in the database (editable on the settings page): thresholds, mask padding (`fix.maskPaddingPct` 10, `fix.maskPaddingMinPx` 16), recipients, quiet hours, approval caps, auto-fix toggle, CV thresholds, sequence template, delivery message templates, client profiles, product map.

---

## 15. Implementation phases

Each phase: feature-flagged, tested, demoed to Jordan, notes written. Estimates assume one focused Claude Code workstream.

### Phase 0: Prerequisites (1 to 2 days)

- Confirm the hub's Phase 0 stabilization items are fixed (section 0.2).
- Credentials: AutoHDR API client (Account settings → Developer), Dropbox app (Full Dropbox, scopes in 2.4, refresh token, root namespace id), Aryeo personal access token, Slack bot, OpenPhone API key, Anthropic key, QStash.
- Email Aryeo support to enable webhooks and send the vendor questions (section 17). Ask the AutoHDR account manager the AutoHDR questions.
- One-time scripts: create Aryeo `RTP:` tags; pull Aryeo products and seed the product map (Claude-suggested, Jordan confirms); seed client profiles for the top clients; map Aryeo team members to hub users.
- Run `?include=fake` discovery on Aryeo orders, listings, appointments and record the valid includes in code.
- **Done when:** `GET /v1/me` returns the Realtour Pilot account and balance; Dropbox can create a folder in the team space; Aryeo returns an order with items and appointment; a Slack, SMS, and in-app test notification reaches Jordan and Kyle.

### Phase 1: Credit monitor and notifications (2 to 3 days, quick win)

- Notification service (in-app, Slack, SMS) with dedupe and quiet hours.
- Credit poller, ledger, alert state machine (250 and 100), runway, header chip, Credits settings page.
- **Done when:** with the threshold temporarily set above the live balance, Jordan and Kyle each get one Slack message, one SMS, and one in-app notification; raising the balance above the threshold (simulated) resets the flags; no duplicate alerts on repeated polls.

### Phase 2: Intake, upload portal, editing pipeline, basic delivery page (1.5 to 2 weeks)

- Aryeo intake (webhook receiver + reconciler), product map, `ExpectedDeliverables`, Dropbox folders, upload tokens.
- Upload portal with direct-to-Dropbox upload, content-hash verification, preflight checks, Finish.
- AutoHDR orchestration: from-urls (or fallback), commit, polling, download, save to Dropbox, derivatives, describe.
- Queue and job detail page with gallery, reorder, hero, exclude, lightbox (no QC yet), manual "Mark ready."
- Aryeo tags mirror.
- **Done when:** a real test shoot (a small set of display JPEGs to limit credit spend) goes from portal upload to edited photos visible in the hub and saved in `02-AUTOHDR/v1/` with no manual step, Aryeo shows the right `RTP:` tags, and a forced AutoHDR failure produces an `EDIT_FAILED` alert.

### Phase 3: QC engine v1 (2 weeks)

- Load `qc-rules.seed.json`; generate TS enums.
- CV metrics (blur, exposure, dust candidates, recurrence, dHash, color stats, file checks).
- P0, P1, P1 arbiter, P1b with build-phase-1 **per-photo** rules (the checklist's section 23 priority detections that can be judged from one photo), plus every CRITICAL per-photo rule. Gallery, original-vs-edited, and order rules arrive with their passes in Phase 5.
- Findings, groups, severity policy, verdicts, Issues tab with box overlays, review mode, Aryeo notes block, Delivery Summary.
- `qc-eval` harness and golden set; shadow mode on.
- **Done when:** on the golden set, the per-photo priority groups (sensor dust, photographer reflections, toilet seats and bathroom clutter, trash and cleaning supplies, painter's tape, hoses and cars, blur and exposure) meet the targets in `04-QC-PROMPT-PACK.md` section 12.3; a 40-photo gallery completes QC within that section's latency and cost targets (15 minutes, $2.50); Claude cost per gallery is logged.

### Phase 4: Fix Cart and fixes (1.5 weeks)

- Live price catalog, Fix Planner, cart UI with Fix all, Ignore, Select, approval caps, pre-flight checks.
- Mask generation and asset uploads, transforms with idempotent submission, polling, versions, before/after, revert.
- Post-Fix Verification, retry, escalation, re-QC, editor path via Dropbox.
- **Done when:** on a test gallery, approving 5 fixes runs them, the ledger matches the balance change, a forced bad fix is auto-reverted, and every result is visible as a before/after.

### Phase 5: Gallery, original-vs-edited, coverage, delivery (1.5 weeks)

- P2, P3 (with original fetch), P4 with Aryeo data (listing, CubiCasa, products, custom fields).
- Delivery gate, sequencing and staging, `ARYEO_ASSISTED` provider, Finish in Aryeo modal, task creation, listing creation when missing.
- `LISTING_DELIVERED` handling (or polling), delivery verification, `DELIVERY_MISMATCH`.
- Raise `QC_MAX_BUILD_PHASE` to 3 after shadow-mode results support it.
- **Done when:** an end-to-end real job goes from upload to verified delivery with the admin doing only: review, approve fixes, and the Aryeo import plus Deliver click; a deliberately missing drone photo is caught as NOT_MET; a deliberately skipped file in Aryeo raises `DELIVERY_MISMATCH`.

### Phase 6: Revisions, coaching, analytics, upsells (1.5 weeks)

- Client revision page and interpreter, re-delivery flow with replacement list.
- Coaching notes, photographer scorecards, weekly Slack digest, analytics page.
- Client profile learning suggestions, goodwill credits, upsell previews (opt-in), reshoot assistant, engagement timeline.
- **Done when:** a test revision request on a delivered job produces interpreted items with costs, runs through fixes, and re-stages only the changed files; the Monday digest posts with real numbers.

### Phase 7: Later

- `ARYEO_PARTNER_API` provider if Aryeo or AutoHDR grant media push and delivery.
- `HUB_NATIVE` provider as part of the Aryeo replacement project.
- CV verticals detector; presets; video QC.

---

## 16. Testing

- **Unit:** rule filtering by room, severity escalation, grouping, verdicts, cost estimator, mask rendering and bbox scaling, credit alert state machine (every crossing and reset case), internal-notes merge, filename sequencing, Dropbox content hash.
- **Contract tests with recorded fixtures (msw):** AutoHDR (every endpoint in 5.1.2 and every error code in 5.1.3), Dropbox, Aryeo (use Aryeo's mock server `https://docs.aryeo.com/_mock/api/aryeo` to record), Anthropic (structured output samples from the prompt pack).
- **Live smoke tests (manual trigger only, never in CI):** AutoHDR has no sandbox, so use a 3-photo display-JPEG shoot to keep spend to a few credits.
- **QC evaluation:** `pnpm qc:eval` on the golden set; fails CI if precision or recall for a blocking rule group drops more than 5 points versus the last baseline.
- **E2E (Playwright):** upload portal, queue, job page, review shortcuts, Fix Cart decisions, Deliver gate, Finish in Aryeo modal.
- **Chaos checks:** kill a step mid-transform (job must recover via `listTransforms`), duplicate webhooks, expired temporary links, 402 from AutoHDR, Aryeo webhook never arrives (polling fallback).

---

## 17. Open questions and vendor asks

### AutoHDR (Pro plan includes a dedicated account manager)

1. Can photoshoots created through the API be pushed to a linked Aryeo listing, the way the Aryeo-side AutoHDR integration does? If yes, the Aryeo import step disappears.
2. Does `POST /v1/photoshoots/from-urls` accept Dropbox temporary links (`*.dl.dropboxusercontent.com`)?
3. Are webhooks or a status callback planned for v1 (the legacy v2 API had `status_callback_url`)?
4. Can a specific (non-head) version be downloaded without changing the head? Is the `setPhotoVersion` → download → `setPhotoVersion` pattern free and safe?
5. Is `autoremove` 0 credits through the API, and is one call with a multi-region mask charged once?
6. API rate limits and maximum files per photoshoot.
7. Timeline for `Idempotency-Key` support.
8. Can sky replacement style be set per photoshoot through the API?
9. For bracketed RAW sets, what exactly is the "Original" step in photo history?

### Aryeo

1. Enable webhooks for the Realtour Pilot account; send the full list of emitted event names and confirm the `Signature` format.
2. Is there partner or private API access for listing media upload, ordering, captions, and delivery (as used by the AutoHDR and Esoft integrations)?
3. Rate limits.
4. Structure of order `custom_fields` (special instructions, requested features).
5. Are imported images hidden from the client until the listing is delivered?
6. Does "Upload from Dropbox" keep filenames and sort by them?
7. Can the delivery email template include a per-order value we supply (for the revision link)?

### Decisions for Jordan (defaults in brackets)

1. Kyle's fix approval cap [25 credits per batch].
2. Auto-apply zero-credit fixes [off].
3. Coaching notes: approve each before sending for the first month [yes], channel [Slack DM].
4. Upsell previews [off until Phase 6 review].
5. Which clients get profiles first [top 10 by order volume, starting with The Brunner Group].

---

## 18. Sources

- AutoHDR AI Integrations page: https://new.autohdr.com/api
- AutoHDR External API reference: https://external.realestatephotoediting.com/reference (spec: `/openapi.json`, `/llms.txt`)
- AutoHDR knowledge base: https://knowledge.autohdr.com/faqs, https://knowledge.autohdr.com/sops/ai-tools, https://knowledge.autohdr.com/sops/uploading-photos
- AutoHDR pricing: https://new.autohdr.com/pricing
- Aryeo API docs: https://docs.aryeo.com/api/aryeo, webhooks guide https://docs.aryeo.com/docs/4-setting-up-webhooks, spec https://docs.aryeo.com/_bundle/api/aryeo.json
- Aryeo help: Public API https://support.aryeo.com/en/articles/5528213-public-api, Uploading and Delivering Media https://support.aryeo.com/en/articles/4734143-uploading-and-delivering-media, AutoHDR Integration https://support.aryeo.com/en/articles/15451006-autohdr-integration
- Dropbox: https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/get-temporary-upload-link, https://docs.dropboxapi.com/dropbox-api/docs/webhooks, https://docs.dropboxapi.com/dropbox-api/docs/team-files
- Vercel function limits: https://vercel.com/docs/functions/limitations
- Claude vision and coordinates: https://platform.claude.com/docs/en/build-with-claude/vision, https://platform.claude.com/docs/en/build-with-claude/vision-coordinates, structured outputs https://platform.claude.com/docs/en/build-with-claude/structured-outputs



