"use server";

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

type Result = { ok: boolean; message: string };

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
async function extractUploadText(form: FormData): Promise<{ ok: true; text: string; name: string } | { ok: false; message: string }> {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, message: "No file." };
  if (file.size > 15 * 1024 * 1024) return { ok: false, message: "File too large (max 15 MB)." };
  let text = "";
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    if (/\.pdf$/i.test(file.name)) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const r = await parser.getText();
        text = r.text ?? "";
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else if (/\.docx$/i.test(file.name)) {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (/\.(txt|md)$/i.test(file.name)) {
      text = buf.toString("utf-8");
    } else {
      return { ok: false, message: "Use a PDF, Word (.docx), or text file." };
    }
  } catch (e) {
    return { ok: false, message: `Couldn't read the file: ${e instanceof Error ? e.message : "unknown error"}` };
  }
  text = text.trim();
  if (!text) return { ok: false, message: "The file has no readable text." };
  return { ok: true, text, name: file.name };
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
    message: `${parsed.structureVersion === "unknown" ? "No numbered sections found — kept as one block" : `${parsed.structureVersion} structure · ${stored.sections.length} sections`} · ${v.pillarCount} pillar${v.pillarCount === 1 ? "" : "s"} · framework: ${v.frameworkSource}${v.missing.length ? ` · missing: ${v.missing.slice(0, 4).join(", ")}${v.missing.length > 4 ? "…" : ""}` : ""}`,
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
      message: `${r.callKind} call · ${r.confirmedTopics} topic${r.confirmedTopics === 1 ? "" : "s"} proposed for the month (confirm them on Video Topics)${decided ? ` · ${decided} already decided by a person, left as is` : ""} · ${r.futureIdeas} idea${r.futureIdeas === 1 ? "" : "s"} for the bank${r.rejected ? ` · ${r.rejected} declined on the call (confirm the rejection${r.rejected === 1 ? "" : "s"} on Video Topics)` : ""} · ${r.intelNotes} fact${r.intelNotes === 1 ? "" : "s"} to review${r.confidentialFacts ? ` (${r.confidentialFacts} confidential, locked)` : ""}${r.proposals ? ` · ${r.proposals} strategy proposal${r.proposals === 1 ? "" : "s"}` : ""}${g.generated ? ` · ${g.generated} script${g.generated === 1 ? "" : "s"} drafted for the topics already confirmed` : ""}.`,
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

export async function reviseScriptAI(scriptId: string, instructions: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!instructions.trim()) return { ok: false, message: "Tell the AI what to change first." };
  try {
    const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
    const me = await actor();
    await reviseScriptWithInstructions(scriptId, instructions, { requestedBy: me.email });
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
 * and the same approval gate; nothing here relaxes the 20–30 s target, which
 * has no override field anywhere in the policy layer. Both statuses sit in the
 * Scripts tab's review queue, so where it lands is unchanged; what was wrong
 * was the word, and a wrong word here is what somebody would go looking for in
 * the version trail.
 */
export async function tightenScriptAI(scriptId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
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
    // overrun, and told a 19-second draft it was "inside the 20–30 s target".
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
    const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
    const me = await actor();
    await reviseScriptWithInstructions(scriptId, instruction, { requestedBy: me.email });
    revalidatePath("/content");
    return { ok: true, message: `Sent back to be tightened from ≈${seconds} s (${words} words) toward ${lo}–${hi} s — v${v.versionNo} is kept. The new version is waiting in the review queue.` };
  } catch (e) { return fail(e); }
}

export async function saveScriptText(scriptId: string, body: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const text = body.trim().slice(0, 20_000);
  if (!text) return { ok: false, message: "The script can't be empty." };
  // A manual edit is a NEW version (never an overwrite): the previous version
  // — and the shared one, if the client already has it — stays intact.
  try {
    const { editScriptFromBody } = await import("@/lib/contentScripts");
    const me = await actor();
    const r = await editScriptFromBody(scriptId, text, me.email);
    revalidatePath("/content");
    return { ok: true, message: `Saved as version ${r.versionNo}.` };
  } catch (e) { return fail(e); }
}

// Pull Calendly bookings + Drive transcripts on demand (cron does both too).
export async function syncCallsNow(): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const { syncStrategyCallsFromCalendly, sweepNotetakerTranscripts, sweepDriveTranscripts } = await import("@/lib/contentCalls");
  const cal = await syncStrategyCallsFromCalendly().catch((e) => ({ skipped: e instanceof Error ? e.message : "failed" }));
  const nt = await sweepNotetakerTranscripts().catch((e) => ({ skipped: e instanceof Error ? e.message : "failed" }));
  const drv = await sweepDriveTranscripts().catch((e) => ({ skipped: e instanceof Error ? e.message : "failed" }));
  revalidatePath("/content");
  const calMsg = "skipped" in cal ? `Calendly: ${cal.skipped}` : `Calendly: ${cal.stamped} scheduled, ${cal.completed} completed${cal.canceled ? `, ${cal.canceled} canceled` : ""}`;
  const ntMsg = "skipped" in nt ? `Notetaker: ${nt.skipped}` : `Notetaker: ${nt.ingested} transcript${nt.ingested === 1 ? "" : "s"}`;
  const drvMsg = "skipped" in drv ? `Drive: ${drv.skipped}` : `Drive: ${drv.ingested} transcript${drv.ingested === 1 ? "" : "s"}`;
  return { ok: true, message: `${calMsg} · ${ntMsg} · ${drvMsg}.` };
}

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
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!/^\d{4}-\d{2}$/.test(targetMonthKey)) return { ok: false, message: "Pick a month." };
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, contentMonthId: true },
  });
  if (!project?.contentMonthId) return { ok: false, message: "That session isn't attached to a content month." };
  const from = await prisma.contentMonth.findUnique({
    where: { id: project.contentMonthId },
    select: { id: true, enrollmentId: true, monthKey: true },
  });
  if (!from) return { ok: false, message: "That session isn't attached to a content month." };
  if (from.monthKey === targetMonthKey) return { ok: true, message: "Already on that month." };
  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { id: from.enrollmentId },
    select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true },
  });
  if (!enrollment) return { ok: false, message: "Enrollment not found." };
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
  await prisma.portalVideo.updateMany({ where: { projectId }, data: { monthId: target.id } }).catch(() => {});
  revalidatePath(`/content/${enrollment.id}`);
  revalidatePath("/content");
  return { ok: true, message: `Moved to ${targetMonthKey} — the portal follows.` };
}

