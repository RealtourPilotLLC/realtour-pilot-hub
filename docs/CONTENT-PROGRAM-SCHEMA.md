# CONTENT PROGRAM OPERATING SYSTEM — schema design (Sep 16 2026)

The one additive schema for `/Users/jordanspackman/Downloads/Realtour-Pilot-Client-Content-Portal-Spec.md` (27 sections),
so that every builder after this works against a fixed model and nobody touches migrations.

- Edited file: `/Users/jordanspackman/Realtour Pilot POT Dashboard/prisma/schema.prisma` — new models in ONE contiguous
  block at the end under `// ===== CONTENT PROGRAM OPERATING SYSTEM (Sep 16 2026) =====`; additive columns inside ten
  existing models, each group marked `// ---- CPOS (Sep 16 2026)`.
- `npx prisma format` applied, `npx prisma validate` passes. 116 models (73 existing + 43 new). Nothing pushed.
- Pre-edit copy of the schema: `schema.before.prisma` beside this file. Diff scripts: `push-preview.sql` (live DB →
  new schema, regenerated after the reviewer round; `migrate-diff.sql` is the pre-review copy) and `datamodel-diff.sql`
  (pre-edit schema → new schema).
- Reviewer round (Sep 16, verdict APPROVE with should-fix items): every should-fix applied, every coverage gap answered
  in §7, the changes listed in §8. Verification below is the POST-fix state.

## 0. Verification (read-only)

| Check | Result |
|---|---|
| `npx prisma validate` | valid |
| `prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script` → `push-preview.sql` (1789 lines) | **CREATE TABLE 43 · ALTER TABLE … ADD COLUMN 10 (one per extended table, 87 column clauses: 86 nullable, 1 `NOT NULL DEFAULT false` = ContentScript.historical) · CREATE INDEX 137 (15 on existing tables, 122 on new) · CREATE UNIQUE INDEX 32 (ALL on new tables) · anything else: 0** (no DROP, no ALTER COLUMN, no RENAME, no ADD CONSTRAINT / FOREIGN KEY, no CREATE TYPE / ALTER TYPE) |
| same diff from `schema.before.prisma` → new schema (`datamodel-diff.sql`) | identical statement SET (only the order of the ten ALTER TABLE statements differs between the two generators) — proves every statement is mine |
| `npx prisma format` run twice | second run is a byte-for-byte no-op |
| `npx prisma generate` against a throwaway copy (in-project path, output into the scratchpad, copy removed) | succeeds — db:push's post-generate step cannot fail |
| identifiers > 63 chars (Postgres limit) in the preview | none |
| R3 programmatic check on all 43 new models | cuid id, `createdAt @default(now())`, `updatedAt @updatedAt` on every one |
| `migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel schema.before.prisma` | `-- This is an empty migration.` (live DB == committed schema; zero pre-existing drift) |
| ADD COLUMN with NOT NULL and no DEFAULT | none |
| `@relation` in the new block | none (the one grep hit is the header comment) |
| duplicate model names | none |
| git stat noise | `prisma format` realigned column whitespace across existing models and reflowed six `/** … */` doc comments (TopazJob, ReviewSubmission, CommLog) into its canonical layout; text unchanged, semantics unchanged (proved by the datamodel diff above). |

Human's steps, once, after review: `npx tsx scripts/backup-content-program.ts` then `npm run db:push`.

## 1. Rules obeyed

- **R1 additive only** — no renames, drops, type changes, NOT NULL without default, no enum edits (no Prisma enums used at all).
- **R2 no @relation** — every reference in the new block is a plain `String` id, indexed. The house style of every Content*/Portal* model and the only style that pushes cleanly against live data with known orphans (mis-filed calls on Gary Mercer Sr, the duplicate "Rick Schultz(don't use)"). The diff therefore contains no FK constraint.
- **R3** — every new model: `id String @id @default(cuid())`, `createdAt @default(now())`, `updatedAt @updatedAt`; indexes on every foreign-id column readers will query; `@@unique` where idempotency is demanded (see §4).
- **R4 naming** — prefix = the layer that owns the record (stated in the block header):
  `Client*` a client person or something the client authored/owns · `Content*` the creative chain · `Program*` the operating layer (sessions, calls, jobs, reminders, policy, owners, automation switches, publishing) · `Portal*` client-facing surfaces. All four prefixes already exist in the schema (Client, Content*, ProgramSignup, Portal*). No name collides with Resource, Sop, Activity, Feedback, Notification, Connection, etc.
- **R5 versioning tables** — ContentStrategyVersion, ContentScriptVersion, ContentTopicRefreshRun (+ContentTopicSuggestion), ProgramGenerationPolicyVersion, ClientAssetVersion. Current rows hold pointers (`currentVersionId`, `approvedVersionId`, `sharedVersionId`, `activeVersionId`); approval is who/when/which-version on the version row and in the ContentScriptRelease ledger.
- **R6 automations** — every automation is a durable row with `state/status + attempts + leaseUntil/leaseBy + nextAttemptAt + lastError(+At)`: ProgramTranscriptJob, ProgramAiRun, ContentTopicRefreshRun, ContentCutTranscript, ProgramReminder (lease added in the reviewer round), ProgramPublishingJob, ProgramSessionRequest (booking job). The switch is `ProgramAutomation.enabled Boolean @default(false)` — OFF at the database, not in code — and because the push creates no rows, **a missing row means DISABLED for every key** (see §5).
- **R7** — ClientUser + ClientMembership are their own thing; AppUser/Role untouched.

### Orchestrator name → model name

| Named in the brief | Model here | Why |
|---|---|---|
| SessionRequest | ProgramSessionRequest | Program* = operating layer |
| TopicEvent / TopicInterview / InterviewAnswer / TopicRefreshRun | ContentTopicEvent / ContentInterview / ContentInterviewAnswer / ContentTopicRefreshRun | Content* = creative chain |
| LogicalVideo | ContentVideo (+ ContentVideoSource) | |
| CutTranscript | ContentCutTranscript | |
| CaptionDraft | ContentCaptionDraft | |
| ImportBatch / ImportItem | ContentImportBatch / ContentImportItem | |
| CalendlyEventMapping / CallRecord / TranscriptJob | ProgramCalendlyEventMapping / ProgramCallRecord / ProgramTranscriptJob (+ ProgramTranscriptSource) | |
| ProgramMonthOwner | ProgramOwnerAssignment (scope DEFAULT / ENROLLMENT / MONTH) | one table for defaults and overrides |
| EnrollmentChange | ProgramEnrollmentChange | |
| ReminderLedger | ProgramReminder | one row = one attempt; it is the ledger |
| GenerationPolicyVersion | ProgramGenerationPolicyVersion | |
| PublishingAccount / PublishingJob | ProgramPublishingAccount / ProgramPublishingJob | |
| AiRun | ProgramAiRun (+ ProgramAiQuota) | |
| onboarding record | ProgramOnboarding | |
| ClientDecision / ClientFact / ClientAsset / ClientEmailAlias | same (+ ClientAssetVersion) | client-owned |
| "extend Resource … else a ProgramResource view" | PortalResource | `Resource.url` is required and it is Kyle's staff link list; a client guide is a body, not a link. Separate model, unpublished by default. |
| ReminderPolicy settings shape | `ProgramAutomation("reminders").configJson` — shape in §5 | a switch row with config beats a code-default AppSetting for "OFF at the database" |

### Deviations from the SYNTHESIS §5 Phase 1 design (reused otherwise verbatim)

- `PortalVisit.at` → `createdAt` (+ `updatedAt`) so the model obeys R3; the index is `[enrollmentId, createdAt]`. No code references `at` yet.
- `ClientMembership` gained `updatedAt` (R3), `revokedBy`, and `@@index([clientId])`.
- Enrollment/PortalComment/ScriptSuggestion/ReviewSubmission columns are exactly the Phase 1 list, plus the §8 columns the spec needs on the same tables (threading, resolution, release, decision pointer, byte hash).

## 2. Model → spec → acceptance criteria → owner

"Owner" = the code area that writes the row (readers may be anywhere). Paths are suggested homes under `src/lib/` / `src/app/`.

