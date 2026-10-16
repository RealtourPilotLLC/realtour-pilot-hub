"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { appBase } from "@/lib/appUrl";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { contentProgramSweep, etMonthKey, assertDutyOwner, setOwnerOverride, type OwnerDuty } from "@/lib/contentProgram";
import type { ImportKind, ImportPreview, ItemMode } from "@/lib/contentImport";
import type { FactCategory, FactScope } from "@/lib/clientFacts";
import type { VersionParts } from "@/lib/contentScripts";

// Who is acting — every approval, release, accept and undo is attributable
// (spec §6/§22/§23). Falls back to "dev" only when auth is off locally.
async function actor(): Promise<{ email: string; id: string | null; realRole: string | null; name: string | null }> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return { email: me?.email ?? "dev@local", id: me?.id ?? null, realRole: me?.realRole ?? me?.role ?? null, name: me?.name ?? null };
}

type Result = { ok: boolean; message: string; outcome?: "confirmed" | "refused" | "unknown" };

const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

// Re-run enrollment/month/project sync on demand. The button pulls the social
// flags FROM ARYEO first — without that, "Sync now" only re-read our local
// copy and a client Jordan removed in Aryeo stayed ACTIVE until the daily
// cron (Aug 24: Alex/Tony/Matthew removals looked like the button was broken).
export async function runProgramSweep(): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  let flagNote = "";
  try {
    const { syncAryeoSocialPlans } = await import("@/lib/integrations/aryeo");
    const f = await syncAryeoSocialPlans();
    flagNote = f.updated > 0 ? `${f.updated} plan change${f.updated === 1 ? "" : "s"} from Aryeo · ` : "";
  } catch {
    flagNote = "Aryeo unreachable — used last-known flags · ";
  }
  // Website signups first (paid Stripe checkouts -> live enrollments), so the
  // sweep below builds their month workspaces in the same click.
  let signupNote = "";
  try {
    const { sweepStripeSignups } = await import("@/lib/stripeSignups");
    const sg = await sweepStripeSignups();
    signupNote = sg.activated > 0 ? `${sg.activated} website signup${sg.activated === 1 ? "" : "s"} activated · ` : "";
    // More than 250 checkouts this month: the oldest were not read on this pass.
    if (sg.truncated) signupNote += "Stripe had more checkouts than one pass reads, so the oldest were skipped this time · ";
  } catch {
    signupNote = "Stripe unreachable — signups unchecked · ";
  }
  const r = await contentProgramSweep();
  revalidatePath("/content");
  const parts = [
    signupNote ? signupNote.replace(/ · $/, "") : null,
    r.created > 0 ? `${r.created} enrolled` : null,
    r.paused > 0 ? `${r.paused} paused` : null,
    r.updated > 0 ? `${r.updated} updated` : null,
    r.monthsCreated > 0 ? `${r.monthsCreated} months created` : null,
    r.projectsAttached > 0 ? `${r.projectsAttached} shoots attached` : null,
  ].filter(Boolean);
  return { ok: true, message: `${flagNote}${parts.length ? parts.join(" · ") : "everything already in sync"}.` };
}

// ---------------------------------------------------------------------------
// PACKAGE AND STATUS, FOR KYLE TOO — through the ledger (UI-02, Sep 24 2026).
//
// The old Client-file card saved package, status and a custom videos-per-month
// straight onto ContentEnrollment through `saveEnrollmentSettings`: gated only
// by requireAdmin, no ProgramEnrollmentChange row, and a mid-month count change
// silently rewrote the month in flight. Meanwhile the Settings tab's ledgered
// actions (workspaceActions.ts) were owner-only — so the one path Kyle had was
// the unrecorded one.
//
// Jordan's decision: Kyle KEEPS pause / end / package change. So these two
// open the SAME ledgered setters (enrollmentChanges.changePackage and
// setEnrollmentStatus) to OWNER and ADMIN: a ledger row first, an explicit
// effective month and a KEEP/APPLY choice for the month in flight, the actor's
// name on every row. Billing terms stay owner-only (setBillingTermsAction), and
// nothing here touches Stripe, QuickBooks or Aryeo. saveEnrollmentSettings is
// gone: its call-mode and topics flags already live on the Settings tab.
// ---------------------------------------------------------------------------
export async function staffChangePackageAction(
  enrollmentId: string,
  input: { package: string; effectiveMonthKey: string | null; currentMonthChoice: "KEEP" | "APPLY" | null; videosPerMonth?: number | null; sessionsPerMonth?: number | null; reason?: string | null },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { changePackage } = await import("@/lib/enrollmentChanges");
    const r = await changePackage(enrollmentId, input, me.email);
    path(enrollmentId);
    const cancelled = r.superseded.length
      ? ` It replaces ${r.superseded.length} scheduled decision${r.superseded.length === 1 ? "" : "s"} that will now never take effect: ${r.superseded.map((x) => x.sentence).join("; ")}.`
      : "";
    // Nothing new recorded: either a true no-op (it cancels nothing now — the
    // rows that already say this survive), or a revert that only retires a
    // LATER scheduled decision. Say which, in those words.
    if (r.changeIds.length === 0) {
      return {
        ok: true,
        message: r.superseded.length
          ? `The current terms stay.${cancelled}`
          : "Nothing changed — those are already this client's terms from that month, and nothing scheduled was cancelled.",
      };
    }
    return {
      ok: true,
      message: `Recorded under your name. The package changes from ${r.effectiveMonthKey}; the video/session quantities apply from ${r.obligationMonthKey}.${cancelled} No invoice, subscription or payment was touched.`,
    };
  } catch (e) { return fail(e); }
}

export async function staffSetEnrollmentStatusAction(enrollmentId: string, status: "ACTIVE" | "PAUSED" | "ENDED", reason?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!["ACTIVE", "PAUSED", "ENDED"].includes(status)) return { ok: false, message: "Unknown status." };
  try {
    const me = await actor();
    const { setEnrollmentStatus } = await import("@/lib/enrollmentChanges");
    await setEnrollmentStatus(enrollmentId, status, me.email, reason);
    path(enrollmentId);
    // Jordan's rule: paused/ended KEEP read-only portal access to released
    // work unless a person explicitly revokes it on the access card.
    return {
      ok: true,
      message: status === "ACTIVE"
        ? "Back to active — recorded under your name."
        : `Marked ${status.toLowerCase()} and recorded under your name. Their portal still opens, read-only, on work already released. No subscription was cancelled.`,
    };
  } catch (e) { return fail(e); }
}