export async function setMonthSkipped(monthId: string, skipped: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, status: true } });
  if (!month) return { ok: false, message: "Month not found." };
  await prisma.contentMonth.update({
    where: { id: monthId },
    data: { status: skipped ? "SKIPPED" : "OPEN" },
  });
  revalidatePath(`/content/${month.enrollmentId}`);
  revalidatePath("/content");
  return { ok: true, message: skipped ? "Marked skipped — no more nagging about this month." : "Reopened." };
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
    path(v.enrollmentId);
    if (r.alreadyApproved) return { ok: true, message: (r.pillarsCreated ? `Already approved · ${r.pillarsCreated} pillar${r.pillarsCreated === 1 ? "" : "s"} created from the document.` : "Already approved — its pillars exist; nothing changed.") + bankNote };
    return { ok: true, message: `Approved under your name${r.pillarsCreated ? ` · ${r.pillarsCreated} pillar${r.pillarsCreated === 1 ? "" : "s"} created from the document` : ""}. Release it to the portal when you want the client to see it.${bankNote}` };
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

export async function releaseStrategy(versionId: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { enrollmentId: true } });
    if (!v) return { ok: false, message: "Version not found." };
    const me = await actor();
    const { releaseStrategyVersion } = await import("@/lib/contentStrategy");
    await releaseStrategyVersion(versionId, me.email);
    path(v.enrollmentId);
    return { ok: true, message: "Released — the portal may show this version (the portal's own gate is switched by the portal builder)." };
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
      const r = await acceptStrategyProposal(proposalId, me.email, note, { text: typeof text === "string" ? text : null, sectionId: typeof sectionId === "string" && sectionId ? sectionId : null });
      path(p.enrollmentId);
      return {
        ok: true,
        message: r.sectionHeading
          ? `Accepted — a new draft changes only the "${r.sectionHeading}" section; approve it to make it the strategy in force. The current version stays in force until then.`
          : r.versionId ? "Accepted — a new draft version carries the change; approve it to make it the strategy in force." : "Accepted and recorded (no approved strategy to base a draft on yet).",
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
    const r = await startTopicRefresh({ enrollmentId, kind, requestedBy: me.email, monthId: monthId ?? null });
    const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r.runId }, select: { status: true, generatedCount: true, changeSummary: true, missingContextJson: true } });
    path(enrollmentId);
    if (r.joined) return { ok: true, message: "That refresh is already running — its suggestions will appear below." };
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
export async function startInterview(topicId: string, monthId: string): Promise<Result & { interviewId?: string }> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { getOrCreateInterview } = await import("@/lib/contentInterview");
    const interviewId = await getOrCreateInterview(topicId, monthId, { staffUserId: me.email });
    revalidatePath("/content");
    return { ok: true, message: "Interview ready.", interviewId };
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
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { decideRevisionFee } = await import("@/lib/reviewWindows");
    const r = await decideRevisionFee(roundId, decision, me.name ?? me.email, note ?? null);
    const round = await prisma.contentRevisionRound.findUnique({ where: { id: roundId }, select: { enrollmentId: true } });
    if (round) path(round.enrollmentId);
    return r;
  } catch (e) { return fail(e); }
}

export async function restartReviewClockAction(windowId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { restartReviewClock } = await import("@/lib/reviewWindows");
    const r = await restartReviewClock(windowId, me.name ?? me.email);
    const w = await prisma.contentReviewWindow.findUnique({ where: { id: windowId }, select: { enrollmentId: true } });
    if (w) path(w.enrollmentId);
    return r;
  } catch (e) { return fail(e); }
}

export async function holdReviewWindowAction(windowId: string, hold: boolean, reason?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { holdReviewWindow, releaseReviewHold } = await import("@/lib/reviewWindows");
    const r = hold ? await holdReviewWindow(windowId, me.name ?? me.email, reason ?? "") : await releaseReviewHold(windowId);
    const w = await prisma.contentReviewWindow.findUnique({ where: { id: windowId }, select: { enrollmentId: true } });
    if (w) path(w.enrollmentId);
    return r;
  } catch (e) { return fail(e); }
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
