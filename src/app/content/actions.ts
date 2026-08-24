"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { contentProgramSweep, PACKAGE_RULES } from "@/lib/contentProgram";

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
  const r = await contentProgramSweep();
  revalidatePath("/content");
  const parts = [
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
  s: { package?: string; strategyCallRequired?: boolean; clientSuppliesTopics?: boolean; status?: string; notes?: string },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const data: Record<string, unknown> = {};
  if (s.package !== undefined) {
    const rules = PACKAGE_RULES[s.package];
    if (!rules) return { ok: false, message: "Unknown package." };
    // A hand-set package is an override — the Aryeo sync must stop following the plan field.
    Object.assign(data, { package: s.package, ...rules, packageSource: "manual" });
  }
  if (s.strategyCallRequired !== undefined) data.strategyCallRequired = s.strategyCallRequired;
  if (s.clientSuppliesTopics !== undefined) data.clientSuppliesTopics = s.clientSuppliesTopics;
  if (s.status !== undefined && ["ACTIVE", "PAUSED", "ENDED"].includes(s.status)) data.status = s.status;
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
    data: { transcriptText: text.trim().slice(0, 500_000) || null, strategyCallStatus: text.trim() ? "COMPLETED" : undefined },
  });
  revalidatePath("/content");
  return { ok: true, message: "Transcript saved. Extraction lands in the next build phase." };
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
    const scripts = (out.scripts ?? [])
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
    for (const [k, v] of Object.entries(out.sections ?? {})) {
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
export async function analyzeTranscript(monthId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { processMonthTranscript, generateScriptsForMonth } = await import("@/lib/contentPipeline");
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
  const { syncStrategyCallsFromCalendly, sweepDriveTranscripts } = await import("@/lib/contentCalls");
  const cal = await syncStrategyCallsFromCalendly().catch((e) => ({ skipped: e instanceof Error ? e.message : "failed" }));
  const drv = await sweepDriveTranscripts().catch((e) => ({ skipped: e instanceof Error ? e.message : "failed" }));
  revalidatePath("/content");
  const calMsg = "skipped" in cal ? `Calendly: ${cal.skipped}` : `Calendly: ${cal.stamped} scheduled, ${cal.completed} completed${cal.canceled ? `, ${cal.canceled} canceled` : ""}`;
  const drvMsg = "skipped" in drv ? `Drive: ${drv.skipped}` : `Drive: ${drv.ingested} transcript${drv.ingested === 1 ? "" : "s"} pulled in`;
  return { ok: true, message: `${calMsg} · ${drvMsg}.` };
}