// The roster's cards/table choice, remembered per browser (UI-02). A cookie,
// because a Server Component can read one but only a Server Function may set
// it. The return URL is rebuilt from the three known params — never echoed
// from the form — so this cannot be turned into an open redirect.
export async function setRosterView(form: FormData): Promise<void> {
  const { cookies } = await import("next/headers");
  const { redirect } = await import("next/navigation");
  const { ROSTER_VIEW_COOKIE, resolveRosterView } = await import("@/lib/contentNav");
  const view = resolveRosterView(String(form.get("view") ?? ""), null);
  (await cookies()).set(ROSTER_VIEW_COOKIE, view, { path: "/content", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true });
  const q = new URLSearchParams();
  const month = String(form.get("month") ?? "");
  const filter = String(form.get("filter") ?? "");
  if (/^(\d{4}-\d{2}|ALL_OPEN)$/.test(month)) q.set("month", month);
  if (/^[a-z_]{1,40}$/.test(filter)) q.set("filter", filter);
  if (form.get("ended") === "1") q.set("ended", "1");
  const qs = q.toString();
  // Outside any try: redirect() throws to do its work (Next 16 docs).
  redirect(`/content${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Month state (strategy-call status until the Phase-3 StrategyCall model)
// ---------------------------------------------------------------------------
const CALL_STATUSES = ["NOT_REQUIRED", "NOT_SCHEDULED", "SCHEDULED", "COMPLETED", "SKIPPED"];
export async function setStrategyCallStatus(monthId: string, status: string, at?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!CALL_STATUSES.includes(status)) return { ok: false, message: "Unknown status." };
  await prisma.contentMonth.update({
    where: { id: monthId },
    data: { strategyCallStatus: status, strategyCallAt: at ? new Date(at) : status === "NOT_SCHEDULED" ? null : undefined },
  });
  revalidatePath("/content");
  return { ok: true, message: "Updated." };
}

export async function saveMonthTranscript(monthId: string, text: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  await prisma.contentMonth.update({
    where: { id: monthId },
    data: {
      transcriptText: text.trim().slice(0, 500_000) || null,
      strategyCallStatus: text.trim() ? "COMPLETED" : undefined,
      // A REPLACED transcript is un-analyzed by definition — clearing the stamp
      // re-arms the Analyze button (audit: it stayed stamped forever).
      transcriptProcessedAt: null,
    },
  });
  revalidatePath("/content");
  // (The old message said extraction was "a later build phase" — it shipped.)
  return { ok: true, message: "Transcript saved — hit “Analyze → topics + scripts” to extract this month's plan." };
}

// ---------------------------------------------------------------------------
// Topic bank
// ---------------------------------------------------------------------------
export async function addTopic(
  enrollmentId: string,
  t: { title: string; concept?: string; pillar?: string; pillarId?: string | null; monthId?: string | null; source?: string; audienceNeed?: string | null; businessGoal?: string | null; intendedMessage?: string | null },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const title = t.title.trim().slice(0, 200);
  if (!title) return { ok: false, message: "Give the topic a title." };
  try {
    const { createTopic, selectTopicForMonth } = await import("@/lib/contentTopics");
    const me = await actor();
    const source = t.source && ["ai", "client", "strategy_call", "staff", "import"].includes(t.source) ? (t.source as "ai" | "client" | "strategy_call" | "staff" | "import") : "staff";
    const r = await createTopic({ enrollmentId, title, concept: t.concept, pillarLabel: t.pillar, pillarId: t.pillarId ?? null, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, source, status: "SAVED", approvalState: source === "staff" ? "APPROVED" : "PROPOSED", actor: { kind: source === "client" ? "CLIENT" : "STAFF", staffUserId: me.email } });
    if (r.existed) return { ok: false, message: "That topic already exists on this client." };
    if (t.monthId) await selectTopicForMonth(r.id, t.monthId, { source: "staff", actor: { kind: "STAFF", staffUserId: me.email } });
    revalidatePath("/content");
    return { ok: true, message: "Topic added." };
  } catch (e) { return fail(e); }
}

export async function setTopicStatus(topicId: string, status: string, monthId?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const OK = ["IDEA", "RECOMMENDED", "SAVED", "SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED", "REJECTED", "ARCHIVED"];
  if (!OK.includes(status)) return { ok: false, message: "Unknown status." };
  // Every status change goes through the topic layer so it lands on the
  // topic's history and its month selection (spec §5), never a bare update.
  try {
    const me = await actor();
    const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, monthId: true, status: true } });
    if (!t) return { ok: false, message: "Topic not found." };
    const { selectTopicForMonth, deselectTopic, rejectTopic, archiveTopic, recordTopicEvent } = await import("@/lib/contentTopics");
    const staff = { kind: "STAFF" as const, staffUserId: me.email };
    if (status === "SELECTED" && monthId) await selectTopicForMonth(topicId, monthId, { source: "staff", actor: staff });
    else if (status === "SAVED" && t.monthId) await deselectTopic(topicId, t.monthId, staff);
    else if (status === "REJECTED") await rejectTopic(topicId, me.email, null);
    else if (status === "ARCHIVED") await archiveTopic(topicId, me.email, null);
    else {
      await prisma.contentTopic.update({ where: { id: topicId }, data: { status, ...(monthId !== undefined ? { monthId } : {}) } });
      await recordTopicEvent(topicId, t.enrollmentId, status === "FILMED" ? "FILMED" : status === "DELIVERED" ? "DELIVERED" : "EDITED", staff, { fromStatus: t.status, toStatus: status, monthId: monthId ?? t.monthId });
    }
    revalidatePath("/content");
    return { ok: true, message: "Updated." };
  } catch (e) { return fail(e); }
}

// ---------------------------------------------------------------------------
// Agent profile — six JSON sections, each a labeled free-form field set.
// ---------------------------------------------------------------------------
const PROFILE_SECTIONS = ["brandJson", "voiceJson", "contentPrefsJson", "productionJson", "editingJson", "storiesJson"] as const;
export async function saveProfileSection(clientId: string, section: string, values: Record<string, string>): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!(PROFILE_SECTIONS as readonly string[]).includes(section)) return { ok: false, message: "Unknown section." };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const key = k.trim().slice(0, 80);
    const val = (v ?? "").trim().slice(0, 4000);
    if (key && val) clean[key] = val;
  }
  await prisma.agentProfile.upsert({
    where: { clientId },
    create: { clientId, [section]: JSON.stringify(clean) },
    update: { [section]: JSON.stringify(clean) },
  });
  revalidatePath("/content");
  return { ok: true, message: "Profile saved." };
}

// ---------------------------------------------------------------------------
// Notes (intelligence flag = feeds AI context later; plain notes never do)
// ---------------------------------------------------------------------------
export async function addContentNote(clientId: string, body: string, intelligence: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const text = body.trim().slice(0, 8000);
  if (!text) return { ok: false, message: "Write the note first." };
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  await prisma.contentNote.create({ data: { clientId, body: text, intelligence, authorName: me?.name ?? null } });
  revalidatePath("/content");
  return { ok: true, message: "Note added." };
}

// Shared file→plain-text extraction for the uploads (strategies + the Import tab).
// (The old AI-split script backfill — status APPROVED, no version, no batch —
// was deleted Sep 17: scripts are imported on the Import tab, historical only.)
// A08 (Sep 25 2026): the extraction itself is lib/documentText.ts, shared with
// the strategy reference manifest so both read a file the same way.
async function extractUploadText(form: FormData): Promise<{ ok: true; text: string; name: string } | { ok: false; message: string }> {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, message: "No file." };
  const { extractDocumentText, MAX_DOCUMENT_BYTES } = await import("@/lib/documentText");
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, message: "File too large (max 15 MB)." };
  const r = await extractDocumentText(Buffer.from(await file.arrayBuffer()), file.name);
  return r.ok ? { ok: true, text: r.text, name: file.name } : r;
}

// ---------------------------------------------------------------------------
// Strategy backfill — Jordan: "I also want to be able to upload the content
// strategies I've put together for them."
//
// Upload → extract text → AI organizes it into the strategy's structured
// sections (VERBATIM content, no rewriting) → staff review → save as the
// client's ACTIVE strategy. Prior strategies archive, never delete.
// ---------------------------------------------------------------------------
export type StrategyPreview = {
  ok: boolean; message: string;
  sections?: Record<string, string>;
  rawText?: string;
  sourceFile?: string;
};

export async function previewStrategyBackfill(form: FormData): Promise<StrategyPreview> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const ex = await extractUploadText(form);
  if (!ex.ok) return ex;
  const { text, name } = ex;
  // The document's OWN structure, read by the policy parser (numeric prefixes,
  // never Word styles) — no AI, no generic eight keys (spec §3).
  const { structuredFromText } = await import("@/lib/contentStrategy");
  const { validateStrategyStructure } = await import("@/lib/contentPolicy");
  const { stored, parsed } = structuredFromText(text);
  const v = validateStrategyStructure(parsed);
  const sections: Record<string, string> = {};
  for (const sec of stored.sections) sections[sec.heading.slice(0, 120)] = sec.text.slice(0, 12_000);
  return {
    ok: true,
    message: `${parsed.structureVersion === "unknown" ? "No numbered sections found — kept as one block" : `${parsed.structureVersion} structure · ${stored.sections.length} sections`} · ${v.pillarCount} pillar${v.pillarCount === 1 ? "" : "s"} · framework: the house framework${v.documentFramework === "own wording" ? " (the document’s own is not used)" : ""}${v.missing.length ? ` · missing: ${v.missing.slice(0, 4).join(", ")}${v.missing.length > 4 ? "…" : ""}` : ""}`,
    sections, rawText: text.slice(0, 200_000), sourceFile: name,
  };
}

/** Save an uploaded strategy as the NEXT VERSION (never a replacement); Jordan approves it on the Strategy tab. */
export async function saveStrategyBackfill(
  enrollmentId: string,
  sections: Record<string, string>,
  rawText: string,
  sourceFile: string,
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!rawText.trim() && !Object.keys(sections).length) return { ok: false, message: "Nothing to save." };
  try {
    const { importStrategyVersion } = await import("@/lib/contentStrategy");
    const me = await actor();
    const r = await importStrategyVersion({ enrollmentId, text: rawText.trim() || Object.entries(sections).map(([k, v]) => `${k}\n${v}`).join("\n\n"), fileName: sourceFile.slice(0, 200), createdBy: me.email });
    revalidatePath(`/content/${enrollmentId}`);
    return { ok: true, message: r.existed ? `That document is already version ${r.versionNo} — nothing duplicated.` : `Saved as version ${r.versionNo} (${r.structureVersion} structure, ${r.pillarCount} pillars). Approve it on the Strategy tab to make it the strategy in force.` };
  } catch (e) { return fail(e); }
}

// ---------------------------------------------------------------------------
// Transcript → topics/intel, topics → scripts, and the approve/revise loop.
// Human-review rule: everything the AI makes stays INTERNAL_REVIEW until
// Jordan approves it; nothing auto-delivers.
// ---------------------------------------------------------------------------
export async function analyzeTranscript(monthId: string, force = false): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { processMonthTranscript, generateScriptsForMonth } = await import("@/lib/contentPipeline");
    // A deliberate re-run clears the analyzed stamp first (topics already
    // extracted are deduped by the pipeline's history pass).
    if (force) await prisma.contentMonth.updateMany({ where: { id: monthId }, data: { transcriptProcessedAt: null } });
    const me = await actor();
    const r = await processMonthTranscript(monthId, { requestedBy: me.email, unattended: false });
    const g = await generateScriptsForMonth(monthId, { requestedBy: me.email, unattended: false });
    revalidatePath("/content");
    const decided = r.keptSelections + r.withheldSelections;
    return {
      ok: true,
      message: `${r.callKind} call · ${r.confirmedTopics} topic${r.confirmedTopics === 1 ? "" : "s"} confirmed for the month (their scripts draft next)${decided ? ` · ${decided} already decided by a person, left as is` : ""} · ${r.futureIdeas} idea${r.futureIdeas === 1 ? "" : "s"} for the bank${r.rejected ? ` · ${r.rejected} declined on the call (confirm the rejection${r.rejected === 1 ? "" : "s"} on Video Topics)` : ""} · ${r.intelNotes} fact${r.intelNotes === 1 ? "" : "s"} to review${r.confidentialFacts ? ` (${r.confidentialFacts} confidential, locked)` : ""}${r.proposals ? ` · ${r.proposals} strategy proposal${r.proposals === 1 ? "" : "s"}` : ""}${g.generated ? ` · ${g.generated} script${g.generated === 1 ? "" : "s"} drafted for the topics already confirmed` : ""}.`,
    };
  } catch (e) { return fail(e); }
}

export async function generateMonthScripts(monthId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { generateScriptsForMonth } = await import("@/lib/contentPipeline");
    const me = await actor();
    const g = await generateScriptsForMonth(monthId, { requestedBy: me.email, unattended: false });
    revalidatePath("/content");
    return { ok: true, message: g.generated ? `${g.generated} script${g.generated === 1 ? "" : "s"} drafted — review below.` : "Every selected topic already has a script (call-proposed topics need confirming first)." };
  } catch (e) { return fail(e); }
}

/**
 * The month tab's Approve: approves EXACTLY the version the tab rendered.
 *
 * It used to take only the script id and sign whatever version was current at
 * the moment of the click — so a tab opened on v2, with v3 drafted since (an AI
 * revise, a hand edit, a client suggestion applied), approved v3: words Jordan
 * had never read (completion audit UI-02, pulled forward with CP-02). The
 * caller now says which version it showed — `shownVersionNo`, unique per
 * script, or null for a legacy body not yet versioned — and a stale one is
 * refused. The version-exact path (approveScriptVersionAction) does the rest.
 * `note` is the override for a version with blocking format findings.
 *
 * UI-02 (Sep 24 2026): NO SCREEN CALLS THIS ANY MORE. Its only caller was the
 * Overview's script list (ScriptReview), retired so that the Scripts view's
 * ScriptsPanel — which hands approveScriptVersionAction a version id — is the
 * one staff approval surface. It is kept, still version-exact and still
 * refusing a call that does not say which version it showed, because a tab
 * running the old bundle may post to it, and the CP-02 drill holds that rule.
 */
export async function approveScript(scriptId: string, shownVersionNo: number | null, note?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  // A tab still running the old bundle sends (scriptId) or (scriptId, note):
  // it never said which version it showed, so it may not approve anything.
  if (shownVersionNo !== null && !(typeof shownVersionNo === "number" && Number.isInteger(shownVersionNo) && shownVersionNo > 0)) {
    return { ok: false, message: "Reload the page — this approve button doesn't say which version you were reading." };
  }
  try {
    const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { historical: true, currentVersionId: true } });
    if (!s) return { ok: false, message: "That script no longer exists." };
    if (s.historical) return { ok: false, message: "Imported scripts are history — nothing to approve." };
    let versionId: string;
    if (shownVersionNo === null) {
      // The tab showed the legacy body. Only while there is STILL no version
      // is that body what gets versioned and signed.
      if (s.currentVersionId) return { ok: false, message: "This script changed since the page loaded — reload and approve the version you can see." };
      const { ensureScriptVersioned } = await import("@/lib/contentScripts");
      versionId = await ensureScriptVersioned(scriptId);
    } else {
      const v = await prisma.contentScriptVersion.findUnique({ where: { scriptId_versionNo: { scriptId, versionNo: shownVersionNo } }, select: { id: true } });
      if (!v) return { ok: false, message: "That version no longer exists — reload the page." };
      if (v.id !== s.currentVersionId) return { ok: false, message: `A newer version has been written since you opened v${shownVersionNo} — reload and read it before approving.` };
      versionId = v.id;
    }
    const r = await approveScriptVersionAction(versionId, note);
    if (r.ok) revalidatePath("/content");
    return r.ok && !/Already approved/.test(r.message)
      ? { ok: true, message: "Approved (recorded under your name). Release it to the portal from the Scripts tab when you want the client to see it." }
      : r;
  } catch (e) { return fail(e); }
}

export async function reviseScriptAI(scriptId: string, instructions: string, lockSections: string[] = []): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!instructions.trim()) return { ok: false, message: "Tell the AI what to change first." };
  try {
    const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
    const me = await actor();
    await reviseScriptWithInstructions(scriptId, instructions, { requestedBy: me.email, lockSections });
    revalidatePath("/content");
    return { ok: true, message: "Revised as a new version — the previous one is kept." };
  } catch (e) { return fail(e); }
}

/**
 * ONE CLICK ON AN OVERRUN: send the script back to the generator with a tighten
 * instruction built HERE, from the version's own stored estimate, and nowhere
 * near a duration override.
 *
 * Why the instruction is not a client prop: the panel renders whatever
 * estimatedSeconds the page was built with, and a script revised in another tab
 * (or by an applied client suggestion) moves on underneath it. Reading the
 * current version at the moment of the click means the AI is told the length the
 * row actually has. The wording itself lives in contentPolicy/scriptFormat.ts
 * beside the target it quotes.
 *
 * This is an ACTION, not an exemption. It produces another VERSION — status
 * INTERNAL_REVIEW, which is what contentGeneration.reviseScript writes for
 * every AI revision, not DRAFT as this comment and the success message used to
 * say (review, Sep 18 2026) — and that version goes through the same validator
 * and the same approval gate; nothing here relaxes the 30–50 s target, which
 * has no override field anywhere in the policy layer. Both statuses sit in the
 * Scripts tab's review queue, so where it lands is unchanged; what was wrong
 * was the word, and a wrong word here is what somebody would go looking for in
 * the version trail.
 */
export async function tightenScriptAI(scriptId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const plan = await tightenPlan(scriptId);
    if (!plan.ok) return plan;
    const { seconds, words, versionNo, lo, hi, instruction } = plan;
    const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
    const me = await actor();
    await reviseScriptWithInstructions(scriptId, instruction, { requestedBy: me.email });
    revalidatePath("/content");
    return { ok: true, message: `Sent back to be tightened from ≈${seconds} s (${words} words) toward ${lo}–${hi} s — v${versionNo} is kept. The new version is waiting in the review queue.` };
  } catch (e) { return fail(e); }
}

/** The tighten instruction for the CURRENT version, or why there is nothing to tighten (shared by the queued Tighten). */
async function tightenPlan(scriptId: string): Promise<{ ok: false; message: string } | { ok: true; instruction: string; seconds: number; words: number; versionNo: number; lo: number; hi: number }> {
  const { ensureScriptVersioned } = await import("@/lib/contentScripts");
  const { tightenInstruction, GENERATION_POLICY } = await import("@/lib/contentPolicy");
  const head = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { historical: true } });
  if (!head) return { ok: false, message: "That script no longer exists." };
  // Same rule as every other rewrite path: an import is the record of what was
  // filmed, and a 126-second archive script is history, not an overrun to fix.
  if (head.historical) return { ok: false, message: "This is an imported historical script — it is not rewritten. Draft a new script for the topic instead." };
  const versionId = await ensureScriptVersioned(scriptId);
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: versionId }, select: { versionNo: true, estimatedSeconds: true, spokenWordCount: true } });
  if (!v) return { ok: false, message: "That script has no version to tighten." };
  const [lo, hi] = GENERATION_POLICY.timing.targetSec;
  const seconds = v.estimatedSeconds, words = v.spokenWordCount;
  if (seconds == null || words == null) return { ok: false, message: "This version has no spoken-length estimate yet — save or regenerate it once and the estimate is recorded." };
  // UNDER-TARGET IS NOT "INSIDE THE TARGET" (review, Sep 18 2026). One
  // `seconds <= hi` test used to answer both of the cases it is not an
  // overrun, and told a 19-second draft it was "inside the target" (then 20–30 s).
  // Four live current versions estimate at 19 s (measured against production,
  // scripts/_fix/CE/probe-under.ts), so four rows were being told something
  // false about themselves — and the fix for a short script is the opposite
  // of a tighten, so the wrong words point at the wrong action.
  if (seconds < lo) {
    return {
      ok: false,
      message: `Version ${v.versionNo} estimates at ≈${seconds} s (${words} words) — that is UNDER the ${lo}–${hi} s target, not over it, and tightening would only make it shorter. Add substance with "Ask AI to revise" or "Edit myself" instead.`,
    };
  }
  if (seconds <= hi) return { ok: false, message: `Version ${v.versionNo} already estimates at ≈${seconds} s, inside the ${lo}–${hi} s target — nothing to tighten.` };
  const instruction = tightenInstruction({ seconds, words, wordsPerSec: GENERATION_POLICY.timing.wordsPerSec, target: GENERATION_POLICY.timing.targetSec });
  return { ok: true, instruction, seconds, words, versionNo: v.versionNo, lo, hi };
}

export async function saveScriptText(scriptId: string, body: string, opts: { baseVersionId?: string | null; filmingNotes?: string | null } = {}): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const text = body.trim().slice(0, 20_000);
  if (!text) return { ok: false, message: "The script can't be empty." };
  // A manual edit is a NEW version (never an overwrite): the previous version
  // — and the shared one, if the client already has it — stays intact.
  try {
    const { editScriptFromBody } = await import("@/lib/contentScripts");
    const me = await actor();
    const r = await editScriptFromBody(scriptId, text, me.email, opts);
    revalidatePath("/content");
    return { ok: true, message: `Saved as version ${r.versionNo}.` };
  } catch (e) { return fail(e); }
}

/** Oct 14 2026: copy an earlier version back on top as a new version (nothing deleted). */
export async function restoreScriptVersionAction(scriptId: string, versionId: string, baseVersionId?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { restoreScriptVersion } = await import("@/lib/contentScripts");
    const me = await actor();
    const r = await restoreScriptVersion(scriptId, versionId, me.email, { baseVersionId });
    revalidatePath("/content");
    return { ok: true, message: `v${r.fromNo} restored as version ${r.versionNo}. The versions in between are kept.` };
  } catch (e) { return fail(e); }
}

// (syncCallsNow — the staff "sync calls" action that ran the retired legacy
// Calendly / Notetaker / Drive sweeps on demand — was removed Oct 13 2026.
// Nothing rendered its button any more; calls arrive through the mapped call
// chain on the hourly sync.)

// ---------------------------------------------------------------------------
// Generators: seed the topic bank from strategy + call ideas; build the agent
// profile from calls + strategy + filmed content. Both non-destructive.
// ---------------------------------------------------------------------------
export async function generateTopicIdeas(enrollmentId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { seedTopicBank } = await import("@/lib/contentPipeline");
    const me = await actor();
    const r = await seedTopicBank(enrollmentId, null, { requestedBy: me.email });
    revalidatePath("/content");
    if (r.needsInput.length) return { ok: false, message: `Not enough context to build topics: ${r.needsInput.join(" ")}` };
    return { ok: true, message: r.created ? `${r.created} topic suggestion${r.created === 1 ? "" : "s"} across ${r.pillars.length} pillar${r.pillars.length === 1 ? "" : "s"} — accept, edit or archive each one on Video Topics.` : "Nothing new — the bank already covers this ground." };
  } catch (e) { return fail(e); }
}

export async function buildProfile(clientId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { buildAgentProfileFromHistory } = await import("@/lib/contentPipeline");
    const me = await actor();
    const r = await buildAgentProfileFromHistory(clientId, { requestedBy: me.email });
    revalidatePath("/content");
    return { ok: true, message: r.keysAdded ? `${r.keysAdded} entries added across ${r.sectionsFilled} section${r.sectionsFilled === 1 ? "" : "s"} — hand-written entries untouched.` : "Not enough call/strategy history to add anything new." };
  } catch (e) { return fail(e); }
}

// ---------------------------------------------------------------------------
// Client portal (Phase 5): issue the unguessable share link. Owner-only —
// this LINK is client-facing.
// ---------------------------------------------------------------------------
export async function issuePortalLink(enrollmentId: string): Promise<Result & { url?: string }> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { portalToken: true } });
  if (!e) return { ok: false, message: "Enrollment not found." };
  let token = e.portalToken;
  if (!token) {
    const { randomBytes } = await import("crypto");
    token = randomBytes(24).toString("base64url");
    // portalTokenIssuedAt is stamped HERE as well as in the newer access card
    // (W1-A handover c): without it a token minted from this older button
    // looks, to the access card, like a link that was never issued — so a
    // later rotation would be invisible and "when did this client get their
    // link" would have no answer.
    await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { portalToken: token, portalTokenIssuedAt: new Date() } });
  }
  const base = appBase();
  return { ok: true, message: "Portal link ready — send it to the client whenever you choose.", url: `${base}/portal/${token}` };
}

// Owner clears a parked website signup off the /content review strip once the
// terms are confirmed. Form action (no client component needed).
export async function dismissSignupReview(formData: FormData): Promise<void> {
  await requireOwner();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const { resolveSignupReview } = await import("@/lib/stripeSignups");
  await resolveSignupReview(id);
  revalidatePath("/content");
}

// ---------------------------------------------------------------------------
// Client script suggestions (portal interactive layer, Aug 28). The client's
// ask is a RECORD — applying it runs the AI rewrite with their words as the
// instruction (original body snapshotted on the suggestion), and the script
// drops back to INTERNAL_REVIEW so a human re-approves before the portal
// shows the new version.
// ---------------------------------------------------------------------------
export async function applyScriptSuggestion(suggestionId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const sugg = await prisma.scriptSuggestion.findUnique({
    where: { id: suggestionId },
    select: { id: true, scriptId: true, enrollmentId: true, body: true, status: true },
  });
  if (!sugg || sugg.status !== "OPEN") return { ok: false, message: "That suggestion was already handled." };
  const script = await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { body: true, historical: true } });
  if (!script) return { ok: false, message: "That script no longer exists." };
  // A historical import is the record of what was filmed — the client's note is
  // kept as a suggestion to read, never an AI rewrite of history.
  if (script.historical) return { ok: false, message: "This is an imported historical script — it is not rewritten. Read the suggestion, then dismiss it or draft a new script for the topic." };
  // Atomic claim: two admins (or a double-click) racing here would run the AI
  // rewrite twice — the second pass rewrites the first pass's output (review
  // finding). Only the claimer proceeds; failure releases the claim.
  const claimed = await prisma.scriptSuggestion.updateMany({
    where: { id: sugg.id, status: "OPEN" },
    data: { status: "APPLYING", originalBody: script.body },
  });
  if (claimed.count !== 1) return { ok: false, message: "That suggestion is being applied already." };
  try {
    const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
    const me = await actor();
    await reviseScriptWithInstructions(
      sugg.scriptId,
      `The client sent this suggestion from their portal — apply it faithfully, keeping everything they didn't mention:\n"${sugg.body}"`,
      { requestedBy: me.email, source: "CLIENT_REQUEST" },
    );
  } catch (e) {
    await prisma.scriptSuggestion.updateMany({ where: { id: sugg.id, status: "APPLYING" }, data: { status: "OPEN", originalBody: null } }).catch(() => {});
    return fail(e);
  }
  await prisma.scriptSuggestion.update({
    where: { id: sugg.id },
    data: { status: "APPLIED", resolvedAt: new Date() },
  });
  revalidatePath("/content");
  return { ok: true, message: "Rewritten with their suggestion — review and approve the new version." };
}