| Model | Spec | Acceptance criteria it satisfies | What code owns it |
|---|---|---|---|
| **ClientUser** | §2 | individual sign-in by email link; approval "records the actual person"; removed collaborators lose access (status DISABLED) | `src/lib/auth/clientSession.ts`, `/portal/login` + `/portal/auth/[token]` |
| **ClientMembership** | §2 | explicit membership per account+program; owner/collaborator/viewer; revocation immediate (re-read per request, `revokedAt`); cross-client id substitution refused via `clientId` | `src/lib/portal.ts resolvePortalViewer`, `content/actions.ts invitePortalUser/revokePortalUser` |
| **PortalVisit** | §2, §15 metrics | "does anyone use it" measurable; no token in analytics (hub UsageEvent still excludes /portal) | `src/app/portal/[token]/page.tsx` render (one row per render) |
| **ClientEmailAlias** | §26, D6/D16 | invitee → unambiguous client; two clients on one address = exception, never a guess | `src/lib/contentCalls.ts` matcher; client file Settings |
| **ContentStrategyVersion** | §3, §21, §27 | version + approval date shown; "each selected topic and generated script records the strategy version used"; approving a newer version never rewrites historical scripts; source's own structure preserved (`structureTemplate`, `sectionsJson`); discovery vs monthly sources separate (`sourceKind`, `callRecordId`); draft never client-visible (`releasedAt` gate, not a text filter) | `src/lib/contentStrategy.ts` (new): import path, AI draft path, approve, release |
| **ContentStrategyProposal** | §3, §23, §21 | a call proposes, never overwrites; staff see proposal + source + impact before accepting; monthly call cannot replace the brand foundation | `contentPipeline.ts` (writes from call analysis), client file Strategy tab (resolve) |
| **ContentPillar** | §5, §18, §27 | stable pillar identity; client-specific names never replaced by a generic set; `topicsPerPillar × pillarCount` | strategy import/approval creates them; client file Strategy tab |
| **ContentPillarAlias** | §18, §27, manifest C-A6/C-C4 | pillar renames keep identity; importer never fails on a label — queues a mapping; "valid pillar linkage" validator | importer, topic refresh (rename with approval) |
| **ContentTopicEvent** | §5 | "history" per topic; "discussed on a call" ≠ selected/approved/filmed; rejection reasons kept internally | every topic writer (`contentPipeline.ts`, portal topic actions, importer, refresh) |
| **ContentTopicSelection** | §5, §14, §19 | select for a named month / remove uncommitted / staff reconcile after the call; overflow kept not deleted; unique per topic+month so changing paths cannot duplicate | portal Topics page actions; call analysis (proposed); staff reconcile |
| **ContentTopicRefreshRun** | §18, §21, §27 | one click → reviewable suggestions; duplicate clicks do not create duplicate jobs (`dedupeKey`); stale inputs shown (`inputsJson`); insufficient context = NEEDS_INPUT with `missingContextJson`, never padded | `src/lib/topicRefresh.ts` (new) driven from cron/`ProgramAutomation("topic_refresh")` |
| **ContentTopicSuggestion** | §18, §27 | accept/edit/archive/regenerate each; previous suggestions accessible; archived concepts not reintroduced (`dedupeHash`, `reintroducedOfId`); "Recommended for your next session" with linked goal / pillar / prior-content relation / why-now; "No verified filming history" | same |
| **ContentInterview** | §6, §19 | interrupted interviews resume (`currentQuestionKey`, `questionPlanJson`); sufficiency evaluated, targeted follow-ups (`sufficiencyJson`, NEEDS_FOLLOWUP; CP-08: at most two gap questions, `gapQuestionsAskedAt`; SUBMITTED only when sufficient, else the client may send as SUBMITTED_WITH_GAPS — no `submittedAt`, no prep clock, no auto-draft, a Kyle task `program-answer-gaps:<id>`); both paths (WRITTEN/CALL) feed one queue; no duplicate per topic+month — `monthId` is REQUIRED so the `@@unique([topicId, monthId])` guard really holds (Postgres treats NULLs as distinct); an interview always belongs to the month whose scripts it feeds, there is no bank-level interview | portal Topics → interview flow; `contentPipeline.ts` for CALL-sourced |
| **ContentInterviewAnswer** | §6, §20 | regenerating cannot erase edits (new row supersedes); scripts identify their source answers; speaker attribution; skip / don't know; reuse known answers | same |
| **ContentScriptVersion** | §6, §22, §27, Jordan's rulings | exactly three points as structured roles (`pointsJson`, `validationJson`); strategy + policy version recorded; source answers (`answerIdsJson`) / call; uncertain claims flagged (`gapsJson`); edits after sharing = new version; regeneration preserves manual edits (`regeneratedSections`); C-A9 extras kept; the 20–30 s target is NOT stored per version — readers get it through `policyVersionId` → ProgramGenerationPolicyVersion, so no per-script column can become a duration override (`timingNote` is prose, `estimatedSeconds` is a measurement) | `src/lib/contentScripts.ts` (new): generate, revise, regenerate-section, approve; Review Room Scripts queue |
| **ContentScriptRelease** | §22 | approval causes sharing exactly once; email + portal refer to the approved version; batch → one notification (`batchKey`); "approval succeeded, email failed" are two facts (`notificationState`, `outboxMessageId`) | Scripts queue "Approve & share" action |
| **ContentVideo** | §7, §9, §16 | grouped by obligation month with filmed/delivered dates separate; multiple sources do not inflate counts; listing videos labelled and excluded from allowance unless mapped (`kind`, `countsTowardAllowance`, `mappedBy`); explicit topic→script version→session→deliverable→cut links; "marked as posted" ≠ published | library sync (`portalLibrary.ts` rewrite), Review Room approve hook, staff mapping UI |
| **ContentVideoSource** | §7 | unique (kind, ref) — source synchronization can never create duplicates; distinct outputs stay visible | same |
| **ClientDecision** | §8 | approve / request-changes keyed to the immutable `submissionId` + `contentHash`; attributable (`clientUserId`/`staffUserId`/`actorLabel`); a new cut needs its own decision (`supersededById`); duplicate submissions → one revision job (`dedupeKey`, `revisionTaskId`); open-notes choice recorded | `src/app/portal/actions.ts` (approve / request changes) |
| **ContentCutTranscript** | §9, §10 | transcript stored per cut version (`@@unique([submissionId, version])`, `contentHash`); human corrections kept beside machine text; cut change invalidates readiness (`invalidatedAt`); job states + lease | `src/lib/cutTranscripts.ts` (new), gated by `ProgramAutomation("cut_transcripts")` |
| **ContentScriptMatch** | §9 | evidence, confidence, alternatives shown to staff; never forced / auto-approved; correcting a match keeps history | historical linking tool in the client file |
| **ContentCaptionDraft** | §10 | drafts tied to cut version + strategy version + author + history (`basedOnId`, `versionNo`); regeneration never overwrites edits; final drafts tied to the chosen approved cut; STALE on cut change; nothing published because a caption exists | video detail "Caption & CTA" section, gated by `ProgramAutomation("caption_assistant")` |
| **ProgramSessionRequest** | §4, §16 | "Requested, awaiting confirmation" until an Aryeo appointment exists (`projectId`); explicit program month; reschedule/cancel history (`supersedesId`); duplicate clicks collide (`dedupeKey`); stale slot cannot double-confirm (booking job + `aryeoAppointmentId`); package/extra capacity recorded | `src/app/portal/actions.ts` (request), Kyle's ops screen (confirm), Aryeo reconcile |
| **ProgramOwnerAssignment** | §16, §17, D11 | "assigned owner" column; escalation owner for reminders; defaults Jordan (strategy/scripts) + Kyle (scheduling/delivery), overridable per client or month | Settings screen; readers: roster, reminders |
| **ProgramEnrollmentChange** | §17 | package changes carry an effective date + current-month choice; past-month quantities preserved; internal setting vs billing truth distinguished; no implicit billing action | `content/actions.ts` enrollment settings writer, Aryeo/Stripe sync |
| **ClientAsset / ClientAssetVersion** | §17 | ownership, type, active version, source; replacing a logo changes future defaults without rewriting delivered work | Brand & Assets tab; existing Dropbox client folder stays the file store |
| **ProgramCalendlyEventMapping** | §26, §21, D6 | classification by event-type URI only; missing mapping = configuration exception; renaming a mapped event does not break it; delete/recreate needs a verified update (`validationStatus`) | `/connections` settings screen; `src/lib/integrations/calendly.ts` |
| **ProgramCallRecord** | §20, §26, §16 | event uri / invitee uri / event type / purpose / calendar external id / Meet link / target month or onboarding; unknown invitee = unmatched, not guessed; ambiguous month/type → exception queue (`matchState`); a late-September call plans October (`monthId`); cancel/reschedule history; internal record shows booking link, call type, client, source event, transcript link, analysis state, last error | `src/lib/contentCalls.ts` rewrite (Calendly sync writes these instead of stamping ContentMonth) |
| **ProgramTranscriptSource** | §20, §26 | dedupe across sources (`contentHash` unique); corrected transcript = new version (`supersedesId`); candidates presented with title/time/participants for staff confirmation; Meet readiness (`readinessState`); historical transcripts enter an import review queue (UNMATCHED) | Drive sweep, Meet API path, manual paste/upload |
| **ProgramTranscriptJob** | §20 | queued/running/succeeded/failed/needs-review with lease; marking processed before success cannot suppress retries; reruns cannot duplicate (`dedupeKey`, format per kind in §4); duplicate ingestion (Drive copy + Meet copy of one meeting) yields ONE analysis because every kind except INGEST is keyed per call, not per source; failed step visible + retryable | `contentPipeline.ts` rewrite, gated by `ProgramAutomation("transcript_jobs")` |
| **ProgramOnboarding** | §21, §26 | program + discovery requirement + booking + source call + intake + asset completeness + generated draft + approval; discovery waivable only explicitly; a discovery event creates onboarding work and does not stamp a monthly call | onboarding flow (signup sweep creates the row), discovery analysis |
| **ClientFact** | §23, §3, §6, §20 | every fact carries source, date, client, scope, status, supersession; permanent vs month vs project scope; conflicting instructions become exceptions (`conflictsWithId`), confidence never overrides; inspect + undo; reported performance ≠ verified analytics (category); generators read ACCEPTED + `aiContext=ALLOWED` only; confidentiality structured (`confidential`), not a marker | `contentPipeline.ts` (extract), client file "Updated from your latest call" strip, generators' context builder |
| **ProgramAiRun** | §13 | every run records client scope, input refs, prompt/model version, output ref, status, cost, human disposition; cancellation + retry + observable failure | `src/lib/integrations/ai.ts` wrapper (all AI calls go through it), gated by `ProgramAutomation("ai_runs")` |
| **ProgramAiQuota** | §13 | quotas per global / enrollment / kind per day / month | same wrapper; settings screen |
| **ContentImportBatch** | §14, §5 | original source preserved; preview before apply; repeated imports idempotent (`@@unique([kind, contentHash])`); month rule confirmed per client (`proposedMonthKey`, D10) | `content/actions.ts` import actions (rewrite of the APPROVED-on-import path) |
| **ContentImportItem** | §14, §5, §27 | create / link / update-proposal / conflict / skip per item; imported ideas traceable to source text; colour marks = proposals (`importedMark`, `proposedState`); pillar labels mapped via alias; no duplicate topics on re-import (`@@unique([batchId, sourceHash])` + `sourceHash` index across batches) | same |
| **ProgramReminder** | §24, §19, §22 | client/month/action/template/attempt/provider id/outcome/next-eligible/suppression stored; recheck before send (`evaluatedStateJson`); booking stops queued reminders, no-call choice changes the type, paused → none (suppressionReason); duplicate runs collide (`dedupeKey`); manual send-now shares safeguards + history; escalation task ref; the evaluator claims a row (`leaseUntil/leaseBy`) before the recheck + enqueue and retries a failed enqueue on `nextAttemptAt` (`nextEligibleAt` stays the business-time clock) | `src/lib/programReminders.ts` (new) hourly evaluator, gated by `ProgramAutomation("reminders")`; sends through OutboxMessage (which has its own lease + dedupeKey for the actual send) |
| **ProgramGenerationPolicyVersion** | §27, manifest §2.4/§9 | one versioned policy: template, manifest, `topicsPerPillar` (10, max 15), timing 20–30 s, exactly 3 points with roles, format, rules, rubric, validators; version stamped on banks, strategies, scripts | settings screen (owner); readers: every generator |
| **ProgramAutomation** | R6, §13, §24, §12, spec preamble | every automation OFF until launch is authorised; who enabled it and when; last run / last error visible; **no row = disabled** (the push seeds nothing) | `/connections` or Settings → "AI Assistants"; every job driver calls one shared `isAutomationEnabled(key)` that returns `false` when the row is missing |
| **ProgramPublishingAccount** | §12 | account identity, secure credentials, connect / disconnect / consent revoked; disconnect stops queued jobs | Instagram phase (later) |
| **ProgramPublishingJob** | §12, §10 | explicit publication approval; timezone; job status; retries without duplicate posts (`dedupeKey`, provider ids); success only on confirmed receipt (`providerMediaId`); new cut/caption after approval invalidates | same, gated by `ProgramAutomation("publishing")` |
| **PortalResource** | §11 | owner, last-reviewed, platform/device context; grouped; staff-editable without redeploy; unpublished placeholders never shown | staff editor under Resources; portal Resources page |
| **ContentFilmingReport** (CP-09, Sep 24) | §9 | the photographer's filmed-topic answer (ticks, per-topic notes, on-site extras) survives any downstream failure and lands exactly once, without anybody re-entering it; a failure is visible (`state`, `lastError`, a FLAG) and retried, and gives up to a person after 6 attempts | `upload/actions.ts finalizeUpload` (writes it in the debrief's transaction); `lib/filmedTopics.ts` applyFilmingReport / sweepFilmingReports (cron/sync `filmingReports`) — see §9 |
| **ContentTopicFolder** (CP-09, batch C) | §9 | a per-topic raw folder under 02-RAW-Video keyed by the topic's stable id, so a renamed topic never orphans its clips | `lib/dropboxFolders.ts ensureTopicFolders` (hourly folder sweep + when a report lands), behind `topic_folders` (OFF); read by `topicFolderLinksFor` — see §9 batch C |

