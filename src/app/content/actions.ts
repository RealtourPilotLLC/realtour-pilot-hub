"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { contentProgramSweep, PACKAGE_RULES, etMonthKey } from "@/lib/contentProgram";

type Result = { ok: boolean; message: string };
// The model occasionally returns an array/object field as a JSON-encoded STRING
// (quote-heavy source documents trigger it — Aug 24 backfill). Coerce first.
function coerceArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? (p as T[]) : []; } catch { return []; } }
  return [];
}
function coerceObject(v: unknown): Record<string, string> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, string>;
  if (typeof v === "string") { try { const p = JSON.parse(v); return p && typeof p === "object" && !Array.isArray(p) ? p : {}; } catch { return {}; } }
  return {};
}

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
  t: { title: string; concept?: string; pillar?: string; monthId?: string | null; source?: string },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const title = t.title.trim().slice(0, 200);
  if (!title) return { ok: false, message: "Give the topic a title." };
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) return { ok: false, message: "Enrollment not found." };
  await prisma.contentTopic.create({
    data: {
      enrollmentId, clientId: e.clientId, title,
      concept: t.concept?.trim().slice(0, 2000) || null,
      pillar: t.pillar?.trim().slice(0, 120) || null,
      monthId: t.monthId ?? null,
      status: t.monthId ? "SELECTED" : "IDEA",
      source: t.source && ["ai", "client", "strategy_call", "staff", "import"].includes(t.source) ? t.source : "staff",
    },
  });
  revalidatePath("/content");
  return { ok: true, message: "Topic added." };
}

export async function setTopicStatus(topicId: string, status: string, monthId?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const OK = ["IDEA", "RECOMMENDED", "SAVED", "SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED", "REJECTED", "ARCHIVED"];
  if (!OK.includes(status)) return { ok: false, message: "Unknown status." };
  await prisma.contentTopic.update({
    where: { id: topicId },
    data: { status, ...(monthId !== undefined ? { monthId } : {}) },
  });
  revalidatePath("/content");
  return { ok: true, message: "Updated." };
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

// ---------------------------------------------------------------------------
// Script backfill — Jordan: "I supply the PDF or Word Doc, select the month,
// and it automatically adds. OR you can read the scripts and see the main
// title in the document is for X month."
//
// Flow: upload → extract text (pdf-parse / mammoth) → AI splits the document
// into individual scripts and proposes a month → staff confirms → save.
// Nothing is client-visible; these are internal records for history + AI.
// ---------------------------------------------------------------------------
export type ExtractedScript = { title: string; body: string; hook?: string | null };
export type BackfillPreview = { ok: boolean; message: string; monthGuess?: string | null; scripts?: ExtractedScript[]; sourceFile?: string };

// Shared file→plain-text extraction for the backfill uploads (scripts + strategies).
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

export async function previewScriptBackfill(form: FormData): Promise<BackfillPreview> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const ex = await extractUploadText(form);
  if (!ex.ok) return ex;
  const { text, name } = ex;

  // AI splits the document into scripts + proposes the month from titles/dates.
  try {
    const { aiJson } = await import("@/lib/integrations/ai");
    const out = await aiJson<{ monthKey: string | null; scripts: { title: string; hook: string | null; body: string }[] }>({
      system:
        "You are indexing a real-estate agent's short-form video scripts for an archive. " +
        "Split the document into its individual scripts. Keep each script's text VERBATIM — do not rewrite, summarize, or improve. " +
        "A script's title is its heading or, absent one, its first line/hook. " +
        "If the document names a month (e.g. 'September Scripts', 'Content for March 2026'), return it as monthKey in YYYY-MM form; " +
        "if the year is missing, assume the most plausible recent year. Otherwise monthKey must be null.",
      prompt: text.slice(0, 100_000),
      maxTokens: 16_000,
      schema: {
        type: "object",
        properties: {
          monthKey: { type: ["string", "null"], description: "YYYY-MM the document's scripts are for, or null" },
          scripts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                hook: { type: ["string", "null"] },
                body: { type: "string", description: "the script text, verbatim" },
              },
              required: ["title", "body"],
            },
          },
        },
        required: ["monthKey", "scripts"],
      },
    });
    const scripts = coerceArray<{ title: string; hook: string | null; body: string }>(out.scripts)
      .filter((s) => s.body?.trim())
      .map((s) => ({ title: (s.title || s.body.slice(0, 60)).trim().slice(0, 200), hook: s.hook?.trim() || null, body: s.body.trim().slice(0, 20_000) }));
    if (scripts.length === 0) return { ok: false, message: "No scripts found in the document." };
    return { ok: true, message: `Found ${scripts.length} script${scripts.length === 1 ? "" : "s"}.`, monthGuess: out.monthKey ?? null, scripts, sourceFile: name };
  } catch {
    // AI unavailable → the whole document becomes one script; staff set the month.
    return { ok: true, message: "Imported as one script (AI split unavailable).", monthGuess: null, scripts: [{ title: name.replace(/\.[^.]+$/, ""), body: text.slice(0, 20_000), hook: null }], sourceFile: name };
  }
}

