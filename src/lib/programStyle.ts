import "server-only";
import { prisma } from "@/lib/prisma";
import { type VideoStyle, VIDEO_STYLE_LABEL, VIDEO_STYLE_OVERRIDE_KEY, videoStyleFromOverrides } from "@/lib/contentPolicy/prompts";

// ---------------------------------------------------------------------------
// PROGRAM STYLE, PER CLIENT (Oct 8 2026) — two switches on the client file.
//
// Jordan: "Mike Ciunci does not do strategy calls, so I'd like the option to
// turn that off for select clients … Mike comes up with his own video topics,
// ideas, scripts, etc, so Mike is really a we-show-up-and-shoot kind of deal."
//
//   STRATEGY CALLS (on | off). Off is the existing call mode NOT_INCLUDED
//     (strategyCallRequired=false, noCallEligible cleared): months read the
//     call NOT_REQUIRED by rule (programMonths), the portal shows no call step
//     and the reminders never ask for one. On puts back what the client had
//     before it was switched off — the explicit mode recorded in the ledger,
//     or the program default (the first call required, later months may be
//     planned in writing) when there was none.
//   CLIENT PLANS THEIR OWN CONTENT (ContentEnrollment.clientSuppliesTopics).
//     On: no topics, topic bank, questions, answers or scripts are asked of
//     them or written by us (every generator refuses — CLIENT_PLANNED_REFUSAL
//     — and the sweeps skip them); the month is ready to film from the start,
//     with no planning gate; the portal month is "add your brief (optional) →
//     book filming"; office and editor screens say "Client-planned".
//
// Both are ledgered (ProgramEnrollmentChange) and re-derive the open months.
// Nothing here messages a client, books or talks to a provider.
// ---------------------------------------------------------------------------

export const CLIENT_PLANNED_REFUSAL = "This client plans their own content, so we don't write topics, questions or scripts for them. Turn that off in Settings › Program style first.";

/** The client plans their own content ("we show up and shoot"). */
export async function clientPlansOwnContent(enrollmentId: string): Promise<boolean> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientSuppliesTopics: true } });
  return !!e?.clientSuppliesTopics;
}

/** Throws CLIENT_PLANNED_REFUSAL for a client who plans their own content. Every topic/question/script generator calls it first. */
export async function assertWeWriteFor(enrollmentId: string): Promise<void> {
  if (await clientPlansOwnContent(enrollmentId)) {
    const err = new Error(CLIENT_PLANNED_REFUSAL);
    err.name = "ClientPlannedError";
    throw err;
  }
}

export type ProgramStyle = { strategyCalls: boolean; clientPlanned: boolean };

/** Calls are "on" unless the explicit (or legacy-derived) mode is NOT_INCLUDED. */
export function programStyleOf(e: { callMode: string | null; strategyCallRequired: boolean; clientSuppliesTopics: boolean }): ProgramStyle {
  const mode = e.callMode === "REQUIRED" || e.callMode === "OPTIONAL_WRITTEN" || e.callMode === "NOT_INCLUDED" ? e.callMode : e.strategyCallRequired ? "REQUIRED" : "NOT_INCLUDED";
  return { strategyCalls: mode !== "NOT_INCLUDED", clientPlanned: e.clientSuppliesTopics };
}

/**
 * Strategy calls on/off. Returns what was written, for the reply line.
 * Off → call mode NOT_INCLUDED (setCallMode keeps strategyCallRequired in step).
 * On  → the mode the client had before the last switch-off, else the program default.
 */
export async function setStrategyCalls(enrollmentId: string, on: boolean, by: string | null): Promise<{ changed: boolean; mode: string }> {
  const { setCallMode, recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
  const { recalcProgramMonthsForEnrollment } = await import("@/lib/programMonths");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, clientId: true, callMode: true, strategyCallRequired: true, noCallEligible: true, clientSuppliesTopics: true } });
  if (!e) throw new Error("Enrollment not found.");
  const style = programStyleOf(e);
  if (!on) {
    // Already off — explicitly, or by the legacy flag (strategyCallRequired=false, no column): nothing to write.
    if (!style.strategyCalls) return { changed: false, mode: "NOT_INCLUDED" };
    await setCallMode(enrollmentId, "NOT_INCLUDED", null, by, "Strategy calls turned off for this client (Program style).");
    return { changed: true, mode: "NOT_INCLUDED" };
  }
  if (style.strategyCalls) return { changed: false, mode: e.callMode ?? "default" };
  // What it was before the last switch-off: the newest callMode change INTO
  // NOT_INCLUDED names it in `fromValue` ("REQUIRED", or "REQUIRED (derived)").
  const last = await prisma.programEnrollmentChange.findFirst({
    where: { enrollmentId, field: "callMode", toValue: JSON.stringify("NOT_INCLUDED") },
    orderBy: { createdAt: "desc" }, select: { fromValue: true },
  });
  let before: string | null = null;
  try { before = last?.fromValue ? (JSON.parse(last.fromValue) as string | null) : null; } catch { before = null; }
  if (before === "REQUIRED" || before === "OPTIONAL_WRITTEN") {
    await setCallMode(enrollmentId, before, null, by, "Strategy calls turned back on (Program style) — the call requirement it had before.");
    return { changed: true, mode: before };
  }
  // The program default: no explicit column, the legacy flag on — the first
  // call is required, later months may be planned in writing (§3).
  const now = new Date();
  const { etMonthKey } = await import("@/lib/contentProgram");
  const base = { enrollmentId, clientId: e.clientId, effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: by, appliedAt: now, reason: "Strategy calls turned back on (Program style) — the program default." } as const;
  if (e.callMode !== null) await recordEnrollmentChange({ ...base, field: "callMode", from: e.callMode, to: null });
  if (!e.strategyCallRequired) await recordEnrollmentChange({ ...base, field: "strategyCallRequired", from: false, to: true });
  if (e.noCallEligible !== null) await recordEnrollmentChange({ ...base, field: "noCallEligible", from: e.noCallEligible, to: null });
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { callMode: null, strategyCallRequired: true, noCallEligible: null } });
  await recalcProgramMonthsForEnrollment(enrollmentId).catch(() => []);
  return { changed: true, mode: "default" };
}