### Existing models extended (87 nullable/defaulted columns)

| Model | Columns | Spec |
|---|---|---|
| ContentEnrollment | portalTokenIssuedAt, portalTokenExpiresAt, portalTokenRotatedAt, accessRevokedAt, accessRevokedBy, callMode, noCallEligible, timezone | §2 token lifecycle; paused/ended read-only unless revoked; §17 call mode (REQUIRED / OPTIONAL_WRITTEN / NOT_INCLUDED; null derives from `strategyCallRequired`) |
| ContentMonth | planningMode, preparationStatus, preparationCompletedAt, preparationWindowDays, preparationExceptionReason/By/At, filmingReadyAt, prioritiesJson, prioritiesSourceRef, callRecordId, remindersSnoozedUntil/By, remindersSnoozeReason | §19 two paths, one workflow (derivation in code; null ≠ "call completed"); §3 monthly priorities vs foundation; §26 month planned by a call; §24 snooze |
| ContentTopic | pillarId, audienceNeed, businessGoal, intendedMessage, approvalState, approvedBy, approvedAt, rejectionReason, archiveReason, sourceRef, importItemId, suggestionId, strategyVersionId, policyVersionId, clientUserId, importedMark, proposedState, dedupeHash, lastEventAt | §5 required topic fields; §18; §14 provenance; manifest §5.3 colour marks as proposals |
| ContentScript | currentVersionId, approvedVersionId, sharedVersionId, approvedAt, approvedBy, sharedAt, historical, releaseState, pillarId, strategyVersionId, policyVersionId, interviewId, callRecordId, importItemId, videoId | §22 versions + attributable approval; D5 historical imports stay visible as history; §9 explicit links; §7 scripts live with their video after filming |
| ContentStrategy | currentVersionId, approvedVersionId, approvedAt, approvedBy, releasedAt, releasedBy, structureTemplate | §3 version + approval date; release gate |
| ContentNote | migratedFactId, migratedAt | §23 migration (see §3 below) |
| PortalComment | clientUserId, staffUserId, parentId, resolvedAt, resolvedBy, resolvedByKind, decisionId, videoId, updatedAt | §2 attribution; §8 replies, resolved state, bundled into which decision. `updatedAt` is `DateTime? @updatedAt`: nullable in Postgres (additive on a live table, 0 rows today) but Prisma-maintained on every create/update, so no action has to set it by hand |
| ScriptSuggestion | clientUserId, staffUserId, scriptVersionId | §2, §22 |
| PortalVideo | videoId, submissionId, label | §7 a library row is one source of one logical video; program vs listing label |
| ReviewSubmission | clientRequestedAt, clientRequestedBy, clientReleasedAt, clientReleasedBy, clientApprovedDecisionId, contentHash, videoId | §8 five separate concepts: internal QC (unchanged: status/decidedAt/decidedBy) · client visibility · client change request (stops the portal overwriting Jordan's QC stamp) · client approval pointer · immutable cut hash |

## 3. Migration note — ContentNote → ClientFact

Facts today: 804 `ContentNote` rows, 804 `intelligence=true`, 0 human-written, no source/scope/status; every prompt reads the 12 newest per client (`contentPipeline.ts:50-55,575-578`) and the portal prefill reads them too. Seven rows carried a mid-string `[CONFIDENTIAL]` marker until the Sep 16 hotfix (now hoisted, guards match anywhere).

The move is a **read-through then cut-over**, never a bulk edit of ContentNote:

1. **Schema push** adds `ClientFact` and `ContentNote.migratedFactId/migratedAt`. Nothing changes for readers.
2. **One-time script** (`scripts/migrate-content-notes-to-facts.ts`, read ContentNote, insert ClientFact, then stamp the note) — per note:
   - `clientId` = note.clientId; `enrollmentId` = the client's enrollment if one exists (else null — 4 non-client Drive names must not mint enrollments).
   - `body` = note.body with the month prefix (`2026-09: …`) and the `[CONFIDENTIAL]` marker stripped; `confidential = true` when the marker was present (structured, spec §23); `aiContext = DENIED` for confidential rows regardless of status.
   - `category`: `INTERNAL` when the note was not `intelligence`; otherwise classified by a cheap keyword pass into BRAND_PREFERENCE / PRODUCTION_PREFERENCE / PERFORMANCE_REPORTED / DECISION / COMMITMENT / FEEDBACK, defaulting to `PROPOSED_CHANGE` when unsure (a human resolves it in the review strip).
   - `source = note_migration`, `sourceRef = "ContentNote:<id>"`, `factDate = note.createdAt`, `speaker = null` (the old writer kept no attribution — this is a known loss, not inferred).
   - `scope`: `MONTH` with `monthId` resolved from the `YYYY-MM:` prefix when present and a ContentMonth exists for it; else `PERMANENT`.
   - `status = PROPOSED`, `aiContext = DENIED`, `autoAccepted = false`, `legacyNoteId = note.id` (unique: rerunning the script is a no-op).
   - Stamp `ContentNote.migratedFactId/migratedAt`. Rows are never deleted.
3. **Cut-over in code**, behind a code flag until the review strip exists: the three prompt context builders and `portalPrefill.ts` switch from `ContentNote where intelligence` to `ClientFact where status=ACCEPTED and aiContext=ALLOWED and confidential=false` (scope-filtered by month/project). Because every migrated fact starts PROPOSED/DENIED, **the first effect of the cut-over is an emptier prompt**, which is the correct honest state — Jordan accepts facts through the "Updated from your latest call" strip (bulk accept per category is fine for the harmless ones; §23 says do not force him to approve every note). `contentPipeline.ts` writes NEW facts straight into ClientFact (`source = call`, `callRecordId`, `excerptJson`, `speaker`), and stops writing ContentNote.intelligence rows.
4. **Field policy** (`ClientFact.fieldKey` + rules in code): routine high-confidence updates to whitelisted keys (e.g. `production.location_preference`, `editing.pace`) may auto-accept (`autoAccepted=true`, still undoable); brand positioning, audience, strategy, pricing, package, billing NEVER auto-accept — they become a `ContentStrategyProposal` or stay PROPOSED.
5. **Rollback**: flip the code flag back; ContentNote is untouched; ClientFact rows can sit unused.

## 4. Idempotency / dedupe keys (where Postgres, not an if-statement, stops the duplicate)

| Model | Unique | Guards |
|---|---|---|
| ClientUser | email; loginTokenHash | one identity per address; single-use login token |
| ClientMembership | [clientUserId, enrollmentId] | one seat per person per program |
| ClientEmailAlias | [clientId, email] | |
| ContentStrategyVersion | [strategyId, versionNo] | |
| ContentPillarAlias | [pillarId, name] | |
| ContentTopicSelection | [topicId, monthId] | changing paths cannot duplicate a selection |
| ContentTopicRefreshRun | dedupeKey | duplicate clicks → one job |
| ContentInterview | [topicId, monthId] (both required) | changing paths cannot duplicate an interview; `monthId` is NOT NULL so the guard is real |
| ContentScriptVersion | [scriptId, versionNo] | |
| ContentVideoSource | [kind, ref] | source sync never creates a second video for the same file |
| ClientDecision | dedupeKey | duplicate submits → one revision job |
| ContentCutTranscript | [submissionId, version] | transcripts of different cuts cannot be confused |
| ClientAssetVersion | [assetId, versionNo] | |
| ProgramSessionRequest | dedupeKey | duplicate clicks → one request |
| ProgramOwnerAssignment | [scope, scopeRef, duty] | |
| ProgramCalendlyEventMapping | eventTypeUri | |
| ProgramCallRecord | calendlyEventUri | one record per booking |
| ProgramTranscriptSource | contentHash | same transcript via Drive and Meet = one source |
| ProgramTranscriptJob | dedupeKey | rerun = same job row. **Key format per kind**: `INGEST` = `<callRecordId>:<transcriptSourceId>:INGEST` (each Drive/Meet copy is pulled once); `ANALYZE`, `STRATEGY_DRAFT`, `SCRIPT_DRAFT`, `FACT_EXTRACT` = `<callRecordId>:<kind>` (one logical result per call, however many sources it has — spec §20) |
| ProgramOnboarding | enrollmentId | |
| ClientFact | legacyNoteId | migration rerun is a no-op |
| ProgramAiRun | dedupeKey | |
| ProgramAiQuota | [scope, scopeRef, period] | |
| ContentImportBatch | [kind, contentHash] | re-uploading a file re-opens the batch |
| ContentImportItem | [batchId, sourceHash] | |
| ProgramReminder | dedupeKey (enrollment:monthKey:action:attempt) | duplicate evaluator runs do not double-send |
| ProgramGenerationPolicyVersion | versionNo | |
| ProgramAutomation | key | |
| ProgramPublishingAccount | [provider, providerAccountId] | |
| ProgramPublishingJob | dedupeKey | no duplicate posts after retries |
| PortalResource | slug | |
| ContentFilmingReport | [projectId, payloadHash] | the same answer submitted twice (a double tap, a reloaded page) is ONE report; written with `createMany({ skipDuplicates: true })` so a duplicate is a no-op, not a P2002 that fails the footage submit |
| ContentTopicFolder | [projectId, topicId] | one raw folder per topic per session (batch C) |

**Where Postgres does NOT stop the duplicate (code must):** `ContentTopic.dedupeHash` is an INDEX, not a unique — the live table has 944 rows, all null, and a unique would be a NOT-NULL-shaped promise on a table we cannot backfill in the push. So spec §5 "repeating an import creates no duplicate topics" is enforced at three levels: (1) the SAME file → `ContentImportBatch @@unique([kind, contentHash])` re-opens the batch; (2) the same item inside a batch → `ContentImportItem @@unique([batchId, sourceHash])`; (3) the same topics arriving in a DIFFERENT file → the importer looks up `ContentTopic` by `[enrollmentId, dedupeHash]` (indexed) and proposes `LINK` / `UPDATE_PROPOSAL` instead of `CREATE`. A builder must not assume Postgres blocks case (3). The same applies to `ContentTopicSuggestion.dedupeHash` (index; the refresh run checks it against archived/rejected topics before it suggests).

## 5. Settings shapes (JSON in `ProgramAutomation.configJson`)

**A MISSING row means DISABLED, for every key.** The push creates no `ProgramAutomation` rows (no seed is allowed against production), so "OFF at the database" is only true if every job driver reads the switch the same way: `enabled = row?.enabled === true` — a missing row, a null config, a row with `enabled=false` all mean "do nothing, record nothing sent". Code defaults apply only to `configJson` VALUES (timezone, cadence, templates) once a row exists and is enabled; there is no code default that turns an automation on. Put this in one shared helper (`src/lib/programAutomation.ts isAutomationEnabled(key)`) and have every cron/driver call it first; never inline the lookup.

`ProgramAutomation.key` values and what each gates: `reminders` (§24) · `transcript_jobs` (§20) · `ai_runs` (§13, master switch for ProgramAiRun execution) · `publishing` (§12) · `script_share_email` (§22 Approve & share email) · `portal_invites` (§2 Stage B) · `portal_login_email` (§2 magic links — transactional, D14) · `topic_refresh` (§18 — since CP-07 the unattended topic bank: the initial bank queued at strategy approval, per-pillar refills below target; suggestions only) · `topic_carryover` (CP-07 — scripted-but-unfilmed topics carry into the new month's allowance with their script and history; swappable by the client) · `strategy_generation` (§21) · `session_booking` (§4 true self-booking — CP-04: books, reads back, cancels and moves in Aryeo ONLY for clients in its config `authorizedFixtureClientIds`, which must also be TEST clients; everyone else stays desk-assisted) · `address_sync` (CP-05 — PATCH a session's Aryeo address and read it back; same `authorizedFixtureClientIds` rule; with it off a client's exact address still saves and goes to Kyle, and our own order sync's readback is what confirms it) · `cut_transcripts` (§9) · `caption_assistant` (§10) · `fact_extraction` (§23 auto-accept rules) · `topic_folders` (CP-09 batch C — one raw folder per topic under the job's 02-RAW-Video, named `NN <title> [<id8>]`; adopted by bracket or Dropbox id, never renamed, moved or deleted; internal).

**Reminder policy** (`key = "reminders"`, `configJson`):
```json
{
  "timezone": "America/New_York",
  "businessHours": { "days": [1,2,3,4,5], "start": "09:00", "end": "16:30" },
  "sender": "info@realtourpilot.com",
  "escalationOwnerDuty": "ESCALATION",
  "planningOpensDaysBeforeMonth": 14,
  "planningDeadlineDayOfPrevMonth": 25,
  "firstReminderDelayBusinessDays": 0,
  "followUpAfterBusinessDays": 3,
  "maxAttemptsPerAction": 2,
  "escalateWhenDeadlineWithinBusinessDays": 3,
  "digestBothAppointments": true,
  "includeNoCallOptionOnlyIfEligible": true,
  "suppressWhen": ["booked","no_call_chosen","preparation_submitted","paused","ended","snoozed","pending_session_request","stale_scheduler_sync"],
  "templates": { "CHOOSE_PATH": "reminder.choose_path.v1", "BOOK_CALL": "reminder.book_call.v1", "COMPLETE_ANSWERS": "reminder.complete_answers.v1", "BOOK_SESSION": "reminder.book_session.v1", "REVIEW_WORK": "reminder.review_work.v1", "SCRIPTS_READY": "scripts_ready.v1" }
}
```
These are adjustable defaults (spec §24: "not an existing business policy"). The existing automatic client texts (confirmation 48h, delivery + feedback ask, welcome) are untouched; program reminders are new OutboxMessage kinds, never a change to `AUTO_SOURCES`.

**Preparation windows** live on the month (`ContentMonth.preparationWindowDays`, null = 3 business days) with staff exceptions carrying a reason.

## 6. What the block deliberately does NOT do

- No Prisma enums (house style for Content* is String + comment; values can grow without a migration).
- No `@relation`, so no cascades: deleting a ContentVideo does not delete its sources — readers filter, the same as today.
- No `deliveredCount` cache on ContentMonth: §7/§16 say count from the library (ContentVideo with `countsTowardAllowance`), never from orders.
- No per-script duration override field and no per-script snapshot of the timing target (Jordan: no duration overrides; manifest Q1 enforcement mode still open). ContentScriptVersion carries `estimatedSeconds` (a measurement) and `timingNote` (prose); the target is read through `policyVersionId`.
- No change to `ContentScript.status`, `ContentTopic.status`, `CLIENT_VISIBLE_SCRIPT` gate or the `clientVisible` columns — visibility stays status-based until a builder switches readers to `releaseState`/`sharedVersionId` deliberately (SYNTHESIS §7 "fragile").
- `ContentMonth.strategyCallStatus/calendlyEventUri/transcriptSource/transcriptText/transcriptProcessedAt` stay; `ProgramCallRecord.legacyMonthId` / `ProgramTranscriptSource.legacyMonthId` let a one-time lift copy them without a drop.

## 7. Coverage by spec section (what has a model, what is code by design)

Every section §2–§14, §16–§24, §26, §27 has models whose fields satisfy its acceptance criteria (table in §2, verified field-by-field in the reviewer round). The sections without a model of their own, and why:

| Spec section | Coverage | Why no model |
|---|---|---|
| §1 Navigation and visual direction | none | UI only; no acceptance criterion needs a field. |
| §15 Implementation order | none | a sequencing plan. Its metrics line ("appointment completion, download/posting use, …") is served by PortalVisit, ContentVideo.postedByClientAt, ProgramSessionRequest, ClientDecision. |
| §25 End-to-end scenarios | composed | scenarios 1–10 compose models already covered: ProgramOnboarding + ContentStrategyVersion (1), ContentTopicSelection + ContentTopicEvent (2), ContentMonth.planningMode + ProgramReminder suppression (3), ContentInterview.sufficiencyJson (4), ClientFact.scope + ContentStrategyProposal (5), ContentTopicRefreshRun (6), ContentScriptRelease.batchKey (7), ProgramTranscriptSource.contentHash + ProgramCallRecord.rescheduledFromId + leases (8), ProgramEnrollmentChange.effectiveAt/billingTruth (9), ClientAsset (10). |
| §14 "AgentProfile" among models to extend | deliberately untouched | AgentProfile stays the "My Brand Profile" READ surface. A client correction to the profile is a `ContentStrategyProposal kind=PROFILE` (attributable, reviewable, never a silent overwrite); files and values (logo, colours, pronunciation…) are `ClientAsset` / `ClientAssetVersion`. Builders extend the profile page to READ those two, not to write AgentProfile from the portal. |
| §12 "secure credential handling" | column + code | `ProgramPublishingAccount.credentialEncrypted` holds the blob; encryption at rest is `src/lib/integrations/crypto.ts` (the Plaid pattern), never plaintext in the column. |
| §2 media protection; §8 server-side approval/download permissions | code | media tokens and the viewer resolver are code. The schema supplies the actors (ClientUser, ClientMembership.role/revokedAt) and the release gates (ReviewSubmission.clientReleasedAt, ContentScript.sharedVersionId, ContentStrategyVersion.releasedAt). |

## 8. Reviewer round — what changed (all additive, all on NEW tables except one attribute)

| Item | Change |
|---|---|
| Missing indexes on foreign-id columns | 20 `@@index` added: ClientDecision.clientUserId · ProgramCallRecord.mappingId, .onboardingId · ContentScriptRelease.scriptVersionId, .monthId · ContentVideo.scriptVersionId, .deliverableId, .currentSubmissionId · ContentTopicSuggestion.pillarId, .acceptedTopicId · ProgramTranscriptJob.transcriptSourceId · ClientFact.enrollmentId · ContentImportItem.resultId · ProgramPublishingJob.submissionId · ContentTopicEvent.monthId · ContentCaptionDraft.transcriptId · ClientEmailAlias.enrollmentId · ContentPillar.strategyVersionId · ContentInterview.callRecordId · ProgramReminder [state, nextAttemptAt]. CREATE INDEX count 117 → 137. |
| ContentInterview unique with nullable monthId | `monthId` made REQUIRED (new table, zero rows — safe). No bank-level interview exists in the spec; an interview belongs to the month whose scripts it feeds. |
| ProgramTranscriptJob.dedupeKey format | documented per kind in the schema comment and §4: INGEST per source, every other kind per call. |
| ProgramAutomation missing row | schema comment + §5 now state that a MISSING row means DISABLED for every key; one shared helper. |
| ProgramReminder lease | `leaseUntil`, `leaseBy`, `nextAttemptAt`, `lastErrorAt` added (+ index). `nextEligibleAt` remains the business-time clock. |
| ContentScriptVersion timing snapshot | `timingTargetMinSec/MaxSec` DROPPED from the (new) table; the target is read through `policyVersionId`. Nothing per-script can become an override. |
| PortalComment.updatedAt | `DateTime? @updatedAt` — Prisma maintains it; SQL unchanged (still a nullable column, no DB default). |
| ContentTopic.dedupeHash is an index | §4 now says where Postgres stops the duplicate and where the importer must. |
| Coverage gaps | §7 above; AgentProfile note also placed in the schema beside ContentStrategyProposal. |

Post-fix verification is the table in §0. Human's steps are unchanged: `npx tsx scripts/backup-content-program.ts` then `npm run db:push`.

## 9. CP-09 — the filming report and the topic → slot binding (Sep 24 2026, batch A)

**The defect.** `finalizeUpload` wrote the project, then called `confirmFilmedTopics` inside a catch that swallowed everything; the ticks were stored nowhere else, so one failed write lost the photographer's only report of what was filmed, silently. Confirmed topic videos also had no slot, so the first cut for a slot minted a second, topic-less video.

**Additive columns (already pushed in 9defa7a).** `ContentFilmingReport` (new table), `ContentTopicFolder` (new table, batch C), `DeliverableOutput.topicId` + `.filmingNote` (+ index on topicId).

**Report lifecycle.**

| State | Meaning | Who moves it |
|---|---|---|
| PENDING | written in the SAME transaction as the debrief (`prisma.$transaction([createMany(skipDuplicates), project.update])`) | `finalizeUpload` |
| APPLYING | claimed by one runner: `updateMany` where state ∈ {PENDING, FAILED} (or APPLYING with an expired lease); `leaseUntil` = now + 5 min, `attempts + 1`. Every later write is fenced on that exact lease | `applyFilmingReport` |
| APPLIED | extras created, topics confirmed, videos bound, capacity review filed; `resultJson` records what happened | `applyFilmingReport` |
| FAILED | `lastError`, `nextAttemptAt` = now + 15 min · 2^(attempt − 1); `resultJson` keeps partial progress (extra key → topic id) so a retry never makes a second topic | `applyFilmingReport`; retried by `sweepFilmingReports` (cron/sync step `filmingReports`, BEFORE `contentLibrary`; DB-only, no switch) |
| NEEDS_REVIEW | 6 attempts failed: no more retries; Kyle gets a `content_filming_report` SmartTask listing what was filmed, and the office an in-app bell | `applyFilmingReport` |

`payloadHash` = sha256 of the sorted topic ids, the extras by lower-cased title + note (NOT the page's key, so a reloaded page is the same report) and the notes. The submit returns `topicsPending` whenever the report is not APPLIED, and the job gets ONE Activity FLAG per report.

**Applying.** (1) Each on-site extra → `createTopic` (PROPOSED, `sourceRef` `FilmingReport:<id>#<key>`) + `selectTopicForMonth` (its capacity check sets `overflow`); a same-titled topic the office REJECTED/ARCHIVED is not reintroduced — the footage becomes a topic-less EXTRA video and a FLAG. (2) `confirmFilmedTopics` — one interactive transaction under `pg_advisory_xact_lock(0x43503039::int4, hashtext(projectId)::int4)`; find-or-create per topic read inside the lock; kind EXTRA / `countsTowardAllowance` false for an overflow selection; `selectionId`; `scriptVersionId` = the shared version when `scriptDecisionsFor` says APPROVED; `filmedConfirmedBy` = the email; the date from the report's own leg, else the latest leg that has STARTED (≤ now + 6 h), else a past shoot date, else unverified. (3) `bindTopicVideosToSlots` (deliverableOutputs.ts) — same lock; each confirmed video, in rank order, takes the lowest slot on the monthly video row with no topic, no bound video and no review round; ContentVideo gets `(deliverableId, slot, outputId)`, the DeliverableOutput gets `topicId` + `filmingNote`. No free slot → never guessed: FLAG + the capacity task. No Deliverable row is created, so the monthly row still routes to personal branding (Kim). (4) `fileCapacityReview` (tasks.ts) — one SmartTask per job (`dedupe([projectId, "filmed_extra"])`, Kyle, MEDIUM) listing every extra / overflow / unbound video: count toward this month, next month, or bill as an extra. Nothing is charged automatically.

**Readers.** `topicsForSession` now unions selections with topics held on the month by `ContentTopic.monthId` (SELECTED..DELIVERED), ignores ARCHIVED videos, and returns per topic `confirmedOnProjectId`, `overflow`, `selectionId`, `folderPath`, the latest `note`, plus the project's `pendingReport`. The upload page pre-ticks only topics confirmed on THIS project. `outputsForProject` labels a slot with the topic's CURRENT title (so a rename shows at once) and carries `topicId`, `topicTitle`, `filmingNote`.

**Not in batch A.** Topic folders (`ContentTopicFolder`, `topic_folders` switch), the per-topic note / add-an-extra UI, `filmingBriefFor` and the editor PDF / project brief lines — batch C. The library-sweep survivor exemption for confirmed rows is CP-01's change in `contentVideos.ts`.

**Batch C (Sep 24 2026) — the rest of CP-09. No schema change** (the columns above were already pushed).

- *Topic folders* (`lib/dropboxFolders.ts`). `ensureTopicFolders(projectId)` checks `topic_folders` FIRST (a missing row is off: not one Dropbox call), then needs the job's own listing folder on record (`Project.dropboxFolder` — the folder engine owns it, so nothing here makes a listing or a 02-RAW-Video). It lists 02-RAW-Video once and, per topic on the session (the month's list minus topics confirmed at another session), finds the topic's folder by its recorded Dropbox id, else by the `[<id8>]` bracket at the end of the name; only a topic with neither gets `create_folder_v2` (a conflict = a racing run made it: adopted). `ContentTopicFolder.state`: CREATED (the hub made it) · ADOPTED (found, never made here) · FAILED (`lastError`; retried next pass). Nothing is renamed, moved or deleted: a topic renamed in the hub keeps its folder and clips; a folder renamed by hand is re-recorded under its new name. Runs from `ensureFoldersForUpcomingShoots` (cron/sync `dropboxFolders`, after the listing pass: content projects with a session in the window, by shootDate OR appointment, or a submit in the last 14 days) and from `applyFilmingReport` step 4 (best-effort, so an extra filmed on site gets its folder at once and a Dropbox blip never fails the report). `topicFolderLinksFor` gives each topic's folder as `<current listing>/02-RAW-Video/<label>`, so links survive the engine moving the listing. Raws-in detection is unchanged — the file counts are recursive.
- *The upload page.* Per ticked topic a collapsible "Note for the editor"; "+ Add a topic you filmed" (title + optional note, ≤ 10); the header "N videos: X planned + Y extra" (an overflow topic counts as extra); a folder link per topic once one exists. A topic already recorded for THIS session stays ticked (a re-submit never walks a confirmation back); a report that has not landed is re-shown ticked, with its extras, so re-sending it unchanged is the same report. A content session with no planned topics can add what was filmed instead of typing a count.
- *The editor's brief.* `filmingBriefFor(projectId)` (`lib/deliverableOutputs.ts`) — per owed video: slot label, the topic's title NOW, the photographer's note, extra (`added_on_site` | `beyond_plan`), the script (the exact version the client approved when it was confirmed, else the shared version and whether the client approved it per `scriptDecisionsFor`, else the office's approved copy or the draft, each said plainly) and the topic's folder; confirmed videos with no slot; how many owed slots have no topic; and the newest report that has not landed, from its own row. Read by the printed brief (`editor-pdf.ts`, replacing "N videos were filmed"), `projectBrief` (`filming`, and a NEEDS_REVIEW report is the blocker when nothing earlier is) and `/edit/<id>` ("What to make"). `cutSlots` carries `topicTitle` on a content session's bound slots; the label (which names the approved file) is unchanged.
- *Unchanged.* No Deliverable row is created for an extra, so the monthly row still routes to personal branding (Kim).

Drill: `scripts/_drill/cp09-filming-handoff.ts` (loads the 9defa7a `finalizeUpload` and `filmedTopics`, and the e26cacd `dropboxFolders` and `editor-pdf`, from git to show the old behaviour first; Dropbox is a stateful fake at the fetch fence).

## CP-06 / CP-11 — the brand profile, the editor's alert, and call knowledge applied by a person (Sep 24 2026, batch B)

**Columns (pushed in e26cacd, nothing else).** `ClientAsset.profileKey` (a single-valued text slot: `fonts`, `website`, `social`, `music`, and the staff-only `editing.pace`, `editing.captions`, `production.wardrobe|teleprompter|location|days`), `ContentEnrollment.setupStateJson` (`{skipped:{[item]:iso}}` — never read as completion), `ClientBrandChange` (one row per changed brand field), `ContentStrategyProposal.targetKey / appliedAt / resultAssetVersionId`.

**One spine (`src/lib/brandProfile.ts`).** Every brand change — the client's portal save or upload, a staff edit on the Brand tab, a call change a person applies — writes a `ClientBrandChange`. That row is the history the three Client columns never had, the banner on `/edit/<id>` until the editor presses "Got it", and a line on Kyle's confirmation task (`SmartTask` `assignedKey kyle`, `dedupeKey brand-ack:<clientId>:<firstChangeId>`, one OPEN per client, appended to). Jordan approves no asset update.

| `alertChannel` | Meaning |
|---|---|
| `pending` | `brand_change_alerts` is OFF — banner + Kyle task only; the editor's DM is owed and is caught up (≤ 7 days old, unacknowledged) by the hourly sweep once the switch is on |
| `slack` / `sms` / `bell` | what the bridge reached for the editor (their "Job pings" switch decides) |
| `deduped` | covered by this client's DM already sent this ET hour (`brand-updated-<clientId>-<yyyymmddHH>`) |
| `no_editor` | no open edit task, no editor on a job in production, no program → Kyle's task says nobody has been told |
| `skipped_test` | a TEST client: ledger rows only, no task, no message |

Rows are claimed atomically (`alertedAt null → alertClaim`), so racing saves alert each row once; `sweepBrandChangeAlerts` (cron/sync step `brandChangeAlerts`, after `clientAssetFolders`) handles any row whose inline alert never ran (older than 2 minutes). Editor resolution: open `edit_video`/`revision` task on an undelivered job → the in-house editor on a SHOT…REVISION job → for an ACTIVE program, the personal-branding route (`?? kim`) → nobody. Departed editors are never returned.

**Clearing.** `Client.brandColors / portalVideoStyle / portalPreferences`: `NULL` = never set (the portal may prefill a suggestion), `""` = the client cleared it (it stays empty). A slot is cleared by a version whose `valueJson` is `{"cleared":true}`; the history keeps what was there. A mixed save reports what it cleared.

**Setup checklist (`src/lib/portalSetup.ts`).** Derived from what is on file: colors (a hex), logo, headshot (ACTIVE registry files), fonts (slot or font file), links (website or social), music, video style; optional team item (another live seat or a held invitation). Skipping never counts as done. The same facts feed `ProgramOnboarding.assetChecklistJson`.

**Team (`src/lib/portalTeam.ts`, the actions are wrappers).** With `portal_invites` OFF a real client's invitation is HELD (AppSetting `portal-access-owed:<enrollmentId>:<email>`): listed as held on Settings & team and cancellable (`cancelOwedAccess` refuses the payer's own `welcome` debt). No row, no email.