export async function dismissScriptSuggestion(suggestionId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  await prisma.scriptSuggestion.updateMany({
    where: { id: suggestionId, status: "OPEN" },
    data: { status: "DISMISSED", resolvedAt: new Date() },
  });
  revalidatePath("/content");
  return { ok: true, message: "Dismissed." };
}

// ---------------------------------------------------------------------------
// Month slippage controls (Jordan, Aug 28: "we did her July content in August
// — sometimes clients get a month behind or miss a month"). The content month
// is a PACKAGE, not a calendar month: a session filmed in August can BELONG to
// July. Moving a session re-labels it (and its library videos); skipping a
// month records "the client missed this one" so nothing nags about it.
// ---------------------------------------------------------------------------
export async function moveSessionToMonth(projectId: string, targetMonthKey: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (!/^\d{4}-\d{2}$/.test(targetMonthKey)) return { ok: false, outcome: "refused", message: "Pick a month." };
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, contentMonthId: true },
  });
  if (!project?.contentMonthId) return { ok: false, outcome: "refused", message: "That session isn't attached to a content month." };
  const from = await prisma.contentMonth.findUnique({
    where: { id: project.contentMonthId },
    select: { id: true, enrollmentId: true, monthKey: true },
  });
  if (!from) return { ok: false, outcome: "refused", message: "That session isn't attached to a content month." };
  if (from.monthKey === targetMonthKey) return { ok: true, outcome: "confirmed", message: "Already on that month." };
  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { id: from.enrollmentId },
    select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true },
  });
  if (!enrollment) return { ok: false, outcome: "refused", message: "Enrollment not found." };
  // Find-or-create the target month WITHIN the same enrollment — a session can
  // never move to another client's month.
  const target = await prisma.contentMonth.upsert({
    where: { enrollmentId_monthKey: { enrollmentId: enrollment.id, monthKey: targetMonthKey } },
    update: {},
    create: {
      enrollmentId: enrollment.id,
      clientId: enrollment.clientId,
      monthKey: targetMonthKey,
      videosOwed: enrollment.videosPerMonth,
      historical: targetMonthKey < etMonthKey(),
      strategyCallStatus: enrollment.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
    },
    select: { id: true },
  });
  await prisma.project.update({ where: { id: projectId }, data: { contentMonthId: target.id } });
  // The library follows the session — the portal groups by month, and "her
  // July content" must sit under July however late it was filmed.
  let libraryConfirmed = true;
  await prisma.portalVideo.updateMany({ where: { projectId }, data: { monthId: target.id } }).catch(() => { libraryConfirmed = false; });
  revalidatePath(`/content/${enrollment.id}`);
  revalidatePath("/content");
  return libraryConfirmed
    ? { ok: true, outcome: "confirmed", message: `Moved to ${targetMonthKey} — the portal follows.` }
    : { ok: false, outcome: "unknown", message: `The session moved to ${targetMonthKey}, but the library update was not confirmed. Ask staff to inspect this session and its exact video records before another move.` };
}

/** An explicit staff repair for a job with no month link. No title/date matching. */
export async function attachUnlinkedSessionToMonth(projectId: string, monthId: string, reason: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const why = reason.trim();
  if (why.length < 8 || why.length > 500) return { ok: false, message: "Say why this job belongs to this package month (8–500 characters)." };
  const [month, project, who] = await Promise.all([
    prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, clientId: true, enrollmentId: true, monthKey: true } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, clientId: true, contentMonthId: true, status: true, deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true } } } }),
    actor(),
  ]);
  if (!month || !project || project.clientId !== month.clientId) return { ok: false, message: "The month and job must belong to the same client." };
  if (project.contentMonthId) return { ok: false, message: "This job already has a month link. Use the month selector on its session row." };
  if (project.status === "CANCELLED" || !project.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")) return { ok: false, message: "Choose an active video job." };
  const conflictingLibrary = await prisma.portalVideo.count({ where: { projectId, monthId: { not: null, notIn: [month.id] } } });
  const conflictingVideo = await prisma.contentVideo.count({ where: { projectId, monthId: { not: null, notIn: [month.id] } } });
  if (conflictingLibrary || conflictingVideo) return { ok: false, message: "This job has video records assigned to another month. Reconcile those identities first; nothing was changed." };
  try {
    await prisma.$transaction(async (tx) => {
      const changed = await tx.project.updateMany({ where: { id: projectId, clientId: month.clientId, contentMonthId: null }, data: { contentMonthId: month.id } });
      if (changed.count !== 1) throw new Error("The job's month link changed while you were working. Reload before trying again.");
      await tx.activity.create({ data: { projectId, type: "SYSTEM", body: `${who.name ?? who.email} linked this job to ${month.monthKey} content month. Reason: ${why}`.slice(0, 1000) } });
    });
  } catch (e) { return fail(e); }
  revalidatePath(`/content/${month.enrollmentId}`);
  revalidatePath(`/edit/${projectId}`);
  revalidatePath("/content");
  return { ok: true, message: `Linked to ${month.monthKey}. Review each video's topic and library month separately.` };
}

export async function setMonthSkipped(monthId: string, skipped: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, status: true, monthKey: true } });
  if (!month) return { ok: false, outcome: "refused", message: "Month not found." };
  // Oct 7 2026: a month closed by a catch-up (or carrying one) is changed through
  // the catch-up's own Undo, which puts BOTH months back — never one of them alone.
  {
    const { catchUpFrom, catchUpInto, catchUpMonthName } = await import("@/lib/catchUp");
    const e = await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { overridesJson: true } });
    const from = month.status === "SKIPPED" ? catchUpFrom(e?.overridesJson, month.monthKey) : null;
    if (from) return { ok: false, outcome: "refused", message: `This month was caught up in ${catchUpMonthName(from.targetMonthKey, month.monthKey)}. To reopen it, undo the catch-up on ${catchUpMonthName(from.targetMonthKey, month.monthKey)}.` };
    const into = skipped ? catchUpInto(e?.overridesJson, month.monthKey) : null;
    if (into) return { ok: false, outcome: "refused", message: `This month carries the ${catchUpMonthName(into.missedMonthKey, month.monthKey)} catch-up. Undo the catch-up first.` };
    // Oct 12 2026: a month whose session is booked late, or a month that books
    // one, changes through that control's own Undo.
    if (skipped) {
      const { lateSessionOf, lateSessionsInto, lateMonthName } = await import("@/lib/lateSession");
      const own = lateSessionOf(e?.overridesJson, month.monthKey);
      if (own) return { ok: false, outcome: "refused", message: `This month's session is being booked in ${lateMonthName(own.hostMonthKey, month.monthKey)}. Undo that first.` };
      const hosts = lateSessionsInto(e?.overridesJson, month.monthKey)[0];
      if (hosts) return { ok: false, outcome: "refused", message: `This month books ${lateMonthName(hosts.lateMonthKey, month.monthKey)}'s session too. Undo that first.` };
    }
  }
  await prisma.contentMonth.update({
    where: { id: monthId },
    data: { status: skipped ? "SKIPPED" : "OPEN" },
  });
  revalidatePath(`/content/${month.enrollmentId}`);
  revalidatePath("/content");
  return { ok: true, outcome: "confirmed", message: skipped ? "Marked skipped — no more nagging about this month." : "Reopened." };
}

// ---------------------------------------------------------------------------
// CATCH UP A MISSED MONTH (Oct 7 2026) — owner/admin only. The rules and the
// writes live in src/lib/monthCatchUp.ts; these only check who is asking.
// ---------------------------------------------------------------------------
export async function catchUpMonthAction(targetMonthId: string, missedMonthId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof targetMonthId !== "string" || typeof missedMonthId !== "string" || !targetMonthId || !missedMonthId) return { ok: false, outcome: "refused", message: "Pick the month to catch up." };
  const who = await actor();
  try {
    const { applyCatchUp } = await import("@/lib/monthCatchUp");
    const r = await applyCatchUp(targetMonthId, missedMonthId, who.name ?? who.email);
    const t = await prisma.contentMonth.findUnique({ where: { id: targetMonthId }, select: { enrollmentId: true } });
    if (t) revalidatePath(`/content/${t.enrollmentId}`);
    revalidatePath("/content");
    return { ok: true, outcome: "confirmed", message: r.message };
  } catch (e) { return { ...fail(e), outcome: "refused" }; }
}

export async function undoCatchUpAction(targetMonthId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof targetMonthId !== "string" || !targetMonthId) return { ok: false, outcome: "refused", message: "Month not found." };
  const who = await actor();
  try {
    const { undoCatchUp } = await import("@/lib/monthCatchUp");
    const r = await undoCatchUp(targetMonthId, who.name ?? who.email);
    const t = await prisma.contentMonth.findUnique({ where: { id: targetMonthId }, select: { enrollmentId: true } });
    if (t) revalidatePath(`/content/${t.enrollmentId}`);
    revalidatePath("/content");
    return { ok: true, outcome: "confirmed", message: r.message };
  } catch (e) { return { ...fail(e), outcome: "refused" }; }
}

// ---------------------------------------------------------------------------
// FILM A LATE MONTH'S SESSION THIS MONTH (Oct 12 2026) — owner/admin only, an
// exception. The rules and the writes live in src/lib/monthLateSession.ts;
// these only check who is asking. The message action composes text for the
// office to copy: it sends nothing.
// ---------------------------------------------------------------------------
const ID = /^[a-z0-9]{10,40}$/i;

export async function lateSessionAction(hostMonthId: string, lateMonthId: string, scriptsSentOutside: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof hostMonthId !== "string" || typeof lateMonthId !== "string" || !ID.test(hostMonthId) || !ID.test(lateMonthId)) return { ok: false, outcome: "refused", message: "Pick the month whose session is booked late." };
  const who = await actor();
  try {
    const { applyLateSession } = await import("@/lib/monthLateSession");
    const r = await applyLateSession(hostMonthId, lateMonthId, who.name ?? who.email, { scriptsSentOutside: scriptsSentOutside === true });
    const t = await prisma.contentMonth.findUnique({ where: { id: hostMonthId }, select: { enrollmentId: true } });
    if (t) revalidatePath(`/content/${t.enrollmentId}`);
    revalidatePath("/content");
    return { ok: true, outcome: "confirmed", message: r.message };
  } catch (e) { return { ...fail(e), outcome: "refused" }; }
}

export async function undoLateSessionAction(lateMonthId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof lateMonthId !== "string" || !ID.test(lateMonthId)) return { ok: false, outcome: "refused", message: "Month not found." };
  const who = await actor();
  try {
    const { undoLateSession } = await import("@/lib/monthLateSession");
    const r = await undoLateSession(lateMonthId, who.name ?? who.email);
    const m = await prisma.contentMonth.findUnique({ where: { id: lateMonthId }, select: { enrollmentId: true } });
    if (m) revalidatePath(`/content/${m.enrollmentId}`);
    revalidatePath("/content");
    return { ok: true, outcome: "confirmed", message: r.message };
  } catch (e) { return { ...fail(e), outcome: "refused" }; }
}

/**
 * One session or two (Oct 13 2026): film the late month together with the
 * month that books it in ONE 4-hour Video Accelerator session (Starter
 * only), or in two sessions. The same rule the client's own choice follows
 * (monthLateSession.setLateCombined). Sends nothing, books nothing.
 */
export async function setLateCombinedAction(lateMonthId: string, combined: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof lateMonthId !== "string" || !ID.test(lateMonthId) || typeof combined !== "boolean") return { ok: false, outcome: "refused", message: "Month not found." };
  const who = await actor();
  try {
    const { setLateCombined } = await import("@/lib/monthLateSession");
    const r = await setLateCombined(lateMonthId, combined, who.name ?? who.email);
    const m = await prisma.contentMonth.findUnique({ where: { id: lateMonthId }, select: { enrollmentId: true } });
    if (m) revalidatePath(`/content/${m.enrollmentId}`);
    revalidatePath("/content");
    return { ok: true, outcome: "confirmed", message: r.message };
  } catch (e) { return { ...fail(e), outcome: "refused" }; }
}

