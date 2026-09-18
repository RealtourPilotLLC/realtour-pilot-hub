"use server";

import { revalidatePath } from "next/cache";
import { appBase } from "@/lib/appUrl";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { contentProgramSweep, PACKAGE_RULES, etMonthKey, assertDutyOwner, setOwnerOverride, type OwnerDuty } from "@/lib/contentProgram";
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
// Enrollment settings (package override + per-client workflow flags, spec §3)
// ---------------------------------------------------------------------------
export async function saveEnrollmentSettings(
  enrollmentId: string,
  s: {
    package?: string; strategyCallRequired?: boolean; clientSuppliesTopics?: boolean; status?: string; notes?: string;
    videosPerMonth?: number;
    billingType?: string | null; billingRate?: number | null; billingMonths?: number | null;
  },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const data: Record<string, unknown> = {};
  // Billing terms are the OWNER's alone — an admin session can save every other
  // field on this card but never money.
  const touchesBilling = s.billingType !== undefined || s.billingRate !== undefined || s.billingMonths !== undefined;
  if (touchesBilling) {
    try { await requireOwner(); } catch (e) { return fail(e); }
    if (s.billingType !== undefined) {
      if (s.billingType !== null && !["PAID_IN_FULL", "MONTHLY_CONTRACT", "MONTH_TO_MONTH", "TRIAL"].includes(s.billingType)) {
        return { ok: false, message: "Unknown billing type." };
      }
      data.billingType = s.billingType;
    }
    if (s.billingRate !== undefined) {
      if (s.billingRate !== null && (!Number.isFinite(s.billingRate) || s.billingRate < 0)) return { ok: false, message: "Bad rate." };
      data.billingRate = s.billingRate;
    }
    if (s.billingMonths !== undefined) {
      if (s.billingMonths !== null && (!Number.isInteger(s.billingMonths) || s.billingMonths < 1 || s.billingMonths > 60)) return { ok: false, message: "Bad term length." };
      data.billingMonths = s.billingMonths;
    }
  }
  if (s.package !== undefined) {
    const rules = PACKAGE_RULES[s.package];
    if (!rules) return { ok: false, message: "Unknown package." };
    // A hand-set package is an override — the Aryeo sync must stop following the plan field.
    // PRESERVE a custom videosPerMonth: Marcee/Erica/Bernadette's 5-video deals
    // are hand-set numbers, and the stock rule silently shrank them to 4 when
    // anyone touched this dropdown (audit Aug 25).
    const cur = await prisma.contentEnrollment.findUnique({
      where: { id: enrollmentId },
      select: { package: true, videosPerMonth: true },
    });
    const curRule = cur ? PACKAGE_RULES[cur.package] : null;
    const isCustom = cur && curRule && cur.videosPerMonth !== curRule.videosPerMonth;
    Object.assign(data, { package: s.package, ...rules, ...(isCustom ? { videosPerMonth: cur.videosPerMonth } : {}), packageSource: "manual" });
  }
  // Owner-set videos-per-month (the custom-deal control — no more direct DB edits).
  if (s.videosPerMonth !== undefined) {
    if (!Number.isInteger(s.videosPerMonth) || s.videosPerMonth < 1 || s.videosPerMonth > 31) return { ok: false, message: "Bad video count." };
    data.videosPerMonth = s.videosPerMonth;
    // The CURRENT month was minted with the old number — update its owed figure
    // too, or a mid-month change is invisible until next month (review finding).
    const { etMonthKey } = await import("@/lib/contentProgram");
    await prisma.contentMonth.updateMany({
      where: { enrollmentId, monthKey: etMonthKey(), historical: false },
      data: { videosOwed: s.videosPerMonth },
    });
  }
  if (s.strategyCallRequired !== undefined) data.strategyCallRequired = s.strategyCallRequired;
  if (s.clientSuppliesTopics !== undefined) data.clientSuppliesTopics = s.clientSuppliesTopics;
  if (s.status !== undefined && ["ACTIVE", "PAUSED", "ENDED"].includes(s.status)) {
    // A hand-set status is an override — the Aryeo sweep stops managing it.
    data.status = s.status;
    data.statusManual = true;
  }
  if (s.notes !== undefined) data.notes = s.notes.trim().slice(0, 4000) || null;
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data });
  revalidatePath("/content");
  return { ok: true, message: "Saved." };
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
 * The month tab's Approve: approves the CURRENT version — the text that tab
 * renders (page.tsx reads the current version's body, not the legacy mirror),
 * so what Jordan sees is what he signs. `note` is the override for a version
 * with blocking format findings.
 */
export async function approveScript(scriptId: string, note?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { ensureScriptVersioned, approveScriptVersion } = await import("@/lib/contentScripts");
    const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { enrollmentId: true, monthId: true, historical: true } });
    if (!s) return { ok: false, message: "That script no longer exists." };
    if (s.historical) return { ok: false, message: "Imported scripts are history — nothing to approve." };
    const me = await actor();
    await assertDutyOwner("SCRIPTS", s.enrollmentId, s.monthId, me);
    const versionId = await ensureScriptVersioned(scriptId);
    const r = await approveScriptVersion(versionId, { email: me.email, appUserId: me.id }, note?.trim() || null);
    revalidatePath("/content");
    return { ok: true, message: r.alreadyApproved ? "Already approved — nothing changed." : "Approved (recorded under your name). Release it to the portal from the Scripts tab when you want the client to see it." };
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
 * This is an ACTION, not an exemption. It produces another DRAFT that goes
 * through the same validator and the same approval gate; nothing here relaxes
 * the 20–30 s target, which has no override field anywhere in the policy layer.
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
    if (seconds <= hi) return { ok: false, message: `Version ${v.versionNo} already estimates at ≈${seconds} s, inside the ${lo}–${hi} s target — nothing to tighten.` };
    const instruction = tightenInstruction({ seconds, words, wordsPerSec: GENERATION_POLICY.timing.wordsPerSec, target: GENERATION_POLICY.timing.targetSec });
    const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
    const me = await actor();
    await reviseScriptWithInstructions(scriptId, instruction, { requestedBy: me.email });
    revalidatePath("/content");
    return { ok: true, message: `Sent back to be tightened from ≈${seconds} s (${words} words) toward ${lo}–${hi} s — v${v.versionNo} is kept. Review the new draft.` };
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
    path(v.enrollmentId);
    if (r.alreadyApproved) return { ok: true, message: r.pillarsCreated ? `Already approved · ${r.pillarsCreated} pillar${r.pillarsCreated === 1 ? "" : "s"} created from the document.` : "Already approved — its pillars exist; nothing changed." };
    return { ok: true, message: `Approved under your name${r.pillarsCreated ? ` · ${r.pillarsCreated} pillar${r.pillarsCreated === 1 ? "" : "s"} created from the document` : ""}. Release it to the portal when you want the client to see it.` };
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

export async function resolveStrategyProposal(proposalId: string, accept: boolean, note: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const p = await prisma.contentStrategyProposal.findUnique({ where: { id: proposalId }, select: { enrollmentId: true } });
    if (!p) return { ok: false, message: "Proposal not found." };
    const me = await actor();
    await assertDutyOwner("STRATEGY", p.enrollmentId, null, me);
    const { acceptStrategyProposal, rejectStrategyProposal } = await import("@/lib/contentStrategy");
    if (accept) {
      const r = await acceptStrategyProposal(proposalId, me.email, note);
      path(p.enrollmentId);
      return { ok: true, message: r.versionId ? "Accepted — a new draft version carries the change; approve it to make it the strategy in force." : "Accepted and recorded (no approved strategy to base a draft on yet)." };
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
    return { ok: true, message: decision === "ACCEPT" ? "Accepted — it now reaches generation and the editor brief." : decision === "REJECT" ? "Rejected (kept as history)." : "Undone — back to needs-review, out of every prompt." };
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