**Call knowledge (`src/lib/profileFields.ts`).** Accepting a fact REMEMBERS it (prompts; production preferences are on the editor brief via `brandBriefFor`). A fact whose `fieldKey` maps to a slot and which carries `proposedValue` also creates a `ContentStrategyProposal` kind `PROFILE`, `targetKey profile.<slot>`, `diffJson [{path, from, to}]`, `factId`, `callRecordId`. **Applying** (`applyFieldProposal`, Jordan or Kyle) runs under the slot's advisory lock in one transaction: PROPOSED → ACCEPTED (a race loses), refuse on drift (the field no longer says `from`) or anything confidential, new slot version `source "fact"`, `ClientBrandChange APPLIED_FROM_CALL`, `appliedAt`, `resultAssetVersionId`, `diffJson[0].appliedTo` when the person edited the value. Ignoring = REJECTED, nothing else. Profile proposals are never listed or accepted as strategy.

**Strategy sections.** A call's strategy proposal names one section (`targetKey strategy.section:<sectionId>`, `diff [{from: section text, to: replacement}]`). Accepting copies the version in force, replaces ONLY that section's text (ids, order and every other section byte-identical; the structured read is re-parsed only when it finds the same headings), and creates an INTERNAL_REVIEW version for Jordan to approve. If the section changed in a newer approved version, it is refused. Untargeted proposals keep the old append path, or can be placed on a section at accept time. Confidential proposals become a locked INTERNAL fact; `createStrategyProposal` refuses a `[CONFIDENTIAL…]` marker and `releaseStrategyVersion` refuses a version carrying one.