/** Oct 13 2026: offer (or stop offering) the client one 4-hour catch-up session; the client chooses in the portal. */
export async function setLateCombineOfferAction(lateMonthId: string, offered: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof lateMonthId !== "string" || !ID.test(lateMonthId) || typeof offered !== "boolean") return { ok: false, outcome: "refused", message: "Month not found." };
  const who = await actor();
  try {
    const { setLateCombineOffer } = await import("@/lib/monthLateSession");
    const r = await setLateCombineOffer(lateMonthId, offered, who.name ?? who.email);
    const m = await prisma.contentMonth.findUnique({ where: { id: lateMonthId }, select: { enrollmentId: true } });
    if (m) revalidatePath(`/content/${m.enrollmentId}`);
    revalidatePath("/content");
    return { ok: true, outcome: "confirmed", message: r.message };
  } catch (e) { return { ...fail(e), outcome: "refused" }; }
}

/** Jordan's message to the client, filled in with their portal link. Copy only — never sent from here. */
export async function lateSessionMessageAction(lateMonthId: string): Promise<Result & { body?: string; url?: string }> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof lateMonthId !== "string" || !ID.test(lateMonthId)) return { ok: false, outcome: "refused", message: "Month not found." };
  try {
    const me = await actor();
    const { lateSessionCopy } = await import("@/lib/monthLateSession");
    const r = await lateSessionCopy(lateMonthId, me.id);
    return { ok: true, outcome: "confirmed", message: r.kind === "login" ? "Copied. It carries a one-time sign-in link (good for 15 minutes), so send it now." : "Copied. Paste it into your text or email.", body: r.body, url: r.url };
  } catch (e) { return { ...fail(e), outcome: "refused" }; }
}

// ---------------------------------------------------------------------------
// HOW A MONTH IS PLANNED, SET BY STAFF (Oct 12 2026). Jordan: "or pick topics
// instead (she preferred that)". The client tells us; the office records it.
// Writes exactly what the portal's own choice writes (programMonths.
// choosePlanningMode): CALL, or WRITTEN — the client picks topics — or
// WRITTEN stamped "office:" (we planned it, as the script upload does).
// Nothing else moves: no booking, call record, topic or script.
// ---------------------------------------------------------------------------
export type MonthPlanningChoice = "CALL" | "TOPICS" | "OFFICE";

export async function setMonthPlanningAction(monthId: string, choice: MonthPlanningChoice): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  if (typeof monthId !== "string" || !ID.test(monthId) || !["CALL", "TOPICS", "OFFICE"].includes(choice)) return { ok: false, outcome: "refused", message: "Pick how this month is planned." };
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, historical: true, planningChosenBy: true } });
  if (!month) return { ok: false, outcome: "refused", message: "Month not found." };
  const { lateMonthName } = await import("@/lib/lateSession");
  const n = lateMonthName(month.monthKey);
  if (month.historical || month.status !== "OPEN") return { ok: false, outcome: "refused", message: `${n} is ${month.historical ? "imported history" : month.status.toLowerCase()}, so its plan can't change.` };
  const e = await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { clientSuppliesTopics: true } });
  if (e?.clientSuppliesTopics) return { ok: false, outcome: "refused", message: "This client plans their own videos (Settings › Program style), so there's no planning route to set." };
  const { recalcProgramMonth, choosePlanningMode } = await import("@/lib/programMonths");
  const d = (await recalcProgramMonth(month.id, { dryRun: true }))?.after;
  if (!d) return { ok: false, outcome: "refused", message: "Couldn't read the month. Reload and try again." };
  const mode = choice === "CALL" ? "CALL" : "WRITTEN";
  const office = !!month.planningChosenBy?.startsWith("office:");
  const current: MonthPlanningChoice | null = d.planningMode === "CALL" ? "CALL" : d.planningMode === "WRITTEN" ? (office ? "OFFICE" : "TOPICS") : null;
  const words: Record<MonthPlanningChoice, string> = { CALL: "on a strategy call", TOPICS: "by the client picking topics in the portal", OFFICE: "by us (we planned it)" };
  if (current === choice && !!month.planningChosenBy) return { ok: true, outcome: "confirmed", message: `${n} is already planned ${words[choice]}.` };
  if (choice === "CALL" && d.callMode === "NOT_INCLUDED") return { ok: false, outcome: "refused", message: "This package has no strategy call." };
  if (mode === "WRITTEN" && d.planningMode !== "WRITTEN" && d.strategyCallStatus === "COMPLETED") return { ok: false, outcome: "refused", message: `${n}'s strategy call was held, so the month stays planned on it.` };
  const live = await prisma.programSessionRequest.count({ where: { monthId: month.id, status: { in: ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"] } } });
  const routeNow = d.planningMode === "UNDECIDED" ? "WRITTEN" : d.planningMode;
  if ((live > 0 || d.sessionsAccountedFor > 0) && routeNow !== mode) return { ok: false, outcome: "refused", message: `Filming is already booked from how ${n} was planned, so the route can't change now.` };
  const who = await actor();
  const by = choice === "OFFICE" ? `office:${who.email}` : `staff:${who.id ?? who.email}`;
  const r = await choosePlanningMode(month.id, mode, by);
  if (!r) return { ok: false, outcome: "refused", message: "Month not found." };
  revalidatePath(`/content/${month.enrollmentId}`);
  revalidatePath("/content");
  return {
    ok: true, outcome: "confirmed",
    message: choice === "CALL" ? `${n} is planned on a strategy call. Their portal asks them to book it.`
      : choice === "TOPICS" ? `${n} is planned by the client picking topics. Their portal asks them to choose topics and answer the questions.`
      : `${n} is marked planned by us. Their portal says we wrote the scripts. Upload them on Plan › Scripts.`,
  };
}

// Scripts slip months too (Jordan, Aug 28: "her July scripts were for the
// content we shot in August") — same move semantics as sessions: the script
// re-labels onto the month its content belongs to, and the portal follows.
export async function moveScriptToMonth(scriptId: string, targetMonthKey: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!/^\d{4}-\d{2}$/.test(targetMonthKey)) return { ok: false, message: "Pick a month." };
  const script = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, enrollmentId: true, monthId: true },
  });
  if (!script) return { ok: false, message: "That script no longer exists." };
  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { id: script.enrollmentId },
    select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true },
  });
  if (!enrollment) return { ok: false, message: "Enrollment not found." };
  const target = await prisma.contentMonth.upsert({
    where: { enrollmentId_monthKey: { enrollmentId: enrollment.id, monthKey: targetMonthKey } },
    update: {},
    create: {
      enrollmentId: enrollment.id,
      clientId: enrollment.clientId,
      monthKey: targetMonthKey,
      videosOwed: enrollment.videosPerMonth,
      historical: targetMonthKey < etMonthKey(),
      strategyCallStatus: enrollment.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
    },
    select: { id: true },
  });
  if (target.id === script.monthId) return { ok: true, message: "Already on that month." };
  await prisma.contentScript.update({ where: { id: scriptId }, data: { monthId: target.id } });
  revalidatePath(`/content/${enrollment.id}`);
  return { ok: true, message: `Moved to ${targetMonthKey}.` };
}

// ===========================================================================
// CONTENT PROGRAM OPERATING SYSTEM (Sep 17 2026) — strategy versions,
// pillars, video topics, interviews, script versions, client facts, imports.
// Every write is attributable; approvals honour ProgramOwnerAssignment
// (Jordan owns strategy + scripts by default, overridable per client/month).
// ===========================================================================
const path = (enrollmentId: string) => { revalidatePath(`/content/${enrollmentId}`); revalidatePath("/content"); };

// ---- owners ---------------------------------------------------------------------
export async function setDutyOwner(enrollmentId: string, duty: OwnerDuty, appUserId: string | null, monthId?: string | null): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await setOwnerOverride(monthId ? "MONTH" : "ENROLLMENT", monthId ?? enrollmentId, duty, appUserId, me.email);
    path(enrollmentId);
    return { ok: true, message: appUserId ? "Owner set." : "Back to the program default." };
  } catch (e) { return fail(e); }
}

// ---- strategy ----------------------------------------------------------------------
export async function approveStrategy(versionId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true } });
    if (!v) return { ok: false, message: "Version not found." };
    const me = await actor();
    await assertDutyOwner("STRATEGY", v.enrollmentId, null, me);
    const { approveStrategyVersion } = await import("@/lib/contentStrategy");
    const r = await approveStrategyVersion(versionId, me.email);
    // CP-07: the initial topic bank is QUEUED the moment a strategy is approved
    // — a row, no AI call, no spend. It runs on the hourly tick once
    // `topic_refresh` is on, or the moment somebody presses Refresh topics
    // (which takes the queued run over rather than paying twice).
    let bankNote = "";
    try {
      const approvedAt = (await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { approvedAt: true } }))?.approvedAt ?? new Date(0);
      const since = await prisma.contentTopicRefreshRun.count({ where: { enrollmentId: v.enrollmentId, kind: { in: ["BANK", "REFRESH"] }, status: { notIn: ["FAILED", "CANCELLED"] }, createdAt: { gte: approvedAt } } });
      if (!since) {
        const { queueTopicRefresh } = await import("@/lib/contentTopics");
        const bankTopics = await prisma.contentTopic.count({ where: { enrollmentId: v.enrollmentId, status: { notIn: ["REJECTED", "ARCHIVED"] } } });
        await queueTopicRefresh({ enrollmentId: v.enrollmentId, kind: bankTopics ? "REFRESH" : "BANK", requestedBy: me.email, reason: "initial bank after strategy approval" });
        bankNote = " The topic bank is queued: it builds on its own once the automatic topic bank is switched on, or press Refresh topics on Video Topics to build it now.";
      }
    } catch { /* the approval stands; the bank can still be built by hand */ }
    // Oct 14 2026: a NEW approved strategy re-derives the client's creative
    // identity (one AI call, auto-approved), after the response and best
    // effort. If it does not run here, the 15-minute AI cron sees the stale
    // identity and builds it.
    if (!r.alreadyApproved) {
      const enrollmentId = v.enrollmentId;
      const work = async () => {
        try {
          const { deriveCreativeIdentity } = await import("@/lib/creativeIdentity");
          await deriveCreativeIdentity(enrollmentId, { requestedBy: me.email, unattended: false });
        } catch { /* the cron retries a missing or stale identity */ }
      };
      try { after(work); } catch { void work(); }
    }
    // APPROVING RELEASES IT (Oct 14 2026). Jordan, Oct 13: "Can you just
    // automate this ... I just want everything done for me." An approved
    // version goes to the client's portal in the same press, through the same
    // releaseStrategyToPortal the Release button uses, so the "strategy ready"
    // email is queued exactly as a Release would queue it: only while
    // script_share_email is on AND the rollout reaches this client (with the
    // reminders policy's testClientsOnly lock); otherwise it is suppressed and
    // the message says why. If the release refuses (the team's working-notes
    // section, a [CONFIDENTIAL] marker), the approval stands and the message
    // says why it is not in their portal. An already-released version is not
    // released again (no second notice).
    let releaseNote = "";
    try {
      const { releaseStrategyToPortal } = await import("@/lib/programOnboarding");
      const now = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { status: true, releasedAt: true } });
      if (now?.status === "APPROVED" && !now.releasedAt) {
        const rel = await releaseStrategyToPortal(versionId, me.email);
        releaseNote = ` ${rel.message}`;
      } else if (now?.releasedAt) {
        releaseNote = " It is already in their portal.";
      }
    } catch (e) {
      releaseNote = ` Not released to their portal: ${e instanceof Error ? e.message : String(e)}`;
    }
    path(v.enrollmentId);
    if (r.alreadyApproved) return { ok: true, message: (r.pillarsCreated ? `Already approved · ${r.pillarsCreated} pillar${r.pillarsCreated === 1 ? "" : "s"} created from the document.` : releaseNote ? "Already approved; its pillars exist." : "Already approved — its pillars exist; nothing changed.") + releaseNote + bankNote };
    return { ok: true, message: `Approved under your name${r.pillarsCreated ? ` · ${r.pillarsCreated} pillar${r.pillarsCreated === 1 ? "" : "s"} created from the document` : ""}.${releaseNote}${bankNote}` };
  } catch (e) { return fail(e); }
}

/** Oct 14 2026: "Rebuild" on the Strategy tab's Creative identity card: one AI call from the approved strategy, auto-approved. */
export async function rebuildCreativeIdentityAction(enrollmentId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { deriveCreativeIdentity } = await import("@/lib/creativeIdentity");
    const r = await deriveCreativeIdentity(String(enrollmentId ?? ""), { requestedBy: me.email, unattended: false });
    if (!r.ok) return { ok: false, message: r.reason };
    path(enrollmentId);
    return { ok: true, message: "Creative identity rebuilt from the approved strategy. Scripts and topic ideas use it from now on." };
  } catch (e) { return fail(e); }
}

/** Create the pillars the APPROVED version names but the client lacks (the four lifted v1s had none). Idempotent. */
export async function createPillarsFromStrategy(versionId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true } });
    if (!v) return { ok: false, message: "Version not found." };
    const me = await actor();
    const { syncPillarsFromVersion } = await import("@/lib/contentStrategy");
    const n = await syncPillarsFromVersion(versionId, me.email);
    path(v.enrollmentId);
    return { ok: true, message: n ? `${n} pillar${n === 1 ? "" : "s"} created from the approved document (stable ids from here on).` : "Every pillar in the document already exists — nothing created. If the document names none, add pillars by hand below." };
  } catch (e) { return fail(e); }
}

/**
 * Release an approved version to the client's portal. A08 (Sep 25 2026): this
 * goes through programOnboarding.releaseStrategyToPortal, so the "Your Content
 * Strategy is Ready + Next Steps" email is queued behind script_share_email
 * (off → nothing queued, and the message says so; the drain also holds real
 * clients while testClientsOnly is on). It used to call the bare release, so
 * the notice could never be queued from the product at all.
 */
export async function releaseStrategy(versionId: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true } });
    if (!v) return { ok: false, message: "Version not found." };
    const me = await actor();
    const { releaseStrategyToPortal } = await import("@/lib/programOnboarding");
    const r = await releaseStrategyToPortal(versionId, me.email);
    path(v.enrollmentId);
    return { ok: true, message: r.message };
  } catch (e) { return fail(e); }
}

// ---- strategy: drafting, editing and revising (A08, Sep 25 2026) ------------------------
// All four are the STRATEGY duty owner's (Jordan by default), and none of them
// approves or releases anything: each ends as a version for review.

/** Draft the strategy NOW from the confirmed brand-discovery transcript — a person's click, so it runs with the sweep switches off. */
export async function draftStrategyFromDiscovery(enrollmentId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await assertDutyOwner("STRATEGY", enrollmentId, null, me);
    const { draftStrategyNow } = await import("@/lib/programOnboarding");
    const r = await draftStrategyNow(enrollmentId, me.email);
    path(enrollmentId);
    const held = r.stripped ? ` ${r.stripped} transcript line${r.stripped === 1 ? " was" : "s were"} held back as confidential or about another client.` : "";
    const early = r.analysed ? "" : " The call's analysis hasn't run yet, so only lines marked or said in confidence were held back — read the draft with that in mind.";
    return { ok: true, message: `Drafted v${r.versionNo} from the discovery call${r.gaps ? ` · ${r.gaps} gap${r.gaps === 1 ? "" : "s"} listed for you to fill, not invented` : ""}. Edit it here, then approve.${held}${early}` };
  } catch (e) { return fail(e); }
}