export async function saveScriptBackfill(
  enrollmentId: string,
  monthKey: string,
  scripts: ExtractedScript[],
  sourceFile: string,
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return { ok: false, message: "Pick the month first." };
  if (!scripts.length) return { ok: false, message: "Nothing to save." };
  const e = await prisma.contentEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { clientId: true, videosPerMonth: true, strategyCallRequired: true },
  });
  if (!e) return { ok: false, message: "Enrollment not found." };

  // Find-or-create the month; a backfilled past month is historical by design.
  const { etMonthKey } = await import("@/lib/contentProgram");
  let month = await prisma.contentMonth.findUnique({
    where: { enrollmentId_monthKey: { enrollmentId, monthKey } },
    select: { id: true },
  });
  if (!month) {
    month = await prisma.contentMonth.create({
      data: {
        enrollmentId, clientId: e.clientId, monthKey,
        videosOwed: e.videosPerMonth,
        strategyCallStatus: e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
        ...(monthKey < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}),
      },
      select: { id: true },
    });
  }
  for (const s of scripts) {
    await prisma.contentScript.create({
      data: {
        enrollmentId, clientId: e.clientId, monthId: month.id,
        title: s.title.slice(0, 200),
        body: s.body.slice(0, 20_000),
        sectionsJson: s.hook ? JSON.stringify({ hook: s.hook }) : null,
        status: "APPROVED", // history — it was already used
        source: "import",
        sourceFile: sourceFile.slice(0, 200),
      },
    });
  }
  revalidatePath("/content");
  return { ok: true, message: `Saved ${scripts.length} script${scripts.length === 1 ? "" : "s"} to ${monthKey}.` };
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

const STRATEGY_SECTIONS = [
  "Brand positioning", "Target audience", "Brand message", "Content goals",
  "Content pillars", "Tone & personality", "Content preferences", "Business context",
];

export async function previewStrategyBackfill(form: FormData): Promise<StrategyPreview> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const ex = await extractUploadText(form);
  if (!ex.ok) return ex;
  const { text, name } = ex;
  try {
    const { aiJson } = await import("@/lib/integrations/ai");
    const out = await aiJson<{ sections: Record<string, string> }>({
      system:
        "You are filing a real-estate agent's existing content strategy document into a structured archive. " +
        "Sort the document's content into these sections, keeping the author's wording as close to VERBATIM as possible — reorganize, never rewrite: " +
        STRATEGY_SECTIONS.map((s) => `"${s}"`).join(", ") + ". " +
        "Omit sections the document doesn't cover. If material fits nowhere, put it under \"Business context\".",
      prompt: text.slice(0, 100_000),
      maxTokens: 16_000,
      schema: {
        type: "object",
        properties: {
          sections: {
            type: "object",
            description: "section name -> the document's own content for that section",
            additionalProperties: { type: "string" },
          },
        },
        required: ["sections"],
      },
    });
    const sections: Record<string, string> = {};
    for (const [k, v] of Object.entries(coerceObject(out.sections))) {
      if (typeof v === "string" && v.trim()) sections[k.slice(0, 80)] = v.trim().slice(0, 12_000);
    }
    if (Object.keys(sections).length === 0) return { ok: false, message: "Couldn't find strategy content in the document." };
    return { ok: true, message: `Organized into ${Object.keys(sections).length} sections.`, sections, rawText: text.slice(0, 200_000), sourceFile: name };
  } catch {
    // AI unavailable → keep the whole document under one section; still saveable.
    return { ok: true, message: "Saved as one block (AI organization unavailable).", sections: { "Business context": text.slice(0, 12_000) }, rawText: text.slice(0, 200_000), sourceFile: name };
  }
}