**Switch.** `brand_change_alerts` (OFF; reaches staff) — only the editor's bell + Slack DM. Everything else here is internal and unswitched.

Drills: `scripts/_drill/cp06-brand-setup.ts`, `scripts/_drill/cp11-field-proposals.ts` (both load the HEAD versions from git to show the old behaviour first).

## CP-12 — the historical library, the identity tool, and downloads (Sep 24 2026, batch D)

**Columns (pushed in e26cacd, nothing else).** `ContentVideoSource.matchBasis / confirmedAt / confirmedBy`, `ContentVideo.identityConfirmedAt / identityConfirmedBy`, and `ContentVideoCorrection` (one row per changed field: `field`, `fromValue`, `toValue`, `by`, `reason`).

| `matchBasis` | How the file came to sit under its video |
|---|---|
| `cut` | a REVIEW_CUT source, or a review-hook `sub:<id>` library row — the cut key put it there |
| `own` | the sync minted the video for this Aryeo file (no cut chain to pair with) |
| `name` | paired to a cut chain because the titles agree (`sameVideoTitle`) |
| `index` | paired by list position only — the weak one; staff see **check pairing** until someone confirms or relinks it |
| `staff` | a person relinked it (`relinkDeliveredFile`); the sync keeps it, pre-claims its video, and never relabels it |
| `null` | linked before this column; the next sync writes what the link evidently is (`name`/`index` from the titles, else `own`) |