/** Edit one section of a version by hand (text), or remove it (text null). A new version; no AI; the version edited is kept. */
export async function editStrategySection(versionId: string, sectionId: string, text: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true } });
    if (!v) return { ok: false, message: "Version not found." };
    const me = await actor();
    await assertDutyOwner("STRATEGY", v.enrollmentId, null, me);
    const { editStrategyVersionSection } = await import("@/lib/contentStrategy");
    const r = await editStrategyVersionSection(versionId, String(sectionId ?? ""), typeof text === "string" ? text : null, me.email);
    path(v.enrollmentId);
    if (!r.changedSectionIds.length) return { ok: true, message: "Nothing changed — the text is the same." };
    if (r.existed) return { ok: true, message: `That matches v${r.versionNo} already — nothing new was saved.` };
    return { ok: true, message: `${typeof text === "string" ? "Saved" : "Removed"} “${r.heading}” as v${r.versionNo}. Every other section is exactly as it was; approve v${r.versionNo} when it's right.` };
  } catch (e) { return fail(e); }
}

/** Revise a version with Jordan's notes and the client's suggestions — one AI run, only the sections the feedback touches change. */
export async function reviseStrategy(versionId: string, notes: string, proposalIds: string[]): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true } });
    if (!v) return { ok: false, message: "Version not found." };
    const me = await actor();
    await assertDutyOwner("STRATEGY", v.enrollmentId, null, me);
    const { reviseStrategyWithFeedback } = await import("@/lib/contentGeneration");
    const r = await reviseStrategyWithFeedback(versionId, { notes: typeof notes === "string" ? notes : null, proposalIds: Array.isArray(proposalIds) ? proposalIds.map(String) : [] }, me.email);
    path(v.enrollmentId);
    const left = r.unaddressed.length ? ` Not applied: ${r.unaddressed.slice(0, 3).join("; ")}.` : "";
    if (r.versionId === versionId) return { ok: true, message: `The revision changed nothing.${left}` };
    if (r.existed && !r.changedSections.length) return { ok: true, message: `Already revised with that feedback — it's v${r.versionNo}.` };
    return { ok: true, message: `Revised as v${r.versionNo}: ${r.changedSections.join(", ") || "no sections"} changed, everything else kept word for word${r.proposalsFolded ? ` · ${r.proposalsFolded} client suggestion${r.proposalsFolded === 1 ? "" : "s"} folded in` : ""}.${left} Approve it when it's right.` };
  } catch (e) { return fail(e); }
}

/** Discovery is waived only explicitly, with a reason — for a client whose strategy arrives by import. Owner only. */
export async function waiveDiscoveryAction(enrollmentId: string, reason: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { waiveDiscovery, advanceOnboarding } = await import("@/lib/programOnboarding");
    await waiveDiscovery(enrollmentId, me.email, String(reason ?? ""));
    await advanceOnboarding(enrollmentId, { enqueue: false, requestedBy: me.email }).catch(() => {});
    path(enrollmentId);
    return { ok: true, message: "Discovery waived, with your reason on the record." };
  } catch (e) { return fail(e); }
}

export async function rejectStrategy(versionId: string, note: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true, status: true } });
    if (!v) return { ok: false, message: "Version not found." };
    if (v.status === "APPROVED") return { ok: false, message: "Approve a newer version instead of rejecting the one in force." };
    const me = await actor();
    const { rejectStrategyVersion } = await import("@/lib/contentStrategy");
    await rejectStrategyVersion(versionId, me.email, note);
    path(v.enrollmentId);
    return { ok: true, message: "Rejected (kept as history)." };
  } catch (e) { return fail(e); }
}

/**
 * Accept or reject a strategy proposal (the STRATEGY duty owner). CP-11: a
 * proposal aimed at one section replaces that section only, in a new draft
 * (`text` = the replacement as the person edited it); the version in force is
 * untouched until someone approves the draft. A profile-change proposal is
 * refused here — it is applied from the Facts tab.
 */
export async function resolveStrategyProposal(proposalId: string, accept: boolean, note: string, text?: string | null, sectionId?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const p = await prisma.contentStrategyProposal.findUnique({ where: { id: proposalId }, select: { enrollmentId: true } });
    if (!p) return { ok: false, message: "Proposal not found." };
    const me = await actor();
    await assertDutyOwner("STRATEGY", p.enrollmentId, null, me);
    const { acceptStrategyProposal, rejectStrategyProposal } = await import("@/lib/contentStrategy");
    if (accept) {
      // Oct 13 2026: `text` is the person's own instruction now (how to apply it), not a replacement section.
      const how = [note, typeof text === "string" ? text : ""].map((x) => (x ?? "").trim()).filter(Boolean).join("\n");
      const r = await acceptStrategyProposal(proposalId, me.email, how, { sectionId: typeof sectionId === "string" && sectionId ? sectionId : null });
      path(p.enrollmentId);
      const where = r.sectionHeadings?.length ? ` (${r.sectionHeadings.map((h) => `"${h}"`).join(", ")})` : "";
      return {
        ok: true,
        message: r.versionId
          ? `Accepted. v${r.versionNo} is v${r.basedOnVersionNo} with this change${where}; approve v${r.versionNo} to put it in force.`
          : "Accepted and recorded (there is no strategy to change yet).",
      };
    }
    await rejectStrategyProposal(proposalId, me.email, note);
    path(p.enrollmentId);
    return { ok: true, message: "Rejected." };
  } catch (e) { return fail(e); }
}

export async function saveMonthPriorities(monthId: string, text: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const m = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true } });
    if (!m) return { ok: false, message: "Month not found." };
    const me = await actor();
    const { setMonthPriorities } = await import("@/lib/contentStrategy");
    await setMonthPriorities(monthId, text.split("\n"), `manual:${me.email}`);
    path(m.enrollmentId);
    return { ok: true, message: "Priorities saved for this month." };
  } catch (e) { return fail(e); }
}

// ---- pillars ------------------------------------------------------------------------
export async function addPillar(enrollmentId: string, name: string, purpose: string, focusAreas: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
    if (!e) return { ok: false, message: "Enrollment not found." };
    const me = await actor();
    const { createPillar } = await import("@/lib/contentPillars");
    await createPillar({ enrollmentId, clientId: e.clientId, name, purpose: purpose || null, focusAreas: focusAreas || null, createdBy: me.email });
    path(enrollmentId);
    return { ok: true, message: "Pillar added." };
  } catch (e) { return fail(e); }
}

export async function renamePillarAction(enrollmentId: string, pillarId: string, name: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { renamePillar } = await import("@/lib/contentPillars");
    await renamePillar(pillarId, name, me.email);
    path(enrollmentId);
    return { ok: true, message: "Renamed — the old name stays as an alias, the pillar keeps its identity." };
  } catch (e) { return fail(e); }
}

/**
 * Oct 13 2026 (Jordan, Arielle Roemer's buyer-heavy recommendations): a
 * pillar's emphasis, Lead · Normal · Light. Strategy work, so the strategy
 * duty owner sets it, like approving the strategy. It changes how many bank
 * topics the pillar gets, how its topics rank and where it sits on the
 * client's topic bank; nothing already in the bank is touched.
 */
export async function setPillarEmphasisAction(enrollmentId: string, pillarId: string, emphasis: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await assertDutyOwner("STRATEGY", enrollmentId, null, me);
    const { setPillarEmphasis } = await import("@/lib/contentPillars");
    const r = await setPillarEmphasis(enrollmentId, pillarId, emphasis);
    path(enrollmentId);
    if (!r.changed) return { ok: true, message: `“${r.name}” is already ${r.emphasis.toLowerCase()}.` };
    const what = r.emphasis === "LEAD" ? "a lead pillar: ranked first in recommendations and shown first to the client" : r.emphasis === "LIGHT" ? "a light pillar: a smaller topic bank, ranked lower and shown last" : "a normal pillar";
    return { ok: true, message: `“${r.name}” is now ${what}.` };
  } catch (e) { return fail(e); }
}

export async function confirmPillarMappingAction(enrollmentId: string, label: string, pillarId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { confirmPillarMapping } = await import("@/lib/contentPillars");
    const r = await confirmPillarMapping(enrollmentId, label, pillarId, me.email);
    path(enrollmentId);
    return { ok: true, message: `Mapped “${label}” · ${r.updated} topic${r.updated === 1 ? "" : "s"} linked.` };
  } catch (e) { return fail(e); }
}

export async function dismissPillarLabelAction(enrollmentId: string, label: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { dismissPillarLabel } = await import("@/lib/contentPillars");
    await dismissPillarLabel(enrollmentId, label, me.email);
    path(enrollmentId);
    return { ok: true, message: "Left unmapped — it will not be proposed again." };
  } catch (e) { return fail(e); }
}

// ---- video topics ----------------------------------------------------------------------
export async function editTopic(topicId: string, patch: { title?: string; concept?: string | null; pillarId?: string | null; audienceNeed?: string | null; businessGoal?: string | null; intendedMessage?: string | null }): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { updateTopicFields } = await import("@/lib/contentTopics");
    await updateTopicFields(topicId, patch, { kind: "STAFF", staffUserId: me.email });
    revalidatePath("/content");
    return { ok: true, message: "Saved." };
  } catch (e) { return fail(e); }
}

export async function reconcileTopicSelection(topicId: string, monthId: string, keep: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { reconcileSelection } = await import("@/lib/contentTopics");
    await reconcileSelection(topicId, monthId, keep, { kind: "STAFF", staffUserId: me.email });
    revalidatePath("/content");
    return { ok: true, message: keep ? "Confirmed for the month." : "Back to the bank — the call's mention stays on its history." };
  } catch (e) { return fail(e); }
}

export async function topicDecision(topicId: string, decision: "APPROVE" | "REJECT" | "ARCHIVE" | "REINTRODUCE", reason: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const lib = await import("@/lib/contentTopics");
    if (decision === "APPROVE") await lib.approveTopic(topicId, me.email);
    else if (decision === "REJECT") await lib.rejectTopic(topicId, me.email, reason || null);
    else if (decision === "ARCHIVE") await lib.archiveTopic(topicId, me.email, reason || null);
    else await lib.reintroduceTopic(topicId, me.email, reason || null);
    revalidatePath("/content");
    return { ok: true, message: decision === "REINTRODUCE" ? "Back in the bank (recorded as reintroduced)." : "Recorded." };
  } catch (e) { return fail(e); }
}

export async function discussTopicAction(topicId: string, note: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!note.trim()) return { ok: false, message: "Write the note first." };
  try {
    const me = await actor();
    const { discussTopic } = await import("@/lib/contentTopics");
    await discussTopic(topicId, note.trim(), { kind: "STAFF", staffUserId: me.email });
    revalidatePath("/content");
    return { ok: true, message: "Noted on the topic's history — no status changed." };
  } catch (e) { return fail(e); }
}

export async function runTopicRefresh(enrollmentId: string, kind: "REFRESH" | "RECOMMENDATION", monthId?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { startTopicRefresh } = await import("@/lib/contentTopics");
    // Oct 12 2026: a REFRESH is a 16k-token model call — it runs in the
    // background and the click answers once the run is claimed. Ranking
    // (RECOMMENDATION) is no AI and stays in hand.
    const background = kind === "REFRESH" ? (work: () => Promise<void>) => { try { after(work); } catch { void work(); } } : undefined;
    const r = await startTopicRefresh({ enrollmentId, kind, requestedBy: me.email, monthId: monthId ?? null, background });
    const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r.runId }, select: { status: true, generatedCount: true, changeSummary: true, missingContextJson: true } });
    path(enrollmentId);
    if (r.joined) return { ok: true, message: "That refresh is already running — its suggestions will appear below." };
    if (background && run?.status === "RUNNING") return { ok: true, message: "Refreshing topics in the background — new suggestions appear below when they're ready (a minute or two)." };
    if (run?.status === "NEEDS_INPUT") {
      let missing: string[] = [];
      try { const mc = run.missingContextJson ? (JSON.parse(run.missingContextJson) as { missing?: string[]; gaps?: string[] }) : null; missing = [...(mc?.missing ?? []), ...(mc?.gaps ?? [])]; } catch { /* none */ }
      return { ok: false, message: `Needs more context before it can suggest anything: ${missing.join(" ") || run.changeSummary || "see the run"}` };
    }
    return { ok: true, message: run?.changeSummary ?? `${run?.generatedCount ?? 0} suggestions.` };
  } catch (e) { return fail(e); }
}

export async function suggestionAction(suggestionId: string, action: "ACCEPT" | "ARCHIVE" | "REGENERATE", opts: { monthId?: string | null; edits?: { title?: string; description?: string | null; audienceNeed?: string | null; businessGoal?: string | null; intendedMessage?: string | null } } = {}): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const lib = await import("@/lib/contentTopics");
    if (action === "ACCEPT") { await lib.acceptSuggestion(suggestionId, me.email, { edits: opts.edits, monthId: opts.monthId ?? null }); revalidatePath("/content"); return { ok: true, message: opts.edits && Object.keys(opts.edits).length ? "Accepted with your edits." : "Accepted into the bank." }; }
    if (action === "ARCHIVE") { await lib.archiveSuggestion(suggestionId, me.email); revalidatePath("/content"); return { ok: true, message: "Archived — it will not be suggested again." }; }
    await lib.regenerateSuggestion(suggestionId, me.email);
    revalidatePath("/content");
    return { ok: true, message: "Regenerated — a replacement suggestion is in the list." };
  } catch (e) { return fail(e); }
}

/**
 * 6.3 staff bank controls (Sep 25 2026): approve every suggestion shown, hold
 * the selected ones (out of the queue, off the client's pages, never
 * re-suggested — until released), or regenerate the selected ones. Each row
 * goes through the same single-suggestion function as its own button.
 */
export async function suggestionBulkAction(ids: string[], action: "ACCEPT" | "HOLD" | "REGENERATE", opts: { monthId?: string | null; note?: string | null } = {}): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const lib = await import("@/lib/contentTopics");
    const list = [...new Set(ids)].slice(0, 100);
    if (!list.length) return { ok: false, message: "Nothing selected." };
    if (action === "ACCEPT") {
      const r = await lib.acceptSuggestions(list, me.email, { monthId: opts.monthId ?? null });
      revalidatePath("/content");
      return { ok: r.errors.length === 0, message: `${r.accepted} approved into the bank${r.skipped ? ` · ${r.skipped} already handled` : ""}${r.errors.length ? ` · ${r.errors.length} failed: ${r.errors[0].error}` : ""}.` };
    }
    let done = 0;
    const errors: string[] = [];
    for (const id of list) {
      try {
        if (action === "HOLD") await lib.holdSuggestion(id, me.email, opts.note ?? null);
        else await lib.regenerateSuggestion(id, me.email);
        done++;
      } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    revalidatePath("/content");
    const verb = action === "HOLD" ? "held — off the review list and the client's pages until released" : "regenerated — replacements are in the list";
    return { ok: errors.length === 0, message: `${done} ${verb}${errors.length ? ` · ${errors.length} could not be: ${errors[0]}` : ""}.` };
  } catch (e) { return fail(e); }
}

