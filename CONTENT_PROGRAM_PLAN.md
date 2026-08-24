# Content Creator Program — Implementation Map

Living roadmap for building the Monthly Content Creator Program natively in the hub,
per `REALTOUR_PILOT_CONTENT_CREATOR_HANDOFF`. Jordan's decisions (2026-08-24):
**client login = email+password with magic-link recovery · rollout = internal first,
Jordan flips the switch per client · strategy calls = Calendly · script backfill =
upload PDF/Word, AI reads it, month confirmed by staff.**

## A. Reused infrastructure (audited, real)
- **Enrollment signal**: `Client.socialClient` + `socialPlan` — synced from Aryeo customer
  custom fields. Stable ID, not title parsing. 10 clients enrolled today.
- **Monthly job detection**: `MONTHLY_PLAN_RE` (pipeline.ts) — already labels monthly shoots.
- **Sessions**: content sessions ARE Aryeo appointments → Projects. `Project.contentMonthId`
  ties the existing shoot→edit→review pipeline into month workspaces. No parallel pipeline.
- **Review**: ReviewSubmission rounds + MediaNote timestamped comments (Review Room) — the
  client portal review reuses this architecture, client-scoped.
- **Scheduling**: Aryeo `availableDates`/`availableTimeslots`/reschedule/cancel already wired.
- **AI**: `aiJson`/`runHubAgent` (Anthropic key connected). Dropbox, notifications, task
  engine, auth (`requireAdmin`/`requireRole`), Section-card UI all reused.
- **Google Meet transcripts**: reader exists but gated on Jordan's ONE-TIME Google re-consent.
  Manual paste fallback ships first.

## B. New models (additive only, `db push` safe)
- `ContentEnrollment` (1:1 Client) — package, videosPerMonth, sessionsPerMonth, sessionHours,
  strategyCallRequired, clientSuppliesTopics, status ACTIVE|PAUSED|ENDED, overridesJson.
- `ContentMonth` (per enrollment+monthKey, unique) — videosOwed, status, strategyCall fields,
  transcriptText, historical flag for backfill.
- `ContentTopic` — the Topic Bank (monthId null = bank; set = planned). status ladder,
  trust/credibility/value/entertainment scores JSON, source (ai|client|staff|call|import).
- `ContentScript` — sectionsJson {hook,rehook,buildup,payoff,cta} + full body; status ladder;
  source import keeps original filename.
- `AgentProfile` (1:1 Client) — six JSON sections: brand, voice, contentPrefs, production,
  editing, stories. Editable forms over JSON; no 60-column table.
- `ContentNote` — chronological; `intelligence` flag = feeds AI context (spec §6.10).
- `Project.contentMonthId String?` — the pipeline link.

## C. Phases
1. **Foundation (NOW)** — schema, enrollment seed from socialClient roster, auto month
   creation + project attach, `/content` internal tab (roster + needs-attention),
   `/content/[id]` workspace (months, topics, scripts, profile, notes), script backfill
   (PDF/Word upload → AI extract → confirm month → save).
2. **Discovery & strategy** — Brand Discovery intake (portal-ready form), AI strategy
   generation → structured records, alignment states, seed topic bank (10/pillar).
3. **Monthly planning** — StrategyCall records, Calendly link-out + booked-time writeback,
   transcript paste→AI extraction (topics/ideas/profile updates/locations/todos),
   monthly recommendation refresh, duplicate prevention.
4. **Scripting engine** — native Hook→Re-hook→Build-up→Payoff→CTA generator with
   AgentProfile context, internal review states, rewrite-reason capture.
5. **Client portal** — email+password auth (magic-link recovery), premium mobile-first
   portal: This Month, Next Step, topic picker, scripts, video review (timestamped),
   approve, download. Server-side client scoping. Jordan invites per client.
6. **Scheduling** — Aryeo live availability in portal, session records per package,
   Pro dual-session tracking, location records.
7. **Automation** — event-driven tasks/notifications, Meet transcript auto-match
   (after Google re-consent), reminders, request/action tracking.
8. **Later** — publishing metadata, performance loop, content library search.

## D. Dependencies on Jordan
- **Google re-consent** (one-time) — gates the Drive transcript sweep AND magic-link/invite
  emails (gmail.send). Password login + transcript paste work without it.
- **Calendly personal access token** — Connections → Calendly card → paste. (In Calendly:
  Integrations → API & webhooks → Personal access tokens → Generate.) Booking link itself
  is already wired: https://calendly.com/realtourpilot-info/content-program-strategy-call
- Portal invites — per client, when he's ready.

## E. Phase 3-4 status (built 2026-08-24)
- Calendly client (read-only) + Connections card; booking sweep stamps months
  SCHEDULED/COMPLETED, honors cancellations, never downgrades hand-set statuses.
- Drive transcript sweep (owner token, gated on Drive scope): transcript docs → month,
  matched by client name in title or same-ET-day as the Calendly booking.
- First-of-month invite drafts (comms_followup task w/ ready-to-send message + link,
  deduped per month). Draft-then-send preserved.
- AI pipeline: processMonthTranscript (confirmed topics → SELECTED, future → bank,
  rejected recorded, profile intel → intelligence notes, location/todos → month note)
  + generateScriptsForMonth (Hook→Re-hook→Build-up→Payoff→CTA, INTERNAL_REVIEW)
  + reviseScriptWithInstructions. Cron auto-processes fresh transcripts; everything
  waits for Jordan's approval (approve / AI-revise / edit-myself loop on the workspace).