`confirmedAt` is a person standing behind the pairing (`confirmPairing` or a relink). It is the ONLY thing `cutEntitlement` reads from this record (`AryeoFinal.confirmed`), so a confirmed position-paired file is served where it used to stay `UNCONFIRMED_PAIRING` for good; how it was paired is still judged from the titles at read time.

**Library sections (`contentVideos.librarySection`).** A video with no month, or on a historical/IMPORTED month with no `identityConfirmedAt`, is **Previous content**: one flat section after the months, newest delivery first, never labelled with the shoot month the backfill guessed. Year chips come from the recent rows only. `portalVideoList(…, { section: "previous" })` is the portal's `?filter=previous`. On a backfilled month a title fix alone does not move the row; **Confirm month** does. On a live month any correction stamps `identityConfirmedAt`.

**The identity tool (staff Content tab, OWNER/ADMIN).** `correctVideoIdentity` (title, topic, script, kind — PROGRAM/LISTING/EXTRA sets `countsTowardAllowance` and `mappedBy` — and confirm/unconfirm month), `relinkDeliveredFile` (PORTAL_VIDEO sources only, same enrollment, same shoot, live target, reason required at the action), `confirmPairing`, `adoptTopicVideo` (a photographer-confirmed topic row with no file of its own is joined onto the same shoot's cut chain: topic, selection, script, the topic's title and the filming confirmation are copied; the topic row is ARCHIVED with `merged into <id>`, never deleted). Each writes its correction rows in the same transaction as the change and re-runs the library sync. Flags: `check pairing`, `unverified legacy row` (a positional `aryeo:<listing>:<n>` key nobody confirmed — the four rows the Sep 22 handoff left), `filmed topic not linked to a cut` (only when a same-shoot chain with no topic exists), `month unconfirmed`. Rows archived before the CP-09 guard stay archived; nothing un-archives automatically.