export async function releaseSuggestionHoldAction(id: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { releaseSuggestionHold } = await import("@/lib/contentTopics");
    await releaseSuggestionHold(id, me.email);
    revalidatePath("/content");
    return { ok: true, message: "Released — it is back on the review list." };
  } catch (e) { return fail(e); }
}

/** The one line a client reads beside a recommended topic (6.3). */
export async function setSuggestionReasonAction(id: string, text: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { setSuggestionClientReason } = await import("@/lib/contentTopics");
    await setSuggestionClientReason(id, text);
    revalidatePath("/content");
    return { ok: true, message: text.trim() ? "Saved — this is what the client reads beside the topic." : "Cleared — the client sees no reason line." };
  } catch (e) { return fail(e); }
}

export async function setTopicsPerPillarAction(n: number): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const { setTopicsPerPillar } = await import("@/lib/aiRuns");
    const p = await setTopicsPerPillar(n);
    revalidatePath("/content");
    return { ok: true, message: `Topics per pillar: ${p.topicsPerPillar}.` };
  } catch (e) { return fail(e); }
}

// ---- CP-07 / CP-08 (Sep 24 2026) --------------------------------------------------

/** Staff put a topic the client said "not interested" to back in their bank (on the record). */
export async function undeclineTopicAction(topicId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { undeclineTopicForClient } = await import("@/lib/contentTopics");
    await undeclineTopicForClient(topicId, { kind: "STAFF", staffUserId: me.email });
    revalidatePath("/content");
    return { ok: true, message: "Back in the client's bank (recorded as reintroduced)." };
  } catch (e) { return fail(e); }
}

/**
 * Carry this client's scripted-but-unfilmed topics into the current month, by
 * hand — the same work `topic_carryover` does on the 1st. `dryRun` lists what
 * would move and changes nothing; that is the first click, always.
 */
export async function carryNowAction(enrollmentId: string, dryRun: boolean): Promise<Result & { candidates?: { title: string; from: string; to: string }[] }> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { carryUnfilmedTopics } = await import("@/lib/contentTopics");
    const r = await carryUnfilmedTopics(enrollmentId, { dryRun, actor: { kind: "STAFF", staffUserId: me.email } });
    const candidates = r.candidates.map((c) => ({ title: c.title, from: c.fromMonthKey, to: c.toMonthKey }));
    if (!r.candidates.length) return { ok: true, message: "Nothing to carry — no past month has a scripted topic that was not filmed.", candidates };
    if (dryRun) return { ok: true, message: `${r.candidates.length} would carry into ${r.candidates[0].toMonthKey}: ${r.candidates.map((c) => `“${c.title}” (${c.fromMonthKey})`).join(", ")}.`, candidates };
    revalidatePath("/content");
    return { ok: true, message: `${r.carried} carried into ${r.candidates[0].toMonthKey}${r.skipped.length ? ` · ${r.skipped.length} left where they were (${r.skipped.map((x) => x.why).join("; ")})` : ""}. Each keeps its script and every version; the client can swap it.`, candidates };
  } catch (e) { return fail(e); }
}

/**
 * The follow-up for answers that stop short of a script (CP-08): the questions
 * still open, and a link that opens them directly. For a person to paste into
 * their own message — this sends nothing, so it works with every switch off.
 */
export async function answerFollowUpLinkAction(interviewId: string): Promise<Result & { url?: string; body?: string }> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const [{ answerGapFollowUp }, { resolvePortalLink }] = await Promise.all([import("@/lib/programDeskTasks"), import("@/lib/programReminders")]);
    const gap = await answerGapFollowUp(interviewId);
    if (!gap) return { ok: false, message: "Their answers are already enough for a script — nothing to follow up." };
    const iv = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { enrollmentId: true } });
    const e = iv ? await prisma.contentEnrollment.findUnique({ where: { id: iv.enrollmentId }, select: { id: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true } }) : null;
    if (!e) return { ok: false, message: "Enrollment not found." };
    const seat = await prisma.clientMembership.findFirst({ where: { enrollmentId: e.id, revokedAt: null, role: "OWNER" }, orderBy: { invitedAt: "asc" }, select: { id: true, clientUserId: true } });
    // The enrollment's own page link first: it lasts, and a text Kyle sends this
    // afternoon must still open tonight. A one-time sign-in link (15 minutes,
    // and minting it voids the one they hold) only when there is no page link.
    const now = new Date();
    const link = (await resolvePortalLink(e, null, me.id, now, { path: gap.path }))
      ?? (seat ? await resolvePortalLink(e, { membershipId: seat.id, clientUserId: seat.clientUserId }, me.id, now, { path: gap.path }) : null);
    if (!link) return { ok: false, message: "No portal link exists for this client yet (no seat, no token)." };
    const body = [
      `Quick one on "${gap.topicTitle}" so we can write it:`,
      ...gap.questions.map((q) => `- ${q}`),
      "",
      `Answer here: ${link.url}`,
    ].join("\n");
    return { ok: true, message: link.kind === "login" ? "Copied — a one-time sign-in link (good for 15 minutes); send it now." : "Copied — the questions and the link.", url: link.url, body };
  } catch (e) { return fail(e); }
}

// ---- interview ---------------------------------------------------------------------------
/**
 * Oct 15 2026: "Written answers" on one topic of a month (the client answers
 * it on her portal and its script waits for those answers), and its Undo
 * ("I need a way to undo that change"). On a month planned on a call the Undo
 * puts the topic back on the call; otherwise it takes the questions back.
 */
export async function setTopicAnswerRouteAction(topicId: string, monthId: string, route: "CALL" | "WRITTEN"): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const lib = await import("@/lib/contentInterview");
    if (route === "WRITTEN") {
      await lib.setTopicAnswerRoute(topicId, monthId, "WRITTEN", { staffUserId: me.email });
      revalidatePath("/content");
      return { ok: true, message: "Open for written answers on the client's portal. Its script waits for them." };
    }
    const facts = await import("@/lib/planningFacts").then((m) => m.planningForMonth(monthId)).catch(() => null);
    if (facts?.route === "CALL") {
      const r = await lib.setTopicAnswerRoute(topicId, monthId, "CALL", { staffUserId: me.email });
      revalidatePath("/content");
      return { ok: true, message: r.withdrawn === "set-aside" ? "Undone: back to the call. What the client already wrote is kept." : "Undone: back to the call, scripted from it." };
    }
    const w = await lib.withdrawInterview(topicId, monthId);
    await prisma.contentTopicSelection.updateMany({ where: { topicId, monthId }, data: { answerRoute: null } });
    revalidatePath("/content");
    return { ok: true, message: w === "set-aside" ? "Undone. What the client already wrote is kept." : "Undone." };
  } catch (e) { return fail(e); }
}

export async function answerInterview(interviewId: string, questionKey: string, text: string, kind: "TYPED" | "SKIPPED" | "DONT_KNOW", questionText?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { answerQuestion } = await import("@/lib/contentInterview");
    const r = await answerQuestion(interviewId, questionKey, { text, kind, actor: { staffUserId: me.email }, questionText });
    revalidatePath("/content");
    return { ok: true, message: r.version > 1 ? `Saved as answer version ${r.version} (earlier versions kept).` : "Saved." };
  } catch (e) { return fail(e); }
}

/**
 * Phrase the six planning questions for THIS topic (F10) — the same work the
 * sweep does before a client opens them, on demand.
 */
export async function planInterviewQuestionsAction(interviewId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { planInterviewQuestions } = await import("@/lib/contentGeneration");
    const r = await planInterviewQuestions(interviewId, { requestedBy: me.email, unattended: false });
    revalidatePath("/content");
    return { ok: true, message: `${r.questions} question${r.questions === 1 ? "" : "s"} rewritten for this topic${r.followUps ? ` (+${r.followUps} follow-ups)` : ""}. Anything the model left thin keeps the house wording.` };
  } catch (e) { return fail(e); }
}

export async function draftScriptFromInterview(interviewId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { submitInterview } = await import("@/lib/contentInterview");
    await submitInterview(interviewId, { staffUserId: me.email }).catch(() => {}); // a draft can be made mid-way; gaps say what's missing
    const { generateScriptFromInterview } = await import("@/lib/contentGeneration");
    const r = await generateScriptFromInterview(interviewId, me.email);
    revalidatePath("/content");
    return { ok: true, message: `Draft ready — ${r.ok ? "passes the format check" : "has format findings"}, ${r.gaps} gap${r.gaps === 1 ? "" : "s"} listed for you (never filled in).` };
  } catch (e) { return fail(e); }
}

// ---- scripts ---------------------------------------------------------------------------------
/**
 * Draft every script this month owes that HAS the evidence to be drafted
 * (F07/F08). The same work the hourly sweep does when `script_drafting` is on,
 * on demand and attributed to the person who pressed it.
 *
 * `includeThin` is the explicit "draft it from the topic line and the strategy
 * alone" — never the default, and never what the unattended sweep does.
 */
export async function draftOwedScriptsAction(monthId: string, includeThin = false): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { draftOwedScriptsForMonth } = await import("@/lib/contentDrafting");
    const r = await draftOwedScriptsForMonth(monthId, { requestedBy: me.email, unattended: false, includeThin });
    revalidatePath("/content");
    if (!r.drafted && !r.failed && !r.skipped) return { ok: true, message: includeThin ? "Nothing left to draft." : "Nothing is ready to draft — the rest are waiting on answers, on reconciling, or have no evidence yet." };
    const parts = [`${r.drafted} drafted`];
    if (r.skipped) parts.push(`${r.skipped} already being drafted`);
    if (r.failed) parts.push(`${r.failed} failed (${r.outcomes.find((o) => o.result === "failed")?.note ?? "see the run log"})`);
    return { ok: true, message: `${parts.join(" · ")}. They are on the Scripts tab for your review — nothing is approved or shared.` };
  } catch (e) { return fail(e); }
}

export async function generateScriptForTopicAction(topicId: string, monthId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { generateScriptForTopic } = await import("@/lib/contentGeneration");
    const r = await generateScriptForTopic({ topicId, monthId, requestedBy: me.email, unattended: false });
    revalidatePath("/content");
    return { ok: true, message: `Drafted as v${r.versionNo} — ${r.ok ? "passes the format check" : `${r.findings} format finding${r.findings === 1 ? "" : "s"}`}, ${r.gaps} gap${r.gaps === 1 ? "" : "s"} listed (never filled in). Review it on the Scripts tab.` };
  } catch (e) { return fail(e); }
}

// ---- the AI queue: every slow AI button answers at once (Oct 12 2026) -------------------
//
// Jordan: "When I click Draft Script on a video topic, I want a message to pop
// up to confirm it's been sent for scripting … I want it done in the
// background so I can continue clicking Draft Script for all of the other
// topics." Each action below validates, writes ONE queued ProgramAiRun (the
// durable "drafting" marker, holding the generator's own dedupe key) and
// answers; a worker in after() does the AI (aiQueue.ts: at most three at once,
// the rest wait QUEUED, stranded ones come back). The synchronous actions above
// stay for callers that want the result in hand (scripts, journeys, a tab on an
// old bundle). Owner or admin, exactly like the buttons they replace.
// ------------------------------------------------------------------------------------------

type QueueResult = Result & { runId?: string };

/** Start a worker after the response — or, outside a request (a script, a drill), now. */
function kickQueue(origin: string): void {
  const work = async () => {
    const { drainAiQueue } = await import("@/lib/aiQueue");
    await drainAiQueue({ origin }).catch((e) => console.error("[aiQueue] worker failed:", e));
  };
  try { after(work); } catch { void work(); }
}

/** One topic's draft, checked and queued. Shared by "Draft script" and its "Try again". */
async function queueTopicDraft(topicId: string, monthId: string, by: string): Promise<QueueResult> {
  const [topic, month] = await Promise.all([
    prisma.contentTopic.findUnique({ where: { id: String(topicId ?? "") }, select: { id: true, title: true, enrollmentId: true, monthId: true } }),
    prisma.contentMonth.findUnique({ where: { id: String(monthId ?? "") }, select: { id: true, enrollmentId: true, clientId: true, historical: true } }),
  ]);
  if (!topic) return { ok: false, message: "That topic no longer exists." };
  if (!month || month.enrollmentId !== topic.enrollmentId) return { ok: false, message: "That month isn't this client's — reload the page." };
  if (month.historical) return { ok: false, message: "That month is imported history — nothing is drafted for it." };
  const onMonth = topic.monthId === month.id
    || !!(await prisma.contentTopicSelection.findFirst({ where: { topicId: topic.id, monthId: month.id, status: { in: ["SELECTED", "RECONCILED", "CARRIED"] } }, select: { id: true } }));
  if (!onMonth) return { ok: false, message: `“${topic.title}” isn't on this month's plan any more — reload the page.` };
  if (await prisma.contentScript.findFirst({ where: { topicId: topic.id, monthId: month.id, historical: false }, select: { id: true } })) {
    return { ok: false, message: `“${topic.title}” already has a script — it's on the Scripts tab.` };
  }
  const { assertWeWriteFor } = await import("@/lib/programStyle");
  await assertWeWriteFor(topic.enrollmentId);
  const { enqueueAiJob, settleStaleRuns } = await import("@/lib/aiQueue");
  await settleStaleRuns();
  // The same topic through its written answers (or a sweep's run) counts as already drafting.
  const viaAnswers = await prisma.programAiRun.findFirst({ where: { status: { in: ["QUEUED", "RUNNING"] }, scopeJson: { contains: `"topicId":"${topic.id}"` }, AND: [{ scopeJson: { contains: `"monthId":"${month.id}"` } }] }, select: { id: true } });
  if (viaAnswers) return { ok: false, message: "That topic is already being drafted — it'll appear on the Scripts tab when it's ready.", runId: viaAnswers.id };
  const q = await enqueueAiJob({ job: { job: "script_topic", topicId: topic.id, monthId: month.id }, enrollmentId: topic.enrollmentId, clientId: month.clientId, requestedBy: by, title: topic.title });
  if (!q.ok) return { ok: false, message: q.message, runId: q.runId ?? undefined };
  return { ok: true, message: `Sent for scripting — ${topic.title}. It'll appear on the Scripts tab when it's ready.`, runId: q.runId };
}

/** "Draft script" on one topic of the month: queued, answered at once. */
export async function queueScriptDraftAction(topicId: string, monthId: string): Promise<QueueResult> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const r = await queueTopicDraft(topicId, monthId, me.email);
    if (r.ok) { kickQueue("click"); revalidatePath("/content"); }
    return r;
  } catch (e) { return fail(e); }
}

/**
 * "Draft what's ready" / "Draft from the topic alone" (Scripts tab): every
 * owed topic the old button would have drafted, queued one by one — the
 * client's answers through the written-answer path, call excerpts and the
 * topic line through the topic path — never one with a script already.
 */