export async function saveStrategyBackfill(
  enrollmentId: string,
  sections: Record<string, string>,
  rawText: string,
  sourceFile: string,
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!Object.keys(sections).length) return { ok: false, message: "Nothing to save." };
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) return { ok: false, message: "Enrollment not found." };
  // One ACTIVE strategy at a time — the old one becomes history, not garbage.
  await prisma.contentStrategy.updateMany({
    where: { enrollmentId, status: "ACTIVE" },
    data: { status: "ARCHIVED" },
  });
  await prisma.contentStrategy.create({
    data: {
      enrollmentId, clientId: e.clientId,
      sectionsJson: JSON.stringify(sections),
      rawText: rawText.slice(0, 200_000) || null,
      status: "ACTIVE",
      source: "import",
      sourceFile: sourceFile.slice(0, 200),
    },
  });
  revalidatePath("/content");
  return { ok: true, message: "Strategy saved as this client's active strategy." };
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
    const r = await processMonthTranscript(monthId);
    const g = await generateScriptsForMonth(monthId);
    revalidatePath("/content");
    return {
      ok: true,
      message: `${r.confirmedTopics} topic${r.confirmedTopics === 1 ? "" : "s"} confirmed · ${r.futureIdeas} saved for later · ${r.intelNotes} things learned about the client · ${g.generated} script${g.generated === 1 ? "" : "s"} drafted for your review.`,
    };
  } catch (e) { return fail(e); }
}

export async function generateMonthScripts(monthId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { generateScriptsForMonth } = await import("@/lib/contentPipeline");
    const g = await generateScriptsForMonth(monthId);
    revalidatePath("/content");
    return { ok: true, message: g.generated ? `${g.generated} script${g.generated === 1 ? "" : "s"} drafted — review below.` : "Every selected topic already has a script." };
  } catch (e) { return fail(e); }
}

export async function approveScript(scriptId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  await prisma.contentScript.update({ where: { id: scriptId }, data: { status: "READY_TO_FILM" } });
  revalidatePath("/content");
  return { ok: true, message: "Approved — ready to film." };
}

export async function reviseScriptAI(scriptId: string, instructions: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!instructions.trim()) return { ok: false, message: "Tell the AI what to change first." };
  try {
    const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
    await reviseScriptWithInstructions(scriptId, instructions);
    revalidatePath("/content");
    return { ok: true, message: "Revised — take another look." };
  } catch (e) { return fail(e); }
}

export async function saveScriptText(scriptId: string, body: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const text = body.trim().slice(0, 20_000);
  if (!text) return { ok: false, message: "The script can't be empty." };
  // A manual edit replaces the body; the section breakdown no longer matches,
  // so it's cleared rather than left lying about the content.
  await prisma.contentScript.update({
    where: { id: scriptId },
    data: { body: text, sectionsJson: null, source: "manual" },
  });
  revalidatePath("/content");
  return { ok: true, message: "Saved." };
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
    const r = await seedTopicBank(enrollmentId);
    revalidatePath("/content");
    return { ok: true, message: r.created ? `${r.created} ideas added across ${r.pillars.length} pillar${r.pillars.length === 1 ? "" : "s"} (${r.pillars.join(", ")}).` : "Nothing new — the bank already covers this ground." };
  } catch (e) { return fail(e); }
}

export async function buildProfile(clientId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { buildAgentProfileFromHistory } = await import("@/lib/contentPipeline");
    const r = await buildAgentProfileFromHistory(clientId);
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
    await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { portalToken: token } });
  }
  const base = process.env.APP_URL ?? "https://realtour-pilot-hub.vercel.app";
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
  const script = await prisma.contentScript.findUnique({ where: { id: sugg.scriptId }, select: { body: true } });
  if (!script) return { ok: false, message: "That script no longer exists." };
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
    await reviseScriptWithInstructions(
      sugg.scriptId,
      `The client sent this suggestion from their portal — apply it faithfully, keeping everything they didn't mention:\n"${sugg.body}"`,
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