**Downloads (`postingKit.downloadPlanFor`, `DownloadButton`).** `proxy` when the entitled file is a hub cut still in the store and ≤ 400 MB (`PROXY_MAX_BYTES`): the page fetches the door, shows %/MB, cancels, resumes a failure with `Range`, then offers the phone's share sheet (a second tap) or saves a file. `redirect` for Dropbox-held cuts (after the 90-day prune), Aryeo files and anything larger: a plain link, "Download started" and per-device instructions, never "completed". PortalVisit paths: `/portal/download/<videoId>?cut=<ref>` = the door opened (**started**); `…&done=1` = the page received every byte (**completed**, `portalDownloadCompleted`, resolve only — not `can()` — so paused/ended/viewer seats record theirs; the ref must be the entitlement's `captionRef`; one per video per 10 minutes). STAFF-scope visits are recorded but are never the client's fact.

**Ended / paused.** Unchanged access (READ_ONLY keeps playback and downloads). `readOnlyNotice(status)` (portal.ts) is the one wording, with `RESUBSCRIBE_URL` = `https://realtourpilot.com/content-program` (contentProgram.ts) on the banner and Home. Generation and scheduling stay refused through `can()`.

**Switch.** None. Nothing here sends a message or writes to a provider.

Drill: `scripts/_drill/cp12-library-delivery.ts` (port 5519). Not drillable: real 50 MB / 350 MB files on desktop Chrome/Safari, iPhone Safari (share sheet → Save Video) and Android Chrome — progress, cancel, airplane-mode failure then Try again, and the Dropbox-held redirect.