export async function queueOwedScriptsAction(monthId: string, includeThin = false): Promise<QueueResult & { queued?: number; already?: number }> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const month = await prisma.contentMonth.findUnique({ where: { id: String(monthId ?? "") }, select: { id: true, enrollmentId: true, clientId: true, historical: true } });
    if (!month || month.historical) return { ok: false, message: "That month can't be drafted — reload the page." };
    const { assertWeWriteFor } = await import("@/lib/programStyle");
    await assertWeWriteFor(month.enrollmentId);
    const { scriptWorkForMonth, isAutoDraftable } = await import("@/lib/contentDrafting");
    const work = await scriptWorkForMonth(month.id);
    const todo = work.filter((w) => (includeThin ? w.readiness === "THIN" || w.readiness === "THIN_ANSWERS" || isAutoDraftable(w.readiness) : isAutoDraftable(w.readiness))).slice(0, 20);
    if (!todo.length) return { ok: true, message: includeThin ? "Nothing left to draft." : "Nothing is ready to draft — the rest are waiting on answers, on reconciling, or have no evidence yet.", queued: 0, already: 0 };
    const { enqueueAiJob } = await import("@/lib/aiQueue");
    let queued = 0, already = 0;
    let refused: string | null = null;
    for (const w of todo) {
      const job = (w.readiness === "FROM_ANSWERS" || w.readiness === "THIN_ANSWERS") && w.interviewId
        ? { job: "script_interview" as const, topicId: w.topicId, monthId: w.monthId, interviewId: w.interviewId }
        : { job: "script_topic" as const, topicId: w.topicId, monthId: w.monthId, callRecordId: w.callRecordId, selectedOnCall: w.readiness === "FROM_CALL" };
      const q = await enqueueAiJob({ job, enrollmentId: month.enrollmentId, clientId: month.clientId, requestedBy: me.email, title: w.title });
      if (q.ok) queued++;
      else if (q.runId) already++;
      else { refused = q.message; break; } // a quota: every later one would refuse the same way
    }
    if (queued) {
      // One worker per job up to the cap, so "Draft what's ready (4)" runs three
      // at once rather than one after another inside a single worker's budget.
      const { QUEUE_CONCURRENCY } = await import("@/lib/aiQueue");
      for (let i = 0; i < Math.min(queued, QUEUE_CONCURRENCY); i++) kickQueue("click");
      revalidatePath("/content");
    }
    const parts: string[] = [];
    if (queued) parts.push(`Sent ${queued} for scripting`);
    if (already) parts.push(`${already} already being drafted`);
    if (refused) parts.push(`stopped: ${refused}`);
    return { ok: queued > 0 || already > 0, message: `${parts.join(" · ")}.${queued ? " Each one appears below as it's ready — nothing is approved or shared." : ""}`, queued, already };
  } catch (e) { return fail(e); }
}

/** "Ask AI to revise" (instructions) or "Tighten" (instruction built from the current version's estimate): queued; the current version is kept. */
export async function queueScriptRevisionAction(scriptId: string, mode: "revise" | "tighten", instructions = "", lockSections: string[] = []): Promise<QueueResult> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const s = await prisma.contentScript.findUnique({ where: { id: String(scriptId ?? "") }, select: { id: true, title: true, historical: true, enrollmentId: true, clientId: true } });
    if (!s) return { ok: false, message: "That script no longer exists." };
    if (s.historical) return { ok: false, message: "This is an imported historical script — it is not rewritten. Draft a new script for the topic instead." };
    let instruction: string;
    let sent: string;
    if (mode === "tighten") {
      const plan = await tightenPlan(s.id);
      if (!plan.ok) return plan;
      instruction = plan.instruction;
      sent = `Sent to be tightened from ≈${plan.seconds} s toward ${plan.lo}–${plan.hi} s — v${plan.versionNo} is kept. The new version appears here when it's ready.`;
    } else {
      instruction = String(instructions ?? "").trim().slice(0, 2000);
      if (!instruction) return { ok: false, message: "Tell the AI what to change first." };
      sent = "Sent for revision — the new version appears here when it's ready; the current one is kept.";
    }
    const { enqueueAiJob } = await import("@/lib/aiQueue");
    // Oct 14 2026: "Keep exactly: Hook / Re-hook / …", only on a revision (a tighten rewrites for length).
    const { asLockSections } = await import("@/lib/contentPolicy");
    const locks = mode === "revise" ? asLockSections(lockSections) : [];
    const q = await enqueueAiJob({ job: { job: "script_revise", scriptId: s.id, instruction, label: mode, ...(locks.length ? { lockSections: locks } : {}) }, enrollmentId: s.enrollmentId, clientId: s.clientId, requestedBy: me.email, title: s.title });
    if (!q.ok) return { ok: false, message: q.message, runId: q.runId ?? undefined };
    kickQueue("click");
    revalidatePath("/content");
    return { ok: true, message: sent, runId: q.runId };
  } catch (e) { return fail(e); }
}

/** "Draft from the discovery call": every check the draft makes, at once; the AI in the background. STRATEGY duty owner only, as before. */
export async function queueStrategyDraftAction(enrollmentId: string): Promise<QueueResult> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await assertDutyOwner("STRATEGY", enrollmentId, null, me);
    const { strategyDraftInputs } = await import("@/lib/programOnboarding");
    const inputs = await strategyDraftInputs(enrollmentId);
    const { enqueueAiJob } = await import("@/lib/aiQueue");
    const q = await enqueueAiJob({ job: { job: "strategy_draft", callRecordId: inputs.call.id }, enrollmentId, clientId: inputs.call.clientId, requestedBy: me.email, title: "Strategy from the discovery call" });
    if (!q.ok) return { ok: false, message: q.message, runId: q.runId ?? undefined };
    kickQueue("click");
    path(enrollmentId);
    const early = inputs.analysed ? "" : " The call's analysis hasn't run yet, so only lines marked or said in confidence are held back — read the draft with that in mind.";
    return { ok: true, message: `Sent for drafting — the strategy from the discovery call appears under Strategy versions when it's ready (a minute or two).${early}`, runId: q.runId };
  } catch (e) { return fail(e); }
}

/** "Try again" on a queued job that failed: the same request, checked again and queued again. */
export async function retryAiJobAction(runId: string): Promise<QueueResult> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { queuedJobOf, enqueueAiJob } = await import("@/lib/aiQueue");
    const prev = await queuedJobOf(String(runId ?? ""));
    if (!prev || !prev.enrollmentId || !prev.clientId) return { ok: false, message: "That job isn't on file any more — reload the page." };
    const j = prev.job;
    let r: QueueResult;
    if (j.job === "script_topic") r = await queueTopicDraft(j.topicId, j.monthId, me.email);
    else if (j.job === "strategy_draft") return queueStrategyDraftAction(prev.enrollmentId);
    else if (j.job === "script_revise") return queueScriptRevisionAction(j.scriptId, j.label === "tighten" ? "tighten" : "revise", j.instruction, j.lockSections ?? []);
    else {
      if (await prisma.contentScript.findFirst({ where: { topicId: j.topicId, monthId: j.monthId, historical: false }, select: { id: true } })) return { ok: false, message: "It already has a script — it's on the Scripts tab." };
      const q = await enqueueAiJob({ job: j, enrollmentId: prev.enrollmentId, clientId: prev.clientId, requestedBy: me.email, title: prev.title });
      r = q.ok ? { ok: true, message: `Sent for scripting — ${prev.title ?? "the topic"}. It'll appear on the Scripts tab when it's ready.`, runId: q.runId } : { ok: false, message: q.message, runId: q.runId ?? undefined };
    }
    if (r.ok) { kickQueue("click"); revalidatePath("/content"); }
    return r;
  } catch (e) { return fail(e); }
}

/**
 * What the page polls while anything is drafting: the run ids still queued
 * or running for this client. It also restarts the queue when work is
 * waiting and a slot is free — a worker killed mid-draft (after()'s ceiling, a
 * deploy) is picked up the next time someone has the page open.
 */
export async function aiQueueStatusAction(enrollmentId: string): Promise<Result & { active?: string[] }> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { activeQueueRuns, queueWantsWorker, recoverStaleQueuedRuns } = await import("@/lib/aiQueue");
    await recoverStaleQueuedRuns();
    if (await queueWantsWorker()) kickQueue("poll");
    const active = await activeQueueRuns(String(enrollmentId ?? ""));
    return { ok: true, message: `${active.length} in progress`, active };
  } catch (e) { return fail(e); }
}

export async function approveScriptVersionAction(versionId: string, note?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentScriptVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true, scriptId: true } });
    if (!v) return { ok: false, message: "Version not found." };
    const s = await prisma.contentScript.findUnique({ where: { id: v.scriptId }, select: { monthId: true } });
    const me = await actor();
    await assertDutyOwner("SCRIPTS", v.enrollmentId, s?.monthId ?? null, me);
    const { approveScriptVersion } = await import("@/lib/contentScripts");
    const r = await approveScriptVersion(versionId, { email: me.email, appUserId: me.id }, note?.trim() || null);
    path(v.enrollmentId);
    return { ok: true, message: r.alreadyApproved ? "Already approved — nothing changed." : "Approved under your name. Release it when the client should see it." };
  } catch (e) { return fail(e); }
}

/**
 * ONE CANONICAL SHARE (audit finding 2, Sep 17).
 *
 * This called releaseScriptVersion directly. That writes notificationState
 * QUEUED on the ledger and nothing else — the ProgramReminder notice the sender
 * actually drains is created by scriptShare.shareApprovedScript, which had no
 * caller outside its own batch wrapper. So with the email switch ON, this
 * button would have said "the email is queued" over a queue with nothing in it,
 * for ever: drainShareNotices drains notices, and an orphaned ledger row is not
 * a notice.
 *
 * It never lied in production — the switch has been off since the feature
 * landed, so every release so far recorded SUPPRESSED and said so, and there
 * are no orphaned QUEUED rows to reconcile (checked Sep 17). It would have lied
 * the day Jordan turned the switch on, which is the wrong day to find out.
 *
 * The button now runs the same operation the batch does. It is idempotent —
 * approve once, release once, queue once — and it reports what that operation
 * actually did rather than what this action assumed. The switch stays off:
 * nothing here authorises a client email.
 */
export async function releaseScriptAction(scriptId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { enrollmentId: true, monthId: true, approvedVersionId: true } });
    if (!s) return { ok: false, message: "Script not found." };
    if (!s.approvedVersionId) return { ok: false, message: "Approve a version first." };
    const me = await actor();
    await assertDutyOwner("SCRIPTS", s.enrollmentId, s.monthId, me);
    const { shareApprovedScript } = await import("@/lib/scriptShare");
    const r = await shareApprovedScript(s.approvedVersionId, { email: me.email, appUserId: me.id });
    path(s.enrollmentId);
    return { ok: true, message: r.message };
  } catch (e) { return fail(e); }
}

export async function returnScriptAction(scriptId: string, note: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { enrollmentId: true } });
    if (!s) return { ok: false, message: "Script not found." };
    const me = await actor();
    const { returnScriptToQueue } = await import("@/lib/contentScripts");
    await returnScriptToQueue(scriptId, { email: me.email, appUserId: me.id }, note || null);
    path(s.enrollmentId);
    return { ok: true, message: "Back in the review queue." };
  } catch (e) { return fail(e); }
}

export async function saveScriptParts(scriptId: string, parts: VersionParts): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { editScriptVersion } = await import("@/lib/contentScripts");
    const r = await editScriptVersion(scriptId, parts, me.email);
    revalidatePath("/content");
    return { ok: true, message: `Saved as version ${r.versionNo} — nothing overwritten.` };
  } catch (e) { return fail(e); }
}

// ---- client facts ---------------------------------------------------------------------------
export async function factDecision(factId: string, decision: "ACCEPT" | "REJECT" | "UNDO", opts: { scope?: FactScope; monthId?: string | null; projectId?: string | null; category?: FactCategory } = {}): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const lib = await import("@/lib/clientFacts");
    const f = await prisma.clientFact.findUnique({ where: { id: factId }, select: { enrollmentId: true } });
    if (decision === "ACCEPT") await lib.acceptFact(factId, me.email, opts);
    else if (decision === "REJECT") await lib.rejectFact(factId, me.email);
    else await lib.undoFactReview(factId, me.email);
    if (f?.enrollmentId) { const { invalidatePortalPrefill } = await import("@/lib/portalPrefill"); await invalidatePortalPrefill(f.enrollmentId); }
    revalidatePath("/content");
    // CP-11: say what accepting actually does. It REMEMBERS the fact (prompts
    // read it; a production preference is also on the editor brief since the
    // brief reads accepted facts); it never changes the client's profile — a
    // proposed change is applied separately, by a person.
    let accepted = "Remembered — generation uses it from now on. It doesn't change their profile; a proposed change is applied separately.";
    if (decision === "ACCEPT") {
      const now = await prisma.clientFact.findUnique({ where: { id: factId }, select: { category: true, scope: true } });
      if (now?.category === "PRODUCTION_PREFERENCE" || now?.scope === "PROJECT") accepted = "Remembered — generation uses it, and it's on the editor brief. It doesn't change their profile; a proposed change is applied separately.";
    }
    return { ok: true, message: decision === "ACCEPT" ? accepted : decision === "REJECT" ? "Rejected (kept as history)." : "Undone — back to needs-review, out of every prompt." };
  } catch (e) { return fail(e); }
}

/**
 * CP-11: APPLY a proposed profile change from a call — the separate, human act
 * (Jordan or Kyle: these are operational editor preferences, not the
 * strategy). `value` lets the person correct the proposed wording; `note` is
 * kept on the proposal. Refused on drift, on anything confidential, and on a
 * proposal already handled; applying also remembers the fact.
 */
export async function applyFieldProposalAction(proposalId: string, value?: string | null, note?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { applyFieldProposal } = await import("@/lib/profileFields");
    const r = await applyFieldProposal(String(proposalId ?? ""), { email: me.email, appUserId: me.id }, { value: typeof value === "string" ? value : null, note: typeof note === "string" ? note : null });
    revalidatePath("/content");
    return { ok: r.ok, message: r.message };
  } catch (e) { return fail(e); }
}

/** CP-11: IGNORE a proposed profile change — the profile is untouched. */
export async function ignoreFieldProposalAction(proposalId: string, note?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { ignoreFieldProposal } = await import("@/lib/profileFields");
    const r = await ignoreFieldProposal(String(proposalId ?? ""), me.email, typeof note === "string" ? note : null);
    revalidatePath("/content");
    return r;
  } catch (e) { return fail(e); }
}

/**
 * "Said in confidence" (A09, Sep 25 2026): mark a fact confidential after the
 * fact. It leaves every prompt, the call line it came from stops reaching
 * scripts and suggested answers, open proposals made from it are rejected, and
 * the portal's prefilled answers are rebuilt without it.
 */
export async function factConfidential(factId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { markFactConfidential } = await import("@/lib/clientFacts");
    const r = await markFactConfidential(String(factId ?? ""), me.email);
    revalidatePath("/content");
    if (r.alreadyConfidential) return { ok: true, message: "Already confidential — it stays out of every prompt and the client's pages." };
    return { ok: true, message: `Marked confidential — it's out of every prompt and the client's suggested answers now${r.proposalsRejected ? `, and ${r.proposalsRejected} proposal${r.proposalsRejected === 1 ? "" : "s"} made from it ${r.proposalsRejected === 1 ? "was" : "were"} rejected` : ""}.` };
  } catch (e) { return fail(e); }
}