/** Client plans their own content on/off (ledgered through setWorkflowFlags), then re-derive the open months. */
export async function setClientPlanned(enrollmentId: string, on: boolean, by: string | null): Promise<{ changed: boolean }> {
  const { setWorkflowFlags } = await import("@/lib/enrollmentChanges");
  const { recalcProgramMonthsForEnrollment } = await import("@/lib/programMonths");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientSuppliesTopics: true } });
  if (!e) throw new Error("Enrollment not found.");
  if (e.clientSuppliesTopics === on) return { changed: false };
  await setWorkflowFlags(enrollmentId, { clientSuppliesTopics: on }, by);
  await recalcProgramMonthsForEnrollment(enrollmentId).catch(() => []);
  return { changed: true };
}

// ---------------------------------------------------------------------------
// VIDEO STYLE (Oct 13 2026), the third Program style setting.
//
// Jordan: "Some clients, like Janice Pigga, Joe Sutow, and Mike Flatley,
// prefer more creative, skit-style videos ... there should be different
// settings for the accounts. Direct-to-camera or Skits."
//
//   DIRECT ("Direct-to-camera", the default): today's scripts and topics.
//   SKITS ("Skits"): every script draft and revision is a short comedic scene
//     inside the same house framework, the client alone on camera by default,
//     and topic suggestions are skit concepts (contentPolicy/prompts.ts).
//
// No column: it lives in ContentEnrollment.overridesJson as `videoStyle`, and
// a missing value is DIRECT. The change is ledgered (ProgramEnrollmentChange,
// field "overrides") with who made it. Nothing here messages anyone or touches
// a script already written.
// ---------------------------------------------------------------------------

export { type VideoStyle, VIDEO_STYLE_LABEL, asVideoStyle, videoStyleFromOverrides } from "@/lib/contentPolicy/prompts";

/** The account's video style; DIRECT when nothing is set. */
export async function videoStyleOf(enrollmentId: string): Promise<VideoStyle> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  return videoStyleFromOverrides(e?.overridesJson ?? null);
}

/**
 * Set the account's video style. DIRECT removes the key (the default), SKITS
 * writes it. Compare-and-swap on the whole bag, like the catch-up and late
 * session records that share it, so a concurrent write to another key is
 * never lost.
 */
export async function setVideoStyle(enrollmentId: string, style: VideoStyle, by: string | null): Promise<{ changed: boolean; style: VideoStyle }> {
  if (style !== "DIRECT" && style !== "SKITS") throw new Error("The video style is Direct-to-camera or Skits.");
  const { recordEnrollmentChange, readOverrides } = await import("@/lib/enrollmentChanges");
  const { etMonthKey } = await import("@/lib/contentProgram");
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
    if (!e) throw new Error("Enrollment not found.");
    const before = videoStyleFromOverrides(e.overridesJson);
    if (before === style) return { changed: false, style };
    const bag = { ...readOverrides(e.overridesJson) };
    if (style === "DIRECT") delete bag[VIDEO_STYLE_OVERRIDE_KEY]; else bag[VIDEO_STYLE_OVERRIDE_KEY] = style;
    const next = Object.keys(bag).length ? JSON.stringify(bag) : null;
    const w = await prisma.contentEnrollment.updateMany({ where: { id: enrollmentId, overridesJson: e.overridesJson }, data: { overridesJson: next } });
    if (!w.count) continue; // another write to the bag landed first: read it again
    const now = new Date();
    await recordEnrollmentChange({
      enrollmentId, clientId: e.clientId, field: "overrides", from: { [VIDEO_STYLE_OVERRIDE_KEY]: before }, to: { [VIDEO_STYLE_OVERRIDE_KEY]: style },
      effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: by, appliedAt: now,
      reason: `Video style set to ${VIDEO_STYLE_LABEL[style]} (Program style).`,
    });
    return { changed: true, style };
  }
  throw new Error("The client file changed while saving. Try again.");
}