## CP-13 / CP-14 — the program conversation, the guides, and Stripe activation (Sep 24 2026, batch D)

**Models (pushed in e26cacd, nothing else).** `ProgramMessage` (one row per message: `authorKind CLIENT|STAFF`, the person — `clientUserId` or `staffUserId` — and a label; `replyToId`; optional `refKind TOPIC|SCRIPT|VIDEO` + `refId`, each proved to be the account's own; `assignedAppUserId` = the MESSAGES owner when a client wrote it; `handledAt/handledBy` when the office answered or set it aside). `ProgramMessageRead` (`@@unique([enrollmentId, readerKey])`, a "seen up to" watermark: `cu:<clientUserId>`, `tok` for the shared link, `au:<appUserId>` for staff; moved forward with createMany/skipDuplicates + a guarded updateMany, never back). `ProgramSignup.activatedVia` (`poll | webhook | manual`) and `billingAnchorAt` (owner-only; recorded, never acted on).

**One conversation per enrollment (`src/lib/programMessages.ts`).** A client message is assigned to the `MESSAGES` duty owner (a new `OwnerDuty`, Kyle by default; `ensureDefaultOwnerAssignments` now mints any MISSING default duty instead of returning when any default exists, which writes ONE `ProgramOwnerAssignment` DEFAULT row for MESSAGES in production the first time it runs). A real client gets ONE `SmartTask` per account (`dedupeKey program-message:<enrollmentId>`, `taskType program_message` — never `client_reply`, which the reply queue auto-closes on any outgoing text — `source content_program`, due at the end of the next business day), refreshed by each message, reopened by a new one, closed by the reply or "No reply needed"; a hand reassignment (`assignedManually`) is kept. TEST clients: no task. The owner gets ONE bell row (`kind program_message`, `tm:<owner>` + an OWNER broadcast, `dedupeKey program-msg-<enrollmentId>-<first unanswered id>`) when the thread goes from nothing waiting to waiting. `program_message` is in `BELL_RULES` and deliberately NOT in `notifyPrefs.KIND_TO_EVENT`: bell only, no staff Slack/text page.

**It is not a revision system.** A message that `classifyComm` reads as a video change is stored as a message; no RevisionBrief, PortalComment or revision task is written. The client's confirmation repeats where video changes go; staff see a "looks like a video change" chip.

**Permissions.** New `PortalPermission` `message`: OWNER, COLLABORATOR and the shared link may write; VIEWER cannot; paused/ended programs are refused by `can()` (the paused refusal now gives Kyle's number instead of "text us"). Staff through the owner iframe are stored as STAFF.

**Surfaces.** Portal: a `messages` tab (account menu + phone More sheet, unread badge, a Home "new reply" row), `MessagesTab` + `MessageComposer`, and `ContactTeam` (Message <owner> → the thread; tel:/sms: to the office line) in the footer and the empty Resources page. Staff: a Messages tab on `/content/<id>` (`ProgramMessagesPanel`: thread, reply, "No reply needed", and the client's texts/emails underneath, opened on demand and labelled "Text · company OpenPhone line" / "Email · Gmail" — context, not a second inbox); `programOverview` rows carry `comms.messagesWaiting` / `oldestWaitingAt`.

**Contact.** AppSetting `portal-contact` = `{"name": "...", "phoneE164": "+1XXXXXXXXXX", "display"?: "..."}`; missing or malformed = Kyle, (215) 645-4889. No row is created by code.

**Switch.** `program_message_notice` (OFF; reaches clients) — the "Kyle replied" email: once per seat per unread run, never to a seat that already read it, Mon–Fri before 4:30pm ET only (cron/sync step `programMessageNotices` is the floor for after-hours replies), outbox kind `program_message` (subject "New reply in your RealTour Pilot portal", dedupeKey `program_message:<messageId>:<clientUserId>`), TEST-client floor applies. Everything else above is internal and unswitched.

**Resources.** New group `YOUR_MONTH` (first). `COMING_SOON` in `portalResources.ts` (Instagram publishing, advanced growth guides) is code, never rows. Nine guide drafts in `docs/portal-guides/*.md`; `scripts/draft-portal-guides.ts` validates them and writes `guides.json` (every guide unpublished). It never opens a database: loading and publishing are Jordan's, on `/content/resources`.

**Stripe (CP-14).** Activation stays on polling (hourly at :00 + Sync now). `ACTIVATING_PAYMENT_STATUS = "paid"`: unpaid async payments wait, a $0 `no_payment_required` checkout never activates. The claim is `createMany({skipDuplicates})` on the unique `checkoutId` (no exception-driven flow); a NEEDS_REVIEW retry is a compare-and-set. `processCheckoutSession` is the one per-checkout path for the poll, the webhook and a replay. Activation order is now: enrollment → month → `rematchDiscoveryForClient` (a discovery booking made before the payment, matched by the existing verified-email rule) → `onProgramActivated` → `grantProgramAccess` (whose seat create is now createMany/skipDuplicates) — so the welcome says "is booked for" when it is. The receiver `src/app/api/webhooks/stripe/route.ts` is built and drilled, NOT registered: fail-closed (secret from Connection `stripe_webhook`, else `STRIPE_WEBHOOK_SECRET`), Stripe `t=`/`v1=` HMAC with a 300 s tolerance, stores only `{id,type,objectId,livemode,created}`, refused bodies are not kept and do not page ops (`refuseWebhook(..., { alert: false })`), `webhookRetry.dispatch("stripe")` replays; Stripe is not in `WEBHOOK_RECEIVERS/LANES`.

Drills: `scripts/_drill/cp13-program-messages.ts` (port 5520), `scripts/_drill/cp14-stripe-activation.ts` (port 5521, loads HEAD's stripeSignups/portalAccess from git for the old behaviour).