export async function setFactScopeAction(factId: string, scope: FactScope, monthId?: string | null, projectId?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { setFactScope } = await import("@/lib/clientFacts");
    await setFactScope(factId, scope, { monthId, projectId });
    revalidatePath("/content");
    return { ok: true, message: `Scope: ${scope.toLowerCase()}.` };
  } catch (e) { return fail(e); }
}

export async function addFact(clientId: string, body: string, category: FactCategory, confidential: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!body.trim()) return { ok: false, message: "Write the fact first." };
  try {
    const me = await actor();
    const e = await prisma.contentEnrollment.findUnique({ where: { clientId }, select: { id: true } });
    const { createFact, acceptFact } = await import("@/lib/clientFacts");
    const r = await createFact({ clientId, enrollmentId: e?.id ?? null, category, body, source: "staff", sourceRef: me.email, factDate: new Date(), confidential });
    if (r.existed) return { ok: false, message: "That fact is already on file." };
    // A staff-typed fact is accepted by the person who typed it — still undoable.
    await acceptFact(r.id, me.email);
    revalidatePath("/content");
    return { ok: true, message: confidential ? "Saved as confidential — never AI context." : "Saved and accepted." };
  } catch (e) { return fail(e); }
}

// ---- imports ------------------------------------------------------------------------------------
export async function previewImportUpload(enrollmentId: string, kind: ImportKind, form: FormData): Promise<{ ok: true; preview: ImportPreview; message: string } | { ok: false; message: string }> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "No access." }; }
  const ex = await extractUploadText(form);
  if (!ex.ok) return ex;
  try {
    const { previewImport } = await import("@/lib/contentImport");
    const preview = await previewImport({ kind, enrollmentId, fileName: ex.name, text: ex.text });
    const c = preview.counts;
    return { ok: true, preview, message: `${preview.items.length} item${preview.items.length === 1 ? "" : "s"}: ${c.CREATE} new · ${c.LINK} already on file · ${c.UPDATE_PROPOSAL} update proposal${c.UPDATE_PROPOSAL === 1 ? "" : "s"} · ${c.SKIP} skipped${preview.existingBatchId ? " · this exact file was imported before (re-opening that batch)" : ""}` };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Could not read the document." }; }
}

export async function applyImportAction(preview: ImportPreview, decisions: { monthKey: string | null; modes: Record<number, ItemMode>; pillarMap?: Record<string, string | null> }): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { applyImport } = await import("@/lib/contentImport");
    const r = await applyImport(preview, decisions, me.email);
    path(preview.enrollmentId);
    return { ok: true, message: `${r.created} created · ${r.linked} linked · ${r.updated} update proposal${r.updated === 1 ? "" : "s"} · ${r.skipped} skipped${r.conflicts ? ` · ${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"} (see review items)` : ""}. Imported records are history — nothing was approved, filmed or released.` };
  } catch (e) { return fail(e); }
}

// ---- one-time lifts (owner) ---------------------------------------------------------------------
export async function runProgramMigrations(): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const [{ migrateLegacyStrategies, repairStrategyIdentities }, { markHistoricalImports, backfillScriptVersions }, { migrateContentNotesToFacts }] = await Promise.all([import("@/lib/contentStrategy"), import("@/lib/contentScripts"), import("@/lib/clientFacts")]);
    const a = await migrateLegacyStrategies();
    const a2 = await repairStrategyIdentities();
    const b = await markHistoricalImports();
    const c = await backfillScriptVersions();
    const d = await migrateContentNotesToFacts();
    revalidatePath("/content");
    return { ok: true, message: `Strategies → v1: ${a.migrated} (${a.skipped} already)${a2.repaired ? ` · identity rows repaired: ${a2.repaired}` : ""} · imports marked historical: ${b.stamped} of ${b.total} · script versions lifted: ${c.created} · notes → facts: ${d.created} created, ${d.skipped} already, ${d.confidential} confidential locked, ${d.monthScoped} month-scoped.` };
  } catch (e) { return fail(e); }
}

// ---------------------------------------------------------------------------
// CLIENT REVIEW WINDOWS + REVISION ROUNDS (CP-02, Sep 24 2026) — the office's
// controls on the client's Content tab. OWNER/ADMIN only: the fee lives here
// and on Kyle's card, never on an editor surface. Nothing here bills anyone.
// Each has a plain form variant (the library panel is a server component).
// ---------------------------------------------------------------------------

export async function decideRevisionFeeAction(roundId: string, decision: "CHARGE" | "WAIVE", note?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  try {
    const me = await actor();
    const { decideRevisionFee } = await import("@/lib/reviewWindows");
    const r = await decideRevisionFee(roundId, decision, me.name ?? me.email, note ?? null);
    const round = await prisma.contentRevisionRound.findUnique({ where: { id: roundId }, select: { enrollmentId: true } });
    if (round) path(round.enrollmentId);
    return { ...r, outcome: r.outcome ?? (r.ok ? "confirmed" : "refused") };
  } catch (e) { return { ...fail(e), outcome: "unknown" }; }
}

export async function restartReviewClockAction(windowId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  try {
    const me = await actor();
    const { restartReviewClock } = await import("@/lib/reviewWindows");
    const r = await restartReviewClock(windowId, me.name ?? me.email);
    const w = await prisma.contentReviewWindow.findUnique({ where: { id: windowId }, select: { enrollmentId: true } });
    if (w) path(w.enrollmentId);
    return { ...r, outcome: r.ok ? "confirmed" : "refused" };
  } catch (e) { return { ...fail(e), outcome: "unknown" }; }
}

export async function holdReviewWindowAction(windowId: string, hold: boolean, reason?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return { ...fail(e), outcome: "refused" }; }
  try {
    const me = await actor();
    const { holdReviewWindow, releaseReviewHold } = await import("@/lib/reviewWindows");
    const r = hold ? await holdReviewWindow(windowId, me.name ?? me.email, reason ?? "") : await releaseReviewHold(windowId);
    const w = await prisma.contentReviewWindow.findUnique({ where: { id: windowId }, select: { enrollmentId: true } });
    if (w) path(w.enrollmentId);
    return { ...r, outcome: r.ok ? "confirmed" : "refused" };
  } catch (e) { return { ...fail(e), outcome: "unknown" }; }
}

/** Form variants: <form action={…}> with hidden inputs. */
export async function decideRevisionFeeForm(formData: FormData): Promise<void> {
  const d = String(formData.get("decision") ?? "");
  await decideRevisionFeeAction(String(formData.get("roundId") ?? ""), d === "CHARGE" ? "CHARGE" : "WAIVE", String(formData.get("note") ?? "") || undefined);
}
export async function restartReviewClockForm(formData: FormData): Promise<void> {
  await restartReviewClockAction(String(formData.get("windowId") ?? ""));
}
export async function holdReviewWindowForm(formData: FormData): Promise<void> {
  const hold = String(formData.get("hold") ?? "") === "1";
  await holdReviewWindowAction(String(formData.get("windowId") ?? ""), hold, String(formData.get("reason") ?? "") || (hold ? "Held from the Content tab" : undefined));
}

// ===========================================================================
// BULK PLANS (Oct 15 2026) — Jordan: "I want the system set up for like a bulk
// option which allows us to turn it on for rick, or other clients in the
// future ... Make this an easy process for rick and I so I can have all his
// content planned in bulk." The rules live in src/lib/bulkPlan.ts; these are
// the owner/admin doors to them. Nothing here messages the client.
// ===========================================================================

async function bulkActor() {
  const me = await actor();
  return { email: me.email, appUserId: me.id, name: me.name };
}

export async function createBulkPlanAction(input: { enrollmentId: string; totalVideos: number; perSession: number; sessionsPlanned?: number | null; cadenceDays?: number | null; startsOn?: string | null; monthKey?: string | null; title?: string | null; editingNote?: string | null }): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { createBulkPlan } = await import("@/lib/bulkPlan");
    const startsOn = input.startsOn && /^\d{4}-\d{2}-\d{2}$/.test(input.startsOn) ? new Date(`${input.startsOn}T12:00:00-05:00`) : null;
    await createBulkPlan({ ...input, startsOn }, await bulkActor());
    revalidatePath("/content");
    return { ok: true, message: `Bulk plan on. ${input.totalVideos} videos, ${input.perSession} a session. Add the scripts next.` };
  } catch (e) { return fail(e); }
}

export async function updateBulkPlanAction(planId: string, patch: { perSession?: number; sessionsPlanned?: number; cadenceDays?: number; startsOn?: string | null; editingNote?: string | null; title?: string | null; totalVideos?: number; status?: "ACTIVE" | "COMPLETE" | "CANCELLED" }): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { updateBulkPlan } = await import("@/lib/bulkPlan");
    const { startsOn, ...rest } = patch;
    await updateBulkPlan(planId, { ...rest, ...(startsOn !== undefined ? { startsOn: startsOn && /^\d{4}-\d{2}-\d{2}$/.test(startsOn) ? new Date(`${startsOn}T12:00:00-05:00`) : null } : {}) }, await bulkActor());
    revalidatePath("/content");
    return { ok: true, message: patch.status === "CANCELLED" ? "Plan cancelled." : patch.status === "COMPLETE" ? "Plan marked complete." : "Saved." };
  } catch (e) { return fail(e); }
}

/** Read a script bank (uploaded file or pasted text) without saving anything. */
export async function previewBulkScriptsAction(form: FormData): Promise<Result & { count?: number; titles?: string[]; problems?: string[]; note?: string | null }> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const text = await bankText(form);
    if (!text.ok) return { ok: false, message: text.message };
    const { parseScriptBank } = await import("@/lib/bulkScriptBank");
    const r = parseScriptBank(text.text);
    return { ok: r.scripts.length > 0, message: r.scripts.length ? `Found ${r.scripts.length} script${r.scripts.length === 1 ? "" : "s"}${r.problems.length ? `, ${r.problems.length} thing${r.problems.length === 1 ? "" : "s"} to check` : ""}.` : r.problems[0] ?? "No scripts found.", count: r.scripts.length, titles: r.scripts.map((s) => `${s.n}. ${s.title}`), problems: r.problems, note: r.note };
  } catch (e) { return fail(e); }
}

async function bankText(form: FormData): Promise<{ ok: true; text: string; name: string } | { ok: false; message: string }> {
  const pasted = form.get("text");
  if (typeof pasted === "string" && pasted.trim()) return { ok: true, text: pasted, name: "Pasted scripts" };
  return extractUploadText(form);
}

/** Add the bank's scripts to the plan, in order; `release` puts them on the client's portal (no email). */
export async function importBulkScriptsAction(planId: string, form: FormData): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const text = await bankText(form);
    if (!text.ok) return { ok: false, message: text.message };
    const { parseScriptBank } = await import("@/lib/bulkScriptBank");
    const parsed = parseScriptBank(text.text);
    if (!parsed.scripts.length) return { ok: false, message: parsed.problems[0] ?? "No scripts found." };
    const lib = await import("@/lib/bulkPlan");
    const plan = await prisma.contentBulkPlan.findUnique({ where: { id: planId }, select: { editingNote: true, enrollmentId: true } });
    if (!plan) return { ok: false, message: "That plan isn't on file." };
    // The document's delivery note becomes the plan's editing note when it has none.
    if (parsed.note && !plan.editingNote) await lib.updateBulkPlan(planId, { editingNote: parsed.note }, await bulkActor());
    // A bank whose scripts are not the house's three points is the client's own format.
    if (parsed.scripts.some((s) => s.lines.length !== 3) && !(await lib.clientScriptFormat(plan.enrollmentId))) {
      await lib.setClientScriptFormat(plan.enrollmentId, "Hook, Beat, Payoff (the client's own script bank)", (await bulkActor()).email);
    }
    const release = form.get("release") === "1";
    const r = await lib.importBulkScripts(planId, parsed.scripts, await bulkActor(), { release, sourceFile: text.name });
    revalidatePath("/content");
    return {
      ok: true,
      message: [
        `Added ${r.created} script${r.created === 1 ? "" : "s"} to the plan, in order.`,
        release ? `${r.released} on the client's portal (no email went out).` : "They're in the review queue; release them when you're ready.",
        r.problems.length ? `Not released: ${r.problems.slice(0, 3).map((p) => `“${p.title}” (${p.why})`).join("; ")}${r.problems.length > 3 ? "…" : ""}` : "",
      ].filter(Boolean).join(" "),
    };
  } catch (e) { return fail(e); }
}

export async function releaseBulkScriptsAction(planId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { releaseBulkScripts } = await import("@/lib/bulkPlan");
    const r = await releaseBulkScripts(planId, null, await bulkActor(), null);
    revalidatePath("/content");
    return { ok: r.problems.length === 0, message: `${r.released} script${r.released === 1 ? "" : "s"} put on the client's portal (no email went out).${r.problems.length ? ` Not released: ${r.problems.slice(0, 3).map((p) => `“${p.title}” (${p.why})`).join("; ")}` : ""}` };
  } catch (e) { return fail(e); }
}

export async function undoBulkImportAction(batchId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { undoBulkImport } = await import("@/lib/bulkPlan");
    const r = await undoBulkImport(batchId, await bulkActor());
    revalidatePath("/content");
    return { ok: true, message: `Undone: ${r.removed} script${r.removed === 1 ? "" : "s"} taken off the plan.` };
  } catch (e) { return fail(e); }
}

export async function moveBulkScriptAction(planId: string, topicId: string, sessionNo: number): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { moveToSession } = await import("@/lib/bulkPlan");
    await moveToSession(planId, topicId, Math.trunc(Number(sessionNo)), await bulkActor());
    revalidatePath("/content");
    return { ok: true, message: `Moved to session ${sessionNo}.` };
  } catch (e) { return fail(e); }
}

export async function nudgeBulkScriptAction(planId: string, topicId: string, dir: "up" | "down"): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { nudgeOrder } = await import("@/lib/bulkPlan");
    await nudgeOrder(planId, topicId, dir === "up" ? "up" : "down");
    revalidatePath("/content");
    return { ok: true, message: "Moved." };
  } catch (e) { return fail(e); }
}

export async function rebalanceBulkAction(planId: string, perSession?: number | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { rebalanceRemaining } = await import("@/lib/bulkPlan");
    const r = await rebalanceRemaining(planId, await bulkActor(), { perSession: perSession ?? null });
    revalidatePath("/content");
    return { ok: true, message: r.moved ? `Spread the unfilmed scripts from session ${r.fromSession} on (${r.moved} moved).` : "Nothing needed moving." };
  } catch (e) { return fail(e); }
}

export async function setBulkShootSessionAction(projectId: string, sessionNo: number | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { setProjectSession } = await import("@/lib/bulkPlan");
    await setProjectSession(projectId, sessionNo == null ? null : Math.trunc(Number(sessionNo)), (await bulkActor()).email);
    revalidatePath("/content");
    return { ok: true, message: sessionNo == null ? "Back to date order." : `That shoot is session ${sessionNo}.` };
  } catch (e) { return fail(e); }
}

export async function setClientScriptFormatAction(enrollmentId: string, label: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { setClientScriptFormat } = await import("@/lib/bulkPlan");
    await setClientScriptFormat(enrollmentId, label, (await bulkActor()).email);
    revalidatePath("/content");
    return { ok: true, message: label ? "Saved: their scripts keep their own format." : "Back to the house format." };
  } catch (e) { return fail(e); }
}
